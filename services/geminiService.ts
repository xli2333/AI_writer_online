import { FinishReason, GenerateContentResponse, GoogleGenAI, Type, createPartFromBase64 } from '@google/genai';
import type { Interaction, InteractionSSEEvent } from '@google/genai';
import {
  WorkflowResumeAction,
  WorkflowSnapshotType,
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
import { loadRuntimePromptAssets } from './backendContentService';
import { getRuntimeSubPersonaDescriptor, resolveRuntimeSubPersona } from './stylePersonaUtils';

const MAX_CONTEXT_CHARS = 180000;
const MAX_DRAFT_CHARS = 18000;
const TEXT_CONTINUATION_MAX_ROUNDS = 2;
const TEXT_CONTINUATION_TAIL_CHARS = 4000;
const DEFAULT_STAGE_TIMEOUT_MS = 180000;
const STAGE_STATUS_INTERVAL_MS = 5000;
const LINE_POLISH_TIMEOUT_MS = 300000;
const MAGAZINE_EDITORIAL_MAX_PASSES = 3;
const MAGAZINE_MAX_ISSUES_PER_PASS = 6;
const COMMERCIAL_HUMANIZER_MAX_ISSUES = 8;
const TARGET_ARTICLE_H2_MIN = 3;
const TARGET_ARTICLE_H2_MAX = 6;
const DEEP_RESEARCH_POLL_INTERVAL_MS = 10000;
const DEEP_RESEARCH_POLL_TIMEOUT_MS = 15 * 60 * 1000;
const DEEP_RESEARCH_STAGE_TIMEOUT_MS = 30 * 60 * 1000;

type EditorialStrategy = 'structure_tune' | 'continuity_tune' | 'micro_polish' | 'done';

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

interface CommercialHumanizerIssue {
  category: string;
  severity: string;
  title: string;
  diagnosis: string;
  instruction: string;
  excerpt: string;
}

interface CommercialHumanizerReport {
  summary: string;
  ready: string;
  toneGuardrail: string;
  unresolvedRisk: string;
  issues: CommercialHumanizerIssue[];
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
  chunkDrafts: string[];
  assembledDraft?: string;
  workingArticleDraft?: string;
  critique: string;
  articleContent: string;
  teachingNotes: string;
}

interface CompletedTextResult {
  text: string;
  response: GenerateContentResponse;
}

const formatDurationLabel = (durationMs: number) => {
  const totalSeconds = Math.max(1, Math.round(durationMs / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;

  if (minutes <= 0) {
    return `${seconds} 秒`;
  }

  if (seconds === 0) {
    return `${minutes} 分钟`;
  }

  return `${minutes} 分 ${seconds} 秒`;
};

export interface ArticleProgressSnapshot {
  type: WorkflowSnapshotType;
  label: string;
  description: string;
  resumeAction: WorkflowResumeAction;
  sourceChunkIndex?: number;
  data: Partial<ArticlePackageResult>;
}

export interface ChatResponse {
  text: string;
  refinementRequest?: {
    target: 'article' | 'notes';
    instruction: string;
  };
}

const DEFAULT_MASTER_PERSONA = [
  '你服务于一条商业文章工作流，目标是生成自然、可信、克制、可发布的中文文章。',
  '所有输出默认使用简体中文，除非我明确要求输出 JSON 或英文。',
  '不要把空话、套话、假转折、装饰性比喻和总结腔带进成文。',
].join('\n\n');

const DEFAULT_ANTI_AI_STYLE_RULES = [
  '去 AI 化不等于口语化或随笔化，商业文章仍然保持客观、分析型、克制。',
  '正文默认使用自然段推进，不把 1. 2. 3. 这种列表直接写进正文，除非本来就在写表格或附录。',
  '避免“不是……而是……”“换句话说”“更重要的是”“说到底”等明显 AI 连接句。',
  '普通概念不要乱加引号，只有原话、专有名词、书名或论文名才用引号。',
  '不要写“注脚”“脚注”这类明显生成式解释腔词，正文里直接完成表达，不要自我标注。',
  '不要写夸张比喻、拟人化修辞、故作姿态的句子，语气保持克制、结实、自然。',
  '段落靠事实和论证自然推进，不靠口号式转折和空泛抽象词撑场面。',
  '少用“赋能”“闭环”“抓手”“底层逻辑”“范式迁移”等万能商业黑话，优先写具体动作和判断。',
  '不要因为追求“像人”就插入第一人称抒情、聊天腔、网络梗或故意制造凌乱。',
  '结尾不要做万能积极收束，回到文中已经建立的判断即可。',
];

const DEFAULT_COMMERCIAL_HUMANIZER_RULES = [
  '去AI化的目标是清理生成式痕迹，不是把商业文章改成口语贴、随笔、访谈口播稿或鸡汤文。',
  '保持商业杂志式语体：判断明确、证据先行、语气克制、段落自然推进，不额外制造“人味表演”。',
  '优先清理模板化连接句、空泛总结句、宣传腔黑话、过度工整排比、伪洞察句、聊天式客套和装饰性标点。',
  '把“赋能、闭环、抓手、底层逻辑、范式迁移、重新定义、颠覆式”这类黑话尽量还原成具体动作、事实或判断。',
  '把“有人认为、业内普遍认为、越来越多人意识到”这类模糊主体改成明确主体，或直接删除。',
  '结尾只允许回到文章已经论证过的判断，不补“未来已来”“值得每个人思考”这类万能积极收束。',
];

const DEFAULT_COMMERCIAL_HUMANIZER_PATTERN_GROUPS = [
  '内容模式：夸大意义、知名度堆砌、宣传语言、模糊归因、公式化“挑战/未来展望”段落。',
  '语言模式：AI 高频词、系动词回避、否定式排比、三段式罗列、刻意换词、虚假范围。',
  '版式模式：破折号过多、粗体过多、内联标题列表、emoji、英文弯引号。',
  '对话痕迹：协作式套话、知识截止免责声明、谄媚语气、填充短语、过度限定、通用积极结论。',
];

const DEFAULT_COMMERCIAL_HUMANIZER_QUICK_CHECKS = [
  '连续三个句子长度和结构是否过于整齐。',
  '是否出现“此外/然而/值得注意的是/综上所述”等机械连接词。',
  '是否存在“挑战与未来展望”式公式段落或万能收尾句。',
  '是否出现破折号揭示句、加粗标题列表、emoji、聊天式客套。',
  '是否写出“注脚”“脚注”这类生成式解释词，或用它们假装补充说明。',
  '是否用模糊主体、黑话或抽象大词代替具体事实和动作。',
];

const MARKDOWN_TABLE_STYLE_RULE =
  '当对比维度、参数、时间线或多项数据用表格比散文更清晰时，可以在正文中使用简洁的 Markdown 表格，不要为了“像文章”强行改写成散文。';
const MARKDOWN_TABLE_FORMAT_RULE =
  '如果使用表格，只用标准 Markdown 表格语法，尽量控制在 2-5 列，单元格用短语或短句，不要把整段大段落塞进表格。';
const MARKDOWN_TABLE_PRESERVE_RULE =
  '已有的 Markdown 表格如果确实承载了对比、参数或数据信息，就保留表格结构，不要在终审或去 AI 化时把它强行打散成散文。';

const appendUniqueRules = (rules: string[], additions: string[]) => {
  const nextRules = [...rules];
  additions.forEach((rule) => {
    if (!nextRules.includes(rule)) {
      nextRules.push(rule);
    }
  });
  return nextRules;
};

let runtimeMasterPersona = DEFAULT_MASTER_PERSONA;
let runtimeAntiAiStyleRules = [...DEFAULT_ANTI_AI_STYLE_RULES];
let runtimeCommercialHumanizerRules = [...DEFAULT_COMMERCIAL_HUMANIZER_RULES];
let runtimeCommercialHumanizerPatterns = [...DEFAULT_COMMERCIAL_HUMANIZER_PATTERN_GROUPS];
let runtimeCommercialHumanizerQuickChecks = [...DEFAULT_COMMERCIAL_HUMANIZER_QUICK_CHECKS];
let runtimeProfileAntiPatterns = '';
let runtimeSubPersonaAssets: Record<string, string> = {};
let runtimeInstructionOptions: WritingTaskOptions | undefined;
let runtimePromptAssetsPromise: Promise<void> | null = null;
let runtimePromptAssetsProfile = '';

const parsePromptRuleLines = (content?: string) =>
  String(content || '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

const setRuntimeInstructionOptions = (options?: WritingTaskOptions) => {
  runtimeInstructionOptions = options;
};

const applyRuntimePromptAssets = (assets: Awaited<ReturnType<typeof loadRuntimePromptAssets>>) => {
  runtimeMasterPersona = assets.masterPersona || DEFAULT_MASTER_PERSONA;
  runtimeAntiAiStyleRules = parsePromptRuleLines(assets.antiAiStyleRules);
  runtimeCommercialHumanizerRules = parsePromptRuleLines(assets.commercialHumanizerRules);
  runtimeCommercialHumanizerPatterns = parsePromptRuleLines(assets.commercialHumanizerPatterns);
  runtimeCommercialHumanizerQuickChecks = parsePromptRuleLines(assets.commercialHumanizerQuickChecks);
  runtimeProfileAntiPatterns = String(assets.profileAntiPatterns || '').trim();
  runtimeSubPersonaAssets = {
    latepostNewsPersona: String(assets.latepostNewsPersona || '').trim(),
    latepostFeaturePersona: String(assets.latepostFeaturePersona || '').trim(),
    latepostProfilePersona: String(assets.latepostProfilePersona || '').trim(),
    latepostIndustryReviewPersona: String(assets.latepostIndustryReviewPersona || '').trim(),
    xinzhiyuanBreakingPersona: String(assets.xinzhiyuanBreakingPersona || '').trim(),
    xinzhiyuanPaperPersona: String(assets.xinzhiyuanPaperPersona || '').trim(),
    xinzhiyuanProductPersona: String(assets.xinzhiyuanProductPersona || '').trim(),
    xinzhiyuanPeoplePersona: String(assets.xinzhiyuanPeoplePersona || '').trim(),
    huxiuIndustryPersona: String(assets.huxiuIndustryPersona || '').trim(),
    huxiuConsumerPersona: String(assets.huxiuConsumerPersona || '').trim(),
    huxiuProfilePersona: String(assets.huxiuProfilePersona || '').trim(),
    huxiuSocietyPersona: String(assets.huxiuSocietyPersona || '').trim(),
    wallstreetcnMacroPersona: String(assets.wallstreetcnMacroPersona || '').trim(),
    wallstreetcnMarketsPersona: String(assets.wallstreetcnMarketsPersona || '').trim(),
    wallstreetcnCompanyPersona: String(assets.wallstreetcnCompanyPersona || '').trim(),
    wallstreetcnStrategyPersona: String(assets.wallstreetcnStrategyPersona || '').trim(),
  };

  if (runtimeAntiAiStyleRules.length === 0) {
    runtimeAntiAiStyleRules = [...DEFAULT_ANTI_AI_STYLE_RULES];
  }

  if (runtimeCommercialHumanizerRules.length === 0) {
    runtimeCommercialHumanizerRules = [...DEFAULT_COMMERCIAL_HUMANIZER_RULES];
  }

  if (runtimeCommercialHumanizerPatterns.length === 0) {
    runtimeCommercialHumanizerPatterns = [...DEFAULT_COMMERCIAL_HUMANIZER_PATTERN_GROUPS];
  }

  if (runtimeCommercialHumanizerQuickChecks.length === 0) {
    runtimeCommercialHumanizerQuickChecks = [...DEFAULT_COMMERCIAL_HUMANIZER_QUICK_CHECKS];
  }

  runtimeAntiAiStyleRules = appendUniqueRules(runtimeAntiAiStyleRules, [MARKDOWN_TABLE_STYLE_RULE, MARKDOWN_TABLE_FORMAT_RULE]);
  runtimeCommercialHumanizerRules = appendUniqueRules(runtimeCommercialHumanizerRules, [
    MARKDOWN_TABLE_STYLE_RULE,
    MARKDOWN_TABLE_FORMAT_RULE,
    MARKDOWN_TABLE_PRESERVE_RULE,
  ]);
  runtimeCommercialHumanizerQuickChecks = appendUniqueRules(runtimeCommercialHumanizerQuickChecks, [
    '如果正文里出现 Markdown 表格，它是否真的让对比或数据更清楚，而不是徒增形式感。',
    '如果已有表格承载参数或对比信息，修订时是否错误地把它打散回散文。',
  ]);
};

const buildMarkdownTableGuidanceBlock = () =>
  [
    'Markdown 表格使用规则：',
    `1. ${MARKDOWN_TABLE_STYLE_RULE}`,
    `2. ${MARKDOWN_TABLE_FORMAT_RULE}`,
    `3. ${MARKDOWN_TABLE_PRESERVE_RULE}`,
  ].join('\n');

const ensureRuntimePromptAssets = async (profile = 'fdsm') => {
  const normalizedProfile = String(profile || 'fdsm');
  if (!runtimePromptAssetsPromise || runtimePromptAssetsProfile !== normalizedProfile) {
    runtimePromptAssetsProfile = normalizedProfile;
    runtimePromptAssetsPromise = loadRuntimePromptAssets(normalizedProfile)
      .then(applyRuntimePromptAssets)
      .catch((error) => {
        console.warn('[prompt-assets] falling back to bundled defaults', error);
      });
  }

  await runtimePromptAssetsPromise;
};

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

const getPrimaryCandidate = (response: GenerateContentResponse) => response.candidates?.[0];

const logTextResponseMeta = (label: string, response: GenerateContentResponse) => {
  const candidate = getPrimaryCandidate(response);
  console.info(
    `[${label}] finish ${formatStageLogMeta({
      finishReason: candidate?.finishReason,
      finishMessage: candidate?.finishMessage,
      tokenCount: candidate?.tokenCount,
      promptTokenCount: response.usageMetadata?.promptTokenCount,
      candidatesTokenCount: response.usageMetadata?.candidatesTokenCount,
      totalTokenCount: response.usageMetadata?.totalTokenCount,
    })}`
  );
};

const mergeContinuationText = (current: string, addition: string) => {
  const base = cleanText(current);
  const extra = cleanText(addition);

  if (!base) return extra;
  if (!extra) return base;
  if (base.includes(extra)) return base;

  const maxOverlap = Math.min(base.length, extra.length, 400);
  for (let size = maxOverlap; size >= 24; size -= 1) {
    if (base.slice(-size) === extra.slice(0, size)) {
      return `${base}${extra.slice(size)}`;
    }
  }

  return `${base}${base.endsWith('\n') || extra.startsWith('\n') ? '' : '\n'}${extra}`;
};

const buildContinuationPrompt = (prompt: string, generatedText: string) =>
  [
    '你上一条回复因为输出被截断，没有写完。',
    '请从刚才中断的位置继续输出剩余内容。',
    '硬性要求：',
    '1. 只输出剩余未完成的部分，不要重复已经输出的内容。',
    '2. 不要解释，不要总结，不要写“继续如下”之类的提示。',
    '3. 保持同一份 Markdown 文稿的标题层级、语气和结构。',
    '原始任务：',
    prompt,
    '上一条回复的结尾片段（用于定位续写位置）：',
    generatedText.slice(-TEXT_CONTINUATION_TAIL_CHARS),
  ].join('\n\n');

const formatTextFinishReasonError = (finishReason?: FinishReason, finishMessage?: string) => {
  const reason = finishReason || 'UNKNOWN';
  const suffix = finishMessage ? `：${finishMessage}` : '';
  return `模型输出被提前中断（${reason}${suffix}），已阻止保存不完整结果。`;
};

const assertFullDocumentWithinLimit = (content: string, label: string) => {
  const normalized = cleanText(content);
  if (normalized.length <= MAX_DRAFT_CHARS) {
    return;
  }

  throw new Error(
    `${label}长度为 ${normalized.length} 字，已超过当前整稿改写安全上限 ${MAX_DRAFT_CHARS} 字。请先拆分文章，或改用选中片段精修。`
  );
};

const emitArticleSnapshot = (
  onSnapshot: ((snapshot: ArticleProgressSnapshot) => void) | undefined,
  snapshot: ArticleProgressSnapshot
) => {
  onSnapshot?.({
    ...snapshot,
    data: {
      ...snapshot.data,
      chunkDrafts: Array.isArray(snapshot.data.chunkDrafts) ? snapshot.data.chunkDrafts : [],
    },
  });
};

const sleep = (ms: number) => new Promise((resolve) => globalThis.setTimeout(resolve, ms));

const formatElapsed = (ms: number) => {
  const seconds = Math.max(1, Math.round(ms / 1000));
  const minutes = Math.floor(seconds / 60);
  const restSeconds = seconds % 60;
  return minutes > 0 ? `${minutes}分${restSeconds}秒` : `${seconds}秒`;
};

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' ? (value as Record<string, unknown>) : null;

const stringifyUnknown = (value: unknown) => {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
};

const pickString = (...values: unknown[]) => {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }

    if (typeof value === 'number' && Number.isFinite(value)) {
      return String(value);
    }
  }

  return '';
};

const pickNumber = (...values: unknown[]) => {
  for (const value of values) {
    if (typeof value === 'number' && Number.isFinite(value)) {
      return value;
    }
  }

  return undefined;
};

const extractApiErrorDetails = (error: unknown) => {
  const candidate = asRecord(error);
  const errorRecord = asRecord(candidate?.error);
  const nestedErrorRecord = asRecord(errorRecord?.error);

  return {
    status: pickNumber(candidate?.status, errorRecord?.status, nestedErrorRecord?.status),
    code: pickString(nestedErrorRecord?.code, errorRecord?.code, candidate?.code),
    message: pickString(nestedErrorRecord?.message, errorRecord?.message, candidate?.message),
    body: errorRecord ? stringifyUnknown(errorRecord) : candidate ? stringifyUnknown(candidate) : '',
  };
};

const stringifyError = (error: unknown): string => {
  const details = extractApiErrorDetails(error);
  const structuredParts = [
    details.status !== undefined ? String(details.status) : '',
    details.code,
    details.message,
  ].filter(Boolean);

  if (structuredParts.length > 0) {
    if (details.body && !structuredParts.includes(details.body)) {
      structuredParts.push(details.body);
    }
    return structuredParts.join(' | ');
  }

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

    return stringifyUnknown(error);
  }

  return String(error);
};

export const formatRuntimeError = (error: unknown) => stringifyError(error);

const isRetryableApiError = (error: unknown) => {
  const { status } = extractApiErrorDetails(error);
  return status === undefined || status === 404 || status === 408 || status === 409 || status === 429 || status >= 500;
};

const normalizeGenModel = (model?: string | null) => {
  if (!model || model === 'gemini-3.1-pro') {
    return 'gemini-3.1-pro-preview';
  }
  return model;
};

const GEMINI_API_KEY_STORAGE_KEY = 'GEMINI_API_KEY';
const getSearchModel = () => localStorage.getItem('SEARCH_MODEL') || 'gemini-3.1-flash-lite';
const getGenModel = () => normalizeGenModel(localStorage.getItem('GEN_MODEL'));

const formatStageLogMeta = (meta: Record<string, unknown>) =>
  JSON.stringify(Object.fromEntries(Object.entries(meta).filter(([, value]) => value !== undefined)));

const readStorageValue = (storage: Storage | null | undefined, key: string) => {
  try {
    return storage?.getItem(key)?.trim() || '';
  } catch {
    return '';
  }
};

export const getStoredGeminiApiKey = () => {
  if (typeof window === 'undefined') return '';

  const sessionValue = readStorageValue(window.sessionStorage, GEMINI_API_KEY_STORAGE_KEY);
  if (sessionValue) {
    return sessionValue;
  }

  const legacyValue = readStorageValue(window.localStorage, GEMINI_API_KEY_STORAGE_KEY);
  if (legacyValue) {
    try {
      window.sessionStorage.setItem(GEMINI_API_KEY_STORAGE_KEY, legacyValue);
    } catch {
      return legacyValue;
    }

    try {
      window.localStorage.removeItem(GEMINI_API_KEY_STORAGE_KEY);
    } catch {
      // Ignore cleanup failures for legacy storage.
    }

    return legacyValue;
  }

  return '';
};

export const setStoredGeminiApiKey = (apiKey: string) => {
  const normalized = String(apiKey || '').trim();
  if (!normalized) {
    throw new Error('请输入 Gemini API Key。');
  }

  if (typeof window === 'undefined') return;

  window.sessionStorage.setItem(GEMINI_API_KEY_STORAGE_KEY, normalized);

  try {
    window.localStorage.removeItem(GEMINI_API_KEY_STORAGE_KEY);
  } catch {
    // Ignore cleanup failures for legacy storage.
  }
};

export const clearStoredGeminiApiKey = () => {
  if (typeof window === 'undefined') return;

  try {
    window.sessionStorage.removeItem(GEMINI_API_KEY_STORAGE_KEY);
  } catch {
    // Ignore session storage cleanup failures.
  }

  try {
    window.localStorage.removeItem(GEMINI_API_KEY_STORAGE_KEY);
  } catch {
    // Ignore legacy local storage cleanup failures.
  }
};

export const validateGeminiApiKey = async (apiKey: string) => {
  const normalized = String(apiKey || '').trim();
  if (!normalized) {
    throw new Error('请输入 Gemini API Key。');
  }

  const ai = new GoogleGenAI({ apiKey: normalized });

  await ai.models.countTokens({
    model: getGenModel(),
    contents: 'ping',
  });
};

const getAiClient = () => {
  const apiKey = getStoredGeminiApiKey();
  if (!apiKey) {
    throw new Error('请先输入你自己的 Gemini API Key。');
  }
  return new GoogleGenAI({ apiKey });
};

async function callWithRetry<T>(
  fn: () => Promise<T>,
  retries = 3,
  baseDelay = 1500,
  label = 'request',
  shouldRetry: (error: unknown, attempt: number) => boolean = () => true
): Promise<T> {
  let lastError: unknown;

  for (let attempt = 0; attempt < retries; attempt += 1) {
    try {
      if (attempt > 0) {
        console.info(`[${label}] retry ${attempt + 1}/${retries}`);
      }
      return await fn();
    } catch (error) {
      lastError = error;
      if (attempt === retries - 1 || !shouldRetry(error, attempt)) {
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
  logMeta,
}: {
  label: string;
  statusMessage: string;
  onStatus?: (message: string) => void;
  work: () => Promise<T>;
  timeoutMs?: number;
  logMeta?: Record<string, unknown>;
}): Promise<T> => {
  const startedAt = Date.now();
  let intervalId: ReturnType<typeof globalThis.setInterval> | null = null;
  const startedLogMeta = logMeta
    ? { timeoutMs, ...logMeta }
    : { api: 'models.generateContent', model: getGenModel(), timeoutMs };

  onStatus?.(statusMessage);
  console.info(`[${label}] started ${formatStageLogMeta(startedLogMeta)}`);

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
    console.error(`[${label}] failed ${formatStageLogMeta(startedLogMeta)}`, error);
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
    `风格库：${options.styleProfile || 'fdsm'}`,
    `文体：${options.genre}`,
    `风格：${options.style}`,
    `目标受众：${options.audience}`,
    `文章目标：${options.articleGoal}`,
    options.desiredLength > 0 ? `目标字数：约 ${options.desiredLength} 字` : '',
    options.chunkLength > 0 ? `单轮写作长度：约 ${options.chunkLength} 字` : '',
    `是否生成 TN：${options.includeTeachingNotes ? '是' : '否'}`,
    `是否启用 Deep Research：${options.enableDeepResearch ? '是' : '否'}`,
    options.enableDeepResearch && options.deepResearchPrompt.trim()
      ? `Deep Research 补充要求：${options.deepResearchPrompt.trim()}`
      : '',
  ]
    .filter(Boolean)
    .join('\n');

const buildAntiAiStyleBlock = () =>
  ['反 AI 文风硬约束：', ...runtimeAntiAiStyleRules.map((rule, index) => `${index + 1}. ${rule}`)].join('\n');

const buildCommercialHumanizerBlock = () =>
  ['商业文章去AI化护栏：', ...runtimeCommercialHumanizerRules.map((rule, index) => `${index + 1}. ${rule}`)].join('\n');

const buildCommercialHumanizerPatternBlock = () =>
  ['商业文章去AI化检查维度：', ...runtimeCommercialHumanizerPatterns.map((rule, index) => `${index + 1}. ${rule}`)].join('\n');

const buildCommercialHumanizerChecklistBlock = () =>
  ['商业文章去AI化快速检查：', ...runtimeCommercialHumanizerQuickChecks.map((rule, index) => `${index + 1}. ${rule}`)].join('\n');

const buildProfileAntiPatternBlock = () =>
  runtimeProfileAntiPatterns ? `当前风格库反模式：\n${runtimeProfileAntiPatterns}` : '';

const buildSubPersonaBlock = (options?: WritingTaskOptions) => {
  const resolvedOptions = options || runtimeInstructionOptions;
  const subPersonaId = resolveRuntimeSubPersona(resolvedOptions);
  if (!subPersonaId) {
    return '';
  }

  const content = runtimeSubPersonaAssets[subPersonaId];
  if (!content) {
    return '';
  }

  const descriptor = getRuntimeSubPersonaDescriptor(subPersonaId);
  const heading = descriptor ? `当前稿型人格：${descriptor.label}` : '当前稿型人格';
  return `${heading}\n\n${content}`;
};

const buildSystemInstruction = (role: string, options?: WritingTaskOptions) =>
  [role, runtimeMasterPersona, buildSubPersonaBlock(options), buildProfileAntiPatternBlock(), buildAntiAiStyleBlock()]
    .filter(Boolean)
    .join('\n\n');

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

type InteractionOutputBlock = NonNullable<Interaction['outputs']>[number];

type StreamedTextOutput = {
  type: 'text';
  text: string;
  annotations?: any[];
};

interface DeepResearchStreamSnapshot {
  interactionId: string;
  lastStatus: string;
  lastEventId: string;
  textOutputs: Map<number, StreamedTextOutput>;
}

const buildInteractionInput = (prompt: string, uploadedFiles: UploadedFile[]) => {
  const input: Array<Record<string, unknown>> = [{ type: 'text', text: prompt }];
  const textFiles = uploadedFiles.filter((file) => file.isText);
  const binaryFiles = uploadedFiles.filter((file) => !file.isText);

  if (textFiles.length > 0) {
    input.push({
      type: 'text',
      text: textFiles
        .slice(0, 6)
        .map((file, index) => `### 用户附件 ${index + 1}：${file.name}\n${truncate(file.data, 12000)}`)
        .join('\n\n'),
    });
  }

  binaryFiles.slice(0, 4).forEach((file) => {
    if (file.mimeType === 'application/pdf') {
      input.push({
        type: 'document',
        data: file.data,
        mime_type: 'application/pdf',
      });
      return;
    }

    input.push({
      type: 'text',
      text: `### 未直接挂载的二进制附件：${file.name}\nMIME: ${file.mimeType}`,
    });
  });

  return input;
};

const getInteractionOutputs = (interaction: Interaction): InteractionOutputBlock[] =>
  Array.isArray(interaction.outputs) ? interaction.outputs : [];

const hasInteractionOutputType = (interaction: Interaction, type: InteractionOutputBlock['type']) =>
  getInteractionOutputs(interaction).some((output) => output.type === type);

const mergeStreamedTextOutput = (
  outputs: Map<number, StreamedTextOutput>,
  index: number,
  payload: { text?: unknown; annotations?: unknown }
) => {
  const existing = outputs.get(index) || { type: 'text', text: '' };
  const nextText = typeof payload.text === 'string' ? `${existing.text}${payload.text}` : existing.text;
  const nextAnnotations = [
    ...(Array.isArray(existing.annotations) ? existing.annotations : []),
    ...(Array.isArray(payload.annotations) ? payload.annotations : []),
  ];

  outputs.set(index, {
    type: 'text',
    text: nextText,
    ...(nextAnnotations.length > 0 ? { annotations: nextAnnotations } : {}),
  });
};

const buildInteractionFromStreamSnapshot = ({
  interactionId,
  lastStatus,
  textOutputs,
}: DeepResearchStreamSnapshot): Interaction | null => {
  if (!interactionId || textOutputs.size === 0) {
    return null;
  }

  const outputs = Array.from(textOutputs.entries())
    .sort((a, b) => a[0] - b[0])
    .map(([, output]) => output)
    .filter((output) => cleanText(output.text).length > 0) as InteractionOutputBlock[];

  if (outputs.length === 0) {
    return null;
  }

  return {
    id: interactionId,
    status: lastStatus || 'completed',
    outputs,
  } as Interaction;
};

const fetchLatestInteraction = async (
  ai: GoogleGenAI,
  interactionId: string,
  meta: Record<string, unknown> = {}
) => {
  try {
    return await callWithRetry(
      () => ai.interactions.get(interactionId, { include_input: false }),
      3,
      1500,
      'interaction-get',
      (error) => isRetryableApiError(error)
    );
  } catch (error) {
    const details = extractApiErrorDetails(error);
    console.error(
      `[interaction-get] failed ${formatStageLogMeta({
        interactionId,
        ...meta,
        status: details.status,
        code: details.code,
        message: details.message,
        body: details.body,
      })}`
    );
    throw new Error(
      `interaction.get 澶辫触锛坕d=${interactionId}锛?${[details.status, details.code, details.message, details.body]
        .filter(Boolean)
        .join(' | ')}`
    );
  }
};

const normalizeInteractionStrings = (value: unknown, limit = 8) =>
  Array.isArray(value)
    ? value
        .map((item) => cleanText(String(item || '')))
        .filter(Boolean)
        .slice(0, limit)
    : [];

const isLikelyStyleArtifact = (value: string) => {
  const normalized = cleanText(value).toLowerCase();
  if (!normalized) return false;

  const propertyMatches = normalized.match(/\b[a-z-]{2,}\s*:\s*[^;{}\n]{1,160};?/g) || [];
  const selectorMatches = normalized.match(/(^|\n)\s*(?:[.#@][\w-]+|[a-z][\w-]*(?:\s+[.#]?[a-z][\w-]*)*)\s*\{/gm) || [];
  const explicitSignals = [
    '@media',
    '@font-face',
    'scrollbar-width',
    'white-space:',
    'display:',
    'position:',
    'margin-right:',
    'overflow:',
  ].filter((signal) => normalized.includes(signal)).length;
  const braceCount = (normalized.match(/[{}]/g) || []).length;

  return propertyMatches.length >= 3 && (selectorMatches.length >= 1 || explicitSignals >= 2 || braceCount >= 4);
};

const cleanRenderedContent = (value: unknown) => {
  const raw = String(value || '');
  if (!raw.trim()) return '';

  const plain = raw
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h\d)>/gi, '\n')
    .replace(/<li[^>]*>/gi, '- ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/\s+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n');

  if (isLikelyStyleArtifact(raw) || isLikelyStyleArtifact(plain)) {
    return '';
  }

  const normalized = cleanText(plain);
  return normalized.length > 600 ? `${normalized.slice(0, 600).trim()}...` : normalized;
};

const pushSearchSource = (
  sources: SearchSource[],
  seen: Set<string>,
  {
    title,
    uri,
    snippet,
    track,
  }: {
    title: string;
    uri: string;
    snippet?: string;
    track?: string;
  }
) => {
  const normalizedUri = cleanText(uri);
  if (!normalizedUri) return;

  const key = `${track || ''}::${normalizedUri}`;
  if (seen.has(key)) return;

  seen.add(key);
  sources.push({
    title: cleanText(title) || normalizedUri,
    uri: normalizedUri,
    snippet: cleanText(snippet || ''),
    track,
  });
};

const appendSearchResultItems = ({
  lines,
  results,
  sources,
  seenSources,
  track,
}: {
  lines: string[];
  results: unknown[];
  sources: SearchSource[];
  seenSources: Set<string>;
  track?: string;
}) => {
  if (!results.length) {
    lines.push('- 未返回结果。');
    return;
  }

  results.forEach((item, index) => {
    const candidate = item && typeof item === 'object' ? (item as Record<string, unknown>) : {};
    const title = cleanText(String(candidate.title || candidate.url || `结果 ${index + 1}`));
    const uri = cleanText(String(candidate.url || ''));
    const snippet = cleanRenderedContent(candidate.rendered_content);

    lines.push(`${index + 1}. ${uri ? `[${title}](${uri})` : title}`);
    if (snippet) {
      lines.push(`   - 摘要：${snippet}`);
    }

    if (uri) {
      pushSearchSource(sources, seenSources, {
        title,
        uri,
        snippet,
        track,
      });
    }
  });
};

const appendUrlContextItems = ({
  lines,
  results,
  sources,
  seenSources,
  track,
}: {
  lines: string[];
  results: unknown[];
  sources: SearchSource[];
  seenSources: Set<string>;
  track?: string;
}) => {
  if (!results.length) {
    lines.push('- 未返回 URL 上下文结果。');
    return;
  }

  results.forEach((item, index) => {
    const candidate = item && typeof item === 'object' ? (item as Record<string, unknown>) : {};
    const uri = cleanText(String(candidate.url || ''));
    const status = cleanText(String(candidate.status || 'unknown'));
    lines.push(`${index + 1}. ${uri || '未返回 URL'}`);
    lines.push(`   - 状态：${status}`);

    if (uri) {
      pushSearchSource(sources, seenSources, {
        title: uri,
        uri,
        snippet: `URL context status: ${status}`,
        track,
      });
    }
  });
};

const formatUnsupportedInteractionBlock = (block: InteractionOutputBlock) => {
  const serialized = JSON.stringify(block, null, 2);
  if (!serialized) return '';
  return serialized.length > 4000 ? `${serialized.slice(0, 4000)}\n...` : serialized;
};

const formatSearchInteractionResult = ({
  title,
  track,
  interaction,
}: {
  title: string;
  track: string;
  interaction: Interaction;
}): ResearchTrackResult => {
  const outputs = getInteractionOutputs(interaction);
  const searchCalls = new Map<string, string[]>();
  const sources: SearchSource[] = [];
  const seenSources = new Set<string>();
  const annotationSources = extractInteractionAnnotationSources(interaction, track);
  const lines = [
    `# ${title}`,
    '',
    `研究轨道：${track}`,
    `研究模型：${interaction.model || getSearchModel()}`,
    '',
    '以下内容为 Gemini Google Search 原生返回，经程序排版展示，未做模型二次总结。',
  ];

  let callIndex = 0;
  let resultIndex = 0;

  for (const output of outputs) {
    if (output.type === 'google_search_call') {
      callIndex += 1;
      const callBlock = output as InteractionOutputBlock & {
        id?: string;
        arguments?: { queries?: string[] };
      };
      const queries = normalizeInteractionStrings(callBlock.arguments?.queries);
      if (callBlock.id) {
        searchCalls.set(callBlock.id, queries);
      }
      lines.push('', `## Google Search 调用 ${callIndex}`);
      if (queries.length > 0) {
        lines.push(...queries.map((query, index) => `${index + 1}. ${query}`));
      } else {
        lines.push('- 未返回查询词。');
      }
      continue;
    }

    if (output.type !== 'google_search_result') {
      continue;
    }

    resultIndex += 1;
    const resultBlock = output as InteractionOutputBlock & {
      call_id?: string;
      result?: unknown[];
      is_error?: boolean;
    };
    const queries = searchCalls.get(String(resultBlock.call_id || '')) || [];
    lines.push('', `## Google Search 结果 ${resultIndex}`);
    if (queries.length > 0) {
      lines.push(`对应查询：${queries.join(' / ')}`);
    }

    if (resultBlock.is_error) {
      lines.push('- 搜索工具返回错误。');
      continue;
    }

    appendSearchResultItems({
      lines,
      results: Array.isArray(resultBlock.result) ? resultBlock.result : [],
      sources,
      seenSources,
      track,
    });
  }

  if (resultIndex === 0) {
    const otherOutputTypes = Array.from(
      new Set(
        outputs
          .map((output) => output.type)
          .filter((type) => type !== 'google_search_call' && type !== 'google_search_result')
      )
    );

    lines.push('', '## 返回状态');
    if (callIndex > 0) {
      lines.push(`- 已触发 ${callIndex} 次 Google Search 调用，但本次 interaction 没有返回 google_search_result 原生块。`);
    } else {
      lines.push('- 本次 interaction 没有返回 google_search_call 或 google_search_result 原生块。');
    }
    lines.push('- 程序没有追加 Gemini 总结；这里只保留接口原生暴露的调用信息。');
    if (otherOutputTypes.length > 0) {
      lines.push(`- 本次 outputs 还包含：${otherOutputTypes.join('、')}。`);
    }

    annotationSources.forEach((source) => {
      pushSearchSource(sources, seenSources, source);
    });

    if (annotationSources.length > 0) {
      lines.push('', '## 附带来源标注');
      annotationSources.forEach((source, index) => {
        lines.push(`${index + 1}. [${source.title}](${source.uri})`);
      });
    }
  }

  return {
    title,
    content: cleanText(lines.join('\n')),
    sources,
  };
};

const formatSearchGenerateContentResult = ({
  title,
  track,
  response,
}: {
  title: string;
  track: string;
  response: GenerateContentResponse;
}): ResearchTrackResult => {
  const sources = extractGroundedSources(response, track);
  const lines = [
    `# ${title}`,
    '',
    `研究轨道：${track}`,
    `研究模型：${getSearchModel()}`,
    '',
    cleanText(response.text) || '未返回可用的研究正文。',
  ];

  return {
    title,
    content: stripForbiddenResearchSections(lines.join('\n')),
    sources,
  };
};

const formatDeepResearchInteractionResult = ({
  title,
  interaction,
}: {
  title: string;
  interaction: Interaction;
}): ResearchTrackResult => {
  const outputs = getInteractionOutputs(interaction);
  if (outputs.length === 0) {
    throw new Error('Deep Research 未返回原生 outputs。');
  }

  const agentTexts = outputs
    .filter((output) => output.type === 'text')
    .map((output) => cleanText(String((output as InteractionOutputBlock & { text?: string }).text || '')))
    .filter(Boolean);

  if (agentTexts.length === 0) {
    throw new Error('Deep Research 未返回可用的 Agent 文本输出。');
  }

  return {
    title,
    content: stripForbiddenResearchSections([`# ${title}`, '', agentTexts.join('\n\n')].join('\n')),
    sources: [],
  };
};

const buildDeepResearchProgressMessage = ({
  status,
  thoughtBlocks,
  textBlocks,
  searchCalls,
  searchResults,
  urlCalls,
  urlResults,
  note,
}: {
  status: string;
  thoughtBlocks: number;
  textBlocks: number;
  searchCalls: number;
  searchResults: number;
  urlCalls: number;
  urlResults: number;
  note?: string;
}) => {
  const statusLabel =
    status === 'completed'
      ? '已完成'
      : status === 'in_progress'
        ? '进行中'
        : status === 'requires_action'
          ? '等待动作'
          : status === 'failed'
            ? '失败'
            : status === 'cancelled'
              ? '已取消'
              : status === 'incomplete'
                ? '未完成'
                : status;

  const parts = [
    `状态：${statusLabel}`,
    searchCalls > 0 ? `搜索调用 ${searchCalls}` : '',
    searchResults > 0 ? `搜索结果 ${searchResults}` : '',
    urlCalls > 0 ? `URL 上下文调用 ${urlCalls}` : '',
    urlResults > 0 ? `URL 上下文结果 ${urlResults}` : '',
    thoughtBlocks > 0 ? `思考块 ${thoughtBlocks}` : '',
    textBlocks > 0 ? `文本块 ${textBlocks}` : '',
    note || '',
  ].filter(Boolean);

  return `正在进行 Deep Research 补充研究...（${parts.join('；')}）`;
};

const streamDeepResearchInteraction = async ({
  prompt,
  uploadedFiles,
  onStatus,
}: {
  prompt: string;
  uploadedFiles: UploadedFile[];
  onStatus?: (message: string) => void;
}) => {
  const ai = getAiClient();
  onStatus?.('正在提交 Deep Research 任务...');

  const initialInteraction = await callWithRetry(
    () =>
      ai.interactions.create({
        agent: 'deep-research-pro-preview-12-2025',
        agent_config: {
          type: 'deep-research',
          thinking_summaries: 'auto',
        },
        input: buildInteractionInput(prompt, uploadedFiles),
        background: true,
      }),
    3,
    1500,
    'deep-research-create',
    (error) => isRetryableApiError(error)
  );

  onStatus?.(`Deep Research 已提交，正在后台执行（ID: ${initialInteraction.id.slice(0, 12)}...）。`);

  const completedInteraction =
    initialInteraction.status === 'completed'
      ? initialInteraction
      : await waitForInteractionCompletion(
          ai,
          initialInteraction.id,
          DEEP_RESEARCH_POLL_TIMEOUT_MS,
          DEEP_RESEARCH_POLL_INTERVAL_MS,
          (status, elapsedMs) => {
            onStatus?.(`正在进行 Deep Research... 状态: ${status}，已等待 ${formatDurationLabel(elapsedMs)}。`);
          }
        );

  if (!getInteractionOutputs(completedInteraction).length) {
    throw new Error(`Deep Research completed without outputs (interactionId=${completedInteraction.id})`);
  }

  return completedInteraction;

  const stream = (await callWithRetry(
    () =>
      ai.interactions.create({
        agent: 'deep-research-pro-preview-12-2025',
        agent_config: {
          type: 'deep-research',
          thinking_summaries: 'auto',
        },
        input: buildInteractionInput(prompt, uploadedFiles),
        background: true,
        store: true,
        stream: true,
        response_modalities: ['text'],
      }),
    3,
    1500,
    'deep-research-create'
  )) as AsyncIterable<InteractionSSEEvent>;

  let interactionId = '';
  let lastStatus = 'in_progress';
  let thoughtBlocks = 0;
  let textBlocks = 0;
  let searchCalls = 0;
  let searchResults = 0;
  let urlCalls = 0;
  let urlResults = 0;
  let lastEventId = '';
  const seenBlocks = new Set<string>();
  const streamedTextOutputs = new Map<number, StreamedTextOutput>();

  const registerBlock = (index: number, type: string) => {
    const key = `${index}:${type}`;
    if (seenBlocks.has(key)) {
      return false;
    }

    seenBlocks.add(key);

    if (type === 'thought') thoughtBlocks += 1;
    if (type === 'text') textBlocks += 1;
    if (type === 'google_search_call') searchCalls += 1;
    if (type === 'google_search_result') searchResults += 1;
    if (type === 'url_context_call') urlCalls += 1;
    if (type === 'url_context_result') urlResults += 1;
    return true;
  };

  const pushStatus = (note?: string) =>
    onStatus?.(
      buildDeepResearchProgressMessage({
        status: lastStatus,
        thoughtBlocks,
        textBlocks,
        searchCalls,
        searchResults,
        urlCalls,
        urlResults,
        note,
      })
    );

  for await (const event of stream) {
    if ('event_id' in event && typeof event.event_id === 'string' && event.event_id.trim()) {
      lastEventId = event.event_id;
    }

    if (event.event_type === 'interaction.start') {
      interactionId = event.interaction.id;
      lastStatus = event.interaction.status;
      pushStatus('已接入流式进度');
      continue;
    }

    if (event.event_type === 'interaction.status_update') {
      lastStatus = event.status;
      pushStatus();
      continue;
    }

    if (event.event_type === 'content.start') {
      if (event.content.type === 'text') {
        mergeStreamedTextOutput(streamedTextOutputs, event.index, {
          text: event.content.text,
          annotations: event.content.annotations,
        });
      }

      if (registerBlock(event.index, event.content.type)) {
        pushStatus();
      }
      continue;
    }

    if (event.event_type === 'content.delta') {
      if (event.delta.type === 'text') {
        mergeStreamedTextOutput(streamedTextOutputs, event.index, {
          text: event.delta.text,
          annotations: event.delta.annotations,
        });
      }

      if (registerBlock(event.index, event.delta.type)) {
        pushStatus();
      }
      continue;
    }

    if (event.event_type === 'interaction.complete') {
      interactionId = event.interaction.id || interactionId;
      lastStatus = event.interaction.status || 'completed';
      pushStatus('流已结束，正在读取最终结果');
      continue;
    }

    if (event.event_type === 'error') {
      throw new Error(event.error?.message || event.error?.code || 'Deep Research stream error');
    }
  }

  if (!interactionId) {
    throw new Error('Deep Research stream 未返回 interaction id。');
  }

  while (interactionId && lastEventId && (lastStatus !== 'completed' || streamedTextOutputs.size === 0)) {
    const resumeFromEventId = lastEventId;
    const previousTextBlockCount = streamedTextOutputs.size;

    pushStatus(`Deep Research 流式连接中断，正在从事件 ${resumeFromEventId} 恢复。`);
    const resumedStream = (await callWithRetry(
      () =>
        ai.interactions.get(interactionId, {
          stream: true,
          last_event_id: resumeFromEventId,
          include_input: false,
        }),
      3,
      1500,
      'deep-research-resume',
      (error) => isRetryableApiError(error)
    )) as AsyncIterable<InteractionSSEEvent>;

    let sawProgress = false;

    for await (const event of resumedStream) {
      sawProgress = true;

      if ('event_id' in event && typeof event.event_id === 'string' && event.event_id.trim()) {
        lastEventId = event.event_id;
      }

      if (event.event_type === 'interaction.start') {
        interactionId = event.interaction.id || interactionId;
        lastStatus = event.interaction.status || lastStatus;
        pushStatus('Deep Research 流式连接已恢复。');
        continue;
      }

      if (event.event_type === 'interaction.status_update') {
        lastStatus = event.status;
        pushStatus();
        continue;
      }

      if (event.event_type === 'content.start') {
        if (event.content.type === 'text') {
          mergeStreamedTextOutput(streamedTextOutputs, event.index, {
            text: event.content.text,
            annotations: event.content.annotations,
          });
        }

        if (registerBlock(event.index, event.content.type)) {
          pushStatus();
        }
        continue;
      }

      if (event.event_type === 'content.delta') {
        if (event.delta.type === 'text') {
          mergeStreamedTextOutput(streamedTextOutputs, event.index, {
            text: event.delta.text,
            annotations: event.delta.annotations,
          });
        }

        if (registerBlock(event.index, event.delta.type)) {
          pushStatus();
        }
        continue;
      }

      if (event.event_type === 'interaction.complete') {
        interactionId = event.interaction.id || interactionId;
        lastStatus = event.interaction.status || 'completed';
        pushStatus('Deep Research 恢复流已结束，正在整理最终结果。');
        continue;
      }

      if (event.event_type === 'error') {
        throw new Error(event.error?.message || event.error?.code || 'Deep Research resume stream error');
      }
    }

    if (lastStatus === 'completed') {
      break;
    }

    if (!sawProgress || (resumeFromEventId === lastEventId && previousTextBlockCount === streamedTextOutputs.size)) {
      break;
    }
  }

  const streamedInteraction = buildInteractionFromStreamSnapshot({
    interactionId,
    lastStatus,
    lastEventId,
    textOutputs: streamedTextOutputs,
  });

  if (lastStatus === 'completed' && streamedInteraction) {
    pushStatus('流已结束，已直接从流式事件重建最终结果。');
    return streamedInteraction;
  }

  pushStatus('流式结果不足，正在读取存储中的 interaction 结果。');
  let interaction = await fetchLatestInteraction(ai, interactionId, {
    status: lastStatus,
    lastEventId,
    streamedTextBlocks: streamedTextOutputs.size,
  });
  if (interaction.status !== 'completed') {
    interaction = await waitForInteractionCompletion(
      ai,
      interactionId,
      DEEP_RESEARCH_POLL_TIMEOUT_MS,
      DEEP_RESEARCH_POLL_INTERVAL_MS,
      (status, elapsedMs) => {
        lastStatus = status;
        pushStatus(`流已结束，正在等待后台完成（已轮询 ${formatDurationLabel(elapsedMs)}）`);
      }
    );
  }

  if (getInteractionOutputs(interaction).length === 0 && streamedInteraction) {
    pushStatus('存储结果未返回 outputs，已回退到流式重建结果。');
    return streamedInteraction;
  }

  return interaction;
};

const waitForInteractionCompletion = async (
  ai: GoogleGenAI,
  interactionId: string,
  timeoutMs: number,
  pollIntervalMs = STAGE_STATUS_INTERVAL_MS,
  onPoll?: (status: string, elapsedMs: number) => void
) => {
  const startedAt = Date.now();
  const deadline = Date.now() + timeoutMs;
  let lastStatus = 'unknown';

  while (Date.now() < deadline) {
    const interaction = await fetchLatestInteraction(ai, interactionId, {
      lastStatus,
      elapsedMs: Date.now() - startedAt,
    });
    lastStatus = interaction.status;
    onPoll?.(lastStatus, Date.now() - startedAt);

    if (interaction.status === 'completed') {
      return interaction;
    }

    if (interaction.status === 'failed' || interaction.status === 'cancelled' || interaction.status === 'incomplete') {
      throw new Error(`interaction ended with status: ${interaction.status}`);
    }

    await sleep(pollIntervalMs);
  }

  throw new Error(
    `interaction polling timed out after ${formatDurationLabel(timeoutMs)} (last status: ${lastStatus})`
  );
};

const extractInteractionAnnotationSources = (interaction: Interaction, track?: string) => {
  const sources: SearchSource[] = [];
  const seen = new Set<string>();

  getInteractionOutputs(interaction).forEach((output) => {
    if (output.type !== 'text') {
      return;
    }

    const textBlock = output as InteractionOutputBlock & {
      annotations?: Array<{ source?: string }>;
    };

    (textBlock.annotations || []).forEach((annotation) => {
      const source = cleanText(String(annotation?.source || ''));
      if (!/^https?:\/\//i.test(source)) {
        return;
      }

      pushSearchSource(sources, seen, {
        title: source,
        uri: source,
        track,
      });
    });
  });

  return sources;
};

const ensureSearchInteractionReady = async (interaction: Interaction) => {
  let latest = interaction;
  const ai = getAiClient();

  if (latest.status !== 'completed') {
    latest = await waitForInteractionCompletion(ai, latest.id, 90000);
  }

  for (let attempt = 0; attempt < 3 && !hasInteractionOutputType(latest, 'google_search_result'); attempt += 1) {
    await sleep(1200 * (attempt + 1));
    latest = await fetchLatestInteraction(ai, latest.id, { attempt: attempt + 1, purpose: 'ensure-search-ready' });
    if (latest.status !== 'completed') {
      latest = await waitForInteractionCompletion(ai, latest.id, 90000);
    }
  }

  return latest;
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

const stripForbiddenResearchSections = (content: string) => {
  const lines = cleanText(content).split('\n');
  const cleaned: string[] = [];
  let skippingForbiddenSection = false;

  for (const line of lines) {
    const trimmed = line.trim();
    const isForbiddenHeading =
      /^##\s*参考来源\s*$/i.test(trimmed) ||
      /^##\s*附带来源标注\s*$/i.test(trimmed) ||
      /^##\s*输出块\s*\d+\s*·\s*(思考摘要|Google Search 调用|Google Search 结果|URL Context 调用|URL Context 结果)\s*$/i.test(
        trimmed
      );

    if (isForbiddenHeading) {
      skippingForbiddenSection = true;
      continue;
    }

    if (skippingForbiddenSection && /^##\s+/.test(trimmed)) {
      skippingForbiddenSection = false;
    }

    if (!skippingForbiddenSection) {
      cleaned.push(line);
    }
  }

  return cleanText(cleaned.join('\n'));
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
  const preferred = Array.isArray(existingArticles)
    ? existingArticles.slice(0, 3).map((article) => ({
        ...article,
        styleProfile: article.styleProfile || options.styleProfile,
      }))
    : [];
  const selected = preferred.length > 0 ? preferred : await selectReferenceTemplates(topic, direction, options);
  return await hydrateReferenceTemplatesWithFullText(selected);
};

const lintStyle = (content: string) => {
  const text = cleanText(content);
  if (!text) {
    return '## 本地风格检查\n- 当前文稿为空。';
  }

  const checks = [
    {
      label: 'AI 连接句',
      regex:
        /(换句话说|更重要的是|说到底|从某种意义上讲|从这个意义上说|值得注意的是|不难发现|可以说|综上所述|总的来看|某种程度上|不是.{0,20}而是)/g,
    },
    {
      label: '商业黑话/口号',
      regex: /(彻底改写|重新定义|革命性|史诗级|全方位赋能|颠覆式|范式迁移|底层逻辑|全链路|闭环|抓手)/g,
    },
    { label: '模糊主体', regex: /(有人认为|有观点认为|业内普遍认为|越来越多人意识到|不少人觉得)/g },
    { label: '过度工整句', regex: /(不是.{0,20}而是|既.{0,20}又.{0,20}|这不仅.{0,30}(更|也))/g },
    { label: '聊天腔', regex: /(你会发现|我们不妨|你可能会问|说白了)/g },
    { label: '宣传式表达', regex: /(作为.{0,10}(证明|体现|标志)|令人叹为观止|迷人的|必游之地|自然之美|坐落在|位于.{0,10}中心|充满活力)/g },
    { label: '知名度堆砌', regex: /(被《[^》]+》.*引用|社交媒体上拥有|超过[0-9一二三四五六七八九十百千万]+万粉丝|多家媒体报道)/g },
    { label: '挑战/展望公式段', regex: /(尽管存在这些挑战|尽管.{0,20}面临若干挑战|未来展望|挑战与未来展望)/g },
    { label: '协作痕迹', regex: /(希望这对[你您]有帮助|当然[！!]?|一定[！!]?|请告诉我|如果你想让我|这是一个.{0,12}(概述|总结|回答))/g },
    { label: '知识截止免责声明', regex: /(根据我最后的训练更新|截至[0-9]{4}年|基于可用信息|具体细节.{0,12}(有限|不详|没有广泛记录))/g },
    { label: '谄媚语气', regex: /(好问题|你说得完全正确|这是一个很好的观点|非常棒的问题)/g },
    { label: '过度限定', regex: /(可以潜在地可能|似乎是在|可能会对.{0,12}产生一些影响|在某种程度上可以认为)/g },
    { label: '万能结尾', regex: /(未来已来|值得每个人思考|给行业带来启示|这或许就是答案|最终答案只有一个)/g },
    { label: '破折号过多', regex: /—/g },
    { label: '粗体标题列表', regex: /\n\s*(?:[-*+]|\d+\.)\s+\*\*[^*]{1,20}[：:]\*\*/g },
    { label: '粗体过多', regex: /\*\*[^*]{1,24}\*\*/g },
    { label: 'Emoji/图标装饰', regex: /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu },
    { label: '英文弯引号', regex: /(“[A-Za-z][^”]{0,18}”|‘[A-Za-z][^’]{0,18}’)/g },
    { label: '装饰性引号', regex: /“[^”]{1,12}”/g },
    { label: '装腔比喻', regex: /(战场|赌桌|手术刀|显微镜下|引爆点)/g },
    { label: '生成式解释词', regex: /(注脚|脚注)/g },
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

const normalizeHeadingCandidate = (value: string) =>
  cleanText(
    value
      .replace(/^#+\s*/, '')
      .replace(/^[一二三四五六七八九十0-9]+[、.．]\s*/, '')
      .replace(/^第\s*[一二三四五六七八九十0-9]+\s*(?:部分|章|节|篇)\s*/, '')
      .replace(/^(?:导语|引言|前言|开头|中场|尾声|结语|结尾|总结|写在最后)\s*[：:]\s*/, '')
      .replace(/^(?:导语|引言|前言|开头|中场|尾声|结语|结尾|总结|写在最后)\s*$/, '')
      .replace(/[：:]\s*$/, '')
  );

const isGenericChunkTitle = (value: string) => /^第\s*\d+\s*(?:段|部分|轮写作)?$/.test(value);

const extractSecondaryHeadingTexts = (content: string) =>
  cleanText(content)
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => /^##\s+/.test(line))
    .map((line) => line.replace(/^##\s+/, '').trim())
    .filter(Boolean);

const isNonPlainArticleSubheading = (value: string) => {
  const normalized = cleanText(value);
  if (!normalized) return false;
  return (
    /^[一二三四五六七八九十0-9]+[、.．]\s*/.test(normalized) ||
    /^第\s*[一二三四五六七八九十0-9]+\s*(?:部分|章|节|篇)/.test(normalized) ||
    /[：:]/.test(normalized) ||
    /^(?:导语|引言|前言|开头|中场|尾声|结语|结尾|总结|写在最后)(?:\s|$)/.test(normalized)
  );
};

const findNonPlainSecondaryHeadings = (content: string) => extractSecondaryHeadingTexts(content).filter(isNonPlainArticleSubheading);

const uniqueStrings = (values: string[], limit = TARGET_ARTICLE_H2_MAX) => {
  const seen = new Set<string>();
  const result: string[] = [];

  values.forEach((value) => {
    const normalized = normalizeHeadingCandidate(value);
    if (!normalized || seen.has(normalized)) {
      return;
    }
    seen.add(normalized);
    result.push(normalized);
  });

  return result.slice(0, limit);
};

const countHeadingMatches = (content: string, pattern: RegExp) => (cleanText(content).match(pattern) || []).length;
const hasMarkdownTitle = (content: string) => /^#\s+/m.test(cleanText(content));
const countSecondaryHeadings = (content: string) => countHeadingMatches(content, /^##\s+/gm);

const deriveSectionHeadingPlan = (outline: string, chunkPlan: WritingChunkPlanItem[]) => {
  const sectionCandidates = uniqueStrings(
    chunkPlan.flatMap((item) => item.sections).filter((section) => section.length >= 4),
    TARGET_ARTICLE_H2_MAX
  );

  const titleCandidates = uniqueStrings(
    chunkPlan
      .map((item) => item.title)
      .filter((title) => title.length >= 4)
      .filter((title) => !isGenericChunkTitle(title)),
    TARGET_ARTICLE_H2_MAX
  );

  const outlineCandidates = uniqueStrings(extractOutlineHeadings(outline).slice(1), TARGET_ARTICLE_H2_MAX);
  const merged = uniqueStrings([...sectionCandidates, ...titleCandidates, ...outlineCandidates], TARGET_ARTICLE_H2_MAX);

  if (merged.length >= TARGET_ARTICLE_H2_MIN) {
    return merged;
  }

  return uniqueStrings(
    [...merged, ...extractOutlineHeadings(outline), ...chunkPlan.map((item) => item.title)],
    TARGET_ARTICLE_H2_MAX
  );
};

const formatChunkPlanForPrompt = (chunkPlan: WritingChunkPlanItem[]) => {
  if (chunkPlan.length === 0) {
    return '- 当前没有可用的 chunk 规划。';
  }

  return chunkPlan
    .map(
      (item) =>
        [
          `### Chunk ${item.index}`,
          `- 标题：${item.title}`,
          `- 负责小节：${item.sections.join('、') || '未指定'}`,
          `- 目标长度：约 ${item.targetLength} 字`,
          `- 写作任务：${item.purpose}`,
        ].join('\n')
    )
    .join('\n\n');
};

const formatChunkDraftsForPrompt = (chunks: string[], chunkPlan: WritingChunkPlanItem[]) => {
  if (chunks.length === 0) {
    return '当前没有 chunk 草稿。';
  }

  return chunks
    .map((chunk, index) => {
      const plan = chunkPlan[index];
      return [
        `### Chunk 原稿 ${index + 1}`,
        plan ? `规划标题：${plan.title}` : '',
        plan?.sections?.length ? `规划小节：${plan.sections.join('、')}` : '',
        truncate(chunk, 6000),
      ]
        .filter(Boolean)
        .join('\n');
    })
    .join('\n\n');
};

const buildArticleStructureChecklist = (content: string, outline: string, chunkPlan: WritingChunkPlanItem[]) => {
  const headingPlan = deriveSectionHeadingPlan(outline, chunkPlan);
  const nonPlainHeadings = findNonPlainSecondaryHeadings(content);
  const lines = [
    '## 结构检查',
    `- 当前是否已有主标题：${hasMarkdownTitle(content) ? '是' : '否'}`,
    `- 当前二级标题数量：${countSecondaryHeadings(content)} 个`,
    '- 子标题风格要求：用自然短句，不要写“第一部分”“一、”“1.”“尾声”“总结：”这类编号、结构标签或冒号前缀。',
  ];

  if (chunkPlan.length > 1 && countSecondaryHeadings(content) === 0) {
    lines.push('- 当前是分段拼接稿，但正文还没有落出二级标题。');
  }

  if (nonPlainHeadings.length > 0) {
    lines.push(`- 当前不自然的小标题：${nonPlainHeadings.slice(0, 5).join('｜')}`);
  }

  if (headingPlan.length > 0) {
    lines.push(`- 建议小标题计划：${headingPlan.join('｜')}`);
  }

  lines.push(`- 终稿目标：保留 1 个 # 标题，并确保有 ${TARGET_ARTICLE_H2_MIN}-${TARGET_ARTICLE_H2_MAX} 个 ## 子标题。`);

  return lines.join('\n');
};

const shouldAssembleArticleDraft = (content: string, chunkPlan: WritingChunkPlanItem[]) =>
  chunkPlan.length > 1 || countSecondaryHeadings(content) < TARGET_ARTICLE_H2_MIN;

const hasExplicitDesiredLength = (options: WritingTaskOptions) => Number(options.desiredLength || 0) > 0;

const getPreferredChunkLength = (options: WritingTaskOptions) => Math.max(600, Number(options.chunkLength || 0) || 1500);

const inferChunkCountFromOutline = (outline: string) => {
  const headingCount = extractOutlineHeadings(outline).length;
  if (headingCount >= 7) return 3;
  if (headingCount >= 4) return 2;
  return 1;
};

const normalizeChunkPlan = (raw: unknown, outline: string, options: WritingTaskOptions): WritingChunkPlanItem[] => {
  if (!Array.isArray(raw) || raw.length === 0) {
    const outlineSections = extractOutlineHeadings(outline);
    return [
      {
        index: 1,
        title: '全文',
        sections: outlineSections,
        targetLength: hasExplicitDesiredLength(options) ? options.desiredLength : getPreferredChunkLength(options),
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
        targetLength: Math.max(
          300,
          hasExplicitDesiredLength(options)
            ? Math.min(Number(candidate.targetLength) || getPreferredChunkLength(options), options.desiredLength)
            : Number(candidate.targetLength) || getPreferredChunkLength(options)
        ),
        purpose: sanitizeChunkText(candidate.purpose, '完成当前轮次负责的正文部分。'),
      };
    })
    .filter((item) => item.title && item.purpose);
};

const getExpectedChunkCount = (options: WritingTaskOptions) =>
  hasExplicitDesiredLength(options)
    ? Math.max(1, Math.ceil(options.desiredLength / getPreferredChunkLength(options)))
    : 1;

const buildChunkTargetLengths = (desiredLength: number, chunkCount: number, fallbackChunkLength: number) => {
  if (desiredLength <= 0) {
    return Array.from({ length: chunkCount }, () => fallbackChunkLength);
  }

  if (chunkCount <= 1) {
    return [desiredLength];
  }

  const base = Math.floor(desiredLength / chunkCount);
  const remainder = desiredLength % chunkCount;

  return Array.from({ length: chunkCount }, (_, index) => base + (index < remainder ? 1 : 0));
};

const distributeOutlineSections = (sections: string[], chunkCount: number) => {
  if (chunkCount <= 1) {
    return [sections.slice(0, 8)];
  }

  const groups = Array.from({ length: chunkCount }, () => [] as string[]);
  if (sections.length === 0) {
    return groups;
  }

  for (let index = 0; index < sections.length; index += 1) {
    const bucket = Math.min(chunkCount - 1, Math.floor((index * chunkCount) / sections.length));
    groups[bucket].push(sections[index]);
  }

  return groups.map((group) => group.slice(0, 6));
};

const buildFallbackChunkPlan = (
  outline: string,
  options: WritingTaskOptions,
  expectedChunkCount = hasExplicitDesiredLength(options) ? getExpectedChunkCount(options) : inferChunkCountFromOutline(outline)
): WritingChunkPlanItem[] => {
  const outlineSections = extractOutlineHeadings(outline);
  const groupedSections = distributeOutlineSections(outlineSections, expectedChunkCount);
  const targetLengths = buildChunkTargetLengths(
    options.desiredLength,
    expectedChunkCount,
    getPreferredChunkLength(options)
  );

  return Array.from({ length: expectedChunkCount }, (_, index) => {
    const sections = groupedSections[index] || [];
    const isFirst = index === 0;
    const isLast = index === expectedChunkCount - 1;
    const title =
      sections.length >= 2 ? `${sections[0]} / ${sections[sections.length - 1]}` : sections[0] || `第 ${index + 1} 段`;
    const purpose = isFirst
      ? '完成开篇，提出问题，并建立全文的观察角度。'
      : isLast
        ? '完成收束，总结判断，并把文章自然落到结论。'
        : '推进主体论证，承接前文，并为下一段继续铺垫。';

    return {
      index: index + 1,
      title,
      sections,
      targetLength: targetLengths[index],
      purpose,
    };
  });
};

const reconcileChunkPlanToExpectedCount = ({
  normalized,
  fallbackPlan,
  expectedChunkCount,
}: {
  normalized: WritingChunkPlanItem[];
  fallbackPlan: WritingChunkPlanItem[];
  expectedChunkCount: number;
}): WritingChunkPlanItem[] => {
  if (normalized.length === expectedChunkCount) {
    return normalized;
  }

  const buckets = Array.from({ length: expectedChunkCount }, () => [] as WritingChunkPlanItem[]);
  normalized.forEach((item, index) => {
    const bucketIndex = Math.min(expectedChunkCount - 1, Math.floor((index * expectedChunkCount) / normalized.length));
    buckets[bucketIndex].push(item);
  });

  return fallbackPlan.map((fallback, index) => {
    const bucket = buckets[index];
    if (!bucket || bucket.length === 0) {
      return fallback;
    }

    const mergedSections = uniqueStrings([...bucket.flatMap((item) => item.sections || []), ...fallback.sections], 6);
    if (bucket.length === 1) {
      const [item] = bucket;
      return {
        ...fallback,
        title: sanitizeChunkText(item.title, fallback.title),
        sections: mergedSections.length > 0 ? mergedSections : fallback.sections,
        targetLength: fallback.targetLength,
        purpose: sanitizeChunkText(item.purpose, fallback.purpose),
      };
    }

    const titleCandidates = bucket
      .map((item) => sanitizeChunkText(item.title))
      .filter(Boolean)
      .filter((title) => !isGenericChunkTitle(title));
    const mergedTitleSeed =
      titleCandidates.length >= 2
        ? `${titleCandidates[0]} / ${titleCandidates[titleCandidates.length - 1]}`
        : titleCandidates[0] || fallback.title;

    return {
      ...fallback,
      title: sanitizeChunkText(mergedTitleSeed, fallback.title),
      sections: mergedSections.length > 0 ? mergedSections : fallback.sections,
      targetLength: fallback.targetLength,
      purpose: fallback.purpose,
    };
  });
};

const normalizeChunkPlanStrict = (raw: unknown, outline: string, options: WritingTaskOptions): WritingChunkPlanItem[] => {
  const expectedChunkCount = hasExplicitDesiredLength(options)
    ? getExpectedChunkCount(options)
    : inferChunkCountFromOutline(outline);
  const fallbackPlan = buildFallbackChunkPlan(outline, options, expectedChunkCount);

  if (!Array.isArray(raw) || raw.length === 0) {
    console.warn('[chunk-plan] empty or invalid model output, using fallback plan', {
      expectedChunkCount,
      desiredLength: options.desiredLength,
      chunkLength: options.chunkLength,
    });
    return fallbackPlan;
  }

  const normalized = normalizeChunkPlan(raw, outline, options);
  if (normalized.length !== expectedChunkCount) {
    const reconciled = reconcileChunkPlanToExpectedCount({
      normalized,
      fallbackPlan,
      expectedChunkCount,
    });
    console.warn('[chunk-plan] model returned unexpected chunk count, using reconciled plan', {
      expectedChunkCount,
      actualChunkCount: normalized.length,
      returnedTitles: normalized.map((item) => item.title),
      returnedSections: normalized.map((item) => item.sections),
      desiredLength: options.desiredLength,
      chunkLength: options.chunkLength,
    });
    return reconciled;
  }

  return normalized.map((item, index) => ({
    index: index + 1,
    title: item.title || fallbackPlan[index].title,
    sections: item.sections.length > 0 ? item.sections : fallbackPlan[index].sections,
    targetLength: fallbackPlan[index].targetLength,
    purpose: item.purpose || fallbackPlan[index].purpose,
  }));
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

const buildCheckedTextPrompt = async ({
  prompt,
  systemInstruction,
  model = getGenModel(),
  uploadedFiles = [],
  tools,
  maxOutputTokens = 8192,
  maxContinuationRounds = TEXT_CONTINUATION_MAX_ROUNDS,
}: {
  prompt: string;
  systemInstruction: string;
  model?: string;
  uploadedFiles?: UploadedFile[];
  tools?: any[];
  maxOutputTokens?: number;
  maxContinuationRounds?: number;
}): Promise<CompletedTextResult> => {
  let response = await buildTextPrompt({
    prompt,
    systemInstruction,
    model,
    uploadedFiles,
    tools,
    maxOutputTokens,
  });
  logTextResponseMeta('text-request', response);

  let text = cleanText(response.text);
  let finishReason = getPrimaryCandidate(response)?.finishReason;

  for (let round = 1; finishReason === FinishReason.MAX_TOKENS && round <= maxContinuationRounds; round += 1) {
    response = await buildTextPrompt({
      prompt: buildContinuationPrompt(prompt, text),
      systemInstruction,
      model,
      uploadedFiles,
      tools,
      maxOutputTokens,
    });
    logTextResponseMeta(`text-request continuation ${round}`, response);
    text = mergeContinuationText(text, response.text);
    finishReason = getPrimaryCandidate(response)?.finishReason;
  }

  if (
    finishReason &&
    finishReason !== FinishReason.STOP &&
    finishReason !== FinishReason.FINISH_REASON_UNSPECIFIED
  ) {
    throw new Error(formatTextFinishReasonError(finishReason, getPrimaryCandidate(response)?.finishMessage));
  }

  return {
    text,
    response,
  };
};

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
    '围绕当前轨道执行 Google Search 研究，并整理成给写作者直接使用的研究笔记。',
    `当前研究轨道：${track}`,
    `本轮重点：${focus}`,
    '要求：',
    '1. 必须先调用 Google Search，再整理结果，不要只靠记忆回答。',
    '2. 输出一份结构清晰的 Markdown 研究笔记，优先覆盖：背景、时间线、关键主体、公开动作、数据点、争议点。',
    '3. 对重要事实尽量给出具体口径；无法确认的内容直接写“待核实”。',
    '4. 如果搜索结果之间存在冲突，明确标出冲突点，不要强行合并。',
    '5. 这是一份研究稿，不是最终文章，不要为了文采扩写。',
  ].join('\n\n');

  const response = await buildTextPrompt({
    prompt,
    systemInstruction: `你是${track}资料员。先搜索，再写成可供后续写作调用的研究笔记。`,
    model: getSearchModel(),
    uploadedFiles,
    tools: [{ googleSearch: {} }],
    maxOutputTokens: 8192,
  });

  return formatSearchGenerateContentResult({
    title,
    track,
    response,
  });
};

const generateDeepResearchTrack = async ({
  topic,
  uploadedFiles,
  options,
  title,
  focus,
  onStatus,
}: {
  topic: string;
  uploadedFiles: UploadedFile[];
  options: WritingTaskOptions;
  title: string;
  focus: string;
  onStatus?: (message: string) => void;
}): Promise<ResearchTrackResult> => {
  const prompt = [
    buildTaskBrief(topic, '待生成', options),
    '执行一次 Deep Research。',
    `研究重点：${focus}`,
    '你需要围绕主题执行原生 Deep Research，尽量覆盖背景、关键主体、时间线、公开动作、争议点和可核查来源。',
    '程序会直接保留 Deep Research 的原生输出块，不会再让其他模型做二次总结。',
  ].join('\n\n');

  const interaction = await streamDeepResearchInteraction({
    prompt,
    uploadedFiles,
    onStatus,
  });

  return formatDeepResearchInteractionResult({
    title,
    interaction,
  });
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
  await ensureRuntimePromptAssets(options.styleProfile);
  setRuntimeInstructionOptions(options);
  const trackResults: ResearchTrackResult[] = [];

  for (const track of RESEARCH_TRACKS) {
    const result = await runTimedStage({
      label: track.track,
      statusMessage: track.status,
      onStatus,
      timeoutMs: 180000,
      logMeta: {
        api: 'models.generateContent',
        model: getSearchModel(),
        tool: 'googleSearch',
        track: track.track,
      },
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
      timeoutMs: DEEP_RESEARCH_STAGE_TIMEOUT_MS,
      logMeta: {
        api: 'interactions',
        agent: 'deep-research-pro-preview-12-2025',
        mode: 'stream',
      },
      work: () =>
        generateDeepResearchTrack({
          topic,
          uploadedFiles,
          options,
          onStatus,
          title: 'Deep Research 原生输出',
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
  await ensureRuntimePromptAssets(options.styleProfile);
  setRuntimeInstructionOptions(options);
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
  await ensureRuntimePromptAssets(options.styleProfile);
  setRuntimeInstructionOptions(options);
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
  await ensureRuntimePromptAssets(options.styleProfile);
  setRuntimeInstructionOptions(options);
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

  const response = await buildCheckedTextPrompt({
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

  const response = await buildCheckedTextPrompt({
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

  const response = await buildCheckedTextPrompt({
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
  const expectedChunks = hasExplicitDesiredLength(options)
    ? getExpectedChunkCount(options)
    : inferChunkCountFromOutline(outline);
  const prompt = [
    buildTaskBrief(topic, direction, options),
    `Strict chunk count: return exactly ${expectedChunks} chunks, no more and no less.`,
    `The top-level JSON array length must be exactly ${expectedChunks}. Returning ${expectedChunks - 1}, ${expectedChunks + 1}, or wrapping the array in an object is invalid.`,
    hasExplicitDesiredLength(options)
      ? `Keep the sum of all targetLength values close to ${options.desiredLength}.`
      : `If total length is not specified, let the article expand naturally and use roughly ${getPreferredChunkLength(options)} characters per chunk as a soft reference.`,
    `请把这份大纲严格拆成 ${expectedChunks} 个写作 chunk，不多不少。`,
    '每个 chunk 返回：title、sections、targetLength、purpose。',
    '每个 chunk 对象都必须包含这 4 个字段，不能省略，不能返回别名，不能额外包一层 chunks 字段。',
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
        required: ['title', 'sections', 'targetLength', 'purpose'],
      },
    },
  });

  try {
    return normalizeChunkPlanStrict(JSON.parse(unwrapCodeFence(response.text)), outline, options);
  } catch {
    return normalizeChunkPlanStrict([], outline, options);
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
    '4. 句子要自然，段落要推进，不要把正文写成条列；但如果对比、参数或多维数据更适合表格，可以在正文中写简洁的 Markdown 表格。',
    '5. 本轮只完成分配给你的部分，不要抢写后文。',
    '6. 参考模板文的节奏、密度和气质，但不要照抄模板句子。',
    buildMarkdownTableGuidanceBlock(),
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

  const response = await buildCheckedTextPrompt({
    prompt,
    systemInstruction: buildSystemInstruction('你是商业文章作者，负责按 chunk 计划续写正文。'),
    maxOutputTokens: 9000,
  });

  return cleanText(response.text);
};

const assembleArticleDraft = async ({
  topic,
  direction,
  outline,
  draft,
  writingInsights,
  referenceArticles,
  chunkPlan,
  chunks,
  options,
}: {
  topic: string;
  direction: string;
  outline: string;
  draft: string;
  writingInsights: string;
  referenceArticles: ReferenceTemplateArticle[];
  chunkPlan: WritingChunkPlanItem[];
  chunks: string[];
  options: WritingTaskOptions;
}) => {
  assertFullDocumentWithinLimit(draft, '终稿缝合输入');
  const headingPlan = deriveSectionHeadingPlan(outline, chunkPlan);
  const prompt = [
    buildTaskBrief(topic, direction, options),
    '你是终稿组装编辑。现在手里是按 chunk 写出的正文草稿，请把它缝合成一篇完整文章。',
    '这一步不是重写，只做结构缝合和最小必要修订。',
    '硬性要求：',
    '1. 保留当前标题、核心判断、论证顺序和大部分原句。',
    `2. 输出必须是一篇完整的 Markdown 文章，包含 1 个 # 标题和 ${TARGET_ARTICLE_H2_MIN}-${TARGET_ARTICLE_H2_MAX} 个 ## 子标题。`,
    '3. 子标题优先使用下方“小标题计划”和当前大纲，不另起一套新结构。',
    '4. 子标题必须是自然短句，不要写“第一部分”“一、”“1.”“尾声”“总结：”这类编号、阶段标签或冒号前缀。',
    '5. 重点处理 chunk 接缝：重复开头、重复收束、转场突兀、段落断裂、信息堆叠。',
    '6. 除非为了衔接绝对必要，不要整段重写；能删一句、并一句、补一句过渡，就不要大改。',
    '7. 不要引入当前稿件之外的新事实、新论点、新例子。',
    '8. 正文保持自然段推进，不要改写成条目列表；但如果某段信息天然适合对比、参数或时间线表格，可以保留或整理成简洁的 Markdown 表格。',
    buildMarkdownTableGuidanceBlock(),
    '结构检查：',
    buildArticleStructureChecklist(draft, outline, chunkPlan),
    headingPlan.length > 0 ? `小标题计划：\n${headingPlan.map((item, index) => `${index + 1}. ${item}`).join('\n')}` : '',
    'chunk 规划：',
    formatChunkPlanForPrompt(chunkPlan),
    '原始 chunk 草稿：',
    formatChunkDraftsForPrompt(chunks, chunkPlan),
    'writing_insights.md：',
    writingInsights,
    '参考模板文：',
    formatReferenceTemplatesForPrompt(referenceArticles),
    '当前整稿：',
    truncate(draft, MAX_DRAFT_CHARS),
    '只输出缝合后的完整文章。',
  ]
    .filter(Boolean)
    .join('\n\n');

  const response = await buildCheckedTextPrompt({
    prompt,
    systemInstruction: buildSystemInstruction('你是终稿组装编辑，只在现有稿件基础上做结构缝合，禁止另起一篇。'),
    maxOutputTokens: 12000,
  });

  return cleanText(response.text);
};

const normalizeEditorialStrategy = (value: unknown, passIndex: number): EditorialStrategy => {
  const normalized = cleanText(String(value || '')).toLowerCase();
  if (normalized === 'done') return 'done';
  if (normalized === 'structure_tune') return 'structure_tune';
  if (normalized === 'continuity_tune') return 'continuity_tune';
  if (normalized === 'micro_polish') return 'micro_polish';
  return passIndex === 1 ? 'continuity_tune' : 'micro_polish';
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
  passIndex: number
): EditorialReviewReport => {
  const candidate = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const issues = normalizeEditorialIssues(candidate.issues);
  const strategy = normalizeEditorialStrategy(candidate.strategy, passIndex);
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

const normalizeCommercialHumanizerIssues = (value: unknown): CommercialHumanizerIssue[] => {
  if (!Array.isArray(value)) return [];

  return value
    .map((item, index) => {
      const candidate = item && typeof item === 'object' ? (item as Record<string, unknown>) : {};
      return {
        category: sanitizeChunkText(candidate.category, 'residual_ai_trace'),
        severity: sanitizeChunkText(candidate.severity, 'medium'),
        title: sanitizeChunkText(candidate.title, `去AI化问题 ${index + 1}`),
        diagnosis: sanitizeChunkText(candidate.diagnosis, ''),
        instruction: sanitizeChunkText(candidate.instruction, ''),
        excerpt: sanitizeChunkText(candidate.excerpt, ''),
      };
    })
    .filter((issue) => issue.instruction)
    .slice(0, COMMERCIAL_HUMANIZER_MAX_ISSUES);
};

const normalizeCommercialHumanizerReport = (raw: unknown): CommercialHumanizerReport => {
  const candidate = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const issues = normalizeCommercialHumanizerIssues(candidate.issues);
  const readyValue = cleanText(String(candidate.ready || ''));
  const ready = /^(yes|true|ready|done)$/i.test(readyValue) || issues.length === 0 ? 'yes' : 'no';

  return {
    summary: sanitizeChunkText(candidate.summary, issues.length > 0 ? '仍有残余 AI 痕迹和模板化表达。' : '未发现明显残余 AI 痕迹。'),
    ready,
    toneGuardrail: sanitizeChunkText(
      candidate.toneGuardrail,
      '保持商业文章语体，不向随笔腔、聊天腔或宣传稿滑动。'
    ),
    unresolvedRisk: sanitizeChunkText(
      candidate.unresolvedRisk,
      issues.length > 0 ? '仍有套话、黑话或模板化表达影响发布感。' : '未发现明显残余风险。'
    ),
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

const formatCommercialHumanizerMarkdown = (
  report: CommercialHumanizerReport,
  title = '商业稿去AI化'
) => {
  const issueLines =
    report.issues.length > 0
      ? report.issues
          .map((issue, index) =>
            [
              `### 去AI化问题 ${index + 1}：${issue.title}`,
              `- 类别：${issue.category}`,
              `- 严重度：${issue.severity}`,
              issue.excerpt ? `- 触发片段：${issue.excerpt}` : '',
              issue.diagnosis ? `- 诊断：${issue.diagnosis}` : '',
              `- 修改指令：${issue.instruction}`,
            ]
              .filter(Boolean)
              .join('\n')
          )
          .join('\n\n')
      : '- 本轮未发现明显残余 AI 痕迹。';

  return [
    `## ${title}`,
    `- 总体判断：${report.summary}`,
    `- 是否通过：${report.ready}`,
    `- 语体护栏：${report.toneGuardrail}`,
    `- 残余风险：${report.unresolvedRisk}`,
    '',
    '### 重点问题',
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
  chunkPlan,
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
  chunkPlan: WritingChunkPlanItem[];
}): Promise<EditorialReviewReport> => {
  const prompt = [
    buildTaskBrief(topic, direction, options),
    `你现在是顶级商业杂志的终稿诊断编辑。这是第 ${passIndex} / ${MAGAZINE_EDITORIAL_MAX_PASSES} 轮终审。`,
    '你的职责是诊断剩余问题，不是要求另写一篇。',
    '终审目标：在原文基础上做最小必要修改，让分段写出的内容成为一篇完整、自然、可发布的文章。',
    '你必须把当前稿件与参考模板文直接对比，重点检查：是否已经是一篇完整文章、是否有明确且自然的 ## 子标题、chunk 接缝、重复开头/收束、段落推进、语气统一、遣词克制、是否自然。',
    '如果正文里出现简洁的 Markdown 表格，并且它确实承担了对比、参数或数据整理功能，不要把它误判为格式噪音或 AI 版式痕迹。',
    '如果子标题出现“第一部分”“一、”“1.”“尾声”“总结：”这类编号、阶段标签或冒号前缀，要明确判为问题。',
    '这是渐进式审稿。如果前一轮已经解决的问题，本轮不要重复提出。',
    `最多返回 ${MAGAZINE_MAX_ISSUES_PER_PASS} 个当前真正阻塞发布的问题。`,
    '返回 JSON 对象，字段为：summary, ready, strategy, templateAlignment, unresolvedRisk, issues。',
    'strategy 只能是 structure_tune、continuity_tune、micro_polish、done。',
    '如果问题涉及子标题缺失、结构断裂、明显拼接感，strategy 用 structure_tune。',
    '如果问题主要是段落承接、收束、重复或推进不顺，strategy 用 continuity_tune。',
    '如果只剩句级用词、节奏、AI 腔问题，strategy 用 micro_polish。',
    'issues 中每项必须含有：severity, scope, title, diagnosis, instruction, excerpt。',
    '输出内容使用简体中文。',
    buildMarkdownTableGuidanceBlock(),
    '此前终审记录：',
    formatEditorialHistoryForPrompt(reviewHistory),
    '结构检查：',
    buildArticleStructureChecklist(draft, outline, chunkPlan),
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
    return normalizeEditorialReviewReport(JSON.parse(unwrapCodeFence(response.text)), passIndex);
  } catch {
    return normalizeEditorialReviewReport({}, passIndex);
  }
};

const reviseArticleEditorialPass = async ({
  topic,
  direction,
  outline,
  referenceArticles,
  draft,
  review,
  revisionMode,
  passIndex,
  chunkPlan,
  options,
}: {
  topic: string;
  direction: string;
  outline: string;
  referenceArticles: ReferenceTemplateArticle[];
  draft: string;
  review: EditorialReviewReport;
  revisionMode: EditorialStrategy;
  passIndex: number;
  chunkPlan: WritingChunkPlanItem[];
  options: WritingTaskOptions;
}) => {
  assertFullDocumentWithinLimit(draft, '终稿修订输入');
  const headingPlan = deriveSectionHeadingPlan(outline, chunkPlan);
  const revisionInstruction =
    revisionMode === 'structure_tune'
      ? '这一轮只允许做结构缝合：补或调整 ## 子标题、修 chunk 接缝、删除重复开头和重复收束、补极短过渡、必要时做相邻段落的小范围挪动。'
      : revisionMode === 'continuity_tune'
        ? '这一轮只允许做段落级连贯性修订：修转场、并重复、压缩拖沓句、补承上启下的一两句。'
        : '这一轮只允许做句级和短语级精修；能改一个词就不要改一句，能改一句就不要改一段。';

  const prompt = [
    buildTaskBrief(topic, direction, options),
    `这是第 ${passIndex} 轮修订。`,
    revisionInstruction,
    '硬性要求：',
    '1. 修的是当前稿件，不是另起一篇。',
    '2. 不要新增当前稿件之外的事实、论点、例子和引用。',
    '3. 保持简体中文。',
    '4. 用参考模板文统一语气、段落密度和开头节奏。',
    '5. 只解决下列仍未解决的问题，不要打扰已经成立的段落。',
    '6. 默认保留当前标题、整体论证顺序和大部分原句。',
    `6a. ${MARKDOWN_TABLE_PRESERVE_RULE}`,
    revisionMode === 'structure_tune'
      ? `7. 如果需要补子标题，只能在以下计划和大纲范围内落出 ${TARGET_ARTICLE_H2_MIN}-${TARGET_ARTICLE_H2_MAX} 个 ## 子标题。`
      : '7. 除非问题明确要求，否则不要改动既有子标题和段落顺序。',
    '8. 子标题必须写成自然短句，不要带“第一部分”“一、”“1.”“尾声”“总结：”这类编号、阶段标签或冒号前缀。',
    buildMarkdownTableGuidanceBlock(),
    '终审意见：',
    formatEditorialReviewMarkdown(review, passIndex),
    '结构检查：',
    buildArticleStructureChecklist(draft, outline, chunkPlan),
    headingPlan.length > 0 ? `小标题计划：\n${headingPlan.map((item, index) => `${index + 1}. ${item}`).join('\n')}` : '',
    'chunk 规划：',
    formatChunkPlanForPrompt(chunkPlan),
    '参考模板文：',
    formatReferenceTemplatesForPrompt(referenceArticles),
    '大纲：',
    outline,
    '当前稿件：',
    truncate(draft, MAX_DRAFT_CHARS),
    '只输出修订后的完整文章。',
  ].join('\n\n');

  const response = await buildCheckedTextPrompt({
    prompt,
    systemInstruction: buildSystemInstruction('你是杂志级修订编辑，负责渐进式修文而不是反复重写。'),
    maxOutputTokens: 12000,
  });

  return cleanText(response.text);
};

const reviewCommercialHumanizationPass = async ({
  topic,
  direction,
  outline,
  draft,
  writingInsights,
  options,
  referenceArticles,
  chunkPlan,
}: {
  topic: string;
  direction: string;
  outline: string;
  draft: string;
  writingInsights: string;
  options: WritingTaskOptions;
  referenceArticles: ReferenceTemplateArticle[];
  chunkPlan: WritingChunkPlanItem[];
}): Promise<CommercialHumanizerReport> => {
  const prompt = [
    buildTaskBrief(topic, direction, options),
    buildCommercialHumanizerBlock(),
    buildCommercialHumanizerPatternBlock(),
    buildCommercialHumanizerChecklistBlock(),
    '你现在是商业杂志发稿前的去AI化编辑。',
    '你的任务是诊断残余 AI 痕迹和模板化表达，不是把文章改成口语、随笔或个人风格写作。',
    '不要套用原始 humanizer 里“适当使用我”“允许一些混乱”“故意增加个性”的随笔化建议。',
    '只检查会直接影响“像成熟编辑写成的商业文章”这一发布感的问题。',
    '重点检查：模板化连接句、万能商业黑话、模糊主体归因、过度工整排比、空泛总结、聊天式客套、装饰性引号和万能积极结尾。',
    '同时检查：知名度堆砌、挑战与未来展望公式段、协作式套话、知识截止免责声明、破折号/粗体/emoji/标题列表等格式残留。',
    '如果正文里出现简洁的 Markdown 表格，并且它确实承担了对比、参数或数据整理功能，不要把它误判为 AI 版式痕迹。',
    '如果某处只是正常商业写作表达，不要误判为 AI 腔。',
    `最多返回 ${COMMERCIAL_HUMANIZER_MAX_ISSUES} 个问题。`,
    buildMarkdownTableGuidanceBlock(),
    '返回 JSON 对象，字段为：summary, ready, toneGuardrail, unresolvedRisk, issues。',
    'issues 中每项必须含有：category, severity, title, diagnosis, instruction, excerpt。',
    '输出内容使用简体中文。',
    '结构检查：',
    buildArticleStructureChecklist(draft, outline, chunkPlan),
    '参考模板文：',
    formatReferenceTemplatesForPrompt(referenceArticles),
    'writing_insights.md：',
    writingInsights,
    '本地风格检查：',
    lintStyle(draft),
    '当前稿件：',
    truncate(draft, MAX_DRAFT_CHARS),
  ].join('\n\n');

  const response = await buildJsonPrompt({
    prompt,
    systemInstruction: buildSystemInstruction(
      '你是商业文章去AI化编辑，只识别真正影响商业文风和发布感的残余 AI 痕迹。'
    ),
    schema: {
      type: Type.OBJECT,
      properties: {
        summary: { type: Type.STRING },
        ready: { type: Type.STRING },
        toneGuardrail: { type: Type.STRING },
        unresolvedRisk: { type: Type.STRING },
        issues: {
          type: Type.ARRAY,
          items: {
            type: Type.OBJECT,
            properties: {
              category: { type: Type.STRING },
              severity: { type: Type.STRING },
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
    return normalizeCommercialHumanizerReport(JSON.parse(unwrapCodeFence(response.text)));
  } catch {
    return normalizeCommercialHumanizerReport({});
  }
};

const reviseCommercialHumanizationPass = async ({
  topic,
  direction,
  outline,
  draft,
  writingInsights,
  referenceArticles,
  report,
  chunkPlan,
  options,
}: {
  topic: string;
  direction: string;
  outline: string;
  draft: string;
  writingInsights: string;
  referenceArticles: ReferenceTemplateArticle[];
  report: CommercialHumanizerReport;
  chunkPlan: WritingChunkPlanItem[];
  options: WritingTaskOptions;
}) => {
  assertFullDocumentWithinLimit(draft, '商业稿去AI化输入');
  const headingPlan = deriveSectionHeadingPlan(outline, chunkPlan);
  const prompt = [
    buildTaskBrief(topic, direction, options),
    buildCommercialHumanizerBlock(),
    buildCommercialHumanizerPatternBlock(),
    buildCommercialHumanizerChecklistBlock(),
    '你现在执行商业稿去AI化修订。',
    '目标是只清理下列已识别的 AI 痕迹，让文本更像成熟编辑写出的商业文章。',
    '这不是重写轮次，只允许做词、短句和局部句群级的最小必要修改。',
    '硬性要求：',
    '1. 保留标题、## 子标题、段落顺序、核心论点、事实、案例和引用。',
    '2. 不新增当前稿件之外的新事实、新论点和新例子。',
    '3. 不要改成第一人称抒情、聊天腔、短视频口播腔、访谈腔或鸡汤结尾。',
    '4. 能删掉一个套话就不要重写整段；能把黑话改具体就不要扩写。',
    '5. 遇到模糊主体时，如果当前稿件无法明确主体，优先删除或改成更克制表达，不要捏造来源。',
    '6. 结尾只允许回到文中已经建立的判断，不补“未来已来”“值得思考”这类万能积极收束。',
    '7. 如果出现破折号、粗体、emoji、内联标题列表等版式痕迹，优先去掉格式腔，而不是新增装饰。',
    '8. 不要引入 humanizer 原文里“适当使用我”“允许一些混乱”那类会把商业文章改成个人随笔的处理。',
    `9. ${MARKDOWN_TABLE_PRESERVE_RULE}`,
    buildMarkdownTableGuidanceBlock(),
    '商业稿去AI化诊断：',
    formatCommercialHumanizerMarkdown(report),
    '结构检查：',
    buildArticleStructureChecklist(draft, outline, chunkPlan),
    headingPlan.length > 0 ? `小标题计划：\n${headingPlan.map((item, index) => `${index + 1}. ${item}`).join('\n')}` : '',
    '参考模板文：',
    formatReferenceTemplatesForPrompt(referenceArticles),
    'writing_insights.md：',
    writingInsights,
    '本地风格检查：',
    lintStyle(draft),
    '当前稿件：',
    truncate(draft, MAX_DRAFT_CHARS),
    '只输出修订后的完整文章。',
  ]
    .filter(Boolean)
    .join('\n\n');

  const response = await buildCheckedTextPrompt({
    prompt,
    systemInstruction: buildSystemInstruction(
      '你是商业文章去AI化修订编辑，只做最小必要修改并保持杂志式商业文体。'
    ),
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

  const response = await buildCheckedTextPrompt({
    prompt,
    systemInstruction: buildSystemInstruction('你是商学院教学指南编辑，只在需要时生成 TN。'),
    maxOutputTokens: 6000,
  });

  return cleanText(response.text);
};

const reviewAndFinalizeArticle = async ({
  topic,
  ammoLibrary,
  direction,
  outline,
  options,
  hydratedReferenceArticles,
  writingInsights,
  evidenceCards,
  chunkPlan,
  chunkDrafts,
  initialDraft,
  onStatus,
  onSnapshot,
}: {
  topic: string;
  ammoLibrary: string;
  direction: string;
  outline: string;
  options: WritingTaskOptions;
  hydratedReferenceArticles: ReferenceTemplateArticle[];
  writingInsights: string;
  evidenceCards: string;
  chunkPlan: WritingChunkPlanItem[];
  chunkDrafts: string[];
  initialDraft: string;
  onStatus?: (message: string) => void;
  onSnapshot?: (snapshot: ArticleProgressSnapshot) => void;
}) => {
  let articleWorkingDraft = initialDraft;
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
          chunkPlan,
        }),
    });

    reviewHistory.push(review);

    if (review.ready === 'yes' || review.strategy === 'done' || review.issues.length === 0) {
      break;
    }

    const revisionMode = normalizeEditorialStrategy(review.strategy, passIndex);

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
          referenceArticles: hydratedReferenceArticles,
          draft: articleWorkingDraft,
          review,
          revisionMode,
          passIndex,
          chunkPlan,
          options,
        }),
    });
  }

  const initialHumanizerReport = await runTimedStage({
    label: '商业稿去AI化诊断',
    statusMessage: '正在检查残余 AI 腔和模板化表达...',
    onStatus,
    timeoutMs: 180000,
    work: () =>
      reviewCommercialHumanizationPass({
        topic,
        direction,
        outline,
        draft: articleWorkingDraft,
        writingInsights,
        options,
        referenceArticles: hydratedReferenceArticles,
        chunkPlan,
      }),
  });

  const humanizerCritiqueSections = [formatCommercialHumanizerMarkdown(initialHumanizerReport, '商业稿去AI化初检')];
  let finalHumanizerReport = initialHumanizerReport;

  if (initialHumanizerReport.ready !== 'yes' && initialHumanizerReport.issues.length > 0) {
    articleWorkingDraft = await runTimedStage({
      label: '商业稿去AI化修订',
      statusMessage: '正在清理残余 AI 痕迹并保持商业文风...',
      onStatus,
      timeoutMs: 240000,
      work: () =>
        reviseCommercialHumanizationPass({
          topic,
          direction,
          outline,
          draft: articleWorkingDraft,
          writingInsights,
          referenceArticles: hydratedReferenceArticles,
          report: initialHumanizerReport,
          chunkPlan,
          options,
        }),
    });

    finalHumanizerReport = await runTimedStage({
      label: '商业稿去AI化复检',
      statusMessage: '正在复检去AI化结果...',
      onStatus,
      timeoutMs: 180000,
      work: () =>
        reviewCommercialHumanizationPass({
          topic,
          direction,
          outline,
          draft: articleWorkingDraft,
          writingInsights,
          options,
          referenceArticles: hydratedReferenceArticles,
          chunkPlan,
        }),
    });

    humanizerCritiqueSections.push(formatCommercialHumanizerMarkdown(finalHumanizerReport, '商业稿去AI化复检'));
  }

  const critique = `${[
    reviewHistory.map((review, index) => formatEditorialReviewMarkdown(review, index + 1)).join('\n\n'),
    ...humanizerCritiqueSections,
  ]
    .filter(Boolean)
    .join('\n\n')}\n\n`;

  emitArticleSnapshot(onSnapshot, {
    type: 'draft_editorial',
    label: '终审后工作稿',
    description: '已完成结构缝合、终审修订与商业稿去AI化，可直接从这里继续句级定稿。',
    resumeAction: 'continue_from_draft',
    data: {
      referenceArticles: hydratedReferenceArticles,
      writingInsights,
      evidenceCards,
      chunkPlan,
      chunkDrafts,
      critique,
      workingArticleDraft: articleWorkingDraft,
    },
  });

  const articleContent = await runTimedStage({
    label: '句级终修',
    statusMessage: '正在做最后的句级收束...',
    onStatus,
    timeoutMs: LINE_POLISH_TIMEOUT_MS,
    work: () =>
      runFinalPolish(
        ammoLibrary,
        articleWorkingDraft,
        undefined,
        undefined,
        hydratedReferenceArticles,
        'article',
        outline,
        chunkPlan
      ),
  });

  emitArticleSnapshot(onSnapshot, {
    type: 'final_article',
    label: '终稿正文',
    description: options.includeTeachingNotes ? '正文已定稿，可从这里继续生成 TN。' : '正文已定稿，可随时回到这里继续人工修改。',
    resumeAction: options.includeTeachingNotes ? 'continue_teaching_notes' : 'view_only',
    data: {
      referenceArticles: hydratedReferenceArticles,
      writingInsights,
      evidenceCards,
      chunkPlan,
      chunkDrafts,
      critique,
      workingArticleDraft: articleWorkingDraft,
      articleContent,
    },
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

    emitArticleSnapshot(onSnapshot, {
      type: 'teaching_notes',
      label: 'TN / 讨论指南',
      description: '教学指南已生成，可随时回到这里继续人工整理。',
      resumeAction: 'view_only',
      data: {
        referenceArticles: hydratedReferenceArticles,
        writingInsights,
        evidenceCards,
        chunkPlan,
        chunkDrafts,
        critique,
        workingArticleDraft: articleWorkingDraft,
        articleContent,
        teachingNotes,
      },
    });
  }

  return {
    critique,
    articleContent,
    teachingNotes,
    workingArticleDraft: articleWorkingDraft,
  };
};

export const generateArticlePackage = async (
  topic: string,
  ammoLibrary: string,
  direction: string,
  outline: string,
  referenceArticles: ReferenceTemplateArticle[],
  options: WritingTaskOptions,
  onStatus?: (message: string) => void,
  onSnapshot?: (snapshot: ArticleProgressSnapshot) => void
): Promise<ArticlePackageResult> => {
  await ensureRuntimePromptAssets(options.styleProfile);
  setRuntimeInstructionOptions(options);
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

  emitArticleSnapshot(onSnapshot, {
    type: 'chunk_plan_ready',
    label: '分段写作规划',
    description: 'chunk 计划已生成，可从这里直接继续写剩余正文。',
    resumeAction: 'continue_from_chunks',
    data: {
      referenceArticles: hydratedReferenceArticles,
      writingInsights,
      evidenceCards,
      chunkPlan,
      chunkDrafts: [],
    },
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

    emitArticleSnapshot(onSnapshot, {
      type: 'chunk_draft',
      label: `Chunk ${chunk.index} 初稿`,
      description: `已保存第 ${chunk.index}/${chunkPlan.length} 段初稿，可从这里继续补写后续 chunk。`,
      resumeAction: 'continue_from_chunks',
      sourceChunkIndex: chunk.index,
      data: {
        referenceArticles: hydratedReferenceArticles,
        writingInsights,
        evidenceCards,
        chunkPlan,
        chunkDrafts: [...chunks],
        workingArticleDraft: cleanText(chunks.join('\n\n')),
      },
    });
  }

  const draft = cleanText(chunks.join('\n\n'));
  let articleWorkingDraft = draft;
  let assembledDraft = '';

  if (shouldAssembleArticleDraft(articleWorkingDraft, chunkPlan)) {
    articleWorkingDraft = await runTimedStage({
      label: '终稿结构缝合',
      statusMessage: '正在把分段草稿缝合成完整文章...',
      onStatus,
      timeoutMs: 240000,
      work: () =>
        assembleArticleDraft({
          topic,
          direction,
          outline,
          draft: articleWorkingDraft,
          writingInsights,
          referenceArticles: hydratedReferenceArticles,
          chunkPlan,
          chunks,
          options,
        }),
    });

    assembledDraft = articleWorkingDraft;
    emitArticleSnapshot(onSnapshot, {
      type: 'draft_assembled',
      label: 'Chunk 缝合稿',
      description: '已把 chunk 草稿缝合为完整文章，可从这里继续终审与定稿。',
      resumeAction: 'continue_from_draft',
      data: {
        referenceArticles: hydratedReferenceArticles,
        writingInsights,
        evidenceCards,
        chunkPlan,
        chunkDrafts: [...chunks],
        assembledDraft,
        workingArticleDraft: articleWorkingDraft,
      },
    });
  }

  const { critique, articleContent, teachingNotes, workingArticleDraft } = await reviewAndFinalizeArticle({
    topic,
    ammoLibrary,
    direction,
    outline,
    options,
    hydratedReferenceArticles,
    writingInsights,
    evidenceCards,
    chunkPlan,
    chunkDrafts: [...chunks],
    initialDraft: articleWorkingDraft,
    onStatus,
    onSnapshot,
  });

  return {
    referenceArticles: hydratedReferenceArticles,
    writingInsights,
    evidenceCards,
    chunkPlan,
    chunkDrafts: [...chunks],
    assembledDraft: assembledDraft || undefined,
    workingArticleDraft,
    critique,
    articleContent,
    teachingNotes,
  };
};

export const continueArticleFromChunkDrafts = async ({
  topic,
  ammoLibrary,
  direction,
  outline,
  referenceArticles,
  options,
  writingInsights,
  evidenceCards,
  chunkPlan,
  chunkDrafts,
  onStatus,
  onSnapshot,
}: {
  topic: string;
  ammoLibrary: string;
  direction: string;
  outline: string;
  referenceArticles: ReferenceTemplateArticle[];
  options: WritingTaskOptions;
  writingInsights: string;
  evidenceCards: string;
  chunkPlan: WritingChunkPlanItem[];
  chunkDrafts: string[];
  onStatus?: (message: string) => void;
  onSnapshot?: (snapshot: ArticleProgressSnapshot) => void;
}): Promise<ArticlePackageResult> => {
  await ensureRuntimePromptAssets(options.styleProfile);
  setRuntimeInstructionOptions(options);
  const hydratedReferenceArticles = await runTimedStage({
    label: '参考模板装载',
    statusMessage: '正在装载参考模板全文...',
    onStatus,
    timeoutMs: 120000,
    work: () => ensureReferenceArticles(topic, direction, options, referenceArticles),
  });

  const chunks = [...chunkDrafts];
  for (let index = chunks.length; index < chunkPlan.length; index += 1) {
    const chunk = chunkPlan[index];
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

    emitArticleSnapshot(onSnapshot, {
      type: 'chunk_draft',
      label: `Chunk ${chunk.index} 初稿`,
      description: `已保存第 ${chunk.index}/${chunkPlan.length} 段初稿，可从这里继续补写后续 chunk。`,
      resumeAction: 'continue_from_chunks',
      sourceChunkIndex: chunk.index,
      data: {
        referenceArticles: hydratedReferenceArticles,
        writingInsights,
        evidenceCards,
        chunkPlan,
        chunkDrafts: [...chunks],
        workingArticleDraft: cleanText(chunks.join('\n\n')),
      },
    });
  }

  const draft = cleanText(chunks.join('\n\n'));
  let articleWorkingDraft = draft;
  let assembledDraft = '';

  if (shouldAssembleArticleDraft(articleWorkingDraft, chunkPlan)) {
    articleWorkingDraft = await runTimedStage({
      label: '终稿结构缝合',
      statusMessage: '正在把分段草稿缝合成完整文章...',
      onStatus,
      timeoutMs: 240000,
      work: () =>
        assembleArticleDraft({
          topic,
          direction,
          outline,
          draft: articleWorkingDraft,
          writingInsights,
          referenceArticles: hydratedReferenceArticles,
          chunkPlan,
          chunks,
          options,
        }),
    });

    assembledDraft = articleWorkingDraft;
    emitArticleSnapshot(onSnapshot, {
      type: 'draft_assembled',
      label: 'Chunk 缝合稿',
      description: '已把 chunk 草稿缝合为完整文章，可从这里继续终审与定稿。',
      resumeAction: 'continue_from_draft',
      data: {
        referenceArticles: hydratedReferenceArticles,
        writingInsights,
        evidenceCards,
        chunkPlan,
        chunkDrafts: [...chunks],
        assembledDraft,
        workingArticleDraft: articleWorkingDraft,
      },
    });
  }

  const { critique, articleContent, teachingNotes, workingArticleDraft } = await reviewAndFinalizeArticle({
    topic,
    ammoLibrary,
    direction,
    outline,
    options,
    hydratedReferenceArticles,
    writingInsights,
    evidenceCards,
    chunkPlan,
    chunkDrafts: [...chunks],
    initialDraft: articleWorkingDraft,
    onStatus,
    onSnapshot,
  });

  return {
    referenceArticles: hydratedReferenceArticles,
    writingInsights,
    evidenceCards,
    chunkPlan,
    chunkDrafts: [...chunks],
    assembledDraft: assembledDraft || undefined,
    workingArticleDraft,
    critique,
    articleContent,
    teachingNotes,
  };
};

export const continueArticleFromDraft = async ({
  topic,
  ammoLibrary,
  direction,
  outline,
  referenceArticles,
  options,
  writingInsights,
  evidenceCards,
  chunkPlan,
  chunkDrafts,
  draft,
  assembledDraft,
  onStatus,
  onSnapshot,
}: {
  topic: string;
  ammoLibrary: string;
  direction: string;
  outline: string;
  referenceArticles: ReferenceTemplateArticle[];
  options: WritingTaskOptions;
  writingInsights: string;
  evidenceCards: string;
  chunkPlan: WritingChunkPlanItem[];
  chunkDrafts: string[];
  draft: string;
  assembledDraft?: string;
  onStatus?: (message: string) => void;
  onSnapshot?: (snapshot: ArticleProgressSnapshot) => void;
}): Promise<ArticlePackageResult> => {
  await ensureRuntimePromptAssets(options.styleProfile);
  setRuntimeInstructionOptions(options);
  const hydratedReferenceArticles = await runTimedStage({
    label: '参考模板装载',
    statusMessage: '正在装载参考模板全文...',
    onStatus,
    timeoutMs: 120000,
    work: () => ensureReferenceArticles(topic, direction, options, referenceArticles),
  });

  const { critique, articleContent, teachingNotes, workingArticleDraft } = await reviewAndFinalizeArticle({
    topic,
    ammoLibrary,
    direction,
    outline,
    options,
    hydratedReferenceArticles,
    writingInsights,
    evidenceCards,
    chunkPlan,
    chunkDrafts: [...chunkDrafts],
    initialDraft: draft,
    onStatus,
    onSnapshot,
  });

  return {
    referenceArticles: hydratedReferenceArticles,
    writingInsights,
    evidenceCards,
    chunkPlan,
    chunkDrafts: [...chunkDrafts],
    assembledDraft,
    workingArticleDraft,
    critique,
    articleContent,
    teachingNotes,
  };
};

export const continueTeachingNotesFromArticle = async ({
  topic,
  direction,
  articleContent,
  options,
  referenceArticles,
  onStatus,
}: {
  topic: string;
  direction: string;
  articleContent: string;
  options: WritingTaskOptions;
  referenceArticles: ReferenceTemplateArticle[];
  onStatus?: (message: string) => void;
}) => {
  await ensureRuntimePromptAssets(options.styleProfile);
  setRuntimeInstructionOptions(options);
  const hydratedReferenceArticles = await runTimedStage({
    label: '参考模板装载',
    statusMessage: '正在装载参考模板全文...',
    onStatus,
    timeoutMs: 120000,
    work: () => ensureReferenceArticles(topic, direction, options, referenceArticles),
  });

  return await runTimedStage({
    label: 'TN 生成',
    statusMessage: '正在生成 TN / 讨论指南...',
    onStatus,
    timeoutMs: 180000,
    work: () => generateTeachingNotes(topic, direction, articleContent, options, hydratedReferenceArticles),
  });
};

export const chatWithEditor = async (
  ammoLibrary: string,
  articleContent: string,
  teachingNotes: string,
  chatHistory: { role: string; parts: { text: string }[] }[],
  userMessage: string
): Promise<ChatResponse> => {
  await ensureRuntimePromptAssets(runtimeInstructionOptions?.styleProfile || runtimePromptAssetsProfile || 'fdsm');
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
  await ensureRuntimePromptAssets(runtimeInstructionOptions?.styleProfile || runtimePromptAssetsProfile || 'fdsm');
  assertFullDocumentWithinLimit(fullText, '选区精修输入全文');
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

  const response = await buildCheckedTextPrompt({
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
  await ensureRuntimePromptAssets(runtimeInstructionOptions?.styleProfile || runtimePromptAssetsProfile || 'fdsm');
  if (checkStop?.()) {
    throw new Error('STOPPED');
  }

  assertFullDocumentWithinLimit(fullMarkdown, '整稿精修输入');

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

  const response = await buildCheckedTextPrompt({
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
  referenceArticles: ReferenceTemplateArticle[] = [],
  target: 'article' | 'notes' = 'article',
  outline = '',
  chunkPlan: WritingChunkPlanItem[] = []
): Promise<string> => {
  await ensureRuntimePromptAssets(runtimeInstructionOptions?.styleProfile || runtimePromptAssetsProfile || 'fdsm');
  if (checkStop?.()) {
    throw new Error('STOPPED');
  }

  assertFullDocumentWithinLimit(content, target === 'article' ? '终稿定稿输入' : 'TN 定稿输入');

  onProgress?.(target === 'article' ? '正在做终稿定稿...' : '正在做 TN 定稿...');
  const referenceTemplateBlock = formatReferenceTemplatesForPrompt(referenceArticles);
  const headingPlan = target === 'article' ? deriveSectionHeadingPlan(outline, chunkPlan) : [];
  const structureChecklist =
    target === 'article' ? buildArticleStructureChecklist(content, outline, chunkPlan) : '## 结构检查\n- 保留当前 TN / 讨论指南结构。';

  const prompt = [
    buildAntiAiStyleBlock(),
    target === 'article' ? buildCommercialHumanizerBlock() : '',
    target === 'article' ? buildCommercialHumanizerPatternBlock() : '',
    target === 'article' ? buildCommercialHumanizerChecklistBlock() : '',
    target === 'article' ? '你是发稿前最后一位 line editor，负责文章定稿。' : '你是发稿前最后一位 line editor，负责 TN / 讨论指南定稿。',
    target === 'article'
      ? '这不是重写轮次，只允许在原文基础上做句级、短语级和极小幅度的段落收束。'
      : '这不是重写轮次，只允许做措辞、语气和清晰度上的最小必要修改。',
    '请对照参考模板文，把当前文稿的语气、节奏、克制程度和自然度收紧到同一水准。',
    '渐进式修订规则：',
    target === 'article'
      ? '1. 保留标题、子标题、段落顺序和整体结构，除非极小的局部调整必不可少。'
      : '1. 保留当前 TN 的标题、列表、小标题和整体框架。',
    '2. 如果一个短语能解决问题，就不要整句改。',
    '3. 如果一句话能解决问题，就不要整段改。',
    '4. 不要重新打开前几轮已经解决的问题。',
    '5. 不要添加资料库和当前文稿之外的新事实、新论点和新例子。',
    target === 'article'
      ? `6. 如果正文仍缺少 ## 子标题，只能沿现有推进补出 ${TARGET_ARTICLE_H2_MIN}-${TARGET_ARTICLE_H2_MAX} 个工作性子标题，不得改写成另一篇文章。`
      : '6. 不要把 TN 改写成正文，也不要新增新的教学模块。',
    '7. 只清理残余的 AI 腔、假转折、空泛抽象词、装饰性标点和不自然的引号表达。',
    '8. 输出修订后的完整文稿。',
    '结构检查：',
    structureChecklist,
    target === 'article' && headingPlan.length > 0
      ? `小标题计划：\n${headingPlan.map((item, index) => `${index + 1}. ${item}`).join('\n')}`
      : '',
    '本地风格检查：',
    lintStyle(content),
    target === 'notes' ? `资料库：\n${truncate(ammoLibrary, 100000)}` : '',
    '参考模板文：',
    referenceTemplateBlock,
    '当前文稿：',
    truncate(content, MAX_DRAFT_CHARS),
  ]
    .filter(Boolean)
    .join('\n\n');

  const response = await buildCheckedTextPrompt({
    prompt,
    systemInstruction: buildSystemInstruction(
      target === 'article'
        ? '你是杂志级 line editor，只做最小必要修改，让正文在原文基础上达到可发布状态。'
        : '你是杂志级 line editor，只做最小必要修改，让 TN / 讨论指南保持原结构并更自然。'
    ),
    maxOutputTokens: 12000,
  });

  if (checkStop?.()) {
    throw new Error('STOPPED');
  }

  return cleanText(response.text);
};
