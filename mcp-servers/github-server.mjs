#!/usr/bin/env node
import { boundedInteger, fetchJson, requireString, startServer, textResult } from "./common.mjs";

const tools = [
  {
    name: "github_search_repositories",
    description: "Search GitHub repositories using the read-only GitHub REST API.",
    inputSchema: { type: "object", properties: { query: { type: "string" }, count: { type: "integer", minimum: 1, maximum: 20, default: 10 } }, required: ["query"], additionalProperties: false }
  },
  {
    name: "github_get_repository",
    description: "Read public or token-accessible GitHub repository metadata.",
    inputSchema: { type: "object", properties: { owner: { type: "string" }, repo: { type: "string" } }, required: ["owner", "repo"], additionalProperties: false }
  },
  {
    name: "github_get_file",
    description: "Read a text file from a GitHub repository. The server never writes to GitHub.",
    inputSchema: { type: "object", properties: { owner: { type: "string" }, repo: { type: "string" }, path: { type: "string" }, ref: { type: "string" } }, required: ["owner", "repo", "path"], additionalProperties: false }
  },
  {
    name: "github_search_issues",
    description: "Search GitHub issues and pull requests through the read-only REST API.",
    inputSchema: { type: "object", properties: { query: { type: "string" }, count: { type: "integer", minimum: 1, maximum: 20, default: 10 } }, required: ["query"], additionalProperties: false }
  }
];

const headers = (accept = "application/vnd.github+json") => {
  const value = { Accept: accept, "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "MathHub-Modulus" };
  if (process.env.GITHUB_TOKEN) value.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  return value;
};

const component = (value, name) => {
  const normalized = requireString(value, name, 200);
  if (!/^[A-Za-z0-9_.-]+$/.test(normalized)) throw new Error(`${name} contains invalid characters.`);
  return normalized;
};

const githubJson = async url => fetchJson(url, { headers: headers() });

await startServer({
  name: "mathhub-github",
  tools,
  callTool: async (name, args) => {
    if (name === "github_search_repositories") {
      const query = requireString(args.query, "query", 500);
      const count = boundedInteger(args.count, 10, 1, 20);
      const url = new URL("https://api.github.com/search/repositories");
      url.searchParams.set("q", query);
      url.searchParams.set("per_page", String(count));
      const data = await githubJson(url);
      return textResult({ totalCount: data.total_count, results: (data.items || []).map(item => ({ fullName: item.full_name, description: item.description, url: item.html_url, stars: item.stargazers_count, language: item.language, updatedAt: item.updated_at, license: item.license?.spdx_id || null })) });
    }
    if (name === "github_search_issues") {
      const query = requireString(args.query, "query", 500);
      const count = boundedInteger(args.count, 10, 1, 20);
      const url = new URL("https://api.github.com/search/issues");
      url.searchParams.set("q", query);
      url.searchParams.set("per_page", String(count));
      const data = await githubJson(url);
      return textResult({ totalCount: data.total_count, results: (data.items || []).map(item => ({ title: item.title, url: item.html_url, state: item.state, author: item.user?.login, createdAt: item.created_at, updatedAt: item.updated_at, pullRequest: Boolean(item.pull_request), body: (item.body || "").slice(0, 2_000) })) });
    }
    const owner = component(args.owner, "owner");
    const repo = component(args.repo, "repo");
    if (name === "github_get_repository") {
      const item = await githubJson(`https://api.github.com/repos/${owner}/${repo}`);
      return textResult({ fullName: item.full_name, description: item.description, url: item.html_url, defaultBranch: item.default_branch, stars: item.stargazers_count, forks: item.forks_count, openIssues: item.open_issues_count, language: item.language, topics: item.topics, license: item.license?.spdx_id || null, archived: item.archived, updatedAt: item.updated_at });
    }
    if (name === "github_get_file") {
      const filePath = requireString(args.path, "path", 2_000).replace(/^\/+/, "");
      if (filePath.split("/").some(part => part === "..")) throw new Error("path cannot contain '..'.");
      const url = new URL(`https://api.github.com/repos/${owner}/${repo}/contents/${filePath.split("/").map(encodeURIComponent).join("/")}`);
      if (args.ref !== undefined) url.searchParams.set("ref", requireString(args.ref, "ref", 200));
      const response = await fetch(url, { headers: headers("application/vnd.github.raw+json"), signal: AbortSignal.timeout(20_000) });
      if (!response.ok) throw new Error(`GitHub HTTP ${response.status}: ${(await response.text()).slice(0, 500)}`);
      const contentType = response.headers.get("content-type") || "";
      if (/application\/octet-stream/i.test(contentType)) throw new Error("Binary files are not supported.");
      const contentLength = Number(response.headers.get("content-length"));
      if (Number.isFinite(contentLength) && contentLength > 200_000) throw new Error("File exceeds the 200 KB limit.");
      const text = await response.text();
      if (text.length > 200_000 || text.includes("\u0000")) throw new Error("File is binary or exceeds the 200 KB limit.");
      return textResult({ repository: `${owner}/${repo}`, path: filePath, ref: args.ref || null, text });
    }
    throw new Error(`Unknown tool: ${name}`);
  }
});
