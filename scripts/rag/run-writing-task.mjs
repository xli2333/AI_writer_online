import path from "node:path";
import { Type } from "@google/genai";
import {
  CACHE_DIR,
  DEFAULT_MODEL,
  GLOBAL_DIR,
  buildSearchDocument,
  extractTokens,
  initRagDirs,
  loadArticleSummaries,
  parseArgs,
  readUtf8,
  scoreArticleForTask,
  writeJson,
  writeUtf8,
} from "./shared.mjs";
import { generateJson, generateText } from "./shared.mjs";

const TASK_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    theme: { type: Type.STRING },
    title_goal: { type: Type.STRING },
    industry: { type: Type.ARRAY, items: { type: Type.STRING } },
    topic: { type: Type.ARRAY, items: { type: Type.STRING } },
    genre: { type: Type.STRING },
    style: { type: Type.ARRAY, items: { type: Type.STRING } },
    audience: { type: Type.ARRAY, items: { type: Type.STRING } },
    intent: { type: Type.ARRAY, items: { type: Type.STRING } },
    must_include: { type: Type.ARRAY, items: { type: Type.STRING } },
    avoid: { type: Type.ARRAY, items: { type: Type.STRING } },
    desired_length: { type: Type.STRING },
  },
  required: [
    "theme",
    "title_goal",
    "industry",
    "topic",
    "genre",
    "style",
    "audience",
    "intent",
    "must_include",
    "avoid",
    "desired_length",
  ],
};

const RERANK_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    selected_ids: { type: Type.ARRAY, items: { type: Type.STRING } },
    reasoning: { type: Type.STRING },
    must_borrow: { type: Type.ARRAY, items: { type: Type.STRING } },
    structure_advice: { type: Type.ARRAY, items: { type: Type.STRING } },
    tone_advice: { type: Type.ARRAY, items: { type: Type.STRING } },
    avoid: { type: Type.ARRAY, items: { type: Type.STRING } },
  },
  required: ["selected_ids", "reasoning", "must_borrow", "structure_advice", "tone_advice", "avoid"],
};

const EVIDENCE_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    cross_article_takeaways: { type: Type.ARRAY, items: { type: Type.STRING } },
    opening_moves: { type: Type.ARRAY, items: { type: Type.STRING } },
    title_angle_options: { type: Type.ARRAY, items: { type: Type.STRING } },
    conclusion_moves: { type: Type.ARRAY, items: { type: Type.STRING } },
    evidence_cards: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          article_id: { type: Type.STRING },
          title: { type: Type.STRING },
          why_selected: { type: Type.STRING },
          usable_facts: { type: Type.ARRAY, items: { type: Type.STRING } },
          structure_takeaways: { type: Type.ARRAY, items: { type: Type.STRING } },
          quote_fragments_to_avoid_copying: { type: Type.ARRAY, items: { type: Type.STRING } },
        },
        required: [
          "article_id",
          "title",
          "why_selected",
          "usable_facts",
          "structure_takeaways",
          "quote_fragments_to_avoid_copying",
        ],
      },
    },
  },
  required: [
    "cross_article_takeaways",
    "opening_moves",
    "title_angle_options",
    "conclusion_moves",
    "evidence_cards",
  ],
};

const OUTLINE_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    title_candidates: { type: Type.ARRAY, items: { type: Type.STRING } },
    recommended_title: { type: Type.STRING },
    thesis: { type: Type.STRING },
    opening_strategy: { type: Type.STRING },
    sections: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          heading: { type: Type.STRING },
          purpose: { type: Type.STRING },
          key_points: { type: Type.ARRAY, items: { type: Type.STRING } },
          evidence_to_use: { type: Type.ARRAY, items: { type: Type.STRING } },
        },
        required: ["heading", "purpose", "key_points", "evidence_to_use"],
      },
    },
    ending_strategy: { type: Type.STRING },
    writing_risks: { type: Type.ARRAY, items: { type: Type.STRING } },
  },
  required: [
    "title_candidates",
    "recommended_title",
    "thesis",
    "opening_strategy",
    "sections",
    "ending_strategy",
    "writing_risks",
  ],
};

const CRITIQUE_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    overall_score: { type: Type.NUMBER },
    strengths: { type: Type.ARRAY, items: { type: Type.STRING } },
    major_issues: { type: Type.ARRAY, items: { type: Type.STRING } },
    ai_style_violations: { type: Type.ARRAY, items: { type: Type.STRING } },
    evidence_gaps: { type: Type.ARRAY, items: { type: Type.STRING } },
    revision_instructions: { type: Type.ARRAY, items: { type: Type.STRING } },
    rewrite_priority: { type: Type.STRING },
    should_rewrite: { type: Type.BOOLEAN },
  },
  required: [
    "overall_score",
    "strengths",
    "major_issues",
    "ai_style_violations",
    "evidence_gaps",
    "revision_instructions",
    "rewrite_priority",
    "should_rewrite",
  ],
};

const AI_PHRASE_BLACKLIST = [
  "值得注意的是",
  "不难发现",
  "某种意义上",
  "归根结底",
  "总的来说",
  "换言之",
  "由此可见",
  "真正的问题在于",
  "更重要的是",
  "但故事远没有结束",
  "这背后折射出",
  "说到底",
  "其本质在于",
  "从某种维度来看",
  "在这一语境之下",
  "值得我们进一步追问的是",
];

const SYMBOL_BLACKLIST = ["——", "~", "~~~", "***", ">>>", "！！", "？？"];

async function buildTaskProfile(taskText) {
  return generateJson({
    model: DEFAULT_MODEL,
    schema: TASK_SCHEMA,
    systemInstruction:
      "你是写作任务解析器。请把用户的写作任务描述转成结构化字段，全部使用简体中文。若用户没有提供某字段，则给出最合理的空字符串或空数组。只返回 JSON。",
    contents: [
      {
        role: "user",
        parts: [{ text: taskText }],
      },
    ],
  });
}

function boostScore(article, taskProfile, baseScore) {
  let score = baseScore;
  const joined = buildSearchDocument(article);
  const joinedTokens = new Set(extractTokens(joined));
  for (const item of [...taskProfile.industry, ...taskProfile.topic, ...taskProfile.style, ...taskProfile.intent]) {
    for (const token of extractTokens(item)) {
      if (joinedTokens.has(token)) {
        score += 0.03;
      }
    }
  }
  if (taskProfile.genre && article.genre === taskProfile.genre) {
    score += 0.08;
  }
  return score;
}

function escapeRegex(input) {
  return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function countHits(text, pattern) {
  const matches = String(text ?? "").match(new RegExp(escapeRegex(pattern), "g"));
  return matches ? matches.length : 0;
}

function buildStyleLintReport(text) {
  const phraseHits = AI_PHRASE_BLACKLIST.map((pattern) => ({ pattern, count: countHits(text, pattern) })).filter(
    (item) => item.count > 0
  );
  const symbolHits = SYMBOL_BLACKLIST.map((pattern) => ({ pattern, count: countHits(text, pattern) })).filter(
    (item) => item.count > 0
  );
  const shortQuotedTerms = [...String(text ?? "").matchAll(/“[^”]{1,6}”/g)].map((match) => match[0]);
  const warnings = [];
  if (shortQuotedTerms.length >= 4) {
    warnings.push(`疑似滥用引号，共出现 ${shortQuotedTerms.length} 处短词引号。`);
  }
  return {
    phrase_hits: phraseHits,
    symbol_hits: symbolHits,
    short_quoted_terms: shortQuotedTerms.slice(0, 20),
    warnings,
    total_hits:
      phraseHits.reduce((sum, item) => sum + item.count, 0) +
      symbolHits.reduce((sum, item) => sum + item.count, 0) +
      warnings.length,
  };
}

function renderEvidenceMarkdown(evidencePack) {
  const sections = [
    "# evidence_cards.md",
    "",
    "## 跨文档共识",
    ...(evidencePack.cross_article_takeaways || []).map((item) => `- ${item}`),
    "",
    "## 标题角度",
    ...(evidencePack.title_angle_options || []).map((item) => `- ${item}`),
    "",
    "## 开头动作",
    ...(evidencePack.opening_moves || []).map((item) => `- ${item}`),
    "",
    "## 结尾动作",
    ...(evidencePack.conclusion_moves || []).map((item) => `- ${item}`),
    "",
    "## 文章证据卡",
  ];

  for (const card of evidencePack.evidence_cards || []) {
    sections.push(`### [${card.article_id}] ${card.title}`);
    sections.push(`- 选择原因：${card.why_selected}`);
    sections.push("- 可用事实：");
    sections.push(...(card.usable_facts || []).map((item) => `  - ${item}`));
    sections.push("- 可借鉴结构动作：");
    sections.push(...(card.structure_takeaways || []).map((item) => `  - ${item}`));
    sections.push("- 禁止照抄的原文片段：");
    sections.push(...(card.quote_fragments_to_avoid_copying || []).map((item) => `  - ${item}`));
    sections.push("");
  }

  return `${sections.join("\n").trim()}\n`;
}

function renderOutlineMarkdown(outline) {
  const lines = [
    "# outline.md",
    "",
    "## 标题候选",
    ...(outline.title_candidates || []).map((item) => `- ${item}`),
    "",
    `## 推荐标题\n${outline.recommended_title || ""}`,
    "",
    `## 核心立论\n${outline.thesis || ""}`,
    "",
    `## 开头策略\n${outline.opening_strategy || ""}`,
    "",
    "## 结构大纲",
  ];

  for (const section of outline.sections || []) {
    lines.push(`### ${section.heading}`);
    lines.push(`- 目的：${section.purpose}`);
    lines.push("- 要点：");
    lines.push(...(section.key_points || []).map((item) => `  - ${item}`));
    lines.push("- 证据：");
    lines.push(...(section.evidence_to_use || []).map((item) => `  - ${item}`));
    lines.push("");
  }

  lines.push(`## 结尾策略\n${outline.ending_strategy || ""}`);
  lines.push("");
  lines.push("## 写作风险");
  lines.push(...(outline.writing_risks || []).map((item) => `- ${item}`));

  return `${lines.join("\n").trim()}\n`;
}

function renderCritiqueMarkdown(critique) {
  return [
    "# critique.md",
    "",
    `## 总分\n${critique.overall_score ?? ""}`,
    "",
    "## 优点",
    ...(critique.strengths || []).map((item) => `- ${item}`),
    "",
    "## 主要问题",
    ...(critique.major_issues || []).map((item) => `- ${item}`),
    "",
    "## AI 腔与表达问题",
    ...(critique.ai_style_violations || []).map((item) => `- ${item}`),
    "",
    "## 证据缺口",
    ...(critique.evidence_gaps || []).map((item) => `- ${item}`),
    "",
    `## 改写优先级\n${critique.rewrite_priority || ""}`,
    "",
    "## 改写指令",
    ...(critique.revision_instructions || []).map((item) => `- ${item}`),
    "",
    `## 是否建议重写\n${critique.should_rewrite ? "是" : "否"}`,
    "",
  ].join("\n");
}

function renderStyleLintMarkdown(report) {
  return [
    "# style_lint.md",
    "",
    "## 命中短语",
    ...(report.phrase_hits || []).map((item) => `- ${item.pattern}: ${item.count}`),
    "",
    "## 命中符号",
    ...(report.symbol_hits || []).map((item) => `- ${item.pattern}: ${item.count}`),
    "",
    "## 引号预警",
    ...(report.short_quoted_terms || []).map((item) => `- ${item}`),
    "",
    "## 其他提醒",
    ...(report.warnings || []).map((item) => `- ${item}`),
    "",
    `## 总命中数\n${report.total_hits}`,
    "",
  ].join("\n");
}

function buildReferenceBundle(selectedArticles) {
  return selectedArticles
    .map((article, index) =>
      [
        `## 参考原文 ${index + 1}`,
        `标题：${article.title}`,
        `来源：${article.relative_path}`,
        "",
        article.full_text,
      ].join("\n")
    )
    .join("\n\n");
}

function buildPromptBundle({
  taskText,
  universalPrompt,
  coreSkills,
  writingInsights,
  evidenceMarkdown,
  outlineMarkdown,
  referenceBundle,
}) {
  return [
    "# AI写作任务总上下文",
    "",
    "## 通用执行提示",
    universalPrompt.trim(),
    "",
    "## 任务描述",
    taskText.trim(),
    "",
    "## 核心写作总纲",
    coreSkills.trim(),
    "",
    "## 本次写作关键参考",
    writingInsights.trim(),
    "",
    "## 证据卡",
    evidenceMarkdown.trim(),
    "",
    "## 写前提纲",
    outlineMarkdown.trim(),
    "",
    "## 精选参考原文",
    referenceBundle.trim(),
  ].join("\n");
}

function shouldRewriteDraft(critique, lintReport) {
  return Boolean(critique.should_rewrite || Number(critique.overall_score || 0) < 88 || lintReport.total_hits > 0);
}

function serializeSelectedArticles(selectedArticles, includeFullText = false) {
  return selectedArticles.map((article) => ({
    id: article.id,
    title: article.title,
    genre: article.genre,
    style: article.style,
    structure_pattern: article.structure_pattern,
    core_argument: article.core_argument,
    key_points: article.key_points,
    summary_200: article.summary_200,
    full_text: includeFullText ? article.full_text : undefined,
  }));
}

async function buildEvidencePack(taskText, taskProfile, selectedArticles) {
  return generateJson({
    model: DEFAULT_MODEL,
    schema: EVIDENCE_SCHEMA,
    systemInstruction:
      "你是中文商业写作研究员。请基于任务描述和精选参考原文，抽取真正能提升成文质量的证据卡。重点抽取：可直接借用的事实、结构动作、开头方式、结尾方式、论证动作。不要泛泛总结，不要复制大段原文。只返回 JSON。",
    contents: [
      {
        role: "user",
        parts: [
          {
            text: `任务描述：\n${taskText}\n\n任务画像：\n${JSON.stringify(
              taskProfile,
              null,
              2
            )}\n\n精选参考文章原文：\n${JSON.stringify(serializeSelectedArticles(selectedArticles, true), null, 2)}`,
          },
        ],
      },
    ],
  });
}

async function buildOutline(taskText, taskProfile, writingInsights, evidencePack, coreSkills) {
  return generateJson({
    model: DEFAULT_MODEL,
    schema: OUTLINE_SCHEMA,
    systemInstruction:
      "你是中文商业内容主编。请先做结构设计，再写文章。根据任务要求、核心写作总纲、单篇任务参考和证据卡，产出一份真正能提高成文质量的写前提纲。标题要克制、专业、有信息密度。结构要可执行。只返回 JSON。",
    contents: [
      {
        role: "user",
        parts: [
          {
            text: `任务描述：\n${taskText}\n\n任务画像：\n${JSON.stringify(
              taskProfile,
              null,
              2
            )}\n\n核心写作总纲：\n${coreSkills}\n\n本次写作关键参考：\n${writingInsights}\n\n证据卡：\n${JSON.stringify(
              evidencePack,
              null,
              2
            )}`,
          },
        ],
      },
    ],
  });
}

async function buildCritique(taskText, promptBundle, draftV1, styleLint) {
  return generateJson({
    model: DEFAULT_MODEL,
    schema: CRITIQUE_SCHEMA,
    systemInstruction:
      "你是中文商业稿件审稿人。请严格从结构、立论、证据、信息密度、语言克制、AI腔、标题质量等方面给初稿打分并提出可执行修改意见。要敢于指出问题，不要客气。只返回 JSON。",
    contents: [
      {
        role: "user",
        parts: [
          {
            text: `任务与上下文：\n${promptBundle}\n\n初稿：\n${draftV1}\n\n本地风格质检报告：\n${JSON.stringify(styleLint, null, 2)}`,
          },
        ],
      },
    ],
  });
}

async function generateDraft(promptBundle, universalPrompt, phase) {
  const phaseInstruction =
    phase === "rewrite"
      ? "你正在对已有初稿做高质量重写，目标是提升结构、论证、证据使用和语言克制度。保留核心观点，但重写表达和结构。"
      : "你现在进入正式写作阶段，必须严格按给定提纲写，优先吸收证据卡中的高价值动作和事实。";

  return generateText({
    model: DEFAULT_MODEL,
    systemInstruction: `${universalPrompt}\n\n补充执行要求：\n- ${phaseInstruction}\n- 必须优先落实提纲中的推荐标题、核心立论和结构顺序。\n- 必须吸收证据卡里的事实和结构动作。\n- 不允许出现明显 AI 腔、引号滥用、破折号滥用、波浪线和装饰性符号。\n- 可以借鉴参考原文，但不能拼接原文句子。`,
    contents: [
      {
        role: "user",
        parts: [{ text: promptBundle }],
      },
    ],
  });
}

async function cleanDraftStyle(draftText) {
  let currentText = draftText;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const lint = buildStyleLintReport(currentText);
    if (lint.total_hits === 0) {
      return currentText;
    }
    currentText = await generateText({
      model: DEFAULT_MODEL,
      systemInstruction:
        "你是中文出版编辑。请在不改变文章核心观点和结构的前提下，只做语言层面的精修：删除 AI 腔套话，删除装饰性符号，删除不必要的破折号和波浪线，删除给普通词语乱加的引号，收紧表达，保持事实和逻辑不变。直接输出修订后的完整文章。",
      contents: [
        {
          role: "user",
          parts: [
            {
              text: `待修稿件：\n${currentText}\n\n风格问题：\n${renderStyleLintMarkdown(lint)}\n\n硬性要求：\n1. 标题和正文尽量不用引号包装普通概念。\n2. 不要使用破折号制造气氛。\n3. 不要保留命中的黑名单短语和装饰性符号。`,
            },
          ],
        },
      ],
    });
  }
  return currentText;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const taskPath = args.task;
  if (!taskPath) {
    throw new Error("请通过 --task 指定任务描述文件路径。");
  }

  await initRagDirs();

  const taskText = await readUtf8(path.resolve(taskPath));
  const taskProfile = await buildTaskProfile(taskText);
  const articles = await loadArticleSummaries();
  if (!articles.length) {
    throw new Error("缺少 article_tags.jsonl，请先运行 rag:analyze。");
  }

  const universalPrompt = await readUtf8(path.join(GLOBAL_DIR, "universal_prompt.md"));
  const coreSkills = await readUtf8(path.join(GLOBAL_DIR, "core_writing_skills.md"));

  const scored = articles
    .filter((article) => !article.is_activity_notice)
    .map((article) => {
      const baseScore = scoreArticleForTask(taskText, article);
      return {
        ...article,
        retrieval_score: boostScore(article, taskProfile, baseScore),
      };
    })
    .sort((left, right) => right.retrieval_score - left.retrieval_score);

  const top20 = scored.slice(0, 20);

  const rerank = await generateJson({
    model: DEFAULT_MODEL,
    schema: RERANK_SCHEMA,
    systemInstruction:
      "你是中文商业写作总编。你会根据任务描述和候选参考文章，从 top 20 中选出最值得借鉴的 3 到 5 篇。选文时优先考虑主题贴合度、文体匹配度、风格匹配度、结构可复用性和参考价值分。只返回 JSON。",
    contents: [
      {
        role: "user",
        parts: [
          {
            text: `任务描述：\n${taskText}\n\n结构化任务画像：\n${JSON.stringify(
              taskProfile,
              null,
              2
            )}\n\n候选文章：\n${JSON.stringify(
              top20.map((article) => ({
                id: article.id,
                title: article.title,
                genre: article.genre,
                style: article.style,
                topic: article.topic,
                audience: article.audience,
                intent: article.intent,
                structure_pattern: article.structure_pattern,
                summary_200: article.summary_200,
                quality_score: article.quality_score,
                reference_value_score: article.reference_value_score,
                retrieval_score: article.retrieval_score,
              })),
              null,
              2
            )}`,
          },
        ],
      },
    ],
  });

  const selectedIds = rerank.selected_ids.slice(0, 5);
  const selectedArticles = [];
  for (const id of selectedIds) {
    const article = top20.find((item) => item.id === id);
    if (!article) {
      continue;
    }
    const fullText = await readUtf8(article.full_text_path);
    selectedArticles.push({
      ...article,
      full_text: fullText,
    });
  }

  const writingInsights = await generateText({
    model: DEFAULT_MODEL,
    systemInstruction:
      "你是中文写作策略顾问。请基于任务描述和精选参考文章，输出一份短小但高价值的 writing_insights.md。必须使用简体中文 Markdown，必须包含：任务画像、推荐参考文章、每篇的借鉴点、本次必须遵守的写法要点、本次建议结构、本次避免事项。不要贴原文大段引用，要提炼可执行的方法。",
    contents: [
      {
        role: "user",
        parts: [
          {
            text: `任务描述：\n${taskText}\n\n任务画像：\n${JSON.stringify(
              taskProfile,
              null,
              2
            )}\n\n重排结果：\n${JSON.stringify(rerank, null, 2)}\n\n精选文章：\n${JSON.stringify(
              selectedArticles.map((article) => ({
                id: article.id,
                title: article.title,
                summary_200: article.summary_200,
                genre: article.genre,
                style: article.style,
                structure_pattern: article.structure_pattern,
                core_argument: article.core_argument,
                key_points: article.key_points,
              })),
              null,
              2
            )}`,
          },
        ],
      },
    ],
  });

  const evidencePack = await buildEvidencePack(taskText, taskProfile, selectedArticles);
  const evidenceMarkdown = renderEvidenceMarkdown(evidencePack);
  const outline = await buildOutline(taskText, taskProfile, writingInsights, evidencePack, coreSkills);
  const outlineMarkdown = renderOutlineMarkdown(outline);
  const referenceBundle = buildReferenceBundle(selectedArticles);
  const promptBundle = buildPromptBundle({
    taskText,
    universalPrompt,
    coreSkills,
    writingInsights,
    evidenceMarkdown,
    outlineMarkdown,
    referenceBundle,
  });

  await writeUtf8(path.join(CACHE_DIR, "task_brief.md"), `${taskText.trim()}\n`);
  await writeUtf8(path.join(CACHE_DIR, "writing_insights.md"), `${writingInsights.trim()}\n`);
  await writeUtf8(path.join(CACHE_DIR, "evidence_cards.md"), evidenceMarkdown);
  await writeUtf8(path.join(CACHE_DIR, "outline.md"), outlineMarkdown);
  await writeUtf8(path.join(CACHE_DIR, "prompt_bundle.md"), `${promptBundle.trim()}\n`);
  await writeJson(path.join(CACHE_DIR, "retrieved_articles.json"), {
    model: DEFAULT_MODEL,
    task_profile: taskProfile,
    top20: top20.map((article) => ({
      id: article.id,
      title: article.title,
      retrieval_score: article.retrieval_score,
      summary_200: article.summary_200,
      genre: article.genre,
      style: article.style,
      topic: article.topic,
      reference_value_score: article.reference_value_score,
    })),
    rerank,
    selected_ids: selectedIds,
    recommended_title: outline.recommended_title,
  });

  if (args.draft) {
    const draftV1 = await generateDraft(promptBundle, universalPrompt, "draft");
    const lintBeforeRewrite = buildStyleLintReport(draftV1);
    const critique = await buildCritique(taskText, promptBundle, draftV1, lintBeforeRewrite);
    let finalDraft = draftV1;

    await writeUtf8(path.join(CACHE_DIR, "draft_v1.md"), `${draftV1.trim()}\n`);
    await writeUtf8(path.join(CACHE_DIR, "style_lint_before_rewrite.md"), renderStyleLintMarkdown(lintBeforeRewrite));
    await writeUtf8(path.join(CACHE_DIR, "critique.md"), renderCritiqueMarkdown(critique));

    if (shouldRewriteDraft(critique, lintBeforeRewrite)) {
      const rewritePrompt = [
        promptBundle,
        "",
        "## 初稿",
        draftV1.trim(),
        "",
        "## 审稿意见",
        renderCritiqueMarkdown(critique).trim(),
        "",
        "## 本地风格质检报告",
        renderStyleLintMarkdown(lintBeforeRewrite).trim(),
      ].join("\n");
      finalDraft = await generateDraft(rewritePrompt, universalPrompt, "rewrite");
    }

    finalDraft = await cleanDraftStyle(finalDraft);
    const finalLint = buildStyleLintReport(finalDraft);
    await writeUtf8(path.join(CACHE_DIR, "style_lint.md"), renderStyleLintMarkdown(finalLint));
    await writeUtf8(path.join(CACHE_DIR, "final_draft.md"), `${finalDraft.trim()}\n`);
    await writeUtf8(path.join(CACHE_DIR, "draft.md"), `${finalDraft.trim()}\n`);
  }

  console.log(
    JSON.stringify(
      {
        model: DEFAULT_MODEL,
        task_profile: taskProfile,
        retrieved_count: top20.length,
        selected_count: selectedArticles.length,
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
