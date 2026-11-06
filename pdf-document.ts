import fs from "fs";
import path from "path";
import katex from "katex";
import puppeteer from "puppeteer";
import type { EmbeddedWordImage, ModelingPaperOptions } from "./word-document.js";

type PdfPaperOptions = ModelingPaperOptions & { images?: EmbeddedWordImage[] };

const escapeHtml = (value: string) => value
  .replace(/&/g, "&amp;")
  .replace(/</g, "&lt;")
  .replace(/>/g, "&gt;")
  .replace(/\"/g, "&quot;")
  .replace(/'/g, "&#39;");

const normalizeImagePath = (value: string) => value.trim()
  .replace(/^<|>$/g, "")
  .replace(/\\/g, "/")
  .replace(/^\.\//, "");

const inlineMarkup = (value: string) => {
  const pattern = /(\$[^$\n]+\$|\*\*[^*]+\*\*|`[^`]+`|\*[^*]+\*)/g;
  const parts: string[] = [];
  let cursor = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(value)) !== null) {
    parts.push(escapeHtml(value.slice(cursor, match.index)));
    const token = match[0];
    if (token.startsWith("$")) {
      parts.push(katex.renderToString(token.slice(1, -1), { throwOnError: false, strict: "ignore", output: "html" }));
    } else if (token.startsWith("**")) {
      parts.push(`<strong>${escapeHtml(token.slice(2, -2))}</strong>`);
    } else if (token.startsWith("`")) {
      parts.push(`<code>${escapeHtml(token.slice(1, -1))}</code>`);
    } else {
      parts.push(`<em>${escapeHtml(token.slice(1, -1))}</em>`);
    }
    cursor = match.index + token.length;
  }
  parts.push(escapeHtml(value.slice(cursor)));
  return parts.join("");
};

const stripMarkdown = (value: string) => value
  .replace(/\*\*([^*]+)\*\*/g, "$1")
  .replace(/`([^`]+)`/g, "$1")
  .replace(/\*([^*]+)\*/g, "$1")
  .trim();

// The paper title is supplied separately to the exporter.  Models commonly
// repeat it as the first Markdown heading, sometimes changing dash variants
// or whitespace, so compare a punctuation-insensitive form before rendering.
const normalizeTitleForComparison = (value: string) => stripMarkdown(value)
  .toLocaleLowerCase()
  .replace(/[\s\p{P}\p{S}_]+/gu, "");

const summaryLabel = /^(?:\*{0,2})?(?:summary|摘要)(?:\*{0,2})?$/i;

// Prefer the complete Markdown H1 before Summary over an abbreviated title
// passed to the export tool, then omit that source H1 from the body.
const derivePaperTitle = (markdown: string, fallback: string) => {
  for (const rawLine of markdown.replace(/\r\n/g, "\n").split("\n")) {
    const trimmed = rawLine.trim();
    if (!trimmed) continue;
    if (summaryLabel.test(trimmed) || /^(?:\[PAGEBREAK\]|\[TOC\])$/i.test(trimmed)) break;
    const heading = trimmed.match(/^#\s+(.+)$/);
    if (heading) {
      const candidate = stripMarkdown(heading[1]);
      if (candidate && !summaryLabel.test(candidate)) return candidate;
    }
  }
  return fallback.trim() || "Mathematical Modeling Paper";
};

const splitTableRow = (line: string) => line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map(cell => cell.trim());
const isTableDivider = (line: string) => splitTableRow(line).every(cell => /^:?-{3,}:?$/.test(cell));

const katexCssWithEmbeddedFonts = () => {
  const cssPath = path.join(process.cwd(), "node_modules", "katex", "dist", "katex.min.css");
  if (!fs.existsSync(cssPath)) return "";
  const cssDirectory = path.dirname(cssPath);
  return fs.readFileSync(cssPath, "utf8").replace(/url\(([^)]+)\)/g, (_match, rawUrl: string) => {
    const filename = rawUrl.trim().replace(/^['\"]|['\"]$/g, "").replace(/^fonts\//, "fonts/");
    const fontPath = path.resolve(cssDirectory, filename);
    if (!fontPath.startsWith(cssDirectory) || !fs.existsSync(fontPath)) return "url()";
    const extension = path.extname(fontPath).toLowerCase();
    const mime = extension === ".woff2" ? "font/woff2" : extension === ".woff" ? "font/woff" : "font/ttf";
    return `url(data:${mime};base64,${fs.readFileSync(fontPath).toString("base64")})`;
  });
};

const renderPaperContent = (markdown: string, title: string, images: EmbeddedWordImage[] = []) => {
  const imageMap = new Map(images.map(image => [normalizeImagePath(image.path), image]));
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  const headings: Array<{ level: number; text: string; id: string }> = [];
  for (const line of lines) {
    const match = line.trim().match(/^(#{1,3})\s+(.+)$/);
    if (!match) continue;
    const text = match[2].replace(/\*\*|`|\*/g, "").trim();
    if (match[1].length === 1 && normalizeTitleForComparison(text) === normalizeTitleForComparison(title)) continue;
    headings.push({ level: match[1].length, text, id: `section-${headings.length + 1}` });
  }

  const html: string[] = [];
  let index = 0;
  let headingIndex = 0;
  let equationNumber = 0;
  let inCode = false;
  let inReferences = false;
  let expectsFormulaExplanation = false;
  let summaryHeadingWritten = false;
  let beforeSummary = true;
  const normalizedTitle = normalizeTitleForComparison(title);
  while (index < lines.length) {
    const raw = lines[index].replace(/\s+$/, "");
    const trimmed = raw.trim();
    if (/^```/.test(trimmed)) {
      inCode = !inCode;
      html.push(inCode ? "<pre><code>" : "</code></pre>");
      index += 1;
      continue;
    }
    if (inCode) {
      html.push(`${escapeHtml(raw)}\n`);
      index += 1;
      continue;
    }
    if (!trimmed) {
      index += 1;
      continue;
    }
    // The same title may be emitted as both an H1 and a regular paragraph
    // before Summary.  The external title is the single source of truth.
    if (beforeSummary && normalizedTitle && normalizeTitleForComparison(trimmed) === normalizedTitle) {
      index += 1;
      continue;
    }
    // A number of model outputs use **Summary** (or plain Summary) instead of
    // a Markdown heading.  It is still the required centered, bold heading on
    // the first page, never body text.
    if (summaryLabel.test(trimmed)) {
      if (!summaryHeadingWritten) {
        summaryHeadingWritten = true;
        html.push('<h1 class="centered-heading">Summary</h1>');
      }
      beforeSummary = false;
      index += 1;
      continue;
    }
    if (/^(?:\[PAGEBREAK\]|<!--\s*pagebreak\s*-->)$/i.test(trimmed)) {
      html.push('<div class="page-break"></div>');
      index += 1;
      continue;
    }
    if (/^(?:\[TOC\]|<!--\s*toc\s*-->)$/i.test(trimmed)) {
      html.push('<section class="toc"><h1>Contents</h1>');
      for (const heading of headings.filter(item => !/^(summary|摘要|contents|目录)$/i.test(item.text))) {
        html.push(`<div class="toc-item toc-level-${heading.level}"><a href="#${heading.id}">${escapeHtml(heading.text)}</a></div>`);
      }
      html.push("</section>");
      index += 1;
      continue;
    }
    if (trimmed.startsWith("$$")) {
      const formula: string[] = [];
      let first = trimmed.slice(2);
      if (first.endsWith("$$")) {
        formula.push(first.slice(0, -2));
        index += 1;
      } else {
        if (first) formula.push(first);
        index += 1;
        while (index < lines.length && !lines[index].trim().endsWith("$$")) {
          formula.push(lines[index]);
          index += 1;
        }
        if (index < lines.length) {
          formula.push(lines[index].trim().replace(/\$\$$/, ""));
          index += 1;
        }
      }
      const rendered = katex.renderToString(formula.join(" ").trim(), { displayMode: true, throwOnError: false, strict: "ignore", output: "html" });
      html.push(`<div class="equation"><div class="equation-content">${rendered}</div><span class="equation-number">(${++equationNumber})</span></div>`);
      expectsFormulaExplanation = true;
      continue;
    }
    const imageMatch = trimmed.match(/^!\[([^\]]*)\]\((?:<([^>]+)>|([^\)]+))\)$/);
    if (imageMatch) {
      const caption = imageMatch[1].replace(/\*\*|`|\*/g, "").trim() || "Figure";
      const imagePath = normalizeImagePath(imageMatch[2] || imageMatch[3] || "");
      const image = imageMap.get(imagePath);
      if (image) {
        const mime = image.mimeType || (imagePath.toLowerCase().endsWith(".jpg") || imagePath.toLowerCase().endsWith(".jpeg") ? "image/jpeg" : "image/png");
        html.push(`<figure><img src="data:${escapeHtml(mime)};base64,${image.base64}" alt="${escapeHtml(caption)}"/><figcaption>${escapeHtml(caption)}</figcaption></figure>`);
      } else {
        html.push(`<p class="missing-image">[Missing result image: ${escapeHtml(imagePath)}]</p>`);
      }
      index += 1;
      continue;
    }
    if (/^(?:table|表)\s*\.?\s*\d+(?:\s*[:.]?\s*.*)?$/i.test(stripMarkdown(trimmed))) {
      // Agents usually leave one blank line between a caption and its Markdown
      // table.  Treat those blank lines as part of the same table construct.
      let tableStart = index + 1;
      while (tableStart < lines.length && !lines[tableStart].trim()) tableStart += 1;
      if (tableStart + 1 < lines.length && lines[tableStart].trim().includes("|") && isTableDivider(lines[tableStart + 1])) {
        html.push(`<div class="table-caption">${inlineMarkup(trimmed)}</div>`);
        index += 1;
        continue;
      }
    }
    if (trimmed.includes("|") && index + 1 < lines.length && isTableDivider(lines[index + 1])) {
      const rows = [splitTableRow(trimmed)];
      index += 2;
      while (index < lines.length && lines[index].trim().includes("|") && lines[index].trim()) {
        rows.push(splitTableRow(lines[index]));
        index += 1;
      }
      html.push("<table><thead><tr>" + rows[0].map(cell => `<th>${inlineMarkup(cell)}</th>`).join("") + "</tr></thead><tbody>" + rows.slice(1).map(row => `<tr>${row.map(cell => `<td>${inlineMarkup(cell)}</td>`).join("")}</tr>`).join("") + "</tbody></table>");
      expectsFormulaExplanation = false;
      continue;
    }
    const heading = trimmed.match(/^(#{1,3})\s+(.+)$/);
    if (heading) {
      const text = heading[2].replace(/\*\*|`|\*/g, "").trim();
      if (!(heading[1].length === 1 && normalizeTitleForComparison(text) === normalizeTitleForComparison(title))) {
        const current = headings[headingIndex++];
        if (/^summary$/i.test(text)) {
          if (summaryHeadingWritten) { index += 1; continue; }
          summaryHeadingWritten = true;
          beforeSummary = false;
        }
        inReferences = /^(references|reference)$/i.test(text);
        expectsFormulaExplanation = false;
        const centered = /^(summary|摘要|contents|目录)$/i.test(text) ? ' class="centered-heading"' : "";
        html.push(`<h${heading[1].length} id="${current?.id || `section-${headingIndex}`}"${centered}>${inlineMarkup(text)}</h${heading[1].length}>`);
      }
      index += 1;
      continue;
    }
    const bullet = trimmed.match(/^[-*+]\s+(.+)$/);
    if (bullet) {
      const items: string[] = [];
      while (index < lines.length) {
        const match = lines[index].trim().match(/^[-*+]\s+(.+)$/);
        if (!match) break;
        items.push(`<li>${inlineMarkup(match[1])}</li>`);
        index += 1;
      }
      html.push(`<ul>${items.join("")}</ul>`);
      continue;
    }
    const numbered = trimmed.match(/^\d+[.)、]\s*(.+)$/);
    if (numbered) {
      const items: string[] = [];
      while (index < lines.length) {
        const match = lines[index].trim().match(/^\d+[.)、]\s*(.+)$/);
        if (!match) break;
        items.push(`<li>${inlineMarkup(match[1])}</li>`);
        index += 1;
      }
      html.push(`<ol>${items.join("")}</ol>`);
      continue;
    }
    const text = expectsFormulaExplanation ? trimmed.replace(/^Where\b/, "where") : trimmed;
    if (!(/^summary$/i.test(text) && summaryHeadingWritten)) {
      const classes = [expectsFormulaExplanation || /^(where|wherein)\b/i.test(text) ? "formula-where" : "", inReferences ? "reference-entry" : ""].filter(Boolean).join(" ");
      html.push(`<p${classes ? ` class="${classes}"` : ""}>${inlineMarkup(text)}</p>`);
    }
    expectsFormulaExplanation = false;
    index += 1;
  }
  return html.join("\n");
};

export const buildModelingPaperHtml = (title: string, markdown: string, options: PdfPaperOptions = {}) => {
  const paperTitle = derivePaperTitle(markdown, title);
  const paperContent = renderPaperContent(markdown, paperTitle, options.images);
  const pageSize = options.paperFormat === "mcm" ? "Letter" : "A4";
  const pageMargin = options.paperFormat === "mcm" ? "25.4mm" : "16mm 12.7mm 14mm 12.7mm";
  return `<!doctype html><html><head><meta charset="utf-8"><style>${katexCssWithEmbeddedFonts()}
    @page { size: ${pageSize}; margin: ${pageMargin}; }
    * { box-sizing: border-box; }
    body { margin: 0; color: #111; font-family: "Times New Roman", "SimSun", serif; font-size: 12pt; line-height: 1.25; }
    .paper-title { text-align: center; font-size: 16pt; line-height: 1.2; margin: 3pt 8% 5pt; font-weight: 700; }
    h1, h2, h3 { break-after: avoid; page-break-after: avoid; font-weight: 700; }
    h1 { font-size: 16pt; margin: 15pt 0 7pt; }
    h2 { font-size: 14pt; margin: 12pt 0 6pt; }
    h3 { font-size: 12pt; margin: 10pt 0 5pt; }
    .centered-heading, .toc h1 { text-align: center; }
    p { margin: 0 0 7pt; text-align: justify; text-indent: 2em; orphans: 3; widows: 3; }
    ul, ol { margin: 4pt 0 8pt 2em; padding-left: 1.2em; }
    li { margin: 2pt 0; text-align: justify; }
    code { font-family: Consolas, monospace; font-size: 9pt; background: #f2f2f2; padding: 0 2pt; }
    pre { white-space: pre-wrap; break-inside: avoid; background: #f2f2f2; padding: 7pt; font-size: 9pt; }
    .page-break { break-before: page; page-break-before: always; }
    .toc { min-height: 0; break-inside: avoid; page-break-inside: avoid; }
    .toc-item { margin: 0; line-height: 1; border-bottom: 0.5pt dotted #aaa; }
    .toc-level-2 { margin-left: 1.5em; }
    .toc-level-3 { margin-left: 3em; }
    .toc a { color: #111; text-decoration: none; }
    .equation { display: grid; grid-template-columns: 1fr auto 1fr; align-items: center; margin: 9pt 0; break-inside: avoid; }
    .equation-content { grid-column: 2; text-align: center; min-width: 0; }
    /* KaTeX defaults to 1.21em.  Override both inline and display math so
       formula glyphs match the 12pt body text exactly. */
    .katex, p .katex, td .katex, th .katex, .equation .katex, .equation .katex-display { font-size: 1em !important; }
    .equation-number { grid-column: 3; justify-self: end; }
    .formula-where { text-indent: 0; }
    .reference-entry { text-indent: 0; }
    figure { margin: 10pt auto 12pt; text-align: center; break-inside: avoid; }
    figure img { display: block; max-width: 92%; max-height: 118mm; margin: 0 auto 5pt; object-fit: contain; }
    figcaption, .table-caption { font-family: "Palatino Linotype", Palatino, serif; font-size: 10pt; font-weight: 700; text-align: center; }
    .table-caption { margin: 9pt 0 4pt; }
    table { width: 100%; border-collapse: collapse; table-layout: fixed; margin: 8pt 0 11pt; break-inside: avoid; font-size: 10.5pt; }
    th, td { border: 0.7pt solid #777; padding: 4pt 5pt; text-align: center; overflow-wrap: anywhere; }
    th { background: #d9eaf7; font-weight: 700; }
    .missing-image { color: #a00; text-align: center; text-indent: 0; font-weight: 700; }
  </style></head><body><div class="paper-title">${escapeHtml(paperTitle)}</div>${paperContent}</body></html>`;
};

export const buildModelingPaperPdf = async (title: string, markdown: string, options: PdfPaperOptions = {}) => {
  const html = buildModelingPaperHtml(title, markdown, options);
  const browser = await puppeteer.launch({ headless: true, args: ["--no-sandbox", "--disable-setuid-sandbox"] });
  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: "load", timeout: 60_000 });
    await page.emulateMediaType("print");
    const outerMargins = options.paperFormat === "mcm"
      ? { top: "0mm", right: "0mm", bottom: "0mm", left: "0mm" }
      : { top: "5.08mm", right: "12.7mm", bottom: "12.7mm", left: "12.7mm" };
    const pdf = await page.pdf({
      format: options.paperFormat === "mcm" ? "Letter" : "A4",
      printBackground: true,
      displayHeaderFooter: false,
      preferCSSPageSize: true,
      margin: outerMargins
    });
    return Buffer.from(pdf);
  } finally {
    await browser.close();
  }
};
