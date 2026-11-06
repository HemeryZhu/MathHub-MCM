#!/usr/bin/env node
import { requireString, startServer, textResult } from "./common.mjs";
import { safePublicFetch } from "./safe-http.mjs";

const tools = [
  {
    name: "external_service_list",
    description: "List external HTTP services explicitly configured by the application owner. Secrets are never returned.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false }
  },
  {
    name: "external_service_request",
    description: "Call one explicitly allowlisted external HTTP service using owner-configured credentials and path restrictions.",
    inputSchema: {
      type: "object",
      properties: {
        service: { type: "string" },
        method: { type: "string", enum: ["GET", "POST"] },
        path: { type: "string" },
        query: { type: "object", additionalProperties: { type: ["string", "number", "boolean"] } },
        body: { type: ["object", "array", "string", "number", "boolean", "null"] }
      },
      required: ["service", "method", "path"],
      additionalProperties: false
    }
  }
];

const loadServices = () => {
  if (!process.env.MCP_EXTERNAL_SERVICES_JSON) return {};
  let parsed;
  try { parsed = JSON.parse(process.env.MCP_EXTERNAL_SERVICES_JSON); } catch { throw new Error("MCP_EXTERNAL_SERVICES_JSON is not valid JSON."); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("MCP_EXTERNAL_SERVICES_JSON must be a JSON object.");
  return parsed;
};

const publicDefinition = (name, definition) => ({
  name,
  baseUrl: definition.baseUrl,
  allowedMethods: definition.allowedMethods || ["GET"],
  allowedPaths: definition.allowedPaths || ["/"],
  credentialHeadersConfigured: Object.keys(definition.headersEnv || {}).filter(header => Boolean(process.env[definition.headersEnv[header]]))
});

await startServer({
  name: "mathhub-external-services",
  tools,
  callTool: async (name, args) => {
    const services = loadServices();
    if (name === "external_service_list") return textResult({ configured: Object.keys(services).map(service => publicDefinition(service, services[service])) });
    if (name !== "external_service_request") throw new Error(`Unknown tool: ${name}`);
    const serviceName = requireString(args.service, "service", 100);
    const definition = services[serviceName];
    if (!definition) throw new Error(`External service is not configured: ${serviceName}`);
    const baseUrl = new URL(requireString(definition.baseUrl, "baseUrl", 2_000));
    if (baseUrl.protocol !== "https:") throw new Error("External service baseUrl must use HTTPS.");
    const method = requireString(args.method, "method", 10).toUpperCase();
    const allowedMethods = (definition.allowedMethods || ["GET"]).map(value => String(value).toUpperCase());
    if (!allowedMethods.includes(method) || !["GET", "POST"].includes(method)) throw new Error(`Method ${method} is not allowed for ${serviceName}.`);
    const requestPath = requireString(args.path, "path", 2_000);
    if (!requestPath.startsWith("/") || requestPath.includes("\\")) throw new Error("path must be an absolute URL path.");
    const url = new URL(requestPath, baseUrl);
    if (url.origin !== baseUrl.origin) throw new Error("External service request cannot change origin.");
    const allowedPaths = definition.allowedPaths || ["/"];
    if (!allowedPaths.some(prefix => url.pathname.startsWith(String(prefix)))) throw new Error("External service path is not allowlisted.");
    for (const [key, value] of Object.entries(args.query || {})) url.searchParams.set(key, String(value));
    const headers = { Accept: "application/json", "User-Agent": "MathHub-Modulus" };
    for (const [header, environmentName] of Object.entries(definition.headersEnv || {})) {
      const value = process.env[String(environmentName)];
      if (value) headers[header] = value;
    }
    let body;
    if (method === "POST") {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(args.body ?? null);
      if (body.length > 200_000) throw new Error("Request body exceeds 200 KB.");
    }
    const { response, text } = await safePublicFetch(url.toString(), {
      method,
      headers,
      body,
      maxBytes: 2_000_000,
      maxRedirects: 0,
      timeoutMs: 30_000
    });
    let data;
    try { data = JSON.parse(text); } catch { data = text.slice(0, 60_000); }
    return textResult({ service: serviceName, status: response.status, data });
  }
});
