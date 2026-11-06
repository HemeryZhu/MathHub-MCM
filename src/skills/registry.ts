export type NatureSkill = {
  name: string;
  description: string;
  instructions: string;
  aliases: string[];
  resourceRoot: string;
  compatibilityNote?: string;
};

type RawModuleLoader = () => Promise<string>;

const natureSkillSources = import.meta.glob(
  "./nature-skills-main/skills/*/SKILL.md",
  { eager: true, query: "?raw", import: "default" }
) as Record<string, string>;

const natureResourceModules = import.meta.glob(
  [
    "./nature-skills-main/skills/**/*.{md,yaml,yml,json,txt,tex,py,mjs,js,sh,csv,tsv,bib,ris,nbib,toml}",
    "!./nature-skills-main/skills/*/SKILL.md",
    "!./nature-skills-main/skills/**/tests/**",
    "!./nature-skills-main/skills/**/.pytest_cache/**"
  ],
  { query: "?raw", import: "default" }
) as Record<string, RawModuleLoader>;

const stripYamlQuotes = (value: string) => {
  const trimmed = value.trim();
  if (
    trimmed.length >= 2 &&
    ((trimmed.startsWith('"') && trimmed.endsWith('"')) ||
      (trimmed.startsWith("'") && trimmed.endsWith("'")))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
};

const parseFrontmatterField = (frontmatter: string, key: string) => {
  const lines = frontmatter.split(/\r?\n/);
  const keyPattern = new RegExp(`^${key}:\\s*(.*)$`);
  const index = lines.findIndex(line => keyPattern.test(line));
  if (index < 0) return undefined;

  const firstValue = lines[index].match(keyPattern)?.[1]?.trim() || "";
  if (![">", ">-", ">+", "|", "|-", "|+"].includes(firstValue)) {
    return stripYamlQuotes(firstValue);
  }

  const continuation: string[] = [];
  for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
    const line = lines[cursor];
    if (line.length > 0 && !/^\s/.test(line)) break;
    continuation.push(line.replace(/^\s+/, ""));
  }
  return continuation.join(firstValue.startsWith("|") ? "\n" : " ").trim();
};

const NATURE_SKILL_SUMMARIES: Record<string, string> = {
  "nature-academic-search": "多来源学术检索、去重、筛选与可复现检索记录。",
  "nature-citation": "引文格式、正文引用和参考文献表的规范化处理。",
  "nature-data": "科研数据清洗、质量检查、可复现分析与结果导出。",
  "nature-downloader": "论文、补充材料和公开数据的合规下载工作流。",
  "nature-experiment-log": "结构化记录实验设计、过程、版本、结果与异常。",
  "nature-figure": "生成、审查和改进符合论文规范的科研图表。",
  "nature-literature-pipeline": "从检索、筛选到证据综合的系统文献工作流。",
  "nature-paper2ppt": "把论文内容组织为学术汇报或答辩演示文稿。",
  "nature-paper-card": "把单篇论文提炼为结构化、可复用的文献卡片。",
  "nature-paper-to-patent": "将研究成果重构为专利交底书和申请材料草稿。",
  "nature-polishing": "学术中英文润色，改善准确性、逻辑、术语与行文。",
  researchwrite: "研究计划、基金申请和课题方案的结构化写作。",
  "nature-reader": "深度阅读论文，提取方法、证据、局限与可复现要点。",
  "nature-ref-verifier": "核验参考文献真实性、元数据、DOI 与引用对应关系。",
  "nature-response": "撰写逐条、可追溯且专业克制的审稿意见回复。",
  "nature-reviewer": "以同行评审视角系统检查论文的贡献、方法与证据。",
  "nature-statistics": "统计方法选择、假设检查、效应量和规范报告。",
  "nature-writing": "按科研论文结构进行证据驱动的学术写作。"
};

const NATURE_COMPATIBILITY_NOTES: Record<string, string> = {
  "nature-academic-search": "优先使用当前已连接的论文 MCP；上游自带检索服务及环境变量不会由 MathHub 自动启动或注入。",
  "nature-downloader": "仅可使用当前已连接且明确列出的外部工具；需要登录、浏览器扩展或上游终端脚本的下载步骤不可直接执行。",
  "nature-figure": "可通过工程内 Python 脚本生成图表；R、系统字体安装及上游终端命令不会直接执行。",
  "nature-paper2ppt": "可完成内容结构、讲稿和可执行生成脚本；最终 PPTX 取决于当前 Python 环境是否具备相应库。",
  "nature-paper-to-patent": "可生成内容草稿与通用文档；特定 Office 宏、Playwright 或专利模板自动化依赖不保证可用。"
};

const getNatureSkillDirectory = (modulePath: string) =>
  modulePath.match(/\/skills\/([^/]+)\/SKILL\.md$/)?.[1];

const parseNatureSkill = (modulePath: string, source: string): NatureSkill | undefined => {
  const directory = getNatureSkillDirectory(modulePath);
  if (!directory || directory === "nature-shared") return undefined;
  const frontmatter = source.match(/^---\s*\r?\n([\s\S]*?)\r?\n---\s*\r?\n?/);
  if (!frontmatter) throw new Error(`Nature 技能 ${directory} 缺少 YAML frontmatter。`);
  const name = parseFrontmatterField(frontmatter[1], "name")?.trim().toLowerCase();
  const originalDescription = parseFrontmatterField(frontmatter[1], "description")?.trim();
  if (!name || !originalDescription) throw new Error(`Nature 技能 ${directory} 缺少 name 或 description。`);
  return {
    name,
    description: NATURE_SKILL_SUMMARIES[name] || originalDescription,
    instructions: source.slice(frontmatter[0].length).trim(),
    aliases: directory === name ? [] : [directory],
    resourceRoot: directory,
    compatibilityNote: NATURE_COMPATIBILITY_NOTES[name]
  };
};

export const NATURE_SKILLS = Object.entries(natureSkillSources)
  .map(([modulePath, source]) => parseNatureSkill(modulePath, source))
  .filter((skill): skill is NatureSkill => Boolean(skill))
  .sort((left, right) => left.name.localeCompare(right.name));

export const getNatureSkill = (name: string) => {
  const normalized = name.trim().toLowerCase().replace(/^\$/, "");
  return NATURE_SKILLS.find(skill =>
    skill.name === normalized || skill.aliases.includes(normalized)
  );
};

const NATURE_RESOURCE_PREFIX = "./nature-skills-main/skills/";
const MAX_SKILL_RESOURCE_CHARS = 24_000;

export const listNatureSkillResources = (name: string) => {
  const skill = getNatureSkill(name);
  if (!skill) throw new Error(`未找到 Nature 技能：${name || "[空]"}`);
  const prefix = `${NATURE_RESOURCE_PREFIX}${skill.resourceRoot}/`;
  return Object.keys(natureResourceModules)
    .filter(modulePath => modulePath.startsWith(prefix) && !modulePath.endsWith("/SKILL.md"))
    .map(modulePath => modulePath.slice(prefix.length))
    .sort((left, right) => left.localeCompare(right));
};

const resolveNatureResource = (skill: NatureSkill, requestedPath: string) => {
  const path = requestedPath.trim().replace(/\\/g, "/").replace(/^\.\//, "");
  if (!path) throw new Error("资源路径不能为空。");
  const normalized: string[] = [];
  for (const segment of [skill.resourceRoot, ...path.split("/")]) {
    if (!segment || segment === ".") continue;
    if (segment === "..") {
      if (normalized.length === 0) throw new Error("资源路径超出 Nature Skills 目录。");
      normalized.pop();
    } else {
      normalized.push(segment);
    }
  }
  const relativePath = normalized.join("/");
  const loader = natureResourceModules[`${NATURE_RESOURCE_PREFIX}${relativePath}`];
  if (!loader) throw new Error(`未找到技能资源：${requestedPath}`);
  return { loader, relativePath };
};

export const loadNatureSkillResource = async (
  name: string,
  path: string,
  offset = 0,
  limit = MAX_SKILL_RESOURCE_CHARS
) => {
  const skill = getNatureSkill(name);
  if (!skill) throw new Error(`未找到 Nature 技能：${name || "[空]"}`);
  const safeOffset = Math.max(0, Math.floor(Number.isFinite(offset) ? offset : 0));
  const safeLimit = Math.min(
    MAX_SKILL_RESOURCE_CHARS,
    Math.max(1_000, Math.floor(Number.isFinite(limit) ? limit : MAX_SKILL_RESOURCE_CHARS))
  );
  const { loader, relativePath } = resolveNatureResource(skill, path);
  const content = await loader();
  const slice = content.slice(safeOffset, safeOffset + safeLimit);
  const nextOffset = safeOffset + slice.length < content.length ? safeOffset + slice.length : undefined;
  return {
    skill: skill.name,
    path: relativePath,
    content: slice,
    totalChars: content.length,
    offset: safeOffset,
    nextOffset,
    truncated: nextOffset !== undefined
  };
};
