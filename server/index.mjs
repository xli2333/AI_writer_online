import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { URL } from 'node:url';
import { DEFAULT_STYLE_PROFILE_ID, getPublicStyleProfiles, getStyleProfile, resolveStyleProfileId } from '../config/styleProfiles.js';
import {
  deleteIllustrationSlotImage,
  generateArticleIllustrationsProgressive,
  getIllustrationManifestBySourceHash,
  ILLUSTRATION_CANCELED_MESSAGE,
  isIllustrationTaskCanceledError,
  markIllustrationManifestCanceled,
  regenerateIllustrationCaption,
  regenerateIllustrationSlot,
  resolveIllustrationCountPreference,
  resolveIllustrationRequestIdentity,
  switchIllustrationSlotVersion,
} from './articleIllustrationService.mjs';
import {
  generateWechatDraftPreview,
  getWechatOfficialDraft,
  getWechatOfficialPublishStatus,
  getWechatPublisherConfig,
  submitWechatOfficialPublish,
  upsertWechatOfficialDraft,
} from './wechatOfficialPublisherService.mjs';

const ROOT_DIR = process.cwd();
const COMMON_PROMPT_ROOT = path.join(ROOT_DIR, 'rag_assets', 'global');
const DIST_DIR = path.join(ROOT_DIR, 'dist');
const GENERATED_ASSET_ROOT = path.join(ROOT_DIR, 'generated_assets');
const HOST = process.env.BACKEND_HOST || '127.0.0.1';
const PORT = Number(process.env.BACKEND_PORT || 8787);

const COMMON_PROMPT_ASSET_MAP = {
  coreWritingSkills: path.join(COMMON_PROMPT_ROOT, 'core_writing_skills.md'),
  universalPrompt: path.join(COMMON_PROMPT_ROOT, 'universal_prompt.md'),
  antiAiStyleRules: path.join(COMMON_PROMPT_ROOT, 'runtime', 'anti_ai_style_rules.md'),
  commercialHumanizerRules: path.join(COMMON_PROMPT_ROOT, 'runtime', 'commercial_humanizer_rules.md'),
  commercialHumanizerPatterns: path.join(COMMON_PROMPT_ROOT, 'runtime', 'commercial_humanizer_patterns.md'),
  commercialHumanizerQuickChecks: path.join(COMMON_PROMPT_ROOT, 'runtime', 'commercial_humanizer_quick_checks.md'),
};

const LATEPOST_SUB_PERSONAS = [
  {
    id: 'latepostNewsPersona',
    label: '快讯与组织变动',
    description: '适合独家信息、组织调整、业务变化和关键事件报道。',
  },
  {
    id: 'latepostFeaturePersona',
    label: '公司深描',
    description: '适合公司观察、业务拆解和组织机制型长文。',
  },
  {
    id: 'latepostProfilePersona',
    label: '人物与公司',
    description: '适合人物切口、管理者判断与人物-组织绑定稿。',
  },
  {
    id: 'latepostIndustryReviewPersona',
    label: '行业复盘',
    description: '适合趋势评论、行业终局判断与赛道格局稿。',
  },
];

const XINZHIYUAN_SUB_PERSONAS = [
  {
    id: 'xinzhiyuanBreakingPersona',
    label: '快讯与前沿动态',
    description: '适合模型发布、行业热点、组织动作与高时效 AI 快讯。',
  },
  {
    id: 'xinzhiyuanPaperPersona',
    label: '论文与基准拆解',
    description: '适合论文解读、实验结果、技术路线与 benchmark 对比稿。',
  },
  {
    id: 'xinzhiyuanProductPersona',
    label: '产品与工具实测',
    description: '适合模型体验、Agent 工具、产品发布与上手评测稿。',
  },
  {
    id: 'xinzhiyuanPeoplePersona',
    label: '人物与团队观察',
    description: '适合研究者、创业团队、实验室与关键人物稿。',
  },
];

const HUXIU_SUB_PERSONAS = [
  {
    id: 'huxiuIndustryPersona',
    label: '科技与产业攻防',
    description: '适合平台竞争、大厂战略、AI 与产业链攻防类写作。',
  },
  {
    id: 'huxiuConsumerPersona',
    label: '商业消费拆解',
    description: '适合品牌、零售、门店、渠道与消费公司分析稿。',
  },
  {
    id: 'huxiuProfilePersona',
    label: '人物与公司深描',
    description: '适合创始人、管理者、公司内幕和人物驱动稿。',
  },
  {
    id: 'huxiuSocietyPersona',
    label: '社会情绪观察',
    description: '适合职场、城市、代际、青年文化与情绪观察稿。',
  },
];

const WALLSTREETCN_SUB_PERSONAS = [
  {
    id: 'wallstreetcnMacroPersona',
    label: '宏观与政策传导',
    description: '适合央行、通胀、财政、关税、增长与地缘冲击的宏观解读稿。',
  },
  {
    id: 'wallstreetcnMarketsPersona',
    label: '市场与资产定价',
    description: '适合股债汇商品加密等跨资产波动、交易逻辑和市场定价稿。',
  },
  {
    id: 'wallstreetcnCompanyPersona',
    label: '公司与资本故事',
    description: '适合财报、并购、行业龙头、资本开支与公司竞争格局稿。',
  },
  {
    id: 'wallstreetcnStrategyPersona',
    label: '策略与交易前瞻',
    description: '适合机构观点、情景推演、周度日程和交易手册型写作。',
  },
];

const resolveProfilePaths = (profileId) => {
  const profile = getStyleProfile(profileId);
  const ragDir = path.resolve(ROOT_DIR, profile.ragDir);
  return {
    profileId: profile.id,
    profile,
    rawDir: path.resolve(ROOT_DIR, profile.rawDir),
    ragDir,
    metadataDir: path.resolve(ROOT_DIR, profile.metadataDir),
    runtimeDir: path.resolve(ROOT_DIR, profile.runtimeDir),
  };
};

const buildPromptAssetMap = (profileId) => {
  const paths = resolveProfilePaths(profileId);
  const assetMap = {
    ...COMMON_PROMPT_ASSET_MAP,
    workflow: path.join(paths.ragDir, 'workflows', 'ai_writing_workflow.md'),
    taskBriefTemplate: path.join(paths.ragDir, 'workflows', 'task_brief_template.md'),
    masterPersona: path.join(paths.runtimeDir, 'master_persona.md'),
    profileAntiPatterns: path.join(paths.runtimeDir, 'anti_patterns.md'),
  };

  if (profileId === 'latepost') {
    assetMap.latepostNewsPersona = path.join(paths.runtimeDir, 'subpersonas', 'news.md');
    assetMap.latepostFeaturePersona = path.join(paths.runtimeDir, 'subpersonas', 'feature.md');
    assetMap.latepostProfilePersona = path.join(paths.runtimeDir, 'subpersonas', 'profile.md');
    assetMap.latepostIndustryReviewPersona = path.join(paths.runtimeDir, 'subpersonas', 'industry_review.md');
  } else if (profileId === 'xinzhiyuan') {
    assetMap.xinzhiyuanBreakingPersona = path.join(paths.runtimeDir, 'subpersonas', 'breaking.md');
    assetMap.xinzhiyuanPaperPersona = path.join(paths.runtimeDir, 'subpersonas', 'paper.md');
    assetMap.xinzhiyuanProductPersona = path.join(paths.runtimeDir, 'subpersonas', 'product.md');
    assetMap.xinzhiyuanPeoplePersona = path.join(paths.runtimeDir, 'subpersonas', 'people.md');
  } else if (profileId === 'huxiu') {
    assetMap.huxiuIndustryPersona = path.join(paths.runtimeDir, 'subpersonas', 'industry.md');
    assetMap.huxiuConsumerPersona = path.join(paths.runtimeDir, 'subpersonas', 'consumer.md');
    assetMap.huxiuProfilePersona = path.join(paths.runtimeDir, 'subpersonas', 'profile.md');
    assetMap.huxiuSocietyPersona = path.join(paths.runtimeDir, 'subpersonas', 'society.md');
  } else if (profileId === 'wallstreetcn') {
    assetMap.wallstreetcnMacroPersona = path.join(paths.runtimeDir, 'subpersonas', 'macro.md');
    assetMap.wallstreetcnMarketsPersona = path.join(paths.runtimeDir, 'subpersonas', 'markets.md');
    assetMap.wallstreetcnCompanyPersona = path.join(paths.runtimeDir, 'subpersonas', 'company.md');
    assetMap.wallstreetcnStrategyPersona = path.join(paths.runtimeDir, 'subpersonas', 'strategy.md');
  }

  return assetMap;
};

const CONTENT_TYPE_MAP = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
};

const sendJson = (response, statusCode, payload) => {
  response.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Cache-Control': 'no-store',
  });
  response.end(`${JSON.stringify(payload)}\n`);
};

const sendNoContent = (response) => {
  response.writeHead(204, {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  });
  response.end();
};

const readUtf8 = async (filePath) => {
  const text = await fs.readFile(filePath, 'utf8');
  return text.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').trim();
};

const parseJsonBody = async (request) => {
  const chunks = [];
  for await (const chunk of request) {
    chunks.push(chunk);
  }

  if (chunks.length === 0) {
    return {};
  }

  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
};

const readJsonIfExists = async (filePath, fallback = null) => {
  try {
    const raw = await readUtf8(filePath);
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
};

const countMeaningfulLines = (markdown) =>
  String(markdown || '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#') && !/^[-*]\s*$/.test(line)).length;

const listMarkdownFiles = async (dirPath) => {
  try {
    const entries = await fs.readdir(dirPath, { withFileTypes: true });
    return entries.filter((entry) => entry.isFile() && entry.name.endsWith('.md')).map((entry) => entry.name).sort();
  } catch {
    return [];
  }
};

const loadPromptAssets = async (profileId, names) => {
  const assetMap = buildPromptAssetMap(profileId);
  const keys = Array.isArray(names) && names.length > 0 ? names : Object.keys(assetMap);
  const output = {};

  await Promise.all(
    keys.map(async (name) => {
      const targetPath = assetMap[name];
      if (!targetPath) {
        throw new Error(`Unknown prompt asset: ${name}`);
      }
      output[name] = await readUtf8(targetPath);
    })
  );

  return output;
};

const buildPersonaVersionLabel = (profileId, updatedAt) => {
  if (!updatedAt) {
    return `${profileId}-bootstrap`;
  }
  const compact = String(updatedAt).replace(/[-:TZ.]/g, '').slice(0, 12);
  return `${profileId}-${compact || 'bootstrap'}`;
};

const toTimestamp = (value) => {
  if (!value) {
    return 0;
  }
  const timestamp = new Date(value).getTime();
  return Number.isNaN(timestamp) ? 0 : timestamp;
};

const pickLatestIso = (...values) => {
  let latestValue = '';
  let latestTime = 0;
  for (const value of values) {
    const time = toTimestamp(value);
    if (time > latestTime) {
      latestTime = time;
      latestValue = value;
    }
  }
  return latestValue;
};

const loadPersonaStatus = async (profileId) => {
  const paths = resolveProfilePaths(profileId);
  const { runtimeDir, profile } = paths;
  const evalDir = path.resolve(ROOT_DIR, profile.evalDir);
  const personaDir = path.resolve(ROOT_DIR, profile.personaDir);
  const evalReport = await readJsonIfExists(path.join(evalDir, 'reports', 'latest.json'), {});
  const sourceMeta = await readJsonIfExists(path.join(runtimeDir, 'master_persona.sources.json'), {});
  const patchLedgerRaw = await fs
    .readFile(path.join(personaDir, 'persona_patches.jsonl'), 'utf8')
    .then((value) => value.replace(/^\uFEFF/, ''))
    .catch(() => '');
  const patchLines = patchLedgerRaw
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  const lastPatch = patchLines.length ? JSON.parse(patchLines[patchLines.length - 1]) : {};
  const benchmarkFiles = await listMarkdownFiles(path.join(evalDir, 'benchmark_tasks'));
  const antiPatternsText = await readUtf8(path.join(runtimeDir, 'anti_patterns.md')).catch(() => '');
  const subPersonas =
    profile.id === 'latepost'
      ? LATEPOST_SUB_PERSONAS
      : profile.id === 'xinzhiyuan'
        ? XINZHIYUAN_SUB_PERSONAS
        : profile.id === 'huxiu'
          ? HUXIU_SUB_PERSONAS
          : profile.id === 'wallstreetcn'
            ? WALLSTREETCN_SUB_PERSONAS
          : [];
  const personaFileStat = await fs.stat(path.join(runtimeDir, 'master_persona.md')).catch(() => null);
  const personaFileUpdatedAt = personaFileStat?.mtime ? new Date(personaFileStat.mtime).toISOString() : '';
  const personaUpdatedAt = pickLatestIso(
    String(sourceMeta.updated_at || ''),
    String(lastPatch.applied_at || ''),
    personaFileUpdatedAt
  );

  return {
    profileId: profile.id,
    versionLabel: buildPersonaVersionLabel(profile.id, personaUpdatedAt),
    personaUpdatedAt: personaUpdatedAt || undefined,
    personaSourceCount: Number(sourceMeta.source_count || 0),
    lastEvolutionAt: String(evalReport.evaluated_at || '') || undefined,
    lastPatchAppliedAt: String(lastPatch.applied_at || '') || undefined,
    lastPatchWinRate:
      typeof evalReport.patch_win_rate === 'number'
        ? Number(evalReport.patch_win_rate)
        : typeof lastPatch.patch_win_rate === 'number'
          ? Number(lastPatch.patch_win_rate)
          : undefined,
    lastEvolutionPassed:
      typeof evalReport.pass === 'boolean' ? evalReport.pass : undefined,
    benchmarkTaskCount: benchmarkFiles.length,
    antiPatternCount: countMeaningfulLines(antiPatternsText),
    subPersonas,
  };
};

const parseArticleCatalog = async (profileId) => {
  const { metadataDir } = resolveProfilePaths(profileId);
  const raw = await readUtf8(path.join(metadataDir, 'article_tags.jsonl'));
  return raw
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));
};

const sanitizeRelativePath = (profileId, relativePath) => {
  const { rawDir } = resolveProfilePaths(profileId);
  const normalized = String(relativePath || '').replace(/\\/g, '/').replace(/^\/+/, '');
  if (!normalized || normalized.includes('..')) {
    throw new Error(`Invalid relative path: ${relativePath}`);
  }

  const absolutePath = path.resolve(rawDir, normalized);
  const rawRoot = path.resolve(rawDir);
  if (!absolutePath.startsWith(rawRoot)) {
    throw new Error(`Path escapes raw root: ${relativePath}`);
  }

  return { normalized, absolutePath };
};

const loadReferenceFullTexts = async (profileId, relativePaths) => {
  const uniquePaths = [...new Set((Array.isArray(relativePaths) ? relativePaths : []).map((item) => String(item || '').trim()).filter(Boolean))];
  const articles = await Promise.all(
    uniquePaths.map(async (relativePath) => {
      const { normalized, absolutePath } = sanitizeRelativePath(profileId, relativePath);
      let fullText = '';
      try {
        fullText = await readUtf8(absolutePath);
      } catch {
        fullText = '';
      }

      return {
        relativePath: normalized,
        fullText,
      };
    })
  );

  return articles;
};

const fileExists = async (filePath) => {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
};

const sendStaticFile = async (response, filePath) => {
  const extension = path.extname(filePath).toLowerCase();
  const contentType = CONTENT_TYPE_MAP[extension] || 'application/octet-stream';
  const payload = await fs.readFile(filePath);
  response.writeHead(200, {
    'Content-Type': contentType,
    'Cache-Control': extension === '.html' ? 'no-store' : 'public, max-age=31536000, immutable',
  });
  response.end(payload);
};

const tryServeFrontend = async (urlPath, response) => {
  const normalizedPath = urlPath === '/' ? '/index.html' : urlPath;
  const cleaned = normalizedPath.replace(/^\/+/, '');
  if (cleaned.includes('..')) {
    return false;
  }

  const candidatePath = path.resolve(DIST_DIR, cleaned);
  if (!candidatePath.startsWith(path.resolve(DIST_DIR))) {
    return false;
  }

  if (await fileExists(candidatePath)) {
    await sendStaticFile(response, candidatePath);
    return true;
  }

  const indexPath = path.join(DIST_DIR, 'index.html');
  if (await fileExists(indexPath)) {
    await sendStaticFile(response, indexPath);
    return true;
  }

  return false;
};

const tryServeGeneratedAsset = async (urlPath, response) => {
  if (!urlPath.startsWith('/generated-assets/')) {
    return false;
  }

  const cleaned = decodeURIComponent(urlPath.replace(/^\/generated-assets\/+/, ''));
  if (!cleaned || cleaned.includes('..')) {
    return false;
  }

  const candidatePath = path.resolve(GENERATED_ASSET_ROOT, cleaned);
  const generatedRoot = path.resolve(GENERATED_ASSET_ROOT);
  if (!candidatePath.startsWith(generatedRoot)) {
    return false;
  }

  if (await fileExists(candidatePath)) {
    await sendStaticFile(response, candidatePath);
    return true;
  }

  return false;
};

const mapIllustrationRole = (role, outputKind, order) => {
  if (outputKind === 'data') return 'data_chart';
  const normalized = String(role || '').toLowerCase();
  if (order === 1 || normalized.includes('首图') || normalized.includes('hero')) return 'hero';
  if (normalized.includes('论点')) return 'core_argument';
  if (normalized.includes('人物')) return 'person';
  if (normalized.includes('组织')) return 'organization';
  if (normalized.includes('行业')) return 'industry_context';
  if (normalized.includes('机制') || normalized.includes('过程')) return 'process_mechanism';
  if (normalized.includes('结果') || normalized.includes('后果')) return 'outcome';
  return 'key_case';
};

const toIllustrationBundle = (manifest) => {
  if (manifest?.promptVersion && Array.isArray(manifest?.assets)) {
    return manifest;
  }

  const slots = Array.isArray(manifest?.slots) ? manifest.slots : [];
  const visualSystem = manifest?.visualSystem || {};

  return {
    promptVersion: 'article-illustrations-v1',
    articleHash: String(manifest?.sourceHash || ''),
    styleProfile: String(manifest?.profileId || DEFAULT_STYLE_PROFILE_ID),
    model: String(manifest?.imageModel || ''),
    wordCount: Number(manifest?.totalCharacterCount || 0),
    targetImageCount: Number(manifest?.targetImageCount || slots.length || 0),
    imageCountPrompt: String(manifest?.imageCountPrompt || '') || undefined,
    generatedAt: String(manifest?.createdAt || '') || undefined,
    visualSystem: {
      profileLabel: String(manifest?.profileId || ''),
      visualDirection: String(visualSystem.visual_direction || ''),
      palette: Array.isArray(visualSystem.palette) ? visualSystem.palette.map((item) => String(item)) : [],
      realismLevel: String(visualSystem.realism_level || ''),
      compositionRules: Array.isArray(visualSystem.composition_rules)
        ? visualSystem.composition_rules.map((item) => String(item))
        : [],
      moodKeywords: Array.isArray(visualSystem.texture_rules) ? visualSystem.texture_rules.map((item) => String(item)) : [],
      chartStyle: Array.isArray(visualSystem.chart_language) ? visualSystem.chart_language.join('；') : '',
      consistencyRules: Array.isArray(visualSystem.composition_rules)
        ? visualSystem.composition_rules.map((item) => String(item))
        : [],
    },
    slots: slots.map((slot) => ({
      id: String(slot.id || ''),
      role: mapIllustrationRole(slot.role, slot.outputKind, Number(slot.order || 0)),
      renderMode: slot.outputKind === 'data' ? 'svg_chart' : 'nanobanana_pro',
      title: String(slot.role || ''),
      sectionTitle: String(slot.anchorHeading || '正文'),
      purpose: String(slot.rationale || ''),
      anchorExcerpt: String(slot.anchorExcerpt || ''),
      prompt: String(slot.prompt || ''),
      negativePrompt: '',
      anchorParagraphIndex: Number(slot.anchorParagraphIndex || 0),
      dataSpec:
        slot.outputKind === 'data'
          ? {
              chartType:
                String(slot.dataGraphicType || '').includes('line')
                  ? 'trend_line'
                  : String(slot.dataGraphicType || '').includes('time')
                    ? 'timeline'
                    : 'comparison_bar',
              title: String(slot.chartTitle || slot.role || ''),
              insight: String(slot.dataGraphicRationale || slot.rationale || ''),
              points: Array.isArray(slot.dataPoints)
                ? slot.dataPoints.map((point) => ({
                    label: String(point.label || point.time || ''),
                    value: typeof point.value === 'number' ? point.value : undefined,
                    unit: String(point.unit || ''),
                    note: String(point.note || ''),
                  }))
                : [],
            }
          : undefined,
    })),
    assets: slots.map((slot) => ({
      slotId: String(slot.id || ''),
      role: mapIllustrationRole(slot.role, slot.outputKind, Number(slot.order || 0)),
      renderMode: slot.outputKind === 'data' ? 'svg_chart' : 'nanobanana_pro',
      title: String(slot.role || ''),
      url: String(slot.outputUrl || ''),
      mimeType: String(slot.outputMimeType || ''),
      width: Number(slot.width || 0),
      height: Number(slot.height || 0),
    })),
    warnings: slots.some((slot) => slot.outputKind === 'data') ? ['数据图走精确渲染链路，优先保证数字关系正确。'] : [],
  };
};

const mapIllustrationJobStatusToBundleStatus = (status) => {
  const normalized = String(status || '').trim().toLowerCase();
  if (normalized === 'queued' || normalized === 'planning') return 'planning';
  if (normalized === 'rendering') return 'rendering';
  if (normalized === 'ready') return 'ready';
  if (normalized === 'partial') return 'partial';
  if (normalized === 'error') return 'error';
  if (normalized === 'canceled') return 'canceled';
  return undefined;
};

const overlayIllustrationBundleJobState = (bundle, job) => {
  if (!bundle || !job || !isIllustrationJobRunning(job)) {
    return bundle;
  }

  return {
    ...bundle,
    status: mapIllustrationJobStatusToBundleStatus(job.status) || bundle.status || 'planning',
    progress: {
      ...(bundle.progress || {}),
      phase: String(job.status || bundle.progress?.phase || 'queued'),
      currentStep: String(job.currentStep || bundle.progress?.currentStep || ''),
      completedCount: Number(job.completedCount || bundle.progress?.completedCount || 0),
      totalCount: Number(job.totalCount || bundle.progress?.totalCount || bundle.targetImageCount || 0),
      startedAt: String(job.startedAt || bundle.progress?.startedAt || bundle.generatedAt || '').trim() || undefined,
      updatedAt: String(job.updatedAt || bundle.progress?.updatedAt || new Date().toISOString()).trim() || undefined,
    },
  };
};

const illustrationJobs = new Map();
const illustrationRunStates = new Map();

const normalizeIllustrationJob = (jobLike, defaults = {}) => {
  const sourceHash = String(jobLike?.sourceHash || defaults.sourceHash || '').trim();
  return {
    sourceHash,
    runId: String(jobLike?.runId || defaults.runId || '').trim() || undefined,
    status: String(jobLike?.status || defaults.status || 'queued').trim(),
    currentStep: String(jobLike?.currentStep || defaults.currentStep || '').trim(),
    completedCount: Number(jobLike?.completedCount || defaults.completedCount || 0),
    totalCount: Number(jobLike?.totalCount || defaults.totalCount || 0),
    currentSlotId: String(jobLike?.currentSlotId || defaults.currentSlotId || '').trim() || undefined,
    currentSlotOrder:
      Number.isFinite(Number(jobLike?.currentSlotOrder))
        ? Number(jobLike.currentSlotOrder)
        : Number.isFinite(Number(defaults.currentSlotOrder))
          ? Number(defaults.currentSlotOrder)
          : undefined,
    currentSlotTitle: String(jobLike?.currentSlotTitle || defaults.currentSlotTitle || '').trim() || undefined,
    startedAt: String(jobLike?.startedAt || defaults.startedAt || '').trim() || undefined,
    updatedAt: String(jobLike?.updatedAt || defaults.updatedAt || '').trim() || undefined,
    error: String(jobLike?.error || defaults.error || '').trim() || undefined,
  };
};

const deriveIllustrationJobFromBundle = (sourceHash, bundle, defaults = {}) => {
  const progress = bundle?.progress || {};
  return normalizeIllustrationJob(
    {
      sourceHash,
      status: progress.phase || bundle?.status || 'queued',
      currentStep: progress.currentStep || '',
      completedCount: progress.completedCount ?? bundle?.assets?.length ?? 0,
      totalCount: progress.totalCount ?? bundle?.targetImageCount ?? 0,
      currentSlotId: progress.currentSlotId,
      currentSlotOrder: progress.currentSlotOrder,
      currentSlotTitle: progress.currentSlotTitle,
      startedAt: progress.startedAt || bundle?.generatedAt,
      updatedAt: progress.updatedAt || bundle?.updatedAt,
      error: bundle?.error,
    },
    { sourceHash, ...defaults }
  );
};

const isIllustrationJobRunning = (job) => ['queued', 'planning', 'rendering', 'finalizing'].includes(String(job?.status || ''));
const isIllustrationBundleRunning = (bundle) => ['planning', 'rendering', 'partial'].includes(String(bundle?.status || ''));
const createIllustrationRunId = () => crypto.randomUUID();

const getIllustrationRunState = (sourceHash) => illustrationRunStates.get(sourceHash) || { activeRunId: null };

const setIllustrationRunState = (sourceHash, activeRunId) => {
  illustrationRunStates.set(sourceHash, {
    activeRunId: activeRunId || null,
    updatedAt: new Date().toISOString(),
  });
};

const isIllustrationRunCurrent = (sourceHash, runId) =>
  Boolean(runId) && String(getIllustrationRunState(sourceHash).activeRunId || '') === String(runId);

const clearIllustrationRunIfCurrent = (sourceHash, runId) => {
  if (isIllustrationRunCurrent(sourceHash, runId)) {
    setIllustrationRunState(sourceHash, null);
  }
};

const updateIllustrationJobForRun = (sourceHash, runId, jobLike, defaults = {}, options = {}) => {
  if (!options.allowInactive && runId && !isIllustrationRunCurrent(sourceHash, runId)) {
    return null;
  }
  const nextJob = normalizeIllustrationJob(
    {
      ...jobLike,
      sourceHash,
      runId,
    },
    {
      sourceHash,
      runId,
      ...defaults,
    }
  );
  illustrationJobs.set(sourceHash, nextJob);
  return nextJob;
};

const server = http.createServer(async (request, response) => {
  const startedAt = Date.now();
  try {
    if (!request.url) {
      sendJson(response, 400, { error: 'Missing request URL.' });
      return;
    }

    if (request.method === 'OPTIONS') {
      sendNoContent(response);
      return;
    }

    const url = new URL(request.url, `http://${request.headers.host || `${HOST}:${PORT}`}`);
    const route = url.pathname;

    if (request.method === 'GET' && route === '/api/health') {
      sendJson(response, 200, { ok: true });
      return;
    }

    if (request.method === 'GET' && route === '/api/content/prompt-assets') {
      const profileId = resolveStyleProfileId(url.searchParams.get('profile') || DEFAULT_STYLE_PROFILE_ID);
      const rawNames = url.searchParams.get('names') || '';
      const names = rawNames
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean);
      const assets = await loadPromptAssets(profileId, names);
      sendJson(response, 200, { assets });
      return;
    }

    if (request.method === 'GET' && route === '/api/content/style-profiles') {
      sendJson(response, 200, { profiles: getPublicStyleProfiles() });
      return;
    }

    if (request.method === 'GET' && route === '/api/content/persona-status') {
      const profileId = resolveStyleProfileId(url.searchParams.get('profile') || DEFAULT_STYLE_PROFILE_ID);
      const status = await loadPersonaStatus(profileId);
      sendJson(response, 200, { status });
      return;
    }

    if (request.method === 'GET' && route === '/api/reference-templates/catalog') {
      const profileId = resolveStyleProfileId(url.searchParams.get('profile') || DEFAULT_STYLE_PROFILE_ID);
      const catalog = await parseArticleCatalog(profileId);
      sendJson(response, 200, { catalog });
      return;
    }

    if (request.method === 'POST' && route === '/api/reference-templates/full-text') {
      const body = await parseJsonBody(request);
      const profileId = resolveStyleProfileId(body.profile || DEFAULT_STYLE_PROFILE_ID);
      const articles = await loadReferenceFullTexts(profileId, body.relativePaths);
      sendJson(response, 200, { articles });
      return;
    }

    if (request.method === 'POST' && route === '/api/article-illustrations/generate') {
      const body = await parseJsonBody(request);
      const profileId = resolveStyleProfileId(body.styleProfile || body.profile || DEFAULT_STYLE_PROFILE_ID);
      const articleContent = String(body.articleContent || '').trim();
      const topic = String(body.topic || body.articleTitle || '').trim();
      const apiKey = String(body.apiKey || '').trim();
      const userPrompt = String(body.userPrompt || '').trim();
      const imageCountPrompt = String(body.imageCountPrompt || '').trim();
      const regenerate = Boolean(body.regenerate);

      if (!apiKey) {
        sendJson(response, 400, { error: 'Missing apiKey.' });
        return;
      }

      if (!articleContent) {
        sendJson(response, 400, { error: 'Missing articleContent.' });
        return;
      }

      const identity = resolveIllustrationRequestIdentity({
        profileId,
        articleTitle: topic,
        articleContent,
      });
      const sourceHash = identity.sourceHash;
      const existingManifest = await getIllustrationManifestBySourceHash(sourceHash);
      const existingJob = illustrationJobs.get(sourceHash);
      const { targetImageCount } = resolveIllustrationCountPreference({
        articleContent,
        imageCountPrompt,
      });

      if (
        !regenerate &&
        existingJob &&
        isIllustrationJobRunning(existingJob) &&
        (!existingJob.runId || isIllustrationRunCurrent(sourceHash, existingJob.runId))
      ) {
        sendJson(response, 202, {
          sourceHash,
          job: normalizeIllustrationJob(existingJob, {
            sourceHash,
            totalCount: existingManifest?.targetImageCount || targetImageCount,
          }),
          bundle: overlayIllustrationBundleJobState(
            existingManifest ? toIllustrationBundle(existingManifest) : undefined,
            existingJob
          ),
        });
        return;
      }

      const runId = createIllustrationRunId();
      const startedAt = new Date().toISOString();
      setIllustrationRunState(sourceHash, runId);
      updateIllustrationJobForRun(sourceHash, runId, {
        status: 'queued',
        currentStep: '任务已创建，准备分析全文',
        completedCount: existingManifest?.assets?.length || 0,
        totalCount: existingManifest?.targetImageCount || targetImageCount,
        startedAt,
        updatedAt: startedAt,
      });

      void generateArticleIllustrationsProgressive({
        apiKey,
        profileId,
        articleTitle: topic,
        articleContent,
        plannerModel: String(body.plannerModel || '').trim() || undefined,
        imageModel: String(body.imageModel || '').trim() || undefined,
        options: body.options && typeof body.options === 'object' ? body.options : {},
        userPrompt,
        imageCountPrompt,
        force: regenerate,
        isCanceled: () => !isIllustrationRunCurrent(sourceHash, runId),
        shouldPersistCancellation: () => getIllustrationRunState(sourceHash).activeRunId === null,
        onProgress: (manifest) => {
          updateIllustrationJobForRun(sourceHash, runId, deriveIllustrationJobFromBundle(sourceHash, manifest, { runId }));
        },
      })
        .then((manifest) => {
          updateIllustrationJobForRun(sourceHash, runId, deriveIllustrationJobFromBundle(sourceHash, manifest, { runId }));
          clearIllustrationRunIfCurrent(sourceHash, runId);
        })
        .catch(async (error) => {
          const latestManifest = await getIllustrationManifestBySourceHash(sourceHash);
          if (isIllustrationTaskCanceledError(error) || latestManifest?.status === 'canceled') {
            if (getIllustrationRunState(sourceHash).activeRunId === null) {
              updateIllustrationJobForRun(
                sourceHash,
                runId,
                latestManifest
                  ? deriveIllustrationJobFromBundle(sourceHash, latestManifest, { runId })
                  : {
                      status: 'canceled',
                      currentStep: error instanceof Error ? error.message : ILLUSTRATION_CANCELED_MESSAGE,
                      completedCount: 0,
                      totalCount: targetImageCount,
                      startedAt,
                      updatedAt: new Date().toISOString(),
                    },
                {
                  status: 'canceled',
                  currentStep: error instanceof Error ? error.message : ILLUSTRATION_CANCELED_MESSAGE,
                  completedCount: latestManifest?.assets?.length || 0,
                  totalCount: latestManifest?.targetImageCount || targetImageCount,
                  startedAt,
                  updatedAt: new Date().toISOString(),
                },
                { allowInactive: true }
              );
            }
            clearIllustrationRunIfCurrent(sourceHash, runId);
            return;
          }

          if (!isIllustrationRunCurrent(sourceHash, runId)) {
            return;
          }

          updateIllustrationJobForRun(
            sourceHash,
            runId,
            latestManifest ? deriveIllustrationJobFromBundle(sourceHash, latestManifest, { runId }) : {},
            {
              status: 'error',
              currentStep: error instanceof Error ? error.message : String(error),
              completedCount: latestManifest?.assets?.length || 0,
              totalCount: latestManifest?.targetImageCount || targetImageCount,
              startedAt,
              updatedAt: new Date().toISOString(),
              error: error instanceof Error ? error.message : String(error),
            }
          );
          clearIllustrationRunIfCurrent(sourceHash, runId);
        });

      sendJson(response, 202, {
        sourceHash,
        job: illustrationJobs.get(sourceHash),
        bundle: overlayIllustrationBundleJobState(
          existingManifest ? toIllustrationBundle(existingManifest) : undefined,
          illustrationJobs.get(sourceHash)
        ),
      });
      return;
    }

    if (request.method === 'POST' && route === '/api/article-illustrations/cancel') {
      const body = await parseJsonBody(request);
      const sourceHash = String(body.sourceHash || '').trim();
      if (!sourceHash) {
        sendJson(response, 400, { error: 'Missing sourceHash.' });
        return;
      }

      const activeRunId = getIllustrationRunState(sourceHash).activeRunId;
      const manifest = await getIllustrationManifestBySourceHash(sourceHash);
      const memoryJob = illustrationJobs.get(sourceHash);
      const runningMemoryJob =
        memoryJob && isIllustrationJobRunning(memoryJob) && (!memoryJob.runId || isIllustrationRunCurrent(sourceHash, memoryJob.runId));
      const shouldCancel = Boolean(activeRunId) || Boolean(runningMemoryJob) || isIllustrationBundleRunning(manifest);

      if (activeRunId) {
        setIllustrationRunState(sourceHash, null);
      }

      const bundle = shouldCancel ? await markIllustrationManifestCanceled({ sourceHash }) : manifest;
      const nextJob = normalizeIllustrationJob(
        bundle ? deriveIllustrationJobFromBundle(sourceHash, bundle, { runId: activeRunId || undefined }) : memoryJob,
        {
          sourceHash,
          runId: activeRunId || memoryJob?.runId,
          status: shouldCancel ? 'canceled' : memoryJob?.status || bundle?.status || 'queued',
          currentStep:
            shouldCancel
              ? ILLUSTRATION_CANCELED_MESSAGE
              : memoryJob?.currentStep || bundle?.progress?.currentStep || '',
          completedCount: bundle?.assets?.length || memoryJob?.completedCount || 0,
          totalCount: bundle?.targetImageCount || memoryJob?.totalCount || 0,
          startedAt: memoryJob?.startedAt || bundle?.generatedAt,
          updatedAt: new Date().toISOString(),
        }
      );

      illustrationJobs.set(sourceHash, nextJob);
      sendJson(response, 200, {
        sourceHash,
        job: nextJob,
        bundle: bundle ? toIllustrationBundle(bundle) : undefined,
      });
      return;
    }

    if (request.method === 'GET' && route === '/api/article-illustrations/status') {
      const sourceHash = String(url.searchParams.get('sourceHash') || '').trim();
      if (!sourceHash) {
        sendJson(response, 400, { error: 'Missing sourceHash.' });
        return;
      }
      const manifest = await getIllustrationManifestBySourceHash(sourceHash);
      const memoryJob = illustrationJobs.get(sourceHash);
      const shouldUseMemoryJob =
        memoryJob &&
        (!isIllustrationJobRunning(memoryJob) || !memoryJob.runId || isIllustrationRunCurrent(sourceHash, memoryJob.runId));
      const job = normalizeIllustrationJob((shouldUseMemoryJob ? memoryJob : null) || deriveIllustrationJobFromBundle(sourceHash, manifest), {
        sourceHash,
        status: manifest?.status || 'queued',
        currentStep: manifest?.progress?.currentStep || '',
        completedCount: manifest?.assets?.length || 0,
        totalCount: manifest?.targetImageCount || 0,
        startedAt: manifest?.generatedAt,
        updatedAt: manifest?.updatedAt,
        error: manifest?.error,
      });
      sendJson(response, 200, {
        sourceHash,
        job,
        bundle: overlayIllustrationBundleJobState(manifest ? toIllustrationBundle(manifest) : undefined, shouldUseMemoryJob ? memoryJob : null),
      });
      return;
    }

    if (request.method === 'POST' && route === '/api/article-illustrations/regenerate-slot') {
      const body = await parseJsonBody(request);
      const apiKey = String(body.apiKey || '').trim();
      const sourceHash = String(body.sourceHash || '').trim();
      const slotId = String(body.slotId || '').trim();
      const articleContent = String(body.articleContent || '').trim();

      if (!apiKey) {
        sendJson(response, 400, { error: 'Missing apiKey.' });
        return;
      }

      if (!sourceHash || !slotId) {
        sendJson(response, 400, { error: 'Missing sourceHash or slotId.' });
        return;
      }

      const manifest = await regenerateIllustrationSlot({
        apiKey,
        sourceHash,
        slotId,
        articleContent,
        plannerModel: String(body.plannerModel || '').trim() || undefined,
        imageModel: String(body.imageModel || '').trim() || undefined,
        userPrompt: String(body.userPrompt || '').trim(),
      });
      sendJson(response, 200, { bundle: toIllustrationBundle(manifest) });
      return;
    }

    if (request.method === 'POST' && route === '/api/article-illustrations/regenerate-caption') {
      const body = await parseJsonBody(request);
      const apiKey = String(body.apiKey || '').trim();
      const sourceHash = String(body.sourceHash || '').trim();
      const slotId = String(body.slotId || '').trim();
      const articleContent = String(body.articleContent || '').trim();

      if (!apiKey) {
        sendJson(response, 400, { error: 'Missing apiKey.' });
        return;
      }

      if (!sourceHash || !slotId) {
        sendJson(response, 400, { error: 'Missing sourceHash or slotId.' });
        return;
      }

      const manifest = await regenerateIllustrationCaption({
        apiKey,
        sourceHash,
        slotId,
        articleContent,
        plannerModel: String(body.plannerModel || '').trim() || undefined,
        userPrompt: String(body.userPrompt || '').trim(),
      });
      sendJson(response, 200, { bundle: toIllustrationBundle(manifest) });
      return;
    }

    if (request.method === 'POST' && route === '/api/article-illustrations/delete-slot-image') {
      const body = await parseJsonBody(request);
      const sourceHash = String(body.sourceHash || '').trim();
      const slotId = String(body.slotId || '').trim();

      if (!sourceHash || !slotId) {
        sendJson(response, 400, { error: 'Missing sourceHash or slotId.' });
        return;
      }

      const manifest = await deleteIllustrationSlotImage({ sourceHash, slotId });
      sendJson(response, 200, { bundle: toIllustrationBundle(manifest) });
      return;
    }

    if (request.method === 'POST' && route === '/api/article-illustrations/switch-slot-version') {
      const body = await parseJsonBody(request);
      const sourceHash = String(body.sourceHash || '').trim();
      const slotId = String(body.slotId || '').trim();
      const direction = String(body.direction || '').trim();

      if (!sourceHash || !slotId || !['previous', 'next'].includes(direction)) {
        sendJson(response, 400, { error: 'Missing sourceHash, slotId, or valid direction.' });
        return;
      }

      const manifest = await switchIllustrationSlotVersion({
        sourceHash,
        slotId,
        direction,
      });
      sendJson(response, 200, { bundle: toIllustrationBundle(manifest) });
      return;
    }

    if (request.method === 'GET' && route === '/api/wechat-official/config') {
      sendJson(response, 200, getWechatPublisherConfig());
      return;
    }

    if (request.method === 'POST' && route === '/api/wechat-official/preview') {
      const body = await parseJsonBody(request);
      const preview = await generateWechatDraftPreview({
        topic: String(body.topic || '').trim(),
        articleContent: String(body.articleContent || '').trim(),
        illustrationBundle: body.illustrationBundle && typeof body.illustrationBundle === 'object' ? body.illustrationBundle : undefined,
        layout: body.layout && typeof body.layout === 'object' ? body.layout : {},
        apiKey: String(body.apiKey || '').trim() || undefined,
        renderPlan: body.renderPlan && typeof body.renderPlan === 'object' ? body.renderPlan : undefined,
      });
      sendJson(response, 200, preview);
      return;
    }

    if (request.method === 'POST' && route === '/api/wechat-official/draft/upsert') {
      const body = await parseJsonBody(request);
      const payload = await upsertWechatOfficialDraft({
        topic: String(body.topic || '').trim(),
        articleContent: String(body.articleContent || '').trim(),
        illustrationBundle: body.illustrationBundle && typeof body.illustrationBundle === 'object' ? body.illustrationBundle : undefined,
        layout: body.layout && typeof body.layout === 'object' ? body.layout : {},
        mediaId: String(body.mediaId || '').trim() || undefined,
        apiKey: String(body.apiKey || '').trim() || undefined,
        renderPlan: body.renderPlan && typeof body.renderPlan === 'object' ? body.renderPlan : undefined,
      });
      sendJson(response, 200, payload);
      return;
    }

    if (request.method === 'POST' && route === '/api/wechat-official/draft/get') {
      const body = await parseJsonBody(request);
      const mediaId = String(body.mediaId || '').trim();
      if (!mediaId) {
        sendJson(response, 400, { error: 'Missing mediaId.' });
        return;
      }
      const payload = await getWechatOfficialDraft({ mediaId });
      sendJson(response, 200, payload);
      return;
    }

    if (request.method === 'POST' && route === '/api/wechat-official/publish/submit') {
      const body = await parseJsonBody(request);
      const mediaId = String(body.mediaId || '').trim();
      if (!mediaId) {
        sendJson(response, 400, { error: 'Missing mediaId.' });
        return;
      }
      const payload = await submitWechatOfficialPublish({ mediaId });
      sendJson(response, 200, payload);
      return;
    }

    if (request.method === 'POST' && route === '/api/wechat-official/publish/get') {
      const body = await parseJsonBody(request);
      const publishId = String(body.publishId || '').trim();
      if (!publishId) {
        sendJson(response, 400, { error: 'Missing publishId.' });
        return;
      }
      const payload = await getWechatOfficialPublishStatus({ publishId });
      sendJson(response, 200, payload);
      return;
    }

    if (request.method === 'GET') {
      if (await tryServeGeneratedAsset(route, response)) {
        return;
      }
      if (await tryServeFrontend(route, response)) {
        return;
      }
    }

    sendJson(response, 404, { error: `Route not found: ${route}` });
  } catch (error) {
    console.error(
      `[backend] ${request.method || 'UNKNOWN'} ${request.url || ''} failed after ${Date.now() - startedAt}ms`,
      error
    );
    sendJson(response, 500, {
      error: error instanceof Error ? error.message : String(error),
      code: error && typeof error === 'object' && 'code' in error ? error.code : undefined,
      details: Array.isArray(error?.details) ? error.details : undefined,
    });
  }
});

server.requestTimeout = 45 * 60 * 1000;
server.headersTimeout = 46 * 60 * 1000;
server.keepAliveTimeout = 2 * 60 * 1000;

server.on('clientError', (error, socket) => {
  console.error('[backend] client socket error', error);
  if (socket.writable) {
    socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
  }
});

server.on('error', (error) => {
  console.error('[backend] server error', error);
});

server.listen(PORT, HOST, () => {
  console.log(`[backend] listening on http://${HOST}:${PORT}`);
});
