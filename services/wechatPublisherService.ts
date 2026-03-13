import type {
  ArticleIllustrationBundle,
  WechatDraftRecord,
  WechatLayoutSettings,
  WechatRenderPlan,
  WechatPreviewMetadata,
  WechatPublisherConfigStatus,
} from '../types';
import { getStoredGeminiApiKey } from './geminiService';
import { resolveBackendUrl } from './runtimeConfig';

interface WechatPreviewPayload {
  previewHtml: string;
  metadata: WechatPreviewMetadata;
  warnings?: string[];
  renderPlan?: WechatRenderPlan;
}

interface WechatDraftUpsertPayload extends WechatPreviewPayload {
  draft: WechatDraftRecord;
}

interface WechatDraftGetPayload {
  mediaId: string;
  article?: any;
  updatedAt?: string;
}

interface WechatPublishSubmitPayload {
  publishId: string;
  msgDataId?: string;
}

interface WechatPublishStatusPayload {
  publishId: string;
  status: string;
  articleUrl?: string;
  payload?: any;
}

export class WechatPublisherApiError extends Error {
  code?: string;
  details?: string[];

  constructor(message: string, options?: { code?: string; details?: string[] }) {
    super(message);
    this.name = 'WechatPublisherApiError';
    this.code = options?.code;
    this.details = options?.details;
  }
}

const fetchJson = async <T>(input: string, init?: RequestInit): Promise<T> => {
  const response = await fetch(resolveBackendUrl(input), init);
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const typedPayload = payload as { error?: string; code?: string; details?: string[] };
    throw new WechatPublisherApiError(String(typedPayload.error || `${response.status} ${response.statusText}`), {
      code: typedPayload.code,
      details: Array.isArray(typedPayload.details) ? typedPayload.details : undefined,
    });
  }
  return payload as T;
};

export const getWechatPublisherConfig = () =>
  fetchJson<WechatPublisherConfigStatus>('/api/wechat-official/config', {
    method: 'GET',
  });

export const previewWechatDraft = ({
  topic,
  articleContent,
  illustrationBundle,
  layout,
  renderPlan,
}: {
  topic: string;
  articleContent: string;
  illustrationBundle?: ArticleIllustrationBundle;
  layout: WechatLayoutSettings;
  renderPlan?: WechatRenderPlan;
}) =>
  fetchJson<WechatPreviewPayload>('/api/wechat-official/preview', {
    method: 'POST',
    cache: 'no-store',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      topic,
      articleContent,
      illustrationBundle,
      layout,
      apiKey: getStoredGeminiApiKey() || undefined,
      renderPlan,
    }),
  });

export const upsertWechatDraft = ({
  topic,
  articleContent,
  illustrationBundle,
  layout,
  mediaId,
  renderPlan,
}: {
  topic: string;
  articleContent: string;
  illustrationBundle?: ArticleIllustrationBundle;
  layout: WechatLayoutSettings;
  mediaId?: string;
  renderPlan?: WechatRenderPlan;
}) =>
  fetchJson<WechatDraftUpsertPayload>('/api/wechat-official/draft/upsert', {
    method: 'POST',
    cache: 'no-store',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      topic,
      articleContent,
      illustrationBundle,
      layout,
      mediaId,
      apiKey: getStoredGeminiApiKey() || undefined,
      renderPlan,
    }),
  });

export const getWechatDraft = (mediaId: string) =>
  fetchJson<WechatDraftGetPayload>('/api/wechat-official/draft/get', {
    method: 'POST',
    cache: 'no-store',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mediaId }),
  });

export const submitWechatPublish = (mediaId: string) =>
  fetchJson<WechatPublishSubmitPayload>('/api/wechat-official/publish/submit', {
    method: 'POST',
    cache: 'no-store',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mediaId }),
  });

export const getWechatPublishStatus = (publishId: string) =>
  fetchJson<WechatPublishStatusPayload>('/api/wechat-official/publish/get', {
    method: 'POST',
    cache: 'no-store',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ publishId }),
  });
