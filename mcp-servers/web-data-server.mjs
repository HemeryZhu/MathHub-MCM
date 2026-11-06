#!/usr/bin/env node
import { boundedInteger, MAX_TEXT_CHARS, requireString, startServer, textResult } from "./common.mjs";
import { safePublicFetch } from "./safe-http.mjs";

const tools = [
  {
    name: "web_search",
    description: "Search the public web. Uses Brave Search when BRAVE_SEARCH_API_KEY is configured; otherwise uses DuckDuckGo Instant Answer with more limited coverage.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query." },
        count: { type: "integer", minimum: 1, maximum: 10, default: 5 }
      },
      required: ["query"],
      additionalProperties: false
    }
  },
  {
    name: "fetch_url",
    description: "Fetch a public HTTP/HTTPS page and return readable text. Private-network and non-standard-port destinations are blocked.",
    inputSchema: {
      type: "object",
      properties: { url: { type: "string", format: "uri" } },
      required: ["url"],
      additionalProperties: false
    }
  },
  {
    name: "fetch_json",
    description: "Fetch and parse JSON from a public HTTP/HTTPS endpoint with SSRF and response-size protections.",
    inputSchema: {
      type: "object",
      properties: { url: { type: "string", format: "uri" } },
      required: ["url"],
      additionalProperties: false
    }
  }
];

const stripHtml = html => html
  .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
  .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
  .replace(/<[^>]+>/g, " ")
  .replace(/&nbsp;/gi, " ")
  .replace(/&amp;/gi, "&")
  .replace(/&lt;/gi, "<")
  .replace(/&gt;/gi, ">")
  .replace(/&#39;/gi, "'")
  .replace(/&quot;/gi, "\"")
  .replace(/\s+/g, " ")
  .trim();

const searchWeb = async args => {
  const query = requireString(args.query, "query", 500);
  const count = boundedInteger(args.count, 5, 1, 10);
  if (process.env.BRAVE_SEARCH_API_KEY) {
    const url = new URL("https://api.search.brave.com/res/v1/web/search");
    url.searchParams.set("q", query);
    url.searchParams.set("count", String(count));
    const { text } = await safePublicFetch(url.toString(), {
      headers: { Accept: "application/json", "X-Subscription-Token": process.env.BRAVE_SEARCH_API_KEY }
    });
    const data = JSON.parse(text);
    return {
      provider: "Brave Search",
      results: (data.web?.results || []).slice(0, count).map(item => ({ title: item.title, url: item.url, description: item.description }))
    };
  }
  try {
    const url = new URL("https://api.duckduckgo.com/");
    url.searchParams.set("q", query);
    url.searchParams.set("format", "json");
    url.searchParams.set("no_html", "1");
    url.searchParams.set("skip_disambig", "1");
    const { text } = await safePublicFetch(url.toString());
    const data = JSON.parse(text);
    const candidates = [];
    if (data.AbstractText) candidates.push({ title: data.Heading || query, url: data.AbstractURL, description: data.AbstractText });
    for (const topic of data.RelatedTopics || []) {
      const entries = Array.isArray(topic.Topics) ? topic.Topics : [topic];
      for (const entry of entries) {
        if (entry.FirstURL && entry.Text) candidates.push({ title: entry.Text.split(" - ")[0], url: entry.FirstURL, description: entry.Text });
      }
    }
    if (candidates.length > 0) return { provider: "DuckDuckGo Instant Answer", limitedFallback: true, results: candidates.slice(0, count) };
  } catch {
    // Continue to the public Wikipedia search fallback below.
  }
  const wikipediaUrl = new URL("https://en.wikipedia.org/w/api.php");
  wikipediaUrl.searchParams.set("action", "query");
  wikipediaUrl.searchParams.set("list", "search");
  wikipediaUrl.searchParams.set("srsearch", query);
  wikipediaUrl.searchParams.set("srlimit", String(count));
  wikipediaUrl.searchParams.set("format", "json");
  wikipediaUrl.searchParams.set("origin", "*");
  const { text } = await safePublicFetch(wikipediaUrl.toString(), { headers: { "User-Agent": "MathHub-Modulus/1.0" } });
  const data = JSON.parse(text);
  return {
    provider: "Wikipedia Search",
    limitedFallback: true,
    results: (data.query?.search || []).map(item => ({
      title: item.title,
      url: `https://en.wikipedia.org/wiki/${encodeURIComponent(item.title.replace(/ /g, "_"))}`,
      description: stripHtml(item.snippet || "")
    }))
  };
};

await startServer({
  name: "mathhub-web-data",
  tools,
  callTool: async (name, args) => {
    if (name === "web_search") return textResult(await searchWeb(args));
    if (name === "fetch_url") {
      const url = requireString(args.url, "url", 4_000);
      const { response, text, finalUrl, bytes } = await safePublicFetch(url);
      const contentType = response.headers.get("content-type") || "";
      const readable = /html|xml/i.test(contentType) ? stripHtml(text) : text;
      return textResult({ finalUrl, contentType, bytes, text: readable.slice(0, MAX_TEXT_CHARS), truncated: readable.length > MAX_TEXT_CHARS });
    }
    if (name === "fetch_json") {
      const url = requireString(args.url, "url", 4_000);
      const { response, text, finalUrl, bytes } = await safePublicFetch(url);
      const data = JSON.parse(text);
      const serialized = JSON.stringify(data);
      return textResult({
        finalUrl,
        contentType: response.headers.get("content-type") || "",
        bytes,
        data: serialized.length > MAX_TEXT_CHARS ? undefined : data,
        truncatedJsonText: serialized.length > MAX_TEXT_CHARS ? serialized.slice(0, MAX_TEXT_CHARS) : undefined,
        truncated: serialized.length > MAX_TEXT_CHARS
      });
    }
    throw new Error(`Unknown tool: ${name}`);
  }
});
