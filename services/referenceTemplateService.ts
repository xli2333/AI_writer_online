import { buildTaskLookupText, loadReferenceTemplateCatalog, loadReferenceTemplateFullTexts } from './backendContentService';
import { ReferenceTemplateArticle, WritingTaskOptions } from '../types';

interface ArticleCatalogEntry {
  id: string;
  date?: string;
  title: string;
  relative_path?: string;
  content_type?: string;
  industry?: string[];
  topic?: string[];
  genre?: string;
  style?: string[];
  audience?: string[];
  intent?: string[];
  tone?: string[];
  structure_pattern?: string;
  opening_pattern?: string;
  ending_pattern?: string;
  core_argument?: string;
  key_points?: string[];
  quality_score?: number;
  reference_value_score?: number;
  structure_score?: number;
  argument_score?: number;
  evidence_score?: number;
  style_score?: number;
  publishability_score?: number;
  is_activity_notice?: boolean;
  is_low_value?: boolean;
  is_advertorial?: boolean;
  advertorial_type?: string;
  advertorial_confidence?: number;
  promotional_intensity_score?: number;
  editorial_independence_score?: number;
  brand_exposure_level?: string;
  source_transparency?: string;
  summary_200?: string;
  summary_500?: string;
}

const articleCatalogPromises = new Map<string, Promise<ArticleCatalogEntry[]>>();
const articleFullTextCache = new Map<string, Promise<string>>();

const normalizeText = (value: unknown) =>
  String(value ?? '')
    .toLowerCase()
    .replace(/\r/g, '\n')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const pushCjkTokens = (segment: string, sink: string[]) => {
  for (let index = 0; index < segment.length; index += 1) {
    sink.push(segment[index]);
    if (index < segment.length - 1) {
      sink.push(segment.slice(index, index + 2));
    }
  }
};

const extractTokens = (input: unknown) => {
  const normalized = normalizeText(input);
  if (!normalized) return [];

  const tokens: string[] = [];
  for (const segment of normalized.split(' ')) {
    if (!segment) continue;
    if (/^[a-z0-9_-]+$/i.test(segment)) {
      if (segment.length >= 2) {
        tokens.push(segment);
      }
      continue;
    }
    pushCjkTokens(segment, tokens);
  }

  return tokens;
};

const countOverlapScore = (queryTokens: string[], docTokens: string[]) => {
  if (!queryTokens.length || !docTokens.length) return 0;

  const docCounts = new Map<string, number>();
  for (const token of docTokens) {
    docCounts.set(token, (docCounts.get(token) || 0) + 1);
  }

  let score = 0;
  for (const token of queryTokens) {
    const count = docCounts.get(token) || 0;
    if (count > 0) {
      score += 1 + Math.log2(count + 1);
    }
  }

  return score / Math.sqrt(queryTokens.length * docTokens.length);
};

const buildSearchDocument = (article: ArticleCatalogEntry) =>
  [
    article.title,
    article.summary_200,
    article.summary_500,
    article.content_type,
    ...(article.industry || []),
    ...(article.topic || []),
    article.genre,
    ...(article.style || []),
    ...(article.audience || []),
    ...(article.intent || []),
    ...(article.tone || []),
    article.structure_pattern,
    article.core_argument,
    article.brand_exposure_level,
    article.source_transparency,
    ...(article.key_points || []),
  ]
    .filter(Boolean)
    .join(' ');

const clamp01 = (value: number) => Math.max(0, Math.min(1, value));

const normalizeScore = (value: unknown) => {
  const numeric = Number(value || 0);
  if (!Number.isFinite(numeric)) return 0;
  const normalized = numeric > 0 && numeric <= 1 ? numeric * 100 : numeric;
  return Math.max(0, Math.min(100, normalized)) / 100;
};

const computeStylePurity = (article: ArticleCatalogEntry, profile = 'fdsm') => {
  const promotional = normalizeScore(article.promotional_intensity_score || article.advertorial_confidence);
  const advertorialRisk = normalizeScore(article.advertorial_confidence);
  const editorialIndependence = normalizeScore(
    article.editorial_independence_score ??
      Math.max(0, 100 - normalizeScore(article.advertorial_confidence) * 75)
  );
  const quality = normalizeScore(article.quality_score);
  const reference = normalizeScore(article.reference_value_score);
  const publishability = normalizeScore(article.publishability_score);
  const structure = normalizeScore(article.structure_score);
  const argument = normalizeScore(article.argument_score);
  const evidence = normalizeScore(article.evidence_score);
  const style = normalizeScore(article.style_score);
  let score = 0;

  if (profile === 'latepost') {
    score =
      editorialIndependence * 0.34 +
      evidence * 0.18 +
      structure * 0.16 +
      style * 0.1 +
      quality * 0.08 +
      publishability * 0.08 +
      reference * 0.06 -
      promotional * 0.18 -
      advertorialRisk * 0.12;

    if (typeof article.content_type === 'string' && /深度|报道|专访|特写|调查/.test(article.content_type)) {
      score += 0.03;
    }
    if (typeof article.genre === 'string' && /人物|行业评论|趋势/.test(article.genre)) {
      score += 0.02;
    }
    if (String(article.brand_exposure_level || '').includes('高')) {
      score -= 0.08;
    }
  } else if (profile === 'xinzhiyuan') {
    score =
      editorialIndependence * 0.22 +
      evidence * 0.18 +
      style * 0.15 +
      quality * 0.13 +
      reference * 0.11 +
      publishability * 0.09 +
      structure * 0.08 +
      argument * 0.08 -
      promotional * 0.18 -
      advertorialRisk * 0.12;

    if (typeof article.content_type === 'string' && /论文|研究|评测|快讯|报道|专访/.test(article.content_type)) {
      score += 0.03;
    }
    if (typeof article.genre === 'string' && /技术解读|论文|产品评测|人物|趋势/.test(article.genre)) {
      score += 0.02;
    }
    if (String(article.source_transparency || '').includes('清晰')) {
      score += 0.02;
    }
    if (String(article.brand_exposure_level || '').includes('高')) {
      score -= 0.06;
    }
  } else {
    score =
      argument * 0.22 +
      structure * 0.18 +
      evidence * 0.16 +
      style * 0.12 +
      quality * 0.12 +
      reference * 0.1 +
      publishability * 0.1 +
      editorialIndependence * 0.08 -
      promotional * 0.12 -
      advertorialRisk * 0.08;
  }

  return clamp01(score);
};

const isStylePureEnough = (article: ArticleCatalogEntry, profile = 'fdsm') => {
  if (article.is_activity_notice || article.is_low_value || article.is_advertorial) {
    return false;
  }

  const promotional = normalizeScore(article.promotional_intensity_score || article.advertorial_confidence);
  const editorialIndependence = normalizeScore(
    article.editorial_independence_score ??
      Math.max(0, 100 - normalizeScore(article.advertorial_confidence) * 75)
  );
  const purity = computeStylePurity(article, profile);
  if (profile === 'latepost') {
    return purity >= 0.48 && promotional <= 0.72 && editorialIndependence >= 0.35;
  }

  if (profile === 'xinzhiyuan') {
    return purity >= 0.46 && promotional <= 0.74 && editorialIndependence >= 0.3;
  }

  return purity >= 0.42 && promotional <= 0.78 && editorialIndependence >= 0.28;
};

const scoreArticleForTask = (taskText: string, article: ArticleCatalogEntry, profile = 'fdsm') => {
  const taskTokens = extractTokens(taskText);
  const titleTokens = extractTokens(article.title);
  const docTokens = extractTokens(buildSearchDocument(article));
  const lexical = countOverlapScore(taskTokens, docTokens);
  const titleHit = countOverlapScore(taskTokens, titleTokens);
  const quality = normalizeScore(article.quality_score);
  const reference = normalizeScore(article.reference_value_score);
  const purity = computeStylePurity(article, profile);
  return lexical * 0.48 + titleHit * 0.18 + quality * 0.08 + reference * 0.11 + purity * 0.15;
};

const boostScore = (article: ArticleCatalogEntry, options: WritingTaskOptions, direction: string, baseScore: number) => {
  let score = baseScore;
  const purity = computeStylePurity(article, String(options.styleProfile || 'fdsm'));

  if (article.genre && article.genre.includes(options.genre)) {
    score += 0.18;
  }

  if (Array.isArray(article.style) && article.style.some((item) => item.includes(options.style) || options.style.includes(item))) {
    score += 0.08;
  }

  if (
    Array.isArray(article.audience) &&
    article.audience.some((item) => item.includes(options.audience) || options.audience.includes(item))
  ) {
    score += 0.05;
  }

  if (direction && article.core_argument && normalizeText(article.core_argument).includes(normalizeText(direction).slice(0, 24))) {
    score += 0.04;
  }

  score += purity * 0.12;

  if (options.styleProfile === 'latepost') {
    if (typeof article.content_type === 'string' && /深度|报道|专访|特写|调查/.test(article.content_type)) {
      score += 0.03;
    }
    if (typeof article.editorial_independence_score === 'number' && article.editorial_independence_score >= 75) {
      score += 0.02;
    }
    if (typeof article.promotional_intensity_score === 'number' && article.promotional_intensity_score >= 45) {
      score -= 0.05;
    }
  } else if (options.styleProfile === 'xinzhiyuan') {
    if (typeof article.content_type === 'string' && /论文|研究|评测|快讯|报道|专访/.test(article.content_type)) {
      score += 0.03;
    }
    if (typeof article.source_transparency === 'string' && article.source_transparency.includes('清晰')) {
      score += 0.02;
    }
    if (typeof article.promotional_intensity_score === 'number' && article.promotional_intensity_score >= 42) {
      score -= 0.06;
    }
  }

  return score;
};

const articleSimilarity = (left: ArticleCatalogEntry, right: ArticleCatalogEntry) => {
  const leftTokens = extractTokens(buildSearchDocument(left));
  const rightTokens = extractTokens(buildSearchDocument(right));
  const leftToRight = countOverlapScore(leftTokens, rightTokens);
  const rightToLeft = countOverlapScore(rightTokens, leftTokens);
  const titleSimilarity = countOverlapScore(extractTokens(left.title), extractTokens(right.title));
  return Math.max(leftToRight, rightToLeft, titleSimilarity);
};

const selectDiversifiedCandidates = (
  candidates: { article: ArticleCatalogEntry; score: number }[],
  limit: number
) => {
  const remaining = [...candidates].sort((left, right) => right.score - left.score);
  const selected: { article: ArticleCatalogEntry; score: number }[] = [];

  while (remaining.length > 0 && selected.length < limit) {
    if (selected.length === 0) {
      selected.push(remaining.shift()!);
      continue;
    }

    let bestIndex = 0;
    let bestValue = Number.NEGATIVE_INFINITY;

    remaining.forEach((candidate, index) => {
      const maxSimilarity = Math.max(
        ...selected.map((picked) => articleSimilarity(candidate.article, picked.article)),
        0
      );
      const sameGenrePenalty = selected.some((picked) => picked.article.genre && picked.article.genre === candidate.article.genre)
        ? 0.03
        : 0;
      const value = candidate.score - maxSimilarity * 0.2 - sameGenrePenalty;

      if (value > bestValue) {
        bestValue = value;
        bestIndex = index;
      }
    });

    selected.push(remaining.splice(bestIndex, 1)[0]);
  }

  return selected;
};

const buildFullTextCacheKey = (profile: string, relativePath?: string) =>
  `${profile}::${String(relativePath || '').replace(/\\/g, '/')}`;

const loadArticleCatalog = async (profile: string) => {
  if (!articleCatalogPromises.has(profile)) {
    articleCatalogPromises.set(
      profile,
      loadReferenceTemplateCatalog(profile).then((catalog) =>
        catalog.filter((entry): entry is ArticleCatalogEntry => Boolean(entry?.id && entry?.title))
      )
    );
  }

  return articleCatalogPromises.get(profile)!;
};

const buildSelectionReason = (article: ArticleCatalogEntry, options: WritingTaskOptions) => {
  const reasons: string[] = [];
  const purity = Math.round(computeStylePurity(article, String(options.styleProfile || 'fdsm')) * 100);

  if (article.genre) {
    reasons.push(`文体参考：${article.genre}`);
  }

  if (article.structure_pattern) {
    reasons.push(`结构可借鉴：${article.structure_pattern}`);
  }

  if (article.opening_pattern) {
    reasons.push(`开头可借鉴：${article.opening_pattern}`);
  }

  if (Array.isArray(article.style) && article.style.length > 0) {
    reasons.push(`风格接近：${article.style.slice(0, 3).join('、')}`);
  }

  reasons.push(`风格纯度：${purity} 分`);

  if (typeof article.editorial_independence_score === 'number' && article.editorial_independence_score > 0) {
    reasons.push(`编辑独立性较高：${Math.round(article.editorial_independence_score)} 分`);
  }

  if (!reasons.length) {
    reasons.push(`与当前${options.genre}任务的主题和结构匹配度较高`);
  }

  return reasons.slice(0, 3).join('；');
};

const cleanFullText = (value?: string) => String(value || '').trim();

const summarizeTemplates = (articles: ReferenceTemplateArticle[]) => ({
  count: articles.length,
  titles: articles.map((article) => article.title),
  relativePaths: articles.map((article) => article.relativePath || ''),
  withFullText: articles.filter((article) => cleanFullText(article.fullText).length > 0).length,
});

export const formatReferenceTemplatesForPrompt = (articles: ReferenceTemplateArticle[]) =>
  articles.length === 0
    ? '当前没有可用的参考模板文章。'
    : articles
        .map(
          (article, index) =>
            [
              `## 模板文章 ${index + 1}`,
              `标题：${article.title}`,
              article.date ? `日期：${article.date}` : '',
              article.genre ? `文体：${article.genre}` : '',
              article.style?.length ? `风格：${article.style.join('、')}` : '',
              article.structurePattern ? `结构模式：${article.structurePattern}` : '',
              article.openingPattern ? `开头方式：${article.openingPattern}` : '',
              article.coreArgument ? `核心论点：${article.coreArgument}` : '',
              article.whySelected ? `本次借鉴点：${article.whySelected}` : '',
              article.summary ? `摘要：${article.summary}` : '',
              article.fullText ? `全文：\n${article.fullText}` : '',
            ]
              .filter(Boolean)
              .join('\n')
        )
        .join('\n\n');

export const formatReferenceTemplateDigestsForPrompt = (articles: ReferenceTemplateArticle[]) =>
  articles.length === 0
    ? '当前没有可用的参考模板文章。'
    : articles
        .map(
          (article, index) =>
            [
              `## 模板文章 ${index + 1}`,
              `标题：${article.title}`,
              article.date ? `日期：${article.date}` : '',
              article.genre ? `文体：${article.genre}` : '',
              article.style?.length ? `风格：${article.style.join('、')}` : '',
              article.structurePattern ? `结构模式：${article.structurePattern}` : '',
              article.openingPattern ? `开头方式：${article.openingPattern}` : '',
              article.coreArgument ? `核心论点：${article.coreArgument}` : '',
              article.whySelected ? `本次借鉴点：${article.whySelected}` : '',
              article.summary ? `摘要：${article.summary}` : '',
            ]
              .filter(Boolean)
              .join('\n')
        )
        .join('\n\n');

export const selectReferenceTemplates = async (
  topic: string,
  direction: string,
  options: WritingTaskOptions,
  limit = 3
): Promise<ReferenceTemplateArticle[]> => {
  const profile = String(options.styleProfile || 'fdsm');
  const catalog = await loadArticleCatalog(profile);
  const taskText = buildTaskLookupText(topic, direction, options);

  const scoredCandidates = catalog
    .filter((article) => isStylePureEnough(article, profile))
    .map((article) => {
      const baseScore = scoreArticleForTask(taskText, article, profile);
      return {
        article,
        score: boostScore(article, options, direction, baseScore),
      };
    });

  const selected = selectDiversifiedCandidates(scoredCandidates, limit)
    .map(({ article, score }) => ({
      id: article.id,
      title: article.title,
      date: article.date,
      styleProfile: profile,
      genre: article.genre,
      style: article.style || [],
      summary: article.summary_200 || article.summary_500 || '',
      structurePattern: article.structure_pattern,
      openingPattern: article.opening_pattern,
      endingPattern: article.ending_pattern,
      coreArgument: article.core_argument,
      relativePath: article.relative_path,
      whySelected: buildSelectionReason(article, options),
      score,
      stylePurityScore: Number((computeStylePurity(article, profile) * 100).toFixed(2)),
    }));

  if (selected.length === 0) {
    console.warn('[reference-rag] no reference templates selected', {
      topic,
      direction,
      styleProfile: profile,
      genre: options.genre,
      style: options.style,
    });
  } else {
    console.info('[reference-rag] selected reference templates', {
      topic,
      direction,
      selectionMode: 'top-score-with-diversity',
      ...summarizeTemplates(selected),
      scores: selected.map((article) => Number(article.score || 0).toFixed(4)),
    });
  }

  return selected;
};

export const hydrateReferenceTemplatesWithFullText = async (articles: ReferenceTemplateArticle[]) => {
  const hydrated = await Promise.all(
    articles.map(async (article) => ({
      ...article,
      fullText: article.fullText || (await loadArticleFullText(article.relativePath, article.styleProfile || 'fdsm')),
    }))
  );

  const missingFullText = hydrated
    .filter((article) => cleanFullText(article.fullText).length === 0)
    .map((article) => ({
      title: article.title,
      relativePath: article.relativePath || '',
    }));

  console.info('[reference-rag] hydrated reference templates', {
    ...summarizeTemplates(hydrated),
    missingFullText,
  });

  return hydrated;
};

const loadArticleFullText = async (relativePath?: string, profile = 'fdsm') => {
  if (!relativePath) return '';
  const normalized = relativePath.replace(/\\/g, '/');
  const cacheKey = buildFullTextCacheKey(profile, normalized);
  if (!articleFullTextCache.has(cacheKey)) {
    articleFullTextCache.set(
      cacheKey,
      loadReferenceTemplateFullTexts(profile, [normalized]).then((articles) => String(articles.get(normalized) || ''))
    );
  }

  return articleFullTextCache.get(cacheKey) || Promise.resolve('');
};
