import JSZip from "jszip";
import katex from "katex";
import sharp from "sharp";
import { DOMParser } from "@xmldom/xmldom";

export type EmbeddedWordImage = {
  path: string;
  mimeType?: string;
  base64: string;
};

export type ModelingPaperOptions = {
  teamNumber?: string;
  problem?: string;
  year?: string;
  images?: EmbeddedWordImage[];
  paperFormat?: "himcm" | "mcm";
};

type PaperBlock =
  | { kind: "heading"; level: 1 | 2 | 3; text: string }
  | { kind: "paragraph" | "bullet" | "number" | "code"; text: string }
  | { kind: "formula"; latex: string }
  | { kind: "image"; path: string; caption: string }
  | { kind: "table"; rows: string[][]; caption?: string }
  | { kind: "toc" }
  | { kind: "pagebreak" };

type PreparedImage = {
  path: string;
  extension: "png" | "jpg" | "jpeg";
  buffer: Buffer;
  width: number;
  height: number;
  relationshipId: string;
  mediaName: string;
};

const escapeXml = (value: string) => value
  .replace(/&/g, "&amp;")
  .replace(/</g, "&lt;")
  .replace(/>/g, "&gt;")
  .replace(/\"/g, "&quot;")
  .replace(/'/g, "&apos;");

const normalizeImagePath = (value: string) => value.trim()
  .replace(/^<|>$/g, "")
  .replace(/\\/g, "/")
  .replace(/^\.\//, "");

const stripMarkdown = (value: string) => value
  .replace(/\*\*([^*]+)\*\*/g, "$1")
  .replace(/`([^`]+)`/g, "$1")
  .replace(/\*([^*]+)\*/g, "$1")
  .trim();

const summaryLabel = /^(?:\*{0,2})?(?:summary|摘要)(?:\*{0,2})?$/i;

// A tool-call title can be abbreviated, while the first H1 before Summary is
// the complete paper title.  Use that authoritative title exactly once.
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

const normalizeTitleForComparison = (value: string) => stripMarkdown(value)
  .toLocaleLowerCase()
  .replace(/[\s\p{P}\p{S}_]+/gu, "");

const splitTableRow = (line: string) => line.trim()
  .replace(/^\|/, "")
  .replace(/\|$/, "")
  .split("|")
  .map(cell => cell.trim());

const isTableDivider = (line: string) => {
  const cells = splitTableRow(line);
  return cells.length > 0 && cells.every(cell => /^:?-{3,}:?$/.test(cell));
};

const parsePaperMarkdown = (markdown: string, title: string): PaperBlock[] => {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  const blocks: PaperBlock[] = [];
  let index = 0;
  let inCode = false;
  let beforeSummary = true;
  const normalizedTitle = normalizeTitleForComparison(title);

  while (index < lines.length) {
    const raw = lines[index].replace(/\s+$/, "");
    const trimmed = raw.trim();

    if (/^```/.test(trimmed)) {
      inCode = !inCode;
      index += 1;
      continue;
    }
    if (inCode) {
      blocks.push({ kind: "code", text: raw || " " });
      index += 1;
      continue;
    }
    if (!trimmed) {
      index += 1;
      continue;
    }
    // Agents occasionally emit the paper title twice: once as H1 and again
    // as an ordinary (or bold) paragraph immediately before Summary.
    if (beforeSummary && normalizedTitle && normalizeTitleForComparison(trimmed) === normalizedTitle) {
      index += 1;
      continue;
    }
    if (/^(?:\[TOC\]|<!--\s*toc\s*-->)$/i.test(trimmed)) {
      blocks.push({ kind: "toc" });
      index += 1;
      continue;
    }
    if (/^(?:\[PAGEBREAK\]|<!--\s*pagebreak\s*-->)$/i.test(trimmed)) {
      blocks.push({ kind: "pagebreak" });
      index += 1;
      continue;
    }
    if (summaryLabel.test(trimmed)) {
      blocks.push({ kind: "heading", level: 1, text: "Summary" });
      beforeSummary = false;
      index += 1;
      continue;
    }
    if (trimmed.startsWith("$$")) {
      const formulaLines: string[] = [];
      let first = trimmed.slice(2);
      if (first.endsWith("$$")) {
        formulaLines.push(first.slice(0, -2));
        index += 1;
      } else {
        if (first) formulaLines.push(first);
        index += 1;
        while (index < lines.length && !lines[index].trim().endsWith("$$")) {
          formulaLines.push(lines[index]);
          index += 1;
        }
        if (index < lines.length) {
          formulaLines.push(lines[index].trim().replace(/\$\$$/, ""));
          index += 1;
        }
      }
      blocks.push({ kind: "formula", latex: formulaLines.join(" ").trim() });
      continue;
    }
    const image = trimmed.match(/^!\[([^\]]*)\]\((?:<([^>]+)>|([^\)]+))\)$/);
    if (image) {
      blocks.push({
        kind: "image",
        caption: stripMarkdown(image[1]) || "Figure",
        path: normalizeImagePath(image[2] || image[3] || "")
      });
      index += 1;
      continue;
    }
    if (trimmed.includes("|") && index + 1 < lines.length && isTableDivider(lines[index + 1])) {
      const rows = [splitTableRow(trimmed)];
      index += 2;
      while (index < lines.length && lines[index].trim().includes("|") && lines[index].trim()) {
        rows.push(splitTableRow(lines[index]));
        index += 1;
      }
      const previous = blocks[blocks.length - 1];
      const captionText = previous?.kind === "paragraph" ? stripMarkdown(previous.text) : "";
      const caption = /^(?:table|表)\s*\.?\s*\d+(?:\s*[:.]?\s*.*)?$/i.test(captionText)
        ? captionText
        : undefined;
      if (caption) blocks.pop();
      blocks.push({ kind: "table", rows, caption });
      continue;
    }
    const heading = trimmed.match(/^(#{1,3})\s+(.+)$/);
    if (heading) {
      const text = stripMarkdown(heading[2]);
      if (summaryLabel.test(text)) beforeSummary = false;
      if (!(heading[1].length === 1 && text === title.trim())) {
        blocks.push({ kind: "heading", level: heading[1].length as 1 | 2 | 3, text });
      }
      index += 1;
      continue;
    }
    const bullet = trimmed.match(/^[-*+]\s+(.+)$/);
    if (bullet) {
      blocks.push({ kind: "bullet", text: bullet[1].trim() });
      index += 1;
      continue;
    }
    const numbered = trimmed.match(/^\d+[.)、]\s*(.+)$/);
    if (numbered) {
      blocks.push({ kind: "number", text: numbered[1].trim() });
      index += 1;
      continue;
    }
    blocks.push({ kind: "paragraph", text: trimmed });
    index += 1;
  }
  return blocks;
};

const mathRun = (text: string) => `<m:r><m:rPr><m:sty m:val="i"/></m:rPr><m:t xml:space="preserve">${escapeXml(text)}</m:t></m:r>`;

const childElements = (node: any) => Array.from(node?.childNodes || []).filter((child: any) => child.nodeType === 1) as any[];

const mathChildrenToOmml = (node: any): string => childElements(node).map(mathNodeToOmml).join("");

const mathNodeToOmml = (node: any): string => {
  const name = String(node?.localName || node?.nodeName || "").toLowerCase();
  const children = childElements(node);
  const child = (position: number) => children[position] ? mathNodeToOmml(children[position]) : mathRun(" ");

  if (["math", "mrow", "mstyle", "mpadded", "semantics"].includes(name)) {
    if (name === "semantics" && children.length) return mathNodeToOmml(children[0]);
    return mathChildrenToOmml(node);
  }
  if (name === "annotation" || name === "annotation-xml") return "";
  if (["mi", "mn", "mo", "mtext", "ms"].includes(name)) return mathRun(node.textContent || "");
  if (name === "mfrac") return `<m:f><m:fPr/><m:num><m:e>${child(0)}</m:e></m:num><m:den><m:e>${child(1)}</m:e></m:den></m:f>`;
  if (name === "msqrt") return `<m:rad><m:radPr><m:degHide m:val="1"/></m:radPr><m:deg/><m:e>${mathChildrenToOmml(node)}</m:e></m:rad>`;
  if (name === "mroot") return `<m:rad><m:radPr/><m:deg>${child(1)}</m:deg><m:e>${child(0)}</m:e></m:rad>`;
  if (name === "msub") return `<m:sSub><m:e>${child(0)}</m:e><m:sub>${child(1)}</m:sub></m:sSub>`;
  if (name === "msup") return `<m:sSup><m:e>${child(0)}</m:e><m:sup>${child(1)}</m:sup></m:sSup>`;
  if (name === "msubsup") return `<m:sSubSup><m:e>${child(0)}</m:e><m:sub>${child(1)}</m:sub><m:sup>${child(2)}</m:sup></m:sSubSup>`;
  if (name === "mover") return `<m:limUpp><m:e>${child(0)}</m:e><m:lim>${child(1)}</m:lim></m:limUpp>`;
  if (name === "munder") return `<m:limLow><m:e>${child(0)}</m:e><m:lim>${child(1)}</m:lim></m:limLow>`;
  if (name === "munderover") return `<m:limLow><m:e><m:limUpp><m:e>${child(0)}</m:e><m:lim>${child(2)}</m:lim></m:limUpp></m:e><m:lim>${child(1)}</m:lim></m:limLow>`;
  if (name === "mfenced") {
    const open = node.getAttribute?.("open") ?? "(";
    const close = node.getAttribute?.("close") ?? ")";
    return `<m:d><m:dPr><m:begChr m:val="${escapeXml(open)}"/><m:endChr m:val="${escapeXml(close)}"/></m:dPr><m:e>${mathChildrenToOmml(node)}</m:e></m:d>`;
  }
  if (name === "mtable") {
    const rows = children.filter(item => String(item.localName || item.nodeName).toLowerCase() === "mtr");
    return `<m:m>${rows.map(row => `<m:mr>${childElements(row).map(cell => `<m:e>${mathChildrenToOmml(cell)}</m:e>`).join("")}</m:mr>`).join("")}</m:m>`;
  }
  return node.textContent ? mathRun(node.textContent) : mathChildrenToOmml(node);
};

const latexToOmml = (latex: string) => {
  try {
    const mathml = katex.renderToString(latex, { output: "mathml", throwOnError: false, strict: "ignore" });
    const document = new DOMParser().parseFromString(mathml, "application/xml");
    const math = document.getElementsByTagName("math")[0];
    return `<m:oMath>${math ? mathChildrenToOmml(math) : mathRun(latex)}</m:oMath>`;
  } catch {
    return `<m:oMath>${mathRun(latex)}</m:oMath>`;
  }
};

const wordTextRun = (text: string, properties = "") => {
  const preserve = /^\s|\s$|\s{2,}/.test(text) ? ' xml:space="preserve"' : "";
  return `<w:r>${properties ? `<w:rPr>${properties}</w:rPr>` : ""}<w:t${preserve}>${escapeXml(text || " ")}</w:t></w:r>`;
};

const wordRunsWithMath = (text: string, code = false) => {
  if (code) return wordTextRun(text, '<w:rFonts w:ascii="Consolas" w:hAnsi="Consolas"/><w:sz w:val="18"/>');
  const runs: string[] = [];
  const pattern = /(\$[^$\n]+\$|\*\*[^*]+\*\*|`[^`]+`|\*[^*]+\*)/g;
  let cursor = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    if (match.index > cursor) runs.push(wordTextRun(text.slice(cursor, match.index)));
    const token = match[0];
    if (token.startsWith("$")) runs.push(latexToOmml(token.slice(1, -1)));
    else if (token.startsWith("**")) runs.push(wordTextRun(token.slice(2, -2), "<w:b/><w:bCs/>"));
    else if (token.startsWith("`")) runs.push(wordTextRun(token.slice(1, -1), '<w:rFonts w:ascii="Consolas" w:hAnsi="Consolas"/><w:shd w:val="clear" w:fill="F2F2F2"/>'));
    else runs.push(wordTextRun(token.slice(1, -1), "<w:i/><w:iCs/>"));
    cursor = match.index + token.length;
  }
  if (cursor < text.length) runs.push(wordTextRun(text.slice(cursor)));
  return runs.join("") || wordTextRun(" ");
};

const paragraphXml = (style: string, runs: string, extra = "") => `<w:p><w:pPr><w:pStyle w:val="${style}"/>${extra}</w:pPr>${runs}</w:p>`;

const paperTextWidth = (paperFormat?: ModelingPaperOptions["paperFormat"]) => paperFormat === "mcm" ? 9_360 : 10_466;

const displayFormulaXml = (latex: string, number: number, paperFormat?: ModelingPaperOptions["paperFormat"]) => {
  const width = paperTextWidth(paperFormat);
  // Letter with 1-in margins needs enough room for the equation number plus
  // Word's table-cell padding.  Equal side columns preserve formula centering.
  const sideColumn = paperFormat === "mcm" ? 1_000 : 900;
  const formulaColumn = width - 2 * sideColumn;
  const numberIndent = paperFormat === "mcm" ? '<w:ind w:right="180"/>' : "";
  return `<w:tbl>
  <w:tblPr><w:tblW w:w="${width}" w:type="dxa"/><w:tblLayout w:type="fixed"/><w:jc w:val="center"/><w:tblBorders><w:top w:val="nil"/><w:left w:val="nil"/><w:bottom w:val="nil"/><w:right w:val="nil"/><w:insideH w:val="nil"/><w:insideV w:val="nil"/></w:tblBorders></w:tblPr>
  <w:tblGrid><w:gridCol w:w="${sideColumn}"/><w:gridCol w:w="${formulaColumn}"/><w:gridCol w:w="${sideColumn}"/></w:tblGrid>
  <w:tr><w:tc><w:tcPr><w:tcW w:w="${sideColumn}" w:type="dxa"/></w:tcPr><w:p/></w:tc><w:tc><w:tcPr><w:tcW w:w="${formulaColumn}" w:type="dxa"/></w:tcPr><w:p><w:pPr><w:jc w:val="center"/></w:pPr><m:oMathPara><m:oMathParaPr><m:jc m:val="centerGroup"/></m:oMathParaPr>${latexToOmml(latex)}</m:oMathPara></w:p></w:tc><w:tc><w:tcPr><w:tcW w:w="${sideColumn}" w:type="dxa"/><w:tcMar><w:left w:w="0" w:type="dxa"/><w:right w:w="0" w:type="dxa"/></w:tcMar></w:tcPr><w:p><w:pPr><w:jc w:val="right"/>${numberIndent}</w:pPr>${wordTextRun(`(${number})`)}</w:p></w:tc></w:tr>
</w:tbl>`;
};

const tableXml = (rows: string[][], caption?: string, paperFormat?: ModelingPaperOptions["paperFormat"]) => {
  const columns = Math.max(1, ...rows.map(row => row.length));
  const totalWidth = paperTextWidth(paperFormat);
  const width = Math.floor(totalWidth / columns);
  const grid = Array.from({ length: columns }, () => `<w:gridCol w:w="${width}"/>`).join("");
  const body = rows.map((row, rowIndex) => `<w:tr>${Array.from({ length: columns }, (_, column) => {
    const shading = rowIndex === 0 ? '<w:shd w:val="clear" w:fill="D9EAF7"/>' : "";
    return `<w:tc><w:tcPr><w:tcW w:w="${width}" w:type="dxa"/>${shading}<w:vAlign w:val="center"/></w:tcPr><w:p><w:pPr><w:jc w:val="center"/><w:spacing w:after="0"/><w:ind w:firstLine="0"/></w:pPr>${wordRunsWithMath(row[column] || " ")}</w:p></w:tc>`;
  }).join("")}</w:tr>`).join("");
  return `${caption ? paragraphXml("TableCaption", wordTextRun(caption)) : ""}<w:tbl><w:tblPr><w:tblW w:w="${totalWidth}" w:type="dxa"/><w:tblLayout w:type="fixed"/><w:jc w:val="center"/><w:tblBorders><w:top w:val="single" w:sz="4" w:color="808080"/><w:left w:val="single" w:sz="4" w:color="808080"/><w:bottom w:val="single" w:sz="4" w:color="808080"/><w:right w:val="single" w:sz="4" w:color="808080"/><w:insideH w:val="single" w:sz="4" w:color="BFBFBF"/><w:insideV w:val="single" w:sz="4" w:color="BFBFBF"/></w:tblBorders></w:tblPr><w:tblGrid>${grid}</w:tblGrid>${body}</w:tbl>${paragraphXml("Normal", wordTextRun(" "), '<w:spacing w:after="0"/>')}`;
};

const imageDrawingXml = (image: PreparedImage, caption: string, drawingId: number) => {
  const maxWidth = 5_943_600;
  const maxHeight = 4_114_800;
  const rawWidth = image.width * 9_525;
  const rawHeight = image.height * 9_525;
  const scale = Math.min(1, maxWidth / rawWidth, maxHeight / rawHeight);
  const cx = Math.max(9_525, Math.round(rawWidth * scale));
  const cy = Math.max(9_525, Math.round(rawHeight * scale));
  const description = caption || image.path;
  return `<w:p><w:pPr><w:jc w:val="center"/><w:spacing w:before="120" w:after="60"/></w:pPr><w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="${cx}" cy="${cy}"/><wp:effectExtent l="0" t="0" r="0" b="0"/><wp:docPr id="${drawingId}" name="${escapeXml(image.mediaName)}" descr="${escapeXml(description)}"/><wp:cNvGraphicFramePr/><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic><pic:nvPicPr><pic:cNvPr id="0" name="${escapeXml(image.mediaName)}"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="${image.relationshipId}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>${paragraphXml("Caption", wordTextRun(caption || image.path))}`;
};

const prepareImages = async (images: EmbeddedWordImage[] = []) => {
  const prepared = new Map<string, PreparedImage>();
  let index = 0;
  for (const item of images.slice(0, 40)) {
    const normalizedPath = normalizeImagePath(item.path || "");
    if (!normalizedPath || prepared.has(normalizedPath) || !item.base64) continue;
    const input = Buffer.from(item.base64, "base64");
    if (!input.length || input.length > 12 * 1024 * 1024) continue;
    const metadata = await sharp(input).metadata();
    const format = metadata.format === "jpeg" ? "jpeg" : metadata.format === "jpg" ? "jpg" : metadata.format === "png" ? "png" : "png";
    const buffer = ["png", "jpg", "jpeg"].includes(metadata.format || "") ? input : await sharp(input).png().toBuffer();
    index += 1;
    prepared.set(normalizedPath, {
      path: normalizedPath,
      extension: format,
      buffer,
      width: metadata.width || 800,
      height: metadata.height || 600,
      relationshipId: `rId${5 + index}`,
      mediaName: `image${index}.${format}`
    });
  }
  return prepared;
};

const coverXml = (title: string) => paragraphXml("PaperTitle", wordTextRun(title));

export const buildModelingPaperBuffer = async (title: string, markdown: string, options: ModelingPaperOptions = {}) => {
  const zip = new JSZip();
  const paperTitle = derivePaperTitle(markdown, title);
  const blocks = parsePaperMarkdown(markdown, paperTitle);
  const images = await prepareImages(options.images);
  const pageSize = options.paperFormat === "mcm"
    ? '<w:pgSz w:w="12240" w:h="15840"/>'
    : '<w:pgSz w:w="11906" w:h="16838"/>';
  const pageMargins = options.paperFormat === "mcm"
    ? '<w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="0" w:footer="0" w:gutter="0"/>'
    : '<w:pgMar w:top="288" w:right="720" w:bottom="720" w:left="720" w:header="0" w:footer="0" w:gutter="0"/>';
  let equationNumber = 0;
  let drawingId = 1;
  let hasSummary = false;
  let summaryHeadingWritten = false;
  let inReferences = false;
  let expectsFormulaExplanation = false;

  const content = blocks.map(block => {
    if (block.kind === "heading") {
      if (/^summary$/i.test(block.text)) {
        if (summaryHeadingWritten) return "";
        summaryHeadingWritten = true;
      }
      inReferences = /^(references|reference)$/i.test(block.text);
      expectsFormulaExplanation = false;
      const centered = /^(summary|摘要|contents|目录)$/i.test(block.text);
      if (/^(summary|摘要)$/i.test(block.text)) hasSummary = true;
      return paragraphXml(`Heading${block.level}`, wordRunsWithMath(block.text), centered ? '<w:jc w:val="center"/>' : "");
    }
    if (block.kind === "paragraph") {
      const text = expectsFormulaExplanation ? block.text.replace(/^Where\b/, "where") : block.text;
      if (/^summary$/i.test(text) && summaryHeadingWritten) return "";
      const noIndent = expectsFormulaExplanation || /^(where|wherein)\b/i.test(text) || inReferences;
      expectsFormulaExplanation = false;
      return paragraphXml("Normal", wordRunsWithMath(text), noIndent ? '<w:ind w:firstLine="0"/>' : "");
    }
    if (block.kind === "bullet") return paragraphXml("Normal", wordRunsWithMath(block.text), '<w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr><w:ind w:firstLine="0"/>');
    if (block.kind === "number") return paragraphXml("Normal", wordRunsWithMath(block.text), '<w:numPr><w:ilvl w:val="0"/><w:numId w:val="2"/></w:numPr><w:ind w:firstLine="0"/>');
    if (block.kind === "code") return paragraphXml("Code", wordRunsWithMath(block.text, true));
    if (block.kind === "formula") {
      expectsFormulaExplanation = true;
      return displayFormulaXml(block.latex, ++equationNumber, options.paperFormat);
    }
    if (block.kind === "table") return tableXml(block.rows, block.caption, options.paperFormat);
    if (block.kind === "toc") return `<w:p><w:pPr><w:jc w:val="center"/><w:pStyle w:val="Heading1"/><w:spacing w:before="0" w:after="0" w:line="240" w:lineRule="auto"/><w:ind w:firstLine="0"/></w:pPr>${wordTextRun("Contents")}</w:p><w:p><w:pPr><w:spacing w:before="0" w:after="0" w:line="240" w:lineRule="auto"/><w:ind w:firstLine="0"/></w:pPr><w:fldSimple w:instr="TOC \\o &quot;1-3&quot; \\h \\z \\u"><w:r><w:t>Right-click and choose Update Field to refresh the table of contents.</w:t></w:r></w:fldSimple></w:p>`;
    if (block.kind === "pagebreak") return `<w:p><w:r><w:br w:type="page"/></w:r></w:p>`;
    if (block.kind === "image") {
      const image = images.get(block.path);
      return image ? imageDrawingXml(image, block.caption, drawingId++) : paragraphXml("Caption", wordTextRun(`[Missing result image: ${block.path}]`));
    }
    return "";
  }).join("");

  const documentBody = `${coverXml(paperTitle)}${hasSummary ? "" : paragraphXml("Heading1", wordTextRun("Summary"), '<w:jc w:val="center"/>')}${content}`;
  const createdAt = new Date().toISOString();
  const imageDefaults = '<Default Extension="png" ContentType="image/png"/><Default Extension="jpg" ContentType="image/jpeg"/><Default Extension="jpeg" ContentType="image/jpeg"/>';
  const imageRelationships = Array.from(images.values()).map(image => `<Relationship Id="${image.relationshipId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/${image.mediaName}"/>`).join("\n  ");

  zip.file("[Content_Types].xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>${imageDefaults}<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/><Override PartName="/word/settings.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/><Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/></Types>`);
  zip.folder("_rels")?.file(".rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/></Relationships>`);
  zip.folder("docProps")?.file("core.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>${escapeXml(title)}</dc:title><dc:creator>Modulus 智能体</dc:creator><cp:lastModifiedBy>Modulus 智能体</cp:lastModifiedBy><dcterms:created xsi:type="dcterms:W3CDTF">${createdAt}</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">${createdAt}</dcterms:modified></cp:coreProperties>`);
  zip.folder("docProps")?.file("app.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Application>MathHub Modulus</Application></Properties>`);

  const word = zip.folder("word");
  word?.file("document.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><w:body>${documentBody}<w:sectPr>${pageSize}${pageMargins}<w:cols w:num="1"/><w:docGrid w:linePitch="312"/></w:sectPr></w:body></w:document>`);
  word?.folder("_rels")?.file("document.xml.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/settings" Target="settings.xml"/>${imageRelationships}</Relationships>`);
  word?.file("styles.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Times New Roman" w:hAnsi="Times New Roman" w:eastAsia="宋体"/><w:sz w:val="24"/><w:szCs w:val="24"/><w:lang w:val="en-US" w:eastAsia="zh-CN"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:jc w:val="both"/><w:spacing w:after="181" w:line="240" w:lineRule="auto"/><w:ind w:firstLine="480"/></w:pPr></w:pPrDefault></w:docDefaults><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/><w:pPr><w:jc w:val="both"/><w:spacing w:after="181" w:line="240" w:lineRule="auto"/><w:ind w:firstLine="480"/></w:pPr></w:style><w:style w:type="paragraph" w:styleId="PaperTitle"><w:name w:val="Paper Title"/><w:basedOn w:val="Normal"/><w:pPr><w:jc w:val="center"/><w:spacing w:before="80" w:after="100"/><w:ind w:firstLine="0"/></w:pPr><w:rPr><w:b/><w:sz w:val="32"/><w:szCs w:val="32"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:qFormat/><w:pPr><w:keepNext/><w:keepLines/><w:outlineLvl w:val="0"/><w:spacing w:before="240" w:after="120"/><w:ind w:firstLine="0"/></w:pPr><w:rPr><w:b/><w:sz w:val="32"/><w:szCs w:val="32"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:basedOn w:val="Normal"/><w:qFormat/><w:pPr><w:keepNext/><w:keepLines/><w:outlineLvl w:val="1"/><w:spacing w:before="200" w:after="100"/><w:ind w:firstLine="0"/></w:pPr><w:rPr><w:b/><w:sz w:val="28"/><w:szCs w:val="28"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="Heading3"><w:name w:val="heading 3"/><w:basedOn w:val="Normal"/><w:qFormat/><w:pPr><w:keepNext/><w:keepLines/><w:outlineLvl w:val="2"/><w:spacing w:before="160" w:after="80"/><w:ind w:firstLine="0"/></w:pPr><w:rPr><w:b/><w:sz w:val="24"/><w:szCs w:val="24"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="Caption"><w:name w:val="caption"/><w:basedOn w:val="Normal"/><w:pPr><w:jc w:val="center"/><w:spacing w:after="160"/><w:ind w:firstLine="0"/></w:pPr><w:rPr><w:rFonts w:ascii="Palatino Linotype" w:hAnsi="Palatino Linotype"/><w:b/><w:sz w:val="20"/><w:szCs w:val="20"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="TableCaption"><w:name w:val="Table Caption"/><w:basedOn w:val="Caption"/><w:pPr><w:jc w:val="center"/><w:spacing w:before="120" w:after="60"/><w:ind w:firstLine="0"/></w:pPr></w:style><w:style w:type="paragraph" w:styleId="Code"><w:name w:val="Code"/><w:basedOn w:val="Normal"/><w:pPr><w:spacing w:after="0" w:line="240"/><w:shd w:val="clear" w:fill="F2F2F2"/><w:ind w:left="180" w:firstLine="0"/></w:pPr><w:rPr><w:rFonts w:ascii="Consolas" w:hAnsi="Consolas"/><w:sz w:val="18"/></w:rPr></w:style></w:styles>`);
  word?.file("numbering.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:abstractNum w:abstractNumId="0"><w:multiLevelType w:val="singleLevel"/><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="bullet"/><w:lvlText w:val="•"/><w:pPr><w:ind w:left="720" w:hanging="360"/></w:pPr></w:lvl></w:abstractNum><w:abstractNum w:abstractNumId="1"><w:multiLevelType w:val="singleLevel"/><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:lvlText w:val="%1."/><w:pPr><w:ind w:left="720" w:hanging="360"/></w:pPr></w:lvl></w:abstractNum><w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num><w:num w:numId="2"><w:abstractNumId w:val="1"/></w:num></w:numbering>`);
  word?.file("settings.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:settings xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:zoom w:percent="100"/><w:updateFields w:val="true"/><w:defaultTabStop w:val="720"/><w:compat/></w:settings>`);
  for (const image of images.values()) word?.folder("media")?.file(image.mediaName, image.buffer);

  return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE", compressionOptions: { level: 6 } });
};
