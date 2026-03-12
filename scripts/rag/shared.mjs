import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { GoogleGenAI, Type } from "@google/genai";
import { ProxyAgent, setGlobalDispatcher } from "undici";
import { DEFAULT_STYLE_PROFILE_ID, getStyleProfile, resolveStyleProfileId } from "../../config/styleProfiles.js";

export const ROOT_DIR = process.cwd();

function readProfileArg() {
  for (let index = 0; index < process.argv.length; index += 1) {
    if (process.argv[index] === "--profile") {
      return process.argv[index + 1] || "";
    }
  }
  return "";
}

export const ACTIVE_PROFILE_ID = resolveStyleProfileId(
  process.env.RAG_PROFILE || process.env.STYLE_PROFILE || readProfileArg() || DEFAULT_STYLE_PROFILE_ID
);
export const ACTIVE_STYLE_PROFILE = getStyleProfile(ACTIVE_PROFILE_ID);
export const RAW_DIR = path.resolve(ROOT_DIR, ACTIVE_STYLE_PROFILE.rawDir);
export const RAG_DIR = path.resolve(ROOT_DIR, ACTIVE_STYLE_PROFILE.ragDir);
export const GLOBAL_DIR = path.resolve(ROOT_DIR, ACTIVE_STYLE_PROFILE.globalDir);
export const METADATA_DIR = path.resolve(ROOT_DIR, ACTIVE_STYLE_PROFILE.metadataDir);
export const SUMMARIES_DIR = path.resolve(ROOT_DIR, ACTIVE_STYLE_PROFILE.summariesDir);
export const CACHE_DIR = path.join(RAG_DIR, "cache", "current_task");
export const WORKFLOWS_DIR = path.join(RAG_DIR, "workflows");
export const PERSONA_DIR = path.resolve(ROOT_DIR, ACTIVE_STYLE_PROFILE.personaDir);
export const EVAL_DIR = path.resolve(ROOT_DIR, ACTIVE_STYLE_PROFILE.evalDir);
export const BENCHMARK_DIR = path.resolve(ROOT_DIR, ACTIVE_STYLE_PROFILE.benchmarkDir);

export const DEFAULT_MODEL =
  process.env.GEMINI_BUILD_MODEL || process.env.GEMINI_MODEL || "gemini-3-flash-preview";

const proxyUrl = process.env.HTTPS_PROXY || process.env.HTTP_PROXY || "";
if (proxyUrl) {
  setGlobalDispatcher(new ProxyAgent(proxyUrl));
}

export const ARTICLE_ANALYSIS_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    content_type: { type: Type.STRING },
    entities: { type: Type.ARRAY, items: { type: Type.STRING } },
    industry: { type: Type.ARRAY, items: { type: Type.STRING } },
    topic: { type: Type.ARRAY, items: { type: Type.STRING } },
    genre: { type: Type.STRING },
    style: { type: Type.ARRAY, items: { type: Type.STRING } },
    audience: { type: Type.ARRAY, items: { type: Type.STRING } },
    intent: { type: Type.ARRAY, items: { type: Type.STRING } },
    tone: { type: Type.ARRAY, items: { type: Type.STRING } },
    primary_question: { type: Type.STRING },
    thesis_type: { type: Type.STRING },
    thesis_sentence: { type: Type.STRING },
    structure_pattern: { type: Type.STRING },
    section_functions: { type: Type.ARRAY, items: { type: Type.STRING } },
    argument_moves: { type: Type.ARRAY, items: { type: Type.STRING } },
    core_argument: { type: Type.STRING },
    key_points: { type: Type.ARRAY, items: { type: Type.STRING } },
    opening_pattern: { type: Type.STRING },
    ending_pattern: { type: Type.STRING },
    evidence_types: { type: Type.ARRAY, items: { type: Type.STRING } },
    evidence_specificity_score: { type: Type.NUMBER },
    data_density_score: { type: Type.NUMBER },
    case_density_score: { type: Type.NUMBER },
    quote_density_score: { type: Type.NUMBER },
    narrative_distance: { type: Type.STRING },
    stance_strength: { type: Type.STRING },
    sentence_rhythm: { type: Type.STRING },
    abstraction_level: { type: Type.STRING },
    transferable_moves: { type: Type.ARRAY, items: { type: Type.STRING } },
    anti_patterns: { type: Type.ARRAY, items: { type: Type.STRING } },
    notable_phrases: { type: Type.ARRAY, items: { type: Type.STRING } },
    title_score: { type: Type.NUMBER },
    opening_score: { type: Type.NUMBER },
    argument_score: { type: Type.NUMBER },
    evidence_score: { type: Type.NUMBER },
    structure_score: { type: Type.NUMBER },
    style_score: { type: Type.NUMBER },
    publishability_score: { type: Type.NUMBER },
    quality_score: { type: Type.NUMBER },
    reference_value_score: { type: Type.NUMBER },
    is_activity_notice: { type: Type.BOOLEAN },
    is_low_value: { type: Type.BOOLEAN },
    is_advertorial: { type: Type.BOOLEAN },
    advertorial_type: { type: Type.STRING },
    advertorial_confidence: { type: Type.NUMBER },
    promotional_intensity_score: { type: Type.NUMBER },
    editorial_independence_score: { type: Type.NUMBER },
    brand_exposure_level: { type: Type.STRING },
    source_transparency: { type: Type.STRING },
    advertorial_signals: { type: Type.ARRAY, items: { type: Type.STRING } },
    summary_200: { type: Type.STRING },
    summary_500: { type: Type.STRING },
  },
  required: [
    "content_type",
    "entities",
    "industry",
    "topic",
    "genre",
    "style",
    "audience",
    "intent",
    "tone",
    "primary_question",
    "thesis_type",
    "thesis_sentence",
    "structure_pattern",
    "section_functions",
    "argument_moves",
    "core_argument",
    "key_points",
    "opening_pattern",
    "ending_pattern",
    "evidence_types",
    "evidence_specificity_score",
    "data_density_score",
    "case_density_score",
    "quote_density_score",
    "narrative_distance",
    "stance_strength",
    "sentence_rhythm",
    "abstraction_level",
    "transferable_moves",
    "anti_patterns",
    "notable_phrases",
    "title_score",
    "opening_score",
    "argument_score",
    "evidence_score",
    "structure_score",
    "style_score",
    "publishability_score",
    "quality_score",
    "reference_value_score",
    "is_activity_notice",
    "is_low_value",
    "is_advertorial",
    "advertorial_type",
    "advertorial_confidence",
    "promotional_intensity_score",
    "editorial_independence_score",
    "brand_exposure_level",
    "source_transparency",
    "advertorial_signals",
    "summary_200",
    "summary_500",
  ],
};

export function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) {
      continue;
    }
    const key = token.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) {
      args[key] = true;
      continue;
    }
    args[key] = next;
    index += 1;
  }
  return args;
}

export async function ensureDir(dirPath) {
  await fs.mkdir(dirPath, { recursive: true });
}

export async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

export async function readUtf8(filePath) {
  const text = await fs.readFile(filePath, "utf8");
  return text.replace(/^\uFEFF/, "");
}

export async function writeUtf8(filePath, content) {
  await ensureDir(path.dirname(filePath));
  await fs.writeFile(filePath, content, "utf8");
}

export async function writeJson(filePath, value) {
  await writeUtf8(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

export async function walkFiles(dirPath, extension = ".txt") {
  const entries = await fs.readdir(dirPath, { withFileTypes: true });
  const output = [];
  for (const entry of entries) {
    const fullPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      output.push(...(await walkFiles(fullPath, extension)));
      continue;
    }
    if (entry.isFile() && path.extname(entry.name).toLowerCase() === extension) {
      output.push(fullPath);
    }
  }
  return output;
}

export async function listArticleFiles() {
  return (await walkFiles(RAW_DIR, ".txt")).sort((left, right) => left.localeCompare(right, "zh-Hans-CN"));
}

export function parseArticlePath(filePath) {
  const relativePath = path.relative(RAW_DIR, filePath);
  const folderName = path.dirname(relativePath).split(path.sep)[0] || "";
  const baseName = path.basename(filePath, ".txt");
  const match = baseName.match(/^(\d{4}-\d{2}-\d{2})_(.+)$/);
  const date = match ? match[1] : "";
  const title = match ? match[2] : baseName;
  const year = date ? date.slice(0, 4) : folderName.slice(0, 4);
  const id = crypto.createHash("sha1").update(relativePath).digest("hex").slice(0, 12);
  return {
    id,
    year,
    date,
    title,
    baseName,
    filePath,
    relativePath: relativePath.replaceAll("\\", "/"),
  };
}

export function escapeCsvValue(value) {
  const stringValue = String(value ?? "");
  return `"${stringValue.replaceAll("\"", "\"\"")}"`;
}

export function toCsv(rows, headers) {
  const headerLine = headers.join(",");
  const body = rows.map((row) => headers.map((header) => escapeCsvValue(row[header])).join(","));
  return `${[headerLine, ...body].join("\n")}\n`;
}

export function normalizeText(value) {
  return String(value ?? "")
    .toLowerCase()
    .replace(/\r/g, "\n")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function pushCjkTokens(segment, sink) {
  for (let index = 0; index < segment.length; index += 1) {
    sink.push(segment[index]);
    if (index < segment.length - 1) {
      sink.push(segment.slice(index, index + 2));
    }
  }
}

export function extractTokens(input) {
  const normalized = normalizeText(input);
  if (!normalized) {
    return [];
  }
  const tokens = [];
  for (const segment of normalized.split(" ")) {
    if (!segment) {
      continue;
    }
    if (/^[a-z0-9_-]+$/i.test(segment)) {
      if (segment.length >= 2) {
        tokens.push(segment);
      }
      continue;
    }
    pushCjkTokens(segment, tokens);
  }
  return tokens;
}

export function countOverlapScore(queryTokens, docTokens) {
  if (!queryTokens.length || !docTokens.length) {
    return 0;
  }
  const docCounts = new Map();
  for (const token of docTokens) {
    docCounts.set(token, (docCounts.get(token) || 0) + 1);
  }
  let score = 0;
  for (const token of queryTokens) {
    const count = docCounts.get(token) || 0;
    if (count > 0) {
      score += 1 + Math.log2(count + 1);
    }
  }
  return score / Math.sqrt(queryTokens.length * docTokens.length);
}

export function buildSearchDocument(article) {
  return [
    article.title,
    article.summary_200,
    article.summary_500,
    article.content_type,
    article.brand_exposure_level,
    article.source_transparency,
    ...(article.entities || []),
    ...(article.industry || []),
    ...(article.topic || []),
    article.genre,
    ...(article.style || []),
    ...(article.audience || []),
    ...(article.intent || []),
    ...(article.tone || []),
    article.primary_question,
    article.thesis_type,
    article.thesis_sentence,
    article.structure_pattern,
    ...(article.section_functions || []),
    ...(article.argument_moves || []),
    article.core_argument,
    ...(article.key_points || []),
    ...(article.evidence_types || []),
    article.narrative_distance,
    article.stance_strength,
    article.sentence_rhythm,
    article.abstraction_level,
    ...(article.transferable_moves || []),
    ...(article.anti_patterns || []),
  ]
    .filter(Boolean)
    .join(" ");
}

export function normalizePercentScore(value) {
  const numeric = Number(value || 0);
  if (!Number.isFinite(numeric)) {
    return 0;
  }
  const normalized = numeric > 0 && numeric <= 1 ? numeric * 100 : numeric;
  return Math.max(0, Math.min(100, normalized));
}

function clamp01(value) {
  return Math.max(0, Math.min(1, value));
}

export function computeStylePurityScore(article, profileId = ACTIVE_PROFILE_ID) {
  const promotional = normalizePercentScore(article.promotional_intensity_score || article.advertorial_confidence) / 100;
  const advertorialRisk = normalizePercentScore(article.advertorial_confidence) / 100;
  const editorialIndependence =
    normalizePercentScore(
      article.editorial_independence_score ??
        Math.max(0, 100 - normalizePercentScore(article.advertorial_confidence || 0) * 0.75)
    ) / 100;
  const quality = normalizePercentScore(article.quality_score) / 100;
  const reference = normalizePercentScore(article.reference_value_score) / 100;
  const publishability = normalizePercentScore(article.publishability_score) / 100;
  const structure = normalizePercentScore(article.structure_score) / 100;
  const argument = normalizePercentScore(article.argument_score) / 100;
  const evidence = normalizePercentScore(article.evidence_score) / 100;
  const style = normalizePercentScore(article.style_score) / 100;
  let score = 0;

  if (profileId === "latepost") {
    score =
      editorialIndependence * 0.34 +
      evidence * 0.18 +
      structure * 0.16 +
      style * 0.1 +
      quality * 0.08 +
      publishability * 0.08 +
      reference * 0.06 -
      promotional * 0.18 -
      advertorialRisk * 0.12;

    if (typeof article.content_type === "string" && /深度|报道|专访|特写|调查/.test(article.content_type)) {
      score += 0.03;
    }
    if (typeof article.genre === "string" && /人物|行业评论|趋势/.test(article.genre)) {
      score += 0.02;
    }
    if (String(article.brand_exposure_level || "").includes("高")) {
      score -= 0.08;
    }
  } else if (profileId === "xinzhiyuan") {
    score =
      editorialIndependence * 0.22 +
      evidence * 0.18 +
      style * 0.15 +
      quality * 0.13 +
      reference * 0.11 +
      publishability * 0.09 +
      structure * 0.08 +
      argument * 0.08 -
      promotional * 0.18 -
      advertorialRisk * 0.12;

    if (typeof article.content_type === "string" && /论文|研究|评测|快讯|报道|专访/.test(article.content_type)) {
      score += 0.03;
    }
    if (typeof article.genre === "string" && /技术解读|论文|产品评测|人物|趋势/.test(article.genre)) {
      score += 0.02;
    }
    if (String(article.source_transparency || "").includes("清晰")) {
      score += 0.02;
    }
    if (String(article.brand_exposure_level || "").includes("高")) {
      score -= 0.06;
    }
  } else if (profileId === "huxiu") {
    score =
      editorialIndependence * 0.26 +
      structure * 0.16 +
      argument * 0.15 +
      evidence * 0.13 +
      style * 0.11 +
      quality * 0.09 +
      publishability * 0.06 +
      reference * 0.04 -
      promotional * 0.16 -
      advertorialRisk * 0.1;

    if (typeof article.content_type === "string" && /报道|评论|人物|专访|特写|观察/.test(article.content_type)) {
      score += 0.03;
    }
    if (typeof article.genre === "string" && /人物|公司|行业|趋势|消费|社会/.test(article.genre)) {
      score += 0.02;
    }
    if (typeof article.source_transparency === "string" && article.source_transparency.includes("清晰")) {
      score += 0.02;
    }
    if (typeof article.brand_exposure_level === "string" && article.brand_exposure_level.includes("高")) {
      score -= 0.06;
    }
  } else if (profileId === "wallstreetcn") {
    score =
      editorialIndependence * 0.28 +
      reference * 0.16 +
      evidence * 0.14 +
      structure * 0.12 +
      publishability * 0.11 +
      quality * 0.09 +
      argument * 0.07 +
      style * 0.05 -
      promotional * 0.17 -
      advertorialRisk * 0.11;

    if (typeof article.content_type === "string" && /解读|快讯|观察|图表|数据|报道|专访/.test(article.content_type)) {
      score += 0.03;
    }
    if (typeof article.genre === "string" && /宏观|市场|公司|行业|政策|策略|商品|科技/.test(article.genre)) {
      score += 0.02;
    }
    if (typeof article.source_transparency === "string" && article.source_transparency.includes("清晰")) {
      score += 0.02;
    }
    if (typeof article.brand_exposure_level === "string" && article.brand_exposure_level.includes("高")) {
      score -= 0.07;
    }
    if (typeof article.title === "string" && /一周重磅日程|一周财经日程|早餐FM|元旦周重磅日程/.test(article.title)) {
      score -= 0.1;
    }
    if (
      /见闻VIP|免费试读|大师课|课程|游学|训练营|报名|星标华尔街见闻/.test(
        `${article.title || ""}\n${article.summary_200 || ""}`
      )
    ) {
      score -= 0.16;
    }
  } else {
    score =
      argument * 0.22 +
      structure * 0.18 +
      evidence * 0.16 +
      style * 0.12 +
      quality * 0.12 +
      reference * 0.1 +
      publishability * 0.1 +
      editorialIndependence * 0.08 -
      promotional * 0.12 -
      advertorialRisk * 0.08;

    if (typeof article.abstraction_level === "string" && /中|高/.test(article.abstraction_level)) {
      score += 0.02;
    }
  }

  return clamp01(score);
}

export function isStylePureEnough(article, profileId = ACTIVE_PROFILE_ID) {
  if (article.is_activity_notice || article.is_low_value || article.is_advertorial) {
    return false;
  }

  const promotional = normalizePercentScore(article.promotional_intensity_score || article.advertorial_confidence) / 100;
  const editorialIndependence =
    normalizePercentScore(
      article.editorial_independence_score ??
        Math.max(0, 100 - normalizePercentScore(article.advertorial_confidence || 0) * 0.75)
    ) / 100;
  const purity = computeStylePurityScore(article, profileId);

  if (profileId === "latepost") {
    return purity >= 0.48 && promotional <= 0.72 && editorialIndependence >= 0.35;
  }

  if (profileId === "xinzhiyuan") {
    return purity >= 0.46 && promotional <= 0.74 && editorialIndependence >= 0.3;
  }

  if (profileId === "huxiu") {
    return purity >= 0.45 && promotional <= 0.72 && editorialIndependence >= 0.32;
  }

  if (profileId === "wallstreetcn") {
    return purity >= 0.44 && promotional <= 0.7 && editorialIndependence >= 0.32;
  }

  return purity >= 0.42 && promotional <= 0.78 && editorialIndependence >= 0.28;
}

export function scoreArticleForTask(taskText, article) {
  const taskTokens = extractTokens(taskText);
  const titleTokens = extractTokens(article.title);
  const docTokens = extractTokens(buildSearchDocument(article));
  const lexical = countOverlapScore(taskTokens, docTokens);
  const titleHit = countOverlapScore(taskTokens, titleTokens);
  const quality = Number(article.quality_score || 0) / 100;
  const reference = Number(article.reference_value_score || 0) / 100;
  return lexical * 0.55 + titleHit * 0.2 + quality * 0.1 + reference * 0.15;
}

export function chunkArray(items, size) {
  const output = [];
  for (let index = 0; index < items.length; index += size) {
    output.push(items.slice(index, index + size));
  }
  return output;
}

export function getSummaryPath(articleId, year) {
  return path.join(SUMMARIES_DIR, `${year || "unknown"}_${articleId}.summary.json`);
}

export function getGeminiClient() {
  const apiKey = getGeminiApiKeys()[0];
  if (!apiKey) {
    throw new Error("缺少 GEMINI_API_KEY 或 GEMINI_API_KEYS 环境变量。");
  }
  return new GoogleGenAI({ apiKey });
}

export function getGeminiApiKeys() {
  const keys = [];
  const singleKey = process.env.GEMINI_API_KEY || "";
  if (singleKey.trim()) {
    keys.push(singleKey.trim());
  }
  const multipleKeys = process.env.GEMINI_API_KEYS || "";
  if (multipleKeys.trim()) {
    for (const token of multipleKeys.split(/[\n,]+/)) {
      const key = token.trim();
      if (key && !keys.includes(key)) {
        keys.push(key);
      }
    }
  }
  return keys;
}

export function createGeminiClient(apiKey) {
  if (!apiKey) {
    throw new Error("Gemini API key 为空。");
  }
  return new GoogleGenAI({ apiKey });
}

export async function sleep(milliseconds) {
  await new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

export async function callWithRetry(factory, retries = 3, initialDelay = 1500) {
  let lastError;
  for (let attempt = 0; attempt < retries; attempt += 1) {
    try {
      return await factory();
    } catch (error) {
      lastError = error;
      if (attempt === retries - 1) {
        break;
      }
      await sleep(initialDelay * (attempt + 1));
    }
  }
  throw lastError;
}

export async function generateJson({ model = DEFAULT_MODEL, contents, schema, systemInstruction, apiKey }) {
  const client = apiKey ? createGeminiClient(apiKey) : getGeminiClient();
  const response = await callWithRetry(() =>
    client.models.generateContent({
      model,
      contents,
      config: {
        systemInstruction,
        responseMimeType: "application/json",
        responseSchema: schema,
      },
    })
  );
  return JSON.parse(response.text || "{}");
}

export async function generateText({ model = DEFAULT_MODEL, contents, systemInstruction, apiKey }) {
  const client = apiKey ? createGeminiClient(apiKey) : getGeminiClient();
  const response = await callWithRetry(() =>
    client.models.generateContent({
      model,
      contents,
      config: systemInstruction ? { systemInstruction } : undefined,
    })
  );
  return unwrapOuterCodeFence((response.text || "").trim());
}

export function unwrapOuterCodeFence(text) {
  const trimmed = String(text ?? "").trim();
  const match = trimmed.match(/^```[a-zA-Z0-9_-]*\r?\n([\s\S]*?)\r?\n```$/);
  if (match) {
    return match[1].trim();
  }
  return trimmed;
}

export async function rebuildArticleTagsJsonl() {
  const summaryFiles = await walkFiles(SUMMARIES_DIR, ".json");
  const items = [];
  for (const filePath of summaryFiles) {
    const raw = await readUtf8(filePath);
    items.push(JSON.parse(raw));
  }
  items.sort((left, right) => left.relative_path.localeCompare(right.relative_path, "zh-Hans-CN"));
  const targetPath = path.join(METADATA_DIR, "article_tags.jsonl");
  await ensureDir(METADATA_DIR);
  const payload = items.map((item) => JSON.stringify(item)).join("\n");
  await writeUtf8(targetPath, payload ? `${payload}\n` : "");
  return items;
}

export async function loadArticleSummaries() {
  const tagsPath = path.join(METADATA_DIR, "article_tags.jsonl");
  if (!(await fileExists(tagsPath))) {
    return [];
  }
  const text = await readUtf8(tagsPath);
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

export async function initRagDirs() {
  await Promise.all([
    ensureDir(GLOBAL_DIR),
    ensureDir(METADATA_DIR),
    ensureDir(SUMMARIES_DIR),
    ensureDir(CACHE_DIR),
    ensureDir(WORKFLOWS_DIR),
    ensureDir(PERSONA_DIR),
    ensureDir(EVAL_DIR),
    ensureDir(BENCHMARK_DIR),
  ]);
}
