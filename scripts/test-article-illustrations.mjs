import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';

const PORT = 18000 + Math.floor(Math.random() * 4000);
const BASE_URL = `http://127.0.0.1:${PORT}`;

const sampleArticle = `
# 一家机器人公司的组织转向

过去两年，这家公司把重心从单点产品销售转向系统交付。2023 年机器人业务收入为 12 亿元，2024 年增长到 18 亿元，服务收入占比也从 18% 提升到 33%。

## 为什么转向

管理层发现，单纯卖设备只能带来一次性收入，而系统交付和长期运维才能建立更稳的客户关系。创始人与 COO 在多次内部会议里都强调，真正的护城河不是硬件本身，而是部署、培训和数据闭环。

## 关键案例

在华东一家大型制造企业的项目里，公司不再只交付机械臂，而是把仓储、调度、质检和售后一起打包。这个案例让单客户年合同额从 800 万提高到 2600 万，也把实施周期从 9 个月缩短到 6 个月。

## 组织变化

为了承接这种变化，公司把原来的产品、销售、交付三条线改成行业战队制。新的组织里，行业负责人直接协调方案、销售、交付和客户成功，避免信息层层回传。

## 行业影响

这件事的意义不只是收入结构变化。它意味着机器人公司正在从卖设备，转向卖解决方案和持续服务。对于整个行业来说，竞争会从参数和价格，转向实施能力、组织效率和客户留存。
`.trim();

const waitForServer = async () => {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      const response = await fetch(`${BASE_URL}/api/health`);
      if (response.ok) {
        return;
      }
    } catch {
      // ignore
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error('Server did not become ready in time.');
};

const run = async () => {
  const child = spawn('node', ['server/index.mjs'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      BACKEND_PORT: String(PORT),
      ILLUSTRATION_PROVIDER: 'mock',
    },
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });

  try {
    await waitForServer();

    const response = await fetch(`${BASE_URL}/api/article-illustrations/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        apiKey: 'mock-key',
        styleProfile: 'fdsm',
        topic: '一家机器人公司的组织转向',
        articleContent: sampleArticle,
        options: {
          styleProfile: 'fdsm',
          genre: '商业分析',
          style: '理性克制',
          audience: '企业管理者',
          articleGoal: '解释问题，形成判断，并给出启发。',
        },
        regenerate: true,
      }),
    });

    assert.equal(response.status, 200, 'illustration generation endpoint should return 200');
    const payload = await response.json();
    assert.ok(payload.bundle, 'response should include bundle');
    assert.ok(Array.isArray(payload.bundle.assets), 'bundle should include assets');
    assert.equal(payload.bundle.assets.length, payload.bundle.targetImageCount, 'asset count should match target count');
    assert.ok(payload.bundle.assets[0].url.startsWith('/generated-assets/illustrations/'), 'asset URL should be served from backend');
    assert.ok(
      payload.bundle.assets.every((asset) => !String(asset.mimeType || '').includes('svg') && asset.renderMode !== 'svg_chart'),
      'all generated illustrations should be raster images'
    );
    assert.ok(
      payload.bundle.slots.every(
        (slot) =>
          typeof slot.explanation === 'string' &&
          slot.explanation.trim() &&
          !slot.explanation.includes('这张图用于') &&
          !slot.explanation.includes('首图')
      ),
      'every slot should have a reader-facing caption'
    );

    const assetResponse = await fetch(`${BASE_URL}${payload.bundle.assets[0].url}`);
    assert.equal(assetResponse.status, 200, 'generated asset should be reachable');
    assert.match(String(assetResponse.headers.get('content-type') || ''), /^image\//, 'generated asset should be image-like');

    const firstSlot = payload.bundle.slots[0];
    const regenerateResponse = await fetch(`${BASE_URL}/api/article-illustrations/regenerate-slot`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        apiKey: 'mock-key',
        sourceHash: payload.bundle.sourceHash,
        slotId: firstSlot.id,
        articleContent: sampleArticle,
        userPrompt: '更强调供应链和物流，不要把注意力放在广告感门头上',
      }),
    });

    assert.equal(regenerateResponse.status, 200, 'slot regenerate endpoint should return 200');
    const regeneratedPayload = await regenerateResponse.json();
    const regeneratedVersions = regeneratedPayload.bundle.assetVersions[firstSlot.id] || [];
    assert.equal(regeneratedVersions.length, 2, 'slot regenerate should append a new version');
    assert.ok(
      regeneratedPayload.bundle.assets.every(
        (asset) => !String(asset.mimeType || '').includes('svg') && asset.renderMode !== 'svg_chart'
      ),
      'regenerated bundle should still contain only raster images'
    );

    const { readFile, writeFile } = await import('node:fs/promises');
    const { join } = await import('node:path');
    const manifestPath = join(process.cwd(), 'generated_assets', 'illustrations', payload.bundle.sourceHash, 'manifest.json');
    const rawManifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    rawManifest.promptVersion = 'illustration-v1';
    if (Array.isArray(rawManifest.assets) && rawManifest.assets[0]) {
      rawManifest.assets[0].renderMode = 'svg_chart';
      rawManifest.assets[0].mimeType = 'image/svg+xml';
    }
    if (Array.isArray(rawManifest.slots) && rawManifest.slots[0]) {
      rawManifest.slots[0].renderMode = 'svg_chart';
      rawManifest.slots[0].explanation = '';
    }
    delete rawManifest.assetVersions;
    await writeFile(manifestPath, `${JSON.stringify(rawManifest, null, 2)}\n`, 'utf8');

    const upgradeResponse = await fetch(`${BASE_URL}/api/article-illustrations/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        apiKey: 'mock-key',
        styleProfile: 'fdsm',
        topic: '一家机器人公司的组织转向',
        articleContent: sampleArticle,
        options: {
          styleProfile: 'fdsm',
          genre: '商业分析',
          style: '理性克制',
          audience: '企业管理者',
          articleGoal: '解释问题，形成判断，并给出启发。',
        },
        regenerate: false,
      }),
    });

    assert.equal(upgradeResponse.status, 200, 'bundle upgrade request should return 200');
    const upgradedPayload = await upgradeResponse.json();
    assert.equal(upgradedPayload.bundle.promptVersion, 'illustration-v3', 'legacy bundle should be upgraded');
    assert.ok(
      upgradedPayload.bundle.assets.every(
        (asset) => !String(asset.mimeType || '').includes('svg') && asset.renderMode !== 'svg_chart'
      ),
      'upgraded bundle should not contain svg illustrations'
    );
  } finally {
    child.kill();
  }
};

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
