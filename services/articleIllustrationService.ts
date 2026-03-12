import type {
  ArticleIllustrationBundle,
  ArticleIllustrationJobStatus,
  WritingTaskOptions,
} from '../types';
import { getStoredGeminiApiKey } from './geminiService';
import { resolveBackendUrl, resolveGeneratedAssetUrl } from './runtimeConfig';

interface IllustrationPayload {
  bundle?: ArticleIllustrationBundle;
  sourceHash?: string;
  job?: ArticleIllustrationJobStatus;
  error?: string;
}

const GENERATE_TIMEOUT_MS = 35 * 60 * 1000;
const REGENERATE_TIMEOUT_MS = 20 * 60 * 1000;
const CAPTION_TIMEOUT_MS = 5 * 60 * 1000;
const MUTATION_TIMEOUT_MS = 60 * 1000;

const mergeAbortSignals = (signals: Array<AbortSignal | null | undefined>) => {
  const activeSignals = signals.filter(Boolean) as AbortSignal[];
  if (activeSignals.length === 0) {
    return undefined;
  }
  if (activeSignals.length === 1) {
    return activeSignals[0];
  }
  if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.any === 'function') {
    return AbortSignal.any(activeSignals);
  }
  return activeSignals[0];
};

const fetchJson = async <T>(input: string, init?: RequestInit, timeoutMs = GENERATE_TIMEOUT_MS): Promise<T> => {
  const timeoutController = new AbortController();
  const timeoutHandle = window.setTimeout(() => {
    timeoutController.abort('timeout');
  }, timeoutMs);
  const signal = mergeAbortSignals([init?.signal, timeoutController.signal]);

  try {
    const response = await fetch(resolveBackendUrl(input), { ...init, signal });
    if (!response.ok) {
      const payload = (await response.json().catch(() => ({}))) as IllustrationPayload;
      throw new Error(payload.error || `Illustration request failed: ${response.status} ${response.statusText}`);
    }
    return (await response.json()) as T;
  } catch (error: any) {
    if (timeoutController.signal.aborted && !(init?.signal && init.signal.aborted)) {
      throw new Error(`生图请求超时（${Math.round(timeoutMs / 1000)} 秒），请稍后重试。`);
    }
    if (error?.name === 'AbortError') {
      throw new Error('已取消本次生图请求。');
    }
    throw error;
  } finally {
    window.clearTimeout(timeoutHandle);
  }
};

const normalizeIllustrationBundle = (bundle?: ArticleIllustrationBundle) => {
  if (!bundle) return bundle;

  const normalizeAsset = (asset: ArticleIllustrationBundle['assets'][number]) => ({
    ...asset,
    url: resolveGeneratedAssetUrl(asset.url),
  });

  return {
    ...bundle,
    slots: Array.isArray(bundle.slots)
      ? bundle.slots.map((slot) => ({
          ...slot,
          assetUrl: slot.assetUrl ? resolveGeneratedAssetUrl(slot.assetUrl) : slot.assetUrl,
        }))
      : [],
    assets: Array.isArray(bundle.assets) ? bundle.assets.map(normalizeAsset) : [],
    assetVersions:
      bundle.assetVersions && typeof bundle.assetVersions === 'object'
        ? Object.fromEntries(
            Object.entries(bundle.assetVersions).map(([slotId, assets]) => [
              slotId,
              Array.isArray(assets) ? assets.map(normalizeAsset) : [],
            ])
          )
        : {},
  } satisfies ArticleIllustrationBundle;
};

const normalizeIllustrationPayload = (payload: IllustrationPayload) => ({
  ...payload,
  bundle: normalizeIllustrationBundle(payload.bundle),
});

const toAssetArray = (value: unknown) =>
  Array.isArray(value) ? (value.filter(Boolean) as ArticleIllustrationBundle['assets']) : [];

const syncSlotWithActiveAsset = (slot: ArticleIllustrationBundle['slots'][number], versions: ArticleIllustrationBundle['assets']) => {
  const activeAsset =
    versions.find((asset) => asset.id === slot.activeAssetId) || versions[versions.length - 1] || null;
  const nextStatus =
    slot.status === 'rendering' || slot.status === 'error' ? slot.status : activeAsset ? 'ready' : 'planned';

  return {
    ...slot,
    explanation: String(activeAsset?.editorCaption || slot.explanation || slot.purpose || '').trim(),
    activeAssetId: activeAsset?.id,
    versionCount: versions.length,
    assetUrl: activeAsset?.url,
    mimeType: activeAsset?.mimeType,
    width: activeAsset?.width,
    height: activeAsset?.height,
    status: nextStatus,
  };
};

const buildActiveAssetList = (
  slots: ArticleIllustrationBundle['slots'],
  assetVersions: ArticleIllustrationBundle['assetVersions']
) =>
  slots
    .map((slot) => {
      const versions = toAssetArray(assetVersions?.[slot.id]);
      return versions.find((asset) => asset.id === slot.activeAssetId) || versions[versions.length - 1] || null;
    })
    .filter(Boolean) as ArticleIllustrationBundle['assets'];

const rebuildBundle = (bundle: ArticleIllustrationBundle): ArticleIllustrationBundle => {
  const normalizedAssetVersions = Object.fromEntries(
    Object.entries(bundle.assetVersions || {}).map(([slotId, versions]) => [slotId, toAssetArray(versions)])
  ) as ArticleIllustrationBundle['assetVersions'];
  const slots = Array.isArray(bundle.slots)
    ? bundle.slots.map((slot) => syncSlotWithActiveAsset(slot, normalizedAssetVersions[slot.id] || []))
    : [];

  return {
    ...bundle,
    slots,
    assets: buildActiveAssetList(slots, normalizedAssetVersions),
    assetVersions: normalizedAssetVersions,
    updatedAt: new Date().toISOString(),
  };
};

const getRuntimeApiKey = () => {
  const apiKey = getStoredGeminiApiKey();
  if (!apiKey) {
    throw new Error('请先输入你自己的 Gemini API Key。');
  }
  return apiKey;
};

const getPlannerModel = () => 'gemini-3.1-pro-preview';

export interface IllustrationGenerationStartResult {
  sourceHash: string;
  bundle?: ArticleIllustrationBundle;
  job?: ArticleIllustrationJobStatus;
}

export interface IllustrationGenerationStatusResult {
  sourceHash: string;
  bundle?: ArticleIllustrationBundle;
  job?: ArticleIllustrationJobStatus;
}

export interface IllustrationGenerationCancelResult {
  sourceHash: string;
  bundle?: ArticleIllustrationBundle;
  job?: ArticleIllustrationJobStatus;
}

export const computeArticleIllustrationHash = (styleProfile: string, articleContent: string) => {
  const normalized = `${String(styleProfile || 'fdsm').trim().toLowerCase()}\n${String(articleContent || '').trim()}`;
  let hash = 2166136261;
  for (let index = 0; index < normalized.length; index += 1) {
    hash ^= normalized.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return Math.abs(hash >>> 0).toString(16);
};

export const startArticleIllustrationGeneration = async ({
  topic,
  articleContent,
  options,
  userPrompt,
  imageCountPrompt,
  regenerate = false,
  signal,
}: {
  topic: string;
  articleContent: string;
  options: WritingTaskOptions;
  userPrompt?: string;
  imageCountPrompt?: string;
  regenerate?: boolean;
  signal?: AbortSignal;
}) => {
  const payload = normalizeIllustrationPayload(
    await fetchJson<IllustrationPayload>(
      '/api/article-illustrations/generate',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal,
        body: JSON.stringify({
          apiKey: getRuntimeApiKey(),
          styleProfile: options.styleProfile,
          topic,
          articleContent,
          plannerModel: getPlannerModel(),
          imageModel: 'gemini-3-pro-image-preview',
          options,
          userPrompt: String(userPrompt || '').trim(),
          imageCountPrompt: String(imageCountPrompt || '').trim(),
          regenerate,
        }),
      },
      GENERATE_TIMEOUT_MS
    )
  );

  if (!payload.sourceHash) {
    throw new Error('后端没有返回配图任务标识。');
  }

  return {
    sourceHash: payload.sourceHash,
    bundle: payload.bundle,
    job: payload.job,
  } satisfies IllustrationGenerationStartResult;
};

export const getArticleIllustrationStatus = async ({
  sourceHash,
  knownAssetCount,
  signal,
}: {
  sourceHash: string;
  knownAssetCount?: number;
  signal?: AbortSignal;
}) => {
  const params = new URLSearchParams({ sourceHash });
  if (Number.isFinite(knownAssetCount)) {
    params.set('knownAssetCount', String(Math.max(0, Number(knownAssetCount || 0))));
  }
  const payload = normalizeIllustrationPayload(
    await fetchJson<IllustrationPayload>(
      `/api/article-illustrations/status?${params.toString()}`,
      {
        method: 'GET',
        signal,
      },
      GENERATE_TIMEOUT_MS
    )
  );

  if (!payload.sourceHash) {
    throw new Error('后端没有返回配图任务状态。');
  }

  return {
    sourceHash: payload.sourceHash,
    bundle: payload.bundle,
    job: payload.job,
  } satisfies IllustrationGenerationStatusResult;
};

export const cancelArticleIllustrationGeneration = async ({
  sourceHash,
  signal,
}: {
  sourceHash: string;
  signal?: AbortSignal;
}) => {
  const payload = normalizeIllustrationPayload(
    await fetchJson<IllustrationPayload>(
      '/api/article-illustrations/cancel',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal,
        body: JSON.stringify({
          sourceHash,
        }),
      },
      MUTATION_TIMEOUT_MS
    )
  );

  if (!payload.sourceHash) {
    throw new Error('后端没有返回被取消的配图任务标识。');
  }

  return {
    sourceHash: payload.sourceHash,
    bundle: payload.bundle,
    job: payload.job,
  } satisfies IllustrationGenerationCancelResult;
};

export const regenerateIllustrationSlot = async ({
  sourceHash,
  slotId,
  articleContent,
  bundle,
  options,
  userPrompt,
  signal,
}: {
  sourceHash: string;
  slotId: string;
  articleContent: string;
  bundle: ArticleIllustrationBundle;
  options: WritingTaskOptions;
  userPrompt?: string;
  signal?: AbortSignal;
}) => {
  const payload = normalizeIllustrationPayload(
    await fetchJson<IllustrationPayload>(
      '/api/article-illustrations/regenerate-slot',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal,
        body: JSON.stringify({
          apiKey: getRuntimeApiKey(),
          sourceHash,
          slotId,
          articleContent,
          bundle,
          styleProfile: options.styleProfile,
          plannerModel: getPlannerModel(),
          imageModel: 'gemini-3-pro-image-preview',
          userPrompt: String(userPrompt || '').trim(),
        }),
      },
      REGENERATE_TIMEOUT_MS
    )
  );

  if (!payload.bundle) {
    throw new Error('后端没有返回更新后的配图结果。');
  }

  return payload.bundle;
};

export const regenerateIllustrationCaption = async ({
  sourceHash,
  slotId,
  articleContent,
  bundle,
  userPrompt,
  signal,
}: {
  sourceHash: string;
  slotId: string;
  articleContent: string;
  bundle: ArticleIllustrationBundle;
  userPrompt?: string;
  signal?: AbortSignal;
}) => {
  const payload = normalizeIllustrationPayload(
    await fetchJson<IllustrationPayload>(
      '/api/article-illustrations/regenerate-caption',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal,
        body: JSON.stringify({
          apiKey: getRuntimeApiKey(),
          sourceHash,
          slotId,
          articleContent,
          bundle,
          plannerModel: getPlannerModel(),
          userPrompt: String(userPrompt || '').trim(),
        }),
      },
      CAPTION_TIMEOUT_MS
    )
  );

  if (!payload.bundle) {
    throw new Error('后端没有返回更新后的图释结果。');
  }

  return payload.bundle;
};

export const deleteIllustrationSlotImage = ({
  bundle,
  slotId,
}: {
  bundle: ArticleIllustrationBundle;
  slotId: string;
}) => {
  const slot = bundle.slots.find((item) => item.id === slotId);
  if (!slot) return bundle;

  const versions = toAssetArray(bundle.assetVersions?.[slot.id]);
  if (versions.length === 0) return bundle;

  const activeIndex = Math.max(0, versions.findIndex((asset) => asset.id === slot.activeAssetId));
  const nextVersions = versions.filter((_, index) => index !== activeIndex);

  return normalizeIllustrationBundle(
    rebuildBundle({
      ...bundle,
      assetVersions: {
        ...bundle.assetVersions,
        [slot.id]: nextVersions,
      },
    })
  )!;
};

export const switchIllustrationSlotVersion = ({
  bundle,
  slotId,
  direction,
}: {
  bundle: ArticleIllustrationBundle;
  slotId: string;
  direction: 'previous' | 'next';
}) => {
  const slot = bundle.slots.find((item) => item.id === slotId);
  if (!slot) return bundle;

  const versions = toAssetArray(bundle.assetVersions?.[slot.id]);
  if (versions.length <= 1) return bundle;

  const currentIndex = Math.max(0, versions.findIndex((asset) => asset.id === slot.activeAssetId));
  const nextIndex =
    direction === 'previous'
      ? Math.max(0, currentIndex - 1)
      : Math.min(versions.length - 1, currentIndex + 1);

  return normalizeIllustrationBundle(
    rebuildBundle({
      ...bundle,
      slots: bundle.slots.map((item) =>
        item.id === slot.id
          ? {
              ...item,
              activeAssetId: versions[nextIndex]?.id,
            }
          : item
      ),
    })
  )!;
};
