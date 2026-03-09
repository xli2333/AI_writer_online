import path from "node:path";
import { Type } from "@google/genai";
import { DEFAULT_MODEL, GLOBAL_DIR, RAG_DIR, ensureDir, initRagDirs, readUtf8, writeJson, writeUtf8 } from "./shared.mjs";
import { generateJson } from "./shared.mjs";

function normalizeMarkdown(text) {
  const raw = String(text || "").trim();
  if (!raw) {
    return "";
  }
  return raw.replace(/\\n/g, "\n").replace(/\r\n/g, "\n").trim();
}

const PERSONA_DIR = path.join(RAG_DIR, "persona");
const PATCH_DIR = path.join(PERSONA_DIR, "patch_candidates");
const RULE_CARDS_PATH = path.join(PERSONA_DIR, "rule_cards.jsonl");
const MASTER_PERSONA_PATH = path.join(GLOBAL_DIR, "runtime", "master_persona.md");

const PATCH_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    summary: { type: Type.STRING },
    patch_title: { type: Type.STRING },
    candidate_rules: { type: Type.ARRAY, items: { type: Type.STRING } },
    acceptance_criteria: { type: Type.ARRAY, items: { type: Type.STRING } },
    updated_master_persona_markdown: { type: Type.STRING },
  },
  required: ["summary", "patch_title", "candidate_rules", "acceptance_criteria", "updated_master_persona_markdown"],
};

function loadRuleCards(raw) {
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function diversifyCards(cards, limit = 80) {
  const selected = [];
  const perCategory = new Map();

  for (const card of cards) {
    const used = perCategory.get(card.category) || 0;
    if (used >= 14) {
      continue;
    }
    selected.push(card);
    perCategory.set(card.category, used + 1);
    if (selected.length >= limit) {
      break;
    }
  }

  return selected;
}

async function main() {
  await initRagDirs();
  await ensureDir(PATCH_DIR);

  const cards = loadRuleCards(await readUtf8(RULE_CARDS_PATH)).sort((left, right) => Number(right.weight || 0) - Number(left.weight || 0));
  if (!cards.length) {
    throw new Error("缺少 rule_cards.jsonl，请先运行 rag:rule-cards。");
  }

  const selectedCards = diversifyCards(cards);
  const masterPersona = await readUtf8(MASTER_PERSONA_PATH);

  const patch = await generateJson({
    model: DEFAULT_MODEL,
    schema: PATCH_SCHEMA,
    systemInstruction:
      "你是中文商业写作系统的 persona 进化编辑。你的任务是基于现有 master_persona 和高权重 rule cards，提出一份可验证的 persona patch。不要推翻原人格，而是在保持其稳定性的前提下做增量强化。输出 JSON。",
    contents: [
      {
        role: "user",
        parts: [
          {
            text: `现有 master_persona.md：\n${masterPersona}\n\n候选 rule cards：\n${JSON.stringify(selectedCards, null, 2)}`,
          },
        ],
      },
    ],
  });

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const baseName = `${stamp}.${String(patch.patch_title || "persona-patch").replace(/[^\p{L}\p{N}_-]+/gu, "-")}`;

  await writeJson(path.join(PATCH_DIR, `${baseName}.json`), {
    model: DEFAULT_MODEL,
    generated_at: new Date().toISOString(),
    selected_card_count: selectedCards.length,
    selected_cards: selectedCards,
    patch,
  });
  const normalizedMarkdown = normalizeMarkdown(patch.updated_master_persona_markdown || "");
  await writeUtf8(path.join(PATCH_DIR, `${baseName}.md`), `${normalizedMarkdown}\n`);
  await writeUtf8(path.join(PERSONA_DIR, "latest_patch.md"), `${normalizedMarkdown}\n`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
