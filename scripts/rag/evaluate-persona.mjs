import fs from "node:fs/promises";
import path from "node:path";
import { Type } from "@google/genai";
import {
  DEFAULT_MODEL,
  GLOBAL_DIR,
  RAG_DIR,
  buildSearchDocument,
  computeStylePurityScore,
  countOverlapScore,
  ensureDir,
  extractTokens,
  initRagDirs,
  isStylePureEnough,
  loadArticleSummaries,
  normalizeText,
  readUtf8,
  writeJson,
} from "./shared.mjs";
import { generateJson, generateText } from "./shared.mjs";

const BENCHMARK_DIR = path.join(RAG_DIR, "evals", "benchmark_tasks");
const REPORT_DIR = path.join(RAG_DIR, "evals", "reports");
const MASTER_PERSONA_PATH = path.join(GLOBAL_DIR, "runtime", "master_persona.md");
const LATEST_PATCH_PATH = path.join(RAG_DIR, "persona", "latest_patch.md");

const JUDGE_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    winner: { type: Type.STRING },
    reasoning: { type: Type.STRING },
    scores: {
      type: Type.OBJECT,
      properties: {
        base: {
          type: Type.OBJECT,
          properties: {
            argument: { type: Type.NUMBER },
            structure: { type: Type.NUMBER },
            evidence: { type: Type.NUMBER },
            style: { type: Type.NUMBER },
            publishability: { type: Type.NUMBER },
          },
          required: ["argument", "structure", "evidence", "style", "publishability"],
        },
        patch: {
          type: Type.OBJECT,
          properties: {
            argument: { type: Type.NUMBER },
            structure: { type: Type.NUMBER },
            evidence: { type: Type.NUMBER },
            style: { type: Type.NUMBER },
            publishability: { type: Type.NUMBER },
          },
          required: ["argument", "structure", "evidence", "style", "publishability"],
        },
      },
      required: ["base", "patch"],
    },
  },
  required: ["winner", "reasoning", "scores"],
};

function scoreArticleForTask(taskText, article) {
  const taskTokens = extractTokens(taskText);
  const titleTokens = extractTokens(article.title);
  const docTokens = extractTokens(buildSearchDocument(article));
  const lexical = countOverlapScore(taskTokens, docTokens);
  const titleHit = countOverlapScore(taskTokens, titleTokens);
  const quality = Number(article.quality_score || 0) / 100;
  const reference = Number(article.reference_value_score || 0) / 100;
  const purity = computeStylePurityScore(article);
  return lexical * 0.46 + titleHit * 0.18 + quality * 0.12 + reference * 0.1 + purity * 0.14;
}

async function loadBenchmarkTasks() {
  const entries = await fs.readdir(BENCHMARK_DIR, { withFileTypes: true });
  const files = entries.filter((entry) => entry.isFile() && entry.name.endsWith(".md")).map((entry) => entry.name).sort();
  const tasks = [];
  for (const fileName of files) {
    const filePath = path.join(BENCHMARK_DIR, fileName);
    tasks.push({
      id: path.basename(fileName, ".md"),
      fileName,
      text: await readUtf8(filePath),
    });
  }
  return tasks;
}

function selectReferences(taskText, articles, limit = 3) {
  return [...articles]
    .filter((article) => isStylePureEnough(article))
    .map((article) => ({
      article,
      score: scoreArticleForTask(taskText, article),
    }))
    .sort((left, right) => right.score - left.score)
    .slice(0, limit)
    .map(({ article }) => ({
      id: article.id,
      title: article.title,
      genre: article.genre,
      topic: article.topic,
      structure_pattern: article.structure_pattern,
      opening_pattern: article.opening_pattern,
      ending_pattern: article.ending_pattern,
      thesis_sentence: article.thesis_sentence,
      transferable_moves: article.transferable_moves,
      anti_patterns: article.anti_patterns,
      evidence_types: article.evidence_types,
      summary_200: article.summary_200,
    }));
}

async function generateArticleWithPersona(personaMarkdown, taskText, references) {
  const prompt = [
    "你现在要完成一篇中文商业文章写作任务。",
    "任务描述：",
    taskText,
    "参考写作基因：",
    JSON.stringify(references, null, 2),
    "输出要求：",
    "1. 直接输出文章正文。",
    "2. 标题和正文都要完整。",
    "3. 如果任务里给了字数约束，以任务本身为准；如果没有，就按内容自然展开。",
    "4. 不要解释写作过程。",
  ].join("\n\n");

  return generateText({
    model: DEFAULT_MODEL,
    systemInstruction: personaMarkdown,
    contents: [
      {
        role: "user",
        parts: [{ text: prompt }],
      },
    ],
  });
}

async function judgePair(taskText, baseArticle, patchArticle) {
  return generateJson({
    model: DEFAULT_MODEL,
    schema: JUDGE_SCHEMA,
    systemInstruction:
      "你是商业中文稿件的严苛终审编辑。请只比较两篇候选稿在立论、结构、证据、风格和可发布性上的优劣，不要因为措辞华丽而误判。winner 只能是 base、patch 或 tie。输出 JSON。",
    contents: [
      {
        role: "user",
        parts: [
          {
            text: `任务描述：\n${taskText}\n\n候选 A（base）：\n${baseArticle}\n\n候选 B（patch）：\n${patchArticle}`,
          },
        ],
      },
    ],
  });
}

async function main() {
  await initRagDirs();
  await ensureDir(REPORT_DIR);

  const basePersona = await readUtf8(MASTER_PERSONA_PATH);
  const patchPersona = await readUtf8(LATEST_PATCH_PATH);
  const articles = await loadArticleSummaries();
  const tasks = await loadBenchmarkTasks();
  if (!tasks.length) {
    throw new Error("缺少 benchmark_tasks，请先准备评测任务。");
  }

  const results = [];
  for (const task of tasks) {
    const references = selectReferences(task.text, articles);
    const baseArticle = await generateArticleWithPersona(basePersona, task.text, references);
    const patchArticle = await generateArticleWithPersona(patchPersona, task.text, references);
    const judgment = await judgePair(task.text, baseArticle, patchArticle);
    results.push({
      task_id: task.id,
      references,
      baseArticle,
      patchArticle,
      judgment,
    });
  }

  const summary = results.reduce(
    (acc, item) => {
      const winner = String(item.judgment.winner || "tie");
      if (winner === "patch") acc.patch_wins += 1;
      else if (winner === "base") acc.base_wins += 1;
      else acc.ties += 1;
      return acc;
    },
    { base_wins: 0, patch_wins: 0, ties: 0 }
  );
  const total = results.length;
  const patchWinRate = total > 0 ? summary.patch_wins / total : 0;
  const pass = patchWinRate >= 0.5 && summary.patch_wins >= summary.base_wins;

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  await writeJson(path.join(REPORT_DIR, `persona_eval.${stamp}.json`), {
    model: DEFAULT_MODEL,
    evaluated_at: new Date().toISOString(),
    total_tasks: total,
    patch_win_rate: Number(patchWinRate.toFixed(4)),
    pass,
    summary,
    results,
  });
  await writeJson(path.join(REPORT_DIR, "latest.json"), {
    model: DEFAULT_MODEL,
    evaluated_at: new Date().toISOString(),
    total_tasks: total,
    patch_win_rate: Number(patchWinRate.toFixed(4)),
    pass,
    summary,
  });
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
