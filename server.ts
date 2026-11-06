import express from "express";
import path from "path";
import fs from "fs";
import { createServer as createViteServer } from "vite";
import { GoogleGenAI } from "@google/genai";
import dotenv from "dotenv";
import multer from "multer";
import mammoth from "mammoth";
import sharp from "sharp";
import WordExtractor from "word-extractor";
import XLSX from "xlsx";
import JSZip from "jszip";
import os from "os";
import crypto from "crypto";
import { spawn } from "child_process";
import { buildModelingPaperBuffer, type EmbeddedWordImage } from "./word-document.js";
import { buildModelingPaperPdf } from "./pdf-document.js";
import { McpClientManager } from "./mcp-client.js";
import { executeAgentTurn, streamAgentTurn, type AgentConversationMessage, type CustomTextProvider } from "./agent-runtime.js";
import { PythonApprovalAuthority, type PythonApprovalManifest } from "./python-approval.js";

dotenv.config();

const normalizeCustomTextProvider = (value: unknown): CustomTextProvider => (
  value === "openai" || value === "anthropic" || value === "bailian" ? value : "bailian"
);

const customTextProviderName = (provider: CustomTextProvider) => (
  provider === "openai" ? "OpenAI" : provider === "anthropic" ? "Claude (Anthropic)" : "阿里云百炼"
);

const extractModelText = (value: unknown): string => {
  if (typeof value === "string") return value.trim();
  if (!Array.isArray(value)) return "";
  return value.map(block => {
    if (typeof block === "string") return block;
    if (!block || typeof block !== "object") return "";
    const candidate = block as { text?: unknown; content?: unknown };
    return typeof candidate.text === "string"
      ? candidate.text
      : typeof candidate.content === "string"
        ? candidate.content
        : "";
  }).join("").trim();
};

// A text-only compatibility turn can still complete the task when a selected
// model rejects native Function Calling parameters.  Credentials, billing and
// rate-limit failures must remain visible instead of being masked by a retry.
const canFallbackToCompatibilityMode = (message: string) => !/api key|authentication|unauthorized|forbidden|quota|rate limit|余额|密钥|限流|鉴权|权限/i.test(message);

// Set up polyfills BEFORE pdfjs-dist is imported (must be at module scope, before any import uses it)
(global as any).DOMMatrix = class DOMMatrix {
  a = 1; b = 0; c = 0; d = 1; e = 0; f = 0;
  isIdentity = true;
  constructor(_?: string | number[]) {}
  multiply() { return this; }
  translate() { return this; }
  scale() { return this; }
  rotate() { return this; }
};
(global as any).HTMLCanvasElement = class {};
(global as any).Image = class {};

// pdfjs-dist is loaded dynamically inside startServer() so polyfills are ready first
let pdfjsLib: any = null;

type TableCell = string | number | boolean | Date | null | undefined;
type TableRow = TableCell[];

const normalizeTableCell = (value: TableCell) => {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value ?? "").replace(/\r?\n/g, " ").trim();
};

const isMissingCell = (value: TableCell) => {
  const normalized = normalizeTableCell(value).toLowerCase();
  return normalized === "" || ["na", "n/a", "null", "none", "undefined", "nan", "-"] .includes(normalized);
};

const isLikelyDateValue = (value: TableCell) => {
  if (value instanceof Date) return true;
  const normalized = normalizeTableCell(value);
  if (!normalized) return false;
  return /^\d{4}[-\/]\d{1,2}[-\/]\d{1,2}(?:\s+\d{1,2}:\d{2}(?::\d{2})?)?$/.test(normalized)
    || /^\d{1,2}[-\/]\d{1,2}[-\/]\d{2,4}$/.test(normalized);
};

const parseNumericValue = (value: TableCell) => {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const normalized = normalizeTableCell(value);
  if (!normalized) return null;
  const compact = normalized.replace(/,/g, "").replace(/%$/, "");
  if (!/^[-+]?\d*\.?\d+(?:e[-+]?\d+)?$/i.test(compact)) return null;
  const parsed = Number(compact);
  return Number.isFinite(parsed) ? parsed : null;
};

const inferHeaderRowIndex = (rows: TableRow[]) => {
  const candidates = rows.slice(0, 5);
  let bestIndex = 0;
  let bestScore = Number.NEGATIVE_INFINITY;

  candidates.forEach((row, index) => {
    const normalized = row.map(normalizeTableCell);
    const nonEmpty = normalized.filter(Boolean);
    if (nonEmpty.length === 0) return;

    const uniqueCount = new Set(nonEmpty).size;
    const numericCount = row.filter((cell) => parseNumericValue(cell) !== null).length;
    const score = nonEmpty.length * 2 + uniqueCount - numericCount * 1.5;

    if (score > bestScore) {
      bestScore = score;
      bestIndex = index;
    }
  });

  return bestIndex;
};

const summarizeTableRows = (rows: TableRow[], sheetName: string, index: number) => {
  const nonEmptyRows = rows.filter((row) => row.some((cell) => !isMissingCell(cell)));
  if (nonEmptyRows.length === 0) {
    return `【工作表 ${index + 1}: ${sheetName}】\n[空工作表]`;
  }

  const headerRowIndex = inferHeaderRowIndex(nonEmptyRows);
  const headerRow = nonEmptyRows[headerRowIndex] || [];
  const dataRows = nonEmptyRows.slice(headerRowIndex + 1);
  const columnCount = Math.max(
    headerRow.length,
    ...dataRows.slice(0, 200).map((row) => row.length),
    0,
  );

  const headers = Array.from({ length: columnCount }, (_, colIndex) => {
    const rawHeader = normalizeTableCell(headerRow[colIndex]);
    return rawHeader || `第${colIndex + 1}列`;
  });

  const columnSummaries = headers.map((header, colIndex) => {
    const values = dataRows.map((row) => row[colIndex]);
    const nonMissingValues = values.filter((value) => !isMissingCell(value));
    const missingCount = values.length - nonMissingValues.length;
    const sampleValues = Array.from(new Set(nonMissingValues.map(normalizeTableCell).filter(Boolean))).slice(0, 3);

    const numericValues = nonMissingValues
      .map(parseNumericValue)
      .filter((value): value is number => value !== null);
    const dateCount = nonMissingValues.filter(isLikelyDateValue).length;
    const textCount = Math.max(nonMissingValues.length - numericValues.length - dateCount, 0);

    let typeLabel = "混合";
    if (numericValues.length > 0 && numericValues.length >= Math.max(2, nonMissingValues.length * 0.6)) {
      typeLabel = "数值列";
    } else if (dateCount > 0 && dateCount >= Math.max(2, nonMissingValues.length * 0.6)) {
      typeLabel = "时间列";
    } else if (textCount > 0) {
      typeLabel = "文本列";
    }

    const hints: string[] = [];
    if (missingCount > 0) hints.push(`缺失值 ${missingCount}`);
    if (typeLabel === "时间列") hints.push("疑似时间字段");

    if (typeLabel === "数值列" && numericValues.length >= 4) {
      const min = Math.min(...numericValues);
      const max = Math.max(...numericValues);
      const mean = numericValues.reduce((sum, value) => sum + value, 0) / numericValues.length;
      const variance = numericValues.reduce((sum, value) => sum + (value - mean) ** 2, 0) / numericValues.length;
      const std = Math.sqrt(variance);
      const outlierCount = std > 0
        ? numericValues.filter((value) => Math.abs(value - mean) > 3 * std).length
        : 0;

      hints.push(`范围 ${min} ~ ${max}`);
      if (outlierCount > 0) hints.push(`疑似异常值 ${outlierCount}`);
    }

    return `- ${header}｜${typeLabel}｜样例: ${sampleValues.length > 0 ? sampleValues.join(" / ") : "[无样例]"}${hints.length > 0 ? `｜${hints.join("；")}` : ""}`;
  });

  const previewRows = dataRows.slice(0, 5).map((row, rowIndex) => {
    const cells = headers.map((header, colIndex) => `${header}=${normalizeTableCell(row[colIndex]) || ""}`);
    return `样例行${rowIndex + 1}: ${cells.join(" | ")}`;
  });

  const overallHints: string[] = [];
  const numericColumnCount = columnSummaries.filter((line) => line.includes("数值列")).length;
  const textColumnCount = columnSummaries.filter((line) => line.includes("文本列")).length;
  const timeColumnCount = columnSummaries.filter((line) => line.includes("时间列")).length;
  overallHints.push(`数值列 ${numericColumnCount} 个，文本列 ${textColumnCount} 个，时间列 ${timeColumnCount} 个`);

  return [
    `【工作表 ${index + 1}: ${sheetName}】`,
    `表头识别: 第 ${headerRowIndex + 1} 行`,
    `数据行数: ${dataRows.length}`,
    `列数: ${headers.length}`,
    `列摘要:`,
    ...columnSummaries,
    previewRows.length > 0 ? `前几行样例:\n${previewRows.join("\n")}` : "前几行样例: [无数据行]",
    `总体提示: ${overallHints.join("；")}`,
  ].join("\n");
};

const summarizeWorkbook = (workbook: XLSX.WorkBook, filename: string) => {
  const sheetSummaries = workbook.SheetNames.map((sheetName, index) => {
    const sheet = workbook.Sheets[sheetName];
    const rows = XLSX.utils.sheet_to_json<TableRow>(sheet, {
      header: 1,
      raw: true,
      defval: "",
    });
    return summarizeTableRows(rows, sheetName, index);
  });

  return sheetSummaries.length > 0
    ? `[表格文件: ${filename}]\n[通过本地表格解析与结构化摘要]\n${sheetSummaries.join("\n\n")}`
    : `[表格文件: ${filename}]\n[未检测到可读取的工作表内容]`;
};

type WordParagraphKind = "title" | "heading1" | "heading2" | "heading3" | "body" | "bullet" | "number" | "code";

type WordParagraph = {
  kind: WordParagraphKind;
  text: string;
};

const escapeXml = (value: string) => value
  .replace(/&/g, "&amp;")
  .replace(/</g, "&lt;")
  .replace(/>/g, "&gt;")
  .replace(/"/g, "&quot;")
  .replace(/'/g, "&apos;");

const sanitizeWordFilename = (value: string) => {
  const normalized = value.trim().replace(/[\\/:*?"<>|]/g, "-").replace(/\s+/g, " ");
  const withoutExtension = normalized.replace(/\.docx$/i, "");
  return `${withoutExtension || "Modulus-报告"}.docx`;
};

const sanitizePdfFilename = (value: string) => {
  const normalized = value.trim().replace(/[\\/:*?"<>|]/g, "-").replace(/\s+/g, " ");
  const withoutExtension = normalized.replace(/\.pdf$/i, "");
  return `${withoutExtension || "Modulus-建模论文"}.pdf`;
};

const markdownToWordParagraphs = (title: string, markdown: string): WordParagraph[] => {
  const paragraphs: WordParagraph[] = [{ kind: "title", text: title.trim() || "Modulus 智能体报告" }];
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  let inCodeBlock = false;

  for (const rawLine of lines) {
    const line = rawLine.replace(/\s+$/, "");
    if (/^\s*```/.test(line)) {
      inCodeBlock = !inCodeBlock;
      continue;
    }
    if (inCodeBlock) {
      paragraphs.push({ kind: "code", text: line || " " });
      continue;
    }

    const heading = line.match(/^(#{1,3})\s+(.+)$/);
    if (heading) {
      if (paragraphs.length === 1 && heading[2].trim() === paragraphs[0].text) continue;
      paragraphs.push({
        kind: heading[1].length === 1 ? "heading1" : heading[1].length === 2 ? "heading2" : "heading3",
        text: heading[2].trim()
      });
      continue;
    }

    const bullet = line.match(/^\s*[-*+]\s+(.+)$/);
    if (bullet) {
      paragraphs.push({ kind: "bullet", text: bullet[1].trim() });
      continue;
    }

    const numbered = line.match(/^\s*\d+[.)、]\s+(.+)$/);
    if (numbered) {
      paragraphs.push({ kind: "number", text: numbered[1].trim() });
      continue;
    }

    paragraphs.push({ kind: "body", text: line.trim() });
  }

  return paragraphs;
};

const buildWordRunsXml = (text: string, isCodeParagraph = false) => {
  if (isCodeParagraph) {
    const preserve = /^\s|\s$|\s{2,}/.test(text) ? ' xml:space="preserve"' : "";
    return `<w:r><w:t${preserve}>${escapeXml(text || " ")}</w:t></w:r>`;
  }

  const runs: string[] = [];
  const tokenPattern = /(\*\*[^*]+\*\*|`[^`]+`|\*[^*]+\*)/g;
  let cursor = 0;
  let match: RegExpExecArray | null;

  const pushRun = (value: string, properties = "") => {
    if (!value) return;
    const preserve = /^\s|\s$|\s{2,}/.test(value) ? ' xml:space="preserve"' : "";
    runs.push(`<w:r>${properties ? `<w:rPr>${properties}</w:rPr>` : ""}<w:t${preserve}>${escapeXml(value)}</w:t></w:r>`);
  };

  while ((match = tokenPattern.exec(text)) !== null) {
    pushRun(text.slice(cursor, match.index));
    const token = match[0];
    if (token.startsWith("**")) {
      pushRun(token.slice(2, -2), "<w:b/><w:bCs/>");
    } else if (token.startsWith("`")) {
      pushRun(token.slice(1, -1), '<w:rFonts w:ascii="Consolas" w:hAnsi="Consolas" w:eastAsia="等线"/><w:shd w:val="clear" w:color="auto" w:fill="F2F4F7"/>');
    } else {
      pushRun(token.slice(1, -1), "<w:i/><w:iCs/>");
    }
    cursor = match.index + token.length;
  }
  pushRun(text.slice(cursor));
  return runs.join("") || "<w:r><w:t> </w:t></w:r>";
};

const buildWordParagraphXml = (paragraph: WordParagraph) => {
  const styleByKind: Record<WordParagraphKind, string> = {
    title: "Title",
    heading1: "Heading1",
    heading2: "Heading2",
    heading3: "Heading3",
    body: "Normal",
    bullet: "Normal",
    number: "Normal",
    code: "Code"
  };
  const numbering = paragraph.kind === "bullet"
    ? '<w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr>'
    : paragraph.kind === "number"
      ? '<w:numPr><w:ilvl w:val="0"/><w:numId w:val="2"/></w:numPr>'
      : "";

  return [
    "<w:p>",
    `<w:pPr><w:pStyle w:val="${styleByKind[paragraph.kind]}"/>${numbering}</w:pPr>`,
    buildWordRunsXml(paragraph.text || " ", paragraph.kind === "code"),
    "</w:p>"
  ].join("");
};

const buildWordDocumentBuffer = async (title: string, markdown: string) => {
  const zip = new JSZip();
  const paragraphs = markdownToWordParagraphs(title, markdown).map(buildWordParagraphXml).join("");
  const createdAt = new Date().toISOString();

  zip.file("[Content_Types].xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
  <Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
  <Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/>
  <Override PartName="/word/settings.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml"/>
  <Override PartName="/word/header1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml"/>
  <Override PartName="/word/footer1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml"/>
  <Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
  <Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>
</Types>`);

  zip.folder("_rels")?.file(".rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>
  <Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>
</Relationships>`);

  zip.folder("docProps")?.file("core.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <dc:title>${escapeXml(title)}</dc:title>
  <dc:creator>Modulus 智能体</dc:creator>
  <cp:lastModifiedBy>Modulus 智能体</cp:lastModifiedBy>
  <dcterms:created xsi:type="dcterms:W3CDTF">${createdAt}</dcterms:created>
  <dcterms:modified xsi:type="dcterms:W3CDTF">${createdAt}</dcterms:modified>
</cp:coreProperties>`);

  zip.folder("docProps")?.file("app.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">
  <Application>MathHub Modulus</Application>
</Properties>`);

  const word = zip.folder("word");
  word?.file("document.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <w:body>
    ${paragraphs}
    <w:sectPr>
      <w:headerReference w:type="default" r:id="rId4"/>
      <w:footerReference w:type="default" r:id="rId5"/>
      <w:pgSz w:w="12240" w:h="15840"/>
      <w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="708" w:footer="708" w:gutter="0"/>
    </w:sectPr>
  </w:body>
</w:document>`);

  word?.folder("_rels")?.file("document.xml.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/>
  <Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/settings" Target="settings.xml"/>
  <Relationship Id="rId4" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/header" Target="header1.xml"/>
  <Relationship Id="rId5" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footer" Target="footer1.xml"/>
</Relationships>`);

  word?.file("styles.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:docDefaults>
    <w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:eastAsia="微软雅黑"/><w:sz w:val="22"/><w:szCs w:val="22"/><w:lang w:val="zh-CN" w:eastAsia="zh-CN"/></w:rPr></w:rPrDefault>
    <w:pPrDefault><w:pPr><w:spacing w:after="120" w:line="264" w:lineRule="auto"/></w:pPr></w:pPrDefault>
  </w:docDefaults>
  <w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/><w:pPr><w:spacing w:after="120" w:line="264" w:lineRule="auto"/></w:pPr></w:style>
  <w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:spacing w:before="0" w:after="240"/><w:keepNext/></w:pPr><w:rPr><w:b/><w:color w:val="0B2545"/><w:sz w:val="48"/><w:szCs w:val="48"/></w:rPr></w:style>
  <w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:keepNext/><w:outlineLvl w:val="0"/><w:spacing w:before="320" w:after="160"/></w:pPr><w:rPr><w:b/><w:color w:val="2E74B5"/><w:sz w:val="32"/><w:szCs w:val="32"/></w:rPr></w:style>
  <w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:keepNext/><w:outlineLvl w:val="1"/><w:spacing w:before="240" w:after="120"/></w:pPr><w:rPr><w:b/><w:color w:val="2E74B5"/><w:sz w:val="26"/><w:szCs w:val="26"/></w:rPr></w:style>
  <w:style w:type="paragraph" w:styleId="Heading3"><w:name w:val="heading 3"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:keepNext/><w:outlineLvl w:val="2"/><w:spacing w:before="160" w:after="80"/></w:pPr><w:rPr><w:b/><w:color w:val="1F4D78"/><w:sz w:val="24"/><w:szCs w:val="24"/></w:rPr></w:style>
  <w:style w:type="paragraph" w:styleId="Code"><w:name w:val="Code"/><w:basedOn w:val="Normal"/><w:pPr><w:spacing w:after="0" w:line="240" w:lineRule="auto"/><w:shd w:val="clear" w:color="auto" w:fill="F6F8FA"/><w:ind w:left="180" w:right="180"/></w:pPr><w:rPr><w:rFonts w:ascii="Consolas" w:hAnsi="Consolas" w:eastAsia="等线"/><w:sz w:val="18"/><w:szCs w:val="18"/></w:rPr></w:style>
</w:styles>`);

  word?.file("numbering.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:abstractNum w:abstractNumId="0"><w:multiLevelType w:val="singleLevel"/><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="bullet"/><w:lvlText w:val="•"/><w:lvlJc w:val="left"/><w:pPr><w:tabs><w:tab w:val="num" w:pos="720"/></w:tabs><w:ind w:left="720" w:hanging="360"/><w:spacing w:after="160" w:line="280" w:lineRule="auto"/></w:pPr><w:rPr><w:rFonts w:ascii="Arial" w:hAnsi="Arial"/></w:rPr></w:lvl></w:abstractNum>
  <w:abstractNum w:abstractNumId="1"><w:multiLevelType w:val="singleLevel"/><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:lvlText w:val="%1."/><w:lvlJc w:val="left"/><w:pPr><w:tabs><w:tab w:val="num" w:pos="720"/></w:tabs><w:ind w:left="720" w:hanging="360"/><w:spacing w:after="160" w:line="280" w:lineRule="auto"/></w:pPr></w:lvl></w:abstractNum>
  <w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>
  <w:num w:numId="2"><w:abstractNumId w:val="1"/></w:num>
</w:numbering>`);

  word?.file("settings.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:settings xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:zoom w:percent="100"/><w:defaultTabStop w:val="720"/><w:compat/></w:settings>`);

  word?.file("header1.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:hdr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:p><w:pPr><w:jc w:val="right"/><w:spacing w:after="0"/></w:pPr><w:r><w:rPr><w:color w:val="8C959F"/><w:sz w:val="18"/></w:rPr><w:t>${escapeXml(title)}</w:t></w:r></w:p></w:hdr>`);

  word?.file("footer1.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:ftr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:p><w:pPr><w:jc w:val="right"/><w:spacing w:after="0"/></w:pPr><w:r><w:rPr><w:color w:val="8C959F"/><w:sz w:val="18"/></w:rPr><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve"> PAGE </w:instrText></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r></w:p></w:ftr>`);

  return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE", compressionOptions: { level: 6 } });
};

const PYTHON_MAX_UPLOAD_BYTES = 60 * 1024 * 1024;
const PYTHON_MAX_RESULT_BYTES = 24 * 1024 * 1024;
const PYTHON_MAX_RESULT_FILE_BYTES = 12 * 1024 * 1024;
const PYTHON_MAX_OUTPUT_CHARS = 80_000;
const PYTHON_MAX_WORKSPACE_BYTES = 256 * 1024 * 1024;
const PYTHON_MAX_WORKSPACE_FILES = 2_000;
const PYTHON_INTERNAL_RUNNER = ".modulus_runner.py";

const normalizePythonWorkspacePath = (rawPath: unknown) => {
  if (typeof rawPath !== "string" || !rawPath.trim()) {
    throw new Error("Python 文件路径不能为空。");
  }
  const normalized = rawPath.trim().replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\/+|\/+$/g, "");
  if (/^[a-zA-Z]:/.test(normalized)) throw new Error("Python 执行只允许工程内相对路径。");
  const parts = normalized.split("/").filter(Boolean);
  if (parts.length === 0 || parts.some(part => part === "." || part === ".." || part.includes("\0"))) {
    throw new Error("Python 文件路径包含不安全的目录跳转。");
  }
  return parts.join("/");
};

const resolvePythonWorkspacePath = (workspace: string, relativePath: string) => {
  const resolvedWorkspace = path.resolve(workspace);
  const resolved = path.resolve(resolvedWorkspace, ...relativePath.split("/"));
  if (resolved !== resolvedWorkspace && !resolved.startsWith(`${resolvedWorkspace}${path.sep}`)) {
    throw new Error("Python 文件路径超出临时工作区。");
  }
  return resolved;
};

const normalizePythonApprovalManifest = (raw: any): PythonApprovalManifest => {
  const entrypoint = normalizePythonWorkspacePath(raw?.entrypoint);
  if (!entrypoint.toLowerCase().endsWith(".py")) throw new Error("entrypoint 必须是 .py 文件。");
  if (!Array.isArray(raw?.files) || raw.files.length === 0 || raw.files.length > 80) {
    throw new Error("Python 授权文件清单必须包含 1-80 个文件。");
  }
  const files = raw.files.map((file: any) => {
    const normalizedPath = normalizePythonWorkspacePath(file?.path);
    const size = Number(file?.size);
    const sha256 = typeof file?.sha256 === "string" ? file.sha256.toLowerCase() : "";
    if (!Number.isInteger(size) || size < 0 || size > 20 * 1024 * 1024 || !/^[a-f0-9]{64}$/.test(sha256)) {
      throw new Error(`Python 授权文件信息无效：${normalizedPath}`);
    }
    return { path: normalizedPath, size, sha256 };
  });
  if (new Set(files.map(file => file.path)).size !== files.length || !files.some(file => file.path === entrypoint)) {
    throw new Error("Python 授权文件清单重复或不包含入口脚本。");
  }
  if (files.reduce((sum, file) => sum + file.size, 0) > PYTHON_MAX_UPLOAD_BYTES) {
    throw new Error("Python 授权输入文件总量超过 60MB。");
  }
  const argumentsList = Array.isArray(raw?.arguments) ? raw.arguments : [];
  if (argumentsList.length > 30 || argumentsList.some((value: unknown) => typeof value !== "string" || value.length > 2_000)) {
    throw new Error("Python 授权参数数量或长度超过限制。");
  }
  const timeoutValue = Number(raw?.timeoutSeconds);
  const timeoutSeconds = Number.isFinite(timeoutValue) ? Math.min(120, Math.max(5, Math.round(timeoutValue))) : 60;
  return { entrypoint, files, arguments: argumentsList, timeoutSeconds };
};

const hashBuffer = (buffer: Buffer) => crypto.createHash("sha256").update(buffer).digest("hex");

const pythonResultMimeType = (filename: string) => {
  const extension = path.extname(filename).toLowerCase();
  const mapping: Record<string, string> = {
    ".txt": "text/plain; charset=utf-8",
    ".md": "text/markdown; charset=utf-8",
    ".json": "application/json",
    ".csv": "text/csv; charset=utf-8",
    ".html": "text/html; charset=utf-8",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".svg": "image/svg+xml",
    ".pdf": "application/pdf",
    ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ".npy": "application/octet-stream",
    ".npz": "application/octet-stream",
    ".pkl": "application/octet-stream"
  };
  return mapping[extension] || "application/octet-stream";
};

const PYTHON_RUNNER_SOURCE = String.raw`import ast
import os
import runpy
import sys

workspace = os.path.realpath(sys.argv[1])
entrypoint = os.path.realpath(sys.argv[2])
user_args = sys.argv[3:]
python_roots = tuple({os.path.realpath(sys.prefix), os.path.realpath(sys.base_prefix)})

BANNED_IMPORT_ROOTS = {
    "ctypes", "ftplib", "http", "multiprocessing", "requests", "socket",
    "subprocess", "telnetlib", "urllib", "webbrowser"
}
BANNED_CALLS = {
    "eval", "exec", "compile", "__import__", "os.system", "os.popen", "os.startfile",
    "os.kill", "os.killpg", "os.fork", "os.forkpty"
}
BANNED_CALL_PREFIXES = ("subprocess.", "socket.", "ctypes.", "os.spawn", "os.exec")

def dotted_name(node):
    if isinstance(node, ast.Name):
        return node.id
    if isinstance(node, ast.Attribute):
        parent = dotted_name(node.value)
        return f"{parent}.{node.attr}" if parent else node.attr
    return ""

def preflight_python_sources():
    for current_root, directories, files in os.walk(workspace):
        directories[:] = [name for name in directories if name not in {".modulus-temp", "__pycache__"}]
        for filename in files:
            candidate = os.path.join(current_root, filename)
            if not filename.lower().endswith(".py") or os.path.realpath(candidate) == os.path.realpath(__file__):
                continue
            try:
                with open(candidate, "r", encoding="utf-8-sig") as source_file:
                    tree = ast.parse(source_file.read(), filename=os.path.relpath(candidate, workspace))
            except (UnicodeError, SyntaxError) as error:
                raise PermissionError(f"Modulus Python 预检失败：{error}") from error
            for node in ast.walk(tree):
                if isinstance(node, ast.Import):
                    names = [alias.name for alias in node.names]
                elif isinstance(node, ast.ImportFrom):
                    names = [node.module or ""]
                else:
                    names = []
                for name in names:
                    if name.split(".", 1)[0] in BANNED_IMPORT_ROOTS:
                        raise PermissionError(f"Modulus Python 安全限制：禁止在用户脚本中导入 {name}（第 {getattr(node, 'lineno', '?')} 行）")
                if isinstance(node, ast.Call):
                    called = dotted_name(node.func)
                    if called in BANNED_CALLS or any(called.startswith(prefix) for prefix in BANNED_CALL_PREFIXES):
                        raise PermissionError(f"Modulus Python 安全限制：禁止调用 {called}（第 {getattr(node, 'lineno', '?')} 行）")

preflight_python_sources()

try:
    import resource
    max_file_bytes = int(os.environ.get("MODULUS_MAX_FILE_BYTES", str(64 * 1024 * 1024)))
    resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
    resource.setrlimit(resource.RLIMIT_FSIZE, (max_file_bytes, max_file_bytes))
    resource.setrlimit(resource.RLIMIT_NOFILE, (256, 256))
except (ImportError, AttributeError, OSError, ValueError):
    pass

def within(candidate, roots):
    if isinstance(candidate, int):
        return True
    try:
        resolved = os.path.realpath(os.fsdecode(os.fspath(candidate)))
    except (TypeError, ValueError):
        return False
    return any(resolved == root or resolved.startswith(root + os.sep) for root in roots)

def require_workspace(candidate, action):
    if not within(candidate, (workspace,)):
        raise PermissionError(f"Modulus Python 安全限制：{action} 只能发生在工程临时工作区内")

def audit(event, args):
    if event == "open" and args:
        candidate = args[0]
        mode = args[1] if len(args) > 1 else "r"
        flags = args[2] if len(args) > 2 else 0
        writing = False
        if isinstance(mode, str):
            writing = any(flag in mode for flag in ("w", "a", "x", "+"))
        elif isinstance(flags, int):
            writing = bool(flags & (os.O_WRONLY | os.O_RDWR | os.O_APPEND | os.O_CREAT | os.O_TRUNC))
        if writing:
            require_workspace(candidate, "写入文件")
        elif not within(candidate, (workspace,) + python_roots):
            raise PermissionError("Modulus Python 安全限制：禁止读取工程和 Python 环境之外的文件")
        return

    if event in {"os.listdir", "os.scandir"} and args and not within(args[0], (workspace,) + python_roots):
        raise PermissionError("Modulus Python 安全限制：禁止浏览工程之外的目录")

    if event == "os.chdir" and args:
        require_workspace(args[0], "切换目录")

    if event in {"os.remove", "os.rmdir", "os.mkdir", "os.chmod", "os.truncate"} and args:
        require_workspace(args[0], event)

    if event in {"os.rename", "os.replace"} and len(args) >= 2:
        require_workspace(args[0], event)
        require_workspace(args[1], event)

    if event in {
        "subprocess.Popen", "os.system", "os.startfile", "os.spawn", "os.posix_spawn",
        "os.exec", "os.fork", "os.forkpty", "pty.spawn",
        "socket.connect", "socket.bind", "socket.getaddrinfo", "socket.gethostbyname", "socket.sendto",
        "os.link", "os.symlink", "os.kill", "os.killpg"
    }:
        raise PermissionError(f"Modulus Python 安全限制：禁止执行 {event}")

sys.addaudithook(audit)
os.chdir(workspace)
sys.path.insert(0, workspace)
sys.argv = [entrypoint, *user_args]
runpy.run_path(entrypoint, run_name="__main__")
`;

type PythonExecutionResult = {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  limitExceeded: boolean;
  terminationReason?: string;
  durationMs: number;
};

const measurePythonWorkspace = (workspace: string) => {
  let bytes = 0;
  let files = 0;
  const pending = [workspace];
  while (pending.length > 0) {
    const directory = pending.pop()!;
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        pending.push(absolute);
      } else if (entry.isFile()) {
        files += 1;
        bytes += fs.statSync(absolute).size;
      }
      if (bytes > PYTHON_MAX_WORKSPACE_BYTES || files > PYTHON_MAX_WORKSPACE_FILES) return { bytes, files };
    }
  }
  return { bytes, files };
};

const runPythonProcess = (
  workspace: string,
  entrypoint: string,
  runnerPath: string,
  args: string[],
  timeoutSeconds: number,
  onChild?: (child: ReturnType<typeof spawn> | null) => void
): Promise<PythonExecutionResult> => new Promise((resolve, reject) => {
  const pythonExecutable = process.env.PYTHON_EXECUTABLE?.trim() || (process.platform === "win32" ? "python" : "python3");
  const startedAt = Date.now();
  let stdout = "";
  let stderr = "";
  let timedOut = false;
  let limitExceeded = false;
  let terminationReason: string | undefined;
  let settled = false;
  const appendLimited = (current: string, chunk: Buffer) => {
    if (current.length >= PYTHON_MAX_OUTPUT_CHARS) return current;
    const next = current + chunk.toString("utf8");
    return next.length > PYTHON_MAX_OUTPUT_CHARS
      ? `${next.slice(0, PYTHON_MAX_OUTPUT_CHARS)}\n[输出过长，已截断]`
      : next;
  };

  const tempDirectory = path.join(workspace, ".modulus-temp");
  fs.mkdirSync(tempDirectory, { recursive: true });
  const safeEnvironment: NodeJS.ProcessEnv = {};
  for (const key of ["PATH", "Path", "SystemRoot", "SYSTEMROOT", "WINDIR", "COMSPEC", "PATHEXT"]) {
    if (process.env[key]) safeEnvironment[key] = process.env[key];
  }
  const child = spawn(pythonExecutable, ["-I", "-B", "-X", "utf8", runnerPath, workspace, entrypoint, ...args], {
    cwd: workspace,
    shell: false,
    windowsHide: true,
    env: {
      ...safeEnvironment,
      PYTHONNOUSERSITE: "1",
      PYTHONDONTWRITEBYTECODE: "1",
      PYTHONUTF8: "1",
      PYTHONIOENCODING: "utf-8",
      PYTHONHASHSEED: "0",
      MPLBACKEND: "Agg",
      MPLCONFIGDIR: path.join(tempDirectory, "matplotlib"),
      HOME: workspace,
      USERPROFILE: workspace,
      TEMP: tempDirectory,
      TMP: tempDirectory,
      MODULUS_MAX_FILE_BYTES: String(PYTHON_MAX_RESULT_FILE_BYTES)
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  onChild?.(child);

  const terminate = (reason: string, resourceLimit = false) => {
    if (settled || child.killed) return;
    terminationReason = reason;
    limitExceeded = resourceLimit;
    child.kill();
  };

  const timer = setTimeout(() => {
    timedOut = true;
    terminate(`执行超过 ${timeoutSeconds} 秒时间限制`);
  }, timeoutSeconds * 1000);
  const workspaceMonitor = setInterval(() => {
    try {
      const usage = measurePythonWorkspace(workspace);
      if (usage.bytes > PYTHON_MAX_WORKSPACE_BYTES) {
        terminate(`临时工作区超过 ${Math.round(PYTHON_MAX_WORKSPACE_BYTES / 1024 / 1024)}MB 限制`, true);
      } else if (usage.files > PYTHON_MAX_WORKSPACE_FILES) {
        terminate(`临时工作区超过 ${PYTHON_MAX_WORKSPACE_FILES} 个文件限制`, true);
      }
    } catch (error) {
      console.warn("[Python sandbox] workspace monitor failed:", error);
    }
  }, 400);

  child.stdout.on("data", (chunk: Buffer) => { stdout = appendLimited(stdout, chunk); });
  child.stderr.on("data", (chunk: Buffer) => { stderr = appendLimited(stderr, chunk); });
  child.on("error", error => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    clearInterval(workspaceMonitor);
    onChild?.(null);
    reject(new Error(`无法启动 Python：${error.message}`));
  });
  child.on("close", code => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    clearInterval(workspaceMonitor);
    onChild?.(null);
    resolve({ exitCode: code, stdout, stderr, timedOut, limitExceeded, terminationReason, durationMs: Date.now() - startedAt });
  });
});

const collectPythonResultFiles = (workspace: string, initialHashes: Map<string, string>) => {
  const files: Array<{ path: string; size: number; mimeType: string; base64: string }> = [];
  const omitted: string[] = [];
  let totalBytes = 0;

  const visit = (directory: string) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      const relative = path.relative(workspace, absolute).split(path.sep).join("/");
      if (
        relative === PYTHON_INTERNAL_RUNNER
        || relative === ".modulus-temp"
        || relative.startsWith(".modulus-temp/")
        || relative === "__pycache__"
        || relative.includes("/__pycache__/")
      ) continue;
      if (entry.isDirectory()) {
        visit(absolute);
        continue;
      }
      if (!entry.isFile()) continue;
      const buffer = fs.readFileSync(absolute);
      if (initialHashes.get(relative) === hashBuffer(buffer)) continue;
      if (buffer.length > PYTHON_MAX_RESULT_FILE_BYTES || totalBytes + buffer.length > PYTHON_MAX_RESULT_BYTES) {
        omitted.push(`${relative}（${buffer.length} 字节）`);
        continue;
      }
      totalBytes += buffer.length;
      files.push({
        path: relative,
        size: buffer.length,
        mimeType: pythonResultMimeType(relative),
        base64: buffer.toString("base64")
      });
    }
  };

  visit(workspace);
  return { files, omitted };
};

async function startServer() {
  // Dynamically import pdfjs-dist here (after polyfills are set)
  const pdfjsModule = await import("pdfjs-dist/legacy/build/pdf.mjs");
  pdfjsLib = pdfjsModule;

  const app = express();
  const PORT = Number(process.env.PORT) || 3000;
  const mcpManager = new McpClientManager(process.cwd());
  const pythonApprovalAuthority = new PythonApprovalAuthority();
  const isLoopbackRequest = (req: express.Request) => {
    const remoteAddress = req.socket.remoteAddress || "";
    return remoteAddress === "127.0.0.1" || remoteAddress === "::1" || remoteAddress === "::ffff:127.0.0.1";
  };

  app.use(express.json({ limit: "30mb" }));

  app.post("/api/agent/python-approval", (req, res) => {
    try {
      if (!isLoopbackRequest(req) && process.env.ALLOW_REMOTE_PYTHON_EXECUTION !== "true") {
        return res.status(403).json({ error: "Python 执行授权默认只允许本机访问。" });
      }
      const manifest = normalizePythonApprovalManifest(req.body);
      const approval = pythonApprovalAuthority.issue(manifest);
      return res.json({ approvalToken: approval.token, approvalId: approval.id, expiresAt: approval.expiresAt });
    } catch (error: any) {
      return res.status(400).json({ error: error.message || "无法签发 Python 操作授权。" });
    }
  });

  app.get("/api/agent/mcp/tools", async (_req, res) => {
    try {
      res.json(await mcpManager.listTools());
    } catch (error: any) {
      res.status(500).json({ error: `MCP 工具发现失败：${error.message || error}`, servers: [], tools: [] });
    }
  });

  app.post(
    "/api/agent/mcp/call",
    (req, res, next) => {
      const remoteAddress = req.socket.remoteAddress || "";
      const isLoopback = remoteAddress === "127.0.0.1" || remoteAddress === "::1" || remoteAddress === "::ffff:127.0.0.1";
      if (!isLoopback && process.env.ALLOW_REMOTE_MCP_EXECUTION !== "true") {
        return res.status(403).json({ error: "MCP 工具执行默认只允许本机访问。" });
      }
      next();
    },
    async (req, res) => {
      try {
        const serverName = typeof req.body?.server === "string" ? req.body.server.trim() : "";
        const toolName = typeof req.body?.tool === "string" ? req.body.tool.trim() : "";
        const argumentsValue = req.body?.arguments;
        if (!serverName || !toolName) return res.status(400).json({ error: "MCP server 和 tool 不能为空。" });
        if (JSON.stringify(argumentsValue || {}).length > 200_000) return res.status(413).json({ error: "MCP 工具参数过大。" });
        const result = await mcpManager.callTool(serverName, toolName, argumentsValue);
        res.json({ server: serverName, tool: toolName, result });
      } catch (error: any) {
        res.status(500).json({ error: `MCP 工具调用失败：${error.message || error}` });
      }
    }
  );

  // Setup Gemini
  const apiKey = process.env.GEMINI_API_KEY || "";
  const ai = new GoogleGenAI({
    apiKey: apiKey,
    httpOptions: {
      headers: {
        "User-Agent": "aistudio-build",
      },
    },
  });

  // API Route for testing integration connection for Alibaba Cloud Bailian
  app.post("/api/test-bailian", async (req, res) => {
    try {
      const { apiKey, model } = req.body;
      if (!apiKey || apiKey.trim() === "") {
        return res.status(400).json({ error: "API Key 不能为空！" });
      }
      
      const testedModel = model || "qwen-plus";

      console.log(`[DashScope] Dispatching verification handshake to model ${testedModel}`);
      const requestBody = {
        model: testedModel,
        messages: [
          { role: "user", content: "请只返回纯文本: OK" }
        ],
        max_tokens: 15
      };

      const response = await fetch("https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${apiKey.trim()}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify(requestBody)
      });

      const data: any = await response.json();
      if (!response.ok) {
        const errMsg = data.error?.message || JSON.stringify(data);
        return res.status(response.status).json({ error: `验证失败 - 阿里云百炼报错信息：${errMsg}` });
      }

      const reply = data.choices?.[0]?.message?.content || "";
      if (reply) {
        return res.json({ message: `连接测试成功！🎉\n已成功连通您的私有阿里云百炼算力接口。\n当前引擎：${testedModel}\n百炼验证即时回执："${reply.trim()}"` });
      } else {
        return res.status(500).json({ error: "连接校验失败，百炼接口未返回有效会话。请检查额度余额。" });
      }
    } catch (error: any) {
      console.error("Test connection exception:", error);
      res.status(500).json({ error: `网关层面连接测试异常：${error.message || error}` });
    }
  });

  // Generic text-model test for OpenAI, Claude (Anthropic), and Bailian.
  app.post("/api/test-text-model", async (req, res) => {
    try {
      const { apiKey, model, provider: rawProvider } = req.body || {};
      if (typeof apiKey !== "string" || !apiKey.trim()) {
        return res.status(400).json({ error: "API Key 不能为空。" });
      }
      const provider = normalizeCustomTextProvider(rawProvider);
      const testedModel = typeof model === "string" && model.trim()
        ? model.trim()
        : provider === "openai" ? "gpt-5.6" : provider === "anthropic" ? "claude-sonnet-4-6" : "qwen-plus";
      const isBailianHybridReasoningModel = provider === "bailian"
        && /^(?:deepseek-v4(?:-|$)|glm-(?:4|5)(?:\.|-|$))/i.test(testedModel);
      const response = provider === "anthropic"
        ? await fetch("https://api.anthropic.com/v1/messages", {
            method: "POST",
            headers: { "x-api-key": apiKey.trim(), "anthropic-version": "2023-06-01", "Content-Type": "application/json" },
            body: JSON.stringify({ model: testedModel, max_tokens: 16, messages: [{ role: "user", content: "Return exactly: OK" }] })
          })
        : await fetch(provider === "openai" ? "https://api.openai.com/v1/chat/completions" : "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions", {
            method: "POST",
            headers: { Authorization: `Bearer ${apiKey.trim()}`, "Content-Type": "application/json" },
            body: JSON.stringify({
              model: testedModel,
              messages: [{ role: "user", content: "Return exactly: OK" }],
              max_tokens: isBailianHybridReasoningModel ? 128 : 32,
              ...(isBailianHybridReasoningModel ? { enable_thinking: false } : {})
            })
          });
      const data: any = await response.json().catch(() => ({}));
      if (!response.ok) {
        return res.status(response.status).json({ error: `验证失败 - ${customTextProviderName(provider)}：${data?.error?.message || JSON.stringify(data)}` });
      }
      const responseMessage = data?.choices?.[0]?.message;
      const reply = provider === "anthropic"
        ? extractModelText(data?.content)
        : extractModelText(responseMessage?.content) || extractModelText(responseMessage?.reasoning_content);
      if (!reply) {
        const finishReason = data?.choices?.[0]?.finish_reason;
        return res.status(500).json({
          error: `连接校验失败：接口请求成功，但模型没有返回文本内容${finishReason ? `（finish_reason: ${finishReason}）` : ""}。`
        });
      }
      res.json({ message: `连接测试成功！\n已成功连通 ${customTextProviderName(provider)}。\n当前模型：${testedModel}\n服务回执：${reply.slice(0, 240)}` });
    } catch (error: any) {
      console.error("Text model connection test exception:", error);
      res.status(500).json({ error: `连接测试异常：${error?.message || error}` });
    }
  });

  // API Route for testing Vision model connection (qwen-vl / qwen3-vl series)
  app.post("/api/test-vision", async (req, res) => {
    try {
      const { apiKey, model } = req.body;
      if (!apiKey || apiKey.trim() === "") {
        return res.status(400).json({ error: "API Key 不能为空！" });
      }

      const testedModel = model || "qwen-vl-plus-latest";
      console.log(`[DashScope] Vision test for model ${testedModel}`);

      const requestBody = {
        model: testedModel,
        messages: [
          {
            role: "user",
            content: [
              { type: "image_url", image_url: { url: "https://dashscope.oss-cn-beijing.aliyuncs.com/images/dog_and_girl.jpeg" } },
              { type: "text", text: "请用一句话描述这张图片。" }
            ]
          }
        ],
        max_tokens: 50
      };

      const response = await fetch("https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${apiKey.trim()}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify(requestBody)
      });

      let data: any = {};
      const text = await response.text();
      if (text) {
        try { data = JSON.parse(text); } catch {}
      }

      if (!response.ok) {
        const errMsg = data.error?.message || data.error?.code || JSON.stringify(data).slice(0, 200);
        return res.status(response.status).json({ error: `验证失败 - 阿里云百炼报错：${errMsg}` });
      }

      const reply = data.choices?.[0]?.message?.content || "";
      if (reply) {
        return res.json({ message: `视觉模型连通测试成功！\n已成功连通阿里云百炼视觉模型接口。\n当前模型：${testedModel}\n百炼回复："${reply.trim().slice(0, 100)}"` });
      } else {
        return res.status(500).json({ error: "视觉模型连通失败，百炼接口未返回有效内容。请检查额度余额。" });
      }
    } catch (error: any) {
      console.error("[/api/test-vision] exception:", error);
      res.status(500).json({ error: `网关层面连接测试异常：${error.message || error}` });
    }
  });

  app.post("/api/test-imagegen", async (req, res) => {
    try {
      const { apiKey, model } = req.body;
      if (!apiKey || apiKey.trim() === "") {
        return res.status(400).json({ error: "API Key 不能为空！" });
      }

      const testedModel = model || "wan2.7-image";

      console.log(`[DashScope] ImageGen test for model ${testedModel}`);

      const imageModels = ["wan2.7-image", "wan2.7-image-pro", "wordart-semantic", "wordart-texture"];
      const isImageModel = imageModels.includes(testedModel);

      const endpoint = isImageModel
        ? "https://dashscope.aliyuncs.com/api/v1/services/aigc/image-generation/generation"
        : "https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation";

      const requestBody: any = {
        model: testedModel,
        input: {
          messages: [{ role: "user", content: [{ text: "a cute cat" }] }]
        },
        parameters: { n: 1 }
      };

      // Step 1: Submit async task (X-DashScope-Async header is REQUIRED)
      const submitRes = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${apiKey.trim()}`,
          "Content-Type": "application/json",
          "X-DashScope-Async": "enable"
        },
        body: JSON.stringify(requestBody)
      });

      const submitData: any = await submitRes.json();

      if (!submitRes.ok && !submitData.output?.task_id) {
        const errMsg = submitData.error?.message || submitData.message || JSON.stringify(submitData);
        return res.status(submitRes.status).json({ error: `验证失败 - 阿里云百炼报错信息：${errMsg}` });
      }

      const taskId = submitData.output?.task_id;
      if (!taskId) {
        return res.status(400).json({ error: "提交测试任务失败，未获得 task_id" });
      }

      console.log(`[DashScope] Test task submitted: ${taskId}, polling...`);

      // Step 2: Poll for completion (up to 3 minutes)
      const maxAttempts = 90;
      let finalStatus = "";
      let outputUrl = "";

      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        await new Promise(r => setTimeout(r, 2000));

        const statusRes = await fetch(`https://dashscope.aliyuncs.com/api/v1/tasks/${taskId}`, {
          method: "GET",
          headers: {
            "Authorization": `Bearer ${apiKey.trim()}`,
            "Content-Type": "application/json"
          }
        });

        const statusData: any = await statusRes.json();
        const state = statusData.output?.task_status || statusData.output?.state || "";

        console.log(`[DashScope] Test poll ${attempt + 1}: state=${state}`);

        if (state === "SUCCEEDED" || state === "succeeded" || state === "COMPLETED") {
          // Official response shape: output.choices[0].message.content[0].image
          outputUrl = statusData.output?.choices?.[0]?.message?.content?.[0]?.image
            || statusData.output?.output?.url
            || statusData.output?.image
            || statusData.output?.url
            || "";
          finalStatus = "succeeded";
          break;
        }

        if (state === "FAILED" || state === "failed" || state === "ERROR" || state === "failed") {
          finalStatus = "failed";
          const errMsg = statusData.output?.error?.message || statusData.error?.message || JSON.stringify(statusData);
          return res.status(500).json({ error: `生成任务失败：${errMsg}` });
        }

        if (attempt === maxAttempts - 1) {
          return res.status(504).json({ error: `生成超时（超过 3 分钟），请稍后重试。任务ID：${taskId}` });
        }
      }

      if (finalStatus === "succeeded" && outputUrl) {
        console.log(`[DashScope] Test succeeded. URL: ${outputUrl.slice(0, 80)}...`);
        return res.json({
          message: `连通测试成功！\n已成功连通阿里云百炼生成模型接口。\n当前模型：${testedModel}\n测试图片已生成完成！`
        });
      }

      return res.status(500).json({ error: "生成完成但未返回媒体 URL，请检查模型配置。" });
    } catch (error: any) {
      console.error("[/api/test-imagegen] exception:", error);
      res.status(500).json({ error: `网关层面连接测试异常：${error.message || error}` });
    }
  });

  // Video generation connection test endpoint
  app.post("/api/test-videogen", async (req, res) => {
    try {
      const { apiKey, model } = req.body;
      if (!apiKey || apiKey.trim() === "") {
        return res.status(400).json({ error: "API Key 不能为空！" });
      }

      const testedModel = model || "wan2.7-t2v-2026-04-25";
      console.log(`[DashScope] VideoGen test for model ${testedModel}`);

      const requestBody = {
        model: testedModel,
        input: { prompt: "A cute cat running in a sunny park" },
        parameters: { duration: 5, resolution: "720P", ratio: "16:9", prompt_extend: true, watermark: false }
      };

      const submitRes = await fetch("https://dashscope.aliyuncs.com/api/v1/services/aigc/video-generation/video-synthesis", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${apiKey.trim()}`,
          "Content-Type": "application/json",
          "X-DashScope-Async": "enable"
        },
        body: JSON.stringify(requestBody)
      });

      let submitData: any = {};
      if (submitRes.ok) {
        const text = await submitRes.text();
        if (text) {
          try { submitData = JSON.parse(text); } catch {}
        }
      } else {
        const errText = await submitRes.text();
        console.error(`[DashScope] Video test submit failed (${submitRes.status}):`, errText.slice(0, 200));
        return res.status(502).json({ error: `阿里云百炼网关拒绝请求（HTTP ${submitRes.status}），请检查 API Key 是否有效。` });
      }

      const taskId = submitData.output?.task_id;

      if (!taskId) {
        const errMsg = submitData.error?.message || submitData.message || JSON.stringify(submitData);
        return res.status(400).json({ error: `验证失败 - 阿里云百炼报错信息：${errMsg}` });
      }

      console.log(`[DashScope] Video test task submitted: ${taskId}, polling...`);

      const maxAttempts = 90;
      let finalStatus = "";
      let outputUrl = "";

      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        await new Promise(r => setTimeout(r, 2000));

        const statusRes = await fetch(`https://dashscope.aliyuncs.com/api/v1/tasks/${taskId}`, {
          method: "GET",
          headers: {
            "Authorization": `Bearer ${apiKey.trim()}`,
            "Content-Type": "application/json"
          }
        });

        let statusData: any = {};
        if (statusRes.ok) {
          const stext = await statusRes.text();
          if (stext) {
            try { statusData = JSON.parse(stext); } catch {}
          }
        } else {
          console.error(`[DashScope] Video test poll failed (${statusRes.status})`);
        }

        const state = statusData.output?.task_status || statusData.output?.state || "";

        console.log(`[DashScope] Video test poll ${attempt + 1}: state=${state}`);

        if (state === "SUCCEEDED" || state === "succeeded" || state === "COMPLETED") {
          outputUrl = statusData.output?.choices?.[0]?.message?.content?.[0]?.video?.video_url
            || statusData.output?.output?.url
            || statusData.output?.video_url
            || statusData.output?.url
            || "";
          finalStatus = "succeeded";
          break;
        }

        if (state === "FAILED" || state === "failed" || state === "ERROR") {
          finalStatus = "failed";
          const errMsg = statusData.output?.error?.message || statusData.error?.message || JSON.stringify(statusData);
          return res.status(500).json({ error: `视频生成任务失败：${errMsg}` });
        }

        if (attempt === maxAttempts - 1) {
          return res.status(504).json({ error: `视频生成超时（超过 3 分钟），请稍后重试。任务ID：${taskId}` });
        }
      }

      if (finalStatus === "succeeded" && outputUrl) {
        console.log(`[DashScope] Video test succeeded. URL: ${outputUrl.slice(0, 80)}...`);
        return res.json({
          message: `连通测试成功！\n已成功连通阿里云百炼视频生成模型接口。\n当前模型：${testedModel}\n测试视频已生成完成！`
        });
      }

      return res.status(500).json({ error: "视频生成完成但未返回媒体 URL，请检查模型配置。" });
    } catch (error: any) {
      console.error("[/api/test-videogen] exception:", error);
      res.status(500).json({ error: `网关层面连接测试异常：${error.message || error}` });
    }
  });

  const sendChunk = (res: express.Response, text: string) => {
    res.write(`data: ${JSON.stringify({ text })}\n\n`);
  };

  const sendErrorChunk = (res: express.Response, error: string) => {
    res.write(`data: ${JSON.stringify({ error })}\n\n`);
  };

  const CHUNK_INTERVAL = 5; // 每 20 个字符推送一次给前端

  const streamOpenAiCompatibleChat = async (
    res: express.Response,
    apiKeyValue: string,
    selectedModel: string,
    formattedMessages: any[],
    provider: "bailian" | "openai"
  ) => {
    const response = await fetch(provider === "openai" ? "https://api.openai.com/v1/chat/completions" : "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKeyValue.trim()}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: selectedModel,
        messages: formattedMessages,
        temperature: 0.7,
        stream: true
      })
    });

    if (!response.ok || !response.body) {
      const data: any = await response.json().catch(() => ({}));
      const errMsg = data.error?.message || JSON.stringify(data);
      console.error(`[${customTextProviderName(provider)}] API error:`, errMsg);
      throw new Error(`${customTextProviderName(provider)} 大模型层报错：${errMsg}`);
    }

    console.log(`[${customTextProviderName(provider)}] Stream started`);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let fullText = "";
    let lastSendLen = 0;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      while (buffer.includes("\n")) {
        const newlineIdx = buffer.indexOf("\n");
        const line = buffer.slice(0, newlineIdx);
        buffer = buffer.slice(newlineIdx + 1);

        const trimmed = line.trim();
        if (!trimmed) continue;
        if (trimmed === "data: [DONE]") continue;

        if (trimmed.startsWith("data: ")) {
          const dataStr = trimmed.slice(6);
          try {
            const parsed = JSON.parse(dataStr);
            const delta = parsed.choices?.[0]?.delta?.content || parsed.choices?.[0]?.message?.content || "";
            if (delta) {
              fullText += delta;
              if (fullText.length - lastSendLen >= CHUNK_INTERVAL) {
                sendChunk(res, fullText);
                lastSendLen = fullText.length;
              }
            }
          } catch {
            // ignore parse errors
          }
        }
      }
    }

    // Push any remaining text that hasn't been flushed yet
    if (fullText.length > lastSendLen) {
      sendChunk(res, fullText);
    }

    console.log(`[${customTextProviderName(provider)}] Stream done. fullText length: ${fullText.length}`);
    return fullText;
  };

  const streamAnthropicChat = async (
    res: express.Response,
    apiKeyValue: string,
    selectedModel: string,
    systemPrompt: string,
    messages: any[]
  ) => {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": apiKeyValue.trim(), "anthropic-version": "2023-06-01", "Content-Type": "application/json" },
      body: JSON.stringify({
        model: selectedModel,
        max_tokens: 4096,
        system: systemPrompt,
        messages: messages.map(message => ({ role: message.role === "assistant" ? "assistant" : "user", content: String(message.content || "") })),
        temperature: 0.7,
        stream: true
      })
    });
    if (!response.ok || !response.body) {
      const data: any = await response.json().catch(() => ({}));
      throw new Error(`Claude 大模型层报错：${data?.error?.message || JSON.stringify(data)}`);
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let fullText = "";
    let lastSendLen = 0;
    const consumeEvent = (rawEvent: string) => {
      const dataLine = rawEvent.split(/\r?\n/).find(line => line.startsWith("data:"));
      if (!dataLine) return;
      try {
        const parsed = JSON.parse(dataLine.slice(5).trim());
        if (parsed?.type === "content_block_delta" && parsed?.delta?.type === "text_delta" && typeof parsed.delta.text === "string") {
          fullText += parsed.delta.text;
          if (fullText.length - lastSendLen >= CHUNK_INTERVAL) {
            sendChunk(res, fullText);
            lastSendLen = fullText.length;
          }
        }
      } catch {
        // Ignore malformed individual SSE events.
      }
    };
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let eventEnd = buffer.search(/\r?\n\r?\n/);
      while (eventEnd >= 0) {
        const event = buffer.slice(0, eventEnd);
        buffer = buffer.slice(eventEnd).replace(/^\r?\n\r?\n/, "");
        consumeEvent(event);
        eventEnd = buffer.search(/\r?\n\r?\n/);
      }
    }
    buffer += decoder.decode();
    if (buffer.trim()) consumeEvent(buffer);
    if (fullText.length > lastSendLen) sendChunk(res, fullText);
    return fullText;
  };

  const streamGeminiChat = async (res: express.Response, contents: any[], systemInstruction: string) => {
    console.log("[Gemini] Stream started");
    const stream = await ai.models.generateContentStream({
      model: "gemini-3.5-flash",
      contents,
      config: {
        systemInstruction,
        temperature: 0.7
      }
    });

    let fullText = "";
    let lastSendLen = 0;
    for await (const chunk of stream) {
      const delta = chunk.text || "";
      if (delta) {
        fullText += delta;
        if (fullText.length - lastSendLen >= CHUNK_INTERVAL) {
          sendChunk(res, fullText);
          lastSendLen = fullText.length;
        }
      }
    }

    if (fullText.length > lastSendLen) {
      sendChunk(res, fullText);
    }

    console.log(`[Gemini] Stream done. fullText length: ${fullText.length}`);
    return fullText;
  };

  // Native structured tool-calling route used by the Modulus agent loop.
  app.post("/api/agent/turn", async (req, res) => {
    try {
      const { messages, systemPrompt, customApiKey, customModel, customProvider, forcedToolName } = req.body || {};
      if (!Array.isArray(messages) || messages.length === 0 || messages.length > 200) {
        return res.status(400).json({ error: "Agent messages 必须是包含 1-200 条消息的数组。" });
      }
      if (typeof systemPrompt !== "string" || !systemPrompt.trim() || systemPrompt.length > 120_000) {
        return res.status(400).json({ error: "Agent systemPrompt 为空或过长。" });
      }
      const serializedMessages = JSON.stringify(messages);
      if (serializedMessages.length > 2_000_000) {
        return res.status(413).json({ error: "Agent 上下文超过 200 万字符限制，请压缩历史消息。" });
      }

      const normalizedMessages: AgentConversationMessage[] = [];
      for (const message of messages) {
        if (!message || typeof message !== "object") return res.status(400).json({ error: "Agent 消息格式无效。" });
        if (message.role === "tool") {
          if (typeof message.content !== "string" || typeof message.toolCallId !== "string" || typeof message.name !== "string") {
            return res.status(400).json({ error: "Agent tool 消息缺少 content、toolCallId 或 name。" });
          }
          normalizedMessages.push({
            role: "tool",
            content: message.content.slice(0, 80_000),
            toolCallId: message.toolCallId.slice(0, 200),
            name: message.name.slice(0, 128)
          });
          continue;
        }
        if (!(["user", "assistant"].includes(message.role)) || typeof message.content !== "string") {
          return res.status(400).json({ error: "Agent 消息 role 或 content 无效。" });
        }
        const toolCalls = Array.isArray(message.toolCalls)
          ? message.toolCalls.slice(0, 32).map((call: any) => ({
              id: String(call?.id || "").slice(0, 200),
              nativeName: String(call?.nativeName || "").slice(0, 128),
              name: String(call?.name || "").slice(0, 128),
              nativeArguments: call?.nativeArguments && typeof call.nativeArguments === "object" && !Array.isArray(call.nativeArguments)
                ? call.nativeArguments
                : {},
              arguments: call?.arguments && typeof call.arguments === "object" && !Array.isArray(call.arguments)
                ? call.arguments
                : {},
              ...(typeof call?.validationError === "string" ? { validationError: call.validationError.slice(0, 2_000) } : {})
            }))
          : undefined;
        normalizedMessages.push({ role: message.role, content: message.content.slice(0, 500_000), toolCalls });
      }

      if (!customApiKey?.trim() && !apiKey) {
        return res.status(400).json({ error: "未配置可用于 Agent 的模型 API Key。" });
      }

      let mcpTools: Awaited<ReturnType<McpClientManager["listTools"]>>["tools"] = [];
      try {
        mcpTools = (await mcpManager.listTools()).tools;
      } catch (error) {
        console.warn("[/api/agent/turn] MCP discovery unavailable:", error);
      }

      const result = await executeAgentTurn({
        ai,
        defaultGeminiModel: process.env.GEMINI_MODEL?.trim() || "gemini-3.5-flash",
        customApiKey: typeof customApiKey === "string" ? customApiKey : undefined,
        customModel: typeof customModel === "string" ? customModel : undefined,
        customProvider: normalizeCustomTextProvider(customProvider),
        systemPrompt,
        messages: normalizedMessages,
        mcpTools,
        forcedToolName: typeof forcedToolName === "string" ? forcedToolName.slice(0, 128) : undefined
      });
      res.json(result);
    } catch (error: any) {
      console.error("[/api/agent/turn] exception:", error);
      const message = error?.message || "Agent 结构化调用失败。";
      const fallbackAllowed = canFallbackToCompatibilityMode(message);
      res.status(500).json({ error: message, fallbackAllowed });
    }
  });

  // Streaming variant of the native Function Calling route. Text is forwarded as
  // it arrives, while the complete structured tool calls are sent in the final event.
  app.post("/api/agent/turn-stream", async (req, res) => {
    try {
      const { messages, systemPrompt, customApiKey, customModel, customProvider, forcedToolName } = req.body || {};
      if (!Array.isArray(messages) || messages.length === 0 || messages.length > 200) {
        return res.status(400).json({ error: "Agent messages 必须是包含 1-200 条消息的数组。" });
      }
      if (typeof systemPrompt !== "string" || !systemPrompt.trim() || systemPrompt.length > 120_000) {
        return res.status(400).json({ error: "Agent systemPrompt 为空或过长。" });
      }
      if (JSON.stringify(messages).length > 2_000_000) {
        return res.status(413).json({ error: "Agent 上下文超过 200 万字符限制，请压缩历史消息。" });
      }

      const normalizedMessages: AgentConversationMessage[] = [];
      for (const message of messages) {
        if (!message || typeof message !== "object") {
          return res.status(400).json({ error: "Agent 消息格式无效。" });
        }
        if (message.role === "tool") {
          if (typeof message.content !== "string" || typeof message.toolCallId !== "string" || typeof message.name !== "string") {
            return res.status(400).json({ error: "Agent tool 消息缺少 content、toolCallId 或 name。" });
          }
          normalizedMessages.push({
            role: "tool",
            content: message.content.slice(0, 80_000),
            toolCallId: message.toolCallId.slice(0, 200),
            name: message.name.slice(0, 128)
          });
          continue;
        }
        if (!["user", "assistant"].includes(message.role) || typeof message.content !== "string") {
          return res.status(400).json({ error: "Agent 消息 role 或 content 无效。" });
        }
        const toolCalls = Array.isArray(message.toolCalls)
          ? message.toolCalls.slice(0, 32).map((call: any) => ({
              id: String(call?.id || "").slice(0, 200),
              nativeName: String(call?.nativeName || "").slice(0, 128),
              name: String(call?.name || "").slice(0, 128),
              nativeArguments: call?.nativeArguments && typeof call.nativeArguments === "object" && !Array.isArray(call.nativeArguments)
                ? call.nativeArguments
                : {},
              arguments: call?.arguments && typeof call.arguments === "object" && !Array.isArray(call.arguments)
                ? call.arguments
                : {},
              ...(typeof call?.validationError === "string" ? { validationError: call.validationError.slice(0, 2_000) } : {})
            }))
          : undefined;
        normalizedMessages.push({ role: message.role, content: message.content.slice(0, 500_000), toolCalls });
      }

      if (!customApiKey?.trim() && !apiKey) {
        return res.status(400).json({ error: "未配置可用于 Agent 的模型 API Key。" });
      }

      let mcpTools: Awaited<ReturnType<McpClientManager["listTools"]>>["tools"] = [];
      try {
        mcpTools = (await mcpManager.listTools()).tools;
      } catch (error) {
        console.warn("[/api/agent/turn-stream] MCP discovery unavailable:", error);
      }

      res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
      res.setHeader("Cache-Control", "no-cache, no-transform");
      res.setHeader("Connection", "keep-alive");
      res.setHeader("X-Accel-Buffering", "no");
      res.flushHeaders();

      const result = await streamAgentTurn({
        ai,
        defaultGeminiModel: process.env.GEMINI_MODEL?.trim() || "gemini-3.5-flash",
        customApiKey: typeof customApiKey === "string" ? customApiKey : undefined,
        customModel: typeof customModel === "string" ? customModel : undefined,
        customProvider: normalizeCustomTextProvider(customProvider),
        systemPrompt,
        messages: normalizedMessages,
        mcpTools,
        forcedToolName: typeof forcedToolName === "string" ? forcedToolName.slice(0, 128) : undefined
      }, fullText => {
        if (!res.writableEnded && !res.destroyed) sendChunk(res, fullText);
      });

      if (!res.writableEnded && !res.destroyed) {
        res.write(`data: ${JSON.stringify({ type: "complete", result })}\n\n`);
        res.write("data: [DONE]\n\n");
        res.end();
      }
    } catch (error: any) {
      console.error("[/api/agent/turn-stream] exception:", error);
      const message = error?.message || "Agent 结构化流式调用失败。";
      const fallbackAllowed = canFallbackToCompatibilityMode(message);
      if (!res.headersSent) {
        res.status(500).json({ error: message, fallbackAllowed });
      } else if (!res.writableEnded && !res.destroyed) {
        res.write(`data: ${JSON.stringify({ error: message, fallbackAllowed })}\n\n`);
        res.write("data: [DONE]\n\n");
        res.end();
      }
    }
  });

  // API Route for chat
  app.post("/api/chat", async (req, res) => {
    try {
      const { messages, customApiKey, customModel, customProvider } = req.body;
      if (!Array.isArray(messages)) {
        return res.status(400).json({ error: "messages array is required" });
      }

      const provider = normalizeCustomTextProvider(customProvider);
      console.log("[API /api/chat] Request received. provider:", provider, "customApiKey:", customApiKey ? "provided" : "empty", "customModel:", customModel);

      res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
      res.setHeader("Cache-Control", "no-cache, no-transform");
      res.setHeader("Connection", "keep-alive");
      res.setHeader("X-Accel-Buffering", "no");
      res.flushHeaders();

      const clientSystemMessage = messages.find((m: any) => m.role === "system");
      const clientOtherMessages = messages.filter((m: any) => m.role !== "system");

      const defaultSystemPrompt = "You are Modulus (Chinese name: 数模灵), a professional and highly capable mathematical modeling AI coach. You speak fluent Chinese (简体中文). Help modeling beginners choose suitable models, write Python/Matlab code, explain concepts with LaTeX or plain-text formulas, and structure competition papers. Focus on logical clarity, clear steps, helpful educational guidance, and consistent self-identification as Modulus or 数模灵.";
      const mathFormattingPrompt = `${defaultSystemPrompt}\n\nWhen you output any mathematical formula, you must use standard Markdown math syntax so the frontend can render it correctly. Use inline math with $...$ and display math with $$...$$ on its own lines. Do not use square brackets [ ... ] to wrap formulas. Do not use code fences for formulas unless you are giving code. Prefer display math for multi-line equations and keep surrounding explanation in normal Chinese paragraphs or bullet points. If there are multiple formulas, separate them clearly and keep notation consistent.`;

      if (customApiKey && customApiKey.trim() !== "") {
        const selectedModel = customModel || (provider === "openai" ? "gpt-5.6" : provider === "anthropic" ? "claude-sonnet-4-6" : "qwen-plus");
        console.log(`[${customTextProviderName(provider)}] Routing user prompt to model: ${selectedModel}`);

        const formattedMessages = [
          {
            role: "system",
            content: clientSystemMessage?.content || defaultSystemPrompt
          },
          ...clientOtherMessages.map((m: any) => ({
            role: m.role,
            content: m.content
          }))
        ];

        const finalText = provider === "anthropic"
          ? await streamAnthropicChat(res, customApiKey, selectedModel, clientSystemMessage?.content || defaultSystemPrompt, clientOtherMessages)
          : await streamOpenAiCompatibleChat(res, customApiKey, selectedModel, formattedMessages, provider);
        if (!finalText.trim()) {
          sendChunk(res, "抱歉，服务端未收到有效回复内容，请重试。");
        }
        res.write(`data: [DONE]\n\n`);
        res.end();
        return;
      }

      if (!apiKey) {
        throw new Error("API key is not configured. Please supply GEMINI_API_KEY in Settings.");
      }

      const contents = clientOtherMessages.map((msg: any) => ({
        role: msg.role === "assistant" ? "model" : "user",
        parts: [{ text: msg.content }]
      }));

      const finalText = await streamGeminiChat(res, contents, clientSystemMessage?.content || mathFormattingPrompt);
      if (!finalText.trim()) {
        sendChunk(res, "抱歉，服务端未收到有效回复内容，请重试。");
      }
      res.write(`data: [DONE]\n\n`);
      res.end();
    } catch (error: any) {
      console.error("Chat API Error:", error);
      if (!res.headersSent) {
        res.status(500).json({ error: error.message || "Internal Server Error" });
      } else {
        sendErrorChunk(res, error.message || "Internal Server Error");
        res.write(`data: [DONE]\n\n`);
        res.end();
      }
    }
  });

  // Multer config: store files in /uploads
  const uploadDir = path.join(process.cwd(), "uploads");
  if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
  const upload = multer({
    storage: multer.diskStorage({
      destination: uploadDir,
      filename: (_req, file, cb) => {
        cb(null, `${Date.now()}-${file.originalname}`);
      },
    }),
    limits: { fileSize: 20 * 1024 * 1024 }, // 20MB
  });
  const pythonUpload = multer({
    storage: multer.memoryStorage(),
    limits: {
      files: 80,
      fileSize: 20 * 1024 * 1024,
      fields: 20,
      fieldSize: 2 * 1024 * 1024
    }
  });

  // File upload + parse endpoint
  app.post("/api/upload", upload.single("file"), async (req, res) => {
    try {
      if (!req.file) {
        return res.status(400).json({ error: "未检测到文件" });
      }

      const {
        visionApiKey: _unused1,
        visionModel: _unused2,
      } = req.body as { visionApiKey?: string; visionModel?: string };
      const filePath = req.file.path;
      const originalFilename = Buffer.from(req.file.originalname, "latin1").toString("utf8");
      const ext = path.extname(originalFilename).toLowerCase();
      let text = "";

      if ([".png", ".jpg", ".jpeg", ".gif", ".webp"].includes(ext)) {
        // Process image: resize + OCR via tesseract.js (local, no API needed)
        try {
          const buffer = await sharp(filePath)
            .resize({ width: 2000, height: 2000, fit: "inside" })
            .jpeg({ quality: 90 })
            .toBuffer();

          const Tesseract = (await import("tesseract.js")).default;
          const { data } = await Tesseract.recognize(buffer, "eng+chi_sim", {
            logger: (m: any) => {
              if (m.status === "recognizing text") {
                process.stdout.write(`\r[OCR] ${Math.round(m.progress * 100)}%`);
              }
            }
          });
          console.log(); // newline after progress

          const extracted = (data.text || "").trim();
          if (extracted) {
            text = `[图片文件: ${originalFilename}]\n[通过本地 OCR 识别]\n${extracted}`;
          } else {
            text = `[图片文件: ${originalFilename}]\n[OCR 未能识别出文字内容，图片可能是纯图形/截图或清晰度不足。]`;
          }
        } catch (err: any) {
          console.error("[/api/upload] Image OCR error:", err);
          text = `[图片文件: ${originalFilename}]\n[图片文字识别失败: ${err.message}]`;
        }
      } else if (ext === ".pdf") {
        // Process PDF: use pdfjs-dist text extraction (local, no API needed)
        try {
          const dataBuffer = fs.readFileSync(filePath);
          const loadingTask = pdfjsLib.getDocument({ data: new Uint8Array(dataBuffer) });
          const pdf = await loadingTask.promise;
          const pageCount = pdf.numPages;

          const pages: string[] = [];
          for (let i = 1; i <= pageCount; i++) {
            const page = await pdf.getPage(i);
            const content = await page.getTextContent();
            const pageText = content.items
              .map((item: any) => item.str || "")
              .join(" ")
              .replace(/\s+/g, " ")
              .trim();
            pages.push(pageText || `[第 ${i} 页未检测到可提取的文字内容]`);
          }

          const extracted = pages.join("\n\n").trim();
          if (extracted) {
            text = `[PDF文件: ${originalFilename}]（共 ${pageCount} 页）\n[通过本地 PDF 解析]\n${extracted}`;
          } else {
            text = `[PDF文件: ${originalFilename}]\n[PDF 内未检测到可提取的文字内容，该 PDF 可能为纯图片扫描件，建议另存为图片后使用图片 OCR 识别。]`;
          }
        } catch (err: any) {
          console.error("[/api/upload] PDF parse error:", err);
          text = `[PDF文件: ${originalFilename}]\n[PDF 解析失败: ${err.message}]`;
        }
      } else if (ext === ".docx") {
        try {
          const result = await mammoth.extractRawText({ path: filePath });
          text = result.value.trim()
            ? `[Word文件: ${originalFilename}]\n[通过本地 DOCX 解析]\n${result.value.trim()}`
            : `[Word文件: ${originalFilename}]\n[DOCX 文字提取结果为空]`;
        } catch (err: any) {
          console.error("[/api/upload] DOCX parse error:", err);
          text = `[Word文件: ${originalFilename}]\n[DOCX 解析失败: ${err.message}]`;
        }
      } else if (ext === ".doc") {
        try {
          const extractor = new WordExtractor();
          const doc = await extractor.extract(filePath);
          const body = doc.getBody?.() || "";
          const headers = doc.getHeaders?.() || "";
          const footnotes = doc.getFootnotes?.() || "";
          const endnotes = doc.getEndnotes?.() || "";
          const textParts = [body, headers, footnotes, endnotes]
            .map(part => part?.trim())
            .filter(Boolean);

          text = textParts.length > 0
            ? `[Word文件: ${originalFilename}]\n[通过本地 DOC 解析]\n${textParts.join("\n\n")}`
            : `[Word文件: ${originalFilename}]\n[DOC 文字提取结果为空]`;
        } catch (err: any) {
          console.error("[/api/upload] DOC parse error:", err);
          text = `[Word文件: ${originalFilename}]\n[DOC 解析失败: ${err.message}]`;
        }
      } else if (ext === ".csv") {
        try {
          const workbook = XLSX.readFile(filePath, { raw: true, cellDates: true, codepage: 65001 });
          text = summarizeWorkbook(workbook, originalFilename);
        } catch (err: any) {
          console.error("[/api/upload] CSV parse error:", err);
          text = `[表格文件: ${originalFilename}]\n[CSV 解析失败: ${err.message}]`;
        }
      } else if (ext === ".xlsx" || ext === ".xls") {
        try {
          const workbook = XLSX.readFile(filePath, { cellDates: true });
          text = summarizeWorkbook(workbook, originalFilename);
        } catch (err: any) {
          console.error("[/api/upload] Excel parse error:", err);
          text = `[表格文件: ${originalFilename}]\n[Excel 解析失败: ${err.message}]`;
        }
      } else {
        text = fs.readFileSync(filePath, "utf-8").slice(0, 10000);
      }

      // Clean up uploaded file after parsing
      fs.unlinkSync(filePath);

      // Truncate very long content
      if (text.length > 15000) {
        text = text.slice(0, 15000) + "\n\n[文件内容过长，已截断...]";
      }

      res.json({
        filename: originalFilename,
        mimeType: req.file.mimetype,
        size: req.file.size,
        content: text.trim(),
      });
    } catch (err: any) {
      console.error("[/api/upload] Error:", err);
      res.status(500).json({ error: err.message || "文件解析失败" });
    }
  });

  // Execute a Python entrypoint in an isolated temporary copy of selected project files.
  app.post(
    "/api/agent/run-python",
    (req, res, next) => {
      if (!isLoopbackRequest(req) && process.env.ALLOW_REMOTE_PYTHON_EXECUTION !== "true") {
        return res.status(403).json({ error: "Python 执行默认只允许本机访问。" });
      }
      next();
    },
    pythonUpload.array("files", 80),
    async (req, res) => {
    const executionBase = path.resolve(os.tmpdir(), "mathhub-modulus-python");
    fs.mkdirSync(executionBase, { recursive: true });
    const workspace = fs.mkdtempSync(path.join(executionBase, "run-"));
    let activeChild: ReturnType<typeof spawn> | null = null;
    let responseFinished = false;
    res.on("close", () => {
      if (!responseFinished && activeChild) activeChild.kill();
    });

    try {
      const uploadedFiles = (req.files || []) as Express.Multer.File[];
      const entrypoint = normalizePythonWorkspacePath(req.body.entrypoint);
      if (!entrypoint.toLowerCase().endsWith(".py")) {
        return res.status(400).json({ error: "entrypoint 必须是 .py 文件。" });
      }

      let filePaths: string[] = [];
      let pythonArgs: string[] = [];
      try {
        filePaths = JSON.parse(String(req.body.filePaths || "[]"));
        pythonArgs = JSON.parse(String(req.body.arguments || "[]"));
      } catch {
        return res.status(400).json({ error: "filePaths 或 arguments 不是有效 JSON。" });
      }
      if (!Array.isArray(filePaths) || filePaths.length !== uploadedFiles.length) {
        return res.status(400).json({ error: "上传文件与 filePaths 数量不一致。" });
      }
      if (!Array.isArray(pythonArgs) || pythonArgs.some(value => typeof value !== "string")) {
        return res.status(400).json({ error: "arguments 必须是字符串数组。" });
      }
      if (pythonArgs.length > 30 || pythonArgs.some(value => value.length > 2_000)) {
        return res.status(400).json({ error: "Python 参数数量或长度超过限制。" });
      }

      const totalUploadBytes = uploadedFiles.reduce((sum, file) => sum + file.size, 0);
      if (totalUploadBytes > PYTHON_MAX_UPLOAD_BYTES) {
        return res.status(413).json({ error: "Python 执行输入文件总量超过 60MB。" });
      }

      const normalizedPaths = filePaths.map(normalizePythonWorkspacePath);
      if (new Set(normalizedPaths).size !== normalizedPaths.length) {
        return res.status(400).json({ error: "Python 执行输入包含重复路径。" });
      }
      if (!normalizedPaths.includes(entrypoint)) {
        return res.status(400).json({ error: "entrypoint 未包含在上传文件中。" });
      }

      const timeoutNumber = Number(req.body.timeoutSeconds);
      const timeoutSeconds = Number.isFinite(timeoutNumber)
        ? Math.min(120, Math.max(5, Math.round(timeoutNumber)))
        : 60;
      const executionManifest: PythonApprovalManifest = {
        entrypoint,
        files: normalizedPaths.map((filePath, index) => ({
          path: filePath,
          size: uploadedFiles[index].size,
          sha256: hashBuffer(uploadedFiles[index].buffer)
        })),
        arguments: pythonArgs,
        timeoutSeconds
      };
      let approvalId = "";
      try {
        approvalId = pythonApprovalAuthority.consume(req.body.approvalToken, executionManifest);
      } catch (error: any) {
        return res.status(403).json({ error: error.message || "Python 操作未获得有效授权。" });
      }

      const initialHashes = new Map<string, string>();
      for (let index = 0; index < uploadedFiles.length; index++) {
        const relativePath = normalizedPaths[index];
        const absolutePath = resolvePythonWorkspacePath(workspace, relativePath);
        fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
        fs.writeFileSync(absolutePath, uploadedFiles[index].buffer);
        initialHashes.set(relativePath, hashBuffer(uploadedFiles[index].buffer));
      }

      const runnerPath = resolvePythonWorkspacePath(workspace, PYTHON_INTERNAL_RUNNER);
      fs.writeFileSync(runnerPath, PYTHON_RUNNER_SOURCE, "utf8");

      const execution = await runPythonProcess(
        workspace,
        resolvePythonWorkspacePath(workspace, entrypoint),
        runnerPath,
        pythonArgs,
        timeoutSeconds,
        child => { activeChild = child; }
      );
      const resultFiles = collectPythonResultFiles(workspace, initialHashes);
      responseFinished = true;
      return res.json({
        ...execution,
        files: resultFiles.files,
        omittedFiles: resultFiles.omitted,
        pythonVersion: process.env.PYTHON_EXECUTABLE?.trim() || (process.platform === "win32" ? "python" : "python3"),
        approvalId,
        sandbox: {
          network: "blocked",
          subprocesses: "blocked",
          projectAccess: "temporary-copy-only",
          maxWorkspaceBytes: PYTHON_MAX_WORKSPACE_BYTES,
          maxWorkspaceFiles: PYTHON_MAX_WORKSPACE_FILES
        }
      });
    } catch (error: any) {
      console.error("[/api/agent/run-python] exception:", error);
      responseFinished = true;
      return res.status(500).json({ error: `Python 执行失败：${error.message || error}` });
    } finally {
      activeChild = null;
      const resolvedWorkspace = path.resolve(workspace);
      if (resolvedWorkspace.startsWith(`${executionBase}${path.sep}`)) {
        fs.rmSync(resolvedWorkspace, { recursive: true, force: true });
      }
    }
    }
  );

  // Build a real OOXML Word document for the browser-side Modulus file tool.
  app.post("/api/agent/create-docx", async (req, res) => {
    try {
      const { title, content, filename, documentType, paperFormat, teamNumber, problem, year, images } = req.body as {
        title?: string;
        content?: string;
        filename?: string;
        documentType?: string;
        paperFormat?: string;
        teamNumber?: string;
        problem?: string;
        year?: string;
        images?: EmbeddedWordImage[];
      };

      if (!content || !content.trim()) {
        return res.status(400).json({ error: "Word 文档内容不能为空。" });
      }
      if (content.length > 500_000) {
        return res.status(413).json({ error: "Word 文档内容过长，单次最多支持 50 万字符。" });
      }

      const safeTitle = (title || "Modulus 智能体报告").trim().slice(0, 160);
      const safeFilename = sanitizeWordFilename(filename || safeTitle);
      const safeImages = Array.isArray(images) ? images.slice(0, 40) : [];
      const totalImageChars = safeImages.reduce((total, image) => total + (typeof image?.base64 === "string" ? image.base64.length : 0), 0);
      if (totalImageChars > 24 * 1024 * 1024) {
        return res.status(413).json({ error: "Word 文档中的图片总量过大，请压缩图片后重试。" });
      }
      const buffer = documentType === "modeling_paper"
        ? await buildModelingPaperBuffer(safeTitle, content, {
            teamNumber: typeof teamNumber === "string" ? teamNumber.slice(0, 80) : "",
            problem: typeof problem === "string" ? problem.slice(0, 80) : "",
            year: typeof year === "string" ? year.slice(0, 20) : "",
            paperFormat: paperFormat === "mcm" ? "mcm" : "himcm",
            images: safeImages
          })
        : await buildWordDocumentBuffer(safeTitle, content);

      res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
      res.setHeader("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(safeFilename)}`);
      res.setHeader("Content-Length", buffer.length.toString());
      res.send(buffer);
    } catch (error: any) {
      console.error("[/api/agent/create-docx] exception:", error);
      res.status(500).json({ error: `Word 文档生成失败：${error.message || error}` });
    }
  });

  // Render a competition-style modeling paper directly to PDF.
  app.post("/api/agent/create-pdf", async (req, res) => {
    try {
      const { title, content, filename, paperFormat, teamNumber, problem, year, images } = req.body as {
        title?: string;
        content?: string;
        filename?: string;
        paperFormat?: string;
        teamNumber?: string;
        problem?: string;
        year?: string;
        images?: EmbeddedWordImage[];
      };
      if (!content || !content.trim()) return res.status(400).json({ error: "PDF 文档内容不能为空。" });
      if (content.length > 500_000) return res.status(413).json({ error: "PDF 文档内容过长，单次最多支持 50 万字符。" });
      const safeImages = Array.isArray(images) ? images.slice(0, 40) : [];
      const totalImageChars = safeImages.reduce((total, image) => total + (typeof image?.base64 === "string" ? image.base64.length : 0), 0);
      if (totalImageChars > 24 * 1024 * 1024) return res.status(413).json({ error: "PDF 中的图片总量过大，请压缩图片后重试。" });
      const safeTitle = (title || "Modulus 数学建模论文").trim().slice(0, 160);
      const safeFilename = sanitizePdfFilename(filename || safeTitle);
      const buffer = await buildModelingPaperPdf(safeTitle, content, {
        teamNumber: typeof teamNumber === "string" ? teamNumber.slice(0, 80) : "",
        problem: typeof problem === "string" ? problem.slice(0, 80) : "",
        year: typeof year === "string" ? year.slice(0, 20) : "",
        paperFormat: paperFormat === "mcm" ? "mcm" : "himcm",
        images: safeImages
      });
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(safeFilename)}`);
      res.setHeader("Content-Length", buffer.length.toString());
      res.send(buffer);
    } catch (error: any) {
      console.error("[/api/agent/create-pdf] exception:", error);
      res.status(500).json({ error: `PDF 文档生成失败：${error.message || error}` });
    }
  });

  // Image generation endpoint (wan2.7-image / wan2.7-video)
  app.post("/api/image-generation", async (req, res) => {
    try {
      const { apiKey, model, prompt } = req.body;
      if (!apiKey || apiKey.trim() === "") {
        return res.status(400).json({ error: "API Key 不能为空！" });
      }
      if (!prompt || !prompt.trim()) {
        return res.status(400).json({ error: "提示词不能为空！" });
      }

      const selectedModel = model || "wan2.7-image";
      console.log(`[DashScope] ImageGeneration for model ${selectedModel}: "${prompt.slice(0, 50)}..."`);

      const imageModels = ["wan2.7-image", "wan2.7-image-pro", "wordart-semantic", "wordart-texture"];
      const isImageModel = imageModels.includes(selectedModel);
      const endpoint = isImageModel
        ? "https://dashscope.aliyuncs.com/api/v1/services/aigc/image-generation/generation"
        : "https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation";

      const requestBody: any = {
        model: selectedModel,
        input: {
          messages: [{ role: "user", content: [{ text: prompt.trim() }] }]
        },
        parameters: { n: 1 }
      };

      // Step 1: Submit async task (X-DashScope-Async header is REQUIRED)
      const submitRes = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${apiKey.trim()}`,
          "Content-Type": "application/json",
          "X-DashScope-Async": "enable"
        },
        body: JSON.stringify(requestBody)
      });

      let submitData: any = {};
      if (submitRes.ok) {
        const text = await submitRes.text();
        if (text) {
          try { submitData = JSON.parse(text); } catch {}
        }
      } else {
        const errText = await submitRes.text();
        console.error(`[DashScope] Image submit failed (${submitRes.status}):`, errText.slice(0, 200));
        return res.status(502).json({ error: `阿里云百炼网关拒绝请求（HTTP ${submitRes.status}），请检查 API Key 是否有效。` });
      }

      const taskId = submitData.output?.task_id;

      if (!taskId) {
        const errMsg = submitData.error?.message || submitData.message || JSON.stringify(submitData);
        return res.status(400).json({ error: `提交生成任务失败：${errMsg}` });
      }

      console.log(`[DashScope] Task submitted. task_id=${taskId}, polling...`);

      // Step 2: Poll for completion (up to 3 minutes)
      const maxAttempts = 90;
      let outputUrl = "";
      let finalStatus = "";

      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        await new Promise(r => setTimeout(r, 2000));

        const statusRes = await fetch(`https://dashscope.aliyuncs.com/api/v1/tasks/${taskId}`, {
          method: "GET",
          headers: {
            "Authorization": `Bearer ${apiKey.trim()}`,
            "Content-Type": "application/json"
          }
        });

        let statusData: any = {};
        if (statusRes.ok) {
          const stext = await statusRes.text();
          if (stext) {
            try { statusData = JSON.parse(stext); } catch {}
          }
        } else {
          console.error(`[DashScope] Image poll failed (${statusRes.status})`);
        }

        const state = statusData.output?.task_status || statusData.output?.state || "";

        console.log(`[DashScope] Poll attempt ${attempt + 1}: state=${state}`);

        if (state === "SUCCEEDED" || state === "succeeded" || state === "COMPLETED") {
          outputUrl = statusData.output?.choices?.[0]?.message?.content?.[0]?.image
            || statusData.output?.output?.url
            || statusData.output?.image
            || statusData.output?.url
            || "";
          finalStatus = "succeeded";
          break;
        }

        if (state === "FAILED" || state === "failed" || state === "ERROR") {
          finalStatus = "failed";
          const errMsg = statusData.output?.error?.message || statusData.error?.message || JSON.stringify(statusData);
          return res.status(500).json({ error: `生成任务失败：${errMsg}` });
        }

        if (attempt === maxAttempts - 1) {
          return res.status(504).json({ error: `生成超时（超过 3 分钟），请稍后重试。任务ID：${taskId}` });
        }
      }

      if (!outputUrl) {
        return res.status(500).json({ error: `生成完成但未返回媒体 URL，请检查模型配置。任务ID：${taskId}` });
      }

      console.log(`[DashScope] Generation succeeded. URL: ${outputUrl.slice(0, 80)}...`);
      res.json({
        url: outputUrl,
        taskId,
        model: selectedModel,
        type: isImageModel ? "image" : "video"
      });
    } catch (error: any) {
      console.error("[/api/image-generation] exception:", error);
      res.status(500).json({ error: `生成异常：${error.message || error}` });
    }
  });

  // Video generation endpoint (wan2.7-t2v / wan2.7-i2v / happyhorse video models)
  app.post("/api/video-generation", async (req, res) => {
    try {
      const { apiKey, model, prompt, duration, resolution, ratio, watermark, seed } = req.body;
      if (!apiKey || apiKey.trim() === "") {
        return res.status(400).json({ error: "API Key 不能为空！" });
      }
      if (!prompt || !prompt.trim()) {
        return res.status(400).json({ error: "提示词不能为空！" });
      }

      const selectedModel = model || "wan2.7-t2v-2026-04-25";
      console.log(`[DashScope] VideoGeneration for model ${selectedModel}: "${prompt.slice(0, 50)}..."`);

      const requestBody: any = {
        model: selectedModel,
        input: {
          prompt: prompt.trim()
        },
        parameters: {
          duration: parseInt(duration) || 5,
          resolution: resolution || "720P",
          ratio: ratio || "16:9",
          prompt_extend: true,
          watermark: !!watermark,
          seed: seed ? parseInt(seed) : undefined
        }
      };

      // Step 1: Submit async task
      const submitRes = await fetch("https://dashscope.aliyuncs.com/api/v1/services/aigc/video-generation/video-synthesis", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${apiKey.trim()}`,
          "Content-Type": "application/json",
          "X-DashScope-Async": "enable"
        },
        body: JSON.stringify(requestBody)
      });

      let submitData: any = {};
      if (submitRes.ok) {
        const text = await submitRes.text();
        if (text) {
          try { submitData = JSON.parse(text); } catch {}
        }
      } else {
        const errText = await submitRes.text();
        console.error(`[DashScope] Video submit failed (${submitRes.status}):`, errText.slice(0, 200));
        return res.status(502).json({ error: `阿里云百炼网关拒绝请求（HTTP ${submitRes.status}），请检查 API Key 是否有效。` });
      }

      const taskId = submitData.output?.task_id;

      if (!taskId) {
        const errMsg = submitData.error?.message || submitData.message || JSON.stringify(submitData);
        return res.status(400).json({ error: `提交视频生成任务失败：${errMsg}` });
      }

      console.log(`[DashScope] Video task submitted. task_id=${taskId}, polling...`);

      // Step 2: Poll for completion (up to 5 minutes for video)
      const maxAttempts = 150;
      let outputUrl = "";
      let finalStatus = "";

      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        await new Promise(r => setTimeout(r, 2000));

        const statusRes = await fetch(`https://dashscope.aliyuncs.com/api/v1/tasks/${taskId}`, {
          method: "GET",
          headers: {
            "Authorization": `Bearer ${apiKey.trim()}`,
            "Content-Type": "application/json"
          }
        });

        let statusData: any = {};
        if (statusRes.ok) {
          const stext = await statusRes.text();
          if (stext) {
            try { statusData = JSON.parse(stext); } catch {}
          }
        } else {
          console.error(`[DashScope] Video poll failed (${statusRes.status})`);
        }

        const state = statusData.output?.task_status || statusData.output?.state || "";

        console.log(`[DashScope] Video poll ${attempt + 1}: state=${state}`);

        if (state === "SUCCEEDED" || state === "succeeded" || state === "COMPLETED") {
          // Official response: output.choices[0].message.content[0].video.video_url
          outputUrl = statusData.output?.choices?.[0]?.message?.content?.[0]?.video?.video_url
            || statusData.output?.output?.url
            || statusData.output?.video_url
            || statusData.output?.url
            || "";
          finalStatus = "succeeded";
          break;
        }

        if (state === "FAILED" || state === "failed" || state === "ERROR") {
          finalStatus = "failed";
          const errMsg = statusData.output?.error?.message || statusData.error?.message || JSON.stringify(statusData);
          return res.status(500).json({ error: `视频生成任务失败：${errMsg}` });
        }

        if (attempt === maxAttempts - 1) {
          return res.status(504).json({ error: `视频生成超时（超过 5 分钟），请稍后重试。任务ID：${taskId}` });
        }
      }

      if (!outputUrl) {
        return res.status(500).json({ error: `视频生成完成但未返回 URL，请检查模型配置。任务ID：${taskId}` });
      }

      console.log(`[DashScope] Video generation succeeded. URL: ${outputUrl.slice(0, 80)}...`);
      res.json({
        url: outputUrl,
        taskId,
        model: selectedModel,
        type: "video"
      });
    } catch (error: any) {
      console.error("[/api/video-generation] exception:", error);
      res.status(500).json({ error: `视频生成异常：${error.message || error}` });
    }
  });

  // Serve static files in production / Vite dev server in dev
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on port ${PORT}`);
  });
}

startServer();
