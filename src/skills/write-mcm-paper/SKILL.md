---
name: write-mcm-paper
description: "Use only when the user explicitly requests a Mathematical Contest in Modeling (MCM) / American college mathematical modeling contest paper, or an MCM-format DOCX/PDF. Create an English, evidence-based MCM submission from the contest problem, verified calculations, and project result figures. Do not use for HiMCM, generic reports, or other modeling contests."
---

# MCM Paper Export

Read `references/mcm-format.md` before drafting. For an HPC-energy problem, also read `references/hpc-data-source-table.md`. Treat these as mandatory production rules, not suggestions.

## Workflow

1. Read the contest PDF, the successful Python scripts, numerical outputs, and every figure that will be cited. Do not invent results, sources, figures, or citations.
2. Build a Task/requirement → method → result → figure/table map. Finish computation before writing the paper.
3. Draft one complete English Markdown manuscript. Use real Markdown headings, `$...$` for inline math, `$$...$$` for display math, tables, `[PAGEBREAK]`, `[TOC]`, and project-relative figure paths.
4. Export the **same Markdown** through both `create_word_document` (`document_type: "modeling_paper", paper_format: "mcm"`) and `create_pdf_document` (`paper_format: "mcm"`). Never claim an export succeeded until both tools report success.
5. Inspect the output checklist below. If a required item is absent, correct the Markdown and re-export.

## Non-negotiable page and manuscript rules

- Produce English prose unless the user explicitly requests otherwise. Match the requested page count with substantive analysis; never pad with empty space, repeated statements, or invented evidence.
- Use US Letter paper (8.5 × 11 in), single-column body text with **2.54 cm margins on every side**. Generate **no header and no footer**, including no team number, page number, date, or running title.
- The first page contains only: centered paper title, centered `Summary`, the required summary paragraphs, and `Keywords:`. Do not add `Summary Sheet`, contest metadata, team-number boxes, tables, or other decoration.
- Put `[PAGEBREAK]` after keywords, then `[TOC]`, then another `[PAGEBREAK]` before `# 1 Introduction`. Keep the TOC compact enough for one page: 0 pt before/after each entry and single line spacing.
- Use numbered section headings: `# 1 Introduction`, `## 1.1 Problem Background`, and so on. Use paragraphs for the Task I through final Task solutions; avoid bullet/number lists in those solution sections.

## First-page Summary

Write a compact, result-led summary in this exact order.

1. Open with one sentence of background, one sentence stating the concrete problem, and one sentence stating the paper's overall work.
2. Write one paragraph per contest task, beginning exactly `For Task I,`, `For Task II,`, and so on. State the method, the verified result, and its implication. Use only real quantities from the completed project.
3. End with one concluding paragraph that synthesizes the recommendation or main finding.
4. Finish with `Keywords:`. Do not use bullet points on the summary page.

## Required body structure and depth

Use this order unless the contest prompt makes a section inapplicable:

1. `# 1 Introduction`
   - `## 1.1 Problem Background`: about 200 English words in two paragraphs; cite at least five **verifiable** references in this subsection.
   - `## 1.2 Literature Review`: about 300 English words; cite at least ten **verifiable** references in this subsection. Synthesize what prior work does and does not solve; do not create fake citations.
   - `## 1.3 Problem Restatement`: use one numbered item per contest task/question; state the concrete deliverable of each task.
2. `# 2 Assumptions and Justifications`: do **not** create `2.1`, `2.2`, or other subheadings. Write consecutive bold opening lines in this exact form: `**1. Assumption 1: <claim>**`, followed by its explanatory paragraph, then `**2. Assumption 2: <claim>**`, and so on. Each paragraph must explain reasonableness, what it enables, and likely limitation. For an applicable HPC-energy problem, use the supplied linear-load, stable-energy-mix, constant-efficiency, and energy-specific-carbon-factor pattern.
3. `# 3 Model Preparation`, including `## 3.1 Notations` and `## 3.2 The Data`. In 3.2, place a centered `Table n. Data Sources` caption immediately above the two-column `Data | Source` table. Use the supplied HPC data-source table only for an applicable HPC problem and verify sources before citing them.
4. `# 4 Task I Solution` through the final task. Explain each task in connected paragraphs: objective, variables, model, solution, verified result, interpretation, and a direct answer to that task. Do not turn this part into a tutorial-style list.
5. Sensitivity analysis or validation appropriate to the problem.
6. `# 10 Evaluation of the Model` (renumber to fit the actual outline) with `## Strengths` and `## Weaknesses`. Each item must state a named property followed by a specific justification; use the provided comprehensiveness/dynamic/predictability/environmental-impact/policy pattern only when those claims are supported by this model.
7. `# 11 Conclusion` (renumber to fit the actual outline): about 300 English words in exactly two connected paragraphs. State task-level findings, limitations, and recommendations; do not use lists.
8. `# References`, then `# Appendix`. The Appendix contains only reproducible source code in code fences—no narrative, tables, or results.

## Tables, figures, and formulas

- Give every table a consecutive caption in the form `Table 1. <title>` through `Table n. <title>`. Place the caption immediately **above** the Markdown table. In the paragraph immediately before or after each table, explicitly introduce its purpose with wording such as `As shown in Table 2, ...`. The exporter centers table captions and tables, uses bold 10-pt Palatino, centers all cells, removes first-line indentation, and renders `$...$` cell math as Word math.
- Give every image a consecutive caption in the form `Figure. 1 <title>` through `Figure. n <title>`, in the image alt text: `![Figure. 1 <title>](results/plot.png)`. Cite the figure in nearby body prose. The exporter places the bold 10-pt Palatino caption centered below the image.
- Every display equation must use `$$...$$`, be numbered by the exporter, and be followed immediately by an unindented paragraph beginning lowercase `where ...` that defines every variable, unit/range where relevant, and the equation's role in the current task. Use mathematical notation rather than ASCII approximations; the exporter renders Word formulas as editable OMML and uses italic math styling.
- Use only project figures that were actually generated. Do not add a missing-image placeholder to the final paper.

## References and final checks

- Number references as `[1]Author, ... Title [J]. Journal, year, issue: pages.` for journal articles and use an equivalent complete, traceable format for reports or web datasets. Use cited, verifiable works only. Do not indent any reference entry.
- Before delivery confirm: US Letter paper (8.5 × 11 in), 2.54 cm margins on all four sides; no header/footer; title + Summary-only first page; background/literature citation counts; Task prose is paragraph-based; every table/figure has a consecutive caption; every display equation has a following `where` paragraph; conclusion has two paragraphs; and Appendix contains code only.
- Report only the generated `.docx` and `.pdf` paths and a concise outcome summary to the user.
