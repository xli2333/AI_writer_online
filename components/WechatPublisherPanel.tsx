import React, { useEffect, useMemo, useRef, useState } from 'react';
import type {
  ArticleIllustrationBundle,
  WechatDraftRecord,
  WechatLayoutSettings,
  WechatPublisherConfigStatus,
  WechatRenderPlan,
  WechatStyleReferenceImage,
  WechatTemplateId,
} from '../types';
import {
  WechatPublisherApiError,
  getWechatDraft,
  getWechatPublisherConfig,
  getWechatPublishStatus,
  previewWechatDraft,
  submitWechatPublish,
  upsertWechatDraft,
} from '../services/wechatPublisherService';

const TEMPLATE_OPTIONS: Array<{ id: WechatTemplateId; label: string; description: string }> = [
  { id: 'latepost_report', label: '晚点报道版', description: '克制留白、蓝灰标题条，适合报道和公司观察。' },
  { id: 'insight_brief', label: '商业简报版', description: '更强调信息卡片和结论前置，适合观点拆解。' },
  { id: 'warm_column', label: '专栏长文版', description: '更柔和，适合人物、案例和长叙事。' },
];

const createDefaultLayout = (
  config?: Partial<WechatPublisherConfigStatus> | null,
  previous?: WechatLayoutSettings,
  illustrationBundle?: ArticleIllustrationBundle
): WechatLayoutSettings => ({
  templateId: previous?.templateId || config?.defaultTemplateId || 'latepost_report',
  author: previous?.author || config?.defaultAuthor || 'AI Writer',
  editor: previous?.editor || '',
  creditLines: previous?.creditLines || [],
  digest: previous?.digest || '',
  contentSourceUrl: previous?.contentSourceUrl || '',
  coverStrategy: previous?.coverStrategy || 'hero',
  preferredCoverAssetId:
    previous?.preferredCoverAssetId ||
    illustrationBundle?.assets?.[0]?.id ||
    undefined,
  openingHighlightMode: previous?.openingHighlightMode || 'smart_lead',
  needOpenComment: previous?.needOpenComment ?? false,
  onlyFansCanComment: previous?.onlyFansCanComment ?? false,
  artDirectionPrompt: previous?.artDirectionPrompt || '',
  styleReferenceImages: previous?.styleReferenceImages || [],
});

const resolveDraftStatusLabel = (draft?: WechatDraftRecord) => {
  switch (draft?.status) {
    case 'draft_ready':
      return '草稿已生成';
    case 'publishing':
      return '发布中';
    case 'published':
      return '已发布';
    case 'error':
      return '异常';
    default:
      return '未提交';
  }
};

type BusyAction = 'preview' | 'draft' | 'draft_get' | 'publish' | 'publish_get';
type PreviewRequestMode = 'standard' | 'feedback';

interface WechatActionErrorViewModel {
  title: string;
  message: string;
  details: string[];
  rawMessage: string;
}

const RELAYOUT_FEEDBACK_EXAMPLES = [
  '\u4f8b\uff1a\u4e8c\u7ea7\u6807\u9898\u6536\u655b\u4e00\u70b9\uff0c\u51cf\u5c11\u7ea2\u8272\u5f3a\u8c03\u3002',
  '\u4f8b\uff1a\u9996\u5c4f\u7559\u767d\u518d\u5927\u4e00\u70b9\uff0c\u56fe\u6ce8\u66f4\u50cf\u5546\u4e1a\u6742\u5fd7\u3002',
  '\u4f8b\uff1a\u6570\u636e\u6bb5\u843d\u505a\u6210\u4fe1\u606f\u5361\uff0c\u4f46\u4e0d\u8981\u6539\u5199\u539f\u6587\u3002',
];

const STYLE_REFERENCE_ACCEPT = 'image/png,image/jpeg,image/webp';
const STYLE_REFERENCE_LIMIT = 3;
const STYLE_REFERENCE_MAX_BYTES = 4 * 1024 * 1024;

const readFileAsDataUrl = (file: File) =>
  new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(new Error(`Failed to read image: ${file.name}`));
    reader.readAsDataURL(file);
  });

const createStyleReferenceImage = async (file: File): Promise<WechatStyleReferenceImage> => ({
  id:
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
  name: file.name,
  mimeType: file.type,
  dataUrl: await readFileAsDataUrl(file),
});

const BUSY_ACTION_STAGES: Record<
  BusyAction,
  {
    title: string;
    subtitle: string;
    slowHint: string;
    stages: Array<{ label: string; detail: string; durationMs: number }>;
  }
> = {
  preview: {
    title: '正在生成公众号预览',
    subtitle: '系统会先整理正文块，再应用排版方案，最后输出预览 HTML。',
    slowHint: '如果这一阶段长时间不结束，通常是排版方案生成或服务端渲染卡住了。',
    stages: [
      { label: '解析正文', detail: '切分段落、标题、列表、表格和配图锚点。', durationMs: 1200 },
      { label: '应用排版方案', detail: '选择标题样式、重点句、图片样式和留白。', durationMs: 8000 },
      { label: '生成预览', detail: '渲染最终 HTML 并做一致性诊断。', durationMs: 2500 },
    ],
  },
  draft: {
    title: '正在提交公众号草稿',
    subtitle: '系统会复用当前排版方案，并按微信要求处理图片和草稿内容。',
    slowHint: '如果长时间停在后段，通常是图片上传或微信草稿接口响应慢。',
    stages: [
      { label: '整理正文', detail: '复用或生成当前这版公众号排版方案。', durationMs: 2200 },
      { label: '上传正文配图', detail: '压缩并上传正文中会用到的图片。', durationMs: 7000 },
      { label: '上传封面', detail: '处理封面素材并换取微信素材 ID。', durationMs: 4500 },
      { label: '提交草稿', detail: '把正文 HTML、摘要和封面信息写入草稿箱。', durationMs: 3500 },
    ],
  },
  draft_get: {
    title: '正在刷新草稿状态',
    subtitle: '系统在向微信查询远端草稿摘要与更新时间。',
    slowHint: '如果这里卡住，多半是微信接口或网络慢。',
    stages: [
      { label: '查询远端草稿', detail: '根据 media_id 请求草稿内容。', durationMs: 1800 },
      { label: '同步面板状态', detail: '更新本地草稿摘要和时间。', durationMs: 1000 },
    ],
  },
  publish: {
    title: '正在提交发布任务',
    subtitle: '系统会把当前草稿提交给公众号发布队列。',
    slowHint: '如果这一阶段异常，通常是微信凭证或发布接口权限问题。',
    stages: [
      { label: '提交发布', detail: '调用公众号发布接口创建 publish_id。', durationMs: 2500 },
      { label: '等待受理', detail: '同步返回的任务 ID 并更新面板状态。', durationMs: 1500 },
    ],
  },
  publish_get: {
    title: '正在刷新发布状态',
    subtitle: '系统在查询公众号后台是否已经生成可访问文章链接。',
    slowHint: '如果状态刷新很久还没结果，可能是公众号后台还在审核或排队。',
    stages: [
      { label: '查询发布队列', detail: '根据 publish_id 请求最新状态。', durationMs: 2200 },
      { label: '同步文章链接', detail: '如果已发布，更新文章访问地址。', durationMs: 1200 },
    ],
  },
};

const buildWechatActionError = (error: unknown, action: BusyAction): WechatActionErrorViewModel => {
  const rawMessage = error instanceof Error ? error.message : String(error || '');
  const details =
    error instanceof WechatPublisherApiError && Array.isArray(error.details)
      ? error.details
      : Array.isArray((error as { details?: string[] } | null | undefined)?.details)
        ? ((error as { details?: string[] }).details || [])
        : [];

  if ((error instanceof WechatPublisherApiError && error.code === 'WECHAT_RENDER_TEXT_DIVERGED') || rawMessage.includes('Rendered WeChat block text diverged')) {
    return {
      title: '排版文本校验未通过',
      message: '服务端发现某个区块在排版后与源文本不一致，因此主动拦截了这次请求。正文不会自动改写。',
      details:
        details.length > 0
          ? details
          : ['这通常是某种样式组合触发了文本一致性校验。', '重新生成预览前，正文内容本身不会被系统改写。'],
      rawMessage,
    };
  }

  if (/invalid credential|access_token is invalid|api unauthorized/i.test(rawMessage)) {
    return {
      title: '公众号凭证不可用',
      message: '微信接口拒绝了这次请求，通常是 AppSecret、access_token 或账号权限有问题。',
      details: ['先确认当前服务端环境变量和公众号后台权限。', '如果刚改过凭证，重启后端再试一次。'],
      rawMessage,
    };
  }

  if (/timed out/i.test(rawMessage)) {
    return {
      title: '请求超时',
      message: '这次公众号操作等待时间过长，被服务端主动终止了。',
      details: ['先重试一次。', '如果经常超时，重点检查模型调用、图片上传或微信接口响应时间。'],
      rawMessage,
    };
  }

  return {
    title: action === 'preview' ? '公众号预览生成失败' : action === 'draft' ? '公众号草稿提交失败' : '公众号操作失败',
    message: rawMessage || '请求失败。',
    details,
    rawMessage,
  };
};

const resolveBusyStageIndex = (action: BusyAction, elapsedMs: number) => {
  const stages = BUSY_ACTION_STAGES[action].stages;
  let remaining = elapsedMs;
  for (let index = 0; index < stages.length; index += 1) {
    remaining -= stages[index].durationMs;
    if (remaining < 0) {
      return index;
    }
  }
  return stages.length - 1;
};

export const WechatPublisherPanel: React.FC<{
  topic: string;
  articleContent: string;
  illustrationBundle?: ArticleIllustrationBundle;
  layout?: WechatLayoutSettings;
  draft?: WechatDraftRecord;
  onUpdateLayout: (layout: WechatLayoutSettings) => void;
  onUpdateDraft: (draft?: WechatDraftRecord) => void;
}> = ({ topic, articleContent, illustrationBundle, layout, draft, onUpdateLayout, onUpdateDraft }) => {
  const draftSubmissionPassword = String(import.meta.env.VITE_WECHAT_DRAFT_PASSWORD || '').trim();
  const [config, setConfig] = useState<WechatPublisherConfigStatus | null>(null);
  const [configError, setConfigError] = useState<string | null>(null);
  const [previewHtml, setPreviewHtml] = useState('');
  const [previewWarnings, setPreviewWarnings] = useState<string[]>([]);
  const [previewRendererVersion, setPreviewRendererVersion] = useState<string>('');
  const [renderPlan, setRenderPlan] = useState<WechatRenderPlan | undefined>();
  const [previewFrameVersion, setPreviewFrameVersion] = useState(0);
  const [appliedArtDirectionPrompt, setAppliedArtDirectionPrompt] = useState('');
  const [previewPlanHash, setPreviewPlanHash] = useState('');
  const [remoteDraftInfo, setRemoteDraftInfo] = useState<any>(null);
  const [busyAction, setBusyAction] = useState<BusyAction | null>(null);
  const [actionError, setActionError] = useState<WechatActionErrorViewModel | null>(null);
  const [busyStartedAt, setBusyStartedAt] = useState<number | null>(null);
  const [busyNow, setBusyNow] = useState<number>(Date.now());
  const [artDirectionDraft, setArtDirectionDraft] = useState(layout?.artDirectionPrompt || '');
  const [styleReferenceError, setStyleReferenceError] = useState<string | null>(null);
  const [previewRequestMode, setPreviewRequestMode] = useState<PreviewRequestMode>('standard');
  const initializedRef = useRef(false);
  const lastPreviewFingerprintRef = useRef('');
  const artDirectionDraftRef = useRef(layout?.artDirectionPrompt || '');

  useEffect(() => {
    let cancelled = false;
    void getWechatPublisherConfig()
      .then((payload) => {
        if (cancelled) return;
        setConfig(payload);
        setConfigError(null);
      })
      .catch((error: any) => {
        if (cancelled) return;
        setConfigError(error?.message || '公众号配置读取失败。');
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (initializedRef.current) return;
    if (layout) {
      initializedRef.current = true;
      return;
    }
    onUpdateLayout(createDefaultLayout(config, undefined, illustrationBundle));
    initializedRef.current = true;
  }, [config, illustrationBundle, layout, onUpdateLayout]);

  const currentLayout = useMemo(
    () => createDefaultLayout(config, layout, illustrationBundle),
    [config, illustrationBundle, layout]
  );

  const requestImageFingerprint = useMemo(
    () =>
      illustrationBundle?.slots?.map((slot) => {
          const versions = illustrationBundle.assetVersions?.[slot.id] || [];
          const activeAsset = versions.find((asset) => asset.id === slot.activeAssetId) || versions[versions.length - 1];
          return {
            slotId: slot.id,
            activeAssetId: activeAsset?.id,
            url: activeAsset?.url,
            caption: activeAsset?.editorCaption || slot.explanation || slot.purpose || '',
            order: slot.order,
          };
        }),
    [illustrationBundle]
  );

  const coverCandidates = useMemo(() => {
    if (!illustrationBundle?.slots?.length || !illustrationBundle.assetVersions) return [];
    return illustrationBundle.slots
      .slice()
      .sort((left, right) => left.order - right.order)
      .map((slot) => {
        const versions = illustrationBundle.assetVersions?.[slot.id] || [];
        const activeAsset = versions.find((asset) => asset.id === slot.activeAssetId) || versions[versions.length - 1];
        if (!activeAsset) return null;
        return {
          assetId: activeAsset.id,
          label: `${slot.order}. ${slot.title || activeAsset.title}`,
        };
      })
      .filter(Boolean) as Array<{ assetId: string; label: string }>;
  }, [illustrationBundle]);

  const updateLayout = (patch: Partial<WechatLayoutSettings>) => {
    onUpdateLayout({
      ...currentLayout,
      ...patch,
    });
  };

  useEffect(() => {
    const nextDraft = currentLayout.artDirectionPrompt || '';
    setArtDirectionDraft((previous) => (previous === nextDraft ? previous : nextDraft));
    artDirectionDraftRef.current = nextDraft;
  }, [currentLayout.artDirectionPrompt]);

  const buildLayoutSnapshot = (): WechatLayoutSettings => ({
    ...currentLayout,
    artDirectionPrompt: artDirectionDraftRef.current,
  });

  const buildRequestFingerprint = (layoutSnapshot: WechatLayoutSettings) =>
    JSON.stringify({
      topic: topic.trim(),
      articleContent: articleContent.trim(),
      layout: layoutSnapshot,
      images: requestImageFingerprint,
    });

  const resolveReusableRenderPlan = (requestFingerprint: string) =>
    lastPreviewFingerprintRef.current === requestFingerprint ? renderPlan : undefined;

  const styleReferenceImages = currentLayout.styleReferenceImages || [];
  const previewBeautyAgentUsed = Boolean(renderPlan?.beautyAgent?.used);
  const previewFrameKey = `wechat-preview-${previewFrameVersion}-${previewPlanHash || 'no-plan'}`;

  const handleArtDirectionPromptChange = (event: React.ChangeEvent<HTMLTextAreaElement>) => {
    const nextValue = event.target.value;
    setArtDirectionDraft(nextValue);
    artDirectionDraftRef.current = nextValue;
    updateLayout({ artDirectionPrompt: nextValue });
  };

  const handleArtDirectionExampleClick = (example: string) => {
    setArtDirectionDraft(example);
    artDirectionDraftRef.current = example;
    updateLayout({ artDirectionPrompt: example });
  };

  const handleStyleReferenceUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files || []);
    event.target.value = '';
    if (!files.length) {
      return;
    }

    const slotsRemaining = Math.max(0, STYLE_REFERENCE_LIMIT - styleReferenceImages.length);
    if (slotsRemaining <= 0) {
      setStyleReferenceError(`最多上传 ${STYLE_REFERENCE_LIMIT} 张样式参考图。`);
      return;
    }

    const validFiles = files
      .filter((file) => STYLE_REFERENCE_ACCEPT.split(',').includes(file.type))
      .filter((file) => file.size <= STYLE_REFERENCE_MAX_BYTES)
      .slice(0, slotsRemaining);

    if (!validFiles.length) {
      setStyleReferenceError('只支持 PNG / JPG / WEBP，且单张不超过 4MB。');
      return;
    }

    try {
      const nextImages = await Promise.all(validFiles.map((file) => createStyleReferenceImage(file)));
      updateLayout({
        styleReferenceImages: [...styleReferenceImages, ...nextImages],
      });
      setStyleReferenceError(null);
    } catch (error: any) {
      setStyleReferenceError(error?.message || '样式参考图读取失败。');
    }
  };

  const handleRemoveStyleReference = (referenceId: string) => {
    updateLayout({
      styleReferenceImages: styleReferenceImages.filter((item) => item.id !== referenceId),
    });
    setStyleReferenceError(null);
  };

  const hasArtDirectionFeedback = artDirectionDraft.trim().length > 0;
  const currentBusyPresentation = busyAction ? BUSY_ACTION_STAGES[busyAction] : null;
  const busyElapsedMs = busyAction && busyStartedAt ? Math.max(0, busyNow - busyStartedAt) : 0;
  const busyStageIndex = busyAction ? resolveBusyStageIndex(busyAction, busyElapsedMs) : 0;
  const standardPreviewButtonLabel =
    busyAction === 'preview' && previewRequestMode === 'standard'
      ? '\u751f\u6210\u4e2d...'
      : '\u6309\u5f53\u524d\u8bbe\u7f6e\u751f\u6210\u9884\u89c8';
  const feedbackRelayoutButtonLabel =
    busyAction === 'preview' && previewRequestMode === 'feedback'
      ? '\u91cd\u6392\u4e2d...'
      : '\u6309\u53cd\u9988\u91cd\u65b0\u6392\u7248';

  useEffect(() => {
    if (!busyAction) {
      setBusyStartedAt(null);
      return;
    }
    setBusyStartedAt((previous) => previous ?? Date.now());
    setBusyNow(Date.now());
    const timer = window.setInterval(() => setBusyNow(Date.now()), 400);
    return () => window.clearInterval(timer);
  }, [busyAction]);

  const handlePreview = async (mode: PreviewRequestMode = 'standard') => {
    const layoutSnapshot = buildLayoutSnapshot();
    const requestFingerprint = buildRequestFingerprint(layoutSnapshot);
    const reusableRenderPlan = mode === 'feedback' ? undefined : resolveReusableRenderPlan(requestFingerprint);
    const previousPlanHash = renderPlan?.beautyAgent?.planHash || '';
    setPreviewRequestMode(mode);
    setBusyAction('preview');
    setActionError(null);
    try {
      const payload = await previewWechatDraft({
        topic,
        articleContent,
        illustrationBundle,
        layout: layoutSnapshot,
        renderPlan: reusableRenderPlan,
      });
      const nextRenderPlan = payload.renderPlan || payload.metadata.renderPlan || reusableRenderPlan;
      const nextPlanHash = nextRenderPlan?.beautyAgent?.planHash || '';
      const nextWarnings = [...(payload.warnings || payload.metadata.warnings || [])];
      if (mode === 'feedback' && nextRenderPlan && previousPlanHash && nextPlanHash === previousPlanHash) {
        nextWarnings.push('本次“按反馈重新排版”已经重新请求，但返回的排版方案与上一版完全一致。更像是模型没有产出新方案，不是前端没发请求。');
      }
      if (mode === 'feedback' && nextRenderPlan && !nextRenderPlan.beautyAgent?.used) {
        nextWarnings.push('本次“按反馈重新排版”未启用 AI 重排，当前看到的是基础排版回退结果。');
      }
      setPreviewHtml(payload.previewHtml);
      setPreviewWarnings(nextWarnings);
      setPreviewRendererVersion(payload.metadata.rendererVersion || 'legacy_or_unknown');
      setRenderPlan(nextRenderPlan);
      setPreviewPlanHash(nextPlanHash);
      setAppliedArtDirectionPrompt(layoutSnapshot.artDirectionPrompt || '');
      setPreviewFrameVersion((previous) => previous + 1);
      lastPreviewFingerprintRef.current = requestFingerprint;
    } catch (error: any) {
      setActionError(buildWechatActionError(error, 'preview'));
    } finally {
      setBusyAction(null);
    }
  };

  const handleUpsertDraft = async () => {
    if (!draftSubmissionPassword) {
      setActionError({
        title: '草稿口令未配置',
        message: '前端没有检测到提交草稿箱所需的口令环境变量，当前已阻止提交。',
        details: ['请在 Vercel 中配置 VITE_WECHAT_DRAFT_PASSWORD，然后重新部署前端。'],
        rawMessage: 'Missing VITE_WECHAT_DRAFT_PASSWORD.',
      });
      return;
    }

    const providedPassword = window.prompt('请输入提交公众号草稿箱口令');
    if (providedPassword === null) {
      return;
    }
    if (providedPassword !== draftSubmissionPassword) {
      setActionError({
        title: '草稿口令错误',
        message: '口令校验未通过，已取消本次提交草稿箱操作。',
        details: [],
        rawMessage: 'Draft submission password mismatch.',
      });
      return;
    }

    const layoutSnapshot = buildLayoutSnapshot();
    const requestFingerprint = buildRequestFingerprint(layoutSnapshot);
    const reusableRenderPlan = resolveReusableRenderPlan(requestFingerprint);

    setBusyAction('draft');
    setActionError(null);
    try {
      const payload = await upsertWechatDraft({
        topic,
        articleContent,
        illustrationBundle,
        layout: layoutSnapshot,
        mediaId: draft?.mediaId,
        renderPlan: reusableRenderPlan,
      });
      const nextRenderPlan = payload.renderPlan || payload.metadata.renderPlan || reusableRenderPlan;
      const nextPlanHash = nextRenderPlan?.beautyAgent?.planHash || '';
      setPreviewHtml(payload.previewHtml);
      setPreviewWarnings(payload.warnings || payload.metadata.warnings || []);
      setPreviewRendererVersion(payload.metadata.rendererVersion || 'legacy_or_unknown');
      setRenderPlan(nextRenderPlan);
      setPreviewPlanHash(nextPlanHash);
      setAppliedArtDirectionPrompt(layoutSnapshot.artDirectionPrompt || '');
      setPreviewFrameVersion((previous) => previous + 1);
      lastPreviewFingerprintRef.current = requestFingerprint;
      onUpdateDraft(payload.draft);
    } catch (error: any) {
      const normalizedError = buildWechatActionError(error, 'draft');
      setActionError(normalizedError);
      onUpdateDraft({
        ...(draft || { status: 'error' }),
        status: 'error',
        error: normalizedError.rawMessage,
      });
    } finally {
      setBusyAction(null);
    }
  };

  const handleRefreshDraft = async () => {
    if (!draft?.mediaId) return;
    setBusyAction('draft_get');
    setActionError(null);
    try {
      const payload = await getWechatDraft(draft.mediaId);
      setRemoteDraftInfo(payload.article || null);
      onUpdateDraft({
        ...draft,
        status: 'draft_ready',
        draftUpdatedAt: payload.updatedAt || new Date().toISOString(),
      });
    } catch (error: any) {
      setActionError(buildWechatActionError(error, 'draft_get'));
    } finally {
      setBusyAction(null);
    }
  };

  const handlePublish = async () => {
    if (!draft?.mediaId) return;
    setBusyAction('publish');
    setActionError(null);
    try {
      const payload = await submitWechatPublish(draft.mediaId);
      onUpdateDraft({
        ...draft,
        status: 'publishing',
        publishId: payload.publishId,
        error: undefined,
      });
    } catch (error: any) {
      const normalizedError = buildWechatActionError(error, 'publish');
      setActionError(normalizedError);
      onUpdateDraft({
        ...(draft || { status: 'error' }),
        status: 'error',
        error: normalizedError.rawMessage,
      });
    } finally {
      setBusyAction(null);
    }
  };

  const handleRefreshPublish = async () => {
    if (!draft?.publishId) return;
    setBusyAction('publish_get');
    setActionError(null);
    try {
      const payload = await getWechatPublishStatus(draft.publishId);
      onUpdateDraft({
        ...draft,
        status: payload.articleUrl ? 'published' : 'publishing',
        articleUrl: payload.articleUrl || draft.articleUrl,
        publishedAt: payload.articleUrl ? new Date().toISOString() : draft.publishedAt,
        error: undefined,
      });
    } catch (error: any) {
      setActionError(buildWechatActionError(error, 'publish_get'));
    } finally {
      setBusyAction(null);
    }
  };

  return (
    <section className="relative rounded-[28px] border border-slate-200 bg-white p-6 shadow-sm sm:p-8">
      <div className="mb-6 border-b border-slate-100 pb-5">
        <h2 className="font-serif text-2xl font-bold text-slate-900">公众号</h2>
        <p className="mt-2 text-sm leading-relaxed text-slate-500">
          统一排版引擎、图片压缩上传、提交公众号草稿箱，最后由人工审核后再发布。
        </p>
      </div>

      <div className="grid gap-6 xl:grid-cols-[minmax(0,380px)_minmax(0,1fr)]">
        <div className="space-y-5">
          <div className="rounded-2xl border border-slate-200 bg-slate-50 p-5">
            <div className="flex items-center justify-between gap-4">
              <div>
                <div className="text-xs font-bold uppercase tracking-wider text-slate-400">配置状态</div>
                <div className="mt-2 text-sm text-slate-700">
                  {config?.configured ? '服务端已配置公众号凭证' : '当前仅能预览，未检测到完整公众号凭证'}
                </div>
              </div>
              <div className="rounded-full bg-white px-3 py-1 text-xs font-semibold text-slate-600">
                {resolveDraftStatusLabel(draft)}
              </div>
            </div>
            {config?.missingKeys?.length ? (
              <div className="mt-3 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
                缺少环境变量：{config.missingKeys.join(', ')}
              </div>
            ) : null}
            {configError ? (
              <div className="mt-3 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
                {configError}
              </div>
            ) : null}
          </div>

          <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
            <div className="text-sm font-semibold text-slate-900">{'\u7edf\u4e00\u5fae\u4fe1\u6392\u7248\u6a21\u5f0f'}</div>
            <div className="mt-2 text-sm leading-relaxed text-slate-500">{'\u4e0d\u518d\u624b\u52a8\u5207\u6a21\u677f\uff0c\u7531 AI \u6839\u636e\u6587\u7ae0\u5185\u5bb9\u81ea\u52a8\u9009\u62e9\u6700\u5408\u9002\u7684\u6807\u9898\u3001\u91cd\u70b9\u53e5\u3001\u56fe\u7247\u548c\u7559\u767d\u5904\u7406\u3002'}</div>
          </div>
          <div className="grid gap-4 sm:grid-cols-3">
            <label className="block text-sm font-medium text-slate-700">
              {'\u4f5c\u8005'}
              <input
                value={currentLayout.author}
                onChange={(event) => updateLayout({ author: event.target.value })}
                className="mt-2 w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700 outline-none focus:border-report-accent"
              />
            </label>
            <label className="block text-sm font-medium text-slate-700">
              {'\u7f16\u8f91'}
              <input
                value={currentLayout.editor || ''}
                onChange={(event) => updateLayout({ editor: event.target.value })}
                className="mt-2 w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700 outline-none focus:border-report-accent"
              />
            </label>
            <label className="block text-sm font-medium text-slate-700">
              {'\u5c01\u9762\u7b56\u7565'}
              <select
                value={currentLayout.coverStrategy}
                onChange={(event) =>
                  updateLayout({
                    coverStrategy: event.target.value as WechatLayoutSettings['coverStrategy'],
                  })
                }
                className="mt-2 w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700 outline-none focus:border-report-accent"
              >
                <option value="hero">{'\u4f18\u5148\u9996\u56fe'}</option>
                <option value="first_ready">{'\u7b2c\u4e00\u5f20\u53ef\u7528\u56fe'}</option>
                <option value="manual">{'\u624b\u52a8\u6307\u5b9a'}</option>
              </select>
            </label>
          </div>

          {currentLayout.coverStrategy === 'manual' && coverCandidates.length > 0 ? (
            <label className="block text-sm font-medium text-slate-700">
              {'\u624b\u52a8\u5c01\u9762'}
              <select
                value={currentLayout.preferredCoverAssetId || ''}
                onChange={(event) => updateLayout({ preferredCoverAssetId: event.target.value || undefined })}
                className="mt-2 w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700 outline-none focus:border-report-accent"
              >
                {coverCandidates.map((candidate) => (
                  <option key={candidate.assetId} value={candidate.assetId}>
                    {candidate.label}
                  </option>
                ))}
              </select>
            </label>
          ) : null}

          <label className="block text-sm font-medium text-slate-700">
            {'\u6b63\u6587\u524d\u7f6e\u4fe1\u606f'}
            <textarea
              value={(currentLayout.creditLines || []).join('\n')}
              onChange={(event) =>
                updateLayout({
                  creditLines: event.target.value
                    .split('\n')
                    .map((line) => line.trim())
                    .filter(Boolean),
                })
              }
              rows={4}
              className="mt-2 w-full rounded-2xl border border-slate-200 bg-white px-3 py-3 text-sm leading-relaxed text-slate-700 outline-none focus:border-report-accent"
              placeholder={'\u6bcf\u884c\u4e00\u6761\u8865\u5145\u4fe1\u606f\uff0c\u4f8b\u5982\u4f5c\u8005\u5355\u4f4d\u3001\u91c7\u8bbf\u8bf4\u660e\u3001\u9879\u76ee\u5757\u7b49\u3002'}
            />
          </label>

          <label className="block text-sm font-medium text-slate-700">
            {'\u5f00\u5934\u5f15\u8a00\u5f3a\u8c03'}
            <select
              value={currentLayout.openingHighlightMode}
              onChange={(event) =>
                updateLayout({
                  openingHighlightMode: event.target.value as WechatLayoutSettings['openingHighlightMode'],
                })
              }
              className="mt-2 w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700 outline-none focus:border-report-accent"
            >
              <option value="smart_lead">{'\u667a\u80fd\u524d\u4e24\u53e5'}</option>
              <option value="first_sentence">{'\u53ea\u5f3a\u8c03\u9996\u53e5'}</option>
              <option value="off">{'\u5173\u95ed'}</option>
            </select>
            <div className="mt-2 text-xs leading-relaxed text-slate-500">
              {'\u5728\u6b63\u6587\u6700\u524d\u9762\u989d\u5916\u63d2\u5165\u4e00\u4e2a\u5f15\u8a00\u5361\u7247\uff0c\u4e0d\u6539\u5199\u539f\u6587\uff0c\u53ea\u505a\u5f00\u573a\u5f3a\u8c03\u3002'}
            </div>
          </label>

          <label className="block text-sm font-medium text-slate-700">
            {'\u6458\u8981'}
            <textarea
              value={currentLayout.digest}
              onChange={(event) => updateLayout({ digest: event.target.value })}
              rows={4}
              className="mt-2 w-full rounded-2xl border border-slate-200 bg-white px-3 py-3 text-sm leading-relaxed text-slate-700 outline-none focus:border-report-accent"
              placeholder={'\u7559\u7a7a\u4f1a\u81ea\u52a8\u53d6\u6b63\u6587\u524d\u4e24\u6bb5\u751f\u6210\u6458\u8981\u3002'}
            />
          </label>

          <label className="block text-sm font-medium text-slate-700">
            {'\u539f\u6587\u94fe\u63a5'}
            <input
              value={currentLayout.contentSourceUrl}
              onChange={(event) => updateLayout({ contentSourceUrl: event.target.value })}
              className="mt-2 w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700 outline-none focus:border-report-accent"
              placeholder="https://..."
            />
          </label>

          <div className="grid gap-3 sm:grid-cols-2">
            <label className="flex items-center gap-3 rounded-2xl border border-slate-200 px-4 py-3 text-sm text-slate-700">
              <input
                type="checkbox"
                checked={currentLayout.needOpenComment}
                onChange={(event) => updateLayout({ needOpenComment: event.target.checked })}
              />
              开启评论
            </label>
            <label className="flex items-center gap-3 rounded-2xl border border-slate-200 px-4 py-3 text-sm text-slate-700">
              <input
                type="checkbox"
                checked={currentLayout.onlyFansCanComment}
                disabled={!currentLayout.needOpenComment}
                onChange={(event) => updateLayout({ onlyFansCanComment: event.target.checked })}
              />
              仅粉丝可评论
            </label>
          </div>

          {actionError ? (
            <div className="rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm leading-relaxed text-red-700">
              <div className="font-semibold text-red-800">{actionError.title}</div>
              <div className="mt-1">{actionError.message}</div>
              {actionError.details.length > 0 ? (
                <div className="mt-3 space-y-1 text-[13px] text-red-700">
                  {actionError.details.map((detail, index) => (
                    <div key={`${detail}-${index}`}>{detail}</div>
                  ))}
                </div>
              ) : null}
              <div className="mt-3 text-[12px] text-red-600/90">原始报错：{actionError.rawMessage}</div>
            </div>
          ) : null}

          {previewWarnings.length > 0 ? (
            <div className="rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm leading-relaxed text-amber-800">
              <div className="font-semibold text-amber-900">排版提示</div>
              <div className="mt-2 space-y-1">
                {previewWarnings.map((warning, index) => (
                  <div key={`${warning}-${index}`}>{warning}</div>
                ))}
              </div>
            </div>
          ) : null}

          <div className="flex flex-wrap gap-3">
            <button
              onClick={() => void handlePreview('standard')}
              disabled={busyAction !== null}
              aria-label={standardPreviewButtonLabel}
              className="relative rounded-xl border border-slate-200 bg-white px-4 py-2 text-sm font-medium text-transparent transition-colors hover:bg-slate-50 disabled:opacity-50"
            >
              <span aria-hidden="true" className="pointer-events-none absolute inset-0 flex items-center justify-center px-4 text-sm font-medium text-slate-700">
                {standardPreviewButtonLabel}
              </span>
              {busyAction === 'preview' ? '生成中...' : '生成预览'}
            </button>
            <button
              onClick={() => void handleUpsertDraft()}
              disabled={busyAction !== null || !config?.configured}
              className="rounded-xl bg-report-accent px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-teal-800 disabled:opacity-50"
            >
              {busyAction === 'draft' ? '提交中...' : draft?.mediaId ? '更新草稿' : '提交草稿箱'}
            </button>
            <button
              onClick={() => void handleRefreshDraft()}
              disabled={busyAction !== null || !draft?.mediaId}
              className="rounded-xl border border-slate-200 bg-white px-4 py-2 text-sm font-medium text-slate-700 transition-colors hover:bg-slate-50 disabled:opacity-50"
            >
              {busyAction === 'draft_get' ? '刷新中...' : '刷新草稿状态'}
            </button>
          </div>

          <div className="flex flex-wrap gap-3">
            <button
              onClick={() => void handlePublish()}
              disabled={busyAction !== null || !draft?.mediaId || !config?.publishEnabled}
              className="rounded-xl border border-slate-200 bg-white px-4 py-2 text-sm font-medium text-slate-700 transition-colors hover:bg-slate-50 disabled:opacity-50"
            >
              {busyAction === 'publish' ? '提交中...' : '审核通过后发布'}
            </button>
            <button
              onClick={() => void handleRefreshPublish()}
              disabled={busyAction !== null || !draft?.publishId}
              className="rounded-xl border border-slate-200 bg-white px-4 py-2 text-sm font-medium text-slate-700 transition-colors hover:bg-slate-50 disabled:opacity-50"
            >
              {busyAction === 'publish_get' ? '刷新中...' : '刷新发布状态'}
            </button>
          </div>

          <div className="rounded-2xl border border-slate-200 bg-slate-50 p-5 text-sm leading-relaxed text-slate-600">
            <div>草稿 Media ID: {draft?.mediaId || '未生成'}</div>
            <div className="mt-2">发布任务 ID: {draft?.publishId || '未提交'}</div>
            <div className="mt-2">最新草稿时间: {draft?.draftUpdatedAt || '未记录'}</div>
            {draft?.articleUrl ? (
              <a href={draft.articleUrl} target="_blank" rel="noreferrer" className="mt-3 inline-block text-report-accent underline">
                查看已发布文章
              </a>
            ) : null}
          </div>

          {remoteDraftInfo ? (
            <div className="rounded-2xl border border-slate-200 bg-white p-5 text-sm leading-relaxed text-slate-600">
              <div className="text-xs font-bold uppercase tracking-wider text-slate-400">远端草稿摘要</div>
              <div className="mt-2 font-semibold text-slate-900">{remoteDraftInfo.title || draft?.draftTitle || '未命名草稿'}</div>
              <div className="mt-2">{remoteDraftInfo.digest || '无摘要'}</div>
            </div>
          ) : null}
        </div>

        <div className="rounded-[28px] border border-slate-200 bg-slate-50 p-4">
          <div className="mb-3 flex items-center justify-between gap-4 px-2">
            <div>
              <div className="text-sm font-semibold text-slate-900">公众号预览</div>
              <div className="mt-1 text-sm text-slate-500">先在这里看排版，再提交公众号草稿箱。</div>
            </div>
            <div className="rounded-full bg-white px-3 py-1 text-xs font-medium text-slate-500 ring-1 ring-slate-200">
              渲染引擎：
              {previewRendererVersion
                ? previewRendererVersion === 'legacy_or_unknown'
                  ? '旧后端未返回版本号'
                  : previewRendererVersion
                : '未生成'}
            </div>
          </div>
          {previewHtml ? (
            <div className="mb-3 flex flex-wrap items-center gap-2 px-2 text-xs text-slate-500">
              <span className="rounded-full bg-white px-3 py-1 font-medium ring-1 ring-slate-200">
                AI 重排: {previewBeautyAgentUsed ? '已启用' : '未启用'}
              </span>
              <span className="rounded-full bg-white px-3 py-1 font-medium ring-1 ring-slate-200">
                Plan Hash: {previewPlanHash || 'none'}
              </span>
              <span className="rounded-full bg-white px-3 py-1 font-medium ring-1 ring-slate-200">
                生效反馈: {appliedArtDirectionPrompt || '无'}
              </span>
            </div>
          ) : null}
          <div className="overflow-hidden rounded-[24px] border border-slate-200 bg-white shadow-sm">
            {previewHtml ? (
              <iframe key={previewFrameKey} title="wechat-preview" className="h-[900px] w-full" srcDoc={previewHtml} />
            ) : (
              <div className="flex h-[900px] items-center justify-center px-6 text-center text-sm leading-relaxed text-slate-500">
                先点击“生成预览”，这里会显示公众号模板排版结果。
              </div>
            )}
          </div>
          <div className="mt-4 rounded-[24px] border border-slate-200 bg-white p-5 shadow-sm">
            <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
              <div className="min-w-0">
                <div className="text-sm font-semibold text-slate-900">{'\u9884\u89c8\u53cd\u9988 / AI \u91cd\u6392'}</div>
                <div className="mt-1 text-sm leading-relaxed text-slate-500">
                  {
                    '\u628a\u4f60\u60f3\u8c03\u6574\u7684\u89c6\u89c9\u53cd\u9988\u5199\u5728\u8fd9\u91cc\uff0c\u5185\u5bb9\u4f1a\u4fdd\u5b58\u5230 AI \u6392\u7248\u6307\u4ee4\uff0c\u540e\u7eed\u9884\u89c8\u548c\u63d0\u4ea4\u8349\u7a3f\u90fd\u4f1a\u6cbf\u7528\u3002'
                  }
                </div>
                <div className="mt-2 text-xs leading-relaxed text-slate-400">
                  {
                    '\u53ea\u8c03\u6574\u6807\u9898\u98ce\u683c\uff0c\u5f3a\u8c03\u7a0b\u5ea6\uff0c\u7559\u767d\uff0c\u56fe\u7247/\u56fe\u6ce8\u5448\u73b0\u7b49\u6392\u7248\u8868\u8fbe\uff0c\u4e0d\u4f1a\u6539\u5199\u6b63\u6587\u5185\u5bb9\u3002'
                  }
                </div>
              </div>
              <button
                onClick={() => void handlePreview('feedback')}
                disabled={busyAction !== null || !hasArtDirectionFeedback}
                className="shrink-0 rounded-xl bg-report-accent px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-teal-800 disabled:opacity-50"
              >
                {feedbackRelayoutButtonLabel}
              </button>
            </div>
            <textarea
              value={artDirectionDraft}
              onChange={handleArtDirectionPromptChange}
              rows={5}
              className="mt-4 w-full rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm leading-relaxed text-slate-700 outline-none focus:border-report-accent"
              placeholder={
                '\u4f8b\u5982\uff1a\u4e8c\u7ea7\u6807\u9898\u518d\u514b\u5236\u4e00\u70b9\uff0c\u9996\u5c4f\u7559\u767d\u589e\u52a0\uff0c\u56fe\u6ce8\u66f4\u50cf\u5546\u4e1a\u6742\u5fd7\uff0c\u6570\u636e\u6bb5\u843d\u4f18\u5148\u505a\u6210\u4fe1\u606f\u5361\u3002'
              }
            />
            <div className="mt-4 rounded-2xl border border-dashed border-slate-200 bg-slate-50/70 p-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <div className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-400">{'Style References'}</div>
                  <div className="mt-1 text-sm text-slate-600">
                    {'上传你喜欢的版式截图，让 AI 参考其中的首段强调、标题节奏、图片边框、图注和留白方式。'}
                  </div>
                </div>
                <label className="inline-flex cursor-pointer items-center rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm font-medium text-slate-700 transition-colors hover:bg-slate-100">
                  {'上传参考图'}
                  <input
                    type="file"
                    accept={STYLE_REFERENCE_ACCEPT}
                    multiple
                    className="hidden"
                    onChange={(event) => void handleStyleReferenceUpload(event)}
                  />
                </label>
              </div>
              <div className="mt-2 text-xs leading-relaxed text-slate-400">
                {`最多 ${STYLE_REFERENCE_LIMIT} 张，仅支持 PNG / JPG / WEBP，单张不超过 4MB。`}
              </div>
              {styleReferenceError ? <div className="mt-2 text-xs leading-relaxed text-rose-500">{styleReferenceError}</div> : null}
              {styleReferenceImages.length ? (
                <div className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                  {styleReferenceImages.map((reference, index) => (
                    <div key={reference.id} className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
                      <div className="relative aspect-[4/3] bg-slate-100">
                        <img src={reference.dataUrl} alt={reference.name} className="h-full w-full object-cover" />
                        <button
                          type="button"
                          onClick={() => handleRemoveStyleReference(reference.id)}
                          className="absolute right-2 top-2 rounded-full bg-slate-950/70 px-2 py-1 text-xs font-medium text-white"
                        >
                          {'移除'}
                        </button>
                      </div>
                      <div className="px-3 py-3">
                        <div className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-400">{`Ref ${index + 1}`}</div>
                        <div className="mt-1 truncate text-sm text-slate-600" title={reference.name}>
                          {reference.name}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              ) : null}
            </div>
            <div className="mt-3 flex flex-wrap gap-2">
              {RELAYOUT_FEEDBACK_EXAMPLES.map((example) => (
                <button
                  key={example}
                  type="button"
                  onClick={() => handleArtDirectionExampleClick(example)}
                  className="rounded-full bg-slate-100 px-3 py-1 text-left text-xs leading-5 text-slate-500 transition-colors hover:bg-slate-200"
                >
                  {example}
                </button>
              ))}
            </div>
            <div className="mt-3 text-xs leading-relaxed text-slate-400">
              {
                '\u9700\u8981\u505a\u57fa\u7840\u7248\u9884\u89c8\u65f6\uff0c\u4f7f\u7528\u5de6\u4fa7\u7684\u300c\u6309\u5f53\u524d\u8bbe\u7f6e\u751f\u6210\u9884\u89c8\u300d\uff1b\u9700\u8981\u57fa\u4e8e\u53cd\u9988\u91cd\u65b0\u8c03\u6574\u65f6\uff0c\u5c31\u5728\u8fd9\u91cc\u76f4\u63a5\u91cd\u6392\u3002'
              }
            </div>
          </div>
        </div>
      </div>

      {busyAction && currentBusyPresentation ? (
        <div className="absolute inset-0 z-20 flex items-center justify-center rounded-[28px] bg-slate-950/12 px-4 backdrop-blur-[2px]">
          <div className="w-full max-w-xl rounded-[28px] border border-slate-200 bg-white/95 p-6 shadow-2xl">
            <div className="flex items-start justify-between gap-4">
              <div>
                <div className="text-xs font-bold uppercase tracking-[0.22em] text-report-accent">Processing</div>
                <div className="mt-2 font-serif text-2xl font-bold text-slate-900">{currentBusyPresentation.title}</div>
                <div className="mt-2 text-sm leading-relaxed text-slate-500">{currentBusyPresentation.subtitle}</div>
              </div>
              <div className="shrink-0 rounded-full bg-slate-100 px-3 py-1 text-xs font-semibold text-slate-600">
                {Math.max(1, Math.round(busyElapsedMs / 1000))}s
              </div>
            </div>

            <div className="mt-6 space-y-3">
              {currentBusyPresentation.stages.map((stage, index) => {
                const status = index < busyStageIndex ? 'done' : index === busyStageIndex ? 'active' : 'pending';
                return (
                  <div
                    key={`${busyAction}-${stage.label}`}
                    className={`rounded-2xl border px-4 py-3 transition-colors ${
                      status === 'active'
                        ? 'border-report-accent bg-report-accent-light/60'
                        : status === 'done'
                          ? 'border-emerald-200 bg-emerald-50'
                          : 'border-slate-200 bg-slate-50'
                    }`}
                  >
                    <div className="flex items-center justify-between gap-3">
                      <div className="font-semibold text-slate-900">{stage.label}</div>
                      <div
                        className={`text-xs font-semibold ${
                          status === 'active' ? 'text-report-accent' : status === 'done' ? 'text-emerald-700' : 'text-slate-400'
                        }`}
                      >
                        {status === 'active' ? '进行中' : status === 'done' ? '已完成' : '等待中'}
                      </div>
                    </div>
                    <div className="mt-1 text-sm leading-relaxed text-slate-500">{stage.detail}</div>
                  </div>
                );
              })}
            </div>

            <div className="mt-5 rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm leading-relaxed text-slate-600">
              {currentBusyPresentation.slowHint}
            </div>
          </div>
        </div>
      ) : null}
    </section>
  );
};
