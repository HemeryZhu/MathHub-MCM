#!/usr/bin/env node
import { boundedInteger, fetchJson, requireString, startServer, textResult } from "./common.mjs";

const tools = [
  {
    name: "search_openalex",
    description: "Search scholarly works through the OpenAlex API and return titles, authors, DOI, source, year, citations, and open-access metadata.",
    inputSchema: {
      type: "object",
      properties: { query: { type: "string" }, count: { type: "integer", minimum: 1, maximum: 20, default: 10 } },
      required: ["query"], additionalProperties: false
    }
  },
  {
    name: "search_crossref",
    description: "Search scholarly metadata registered with Crossref.",
    inputSchema: {
      type: "object",
      properties: { query: { type: "string" }, count: { type: "integer", minimum: 1, maximum: 20, default: 10 } },
      required: ["query"], additionalProperties: false
    }
  },
  {
    name: "get_doi_metadata",
    description: "Retrieve Crossref metadata for one DOI.",
    inputSchema: {
      type: "object",
      properties: { doi: { type: "string" } },
      required: ["doi"], additionalProperties: false
    }
  }
];

const crossrefHeaders = () => ({
  Accept: "application/json",
  "User-Agent": `MathHub-Modulus/1.0${process.env.CROSSREF_MAILTO ? ` (mailto:${process.env.CROSSREF_MAILTO})` : ""}`
});

const crossrefWork = item => ({
  title: item.title?.[0] || "",
  authors: (item.author || []).map(author => [author.given, author.family].filter(Boolean).join(" ")).slice(0, 20),
  year: item.published?.["date-parts"]?.[0]?.[0] ?? item.created?.["date-parts"]?.[0]?.[0],
  doi: item.DOI || "",
  url: item.URL || "",
  type: item.type || "",
  publisher: item.publisher || "",
  containerTitle: item["container-title"]?.[0] || "",
  citationCount: item["is-referenced-by-count"] ?? 0
});

await startServer({
  name: "mathhub-academic-research",
  tools,
  callTool: async (name, args) => {
    if (name === "search_openalex") {
      const query = requireString(args.query, "query", 500);
      const count = boundedInteger(args.count, 10, 1, 20);
      const url = new URL("https://api.openalex.org/works");
      url.searchParams.set("search", query);
      url.searchParams.set("per-page", String(count));
      url.searchParams.set("select", "id,doi,title,publication_year,cited_by_count,authorships,primary_location,open_access");
      if (process.env.OPENALEX_API_KEY) url.searchParams.set("api_key", process.env.OPENALEX_API_KEY);
      if (process.env.OPENALEX_EMAIL) url.searchParams.set("mailto", process.env.OPENALEX_EMAIL);
      const data = await fetchJson(url, { headers: { "User-Agent": "MathHub-Modulus/1.0" } });
      return textResult({
        provider: "OpenAlex",
        count: data.meta?.count,
        results: (data.results || []).map(item => ({
          title: item.title,
          year: item.publication_year,
          doi: item.doi,
          openAlexId: item.id,
          citationCount: item.cited_by_count,
          authors: (item.authorships || []).map(authorship => authorship.author?.display_name).filter(Boolean).slice(0, 20),
          source: item.primary_location?.source?.display_name || "",
          landingPage: item.primary_location?.landing_page_url || "",
          openAccess: item.open_access || null
        }))
      });
    }
    if (name === "search_crossref") {
      const query = requireString(args.query, "query", 500);
      const count = boundedInteger(args.count, 10, 1, 20);
      const url = new URL("https://api.crossref.org/works");
      url.searchParams.set("query", query);
      url.searchParams.set("rows", String(count));
      if (process.env.CROSSREF_MAILTO) url.searchParams.set("mailto", process.env.CROSSREF_MAILTO);
      const data = await fetchJson(url, { headers: crossrefHeaders() });
      return textResult({ provider: "Crossref", totalResults: data.message?.["total-results"], results: (data.message?.items || []).map(crossrefWork) });
    }
    if (name === "get_doi_metadata") {
      const doi = requireString(args.doi, "doi", 500).replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, "");
      const url = new URL(`https://api.crossref.org/works/${encodeURIComponent(doi)}`);
      if (process.env.CROSSREF_MAILTO) url.searchParams.set("mailto", process.env.CROSSREF_MAILTO);
      const data = await fetchJson(url, { headers: crossrefHeaders() });
      return textResult({ provider: "Crossref", result: crossrefWork(data.message || {}) });
    }
    throw new Error(`Unknown tool: ${name}`);
  }
});
