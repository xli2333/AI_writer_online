import path from "node:path";
import {
  DEFAULT_MODEL,
  GLOBAL_DIR,
  initRagDirs,
  isStylePureEnough,
  loadArticleSummaries,
  readUtf8,
  writeJson,
  writeUtf8,
  ensureDir,
} from "./shared.mjs";
import { generateText } from "./shared.mjs";

function normalizeMarkdown(text) {
  const raw = String(text || "").trim();
  if (!raw) {
    return "";
  }
  return raw.replace(/\\n/g, "\n").replace(/\r\n/g, "\n").trim();
}

function rankForPersona(article) {
  const quality = Number(article.quality_score || 0);
  const reference = Number(article.reference_value_score || 0);
  const publishability = Number(article.publishability_score || 0);
  const structure = Number(article.structure_score || 0);
  const argument = Number(article.argument_score || 0);
  const evidence = Number(article.evidence_score || 0);
  return publishability * 0.26 + quality * 0.22 + reference * 0.18 + structure * 0.14 + argument * 0.12 + evidence * 0.08;
}

function pickPersonaCandidates(articles, limit = 36) {
  return [...articles]
    .filter((article) => isStylePureEnough(article))
    .sort((left, right) => rankForPersona(right) - rankForPersona(left))
    .slice(0, limit)
    .map((article) => ({
      id: article.id,
      title: article.title,
      content_type: article.content_type,
      genre: article.genre,
      topic: article.topic,
      style: article.style,
      audience: article.audience,
      tone: article.tone,
      primary_question: article.primary_question,
      thesis_type: article.thesis_type,
      thesis_sentence: article.thesis_sentence,
      structure_pattern: article.structure_pattern,
      section_functions: article.section_functions,
      argument_moves: article.argument_moves,
      opening_pattern: article.opening_pattern,
      ending_pattern: article.ending_pattern,
      evidence_types: article.evidence_types,
      narrative_distance: article.narrative_distance,
      stance_strength: article.stance_strength,
      abstraction_level: article.abstraction_level,
      transferable_moves: article.transferable_moves,
      anti_patterns: article.anti_patterns,
      title_score: article.title_score,
      opening_score: article.opening_score,
      argument_score: article.argument_score,
      evidence_score: article.evidence_score,
      structure_score: article.structure_score,
      style_score: article.style_score,
      publishability_score: article.publishability_score,
      quality_score: article.quality_score,
      reference_value_score: article.reference_value_score,
      summary_200: article.summary_200,
    }));
}

async function main() {
  await initRagDirs();
  const articles = await loadArticleSummaries();
  if (!articles.length) {
    throw new Error("缺少 article_tags.jsonl，请先运行 rag:analyze。");
  }

  const candidates = pickPersonaCandidates(articles);
  if (!candidates.length) {
    throw new Error("没有可用于提炼主人格的高质量文章样本。");
  }

  const markdown = await generateText({
    model: DEFAULT_MODEL,
    systemInstruction:
      "你是中文商业写作系统的总编辑设计师。请基于一批高质量文章的结构化写作基因，提炼一份可直接用于生成商业中文文章的 master_persona.md。输出必须是简体中文 Markdown。必须覆盖五块：身份与目标、AI行为纪律、任务理解、文章理解、输出门槛。不要写空话，不要复述样本，不要写流程说明，要写成可直接进入系统指令的长期规则。",
    contents: [
      {
        role: "user",
        parts: [
          {
            text: `请基于以下高质量文章基因样本，生成一份可长期复用的 master_persona.md：\n${JSON.stringify(
              candidates,
              null,
              2
            )}`,
          },
        ],
      },
    ],
  });

  const targetPath = path.join(GLOBAL_DIR, "runtime", "master_persona.md");
  const historyDir = path.join(GLOBAL_DIR, "runtime", "history");
  await ensureDir(historyDir);
  try {
    const previous = await readUtf8(targetPath);
    if (previous.trim()) {
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      await writeUtf8(path.join(historyDir, `master_persona.${stamp}.md`), `${previous.trim()}\n`);
    }
  } catch {
    // ignore first-run missing file
  }
  await writeUtf8(targetPath, `${normalizeMarkdown(markdown)}\n`);
  await writeJson(path.join(GLOBAL_DIR, "runtime", "master_persona.sources.json"), {
    model: DEFAULT_MODEL,
    source_count: candidates.length,
    updated_at: new Date().toISOString(),
    selected_articles: candidates.map((article) => ({
      id: article.id,
      title: article.title,
      quality_score: article.quality_score,
      reference_value_score: article.reference_value_score,
      publishability_score: article.publishability_score,
    })),
  });
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
