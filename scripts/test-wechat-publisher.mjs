import assert from 'node:assert/strict';

process.env.WECHAT_OFFICIAL_APP_ID = 'wx-test-app-id';
process.env.WECHAT_OFFICIAL_APP_SECRET = 'wx-test-app-secret';
process.env.WECHAT_OFFICIAL_DEFAULT_AUTHOR = 'WeChat QA';
process.env.WECHAT_OFFICIAL_ENABLE_PUBLISH = '1';

const {
  __wechatPublisherTestUtils,
  generateWechatDraftPreview,
  getWechatOfficialDraft,
  getWechatOfficialPublishStatus,
  getWechatPublisherConfig,
  submitWechatOfficialPublish,
  upsertWechatOfficialDraft,
} = await import('../server/wechatOfficialPublisherService.mjs');

const tinyPngBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j3X8AAAAASUVORK5CYII=';
const tinyPngDataUrl = `data:image/png;base64,${tinyPngBase64}`;

const articleContent = `# AI 模型价格战的下一站

这一轮竞争已经不只是参数规模，而是落到了成本、调用门槛和分发效率。

平台方开始重新定义商业真相：同样一项能力，谁能更低价、更快交付，谁就会先拿到流量。

## 为什么成本变化最关键

当调用成本出现数量级差异，产品策略、渠道结构和客户心智都会被重写。

> 最后的胜负，往往不在功能列表，而在单位经济模型。

- 价格差异会改变 API 接入决策
- 价格差异会改变渠道分发策略

1. 先发生在开发者侧
2. 再传导到终端用户侧

| 指标 | 海外模型 | 国内模型 |
| --- | --- | --- |
| 推理成本 | $20-50/天 | ¥1-3/天 |
| 默认门槛 | 高 | 低 |

### 接下来的看点

下一阶段的竞争，会继续从模型能力延伸到平台效率、生态合作和默认分发位。`;

const illustrationBundle = {
  slots: [
    {
      id: 'slot-hero',
      order: 1,
      role: 'hero',
      title: '成本结构变化',
      anchorParagraphIndex: 0,
      explanation: '用首图承接全文的成本差异主题。',
      activeAssetId: 'asset-hero',
    },
    {
      id: 'slot-ops',
      order: 2,
      role: 'support',
      title: '平台分发变化',
      anchorParagraphIndex: 3,
      explanation: '补充平台侧的分发效率变化。',
      activeAssetId: 'asset-ops',
    },
  ],
  assets: [
    {
      id: 'asset-hero',
      slotId: 'slot-hero',
      url: tinyPngDataUrl,
      title: '成本结构变化',
      mimeType: 'image/png',
    },
    {
      id: 'asset-ops',
      slotId: 'slot-ops',
      url: tinyPngDataUrl,
      title: '平台分发变化',
      mimeType: 'image/png',
    },
  ],
  assetVersions: {
    'slot-hero': [
      {
        id: 'asset-hero',
        slotId: 'slot-hero',
        url: tinyPngDataUrl,
        title: '成本结构变化',
        mimeType: 'image/png',
        editorCaption: '单位成本差异正在重写平台分发逻辑。',
      },
    ],
    'slot-ops': [
      {
        id: 'asset-ops',
        slotId: 'slot-ops',
        url: tinyPngDataUrl,
        title: '平台分发变化',
        mimeType: 'image/png',
        editorCaption: '更低成本的一方会更早拿到默认分发位。',
      },
    ],
  },
};

const layout = {
  templateId: 'latepost_report',
  author: 'WeChat QA',
  digest: '',
  contentSourceUrl: 'https://example.com/source',
  coverStrategy: 'hero',
  needOpenComment: true,
  onlyFansCanComment: false,
};

const requestLog = [];
let inlineUploadCount = 0;

const jsonResponse = (payload, status = 200) =>
  new Response(JSON.stringify(payload), {
    status,
    headers: {
      'content-type': 'application/json',
    },
  });

const fetchMock = async (input, init = {}) => {
  const url = typeof input === 'string' ? input : input.url;
  const method = init.method || 'GET';
  requestLog.push({ url, method });

  const parsed = new URL(url);

  if (parsed.pathname === '/cgi-bin/stable_token') {
    return jsonResponse({
      access_token: 'mock-access-token',
      expires_in: 7200,
    });
  }

  if (parsed.pathname === '/cgi-bin/media/uploadimg') {
    inlineUploadCount += 1;
    return jsonResponse({
      url: `https://mmbiz.qpic.cn/mock-inline-${inlineUploadCount}.jpg`,
    });
  }

  if (parsed.pathname === '/cgi-bin/material/add_material') {
    return jsonResponse({
      media_id: 'mock-cover-media-id',
      url: 'https://mmbiz.qpic.cn/mock-cover.jpg',
    });
  }

  if (parsed.pathname === '/cgi-bin/draft/add') {
    return jsonResponse({
      media_id: 'mock-draft-media-id',
    });
  }

  if (parsed.pathname === '/cgi-bin/draft/update') {
    return jsonResponse({
      errcode: 0,
      errmsg: 'ok',
    });
  }

  if (parsed.pathname === '/cgi-bin/draft/get') {
    return jsonResponse({
      news_item: [
        {
          title: '远端公众号草稿',
          digest: '远端草稿摘要',
        },
      ],
    });
  }

  if (parsed.pathname === '/cgi-bin/freepublish/submit') {
    return jsonResponse({
      publish_id: 'mock-publish-id',
      msg_data_id: 'mock-msg-data-id',
    });
  }

  if (parsed.pathname === '/cgi-bin/freepublish/get') {
    return jsonResponse({
      publish_status: 'success',
      article_detail: {
        article_url: 'https://mp.weixin.qq.com/s/mock-article-url',
      },
    });
  }

  throw new Error(`Unexpected fetch: ${method} ${url}`);
};

const config = getWechatPublisherConfig();
assert.equal(config.configured, true);
assert.equal(config.defaultAuthor, 'WeChat QA');
assert.equal(config.publishEnabled, true);

const blocks = __wechatPublisherTestUtils.buildArticleBlocks(articleContent);
assert.ok(blocks.length >= 8, 'article blocks should be parsed');
const spacingAuditBlocks = __wechatPublisherTestUtils.buildArticleBlocks(
  '\u0032\u0030\u0032\u0033 \u5e74\uff0c\u4e2d\u56fd App Store \u4fc3\u6210\u7684 \u0033\u002e\u0037\u0036 \u4e07\u4ebf\u5143\u4ea4\u6613\u989d\u4e2d\uff0c\u957f\u671f\u5b58\u5728\u4e8e\u89c6\u9891\u4f1a\u5458\u3001\u7f51\u6e38\u5145\u503c\u4e2d\u7684 iOS \u6ea2\u4ef7\uff08\u901a\u5e38\u6bd4\u5b89\u5353\u7aef\u9ad8\u51fa \u0032\u0030% \u81f3 \u0033\u0030%\uff09\u5c06\u88ab\u62b9\u5e73\uff0c\u666e\u901a\u6d88\u8d39\u8005\u5c06\u76f4\u63a5\u4eab\u53d7\u5230\u7ea6 \u0031\u0030 \u4ebf\u5143\u7684\u964d\u4ef7\u7ea2\u5229\u3002'
);
assert.equal(
  spacingAuditBlocks[0]?.text,
  '\u0032\u0030\u0032\u0033\u5e74\uff0c\u4e2d\u56fdApp Store\u4fc3\u6210\u7684\u0033\u002e\u0037\u0036\u4e07\u4ebf\u5143\u4ea4\u6613\u989d\u4e2d\uff0c\u957f\u671f\u5b58\u5728\u4e8e\u89c6\u9891\u4f1a\u5458\u3001\u7f51\u6e38\u5145\u503c\u4e2d\u7684iOS\u6ea2\u4ef7\uff08\u901a\u5e38\u6bd4\u5b89\u5353\u7aef\u9ad8\u51fa\u0032\u0030%\u81f3\u0033\u0030%\uff09\u5c06\u88ab\u62b9\u5e73\uff0c\u666e\u901a\u6d88\u8d39\u8005\u5c06\u76f4\u63a5\u4eab\u53d7\u5230\u7ea6\u0031\u0030\u4ebf\u5143\u7684\u964d\u4ef7\u7ea2\u5229\u3002',
  'format audit should remove extra spaces around Chinese-number and Chinese-English boundaries while preserving spaces inside English phrases'
);

const preview = await generateWechatDraftPreview({
  topic: 'AI 模型价格战的下一站',
  articleContent,
  illustrationBundle,
  layout,
});

assert.equal(preview.metadata.templateId, 'latepost_report');
assert.equal(preview.metadata.rendererVersion, 'beauty_plan_v5');
assert.equal(preview.metadata.imageCount, 2);
assert.equal(preview.metadata.author, 'WeChat QA');
assert.ok(preview.metadata.blockCount >= 8, 'preview should include parsed blocks');
assert.match(preview.previewHtml, /AI模型价格战的下一站/);
assert.match(preview.previewHtml, /单位成本差异正在重写平台分发逻辑/);
assert.ok(preview.renderPlan, 'preview should return a reusable render plan');
assert.ok(preview.metadata.renderPlan, 'preview metadata should include render plan details');
assert.equal(preview.metadata.beautyAgent?.used, false);
assert.ok(preview.renderPlan?.beautyAgent?.planHash, 'render plan should carry a stable hash');
assert.doesNotMatch(preview.previewHtml, /<h1\b/i, 'wechat body should no longer render a standalone main title');
assert.doesNotMatch(preview.previewHtml, /Summary|Focus|Lead \/|\/ note/i, 'opening highlight should not render helper labels');

const themedExpectations = {
  bauhaus: { creditsVariant: 'stacked_editorial', headingVariants: ['offset_block', 'double_rule'] },
  knowledge_base: { creditsVariant: 'rule_meta', headingVariants: ['double_rule', 'overline'] },
  morandi_forest: { creditsVariant: 'minimal_labels', headingVariants: ['underline', 'overline'] },
  neo_brutalism: { creditsVariant: 'brutal_meta', headingVariants: ['number_badge', 'offset_block'] },
  receipt: { creditsVariant: 'ledger_meta', headingVariants: ['ledger_rule', 'plain'] },
  sunset_film: { creditsVariant: 'film_meta', headingVariants: ['cinema_caption', 'overline'] },
  capital_review: { creditsVariant: 'executive_meta', headingVariants: ['executive_rule', 'underline'] },
};

for (const [templateId, expectation] of Object.entries(themedExpectations)) {
  const themedPreview = await generateWechatDraftPreview({
    topic: 'AI pricing war next stage',
    articleContent,
    illustrationBundle,
    layout: {
      ...layout,
      templateId,
    },
  });

  assert.equal(themedPreview.metadata.templateId, templateId);
  assert.equal(themedPreview.renderPlan.creditsVariant, expectation.creditsVariant);
  assert.ok(
    themedPreview.renderPlan.headingStyles.length > 0,
    `heading styles should exist for ${templateId}`
  );
  for (const headingVariant of expectation.headingVariants) {
    assert.ok(
      themedPreview.renderPlan.headingStyles.some((item) => item.variant === headingVariant),
      `heading system should include ${headingVariant} for ${templateId}`
    );
  }
  assert.ok(
    themedPreview.previewHtml.length > 0,
    `preview html should be generated for ${templateId}`
  );
  if (templateId === 'receipt') {
    assert.doesNotMatch(
      themedPreview.previewHtml,
      /background: #111111; color: #222222;/,
      'receipt image captions should not render dark text on a dark caption band'
    );
  }
}

const explicitRenderPlanPreview = await generateWechatDraftPreview({
  topic: 'AI 模型价格战的下一站',
  articleContent,
  illustrationBundle,
  layout,
  renderPlan: {
    creditsVariant: 'minimal_labels',
    headingStyles: [
      { blockIndex: 3, variant: 'red_bar' },
      { blockIndex: 10, variant: 'underline' },
    ],
    paragraphStyles: [
      { blockIndex: 0, variant: 'lead' },
      { blockIndex: 11, variant: 'closing' },
    ],
    quoteStyles: [{ blockIndex: 5, variant: 'plain_quote' }],
    listStyles: [
      { blockIndex: 7, variant: 'bullet_brief' },
      { blockIndex: 8, variant: 'numbered_steps' },
    ],
    tableStyles: [{ blockIndex: 9, variant: 'compact_grid' }],
    imageStyles: [
      { blockIndex: 1, variant: 'full_bleed' },
      { blockIndex: 6, variant: 'editorial_card' },
    ],
    highlightSentences: [
      {
        blockIndex: 2,
        text: '同样一项能力，谁能更低价、更快交付，谁就会先拿到流量。',
        variant: 'marker',
      },
    ],
    dividerAfterBlocks: [5],
    beautyAgent: { used: false },
  },
});
assert.match(explicitRenderPlanPreview.previewHtml, /同样一项能力，谁能更低价、更快交付/);
assert.equal(explicitRenderPlanPreview.metadata.blockCount, preview.metadata.blockCount);

const compressedInline = await __wechatPublisherTestUtils.compressImageForWechat({
  buffer: Buffer.from(tinyPngBase64, 'base64'),
  kind: 'inline',
});
assert.equal(compressedInline.mimeType, 'image/jpeg');
assert.ok(compressedInline.byteLength > 0);
assert.ok(compressedInline.byteLength < 950 * 1024);

const createdDraft = await upsertWechatOfficialDraft({
  topic: 'AI 模型价格战的下一站',
  articleContent,
  illustrationBundle,
  layout,
  renderPlan: preview.renderPlan,
  fetchImpl: fetchMock,
});

assert.equal(createdDraft.draft.status, 'draft_ready');
assert.equal(createdDraft.draft.mediaId, 'mock-draft-media-id');
assert.equal(createdDraft.draft.templateId, 'latepost_report');
assert.equal(createdDraft.metadata.coverAssetId, 'asset-hero');
assert.equal(createdDraft.metadata.renderPlan?.beautyAgent?.planHash, preview.renderPlan?.beautyAgent?.planHash);

const updatedDraft = await upsertWechatOfficialDraft({
  topic: 'AI 模型价格战的下一站',
  articleContent,
  illustrationBundle,
  layout: {
    ...layout,
    templateId: 'insight_brief',
  },
  mediaId: 'mock-draft-media-id',
  fetchImpl: fetchMock,
});

assert.equal(updatedDraft.draft.mediaId, 'mock-draft-media-id');
assert.equal(updatedDraft.draft.templateId, 'insight_brief');

const fallbackRequestLog = [];
let fallbackInlineUploadCount = 0;

const fallbackFetchMock = async (input, init = {}) => {
  const url = typeof input === 'string' ? input : input.url;
  const method = init.method || 'GET';
  fallbackRequestLog.push({ url, method });
  const parsed = new URL(url);

  if (parsed.pathname === '/cgi-bin/stable_token') {
    return jsonResponse({
      access_token: 'mock-access-token-fallback',
      expires_in: 7200,
    });
  }

  if (parsed.pathname === '/cgi-bin/media/uploadimg') {
    fallbackInlineUploadCount += 1;
    return jsonResponse({
      url: `https://mmbiz.qpic.cn/mock-inline-fallback-${fallbackInlineUploadCount}.jpg`,
    });
  }

  if (parsed.pathname === '/cgi-bin/material/add_material') {
    return jsonResponse({
      media_id: 'mock-cover-media-id-fallback',
      url: 'https://mmbiz.qpic.cn/mock-cover-fallback.jpg',
    });
  }

  if (parsed.pathname === '/cgi-bin/draft/update') {
    return jsonResponse({
      errcode: 40007,
      errmsg: 'invalid media_id hint: [Mdrlfa081078-0] rid: fallback-rid',
    });
  }

  if (parsed.pathname === '/cgi-bin/draft/add') {
    return jsonResponse({
      media_id: 'mock-draft-media-id-fallback',
    });
  }

  throw new Error(`Unexpected fallback fetch: ${method} ${url}`);
};

__wechatPublisherTestUtils.clearWechatAccessTokenCache();

const fallbackDraft = await upsertWechatOfficialDraft({
  topic: 'AI pricing war next stage',
  articleContent,
  illustrationBundle,
  layout,
  mediaId: 'stale-draft-media-id',
  fetchImpl: fallbackFetchMock,
});

assert.equal(fallbackDraft.draft.mediaId, 'mock-draft-media-id-fallback');
assert.ok(
  (fallbackDraft.warnings || []).some(
    (warning) =>
      warning.includes('stale-draft-media-id') && warning.includes('Created a new draft automatically.')
  ),
  'fallback should surface a warning about recreating the draft'
);
assert.equal(fallbackRequestLog.filter((entry) => entry.url.includes('/cgi-bin/draft/update')).length, 1);
assert.equal(fallbackRequestLog.filter((entry) => entry.url.includes('/cgi-bin/draft/add')).length, 1);

const remoteDraft = await getWechatOfficialDraft({
  mediaId: 'mock-draft-media-id',
  fetchImpl: fetchMock,
});

assert.equal(remoteDraft.mediaId, 'mock-draft-media-id');
assert.equal(remoteDraft.article?.title, '远端公众号草稿');

const publishJob = await submitWechatOfficialPublish({
  mediaId: 'mock-draft-media-id',
  fetchImpl: fetchMock,
});

assert.equal(publishJob.publishId, 'mock-publish-id');
assert.equal(publishJob.msgDataId, 'mock-msg-data-id');

const publishStatus = await getWechatOfficialPublishStatus({
  publishId: 'mock-publish-id',
  fetchImpl: fetchMock,
});

assert.equal(publishStatus.publishId, 'mock-publish-id');
assert.equal(publishStatus.status, 'success');
assert.equal(publishStatus.articleUrl, 'https://mp.weixin.qq.com/s/mock-article-url');

__wechatPublisherTestUtils.clearWechatAccessTokenCache();

const retryRequestLog = [];
let retryTokenCount = 0;
let retryInlineFailureSent = false;

const retryFetchMock = async (input, init = {}) => {
  const url = typeof input === 'string' ? input : input.url;
  const method = init.method || 'GET';
  retryRequestLog.push({ url, method });
  const parsed = new URL(url);

  if (parsed.pathname === '/cgi-bin/stable_token') {
    retryTokenCount += 1;
    const body = JSON.parse(String(init.body || '{}'));
    const isForceRefresh = Boolean(body.force_refresh);
    return jsonResponse({
      access_token: isForceRefresh ? 'mock-access-token-refreshed' : 'mock-access-token-stale',
      expires_in: 7200,
    });
  }

  if (parsed.pathname === '/cgi-bin/media/uploadimg') {
    if (!retryInlineFailureSent) {
      retryInlineFailureSent = true;
      return jsonResponse({
        errcode: 40001,
        errmsg:
          'invalid credential, access_token is invalid or not latest, could get access_token by getStableAccessToken',
      });
    }
    return jsonResponse({
      url: 'https://mmbiz.qpic.cn/mock-inline-retry.jpg',
    });
  }

  if (parsed.pathname === '/cgi-bin/material/add_material') {
    return jsonResponse({
      media_id: 'mock-cover-media-id-retry',
      url: 'https://mmbiz.qpic.cn/mock-cover-retry.jpg',
    });
  }

  if (parsed.pathname === '/cgi-bin/draft/add') {
    return jsonResponse({
      media_id: 'mock-draft-media-id-retry',
    });
  }

  throw new Error(`Unexpected retry fetch: ${method} ${url}`);
};

const retriedDraft = await upsertWechatOfficialDraft({
  topic: 'AI pricing war next stage',
  articleContent,
  illustrationBundle,
  layout,
  fetchImpl: retryFetchMock,
});

assert.equal(retriedDraft.draft.mediaId, 'mock-draft-media-id-retry');
assert.equal(retryTokenCount, 2);
assert.equal(
  retryRequestLog.filter((entry) => entry.url.includes('/cgi-bin/stable_token')).length,
  2
);

assert.equal(requestLog.filter((entry) => entry.url.includes('/cgi-bin/media/uploadimg')).length, 4);
assert.equal(requestLog.filter((entry) => entry.url.includes('/cgi-bin/material/add_material')).length, 2);
assert.equal(requestLog.filter((entry) => entry.url.includes('/cgi-bin/draft/add')).length, 1);
assert.equal(requestLog.filter((entry) => entry.url.includes('/cgi-bin/draft/update')).length, 1);
assert.equal(requestLog.filter((entry) => entry.url.includes('/cgi-bin/freepublish/submit')).length, 1);
assert.equal(requestLog.filter((entry) => entry.url.includes('/cgi-bin/freepublish/get')).length, 1);
assert.equal(requestLog.filter((entry) => entry.url.includes('/cgi-bin/stable_token')).length, 1);

console.log('WeChat publisher tests passed.');
