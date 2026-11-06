import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

export const MAX_TEXT_CHARS = 60_000;

export const textResult = (value, isError = false) => ({
  isError,
  content: [{
    type: "text",
    text: typeof value === "string" ? value : JSON.stringify(value, null, 2)
  }]
});

export const requireString = (value, name, maxLength = 2_000) => {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} must be a non-empty string.`);
  const normalized = value.trim();
  if (normalized.length > maxLength) throw new Error(`${name} exceeds ${maxLength} characters.`);
  return normalized;
};

export const boundedInteger = (value, fallback, minimum, maximum) => {
  const parsed = Number(value ?? fallback);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`Expected an integer between ${minimum} and ${maximum}.`);
  }
  return parsed;
};

export const fetchJson = async (url, options = {}, timeoutMs = 20_000) => {
  const response = await fetch(url, { ...options, signal: AbortSignal.timeout(timeoutMs) });
  const text = await response.text();
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${text.slice(0, 500)}`);
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("The remote service returned invalid JSON.");
  }
};

export const startServer = async ({ name, version = "1.0.0", tools, callTool }) => {
  const server = new Server({ name, version }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));
  server.setRequestHandler(CallToolRequestSchema, async request => {
    try {
      return await callTool(request.params.name, request.params.arguments || {});
    } catch (error) {
      return textResult({ error: error instanceof Error ? error.message : String(error) }, true);
    }
  });
  await server.connect(new StdioServerTransport());
};
