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
} from '@heroicons/react/24/outline';
import { WritingProjectData } from '../types';
import * as GeminiService from '../services/geminiService';
import { MarkdownRenderer } from './MarkdownRenderer';
import { SelectionMenu } from './SelectionMenu';
import { WritingCopilot } from './WritingCopilot';

interface ArticleViewerProps {
  data: WritingProjectData;
  onReset: () => void;
  onUpdateArticleContent: (content: string) => void;
  onUpdateTeachingNotes: (notes: string) => void;
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

type ViewerPanel = 'article' | 'chunks' | 'references' | 'task' | 'outline' | 'research' | 'critique' | 'notes';

interface ViewerTab {
  id: ViewerPanel;
  label: string;
}

const downloadTextFile = (filename: string, content: string) => {
  const blob = new Blob([content], { type: 'text/markdown;charset=utf-8' });
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
let plainPdfFontBinaryPromise: Promise<string> | null = null;

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

const ArticleDocument: React.FC<{ data: ViewerData; exportMode?: boolean }> = ({ data, exportMode = false }) => {
  const previewContent = resolveArticlePreviewContent(data);
  const articleTitle = extractArticleTitle(data.topic, previewContent);
  const articleBody = stripLeadingTitleFromArticle(previewContent, articleTitle);
  const isDraftPreview = !data.articleContent && Boolean(previewContent);

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

      <section className="article-copy mb-12">
        <MarkdownRenderer content={articleBody} />
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
  const [selection, setSelection] = useState('');
  const [selectionPos, setSelectionPos] = useState<{ x: number; y: number } | null>(null);
  const [selectionSource, setSelectionSource] = useState<'article' | 'notes' | null>(null);
  const [activePanel, setActivePanel] = useState<ViewerPanel>('article');

  const abortControllerRef = useRef(false);
  const articleExportRef = useRef<HTMLDivElement>(null);
  const plainArticleExportRef = useRef<HTMLDivElement>(null);
  const notesExportRef = useRef<HTMLDivElement>(null);

  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [historyIndex, setHistoryIndex] = useState(0);

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

  const tabs = useMemo<ViewerTab[]>(
    () =>
      [
        { id: 'article', label: '正文' },
        ...(referenceArticles.length > 0 ? [{ id: 'references' as const, label: '参考模板' }] : []),
        { id: 'task', label: '任务摘要' },
        ...(data.outline ? [{ id: 'outline' as const, label: '提纲' }] : []),
        ...(data.researchDocuments.length > 0 ? [{ id: 'research' as const, label: '研究资料' }] : []),
        ...(data.critique ? [{ id: 'critique' as const, label: '审查' }] : []),
        ...(data.teachingNotes ? [{ id: 'notes' as const, label: 'TN' }] : []),
      ] satisfies ViewerTab[],
    [data.critique, data.outline, data.researchDocuments.length, data.teachingNotes, referenceArticles.length]
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

  const renderActivePanel = () => {
    switch (activePanel) {
      case 'article':
        return <ArticleDocument data={viewerData} />;
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
              onClick={() => downloadTextFile(`${articleFilenameBase}.md`, previewArticleContent)}
              className="flex items-center gap-2 rounded-lg border border-gray-200 bg-white px-4 py-2 text-sm font-medium text-gray-700 shadow-sm transition-colors hover:bg-gray-50"
            >
              <DocumentDuplicateIcon className="h-4 w-4" />
              正文 MD
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
