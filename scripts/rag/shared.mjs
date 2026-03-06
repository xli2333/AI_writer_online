import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { GoogleGenAI, Type } from "@google/genai";
import { ProxyAgent, setGlobalDispatcher } from "undici";

export const ROOT_DIR = process.cwd();
export const RAW_DIR = path.join(ROOT_DIR, "raw_materials");
export const RAG_DIR = path.join(ROOT_DIR, "rag_assets");
export const GLOBAL_DIR = path.join(RAG_DIR, "global");
export const METADATA_DIR = path.join(RAG_DIR, "metadata");
export const SUMMARIES_DIR = path.join(RAG_DIR, "summaries", "per_article");
export const CACHE_DIR = path.join(RAG_DIR, "cache", "current_task");
export const WORKFLOWS_DIR = path.join(RAG_DIR, "workflows");

export const DEFAULT_MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash-lite";

const proxyUrl = process.env.HTTPS_PROXY || process.env.HTTP_PROXY || "";
if (proxyUrl) {
  setGlobalDispatcher(new ProxyAgent(proxyUrl));
}

export const ARTICLE_ANALYSIS_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    industry: { type: Type.ARRAY, items: { type: Type.STRING } },
    topic: { type: Type.ARRAY, items: { type: Type.STRING } },
    genre: { type: Type.STRING },
    style: { type: Type.ARRAY, items: { type: Type.STRING } },
    audience: { type: Type.ARRAY, items: { type: Type.STRING } },
    intent: { type: Type.ARRAY, items: { type: Type.STRING } },
    tone: { type: Type.ARRAY, items: { type: Type.STRING } },
    structure_pattern: { type: Type.STRING },
    core_argument: { type: Type.STRING },
    key_points: { type: Type.ARRAY, items: { type: Type.STRING } },
    opening_pattern: { type: Type.STRING },
    ending_pattern: { type: Type.STRING },
    notable_phrases: { type: Type.ARRAY, items: { type: Type.STRING } },
    quality_score: { type: Type.NUMBER },
    reference_value_score: { type: Type.NUMBER },
    is_activity_notice: { type: Type.BOOLEAN },
    is_low_value: { type: Type.BOOLEAN },
    summary_200: { type: Type.STRING },
    summary_500: { type: Type.STRING },
  },
  required: [
    "industry",
    "topic",
    "genre",
    "style",
    "audience",
    "intent",
    "tone",
    "structure_pattern",
    "core_argument",
    "key_points",
    "opening_pattern",
    "ending_pattern",
    "notable_phrases",
    "quality_score",
    "reference_value_score",
    "is_activity_notice",
    "is_low_value",
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
    ...(article.industry || []),
    ...(article.topic || []),
    article.genre,
    ...(article.style || []),
    ...(article.audience || []),
    ...(article.intent || []),
    ...(article.tone || []),
    article.structure_pattern,
    article.core_argument,
    ...(article.key_points || []),
  ]
    .filter(Boolean)
    .join(" ");
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
  ]);
}
