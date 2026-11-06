import frameContestProblem from "./frame-contest-problem/SKILL.md?raw";
import analyzeMcmProblem from "./analyze-mcm-problem/SKILL.md?raw";
import runMcmContest from "./run-mcm-contest/SKILL.md?raw";
import mcmFigureGuide from "./mcm-figure-guide/SKILL.md?raw";
import mcmModelingGuide from "./mcm-modeling-guide/SKILL.md?raw";
import auditModelingData from "./audit-modeling-data/SKILL.md?raw";
import exploreModelingData from "./explore-modeling-data/SKILL.md?raw";
import designMathematicalModel from "./design-mathematical-model/SKILL.md?raw";
import solveOptimizationModel from "./solve-optimization-model/SKILL.md?raw";
import forecastTimeSeries from "./forecast-time-series/SKILL.md?raw";
import simulateUncertainty from "./simulate-uncertainty/SKILL.md?raw";
import validateModelRobustness from "./validate-model-robustness/SKILL.md?raw";
import visualizeModelResults from "./visualize-model-results/SKILL.md?raw";
import writeHiMcmPaper from "./write-himcm-paper/SKILL.md?raw";
import writeHiMcmPaperFormat from "./write-himcm-paper/references/16226-format.md?raw";
import writeMcmPaper from "./write-mcm-paper/SKILL.md?raw";
import writeMcmPaperFormat from "./write-mcm-paper/references/mcm-format.md?raw";
import writeMcmPaperScoringGuide from "./write-mcm-paper/references/mcm-scoring-guide.md?raw";
import writeChineseModelingPaper from "./write-chinese-modeling-paper/SKILL.md?raw";
import writeChineseModelingPaperFormat from "./write-chinese-modeling-paper/references/chinese-modeling-format.md?raw";
import {
  NATURE_SKILLS,
  getNatureSkill,
  listNatureSkillResources,
  loadNatureSkillResource
} from "./registry";

export type ModelingSkill = {
  name: string;
  description: string;
  instructions: string;
};

const parseSkill = (source: string): ModelingSkill => {
  const frontmatter = source.match(/^---\s*\n([\s\S]*?)\n---\s*\n?/);
  if (!frontmatter) throw new Error("建模技能缺少 YAML frontmatter。");
  const name = frontmatter[1].match(/^name:\s*(.+)$/m)?.[1]?.trim();
  const description = frontmatter[1].match(/^description:\s*(.+)$/m)?.[1]?.trim();
  if (!name || !description) throw new Error("建模技能缺少 name 或 description。");
  return {
    name,
    description,
    instructions: source.slice(frontmatter[0].length).trim()
  };
};

const skillSources = [
  frameContestProblem,
  analyzeMcmProblem,
  runMcmContest,
  mcmFigureGuide,
  mcmModelingGuide,
  auditModelingData,
  exploreModelingData,
  designMathematicalModel,
  solveOptimizationModel,
  forecastTimeSeries,
  simulateUncertainty,
  validateModelRobustness,
  visualizeModelResults,
  writeHiMcmPaper,
  writeMcmPaper,
  writeChineseModelingPaper
];

const skillFormatReferences: Record<string, string> = {
  "write-himcm-paper": writeHiMcmPaperFormat,
  "write-mcm-paper": `${writeMcmPaperFormat}\n\n---\n\n${writeMcmPaperScoringGuide}`,
  "write-chinese-modeling-paper": writeChineseModelingPaperFormat
};

export const MODELING_SKILLS = skillSources.map(parseSkill).map(skill => {
  const formatReference = skillFormatReferences[skill.name];
  return formatReference
    ? { ...skill, instructions: `${skill.instructions}\n\n---\n\n${formatReference.trim()}` }
    : skill;
});

export const MODELING_SKILLS_CATALOG = MODELING_SKILLS
  .map(skill => `- ${skill.name}: ${skill.description}`)
  .join("\n");

const NATURE_SKILLS_CATALOG = NATURE_SKILLS
  .map(skill => {
    const alias = skill.aliases.length > 0 ? `（别名：${skill.aliases.join("、")}）` : "";
    return `- ${skill.name}${alias}: ${skill.description}`;
  })
  .join("\n");

export const AGENT_SKILLS_CATALOG = [
  "【数学建模】",
  MODELING_SKILLS_CATALOG,
  "",
  "【Nature 科研工作流】",
  NATURE_SKILLS_CATALOG
].join("\n");

export const getModelingSkill = (name: string) => {
  const normalized = name.trim().toLowerCase().replace(/^\$/, "");
  return MODELING_SKILLS.find(skill => skill.name === normalized);
};

export const getAgentSkill = (name: string) => getModelingSkill(name) || getNatureSkill(name);

export { NATURE_SKILLS, listNatureSkillResources, loadNatureSkillResource };
