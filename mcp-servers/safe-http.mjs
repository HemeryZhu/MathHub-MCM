import dns from "node:dns/promises";
import net from "node:net";

const MAX_REDIRECTS = 5;
const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;

const blockedIpv4 = address => {
  const parts = address.split(".").map(Number);
  if (parts.length !== 4 || parts.some(part => !Number.isInteger(part) || part < 0 || part > 255)) return true;
  const [a, b, c] = parts;
  return a === 0 || a === 10 || a === 127 || a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113);
};

const blockedIpv6 = address => {
  const normalized = address.toLowerCase().split("%")[0];
  if (normalized === "::" || normalized === "::1") return true;
  if (normalized.startsWith("fc") || normalized.startsWith("fd") || /^fe[89ab]/.test(normalized)) return true;
  const mapped = normalized.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return blockedIpv4(mapped[1]);
  return !/^[23]/.test(normalized);
};

const isBlockedAddress = address => {
  const family = net.isIP(address);
  if (family === 4) return blockedIpv4(address);
  if (family === 6) return blockedIpv6(address);
  return true;
};

export const validatePublicUrl = async rawUrl => {
  const url = new URL(rawUrl);
  if (!(["http:", "https:"].includes(url.protocol))) throw new Error("Only HTTP and HTTPS URLs are allowed.");
  if (url.username || url.password) throw new Error("URLs containing credentials are not allowed.");
  if (url.port && !((url.protocol === "http:" && url.port === "80") || (url.protocol === "https:" && url.port === "443"))) {
    throw new Error("Only standard HTTP/HTTPS ports are allowed.");
  }
  const hostname = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (!hostname || hostname === "localhost" || hostname.endsWith(".localhost") || hostname.endsWith(".local")) {
    throw new Error("Local network destinations are not allowed.");
  }
  const directFamily = net.isIP(hostname);
  const addresses = directFamily ? [{ address: hostname }] : await dns.lookup(hostname, { all: true, verbatim: true });
  if (!addresses.length || addresses.some(entry => isBlockedAddress(entry.address))) {
    throw new Error("Private, loopback, link-local, reserved, or non-public destinations are not allowed.");
  }
  return url;
};

const readLimitedBody = async (response, maxBytes) => {
  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > maxBytes) throw new Error(`Response exceeds ${maxBytes} bytes.`);
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new Error(`Response exceeds ${maxBytes} bytes.`);
    }
    chunks.push(value);
  }
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
};

export const safePublicFetch = async (rawUrl, options = {}) => {
  const timeoutMs = Math.min(30_000, Math.max(1_000, Number(options.timeoutMs) || 20_000));
  const maxBytes = Math.min(5 * 1024 * 1024, Math.max(1_024, Number(options.maxBytes) || DEFAULT_MAX_BYTES));
  const maxRedirects = Math.min(MAX_REDIRECTS, Math.max(0, Number(options.maxRedirects ?? MAX_REDIRECTS)));
  let current = await validatePublicUrl(rawUrl);
  for (let redirects = 0; redirects <= maxRedirects; redirects += 1) {
    const response = await fetch(current, {
      method: options.method || "GET",
      headers: options.headers,
      body: options.body,
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs)
    });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get("location");
      if (!location) throw new Error("Redirect response did not include a Location header.");
      if (redirects === maxRedirects) throw new Error("Redirects are not allowed for this request.");
      current = await validatePublicUrl(new URL(location, current).toString());
      continue;
    }
    const body = await readLimitedBody(response, maxBytes);
    const text = new TextDecoder("utf-8", { fatal: false }).decode(body);
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${text.slice(0, 500)}`);
    return { response, text, finalUrl: current.toString(), bytes: body.byteLength };
  }
  throw new Error("Too many redirects.");
};
