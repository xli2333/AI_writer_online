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

const ANALYSIS_SCHEMA_VERSION = 3;
const UPGRADE_FIELDS = [
  "advertorial_type",
  "promotional_intensity_score",
  "editorial_independence_score",
  "brand_exposure_level",
  "source_transparency",
];

const PERCENT_FIELDS = [
  "evidence_specificity_score",
  "data_density_score",
  "case_density_score",
  "quote_density_score",
  "title_score",
  "opening_score",
  "argument_score",
  "evidence_score",
  "structure_score",
  "style_score",
  "publishability_score",
  "quality_score",
  "reference_value_score",
  "advertorial_confidence",
  "promotional_intensity_score",
  "editorial_independence_score",
];

const normalizePercentValue = (value) => {
  const numeric = Number(value || 0);
  if (!Number.isFinite(numeric)) {
    return 0;
  }
  const normalized = numeric > 0 && numeric <= 1 ? numeric * 100 : numeric;
  return Math.max(0, Math.min(100, Number(normalized.toFixed(2))));
};

const normalizeStringArray = (value) =>
  Array.isArray(value)
    ? value.map((item) => String(item || "").trim()).filter(Boolean)
    : [];

function normalizeAnalysis(analysis) {
  const output = {
    ...analysis,
    entities: normalizeStringArray(analysis.entities),
    industry: normalizeStringArray(analysis.industry),
    topic: normalizeStringArray(analysis.topic),
    style: normalizeStringArray(analysis.style),
    audience: normalizeStringArray(analysis.audience),
    intent: normalizeStringArray(analysis.intent),
    tone: normalizeStringArray(analysis.tone),
    section_functions: normalizeStringArray(analysis.section_functions),
    argument_moves: normalizeStringArray(analysis.argument_moves),
    key_points: normalizeStringArray(analysis.key_points),
    evidence_types: normalizeStringArray(analysis.evidence_types),
    transferable_moves: normalizeStringArray(analysis.transferable_moves),
    anti_patterns: normalizeStringArray(analysis.anti_patterns),
    notable_phrases: normalizeStringArray(analysis.notable_phrases),
    advertorial_signals: normalizeStringArray(analysis.advertorial_signals),
    is_activity_notice: Boolean(analysis.is_activity_notice),
    is_low_value: Boolean(analysis.is_low_value),
    is_advertorial: Boolean(analysis.is_advertorial),
    advertorial_type: String(analysis.advertorial_type || "").trim(),
    brand_exposure_level: String(analysis.brand_exposure_level || "").trim(),
    source_transparency: String(analysis.source_transparency || "").trim(),
  };

  for (const field of PERCENT_FIELDS) {
    output[field] = normalizePercentValue(output[field]);
  }

  return output;
}

function isSummaryUpToDate(existingSummary) {
  if (!existingSummary || typeof existingSummary !== "object") {
    return false;
  }

  const schemaVersion = Number(existingSummary.analysis_schema_version || 0);
  if (schemaVersion >= ANALYSIS_SCHEMA_VERSION) {
    return true;
  }

  return UPGRADE_FIELDS.every((field) => Object.prototype.hasOwnProperty.call(existingSummary, field));
}

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
            "3. genre 与 content_type 都只填一个最贴切的中文标签。",
            "4. 必须补足写作机制字段：primary_question、thesis_type、thesis_sentence、section_functions、argument_moves、evidence_types、transferable_moves、anti_patterns。",
            "5. 所有 *_score 字段范围均为 0 到 100，必须是数字。",
            "6. 评分要区分 quality_score、reference_value_score 以及 title/opening/argument/evidence/structure/style/publishability 等分项。",
            "7. 若文章信息密度很低、只有通知作用、缺乏完整成文价值，请如实降低分数并标记。",
            "8. entities 至少提取出文中最关键的公司、品牌、人物或组织名称。",
            "9. 必须识别广告软文、品牌合作稿、招商宣传稿、产品背书稿。如果文章主要服务于品牌宣传、合作传播、产品背书或商业导流，即使包装成采访或报道，也要将 is_advertorial 设为 true，并写出 advertorial_signals。",
            "10. advertorial_type 必须尽量细分，可用标签包括：editorial、brand_cooperation、product_seeding、event_promotion、executive_pr、investment_promotion、mixed。",
            "11. promotional_intensity_score 表示推广/公关意图强度，0 到 100；editorial_independence_score 表示编辑独立性，0 到 100。",
            "12. brand_exposure_level 用 低/中/高；source_transparency 用 清晰/混合/模糊。",
            `标题：${article.title}`,
            `日期：${article.date || "未知"}`,
            "正文：",
            content.slice(0, 16000),
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
        const existing = JSON.parse(await readUtf8(summaryPath));
        if (isSummaryUpToDate(existing)) {
          continue;
        }
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
            "你是中文商业内容分析师。你的任务不是续写，而是把文章转为可检索、可推荐、可用于 RAG 写作和人格提炼的结构化数据。请用简体中文输出 JSON。必须同时提取主题标签、写作机制、证据特征、可迁移动作、禁学反模式、关键实体、广告软文风险和分项评分。分数字段必须是数字。对于明显低价值、信息过短、仅有通知作用或明显偏品牌宣传的文章，要如实降低分数并标记。",
          contents: buildPrompt(article, content),
          apiKey,
        });

        const output = {
          analysis_schema_version: ANALYSIS_SCHEMA_VERSION,
          id: article.id,
          year: article.year,
          date: article.date,
          title: article.title,
          relative_path: article.relativePath,
          full_text_path: article.filePath,
          char_count: content.length,
          ...normalizeAnalysis(analysis),
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
