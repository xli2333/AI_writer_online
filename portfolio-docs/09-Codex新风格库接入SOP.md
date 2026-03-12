# Codex 新风格库接入 SOP

## 1. 适用范围

这份 SOP 只用于本仓库的新风格库接入，目标是把一个新的媒体语料源接成完整可用的 style profile，覆盖以下链路：

1. 原始语料导入
2. 文章分析与打标签
3. 主人格生成
4. rule cards / persona patch / eval 演化
5. 运行时主人格与子人格接入
6. 前后端可见、可选、可调用
7. 验收与回归

这份 SOP 不讨论抽象风格理论，只讨论仓库里的真实文件、真实脚本和真实验收口径。

## 2. 输入物要求

开始前，必须先准备以下输入：

1. 一个稳定的 profile id。
2. 一个明确的语料源目录。
3. 该风格库的人类可读名称、短名称、简介。
4. 可用的 Gemini API Key。
5. 明确要求使用的模型名。

推荐命名规则：

1. `profile id` 只用小写英文和连字符或纯小写英文，示例：`latepost`、`xinzhiyuan`、`huxiu`。
2. 原始语料目录建议放在仓库根目录，名称可以是中文，但导入后统一进入 `style_corpora/<profile>/raw_materials/`。
3. 运行时子人格文件名用英文，避免跨平台路径和编码问题。

## 3. 输出物清单

接入完成后，至少要有这些产物：

1. `config/styleProfiles.js` 新 profile 已注册。
2. `scripts/rag/import-<profile>-corpus.mjs` 可执行。
3. `style_corpora/<profile>/raw_materials/` 有导入结果。
4. `rag_assets/profiles/<profile>/metadata/article_tags.jsonl` 已生成。
5. `rag_assets/profiles/<profile>/global/runtime/master_persona.md` 已生成。
6. `rag_assets/profiles/<profile>/global/runtime/anti_patterns.md` 已存在。
7. `rag_assets/profiles/<profile>/global/runtime/subpersonas/*.md` 已存在。
8. 前端能看到新 profile。
9. 后端能返回 persona status、prompt assets、reference templates。
10. `npm run build` 通过。

## 4. 编码约束

所有新增中文 Markdown 和脚本文件都必须使用 UTF-8。

具体要求：

1. 优先使用 UTF-8 无 BOM。
2. 如果某些工具写入了 BOM，本仓库的 `readUtf8` 已处理常见 BOM，但不要依赖这个行为。
3. Windows 终端看到乱码，不代表文件本身编码错误，先用脚本按 `utf8` 读取再判断。
4. 文件名可以使用中文，但脚本里的关键路径名、资产名、子人格文件名建议使用英文。
5. 修改文件时优先用 `apply_patch`，避免终端重定向误写成本地默认编码。

定位编码问题时，优先做这三步：

1. 用 `node -e` 或内联 Node 脚本按 `utf8` 读取文件。
2. 检查是否混入了 `\r\n` 和 `\n` 的混合换行。
3. 检查是否被外部编辑器保存成 ANSI / GBK。

## 5. 必看接入点

新风格库接入时，先审这几个文件：

1. `config/styleProfiles.js`
2. `scripts/rag/shared.mjs`
3. `services/referenceTemplateService.ts`
4. `services/stylePersonaUtils.ts`
5. `services/backendContentService.ts`
6. `services/geminiService.ts`
7. `server/index.mjs`
8. `App.tsx`

职责划分：

1. `config/styleProfiles.js` 负责 profile 注册和目录映射。
2. `scripts/rag/import-*.mjs` 负责原始语料导入。
3. `scripts/rag/shared.mjs` 负责通用目录、通用模型配置、纯度计算。
4. `services/referenceTemplateService.ts` 负责参考模板检索与纯度过滤。
5. `services/stylePersonaUtils.ts` 负责运行时子人格路由。
6. `services/backendContentService.ts` 负责前端拉取 prompt assets。
7. `services/geminiService.ts` 负责把运行时资产注入真正的 system instruction。
8. `server/index.mjs` 负责把 profile 资产暴露给 API。
9. `App.tsx` 负责前端 fallback profile 展示。

## 6. 标准操作步骤

### 步骤 1：注册 profile

在 `config/styleProfiles.js` 新增一个 profile 对象，至少包含：

1. `id`
2. `label`
3. `shortLabel`
4. `description`
5. `rawDir`
6. `ragDir`
7. `globalDir`
8. `runtimeDir`
9. `metadataDir`
10. `summariesDir`
11. `personaDir`
12. `evalDir`
13. `benchmarkDir`

目录约定统一使用：

```text
style_corpora/<profile>/raw_materials
rag_assets/profiles/<profile>/global
rag_assets/profiles/<profile>/global/runtime
rag_assets/profiles/<profile>/metadata
rag_assets/profiles/<profile>/summaries/per_article
rag_assets/profiles/<profile>/persona
rag_assets/profiles/<profile>/evals
rag_assets/profiles/<profile>/evals/benchmark_tasks
```

### 步骤 2：新增导入脚本

新增 `scripts/rag/import-<profile>-corpus.mjs`。

推荐直接参考：

1. `scripts/rag/import-latepost-corpus.mjs`
2. `scripts/rag/import-xinzhiyuan-corpus.mjs`

导入脚本最低要求：

1. 校验 `ACTIVE_PROFILE_ID` 是否与目标 profile 一致。
2. 从原始目录扫描文章正文。
3. 忽略图片、附件等非正文文件。
4. 统一导入到 `style_corpora/<profile>/raw_materials/<year>/`。
5. 文件命名统一成 `<yyyy-mm-dd>_<title>.txt`。
6. 生成导入 manifest。
7. 生成导入 summary。
8. 复制通用 `workflows/*.md` 到新 profile。
9. 复制通用 `benchmark_tasks/*.md` 到新 profile。

建议同步在 `package.json` 增加：

```json
"rag:import-<profile>": "node scripts/rag/import-<profile>-corpus.mjs --profile <profile>"
```

### 步骤 3：建立运行时资产骨架

至少准备这些文件：

1. `rag_assets/profiles/<profile>/global/runtime/anti_patterns.md`
2. `rag_assets/profiles/<profile>/global/runtime/subpersonas/*.md`

注意：

1. `master_persona.md` 一般由脚本生成，不要手搓首版占位内容。
2. `anti_patterns.md` 和子人格文件通常需要手写。
3. 子人格不是自动 persona pipeline 的产物，而是运行时资产。

### 步骤 4：增加风格纯度规则

必须同时改两处：

1. `scripts/rag/shared.mjs`
2. `services/referenceTemplateService.ts`

原因：

1. `shared.mjs` 影响主人格、演化链路里的筛样。
2. `referenceTemplateService.ts` 影响运行时参考模板检索。

每个新 profile 至少要补：

1. `computeStylePurityScore / computeStylePurity`
2. `isStylePureEnough`
3. `boostScore`

如果这两处不保持同构，离线主人格和在线参考模板会“不是同一种风格”。

### 步骤 5：接入运行时子人格

必须同时改四处：

1. `services/stylePersonaUtils.ts`
2. `services/backendContentService.ts`
3. `services/geminiService.ts`
4. `server/index.mjs`

具体要求：

1. 在 `stylePersonaUtils.ts` 扩展 `RuntimeSubPersonaId`。
2. 在 `stylePersonaUtils.ts` 新增该 profile 的子人格 descriptor 列表。
3. 在 `resolveRuntimeSubPersona()` 里新增该 profile 的自动路由规则。
4. 在 `backendContentService.ts` 里增加对应 prompt asset 名称。
5. 在 `geminiService.ts` 里把这些资产写入 `runtimeSubPersonaAssets`。
6. 在 `server/index.mjs` 里把这些子人格文件暴露给 `/api/content/prompt-assets`。
7. 在 `server/index.mjs` 里把这些 descriptor 暴露给 `/api/content/persona-status`。

### 步骤 6：补前端 fallback profile

在 `App.tsx` 的 fallback profile 列表里补上新 profile。

原因：

1. 后端还没起来时，前端仍能展示入口。
2. 如果漏掉这一步，UI 可能表现得像 profile 没接入。

### 步骤 7：固定模型和 API Key

如果任务要求只能使用某一个 Gemini 模型，必须在执行脚本前显式设置环境变量，不要依赖默认值。

先做一次模型可用性探测：

```powershell
Invoke-WebRequest -Uri "https://generativelanguage.googleapis.com/v1/models?key=<YOUR_KEY>" -UseBasicParsing
```

只有当返回列表里真的存在该模型，并且支持 `generateContent`，才继续后面的 persona 生成链路。

推荐：

```powershell
$env:GEMINI_BUILD_MODEL='gemini-3-flash'
$env:GEMINI_MODEL='gemini-3-flash'
$env:GEMINI_API_KEYS='key1,key2,key3'
```

关键提醒：

1. `scripts/rag/analyze-articles.mjs` 会轮转 `GEMINI_API_KEYS`。
2. `build-master-persona.mjs`、`build-persona-patches.mjs`、`evaluate-persona.mjs` 默认走第一把 key。
3. `build-rule-cards.mjs` 和 `apply-persona-patch.mjs` 本身不调用模型。
4. 如果仓库默认模型不是你要求的模型，要么改默认值，要么每次命令前显式注入环境变量。
5. 如果目标模型名不在官方 `listModels` 返回中，必须立即停止并向用户确认，不要私自切换到 preview 或其他别名模型。

### 步骤 8：导入语料

执行：

```powershell
npm run rag:import-<profile>
```

导入完成后检查：

1. `style_corpora/<profile>/raw_materials/` 是否有文章。
2. `rag_assets/profiles/<profile>/metadata/*import_manifest.jsonl` 是否生成。
3. `rag_assets/profiles/<profile>/metadata/*import_summary.json` 是否生成。

### 步骤 9：先做最小模型验证

不要一上来就全量 analyze，先跑最小样本验证模型和 key：

```powershell
node scripts/rag/analyze-articles.mjs --profile <profile> --limit 1 --concurrency 1 --force
```

只要这里报模型不存在、鉴权失败、schema 失败，就先修环境，不要继续跑全量。

### 步骤 10：全量 analyze

最小验证通过后，再跑：

```powershell
node scripts/rag/analyze-articles.mjs --profile <profile> --concurrency 6
```

视 key 配额和机器稳定性调整并发。

Analyze 完成后检查：

1. `rag_assets/profiles/<profile>/summaries/per_article/*.summary.json`
2. `rag_assets/profiles/<profile>/metadata/article_tags.jsonl`
3. `rag_assets/profiles/<profile>/metadata/analyze_summary.json`

重点看：

1. 失败率是否可接受。
2. 标签字段是否足够区分该媒体的文章类型。
3. 是否明显把大量活动稿、软文、低价值稿放进了高纯度样本。

### 步骤 11：生成人格与演化资产

按顺序执行：

```powershell
node scripts/rag/build-master-persona.mjs --profile <profile>
node scripts/rag/build-rule-cards.mjs --profile <profile>
node scripts/rag/build-persona-patches.mjs --profile <profile>
node scripts/rag/evaluate-persona.mjs --profile <profile>
node scripts/rag/apply-persona-patch.mjs --profile <profile>
```

也可以直接跑总链路：

```powershell
node scripts/rag/run-evolution-cycle.mjs --profile <profile>
```

执行后重点检查：

1. `global/runtime/master_persona.md`
2. `global/runtime/master_persona.sources.json`
3. `persona/persona_patches.jsonl`
4. `evals/reports/latest.json`

### 步骤 12：运行时验收

至少验证这几个接口：

1. `/api/content/style-profiles`
2. `/api/content/prompt-assets?profile=<profile>`
3. `/api/content/persona-status?profile=<profile>`
4. `/api/reference-templates/catalog?profile=<profile>`
5. `/api/reference-templates/full-text`

至少验证这几个结果：

1. 新 profile 出现在 profile 列表中。
2. prompt assets 能返回主人格、反模式、子人格。
3. persona status 能返回版本、样本数、子人格列表。
4. reference template catalog 能返回该 profile 的语料条目。

### 步骤 13：构建验收

执行：

```powershell
npm run build
```

如果构建失败，先解决再视为接入完成。

## 7. 新风格库验收标准

满足以下条件，才算验收完成：

1. profile 已注册且前端可见。
2. 原始语料已导入到独立目录。
3. `article_tags.jsonl` 已生成。
4. `master_persona.md` 已生成。
5. `anti_patterns.md` 已存在。
6. 子人格资产已接入并能被 API 返回。
7. persona status 能返回样本数和版本信息。
8. reference templates 可检索、可读取全文。
9. `npm run build` 通过。
10. 不影响现有 profile。

## 8. 常见坑

### 坑 1：只接了主人格，没接子人格

后果：

1. 前端看起来 profile 已存在。
2. 运行时实际上没有分人格路由。
3. 文章写作会退化成单一主人格。

### 坑 2：只改了 `shared.mjs`，没改 `referenceTemplateService.ts`

后果：

1. 离线 persona 和在线参考模板筛样口径不一致。
2. 主人格像一种媒体，参考模板像另一种媒体。

### 坑 3：只改了后端，漏改 `App.tsx`

后果：

1. 后端没问题。
2. 前端 fallback 看不到新 profile。

### 坑 4：导入脚本没复制 workflows 和 benchmark

后果：

1. 后续脚本可能缺模板。
2. persona eval 无法完整跑通。

### 坑 5：没有显式固定模型名

后果：

1. 代码默认模型可能不是你要求的模型。
2. 同一批任务前后跑出了不同模型结果。

### 坑 6：把终端乱码当作文件编码错误

后果：

1. 误判文件本身。
2. 反复重写导致真正的编码破坏。

## 9. 复用时给 Codex 的最短指令模板

后续如果你要接一个新的风格库，可以直接把下面这段要求给 Codex：

```text
请严格按 portfolio-docs/09-Codex新风格库接入SOP.md 执行，把 <SOURCE_NAME> 接成新的 style profile：<PROFILE_ID>。
要求：
1. 只能使用 gemini-3-flash。
2. 先完成 profile 注册、import 脚本、纯度规则、运行时子人格接入。
3. 再执行 import -> analyze -> master persona -> rule cards -> patch -> eval -> apply。
4. 最后完成 API 验收和 npm run build。
5. 所有新增中文文件使用 UTF-8。
```

## 10. 本仓库当前事实

截至当前仓库版本，这套 SOP 已验证适用于：

1. `latepost`
2. `xinzhiyuan`
3. `huxiu`

后续如果再接第四套、第五套风格库，优先复用这份 SOP，而不是重新发明流程。
