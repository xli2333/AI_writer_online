import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowDownTrayIcon,
  ArrowPathIcon,
  ChatBubbleLeftRightIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  DocumentDuplicateIcon,
  ShieldCheckIcon,
  StopIcon,
  TrashIcon,
} from '@heroicons/react/24/outline';
import {
  ArticleIllustrationAsset,
  ArticleIllustrationBundle,
  ArticleIllustrationJobStatus,
  ArticleIllustrationSlot,
  ArticleIllustrationStyleReferenceImage,
  WechatDraftRecord,
  WechatLayoutSettings,
  WritingProjectData,
} from '../types';
import * as GeminiService from '../services/geminiService';
import {
  cancelArticleIllustrationGeneration,
  deleteIllustrationSlotImage,
  getArticleIllustrationStatus,
  regenerateIllustrationCaption,
  regenerateIllustrationSlot,
  startArticleIllustrationGeneration,
  switchIllustrationSlotVersion,
} from '../services/articleIllustrationService';
import { ArchiveEntry, buildZipArchive, downloadBlob, encodeTextArchiveEntry } from '../services/archiveService';
import { resolveGeneratedAssetUrl } from '../services/runtimeConfig';
import { MarkdownRenderer } from './MarkdownRenderer';
import { SelectionMenu } from './SelectionMenu';
import { WechatPublisherPanel } from './WechatPublisherPanel';
import { WritingCopilot } from './WritingCopilot';

interface ArticleViewerProps {
  data: WritingProjectData;
  onReset: () => void;
  onUpdateArticleContent: (content: string) => void;
  onUpdateTeachingNotes: (notes: string) => void;
  onUpdateIllustrationBundle: (bundle?: ArticleIllustrationBundle) => void;
  onUpdateWechatLayout: (layout?: WechatLayoutSettings) => void;
  onUpdateWechatDraft: (draft?: WechatDraftRecord) => void;
}

interface HistoryItem {
  articleContent: string;
  teachingNotes: string;
}

interface ReferenceTemplateArticle {
  id?: string;
  title: string;
  date?: string;
  genre?: string;
  style?: string[];
  summary?: string;
  structurePattern?: string;
  openingPattern?: string;
  coreArgument?: string;
  whySelected?: string;
  relativePath?: string;
}

type ViewerData = WritingProjectData & {
  referenceArticles?: ReferenceTemplateArticle[];
};

const ILLUSTRATION_STYLE_REFERENCE_ACCEPT = 'image/png,image/jpeg,image/webp';
const ILLUSTRATION_STYLE_REFERENCE_MAX_BYTES = 4 * 1024 * 1024;

const readFileAsDataUrl = (file: File) =>
  new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(new Error(`Failed to read image: ${file.name}`));
    reader.readAsDataURL(file);
  });

const createIllustrationStyleReferenceImage = async (
  file: File
): Promise<ArticleIllustrationStyleReferenceImage> => ({
  id: `illustration-style-reference-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  name: file.name,
  mimeType: file.type || 'image/png',
  dataUrl: await readFileAsDataUrl(file),
});

type ViewerPanel =
  | 'article'
  | 'illustrations'
  | 'wechat'
  | 'chunks'
  | 'references'
  | 'task'
  | 'outline'
  | 'research'
  | 'critique'
  | 'notes';

interface ViewerTab {
  id: ViewerPanel;
  label: string;
}

const downloadTextFile = (filename: string, content: string, mimeType = 'text/plain;charset=utf-8') => {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
};

const waitForAnimationFrames = async (count = 2) => {
  for (let index = 0; index < count; index += 1) {
    await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
  }
};

const PanelShell: React.FC<{
  title: string;
  description?: string;
  children: React.ReactNode;
}> = ({ title, description, children }) => (
  <section className="rounded-[28px] border border-slate-200 bg-white p-6 shadow-sm sm:p-8">
    <div className="mb-6 border-b border-slate-100 pb-5">
      <h2 className="font-serif text-2xl font-bold text-slate-900">{title}</h2>
      {description && <p className="mt-2 text-sm leading-relaxed text-slate-500">{description}</p>}
    </div>
    {children}
  </section>
);

const EXPORT_PAGE_WIDTH_PX = 794;
const PLAIN_PDF_FONT_URL = '/fonts/yahei.ttf';
const ARCHIVE_IMAGE_EXTENSION_MAP: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/svg+xml': 'svg',
};
let plainPdfFontBinaryPromise: Promise<string> | null = null;

const sanitizeArchiveSegment = (value: string, fallback = 'file') => {
  const normalized = String(value || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toLowerCase();
  return (normalized || fallback).slice(0, 48);
};

const padArchiveIndex = (value: number) => String(Math.max(1, value)).padStart(2, '0');

const normalizeTextAssetContent = (value: string) => {
  const normalized = String(value || '').replace(/\r\n/g, '\n').trimEnd();
  return normalized ? `${normalized}\n` : '';
};

const pushTextArchiveEntry = (entries: ArchiveEntry[], path: string, content: string | undefined, lastModified: Date) => {
  if (!String(content || '').trim()) return;
  entries.push(encodeTextArchiveEntry(path, normalizeTextAssetContent(content || ''), lastModified));
};

const resolveArchiveAssetUrl = (value: string) => {
  const raw = String(value || '').trim();
  if (!raw) return '';
  return resolveGeneratedAssetUrl(raw);
};

const inferArchiveAssetExtension = (mimeType?: string, sourceUrl?: string) => {
  const normalizedMimeType = String(mimeType || '')
    .split(';')[0]
    .trim()
    .toLowerCase();
  if (ARCHIVE_IMAGE_EXTENSION_MAP[normalizedMimeType]) {
    return ARCHIVE_IMAGE_EXTENSION_MAP[normalizedMimeType];
  }

  try {
    const pathname = new URL(resolveArchiveAssetUrl(sourceUrl || ''), window.location.origin).pathname;
    const extension = pathname.split('.').pop()?.trim().toLowerCase();
    if (extension && extension.length <= 5) {
      return extension;
    }
  } catch {
    return 'bin';
  }

  return 'bin';
};

const stripMarkdownTitleDecorators = (line: string) =>
  line
    .trim()
    .replace(/^#{1,6}\s+/, '')
    .replace(/^>\s+/, '')
    .replace(/^[-*+]\s+/, '')
    .replace(/^\d+\.\s+/, '')
    .replace(/^\*\*(.+)\*\*$/, '$1')
    .replace(/^__(.+)__$/, '$1')
    .trim();

const normalizeTitleText = (value: string) =>
  stripMarkdownTitleDecorators(value)
    .replace(/\s+/g, '')
    .replace(/[“”"'`·•]/g, '')
    .trim();

const extractArticleTitle = (fallback: string, content?: string) => {
  const lines = String(content || '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

  const markdownHeading = lines.find((line) => /^#\s+/.test(line));
  if (markdownHeading) {
    return stripMarkdownTitleDecorators(markdownHeading);
  }

  const candidate = lines
    .slice(0, 8)
    .map(stripMarkdownTitleDecorators)
    .find(
      (line) =>
        line.length >= 6 &&
        line.length <= 40 &&
        !/^[0-9０-９一二三四五六七八九十]+[、.]/.test(line) &&
        !/^\d{4}[-/年]/.test(line) &&
        !/[。！？；]$/.test(line)
    );

  return candidate || fallback;
};

const stripLeadingTitleFromArticle = (content: string, title: string) => {
  const lines = String(content || '').split('\n');
  const normalizedTitle = normalizeTitleText(title);
  if (!normalizedTitle) {
    return content;
  }

  const firstContentLineIndex = lines.findIndex((line) => line.trim().length > 0);
  if (firstContentLineIndex === -1) {
    return content;
  }

  if (normalizeTitleText(lines[firstContentLineIndex]) !== normalizedTitle) {
    return content;
  }

  const removeCount = firstContentLineIndex + 1 < lines.length && !lines[firstContentLineIndex + 1].trim() ? 2 : 1;
  lines.splice(firstContentLineIndex, removeCount);
  return lines.join('\n').trim();
};

const resolveArticlePreviewContent = (data: ViewerData) => {
  if (data.articleContent) {
    return data.articleContent;
  }

  if (data.workingArticleDraft) {
    return data.workingArticleDraft;
  }

  return Array.isArray(data.chunkDrafts) ? data.chunkDrafts.filter(Boolean).join('\n\n') : '';
};

const resolveIllustrationSlotMap = (bundle?: ArticleIllustrationBundle) =>
  new Map((bundle?.slots || []).map((slot) => [slot.id, slot]));

const resolveHeroIllustration = (bundle?: ArticleIllustrationBundle) => {
  if (!bundle) return null;
  const heroAsset = bundle.assets.find((asset) => asset.role === 'hero') || bundle.assets[0];
  if (!heroAsset) return null;
  const slotMap = resolveIllustrationSlotMap(bundle);
  const slot = slotMap.get(heroAsset.slotId);
  return { asset: heroAsset, slot };
};

const resolveIllustrationVersionMap = (bundle?: ArticleIllustrationBundle) =>
  new Map(Object.entries(bundle?.assetVersions || {}).map(([slotId, versions]) => [slotId, versions || []]));

const resolveActiveIllustrationAssetMap = (bundle?: ArticleIllustrationBundle) =>
  new Map((bundle?.assets || []).map((asset) => [asset.slotId, asset]));

const resolveIllustrationVersionState = (bundle: ArticleIllustrationBundle | undefined, slotId: string) => {
  const versions = bundle?.assetVersions?.[slotId] || [];
  const activeAsset = bundle?.assets?.find((asset) => asset.slotId === slotId);
  const activeIndex = Math.max(
    0,
    versions.findIndex((asset) => asset.id === activeAsset?.id)
  );

  return {
    versions,
    activeAsset,
    activeIndex,
    total: versions.length,
    hasPrevious: activeIndex > 0,
    hasNext: activeIndex >= 0 && activeIndex < versions.length - 1,
  };
};

const bundleNeedsRefresh = (bundle?: ArticleIllustrationBundle) => {
  if (!bundle) return false;
  if (bundle.promptVersion !== 'illustration-v5') return true;
  if (!bundle.sourceHash) return true;
  if (!bundle.assetVersions || Object.keys(bundle.assetVersions).length === 0) return true;

  const hasSvgAsset = (bundle.assets || []).some(
    (asset) => asset.renderMode === 'svg_chart' || String(asset.mimeType || '').toLowerCase().includes('svg')
  );
  if (hasSvgAsset) return true;

  return (bundle.slots || []).some(
    (slot) => slot.renderMode === 'svg_chart' || !String(slot.explanation || '').trim()
  );
};

const isIllustrationJobActive = (job?: ArticleIllustrationJobStatus | null) => {
  const status = String(job?.status || '');
  if (!['queued', 'planning', 'rendering', 'finalizing'].includes(status)) {
    return false;
  }

  const currentStep = String(job?.currentStep || '').trim();
  if (currentStep.includes('已停止') || currentStep.includes('没有可恢复的配图任务') || currentStep.includes('重新生成')) {
    return false;
  }

  if (status === 'queued' && Number(job?.totalCount || 0) <= 0 && Number(job?.completedCount || 0) <= 0) {
    return false;
  }

  return true;
};

const resolveIllustrationPhaseLabel = (job?: ArticleIllustrationJobStatus | null) => {
  switch (job?.status) {
    case 'queued':
      return '已进入队列';
    case 'planning':
      return '正在规划';
    case 'rendering':
      return '正在生图';
    case 'finalizing':
      return '正在整理';
    case 'ready':
      return '全部完成';
    case 'canceled':
      return '已停止';
    case 'error':
      return '生成失败';
    default:
      return '待生成';
  }
};

const decodeHtmlEntities = (value: string) =>
  value
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");

const stripInlineMarkdown = (value: string) =>
  decodeHtmlEntities(
    value
      .replace(/!\[([^\]]*)\]\([^)]+\)/g, '$1')
      .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
      .replace(/`([^`]+)`/g, '$1')
      .replace(/\*\*([^*]+)\*\*/g, '$1')
      .replace(/__([^_]+)__/g, '$1')
      .replace(/\*([^*]+)\*/g, '$1')
      .replace(/_([^_]+)_/g, '$1')
      .replace(/~~([^~]+)~~/g, '$1')
      .replace(/<\/?[^>]+>/g, '')
  )
    .replace(/\s+/g, ' ')
    .trim();

type PlainTextBlock =
  | { type: 'heading1' | 'heading2' | 'heading3' | 'paragraph' | 'quote' | 'table'; text: string }
  | { type: 'list'; text: string; ordered: boolean; order?: number };

const buildPlainTextBlocks = (content: string): PlainTextBlock[] => {
  const blocks: PlainTextBlock[] = [];
  const lines = String(content || '').replace(/\r\n/g, '\n').split('\n');
  let paragraphBuffer: string[] = [];

  const flushParagraph = () => {
    if (paragraphBuffer.length === 0) return;
    const text = stripInlineMarkdown(paragraphBuffer.join(' '));
    if (text) {
      blocks.push({ type: 'paragraph', text });
    }
    paragraphBuffer = [];
  };

  for (const rawLine of lines) {
    const line = rawLine.trim();

    if (!line) {
      flushParagraph();
      continue;
    }

    if (/^\|?[\s\-:|]+\|?$/.test(line)) {
      flushParagraph();
      continue;
    }

    if (/^###\s+/.test(line)) {
      flushParagraph();
      blocks.push({ type: 'heading3', text: stripInlineMarkdown(line.replace(/^###\s+/, '')) });
      continue;
    }

    if (/^##\s+/.test(line)) {
      flushParagraph();
      blocks.push({ type: 'heading2', text: stripInlineMarkdown(line.replace(/^##\s+/, '')) });
      continue;
    }

    if (/^#\s+/.test(line)) {
      flushParagraph();
      blocks.push({ type: 'heading1', text: stripInlineMarkdown(line.replace(/^#\s+/, '')) });
      continue;
    }

    if (/^>\s?/.test(line)) {
      flushParagraph();
      blocks.push({ type: 'quote', text: stripInlineMarkdown(line.replace(/^>\s?/, '')) });
      continue;
    }

    if (/^[-*]\s+/.test(line)) {
      flushParagraph();
      blocks.push({ type: 'list', text: stripInlineMarkdown(line.replace(/^[-*]\s+/, '')), ordered: false });
      continue;
    }

    const orderedMatch = line.match(/^(\d+)\.\s+(.*)$/);
    if (orderedMatch) {
      flushParagraph();
      blocks.push({
        type: 'list',
        text: stripInlineMarkdown(orderedMatch[2]),
        ordered: true,
        order: Number(orderedMatch[1]),
      });
      continue;
    }

    if (line.includes('|')) {
      flushParagraph();
      const text = stripInlineMarkdown(
        line
          .replace(/^\|/, '')
          .replace(/\|$/, '')
          .split('|')
          .map((cell) => cell.trim())
          .join('    ')
      );
      if (text) {
        blocks.push({ type: 'table', text });
      }
      continue;
    }

    paragraphBuffer.push(line);
  }

  flushParagraph();
  return blocks;
};

const arrayBufferToBinaryString = (buffer: ArrayBuffer) => {
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  let binary = '';

  for (let index = 0; index < bytes.length; index += chunkSize) {
    const chunk = bytes.subarray(index, index + chunkSize);
    binary += String.fromCharCode(...chunk);
  }

  return binary;
};

const loadPlainPdfFontBinary = async () => {
  if (!plainPdfFontBinaryPromise) {
    plainPdfFontBinaryPromise = fetch(PLAIN_PDF_FONT_URL)
      .then((response) => {
        if (!response.ok) {
          throw new Error(`Failed to load plain PDF font: ${response.status}`);
        }
        return response.arrayBuffer();
      })
      .then(arrayBufferToBinaryString);
  }

  return plainPdfFontBinaryPromise;
};

const ArticleDocument: React.FC<{
  data: ViewerData;
  exportMode?: boolean;
  illustrationActions?: IllustrationSlotActions;
}> = ({ data, exportMode = false, illustrationActions }) => {
  const previewContent = resolveArticlePreviewContent(data);
  const articleTitle = extractArticleTitle(data.topic, previewContent);
  const articleBody = stripLeadingTitleFromArticle(previewContent, articleTitle);
  const isDraftPreview = !data.articleContent && Boolean(previewContent);
  const bundle = data.illustrationBundle;
  const activeAssetMap = resolveActiveIllustrationAssetMap(bundle);
  const inlineSlots = (bundle?.slots || [])
    .filter((slot) => slot.role !== 'hero' && activeAssetMap.get(slot.id))
    .slice()
    .sort((left, right) => left.anchorParagraphIndex - right.anchorParagraphIndex || left.order - right.order);

  return (
    <div
      data-section="article"
      className={
        exportMode
          ? 'mx-auto box-border w-full max-w-none bg-white px-[22mm] py-[22mm]'
          : 'rounded-[28px] border border-slate-200 bg-white p-6 shadow-xl sm:p-[22mm]'
      }
    >
      <header className="mb-12 border-b-4 border-double border-gray-200 pb-8 text-center">
        <div className="mb-4 flex items-center justify-center gap-4 opacity-60">
          <span className="h-px w-12 bg-gray-400" />
          <span className="text-xs font-bold uppercase tracking-[0.3em] text-gray-500">Business Article</span>
          <span className="h-px w-12 bg-gray-400" />
        </div>
        {isDraftPreview && (
          <div className="mb-5 inline-flex items-center rounded-full border border-amber-200 bg-amber-50 px-4 py-1.5 text-xs font-semibold text-amber-700">
            当前显示的是阶段草稿预览，尚未进入最终正文状态。
          </div>
        )}
        <h1 className="mb-6 font-serif text-4xl font-bold leading-tight tracking-tight text-slate-900 md:text-5xl">
          {articleTitle}
        </h1>
        <div className="flex justify-center gap-6 text-xs font-semibold uppercase tracking-widest text-gray-500">
          <span>{data.options.genre}</span>
          <span>·</span>
          <span>{new Date().getFullYear()}</span>
        </div>
      </header>

      <ModernIllustrationHero bundle={bundle} actions={!exportMode ? illustrationActions : undefined} />

      <section className="article-copy mb-12">
        <MarkdownRenderer
          content={articleBody}
          renderAfterParagraphRange={(start, end) => {
            const matchedSlots = inlineSlots.filter(
              (slot) => slot.anchorParagraphIndex >= start && slot.anchorParagraphIndex <= end
            );
            if (matchedSlots.length === 0) {
              return null;
            }

            return matchedSlots.map((slot) => {
              const asset = activeAssetMap.get(slot.id);
              const versionState = resolveIllustrationVersionState(bundle, slot.id);
              return (
                <ModernIllustrationCard
                  key={slot.id}
                  slot={slot}
                  asset={asset}
                  actions={!exportMode ? illustrationActions : undefined}
                  versionLabel={versionState.total > 0 ? `${versionState.activeIndex + 1}/${versionState.total}` : undefined}
                  hasPrevious={versionState.hasPrevious}
                  hasNext={versionState.hasNext}
                />
              );
            });
          }}
        />
      </section>

      <div className="border-t border-gray-100 pt-8 text-center font-sans text-[10px] uppercase tracking-widest text-gray-400">
        Generated by Writing Workspace · {articleTitle}
      </div>
    </div>
  );
};

const PlainTextArticleDocument: React.FC<{ data: ViewerData; exportMode?: boolean }> = ({ data, exportMode = false }) => {
  const previewContent = resolveArticlePreviewContent(data);
  const articleTitle = extractArticleTitle(data.topic, previewContent);
  const articleBody = stripLeadingTitleFromArticle(previewContent, articleTitle);
  const blocks = buildPlainTextBlocks(articleBody);
  const isDraftPreview = !data.articleContent && Boolean(previewContent);

  return (
    <div
      data-section="article-plain"
      className={
        exportMode
          ? 'mx-auto box-border w-full max-w-none bg-white px-[25mm] py-[24mm]'
          : 'rounded-[28px] border border-slate-200 bg-white p-6 shadow-sm sm:p-[24mm]'
      }
    >
      <header className="mb-10 pb-5 text-center">
        {isDraftPreview && (
          <div className="mb-5 inline-flex items-center rounded-full border border-amber-200 bg-amber-50 px-4 py-1.5 text-xs font-semibold text-amber-700">
            当前导出的是阶段草稿预览。
          </div>
        )}
        <h1 className="font-serif text-[26px] font-bold leading-tight text-slate-950">{articleTitle}</h1>
        <div className="mt-3 text-[11px] tracking-[0.18em] text-slate-500">
          {data.options.genre} · {new Date().getFullYear()}
        </div>
      </header>

      <section className="article-copy font-serif text-[15px] leading-[1.95] text-slate-900">
        {blocks.map((block, index) => {
          if (block.type === 'heading1') {
            return (
              <h2 key={index} className="mb-5 mt-8 break-after-avoid text-center text-[20px] font-bold text-slate-950">
                {block.text}
              </h2>
            );
          }

          if (block.type === 'heading2') {
            return (
              <h2 key={index} className="mb-4 mt-8 break-after-avoid text-[17px] font-bold text-slate-950">
                {block.text}
              </h2>
            );
          }

          if (block.type === 'heading3') {
            return (
              <h3 key={index} className="mb-3 mt-6 break-after-avoid text-[15px] font-bold text-slate-900">
                {block.text}
              </h3>
            );
          }

          if (block.type === 'quote') {
            return (
              <p key={index} className="mb-4 border-l-2 border-slate-300 pl-5 italic text-slate-700">
                {block.text}
              </p>
            );
          }

          if (block.type === 'table') {
            return (
              <p key={index} className="mb-3 whitespace-pre-wrap pl-4 text-[13px] leading-[1.85] text-slate-700">
                {block.text}
              </p>
            );
          }

          if (block.type === 'list') {
            return (
              <p key={index} className="mb-2" style={{ paddingLeft: '2em', textIndent: '-1.25em' }}>
                <span className="mr-2">{block.ordered ? `${block.order}.` : '•'}</span>
                <span>{block.text}</span>
              </p>
            );
          }

          return (
            <p key={index} className="mb-4 text-justify" style={{ textIndent: '2em' }}>
              {block.text}
            </p>
          );
        })}
      </section>
    </div>
  );
};

const NotesDocument: React.FC<{ data: ViewerData; exportMode?: boolean }> = ({ data, exportMode = false }) => {
  if (!data.teachingNotes) return null;
  const articleTitle = extractArticleTitle(data.topic, data.articleContent);

  return (
    <div
      data-section="notes"
      className={
        exportMode
          ? 'mx-auto box-border w-full max-w-none bg-white px-[22mm] py-[22mm]'
          : 'rounded-[28px] border border-slate-200 bg-white p-6 shadow-sm sm:p-[22mm]'
      }
    >
      <div className="mb-8 border-b border-gray-200 pb-6">
        <h2 className="font-serif text-2xl font-bold text-slate-800">TN / Discussion Guide</h2>
        <p className="mt-2 text-sm font-medium text-gray-500">关联正文：{articleTitle}</p>
      </div>
      <section className="mb-12 rounded-xl border border-slate-100 bg-slate-50/50 p-6">
        <MarkdownRenderer content={data.teachingNotes} />
      </section>
      <div className="border-t border-gray-100 pt-8 text-center font-sans text-[10px] uppercase tracking-widest text-gray-400">
        Generated by Writing Workspace · {articleTitle} · TN
      </div>
    </div>
  );
};

const TaskSummaryPanel: React.FC<{ data: ViewerData; referenceCount: number }> = ({ data, referenceCount }) => (
  <PanelShell title="任务摘要" description="这里只保留本次正文生成所使用的任务配置和流程摘要。">
    <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
      <div className="rounded-2xl border border-slate-100 bg-slate-50 p-5">
        <p className="text-xs font-bold uppercase tracking-wider text-slate-400">文章目标</p>
        <p className="mt-2 text-sm leading-relaxed text-slate-700">{data.options.articleGoal}</p>
      </div>
      <div className="rounded-2xl border border-slate-100 bg-slate-50 p-5">
        <p className="text-xs font-bold uppercase tracking-wider text-slate-400">讨论方向</p>
        <p className="mt-2 text-sm leading-relaxed text-slate-700">{data.selectedDirection || '未记录'}</p>
      </div>
      <div className="rounded-2xl border border-slate-100 bg-slate-50 p-5">
        <p className="text-xs font-bold uppercase tracking-wider text-slate-400">文体 / 风格</p>
        <p className="mt-2 text-sm leading-relaxed text-slate-700">
          {data.options.genre} / {data.options.style}
        </p>
      </div>
      <div className="rounded-2xl border border-slate-100 bg-slate-50 p-5">
        <p className="text-xs font-bold uppercase tracking-wider text-slate-400">目标受众</p>
        <p className="mt-2 text-sm leading-relaxed text-slate-700">{data.options.audience}</p>
      </div>
      <div className="rounded-2xl border border-slate-100 bg-slate-50 p-5">
        <p className="text-xs font-bold uppercase tracking-wider text-slate-400">字数规划</p>
        <p className="mt-2 text-sm leading-relaxed text-slate-700">
          总长约 {data.options.desiredLength} 字
          <br />
          单轮约 {data.options.chunkLength} 字
        </p>
      </div>
      <div className="rounded-2xl border border-slate-100 bg-slate-50 p-5">
        <p className="text-xs font-bold uppercase tracking-wider text-slate-400">流程摘要</p>
        <p className="mt-2 text-sm leading-relaxed text-slate-700">
          模板参考文章：{referenceCount} 篇
          <br />
          研究资料：{data.researchDocuments.length} 份
          <br />
          是否生成 TN：{data.options.includeTeachingNotes ? '是' : '否'}
        </p>
      </div>
    </div>
  </PanelShell>
);

const IllustrationHero: React.FC<{ bundle?: ArticleIllustrationBundle }> = ({ bundle }) => {
  const hero = resolveHeroIllustration(bundle);
  if (!hero) return null;

  return (
    <figure className="mb-10 overflow-hidden rounded-[28px] border border-slate-200 bg-slate-50 shadow-sm">
      <img
        src={resolveGeneratedAssetUrl(hero.asset.url)}
        alt={hero.slot?.title || '文章首图'}
        className="aspect-[16/9] w-full object-cover"
      />
      <figcaption className="grid gap-2 border-t border-slate-200 bg-white px-5 py-4 text-sm text-slate-600 md:grid-cols-[1fr_auto] md:items-center">
        <div>
          <div className="font-semibold text-slate-900">{hero.slot?.title || '首图总图'}</div>
          <div className="mt-1 leading-relaxed text-slate-500">{hero.slot?.purpose || '用于建立整篇文章的视觉气质。'}</div>
        </div>
        <div className="text-xs uppercase tracking-[0.18em] text-slate-400">{hero.slot?.sectionTitle || '导语'}</div>
      </figcaption>
    </figure>
  );
};

const IllustrationGalleryPanel: React.FC<{
  bundle?: ArticleIllustrationBundle;
  isGenerating: boolean;
  errorMessage?: string | null;
  onRegenerate: () => void;
}> = ({ bundle, isGenerating, errorMessage, onRegenerate }) => {
  const slotMap = resolveIllustrationSlotMap(bundle);

  return (
    <PanelShell title="配图" description="根据最终定稿自动规划并生成的整篇文章配图。">
      <div className="space-y-6">
        <div className="grid gap-4 lg:grid-cols-[minmax(0,1.1fr)_minmax(0,0.9fr)]">
          <div className="rounded-2xl border border-slate-200 bg-slate-50 p-5">
            <div className="flex items-center justify-between gap-4">
              <div>
                <p className="text-xs font-bold uppercase tracking-wider text-slate-400">生成状态</p>
                <p className="mt-2 text-sm leading-relaxed text-slate-700">
                  {isGenerating
                    ? '正在按整篇统一视觉系统生成配图...'
                    : bundle
                      ? `已生成 ${bundle.assets.length}/${bundle.targetImageCount} 张图`
                      : '尚未生成配图'}
                </p>
              </div>
              <button
                onClick={onRegenerate}
                disabled={isGenerating}
                className="rounded-lg border border-slate-200 bg-white px-4 py-2 text-sm font-medium text-slate-700 transition-colors hover:bg-slate-50 disabled:opacity-50"
              >
                重跑配图
              </button>
            </div>
            {errorMessage && <p className="mt-3 text-sm leading-relaxed text-red-600">{errorMessage}</p>}
            {bundle && (
              <div className="mt-4 grid gap-3 text-sm text-slate-600 md:grid-cols-2">
                <div className="rounded-xl bg-white px-4 py-3">
                  <div className="text-xs font-bold uppercase tracking-wider text-slate-400">视觉方向</div>
                  <div className="mt-2 leading-relaxed text-slate-700">{bundle.visualSystem.visualDirection}</div>
                </div>
                <div className="rounded-xl bg-white px-4 py-3">
                  <div className="text-xs font-bold uppercase tracking-wider text-slate-400">色彩与图表</div>
                  <div className="mt-2 leading-relaxed text-slate-700">
                    {bundle.visualSystem.palette.join(' / ')}
                    <br />
                    {bundle.visualSystem.chartStyle}
                  </div>
                </div>
              </div>
            )}
          </div>

          <div className="rounded-2xl border border-slate-200 bg-white p-5">
            <p className="text-xs font-bold uppercase tracking-wider text-slate-400">整篇一致性规则</p>
            <div className="mt-3 flex flex-wrap gap-2">
              {(bundle?.visualSystem.consistencyRules || []).map((rule) => (
                <span key={rule} className="rounded-full bg-slate-100 px-3 py-1 text-xs font-medium text-slate-600">
                  {rule}
                </span>
              ))}
            </div>
            {bundle?.warnings?.length ? (
              <div className="mt-4 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm leading-relaxed text-amber-800">
                {bundle.warnings.join(' ')}
              </div>
            ) : null}
          </div>
        </div>

        {bundle?.assets?.length ? (
          <div className="grid gap-5 lg:grid-cols-2">
            {bundle.assets.map((asset) => {
              const slot = slotMap.get(asset.slotId) as ArticleIllustrationSlot | undefined;
              return (
                <article key={asset.slotId} className="overflow-hidden rounded-[24px] border border-slate-200 bg-white shadow-sm">
                  <img
                    src={resolveGeneratedAssetUrl(asset.url)}
                    alt={slot?.title || asset.title}
                    className="aspect-[16/9] w-full object-cover"
                  />
                  <div className="space-y-3 px-5 py-4">
                    <div className="flex items-center justify-between gap-4">
                      <div>
                        <h3 className="text-lg font-semibold text-slate-900">{slot?.title || asset.title}</h3>
                        <p className="mt-1 text-sm text-slate-500">{slot?.sectionTitle || '正文'}</p>
                      </div>
                      <span className="rounded-full bg-slate-100 px-3 py-1 text-[11px] font-semibold uppercase tracking-wider text-slate-500">
                        {slot?.dataSpec || asset.role === 'data_chart' ? 'Data' : 'Scene'}
                      </span>
                    </div>
                    <p className="text-sm leading-relaxed text-slate-700">{slot?.purpose}</p>
                    <p className="rounded-xl bg-slate-50 px-4 py-3 text-sm leading-relaxed text-slate-500">
                      {slot?.anchorExcerpt}
                    </p>
                  </div>
                </article>
              );
            })}
          </div>
        ) : (
          <div className="rounded-2xl border border-dashed border-slate-300 bg-slate-50 px-5 py-10 text-center text-sm text-slate-500">
            {isGenerating ? '正在生成配图，请稍候。' : '当前还没有可展示的配图结果。'}
          </div>
        )}
      </div>
    </PanelShell>
  );
};

interface IllustrationSlotActions {
  onDelete: (slot: ArticleIllustrationSlot) => void;
  onRegenerate: (slot: ArticleIllustrationSlot) => void;
  onRewriteCaption: (slot: ArticleIllustrationSlot) => void;
  onSwitchVersion: (slot: ArticleIllustrationSlot, direction: 'previous' | 'next') => void;
  isAnyBusy: boolean;
  busyAction?: 'regenerate' | 'caption' | 'delete' | 'switch' | null;
  busySlotId?: string | null;
  pendingSlotId?: string | null;
  pendingCaptionSlotId?: string | null;
}

const ModernIllustrationCard: React.FC<{
  slot: ArticleIllustrationSlot;
  asset?: ArticleIllustrationAsset;
  versionLabel?: string;
  hasPrevious?: boolean;
  hasNext?: boolean;
  actions?: IllustrationSlotActions;
  compact?: boolean;
}> = ({ slot, asset, versionLabel, hasPrevious, hasNext, actions, compact = false }) => {
  const isSlotBusy = actions?.busySlotId === slot.id;
  const isSlotPending = actions?.pendingSlotId === slot.id;
  const isCaptionPending = actions?.pendingCaptionSlotId === slot.id;
  const isRegenerateBusy = isSlotBusy && actions?.busyAction === 'regenerate';
  const isCaptionBusy = isSlotBusy && actions?.busyAction === 'caption';
  const shouldAnimateRegenerate = isRegenerateBusy || isSlotPending;
  const shouldAnimateCaption = isCaptionBusy || isCaptionPending;
  const slotStatusLabel =
    slot.status === 'ready' ? '已完成' : slot.status === 'rendering' ? '生成中' : slot.status === 'error' ? '失败' : '排队中';

  return (
  <figure className={`overflow-hidden rounded-[24px] border border-slate-200 bg-white shadow-sm ${compact ? '' : 'mb-8'}`}>
    {actions ? (
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 bg-slate-50 px-4 py-3">
        <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">
          <span>{slot.sectionTitle || '正文'}</span>
          {versionLabel ? <span className="rounded-full bg-white px-2 py-1 tracking-normal text-slate-600">{versionLabel}</span> : null}
          <span className="rounded-full bg-white px-2 py-1 tracking-normal text-slate-500">{slotStatusLabel}</span>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button
            onClick={() => actions.onDelete(slot)}
            disabled={actions.isAnyBusy || !asset}
            className="inline-flex items-center gap-1 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-sm text-slate-600 transition-colors hover:bg-slate-100 disabled:opacity-40"
          >
            <TrashIcon className="h-4 w-4" />
            删除
          </button>
          <button
            onClick={() => actions.onRegenerate(slot)}
            disabled={actions.isAnyBusy}
            className="inline-flex items-center gap-1 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-sm text-slate-600 transition-colors hover:bg-slate-100 disabled:opacity-40"
          >
            <ArrowPathIcon className={`h-4 w-4 ${shouldAnimateRegenerate ? 'animate-spin' : ''}`} />
            {isRegenerateBusy ? '生成中' : '重新生成'}
          </button>
          <button
            onClick={() => actions.onRewriteCaption(slot)}
            disabled={actions.isAnyBusy || !asset}
            className="inline-flex items-center gap-1 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-sm text-slate-600 transition-colors hover:bg-slate-100 disabled:opacity-40"
          >
            <ChatBubbleLeftRightIcon className={`h-4 w-4 ${shouldAnimateCaption ? 'animate-pulse' : ''}`} />
            {isCaptionBusy ? '修改中' : '修改图释'}
          </button>
          <button
            onClick={() => actions.onSwitchVersion(slot, 'previous')}
            disabled={actions.isAnyBusy || !hasPrevious}
            className="rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-sm text-slate-600 transition-colors hover:bg-slate-100 disabled:opacity-40"
          >
            上一版
          </button>
          <button
            onClick={() => actions.onSwitchVersion(slot, 'next')}
            disabled={actions.isAnyBusy || !hasNext}
            className="rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-sm text-slate-600 transition-colors hover:bg-slate-100 disabled:opacity-40"
          >
            下一版
          </button>
        </div>
      </div>
    ) : null}

    {asset ? (
      <img
        src={resolveGeneratedAssetUrl(asset.url)}
        alt={slot.title || asset.title}
        className="aspect-[16/9] w-full object-cover"
      />
    ) : (
      <div className="flex aspect-[16/9] items-center justify-center bg-slate-100 text-sm text-slate-500">当前图位暂无图片</div>
    )}

    <figcaption className="px-5 py-4">
      <p className="text-sm leading-relaxed text-slate-700">{slot.explanation || asset?.editorCaption || slot.purpose || slot.anchorExcerpt}</p>
    </figcaption>
  </figure>
  );
};

const ModernIllustrationHero: React.FC<{
  bundle?: ArticleIllustrationBundle;
  actions?: IllustrationSlotActions;
}> = ({ bundle, actions }) => {
  const hero = resolveHeroIllustration(bundle);
  if (!hero?.slot) return null;
  const versionState = resolveIllustrationVersionState(bundle, hero.slot.id);

  return (
    <ModernIllustrationCard
      slot={hero.slot}
      asset={hero.asset}
      actions={actions}
      versionLabel={versionState.total > 0 ? `${versionState.activeIndex + 1}/${versionState.total}` : undefined}
      hasPrevious={versionState.hasPrevious}
      hasNext={versionState.hasNext}
    />
  );
};

const ModernIllustrationGalleryPanel: React.FC<{
  bundle?: ArticleIllustrationBundle;
  job?: ArticleIllustrationJobStatus | null;
  isGenerating: boolean;
  errorMessage?: string | null;
  onRegenerateAll: () => void;
  slotActions: IllustrationSlotActions;
}> = ({ bundle, job, isGenerating, errorMessage, onRegenerateAll, slotActions }) => {
  const activeAssetMap = resolveActiveIllustrationAssetMap(bundle);
  const completedCount = job?.completedCount ?? bundle?.assets.length ?? 0;
  const totalCount = job?.totalCount ?? bundle?.targetImageCount ?? 0;
  const currentStep = job?.currentStep || bundle?.progress?.currentStep || '';
  const phaseLabel = resolveIllustrationPhaseLabel(job);

  return (
    <PanelShell title="配图" description="根据最终定稿自动规划并生成的整篇文章配图。">
      <div className="space-y-6">
        <div className="grid gap-4 lg:grid-cols-[minmax(0,1.1fr)_minmax(0,0.9fr)]">
          <div className="rounded-2xl border border-slate-200 bg-slate-50 p-5">
            <div className="flex items-center justify-between gap-4">
              <div>
                <p className="text-xs font-bold uppercase tracking-wider text-slate-400">生成状态</p>
                <p className="mt-2 text-sm leading-relaxed text-slate-700">
                  {isGenerating
                    ? '正在按整篇统一视觉系统生成配图...'
                    : bundle
                      ? `已生成 ${bundle.assets.length}/${bundle.targetImageCount} 张图`
                      : '尚未生成配图'}
                </p>
              </div>
              <button
                onClick={onRegenerateAll}
                disabled={isGenerating}
                className="rounded-lg border border-slate-200 bg-white px-4 py-2 text-sm font-medium text-slate-700 transition-colors hover:bg-slate-50 disabled:opacity-50"
              >
                重跑配图
              </button>
            </div>
            {errorMessage ? <p className="mt-3 text-sm leading-relaxed text-red-600">{errorMessage}</p> : null}
            {bundle ? (
              <div className="mt-4 grid gap-3 text-sm text-slate-600 md:grid-cols-2">
                <div className="rounded-xl bg-white px-4 py-3">
                  <div className="text-xs font-bold uppercase tracking-wider text-slate-400">视觉方向</div>
                  <div className="mt-2 leading-relaxed text-slate-700">{bundle.visualSystem.visualDirection}</div>
                </div>
                <div className="rounded-xl bg-white px-4 py-3">
                  <div className="text-xs font-bold uppercase tracking-wider text-slate-400">色彩与图表</div>
                  <div className="mt-2 leading-relaxed text-slate-700">
                    {bundle.visualSystem.palette.join(' / ')}
                    <br />
                    {bundle.visualSystem.chartStyle}
                  </div>
                </div>
              </div>
            ) : null}
          </div>

          <div className="rounded-2xl border border-slate-200 bg-white p-5">
            <p className="text-xs font-bold uppercase tracking-wider text-slate-400">整篇一致性规则</p>
            <div className="mt-3 flex flex-wrap gap-2">
              {(bundle?.visualSystem.consistencyRules || []).map((rule) => (
                <span key={rule} className="rounded-full bg-slate-100 px-3 py-1 text-xs font-medium text-slate-600">
                  {rule}
                </span>
              ))}
            </div>
            {bundle?.warnings?.length ? (
              <div className="mt-4 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm leading-relaxed text-amber-800">
                {bundle.warnings.join(' ')}
              </div>
            ) : null}
          </div>
        </div>

        {bundle?.slots?.length ? (
          <div className="grid gap-5 lg:grid-cols-2">
            {bundle.slots
              .slice()
              .sort((left, right) => left.order - right.order)
              .map((slot) => {
                const asset = activeAssetMap.get(slot.id);
                const versionState = resolveIllustrationVersionState(bundle, slot.id);
                return (
                  <ModernIllustrationCard
                    key={slot.id}
                    slot={slot}
                    asset={asset}
                    actions={slotActions}
                    compact
                    versionLabel={versionState.total > 0 ? `${versionState.activeIndex + 1}/${versionState.total}` : undefined}
                    hasPrevious={versionState.hasPrevious}
                    hasNext={versionState.hasNext}
                  />
                );
              })}
          </div>
        ) : (
          <div className="rounded-2xl border border-dashed border-slate-300 bg-slate-50 px-5 py-10 text-center text-sm text-slate-500">
            {isGenerating ? '正在生成配图，请稍候。' : '当前还没有可展示的配图结果。'}
          </div>
        )}
      </div>
    </PanelShell>
  );
};

const ProgressiveIllustrationGalleryPanel: React.FC<{
  bundle?: ArticleIllustrationBundle;
  job?: ArticleIllustrationJobStatus | null;
  isGenerating: boolean;
  isCanceling: boolean;
  status: 'idle' | 'generating' | 'canceling' | 'ready' | 'error' | 'canceled';
  errorMessage?: string | null;
  onRegenerateAll: () => void;
  onCancelAll: () => void;
  slotActions: IllustrationSlotActions;
}> = ({ bundle, job, isGenerating, isCanceling, status, errorMessage, onRegenerateAll, onCancelAll, slotActions }) => {
  const activeAssetMap = resolveActiveIllustrationAssetMap(bundle);
  const completedCount = job?.completedCount ?? bundle?.assets.length ?? 0;
  const totalCount = job?.totalCount ?? bundle?.targetImageCount ?? 0;
  const currentStep = job?.currentStep || bundle?.progress?.currentStep || '';
  const phaseLabel = resolveIllustrationPhaseLabel(job);
  const progressPercent = totalCount > 0 ? Math.min(100, Math.round((completedCount / totalCount) * 100)) : 0;
  const isRunning = isGenerating || isCanceling;
  const isStopped = status === 'canceled' || job?.status === 'canceled' || bundle?.status === 'canceled';
  const statusText = isCanceling
    ? '正在停止本轮配图…'
    : isGenerating
      ? `${phaseLabel} ${completedCount}/${totalCount || '?'} 张`
    : isStopped
      ? '本轮配图已停止'
      : bundle
        ? `已生成 ${bundle.assets.length}/${bundle.targetImageCount} 张图`
        : '尚未生成配图';
  const noticeClass = isStopped
    ? 'mt-4 rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm leading-relaxed text-amber-800'
    : 'mt-4 rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm leading-relaxed text-red-700';

  return (
    <PanelShell title="配图" description="按整篇文章的统一视觉系统逐张生成。生成到哪一张、当前在做什么，都会直接显示在这里。">
      <div className="space-y-6">
        <div className="grid gap-4 lg:grid-cols-[minmax(0,1.1fr)_minmax(0,0.9fr)]">
          <div className="rounded-2xl border border-slate-200 bg-slate-50 p-5">
            <div className="flex items-center justify-between gap-4">
              <div>
                <p className="text-xs font-bold uppercase tracking-wider text-slate-400">生成状态</p>
                <p className="mt-2 text-sm leading-relaxed text-slate-700">{statusText}</p>
                {currentStep ? <p className="mt-2 text-sm leading-relaxed text-slate-500">{currentStep}</p> : null}
              </div>
              <div className="flex flex-wrap items-center justify-end gap-3">
                {isRunning ? (
                  <button
                    onClick={onCancelAll}
                    disabled={isCanceling}
                    className="inline-flex items-center gap-2 rounded-lg border border-red-200 bg-white px-4 py-2 text-sm font-medium text-red-600 transition-colors hover:bg-red-50 disabled:opacity-50"
                  >
                    {isCanceling ? <ArrowPathIcon className="h-4 w-4 animate-spin" /> : <StopIcon className="h-4 w-4" />}
                    {isCanceling ? '停止中' : '停止配图'}
                  </button>
                ) : (
                  <button
                    onClick={onRegenerateAll}
                    className="rounded-lg border border-slate-200 bg-white px-4 py-2 text-sm font-medium text-slate-700 transition-colors hover:bg-slate-50"
                  >
                    {isStopped ? '调整 Prompt 重新配图' : '重跑配图'}
                  </button>
                )}
              </div>
            </div>
            <div className="mt-4">
              <div className="h-2 overflow-hidden rounded-full bg-white">
                <div
                  className="h-full rounded-full bg-report-accent transition-all duration-300"
                  style={{ width: `${progressPercent}%` }}
                />
              </div>
              <div className="mt-3 grid gap-3 text-sm text-slate-600 md:grid-cols-2">
                <div className="rounded-xl bg-white px-4 py-3">
                  <div className="text-xs font-bold uppercase tracking-wider text-slate-400">当前阶段</div>
                  <div className="mt-2 leading-relaxed text-slate-700">{phaseLabel}</div>
                </div>
                <div className="rounded-xl bg-white px-4 py-3">
                  <div className="text-xs font-bold uppercase tracking-wider text-slate-400">推进进度</div>
                  <div className="mt-2 leading-relaxed text-slate-700">
                    {completedCount}/{totalCount || '?'} 张
                  </div>
                </div>
              </div>
            </div>
            {errorMessage ? <div className={noticeClass}>{errorMessage}</div> : null}
          </div>

          <div className="rounded-2xl border border-slate-200 bg-white p-5">
            <p className="text-xs font-bold uppercase tracking-wider text-slate-400">整篇一致性规则</p>
            <div className="mt-3 flex flex-wrap gap-2">
              {(bundle?.visualSystem.consistencyRules || []).map((rule) => (
                <span key={rule} className="rounded-full bg-slate-100 px-3 py-1 text-xs font-medium text-slate-600">
                  {rule}
                </span>
              ))}
            </div>
            {bundle?.warnings?.length ? (
              <div className="mt-4 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm leading-relaxed text-amber-800">
                {bundle.warnings.join(' ')}
              </div>
            ) : null}
            {bundle?.visualSystem.visualDirection ? (
              <div className="mt-4 rounded-xl bg-slate-50 px-4 py-3 text-sm leading-relaxed text-slate-600">
                {bundle.visualSystem.visualDirection}
              </div>
            ) : null}
          </div>
        </div>

        {bundle?.slots?.length ? (
          <div className="grid gap-5 lg:grid-cols-2">
            {bundle.slots
              .slice()
              .sort((left, right) => left.order - right.order)
              .map((slot) => {
                const asset = activeAssetMap.get(slot.id);
                const versionState = resolveIllustrationVersionState(bundle, slot.id);
                return (
                  <ModernIllustrationCard
                    key={slot.id}
                    slot={slot}
                    asset={asset}
                    actions={slotActions}
                    compact
                    versionLabel={versionState.total > 0 ? `${versionState.activeIndex + 1}/${versionState.total}` : undefined}
                    hasPrevious={versionState.hasPrevious}
                    hasNext={versionState.hasNext}
                  />
                );
              })}
          </div>
        ) : (
          <div className="rounded-2xl border border-dashed border-slate-300 bg-slate-50 px-5 py-10 text-center text-sm text-slate-500">
            {isRunning ? '正在创建首批图位，请稍候。' : '当前还没有可展示的配图结果。'}
          </div>
        )}
      </div>
    </PanelShell>
  );
};

const ChunkDraftsPanel: React.FC<{ data: ViewerData }> = ({ data }) => {
  const chunkDrafts = Array.isArray(data.chunkDrafts) ? data.chunkDrafts : [];

  return (
    <PanelShell title="Chunk 草稿" description="这里保留每一次分段初稿。恢复到任一节点后，可以从对应位置继续往下跑。">
      <div className="space-y-6">
        {chunkDrafts.length === 0 && (
          <div className="rounded-2xl border border-dashed border-slate-200 bg-slate-50 px-5 py-8 text-sm text-slate-500">
            当前还没有保存的 chunk 草稿。
          </div>
        )}

        {chunkDrafts.map((chunkDraft, index) => {
          const chunkPlan = data.chunkPlan?.[index];
          const chunkTitle = chunkPlan?.title || `Chunk ${index + 1}`;

          return (
            <section key={`${chunkTitle}-${index}`} className="rounded-3xl border border-slate-200 bg-slate-50/70 p-6">
              <div className="mb-4 flex flex-wrap items-center gap-3">
                <h3 className="font-serif text-xl font-bold text-slate-900">{chunkTitle}</h3>
                <span className="rounded-full bg-white px-3 py-1 text-xs font-semibold text-slate-500 ring-1 ring-slate-200">
                  第 {index + 1} 段
                </span>
                {typeof chunkPlan?.targetLength === 'number' && (
                  <span className="rounded-full bg-white px-3 py-1 text-xs font-semibold text-slate-500 ring-1 ring-slate-200">
                    目标 {chunkPlan.targetLength} 字
                  </span>
                )}
              </div>

              {chunkPlan?.purpose && (
                <p className="mb-5 text-sm leading-relaxed text-slate-600">{chunkPlan.purpose}</p>
              )}

              <div className="rounded-2xl border border-white bg-white p-5">
                <MarkdownRenderer content={chunkDraft} />
              </div>
            </section>
          );
        })}
      </div>
    </PanelShell>
  );
};

const ReferenceTemplatesPanel: React.FC<{ articles: ReferenceTemplateArticle[] }> = ({ articles }) => (
  <PanelShell title="参考模板文章" description="这些文章会整篇提供给模型，用于学习结构、开头、段落推进和语气控制；这里展示的是本次实际采用的模板来源。">
    <div className="space-y-5">
      {articles.map((article, index) => (
        <article key={`${article.id || article.title}-${index}`} className="rounded-2xl border border-slate-200 bg-slate-50/70 p-6">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <p className="text-xs font-bold uppercase tracking-wider text-slate-400">模板文章 {index + 1}</p>
              <h3 className="mt-2 font-serif text-2xl font-bold text-slate-900">{article.title}</h3>
            </div>
            <div className="text-right text-sm text-slate-500">
              {article.date && <p>{article.date}</p>}
              {article.genre && <p>{article.genre}</p>}
            </div>
          </div>

          {(article.style?.length || article.relativePath) && (
            <div className="mt-4 flex flex-wrap gap-2 text-xs font-semibold">
              {(article.style || []).map((style) => (
                <span key={style} className="rounded-full bg-white px-3 py-1 text-slate-600 ring-1 ring-slate-200">
                  {style}
                </span>
              ))}
              {article.relativePath && (
                <span className="rounded-full bg-white px-3 py-1 text-slate-500 ring-1 ring-slate-200">
                  {article.relativePath}
                </span>
              )}
            </div>
          )}

          <div className="mt-5 grid gap-4 md:grid-cols-2">
            {article.whySelected && (
              <div className="rounded-xl border border-slate-200 bg-white p-4">
                <p className="text-xs font-bold uppercase tracking-wider text-slate-400">借鉴点</p>
                <p className="mt-2 text-sm leading-relaxed text-slate-700">{article.whySelected}</p>
              </div>
            )}
            {article.structurePattern && (
              <div className="rounded-xl border border-slate-200 bg-white p-4">
                <p className="text-xs font-bold uppercase tracking-wider text-slate-400">结构模式</p>
                <p className="mt-2 text-sm leading-relaxed text-slate-700">{article.structurePattern}</p>
              </div>
            )}
            {article.openingPattern && (
              <div className="rounded-xl border border-slate-200 bg-white p-4">
                <p className="text-xs font-bold uppercase tracking-wider text-slate-400">开头方式</p>
                <p className="mt-2 text-sm leading-relaxed text-slate-700">{article.openingPattern}</p>
              </div>
            )}
            {article.coreArgument && (
              <div className="rounded-xl border border-slate-200 bg-white p-4">
                <p className="text-xs font-bold uppercase tracking-wider text-slate-400">核心论点</p>
                <p className="mt-2 text-sm leading-relaxed text-slate-700">{article.coreArgument}</p>
              </div>
            )}
          </div>

          {article.summary && (
            <div className="mt-4 rounded-xl border border-slate-200 bg-white p-4">
              <p className="text-xs font-bold uppercase tracking-wider text-slate-400">文章摘要</p>
              <p className="mt-2 text-sm leading-relaxed text-slate-700">{article.summary}</p>
            </div>
          )}
        </article>
      ))}
    </div>
  </PanelShell>
);

export const ArticleViewer: React.FC<ArticleViewerProps> = ({
  data,
  onReset,
  onUpdateArticleContent,
  onUpdateTeachingNotes,
  onUpdateIllustrationBundle,
  onUpdateWechatLayout,
  onUpdateWechatDraft,
}) => {
  const viewerData = data as ViewerData;
  const referenceArticles = Array.isArray(viewerData.referenceArticles) ? viewerData.referenceArticles : [];
  const previewArticleContent = useMemo(() => resolveArticlePreviewContent(viewerData), [viewerData]);
  const hasFinalArticle = Boolean(data.articleContent);
  const articleTitle = useMemo(
    () => extractArticleTitle(data.topic, previewArticleContent),
    [data.topic, previewArticleContent]
  );

  const [showCopilot, setShowCopilot] = useState(false);
  const [isDownloading, setIsDownloading] = useState(false);
  const [refineStatus, setRefineStatus] = useState<string | null>(null);
  const [illustrationStatus, setIllustrationStatus] = useState<'idle' | 'generating' | 'canceling' | 'ready' | 'error' | 'canceled'>('idle');
  const [illustrationError, setIllustrationError] = useState<string | null>(null);
  const [illustrationJob, setIllustrationJob] = useState<ArticleIllustrationJobStatus | null>(null);
  const [illustrationMutationSlotId, setIllustrationMutationSlotId] = useState<string | null>(null);
  const [illustrationMutationKind, setIllustrationMutationKind] = useState<'regenerate' | 'caption' | 'delete' | 'switch' | null>(null);
  const [illustrationPromptDraft, setIllustrationPromptDraft] = useState('');
  const [illustrationCountPromptDraft, setIllustrationCountPromptDraft] = useState('');
  const [illustrationStyleReference, setIllustrationStyleReference] = useState<ArticleIllustrationStyleReferenceImage | null>(null);
  const [illustrationStyleReferenceError, setIllustrationStyleReferenceError] = useState<string | null>(null);
  const [illustrationPromptMode, setIllustrationPromptMode] = useState<'initial' | 'regenerate' | null>(null);
  const [regeneratePromptDraft, setRegeneratePromptDraft] = useState('');
  const [regeneratePromptSlotId, setRegeneratePromptSlotId] = useState<string | null>(null);
  const [captionPromptDraft, setCaptionPromptDraft] = useState('');
  const [captionPromptSlotId, setCaptionPromptSlotId] = useState<string | null>(null);
  const [selection, setSelection] = useState('');
  const [selectionPos, setSelectionPos] = useState<{ x: number; y: number } | null>(null);
  const [selectionSource, setSelectionSource] = useState<'article' | 'notes' | null>(null);
  const [activePanel, setActivePanel] = useState<ViewerPanel>('article');

  const abortControllerRef = useRef(false);
  const illustrationRequestAbortRef = useRef<AbortController | null>(null);
  const illustrationStatusPollRef = useRef<number | null>(null);
  const illustrationStatusFailureCountRef = useRef(0);
  const illustrationFlowTokenRef = useRef(0);
  const activeIllustrationBundleRef = useRef<ArticleIllustrationBundle | undefined>(data.illustrationBundle);
  const articleExportRef = useRef<HTMLDivElement>(null);
  const plainArticleExportRef = useRef<HTMLDivElement>(null);
  const notesExportRef = useRef<HTMLDivElement>(null);

  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [historyIndex, setHistoryIndex] = useState(0);
  const activeIllustrationBundle = data.illustrationBundle;
  const activeRegenerateSlot = activeIllustrationBundle?.slots.find((slot) => slot.id === regeneratePromptSlotId);
  const activeCaptionSlot = activeIllustrationBundle?.slots.find((slot) => slot.id === captionPromptSlotId);
  const illustrationBundleNeedsRefresh = bundleNeedsRefresh(activeIllustrationBundle);
  const autoIllustrationStateRef = useRef('');
  const autoIllustrationPromptSeenRef = useRef('');
  const illustrationPromptContextKey = useMemo(
    () => `${data.options.styleProfile}\n${articleTitle}\n${data.articleContent || ''}`,
    [articleTitle, data.articleContent, data.options.styleProfile]
  );
  const beginIllustrationFlow = () => {
    illustrationFlowTokenRef.current += 1;
    return illustrationFlowTokenRef.current;
  };
  const isIllustrationFlowCurrent = (token: number) => illustrationFlowTokenRef.current === token;
  const isIllustrationBusy = illustrationStatus === 'generating' || illustrationStatus === 'canceling';
  const shouldRetryIllustrationStatusError = (error: any) => {
    const message = String(error?.message || '').toLowerCase();
    return (
      message.includes('failed to fetch') ||
      message.includes('networkerror') ||
      message.includes('load failed') ||
      message.includes('bad gateway') ||
      message.includes(' 502') ||
      message.includes(' 503') ||
      message.includes(' 504')
    );
  };

  useEffect(() => {
    activeIllustrationBundleRef.current = data.illustrationBundle;
  }, [data.illustrationBundle]);

  useEffect(() => {
    if (illustrationPromptMode) return;
    setIllustrationStyleReference(data.illustrationBundle?.styleReferenceImage || null);
    setIllustrationStyleReferenceError(null);
  }, [data.illustrationBundle?.styleReferenceImage, illustrationPromptMode]);

  const stopIllustrationPolling = () => {
    if (illustrationStatusPollRef.current !== null) {
      window.clearTimeout(illustrationStatusPollRef.current);
      illustrationStatusPollRef.current = null;
    }
  };

  const pollIllustrationStatus = async (sourceHash: string, immediate = false, flowToken = illustrationFlowTokenRef.current) => {
    stopIllustrationPolling();
    const run = async () => {
      if (!isIllustrationFlowCurrent(flowToken)) return;
      const controller = new AbortController();
      illustrationRequestAbortRef.current = controller;
      try {
        const payload = await getArticleIllustrationStatus({
          sourceHash,
          knownAssetCount: activeIllustrationBundleRef.current?.assets?.length || 0,
          signal: controller.signal,
        });
        illustrationStatusFailureCountRef.current = 0;
        if (!isIllustrationFlowCurrent(flowToken)) return;
        if (payload.bundle) {
          onUpdateIllustrationBundle(payload.bundle);
        }
        if (payload.job) {
          setIllustrationJob(payload.job);
          if (payload.job.status === 'error') {
            setIllustrationStatus('error');
            setIllustrationError(payload.job.error || payload.job.currentStep || '配图生成失败，请稍后重试。');
            stopIllustrationPolling();
            return;
          }
          if (payload.job.status === 'canceled') {
            setIllustrationStatus('canceled');
            setIllustrationError(payload.job.currentStep || '本轮配图已停止，可调整 Prompt 后重新开始。');
            stopIllustrationPolling();
            return;
          }
          if (payload.job.status === 'ready') {
            setIllustrationStatus('ready');
            setIllustrationError(null);
            stopIllustrationPolling();
            return;
          }
        }
        setIllustrationStatus('generating');
        illustrationStatusPollRef.current = window.setTimeout(() => {
          void pollIllustrationStatus(sourceHash, false, flowToken);
        }, 1800);
      } catch (error: any) {
        if (!isIllustrationFlowCurrent(flowToken)) return;
        if (error?.message !== '已取消本次生图请求。') {
          if (shouldRetryIllustrationStatusError(error)) {
            illustrationStatusFailureCountRef.current += 1;
            const retryCount = illustrationStatusFailureCountRef.current;
            if (retryCount <= 6) {
              const retryDelayMs = Math.min(6000, 1200 + retryCount * 800);
              illustrationStatusPollRef.current = window.setTimeout(() => {
                void pollIllustrationStatus(sourceHash, true, flowToken);
              }, retryDelayMs);
              return;
            }
          }
          console.error('Illustration status polling failed', error);
          setIllustrationStatus('error');
          setIllustrationError(error?.message || '配图状态获取失败，请稍后重试。');
          stopIllustrationPolling();
        }
      } finally {
        if (illustrationRequestAbortRef.current === controller) {
          illustrationRequestAbortRef.current = null;
        }
      }
    };

    if (immediate) {
      await run();
      return;
    }

    illustrationStatusPollRef.current = window.setTimeout(() => {
      void run();
    }, 1800);
  };

  const requestIllustrations = async (
    regenerate = false,
    userPrompt = '',
    imageCountPrompt = '',
    styleReferenceImage?: ArticleIllustrationStyleReferenceImage | null
  ) => {
    if (!data.articleContent) return false;
    const flowToken = beginIllustrationFlow();
    stopIllustrationPolling();
    illustrationRequestAbortRef.current?.abort();
    const controller = new AbortController();
    illustrationRequestAbortRef.current = controller;
    illustrationStatusFailureCountRef.current = 0;
    setIllustrationStatus('generating');
    setIllustrationError(null);

    try {
      const result = await startArticleIllustrationGeneration({
        topic: articleTitle,
        articleContent: data.articleContent,
        options: data.options,
        userPrompt,
        imageCountPrompt,
        styleReferenceImage: styleReferenceImage || undefined,
        regenerate,
        signal: controller.signal,
      });
      if (!isIllustrationFlowCurrent(flowToken)) return false;
      if (result.bundle) {
        onUpdateIllustrationBundle(result.bundle);
      }
      if (result.job) {
        setIllustrationJob(result.job);
      }
      await pollIllustrationStatus(result.sourceHash, true, flowToken);
      return true;
    } catch (error: any) {
      if (!isIllustrationFlowCurrent(flowToken)) return false;
      console.error('Illustration generation failed', error);
      if (error?.message === '已取消本次生图请求。') {
        setIllustrationStatus('idle');
      } else {
        setIllustrationStatus('error');
        setIllustrationError(error?.message || '配图生成失败，请稍后重试。');
      }
      return false;
    } finally {
      if (illustrationRequestAbortRef.current === controller) {
        illustrationRequestAbortRef.current = null;
      }
    }
  };

  const handleIllustrationStyleReferenceUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) {
      return;
    }

    if (!ILLUSTRATION_STYLE_REFERENCE_ACCEPT.split(',').includes(file.type)) {
      setIllustrationStyleReferenceError('仅支持 PNG / JPG / WEBP 样张。');
      return;
    }

    if (file.size > ILLUSTRATION_STYLE_REFERENCE_MAX_BYTES) {
      setIllustrationStyleReferenceError('样张单张不能超过 4MB。');
      return;
    }

    try {
      const nextReference = await createIllustrationStyleReferenceImage(file);
      setIllustrationStyleReference(nextReference);
      setIllustrationStyleReferenceError(null);
    } catch (error: any) {
      setIllustrationStyleReferenceError(error?.message || '样张读取失败。');
    }
  };

  const handleRemoveIllustrationStyleReference = () => {
    setIllustrationStyleReference(null);
    setIllustrationStyleReferenceError(null);
  };

  const handleCancelIllustrations = async () => {
    const sourceHash = activeIllustrationBundle?.sourceHash || illustrationJob?.sourceHash;
    if (!sourceHash || !isIllustrationBusy) return;

    const flowToken = beginIllustrationFlow();
    stopIllustrationPolling();
    illustrationRequestAbortRef.current?.abort();
    const controller = new AbortController();
    illustrationRequestAbortRef.current = controller;
    illustrationStatusFailureCountRef.current = 0;
    setIllustrationStatus('canceling');
    setIllustrationError(null);

    try {
      const result = await cancelArticleIllustrationGeneration({
        sourceHash,
        signal: controller.signal,
      });
      if (!isIllustrationFlowCurrent(flowToken)) return;
      if (result.bundle) {
        onUpdateIllustrationBundle(result.bundle);
      }
      if (result.job) {
        setIllustrationJob(result.job);
      }
      setIllustrationStatus('canceled');
      setIllustrationError(result.job?.currentStep || '本轮配图已停止，可调整 Prompt 后重新开始。');
      setActivePanel('illustrations');
    } catch (error: any) {
      if (!isIllustrationFlowCurrent(flowToken)) return;
      if (error?.message !== '已取消本次生图请求。') {
        console.error('Illustration cancel failed', error);
        setIllustrationStatus('error');
        setIllustrationError(error?.message || '停止配图失败，请稍后重试。');
      }
    } finally {
      if (illustrationRequestAbortRef.current === controller) {
        illustrationRequestAbortRef.current = null;
      }
    }
  };

  const openIllustrationPromptDialog = (mode: 'initial' | 'regenerate' = activeIllustrationBundle ? 'regenerate' : 'initial') => {
    setIllustrationError(null);
    setRegeneratePromptSlotId(null);
    setRegeneratePromptDraft('');
    setIllustrationPromptMode(mode);
    setIllustrationPromptDraft(activeIllustrationBundle?.globalUserPrompt || '');
    setIllustrationCountPromptDraft(activeIllustrationBundle?.imageCountPrompt || '');
    setIllustrationStyleReference(activeIllustrationBundle?.styleReferenceImage || null);
    setIllustrationStyleReferenceError(null);
  };

  const closeIllustrationPromptDialog = () => {
    setIllustrationPromptMode(null);
    setIllustrationPromptDraft(activeIllustrationBundle?.globalUserPrompt || '');
    setIllustrationCountPromptDraft(activeIllustrationBundle?.imageCountPrompt || '');
    setIllustrationStyleReference(activeIllustrationBundle?.styleReferenceImage || null);
    setIllustrationStyleReferenceError(null);
  };

  const handleIllustrationPromptSubmit = () => {
    if (!illustrationPromptMode) return;
    const shouldRegenerate =
      illustrationPromptMode === 'regenerate' || Boolean(String(illustrationPromptDraft || '').trim());
    const nextPrompt = illustrationPromptDraft;
    const nextImageCountPrompt = illustrationCountPromptDraft;
    const nextStyleReferenceImage = illustrationStyleReference;
    setIllustrationPromptMode(null);
    setActivePanel('illustrations');
    void requestIllustrations(shouldRegenerate, nextPrompt, nextImageCountPrompt, nextStyleReferenceImage);
  };

  const openRegeneratePromptDialog = (slot: ArticleIllustrationSlot) => {
    setIllustrationError(null);
    setIllustrationPromptMode(null);
    setIllustrationPromptDraft('');
    setIllustrationCountPromptDraft('');
    setCaptionPromptSlotId(null);
    setCaptionPromptDraft('');
    setRegeneratePromptSlotId(slot.id);
    setRegeneratePromptDraft(slot.lastUserPrompt || '');
  };

  const closeRegeneratePromptDialog = (abortRequest = false) => {
    if (abortRequest && illustrationMutationKind === 'regenerate' && illustrationMutationSlotId && illustrationRequestAbortRef.current) {
      illustrationRequestAbortRef.current.abort();
      illustrationRequestAbortRef.current = null;
      setIllustrationMutationSlotId(null);
      setIllustrationMutationKind(null);
    }
    setRegeneratePromptSlotId(null);
    setRegeneratePromptDraft('');
  };

  const openCaptionPromptDialog = (slot: ArticleIllustrationSlot) => {
    setIllustrationError(null);
    setIllustrationPromptMode(null);
    setIllustrationPromptDraft('');
    setIllustrationCountPromptDraft('');
    setRegeneratePromptSlotId(null);
    setRegeneratePromptDraft('');
    setCaptionPromptSlotId(slot.id);
    setCaptionPromptDraft('');
  };

  const closeCaptionPromptDialog = (abortRequest = false) => {
    if (abortRequest && illustrationMutationKind === 'caption' && illustrationMutationSlotId && illustrationRequestAbortRef.current) {
      illustrationRequestAbortRef.current.abort();
      illustrationRequestAbortRef.current = null;
      setIllustrationMutationSlotId(null);
      setIllustrationMutationKind(null);
    }
    setCaptionPromptSlotId(null);
    setCaptionPromptDraft('');
  };

  const handleRegenerateSlot = async (slot: ArticleIllustrationSlot) => {
    if (!activeIllustrationBundle?.sourceHash) return;
    illustrationRequestAbortRef.current?.abort();
    const controller = new AbortController();
    illustrationRequestAbortRef.current = controller;
    setIllustrationMutationSlotId(slot.id);
    setIllustrationMutationKind('regenerate');
    setIllustrationError(null);
    try {
      const bundle = await regenerateIllustrationSlot({
        sourceHash: activeIllustrationBundle.sourceHash,
        slotId: slot.id,
        articleContent: data.articleContent || '',
        bundle: activeIllustrationBundle,
        options: data.options,
        userPrompt: regeneratePromptDraft,
        signal: controller.signal,
      });
      onUpdateIllustrationBundle(bundle);
      closeRegeneratePromptDialog(false);
    } catch (error: any) {
      console.error('Illustration slot regenerate failed', error);
      if (error?.message !== '已取消本次生图请求。') {
        setIllustrationError(error?.message || '局部配图重生失败，请稍后重试。');
      }
    } finally {
      if (illustrationRequestAbortRef.current === controller) {
        illustrationRequestAbortRef.current = null;
      }
      setIllustrationMutationSlotId(null);
      setIllustrationMutationKind(null);
    }
  };

  const handleRewriteCaption = async (slot: ArticleIllustrationSlot) => {
    if (!activeIllustrationBundle?.sourceHash) return;
    illustrationRequestAbortRef.current?.abort();
    const controller = new AbortController();
    illustrationRequestAbortRef.current = controller;
    setIllustrationMutationSlotId(slot.id);
    setIllustrationMutationKind('caption');
    setIllustrationError(null);
    try {
      const bundle = await regenerateIllustrationCaption({
        sourceHash: activeIllustrationBundle.sourceHash,
        slotId: slot.id,
        articleContent: data.articleContent || '',
        bundle: activeIllustrationBundle,
        userPrompt: captionPromptDraft,
        signal: controller.signal,
      });
      onUpdateIllustrationBundle(bundle);
      setActivePanel('illustrations');
      closeCaptionPromptDialog(false);
    } catch (error: any) {
      console.error('Illustration caption rewrite failed', error);
      if (error?.message !== '已取消本次生图请求。') {
        setIllustrationError(error?.message || '图释修改失败，请稍后重试。');
      }
    } finally {
      if (illustrationRequestAbortRef.current === controller) {
        illustrationRequestAbortRef.current = null;
      }
      setIllustrationMutationSlotId(null);
      setIllustrationMutationKind(null);
    }
  };

  const handleDeleteSlot = async (slot: ArticleIllustrationSlot) => {
    if (!activeIllustrationBundle) return;
    setIllustrationMutationSlotId(slot.id);
    setIllustrationMutationKind('delete');
    setIllustrationError(null);
    try {
      const bundle = deleteIllustrationSlotImage({
        bundle: activeIllustrationBundle,
        slotId: slot.id,
      });
      onUpdateIllustrationBundle(bundle);
    } catch (error: any) {
      console.error('Illustration slot delete failed', error);
      if (error?.message !== '已取消本次生图请求。') {
        setIllustrationError(error?.message || '删除配图失败，请稍后重试。');
      }
    } finally {
      setIllustrationMutationSlotId(null);
      setIllustrationMutationKind(null);
    }
  };

  const handleSwitchSlotVersion = async (slot: ArticleIllustrationSlot, direction: 'previous' | 'next') => {
    if (!activeIllustrationBundle) return;
    setIllustrationMutationSlotId(slot.id);
    setIllustrationMutationKind('switch');
    setIllustrationError(null);
    try {
      const bundle = switchIllustrationSlotVersion({
        bundle: activeIllustrationBundle,
        slotId: slot.id,
        direction,
      });
      onUpdateIllustrationBundle(bundle);
    } catch (error: any) {
      console.error('Illustration version switch failed', error);
      if (error?.message !== '已取消本次生图请求。') {
        setIllustrationError(error?.message || '切换配图版本失败，请稍后重试。');
      }
    } finally {
      setIllustrationMutationSlotId(null);
      setIllustrationMutationKind(null);
    }
  };

  const illustrationSlotActions: IllustrationSlotActions = {
    onDelete: (slot) => void handleDeleteSlot(slot),
    onRegenerate: (slot) => openRegeneratePromptDialog(slot),
    onRewriteCaption: (slot) => openCaptionPromptDialog(slot),
    onSwitchVersion: (slot, direction) => void handleSwitchSlotVersion(slot, direction),
    isAnyBusy: illustrationMutationSlotId !== null || isIllustrationBusy,
    busyAction: illustrationMutationKind,
    busySlotId: illustrationMutationSlotId,
    pendingSlotId: regeneratePromptSlotId,
    pendingCaptionSlotId: captionPromptSlotId,
  };

  useEffect(() => {
    if (history.length === 0 && data.articleContent) {
      setHistory([
        {
          articleContent: data.articleContent,
          teachingNotes: data.teachingNotes || '',
        },
      ]);
    }
  }, [data.articleContent, data.teachingNotes, history.length]);

  useEffect(() => {
    const current = history[historyIndex];
    if (
      current &&
      (current.articleContent !== (data.articleContent || '') ||
        current.teachingNotes !== (data.teachingNotes || ''))
    ) {
      const nextHistory = history.slice(0, historyIndex + 1);
      nextHistory.push({
        articleContent: data.articleContent || '',
        teachingNotes: data.teachingNotes || '',
      });
      setHistory(nextHistory);
      setHistoryIndex(nextHistory.length - 1);
    }
  }, [data.articleContent, data.teachingNotes]);

  useEffect(() => {
    const autoStateKey = JSON.stringify({
      hasFinalArticle,
      articleContent: data.articleContent || '',
      sourceHash: activeIllustrationBundle?.sourceHash || '',
      updatedAt: activeIllustrationBundle?.updatedAt || '',
      assetCount: activeIllustrationBundle?.assets?.length || 0,
      needsRefresh: illustrationBundleNeedsRefresh,
      illustrationStatus,
      illustrationJobStatus: illustrationJob?.status || '',
    });
    if (autoIllustrationStateRef.current === autoStateKey) {
      return;
    }
    autoIllustrationStateRef.current = autoStateKey;

    if (!hasFinalArticle || !data.articleContent) {
      beginIllustrationFlow();
      stopIllustrationPolling();
      illustrationStatusFailureCountRef.current = 0;
      setIllustrationStatus('idle');
      setIllustrationError(null);
      setIllustrationJob(null);
      return;
    }

    if (activeIllustrationBundle?.status === 'canceled' || illustrationJob?.status === 'canceled') {
      stopIllustrationPolling();
      setIllustrationStatus('canceled');
      setIllustrationError(
        illustrationJob?.currentStep || activeIllustrationBundle?.progress?.currentStep || '本轮配图已停止，可调整 Prompt 后重新开始。'
      );
      return;
    }

    if (activeIllustrationBundle?.status === 'error' || illustrationJob?.status === 'error') {
      stopIllustrationPolling();
      setIllustrationStatus('error');
      setIllustrationError(illustrationJob?.error || activeIllustrationBundle?.error || '配图生成失败，请稍后重试。');
      return;
    }

    if (
      activeIllustrationBundle?.sourceHash &&
      ['planning', 'rendering', 'partial'].includes(String(activeIllustrationBundle.status || ''))
    ) {
      if (illustrationStatus !== 'canceling') {
        setIllustrationStatus('generating');
      }
      if (illustrationStatusPollRef.current === null) {
        void pollIllustrationStatus(activeIllustrationBundle.sourceHash, true, illustrationFlowTokenRef.current);
      }
      return;
    }

    if (isIllustrationJobActive(illustrationJob)) {
      if (illustrationStatus !== 'canceling') {
        setIllustrationStatus('generating');
      }
      if (illustrationStatusPollRef.current === null) {
        void pollIllustrationStatus(illustrationJob!.sourceHash, true, illustrationFlowTokenRef.current);
      }
      return;
    }

    if (activeIllustrationBundle && !illustrationBundleNeedsRefresh) {
      stopIllustrationPolling();
      if (activeIllustrationBundle.status === 'canceled') {
        setIllustrationStatus('canceled');
        setIllustrationError(activeIllustrationBundle.progress?.currentStep || '本轮配图已停止，可调整 Prompt 后重新开始。');
      } else {
        setIllustrationStatus('ready');
        setIllustrationError(null);
      }
      return;
    }

    if (illustrationStatus === 'error' || illustrationStatus === 'canceled') {
      return;
    }

    if (illustrationStatus === 'generating' || illustrationStatus === 'canceling') {
      return;
    }

    if (autoIllustrationPromptSeenRef.current === illustrationPromptContextKey) {
      return;
    }

    autoIllustrationPromptSeenRef.current = illustrationPromptContextKey;
    openIllustrationPromptDialog(activeIllustrationBundle ? 'regenerate' : 'initial');
  });

  useEffect(() => () => {
    stopIllustrationPolling();
    illustrationRequestAbortRef.current?.abort();
  }, []);

  const tabs = useMemo<ViewerTab[]>(
    () =>
      [
        { id: 'article', label: '正文' },
        ...(hasFinalArticle ? [{ id: 'illustrations' as const, label: '配图' }] : []),
        ...(hasFinalArticle ? [{ id: 'wechat' as const, label: '公众号' }] : []),
        ...(referenceArticles.length > 0 ? [{ id: 'references' as const, label: '参考模板' }] : []),
        { id: 'task', label: '任务摘要' },
        ...(data.outline ? [{ id: 'outline' as const, label: '提纲' }] : []),
        ...(data.researchDocuments.length > 0 ? [{ id: 'research' as const, label: '研究资料' }] : []),
        ...(data.critique ? [{ id: 'critique' as const, label: '审查' }] : []),
        ...(data.teachingNotes ? [{ id: 'notes' as const, label: 'TN' }] : []),
      ] satisfies ViewerTab[],
    [data.critique, data.outline, data.researchDocuments.length, data.teachingNotes, hasFinalArticle, referenceArticles.length]
  );

  const visibleTabs = useMemo<ViewerTab[]>(
    () =>
      (data.chunkDrafts || []).length > 0
        ? [{ id: 'article', label: tabs[0]?.label || 'Article' }, { id: 'chunks', label: 'Chunk' }, ...tabs.slice(1)]
        : tabs,
    [data.chunkDrafts, tabs]
  );

  useEffect(() => {
    if (!visibleTabs.some((tab) => tab.id === activePanel)) {
      setActivePanel('article');
    }
  }, [activePanel, visibleTabs]);

  const handleMouseUp = (event: React.MouseEvent) => {
    if (refineStatus) return;

    const currentSelection = window.getSelection();
    if (!currentSelection || currentSelection.isCollapsed || !currentSelection.toString().trim()) return;

    const target = event.target as HTMLElement;
    const articleSection = target.closest('[data-section="article"]');
    const notesSection = target.closest('[data-section="notes"]');

    if (articleSection) {
      setSelectionSource('article');
    } else if (notesSection) {
      setSelectionSource('notes');
    } else {
      return;
    }

    const range = currentSelection.getRangeAt(0);
    const rect = range.getBoundingClientRect();
    setSelection(currentSelection.toString().trim());
    setSelectionPos({
      x: rect.left + rect.width / 2,
      y: rect.top,
    });
  };

  const closeMenu = () => {
    setSelection('');
    setSelectionPos(null);
    setSelectionSource(null);
    window.getSelection()?.removeAllRanges();
  };

  const executeRefine = async (instruction: string, selectedText?: string, target?: 'article' | 'notes') => {
    const actualTarget = target || 'article';
    const fullText = actualTarget === 'article' ? data.articleContent : data.teachingNotes;
    if (!fullText) return;

    abortControllerRef.current = false;
    setRefineStatus('正在启动深度编辑...');

    try {
      const nextText = await GeminiService.refineContent(
        data.ammoLibrary,
        fullText,
        instruction,
        selectedText,
        (message) => setRefineStatus(message),
        () => abortControllerRef.current
      );

      if (actualTarget === 'article') {
        onUpdateArticleContent(nextText);
      } else {
        onUpdateTeachingNotes(nextText);
      }
    } catch (error: any) {
      if (error?.message !== 'STOPPED') {
        console.error(error);
        alert(error?.message || '内容改写失败，请稍后再试。');
      }
    } finally {
      setRefineStatus(null);
    }
  };

  const handleSelectionRefine = async (instruction: string) => {
    if (!selection || !selectionSource) return;
    closeMenu();
    await executeRefine(instruction, selection, selectionSource);
  };

  const handleCopilotRefineRequest = async (target: 'article' | 'notes', instruction: string) => {
    await executeRefine(instruction, undefined, target);
  };

  const handlePolish = async () => {
    abortControllerRef.current = false;
    setRefineStatus('正在执行终稿审查...');

    try {
      const polishedArticle = await GeminiService.runFinalPolish(
        data.ammoLibrary,
        data.articleContent || '',
        (message) => setRefineStatus(`正文：${message}`),
        () => abortControllerRef.current,
        referenceArticles,
        'article',
        data.outline || '',
        data.chunkPlan || []
      );
      onUpdateArticleContent(polishedArticle);

      if (data.teachingNotes) {
        const polishedNotes = await GeminiService.runFinalPolish(
          data.ammoLibrary,
          data.teachingNotes,
          (message) => setRefineStatus(`TN：${message}`),
          () => abortControllerRef.current,
          referenceArticles,
          'notes'
        );
        onUpdateTeachingNotes(polishedNotes);
      }
    } catch (error: any) {
      if (error?.message !== 'STOPPED') {
        console.error(error);
        alert(error?.message || '终稿审查失败，请稍后再试。');
      }
    } finally {
      setRefineStatus(null);
    }
  };

  const handleStop = () => {
    abortControllerRef.current = true;
    setRefineStatus('正在停止...');
  };

  const handleUndo = () => {
    if (historyIndex <= 0) return;
    const nextIndex = historyIndex - 1;
    const snapshot = history[nextIndex];
    setHistoryIndex(nextIndex);
    onUpdateArticleContent(snapshot.articleContent);
    onUpdateTeachingNotes(snapshot.teachingNotes);
  };

  const handleRedo = () => {
    if (historyIndex >= history.length - 1) return;
    const nextIndex = historyIndex + 1;
    const snapshot = history[nextIndex];
    setHistoryIndex(nextIndex);
    onUpdateArticleContent(snapshot.articleContent);
    onUpdateTeachingNotes(snapshot.teachingNotes);
  };

  const downloadPDF = async (elementRef: React.RefObject<HTMLDivElement>, filename: string) => {
    const source = elementRef.current;
    if (!source) return;
    const sourceNode = (source.firstElementChild as HTMLDivElement | null) || source;
    const { default: html2pdf } = await import('html2pdf.js');

    setIsDownloading(true);
    if ((document as any).fonts?.ready) {
      await (document as any).fonts.ready;
    }

    const exportHost = document.createElement('div');
    exportHost.style.position = 'fixed';
    exportHost.style.left = '0';
    exportHost.style.top = '0';
    exportHost.style.width = `${EXPORT_PAGE_WIDTH_PX}px`;
    exportHost.style.maxWidth = `${EXPORT_PAGE_WIDTH_PX}px`;
    exportHost.style.padding = '0';
    exportHost.style.margin = '0';
    exportHost.style.background = '#ffffff';
    exportHost.style.opacity = '1';
    exportHost.style.visibility = 'visible';
    exportHost.style.pointerEvents = 'none';
    exportHost.style.overflow = 'visible';
    exportHost.style.zIndex = '-1';
    exportHost.setAttribute('aria-hidden', 'true');

    const clonedRoot = sourceNode.cloneNode(true) as HTMLDivElement;
    clonedRoot.querySelectorAll('.no-print').forEach((node) => node.remove());
    clonedRoot.style.width = `${EXPORT_PAGE_WIDTH_PX}px`;
    clonedRoot.style.maxWidth = `${EXPORT_PAGE_WIDTH_PX}px`;
    clonedRoot.style.minWidth = `${EXPORT_PAGE_WIDTH_PX}px`;
    clonedRoot.style.margin = '0';
    clonedRoot.style.boxSizing = 'border-box';
    clonedRoot.style.boxShadow = 'none';
    clonedRoot.style.borderRadius = '0';
    clonedRoot.style.border = 'none';
    clonedRoot.style.background = '#ffffff';
    clonedRoot.style.overflow = 'visible';
    clonedRoot.style.transform = 'none';
    clonedRoot.style.position = 'relative';
    clonedRoot.style.left = '0';

    exportHost.appendChild(clonedRoot);
    document.body.appendChild(exportHost);

    try {
      await waitForAnimationFrames(3);

      const captureWidth = EXPORT_PAGE_WIDTH_PX;

      await html2pdf()
        .set({
          margin: [10, 10, 10, 10],
          filename,
          image: { type: 'jpeg', quality: 0.98 },
          html2canvas: {
            scale: 2,
            useCORS: true,
            backgroundColor: '#ffffff',
            width: captureWidth,
            windowWidth: captureWidth,
            removeContainer: true,
            scrollX: 0,
            scrollY: 0,
          },
          jsPDF: { unit: 'mm', format: 'a4', orientation: 'portrait' },
          pagebreak: {
            mode: ['avoid-all', 'css', 'legacy'],
            avoid: ['.pdf-avoid-break', 'table', 'tr', 'blockquote', 'h1', 'h2', 'h3'],
          },
        })
        .from(clonedRoot)
        .save();
    } catch (error) {
      console.error('PDF export failed', error);
      alert('PDF 导出失败，请稍后再试。');
    } finally {
      exportHost.remove();
      setIsDownloading(false);
    }
  };

  const downloadPlainTextPDF = async (filename: string) => {
    const previewContent = resolveArticlePreviewContent(viewerData);
    if (!previewContent) return;

    setIsDownloading(true);

    try {
      const [{ jsPDF }, fontBinary] = await Promise.all([import('jspdf'), loadPlainPdfFontBinary()]);
      const doc = new jsPDF({ unit: 'mm', format: 'a4', orientation: 'portrait', compress: true });
      const articleTitleForPdf = extractArticleTitle(data.topic, previewContent);
      const articleBodyForPdf = stripLeadingTitleFromArticle(previewContent, articleTitleForPdf);
      const blocks = buildPlainTextBlocks(articleBodyForPdf);
      const pageWidth = doc.internal.pageSize.getWidth();
      const pageHeight = doc.internal.pageSize.getHeight();
      const marginX = 20;
      const marginTop = 18;
      const marginBottom = 18;
      const contentWidth = pageWidth - marginX * 2;
      const lineHeightFactor = 1.65;
      const ptToMm = (pt: number) => pt * 0.352778;
      let cursorY = marginTop;

      doc.addFileToVFS('YaHei.ttf', fontBinary);
      doc.addFont('YaHei.ttf', 'YaHei', 'normal');
      doc.setFont('YaHei', 'normal');
      doc.setLineHeightFactor(lineHeightFactor);

      const ensurePageSpace = (height: number) => {
        if (cursorY + height <= pageHeight - marginBottom) return;
        doc.addPage();
        doc.setFont('YaHei', 'normal');
        doc.setLineHeightFactor(lineHeightFactor);
        cursorY = marginTop;
      };

      const getTextHeight = (lineCount: number, fontSize: number) => lineCount * ptToMm(fontSize) * lineHeightFactor;

      const drawBlock = (
        text: string,
        options: {
          fontSize: number;
          before?: number;
          after?: number;
          align?: 'left' | 'center';
          color?: [number, number, number];
        }
      ) => {
        const before = options.before ?? 0;
        const after = options.after ?? 0;
        const color = options.color ?? [20, 24, 28];
        doc.setFontSize(options.fontSize);
        doc.setTextColor(color[0], color[1], color[2]);

        const lines = doc.splitTextToSize(text, contentWidth) as string[];
        const blockHeight = before + getTextHeight(lines.length, options.fontSize) + after;
        ensurePageSpace(blockHeight);
        cursorY += before;

        if (options.align === 'center') {
          doc.text(lines, pageWidth / 2, cursorY, { align: 'center' });
        } else {
          doc.text(lines, marginX, cursorY);
        }

        cursorY += getTextHeight(lines.length, options.fontSize) + after;
      };

      drawBlock(articleTitleForPdf, { fontSize: 18, after: 3, align: 'center', color: [15, 23, 42] });
      drawBlock(`${data.options.genre}  ${new Date().getFullYear()}`, {
        fontSize: 9.5,
        after: 5,
        align: 'center',
        color: [100, 116, 139],
      });

      blocks.forEach((block) => {
        if (block.type === 'heading1') {
          drawBlock(block.text, { fontSize: 15, before: 2, after: 2, align: 'center', color: [15, 23, 42] });
          return;
        }

        if (block.type === 'heading2') {
          drawBlock(block.text, { fontSize: 13.5, before: 3, after: 1.5, color: [15, 23, 42] });
          return;
        }

        if (block.type === 'heading3') {
          drawBlock(block.text, { fontSize: 12, before: 2.5, after: 1, color: [30, 41, 59] });
          return;
        }

        if (block.type === 'quote') {
          drawBlock(`    ${block.text}`, { fontSize: 11, before: 1, after: 2, color: [71, 85, 105] });
          return;
        }

        if (block.type === 'table') {
          drawBlock(block.text, { fontSize: 10.5, after: 1.5, color: [71, 85, 105] });
          return;
        }

        if (block.type === 'list') {
          const prefix = block.ordered ? `${block.order}. ` : '- ';
          drawBlock(`${prefix}${block.text}`, { fontSize: 11.5, after: 1 });
          return;
        }

        drawBlock(`　　${block.text}`, { fontSize: 11.5, after: 2 });
      });

      doc.save(filename);
    } catch (error) {
      console.error('Plain text PDF export failed', error);
      alert('纯文字 PDF 导出失败，请稍后再试。');
    } finally {
      setIsDownloading(false);
    }
  };

  const articleFilenameBase = articleTitle.replace(/[\\/:*?"<>|]/g, '_').slice(0, 24) || 'article';
  const articleArchiveRoot = `${sanitizeArchiveSegment(articleTitle, 'article')}_assets`;

  const downloadAssetArchive = async () => {
    const previewContent = resolveArticlePreviewContent(viewerData);
    if (!previewContent) return;

    const exportedAt = new Date();
    const archiveEntries: ArchiveEntry[] = [];
    const orderedAssets = [...(activeIllustrationBundle?.assets || [])].sort((left, right) => {
      const leftSlot =
        activeIllustrationBundle?.slots.find((slot) => slot.id === left.slotId)?.order ?? Number.MAX_SAFE_INTEGER;
      const rightSlot =
        activeIllustrationBundle?.slots.find((slot) => slot.id === right.slotId)?.order ?? Number.MAX_SAFE_INTEGER;
      if (leftSlot !== rightSlot) return leftSlot - rightSlot;
      return left.title.localeCompare(right.title);
    });
    const slotMap = resolveIllustrationSlotMap(activeIllustrationBundle);
    const imageManifestSections: string[] = [];
    const imageWarnings: string[] = [];
    const packagedImagePaths: string[] = [];

    setIsDownloading(true);

    try {
      pushTextArchiveEntry(archiveEntries, `${articleArchiveRoot}/text/article.txt`, previewContent, exportedAt);
      pushTextArchiveEntry(archiveEntries, `${articleArchiveRoot}/text/teaching_notes.txt`, data.teachingNotes, exportedAt);
      pushTextArchiveEntry(archiveEntries, `${articleArchiveRoot}/text/outline.txt`, data.outline, exportedAt);
      pushTextArchiveEntry(archiveEntries, `${articleArchiveRoot}/text/critique.txt`, data.critique, exportedAt);

      data.researchDocuments.forEach((doc, index) => {
        const researchTitle = String(doc.title || `research_${index + 1}`).trim();
        const researchContent = [researchTitle, '', doc.content].filter(Boolean).join('\n');
        pushTextArchiveEntry(
          archiveEntries,
          `${articleArchiveRoot}/text/research/${padArchiveIndex(index + 1)}_${sanitizeArchiveSegment(researchTitle, 'research')}.txt`,
          researchContent,
          exportedAt
        );
      });

      for (let index = 0; index < orderedAssets.length; index += 1) {
        const asset = orderedAssets[index];
        const slot = slotMap.get(asset.slotId);
        const order = slot?.order || index + 1;
        const roleSegment = sanitizeArchiveSegment(slot?.role || asset.role || 'image', 'image');
        const titleSegment = sanitizeArchiveSegment(slot?.title || asset.title || 'asset', 'asset');
        const extension = inferArchiveAssetExtension(asset.mimeType, asset.url);
        const imageRelativePath = `images/${padArchiveIndex(order)}_${roleSegment}_${titleSegment}.${extension}`;
        const imageArchivePath = `${articleArchiveRoot}/${imageRelativePath}`;
        const assetUrl = resolveArchiveAssetUrl(asset.url);

        try {
          if (!assetUrl) {
            throw new Error('缺少图片地址');
          }

          const response = await fetch(assetUrl);
          if (!response.ok) {
            throw new Error(`下载失败：${response.status} ${response.statusText}`);
          }

          archiveEntries.push({
            path: imageArchivePath,
            data: new Uint8Array(await response.arrayBuffer()),
            lastModified: exportedAt,
          });
          packagedImagePaths.push(imageRelativePath);
          imageManifestSections.push(
            [
              `[${padArchiveIndex(order)}]`,
              `文件: ${imageRelativePath}`,
              `标题: ${slot?.title || asset.title || '未命名图片'}`,
              `角色: ${slot?.role || asset.role || 'image'}`,
              `章节: ${slot?.sectionTitle || '正文'}`,
              `说明: ${asset.editorCaption || slot?.explanation || slot?.purpose || ''}`,
              `锚点摘录: ${slot?.anchorExcerpt || ''}`,
              `状态: 已打包`,
              `源地址: ${assetUrl}`,
            ].join('\n')
          );
        } catch (error: any) {
          const message = error?.message || '图片下载失败';
          imageWarnings.push(`${padArchiveIndex(order)} ${slot?.title || asset.title || asset.slotId}: ${message}`);
          imageManifestSections.push(
            [
              `[${padArchiveIndex(order)}]`,
              `文件: ${imageRelativePath}`,
              `标题: ${slot?.title || asset.title || '未命名图片'}`,
              `角色: ${slot?.role || asset.role || 'image'}`,
              `章节: ${slot?.sectionTitle || '正文'}`,
              `说明: ${asset.editorCaption || slot?.explanation || slot?.purpose || ''}`,
              `锚点摘录: ${slot?.anchorExcerpt || ''}`,
              `状态: 下载失败`,
              `失败原因: ${message}`,
              `源地址: ${assetUrl || '无'}`,
            ].join('\n')
          );
        }
      }

      const readmeLines = [
        '素材包导出说明',
        `标题: ${articleTitle}`,
        `导出时间: ${exportedAt.toISOString()}`,
        '文本格式: UTF-8 TXT',
        '图片格式: 保留当前已选中的原始输出文件',
        `正文文件: text/article.txt`,
        data.teachingNotes ? '附加文本: text/teaching_notes.txt' : '',
        data.outline ? '附加文本: text/outline.txt' : '',
        data.critique ? '附加文本: text/critique.txt' : '',
        data.researchDocuments.length ? `研究资料: ${data.researchDocuments.length} 份` : '',
        `已打包图片: ${packagedImagePaths.length} 张`,
        imageWarnings.length ? `图片下载失败: ${imageWarnings.length} 张` : '',
        '',
        '说明:',
        '- 所有文字资产均使用 TXT，便于后续排版软件稳定导入。',
        '- images/ 目录只包含当前界面选中的配图版本。',
        '- text/image_manifest.txt 记录图片位次、章节和说明。',
      ].filter(Boolean);

      const imageManifestLines = [
        '图片素材清单',
        `标题: ${articleTitle}`,
        `导出时间: ${exportedAt.toISOString()}`,
        `当前配图状态: ${activeIllustrationBundle?.status || 'none'}`,
        `已打包图片: ${packagedImagePaths.length}`,
        imageWarnings.length ? `下载失败: ${imageWarnings.length}` : '',
        '',
        ...(imageManifestSections.length > 0 ? imageManifestSections.join('\n\n').split('\n') : ['当前没有可打包的图片。']),
      ].filter(Boolean);

      pushTextArchiveEntry(archiveEntries, `${articleArchiveRoot}/README.txt`, readmeLines.join('\n'), exportedAt);
      pushTextArchiveEntry(
        archiveEntries,
        `${articleArchiveRoot}/text/image_manifest.txt`,
        imageManifestLines.join('\n'),
        exportedAt
      );
      if (imageWarnings.length > 0) {
        pushTextArchiveEntry(
          archiveEntries,
          `${articleArchiveRoot}/text/export_warnings.txt`,
          imageWarnings.join('\n'),
          exportedAt
        );
      }

      const zipBlob = buildZipArchive(archiveEntries);
      downloadBlob(`${articleFilenameBase}_assets.zip`, zipBlob);
    } catch (error: any) {
      console.error('Asset archive export failed', error);
      alert(error?.message || '素材包下载失败，请稍后再试。');
    } finally {
      setIsDownloading(false);
    }
  };

  const renderActivePanel = () => {
    switch (activePanel) {
      case 'article':
        return <ArticleDocument data={viewerData} illustrationActions={illustrationSlotActions} />;
      case 'illustrations':
        return (
          <ProgressiveIllustrationGalleryPanel
            bundle={activeIllustrationBundle}
            job={illustrationJob}
            isGenerating={illustrationStatus === 'generating'}
            isCanceling={illustrationStatus === 'canceling'}
            status={illustrationStatus}
            errorMessage={illustrationError}
            onRegenerateAll={() => openIllustrationPromptDialog(activeIllustrationBundle ? 'regenerate' : 'initial')}
            onCancelAll={() => void handleCancelIllustrations()}
            slotActions={illustrationSlotActions}
          />
        );
      case 'wechat':
        return (
          <WechatPublisherPanel
            topic={articleTitle}
            articleContent={data.articleContent || ''}
            illustrationBundle={activeIllustrationBundle}
            layout={data.wechatLayout}
            draft={data.wechatDraft}
            onUpdateLayout={onUpdateWechatLayout}
            onUpdateDraft={onUpdateWechatDraft}
          />
        );
      case 'chunks':
        return <ChunkDraftsPanel data={viewerData} />;
      case 'references':
        return <ReferenceTemplatesPanel articles={referenceArticles} />;
      case 'task':
        return <TaskSummaryPanel data={viewerData} referenceCount={referenceArticles.length} />;
      case 'outline':
        return (
          <PanelShell title="提纲" description="批准后进入写作的结构底稿。">
            <MarkdownRenderer content={data.outline || ''} />
          </PanelShell>
        );
      case 'research':
        return (
          <PanelShell title="研究资料" description="三路搜索显示为研究笔记，Deep Research 只保留清洗后的 Agent 文本输出。">
            <div className="space-y-6">
              {data.researchDocuments.map((doc) => (
                <section key={doc.id} className="rounded-2xl border border-slate-200 bg-slate-50/70 p-6">
                  <h3 className="mb-4 font-serif text-xl font-bold text-slate-900">{doc.title}</h3>
                  <MarkdownRenderer content={doc.content} />
                </section>
              ))}
            </div>
          </PanelShell>
        );
      case 'critique':
        return (
          <PanelShell title="审查" description="终稿前的审查意见与本地风格检查。">
            <MarkdownRenderer content={data.critique || ''} />
          </PanelShell>
        );
      case 'notes':
        return <NotesDocument data={viewerData} />;
      default:
        return <ArticleDocument data={viewerData} />;
    }
  };

  return (
    <div className="relative min-h-screen w-full bg-report-bg pb-24" onMouseUp={handleMouseUp}>
      {refineStatus && (
        <div className="fixed inset-0 z-[100] flex animate-fade-in flex-col items-center justify-center bg-white/90 backdrop-blur-md no-print">
          <div className="relative mb-8 h-24 w-24">
            <div className="absolute inset-0 rounded-full border-4 border-gray-100" />
            <div className="absolute inset-0 animate-spin rounded-full border-4 border-report-accent border-t-transparent" />
          </div>
          <h3 className="mb-2 font-serif text-3xl font-bold tracking-tight text-slate-900">AI 正在重整成文</h3>
          <p className="mb-8 font-mono text-sm uppercase tracking-wider text-report-accent animate-pulse">{refineStatus}</p>
          <button
            onClick={handleStop}
            className="flex items-center gap-2 rounded-full border border-red-200 bg-white px-6 py-2 text-sm font-bold text-red-500 shadow-sm transition-colors hover:bg-red-50"
          >
            <StopIcon className="h-4 w-4" />
            停止
          </button>
        </div>
      )}

      {illustrationPromptMode && (
        <div className="fixed inset-0 z-[96] flex items-center justify-center bg-slate-950/40 px-4 backdrop-blur-sm no-print">
          <div className="w-full max-w-2xl rounded-[28px] border border-slate-200 bg-white p-6 shadow-2xl sm:p-8">
            <div className="mb-5">
              <h3 className="font-serif text-2xl font-bold text-slate-900">
                {illustrationPromptMode === 'regenerate' ? '重跑整组配图' : '先补充整组配图要求'}
              </h3>
              <p className="mt-2 text-sm leading-relaxed text-slate-500">
                在出图前先写下你希望的整体风格、特殊限制、重点元素或禁用元素。留空也可以，系统会按默认视觉系统生成。
              </p>
            </div>

            <label className="block text-sm font-medium text-slate-700" htmlFor="illustration-batch-count-prompt">
              {'\u914d\u56fe\u6570\u91cf / \u89c4\u5219'}
            </label>
            <input
              id="illustration-batch-count-prompt"
              value={illustrationCountPromptDraft}
              onChange={(event) => setIllustrationCountPromptDraft(event.target.value)}
              placeholder={
                '\u4f8b\u5982\uff1a3 \u5f20 / 5 \u5f20 / \u6bcf\u4e2a\u5b50\u6a21\u5757\u4e00\u5f20 / \u6bcf\u4e2a\u4e8c\u7ea7\u6807\u9898\u4e00\u5f20'
              }
              className="mt-3 w-full rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm leading-relaxed text-slate-700 outline-none transition-colors focus:border-report-accent focus:bg-white"
            />
            <p className="mt-2 text-xs leading-relaxed text-slate-500">
              {
                '\u53ef\u4ee5\u76f4\u63a5\u8bf4\u6570\u5b57\uff0c\u4e5f\u53ef\u4ee5\u5199\u89c4\u5219\uff0c\u4f8b\u5982\u201c\u6bcf\u4e2a\u5b50\u6a21\u5757\u4e00\u5f20\u201d\u3002\u7cfb\u7edf\u4f1a\u7ed3\u5408\u6587\u7ae0\u7ed3\u6784\u7406\u89e3\u6210\u6700\u7ec8\u5f20\u6570\u3002'
              }
            </p>

            <label className="mt-5 block text-sm font-medium text-slate-700" htmlFor="illustration-batch-prompt">
              整组配图要求
            </label>
            <div className="mt-5 rounded-2xl border border-dashed border-slate-200 bg-slate-50/70 p-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <div className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-400">Style Sample</div>
                  <div className="mt-1 text-sm text-slate-600">
                    上传 1 张风格样张，AI 会参考它的构图、色彩、质感和视觉气质，但不会照搬里面的具体主体。
                  </div>
                </div>
                <label className="inline-flex cursor-pointer items-center rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm font-medium text-slate-700 transition-colors hover:bg-slate-100">
                  上传样张
                  <input
                    type="file"
                    accept={ILLUSTRATION_STYLE_REFERENCE_ACCEPT}
                    className="hidden"
                    onChange={(event) => void handleIllustrationStyleReferenceUpload(event)}
                  />
                </label>
              </div>
              <div className="mt-2 text-xs leading-relaxed text-slate-400">仅支持 PNG / JPG / WEBP，单张不超过 4MB。</div>
              {illustrationStyleReferenceError ? (
                <div className="mt-2 text-xs leading-relaxed text-rose-500">{illustrationStyleReferenceError}</div>
              ) : null}
              {illustrationStyleReference ? (
                <div className="mt-4 overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
                  <div className="relative aspect-[4/3] bg-slate-100">
                    <img
                      src={illustrationStyleReference.dataUrl}
                      alt={illustrationStyleReference.name}
                      className="h-full w-full object-cover"
                    />
                    <button
                      type="button"
                      onClick={handleRemoveIllustrationStyleReference}
                      className="absolute right-2 top-2 rounded-full bg-slate-950/70 px-2 py-1 text-xs font-medium text-white"
                    >
                      移除
                    </button>
                  </div>
                  <div className="px-3 py-3">
                    <div className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-400">Current Sample</div>
                    <div className="mt-1 truncate text-sm text-slate-600" title={illustrationStyleReference.name}>
                      {illustrationStyleReference.name}
                    </div>
                  </div>
                </div>
              ) : null}
            </div>

            <textarea
              id="illustration-batch-prompt"
              value={illustrationPromptDraft}
              onChange={(event) => setIllustrationPromptDraft(event.target.value)}
              rows={7}
              placeholder="例如：整体更克制一些，偏纪实商业杂志风；重点突出门店经营压力和供应链关系；避免夸张灯牌、广告海报感和无关城市地标。"
              className="mt-3 w-full rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm leading-relaxed text-slate-700 outline-none transition-colors focus:border-report-accent focus:bg-white"
            />

            {illustrationError ? (
              <div className="mt-4 rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm leading-relaxed text-red-700">
                {illustrationError}
              </div>
            ) : null}

            <div className="mt-6 flex flex-wrap items-center justify-end gap-3">
              <button
                onClick={closeIllustrationPromptDialog}
                className="rounded-xl border border-slate-200 bg-white px-4 py-2 text-sm font-medium text-slate-600 transition-colors hover:bg-slate-50 disabled:opacity-50"
              >
                取消
              </button>
              <button
                onClick={() => void handleIllustrationPromptSubmit()}
                disabled={isIllustrationBusy}
                className="inline-flex items-center gap-2 rounded-xl bg-report-accent px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-teal-800 disabled:opacity-50"
              >
                {isIllustrationBusy ? <ArrowPathIcon className="h-4 w-4 animate-spin" /> : null}
                {isIllustrationBusy
                  ? illustrationStatus === 'canceling'
                    ? '停止中'
                    : '配图启动中'
                  : illustrationPromptMode === 'regenerate'
                    ? '按这个要求重跑'
                    : '开始生成配图'}
              </button>
            </div>
          </div>
        </div>
      )}

      {regeneratePromptSlotId && (
        <div className="fixed inset-0 z-[95] flex items-center justify-center bg-slate-950/40 px-4 backdrop-blur-sm no-print">
          <div className="w-full max-w-2xl rounded-[28px] border border-slate-200 bg-white p-6 shadow-2xl sm:p-8">
            <div className="mb-5">
              <h3 className="font-serif text-2xl font-bold text-slate-900">重新生成这张图</h3>
              <p className="mt-2 text-sm leading-relaxed text-slate-500">
                {activeRegenerateSlot?.title || '当前图位'}会在保留整篇视觉系统的前提下，按照你补充的要求重新生成。
              </p>
            </div>

            <label className="block text-sm font-medium text-slate-700" htmlFor="illustration-regenerate-prompt">
              你想要什么样的图
            </label>
            <textarea
              id="illustration-regenerate-prompt"
              value={regeneratePromptDraft}
              onChange={(event) => setRegeneratePromptDraft(event.target.value)}
              rows={6}
              placeholder="例如：更强调供应链关系，弱化门店招牌；画面更克制，少一点广告感；突出东南亚街头环境和物流细节。"
              className="mt-3 w-full rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm leading-relaxed text-slate-700 outline-none transition-colors focus:border-report-accent focus:bg-white"
            />

            {illustrationError ? (
              <div className="mt-4 rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm leading-relaxed text-red-700">
                {illustrationError}
              </div>
            ) : null}

            <div className="mt-6 flex flex-wrap items-center justify-end gap-3">
              <button
                onClick={() => closeRegeneratePromptDialog(true)}
                className="rounded-xl border border-slate-200 bg-white px-4 py-2 text-sm font-medium text-slate-600 transition-colors hover:bg-slate-50 disabled:opacity-50"
              >
                {illustrationMutationSlotId ? '取消并停止' : '取消'}
              </button>
              <button
                onClick={() => activeRegenerateSlot && void handleRegenerateSlot(activeRegenerateSlot)}
                disabled={!activeRegenerateSlot || illustrationMutationSlotId !== null}
                className="inline-flex items-center gap-2 rounded-xl bg-report-accent px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-teal-800 disabled:opacity-50"
              >
                {illustrationMutationSlotId ? <ArrowPathIcon className="h-4 w-4 animate-spin" /> : null}
                {illustrationMutationSlotId ? '生成中' : '开始重生'}
              </button>
            </div>
          </div>
        </div>
      )}

      {captionPromptSlotId && (
        <div className="fixed inset-0 z-[95] flex items-center justify-center bg-slate-950/40 px-4 backdrop-blur-sm no-print">
          <div className="w-full max-w-2xl rounded-[28px] border border-slate-200 bg-white p-6 shadow-2xl sm:p-8">
            <div className="mb-5">
              <h3 className="font-serif text-2xl font-bold text-slate-900">修改这张图的图释</h3>
              <p className="mt-2 text-sm leading-relaxed text-slate-500">
                图片本身不会改动，只会基于当前这张图和全文语境，按你的要求重写图释。
              </p>
            </div>

            <div className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3">
              <p className="text-xs font-bold uppercase tracking-wider text-slate-400">当前图释</p>
              <p className="mt-2 text-sm leading-relaxed text-slate-700">
                {activeCaptionSlot?.explanation || activeCaptionSlot?.purpose || activeCaptionSlot?.anchorExcerpt || '当前还没有图释。'}
              </p>
            </div>

            <label className="mt-5 block text-sm font-medium text-slate-700" htmlFor="illustration-caption-prompt">
              你想怎么改图释
            </label>
            <textarea
              id="illustration-caption-prompt"
              value={captionPromptDraft}
              onChange={(event) => setCaptionPromptDraft(event.target.value)}
              rows={6}
              placeholder="例如：更像新闻现场图注，少一点总结判断；第一句更具体写人物/场景，第二句再轻轻带出文章观点；语气再克制一点。"
              className="mt-3 w-full rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm leading-relaxed text-slate-700 outline-none transition-colors focus:border-report-accent focus:bg-white"
            />

            {illustrationError ? (
              <div className="mt-4 rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm leading-relaxed text-red-700">
                {illustrationError}
              </div>
            ) : null}

            <div className="mt-6 flex flex-wrap items-center justify-end gap-3">
              <button
                onClick={() => closeCaptionPromptDialog(true)}
                className="rounded-xl border border-slate-200 bg-white px-4 py-2 text-sm font-medium text-slate-600 transition-colors hover:bg-slate-50 disabled:opacity-50"
              >
                {illustrationMutationKind === 'caption' ? '取消并停止' : '取消'}
              </button>
              <button
                onClick={() => activeCaptionSlot && void handleRewriteCaption(activeCaptionSlot)}
                disabled={!activeCaptionSlot || illustrationMutationSlotId !== null}
                className="inline-flex items-center gap-2 rounded-xl bg-report-accent px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-teal-800 disabled:opacity-50"
              >
                {illustrationMutationKind === 'caption' ? <ArrowPathIcon className="h-4 w-4 animate-spin" /> : null}
                {illustrationMutationKind === 'caption' ? '修改中' : '更新图释'}
              </button>
            </div>
          </div>
        </div>
      )}

      <div className="sticky top-0 z-40 border-b border-gray-200 bg-white shadow-sm no-print">
        <div className="mx-auto flex h-16 max-w-7xl items-center justify-between px-4">
          <div className="flex items-center gap-3">
            <span className="font-serif text-xl font-bold text-slate-800">Writing Workspace</span>
            <span className="rounded-md bg-gray-100 px-2 py-1 font-mono text-xs text-gray-500">v{historyIndex + 1}</span>
          </div>

          <div className="flex items-center gap-3">
            <div className="flex items-center gap-1 rounded-lg border border-gray-100 bg-gray-50 p-1">
              <button
                onClick={handleUndo}
                disabled={historyIndex <= 0 || !!refineStatus}
                className="rounded-md p-1.5 text-gray-500 transition-all hover:bg-white hover:text-slate-800 disabled:opacity-30"
                title="上一版"
              >
                <ChevronLeftIcon className="h-4 w-4" />
              </button>
              <button
                onClick={handleRedo}
                disabled={historyIndex >= history.length - 1 || !!refineStatus}
                className="rounded-md p-1.5 text-gray-500 transition-all hover:bg-white hover:text-slate-800 disabled:opacity-30"
                title="下一版"
              >
                <ChevronRightIcon className="h-4 w-4" />
              </button>
            </div>

            <button
              onClick={() => setShowCopilot(true)}
              disabled={!hasFinalArticle}
              className={`flex items-center gap-2 rounded-lg border px-4 py-2 text-sm font-medium transition-colors ${
                showCopilot
                  ? 'border-report-accent bg-teal-50 text-report-accent'
                  : 'border-gray-200 bg-white text-gray-600 hover:bg-gray-50'
              } disabled:cursor-not-allowed disabled:opacity-50`}
            >
              <ChatBubbleLeftRightIcon className="h-4 w-4" />
              Copilot
            </button>

            <button
              onClick={handlePolish}
              disabled={!!refineStatus || !hasFinalArticle}
              className="flex items-center gap-2 rounded-lg border border-gray-200 bg-white px-4 py-2 text-sm font-medium text-gray-600 transition-colors hover:bg-gray-50 disabled:opacity-50"
            >
              <ShieldCheckIcon className="h-4 w-4 text-orange-500" />
              审查
            </button>

            <button
              onClick={() => openIllustrationPromptDialog(activeIllustrationBundle ? 'regenerate' : 'initial')}
              disabled={!hasFinalArticle || isIllustrationBusy}
              className="flex items-center gap-2 rounded-lg border border-gray-200 bg-white px-4 py-2 text-sm font-medium text-gray-600 transition-colors hover:bg-gray-50 disabled:opacity-50"
            >
              <ArrowPathIcon className={`h-4 w-4 ${isIllustrationBusy ? 'animate-spin text-report-accent' : ''}`} />
              {illustrationStatus === 'canceling'
                ? '停止中'
                : illustrationStatus === 'generating'
                  ? '配图中'
                  : illustrationStatus === 'canceled'
                    ? '调整 Prompt 重跑'
                    : activeIllustrationBundle
                      ? '重跑配图'
                      : '生成配图'}
            </button>

            <button
              onClick={() => downloadTextFile(`${articleFilenameBase}.md`, previewArticleContent, 'text/markdown;charset=utf-8')}
              disabled={!previewArticleContent || isDownloading}
              className="flex items-center gap-2 rounded-lg border border-gray-200 bg-white px-4 py-2 text-sm font-medium text-gray-700 shadow-sm transition-colors hover:bg-gray-50 disabled:opacity-60"
            >
              <DocumentDuplicateIcon className="h-4 w-4" />
              正文 MD
            </button>

            <button
              onClick={() => void downloadAssetArchive()}
              disabled={!previewArticleContent || isDownloading}
              className="flex items-center gap-2 rounded-lg border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-700 shadow-sm transition-colors hover:bg-gray-50 disabled:opacity-60"
            >
              {isDownloading ? <ArrowPathIcon className="h-4 w-4 animate-spin" /> : <ArrowDownTrayIcon className="h-4 w-4" />}
              素材包 ZIP
            </button>

            <button
              onClick={() => downloadPDF(articleExportRef, `${articleFilenameBase}.pdf`)}
              disabled={isDownloading}
              className="flex items-center gap-2 rounded-lg border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-700 shadow-sm transition-colors hover:bg-gray-50 disabled:opacity-60"
            >
              <ArrowDownTrayIcon className="h-4 w-4" />
              正文 PDF
            </button>

            <button
              onClick={() => downloadPlainTextPDF(`${articleFilenameBase}_plain.pdf`)}
              disabled={isDownloading}
              className="hidden"
            >
              <ArrowDownTrayIcon className="h-4 w-4" />
              纯文字 PDF
            </button>

            <button
              onClick={() => downloadPlainTextPDF(`${articleFilenameBase}_plain.pdf`)}
              disabled={isDownloading}
              className="flex items-center gap-2 rounded-lg border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-700 shadow-sm transition-colors hover:bg-gray-50 disabled:opacity-60"
            >
              <ArrowDownTrayIcon className="h-4 w-4" />
              Plain PDF
            </button>

            {data.teachingNotes && (
              <button
                onClick={() => downloadPDF(notesExportRef, `${articleFilenameBase}_TN.pdf`)}
                disabled={isDownloading}
                className="flex items-center gap-2 rounded-lg bg-report-accent px-4 py-2 text-sm font-medium text-white shadow-sm transition-colors hover:bg-teal-800 disabled:opacity-60"
              >
                <ArrowDownTrayIcon className="h-4 w-4" />
                TN PDF
              </button>
            )}

            <button onClick={onReset} className="p-2 text-gray-400 transition-colors hover:text-red-500" title="重置">
              <ArrowPathIcon className="h-5 w-5" />
            </button>
          </div>
        </div>
      </div>

      <div className="mx-auto max-w-7xl px-4 pb-20 pt-8">
        <div className="mb-6 flex flex-wrap items-center gap-3 no-print">
          {visibleTabs.map((tab) => (
            <button
              key={tab.id}
              onClick={() => setActivePanel(tab.id)}
              className={`rounded-full px-4 py-2 text-sm font-semibold transition-colors ${
                activePanel === tab.id
                  ? 'bg-slate-900 text-white shadow-sm'
                  : 'bg-white text-slate-600 ring-1 ring-slate-200 hover:bg-slate-50'
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>

        {renderActivePanel()}
      </div>

      <div
        className="pointer-events-none absolute z-[-1] overflow-visible"
        style={{ left: '-100000px', top: 0, width: `${EXPORT_PAGE_WIDTH_PX}px` }}
        aria-hidden="true"
      >
        <div ref={articleExportRef} style={{ width: `${EXPORT_PAGE_WIDTH_PX}px` }}>
          <ArticleDocument data={viewerData} exportMode />
        </div>
        <div ref={plainArticleExportRef} style={{ width: `${EXPORT_PAGE_WIDTH_PX}px` }}>
          <PlainTextArticleDocument data={viewerData} exportMode />
        </div>
        {data.teachingNotes && (
          <div ref={notesExportRef} style={{ width: `${EXPORT_PAGE_WIDTH_PX}px` }}>
            <NotesDocument data={viewerData} exportMode />
          </div>
        )}
      </div>

      {showCopilot && (
        <div className="fixed inset-0 z-50 flex justify-end no-print">
          <div className="absolute inset-0 bg-slate-900/10 backdrop-blur-sm" onClick={() => setShowCopilot(false)} />
          <WritingCopilot
            ammoLibrary={data.ammoLibrary}
            articleContent={data.articleContent || ''}
            teachingNotes={data.teachingNotes || ''}
            onRequestRefine={handleCopilotRefineRequest}
            onClose={() => setShowCopilot(false)}
          />
        </div>
      )}

      <SelectionMenu
        position={selectionPos}
        selectedText={selection}
        onClose={closeMenu}
        onSubmit={handleSelectionRefine}
        isLoading={!!refineStatus}
      />
    </div>
  );
};
