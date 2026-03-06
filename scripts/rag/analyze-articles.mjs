import path from "node:path";
import fs from "node:fs/promises";
import {
  ARTICLE_ANALYSIS_SCHEMA,
  DEFAULT_MODEL,
  METADATA_DIR,
  getGeminiApiKeys,
  getSummaryPath,
  initRagDirs,
  listArticleFiles,
  parseArgs,
  parseArticlePath,
  readUtf8,
  rebuildArticleTagsJsonl,
  writeJson,
} from "./shared.mjs";
import { generateJson } from "./shared.mjs";

function buildPrompt(article, content) {
  return [
    {
      role: "user",
      parts: [
        {
          text: [
            "请对下面这篇中文文章做结构化写作分析。",
            "要求：",
            "1. 所有字段都必须基于原文，不要杜撰。",
            "2. industry/topic/style/audience/intent/tone 可以多选，但要克制。",
            "3. genre 用一个最贴切的中文标签。",
            "4. quality_score 与 reference_value_score 范围均为 0 到 100。",
            "5. 若文章信息密度很低或只是图片说明、活动邀请，请如实标记。",
            `标题：${article.title}`,
            `日期：${article.date || "未知"}`,
            "正文：",
            content.slice(0, 12000),
          ].join("\n"),
        },
      ],
    },
  ];
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const limit = Number(args.limit || 0);
  const yearFilter = args.year ? String(args.year) : "";
  const force = Boolean(args.force);
  const concurrency = Math.max(1, Number(args.concurrency || 1));
  const shardCount = Math.max(1, Number(args["shard-count"] || 1));
  const shardIndex = Math.max(0, Number(args["shard-index"] || 0));

  await initRagDirs();
  const apiKeys = getGeminiApiKeys();
  if (!apiKeys.length) {
    throw new Error("缺少 GEMINI_API_KEY 或 GEMINI_API_KEYS。");
  }
  const failureLogPath = path.join(METADATA_DIR, "analyze_failures.jsonl");

  let files = await listArticleFiles();
  if (yearFilter) {
    files = files.filter((filePath) => parseArticlePath(filePath).year === yearFilter);
  }
  if (shardCount > 1) {
    files = files.filter((filePath) => {
      const article = parseArticlePath(filePath);
      const hash = Number.parseInt(article.id.slice(0, 6), 16);
      return hash % shardCount === shardIndex;
    });
  }

  const targets = [];
  for (const filePath of files) {
    const article = parseArticlePath(filePath);
    const summaryPath = getSummaryPath(article.id, article.year);
    if (!force) {
      try {
        await readUtf8(summaryPath);
        continue;
      } catch {
        // continue to analyze
      }
    }
    targets.push(article);
    if (limit && targets.length >= limit) {
      break;
    }
  }

  let completed = 0;
  let failed = 0;
  let cursor = 0;

  async function worker(workerIndex) {
    const apiKey = apiKeys[workerIndex % apiKeys.length];
    while (cursor < targets.length) {
      const article = targets[cursor];
      cursor += 1;
      if (!article) {
        return;
      }
      const content = await readUtf8(article.filePath);
      try {
        const analysis = await generateJson({
          model: DEFAULT_MODEL,
          schema: ARTICLE_ANALYSIS_SCHEMA,
          systemInstruction:
            "你是中文商业内容分析师。你的任务不是续写，而是把文章转为可检索、可推荐、可用于 RAG 写作的结构化数据。请用简体中文输出 JSON。分数字段必须是数字。对于明显低价值、信息过短或仅有通知作用的文章，要如实降低分数并标记。",
          contents: buildPrompt(article, content),
          apiKey,
        });

        const output = {
          id: article.id,
          year: article.year,
          date: article.date,
          title: article.title,
          relative_path: article.relativePath,
          full_text_path: article.filePath,
          char_count: content.length,
          ...analysis,
        };
        await writeJson(getSummaryPath(article.id, article.year), output);
        completed += 1;
        console.log(`worker=${workerIndex + 1} analyzed ${completed}/${targets.length}: ${article.relativePath}`);
      } catch (error) {
        failed += 1;
        const failureRecord = {
          worker: workerIndex + 1,
          id: article.id,
          relative_path: article.relativePath,
          error: error instanceof Error ? error.message : String(error),
          timestamp: new Date().toISOString(),
        };
        await fs.appendFile(failureLogPath, `${JSON.stringify(failureRecord)}\n`, "utf8");
        console.error(`worker=${workerIndex + 1} failed ${article.relativePath}`);
      }
    }
  }

  await Promise.all(Array.from({ length: concurrency }, (_, index) => worker(index)));

  const tags = await rebuildArticleTagsJsonl();
  await writeJson(path.join(METADATA_DIR, "analyze_summary.json"), {
    model: DEFAULT_MODEL,
    processed_in_this_run: completed,
    total_indexed_articles: tags.length,
    failed_in_this_run: failed,
    year_filter: yearFilter || null,
    force,
    concurrency,
    api_key_count: apiKeys.length,
    shard_count: shardCount,
    shard_index: shardCount > 1 ? shardIndex : null,
  });
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
