import path from "node:path";
import { Type } from "@google/genai";
import { DEFAULT_MODEL, GLOBAL_DIR, initRagDirs, loadArticleSummaries, writeUtf8 } from "./shared.mjs";
import { generateJson, generateText } from "./shared.mjs";

const SAMPLE_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    selected_ids: { type: Type.ARRAY, items: { type: Type.STRING } },
    selection_reason: { type: Type.STRING },
  },
  required: ["selected_ids", "selection_reason"],
};

async function main() {
  await initRagDirs();
  const articles = await loadArticleSummaries();
  if (!articles.length) {
    throw new Error("缺少 article_tags.jsonl，请先运行 rag:analyze。");
  }

  const ranked = [...articles]
    .filter((article) => !article.is_activity_notice)
    .sort(
      (left, right) =>
        Number(right.reference_value_score || 0) + Number(right.quality_score || 0) -
        (Number(left.reference_value_score || 0) + Number(left.quality_score || 0))
    )
    .slice(0, 120)
    .map((article) => ({
      id: article.id,
      title: article.title,
      genre: article.genre,
      style: article.style,
      topic: article.topic,
      structure_pattern: article.structure_pattern,
      opening_pattern: article.opening_pattern,
      ending_pattern: article.ending_pattern,
      summary_200: article.summary_200,
      quality_score: article.quality_score,
      reference_value_score: article.reference_value_score,
    }));

  const sampleDecision = await generateJson({
    model: DEFAULT_MODEL,
    schema: SAMPLE_SCHEMA,
    systemInstruction:
      "你是中文写作策略分析师。请从候选文章中挑选最适合提炼全局写作规律的样本。优先选择高参考价值、高质量、类型有一定覆盖度的文章。只返回 JSON。",
    contents: [
      {
        role: "user",
        parts: [
          {
            text: `请从以下候选样本中挑选 30 篇最适合提炼核心写作技能的文章，返回 selected_ids。\n${JSON.stringify(
              ranked,
              null,
              2
            )}`,
          },
        ],
      },
    ],
  });

  const selected = ranked.filter((article) => sampleDecision.selected_ids.includes(article.id));
  const markdown = await generateText({
    model: DEFAULT_MODEL,
    systemInstruction:
      "你是中文商业内容总编。你的任务是基于一批高质量样本，提炼一份可长期复用的《核心写作总纲》。输出必须是简体中文 Markdown。必须包含：写作目标、标题原则、开头原则、结构原则、论证原则、风格原则、信息组织原则、结尾原则、禁忌清单、质量评分标准、使用方法。不要写空话，要写成可直接喂给 AI 的规则。",
    contents: [
      {
        role: "user",
        parts: [
          {
            text: `以下是用于提炼的样本文章摘要，请输出完整 Markdown：\n${JSON.stringify(
              {
                selection_reason: sampleDecision.selection_reason,
                selected_articles: selected,
              },
              null,
              2
            )}`,
          },
        ],
      },
    ],
  });

  await writeUtf8(path.join(GLOBAL_DIR, "core_writing_skills.md"), `${markdown}\n`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
