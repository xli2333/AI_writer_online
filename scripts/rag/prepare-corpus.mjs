import fs from "node:fs/promises";
import path from "node:path";
import { Type } from "@google/genai";
import {
  DEFAULT_MODEL,
  METADATA_DIR,
  RAW_DIR,
  ensureDir,
  generateJson,
  initRagDirs,
  listArticleFiles,
  parseArgs,
  parseArticlePath,
  readUtf8,
  toCsv,
  writeJson,
  writeUtf8,
} from "./shared.mjs";

const CANDIDATE_PATTERN =
  /活动预告|直播预告|预告|报名|讲座|论坛|沙龙|公开课|课程预告|招生|宣讲|工作坊|直播进行中|报名通道|火热报名/;

const KEEP_PATTERN = /回顾|笔记|纪要|复盘|实录|总结|观察|对话|专访|案例|翻书日签|书评/;

const CLASSIFY_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    delete_as_activity_notice: { type: Type.BOOLEAN },
    confidence: { type: Type.NUMBER },
    category: { type: Type.STRING },
    reason: { type: Type.STRING },
  },
  required: ["delete_as_activity_notice", "confidence", "category", "reason"],
};

function isCandidate(title) {
  return CANDIDATE_PATTERN.test(title);
}

async function classifyCandidate(filePath) {
  const article = parseArticlePath(filePath);
  const content = (await readUtf8(filePath)).slice(0, 1800);
  const title = article.title;

  if (!isCandidate(title)) {
    return {
      delete_as_activity_notice: false,
      confidence: 1,
      category: "normal_article",
      reason: "标题未命中活动通知关键词。",
    };
  }

  if (KEEP_PATTERN.test(title)) {
    return {
      delete_as_activity_notice: false,
      confidence: 0.98,
      category: "activity_review_or_notes",
      reason: "标题包含回顾或笔记等关键词，保留为内容文章。",
    };
  }

  return generateJson({
    model: DEFAULT_MODEL,
    schema: CLASSIFY_SCHEMA,
    systemInstruction:
      "你是中文内容清洗助手。你的任务是判断一篇文章是否属于活动通知、活动预告、直播预告、报名邀请、工作坊宣传等低长期参考价值文本。如果主要作用是通知活动时间、地点、报名、直播入口、宣传引流，则 delete_as_activity_notice 设为 true。若是活动回顾、论坛笔记、内容纪要、方法总结、案例复盘，则必须设为 false。只返回 JSON。",
    contents: [
      {
        role: "user",
        parts: [
          {
            text: `请判断是否删除。\n标题：${title}\n正文节选：\n${content}`,
          },
        ],
      },
    ],
  });
}

async function buildCatalog() {
  const files = await listArticleFiles();
  const rows = [];
  for (const filePath of files) {
    const article = parseArticlePath(filePath);
    const content = await readUtf8(filePath);
    rows.push({
      id: article.id,
      year: article.year,
      date: article.date,
      title: article.title,
      relative_path: article.relativePath,
      char_count: content.length,
      line_count: content.split("\n").length,
    });
  }
  const csv = toCsv(rows, ["id", "year", "date", "title", "relative_path", "char_count", "line_count"]);
  await writeUtf8(path.join(METADATA_DIR, "article_catalog.csv"), csv);
  return rows;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const apply = Boolean(args.apply);

  await initRagDirs();

  const files = await listArticleFiles();
  const candidates = files.map(parseArticlePath).filter((article) => isCandidate(article.title));

  const report = [];
  for (const candidate of candidates) {
    const decision = await classifyCandidate(candidate.filePath);
    report.push({
      id: candidate.id,
      year: candidate.year,
      title: candidate.title,
      relative_path: candidate.relativePath,
      delete_as_activity_notice: decision.delete_as_activity_notice,
      confidence: Number(decision.confidence || 0),
      category: decision.category,
      reason: decision.reason,
    });
  }

  const deleteTargets = report.filter((item) => item.delete_as_activity_notice && item.confidence >= 0.7);
  if (apply) {
    for (const item of deleteTargets) {
      await fs.unlink(path.join(RAW_DIR, item.relative_path));
    }
  }

  await ensureDir(METADATA_DIR);
  await writeJson(path.join(METADATA_DIR, "activity_cleanup_report.json"), report);
  await writeUtf8(
    path.join(METADATA_DIR, "deleted_activity_articles.csv"),
    toCsv(deleteTargets, [
      "id",
      "year",
      "title",
      "relative_path",
      "delete_as_activity_notice",
      "confidence",
      "category",
      "reason",
    ])
  );

  const catalog = await buildCatalog();
  const summary = {
    model: DEFAULT_MODEL,
    scanned_candidates: candidates.length,
    deleted_count: deleteTargets.length,
    catalog_count: catalog.length,
    apply,
  };
  await writeJson(path.join(METADATA_DIR, "prepare_summary.json"), summary);

  console.log(JSON.stringify(summary, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
