import fs from "fs";
import path from "path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

type StdioServerConfig = {
  enabled?: boolean;
  transport: "stdio";
  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  envFrom?: Record<string, string>;
  allowedTools?: string[];
  timeoutMs?: number;
};

type HttpServerConfig = {
  enabled?: boolean;
  transport: "http";
  url: string;
  headersEnv?: Record<string, string>;
  allowedTools?: string[];
  timeoutMs?: number;
};

type McpServerConfig = StdioServerConfig | HttpServerConfig;
type McpConfig = { servers?: Record<string, McpServerConfig> };

type ConnectedServer = {
  client: Client;
  config: McpServerConfig;
};

export type DiscoveredMcpTool = {
  server: string;
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
};

const CONFIG_FILENAME = "mcp.config.json";
const DEFAULT_TIMEOUT_MS = 20_000;
const MAX_TIMEOUT_MS = 120_000;
const MAX_RESULT_CHARS = 60_000;

const clampTimeout = (value: unknown) => Math.min(MAX_TIMEOUT_MS, Math.max(1_000, Number(value) || DEFAULT_TIMEOUT_MS));
const isPlainObject = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);

export class McpClientManager {
  private readonly projectRoot: string;
  private readonly configs: Record<string, McpServerConfig>;
  private readonly connections = new Map<string, Promise<ConnectedServer>>();

  constructor(projectRoot = process.cwd()) {
    this.projectRoot = path.resolve(projectRoot);
    this.configs = this.loadConfig();
  }

  private loadConfig() {
    const configPath = path.join(this.projectRoot, CONFIG_FILENAME);
    if (!fs.existsSync(configPath)) return {};
    const parsed = JSON.parse(fs.readFileSync(configPath, "utf8")) as McpConfig;
    if (!isPlainObject(parsed.servers)) throw new Error(`${CONFIG_FILENAME} must contain a servers object.`);
    return parsed.servers as Record<string, McpServerConfig>;
  }

  private validateHttpUrl(rawUrl: string) {
    const url = new URL(rawUrl);
    if (!["http:", "https:"].includes(url.protocol)) throw new Error("MCP HTTP URL must use http or https.");
    const hostname = url.hostname.toLowerCase();
    const loopback = hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1" || hostname === "[::1]";
    if (!loopback && process.env.ALLOW_REMOTE_MCP_HTTP !== "true") {
      throw new Error("Remote MCP HTTP servers are disabled. Set ALLOW_REMOTE_MCP_HTTP=true after reviewing the endpoint.");
    }
    return url;
  }

  private buildSafeStdioParameters(config: StdioServerConfig) {
    const args = Array.isArray(config.args) ? config.args.map(value => String(value)) : [];
    const firstArg = args[0] ? path.resolve(this.projectRoot, args[0]) : "";
    const builtInRoot = path.resolve(this.projectRoot, "mcp-servers");
    const isBuiltIn = config.command.toLowerCase() === "node" && firstArg.startsWith(`${builtInRoot}${path.sep}`);
    if (!isBuiltIn && process.env.ALLOW_EXTERNAL_MCP_STDIO !== "true") {
      throw new Error("External MCP stdio commands are disabled. Set ALLOW_EXTERNAL_MCP_STDIO=true after reviewing the command.");
    }
    if (isBuiltIn) args[0] = firstArg;
    const cwd = config.cwd ? path.resolve(this.projectRoot, config.cwd) : this.projectRoot;
    const explicitEnvironment: Record<string, string> = { ...(config.env || {}) };
    for (const [targetName, sourceName] of Object.entries(config.envFrom || {})) {
      const value = process.env[sourceName];
      if (value !== undefined) explicitEnvironment[targetName] = value;
    }
    return {
      command: config.command,
      args,
      cwd,
      env: { ...getDefaultEnvironment(), ...explicitEnvironment },
      stderr: "pipe" as const,
      maxBufferSize: 10 * 1024 * 1024
    };
  }

  private async connect(serverName: string): Promise<ConnectedServer> {
    const existing = this.connections.get(serverName);
    if (existing) return existing;
    const pending = (async () => {
      const config = Object.prototype.hasOwnProperty.call(this.configs, serverName) ? this.configs[serverName] : undefined;
      if (!config || config.enabled === false) throw new Error(`MCP server is not enabled: ${serverName}`);
      const client = new Client({ name: "mathhub-modulus", version: "1.0.0" });
      if (config.transport === "stdio") {
        const transport = new StdioClientTransport(this.buildSafeStdioParameters(config));
        transport.stderr?.on("data", chunk => console.error(`[MCP:${serverName}] ${String(chunk).trim()}`));
        await client.connect(transport, { timeout: clampTimeout(config.timeoutMs) });
      } else if (config.transport === "http") {
        const headers = new Headers();
        for (const [header, environmentName] of Object.entries(config.headersEnv || {})) {
          const value = process.env[environmentName];
          if (value) headers.set(header, value);
        }
        const transport = new StreamableHTTPClientTransport(this.validateHttpUrl(config.url), { requestInit: { headers } });
        await client.connect(transport, { timeout: clampTimeout(config.timeoutMs) });
      } else {
        throw new Error(`Unsupported MCP transport for ${serverName}.`);
      }
      return { client, config };
    })();
    this.connections.set(serverName, pending);
    try {
      return await pending;
    } catch (error) {
      this.connections.delete(serverName);
      throw error;
    }
  }

  private isAllowed(config: McpServerConfig, toolName: string) {
    return !Array.isArray(config.allowedTools) || config.allowedTools.includes(toolName);
  }

  private async listServerTools(client: Client, config: McpServerConfig) {
    const tools: Awaited<ReturnType<Client["listTools"]>>["tools"] = [];
    let cursor: string | undefined;
    do {
      const result = await client.listTools(cursor ? { cursor } : undefined, { timeout: clampTimeout(config.timeoutMs) });
      tools.push(...result.tools);
      cursor = result.nextCursor;
    } while (cursor);
    return tools;
  }

  async listTools() {
    const tools: DiscoveredMcpTool[] = [];
    const servers: Array<{ name: string; connected: boolean; error?: string }> = [];
    for (const [serverName, config] of Object.entries(this.configs)) {
      if (config.enabled === false) continue;
      try {
        const { client } = await this.connect(serverName);
        for (const tool of await this.listServerTools(client, config)) {
          if (!this.isAllowed(config, tool.name)) continue;
          tools.push({
            server: serverName,
            name: tool.name,
            description: tool.description || "",
            inputSchema: tool.inputSchema as Record<string, unknown>
          });
        }
        servers.push({ name: serverName, connected: true });
      } catch (error) {
        servers.push({ name: serverName, connected: false, error: error instanceof Error ? error.message : String(error) });
      }
    }
    return { servers, tools };
  }

  async callTool(serverName: string, toolName: string, argumentsValue: unknown) {
    const { client, config } = await this.connect(serverName);
    if (!this.isAllowed(config, toolName)) throw new Error(`MCP tool is not allowlisted: ${serverName}/${toolName}`);
    const listedTools = await this.listServerTools(client, config);
    if (!listedTools.some(tool => tool.name === toolName)) throw new Error(`MCP tool does not exist: ${serverName}/${toolName}`);
    const result = await client.callTool(
      { name: toolName, arguments: isPlainObject(argumentsValue) ? argumentsValue : {} },
      undefined,
      { timeout: clampTimeout(config.timeoutMs) }
    );
    const serialized = JSON.stringify(result);
    if (serialized.length <= MAX_RESULT_CHARS) return result;
    return {
      isError: true,
      content: [{ type: "text", text: `${serialized.slice(0, MAX_RESULT_CHARS)}\n[MCP result truncated]` }]
    };
  }

  async closeAll() {
    const connected = await Promise.allSettled(Array.from(this.connections.values()));
    await Promise.allSettled(connected.flatMap(result => result.status === "fulfilled" ? [result.value.client.close()] : []));
    this.connections.clear();
  }
}
