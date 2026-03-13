import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { GoogleGenAI, Type, createPartFromBase64 } from '@google/genai';
import sharp from 'sharp';
import { ProxyAgent, setGlobalDispatcher } from 'undici';

const ROOT_DIR = process.cwd();
const GENERATED_ASSET_ROOT = path.resolve(process.env.GENERATED_ASSET_ROOT || path.join(ROOT_DIR, 'generated_assets'));
const WECHAT_API_ORIGIN = 'https://api.weixin.qq.com';
const DEFAULT_TEMPLATE_ID = 'latepost_report';
const DEFAULT_AUTHOR = process.env.WECHAT_OFFICIAL_DEFAULT_AUTHOR || 'AI Writer';
const DEFAULT_SOURCE_URL = process.env.WECHAT_OFFICIAL_DEFAULT_SOURCE_URL || '';
const INLINE_IMAGE_MAX_BYTES = 950 * 1024;
const COVER_IMAGE_MAX_BYTES = 1200 * 1024;
const INLINE_IMAGE_WIDTH = 1280;
const COVER_IMAGE_WIDTH = 900;
const WECHAT_BEAUTY_AGENT_MODEL = 'gemini-3.1-pro-preview';
const WECHAT_BEAUTY_AGENT_TIMEOUT_MS = 45 * 1000;
const WECHAT_RENDERER_VERSION = 'beauty_plan_v5';
const WECHAT_OPENING_HIGHLIGHT_MODES = new Set(['off', 'first_sentence', 'smart_lead']);

const proxyUrl = process.env.HTTPS_PROXY || process.env.HTTP_PROXY || '';
if (proxyUrl) {
  setGlobalDispatcher(new ProxyAgent(proxyUrl));
}

const WECHAT_TEMPLATE_OPTIONS = [
  {
    id: 'latepost_report',
    label: '晚点报道版',
    description: '克制留白、蓝灰标题条、适合公司观察和商业报道。',
  },
  {
    id: 'insight_brief',
    label: '商业简报版',
    description: '更强的信息卡片感，适合观点拆解和结论先行。',
  },
  {
    id: 'warm_column',
    label: '专栏长文版',
    description: '更柔和的专栏气质，适合人物、案例和长文叙事。',
  },
];

const WECHAT_TEMPLATE_THEMES = {
  latepost_report: {
    pageBackground: '#F5F7FB',
    cardBackground: '#FFFFFF',
    cardBorder: '#D8E1F0',
    headerGradient: 'linear-gradient(135deg, #1F3A5F 0%, #325C8A 100%)',
    headerText: '#FFFFFF',
    titleColor: '#0F172A',
    bodyColor: '#334155',
    mutedColor: '#64748B',
    accent: '#2B5A88',
    accentSoft: '#E8F0F8',
    quoteBorder: '#2B5A88',
    quoteBackground: '#F3F7FC',
    sectionBackground: '#EEF4FB',
    sectionColor: '#23486D',
    tableHeaderBackground: '#E7EEF7',
    tableStripeBackground: '#F8FBFF',
  },
  insight_brief: {
    pageBackground: '#F4FBF8',
    cardBackground: '#FFFFFF',
    cardBorder: '#CFE7DE',
    headerGradient: 'linear-gradient(135deg, #0F766E 0%, #118A7E 100%)',
    headerText: '#FFFFFF',
    titleColor: '#083344',
    bodyColor: '#24414A',
    mutedColor: '#5B737B',
    accent: '#0F766E',
    accentSoft: '#E5F5F1',
    quoteBorder: '#0F766E',
    quoteBackground: '#EFFAF7',
    sectionBackground: '#E7F7F2',
    sectionColor: '#0D5C56',
    tableHeaderBackground: '#DCF3EC',
    tableStripeBackground: '#F6FCFA',
  },
  warm_column: {
    pageBackground: '#FBF7F1',
    cardBackground: '#FFFFFF',
    cardBorder: '#E7DCCB',
    headerGradient: 'linear-gradient(135deg, #7C4F2A 0%, #A66A36 100%)',
    headerText: '#FFFDF8',
    titleColor: '#4A3423',
    bodyColor: '#5A4636',
    mutedColor: '#7C6A5C',
    accent: '#9B6230',
    accentSoft: '#F5E8DA',
    quoteBorder: '#9B6230',
    quoteBackground: '#FCF4EA',
    sectionBackground: '#F8EEE2',
    sectionColor: '#714A27',
    tableHeaderBackground: '#F1E1CF',
    tableStripeBackground: '#FDF9F4',
  },
};

let accessTokenCache = {
  accessToken: '',
  expiresAt: 0,
};

const WECHAT_BEAUTY_PLAN_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    credits_variant: { type: Type.STRING },
    heading_styles: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          block_index: { type: Type.NUMBER },
          variant: { type: Type.STRING },
        },
        required: ['block_index', 'variant'],
      },
    },
    paragraph_styles: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          block_index: { type: Type.NUMBER },
          variant: { type: Type.STRING },
        },
        required: ['block_index', 'variant'],
      },
    },
    quote_styles: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          block_index: { type: Type.NUMBER },
          variant: { type: Type.STRING },
        },
        required: ['block_index', 'variant'],
      },
    },
    list_styles: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          block_index: { type: Type.NUMBER },
          variant: { type: Type.STRING },
        },
        required: ['block_index', 'variant'],
      },
    },
    table_styles: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          block_index: { type: Type.NUMBER },
          variant: { type: Type.STRING },
        },
        required: ['block_index', 'variant'],
      },
    },
    image_styles: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          block_index: { type: Type.NUMBER },
          variant: { type: Type.STRING },
        },
        required: ['block_index', 'variant'],
      },
    },
    highlight_sentences: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          block_index: { type: Type.NUMBER },
          text: { type: Type.STRING },
          variant: { type: Type.STRING },
        },
        required: ['block_index', 'text', 'variant'],
      },
    },
    divider_after_blocks: {
      type: Type.ARRAY,
      items: { type: Type.NUMBER },
    },
    notes: {
      type: Type.ARRAY,
      items: { type: Type.STRING },
    },
  },
  required: [
    'credits_variant',
    'heading_styles',
    'paragraph_styles',
    'quote_styles',
    'list_styles',
    'table_styles',
    'image_styles',
    'highlight_sentences',
    'divider_after_blocks',
    'notes',
  ],
};

const cleanText = (value) => String(value || '').replace(/\r\n/g, '\n').trim();

const clip = (value, maxLength = 120) => {
  const normalized = cleanText(value);
  return normalized.length <= maxLength ? normalized : `${normalized.slice(0, maxLength)}…`;
};

const escapeHtml = (value) =>
  String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

const stripMarkdownInline = (value) =>
  cleanText(
    String(value || '')
      .replace(/!\[[^\]]*\]\([^)]+\)/g, '')
      .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1')
      .replace(/`([^`]+)`/g, '$1')
      .replace(/\*\*([^*]+)\*\*/g, '$1')
      .replace(/__([^_]+)__/g, '$1')
      .replace(/\*([^*]+)\*/g, '$1')
      .replace(/_([^_]+)_/g, '$1')
      .replace(/~~([^~]+)~~/g, '$1')
  );

const stripMarkdownTitleDecorators = (line) =>
  stripMarkdownInline(
    String(line || '')
      .trim()
      .replace(/^#{1,6}\s+/, '')
      .replace(/^>\s+/, '')
      .replace(/^[-*+]\s+/, '')
      .replace(/^\d+\.\s+/, '')
  );

const toCommentFlag = (value) => (value ? 1 : 0);

const safeUrl = (value) => {
  const normalized = cleanText(value);
  return /^https?:\/\//i.test(normalized) ? normalized : '';
};

const normalizeCreditLines = (value) => {
  if (Array.isArray(value)) {
    return value.map((line) => cleanText(line)).filter(Boolean).slice(0, 6);
  }
  if (typeof value === 'string') {
    return value
      .split('\n')
      .map((line) => cleanText(line))
      .filter(Boolean)
      .slice(0, 6);
  }
  return [];
};

const decodeInlineImageDataUrl = (value) => {
  const matched = String(value || '').match(/^data:([^;]+);base64,(.+)$/);
  if (!matched) {
    return null;
  }
  const mimeType = cleanText(matched[1]).toLowerCase();
  if (!['image/png', 'image/jpeg', 'image/jpg', 'image/webp'].includes(mimeType)) {
    return null;
  }
  return {
    mimeType: mimeType === 'image/jpg' ? 'image/jpeg' : mimeType,
    data: matched[2].replace(/\s+/g, ''),
  };
};

const normalizeWechatStyleReferenceImages = (value) =>
  (Array.isArray(value) ? value : [])
    .map((item, index) => {
      const decoded = decodeInlineImageDataUrl(item?.dataUrl);
      if (!decoded) {
        return null;
      }
      return {
        id: cleanText(item?.id) || `style-reference-${index + 1}`,
        name: cleanText(item?.name) || `style-reference-${index + 1}`,
        mimeType: decoded.mimeType,
        dataUrl: `data:${decoded.mimeType};base64,${decoded.data}`,
      };
    })
    .filter(Boolean)
    .slice(0, 3);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const withTimeout = async (promise, ms, label) => {
  let timer = null;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`${label} timed out after ${Math.round(ms / 1000)}s.`));
        }, ms);
      }),
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
};

const callWithRetry = async (work, retries = 2, baseDelay = 800) => {
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

const createGenAiClient = (apiKey, timeoutMs) =>
  new GoogleGenAI({
    apiKey,
    httpOptions: {
      timeout: timeoutMs,
    },
  });

const buildStableHash = (value) => crypto.createHash('sha1').update(JSON.stringify(value)).digest('hex').slice(0, 12);

const resolveTemplateOption = (templateId) =>
  WECHAT_TEMPLATE_OPTIONS.find((option) => option.id === templateId) || WECHAT_TEMPLATE_OPTIONS[0];

const extractTitle = (fallback, content) => {
  const lines = String(content || '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  const heading = lines.find((line) => /^#\s+/.test(line));
  return stripMarkdownTitleDecorators(heading || fallback) || '未命名文章';
};

const inferDigest = (content) => {
  const lines = String(content || '')
    .split('\n')
    .map((line) => stripMarkdownTitleDecorators(line))
    .filter(Boolean)
    .filter((line) => !/^#{1,6}\s+/.test(line));
  return clip(lines.slice(0, 2).join(' '), 110);
};

const resolveTemplateTheme = (templateId) => WECHAT_TEMPLATE_THEMES[templateId] || WECHAT_TEMPLATE_THEMES[DEFAULT_TEMPLATE_ID];

const normalizeWechatLayoutSettings = (layout = {}) => ({
  templateId: resolveTemplateOption(layout.templateId).id,
  author: cleanText(layout.author) || DEFAULT_AUTHOR,
  editor: cleanText(layout.editor) || undefined,
  creditLines: normalizeCreditLines(layout.creditLines),
  digest: cleanText(layout.digest),
  contentSourceUrl: safeUrl(layout.contentSourceUrl || DEFAULT_SOURCE_URL),
  coverStrategy: ['hero', 'first_ready', 'manual'].includes(String(layout.coverStrategy)) ? String(layout.coverStrategy) : 'hero',
  preferredCoverAssetId: cleanText(layout.preferredCoverAssetId) || undefined,
  openingHighlightMode: WECHAT_OPENING_HIGHLIGHT_MODES.has(cleanText(layout.openingHighlightMode))
    ? cleanText(layout.openingHighlightMode)
    : 'smart_lead',
  needOpenComment: Boolean(layout.needOpenComment),
  onlyFansCanComment: Boolean(layout.onlyFansCanComment),
  artDirectionPrompt: cleanText(layout.artDirectionPrompt) || undefined,
  styleReferenceImages: normalizeWechatStyleReferenceImages(layout.styleReferenceImages),
});

const buildWechatPublisherConfig = () => {
  const appId = cleanText(process.env.WECHAT_OFFICIAL_APP_ID || process.env.WX_APP_ID);
  const appSecret = cleanText(process.env.WECHAT_OFFICIAL_APP_SECRET || process.env.WX_APP_SECRET);
  const missingKeys = [];
  if (!appId) missingKeys.push('WECHAT_OFFICIAL_APP_ID');
  if (!appSecret) missingKeys.push('WECHAT_OFFICIAL_APP_SECRET');
  return {
    appId,
    appSecret,
    configured: missingKeys.length === 0,
    publishEnabled: process.env.WECHAT_OFFICIAL_ENABLE_PUBLISH !== '0',
    defaultAuthor: DEFAULT_AUTHOR,
    defaultTemplateId: DEFAULT_TEMPLATE_ID,
    missingKeys,
  };
};

export const getWechatPublisherConfig = () => {
  const config = buildWechatPublisherConfig();
  return {
    configured: config.configured,
    appIdPresent: Boolean(config.appId),
    appSecretPresent: Boolean(config.appSecret),
    defaultAuthor: config.defaultAuthor,
    defaultTemplateId: config.defaultTemplateId,
    publishEnabled: config.publishEnabled,
    missingKeys: config.missingKeys,
  };
};

const buildArticleBlocks = (content) => {
  const lines = String(content || '').replace(/\r\n/g, '\n').split('\n');
  const blocks = [];
  let paragraphIndex = 0;
  let paragraphBuffer = [];
  let listItems = [];
  let listKind = null;
  let quoteLines = [];
  let tableLines = [];

  const flushParagraph = () => {
    const text = stripMarkdownInline(paragraphBuffer.join(' '));
    if (text) {
      blocks.push({ type: 'paragraph', text, paragraphIndex });
      paragraphIndex += 1;
    }
    paragraphBuffer = [];
  };

  const flushList = () => {
    if (listItems.length > 0) {
      blocks.push({ type: listKind, items: listItems, paragraphIndex });
      paragraphIndex += 1;
    }
    listItems = [];
    listKind = null;
  };

  const flushQuote = () => {
    const text = stripMarkdownInline(quoteLines.join(' '));
    if (text) {
      blocks.push({ type: 'quote', text, paragraphIndex });
      paragraphIndex += 1;
    }
    quoteLines = [];
  };

  const parseTableLines = () => {
    const rows = tableLines
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => line.replace(/^\|/, '').replace(/\|$/, '').split('|').map((cell) => stripMarkdownInline(cell.trim())));
    const dataRows = rows.filter((row) => !row.every((cell) => /^:?-{3,}:?$/.test(cell)));
    if (dataRows.length >= 2) {
      blocks.push({
        type: 'table',
        headers: dataRows[0],
        rows: dataRows.slice(1),
        paragraphIndex,
      });
      paragraphIndex += 1;
    }
    tableLines = [];
  };

  const flushTable = () => {
    if (tableLines.length > 0) {
      parseTableLines();
    }
    tableLines = [];
  };

  const flushAll = () => {
    flushParagraph();
    flushList();
    flushQuote();
    flushTable();
  };

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) {
      flushAll();
      continue;
    }

    if (/^#{1,3}\s+/.test(line)) {
      flushAll();
      const headingText = stripMarkdownTitleDecorators(line);
      const headingLevel = (line.match(/^#+/)?.[0].length || 2);
      if (headingLevel === 1 && blocks.length === 0) {
        continue;
      }
      blocks.push({
        type: headingLevel === 2 ? 'heading' : 'subheading',
        text: headingText,
      });
      continue;
    }

    if (/^\|.+\|$/.test(line)) {
      flushParagraph();
      flushList();
      flushQuote();
      tableLines.push(line);
      continue;
    }

    if (/^>\s?/.test(line)) {
      flushParagraph();
      flushList();
      flushTable();
      quoteLines.push(line.replace(/^>\s?/, ''));
      continue;
    }

    if (/^[-*+]\s+/.test(line)) {
      flushParagraph();
      flushQuote();
      flushTable();
      if (listKind && listKind !== 'unordered_list') {
        flushList();
      }
      listKind = 'unordered_list';
      listItems.push(stripMarkdownInline(line.replace(/^[-*+]\s+/, '')));
      continue;
    }

    if (/^\d+\.\s+/.test(line)) {
      flushParagraph();
      flushQuote();
      flushTable();
      if (listKind && listKind !== 'ordered_list') {
        flushList();
      }
      listKind = 'ordered_list';
      listItems.push(stripMarkdownInline(line.replace(/^\d+\.\s+/, '')));
      continue;
    }

    flushList();
    flushQuote();
    flushTable();
    paragraphBuffer.push(line);
  }

  flushAll();
  return blocks;
};

const resolveActiveIllustrationEntries = (bundle) => {
  if (!bundle?.slots?.length || !bundle?.assetVersions) {
    return [];
  }

  return bundle.slots
    .slice()
    .sort((left, right) => left.order - right.order)
    .map((slot) => {
      const versions = Array.isArray(bundle.assetVersions?.[slot.id]) ? bundle.assetVersions[slot.id] : [];
      const activeAsset = versions.find((asset) => asset.id === slot.activeAssetId) || versions[versions.length - 1];
      if (!activeAsset?.url) {
        return null;
      }
      return {
        slotId: slot.id,
        assetId: activeAsset.id,
        order: slot.order,
        role: slot.role,
        title: slot.title || activeAsset.title,
        sectionTitle: slot.sectionTitle,
        anchorParagraphIndex: Number(slot.anchorParagraphIndex || 0),
        caption: cleanText(activeAsset.editorCaption || slot.explanation || slot.purpose),
        url: activeAsset.url,
        mimeType: activeAsset.mimeType,
        dataSpec: slot.dataSpec,
      };
    })
    .filter(Boolean);
};

const interleaveImageBlocks = (blocks, illustrationEntries) => {
  const grouped = new Map();
  for (const entry of illustrationEntries) {
    const key = Number.isFinite(entry.anchorParagraphIndex) ? entry.anchorParagraphIndex : Number.MAX_SAFE_INTEGER;
    const list = grouped.get(key) || [];
    list.push(entry);
    grouped.set(key, list);
  }

  const output = [];
  for (const block of blocks) {
    output.push(block);
    if (Number.isFinite(block.paragraphIndex) && grouped.has(block.paragraphIndex)) {
      for (const entry of grouped.get(block.paragraphIndex)) {
        output.push({ type: 'image', image: entry });
      }
      grouped.delete(block.paragraphIndex);
    }
  }

  for (const leftovers of grouped.values()) {
    for (const entry of leftovers) {
      output.push({ type: 'image', image: entry });
    }
  }

  return output;
};

const renderTextParagraph = (text, style) => `<p style="${style}">${escapeHtml(text)}</p>`;

const renderImageBlock = (image, theme) => `
  <figure style="margin: 28px 0; padding: 16px; border: 1px solid ${theme.cardBorder}; border-radius: 22px; background: ${theme.cardBackground};">
    <img src="${escapeHtml(image.url)}" alt="${escapeHtml(image.title || '配图')}" style="display:block; width:100%; border-radius:16px; background:#F8FAFC;" />
    ${image.caption ? `<figcaption style="margin-top: 12px; font-size: 13px; line-height: 1.7; color: ${theme.mutedColor};">${escapeHtml(image.caption)}</figcaption>` : ''}
  </figure>
`;

const renderBlockHtml = (block, theme) => {
  if (block.type === 'heading') {
    return `<h2 style="margin: 34px 0 16px; padding: 10px 14px; border-radius: 14px; background: ${theme.sectionBackground}; color: ${theme.sectionColor}; font-size: 20px; line-height: 1.5; font-weight: 700;">${escapeHtml(block.text)}</h2>`;
  }
  if (block.type === 'subheading') {
    return `<h3 style="margin: 28px 0 12px; color: ${theme.accent}; font-size: 18px; line-height: 1.5; font-weight: 700;">${escapeHtml(block.text)}</h3>`;
  }
  if (block.type === 'quote') {
    return `<blockquote style="margin: 24px 0; padding: 16px 18px; border-left: 4px solid ${theme.quoteBorder}; border-radius: 0 16px 16px 0; background: ${theme.quoteBackground}; color: ${theme.bodyColor}; font-size: 15px; line-height: 1.9;">${escapeHtml(block.text)}</blockquote>`;
  }
  if (block.type === 'unordered_list' || block.type === 'ordered_list') {
    const tag = block.type === 'ordered_list' ? 'ol' : 'ul';
    return `<${tag} style="margin: 0 0 18px; padding-left: 1.35em; color: ${theme.bodyColor}; font-size: 15px; line-height: 1.9;">${block.items
      .map((item) => `<li style="margin: 0 0 8px;">${escapeHtml(item)}</li>`)
      .join('')}</${tag}>`;
  }
  if (block.type === 'table') {
    return `
      <div style="margin: 26px 0; overflow-x:auto; border: 1px solid ${theme.cardBorder}; border-radius: 18px; background: ${theme.cardBackground};">
        <table style="width:100%; border-collapse:collapse; font-size:13px; line-height:1.7; color:${theme.bodyColor};">
          <thead style="background:${theme.tableHeaderBackground};">
            <tr>${block.headers.map((cell) => `<th style="padding: 12px 10px; border-bottom: 1px solid ${theme.cardBorder}; text-align:left;">${escapeHtml(cell)}</th>`).join('')}</tr>
          </thead>
          <tbody>
            ${block.rows
              .map(
                (row, rowIndex) =>
                  `<tr style="background:${rowIndex % 2 === 0 ? theme.cardBackground : theme.tableStripeBackground};">${row
                    .map((cell) => `<td style="padding: 11px 10px; border-bottom: 1px solid ${theme.cardBorder}; vertical-align:top;">${escapeHtml(cell)}</td>`)
                    .join('')}</tr>`
              )
              .join('')}
          </tbody>
        </table>
      </div>
    `;
  }
  if (block.type === 'image') {
    return renderImageBlock(block.image, theme);
  }
  return renderTextParagraph(
    block.text,
    `margin: 0 0 18px; color: ${theme.bodyColor}; font-size: 15px; line-height: 1.95; letter-spacing: 0.01em;`
  );
};

const buildPreviewDocument = ({ title, contentHtml, theme }) => `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(title)}</title>
    <style>
      body { margin: 0; padding: 24px 12px; background: ${theme.pageBackground}; font-family: "PingFang SC","Microsoft YaHei",sans-serif; }
      .wechat-preview-shell { max-width: 760px; margin: 0 auto; }
      img { max-width: 100%; }
    </style>
  </head>
  <body>
    <div class="wechat-preview-shell">${contentHtml}</div>
  </body>
</html>`;

const renderWechatArticleHtml = ({ title, digest, blocks, theme, author, templateLabel }) => {
  const blockHtml = blocks.map((block) => renderBlockHtml(block, theme)).join('\n');
  return `
    <section style="padding: 22px 18px 28px; background: ${theme.pageBackground};">
      <article style="margin: 0 auto; padding: 22px 20px 28px; border-radius: 28px; background: ${theme.cardBackground}; border: 1px solid ${theme.cardBorder};">
        <header style="margin-bottom: 22px; overflow: hidden; border-radius: 22px; background: ${theme.headerGradient};">
          <div style="padding: 22px 20px 18px;">
            <div style="display:inline-block; margin-bottom: 12px; padding: 4px 10px; border-radius: 999px; background: rgba(255,255,255,0.16); color: ${theme.headerText}; font-size: 12px; line-height: 1.4; letter-spacing: 0.08em;">${escapeHtml(templateLabel)}</div>
            <h1 style="margin: 0; color: ${theme.headerText}; font-size: 28px; line-height: 1.35; font-weight: 700;">${escapeHtml(title)}</h1>
            ${digest ? `<p style="margin: 14px 0 0; color: rgba(255,255,255,0.92); font-size: 15px; line-height: 1.8;">${escapeHtml(digest)}</p>` : ''}
            <p style="margin: 14px 0 0; color: rgba(255,255,255,0.78); font-size: 12px; line-height: 1.6;">作者：${escapeHtml(author)}</p>
          </div>
        </header>
        <div style="color: ${theme.titleColor};">${blockHtml}</div>
      </article>
    </section>
  `.trim();
};

const WECHAT_CREDITS_VARIANTS = new Set(['stacked_labels', 'minimal_labels', 'inline_meta_bar']);
const WECHAT_HEADING_VARIANTS = new Set([
  'chapter_marker',
  'section_band',
  'red_bar',
  'underline',
  'accent_tag',
  'number_badge',
  'plain',
]);
const WECHAT_PARAGRAPH_VARIANTS = new Set(['body', 'lead', 'callout', 'closing', 'spotlight', 'compact', 'data_callout']);
const WECHAT_QUOTE_VARIANTS = new Set(['editorial_quote', 'plain_quote', 'accent_panel', 'centered_pull']);
const WECHAT_LIST_VARIANTS = new Set(['bullet_brief', 'numbered_steps', 'plain_list', 'check_grid', 'card_list']);
const WECHAT_TABLE_VARIANTS = new Set(['data_grid', 'compact_grid', 'matrix_panel', 'minimal_rows']);
const WECHAT_IMAGE_VARIANTS = new Set([
  'full_bleed',
  'editorial_card',
  'caption_focus',
  'shadow_card',
  'caption_band',
  'border_frame',
]);
const WECHAT_HIGHLIGHT_VARIANTS = new Set(['marker', 'underline', 'ink', 'accent_bar']);

const getWechatBlockPlainText = (block) => {
  if (!block) return '';
  if (block.type === 'unordered_list' || block.type === 'ordered_list') {
    return (block.items || []).join(' ');
  }
  if (block.type === 'table') {
    return [...(block.headers || []), ...(block.rows || []).flat()].join(' ');
  }
  if (block.type === 'image') {
    return '';
  }
  return cleanText(block.text);
};

const normalizeWechatPlainText = (value) => cleanText(String(value || '').replace(/\s+/g, ' '));

const splitWechatTextIntoSentences = (value) => {
  const source = normalizeWechatPlainText(value);
  if (!source) return [];
  const sentences = [];
  let start = 0;
  for (let index = 0; index < source.length; index += 1) {
    const current = source[index];
    const next = source[index + 1] || '';
    const afterNext = source[index + 2] || '';
    const shouldBreak =
      '。！？!?；;'.includes(current) ||
      (current === '.' &&
        (!next || (next === ' ' && /["'“”‘’)\]A-Z0-9\u4E00-\u9FFF]/.test(afterNext))));
    if (!shouldBreak) continue;
    const sentence = normalizeWechatPlainText(source.slice(start, index + 1));
    if (sentence) {
      sentences.push(sentence);
    }
    start = index + 1;
  }
  const tail = normalizeWechatPlainText(source.slice(start));
  if (tail) {
    sentences.push(tail);
  }
  return sentences;
};

const collectWechatOpeningHighlightCandidates = (blocks) => {
  const candidateBlocks = [];
  for (let blockIndex = 0; blockIndex < blocks.length; blockIndex += 1) {
    const block = blocks[blockIndex];
    if (block?.type !== 'paragraph' && block?.type !== 'quote') {
      continue;
    }
    const text = getWechatBlockPlainText(block);
    if (!text) continue;
    const sentences = splitWechatTextIntoSentences(text).slice(0, 3);
    if (sentences.length) {
      candidateBlocks.push({
        blockIndex,
        blockOffset: candidateBlocks.length,
        sentences,
      });
      break;
    }
  }

  if (!candidateBlocks.length) {
    const fallbackBlockIndex = blocks.findIndex((block) => block?.type === 'heading' || block?.type === 'subheading');
    if (fallbackBlockIndex >= 0) {
      const text = getWechatBlockPlainText(blocks[fallbackBlockIndex]);
      if (text) {
        candidateBlocks.push({
          blockIndex: fallbackBlockIndex,
          blockOffset: 0,
          sentences: [text],
        });
      }
    }
  }

  return candidateBlocks.flatMap((item) =>
    item.sentences.map((text, sentenceOffset) => ({
      blockIndex: item.blockIndex,
      blockOffset: item.blockOffset,
      sentenceOffset,
      text,
    }))
  );
};

const scoreWechatOpeningHighlightCandidate = (candidate) => {
  const text = cleanText(candidate?.text);
  if (!text) return Number.NEGATIVE_INFINITY;
  const length = text.length;
  let score = 88 - candidate.blockOffset * 14 - candidate.sentenceOffset * 9;
  if (length < 12) {
    score -= 18;
  } else {
    score += Math.max(-8, 18 - Math.abs(length - 38) * 0.45);
  }
  if (/(不是|而是|意味着|核心|关键|本质|决定|真正|正在|加速|背后|趋势|机会|风险|竞争|壁垒|AI|GPU|芯片|算力|增长|SerDes)/i.test(text)) {
    score += 14;
  }
  if (/[：:]/.test(text)) {
    score += 6;
  }
  if (/[，,]/.test(text)) {
    score += 4;
  }
  return score;
};

const selectWechatOpeningHighlightSentences = ({ blocks, mode }) => {
  if (mode === 'off') {
    return [];
  }
  const candidates = collectWechatOpeningHighlightCandidates(blocks);
  if (!candidates.length) {
    return [];
  }
  if (mode === 'first_sentence') {
    return [candidates[0].text];
  }

  const ranked = candidates
    .map((candidate) => ({
      ...candidate,
      score: scoreWechatOpeningHighlightCandidate(candidate),
    }))
    .sort((left, right) => right.score - left.score);

  const selected = [];
  for (const candidate of ranked) {
    if (selected.length >= 2) {
      break;
    }
    if (selected.some((item) => item.text === candidate.text)) {
      continue;
    }
    if (selected.length > 0 && candidate.score < 18) {
      continue;
    }
    selected.push(candidate);
  }

  if (!selected.length) {
    return [candidates[0].text];
  }

  return selected
    .sort((left, right) => left.blockOffset - right.blockOffset || left.sentenceOffset - right.sentenceOffset)
    .map((candidate) => candidate.text)
    .slice(0, 2);
};

const resolveWechatOpeningHighlightSourceBlockIndex = (blocks) =>
  blocks.findIndex((block) => block?.type === 'paragraph' || block?.type === 'quote');

const stripLeadingWechatOpeningHighlightSentences = (text, sentences = []) => {
  let remaining = normalizeWechatPlainText(text);
  for (const sentence of Array.isArray(sentences) ? sentences : []) {
    const normalizedSentence = normalizeWechatPlainText(sentence);
    if (!normalizedSentence || !remaining.startsWith(normalizedSentence)) {
      break;
    }
    remaining = normalizeWechatPlainText(remaining.slice(normalizedSentence.length)).replace(/^[，。；：、\s]+/, '');
  }
  return remaining;
};

const renderWechatOpeningHighlightBlock = ({ blocks, layout, theme }) => {
  const sentences = selectWechatOpeningHighlightSentences({
    blocks,
    mode: layout?.openingHighlightMode || 'smart_lead',
  });
  if (!sentences.length) {
    return '';
  }

  const label = sentences.length > 1 ? 'Lead' : 'Focus';
  return `
    <section style="margin: 0 0 24px; padding: 16px 16px 14px; border: 1px solid ${theme.cardBorder}; border-radius: 18px; background: #FFFFFF;">
      <div data-wechat-decoration="true" style="display: inline-flex; align-items: center; gap: 8px; margin-bottom: 12px; color: ${theme.sectionColor}; font-size: 12px; font-weight: 800; letter-spacing: 0.12em; text-transform: uppercase;">
        <span style="display: inline-block; width: 18px; height: 2px; background: ${theme.cardBorder};"></span>
        <span>${label}</span>
      </div>
      ${sentences
        .map((sentence, sentenceIndex) =>
          `<p style="margin: ${sentenceIndex === 0 ? '0' : '10px 0 0'}; color: ${theme.titleColor}; font-size: ${sentenceIndex === 0 ? 18 : 15}px; line-height: ${sentenceIndex === 0 ? 1.85 : 1.82}; font-weight: ${sentenceIndex === 0 ? 650 : 500}; letter-spacing: 0.01em;">${escapeHtml(sentence)}</p>`
        )
        .join('')}
    </section>
  `.trim();
};

const stripWechatHtmlToText = (html) =>
  normalizeWechatPlainText(
    String(html || '')
      .replace(/<[^>]+data-wechat-decoration="true"[^>]*>[\s\S]*?<\/[^>]+>/gi, ' ')
      .replace(/<br\s*\/?>/gi, ' ')
      .replace(/<\/(p|h\d|li|blockquote|tr|figure|figcaption|div|section|article|thead|tbody|table|ul|ol)>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
  );

const normalizeWechatVariantSelections = ({ selections, blocks, allowedVariants, allowedTypes, limit }) => {
  const output = [];
  const seen = new Set();
  const items = Array.isArray(selections) ? selections : [];
  for (const item of items) {
    const blockIndex = Number(item?.block_index ?? item?.blockIndex);
    const variant = cleanText(item?.variant);
    if (!Number.isInteger(blockIndex) || blockIndex < 0 || blockIndex >= blocks.length) continue;
    if (!allowedVariants.has(variant)) continue;
    if (!allowedTypes.includes(blocks[blockIndex]?.type)) continue;
    if (seen.has(blockIndex)) continue;
    output.push({ blockIndex, variant });
    seen.add(blockIndex);
    if (output.length >= limit) {
      break;
    }
  }
  return output;
};

const buildWechatHighlightSectionMap = (blocks) => {
  const sectionMap = new Map();
  let sectionId = 0;
  for (let blockIndex = 0; blockIndex < blocks.length; blockIndex += 1) {
    const type = blocks[blockIndex]?.type;
    if (type === 'heading' || type === 'subheading') {
      sectionId += 1;
    }
    sectionMap.set(blockIndex, sectionId);
  }
  return sectionMap;
};

const scoreWechatHighlightCandidate = ({ block, text, sentenceIndex }) => {
  const source = cleanText(text);
  if (!source) return Number.NEGATIVE_INFINITY;

  const length = source.length;
  let score = 10 - sentenceIndex * 1.5;
  if (length < 12) {
    score -= 12;
  } else if (length > 80) {
    score -= 10;
  } else {
    score += Math.max(0, 18 - Math.abs(length - 32) * 0.4);
  }
  if (block?.type === 'quote') {
    score += 3;
  }
  if (/(?:\d+(?:\.\d+)?(?:%|\u500d|\u4e07|\u4ebf|\u5e74|\u5929|\u5143|\u7f8e\u5143)|ROI|Token|GPU|AI|H100|H200|B200|R100|Feynman|Dynamo|SerDes)/i.test(source)) {
    score += 11;
  }
  if (/(?:\u610f\u5473\u7740|\u7ed3\u8bba|\u5224\u65ad|\u672c\u8d28|\u6838\u5fc3|\u5173\u952e|\u8bf4\u660e|\u8bc1\u660e|\u51b3\u5b9a|\u771f\u6b63)/.test(source)) {
    score += 9;
  }
  if (/(?:\u4e0d\u518d|\u6b63\u5728|\u5f00\u59cb|\u9996\u6b21|\u8f6c\u5411|\u91cd\u5199|\u91cd\u5851|\u66ff\u4ee3|\u5347\u7ea7|\u6539\u53d8|\u53d8\u5316|\u62d0\u70b9|\u8dcc\u7834|\u7a81\u7834)/.test(source)) {
    score += 8;
  }
  if (/(?:\u98ce\u9669|\u673a\u4f1a|\u7126\u8651|\u74f6\u9888|\u58c1\u5792|\u7ade\u4e89|\u538b\u529b|\u5d29\u584c|\u7a97\u53e3|\u9690\u5fe7)/.test(source)) {
    score += 6;
  }
  if (/[?!\uff1f\uff01]/.test(source)) {
    score += 2;
  }
  return score;
};

const pickWechatHighlightVariant = (text) => {
  const source = cleanText(text);
  if (/(?:\d+(?:\.\d+)?(?:%|\u500d|\u4e07|\u4ebf|\u5e74|\u5929|\u5143|\u7f8e\u5143)|ROI|Token|GPU|AI|H100|H200|B200|R100|Feynman|Dynamo|SerDes)/i.test(source)) {
    return 'marker';
  }
  if (/(?:\u4e0d\u518d|\u8f6c\u5411|\u91cd\u5199|\u91cd\u5851|\u5347\u7ea7|\u6539\u53d8|\u53d8\u5316|\u62d0\u70b9|\u7a81\u7834|\u9996\u6b21)/.test(source)) {
    return 'accent_bar';
  }
  if (/(?:\u610f\u5473\u7740|\u7ed3\u8bba|\u5224\u65ad|\u672c\u8d28|\u6838\u5fc3|\u5173\u952e|\u8bf4\u660e|\u8bc1\u660e|\u51b3\u5b9a|\u771f\u6b63|\u4e0d\u518d|\u8f6c\u5411|\u91cd\u5199|\u91cd\u5851|\u6539\u53d8|\u53d8\u5316)/.test(source)) {
    return 'underline';
  }
  return 'ink';
};

const enforceWechatHighlightSelectionRules = ({ selections, blocks, totalLimit = 12, perSectionLimit = 3, perBlockLimit = 1 }) => {
  const output = [];
  const seen = new Set();
  const sectionMap = buildWechatHighlightSectionMap(blocks);
  const sectionCounts = new Map();
  const blockCounts = new Map();
  const items = Array.isArray(selections) ? selections : [];

  for (const item of items) {
    const blockIndex = Number(item?.blockIndex);
    const text = cleanText(item?.text);
    const variant = cleanText(item?.variant);
    if (!Number.isInteger(blockIndex) || blockIndex < 0 || blockIndex >= blocks.length) continue;
    if (!WECHAT_HIGHLIGHT_VARIANTS.has(variant)) continue;
    const blockText = getWechatBlockPlainText(blocks[blockIndex]);
    if (!blockText || text.length < 4 || text.length > 80) continue;
    if (!blockText.includes(text)) continue;

    const dedupeKey = `${blockIndex}:${text}`;
    if (seen.has(dedupeKey)) continue;

    const sectionId = sectionMap.get(blockIndex) || 0;
    if ((sectionCounts.get(sectionId) || 0) >= perSectionLimit) continue;
    if ((blockCounts.get(blockIndex) || 0) >= perBlockLimit) continue;

    output.push({ blockIndex, text, variant });
    seen.add(dedupeKey);
    sectionCounts.set(sectionId, (sectionCounts.get(sectionId) || 0) + 1);
    blockCounts.set(blockIndex, (blockCounts.get(blockIndex) || 0) + 1);

    if (output.length >= totalLimit) {
      break;
    }
  }

  return output;
};

const buildDefaultWechatHighlightSelections = (blocks) => {
  const sectionMap = buildWechatHighlightSectionMap(blocks);
  const candidates = [];

  for (let blockIndex = 0; blockIndex < blocks.length; blockIndex += 1) {
    const block = blocks[blockIndex];
    if (block?.type !== 'paragraph' && block?.type !== 'quote') {
      continue;
    }

    const sentences = splitWechatTextIntoSentences(getWechatBlockPlainText(block));
    for (let sentenceIndex = 0; sentenceIndex < sentences.length; sentenceIndex += 1) {
      const text = cleanText(sentences[sentenceIndex]);
      const score = scoreWechatHighlightCandidate({ block, text, sentenceIndex });
      if (score < 18) {
        continue;
      }
      candidates.push({
        blockIndex,
        text,
        variant: pickWechatHighlightVariant(text),
        score,
        sectionId: sectionMap.get(blockIndex) || 0,
        sentenceIndex,
      });
    }
  }

  const ranked = candidates.sort((left, right) => {
    if (right.score !== left.score) return right.score - left.score;
    if (left.blockIndex !== right.blockIndex) return left.blockIndex - right.blockIndex;
    return left.sentenceIndex - right.sentenceIndex;
  });

  return enforceWechatHighlightSelectionRules({
    selections: ranked,
    blocks,
  }).sort((left, right) => left.blockIndex - right.blockIndex || 0);
};

const mergeWechatHighlightSelections = ({ primary, fallback, blocks }) =>
  enforceWechatHighlightSelectionRules({
    selections: [...(Array.isArray(primary) ? primary : []), ...(Array.isArray(fallback) ? fallback : [])],
    blocks,
  });

const normalizeWechatHighlightSelections = ({ selections, blocks }) => {
  const output = [];
  const seen = new Set();
  const items = Array.isArray(selections) ? selections : [];
  for (const item of items) {
    const blockIndex = Number(item?.block_index ?? item?.blockIndex);
    const text = cleanText(item?.text);
    const variant = cleanText(item?.variant);
    if (!Number.isInteger(blockIndex) || blockIndex < 0 || blockIndex >= blocks.length) continue;
    if (!WECHAT_HIGHLIGHT_VARIANTS.has(variant)) continue;
    const blockText = getWechatBlockPlainText(blocks[blockIndex]);
    if (!blockText || text.length < 4 || text.length > 80) continue;
    if (!blockText.includes(text)) continue;
    const dedupeKey = `${blockIndex}:${text}`;
    if (seen.has(dedupeKey)) continue;
    output.push({ blockIndex, text, variant });
    seen.add(dedupeKey);
    if (output.length >= 24) {
      break;
    }
  }
  return output;
};

const normalizeWechatDividerSelections = ({ selections, blocks }) => {
  const output = [];
  const seen = new Set();
  const items = Array.isArray(selections) ? selections : [];
  for (const item of items) {
    const blockIndex = Number(item);
    if (!Number.isInteger(blockIndex) || blockIndex < 0 || blockIndex >= blocks.length) continue;
    if (seen.has(blockIndex)) continue;
    output.push(blockIndex);
    seen.add(blockIndex);
    if (output.length >= 3) {
      break;
    }
  }
  return output;
};

const mergeWechatVariantSelections = ({ primary, fallback, limit = Number.POSITIVE_INFINITY }) => {
  const output = [];
  const seen = new Set();
  const items = [...(Array.isArray(primary) ? primary : []), ...(Array.isArray(fallback) ? fallback : [])];
  for (const item of items) {
    const blockIndex = Number(item?.blockIndex ?? item?.block_index);
    const variant = cleanText(item?.variant);
    if (!Number.isInteger(blockIndex) || blockIndex < 0 || seen.has(blockIndex) || !variant) continue;
    output.push({ blockIndex, variant });
    seen.add(blockIndex);
    if (output.length >= limit) {
      break;
    }
  }
  return output;
};

const buildDefaultWechatHeadingSelections = (blocks) => {
  const headingIndexes = blocks
    .map((block, index) => ({ block, index }))
    .filter(({ block }) => block.type === 'heading' || block.type === 'subheading');
  if (!headingIndexes.length) {
    return [];
  }

  return headingIndexes.map(({ index }) => ({ blockIndex: index, variant: 'underline' }));
};

const buildDefaultWechatParagraphSelections = (blocks, layout = {}) => {
  const paragraphIndexes = blocks
    .map((block, index) => ({ block, index }))
    .filter(({ block }) => block.type === 'paragraph')
    .map(({ index }) => index);
  if (!paragraphIndexes.length) {
    return [];
  }

  const openingHighlightActive = hasWechatOpeningHighlight({ blocks, layout });
  const selections = [];
  const seen = new Set();
  const firstParagraphIndex = paragraphIndexes[0];
  const lastParagraphIndex = paragraphIndexes[paragraphIndexes.length - 1];
  const addVariant = (blockIndex, variant) => {
    if (!Number.isInteger(blockIndex) || seen.has(blockIndex)) return;
    selections.push({ blockIndex, variant });
    seen.add(blockIndex);
  };
  const getText = (blockIndex) => getWechatBlockPlainText(blocks[blockIndex]);
  const dataPattern =
    /(?:\d+(?:\.\d+)?(?:%|\u500d|\u4e07|\u4ebf|\u5e74|\u5929|\u5143|\u7f8e\u5143)|ROI|Token|GPU|AI|H100|H200|B200|R100|Feynman|Dynamo|SerDes)/i;
  const emphasisPattern =
    /(?:\u610f\u5473\u7740|\u7ed3\u8bba|\u5224\u65ad|\u672c\u8d28|\u6838\u5fc3|\u5173\u952e|\u98ce\u9669|\u673a\u4f1a|\u62d0\u70b9|\u771f\u6b63|\u800c\u662f|\u4e0d\u662f)/;

  if (!openingHighlightActive) {
    addVariant(firstParagraphIndex, 'lead');
  }

  const calloutIndex = paragraphIndexes.find((blockIndex) => {
    if (seen.has(blockIndex) || blockIndex === lastParagraphIndex) return false;
    return emphasisPattern.test(getText(blockIndex)) || dataPattern.test(getText(blockIndex));
  });
  if (calloutIndex !== undefined) {
    addVariant(calloutIndex, 'callout');
  }

  const compactIndex = paragraphIndexes.find((blockIndex) => {
    if (seen.has(blockIndex) || blockIndex === firstParagraphIndex || blockIndex === lastParagraphIndex) return false;
    const text = getText(blockIndex);
    return text.length >= 36 && text.length <= 96;
  });
  if (compactIndex !== undefined) {
    addVariant(compactIndex, 'compact');
  }

  if (lastParagraphIndex !== firstParagraphIndex) {
    addVariant(lastParagraphIndex, 'closing');
  }

  return selections.sort((left, right) => left.blockIndex - right.blockIndex);
};

const buildDefaultWechatQuoteSelections = (blocks) =>
  blocks
    .map((block, index) => ({ block, index }))
    .filter(({ block }) => block.type === 'quote')
    .map(({ index }, itemIndex, quoteBlocks) => {
      const textLength = getWechatBlockPlainText(blocks[index]).length;
      if (itemIndex === 0) {
        return { blockIndex: index, variant: textLength <= 56 ? 'plain_quote' : 'editorial_quote' };
      }
      if (itemIndex === quoteBlocks.length - 1) {
        return { blockIndex: index, variant: 'plain_quote' };
      }
      return { blockIndex: index, variant: 'editorial_quote' };
    });

const buildDefaultWechatListSelections = (blocks) =>
  blocks
    .map((block, index) => ({ block, index }))
    .filter(({ block }) => block.type === 'unordered_list' || block.type === 'ordered_list')
    .map(({ block, index }, itemIndex) => {
      const items = Array.isArray(block.items) ? block.items : [];
      const maxItemLength = items.reduce((maxLength, item) => Math.max(maxLength, cleanText(item).length), 0);
      if (block.type === 'ordered_list') {
        return { blockIndex: index, variant: itemIndex === 0 ? 'numbered_steps' : 'plain_list' };
      }
      if (maxItemLength >= 36) {
        return { blockIndex: index, variant: 'plain_list' };
      }
      return { blockIndex: index, variant: 'bullet_brief' };
    });

const buildDefaultWechatTableSelections = (blocks) =>
  blocks
    .map((block, index) => ({ block, index }))
    .filter(({ block }) => block.type === 'table')
    .map(({ block, index }, itemIndex) => {
      const headers = Array.isArray(block.headers) ? block.headers : [];
      const rows = Array.isArray(block.rows) ? block.rows : [];
      const columnCount = Math.max(headers.length, ...rows.map((row) => row.length), 0);
      if (columnCount >= 5 || rows.length >= 6) {
        return { blockIndex: index, variant: 'minimal_rows' };
      }
      if (columnCount >= 4) {
        return { blockIndex: index, variant: 'compact_grid' };
      }
      return { blockIndex: index, variant: 'data_grid' };
    });

const buildDefaultWechatImageSelections = (blocks) =>
  blocks
    .map((block, index) => ({ block, index }))
    .filter(({ block }) => block.type === 'image')
    .map(({ block, index }, itemIndex) => {
      const caption = cleanText(block.image?.caption);
      if (itemIndex === 0) {
        return { blockIndex: index, variant: 'full_bleed' };
      }
      if (caption && itemIndex <= 1) {
        return { blockIndex: index, variant: 'caption_band' };
      }
      if (itemIndex % 2 === 0) {
        return { blockIndex: index, variant: 'full_bleed' };
      }
      return { blockIndex: index, variant: 'editorial_card' };
    });

const buildDefaultWechatDividerSelections = (blocks) => {
  const candidates = [];
  for (let index = 0; index < blocks.length; index += 1) {
    if (index >= blocks.length - 1) {
      break;
    }
    const type = blocks[index]?.type;
    if (type === 'quote' || type === 'table' || type === 'image') {
      candidates.push(index);
    }
  }

  if (candidates.length < 2) {
    for (let index = 1; index < blocks.length - 1; index += 1) {
      const type = blocks[index]?.type;
      if (type === 'heading' || type === 'subheading') {
        candidates.push(index);
      }
      if (candidates.length >= 3) {
        break;
      }
    }
  }

  return normalizeWechatDividerSelections({ selections: candidates, blocks });
};

const buildWechatRenderPlanHash = (plan) =>
  buildStableHash({
    creditsVariant: plan.creditsVariant,
    headingStyles: plan.headingStyles,
    paragraphStyles: plan.paragraphStyles,
    quoteStyles: plan.quoteStyles,
    listStyles: plan.listStyles,
    tableStyles: plan.tableStyles,
    imageStyles: plan.imageStyles,
    highlightSentences: plan.highlightSentences,
    dividerAfterBlocks: plan.dividerAfterBlocks,
  });

const hasWechatOpeningHighlight = ({ blocks, layout }) =>
  selectWechatOpeningHighlightSentences({
    blocks,
    mode: layout?.openingHighlightMode || 'smart_lead',
  }).length > 0;

const normalizeWechatBodyBlocks = ({ blocks, layout }) => {
  const sourceBlocks = Array.isArray(blocks) ? blocks : [];
  if (!sourceBlocks.length || !hasWechatOpeningHighlight({ blocks: sourceBlocks, layout })) {
    return sourceBlocks;
  }
  if (!sourceBlocks.some((block) => block.type === 'paragraph')) {
    return sourceBlocks;
  }

  let trimCount = 0;
  while (trimCount < sourceBlocks.length) {
    const type = sourceBlocks[trimCount]?.type;
    if (type !== 'heading' && type !== 'subheading') {
      break;
    }
    trimCount += 1;
  }

  return trimCount > 0 ? sourceBlocks.slice(trimCount) : sourceBlocks;
};

const normalizeWechatHeadingSystemVariant = (variant) => {
  const normalized = cleanText(variant);
  if (normalized === 'plain' || normalized === 'section_band' || normalized === 'underline') {
    return normalized;
  }
  return 'underline';
};

const chooseBalancedWechatHeadingVariant = ({ blockType, previousVariant, usageCounts, chapterMarkerUsed }) => {
  const candidates =
    blockType === 'heading'
      ? ['section_band', 'red_bar', 'underline', 'number_badge', 'plain']
      : ['accent_tag', 'underline', 'plain', 'number_badge', 'red_bar'];
  const allowed = candidates.filter((candidate) => candidate !== 'chapter_marker' || !chapterMarkerUsed);
  const preferredPool = allowed.filter((candidate) => candidate !== previousVariant);
  const pool = preferredPool.length ? preferredPool : allowed;
  return (
    pool
      .slice()
      .sort((left, right) => {
        const usageDiff = (usageCounts.get(left) || 0) - (usageCounts.get(right) || 0);
        if (usageDiff !== 0) return usageDiff;
        return candidates.indexOf(left) - candidates.indexOf(right);
      })[0] || (blockType === 'heading' ? 'underline' : 'plain')
  );
};

const balanceWechatHeadingSelections = ({ selections, blocks }) => {
  const items = [...(Array.isArray(selections) ? selections : [])].sort((left, right) => left.blockIndex - right.blockIndex);
  const anchorVariant = normalizeWechatHeadingSystemVariant(items[0]?.variant || 'underline');

  return items.map((item) => {
    const blockType = blocks[item.blockIndex]?.type;
    let variant = item.variant;
    if (!blockType) {
      return item;
    }
    variant = anchorVariant;
    return { ...item, variant };
  });
};

const enforceWechatOpeningHighlightPlanRules = ({ renderPlan, blocks, layout }) => {
  if (!hasWechatOpeningHighlight({ blocks, layout })) {
    return renderPlan;
  }

  const firstParagraphIndex = blocks.findIndex((block) => block.type === 'paragraph');
  if (firstParagraphIndex < 0) {
    return renderPlan;
  }

  return {
    ...renderPlan,
    paragraphStyles: (renderPlan.paragraphStyles || []).filter((item) => item.blockIndex !== firstParagraphIndex),
  };
};

const buildDefaultWechatRenderPlan = (blocks, layout = {}, beautyAgent = {}) => {
  const creditLineCount = (layout.creditLines || []).filter((line) => cleanText(line)).length;

  return {
    creditsVariant: creditLineCount >= 2 ? 'inline_meta_bar' : 'stacked_labels',
    headingStyles: buildDefaultWechatHeadingSelections(blocks),
    paragraphStyles: buildDefaultWechatParagraphSelections(blocks, layout),
    quoteStyles: buildDefaultWechatQuoteSelections(blocks),
    listStyles: buildDefaultWechatListSelections(blocks),
    tableStyles: buildDefaultWechatTableSelections(blocks),
    imageStyles: buildDefaultWechatImageSelections(blocks),
    highlightSentences: buildDefaultWechatHighlightSelections(blocks),
    dividerAfterBlocks: buildDefaultWechatDividerSelections(blocks),
    beautyAgent: {
      used: Boolean(beautyAgent.used),
      model: cleanText(beautyAgent.model) || (beautyAgent.used ? WECHAT_BEAUTY_AGENT_MODEL : undefined),
      fallbackReason: cleanText(beautyAgent.fallbackReason) || undefined,
    },
  };
};

const normalizeWechatRenderPlan = (inputPlan, blocks, layout = {}, beautyAgent = {}) => {
  const basePlan = buildDefaultWechatRenderPlan(blocks, layout, beautyAgent);
  const normalized = {
    creditsVariant: WECHAT_CREDITS_VARIANTS.has(cleanText(inputPlan?.credits_variant ?? inputPlan?.creditsVariant))
      ? cleanText(inputPlan?.credits_variant ?? inputPlan?.creditsVariant)
      : basePlan.creditsVariant,
    headingStyles: balanceWechatHeadingSelections({
      selections: mergeWechatVariantSelections({
        primary: normalizeWechatVariantSelections({
          selections: inputPlan?.heading_styles ?? inputPlan?.headingStyles,
          blocks,
          allowedVariants: WECHAT_HEADING_VARIANTS,
          allowedTypes: ['heading', 'subheading'],
          limit: 12,
        }),
        fallback: basePlan.headingStyles,
        limit: 12,
      }),
      blocks,
    }),
    paragraphStyles: mergeWechatVariantSelections({
      primary: normalizeWechatVariantSelections({
        selections: inputPlan?.paragraph_styles ?? inputPlan?.paragraphStyles,
        blocks,
        allowedVariants: WECHAT_PARAGRAPH_VARIANTS,
        allowedTypes: ['paragraph'],
        limit: 10,
      }),
      fallback: basePlan.paragraphStyles,
      limit: 10,
    }),
    quoteStyles: mergeWechatVariantSelections({
      primary: normalizeWechatVariantSelections({
        selections: inputPlan?.quote_styles ?? inputPlan?.quoteStyles,
        blocks,
        allowedVariants: WECHAT_QUOTE_VARIANTS,
        allowedTypes: ['quote'],
        limit: 6,
      }),
      fallback: basePlan.quoteStyles,
      limit: 6,
    }),
    listStyles: mergeWechatVariantSelections({
      primary: normalizeWechatVariantSelections({
        selections: inputPlan?.list_styles ?? inputPlan?.listStyles,
        blocks,
        allowedVariants: WECHAT_LIST_VARIANTS,
        allowedTypes: ['unordered_list', 'ordered_list'],
        limit: 8,
      }),
      fallback: basePlan.listStyles,
      limit: 8,
    }),
    tableStyles: mergeWechatVariantSelections({
      primary: normalizeWechatVariantSelections({
        selections: inputPlan?.table_styles ?? inputPlan?.tableStyles,
        blocks,
        allowedVariants: WECHAT_TABLE_VARIANTS,
        allowedTypes: ['table'],
        limit: 6,
      }),
      fallback: basePlan.tableStyles,
      limit: 6,
    }),
    imageStyles: mergeWechatVariantSelections({
      primary: normalizeWechatVariantSelections({
        selections: inputPlan?.image_styles ?? inputPlan?.imageStyles,
        blocks,
        allowedVariants: WECHAT_IMAGE_VARIANTS,
        allowedTypes: ['image'],
        limit: 16,
      }),
      fallback: basePlan.imageStyles,
      limit: 16,
    }),
    highlightSentences: mergeWechatHighlightSelections({
      primary: normalizeWechatHighlightSelections({
        selections: inputPlan?.highlight_sentences ?? inputPlan?.highlightSentences,
        blocks,
      }),
      fallback: basePlan.highlightSentences,
      blocks,
    }),
    dividerAfterBlocks: normalizeWechatDividerSelections({
      selections: [
        ...(Array.isArray(inputPlan?.divider_after_blocks) ? inputPlan.divider_after_blocks : []),
        ...(Array.isArray(inputPlan?.dividerAfterBlocks) ? inputPlan.dividerAfterBlocks : []),
        ...basePlan.dividerAfterBlocks,
      ],
      blocks,
    }),
    beautyAgent: {
      used: Boolean(beautyAgent.used),
      model: cleanText(beautyAgent.model) || (beautyAgent.used ? WECHAT_BEAUTY_AGENT_MODEL : undefined),
      fallbackReason: cleanText(beautyAgent.fallbackReason) || undefined,
    },
  };
  const adjusted = enforceWechatOpeningHighlightPlanRules({
    renderPlan: normalized,
    blocks,
    layout,
  });
  adjusted.beautyAgent.planHash = buildWechatRenderPlanHash(adjusted);
  return adjusted;
};

const buildWechatBeautyAgentPrompt = ({ title, digest, layout, templateLabel, blocks }) => {
  const openingHighlightActive = hasWechatOpeningHighlight({ blocks, layout });
  const styleReferenceImages = Array.isArray(layout?.styleReferenceImages) ? layout.styleReferenceImages : [];
  const blocksForPrompt = blocks.map((block, blockIndex) => {
    if (block.type === 'image') {
      return {
        block_index: blockIndex,
        type: block.type,
        role: cleanText(block.image?.role),
        title: cleanText(block.image?.title),
        caption: cleanText(block.image?.caption),
      };
    }
    if (block.type === 'unordered_list' || block.type === 'ordered_list') {
      return {
        block_index: blockIndex,
        type: block.type,
        items: block.items || [],
      };
    }
    if (block.type === 'table') {
      return {
        block_index: blockIndex,
        type: block.type,
        headers: block.headers || [],
        rows: (block.rows || []).slice(0, 8),
      };
    }
    return {
      block_index: blockIndex,
      type: block.type,
      text: block.text || '',
    };
  });

  return [
    'You are the top art director for premium WeChat business articles.',
    'Your job is to decide layout treatments only. Never rewrite, add, delete, summarize, translate, or paraphrase body text.',
    'The template is only a loose palette and tone reference, not a fixed layout.',
    'Treat this as a full-article relayout task. Improve structure, pacing, emphasis, hierarchy, images, lists, tables, quotes, credits, and section transitions together.',
    'User art direction is current-round feedback for this preview. Follow it when possible without breaking text preservation rules.',
    ...(styleReferenceImages.length
      ? [
          `Style reference images are attached: ${styleReferenceImages.map((image, index) => `#${index + 1} ${image.name}`).join(' | ')}.`,
          'Analyze those images for layout cues only: opening emphasis, heading system, spacing rhythm, caption treatment, image framing, list/table styling, dividers, and overall editorial tone.',
          'Do not copy image subject matter, screenshot text, or brand names into the article. Extract only visual layout patterns that can be adapted to this article.',
        ]
      : []),
    'Do not inject numbered section wording into any subheading. If section rhythm is needed, express it only through decorative layout choices.',
    'The body must not render a standalone title block. The article starts from credits and the first body block.',
    'Use highlights sparingly. Choose only the most important sentences.',
    'When you return highlight_sentences.text, copy exact substrings from the target block.',
    'Use highlight_sentences for key data, key conclusions, key changes, and meaningful risks or turning points.',
    'Within one subsection, highlight at most 3 sentences. Within one paragraph, highlight at most 1 sentence.',
    'Use chapter_marker at most once, and only for one major section heading.',
    'Use one consistent heading treatment across the whole article. Do not mix different heading variants in the same article.',
    'Prefer restrained editorial layout. If you use cards, use simple outlined cards with light borders. Avoid heavy gradients, shadows, decorative dots, and flashy badges.',
    'If opening highlight is enabled, the highlighted sentence(s) should not be repeated again at the start of the body content.',
    ...(openingHighlightActive
      ? ['Opening highlight is enabled. The first body paragraph must remain a normal body paragraph, not lead or callout.']
      : []),
    'Allowed credits_variant: stacked_labels, minimal_labels, inline_meta_bar.',
    'Allowed heading variants: chapter_marker, section_band, red_bar, underline, accent_tag, number_badge, plain.',
    'Allowed paragraph variants: body, lead, callout, closing, spotlight, compact, data_callout.',
    'Allowed quote variants: editorial_quote, plain_quote, accent_panel, centered_pull.',
    'Allowed list variants: bullet_brief, numbered_steps, plain_list, check_grid, card_list.',
    'Allowed table variants: data_grid, compact_grid, matrix_panel, minimal_rows.',
    'Allowed image variants: full_bleed, editorial_card, caption_focus, shadow_card, caption_band, border_frame.',
    'Allowed highlight variants: marker, underline, ink, accent_bar.',
    'At most 1 lead paragraph, at most 2 callout paragraphs, at most 1 spotlight or data_callout paragraph total, at most 3 highlight sentences per subsection, and at most 3 dividers.',
    `Article title for context only: ${title || ''}`,
    `Digest for context only: ${digest || ''}`,
    `Author credit: ${layout.author || ''}`,
    `Editor credit: ${layout.editor || ''}`,
    `Template reference: ${templateLabel || ''}`,
    `Additional credits: ${(layout.creditLines || []).join(' | ')}`,
    `User art direction: ${layout.artDirectionPrompt || 'None'}`,
    '',
    'Return JSON only. Do not return HTML.',
    JSON.stringify({ blocks: blocksForPrompt }, null, 2),
  ].join('\n');
};

const buildWechatBeautyAgentParts = ({ title, digest, layout, templateLabel, blocks }) => {
  const parts = [{ text: buildWechatBeautyAgentPrompt({ title, digest, layout, templateLabel, blocks }) }];
  const styleReferenceImages = Array.isArray(layout?.styleReferenceImages) ? layout.styleReferenceImages : [];

  styleReferenceImages.forEach((image, index) => {
    const decoded = decodeInlineImageDataUrl(image?.dataUrl);
    if (!decoded) {
      return;
    }
    parts.push({
      text: `Style reference image ${index + 1}: ${cleanText(image.name) || `reference-${index + 1}`}. Focus on layout and composition, not literal content.`,
    });
    parts.push(createPartFromBase64(decoded.data, decoded.mimeType));
  });

  return parts;
};

const generateWechatBeautyPlan = async ({ apiKey, title, digest, layout, templateLabel, blocks }) => {
  const client = createGenAiClient(apiKey, WECHAT_BEAUTY_AGENT_TIMEOUT_MS + 15_000);
  const response = await withTimeout(
    callWithRetry(() =>
      client.models.generateContent({
        model: WECHAT_BEAUTY_AGENT_MODEL,
        contents: [{ role: 'user', parts: buildWechatBeautyAgentParts({ title, digest, layout, templateLabel, blocks }) }],
        config: {
          systemInstruction:
            'You are a constrained layout-only agent. You may only choose from the provided style enums and exact-text highlights. Never rewrite article text.',
          responseMimeType: 'application/json',
          responseSchema: WECHAT_BEAUTY_PLAN_SCHEMA,
        },
      })
    ),
    WECHAT_BEAUTY_AGENT_TIMEOUT_MS,
    'WeChat beauty agent'
  );
  return JSON.parse(response.text || '{}');
};

const resolveWechatRenderPlanWithAgent = async ({ apiKey, title, digest, layout, templateLabel, blocks, renderPlan }) => {
  if (renderPlan && typeof renderPlan === 'object') {
    return {
      renderPlan: normalizeWechatRenderPlan(renderPlan, blocks, layout, renderPlan.beautyAgent || {}),
      warnings: [],
    };
  }

  if (!cleanText(apiKey)) {
    return {
      renderPlan: normalizeWechatRenderPlan({}, blocks, layout, {
        used: false,
        fallbackReason: 'Beauty agent skipped because no Gemini API key was provided.',
      }),
      warnings: ['No Gemini API key was available for the WeChat beauty agent. Base layout was used.'],
    };
  }

  try {
    const generatedPlan = await generateWechatBeautyPlan({
      apiKey: cleanText(apiKey),
      title,
      digest,
      layout,
      templateLabel,
      blocks,
    });
    return {
      renderPlan: normalizeWechatRenderPlan(generatedPlan, blocks, layout, {
        used: true,
        model: WECHAT_BEAUTY_AGENT_MODEL,
      }),
      warnings: [],
    };
  } catch (error) {
    return {
      renderPlan: normalizeWechatRenderPlan({}, blocks, layout, {
        used: false,
        fallbackReason: error instanceof Error ? error.message : String(error),
      }),
      warnings: [`WeChat beauty agent fallback: ${error instanceof Error ? error.message : String(error)}`],
    };
  }
};

const buildWechatBeautyRenderContext = ({ blocks, renderPlan, theme, layout }) => {
  const headingOrdinals = new Map();
  let headingCount = 0;
  for (let index = 0; index < blocks.length; index += 1) {
    const block = blocks[index];
    if (block.type === 'heading' || block.type === 'subheading') {
      headingCount += 1;
      headingOrdinals.set(index, headingCount);
    }
  }

  const openingHighlightSentences = hasWechatOpeningHighlight({ blocks, layout })
    ? selectWechatOpeningHighlightSentences({
        blocks,
        mode: layout?.openingHighlightMode || 'smart_lead',
      })
    : [];
  const openingHighlightBlockIndex = openingHighlightSentences.length
    ? resolveWechatOpeningHighlightSourceBlockIndex(blocks)
    : -1;

  return {
    theme,
    headingOrdinals,
    openingHighlightSentences,
    openingHighlightBlockIndex,
    dividerSet: new Set(renderPlan.dividerAfterBlocks || []),
    headingMap: new Map((renderPlan.headingStyles || []).map((item) => [item.blockIndex, item.variant])),
    paragraphMap: new Map((renderPlan.paragraphStyles || []).map((item) => [item.blockIndex, item.variant])),
    quoteMap: new Map((renderPlan.quoteStyles || []).map((item) => [item.blockIndex, item.variant])),
    listMap: new Map((renderPlan.listStyles || []).map((item) => [item.blockIndex, item.variant])),
    tableMap: new Map((renderPlan.tableStyles || []).map((item) => [item.blockIndex, item.variant])),
    imageMap: new Map((renderPlan.imageStyles || []).map((item) => [item.blockIndex, item.variant])),
    highlightMap: (renderPlan.highlightSentences || []).reduce((accumulator, item) => {
      const list = accumulator.get(item.blockIndex) || [];
      list.push(item);
      accumulator.set(item.blockIndex, list);
      return accumulator;
    }, new Map()),
  };
};

const resolveWechatHighlightStyle = (variant, theme) => {
  if (variant === 'underline') {
    return `padding-bottom: 1px; box-shadow: inset 0 -0.34em 0 ${theme.accentSoft}; font-weight: 600;`;
  }
  if (variant === 'accent_bar') {
    return `padding: 0 5px 0 10px; border-left: 3px solid ${theme.accent}; border-radius: 6px; background: linear-gradient(90deg, ${theme.accentSoft} 0%, rgba(255,255,255,0) 100%); color: ${theme.titleColor}; font-weight: 700;`;
  }
  if (variant === 'ink') {
    return `padding: 0 2px; border-radius: 4px; background: rgba(15, 23, 42, 0.08); color: ${theme.titleColor}; font-weight: 700;`;
  }
  return `padding: 0 3px; border-radius: 4px; background: rgba(241, 143, 37, 0.22); color: ${theme.titleColor}; font-weight: 700;`;
};

const renderWechatTextWithHighlights = (text, highlights, theme) => {
  const source = String(text || '');
  if (!highlights?.length) {
    return escapeHtml(source);
  }

  const ranges = [];
  for (const highlight of highlights) {
    const start = source.indexOf(highlight.text);
    if (start < 0) continue;
    const end = start + highlight.text.length;
    if (ranges.some((range) => start < range.end && end > range.start)) {
      continue;
    }
    ranges.push({ start, end, variant: highlight.variant });
  }

  if (!ranges.length) {
    return escapeHtml(source);
  }

  ranges.sort((left, right) => left.start - right.start);
  const output = [];
  let cursor = 0;
  for (const range of ranges) {
    if (range.start > cursor) {
      output.push(escapeHtml(source.slice(cursor, range.start)));
    }
    output.push(
      `<span style="${resolveWechatHighlightStyle(range.variant, theme)}">${escapeHtml(source.slice(range.start, range.end))}</span>`
    );
    cursor = range.end;
  }
  if (cursor < source.length) {
    output.push(escapeHtml(source.slice(cursor)));
  }
  return output.join('');
};

const createWechatRenderedBlock = (html, plainText = '') => ({
  html,
  plainText: normalizeWechatPlainText(plainText),
});

const buildWechatRenderValidationError = ({ block, blockIndex, expected, actual }) => {
  const type = cleanText(block?.type) || 'unknown';
  const paragraphIndex =
    Number.isInteger(block?.paragraphIndex) || Number.isFinite(block?.paragraphIndex) ? String(block.paragraphIndex) : 'n/a';
  const error = new Error(`Rendered WeChat block text diverged at block ${blockIndex}.`);
  error.code = 'WECHAT_RENDER_TEXT_DIVERGED';
  error.details = [
    `Block ${blockIndex} type: ${type}`,
    `Paragraph index: ${paragraphIndex}`,
    `Expected text: ${clip(expected, 140) || '(empty)'}`,
    `Rendered text: ${clip(actual, 140) || '(empty)'}`,
  ];
  return error;
};

const renderWechatBeautyParagraphBlock = (block, blockIndex, context) => {
  const variant = context.paragraphMap.get(blockIndex) || 'body';
  const renderedText =
    blockIndex === context.openingHighlightBlockIndex
      ? stripLeadingWechatOpeningHighlightSentences(block.text, context.openingHighlightSentences)
      : block.text;
  if (!cleanText(renderedText)) {
    return createWechatRenderedBlock('', block.text);
  }
  const textHtml = renderWechatTextWithHighlights(renderedText, context.highlightMap.get(blockIndex), context.theme);
  if (variant === 'lead') {
    return createWechatRenderedBlock(
      `<p style="margin: 0 0 20px; color: ${context.theme.titleColor}; font-size: 17px; line-height: 1.92; letter-spacing: 0.01em; font-weight: 500;">${textHtml}</p>`,
      block.text
    );
  }
  if (variant === 'callout') {
    return createWechatRenderedBlock(
      `<div style="margin: 4px 0 22px; padding: 14px 16px; border: 1px solid ${context.theme.cardBorder}; border-left: 3px solid ${context.theme.accent}; border-radius: 18px; background: #FFFFFF;"><p style="margin: 0; color: ${context.theme.titleColor}; font-size: 15px; line-height: 1.9; letter-spacing: 0.01em;">${textHtml}</p></div>`,
      block.text
    );
  }
  if (variant === 'spotlight') {
    return createWechatRenderedBlock(
      `
        <div style="margin: 8px 0 24px; padding: 16px 18px; border: 1px solid ${context.theme.cardBorder}; border-radius: 18px; background: #FFFFFF;">
          <p style="margin: 0; color: ${context.theme.titleColor}; font-size: 16px; line-height: 1.88; letter-spacing: 0.01em; font-weight: 550;">${textHtml}</p>
        </div>
      `.trim(),
      block.text
    );
  }
  if (variant === 'compact') {
    return createWechatRenderedBlock(
      `<p style="max-width: 92%; margin: 0 0 16px; padding-left: 14px; border-left: 2px solid ${context.theme.cardBorder}; color: ${context.theme.bodyColor}; font-size: 14px; line-height: 1.82; letter-spacing: 0.01em;">${textHtml}</p>`,
      block.text
    );
  }
  if (variant === 'data_callout') {
    return createWechatRenderedBlock(
      `
        <div style="margin: 10px 0 24px; padding: 14px 16px 16px; border-radius: 18px; background: #FFFFFF; border: 1px solid ${context.theme.cardBorder};">
          <p style="margin: 0; color: ${context.theme.titleColor}; font-size: 15px; line-height: 1.88; letter-spacing: 0.01em; font-weight: 550;">${textHtml}</p>
        </div>
      `.trim(),
      block.text
    );
  }
  if (variant === 'closing') {
    return createWechatRenderedBlock(
      `<p style="margin: 26px 0 0; padding-top: 16px; border-top: 1px solid ${context.theme.cardBorder}; color: ${context.theme.bodyColor}; font-size: 15px; line-height: 1.9; letter-spacing: 0.01em;">${textHtml}</p>`,
      block.text
    );
  }
  return createWechatRenderedBlock(
    `<p style="margin: 0 0 16px; color: ${context.theme.bodyColor}; font-size: 15px; line-height: 1.9; letter-spacing: 0.01em;">${textHtml}</p>`,
    block.text
  );
};

const renderWechatBeautyHeadingBlock = (block, blockIndex, context) => {
  const variant = context.headingMap.get(blockIndex) || (block.type === 'heading' ? 'underline' : 'plain');
  const tag = block.type === 'heading' ? 'h2' : 'h3';
  const ordinal = context.headingOrdinals.get(blockIndex);
  const textHtml = renderWechatTextWithHighlights(block.text, context.highlightMap.get(blockIndex), context.theme);

  if (variant === 'chapter_marker') {
    return createWechatRenderedBlock(
      `
        <div style="margin: 40px 0 22px;">
          <${tag} style="margin: 0; color: #F17724; font-size: ${block.type === 'heading' ? 28 : 22}px; line-height: 1.45; font-weight: 800;">
            ${ordinal ? `<span data-wechat-decoration="true" style="display: inline-block; margin-right: 10px; color: #F17724; font-weight: 800;">#${ordinal}</span>` : ''}
            <span>${textHtml}</span>
          </${tag}>
          <div data-wechat-decoration="true" style="width: ${block.type === 'heading' ? 108 : 82}px; height: 2px; margin-top: 12px; background: linear-gradient(90deg, #F17724 0%, rgba(241, 119, 36, 0.28) 100%);"></div>
        </div>
      `.trim(),
      block.text
    );
  }

  if (variant === 'red_bar') {
    return createWechatRenderedBlock(
      `
        <div style="margin: 34px 0 18px; padding-left: 16px; border-left: 6px solid #D92D20;">
          <${tag} style="margin: 0; color: ${context.theme.titleColor}; font-size: ${block.type === 'heading' ? 24 : 20}px; line-height: 1.45; font-weight: 800;">${textHtml}</${tag}>
        </div>
      `.trim(),
      block.text
    );
  }

  if (variant === 'section_band') {
    return createWechatRenderedBlock(
      `
        <div style="margin: 36px 0 18px; padding: 16px 18px; border-radius: 22px; background: ${context.theme.sectionBackground}; border: 1px solid ${context.theme.cardBorder};">
          <${tag} style="margin: 0; color: ${context.theme.sectionColor}; font-size: ${block.type === 'heading' ? 24 : 20}px; line-height: 1.45; font-weight: 800;">${textHtml}</${tag}>
        </div>
      `.trim(),
      block.text
    );
  }

  if (variant === 'underline') {
    return createWechatRenderedBlock(
      `
        <div style="margin: 32px 0 18px;">
          <${tag} style="margin: 0; color: ${context.theme.titleColor}; font-size: ${block.type === 'heading' ? 23 : 19}px; line-height: 1.45; font-weight: 700;">${textHtml}</${tag}>
          <div data-wechat-decoration="true" style="width: ${block.type === 'heading' ? 84 : 64}px; height: 2px; margin-top: 10px; background: ${context.theme.accent};"></div>
        </div>
      `.trim(),
      block.text
    );
  }

  if (variant === 'accent_tag') {
    return createWechatRenderedBlock(
      `
        <div style="margin: 28px 0 14px;">
          <div style="display: inline-flex; align-items: center; gap: 8px; margin-bottom: 8px;">
            <span data-wechat-decoration="true" style="display: inline-block; width: 26px; height: 8px; border-radius: 999px; background: ${context.theme.accent};"></span>
            <span data-wechat-decoration="true" style="display: inline-block; width: 8px; height: 8px; border-radius: 999px; background: ${context.theme.cardBorder};"></span>
          </div>
          <${tag} style="margin: 0; color: ${context.theme.titleColor}; font-size: ${block.type === 'heading' ? 22 : 18}px; line-height: 1.48; font-weight: 760;">${textHtml}</${tag}>
        </div>
      `.trim(),
      block.text
    );
  }

  if (variant === 'number_badge') {
    const badgeText = ordinal ? String(ordinal).padStart(2, '0') : '+';
    return createWechatRenderedBlock(
      `
        <div style="display: flex; align-items: flex-start; gap: 12px; margin: 32px 0 18px;">
          <span data-wechat-decoration="true" style="display: inline-flex; flex: 0 0 auto; align-items: center; justify-content: center; min-width: ${block.type === 'heading' ? 38 : 34}px; height: ${block.type === 'heading' ? 38 : 34}px; border-radius: 14px; background: ${context.theme.accentSoft}; color: ${context.theme.sectionColor}; font-size: ${block.type === 'heading' ? 14 : 13}px; font-weight: 800; line-height: 1;">${badgeText}</span>
          <${tag} style="margin: 2px 0 0; color: ${context.theme.titleColor}; font-size: ${block.type === 'heading' ? 22 : 18}px; line-height: 1.5; font-weight: 780;">${textHtml}</${tag}>
        </div>
      `.trim(),
      block.text
    );
  }

  return createWechatRenderedBlock(
    `<${tag} style="margin: ${block.type === 'heading' ? '30px 0 16px' : '24px 0 12px'}; color: ${context.theme.titleColor}; font-size: ${block.type === 'heading' ? 22 : 18}px; line-height: 1.5; font-weight: 700;">${textHtml}</${tag}>`,
    block.text
  );
};

const renderWechatBeautyQuoteBlock = (block, blockIndex, context) => {
  const variant = context.quoteMap.get(blockIndex) || 'editorial_quote';
  const renderedText =
    blockIndex === context.openingHighlightBlockIndex
      ? stripLeadingWechatOpeningHighlightSentences(block.text, context.openingHighlightSentences)
      : block.text;
  if (!cleanText(renderedText)) {
    return createWechatRenderedBlock('', block.text);
  }
  const textHtml = renderWechatTextWithHighlights(renderedText, context.highlightMap.get(blockIndex), context.theme);
  if (variant === 'accent_panel') {
    return createWechatRenderedBlock(
      `
        <blockquote style="margin: 28px 0; padding: 18px 18px 18px 20px; border-radius: 18px; background: #FFFFFF; border: 1px solid ${context.theme.cardBorder}; color: ${context.theme.titleColor}; font-size: 16px; line-height: 1.92;">
          ${textHtml}
        </blockquote>
      `.trim(),
      block.text
    );
  }
  if (variant === 'centered_pull') {
    return createWechatRenderedBlock(
      `
        <blockquote style="margin: 30px 0; padding: 16px 14px; text-align: center; border: 1px solid ${context.theme.cardBorder}; border-radius: 18px; background: #FFFFFF;">
          <p style="margin: 0; color: ${context.theme.titleColor}; font-size: 18px; line-height: 1.85; font-weight: 650;">${textHtml}</p>
        </blockquote>
      `.trim(),
      block.text
    );
  }
  if (variant === 'plain_quote') {
    return createWechatRenderedBlock(
      `<blockquote style="margin: 24px 0; padding-left: 16px; border-left: 3px solid ${context.theme.cardBorder}; color: ${context.theme.bodyColor}; font-size: 15px; line-height: 1.9;">${textHtml}</blockquote>`,
      block.text
    );
  }
  return createWechatRenderedBlock(
    `<blockquote style="margin: 26px 0; padding: 18px 20px; border-left: 4px solid ${context.theme.quoteBorder}; border-radius: 0 20px 20px 0; background: ${context.theme.quoteBackground}; color: ${context.theme.titleColor}; font-size: 16px; line-height: 1.92;">${textHtml}</blockquote>`,
    block.text
  );
};

const renderWechatBeautyListBlock = (block, blockIndex, context) => {
  const variant = context.listMap.get(blockIndex) || (block.type === 'ordered_list' ? 'numbered_steps' : 'bullet_brief');
  const tag = block.type === 'ordered_list' ? 'ol' : 'ul';
  if (variant === 'numbered_steps') {
    return createWechatRenderedBlock(
      `<ol style="display: grid; grid-template-columns: 1fr; gap: 10px; margin: 4px 0 22px; padding: 0; list-style: none;">${(block.items || [])
        .map(
          (item, itemIndex) =>
            `<li style="display: flex; gap: 12px; align-items: flex-start; padding: 12px 0 12px; border-bottom: 1px solid ${context.theme.cardBorder};"><span data-wechat-decoration="true" style="display: inline-flex; flex: 0 0 auto; align-items: center; justify-content: center; min-width: 28px; height: 28px; border-radius: 999px; background: ${context.theme.accentSoft}; color: ${context.theme.sectionColor}; font-size: 12px; font-weight: 800; line-height: 1;">${itemIndex + 1}</span><span style="display: inline-block; color: ${context.theme.bodyColor}; font-size: 15px; line-height: 1.82;">${escapeHtml(item)}</span></li>`
        )
        .join('')}</ol>`,
      (block.items || []).join(' ')
    );
  }
  if (variant === 'card_list') {
    return createWechatRenderedBlock(
      `<${tag} style="display: grid; grid-template-columns: 1fr; gap: 10px; margin: 4px 0 22px; padding: 0; list-style: none;">${(block.items || [])
        .map((item, itemIndex) => {
          const marker = block.type === 'ordered_list' ? String(itemIndex + 1).padStart(2, '0') : '*';
          return `<li style="display: flex; gap: 12px; align-items: flex-start; padding: 14px 14px 13px; border: 1px solid ${context.theme.cardBorder}; border-radius: 18px; background: #FFFFFF;"><span data-wechat-decoration="true" style="display: inline-flex; flex: 0 0 auto; align-items: center; justify-content: center; min-width: 28px; height: 28px; border-radius: 10px; border: 1px solid ${context.theme.cardBorder}; background: #FFFFFF; color: ${context.theme.sectionColor}; font-size: 12px; font-weight: 800; line-height: 1;">${marker}</span><span style="display: inline-block; color: ${context.theme.bodyColor}; font-size: 15px; line-height: 1.82;">${escapeHtml(item)}</span></li>`;
        })
        .join('')}</${tag}>`,
      (block.items || []).join(' ')
    );
  }
  if (variant === 'check_grid') {
    return createWechatRenderedBlock(
      `<${tag} style="display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 10px 12px; margin: 4px 0 22px; padding: 0; list-style: none;">${(block.items || [])
        .map(
          (item) =>
            `<li style="display: flex; gap: 10px; align-items: flex-start; min-width: 0; padding: 10px 12px; border-radius: 16px; border: 1px solid ${context.theme.cardBorder}; background: #FFFFFF;"><span data-wechat-decoration="true" style="display: inline-flex; flex: 0 0 auto; align-items: center; justify-content: center; width: 20px; height: 20px; border-radius: 999px; border: 1px solid ${context.theme.cardBorder}; background: #FFFFFF; color: ${context.theme.accent}; font-size: 12px; font-weight: 800; line-height: 1;">+</span><span style="display: inline-block; min-width: 0; color: ${context.theme.bodyColor}; font-size: 14px; line-height: 1.75;">${escapeHtml(item)}</span></li>`
        )
        .join('')}</${tag}>`,
      (block.items || []).join(' ')
    );
  }
  const baseStyle =
    variant === 'plain_list'
      ? `margin: 0 0 18px; padding-left: 1.35em; color: ${context.theme.bodyColor}; font-size: 15px; line-height: 1.9;`
      : `margin: 2px 0 20px; padding-left: 1.45em; color: ${context.theme.bodyColor}; font-size: 15px; line-height: 1.95;`;
  return createWechatRenderedBlock(
    `<${tag} style="${baseStyle}">${block.items
      .map((item) => `<li style="margin: 0 0 10px;">${escapeHtml(item)}</li>`)
      .join('')}</${tag}>`,
    (block.items || []).join(' ')
  );
};

const renderWechatBeautyTableBlock = (block, blockIndex, context) => {
  const variant = context.tableMap.get(blockIndex) || 'data_grid';
  const radius = variant === 'compact_grid' ? 14 : variant === 'matrix_panel' ? 22 : 20;
  const cellPadding = variant === 'compact_grid' ? '9px 8px' : variant === 'minimal_rows' ? '11px 6px' : '12px 10px';
  const containerBackground = variant === 'matrix_panel' ? context.theme.sectionBackground : context.theme.cardBackground;
  const headerBackground = variant === 'matrix_panel' ? '#FFFFFF' : context.theme.tableHeaderBackground;
  const rowBackground = (rowIndex) => {
    if (variant === 'minimal_rows') {
      return 'transparent';
    }
    if (variant === 'matrix_panel') {
      return rowIndex % 2 === 0 ? '#FFFFFF' : 'rgba(255,255,255,0.72)';
    }
    return rowIndex % 2 === 0 ? context.theme.cardBackground : context.theme.tableStripeBackground;
  };
  return createWechatRenderedBlock(
    `
      <div style="margin: 28px 0; overflow-x: auto; border: 1px solid ${context.theme.cardBorder}; border-radius: ${radius}px; background: ${containerBackground}; box-shadow: none;">
        <table style="width: 100%; border-collapse: collapse; font-size: 13px; line-height: 1.75; color: ${context.theme.bodyColor};">
          <thead style="background: ${headerBackground};">
            <tr>${block.headers
              .map(
                (cell, cellIndex) =>
                  `<th style="padding: ${cellPadding}; border-bottom: 1px solid ${context.theme.cardBorder}; text-align: left; font-weight: 700; color: ${cellIndex === 0 && variant === 'matrix_panel' ? context.theme.sectionColor : context.theme.titleColor}; white-space: ${variant === 'minimal_rows' ? 'nowrap' : 'normal'};">${escapeHtml(cell)}</th>`
              )
              .join('')}</tr>
          </thead>
          <tbody>
            ${block.rows
              .map(
                (row, rowIndex) =>
                  `<tr style="background: ${rowBackground(rowIndex)};">${row
                    .map(
                      (cell, cellIndex) =>
                        `<td style="padding: ${cellPadding}; border-bottom: 1px solid ${context.theme.cardBorder}; vertical-align: top; font-weight: ${cellIndex === 0 && variant === 'matrix_panel' ? 650 : 400}; color: ${cellIndex === 0 && variant === 'matrix_panel' ? context.theme.titleColor : context.theme.bodyColor};">${escapeHtml(cell)}</td>`
                    )
                    .join('')}</tr>`
              )
              .join('')}
          </tbody>
        </table>
      </div>
    `.trim(),
    [...(block.headers || []), ...(block.rows || []).flat()].join(' ')
  );
};

const renderWechatBeautyImageBlock = (image, blockIndex, context) => {
  const variant = context.imageMap.get(blockIndex) || 'caption_focus';
  if (variant === 'shadow_card') {
    return createWechatRenderedBlock(
      `
        <figure style="margin: 36px 0 32px; width: 100%; box-sizing: border-box; padding: 10px; border-radius: 24px; background: #FFFFFF; border: 1px solid ${context.theme.cardBorder};">
          <img src="${escapeHtml(image.url)}" alt="${escapeHtml(image.title || 'Illustration')}" style="display: block; width: 100%; max-width: 100%; height: auto; border-radius: 16px; background: #F8FAFC;" />
          ${image.caption ? `<figcaption style="margin-top: 12px; color: ${context.theme.mutedColor}; font-size: 13px; line-height: 1.75;">${escapeHtml(image.caption)}</figcaption>` : ''}
        </figure>
      `.trim()
    );
  }
  if (variant === 'caption_band') {
    return createWechatRenderedBlock(
      `
        <figure style="margin: 36px 0 30px; width: 100%; box-sizing: border-box; overflow: hidden; border-radius: 22px; background: #FFFFFF; border: 1px solid ${context.theme.cardBorder};">
          <img src="${escapeHtml(image.url)}" alt="${escapeHtml(image.title || 'Illustration')}" style="display: block; width: 100%; max-width: 100%; height: auto; background: #F8FAFC;" />
          ${image.caption ? `<figcaption style="padding: 12px 14px 13px; background: ${context.theme.sectionBackground}; color: ${context.theme.bodyColor}; font-size: 13px; line-height: 1.72;">${escapeHtml(image.caption)}</figcaption>` : ''}
        </figure>
      `.trim()
    );
  }
  if (variant === 'border_frame') {
    return createWechatRenderedBlock(
      `
        <figure style="margin: 36px 0 30px; width: 100%; box-sizing: border-box; padding: 8px; border-radius: 24px; border: 1px solid ${context.theme.cardBorder}; background: #FFFFFF;">
          <img src="${escapeHtml(image.url)}" alt="${escapeHtml(image.title || 'Illustration')}" style="display: block; width: 100%; max-width: 100%; height: auto; border-radius: 16px; background: #F8FAFC;" />
          ${image.caption ? `<figcaption style="margin-top: 10px; color: ${context.theme.mutedColor}; font-size: 13px; line-height: 1.75;">${escapeHtml(image.caption)}</figcaption>` : ''}
        </figure>
      `.trim()
    );
  }
  if (variant === 'editorial_card') {
    return createWechatRenderedBlock(
      `
        <figure style="margin: 34px 0 30px; width: 100%; box-sizing: border-box; padding: 10px; border: 1px solid ${context.theme.cardBorder}; border-radius: 22px; background: #FFFFFF;">
          <img src="${escapeHtml(image.url)}" alt="${escapeHtml(image.title || 'Illustration')}" style="display: block; width: 100%; max-width: 100%; height: auto; border-radius: 14px; background: #F8FAFC;" />
          ${image.caption ? `<figcaption style="margin-top: 12px; color: ${context.theme.mutedColor}; font-size: 13px; line-height: 1.75;">${escapeHtml(image.caption)}</figcaption>` : ''}
        </figure>
      `.trim()
    );
  }

  if (variant === 'full_bleed') {
    return createWechatRenderedBlock(
      `
        <figure style="margin: 38px 0 32px; width: 100%; box-sizing: border-box;">
          <img src="${escapeHtml(image.url)}" alt="${escapeHtml(image.title || 'Illustration')}" style="display: block; width: 100%; max-width: 100%; height: auto; border-radius: 20px; background: #F8FAFC;" />
          ${image.caption ? `<figcaption style="margin-top: 10px; padding-left: 2px; color: ${context.theme.mutedColor}; font-size: 12px; line-height: 1.7;">${escapeHtml(image.caption)}</figcaption>` : ''}
        </figure>
      `.trim()
    );
  }

  return createWechatRenderedBlock(
    `
      <figure style="margin: 34px 0 30px; width: 100%; box-sizing: border-box;">
        <img src="${escapeHtml(image.url)}" alt="${escapeHtml(image.title || 'Illustration')}" style="display: block; width: 100%; max-width: 100%; height: auto; border-radius: 18px; background: #F8FAFC;" />
        ${image.caption ? `<figcaption style="margin-top: 12px; padding-top: 10px; border-top: 1px solid ${context.theme.cardBorder}; color: ${context.theme.mutedColor}; font-size: 13px; line-height: 1.75;">${escapeHtml(image.caption)}</figcaption>` : ''}
      </figure>
    `.trim()
  );
};

const renderWechatBeautyDivider = (theme) =>
  `<div data-wechat-decoration="true" style="width: 100%; height: 1px; margin: 28px 0; background: linear-gradient(90deg, transparent 0%, ${theme.cardBorder} 18%, ${theme.cardBorder} 82%, transparent 100%);"></div>`;

const renderWechatBeautyBlockHtml = (block, blockIndex, context) => {
  if (block.type === 'heading' || block.type === 'subheading') {
    return renderWechatBeautyHeadingBlock(block, blockIndex, context);
  }
  if (block.type === 'quote') {
    return renderWechatBeautyQuoteBlock(block, blockIndex, context);
  }
  if (block.type === 'unordered_list' || block.type === 'ordered_list') {
    return renderWechatBeautyListBlock(block, blockIndex, context);
  }
  if (block.type === 'table') {
    return renderWechatBeautyTableBlock(block, blockIndex, context);
  }
  if (block.type === 'image') {
    return renderWechatBeautyImageBlock(block.image, blockIndex, context);
  }
  return renderWechatBeautyParagraphBlock(block, blockIndex, context);
};

const validateWechatRenderedBlocksPreserveText = (blocks, renderedBlocks) => {
  for (let index = 0; index < blocks.length; index += 1) {
    if (blocks[index].type === 'image') {
      continue;
    }
    const expected = normalizeWechatPlainText(getWechatBlockPlainText(blocks[index]));
    const actual = normalizeWechatPlainText(renderedBlocks[index]?.plainText);
    if (expected !== actual) {
      throw buildWechatRenderValidationError({
        block: blocks[index],
        blockIndex: index,
        expected,
        actual,
      });
    }
  }
};

const collectWechatRenderedBlockDiagnostics = (blocks, renderedBlocks, layout = {}) => {
  const warnings = [];
  const openingHighlightBlockIndex = hasWechatOpeningHighlight({ blocks, layout })
    ? resolveWechatOpeningHighlightSourceBlockIndex(blocks)
    : -1;
  for (let index = 0; index < blocks.length; index += 1) {
    if (blocks[index].type === 'image') {
      continue;
    }
    if (index === openingHighlightBlockIndex) {
      continue;
    }
    const expected = normalizeWechatPlainText(getWechatBlockPlainText(blocks[index]));
    const extracted = stripWechatHtmlToText(renderedBlocks[index]?.html);
    if (expected !== extracted) {
      warnings.push(
        `渲染诊断：第 ${index + 1} 个区块（${blocks[index].type}）的 HTML 文本抽取结果与源文本不一致，但源文本已按原文保留。`
      );
    }
  }
  return warnings;
};

const renderWechatCreditsBlock = ({ layout, theme, renderPlan }) => {
  const lines = [];
  if (layout.author) {
    lines.push({ label: '\u4f5c\u8005', value: layout.author });
  }
  if (layout.editor) {
    lines.push({ label: '\u7f16\u8f91', value: layout.editor });
  }
  if (!lines.length && !(layout.creditLines || []).length) {
    return '';
  }

  const creditsVariant = renderPlan?.creditsVariant || 'stacked_labels';
  if (creditsVariant === 'inline_meta_bar') {
    const inlineItems = [
      ...lines.map(
        (line) =>
          `<div style="display: inline-flex; align-items: center; gap: 8px; padding: 8px 12px; border-radius: 999px; background: ${theme.sectionBackground};"><span data-wechat-decoration="true" style="color: ${theme.sectionColor}; font-size: 12px; font-weight: 800; letter-spacing: 0.04em;">${escapeHtml(line.label)}</span><span style="color: ${theme.titleColor}; font-size: 14px; line-height: 1.5; font-weight: 600;">${escapeHtml(line.value)}</span></div>`
      ),
      ...(layout.creditLines || []).map(
        (line) =>
          `<div style="display: inline-flex; align-items: center; padding: 8px 12px; border-radius: 999px; border: 1px solid ${theme.cardBorder}; color: ${theme.mutedColor}; font-size: 13px; line-height: 1.5;">${escapeHtml(line)}</div>`
      ),
    ].join('');

    return `
      <section style="display: flex; flex-wrap: wrap; gap: 10px; margin: 0 0 20px; padding: 0;">
        ${inlineItems}
      </section>
    `.trim();
  }

  const lineHtml = lines
    .map((line) => {
      if (creditsVariant === 'minimal_labels') {
        return `<div style="margin: 0 0 8px;"><span data-wechat-decoration="true" style="display: inline-block; min-width: 34px; margin-right: 8px; color: ${theme.accent}; font-size: 13px; font-weight: 700; vertical-align: baseline;">${escapeHtml(line.label)}</span><span style="display: inline-block; color: ${theme.titleColor}; font-size: 15px; line-height: 1.65; font-weight: 600; vertical-align: baseline;">${escapeHtml(line.value)}</span></div>`;
      }
      return `<div style="margin: 0 0 10px;"><span data-wechat-decoration="true" style="display: inline-block; min-width: 44px; margin-right: 8px; padding: 2px 9px; background: #F17724; color: #FFFFFF; font-size: 13px; font-weight: 800; line-height: 1.35; text-align: center; vertical-align: baseline;">${escapeHtml(line.label)}</span><span style="display: inline-block; color: ${theme.titleColor}; font-size: 15px; line-height: 1.65; font-weight: 600; vertical-align: baseline;">${escapeHtml(line.value)}</span></div>`;
    })
    .join('');

  const creditLinesHtml = (layout.creditLines || [])
    .map(
      (line) =>
        `<div style="margin: 0 0 8px; color: ${theme.mutedColor}; font-size: 13px; line-height: 1.7;">${escapeHtml(line)}</div>`
    )
    .join('');

  return `
    <section style="margin: 0 0 18px; padding: 0 0 8px;">
      ${lineHtml}
      ${creditLinesHtml}
    </section>
  `.trim();
};

const renderWechatArticleHtmlWithPlan = ({ title, blocks, theme, layout, renderPlan }) => {
  const context = buildWechatBeautyRenderContext({ blocks, renderPlan, theme, layout });
  const renderedBlocks = blocks.map((block, blockIndex) => renderWechatBeautyBlockHtml(block, blockIndex, context));
  validateWechatRenderedBlocksPreserveText(blocks, renderedBlocks);
  const diagnosticWarnings = collectWechatRenderedBlockDiagnostics(blocks, renderedBlocks, layout);
  const bodyHtml = renderedBlocks
    .map(({ html }, blockIndex) => `${html}${context.dividerSet.has(blockIndex) ? renderWechatBeautyDivider(theme) : ''}`)
    .join('\n');
  const creditsHtml = renderWechatCreditsBlock({ layout, theme, renderPlan });
  const openingHighlightHtml = renderWechatOpeningHighlightBlock({ blocks, layout, theme });
  return {
    contentHtml: `
      <section style="padding: 18px 10px 26px; background: #FFFFFF;">
        <article style="margin: 0 auto; width: 100%; max-width: 700px;">
          ${creditsHtml}
          ${openingHighlightHtml}
          <div style="color: ${theme.titleColor};">${bodyHtml}</div>
        </article>
      </section>
    `.trim(),
    warnings: diagnosticWarnings,
  };
};

const buildWechatPreviewDocument = ({ title, contentHtml, theme }) => `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(title)}</title>
    <style>
      * { box-sizing: border-box; }
      body { margin: 0; padding: 12px 8px 20px; background: ${theme.pageBackground}; font-family: "PingFang SC","Microsoft YaHei",sans-serif; }
      .wechat-preview-shell { max-width: 760px; margin: 0 auto; background: #FFFFFF; border-radius: 28px; box-shadow: 0 20px 40px rgba(15, 23, 42, 0.08); overflow: hidden; }
      img { display: block; max-width: 100%; height: auto; }
    </style>
  </head>
  <body>
    <div class="wechat-preview-shell">${contentHtml}</div>
  </body>
</html>`;

const resolveCoverEntry = (entries, layout) => {
  if (!entries.length) return null;
  if (layout.coverStrategy === 'manual' && layout.preferredCoverAssetId) {
    const matched = entries.find((entry) => entry.assetId === layout.preferredCoverAssetId);
    if (matched) return matched;
  }
  if (layout.coverStrategy === 'hero') {
    const hero = entries.find((entry) => entry.role === 'hero');
    if (hero) return hero;
  }
  return entries[0];
};

const decodeDataUrl = (value) => {
  const matched = String(value || '').match(/^data:([^;]+);base64,(.+)$/);
  if (!matched) {
    throw new Error('Unsupported data URL.');
  }
  return {
    mimeType: matched[1],
    buffer: Buffer.from(matched[2], 'base64'),
  };
};

const readAssetBuffer = async (assetUrl) => {
  const normalized = cleanText(assetUrl);
  if (!normalized) {
    throw new Error('Missing asset URL.');
  }
  if (normalized.startsWith('data:')) {
    return decodeDataUrl(normalized);
  }
  if (/^https?:\/\//i.test(normalized)) {
    const response = await fetch(normalized);
    if (!response.ok) {
      throw new Error(`Failed to fetch image: ${response.status} ${response.statusText}`);
    }
    return {
      mimeType: response.headers.get('content-type') || 'image/png',
      buffer: Buffer.from(await response.arrayBuffer()),
    };
  }
  if (normalized.startsWith('/generated-assets/')) {
    const relativeAssetPath = decodeURIComponent(normalized.replace(/^\/generated-assets\//, ''));
    const localPath = path.resolve(GENERATED_ASSET_ROOT, relativeAssetPath);
    const rootPath = path.resolve(GENERATED_ASSET_ROOT);
    if (localPath !== rootPath && !localPath.startsWith(`${rootPath}${path.sep}`)) {
      throw new Error('Unsafe generated asset path.');
    }
    const buffer = await fs.readFile(localPath);
    return {
      mimeType: normalized.toLowerCase().endsWith('.png') ? 'image/png' : 'image/jpeg',
      buffer,
    };
  }
  throw new Error(`Unsupported asset URL: ${normalized}`);
};

const compressImageForWechat = async ({ buffer, kind }) => {
  const targetBytes = kind === 'cover' ? COVER_IMAGE_MAX_BYTES : INLINE_IMAGE_MAX_BYTES;
  const targetWidth = kind === 'cover' ? COVER_IMAGE_WIDTH : INLINE_IMAGE_WIDTH;
  const qualityCandidates = kind === 'cover' ? [84, 78, 72, 66] : [82, 76, 70, 64];

  for (const quality of qualityCandidates) {
    const output = await sharp(buffer)
      .rotate()
      .resize({ width: targetWidth, withoutEnlargement: true })
      .flatten({ background: '#FFFFFF' })
      .jpeg({ quality, mozjpeg: true })
      .toBuffer();
    if (output.byteLength <= targetBytes || quality === qualityCandidates[qualityCandidates.length - 1]) {
      return {
        buffer: output,
        mimeType: 'image/jpeg',
        fileName: kind === 'cover' ? 'wechat-cover.jpg' : 'wechat-inline.jpg',
        byteLength: output.byteLength,
      };
    }
  }

  throw new Error('Failed to compress image for WeChat.');
};

const ensureWechatOk = (payload, context) => {
  if (payload && typeof payload.errcode !== 'undefined' && Number(payload.errcode) !== 0) {
    throw new Error(`${context} failed: ${payload.errmsg || payload.errcode}`);
  }
  return payload;
};

const clearWechatAccessTokenCache = () => {
  accessTokenCache = {
    accessToken: '',
    expiresAt: 0,
  };
};

const isWechatCredentialError = (error) => {
  const message = String(error?.message || '');
  return /invalid credential|access_token is invalid|not latest|getStableAccessToken/i.test(message);
};

const fetchWechatJson = async (url, init = {}, context = 'Wechat request', fetchImpl = fetch) => {
  const response = await fetchImpl(url, init);
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(`${context} failed: ${response.status} ${response.statusText}`);
  }
  return ensureWechatOk(payload, context);
};

const isWechatInvalidDraftMediaIdError = (error) => /invalid media_id/i.test(String(error?.message || ''));

const createWechatDraft = async ({ accessToken, articlePayload, fetchImpl = fetch }) =>
  fetchWechatJson(
    `${WECHAT_API_ORIGIN}/cgi-bin/draft/add?access_token=${encodeURIComponent(accessToken)}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        articles: [articlePayload],
      }),
    },
    'Create draft',
    fetchImpl
  );

const updateWechatDraft = async ({ accessToken, mediaId, articlePayload, fetchImpl = fetch }) =>
  fetchWechatJson(
    `${WECHAT_API_ORIGIN}/cgi-bin/draft/update?access_token=${encodeURIComponent(accessToken)}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        media_id: mediaId,
        index: 0,
        articles: articlePayload,
      }),
    },
    'Update draft',
    fetchImpl
  );

const getWechatAccessToken = async (fetchImpl = fetch, forceRefresh = false) => {
  const config = buildWechatPublisherConfig();
  if (!config.configured) {
    throw new Error(`WeChat credentials are missing: ${config.missingKeys.join(', ')}`);
  }
  if (!forceRefresh && accessTokenCache.accessToken && accessTokenCache.expiresAt > Date.now()) {
    return accessTokenCache.accessToken;
  }
  const payload = await fetchWechatJson(
    `${WECHAT_API_ORIGIN}/cgi-bin/stable_token`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'client_credential',
        appid: config.appId,
        secret: config.appSecret,
        force_refresh: Boolean(forceRefresh),
      }),
    },
    forceRefresh ? 'Force refresh stable access token' : 'Get stable access token',
    fetchImpl
  );
  accessTokenCache = {
    accessToken: cleanText(payload.access_token),
    expiresAt: Date.now() + Math.max(0, Number(payload.expires_in || 7200) - 300) * 1000,
  };
  return accessTokenCache.accessToken;
};

const runWithWechatCredentialRetry = async (operation) => {
  try {
    return await operation(false);
  } catch (error) {
    if (!isWechatCredentialError(error)) {
      throw error;
    }
    clearWechatAccessTokenCache();
    return operation(true);
  }
};

const uploadWechatInlineImage = async ({ accessToken, image, fetchImpl = fetch }) => {
  const form = new FormData();
  form.append('media', new Blob([image.buffer], { type: image.mimeType }), image.fileName);
  const url = `${WECHAT_API_ORIGIN}/cgi-bin/media/uploadimg?access_token=${encodeURIComponent(accessToken)}`;
  const payload = await fetchWechatJson(url, { method: 'POST', body: form }, 'Upload inline image', fetchImpl);
  return cleanText(payload.url);
};

const uploadWechatCoverMaterial = async ({ accessToken, image, fetchImpl = fetch }) => {
  const form = new FormData();
  form.append('media', new Blob([image.buffer], { type: image.mimeType }), image.fileName);
  const url = `${WECHAT_API_ORIGIN}/cgi-bin/material/add_material?access_token=${encodeURIComponent(accessToken)}&type=image`;
  const payload = await fetchWechatJson(url, { method: 'POST', body: form }, 'Upload cover material', fetchImpl);
  return {
    mediaId: cleanText(payload.media_id),
    url: cleanText(payload.url),
  };
};

const buildDraftArticlePayload = ({ title, contentHtml, layout, digest, coverMediaId }) => ({
  title,
  author: layout.author,
  digest,
  content: contentHtml,
  content_source_url: layout.contentSourceUrl || '',
  thumb_media_id: coverMediaId,
  need_open_comment: toCommentFlag(layout.needOpenComment),
  only_fans_can_comment: toCommentFlag(layout.needOpenComment && layout.onlyFansCanComment),
});

const replaceImageUrlsForDraft = (blocks, uploadedImageUrls) =>
  blocks.map((block) =>
    block.type === 'image'
      ? {
          ...block,
          image: {
            ...block.image,
            url: uploadedImageUrls.get(block.image.assetId) || block.image.url,
          },
        }
      : block
  );

const prepareWechatPreview = async ({ topic, articleContent, illustrationBundle, layout, apiKey, renderPlan }) => {
  const normalizedLayout = normalizeWechatLayoutSettings(layout);
  const title = extractTitle(topic, articleContent);
  const digest = normalizedLayout.digest || inferDigest(articleContent);
  const template = resolveTemplateOption(normalizedLayout.templateId);
  const theme = resolveTemplateTheme(normalizedLayout.templateId);
  const illustrationEntries = resolveActiveIllustrationEntries(illustrationBundle);
  const coverEntry = resolveCoverEntry(illustrationEntries, normalizedLayout);
  const baseBlocks = buildArticleBlocks(articleContent);
  const blocks = normalizeWechatBodyBlocks({
    blocks: interleaveImageBlocks(baseBlocks, illustrationEntries),
    layout: normalizedLayout,
  });
  const warnings = [];
  if (!illustrationEntries.length) {
    warnings.push('当前正文没有可用配图，将只导出纯文字公众号排版。');
  }
  const planResolution = await resolveWechatRenderPlanWithAgent({
    apiKey,
    title,
    digest,
    layout: normalizedLayout,
    templateLabel: template.label,
    blocks,
    renderPlan,
  });
  warnings.push(...planResolution.warnings);
  const renderResult = renderWechatArticleHtmlWithPlan({
    title,
    blocks,
    theme,
    layout: normalizedLayout,
    renderPlan: planResolution.renderPlan,
  });
  warnings.push(...renderResult.warnings);
  return {
    title,
    layout: normalizedLayout,
    contentHtml: renderResult.contentHtml,
    previewHtml: buildWechatPreviewDocument({ title, contentHtml: renderResult.contentHtml, theme }),
    digest,
    blocks,
    coverEntry,
    renderPlan: planResolution.renderPlan,
    metadata: {
      templateId: normalizedLayout.templateId,
      rendererVersion: WECHAT_RENDERER_VERSION,
      title,
      author: normalizedLayout.author,
      editor: normalizedLayout.editor,
      digest,
      contentSourceUrl: normalizedLayout.contentSourceUrl || undefined,
      coverAssetId: coverEntry?.assetId,
      coverImageUrl: coverEntry?.url,
      imageCount: illustrationEntries.length,
      blockCount: blocks.length,
      renderPlan: planResolution.renderPlan,
      beautyAgent: planResolution.renderPlan.beautyAgent,
      warnings,
    },
    warnings,
  };
};

export const generateWechatDraftPreview = async ({ topic, articleContent, illustrationBundle, layout, apiKey, renderPlan }) =>
  prepareWechatPreview({ topic, articleContent, illustrationBundle, layout, apiKey, renderPlan });

export const upsertWechatOfficialDraft = async ({
  topic,
  articleContent,
  illustrationBundle,
  layout,
  mediaId,
  apiKey,
  renderPlan,
  fetchImpl = fetch,
}) => {
  return runWithWechatCredentialRetry(async (forceRefresh) => {
    const preview = await prepareWechatPreview({ topic, articleContent, illustrationBundle, layout, apiKey, renderPlan });
    const accessToken = await getWechatAccessToken(fetchImpl, forceRefresh);
    const uploadedImageUrls = new Map();

    for (const block of preview.blocks) {
      if (block.type !== 'image' || uploadedImageUrls.has(block.image.assetId)) {
        continue;
      }
      const source = await readAssetBuffer(block.image.url);
      const compressed = await compressImageForWechat({ buffer: source.buffer, kind: 'inline' });
      const uploadedUrl = await uploadWechatInlineImage({
        accessToken,
        image: compressed,
        fetchImpl,
      });
      uploadedImageUrls.set(block.image.assetId, uploadedUrl);
    }

    let coverMediaId = '';
    let coverAssetId = preview.coverEntry?.assetId;
    if (preview.coverEntry) {
      const coverSource = await readAssetBuffer(preview.coverEntry.url);
      const coverImage = await compressImageForWechat({ buffer: coverSource.buffer, kind: 'cover' });
      const uploadedCover = await uploadWechatCoverMaterial({
        accessToken,
        image: coverImage,
        fetchImpl,
      });
      coverMediaId = uploadedCover.mediaId;
    }

    if (!coverMediaId) {
      throw new Error('No cover image is available for WeChat draft.');
    }

    const uploadedBlocks = replaceImageUrlsForDraft(preview.blocks, uploadedImageUrls);
    const renderResult = renderWechatArticleHtmlWithPlan({
      title: preview.title,
      blocks: uploadedBlocks,
      theme: resolveTemplateTheme(preview.layout.templateId),
      layout: preview.layout,
      renderPlan: preview.renderPlan,
    });
    const contentHtml = renderResult.contentHtml;
    preview.warnings = [...(preview.warnings || []), ...(renderResult.warnings || [])];
    preview.metadata = {
      ...preview.metadata,
      warnings: preview.warnings,
    };

    const articlePayload = buildDraftArticlePayload({
      title: preview.title,
      contentHtml,
      layout: preview.layout,
      digest: preview.digest,
      coverMediaId,
    });

    let payload;
    if (mediaId) {
      try {
        payload = await updateWechatDraft({
          accessToken,
          mediaId,
          articlePayload,
          fetchImpl,
        });
      } catch (error) {
        if (!isWechatInvalidDraftMediaIdError(error)) {
          throw error;
        }
        preview.warnings = [
          ...(preview.warnings || []),
          `Existing WeChat draft ${mediaId} is invalid. Created a new draft automatically.`,
        ];
        preview.metadata = {
          ...preview.metadata,
          warnings: preview.warnings,
        };
        payload = await createWechatDraft({
          accessToken,
          articlePayload,
          fetchImpl,
        });
      }
    } else {
      payload = await createWechatDraft({
        accessToken,
        articlePayload,
        fetchImpl,
      });
    }

    const resolvedMediaId = cleanText(payload.media_id || mediaId);
    return {
      draft: {
        status: 'draft_ready',
        mediaId: resolvedMediaId,
        templateId: preview.layout.templateId,
        draftTitle: preview.title,
        coverAssetId,
        draftUpdatedAt: new Date().toISOString(),
        warnings: preview.warnings,
      },
      metadata: preview.metadata,
      previewHtml: preview.previewHtml,
      warnings: preview.warnings,
    };
  });
};

export const getWechatOfficialDraft = async ({ mediaId, fetchImpl = fetch }) => {
  return runWithWechatCredentialRetry(async (forceRefresh) => {
    const accessToken = await getWechatAccessToken(fetchImpl, forceRefresh);
    const payload = await fetchWechatJson(
      `${WECHAT_API_ORIGIN}/cgi-bin/draft/get?access_token=${encodeURIComponent(accessToken)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ media_id: mediaId }),
      },
      'Get draft',
      fetchImpl
    );
    const article = Array.isArray(payload.news_item) ? payload.news_item[0] : payload.news_item?.[0] || payload.news_item || null;
    return {
      mediaId,
      article,
      updatedAt: new Date().toISOString(),
    };
  });
};

export const submitWechatOfficialPublish = async ({ mediaId, fetchImpl = fetch }) => {
  const config = buildWechatPublisherConfig();
  if (!config.publishEnabled) {
    throw new Error('WeChat publish is disabled by server configuration.');
  }
  return runWithWechatCredentialRetry(async (forceRefresh) => {
    const accessToken = await getWechatAccessToken(fetchImpl, forceRefresh);
    const payload = await fetchWechatJson(
      `${WECHAT_API_ORIGIN}/cgi-bin/freepublish/submit?access_token=${encodeURIComponent(accessToken)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ media_id: mediaId }),
      },
      'Submit publish',
      fetchImpl
    );
    return {
      publishId: cleanText(payload.publish_id),
      msgDataId: cleanText(payload.msg_data_id),
    };
  });
};

export const getWechatOfficialPublishStatus = async ({ publishId, fetchImpl = fetch }) => {
  return runWithWechatCredentialRetry(async (forceRefresh) => {
    const accessToken = await getWechatAccessToken(fetchImpl, forceRefresh);
    const payload = await fetchWechatJson(
      `${WECHAT_API_ORIGIN}/cgi-bin/freepublish/get?access_token=${encodeURIComponent(accessToken)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ publish_id: publishId }),
      },
      'Get publish status',
      fetchImpl
    );
    const articleUrl =
      cleanText(payload?.article_id || '') ||
      (Array.isArray(payload?.article_detail?.article_url)
        ? cleanText(payload.article_detail.article_url[0])
        : cleanText(payload?.article_detail?.article_url || ''));
    return {
      publishId,
      status: cleanText(payload.publish_status || payload.status || ''),
      articleUrl: articleUrl || undefined,
      payload,
    };
  });
};

export const __wechatPublisherTestUtils = {
  buildArticleBlocks,
  interleaveImageBlocks,
  normalizeWechatLayoutSettings,
  prepareWechatPreview,
  buildWechatPublisherConfig,
  compressImageForWechat,
  clearWechatAccessTokenCache,
};
