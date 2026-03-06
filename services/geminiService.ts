import { GenerateContentResponse, GoogleGenAI, Type, createPartFromBase64 } from '@google/genai';
import {
  ReferenceTemplateArticle,
  ResearchDocument,
  SearchSource,
  UploadedFile,
  WritingChunkPlanItem,
  WritingTaskOptions,
} from '../types';
import {
  hydrateReferenceTemplatesWithFullText,
  selectReferenceTemplates,
} from './referenceTemplateService';

const MAX_CONTEXT_CHARS = 180000;
const MAX_DRAFT_CHARS = 18000;
const DEFAULT_STAGE_TIMEOUT_MS = 180000;
const STAGE_STATUS_INTERVAL_MS = 5000;
const MAGAZINE_EDITORIAL_MAX_PASSES = 3;
const MAGAZINE_MAX_ISSUES_PER_PASS = 6;

type EditorialStrategy = 'rewrite' | 'sectional' | 'surgical' | 'done';

interface EditorialIssue {
  severity: string;
  scope: string;
  title: string;
  diagnosis: string;
  instruction: string;
  excerpt: string;
}

interface EditorialReviewReport {
  summary: string;
  ready: string;
  strategy: EditorialStrategy;
  templateAlignment: string;
  unresolvedRisk: string;
  issues: EditorialIssue[];
}

interface OutlineResult {
  outline: string;
  referenceArticles: ReferenceTemplateArticle[];
}

interface ResearchTrackResult {
  title: string;
  content: string;
  sources: SearchSource[];
}

interface ArticlePackageResult {
  referenceArticles: ReferenceTemplateArticle[];
  writingInsights: string;
  evidenceCards: string;
  chunkPlan: WritingChunkPlanItem[];
  critique: string;
  articleContent: string;
  teachingNotes: string;
}

export interface ChatResponse {
  text: string;
  refinementRequest?: {
    target: 'article' | 'notes';
    instruction: string;
  };
}

const ANTI_AI_STYLE_RULES = [
  '正文默认使用自然段推进，不把 1. 2. 3. 这种列表直接写进正文，除非本来就在写表格或附录。',
  '避免“不是……而是……”“换句话说”“更重要的是”“说到底”等明显 AI 连接句。',
  '普通概念不要乱加引号，只有原话、专有名词、书名或论文名才用引号。',
  '不要写夸张比喻、拟人化修辞、故作姿态的句子，语气保持克制、结实、自然。',
  '段落靠事实和论证自然推进，不靠口号式转折和空泛抽象词撑场面。',
];

const RESEARCH_TRACKS = [
  {
    id: 'general',
    title: '综合研究原始返回',
    status: '正在进行综合研究...',
    track: '综合研究',
    focus:
      '覆盖事件背景、时间线、关键主体、公开动作、争议点与基础事实，不做评价，只保留可核查信息。',
  },
  {
    id: 'quant',
    title: '量化研究原始返回',
    status: '正在进行量化研究...',
    track: '量化研究',
    focus:
      '优先搜集财务数据、业务指标、市场份额、投融资、估值、销量、用户规模和可量化对比。',
  },
  {
    id: 'human',
    title: '人文研究原始返回',
    status: '正在进行人文研究...',
    track: '人文研究',
    focus:
      '优先搜集人物履历、公开表态、组织变化、舆论反应、媒体叙事、员工或用户反馈等公开信息。',
  },
] as const;

const cleanText = (text?: string) => String(text || '').replace(/\r\n/g, '\n').trim();

const truncate = (text: string, limit = MAX_CONTEXT_CHARS) => {
  const normalized = cleanText(text);
  if (!normalized) return '';
  return normalized.length > limit ? `${normalized.slice(0, limit)}\n\n[内容已截断]` : normalized;
};

const sleep = (ms: number) => new Promise((resolve) => globalThis.setTimeout(resolve, ms));

const formatElapsed = (ms: number) => {
  const seconds = Math.max(1, Math.round(ms / 1000));
  const minutes = Math.floor(seconds / 60);
  const restSeconds = seconds % 60;
  return minutes > 0 ? `${minutes}分${restSeconds}秒` : `${seconds}秒`;
};

const stringifyError = (error: unknown): string => {
  if (error instanceof Error) {
    return error.message;
  }

  if (typeof error === 'string') {
    return error;
  }

  if (error && typeof error === 'object') {
    const candidate = error as Record<string, unknown>;
    if (typeof candidate.message === 'string' && candidate.message.trim()) {
      return candidate.message;
    }

    if (candidate.error && typeof candidate.error === 'object') {
      const nested = candidate.error as Record<string, unknown>;
      const parts = [nested.status, nested.code, nested.message]
        .filter((value) => value !== undefined && value !== null)
        .map((value) => String(value).trim())
        .filter(Boolean);
      if (parts.length > 0) {
        return parts.join(' | ');
      }
    }

    try {
      return JSON.stringify(error);
    } catch {
      return String(error);
    }
  }

  return String(error);
};

export const formatRuntimeError = (error: unknown) => stringifyError(error);

const normalizeGenModel = (model?: string | null) => {
  if (!model || model === 'gemini-3.1-pro') {
    return 'gemini-3.1-pro-preview';
  }
  return model;
};

const getSearchModel = () => localStorage.getItem('SEARCH_MODEL') || 'gemini-3.1-flash-lite';
const getGenModel = () => normalizeGenModel(localStorage.getItem('GEN_MODEL'));

const getAiClient = () => {
  const apiKey = localStorage.getItem('GEMINI_API_KEY');
  if (!apiKey) {
    throw new Error('请先输入 Gemini API Key。');
  }
  return new GoogleGenAI({ apiKey });
};

async function callWithRetry<T>(fn: () => Promise<T>, retries = 3, baseDelay = 1500, label = 'request'): Promise<T> {
  let lastError: unknown;

  for (let attempt = 0; attempt < retries; attempt += 1) {
    try {
      if (attempt > 0) {
        console.info(`[${label}] retry ${attempt + 1}/${retries}`);
      }
      return await fn();
    } catch (error) {
      lastError = error;
      if (attempt === retries - 1) {
        break;
      }
      await sleep(baseDelay * Math.pow(2, attempt));
    }
  }

  throw lastError instanceof Error ? lastError : new Error(stringifyError(lastError));
}

const withTimeout = async <T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> => {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return promise;
  }

  return await Promise.race<T>([
    promise,
    new Promise<T>((_, reject) => {
      globalThis.setTimeout(() => {
        reject(new Error(`${label} 超时，${Math.round(timeoutMs / 1000)} 秒内未返回结果。`));
      }, timeoutMs);
    }),
  ]);
};

const runTimedStage = async <T>({
  label,
  statusMessage,
  onStatus,
  work,
  timeoutMs = DEFAULT_STAGE_TIMEOUT_MS,
}: {
  label: string;
  statusMessage: string;
  onStatus?: (message: string) => void;
  work: () => Promise<T>;
  timeoutMs?: number;
}): Promise<T> => {
  const startedAt = Date.now();
  let intervalId: ReturnType<typeof globalThis.setInterval> | null = null;

  onStatus?.(statusMessage);
  console.info(`[${label}] started`, { model: getGenModel(), timeoutMs });

  if (onStatus) {
    intervalId = globalThis.setInterval(() => {
      onStatus(`${statusMessage}（已耗时 ${formatElapsed(Date.now() - startedAt)}）...`);
    }, STAGE_STATUS_INTERVAL_MS);
  }

  try {
    const result = await withTimeout(work(), timeoutMs, label);
    console.info(`[${label}] completed in ${formatElapsed(Date.now() - startedAt)}`);
    return result;
  } catch (error) {
    console.error(`[${label}] failed`, error);
    throw new Error(`${label}失败：${stringifyError(error)}`);
  } finally {
    if (intervalId) {
      globalThis.clearInterval(intervalId);
    }
  }
};

const buildTaskBrief = (topic: string, direction: string, options: WritingTaskOptions) =>
  [
    `写作主题：${topic}`,
    `讨论方向：${direction || '待生成'}`,
    `文体：${options.genre}`,
    `风格：${options.style}`,
    `目标受众：${options.audience}`,
    `文章目标：${options.articleGoal}`,
    `目标字数：约 ${options.desiredLength} 字`,
    `单轮写作长度：约 ${options.chunkLength} 字`,
    `是否生成 TN：${options.includeTeachingNotes ? '是' : '否'}`,
    `是否启用 Deep Research：${options.enableDeepResearch ? '是' : '否'}`,
    options.enableDeepResearch && options.deepResearchPrompt.trim()
      ? `Deep Research 补充要求：${options.deepResearchPrompt.trim()}`
      : '',
  ]
    .filter(Boolean)
    .join('\n');

const buildAntiAiStyleBlock = () =>
  ['反 AI 文风硬约束：', ...ANTI_AI_STYLE_RULES.map((rule, index) => `${index + 1}. ${rule}`)].join('\n');

const buildSystemInstruction = (role: string) =>
  [
    role,
    '你服务于一条商业文章工作流，目标是生成自然、可信、克制、可发布的中文文章。',
    '所有输出默认使用简体中文，除非我明确要求输出 JSON 或英文。',
    '不要把空话、套话、假转折、装饰性比喻和总结腔带进成文。',
    buildAntiAiStyleBlock(),
  ].join('\n\n');

const formatReferenceTemplatesForPrompt = (articles: ReferenceTemplateArticle[]) => {
  if (articles.length === 0) {
    return '当前没有可用的参考模板文章。';
  }

  return articles
    .map((article, index) =>
      [
        `## 模板文章 ${index + 1}`,
        `标题：${article.title}`,
        article.date ? `日期：${article.date}` : '',
        article.genre ? `文体：${article.genre}` : '',
        article.style?.length ? `风格：${article.style.join('、')}` : '',
        article.structurePattern ? `结构模式：${article.structurePattern}` : '',
        article.openingPattern ? `开头方式：${article.openingPattern}` : '',
        article.endingPattern ? `收束方式：${article.endingPattern}` : '',
        article.coreArgument ? `核心观点：${article.coreArgument}` : '',
        article.whySelected ? `本次借鉴点：${article.whySelected}` : '',
        article.summary ? `摘要：${article.summary}` : '',
        article.fullText ? `全文：\n${truncate(article.fullText, 16000)}` : '',
      ]
        .filter(Boolean)
        .join('\n')
    )
    .join('\n\n');
};

const buildUploadParts = (uploadedFiles: UploadedFile[]) => {
  const parts: any[] = [];
  const textFiles = uploadedFiles.filter((file) => file.isText);
  const binaryFiles = uploadedFiles.filter((file) => !file.isText);

  if (textFiles.length > 0) {
    parts.push(
      textFiles
        .slice(0, 6)
        .map((file, index) => `### 用户附件 ${index + 1}：${file.name}\n${truncate(file.data, 12000)}`)
        .join('\n\n')
    );
  }

  binaryFiles.slice(0, 4).forEach((file) => {
    parts.push(`下面附上用户上传的文件：${file.name}`);
    parts.push(createPartFromBase64(file.data, file.mimeType));
  });

  return parts;
};

const extractGroundedSources = (response: GenerateContentResponse, track?: string): SearchSource[] => {
  const candidates = ((response as unknown as { candidates?: any[] }).candidates || []) as any[];
  const chunks = candidates.flatMap((candidate) => candidate?.groundingMetadata?.groundingChunks || []);
  const sources: SearchSource[] = [];
  const seen = new Set<string>();

  for (const chunk of chunks) {
    const webChunk = chunk?.web;
    const uri = String(webChunk?.uri || '').trim();
    if (!uri || seen.has(uri)) continue;
    seen.add(uri);
    sources.push({
      title: String(webChunk?.title || uri),
      uri,
      track,
    });
  }

  return sources;
};

const collectAllSources = (...groups: SearchSource[][]) => {
  const seen = new Set<string>();
  const merged: SearchSource[] = [];

  for (const group of groups) {
    for (const source of group) {
      const key = `${source.track || ''}::${source.uri}`;
      if (!source.uri || seen.has(key)) continue;
      seen.add(key);
      merged.push(source);
    }
  }

  return merged;
};

const ensureReferenceArticles = async (
  topic: string,
  direction: string,
  options: WritingTaskOptions,
  existingArticles?: ReferenceTemplateArticle[]
) => {
  const preferred = Array.isArray(existingArticles) ? existingArticles.slice(0, 3) : [];
  const selected = preferred.length > 0 ? preferred : await selectReferenceTemplates(topic, direction, options);
  return await hydrateReferenceTemplatesWithFullText(selected);
};

const lintStyle = (content: string) => {
  const text = cleanText(content);
  if (!text) {
    return '## 本地风格检查\n- 当前文稿为空。';
  }

  const checks = [
    { label: 'AI 连接句', regex: /(换句话说|更重要的是|说到底|从某种意义上讲|不是.{0,20}而是)/g },
    { label: '口号式判断', regex: /(彻底改写|重新定义|革命性|史诗级|全方位赋能)/g },
    { label: '装饰性引号', regex: /“[^”]{1,12}”/g },
    { label: '装腔比喻', regex: /(战场|赌桌|手术刀|显微镜下|引爆点)/g },
    { label: '列表式正文', regex: /\n\s*(?:\d+\.|[-*+])\s+/g },
  ];

  const findings = checks
    .map(({ label, regex }) => {
      const matches = text.match(regex);
      return matches && matches.length > 0 ? `- ${label}：${matches.length} 处` : '';
    })
    .filter(Boolean);

  return findings.length > 0
    ? ['## 本地风格检查', ...findings].join('\n')
    : '## 本地风格检查\n- 未发现明显的 AI 套话和禁用文风。';
};

const unwrapCodeFence = (text: string) => {
  const candidate = cleanText(text);
  if (!candidate) return '';
  const match = candidate.match(/```(?:json)?\s*([\s\S]*?)```/i);
  return match ? cleanText(match[1]) : candidate;
};

const extractOutlineHeadings = (outline: string) =>
  cleanText(outline)
    .split('\n')
    .map((line) => line.replace(/^#+\s*/, '').trim())
    .filter(Boolean)
    .filter((line) => line.length <= 80)
    .slice(0, 10);

const sanitizeChunkText = (value: unknown, fallback = '') => {
  const text = cleanText(String(value ?? ''));
  if (!text) return fallback;
  return text.length > 120 ? text.slice(0, 120).trim() : text;
};

const normalizeChunkPlan = (raw: unknown, outline: string, options: WritingTaskOptions): WritingChunkPlanItem[] => {
  if (!Array.isArray(raw) || raw.length === 0) {
    const outlineSections = extractOutlineHeadings(outline);
    return [
      {
        index: 1,
        title: '全文',
        sections: outlineSections,
        targetLength: options.desiredLength,
        purpose: '完成整篇正文并自然收束。',
      },
    ];
  }

  const outlineSections = new Set(extractOutlineHeadings(outline));

  return raw
    .map((item, index) => {
      const candidate = item && typeof item === 'object' ? (item as Record<string, unknown>) : {};
      const sections = Array.isArray(candidate.sections)
        ? candidate.sections
            .map((section) => sanitizeChunkText(section))
            .filter(Boolean)
            .filter((section) => outlineSections.size === 0 || outlineSections.has(section) || section.length >= 4)
            .slice(0, 6)
        : [];

      return {
        index: index + 1,
        title: sanitizeChunkText(candidate.title, `第 ${index + 1} 轮写作`),
        sections,
        targetLength: Math.max(300, Math.min(Number(candidate.targetLength) || options.chunkLength, options.desiredLength)),
        purpose: sanitizeChunkText(candidate.purpose, '完成当前轮次负责的正文部分。'),
      };
    })
    .filter((item) => item.title && item.purpose);
};

const buildJsonPrompt = ({
  prompt,
  systemInstruction,
  schema,
  model = getGenModel(),
  uploadedFiles = [],
  tools,
  maxOutputTokens = 8192,
}: {
  prompt: string;
  systemInstruction: string;
  schema: Record<string, unknown>;
  model?: string;
  uploadedFiles?: UploadedFile[];
  tools?: any[];
  maxOutputTokens?: number;
}) =>
  callWithRetry<GenerateContentResponse>(
    () =>
      getAiClient().models.generateContent({
        model,
        contents: [prompt, ...buildUploadParts(uploadedFiles)],
        config: {
          systemInstruction,
          responseMimeType: 'application/json',
          responseSchema: schema,
          temperature: 0.2,
          maxOutputTokens,
          tools,
        },
      }),
    3,
    1500,
    'json-request'
  );

const buildTextPrompt = ({
  prompt,
  systemInstruction,
  model = getGenModel(),
  uploadedFiles = [],
  tools,
  maxOutputTokens = 8192,
}: {
  prompt: string;
  systemInstruction: string;
  model?: string;
  uploadedFiles?: UploadedFile[];
  tools?: any[];
  maxOutputTokens?: number;
}) =>
  callWithRetry<GenerateContentResponse>(
    () =>
      getAiClient().models.generateContent({
        model,
        contents: [prompt, ...buildUploadParts(uploadedFiles)],
        config: {
          systemInstruction,
          temperature: 0.2,
          maxOutputTokens,
          tools,
        },
      }),
    3,
    1500,
    'text-request'
  );

const generateResearchTrack = async ({
  topic,
  uploadedFiles,
  options,
  title,
  track,
  focus,
}: {
  topic: string;
  uploadedFiles: UploadedFile[];
  options: WritingTaskOptions;
  title: string;
  track: string;
  focus: string;
}): Promise<ResearchTrackResult> => {
  const prompt = [
    buildTaskBrief(topic, '待生成', options),
    '你正在为后续写作建立原始资料库。',
    `当前研究轨道：${track}`,
    `本轮重点：${focus}`,
    '要求：',
    '1. 只保留事实、数字、时间点、公开表态、原始说法和可核查争议，不做观点总结。',
    '2. 保留重要来源线索；如果信息不完整，明确写出“待核实”。',
    '3. 直接输出 Markdown。',
    '4. 优先给出时间线、关键主体、关键事实、重要引述和开放问题。',
  ].join('\n\n');

  const response = await buildTextPrompt({
    model: getSearchModel(),
    prompt,
    systemInstruction: buildSystemInstruction(`你是${track}资料员，只负责搜集和整理可核查信息。`),
    uploadedFiles,
    tools: [{ googleSearch: {} } as any],
    maxOutputTokens: 12000,
  });

  return {
    title,
    content: cleanText(response.text),
    sources: extractGroundedSources(response, track),
  };
};

const normalizeStringArray = (value: unknown, fallback: string[] = []) => {
  if (!Array.isArray(value)) return fallback;
  const normalized = value.map((item) => cleanText(String(item || ''))).filter(Boolean);
  return normalized.length > 0 ? normalized.slice(0, 8) : fallback;
};

export const gatherInformation = async (
  topic: string,
  uploadedFiles: UploadedFile[],
  options: WritingTaskOptions,
  onStatus?: (message: string) => void
): Promise<{ ammoLibrary: string; researchDocuments: ResearchDocument[]; sources: SearchSource[] }> => {
  const trackResults: ResearchTrackResult[] = [];

  for (const track of RESEARCH_TRACKS) {
    const result = await runTimedStage({
      label: track.track,
      statusMessage: track.status,
      onStatus,
      timeoutMs: 180000,
      work: () =>
        generateResearchTrack({
          topic,
          uploadedFiles,
          options,
          title: track.title,
          track: track.track,
          focus: track.focus,
        }),
    });
    trackResults.push(result);
  }

  if (options.enableDeepResearch) {
    const deepResearch = await runTimedStage({
      label: 'Deep Research',
      statusMessage: '正在进行 Deep Research 补充研究...',
      onStatus,
      timeoutMs: 240000,
      work: () =>
        generateResearchTrack({
          topic,
          uploadedFiles,
          options,
          title: 'Deep Research 补充返回',
          track: 'Deep Research',
          focus:
            options.deepResearchPrompt.trim() ||
            '补充反向信息、争议材料、容易遗漏的事实链条，以及能提升最终文章密度的公开证据。',
        }),
    });
    trackResults.push(deepResearch);
  }

  const researchDocuments: ResearchDocument[] = trackResults.map((result, index) => ({
    id: `research-${index + 1}`,
    title: result.title,
    content: result.content,
  }));

  const sources = collectAllSources(...trackResults.map((result) => result.sources));
  const ammoLibrary = [
    '# 主题资料库',
    `主题：${topic}`,
    '',
    ...researchDocuments.map((doc) => `## ${doc.title}\n\n${doc.content}`),
    sources.length > 0
      ? ['## 来源清单', ...sources.map((source, index) => `${index + 1}. ${source.title}\n   - ${source.uri}`)].join('\n')
      : '## 来源清单\n\n- 本轮没有抽取到结构化来源，请以原始研究文档为准。',
  ].join('\n\n');

  onStatus?.('正在合并信息资料库...');

  return {
    ammoLibrary: cleanText(ammoLibrary),
    researchDocuments,
    sources,
  };
};

export const generateDiscussionDirections = async (
  topic: string,
  ammoLibrary: string,
  options: WritingTaskOptions
): Promise<string[]> => {
  const prompt = [
    buildTaskBrief(topic, '待生成', options),
    '请基于资料库生成 5 个不同但都能成立的讨论方向。',
    '每个方向都必须是完整中文句子，并体现明确判断、切入角度和展开潜力。',
    '不要只做同义改写，不要生成空泛标题党。',
    '资料库：',
    truncate(ammoLibrary, 100000),
  ].join('\n\n');

  const response = await buildJsonPrompt({
    prompt,
    systemInstruction: buildSystemInstruction('你是商业文章的选题编辑，负责提出差异化讨论方向。'),
    schema: {
      type: Type.ARRAY,
      items: { type: Type.STRING },
    },
  });

  try {
    return normalizeStringArray(JSON.parse(unwrapCodeFence(response.text)), ['请围绕核心争议重新界定文章主问题。']);
  } catch {
    return ['请围绕核心争议重新界定文章主问题。'];
  }
};

export const refineDiscussionDirections = async (
  topic: string,
  ammoLibrary: string,
  options: WritingTaskOptions,
  refinement: string
): Promise<string[]> => {
  const prompt = [
    buildTaskBrief(topic, '待生成', options),
    '请重新生成 5 个讨论方向，但要严格吸收下面这条补充偏好。',
    `补充偏好：${refinement}`,
    '要求：保持差异化，不要只是换几个词。',
    '资料库：',
    truncate(ammoLibrary, 100000),
  ].join('\n\n');

  const response = await buildJsonPrompt({
    prompt,
    systemInstruction: buildSystemInstruction('你是商业文章的选题编辑，负责根据补充偏好重做讨论方向。'),
    schema: {
      type: Type.ARRAY,
      items: { type: Type.STRING },
    },
  });

  try {
    return normalizeStringArray(JSON.parse(unwrapCodeFence(response.text)), ['请围绕补充偏好重做文章主方向。']);
  } catch {
    return ['请围绕补充偏好重做文章主方向。'];
  }
};

export const generateArticleOutline = async (
  topic: string,
  ammoLibrary: string,
  direction: string,
  options: WritingTaskOptions,
  feedback?: string,
  existingOutline?: string
): Promise<OutlineResult> => {
  const referenceArticles = await ensureReferenceArticles(topic, direction, options);
  const referenceBlock = formatReferenceTemplatesForPrompt(referenceArticles);

  const prompt = [
    buildTaskBrief(topic, direction, options),
    '请生成一份适合后续分段写作的商业文章大纲。',
    '要求：',
    '1. 大纲必须能自然写成文章，不要把正文默认写成列表体。',
    '2. 要有明确标题、开头任务、中段推进、尾段收束。',
    '3. 每个大段都要写出承担的论证任务。',
    '4. 结构、节奏和开头方式要参考模板文，但不能套模板句子。',
    feedback ? `本轮修订意见：${feedback}` : '',
    existingOutline ? `当前旧大纲：\n${existingOutline}` : '',
    '参考模板文：',
    referenceBlock,
    '资料库：',
    truncate(ammoLibrary, 120000),
  ]
    .filter(Boolean)
    .join('\n\n');

  const response = await buildTextPrompt({
    prompt,
    systemInstruction: buildSystemInstruction('你是商业文章结构编辑，负责设计能直接进入写作的大纲。'),
    maxOutputTokens: 8000,
  });

  return {
    outline: cleanText(response.text),
    referenceArticles,
  };
};

const generateWritingInsights = async (
  topic: string,
  ammoLibrary: string,
  direction: string,
  outline: string,
  options: WritingTaskOptions,
  referenceArticles: ReferenceTemplateArticle[]
) => {
  const prompt = [
    buildTaskBrief(topic, direction, options),
    '请生成一份简短但高价值的 writing_insights.md。',
    '必须包含：任务画像、模板借鉴、最重要的 5 条写作规则、需要避开的文风风险。',
    '控制在 800-1200 字之间。',
    '参考模板文：',
    formatReferenceTemplatesForPrompt(referenceArticles),
    '资料库：',
    truncate(ammoLibrary, 100000),
    '当前大纲：',
    outline,
  ].join('\n\n');

  const response = await buildTextPrompt({
    prompt,
    systemInstruction: buildSystemInstruction('你是写作方法编辑，负责把本次写作的方法论压缩成可执行指令。'),
    maxOutputTokens: 5000,
  });

  return cleanText(response.text);
};

const generateEvidenceCards = async (
  topic: string,
  ammoLibrary: string,
  direction: string,
  outline: string,
  options: WritingTaskOptions,
  referenceArticles: ReferenceTemplateArticle[]
) => {
  const prompt = [
    buildTaskBrief(topic, direction, options),
    '请把资料库整理为 evidence_cards.md。',
    '要求：只保留与当前方向直接相关的事实、数据、案例、争议和可引用说法，方便后续写作调用。',
    '可以分组，但不要写成长文。',
    '参考模板文：',
    formatReferenceTemplatesForPrompt(referenceArticles),
    '当前大纲：',
    outline,
    '资料库：',
    truncate(ammoLibrary, 120000),
  ].join('\n\n');

  const response = await buildTextPrompt({
    prompt,
    systemInstruction: buildSystemInstruction('你是证据整理编辑，负责把资料压缩为可直接调用的证据卡片。'),
    maxOutputTokens: 7000,
  });

  return cleanText(response.text);
};

const buildChunkPlan = async (
  topic: string,
  direction: string,
  outline: string,
  options: WritingTaskOptions,
  referenceArticles: ReferenceTemplateArticle[]
) => {
  const expectedChunks = Math.max(1, Math.ceil(options.desiredLength / Math.max(600, options.chunkLength)));
  const prompt = [
    buildTaskBrief(topic, direction, options),
    `请把这份大纲拆成 ${expectedChunks} 个左右的写作 chunk。`,
    '每个 chunk 返回：title、sections、targetLength、purpose。',
    'sections 只能写大纲里真实存在的小节名。',
    'purpose 必须是一句正常中文，说明本轮写作要解决什么。',
    '只输出 JSON 数组。',
    '参考模板文：',
    formatReferenceTemplatesForPrompt(referenceArticles),
    '大纲：',
    outline,
  ].join('\n\n');

  const response = await buildJsonPrompt({
    prompt,
    systemInstruction: buildSystemInstruction('你是写作调度编辑，负责把大纲拆成稳定、可续写的 chunk。'),
    schema: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          title: { type: Type.STRING },
          sections: { type: Type.ARRAY, items: { type: Type.STRING } },
          targetLength: { type: Type.INTEGER },
          purpose: { type: Type.STRING },
        },
      },
    },
  });

  try {
    return normalizeChunkPlan(JSON.parse(unwrapCodeFence(response.text)), outline, options);
  } catch {
    return normalizeChunkPlan([], outline, options);
  }
};

const generateChunk = async ({
  topic,
  direction,
  outline,
  ammoLibrary,
  writingInsights,
  evidenceCards,
  referenceArticles,
  options,
  chunk,
  previousText,
}: {
  topic: string;
  direction: string;
  outline: string;
  ammoLibrary: string;
  writingInsights: string;
  evidenceCards: string;
  referenceArticles: ReferenceTemplateArticle[];
  options: WritingTaskOptions;
  chunk: WritingChunkPlanItem;
  previousText: string;
}) => {
  const prompt = [
    buildTaskBrief(topic, direction, options),
    `当前 chunk：${chunk.index}`,
    `当前 chunk 标题：${chunk.title}`,
    `负责小节：${chunk.sections.join('、') || '未指定'}`,
    `当前 chunk 目标长度：约 ${chunk.targetLength} 字`,
    `当前 chunk 任务：${chunk.purpose}`,
    previousText
      ? `已写正文长度约 ${previousText.length} 字。请只续写尚未完成的部分，不要重复前文。`
      : '这是首轮写作，请直接进入标题和开篇。',
    '要求：',
    '1. 全文使用简体中文。',
    '2. 不要重复前文观点和段落。',
    '3. 不要使用明显 AI 套话和装饰性修辞。',
    '4. 句子要自然，段落要推进，不要把正文写成条列。',
    '5. 本轮只完成分配给你的部分，不要抢写后文。',
    '6. 参考模板文的节奏、密度和气质，但不要照抄模板句子。',
    '参考模板文：',
    formatReferenceTemplatesForPrompt(referenceArticles),
    'writing_insights.md：',
    writingInsights,
    'evidence_cards.md：',
    evidenceCards,
    '资料库：',
    truncate(ammoLibrary, 100000),
    '大纲：',
    outline,
    previousText ? `已写正文：\n${truncate(previousText, 12000)}` : '',
  ]
    .filter(Boolean)
    .join('\n\n');

  const response = await buildTextPrompt({
    prompt,
    systemInstruction: buildSystemInstruction('你是商业文章作者，负责按 chunk 计划续写正文。'),
    maxOutputTokens: 9000,
  });

  return cleanText(response.text);
};

const normalizeEditorialStrategy = (
  value: unknown,
  passIndex: number,
  majorRevisionUsed: boolean
): EditorialStrategy => {
  const normalized = cleanText(String(value || '')).toLowerCase();
  if (normalized === 'done') return 'done';
  if (normalized === 'sectional') return 'sectional';
  if (normalized === 'surgical') return 'surgical';
  if (normalized === 'rewrite' && passIndex === 1 && !majorRevisionUsed) return 'rewrite';
  return passIndex === 1 && !majorRevisionUsed ? 'sectional' : 'surgical';
};

const normalizeEditorialIssues = (value: unknown): EditorialIssue[] => {
  if (!Array.isArray(value)) return [];

  return value
    .map((item, index) => {
      const candidate = item && typeof item === 'object' ? (item as Record<string, unknown>) : {};
      return {
        severity: sanitizeChunkText(candidate.severity, 'medium'),
        scope: sanitizeChunkText(candidate.scope, 'paragraph'),
        title: sanitizeChunkText(candidate.title, `问题 ${index + 1}`),
        diagnosis: sanitizeChunkText(candidate.diagnosis, ''),
        instruction: sanitizeChunkText(candidate.instruction, ''),
        excerpt: sanitizeChunkText(candidate.excerpt, ''),
      };
    })
    .filter((issue) => issue.instruction)
    .slice(0, MAGAZINE_MAX_ISSUES_PER_PASS);
};

const normalizeEditorialReviewReport = (
  raw: unknown,
  passIndex: number,
  majorRevisionUsed: boolean
): EditorialReviewReport => {
  const candidate = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const issues = normalizeEditorialIssues(candidate.issues);
  const strategy = normalizeEditorialStrategy(candidate.strategy, passIndex, majorRevisionUsed);
  const readyValue = cleanText(String(candidate.ready || ''));
  const ready =
    /^(yes|true|ready|done)$/i.test(readyValue) || (issues.length === 0 && strategy === 'done') ? 'yes' : 'no';

  return {
    summary: sanitizeChunkText(candidate.summary, issues.length > 0 ? '仍有未解决的编辑问题。' : '文稿已接近可发布状态。'),
    ready,
    strategy: ready === 'yes' ? 'done' : strategy,
    templateAlignment: sanitizeChunkText(candidate.templateAlignment, '与模板文的贴合度仍可继续优化。'),
    unresolvedRisk: sanitizeChunkText(candidate.unresolvedRisk, issues.length > 0 ? '仍有残余文风或结构风险。' : '未发现明显残余风险。'),
    issues,
  };
};

const formatEditorialHistoryForPrompt = (history: EditorialReviewReport[]) => {
  if (history.length === 0) {
    return '此前还没有进行过终审。';
  }

  return history
    .map((review, index) => {
      const issueTitles = review.issues.map((issue) => issue.title).join(' | ') || '无';
      return `第 ${index + 1} 轮：strategy=${review.strategy}; summary=${review.summary}; issues=${issueTitles}`;
    })
    .join('\n');
};

const formatEditorialReviewMarkdown = (review: EditorialReviewReport, passIndex: number) => {
  const issueLines =
    review.issues.length > 0
      ? review.issues
          .map((issue, index) =>
            [
              `### 问题 ${index + 1}：${issue.title}`,
              `- 严重度：${issue.severity}`,
              `- 范围：${issue.scope}`,
              issue.excerpt ? `- 触发片段：${issue.excerpt}` : '',
              issue.diagnosis ? `- 诊断：${issue.diagnosis}` : '',
              `- 修改指令：${issue.instruction}`,
            ]
              .filter(Boolean)
              .join('\n')
          )
          .join('\n\n')
      : '- 本轮未发现新的阻塞问题。';

  return [
    `## 终审第 ${passIndex} 轮`,
    `- 总体判断：${review.summary}`,
    `- 当前策略：${review.strategy}`,
    `- 是否可发：${review.ready}`,
    `- 模板贴合：${review.templateAlignment}`,
    `- 残余风险：${review.unresolvedRisk}`,
    '',
    '### 未解决问题',
    issueLines,
  ].join('\n');
};

const reviewArticleEditorialPass = async ({
  topic,
  direction,
  outline,
  ammoLibrary,
  draft,
  writingInsights,
  evidenceCards,
  options,
  referenceArticles,
  passIndex,
  reviewHistory,
  majorRevisionUsed,
}: {
  topic: string;
  direction: string;
  outline: string;
  ammoLibrary: string;
  draft: string;
  writingInsights: string;
  evidenceCards: string;
  options: WritingTaskOptions;
  referenceArticles: ReferenceTemplateArticle[];
  passIndex: number;
  reviewHistory: EditorialReviewReport[];
  majorRevisionUsed: boolean;
}): Promise<EditorialReviewReport> => {
  const prompt = [
    buildTaskBrief(topic, direction, options),
    `你现在是顶级商业杂志的终审编辑。这是第 ${passIndex} / ${MAGAZINE_EDITORIAL_MAX_PASSES} 轮终审。`,
    passIndex === 1
      ? '如果结构、文风、叙述推进都明显失衡，你可以允许一次大改。'
      : '从第二轮开始，不允许再次要求整篇重写，只保留尚未解决的问题，并优先做局部或句级修改。',
    '你必须把当前稿件与参考模板文直接对比，重点检查：开头节奏、段落推进、信息密度、语气统一、遣词克制、是否自然。',
    '这是渐进式审稿。如果前一轮已经解决的问题，本轮不要重复提出。',
    `最多返回 ${MAGAZINE_MAX_ISSUES_PER_PASS} 个当前真正阻塞发布的问题。`,
    '返回 JSON 对象，字段为：summary, ready, strategy, templateAlignment, unresolvedRisk, issues。',
    'strategy 只能是 rewrite、sectional、surgical、done。',
    'issues 中每项必须含有：severity, scope, title, diagnosis, instruction, excerpt。',
    '输出内容使用简体中文。',
    '此前终审记录：',
    formatEditorialHistoryForPrompt(reviewHistory),
    '参考模板文：',
    formatReferenceTemplatesForPrompt(referenceArticles),
    'writing_insights.md：',
    writingInsights,
    'evidence_cards.md：',
    evidenceCards,
    '本地风格检查：',
    lintStyle(draft),
    '资料库：',
    truncate(ammoLibrary, 100000),
    '大纲：',
    outline,
    '当前稿件：',
    truncate(draft, MAX_DRAFT_CHARS),
  ].join('\n\n');

  const response = await buildJsonPrompt({
    prompt,
    systemInstruction: buildSystemInstruction('你是杂志级终审编辑，只保留本轮仍未解决的问题。'),
    schema: {
      type: Type.OBJECT,
      properties: {
        summary: { type: Type.STRING },
        ready: { type: Type.STRING },
        strategy: { type: Type.STRING },
        templateAlignment: { type: Type.STRING },
        unresolvedRisk: { type: Type.STRING },
        issues: {
          type: Type.ARRAY,
          items: {
            type: Type.OBJECT,
            properties: {
              severity: { type: Type.STRING },
              scope: { type: Type.STRING },
              title: { type: Type.STRING },
              diagnosis: { type: Type.STRING },
              instruction: { type: Type.STRING },
              excerpt: { type: Type.STRING },
            },
          },
        },
      },
    },
    maxOutputTokens: 5000,
  });

  try {
    return normalizeEditorialReviewReport(JSON.parse(unwrapCodeFence(response.text)), passIndex, majorRevisionUsed);
  } catch {
    return normalizeEditorialReviewReport({}, passIndex, majorRevisionUsed);
  }
};

const reviseArticleEditorialPass = async ({
  topic,
  direction,
  outline,
  ammoLibrary,
  writingInsights,
  evidenceCards,
  referenceArticles,
  draft,
  review,
  revisionMode,
  passIndex,
  options,
}: {
  topic: string;
  direction: string;
  outline: string;
  ammoLibrary: string;
  writingInsights: string;
  evidenceCards: string;
  referenceArticles: ReferenceTemplateArticle[];
  draft: string;
  review: EditorialReviewReport;
  revisionMode: EditorialStrategy;
  passIndex: number;
  options: WritingTaskOptions;
}) => {
  const revisionInstruction =
    revisionMode === 'rewrite'
      ? '这一轮允许一次大改，但必须建立在当前稿件基础上，保留有效事实和核心判断。'
      : revisionMode === 'sectional'
        ? '这一轮只能做局部段落级修订，只改有问题的部分，其余段落保持稳定。'
        : '这一轮只能做句级或短段级手术式修改；一句能解决，就不要整段重写。';

  const prompt = [
    buildTaskBrief(topic, direction, options),
    `这是第 ${passIndex} 轮修订。`,
    revisionInstruction,
    '硬性要求：',
    '1. 修的是当前稿件，不是另起一篇。',
    '2. 不要新增资料库和当前稿件之外的事实。',
    '3. 保持简体中文。',
    '4. 用参考模板文统一语气、段落密度和开头节奏。',
    '5. 只解决下列仍未解决的问题，不要打扰已经成立的段落。',
    revisionMode === 'rewrite'
      ? '6. 如有必要可以重排结构，但要保留核心论点和可用材料。'
      : '6. 除非问题明确要求，否则保留当前标题、结构与段落顺序。',
    '终审意见：',
    formatEditorialReviewMarkdown(review, passIndex),
    '参考模板文：',
    formatReferenceTemplatesForPrompt(referenceArticles),
    'writing_insights.md：',
    writingInsights,
    'evidence_cards.md：',
    evidenceCards,
    '资料库：',
    truncate(ammoLibrary, 100000),
    '大纲：',
    outline,
    '当前稿件：',
    truncate(draft, MAX_DRAFT_CHARS),
    '只输出修订后的完整文章。',
  ].join('\n\n');

  const response = await buildTextPrompt({
    prompt,
    systemInstruction: buildSystemInstruction('你是杂志级修订编辑，负责渐进式修文而不是反复重写。'),
    maxOutputTokens: 12000,
  });

  return cleanText(response.text);
};

const generateTeachingNotes = async (
  topic: string,
  direction: string,
  articleContent: string,
  options: WritingTaskOptions,
  referenceArticles: ReferenceTemplateArticle[]
) => {
  const prompt = [
    buildTaskBrief(topic, direction, options),
    '请基于成文生成一份可选的 TN / 讨论指南。',
    '内容包含：适用场景、核心讨论问题、可用板书结构、课堂上需要提醒的风险。',
    '直接输出 Markdown。',
    '参考模板文：',
    formatReferenceTemplatesForPrompt(referenceArticles),
    '正文：',
    truncate(articleContent, 12000),
  ].join('\n\n');

  const response = await buildTextPrompt({
    prompt,
    systemInstruction: buildSystemInstruction('你是商学院教学指南编辑，只在需要时生成 TN。'),
    maxOutputTokens: 6000,
  });

  return cleanText(response.text);
};

export const generateArticlePackage = async (
  topic: string,
  ammoLibrary: string,
  direction: string,
  outline: string,
  referenceArticles: ReferenceTemplateArticle[],
  options: WritingTaskOptions,
  onStatus?: (message: string) => void
): Promise<ArticlePackageResult> => {
  const hydratedReferenceArticles = await runTimedStage({
    label: '参考模板装载',
    statusMessage: '正在装载参考模板全文...',
    onStatus,
    timeoutMs: 120000,
    work: () => ensureReferenceArticles(topic, direction, options, referenceArticles),
  });

  const writingInsights = await runTimedStage({
    label: '写作方法提炼',
    statusMessage: '正在提炼本次写作方法...',
    onStatus,
    timeoutMs: 150000,
    work: () =>
      generateWritingInsights(topic, ammoLibrary, direction, outline, options, hydratedReferenceArticles),
  });

  const evidenceCards = await runTimedStage({
    label: '证据卡整理',
    statusMessage: '正在整理证据卡...',
    onStatus,
    timeoutMs: 150000,
    work: () =>
      generateEvidenceCards(topic, ammoLibrary, direction, outline, options, hydratedReferenceArticles),
  });

  const chunkPlan = await runTimedStage({
    label: '分段写作规划',
    statusMessage: '正在规划分段写作...',
    onStatus,
    timeoutMs: 150000,
    work: () => buildChunkPlan(topic, direction, outline, options, hydratedReferenceArticles),
  });

  const chunks: string[] = [];
  for (const chunk of chunkPlan) {
    const previousText = chunks.join('\n\n');
    const chunkText = await runTimedStage({
      label: `正文写作 ${chunk.index}/${chunkPlan.length}`,
      statusMessage: `正在写作第 ${chunk.index}/${chunkPlan.length} 段...`,
      onStatus,
      timeoutMs: 240000,
      work: () =>
        generateChunk({
          topic,
          direction,
          outline,
          ammoLibrary,
          writingInsights,
          evidenceCards,
          referenceArticles: hydratedReferenceArticles,
          options,
          chunk,
          previousText,
        }),
    });
    chunks.push(chunkText);
  }

  const draft = cleanText(chunks.join('\n\n'));
  let articleWorkingDraft = draft;
  let majorRevisionUsed = false;
  const reviewHistory: EditorialReviewReport[] = [];

  for (let passIndex = 1; passIndex <= MAGAZINE_EDITORIAL_MAX_PASSES; passIndex += 1) {
    const review = await runTimedStage({
      label: `终稿审校 ${passIndex}/${MAGAZINE_EDITORIAL_MAX_PASSES}`,
      statusMessage: `正在进行第 ${passIndex} 轮终稿审校...`,
      onStatus,
      timeoutMs: 180000,
      work: () =>
        reviewArticleEditorialPass({
          topic,
          direction,
          outline,
          ammoLibrary,
          draft: articleWorkingDraft,
          writingInsights,
          evidenceCards,
          options,
          referenceArticles: hydratedReferenceArticles,
          passIndex,
          reviewHistory,
          majorRevisionUsed,
        }),
    });

    reviewHistory.push(review);

    if (review.ready === 'yes' || review.strategy === 'done' || review.issues.length === 0) {
      break;
    }

    const revisionMode = normalizeEditorialStrategy(review.strategy, passIndex, majorRevisionUsed);
    if (revisionMode === 'rewrite') {
      majorRevisionUsed = true;
    }

    articleWorkingDraft = await runTimedStage({
      label: `终稿修订 ${passIndex}/${MAGAZINE_EDITORIAL_MAX_PASSES}`,
      statusMessage: `正在执行第 ${passIndex} 轮终稿修订（${revisionMode}）...`,
      onStatus,
      timeoutMs: 240000,
      work: () =>
        reviseArticleEditorialPass({
          topic,
          direction,
          outline,
          ammoLibrary,
          writingInsights,
          evidenceCards,
          referenceArticles: hydratedReferenceArticles,
          draft: articleWorkingDraft,
          review,
          revisionMode,
          passIndex,
          options,
        }),
    });
  }

  const critique = `${reviewHistory
    .map((review, index) => formatEditorialReviewMarkdown(review, index + 1))
    .join('\n\n')}\n\n`;

  const articleContent = await runTimedStage({
    label: '句级终修',
    statusMessage: '正在做最后的句级收束...',
    onStatus,
    timeoutMs: 180000,
    work: () => runFinalPolish(ammoLibrary, articleWorkingDraft, undefined, undefined, hydratedReferenceArticles),
  });

  let teachingNotes = '';
  if (options.includeTeachingNotes) {
    teachingNotes = await runTimedStage({
      label: 'TN 生成',
      statusMessage: '正在生成 TN / 讨论指南...',
      onStatus,
      timeoutMs: 180000,
      work: () => generateTeachingNotes(topic, direction, articleContent, options, hydratedReferenceArticles),
    });
  }

  return {
    referenceArticles: hydratedReferenceArticles,
    writingInsights,
    evidenceCards,
    chunkPlan,
    critique,
    articleContent,
    teachingNotes,
  };
};

export const chatWithEditor = async (
  ammoLibrary: string,
  articleContent: string,
  teachingNotes: string,
  chatHistory: { role: string; parts: { text: string }[] }[],
  userMessage: string
): Promise<ChatResponse> => {
  const prompt = [
    '当前资料库：',
    truncate(ammoLibrary, 100000),
    '当前正文：',
    truncate(articleContent, 12000),
    teachingNotes ? `当前 TN / 讨论指南：\n${truncate(teachingNotes, 8000)}` : '当前没有 TN / 讨论指南。',
    '请返回一个 JSON 对象，字段如下：',
    'reply: 直接回复用户',
    'action: "reply" 或 "refine"',
    'target: "article" 或 "notes"',
    'instruction: 如果 action 是 refine，则给出明确编辑指令，否则留空',
  ].join('\n\n');

  const response = await callWithRetry<GenerateContentResponse>(
    () =>
      getAiClient().models.generateContent({
        model: getGenModel(),
        contents: [
          {
            role: 'user',
            parts: [{ text: prompt }],
          },
          ...chatHistory,
          {
            role: 'user',
            parts: [{ text: userMessage }],
          },
        ],
        config: {
          systemInstruction: buildSystemInstruction(
            '你是写作 Copilot。回复要简洁；如果用户明显在要求修改，就把动作转成 refine 指令。'
          ),
          responseMimeType: 'application/json',
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              reply: { type: Type.STRING },
              action: { type: Type.STRING },
              target: { type: Type.STRING },
              instruction: { type: Type.STRING },
            },
          },
          temperature: 0.2,
          maxOutputTokens: 2000,
        },
      }),
    3,
    1500,
    'copilot-chat'
  );

  try {
    const parsed = JSON.parse(unwrapCodeFence(response.text)) as Record<string, unknown>;
    if (parsed.action === 'refine' && cleanText(String(parsed.instruction || ''))) {
      return {
        text: cleanText(String(parsed.reply || '收到，我将调用深度编辑流程。')),
        refinementRequest: {
          target: parsed.target === 'notes' ? 'notes' : 'article',
          instruction: cleanText(String(parsed.instruction || '')),
        },
      };
    }

    return { text: cleanText(String(parsed.reply || '收到。')) };
  } catch {
    return { text: '编辑 Copilot 暂时没有返回可解析结果，请稍后再试。' };
  }
};

export const refineTextBySelection = async (
  ammoLibrary: string,
  fullText: string,
  selection: string,
  instruction: string
): Promise<string> => {
  const prompt = [
    '你只修改用户选中的那一小段内容，其余内容保持不变。',
    '资料库：',
    truncate(ammoLibrary, 100000),
    '全文：',
    fullText,
    `选中文本：${selection}`,
    `修改要求：${instruction}`,
    '输出修改后的完整文档。',
  ].join('\n\n');

  const response = await buildTextPrompt({
    prompt,
    systemInstruction: buildSystemInstruction('你是精确编辑器，只重写被选中的部分。'),
    maxOutputTokens: 12000,
  });

  return cleanText(response.text);
};

export const refineContent = async (
  ammoLibrary: string,
  fullMarkdown: string,
  instruction: string,
  selectedText?: string,
  onProgress?: (message: string) => void,
  checkStop?: () => boolean
): Promise<string> => {
  if (checkStop?.()) {
    throw new Error('STOPPED');
  }

  onProgress?.(selectedText ? '正在按选中片段执行精修...' : '正在根据编辑要求修订全文...');

  const prompt = [
    selectedText
      ? '请只修改指定片段，并保持全文其他部分不变。'
      : '请根据全局编辑要求修订全文，并尽量保留有效信息密度。',
    buildAntiAiStyleBlock(),
    `编辑要求：${instruction}`,
    selectedText ? `指定片段：${selectedText}` : '',
    '资料库：',
    truncate(ammoLibrary, 100000),
    '全文：',
    truncate(fullMarkdown, MAX_DRAFT_CHARS),
    selectedText
      ? '输出修改后的完整文档，优先做局部修改。'
      : '输出修订后的完整文档；如果问题已经局部化，就不要整篇重写。',
  ]
    .filter(Boolean)
    .join('\n\n');

  const response = await buildTextPrompt({
    prompt,
    systemInstruction: buildSystemInstruction('你是商业文章编辑，负责执行用户指定的局部或全局修订。'),
    maxOutputTokens: 12000,
  });

  if (checkStop?.()) {
    throw new Error('STOPPED');
  }

  return cleanText(response.text);
};

export const runFinalPolish = async (
  ammoLibrary: string,
  content: string,
  onProgress?: (message: string) => void,
  checkStop?: () => boolean,
  referenceArticles: ReferenceTemplateArticle[] = []
): Promise<string> => {
  if (checkStop?.()) {
    throw new Error('STOPPED');
  }

  onProgress?.('正在做终稿句级精修...');
  const referenceTemplateBlock = formatReferenceTemplatesForPrompt(referenceArticles);

  const prompt = [
    buildAntiAiStyleBlock(),
    '你是发稿前最后一位 line editor。',
    '这不是重写轮次，只允许做句级和短语级精修。',
    '请对照参考模板文，把当前文稿的语气、节奏、克制程度和自然度收紧到同一水准。',
    '渐进式修订规则：',
    '1. 保留标题、段落顺序和整体结构，除非极小的局部调整必不可少。',
    '2. 如果一个短语能解决问题，就不要整句改。',
    '3. 如果一句话能解决问题，就不要整段改。',
    '4. 不要重新打开前几轮已经解决的问题。',
    '5. 不要添加资料库和当前文稿之外的新事实、新论点和新例子。',
    '6. 只清理残余的 AI 腔、假转折、空泛抽象词、装饰性标点和不自然的引号表达。',
    '7. 输出修订后的完整文稿。',
    '本地风格检查：',
    lintStyle(content),
    '资料库：',
    truncate(ammoLibrary, 100000),
    '参考模板文：',
    referenceTemplateBlock,
    '当前文稿：',
    truncate(content, MAX_DRAFT_CHARS),
  ].join('\n\n');

  const response = await buildTextPrompt({
    prompt,
    systemInstruction: buildSystemInstruction('你是杂志级 line editor，只做最小必要修改，让文稿达到可发布状态。'),
    maxOutputTokens: 12000,
  });

  if (checkStop?.()) {
    throw new Error('STOPPED');
  }

  return cleanText(response.text);
};
