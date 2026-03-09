import path from "node:path";
import { RAG_DIR, DEFAULT_MODEL, ensureDir, initRagDirs, isStylePureEnough, loadArticleSummaries, writeJson, writeUtf8 } from "./shared.mjs";

const PERSONA_DIR = path.join(RAG_DIR, "persona");
const RULE_CARDS_PATH = path.join(PERSONA_DIR, "rule_cards.jsonl");

function scoreArticle(article) {
  const quality = Number(article.quality_score || 0);
  const reference = Number(article.reference_value_score || 0);
  const publishability = Number(article.publishability_score || 0);
  const structure = Number(article.structure_score || 0);
  const argument = Number(article.argument_score || 0);
  const evidence = Number(article.evidence_score || 0);
  const style = Number(article.style_score || 0);
  return publishability * 0.25 + quality * 0.2 + reference * 0.18 + structure * 0.13 + argument * 0.12 + evidence * 0.07 + style * 0.05;
}

function createCard(article, category, rule, evidence, weight, extra = {}) {
  return {
    id: `${article.id}_${category}_${Math.random().toString(36).slice(2, 8)}`,
    article_id: article.id,
    article_title: article.title,
    category,
    weight: Number(weight.toFixed(2)),
    rule,
    evidence,
    genre: article.genre,
    content_type: article.content_type || "",
    topic: article.topic || [],
    style: article.style || [],
    audience: article.audience || [],
    publishability_score: Number(article.publishability_score || 0),
    reference_value_score: Number(article.reference_value_score || 0),
    ...extra,
  };
}

function buildCardsFromArticle(article) {
  const cards = [];
  const baseWeight = scoreArticle(article);

  if (article.opening_pattern && Number(article.opening_score || 0) >= 75) {
    cards.push(
      createCard(
        article,
        "opening",
        `在${article.genre || "商业中文"}写作中，可优先考虑这种开篇动作：${article.opening_pattern}`,
        `来源文章的 opening_score=${article.opening_score || 0}`,
        baseWeight + Number(article.opening_score || 0) * 0.1
      )
    );
  }

  if (article.structure_pattern && Number(article.structure_score || 0) >= 75) {
    cards.push(
      createCard(
        article,
        "structure",
        `当主题需要展开多维拆解时，可优先采用这种结构组织方式：${article.structure_pattern}`,
        `section_functions=${JSON.stringify(article.section_functions || [])}`,
        baseWeight + Number(article.structure_score || 0) * 0.1
      )
    );
  }

  for (const move of (article.argument_moves || []).slice(0, 4)) {
    cards.push(
      createCard(
        article,
        "argument",
        `可迁移的论证动作：${move}`,
        `thesis_type=${article.thesis_type || ""}; thesis_sentence=${article.thesis_sentence || ""}`,
        baseWeight + Number(article.argument_score || 0) * 0.08
      )
    );
  }

  if (Array.isArray(article.evidence_types) && article.evidence_types.length > 0) {
    cards.push(
      createCard(
        article,
        "evidence",
        `这类稿件适合混合使用这些证据类型：${article.evidence_types.join("、")}`,
        `evidence_specificity_score=${article.evidence_specificity_score || 0}; data_density_score=${article.data_density_score || 0}; case_density_score=${article.case_density_score || 0}`,
        baseWeight + Number(article.evidence_score || 0) * 0.08
      )
    );
  }

  if (article.narrative_distance || article.stance_strength || article.abstraction_level) {
    cards.push(
      createCard(
        article,
        "style",
        `推荐维持这种文风组合：叙述距离=${article.narrative_distance || ""}；立场强度=${article.stance_strength || ""}；抽象层级=${article.abstraction_level || ""}`,
        `sentence_rhythm=${article.sentence_rhythm || ""}`,
        baseWeight + Number(article.style_score || 0) * 0.08
      )
    );
  }

  for (const move of (article.transferable_moves || []).slice(0, 4)) {
    cards.push(
      createCard(
        article,
        "transferable_move",
        `可直接借用的写作/组织动作：${move}`,
        `core_argument=${article.core_argument || ""}`,
        baseWeight + 4
      )
    );
  }

  for (const antiPattern of (article.anti_patterns || []).slice(0, 4)) {
    cards.push(
      createCard(
        article,
        "anti_pattern",
        `应主动规避的反模式：${antiPattern}`,
        `source_summary=${article.summary_200 || ""}`,
        baseWeight + 3
      )
    );
  }

  if (article.ending_pattern) {
    cards.push(
      createCard(
        article,
        "ending",
        `收束时可采用这种结尾方式：${article.ending_pattern}`,
        `publishability_score=${article.publishability_score || 0}`,
        baseWeight + 2
      )
    );
  }

  return cards;
}

async function main() {
  await initRagDirs();
  await ensureDir(PERSONA_DIR);

  const articles = await loadArticleSummaries();
  if (!articles.length) {
    throw new Error("缺少 article_tags.jsonl，请先运行 rag:analyze。");
  }

  const cards = articles
    .filter(
      (article) =>
        isStylePureEnough(article) &&
        typeof article.content_type === "string" &&
        article.content_type.trim()
    )
    .flatMap(buildCardsFromArticle)
    .sort((left, right) => right.weight - left.weight);

  await writeUtf8(RULE_CARDS_PATH, cards.map((card) => JSON.stringify(card)).join("\n") + "\n");
  await writeJson(path.join(PERSONA_DIR, "rule_cards.summary.json"), {
    model: DEFAULT_MODEL,
    generated_at: new Date().toISOString(),
    total_cards: cards.length,
    categories: cards.reduce((acc, card) => {
      acc[card.category] = (acc[card.category] || 0) + 1;
      return acc;
    }, {}),
    top_cards: cards.slice(0, 20),
  });
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
