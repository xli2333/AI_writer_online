import { ReferenceTemplateArticle, WritingTaskOptions } from '../types';

interface ArticleCatalogEntry {
  id: string;
  date?: string;
  title: string;
  relative_path?: string;
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
  is_activity_notice?: boolean;
  is_low_value?: boolean;
  summary_200?: string;
  summary_500?: string;
}

const articleCatalogUrl = new URL('../rag_assets/metadata/article_tags.jsonl', import.meta.url).href;
const rawArticleModules = import.meta.glob('../raw_materials/**/*.txt', {
  query: '?raw',
  import: 'default',
});

let articleCatalogPromise: Promise<ArticleCatalogEntry[]> | null = null;
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
    ...(article.industry || []),
    ...(article.topic || []),
    article.genre,
    ...(article.style || []),
    ...(article.audience || []),
    ...(article.intent || []),
    ...(article.tone || []),
    article.structure_pattern,
    article.core_argument,
    ...(article.key_points || []),
  ]
    .filter(Boolean)
    .join(' ');

const scoreArticleForTask = (taskText: string, article: ArticleCatalogEntry) => {
  const taskTokens = extractTokens(taskText);
  const titleTokens = extractTokens(article.title);
  const docTokens = extractTokens(buildSearchDocument(article));
  const lexical = countOverlapScore(taskTokens, docTokens);
  const titleHit = countOverlapScore(taskTokens, titleTokens);
  const quality = Number(article.quality_score || 0) / 100;
  const reference = Number(article.reference_value_score || 0) / 100;
  return lexical * 0.55 + titleHit * 0.2 + quality * 0.1 + reference * 0.15;
};

const boostScore = (article: ArticleCatalogEntry, options: WritingTaskOptions, direction: string, baseScore: number) => {
  let score = baseScore;

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

const parseArticleCatalog = (raw: string): ArticleCatalogEntry[] =>
  raw
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line) as ArticleCatalogEntry;
      } catch {
        return null;
      }
    })
    .filter((entry): entry is ArticleCatalogEntry => Boolean(entry?.id && entry?.title));

const loadArticleCatalog = async () => {
  if (!articleCatalogPromise) {
    articleCatalogPromise = fetch(articleCatalogUrl)
      .then((response) => {
        if (!response.ok) {
          throw new Error(`Failed to load article catalog: ${response.status}`);
        }
        return response.text();
      })
      .then(parseArticleCatalog);
  }

  return articleCatalogPromise;
};

const buildSelectionReason = (article: ArticleCatalogEntry, options: WritingTaskOptions) => {
  const reasons: string[] = [];

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

const loadArticleFullText = async (relativePath?: string) => {
  if (!relativePath) return '';

  const modulePath = `../raw_materials/${relativePath.replace(/\\/g, '/')}`;
  const loader = rawArticleModules[modulePath] as (() => Promise<string>) | undefined;
  if (!loader) return '';

  if (!articleFullTextCache.has(modulePath)) {
    articleFullTextCache.set(modulePath, loader().then((content) => String(content || '')));
  }

  return articleFullTextCache.get(modulePath) || Promise.resolve('');
};

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
  const catalog = await loadArticleCatalog();
  const taskText = [topic, direction, options.genre, options.style, options.audience, options.articleGoal]
    .filter(Boolean)
    .join(' ');

  const scoredCandidates = catalog
    .filter((article) => !article.is_activity_notice && !article.is_low_value)
    .map((article) => {
      const baseScore = scoreArticleForTask(taskText, article);
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
    }));

  if (selected.length === 0) {
    console.warn('[reference-rag] no reference templates selected', {
      topic,
      direction,
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
      fullText: article.fullText || (await loadArticleFullText(article.relativePath)),
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
