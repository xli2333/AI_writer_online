import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import sharp from 'sharp';
import { GoogleGenAI, Modality, Type, createPartFromBase64 } from '@google/genai';
import { ProxyAgent, setGlobalDispatcher } from 'undici';
import { getStyleProfile, resolveStyleProfileId } from '../config/styleProfiles.js';

const ROOT_DIR = process.cwd();
const GENERATED_ROOT = path.join(
  path.resolve(process.env.GENERATED_ASSET_ROOT || path.join(ROOT_DIR, 'generated_assets')),
  'illustrations'
);
const DEFAULT_IMAGE_MODEL = 'gemini-3-pro-image-preview';
const DEFAULT_PLANNER_MODEL = 'gemini-3.1-pro-preview';
const IMAGE_ASPECT_RATIO = '1:1';
const IMAGE_WIDTH = 3840;
const IMAGE_HEIGHT = 3840;
const CHART_VIEWBOX = `0 0 ${IMAGE_WIDTH} ${IMAGE_HEIGHT}`;
const ILLUSTRATION_PROMPT_VERSION = 'illustration-v5';
const TARGET_CHARS_PER_ILLUSTRATION = 1000;
const PLANNER_TIMEOUT_MS = 10 * 60 * 1000;
const IMAGE_TIMEOUT_MS = 12 * 60 * 1000;
const CAPTION_TIMEOUT_MS = 5 * 60 * 1000;
const ILLUSTRATION_BUNDLE_CACHE_ACTIVE_TTL_MS = 60 * 60 * 1000;
const ILLUSTRATION_BUNDLE_CACHE_FINAL_TTL_MS = 10 * 60 * 1000;

export const ILLUSTRATION_CANCELED_MESSAGE = '本轮配图已停止，可调整 Prompt 后重新开始。';

const createIllustrationTaskCanceledError = (message = ILLUSTRATION_CANCELED_MESSAGE) => {
  const error = new Error(message);
  error.name = 'IllustrationTaskCanceledError';
  return error;
};

export const isIllustrationTaskCanceledError = (error) => error?.name === 'IllustrationTaskCanceledError';

const illustrationBundleCache = new Map();
const illustrationBundleCacheTimers = new Map();

const scheduleIllustrationBundleCacheExpiry = (sourceHash, ttlMs) => {
  if (!cleanText(sourceHash)) return;
  const existingTimer = illustrationBundleCacheTimers.get(sourceHash);
  if (existingTimer) {
    clearTimeout(existingTimer);
  }
  if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
    illustrationBundleCacheTimers.delete(sourceHash);
    return;
  }
  const timer = setTimeout(() => {
    illustrationBundleCache.delete(sourceHash);
    illustrationBundleCacheTimers.delete(sourceHash);
  }, ttlMs);
  timer.unref?.();
  illustrationBundleCacheTimers.set(sourceHash, timer);
};

const cacheIllustrationBundle = (manifest) => {
  const normalized = normalizeIllustrationManifest(manifest);
  if (!cleanText(normalized?.sourceHash)) {
    return normalized;
  }
  const ttlMs = ['ready', 'error', 'canceled'].includes(String(normalized.status || ''))
    ? ILLUSTRATION_BUNDLE_CACHE_FINAL_TTL_MS
    : ILLUSTRATION_BUNDLE_CACHE_ACTIVE_TTL_MS;
  illustrationBundleCache.set(normalized.sourceHash, normalized);
  scheduleIllustrationBundleCacheExpiry(normalized.sourceHash, ttlMs);
  return normalized;
};

const getCachedIllustrationBundle = (sourceHash) => {
  const normalizedHash = cleanText(sourceHash);
  if (!normalizedHash) return null;
  return illustrationBundleCache.get(normalizedHash) || null;
};

const proxyUrl = process.env.HTTPS_PROXY || process.env.HTTP_PROXY || '';
if (proxyUrl) {
  setGlobalDispatcher(new ProxyAgent(proxyUrl));
}

const createGenAiClient = (apiKey, timeoutMs) =>
  new GoogleGenAI({
    apiKey,
    httpOptions: {
      timeout: timeoutMs,
    },
  });

const PLAN_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    planned_image_count: { type: Type.NUMBER },
    count_rationale: { type: Type.STRING },
    visual_system: {
      type: Type.OBJECT,
      properties: {
        visual_direction: { type: Type.STRING },
        realism_level: { type: Type.STRING },
        palette: { type: Type.ARRAY, items: { type: Type.STRING } },
        lighting: { type: Type.STRING },
        composition_rules: { type: Type.ARRAY, items: { type: Type.STRING } },
        texture_rules: { type: Type.ARRAY, items: { type: Type.STRING } },
        chart_language: { type: Type.ARRAY, items: { type: Type.STRING } },
        forbidden_elements: { type: Type.ARRAY, items: { type: Type.STRING } },
      },
      required: [
        'visual_direction',
        'realism_level',
        'palette',
        'lighting',
        'composition_rules',
        'texture_rules',
        'chart_language',
        'forbidden_elements',
      ],
    },
    slots: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          order: { type: Type.NUMBER },
          role: { type: Type.STRING },
          anchor_paragraph_index: { type: Type.NUMBER },
          anchor_heading: { type: Type.STRING },
          anchor_excerpt: { type: Type.STRING },
          rationale: { type: Type.STRING },
          visual_focus: { type: Type.STRING },
          composition: { type: Type.STRING },
          mood: { type: Type.STRING },
          consistency_note: { type: Type.STRING },
          should_use_data_graphic: { type: Type.BOOLEAN },
          data_graphic_type: { type: Type.STRING },
          data_graphic_rationale: { type: Type.STRING },
          chart_title: { type: Type.STRING },
          chart_subtitle: { type: Type.STRING },
          data_points: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: {
                label: { type: Type.STRING },
                value: { type: Type.NUMBER },
                unit: { type: Type.STRING },
                group: { type: Type.STRING },
                time: { type: Type.STRING },
                note: { type: Type.STRING },
              },
              required: ['label', 'value', 'unit', 'group', 'time', 'note'],
            },
          },
        },
        required: [
          'order',
          'role',
          'anchor_paragraph_index',
          'anchor_heading',
          'anchor_excerpt',
          'rationale',
          'visual_focus',
          'composition',
          'mood',
          'consistency_note',
          'should_use_data_graphic',
          'data_graphic_type',
          'data_graphic_rationale',
          'chart_title',
          'chart_subtitle',
          'data_points',
        ],
      },
    },
  },
  required: ['visual_system', 'slots'],
};

const IMAGE_EXPLANATION_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    explanation: { type: Type.STRING },
  },
  required: ['explanation'],
};

const paletteFallbacks = {
  fdsm: ['#0F172A', '#155E75', '#E2E8F0', '#94A3B8', '#F8FAFC'],
  latepost: ['#17202A', '#0F766E', '#F3F4F6', '#9CA3AF', '#FAFAF9'],
};

const readUtf8 = async (filePath) => {
  const raw = await fs.readFile(filePath, 'utf8');
  return raw.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').trim();
};

const ensureDir = async (dirPath) => {
  await fs.mkdir(dirPath, { recursive: true });
};

const fileExists = async (filePath) => {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
};

const cleanText = (value) => String(value || '').replace(/\r\n/g, '\n').trim();

const stripMarkdownInline = (value) =>
  cleanText(
    String(value || '')
      .replace(/!\[[^\]]*\]\([^)]+\)/g, '')
      .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
      .replace(/`([^`]+)`/g, '$1')
      .replace(/\*\*([^*]+)\*\*/g, '$1')
      .replace(/__([^_]+)__/g, '$1')
      .replace(/\*([^*]+)\*/g, '$1')
      .replace(/_([^_]+)_/g, '$1')
      .replace(/~~([^~]+)~~/g, '$1')
  );

const countArticleCharacters = (content) => stripMarkdownInline(content).replace(/\s+/g, '').length;

const stableSlug = (value) =>
  String(value || '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'slot';

const clip = (text, limit = 140) => {
  const normalized = cleanText(text);
  if (normalized.length <= limit) {
    return normalized;
  }
  return `${normalized.slice(0, limit)}…`;
};

const normalizeCaptionSourceText = (text) =>
  cleanText(
    stripMarkdownInline(text)
      .replace(/（[A-Za-z][^）]{0,60}）/g, '')
      .replace(/\([A-Za-z][^)]{0,60}\)/g, '')
      .replace(/\s+/g, ' ')
  );

const splitCaptionSentences = (text) =>
  normalizeCaptionSourceText(text)
    .replace(/……/g, '。')
    .split(/[。！？!?；;]+/)
    .map((item) =>
      cleanText(item)
        .replace(/^[，、:：\-\s]+/g, '')
        .replace(/[，、:：\-\s]+$/g, '')
    )
    .filter(Boolean);

const stripCaptionPlanningLanguage = (text) =>
  normalizeCaptionSourceText(text)
    .replace(/^这张图要承接的判断[:：]?\s*/, '')
    .replace(/^图位要承接的核心判断[:：]?\s*/, '')
    .replace(/^图位要承接的核心意思[:：]?\s*/, '')
    .replace(/^作为[^，。]*[，,]\s*(需|需要|要)?/, '')
    .replace(/^收尾处/, '');

const toCaptionSentence = (text, limit = 36) => {
  const normalized = clip(cleanText(text).replace(/[。！？!?；;]+/g, ''), limit);
  if (!normalized) {
    return '';
  }
  return /[。！？!?]$/.test(normalized) ? normalized : `${normalized}。`;
};

const INTERNAL_CAPTION_PATTERNS = [
  /文章要说的那层关系/,
  /这版又额外收紧了/,
  /这一层要求/,
  /关键差距落在/,
  /当前已有图释/,
  /本轮用户补充要求/,
];

const looksLikeInternalCaption = (text) =>
  INTERNAL_CAPTION_PATTERNS.some((pattern) => pattern.test(cleanText(text)));

const escapeXml = (value) =>
  String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');

const normalizeHexColor = (value, fallback) => {
  const normalized = String(value || '').trim();
  return /^#[0-9a-f]{6}$/i.test(normalized) ? normalized : fallback;
};

const buildSourceHash = ({ profileId, title, articleContent, styleReferenceImage }) =>
  crypto
    .createHash('sha1')
    .update(
      `${profileId}\n${cleanText(title)}\n${cleanText(articleContent)}\n${buildIllustrationStyleReferenceFingerprint(styleReferenceImage)}`,
      'utf8'
    )
    .digest('hex')
    .slice(0, 16);

const parseInlineImageDataUrl = (value) => {
  const matched = String(value || '').match(/^data:([^;]+);base64,(.+)$/);
  if (!matched) {
    return null;
  }
  return {
    mimeType: matched[1],
    base64: matched[2],
    buffer: Buffer.from(matched[2], 'base64'),
  };
};

const normalizeIllustrationStyleReferenceImage = (value) => {
  if (!value || typeof value !== 'object') {
    return undefined;
  }
  const dataUrl = cleanText(value.dataUrl);
  const parsed = parseInlineImageDataUrl(dataUrl);
  if (!parsed) {
    return undefined;
  }
  const name = cleanText(value.name) || 'style-reference';
  const mimeType = cleanText(value.mimeType || parsed.mimeType) || parsed.mimeType || 'image/png';
  const idSeed = `${name}\n${mimeType}\n${dataUrl}`;
  return {
    id: cleanText(value.id) || crypto.createHash('sha1').update(idSeed, 'utf8').digest('hex').slice(0, 12),
    name,
    mimeType,
    dataUrl,
  };
};

const buildIllustrationStyleReferenceFingerprint = (value) => {
  const normalized = normalizeIllustrationStyleReferenceImage(value);
  if (!normalized) {
    return '';
  }
  return crypto
    .createHash('sha1')
    .update(`${normalized.name}\n${normalized.mimeType}\n${normalized.dataUrl}`, 'utf8')
    .digest('hex');
};

const buildIllustrationStyleReferenceParts = (value) => {
  const normalized = normalizeIllustrationStyleReferenceImage(value);
  const parsed = normalized ? parseInlineImageDataUrl(normalized.dataUrl) : null;
  if (!normalized || !parsed) {
    return [];
  }
  return [
    {
      text: `Style reference image: ${normalized.name}. Learn its crop, composition, palette, texture, lighting, and editorial feel. Use it only as style guidance, not as literal subject matter.`,
    },
    createPartFromBase64(parsed.base64, normalized.mimeType || parsed.mimeType || 'image/png'),
  ];
};

const buildIllustrationProgress = ({
  phase,
  activity,
  currentStep,
  completedCount = 0,
  totalCount = 0,
  currentItemIndex,
  currentSlotId,
  currentSlotOrder,
  currentSlotTitle,
  startedAt,
}) => ({
  phase,
  activity: cleanText(activity) || undefined,
  currentStep: cleanText(currentStep),
  completedCount: Number(completedCount || 0),
  totalCount: Number(totalCount || 0),
  currentItemIndex: Number.isFinite(Number(currentItemIndex)) ? Number(currentItemIndex) : undefined,
  currentSlotId: cleanText(currentSlotId) || undefined,
  currentSlotOrder: Number.isFinite(Number(currentSlotOrder)) ? Number(currentSlotOrder) : undefined,
  currentSlotTitle: cleanText(currentSlotTitle) || undefined,
  startedAt: cleanText(startedAt) || undefined,
  updatedAt: new Date().toISOString(),
});
const resetCanceledIllustrationSlots = (slots = [], assetVersions = {}) =>
  (Array.isArray(slots) ? slots : []).map((slot) => {
    if (String(slot?.status || '') !== 'rendering') {
      return slot;
    }
    const versions = toAssetArray(assetVersions?.[slot.id]);
    return {
      ...slot,
      status: versions.length > 0 ? 'ready' : 'planned',
      error: undefined,
    };
  });

const buildCanceledIllustrationManifest = (manifest, currentStep = ILLUSTRATION_CANCELED_MESSAGE) => {
  const normalizedCurrentStep = cleanText(currentStep) || ILLUSTRATION_CANCELED_MESSAGE;
  const startedAt = cleanText(manifest?.progress?.startedAt || manifest?.generatedAt) || undefined;
  const completedCount = Array.isArray(manifest?.assets) ? manifest.assets.length : 0;
  const totalCount = Number(manifest?.targetImageCount || manifest?.progress?.totalCount || 0);
  const nextSlots = resetCanceledIllustrationSlots(manifest?.slots, manifest?.assetVersions);

  return normalizeIllustrationManifest({
    ...manifest,
    status: 'canceled',
    updatedAt: new Date().toISOString(),
    error: undefined,
    slots: nextSlots,
    progress: buildIllustrationProgress({
      phase: 'canceled',
      activity: 'canceled',
      currentStep: normalizedCurrentStep,
      completedCount,
      totalCount,
      startedAt,
    }),
  });
};

const computeArticleHash = (styleProfile, articleContent) => {
  const normalized = `${String(styleProfile || 'fdsm').trim().toLowerCase()}\n${String(articleContent || '').trim()}`;
  let hash = 2166136261;
  for (let index = 0; index < normalized.length; index += 1) {
    hash ^= normalized.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return Math.abs(hash >>> 0).toString(16);
};

const extractArticleTitle = (fallback, content) => {
  const lines = String(content || '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  const heading = lines.find((line) => /^#\s+/.test(line));
  if (heading) {
    return heading.replace(/^#\s+/, '').trim();
  }
  return cleanText(fallback) || '未命名文章';
};

export const resolveIllustrationRequestIdentity = ({ profileId, articleTitle, articleContent, styleReferenceImage }) => {
  const normalizedProfileId = resolveStyleProfileId(profileId);
  const resolvedTitle = extractArticleTitle(articleTitle, articleContent);
  const normalizedStyleReferenceImage = normalizeIllustrationStyleReferenceImage(styleReferenceImage);
  return {
    normalizedProfileId,
    resolvedTitle,
    sourceHash: buildSourceHash({
      profileId: normalizedProfileId,
      title: resolvedTitle,
      articleContent,
      styleReferenceImage: normalizedStyleReferenceImage,
    }),
    articleHash: computeArticleHash(normalizedProfileId, articleContent),
    styleReferenceImage: normalizedStyleReferenceImage,
  };
};

const buildArticleStructure = (content) => {
  const lines = String(content || '').replace(/\r\n/g, '\n').split('\n');
  const paragraphs = [];
  let currentHeading = '';
  let buffer = [];

  const flush = () => {
    const text = stripMarkdownInline(buffer.join(' '));
    if (text) {
      paragraphs.push({
        index: paragraphs.length,
        heading: currentHeading,
        text,
      });
    }
    buffer = [];
  };

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) {
      flush();
      continue;
    }

    if (/^#{1,3}\s+/.test(line)) {
      flush();
      currentHeading = stripMarkdownInline(line.replace(/^#{1,3}\s+/, ''));
      continue;
    }

    if (/^\|/.test(line) || /^[-*]\s+/.test(line) || /^\d+\.\s+/.test(line) || /^>/.test(line)) {
      flush();
      const text = stripMarkdownInline(line.replace(/^>\s?/, '').replace(/^[-*]\s+/, '').replace(/^\d+\.\s+/, ''));
      if (text) {
        paragraphs.push({
          index: paragraphs.length,
          heading: currentHeading,
          text,
        });
      }
      continue;
    }

    buffer.push(line);
  }

  flush();
  return paragraphs;
};

const summarizeStructureForPrompt = (paragraphs) =>
  paragraphs
    .map((item) => `[P${item.index}]${item.heading ? ` [${item.heading}]` : ''} ${clip(item.text, 180)}`)
    .join('\n');

const extractDataHints = (paragraphs) =>
  paragraphs
    .filter((item) => /\d/.test(item.text))
    .map((item) => {
      const numbers = item.text.match(/(?:\d+(?:\.\d+)?)(?:%|倍|亿元|万亿|万人|万台|万家|亿美元|元|人|家|年|月|日)?/g) || [];
      return {
        index: item.index,
        heading: item.heading,
        excerpt: clip(item.text, 160),
        numeric_mentions: numbers.slice(0, 8),
      };
    })
    .slice(0, 18);

const buildVisualSystemFallback = (profileId) => ({
  visual_direction:
    profileId === 'latepost' ? '克制的报道型商业 editorial visual system' : '克制的分析型商业 editorial visual system',
  realism_level: profileId === 'latepost' ? '报道现实感，中等写实' : '结构化 editorial illustration，中等写实',
  palette: paletteFallbacks[profileId] || paletteFallbacks.fdsm,
  lighting: profileId === 'latepost' ? '自然光与室内环境光结合，层次清楚' : '克制、干净、偏杂志 editorial 的光线',
  composition_rules: [
    '同一篇图组保持同一画面密度和镜头语言',
    '优先清晰主体与关系，不做无信息量装饰',
    '首图更概括，其余图更针对各自职责',
  ],
  texture_rules: [
    '不要海报感磨皮',
    '不要廉价 3D 素材拼贴',
    '保持成熟商业媒体质感',
  ],
  chart_language: ['低饱和、杂志型信息图', '优先比较关系和主结论，不堆满注释'],
  forbidden_elements: ['大段文字', '水印', '大面积 logo', '虚假仪表盘', '广告海报感'],
});

const mapRoleToFrontendRole = (role, isDataGraphic) => {
  if (isDataGraphic) {
    return 'data_chart';
  }

  const normalized = String(role || '').toLowerCase();
  if (normalized.includes('首图') || normalized.includes('hero')) return 'hero';
  if (normalized.includes('问题')) return 'main_question';
  if (normalized.includes('论点')) return 'core_argument';
  if (normalized.includes('案例')) return 'key_case';
  if (normalized.includes('人物')) return 'person';
  if (normalized.includes('组织')) return 'organization';
  if (normalized.includes('行业')) return 'industry_context';
  if (normalized.includes('机制') || normalized.includes('过程')) return 'process_mechanism';
  if (normalized.includes('结果') || normalized.includes('后果') || normalized.includes('结尾')) return 'outcome';
  return 'key_case';
};

const buildFocusTerms = (text) =>
  String(text || '')
    .split(/[，。；、,/\s]+/)
    .map((item) => item.trim())
    .filter((item) => item.length >= 2)
    .slice(0, 6);

const isModelNotFoundError = (error) => {
  const message = String(error?.message || error || '').toLowerCase();
  return message.includes('not found') || message.includes('"code":404') || message.includes('models/');
};

const shouldUseMockProvider = () => process.env.ILLUSTRATION_PROVIDER === 'mock' || process.env.MOCK_NANOBANANA === '1';

const buildFallbackDataPoints = (text) => {
  const matches = cleanText(text).match(/(\d+(?:\.\d+)?)(%|倍|亿元|万亿|万人|万台|万家|亿美元|元|人|家|年|月|日)?/g) || [];
  return matches.slice(0, 5).map((item, index) => {
    const match = item.match(/(\d+(?:\.\d+)?)(.*)/);
    return {
      label: `数据${index + 1}`,
      value: Number(match?.[1] || 0),
      unit: cleanText(match?.[2] || ''),
      group: '',
      time: '',
      note: clip(text, 24),
    };
  });
};

const clampSlotCount = (count) => Math.max(1, Math.min(10, Number(count) || 1));

const CHINESE_COUNT_TOKENS = {
  零: 0,
  一: 1,
  二: 2,
  两: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  七: 7,
  八: 8,
  九: 9,
  十: 10,
};

const parseChineseCountToken = (token) => {
  const source = cleanText(token);
  if (!source) return null;
  if (source === '十') return 10;
  if (source.length === 2 && source.startsWith('十')) {
    return 10 + (CHINESE_COUNT_TOKENS[source[1]] || 0);
  }
  if (source.length === 2 && source.endsWith('十')) {
    return (CHINESE_COUNT_TOKENS[source[0]] || 0) * 10;
  }
  if (source.length === 3 && source[1] === '十') {
    return (CHINESE_COUNT_TOKENS[source[0]] || 0) * 10 + (CHINESE_COUNT_TOKENS[source[2]] || 0);
  }
  if (source.length === 1 && Object.prototype.hasOwnProperty.call(CHINESE_COUNT_TOKENS, source)) {
    return CHINESE_COUNT_TOKENS[source];
  }
  return null;
};

const countMarkdownHeadings = (articleContent, pattern) => (String(articleContent || '').match(pattern) || []).length;

const resolveStructuredImageRuleCount = ({ instruction, articleContent, paragraphs }) => {
  const normalized = cleanText(instruction);
  if (!normalized) {
    return null;
  }

  const explicitArabic = normalized.match(/(\d{1,2})\s*(?:张|幅|个|组)?(?:图|配图)?/);
  if (explicitArabic) {
    return clampSlotCount(Number(explicitArabic[1]));
  }

  const explicitChinese = normalized.match(/([零一二两三四五六七八九十]{1,3})\s*(?:张|幅|个|组)?(?:图|配图)?/);
  if (explicitChinese) {
    const parsed = parseChineseCountToken(explicitChinese[1]);
    if (Number.isFinite(parsed)) {
      return clampSlotCount(parsed);
    }
  }

  const sectionCount = new Set((Array.isArray(paragraphs) ? paragraphs : []).map((item) => cleanText(item?.heading)).filter(Boolean)).size;
  const h2Count = countMarkdownHeadings(articleContent, /^##(?!#)\s+/gm);
  const h3Count = countMarkdownHeadings(articleContent, /^###\s+/gm);
  const paragraphCount = Array.isArray(paragraphs) ? paragraphs.length : 0;

  if (/(?:每个?二级标题|每个?h2|每个H2)/.test(normalized)) {
    return clampSlotCount(h2Count || sectionCount || 1);
  }
  if (/(?:每个?三级标题|每个?h3|每个H3)/.test(normalized)) {
    return clampSlotCount(h3Count || sectionCount || 1);
  }
  if (/(?:每个?子模块|每个?模块|每个?部分|每个?章节|每个?小节|每节|每个?单元)/.test(normalized)) {
    return clampSlotCount(sectionCount || h2Count || h3Count || 1);
  }
  if (/(?:每个?子段落|每段|逐段|一段一张)/.test(normalized)) {
    return clampSlotCount(paragraphCount || 1);
  }
  if (/(?:少一点|少些|精简一点)/.test(normalized)) {
    return clampSlotCount(Math.max(1, Math.ceil(paragraphCount / 3)));
  }
  if (/(?:多一点|丰富一点|密一点)/.test(normalized)) {
    return clampSlotCount(Math.max(1, Math.ceil(paragraphCount / 2)));
  }

  return null;
};

export const resolveIllustrationCountPreference = ({
  articleContent,
  imageCountPrompt = '',
  paragraphs = buildArticleStructure(articleContent),
  totalCharacterCount = Math.max(1, countArticleCharacters(articleContent)),
}) => {
  const normalizedImageCountPrompt = cleanText(imageCountPrompt);
  const defaultTargetImageCount = clampSlotCount(Math.ceil(totalCharacterCount / TARGET_CHARS_PER_ILLUSTRATION));
  const preferredCount = resolveStructuredImageRuleCount({
    instruction: normalizedImageCountPrompt,
    articleContent,
    paragraphs,
  });

  return {
    normalizedImageCountPrompt,
    targetImageCount: preferredCount || defaultTargetImageCount,
    usedStructuredRule: Boolean(normalizedImageCountPrompt && preferredCount),
  };
};

const buildIllustrationPlanPrompt = ({
  targetImageCount,
  normalizedProfileId,
  resolvedTitle,
  options,
  paragraphs,
  dataHints,
  normalizedUserPrompt,
  normalizedImageCountPrompt,
  hasStyleReferenceImage = false,
}) => {
  let planPrompt = [
    `目标图数：${targetImageCount}`,
    `风格档：${normalizedProfileId}`,
    `文章标题：${resolvedTitle}`,
    `文章任务信息：${JSON.stringify(
      {
        audience: options.audience || '',
        genre: options.genre || '',
        style: options.style || '',
        articleGoal: options.articleGoal || '',
      },
      null,
      2
    )}`,
    '文章结构地图：',
    summarizeStructureForPrompt(paragraphs),
    '可视化候选数据段：',
    JSON.stringify(dataHints, null, 2),
    normalizedImageCountPrompt
      ? `配图数量 / 规则：${normalizedImageCountPrompt}`
      : 'No extra image-count rule was provided.',
    hasStyleReferenceImage
      ? 'A style reference image is attached. Extract its visual language and apply that art direction consistently across the whole illustration set.'
      : 'No style reference image is attached.',
    'Return planned_image_count as an integer from 1 to 10.',
    normalizedImageCountPrompt
      ? 'If the user gave an explicit number, obey it exactly. If the user gave a rule, infer the final count from article structure and make slots.length exactly match planned_image_count.'
      : 'If no extra image-count rule is given, use the target count above and make slots.length exactly match planned_image_count.',
  ].join('\n\n');

  if (normalizedUserPrompt) {
    planPrompt = `${planPrompt}\n\n用户补充的整组配图要求：\n${normalizedUserPrompt}\n\n请把这些要求落实到整组视觉系统、图位规划和每张图的画面重点里。`;
  }

  return planPrompt;
};

const pickFallbackParagraphIndices = (paragraphs, targetCount) => {
  if (!paragraphs.length) {
    return Array.from({ length: targetCount }, (_, index) => index);
  }

  if (targetCount === 1) {
    return [0];
  }

  const maxIndex = paragraphs.length - 1;
  const picks = new Set([0]);
  for (let slotIndex = 1; slotIndex < targetCount; slotIndex += 1) {
    const ratio = slotIndex / targetCount;
    picks.add(Math.min(maxIndex, Math.round(ratio * maxIndex)));
  }
  return [...picks].slice(0, targetCount);
};

const buildFallbackPlan = ({ paragraphs, targetImageCount, profileId, dataHints }) => {
  const indices = pickFallbackParagraphIndices(paragraphs, targetImageCount);
  const dataIndexSet = new Set((Array.isArray(dataHints) ? dataHints : []).map((item) => item.index));

  return {
    planned_image_count: targetImageCount,
    count_rationale: 'Derived from local image-count preference parsing.',
    visual_system: buildVisualSystemFallback(profileId),
    slots: indices.map((paragraphIndex, index) => {
      const anchor = paragraphs[paragraphIndex] || paragraphs[0] || { index: paragraphIndex, heading: '', text: '' };
      const dataPoints = buildFallbackDataPoints(anchor.text);
      const shouldUseDataGraphic = index > 0 && dataIndexSet.has(paragraphIndex) && dataPoints.length >= 2;
      return {
        order: index + 1,
        role: index === 0 ? '首图总图' : shouldUseDataGraphic ? '数据图' : '正文配图',
        anchor_paragraph_index: anchor.index,
        anchor_heading: anchor.heading || '',
        anchor_excerpt: clip(anchor.text, 120),
        rationale: index === 0 ? '建立整篇文章的主题、对象和张力。' : '覆盖文章中的关键结构节点。',
        visual_focus: clip(anchor.text, 96),
        composition: index === 0 ? '总图，建立主题与关系。' : '围绕该段核心信息组织主体与环境。',
        mood: profileId === 'latepost' ? '克制、报道型、可信。' : '克制、分析型、可信。',
        consistency_note: '必须与整篇图组保持一致的视觉规则。',
        should_use_data_graphic: shouldUseDataGraphic,
        data_graphic_type: shouldUseDataGraphic ? 'bar_compare' : '',
        data_graphic_rationale: shouldUseDataGraphic ? '该段存在可提取的数字关系。' : '',
        chart_title: shouldUseDataGraphic ? `${anchor.heading || '正文'}数据图` : '',
        chart_subtitle: shouldUseDataGraphic ? '基于正文中的明确数字关系生成。' : '',
        data_points: shouldUseDataGraphic ? dataPoints : [],
      };
    }),
  };
};

const normalizeDataPoints = (points) =>
  Array.isArray(points)
    ? points
        .map((point) => ({
          label: cleanText(point?.label),
          value: Number(point?.value),
          unit: cleanText(point?.unit),
          group: cleanText(point?.group),
          time: cleanText(point?.time),
          note: cleanText(point?.note),
        }))
        .filter((point) => point.label && Number.isFinite(point.value))
        .slice(0, 8)
    : [];

const normalizePlan = ({ plan, paragraphs, targetImageCount, profileId }) => {
  const fallbackVisualSystem = buildVisualSystemFallback(profileId);
  const slots = Array.isArray(plan?.slots) ? [...plan.slots] : [];
  const usedParagraphs = new Set();
  const normalizedSlots = [];

  for (const rawSlot of slots) {
    const paragraphIndex = Math.max(0, Math.min(paragraphs.length - 1, Number(rawSlot?.anchor_paragraph_index) || 0));
    const anchor = paragraphs[paragraphIndex] || paragraphs[0] || { index: 0, heading: '', text: '' };
    const dataPoints = normalizeDataPoints(rawSlot?.data_points);
    const wantsDataGraphic = Boolean(rawSlot?.should_use_data_graphic) && dataPoints.length >= 2;
    const dedupeIndex = usedParagraphs.has(paragraphIndex)
      ? paragraphs.find((item) => !usedParagraphs.has(item.index))?.index ?? paragraphIndex
      : paragraphIndex;
    usedParagraphs.add(dedupeIndex);
    const resolvedAnchor = paragraphs[dedupeIndex] || anchor;

    normalizedSlots.push({
      order: Number(rawSlot?.order) || normalizedSlots.length + 1,
      role: cleanText(rawSlot?.role) || (normalizedSlots.length === 0 ? '首图总图' : '正文配图'),
      anchorParagraphIndex: resolvedAnchor.index,
      anchorHeading: cleanText(rawSlot?.anchor_heading) || resolvedAnchor.heading || '',
      anchorExcerpt: cleanText(rawSlot?.anchor_excerpt) || clip(resolvedAnchor.text, 120),
      rationale: cleanText(rawSlot?.rationale) || '用于承接文章关键结构节点。',
      visualFocus: cleanText(rawSlot?.visual_focus) || clip(resolvedAnchor.text, 96),
      composition: cleanText(rawSlot?.composition) || '主体清晰，构图克制，保留环境关系。',
      mood: cleanText(rawSlot?.mood) || '克制、可信、编辑型。',
      consistencyNote: cleanText(rawSlot?.consistency_note) || '必须与整篇图组保持一致的视觉规则。',
      shouldUseDataGraphic: wantsDataGraphic,
      dataGraphicType: cleanText(rawSlot?.data_graphic_type),
      dataGraphicRationale: cleanText(rawSlot?.data_graphic_rationale),
      chartTitle: cleanText(rawSlot?.chart_title),
      chartSubtitle: cleanText(rawSlot?.chart_subtitle),
      dataPoints,
    });
  }

  const fallbackIndices = pickFallbackParagraphIndices(paragraphs, targetImageCount);
  for (const paragraphIndex of fallbackIndices) {
    if (normalizedSlots.length >= targetImageCount) {
      break;
    }
    if (normalizedSlots.some((slot) => slot.anchorParagraphIndex === paragraphIndex)) {
      continue;
    }
    const anchor = paragraphs[paragraphIndex] || paragraphs[0] || { index: paragraphIndex, heading: '', text: '' };
    normalizedSlots.push({
      order: normalizedSlots.length + 1,
      role: normalizedSlots.length === 0 ? '首图总图' : '正文配图',
      anchorParagraphIndex: anchor.index,
      anchorHeading: anchor.heading || '',
      anchorExcerpt: clip(anchor.text, 120),
      rationale: normalizedSlots.length === 0 ? '建立整篇文章的主题与气质。' : '覆盖文章另一处高价值结构节点。',
      visualFocus: clip(anchor.text, 96),
      composition: normalizedSlots.length === 0 ? '总图，建立主题、对象和张力。' : '围绕该段核心对象组织画面。',
      mood: '克制、可信、编辑型。',
      consistencyNote: '必须与整篇图组保持一致的视觉规则。',
      shouldUseDataGraphic: false,
      dataGraphicType: '',
      dataGraphicRationale: '',
      chartTitle: '',
      chartSubtitle: '',
      dataPoints: [],
    });
  }

  const visualSystem = {
    ...fallbackVisualSystem,
    ...(plan?.visual_system || {}),
    palette:
      Array.isArray(plan?.visual_system?.palette) && plan.visual_system.palette.length > 0
        ? plan.visual_system.palette.map((item) => cleanText(item)).filter(Boolean).slice(0, 6)
        : fallbackVisualSystem.palette,
    composition_rules:
      Array.isArray(plan?.visual_system?.composition_rules) && plan.visual_system.composition_rules.length > 0
        ? plan.visual_system.composition_rules.map((item) => cleanText(item)).filter(Boolean).slice(0, 8)
        : fallbackVisualSystem.composition_rules,
    texture_rules:
      Array.isArray(plan?.visual_system?.texture_rules) && plan.visual_system.texture_rules.length > 0
        ? plan.visual_system.texture_rules.map((item) => cleanText(item)).filter(Boolean).slice(0, 8)
        : fallbackVisualSystem.texture_rules,
    chart_language:
      Array.isArray(plan?.visual_system?.chart_language) && plan.visual_system.chart_language.length > 0
        ? plan.visual_system.chart_language.map((item) => cleanText(item)).filter(Boolean).slice(0, 8)
        : fallbackVisualSystem.chart_language,
    forbidden_elements:
      Array.isArray(plan?.visual_system?.forbidden_elements) && plan.visual_system.forbidden_elements.length > 0
        ? plan.visual_system.forbidden_elements.map((item) => cleanText(item)).filter(Boolean).slice(0, 10)
        : fallbackVisualSystem.forbidden_elements,
  };

  const finalSlots = normalizedSlots
    .slice(0, targetImageCount)
    .sort((left, right) => left.order - right.order)
    .map((slot, index) => ({
      ...slot,
      order: index + 1,
      role: index === 0 ? '首图总图' : slot.role,
      shouldUseDataGraphic: index === 0 ? false : slot.shouldUseDataGraphic,
    }));

  return { visualSystem, slots: finalSlots };
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const withTimeout = async (promise, ms, label) => {
  let timer = null;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`${label}超时（${Math.round(ms / 1000)} 秒）`));
        }, ms);
      }),
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
};

const callWithRetry = async (work, retries = 3, baseDelay = 1500) => {
  let lastError;
  for (let attempt = 0; attempt < retries; attempt += 1) {
    try {
      return await work();
    } catch (error) {
      lastError = error;
      if (attempt === retries - 1) {
        break;
      }
      await sleep(baseDelay * (attempt + 1));
    }
  }
  throw lastError;
};

const extractImageBytes = (response) => {
  const candidates = Array.isArray(response?.candidates) ? response.candidates : [];
  for (const candidate of candidates) {
    const parts = Array.isArray(candidate?.content?.parts) ? candidate.content.parts : [];
    for (const part of parts) {
      if (part?.inlineData?.data && String(part.inlineData.mimeType || '').startsWith('image/')) {
        return {
          buffer: Buffer.from(part.inlineData.data, 'base64'),
          mimeType: String(part.inlineData.mimeType || 'image/png'),
        };
      }
    }
  }
  return null;
};

const wrapLines = (text, limit) => {
  const words = String(text || '').split(/\s+/).filter(Boolean);
  const lines = [];
  let current = '';
  for (const word of words) {
    const next = current ? `${current} ${word}` : word;
    if (next.length > limit && current) {
      lines.push(current);
      current = word;
    } else {
      current = next;
    }
  }
  if (current) {
    lines.push(current);
  }
  return lines;
};

const renderBarChart = ({ points, palette, title, subtitle, footer }) => {
  const maxValue = Math.max(...points.map((point) => point.value), 1);
  const chartLeft = 420;
  const chartRight = IMAGE_WIDTH - 320;
  const chartTop = 520;
  const rowHeight = 220;

  const bars = points
    .map((point, index) => {
      const y = chartTop + index * rowHeight;
      const width = ((chartRight - chartLeft) * point.value) / maxValue;
      const fill = palette[index % palette.length];
      return `
        <text x="140" y="${y + 78}" fill="#E2E8F0" font-size="56" font-family="'Microsoft YaHei','PingFang SC','Noto Sans CJK SC',sans-serif">${escapeXml(point.label)}</text>
        <rect x="${chartLeft}" y="${y}" width="${width}" height="96" rx="24" fill="${fill}" opacity="0.95" />
        <text x="${chartLeft + width + 36}" y="${y + 70}" fill="#F8FAFC" font-size="56" font-weight="700" font-family="'Microsoft YaHei','PingFang SC','Noto Sans CJK SC',sans-serif">${escapeXml(
          `${point.value}${point.unit || ''}`
        )}</text>
      `;
    })
    .join('\n');

  return `
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="${CHART_VIEWBOX}" width="${IMAGE_WIDTH}" height="${IMAGE_HEIGHT}">
      <defs>
        <linearGradient id="bg" x1="0" x2="1" y1="0" y2="1">
          <stop offset="0%" stop-color="#0F172A" />
          <stop offset="100%" stop-color="#111827" />
        </linearGradient>
      </defs>
      <rect width="${IMAGE_WIDTH}" height="${IMAGE_HEIGHT}" fill="url(#bg)" />
      <rect x="96" y="96" width="${IMAGE_WIDTH - 192}" height="${IMAGE_HEIGHT - 192}" rx="48" fill="rgba(255,255,255,0.04)" stroke="rgba(255,255,255,0.08)" />
      <text x="140" y="220" fill="#F8FAFC" font-size="88" font-weight="700" font-family="'Microsoft YaHei','PingFang SC','Noto Sans CJK SC',sans-serif">${escapeXml(
        title
      )}</text>
      <text x="140" y="300" fill="#94A3B8" font-size="40" font-family="'Microsoft YaHei','PingFang SC','Noto Sans CJK SC',sans-serif">${escapeXml(
        subtitle
      )}</text>
      ${bars}
      <text x="140" y="${IMAGE_HEIGHT - 120}" fill="#64748B" font-size="32" font-family="'Microsoft YaHei','PingFang SC','Noto Sans CJK SC',sans-serif">${escapeXml(
        footer
      )}</text>
    </svg>
  `;
};

const renderLineChart = ({ points, palette, title, subtitle, footer }) => {
  const chartLeft = 220;
  const chartTop = 520;
  const chartWidth = IMAGE_WIDTH - 440;
  const chartHeight = 1050;
  const maxValue = Math.max(...points.map((point) => point.value), 1);
  const minValue = Math.min(...points.map((point) => point.value), 0);
  const span = Math.max(1, maxValue - minValue);

  const coords = points.map((point, index) => {
    const x = chartLeft + (chartWidth * index) / Math.max(1, points.length - 1);
    const y = chartTop + chartHeight - ((point.value - minValue) / span) * chartHeight;
    return { ...point, x, y };
  });

  const linePath = coords
    .map((point, index) => `${index === 0 ? 'M' : 'L'} ${point.x.toFixed(2)} ${point.y.toFixed(2)}`)
    .join(' ');

  const pointNodes = coords
    .map(
      (point, index) => `
        <circle cx="${point.x}" cy="${point.y}" r="18" fill="${palette[index % palette.length]}" stroke="#F8FAFC" stroke-width="8" />
        <text x="${point.x}" y="${chartTop + chartHeight + 72}" text-anchor="middle" fill="#CBD5E1" font-size="42" font-family="'Microsoft YaHei','PingFang SC','Noto Sans CJK SC',sans-serif">${escapeXml(
          point.time || point.label
        )}</text>
        <text x="${point.x}" y="${point.y - 34}" text-anchor="middle" fill="#F8FAFC" font-size="42" font-weight="700" font-family="'Microsoft YaHei','PingFang SC','Noto Sans CJK SC',sans-serif">${escapeXml(
          `${point.value}${point.unit || ''}`
        )}</text>
      `
    )
    .join('\n');

  const gridLines = Array.from({ length: 5 }, (_, index) => {
    const y = chartTop + (chartHeight * index) / 4;
    return `<line x1="${chartLeft}" y1="${y}" x2="${chartLeft + chartWidth}" y2="${y}" stroke="rgba(255,255,255,0.12)" stroke-width="2" />`;
  }).join('\n');

  return `
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="${CHART_VIEWBOX}" width="${IMAGE_WIDTH}" height="${IMAGE_HEIGHT}">
      <defs>
        <linearGradient id="bg-line" x1="0" x2="1" y1="0" y2="1">
          <stop offset="0%" stop-color="#111827" />
          <stop offset="100%" stop-color="#0F172A" />
        </linearGradient>
      </defs>
      <rect width="${IMAGE_WIDTH}" height="${IMAGE_HEIGHT}" fill="url(#bg-line)" />
      <rect x="96" y="96" width="${IMAGE_WIDTH - 192}" height="${IMAGE_HEIGHT - 192}" rx="48" fill="rgba(255,255,255,0.04)" stroke="rgba(255,255,255,0.08)" />
      <text x="140" y="220" fill="#F8FAFC" font-size="88" font-weight="700" font-family="'Microsoft YaHei','PingFang SC','Noto Sans CJK SC',sans-serif">${escapeXml(
        title
      )}</text>
      <text x="140" y="300" fill="#94A3B8" font-size="40" font-family="'Microsoft YaHei','PingFang SC','Noto Sans CJK SC',sans-serif">${escapeXml(
        subtitle
      )}</text>
      ${gridLines}
      <path d="${linePath}" fill="none" stroke="${palette[0]}" stroke-width="12" stroke-linecap="round" stroke-linejoin="round" />
      ${pointNodes}
      <text x="140" y="${IMAGE_HEIGHT - 120}" fill="#64748B" font-size="32" font-family="'Microsoft YaHei','PingFang SC','Noto Sans CJK SC',sans-serif">${escapeXml(
        footer
      )}</text>
    </svg>
  `;
};

const renderTimeline = ({ points, palette, title, subtitle, footer }) => {
  const startX = 260;
  const endX = IMAGE_WIDTH - 260;
  const y = IMAGE_HEIGHT / 2 + 80;
  const step = (endX - startX) / Math.max(1, points.length - 1);

  const nodes = points
    .map((point, index) => {
      const x = startX + step * index;
      return `
        <circle cx="${x}" cy="${y}" r="26" fill="${palette[index % palette.length]}" />
        <text x="${x}" y="${y - 120}" text-anchor="middle" fill="#F8FAFC" font-size="52" font-weight="700" font-family="'Microsoft YaHei','PingFang SC','Noto Sans CJK SC',sans-serif">${escapeXml(
          point.time || point.label
        )}</text>
        <text x="${x}" y="${y + 118}" text-anchor="middle" fill="#E2E8F0" font-size="42" font-family="'Microsoft YaHei','PingFang SC','Noto Sans CJK SC',sans-serif">${escapeXml(
          point.label
        )}</text>
        <text x="${x}" y="${y + 178}" text-anchor="middle" fill="#94A3B8" font-size="32" font-family="'Microsoft YaHei','PingFang SC','Noto Sans CJK SC',sans-serif">${escapeXml(
          clip(point.note || `${point.value}${point.unit || ''}`, 24)
        )}</text>
      `;
    })
    .join('\n');

  return `
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="${CHART_VIEWBOX}" width="${IMAGE_WIDTH}" height="${IMAGE_HEIGHT}">
      <defs>
        <linearGradient id="bg-time" x1="0" x2="1" y1="0" y2="1">
          <stop offset="0%" stop-color="#0F172A" />
          <stop offset="100%" stop-color="#1E293B" />
        </linearGradient>
      </defs>
      <rect width="${IMAGE_WIDTH}" height="${IMAGE_HEIGHT}" fill="url(#bg-time)" />
      <rect x="96" y="96" width="${IMAGE_WIDTH - 192}" height="${IMAGE_HEIGHT - 192}" rx="48" fill="rgba(255,255,255,0.04)" stroke="rgba(255,255,255,0.08)" />
      <text x="140" y="220" fill="#F8FAFC" font-size="88" font-weight="700" font-family="'Microsoft YaHei','PingFang SC','Noto Sans CJK SC',sans-serif">${escapeXml(
        title
      )}</text>
      <text x="140" y="300" fill="#94A3B8" font-size="40" font-family="'Microsoft YaHei','PingFang SC','Noto Sans CJK SC',sans-serif">${escapeXml(
        subtitle
      )}</text>
      <line x1="${startX}" y1="${y}" x2="${endX}" y2="${y}" stroke="rgba(255,255,255,0.18)" stroke-width="10" stroke-linecap="round" />
      ${nodes}
      <text x="140" y="${IMAGE_HEIGHT - 120}" fill="#64748B" font-size="32" font-family="'Microsoft YaHei','PingFang SC','Noto Sans CJK SC',sans-serif">${escapeXml(
        footer
      )}</text>
    </svg>
  `;
};

const resolveChartRenderer = (chartType) => {
  const normalized = String(chartType || '').toLowerCase();
  if (normalized.includes('line') || normalized.includes('trend')) {
    return 'line';
  }
  if (normalized.includes('time')) {
    return 'timeline';
  }
  return 'bar';
};

const renderDataGraphicSvg = ({ slot, visualSystem, articleTitle }) => {
  const points = normalizeDataPoints(slot.dataPoints);
  const palette = (visualSystem.palette || []).map((color, index) =>
    normalizeHexColor(color, paletteFallbacks.fdsm[index] || '#94A3B8')
  );
  const title = slot.chartTitle || slot.role || '数据图';
  const subtitle = slot.chartSubtitle || clip(slot.rationale, 48);
  const footer = `${articleTitle} · ${slot.role}`;
  const renderer = resolveChartRenderer(slot.dataGraphicType);

  if (renderer === 'line') {
    return renderLineChart({ points, palette, title, subtitle, footer });
  }
  if (renderer === 'timeline') {
    return renderTimeline({ points, palette, title, subtitle, footer });
  }
  return renderBarChart({ points, palette, title, subtitle, footer });
};

const renderMockSceneSvg = ({ articleTitle, slot, visualSystem }) => {
  const palette = (visualSystem.palette || []).map((color, index) =>
    normalizeHexColor(color, paletteFallbacks.fdsm[index] || '#94A3B8')
  );
  const focusTerms = buildFocusTerms(slot.visualFocus || slot.anchorExcerpt).join(' · ');
  return `
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="${CHART_VIEWBOX}" width="${IMAGE_WIDTH}" height="${IMAGE_HEIGHT}">
      <defs>
        <linearGradient id="scene-bg" x1="0" x2="1" y1="0" y2="1">
          <stop offset="0%" stop-color="#0F172A" />
          <stop offset="100%" stop-color="#1E293B" />
        </linearGradient>
      </defs>
      <rect width="${IMAGE_WIDTH}" height="${IMAGE_HEIGHT}" fill="url(#scene-bg)" />
      <rect x="110" y="110" width="${IMAGE_WIDTH - 220}" height="${IMAGE_HEIGHT - 220}" rx="54" fill="rgba(255,255,255,0.04)" stroke="rgba(255,255,255,0.08)" />
      <circle cx="820" cy="860" r="320" fill="${palette[0]}" opacity="0.18" />
      <circle cx="1500" cy="760" r="180" fill="${palette[1] || palette[0]}" opacity="0.22" />
      <circle cx="2460" cy="980" r="420" fill="${palette[2] || palette[0]}" opacity="0.14" />
      <rect x="540" y="1220" width="2280" height="260" rx="36" fill="rgba(255,255,255,0.06)" />
      <text x="180" y="220" fill="#F8FAFC" font-size="88" font-weight="700" font-family="'Microsoft YaHei','PingFang SC','Noto Sans CJK SC',sans-serif">${escapeXml(
        slot.role
      )}</text>
      <text x="180" y="306" fill="#94A3B8" font-size="40" font-family="'Microsoft YaHei','PingFang SC','Noto Sans CJK SC',sans-serif">${escapeXml(
        articleTitle
      )}</text>
      <text x="180" y="440" fill="#E2E8F0" font-size="46" font-family="'Microsoft YaHei','PingFang SC','Noto Sans CJK SC',sans-serif">${escapeXml(
        slot.anchorHeading || '正文'
      )}</text>
      <text x="180" y="520" fill="#CBD5E1" font-size="34" font-family="'Microsoft YaHei','PingFang SC','Noto Sans CJK SC',sans-serif">${escapeXml(
        clip(slot.anchorExcerpt, 120)
      )}</text>
      <text x="180" y="${IMAGE_HEIGHT - 180}" fill="#94A3B8" font-size="32" font-family="'Microsoft YaHei','PingFang SC','Noto Sans CJK SC',sans-serif">${escapeXml(
        focusTerms || 'editorial business illustration'
      )}</text>
    </svg>
  `;
};

const buildImagePrompt = ({ articleTitle, slot, visualSystem, profileId, targetImageCount, promptAssets }) =>
  [
    promptAssets.guardrails,
    `为一篇中文商业文章生成第 ${slot.order}/${targetImageCount} 张 editorial 配图。`,
    `文章标题：${articleTitle}`,
    `图位职责：${slot.role}`,
    `这张图要承接的判断：${slot.rationale}`,
    `对应正文段落：${slot.anchorExcerpt}`,
    `画面重点：${slot.visualFocus}`,
    `构图要求：${slot.composition}`,
    `情绪与气质：${slot.mood}`,
    `整篇统一视觉方向：${visualSystem.visual_direction}`,
    `真实感等级：${visualSystem.realism_level}`,
    `整篇统一光线：${visualSystem.lighting}`,
    `整篇统一色彩：${(visualSystem.palette || []).join(', ')}`,
    `整篇统一构图规则：${(visualSystem.composition_rules || []).join('；')}`,
    `整篇统一材质规则：${(visualSystem.texture_rules || []).join('；')}`,
    `一致性说明：${slot.consistencyNote}`,
    `风格库：${profileId === 'latepost' ? 'LatePost 报道型商业写作' : 'FDSM 分析型商业写作'}`,
    '对象一致性要求：画面主体必须与整篇文章讨论的公司、品牌、人物、产品和业务场景保持一致，不要换成不相关的门店、品牌、人物或行业。',
    '品牌呈现要求：如果涉及真实品牌，不要在招牌上生成清晰可读的文字，不要硬写品牌名，优先用门头颜色、货箱、制服、空间关系和街景细节表达对象。',
    '输出要求：单张横版 16:9 图片，3840x2160 4K，清晰、成熟、编辑型，不要拼贴感，不要低清压缩感。',
    `禁止元素：${promptAssets.negativePrompt}`,
  ].join('\n');

const generateJson = async ({ apiKey, model, systemInstruction, prompt, schema, referenceParts = [] }) => {
  const client = createGenAiClient(apiKey, PLANNER_TIMEOUT_MS + 60_000);
  const candidates = [...new Set([model, DEFAULT_PLANNER_MODEL, 'gemini-2.5-flash'].filter(Boolean))];
  let lastError;

  for (const candidateModel of candidates) {
    try {
      const response = await withTimeout(
        callWithRetry(() =>
          client.models.generateContent({
            model: candidateModel,
            contents: [{ role: 'user', parts: [{ text: prompt }, ...referenceParts] }],
            config: {
              systemInstruction,
              responseMimeType: 'application/json',
              responseSchema: schema,
            },
          })
        ),
        PLANNER_TIMEOUT_MS,
        '规划请求'
      );
      return JSON.parse(response.text || '{}');
    } catch (error) {
      lastError = error;
      if (!isModelNotFoundError(error)) {
        throw error;
      }
    }
  }

  throw lastError;
};

const generateImageBuffer = async ({ apiKey, prompt, model = DEFAULT_IMAGE_MODEL, fallbackSvg, referenceParts = [] }) => {
  if (shouldUseMockProvider()) {
    const buffer = await sharp(Buffer.from(fallbackSvg, 'utf8')).png({ compressionLevel: 0, palette: false }).toBuffer();
    return {
      buffer,
      mimeType: 'image/png',
    };
  }

  const client = createGenAiClient(apiKey, IMAGE_TIMEOUT_MS + 60_000);
  const response = await withTimeout(
    callWithRetry(
      () =>
        client.models.generateContent({
          model,
          contents: [{ role: 'user', parts: [{ text: prompt }, ...referenceParts] }],
          config: {
            responseModalities: [Modality.IMAGE],
            imageConfig: {
              aspectRatio: IMAGE_ASPECT_RATIO,
              imageSize: '4K',
            },
          },
        }),
      3,
      1800
    ),
    IMAGE_TIMEOUT_MS,
    '4K 生图请求'
  );
  const image = extractImageBytes(response);
  if (!image) {
    throw new Error('Nanobanana Pro 未返回图片数据。');
  }
  return image;
};

const readIllustrationPrompts = async (profileId) => {
  const profile = getStyleProfile(profileId);
  const commonSystem = await readUtf8(path.join(ROOT_DIR, 'rag_assets', 'global', 'runtime', 'illustration_system.md'));
  const commonStyle = await readUtf8(path.join(ROOT_DIR, 'rag_assets', 'global', 'runtime', 'illustration_style.md'));
  const commonGuardrails = await readUtf8(
    path.join(ROOT_DIR, 'rag_assets', 'global', 'runtime', 'illustration_global_guardrails.md')
  );
  const dataRules = await readUtf8(path.join(ROOT_DIR, 'rag_assets', 'global', 'runtime', 'illustration_data_chart_rules.md'));
  const negativePrompt = await readUtf8(
    path.join(ROOT_DIR, 'rag_assets', 'global', 'runtime', 'illustration_negative_prompt.md')
  );
  const profileStylePath = path.join(ROOT_DIR, profile.runtimeDir, 'illustration_style.md');
  const profileStyle = (await fileExists(profileStylePath)) ? await readUtf8(profileStylePath) : commonStyle;

  return {
    system: commonSystem,
    guardrails: commonGuardrails,
    dataRules,
    negativePrompt,
    profileStyle,
  };
};

const resolveSourceHashFromManifestPath = (manifestPath) => {
  const normalized = cleanText(manifestPath).replace(/\\/g, '/');
  if (!normalized) return '';
  const parts = normalized.split('/').filter(Boolean);
  const manifestIndex = parts.lastIndexOf('manifest.json');
  if (manifestIndex > 0) {
    return cleanText(parts[manifestIndex - 1]);
  }
  return cleanText(parts[parts.length - 2]);
};

const writeManifest = async (manifestPath, manifest) => {
  return cacheIllustrationBundle(manifest);
};

const loadExistingManifest = async (manifestPath) => {
  return getCachedIllustrationBundle(resolveSourceHashFromManifestPath(manifestPath));
};

const buildInlineImageDataUrl = ({ buffer, mimeType }) => `data:${mimeType};base64,${buffer.toString('base64')}`;

const saveGeneratedImage = async ({ buffer }) => {
  const resized = await sharp(buffer)
    .resize(IMAGE_WIDTH, IMAGE_HEIGHT, {
      fit: 'cover',
      position: 'attention',
      withoutEnlargement: false,
    })
    .jpeg({
      quality: 84,
      mozjpeg: true,
      chromaSubsampling: '4:4:4',
    })
    .toBuffer();

  return {
    buffer: resized,
    mimeType: 'image/jpeg',
    width: IMAGE_WIDTH,
    height: IMAGE_HEIGHT,
    dataUrl: buildInlineImageDataUrl({
      buffer: resized,
      mimeType: 'image/jpeg',
    }),
  };
};

const saveDataGraphic = async ({ svg, outputPath }) => {
  await fs.writeFile(outputPath, svg, 'utf8');
  return {
    mimeType: 'image/svg+xml',
    width: IMAGE_WIDTH,
    height: IMAGE_HEIGHT,
  };
};

const relativeGeneratedUrl = ({ sourceHash, fileName }) => `/generated-assets/illustrations/${sourceHash}/${fileName}`;

const generateArticleIllustrationsLegacy = async (params = {}) => generateArticleIllustrations(params);
const buildVersionedAssetId = (slotId, versionIndex) => `${slotId}@v${versionIndex}`;

const buildVersionedFileName = ({ slotId, versionIndex, extension }) => `${slotId}.v${versionIndex}.${extension}`;

const toAssetArray = (value) =>
  Array.isArray(value)
    ? [...value]
        .map((item) => item || {})
        .sort((left, right) => Number(left.versionIndex || 0) - Number(right.versionIndex || 0))
    : [];

const summarizeDataSpec = (dataSpec) =>
  Array.isArray(dataSpec?.points)
    ? dataSpec.points
        .slice(0, 6)
        .map((point) => `${point.label}:${point.displayValue || `${point.value}${point.unit || ''}`}`)
        .join('；')
    : '';

const buildDataChartPrompt = ({ articleTitle, slot, visualSystem }) =>
  [
    '为一篇中文商业文章生成单张 16:9 数据图配图。',
    `文章标题：${articleTitle}`,
    `图位标题：${slot.title || slot.role}`,
    `图位要承接的核心意思：${slot.purpose}`,
    `对应正文片段：${slot.anchorExcerpt}`,
    slot.dataSpec ? `必须表达的数据关系：${summarizeDataSpec(slot.dataSpec)}` : '',
    `推荐图表类型：${slot.dataSpec?.chartType || 'comparison_bar'}`,
    `图表标题：${slot.dataSpec?.title || slot.title || slot.role}`,
    `图表结论：${slot.dataSpec?.insight || slot.purpose}`,
    `统一色彩：${Array.isArray(visualSystem.palette) ? visualSystem.palette.join(', ') : ''}`,
    `统一图表语言：${
      Array.isArray(visualSystem.chart_language)
        ? visualSystem.chart_language.join('；')
        : cleanText(visualSystem.chartStyle || '')
    }`,
    '只生成标准商业数据图，不要人物、办公室、门店、会议室、屏幕、投影墙、电脑界面、UI 面板、信息大屏、海报或任何实景空间。',
    '不要把图表画进电视、显示器、会议大屏、墙面看板或产品界面里。',
    '不要生成 dashboard screenshot，不要生成信息墙，不要生成带实景透视的图表场景。',
    '画面主体必须就是图表本身，层级清晰，标签精简，重点数字突出，适合公众号文章配图。',
    '输出要求：单张横版 16:9 图片，3840x2160，高清，成熟商业媒体风格。',
  ]
    .filter(Boolean)
    .join('\n\n');

const buildSlotRasterPrompt = ({ articleTitle, articleContent, slot, visualSystem }) =>
  [
    '为一篇中文商业文章生成单张 editorial 配图。',
    `文章标题：${articleTitle}`,
    `图位标题：${slot.title || slot.role}`,
    `图位要承接的核心意思：${slot.purpose}`,
    `对应正文片段：${slot.anchorExcerpt}`,
    slot.dataSpec ? `需要吸收的关键数字关系：${summarizeDataSpec(slot.dataSpec)}` : '',
    `统一视觉方向：${visualSystem.visual_direction || ''}`,
    `统一色彩：${Array.isArray(visualSystem.palette) ? visualSystem.palette.join(', ') : ''}`,
    `统一构图规则：${Array.isArray(visualSystem.composition_rules) ? visualSystem.composition_rules.join('；') : ''}`,
    '对象一致性要求：画面主体必须围绕文章讨论的公司、品牌、人物和业务场景，不要换成无关门店、无关品牌或无关行业。',
    '品牌呈现要求：如果涉及真实品牌，不要在招牌上生成清晰可读的字，优先通过门头颜色、货箱、制服、街景和物流细节表达对象。',
    '清晰度要求：必须按 3840x2160 的 4K 横图质量生成，不要做低清、模糊、压缩感强或细节发虚的画面。',
    '不要做图表或 SVG，要直接生成图片。',
    cleanText(articleContent) ? '整篇文章全文（必须先整体理解文章，再为当前图位出图）：' : '',
    cleanText(articleContent),
  ]
    .filter(Boolean)
    .join('\n\n');

const appendArticleContextToPrompt = (prompt, articleContent) => {
  const cleanPrompt = cleanText(prompt);
  const fullArticle = cleanText(articleContent);
  if (!fullArticle) {
    return cleanPrompt;
  }

  const probe = fullArticle.slice(0, 120);
  if (probe && cleanPrompt.includes(probe)) {
    return cleanPrompt;
  }

  return [cleanPrompt, '整篇文章全文（必须先整体理解文章，再为当前图位出图）：', fullArticle]
    .filter(Boolean)
    .join('\n\n');
};

const buildIllustrationExplanationFallback = ({ slot }) => {
  const anchorSentences = splitCaptionSentences(slot.anchorExcerpt);
  const purposeSentences = splitCaptionSentences(stripCaptionPlanningLanguage(slot.purpose));
  const dataSummary = cleanText(summarizeDataSpec(slot.dataSpec));
  const sentences = [];

  const pushSentence = (candidate, limit = 36) => {
    const nextSentence = toCaptionSentence(candidate, limit);
    if (!nextSentence) {
      return;
    }
    const normalized = nextSentence.replace(/[。！？!?…]/g, '');
    if (!normalized || sentences.some((item) => item.replace(/[。！？!?…]/g, '') === normalized)) {
      return;
    }
    sentences.push(nextSentence);
  };

  pushSentence(anchorSentences[0] || purposeSentences[0] || slot.title || slot.sectionTitle, slot.dataSpec ? 34 : 38);
  pushSentence(anchorSentences[1], 38);

  if (sentences.length < 2 && dataSummary) {
    pushSentence(`图里最值得看的数字变化是${clip(dataSummary, 28)}`, 38);
  }

  if (sentences.length < 2) {
    pushSentence(purposeSentences[1] || purposeSentences[0], 36);
  }

  if (sentences.length < 2) {
    pushSentence(`${slot.sectionTitle || slot.title || '这一段'}把讨论落到了更具体的业务现场`, 34);
  }

  return cleanText(sentences.slice(0, 2).join(' '));
};

const normalizeIllustrationExplanation = (text, slot) => {
  const normalized = cleanText(text).replace(/\s+/g, ' ');
  if (!normalized || looksLikeInternalCaption(normalized)) {
    return buildIllustrationExplanationFallback({ slot });
  }
  return normalized;
};

const logIllustrationCaptionFallback = ({ slot, model, reason }) => {
  const normalizedReason = clip(cleanText(reason) || 'empty caption payload', 220);
  console.warn(
    `[illustrations] falling back to synthesized caption for slot "${slot?.id || slot?.title || 'unknown'}" with model "${model || DEFAULT_PLANNER_MODEL}": ${normalizedReason}`
  );
};

const generateIllustrationExplanation = async ({
  apiKey,
  plannerModel,
  articleTitle,
  articleContent,
  slot,
  userPrompt,
  existingExplanation = '',
  imageBuffer,
  imageMimeType = 'image/png',
}) => {
  if (shouldUseMockProvider() || !apiKey || !imageBuffer) {
    return buildIllustrationExplanationFallback({ slot });
  }

  const client = createGenAiClient(apiKey, CAPTION_TIMEOUT_MS + 30_000);
  const candidateModels = [...new Set([plannerModel, DEFAULT_PLANNER_MODEL, 'gemini-2.5-flash'].filter(Boolean))];
  let lastError = null;

  for (const candidateModel of candidateModels) {
    try {
      const response = await withTimeout(
        callWithRetry(() =>
          client.models.generateContent({
            model: candidateModel,
            contents: [
              {
                role: 'user',
                parts: [
                  {
                    text: [
                      '你是中文商业文章的图片编辑。',
                      '你会同时看到整篇文章、当前图位信息和已经生成好的图片。',
                      '请写两句可以直接放在图片下方的中文配文，只输出配文本身。',
                      '语气要像文章正文自然延长出来的两句话，不要像解释图，不要像系统说明，不要像写提示词。',
                      '不要写标题，不要出现“这张图”“该图”“图位”“首图”“Scene”“Data”“用于承接”“体现了”“隐喻了”“AI”“生成”等字样。',
                      '第一句先落具体对象、位置、关系或情境；第二句再自然接上文章里的判断，但不要硬拐弯，不要总结腔。',
                      '图中如果出现偏题元素，要以文章主题为准，把重点拉回文章真正讨论的公司、渠道、人物或业务。',
                      '文字要自然、克制、像成熟编辑写的图注，不要解释自己在解释，也不要故作深刻。',
                      '控制在 38 到 78 个汉字，两句，简体中文。',
                      `文章标题：${articleTitle}`,
                      `图位标题：${slot.title || slot.role}`,
                      `对应小节：${slot.sectionTitle || '正文'}`,
                      `图位要承接的核心判断：${slot.purpose}`,
                      `正文锚点：${slot.anchorExcerpt}`,
                      slot.dataSpec ? `需要吸收的数据关系：${summarizeDataSpec(slot.dataSpec)}` : '',
                      cleanText(existingExplanation) ? `当前已有图释：${cleanText(existingExplanation)}` : '',
                      cleanText(userPrompt) ? `本轮用户补充要求：${cleanText(userPrompt)}` : '',
                      cleanText(existingExplanation) && cleanText(userPrompt)
                        ? '请在不改图片内容的前提下，根据用户要求重写图释，保留文章语气和事实方向。'
                        : '',
                      '整篇文章全文：',
                      cleanText(articleContent),
                    ]
                      .filter(Boolean)
                      .join('\n\n'),
                  },
                  createPartFromBase64(imageBuffer.toString('base64'), imageMimeType),
                ],
              },
            ],
            config: {
              responseMimeType: 'application/json',
              responseSchema: IMAGE_EXPLANATION_SCHEMA,
            },
          })
        ),
        CAPTION_TIMEOUT_MS,
        '图释生成请求'
      );

      const payload = JSON.parse(response.text || '{}');
      const explanation = normalizeIllustrationExplanation(
        String(payload?.explanation || '').replace(/^图释[:：]\s*/, ''),
        slot
      );
      if (explanation) {
        return explanation;
      }
      lastError = new Error('empty caption payload');
    } catch (error) {
      lastError = error;
      if (!isModelNotFoundError(error)) {
        break;
      }
    }
  }

  logIllustrationCaptionFallback({
    slot,
    model: plannerModel || DEFAULT_PLANNER_MODEL,
    reason: lastError?.message || lastError || 'unknown caption generation failure',
  });
  return buildIllustrationExplanationFallback({ slot });
};

const resolveIllustrationAssetPath = ({ sourceHash, assetUrl }) => {
  const fileName = cleanText(decodeURIComponent(String(assetUrl || '').split('?')[0])).split('/').pop();
  if (!fileName) {
    throw new Error('未找到当前图位对应的图片文件。');
  }
  return path.join(GENERATED_ROOT, sourceHash, fileName);
};

const decodeInlineImageDataUrl = (value) => {
  const parsed = parseInlineImageDataUrl(value);
  if (!parsed) {
    return null;
  }
  return {
    mimeType: parsed.mimeType,
    buffer: parsed.buffer,
  };
};

const loadIllustrationCaptionImageInput = async ({ assetUrl, mimeType, sourceHash }) => {
  const inlineImage = decodeInlineImageDataUrl(assetUrl);
  if (inlineImage) {
    if (String(inlineImage.mimeType || '').toLowerCase().includes('svg')) {
      return {
        imageBuffer: await sharp(inlineImage.buffer).png({ compressionLevel: 0, palette: false }).toBuffer(),
        imageMimeType: 'image/png',
      };
    }

    return {
      imageBuffer: inlineImage.buffer,
      imageMimeType: cleanText(inlineImage.mimeType) || cleanText(mimeType) || 'image/png',
    };
  }

  const assetPath = resolveIllustrationAssetPath({ sourceHash, assetUrl });
  const rawBuffer = await fs.readFile(assetPath);
  if (String(mimeType || '').toLowerCase().includes('svg') || assetPath.toLowerCase().endsWith('.svg')) {
    return {
      imageBuffer: await sharp(rawBuffer).png({ compressionLevel: 0, palette: false }).toBuffer(),
      imageMimeType: 'image/png',
    };
  }

  return {
    imageBuffer: rawBuffer,
    imageMimeType: cleanText(mimeType) || 'image/png',
  };
};

const normalizeAssetRecord = (asset, slotId, slotDefaults = {}) => {
  const versionIndex = Math.max(1, Number(asset?.versionIndex || 1));
  return {
    id: cleanText(asset?.id) || buildVersionedAssetId(slotId, versionIndex),
    slotId,
    role: cleanText(asset?.role) || slotDefaults.role || 'key_case',
    renderMode: cleanText(asset?.renderMode) || slotDefaults.renderMode || 'nanobanana_pro',
    title: cleanText(asset?.title) || slotDefaults.title || '配图',
    url: cleanText(asset?.url) || cleanText(slotDefaults.assetUrl),
    mimeType: cleanText(asset?.mimeType) || cleanText(slotDefaults.mimeType) || 'image/png',
    width: Number(asset?.width || slotDefaults.width || IMAGE_WIDTH) || IMAGE_WIDTH,
    height: Number(asset?.height || slotDefaults.height || IMAGE_HEIGHT) || IMAGE_HEIGHT,
    versionIndex,
    createdAt: cleanText(asset?.createdAt) || new Date().toISOString(),
    userPrompt: cleanText(asset?.userPrompt) || undefined,
    editorCaption: normalizeIllustrationExplanation(asset?.editorCaption || slotDefaults.explanation || '', slotDefaults),
  };
};

const syncSlotWithActiveAsset = (slot, versions) => {
  const sortedVersions = toAssetArray(versions);
  const activeAsset =
    sortedVersions.find((asset) => asset.id === slot.activeAssetId) || sortedVersions[sortedVersions.length - 1] || null;
  const fallbackStatus =
    slot.status === 'rendering' || slot.status === 'error'
      ? slot.status
      : sortedVersions.length > 0
        ? 'ready'
        : 'planned';

  return {
    ...slot,
    explanation: normalizeIllustrationExplanation(activeAsset?.editorCaption || slot.explanation || slot.purpose, slot),
    activeAssetId: activeAsset?.id,
    versionCount: sortedVersions.length,
    assetUrl: activeAsset?.url,
    mimeType: activeAsset?.mimeType,
    width: activeAsset?.width,
    height: activeAsset?.height,
    status: activeAsset ? 'ready' : fallbackStatus,
  };
};

const buildActiveAssetList = (slots, assetVersions) =>
  slots
    .map((slot) => {
      const versions = toAssetArray(assetVersions?.[slot.id]);
      const activeAsset = versions.find((asset) => asset.id === slot.activeAssetId) || versions[versions.length - 1];
      return activeAsset || null;
    })
    .filter(Boolean);

const normalizeIllustrationManifest = (manifest, defaults = {}) => {
  const sourceHash = cleanText(manifest?.sourceHash || defaults.sourceHash);
  const slots = Array.isArray(manifest?.slots)
    ? manifest.slots.map((slot) => ({
        ...slot,
        explanation: normalizeIllustrationExplanation(slot?.explanation || slot?.editorCaption || slot?.purpose, slot),
        focusTerms: Array.isArray(slot?.focusTerms) ? slot.focusTerms.map((item) => cleanText(item)).filter(Boolean) : [],
        qualityChecks: Array.isArray(slot?.qualityChecks)
          ? slot.qualityChecks.map((item) => cleanText(item)).filter(Boolean)
          : [],
      }))
    : [];

  const existingVersions = manifest?.assetVersions && typeof manifest.assetVersions === 'object' ? manifest.assetVersions : {};
  const assetVersions = {};

  for (const slot of slots) {
    const rawVersions = toAssetArray(existingVersions?.[slot.id]);
    const normalizedVersions = rawVersions.map((asset) => normalizeAssetRecord(asset, slot.id, slot));

    if (normalizedVersions.length === 0) {
      const activeAsset = Array.isArray(manifest?.assets) ? manifest.assets.find((asset) => asset.slotId === slot.id) : null;
      if (activeAsset || slot.assetUrl) {
        normalizedVersions.push(
          normalizeAssetRecord(
            activeAsset || {
              slotId: slot.id,
              role: slot.role,
              renderMode: slot.renderMode,
              title: slot.title,
              url: slot.assetUrl,
              mimeType: slot.mimeType,
              width: slot.width,
              height: slot.height,
            },
            slot.id,
            slot
          )
        );
      }
    }

    assetVersions[slot.id] = normalizedVersions;
  }

  const normalizedSlots = slots.map((slot) => syncSlotWithActiveAsset(slot, assetVersions[slot.id]));
  const assets = buildActiveAssetList(normalizedSlots, assetVersions);
  const styleReferenceImage = normalizeIllustrationStyleReferenceImage(
    manifest?.styleReferenceImage || defaults.styleReferenceImage
  );

  return {
    promptVersion: cleanText(manifest?.promptVersion || defaults.promptVersion) || ILLUSTRATION_PROMPT_VERSION,
    sourceHash,
    articleHash: cleanText(manifest?.articleHash || defaults.articleHash),
    articleTitle: cleanText(manifest?.articleTitle || defaults.articleTitle) || '未命名文章',
    styleProfile: cleanText(manifest?.styleProfile || defaults.styleProfile) || 'fdsm',
    model: cleanText(manifest?.model || defaults.model) || DEFAULT_IMAGE_MODEL,
    wordCount: Number(manifest?.wordCount || defaults.wordCount || 0),
    targetImageCount: Number(manifest?.targetImageCount || defaults.targetImageCount || normalizedSlots.length || 1),
    globalUserPrompt: cleanText(manifest?.globalUserPrompt || defaults.globalUserPrompt) || undefined,
    imageCountPrompt: cleanText(manifest?.imageCountPrompt || defaults.imageCountPrompt) || undefined,
    styleReferenceImage,
    status: cleanText(manifest?.status || defaults.status) || 'ready',
    generatedAt: cleanText(manifest?.generatedAt || defaults.generatedAt) || undefined,
    updatedAt: cleanText(manifest?.updatedAt || defaults.updatedAt) || undefined,
    visualSystem: manifest?.visualSystem || defaults.visualSystem || {},
    slots: normalizedSlots,
    assets,
    assetVersions,
    progress: manifest?.progress || defaults.progress,
    warnings: Array.isArray(manifest?.warnings) ? manifest.warnings.map((item) => cleanText(item)).filter(Boolean) : undefined,
    error: cleanText(manifest?.error || defaults.error) || undefined,
  };
};

const loadNormalizedManifest = async (manifestPath, defaults = {}) => {
  const raw = await loadExistingManifest(manifestPath);
  if (!raw) {
    return null;
  }
  return normalizeIllustrationManifest(raw, defaults);
};

const createSceneSlotSeed = ({
  slot,
  negativePrompt,
  resolvedTitle,
  normalizedPlan,
  normalizedProfileId,
  targetImageCount,
  promptAssets,
  articleContent,
}) => ({
  id: `${String(slot.order).padStart(2, '0')}-${stableSlug(slot.role)}`,
  order: slot.order,
  role: mapRoleToFrontendRole(slot.role, false),
  renderMode: 'nanobanana_pro',
  title: slot.role,
  sectionTitle: slot.anchorHeading || `段落 ${slot.anchorParagraphIndex + 1}`,
  purpose: slot.rationale,
  explanation: '',
  anchorParagraphIndex: slot.anchorParagraphIndex,
  anchorExcerpt: slot.anchorExcerpt,
  focusTerms: buildFocusTerms(slot.visualFocus),
  qualityChecks: ['主体清晰', '无文字水印', '符合整篇视觉系统'],
  prompt: [
    buildImagePrompt({
      articleTitle: resolvedTitle,
      slot,
      visualSystem: normalizedPlan.visualSystem,
      profileId: normalizedProfileId,
      targetImageCount,
      promptAssets,
    }),
    '整篇文章全文（必须先整体理解文章，再为当前图位出图）：',
    cleanText(articleContent),
  ]
    .filter(Boolean)
    .join('\n\n'),
  negativePrompt: `${negativePrompt} ${(normalizedPlan.visualSystem.forbidden_elements || []).join('；')}`.trim(),
  status: 'planned',
});

const createChartSlotSeed = ({ slot, negativePrompt, normalizedPlan }) => ({
  id: `${String(slot.order).padStart(2, '0')}-${stableSlug(slot.role)}`,
  order: slot.order,
  role: mapRoleToFrontendRole(slot.role, true),
  renderMode: 'svg_chart',
  title: slot.chartTitle || slot.role,
  sectionTitle: slot.anchorHeading || `段落 ${slot.anchorParagraphIndex + 1}`,
  purpose: slot.rationale,
  explanation: '',
  anchorParagraphIndex: slot.anchorParagraphIndex,
  anchorExcerpt: slot.anchorExcerpt,
  focusTerms: buildFocusTerms(slot.visualFocus),
  qualityChecks: ['保持整篇统一视觉系统', '数据关系必须与正文一致'],
  prompt: '',
  negativePrompt: `${negativePrompt} ${(normalizedPlan.visualSystem.forbidden_elements || []).join('；')}`.trim(),
  dataSpec: {
    chartType:
      resolveChartRenderer(slot.dataGraphicType) === 'line'
        ? 'metric_grid'
        : resolveChartRenderer(slot.dataGraphicType) === 'timeline'
          ? 'timeline'
          : 'comparison_bar',
    title: slot.chartTitle || slot.role,
    insight: slot.dataGraphicRationale || slot.rationale,
    points: slot.dataPoints.map((point) => ({
      label: point.label,
      value: point.value,
      displayValue: `${point.value}${point.unit || ''}`,
      unit: point.unit || undefined,
      note: point.note || undefined,
    })),
  },
  status: 'planned',
});

const createNanobananaChartSlotSeed = ({ slot, negativePrompt, normalizedPlan, resolvedTitle }) => {
  const baseSeed = createChartSlotSeed({ slot, negativePrompt, normalizedPlan });
  const nextSeed = {
    ...baseSeed,
    renderMode: 'nanobanana_pro',
    qualityChecks: ['必须是纯数据图，不是实景场景', '数字关系必须与正文一致', '图表层级清晰，重点数字突出', '禁止办公室大屏、看板、屏幕截图和人物环境'],
  };

  return {
    ...nextSeed,
    prompt: buildDataChartPrompt({
      articleTitle: resolvedTitle,
      slot: nextSeed,
      visualSystem: normalizedPlan.visualSystem,
    }),
  };
};

const createIllustrationSlotSeed = (params) =>
  params.slot.shouldUseDataGraphic && Array.isArray(params.slot.dataPoints) && params.slot.dataPoints.length >= 2
    ? createNanobananaChartSlotSeed(params)
    : createSceneSlotSeed(params);

const renderSlotVersion = async ({
  apiKey,
  plannerModel,
  imageModel,
  articleTitle,
  articleContent,
  slot,
  visualSystem,
  userPrompt,
  styleReferenceImage,
  onImageSaved,
  abortIfCanceled,
}) => {
  const versionHistory = toAssetArray(slot.assetVersions);
  const versionIndex =
    versionHistory.length === 0 ? 1 : Math.max(...versionHistory.map((asset) => Number(asset.versionIndex || 0))) + 1;
  const assetId = buildVersionedAssetId(slot.id, versionIndex);
  const createdAt = new Date().toISOString();
  const rasterSlot =
    slot.renderMode === 'svg_chart' ||
    String(slot.mimeType || '').toLowerCase().includes('svg') ||
    String(slot.assetUrl || '').toLowerCase().endsWith('.svg')
      ? {
          ...slot,
          renderMode: 'nanobanana_pro',
          prompt:
            cleanText(slot.prompt) ||
            (slot.dataSpec
              ? buildDataChartPrompt({
                  articleTitle,
                  slot,
                  visualSystem,
                })
              : buildSlotRasterPrompt({
                  articleTitle,
                  articleContent,
                  slot,
                  visualSystem,
                })),
        }
      : {
          ...slot,
          renderMode: 'nanobanana_pro',
        };

  let prompt = cleanText(rasterSlot.prompt);
  if (!prompt) {
    prompt = rasterSlot.dataSpec
      ? buildDataChartPrompt({
          articleTitle,
          slot: rasterSlot,
          visualSystem,
        })
      : buildSlotRasterPrompt({
          articleTitle,
          articleContent,
          slot: rasterSlot,
          visualSystem,
        });
  }

  if (!rasterSlot.dataSpec) {
    prompt = appendArticleContextToPrompt(prompt, articleContent);
    prompt = `${prompt}\n\n对象一致性要求：必须围绕文章讨论的核心公司、品牌、人物和业务场景出图，不能换成不相关的门店、品牌或城市地标。`;
  }

  if (cleanText(userPrompt)) {
    prompt = `${prompt}\n\n用户追加要求：${cleanText(userPrompt)}`;
  }

  prompt = prompt
    .replaceAll('横版', '方形')
    .replaceAll('横图', '方图')
    .replaceAll('16:9', IMAGE_ASPECT_RATIO)
    .replaceAll('3840x2160', '3840x3840');
  const styleReferenceParts = buildIllustrationStyleReferenceParts(styleReferenceImage);
  if (styleReferenceParts.length > 0) {
    prompt = `${prompt}\n\nA style reference image is attached. Match its crop discipline, palette, texture, lighting, and editorial mood without copying unrelated literal subjects.`;
  }

  await abortIfCanceled?.();
  const generated = await generateImageBuffer({
    apiKey,
    prompt,
    model: imageModel || DEFAULT_IMAGE_MODEL,
    referenceParts: styleReferenceParts,
    fallbackSvg: renderMockSceneSvg({
      articleTitle,
      slot: {
        role: rasterSlot.title,
        anchorHeading: rasterSlot.sectionTitle,
        anchorExcerpt: rasterSlot.anchorExcerpt,
        visualFocus: rasterSlot.focusTerms.join('，') || rasterSlot.anchorExcerpt,
      },
      visualSystem,
    }),
  });
  await abortIfCanceled?.();

  const saved = await saveGeneratedImage({
    buffer: generated.buffer,
  });
  const savedBuffer = saved.buffer;
  await abortIfCanceled?.();

  const intermediateAsset = {
    id: assetId,
    slotId: rasterSlot.id,
    role: rasterSlot.role,
    renderMode: 'nanobanana_pro',
    title: rasterSlot.title,
    url: saved.dataUrl,
    mimeType: saved.mimeType,
    width: saved.width,
    height: saved.height,
    versionIndex,
    createdAt,
    userPrompt: cleanText(userPrompt) || undefined,
    editorCaption: cleanText(rasterSlot.explanation || rasterSlot.purpose || rasterSlot.anchorExcerpt),
  };

  if (typeof onImageSaved === 'function') {
    await abortIfCanceled?.();
    await onImageSaved({
      slot: {
        ...rasterSlot,
        status: 'ready',
        explanation: cleanText(rasterSlot.explanation || rasterSlot.purpose || rasterSlot.anchorExcerpt),
        lastUserPrompt: cleanText(userPrompt) || undefined,
      },
      asset: intermediateAsset,
    });
    await abortIfCanceled?.();
  }

  const explanation = await generateIllustrationExplanation({
    apiKey,
    plannerModel,
    articleTitle,
    articleContent,
    slot: rasterSlot,
    userPrompt,
    imageBuffer: savedBuffer,
  });
  await abortIfCanceled?.();

  return {
    slot: {
      ...rasterSlot,
      status: 'ready',
      explanation,
      lastUserPrompt: cleanText(userPrompt) || undefined,
      qualityChecks: rasterSlot.qualityChecks,
    },
    asset: {
      id: assetId,
      slotId: rasterSlot.id,
      role: rasterSlot.role,
      renderMode: 'nanobanana_pro',
      title: rasterSlot.title,
      url: saved.dataUrl,
      mimeType: saved.mimeType,
      width: saved.width,
      height: saved.height,
      versionIndex,
      createdAt,
      userPrompt: cleanText(userPrompt) || undefined,
      editorCaption: explanation,
    },
    warnings: [],
  };
};
const updateManifestSlotVersion = (manifest, nextSlot, nextAsset) => {
  const existingVersions = toAssetArray(manifest.assetVersions?.[nextSlot.id]);
  const mergedVersions = existingVersions.some((asset) => asset.id === nextAsset.id)
    ? existingVersions.map((asset) => (asset.id === nextAsset.id ? nextAsset : asset))
    : [...existingVersions, nextAsset];
  const assetVersions = {
    ...manifest.assetVersions,
    [nextSlot.id]: mergedVersions,
  };
  const syncedSlot = syncSlotWithActiveAsset(
    {
      ...nextSlot,
      activeAssetId: nextAsset.id,
    },
    assetVersions[nextSlot.id]
  );
  const slots = manifest.slots.map((slot) => (slot.id === nextSlot.id ? syncedSlot : slot));
  return normalizeIllustrationManifest({
    ...manifest,
    updatedAt: new Date().toISOString(),
    slots,
    assetVersions,
  });
};

export const generateArticleIllustrations = async ({
  apiKey,
  plannerModel = DEFAULT_PLANNER_MODEL,
  imageModel = DEFAULT_IMAGE_MODEL,
  profileId,
  articleTitle,
  articleContent,
  options = {},
  userPrompt = '',
  imageCountPrompt = '',
  styleReferenceImage,
  force = false,
}) => {
  const normalizedProfileId = resolveStyleProfileId(profileId);
  const profile = getStyleProfile(normalizedProfileId);
  const resolvedTitle = extractArticleTitle(articleTitle, articleContent);
  const normalizedStyleReferenceImage = normalizeIllustrationStyleReferenceImage(styleReferenceImage);
  const requestedStyleReferenceFingerprint = buildIllustrationStyleReferenceFingerprint(normalizedStyleReferenceImage);
  const sourceHash = buildSourceHash({
    profileId: normalizedProfileId,
    title: resolvedTitle,
    articleContent,
    styleReferenceImage: normalizedStyleReferenceImage,
  });
  const articleHash = computeArticleHash(normalizedProfileId, articleContent);
  const targetDir = path.join(GENERATED_ROOT, sourceHash);
  const manifestPath = path.join(targetDir, 'manifest.json');

  if (!force) {
    const existing = await loadNormalizedManifest(manifestPath, {
      sourceHash,
      articleHash,
      articleTitle: resolvedTitle,
      styleProfile: normalizedProfileId,
      model: imageModel || DEFAULT_IMAGE_MODEL,
    });
    const hasSvgAsset = Boolean(
      existing?.assets?.some((asset) => asset.renderMode === 'svg_chart' || String(asset.mimeType || '').includes('svg'))
    );
    const hasMissingExplanation = Boolean(existing?.slots?.some((slot) => !cleanText(slot.explanation)));
    const isLegacyManifest = existing?.promptVersion !== ILLUSTRATION_PROMPT_VERSION || !existing?.assetVersions;
    const hasStyleReferenceMismatch =
      buildIllustrationStyleReferenceFingerprint(existing?.styleReferenceImage) !== requestedStyleReferenceFingerprint;
    if (
      existing &&
      (!existing.sourceHash || existing.sourceHash === sourceHash) &&
      !hasSvgAsset &&
      !hasMissingExplanation &&
      !isLegacyManifest &&
      !hasStyleReferenceMismatch
    ) {
      return existing;
    }
  }

  const paragraphs = buildArticleStructure(articleContent);
  const totalCharacterCount = Math.max(1, countArticleCharacters(articleContent));
  const { normalizedImageCountPrompt, targetImageCount } = resolveIllustrationCountPreference({
    articleContent,
    imageCountPrompt,
    paragraphs,
    totalCharacterCount,
  });
  const dataHints = extractDataHints(paragraphs);
  const normalizedUserPrompt = cleanText(userPrompt);
  const styleReferenceParts = buildIllustrationStyleReferenceParts(normalizedStyleReferenceImage);
  const promptAssets = await readIllustrationPrompts(normalizedProfileId);
  const { system, guardrails, dataRules, profileStyle, negativePrompt } = promptAssets;

  let planPrompt = [
    `目标图数：${targetImageCount}`,
    `风格库：${normalizedProfileId}`,
    `文章标题：${resolvedTitle}`,
    `文章任务信息：${JSON.stringify(
      {
        audience: options.audience || '',
        genre: options.genre || '',
        style: options.style || '',
        articleGoal: options.articleGoal || '',
      },
      null,
      2
    )}`,
    '文章结构地图：',
    summarizeStructureForPrompt(paragraphs),
    '可视化候选数据段：',
    JSON.stringify(dataHints, null, 2),
    '请严格按目标图数规划整篇配图，不要少图或多图。',
  ].join('\n\n');

  if (normalizedUserPrompt) {
    planPrompt = `${planPrompt}\n\n用户补充的整组配图要求：\n${normalizedUserPrompt}\n\n请把这些要求落实到整组视觉系统、图位规划和每张图的画面重点里。`;
  }

  planPrompt = buildIllustrationPlanPrompt({
    targetImageCount,
    normalizedProfileId,
    resolvedTitle,
    options,
    paragraphs,
    dataHints,
    normalizedUserPrompt,
    normalizedImageCountPrompt,
    hasStyleReferenceImage: Boolean(normalizedStyleReferenceImage),
  });

  const rawPlan =
    shouldUseMockProvider() || !apiKey
      ? buildFallbackPlan({
          paragraphs,
          targetImageCount,
          profileId: normalizedProfileId,
          dataHints,
        })
      : await generateJson({
          apiKey,
          model: plannerModel || DEFAULT_PLANNER_MODEL,
          systemInstruction: `${system}\n\n${guardrails}\n\n${dataRules}\n\n风格补充：\n${profileStyle}`,
          prompt: planPrompt,
          schema: PLAN_SCHEMA,
          referenceParts: styleReferenceParts,
        });

  const finalizedTargetImageCount = clampSlotCount(Number(rawPlan?.planned_image_count) || targetImageCount);

  const normalizedPlan = normalizePlan({
    plan: rawPlan,
    paragraphs,
    targetImageCount: finalizedTargetImageCount,
    profileId: normalizedProfileId,
  });

  let manifest = normalizeIllustrationManifest({
    promptVersion: ILLUSTRATION_PROMPT_VERSION,
    sourceHash,
    articleHash,
    articleTitle: resolvedTitle,
    styleProfile: normalizedProfileId,
    model: imageModel || DEFAULT_IMAGE_MODEL,
    wordCount: totalCharacterCount,
    targetImageCount: finalizedTargetImageCount,
    globalUserPrompt: normalizedUserPrompt || undefined,
    imageCountPrompt: normalizedImageCountPrompt || undefined,
    styleReferenceImage: normalizedStyleReferenceImage,
    status: 'rendering',
    generatedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    visualSystem: {
      collectionTitle: `${resolvedTitle} 配图`,
      profileLabel: profile.label,
      visualDirection: normalizedPlan.visualSystem.visual_direction,
      palette: normalizedPlan.visualSystem.palette,
      realismLevel: normalizedPlan.visualSystem.realism_level,
      compositionRules: normalizedPlan.visualSystem.composition_rules,
      moodKeywords: buildFocusTerms(
        `${normalizedPlan.visualSystem.visual_direction} ${normalizedPlan.visualSystem.lighting} ${normalizedPlan.visualSystem.realism_level}`
      ),
      chartStyle: (normalizedPlan.visualSystem.chart_language || []).join('；'),
      consistencyRules: normalizedPlan.visualSystem.composition_rules.slice(0, 4),
      lighting: normalizedPlan.visualSystem.lighting,
      texture: (normalizedPlan.visualSystem.texture_rules || []).join('；'),
      negativeRules: normalizedPlan.visualSystem.forbidden_elements,
    },
    slots: [],
    assets: [],
    assetVersions: {},
    warnings: [],
  });

  const warnings = [];

  for (const slot of normalizedPlan.slots) {
    const slotSeed = createIllustrationSlotSeed({
      slot,
      negativePrompt,
      resolvedTitle,
      normalizedPlan,
      normalizedProfileId,
      targetImageCount: finalizedTargetImageCount,
      promptAssets,
      articleContent,
    });

    const rendered = await renderSlotVersion({
      apiKey,
      plannerModel,
      imageModel,
      sourceHash,
      targetDir,
      articleTitle: resolvedTitle,
      articleContent,
      slot: {
        ...slotSeed,
        assetVersions: [],
      },
      visualSystem: normalizedPlan.visualSystem,
      userPrompt: normalizedUserPrompt,
      styleReferenceImage: normalizedStyleReferenceImage,
    });

    warnings.push(...rendered.warnings);
    manifest = updateManifestSlotVersion(
      {
        ...manifest,
        slots: [...manifest.slots, rendered.slot],
        assetVersions: { ...manifest.assetVersions, [rendered.slot.id]: [] },
      },
      rendered.slot,
      rendered.asset
    );
  }

  const finalized = normalizeIllustrationManifest({
    ...manifest,
    status: 'ready',
    warnings: warnings.length > 0 ? warnings : undefined,
    updatedAt: new Date().toISOString(),
  });

  await writeManifest(manifestPath, finalized);
  return finalized;
};

export const generateArticleIllustrationsProgressive = async ({
  apiKey,
  plannerModel = DEFAULT_PLANNER_MODEL,
  imageModel = DEFAULT_IMAGE_MODEL,
  profileId,
  articleTitle,
  articleContent,
  options = {},
  userPrompt = '',
  imageCountPrompt = '',
  styleReferenceImage,
  force = false,
  onProgress,
  isCanceled,
  shouldPersistCancellation,
}) => {
  const {
    normalizedProfileId,
    resolvedTitle,
    sourceHash,
    articleHash,
    styleReferenceImage: normalizedStyleReferenceImage,
  } = resolveIllustrationRequestIdentity({
    profileId,
    articleTitle,
    articleContent,
    styleReferenceImage,
  });
  const profile = getStyleProfile(normalizedProfileId);
  const styleReferenceParts = buildIllustrationStyleReferenceParts(normalizedStyleReferenceImage);
  const targetDir = path.join(GENERATED_ROOT, sourceHash);
  const manifestPath = path.join(targetDir, 'manifest.json');
  const startedAt = new Date().toISOString();
  const paragraphs = buildArticleStructure(articleContent);
  const totalCharacterCount = Math.max(1, countArticleCharacters(articleContent));
  const { normalizedImageCountPrompt, targetImageCount } = resolveIllustrationCountPreference({
    articleContent,
    imageCountPrompt,
    paragraphs,
    totalCharacterCount,
  });
  const dataHints = extractDataHints(paragraphs);
  const normalizedUserPrompt = cleanText(userPrompt);
  const promptAssets = await readIllustrationPrompts(normalizedProfileId);
  const { system, guardrails, dataRules, profileStyle, negativePrompt } = promptAssets;
  let manifest = null;
  let cancellationPersisted = false;

  const persistCanceledManifest = async (currentStep = ILLUSTRATION_CANCELED_MESSAGE) => {
    if (cancellationPersisted && manifest) {
      return manifest;
    }

    const fallbackManifest =
      manifest ||
      normalizeIllustrationManifest({
        promptVersion: ILLUSTRATION_PROMPT_VERSION,
        sourceHash,
        articleHash,
        articleTitle: resolvedTitle,
        styleProfile: normalizedProfileId,
        model: imageModel || DEFAULT_IMAGE_MODEL,
        wordCount: totalCharacterCount,
        targetImageCount,
        globalUserPrompt: normalizedUserPrompt || undefined,
        imageCountPrompt: normalizedImageCountPrompt || undefined,
        styleReferenceImage: normalizedStyleReferenceImage,
        status: 'canceled',
        generatedAt: startedAt,
        updatedAt: startedAt,
        visualSystem: {
          collectionTitle: `${resolvedTitle} 配图`,
          profileLabel: profile.label,
          visualDirection: '',
          palette: [],
          realismLevel: '',
          compositionRules: [],
          moodKeywords: [],
          chartStyle: '',
          consistencyRules: [],
          lighting: '',
          texture: '',
          negativeRules: [],
        },
        slots: [],
        assets: [],
        assetVersions: {},
        warnings: [],
      });

    const nextManifest = buildCanceledIllustrationManifest(fallbackManifest, currentStep);
    await writeManifest(manifestPath, nextManifest);
    onProgress?.(nextManifest);
    manifest = nextManifest;
    cancellationPersisted = true;
    return nextManifest;
  };

  const abortIfCanceled = async (currentStep = ILLUSTRATION_CANCELED_MESSAGE) => {
    if (!isCanceled?.()) {
      return;
    }
    if (shouldPersistCancellation?.() !== false) {
      await persistCanceledManifest(currentStep);
    }
    throw createIllustrationTaskCanceledError(currentStep);
  };

  const publish = async (nextManifest) => {
    if (isCanceled?.()) {
      const currentStep = cleanText(nextManifest?.progress?.currentStep) || ILLUSTRATION_CANCELED_MESSAGE;
      if (shouldPersistCancellation?.() !== false) {
        await persistCanceledManifest(currentStep);
      }
      throw createIllustrationTaskCanceledError(currentStep);
    }
    const normalized = normalizeIllustrationManifest(nextManifest);
    await writeManifest(manifestPath, normalized);
    onProgress?.(normalized);
    manifest = normalized;
    return normalized;
  };

  await abortIfCanceled();
  manifest = await publish({
    promptVersion: ILLUSTRATION_PROMPT_VERSION,
    sourceHash,
    articleHash,
    articleTitle: resolvedTitle,
    styleProfile: normalizedProfileId,
    model: imageModel || DEFAULT_IMAGE_MODEL,
    wordCount: totalCharacterCount,
    targetImageCount,
    globalUserPrompt: normalizedUserPrompt || undefined,
    imageCountPrompt: normalizedImageCountPrompt || undefined,
    styleReferenceImage: normalizedStyleReferenceImage,
    status: 'planning',
    generatedAt: startedAt,
    updatedAt: startedAt,
    visualSystem: {
      collectionTitle: `${resolvedTitle} 配图`,
      profileLabel: profile.label,
      visualDirection: '',
      palette: [],
      realismLevel: '',
      compositionRules: [],
      moodKeywords: [],
      chartStyle: '',
      consistencyRules: [],
      lighting: '',
      texture: '',
      negativeRules: [],
    },
    slots: [],
    assets: [],
    assetVersions: {},
    progress: buildIllustrationProgress({
      phase: 'planning',
      activity: 'planning',
      currentStep: '正在分析全文并规划图位',
      completedCount: 0,
      totalCount: targetImageCount,
      startedAt,
    }),
    warnings: [],
  });

  try {
    await abortIfCanceled('正在分析全文并规划图位');
    let planPrompt = [
      `目标图数：${targetImageCount}`,
      `风格库：${normalizedProfileId}`,
      `文章标题：${resolvedTitle}`,
      `文章任务信息：${JSON.stringify(
        {
          audience: options.audience || '',
          genre: options.genre || '',
          style: options.style || '',
          articleGoal: options.articleGoal || '',
        },
        null,
        2
      )}`,
      '文章结构地图：',
      summarizeStructureForPrompt(paragraphs),
      '可视化候选数据段：',
      JSON.stringify(dataHints, null, 2),
      '请严格按目标图数规划整篇配图，不要少图或多图。',
    ].join('\n\n');

    if (normalizedUserPrompt) {
      planPrompt = `${planPrompt}\n\n用户补充的整组配图要求：\n${normalizedUserPrompt}\n\n请把这些要求落实到整组视觉系统、图位规划和每张图的画面重点里。`;
    }

    planPrompt = buildIllustrationPlanPrompt({
      targetImageCount,
      normalizedProfileId,
      resolvedTitle,
      options,
      paragraphs,
      dataHints,
      normalizedUserPrompt,
      normalizedImageCountPrompt,
      hasStyleReferenceImage: Boolean(normalizedStyleReferenceImage),
    });

    const rawPlan =
      shouldUseMockProvider() || !apiKey
        ? buildFallbackPlan({
            paragraphs,
            targetImageCount,
            profileId: normalizedProfileId,
            dataHints,
          })
        : await generateJson({
            apiKey,
            model: plannerModel || DEFAULT_PLANNER_MODEL,
            systemInstruction: `${system}\n\n${guardrails}\n\n${dataRules}\n\n风格补充：\n${profileStyle}`,
            prompt: planPrompt,
            schema: PLAN_SCHEMA,
            referenceParts: styleReferenceParts,
          });

    await abortIfCanceled('图位规划完成，正在整理生成队列');
    const finalizedTargetImageCount = clampSlotCount(Number(rawPlan?.planned_image_count) || targetImageCount);
    const normalizedPlan = normalizePlan({
      plan: rawPlan,
      paragraphs,
      targetImageCount: finalizedTargetImageCount,
      profileId: normalizedProfileId,
    });

    const seededSlots = normalizedPlan.slots.map((slot) =>
      createIllustrationSlotSeed({
        slot,
        negativePrompt,
        resolvedTitle,
        normalizedPlan,
        normalizedProfileId,
        targetImageCount: finalizedTargetImageCount,
        promptAssets,
        articleContent,
      })
    );

    manifest = await publish({
      ...manifest,
      targetImageCount: seededSlots.length,
      status: 'rendering',
      visualSystem: {
        collectionTitle: `${resolvedTitle} 配图`,
        profileLabel: profile.label,
        visualDirection: normalizedPlan.visualSystem.visual_direction,
        palette: normalizedPlan.visualSystem.palette,
        realismLevel: normalizedPlan.visualSystem.realism_level,
        compositionRules: normalizedPlan.visualSystem.composition_rules,
        moodKeywords: buildFocusTerms(
          `${normalizedPlan.visualSystem.visual_direction} ${normalizedPlan.visualSystem.lighting} ${normalizedPlan.visualSystem.realism_level}`
        ),
        chartStyle: (normalizedPlan.visualSystem.chart_language || []).join(' / '),
        consistencyRules: normalizedPlan.visualSystem.composition_rules.slice(0, 4),
        lighting: normalizedPlan.visualSystem.lighting,
        texture: (normalizedPlan.visualSystem.texture_rules || []).join(' / '),
        negativeRules: normalizedPlan.visualSystem.forbidden_elements,
      },
      slots: seededSlots.map((slot, slotIndex) =>
        slotIndex === 0
          ? {
              ...slot,
              status: 'rendering',
              error: undefined,
            }
          : slot
      ),
      assetVersions: seededSlots.reduce((acc, slot) => {
        acc[slot.id] = [];
        return acc;
      }, {}),
      progress: buildIllustrationProgress({
        phase: 'rendering',
        activity: 'rendering_image',
        currentStep: `正在生成第 1/${seededSlots.length} 张图：${seededSlots[0]?.sectionTitle || seededSlots[0]?.title || '未命名图位'}`,
        completedCount: 0,
        totalCount: seededSlots.length,
        currentItemIndex: seededSlots.length > 0 ? 1 : undefined,
        currentSlotId: seededSlots[0]?.id,
        currentSlotOrder: seededSlots[0]?.order,
        currentSlotTitle: seededSlots[0]?.sectionTitle || seededSlots[0]?.title,
        startedAt,
      }),
    });

    const warnings = [];

    for (let index = 0; index < seededSlots.length; index += 1) {
      const slotSeed = seededSlots[index];
      const rendered = await renderSlotVersion({
        apiKey,
        plannerModel,
        imageModel,
        sourceHash,
        targetDir,
        articleTitle: resolvedTitle,
        articleContent,
        slot: {
          ...slotSeed,
          assetVersions: toAssetArray(manifest.assetVersions?.[slotSeed.id]),
        },
        visualSystem: normalizedPlan.visualSystem,
        userPrompt: normalizedUserPrompt,
        styleReferenceImage: normalizedStyleReferenceImage,
        abortIfCanceled,
        onImageSaved: async ({ slot: interimSlot, asset: interimAsset }) => {
          const interimVersions = {
            ...manifest.assetVersions,
            [interimSlot.id]: [interimAsset],
          };
          const captionStep = `第 ${index + 1}/${seededSlots.length} 张图已出，正在补图释`;
          await abortIfCanceled(captionStep);
          manifest = await publish({
            ...manifest,
            slots: manifest.slots.map((slot) =>
              slot.id === interimSlot.id
                ? syncSlotWithActiveAsset(
                    {
                      ...slot,
                      ...interimSlot,
                      activeAssetId: interimAsset.id,
                    },
                    interimVersions[interimSlot.id]
                  )
                : slot
            ),
            assetVersions: interimVersions,
            progress: buildIllustrationProgress({
              phase: 'rendering',
              activity: 'captioning',
              currentStep: captionStep,
              completedCount: index,
              totalCount: seededSlots.length,
              currentItemIndex: index + 1,
              currentSlotId: interimSlot.id,
              currentSlotOrder: interimSlot.order,
              currentSlotTitle: interimSlot.sectionTitle || interimSlot.title,
              startedAt,
            }),
          });
        },
      });

      warnings.push(...rendered.warnings);
      manifest = updateManifestSlotVersion(manifest, rendered.slot, rendered.asset);
      if (index === seededSlots.length - 1) {
        const finalizingStep = `第 ${index + 1}/${seededSlots.length} 张图与图释已完成，正在整理最终结果`;
        await abortIfCanceled(finalizingStep);
        manifest = await publish({
          ...manifest,
          status: 'partial',
          warnings: warnings.length > 0 ? warnings : undefined,
          progress: buildIllustrationProgress({
            phase: 'finalizing',
            activity: 'finalizing',
            currentStep: finalizingStep,
            completedCount: index + 1,
            totalCount: seededSlots.length,
            currentItemIndex: index + 1,
            currentSlotId: slotSeed.id,
            currentSlotOrder: slotSeed.order,
            currentSlotTitle: slotSeed.sectionTitle || slotSeed.title,
            startedAt,
          }),
        });
        continue;
      }

      const nextSlotSeed = seededSlots[index + 1];
      const nextRenderingStep = `正在生成第 ${index + 2}/${seededSlots.length} 张图：${nextSlotSeed.sectionTitle || nextSlotSeed.title}`;
      await abortIfCanceled(nextRenderingStep);
      manifest = await publish({
        ...manifest,
        status: 'rendering',
        warnings: warnings.length > 0 ? warnings : undefined,
        slots: manifest.slots.map((slot) =>
          slot.id === nextSlotSeed.id
            ? {
                ...slot,
                status: 'rendering',
                error: undefined,
              }
            : slot
        ),
        progress: buildIllustrationProgress({
          phase: 'rendering',
          activity: 'rendering_image',
          currentStep: nextRenderingStep,
          completedCount: index + 1,
          totalCount: seededSlots.length,
          currentItemIndex: index + 2,
          currentSlotId: nextSlotSeed.id,
          currentSlotOrder: nextSlotSeed.order,
          currentSlotTitle: nextSlotSeed.sectionTitle || nextSlotSeed.title,
          startedAt,
        }),
      });
    }

    await abortIfCanceled('正在整理最后的图释和版本信息');
    manifest = await publish({
      ...manifest,
      status: 'ready',
      warnings: manifest.warnings,
      progress: buildIllustrationProgress({
        phase: 'ready',
        activity: 'ready',
        currentStep: `全部 ${seededSlots.length} 张图已生成完成`,
        completedCount: seededSlots.length,
        totalCount: seededSlots.length,
        currentItemIndex: seededSlots.length,
        startedAt,
      }),
    });

    return manifest;
  } catch (error) {
    if (isIllustrationTaskCanceledError(error)) {
      if (!cancellationPersisted && shouldPersistCancellation?.() !== false) {
        manifest = await persistCanceledManifest(error.message);
      }
      throw error;
    }

    manifest = await publish({
      ...manifest,
      status: 'error',
      error: error instanceof Error ? error.message : String(error),
      progress: buildIllustrationProgress({
        phase: 'error',
        activity: 'error',
        currentStep: error instanceof Error ? error.message : String(error),
        completedCount: manifest?.assets?.length || 0,
        totalCount: manifest?.targetImageCount || targetImageCount,
        startedAt,
      }),
    });
    throw new Error(manifest.error || '配图生成失败。');
  }
};
const loadManifestBySourceHash = async (sourceHash) => {
  const manifestPath = path.join(GENERATED_ROOT, sourceHash, 'manifest.json');
  const manifest = getCachedIllustrationBundle(sourceHash);
  if (!manifest) {
    throw new Error('未找到这篇文章的配图记录。');
  }
  return { manifestPath, manifest };
};

export const getIllustrationManifestBySourceHash = async (sourceHash) => {
  return getCachedIllustrationBundle(sourceHash);
};
export const markIllustrationManifestCanceled = async ({
  sourceHash,
  currentStep = ILLUSTRATION_CANCELED_MESSAGE,
}) => {
  const manifestPath = path.join(GENERATED_ROOT, sourceHash, 'manifest.json');
  const existing = getCachedIllustrationBundle(sourceHash);
  if (!existing) {
    return null;
  }
  const nextManifest = buildCanceledIllustrationManifest(existing, currentStep);
  await writeManifest(manifestPath, nextManifest);
  return nextManifest;
};

const resolveIllustrationManifestInput = async ({ sourceHash, bundle }) => {
  if (bundle && typeof bundle === 'object') {
    const normalized = normalizeIllustrationManifest({
      ...bundle,
      sourceHash: cleanText(bundle.sourceHash || sourceHash),
    });
    return {
      manifestPath: path.join(GENERATED_ROOT, normalized.sourceHash, 'manifest.json'),
      manifest: normalized,
    };
  }

  return loadManifestBySourceHash(sourceHash);
};


export const regenerateIllustrationSlot = async ({
  apiKey,
  sourceHash,
  slotId,
  plannerModel = DEFAULT_PLANNER_MODEL,
  imageModel = DEFAULT_IMAGE_MODEL,
  articleContent = '',
  userPrompt = '',
  bundle = null,
}) => {
  const { manifestPath, manifest } = await resolveIllustrationManifestInput({ sourceHash, bundle });
  const slot = manifest.slots.find((item) => item.id === slotId);
  if (!slot) {
    throw new Error('未找到对应的图位。');
  }

  const rendered = await renderSlotVersion({
    apiKey,
    plannerModel,
    imageModel,
    articleTitle: manifest.articleTitle,
    articleContent,
    slot: {
      ...slot,
      assetVersions: toAssetArray(manifest.assetVersions?.[slot.id]),
    },
    visualSystem: {
      visual_direction: manifest.visualSystem.visualDirection,
      realism_level: manifest.visualSystem.realismLevel,
      palette: manifest.visualSystem.palette,
      lighting: manifest.visualSystem.lighting,
      composition_rules: manifest.visualSystem.compositionRules,
      texture_rules: String(manifest.visualSystem.texture || '')
        .split(/[；;/]+/)
        .map((item) => cleanText(item))
        .filter(Boolean),
      chart_language: String(manifest.visualSystem.chartStyle || '')
        .split(/[；;/]+/)
        .map((item) => cleanText(item))
        .filter(Boolean),
      forbidden_elements: Array.isArray(manifest.visualSystem.negativeRules) ? manifest.visualSystem.negativeRules : [],
    },
    userPrompt,
    styleReferenceImage: manifest.styleReferenceImage,
  });

  const nextManifest = normalizeIllustrationManifest({
    ...updateManifestSlotVersion(manifest, rendered.slot, rendered.asset),
    warnings: [...(manifest.warnings || []), ...rendered.warnings],
    updatedAt: new Date().toISOString(),
  });
  await writeManifest(manifestPath, nextManifest);
  return nextManifest;
};

export const regenerateIllustrationCaption = async ({
  apiKey,
  sourceHash,
  slotId,
  plannerModel = DEFAULT_PLANNER_MODEL,
  articleContent = '',
  userPrompt = '',
  bundle = null,
}) => {
  const { manifestPath, manifest } = await resolveIllustrationManifestInput({ sourceHash, bundle });
  const slot = manifest.slots.find((item) => item.id === slotId);
  if (!slot) {
    throw new Error('未找到对应的图位。');
  }

  const versions = toAssetArray(manifest.assetVersions?.[slot.id]);
  if (versions.length === 0) {
    throw new Error('当前图位还没有可修改图释的图片。');
  }

  const activeAsset = versions.find((asset) => asset.id === slot.activeAssetId) || versions[versions.length - 1];
  const { imageBuffer, imageMimeType } = await loadIllustrationCaptionImageInput({
    assetUrl: activeAsset.url,
    mimeType: activeAsset.mimeType,
    sourceHash: manifest.sourceHash || sourceHash,
  });
  const explanation = await generateIllustrationExplanation({
    apiKey,
    plannerModel,
    articleTitle: manifest.articleTitle,
    articleContent,
    slot,
    userPrompt,
    existingExplanation: cleanText(activeAsset.editorCaption || slot.explanation || slot.purpose),
    imageBuffer,
    imageMimeType,
  });

  const nextManifest = normalizeIllustrationManifest({
    ...manifest,
    assetVersions: {
      ...manifest.assetVersions,
      [slot.id]: versions.map((asset) =>
        asset.id === activeAsset.id
          ? {
              ...asset,
              editorCaption: explanation,
            }
          : asset
      ),
    },
    slots: manifest.slots.map((item) =>
      item.id === slot.id
        ? {
            ...item,
            explanation,
          }
        : item
    ),
    updatedAt: new Date().toISOString(),
  });

  await writeManifest(manifestPath, nextManifest);
  return nextManifest;
};
export const deleteIllustrationSlotImage = async ({ sourceHash, slotId }) => {
  const { manifestPath, manifest } = await loadManifestBySourceHash(sourceHash);
  const slot = manifest.slots.find((item) => item.id === slotId);
  if (!slot) {
    throw new Error('未找到对应的图位。');
  }

  const versions = toAssetArray(manifest.assetVersions?.[slot.id]);
  if (versions.length === 0) {
    return manifest;
  }

  const activeIndex = Math.max(
    0,
    versions.findIndex((asset) => asset.id === slot.activeAssetId)
  );
  const nextVersions = versions.filter((_, index) => index !== activeIndex);
  const nextActiveAsset = nextVersions[Math.max(0, activeIndex - 1)] || nextVersions[0] || null;

  const nextManifest = normalizeIllustrationManifest({
    ...manifest,
    assetVersions: {
      ...manifest.assetVersions,
      [slot.id]: nextVersions,
    },
    slots: manifest.slots.map((item) =>
      item.id === slot.id
        ? {
            ...item,
            activeAssetId: nextActiveAsset?.id,
            explanation: cleanText(nextActiveAsset?.editorCaption) || item.explanation,
          }
        : item
    ),
    updatedAt: new Date().toISOString(),
  });

  await writeManifest(manifestPath, nextManifest);
  return nextManifest;
};

export const switchIllustrationSlotVersion = async ({ sourceHash, slotId, direction }) => {
  const { manifestPath, manifest } = await loadManifestBySourceHash(sourceHash);
  const slot = manifest.slots.find((item) => item.id === slotId);
  if (!slot) {
    throw new Error('未找到对应的图位。');
  }

  const versions = toAssetArray(manifest.assetVersions?.[slot.id]);
  if (versions.length <= 1) {
    return manifest;
  }

  const currentIndex = Math.max(
    0,
    versions.findIndex((asset) => asset.id === slot.activeAssetId)
  );
  const nextIndex =
    direction === 'previous'
      ? Math.max(0, currentIndex - 1)
      : Math.min(versions.length - 1, currentIndex + 1);
  const nextActiveAsset = versions[nextIndex];

  const nextManifest = normalizeIllustrationManifest({
    ...manifest,
    slots: manifest.slots.map((item) =>
      item.id === slot.id
        ? {
            ...item,
            activeAssetId: nextActiveAsset.id,
            explanation: cleanText(nextActiveAsset.editorCaption) || item.explanation,
          }
        : item
    ),
    updatedAt: new Date().toISOString(),
  });

  await writeManifest(manifestPath, nextManifest);
  return nextManifest;
};

export const getIllustrationManifestPath = (sourceHash) => path.join(GENERATED_ROOT, sourceHash, 'manifest.json');

export const getIllustrationStaticRoot = () => GENERATED_ROOT;
