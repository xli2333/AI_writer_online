import fs from "node:fs/promises";
import path from "node:path";
import {
  ACTIVE_PROFILE_ID,
  BENCHMARK_DIR,
  METADATA_DIR,
  RAW_DIR,
  ROOT_DIR,
  WORKFLOWS_DIR,
  ensureDir,
  initRagDirs,
  readUtf8,
  writeJson,
  writeUtf8,
} from "./shared.mjs";

const SOURCE_DIR = path.join(ROOT_DIR, "华尔街见闻");
const WORKFLOW_SOURCE_DIR = path.join(ROOT_DIR, "rag_assets", "workflows");
const BENCHMARK_SOURCE_DIR = path.join(ROOT_DIR, "rag_assets", "evals", "benchmark_tasks");

const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".svg"]);
const STRIP_LINE_PATTERNS = [
  /^⭐星标华尔街见闻(?:Max)?，好内容不错过$/,
  /^本文首发于“见闻VIP”作者.*欢迎订阅“见闻VIP”。?$/,
];

const normalizeContent = (value) => String(value || "").replace(/^\uFEFF/, "").replace(/\r\n/g, "\n").trim();

async function pathExists(targetPath) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function copyMarkdownAssets(sourceDir, targetDir) {
  await ensureDir(targetDir);
  const entries = await fs.readdir(sourceDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (!entry.name.endsWith(".md")) continue;
    const sourcePath = path.join(sourceDir, entry.name);
    const targetPath = path.join(targetDir, entry.name);
    const content = await readUtf8(sourcePath);
    await writeUtf8(targetPath, `${content.trim()}\n`);
  }
}

function parseArticleDirName(dirName, parentName) {
  const cleanName = String(dirName || "").trim();
  const match = cleanName.match(/^(\d{4}-\d{2}-\d{2})_(.+)$/);
  if (match) {
    return {
      date: match[1],
      year: match[1].slice(0, 4),
      title: match[2].trim(),
      baseName: cleanName,
    };
  }

  const fallbackYear = String(parentName || "").slice(0, 4);
  return {
    date: "",
    year: /^\d{4}$/.test(fallbackYear) ? fallbackYear : "unknown",
    title: cleanName,
    baseName: cleanName,
  };
}

function sanitizeWallstreetcnContent(value) {
  const normalized = normalizeContent(value);
  if (!normalized) {
    return "";
  }

  const lines = normalized
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => {
      const trimmed = line.trim();
      if (!trimmed) return true;
      return !STRIP_LINE_PATTERNS.some((pattern) => pattern.test(trimmed));
    });

  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

async function main() {
  if (ACTIVE_PROFILE_ID !== "wallstreetcn") {
    throw new Error("请使用 --profile wallstreetcn 运行该脚本。");
  }

  await initRagDirs();
  await ensureDir(RAW_DIR);
  await copyMarkdownAssets(WORKFLOW_SOURCE_DIR, WORKFLOWS_DIR);
  await copyMarkdownAssets(BENCHMARK_SOURCE_DIR, BENCHMARK_DIR);

  if (!(await pathExists(SOURCE_DIR))) {
    throw new Error(`缺少华尔街见闻原始目录：${SOURCE_DIR}`);
  }

  const monthDirs = await fs.readdir(SOURCE_DIR, { withFileTypes: true });
  const manifest = [];
  const imageExtensions = {};
  let scannedArticleDirs = 0;
  let importedArticles = 0;
  let ignoredImageFiles = 0;
  let missingContentCount = 0;
  let emptyContentCount = 0;

  for (const monthEntry of monthDirs) {
    if (!monthEntry.isDirectory()) continue;
    const monthDirPath = path.join(SOURCE_DIR, monthEntry.name);
    const articleDirs = await fs.readdir(monthDirPath, { withFileTypes: true });

    for (const articleEntry of articleDirs) {
      if (!articleEntry.isDirectory()) continue;
      scannedArticleDirs += 1;
      const articleDirPath = path.join(monthDirPath, articleEntry.name);
      const articleMeta = parseArticleDirName(articleEntry.name, monthEntry.name);
      const contentPath = path.join(articleDirPath, "content.txt");
      const assetEntries = await fs.readdir(articleDirPath, { withFileTypes: true });

      for (const assetEntry of assetEntries) {
        const extension = path.extname(assetEntry.name).toLowerCase();
        if (assetEntry.isFile() && IMAGE_EXTENSIONS.has(extension)) {
          ignoredImageFiles += 1;
          imageExtensions[extension] = (imageExtensions[extension] || 0) + 1;
        }
      }

      if (!(await pathExists(contentPath))) {
        missingContentCount += 1;
        manifest.push({
          source_dir: articleDirPath,
          month_folder: monthEntry.name,
          imported: false,
          reason: "missing_content.txt",
        });
        continue;
      }

      const content = sanitizeWallstreetcnContent(await readUtf8(contentPath));
      if (!content) {
        emptyContentCount += 1;
        manifest.push({
          source_dir: articleDirPath,
          month_folder: monthEntry.name,
          imported: false,
          reason: "empty_content",
        });
        continue;
      }

      const yearDir = path.join(RAW_DIR, articleMeta.year);
      const targetPath = path.join(yearDir, `${articleMeta.baseName}.txt`);
      await ensureDir(yearDir);
      await writeUtf8(targetPath, `${content}\n`);
      importedArticles += 1;
      manifest.push({
        source_dir: articleDirPath,
        month_folder: monthEntry.name,
        imported: true,
        date: articleMeta.date,
        year: articleMeta.year,
        title: articleMeta.title,
        target_path: path.relative(ROOT_DIR, targetPath).replaceAll("\\", "/"),
        ignored_images: assetEntries.filter(
          (entry) => entry.isFile() && IMAGE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())
        ).length,
      });
    }
  }

  await ensureDir(METADATA_DIR);
  await writeUtf8(
    path.join(METADATA_DIR, "wallstreetcn_import_manifest.jsonl"),
    manifest.map((item) => JSON.stringify(item)).join("\n") + "\n"
  );
  await writeJson(path.join(METADATA_DIR, "wallstreetcn_import_summary.json"), {
    profile: ACTIVE_PROFILE_ID,
    source_dir: SOURCE_DIR,
    target_raw_dir: RAW_DIR,
    scanned_article_dirs: scannedArticleDirs,
    imported_articles: importedArticles,
    missing_content_count: missingContentCount,
    empty_content_count: emptyContentCount,
    ignored_image_files: ignoredImageFiles,
    ignored_image_extensions: imageExtensions,
    workflow_assets_dir: WORKFLOWS_DIR,
    benchmark_dir: BENCHMARK_DIR,
    stripped_line_patterns: STRIP_LINE_PATTERNS.map((pattern) => pattern.source),
    generated_at: new Date().toISOString(),
  });

  console.log(
    JSON.stringify(
      {
        profile: ACTIVE_PROFILE_ID,
        imported_articles: importedArticles,
        ignored_image_files: ignoredImageFiles,
        missing_content_count: missingContentCount,
        empty_content_count: emptyContentCount,
      },
      null,
      2
    )
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
