#!/usr/bin/env node
import pg from "pg";
import { boundedInteger, requireString, startServer, textResult } from "./common.mjs";

const { Client } = pg;

const tools = [
  {
    name: "database_status",
    description: "Report whether the read-only PostgreSQL MCP is configured, without exposing credentials.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false }
  },
  {
    name: "database_list_tables",
    description: "List tables and views visible to the configured PostgreSQL account.",
    inputSchema: { type: "object", properties: { schema: { type: "string", default: "public" } }, additionalProperties: false }
  },
  {
    name: "database_describe_table",
    description: "Describe columns for a PostgreSQL table or view.",
    inputSchema: { type: "object", properties: { schema: { type: "string", default: "public" }, table: { type: "string" } }, required: ["table"], additionalProperties: false }
  },
  {
    name: "database_query_readonly",
    description: "Execute one read-only PostgreSQL query inside a READ ONLY transaction. Results are capped at 1000 rows.",
    inputSchema: { type: "object", properties: { sql: { type: "string" }, maxRows: { type: "integer", minimum: 1, maximum: 1000, default: 200 } }, required: ["sql"], additionalProperties: false }
  }
];

const identifier = (value, name, fallback) => {
  const normalized = value === undefined && fallback ? fallback : requireString(value, name, 128);
  if (!/^[A-Za-z_][A-Za-z0-9_$]*$/.test(normalized)) throw new Error(`${name} is not a safe PostgreSQL identifier.`);
  return normalized;
};

const databaseOptions = () => {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is not configured.");
  return {
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_SSL === "true" ? { rejectUnauthorized: true } : undefined,
    connectionTimeoutMillis: 10_000,
    statement_timeout: 20_000,
    query_timeout: 25_000,
    application_name: "mathhub-modulus-mcp"
  };
};

const withReadOnlyClient = async operation => {
  const client = new Client(databaseOptions());
  await client.connect();
  try {
    await client.query("BEGIN READ ONLY");
    await client.query("SET LOCAL statement_timeout = '20s'");
    const result = await operation(client);
    await client.query("ROLLBACK");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    await client.end();
  }
};

const validateReadOnlySql = value => {
  const sql = requireString(value, "sql", 20_000).trim();
  const withoutTrailingSemicolon = sql.replace(/;\s*$/, "");
  if (withoutTrailingSemicolon.includes(";")) throw new Error("Only one SQL statement is allowed.");
  if (/\/\*|--/.test(withoutTrailingSemicolon)) throw new Error("SQL comments are not allowed.");
  if (!/^(select|with|explain|show|values)\b/i.test(withoutTrailingSemicolon)) throw new Error("Only SELECT, WITH, EXPLAIN, SHOW, or VALUES queries are allowed.");
  return withoutTrailingSemicolon;
};

await startServer({
  name: "mathhub-database",
  tools,
  callTool: async (name, args) => {
    if (name === "database_status") return textResult({ engine: "PostgreSQL", configured: Boolean(process.env.DATABASE_URL), mode: "read-only", credentialsExposed: false });
    if (name === "database_list_tables") {
      const schema = identifier(args.schema, "schema", "public");
      const result = await withReadOnlyClient(client => client.query(
        `SELECT table_schema, table_name, table_type FROM information_schema.tables WHERE table_schema = $1 ORDER BY table_name LIMIT 1000`,
        [schema]
      ));
      return textResult({ schema, tables: result.rows });
    }
    if (name === "database_describe_table") {
      const schema = identifier(args.schema, "schema", "public");
      const table = identifier(args.table, "table");
      const result = await withReadOnlyClient(client => client.query(
        `SELECT ordinal_position, column_name, data_type, is_nullable, column_default FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2 ORDER BY ordinal_position`,
        [schema, table]
      ));
      return textResult({ schema, table, columns: result.rows });
    }
    if (name === "database_query_readonly") {
      const sql = validateReadOnlySql(args.sql);
      const maxRows = boundedInteger(args.maxRows, 200, 1, 1000);
      const result = await withReadOnlyClient(client => client.query(sql));
      return textResult({ command: result.command, rowCount: result.rowCount, fields: result.fields.map(field => ({ name: field.name, dataTypeId: field.dataTypeID })), rows: result.rows.slice(0, maxRows), truncated: result.rows.length > maxRows });
    }
    throw new Error(`Unknown tool: ${name}`);
  }
});
