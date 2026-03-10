# AI Writer 完整工作流详解

> 本文档详细盘点 AI Writer 系统从用户输入到最终输出的全流程，包括每个阶段加载的文件、使用的 Prompt 全文、实现的功能及其技术实现方式。

---

## 目录

1. [系统架构总览](#1-系统架构总览)
2. [启动与初始化阶段](#2-启动与初始化阶段)
3. [阶段一：用户输入与任务配置](#3-阶段一用户输入与任务配置)
4. [阶段二：运行时资产加载](#4-阶段二运行时资产加载)
5. [阶段三：信息研究（Research）](#5-阶段三信息研究research)
6. [阶段四：讨论方向生成](#6-阶段四讨论方向生成)
7. [阶段五：文章大纲生成](#7-阶段五文章大纲生成)
8. [阶段六：参考模板匹配与装载](#8-阶段六参考模板匹配与装载)
9. [阶段七：写作方法提炼（Writing Insights）](#9-阶段七写作方法提炼writing-insights)
10. [阶段八：证据卡整理（Evidence Cards）](#10-阶段八证据卡整理evidence-cards)
11. [阶段九：分段写作规划（Chunk Plan）](#11-阶段九分段写作规划chunk-plan)
12. [阶段十：分段正文写作（Chunk Writing）](#12-阶段十分段正文写作chunk-writing)
13. [阶段十一：终稿结构缝合（Assembly）](#13-阶段十一终稿结构缝合assembly)
14. [阶段十二：杂志级终审循环（Editorial Review）](#14-阶段十二杂志级终审循环editorial-review)
15. [阶段十三：商业稿去AI化（Commercial Humanizer）](#15-阶段十三商业稿去ai化commercial-humanizer)
16. [阶段十四：句级终修（Final Polish）](#16-阶段十四句级终修final-polish)
17. [阶段十五：TN 教学指南生成](#17-阶段十五tn-教学指南生成)
18. [辅助功能：Copilot 对话、选区精修、整稿精修](#18-辅助功能)
19. [系统指令构建机制详解](#19-系统指令构建机制详解)
20. [本地风格检查（Lint Style）](#20-本地风格检查lint-style)
21. [完整文件依赖关系图](#21-完整文件依赖关系图)

---

## 1. 系统架构总览

AI Writer 是一个基于 **Gemini API** 的中文商业文章全自动写作系统，采用前后端分离架构：

| 层级 | 技术 | 核心文件 |
|------|------|----------|
| 前端 UI | React + TypeScript + Vite | `App.tsx`、`components/*.tsx` |
| 核心服务 | TypeScript（浏览器端） | `services/geminiService.ts`（4148行） |
| 后端服务 | Node.js HTTP Server | `server/index.mjs` |
| 提示词资产 | Markdown 文件 | `rag_assets/` 目录 |
| 风格配置 | JavaScript | `config/styleProfiles.js` |

### 核心工作流阶段（共 15 个）

```
用户输入 → 资产加载 → 信息研究(3轨道+DeepResearch)
  → 讨论方向 → 大纲 → 参考模板匹配
  → Writing Insights → Evidence Cards → Chunk Plan
  → 分段写作 → 终稿缝合 → 终审循环(最多3轮)
  → 去AI化(诊断+修订+复检) → 句级终修 → TN生成
```

### 涉及的模型

| 用途 | 默认模型 |
|------|----------|
| 研究/搜索 | `gemini-3.1-flash-lite` |
| 生成/写作 | `gemini-3.1-pro-preview` |
| Deep Research | `deep-research-pro-preview-12-2025` |

---

## 2. 启动与初始化阶段

### 2.1 后端启动

**文件**：`server/index.mjs`

后端是一个纯 Node.js HTTP 服务器（无框架），监听 `127.0.0.1:8787`，提供以下 API：

| 路由 | 方法 | 功能 |
|------|------|------|
| `/api/health` | GET | 健康检查 |
| `/api/content/prompt-assets` | GET | 加载运行时 Prompt 资产 |
| `/api/content/style-profiles` | GET | 返回可用风格库列表 |
| `/api/content/persona-status` | GET | 返回 Persona 状态信息 |
| `/api/reference-templates/catalog` | GET | 返回参考模板文章目录 |
| `/api/reference-templates/full-text` | POST | 返回指定文章全文 |

### 2.2 风格库配置

**文件**：`config/styleProfiles.js`

系统内置两个风格库：

```javascript
// 风格库 1：复旦商业文章（默认）
{
  id: 'fdsm',
  label: '复旦商业文章',
  description: '偏管理学、商业分析、学术转译与案例拆解的中文商业写作风格。',
  rawDir: 'raw_materials',
  ragDir: 'rag_assets',
  runtimeDir: 'rag_assets/global/runtime',
  metadataDir: 'rag_assets/metadata',
  // ...
}

// 风格库 2：晚点 LatePost
{
  id: 'latepost',
  label: '晚点 LatePost',
  description: '偏商业报道、公司观察、独家信息与人物/组织叙事的中文商业写作风格。',
  rawDir: 'style_corpora/latepost/raw_materials',
  ragDir: 'rag_assets/profiles/latepost',
  runtimeDir: 'rag_assets/profiles/latepost/global/runtime',
  // ...
}
```

### 2.3 前端加载的静态 Prompt 资产

**文件**：`services/promptAssets.ts`

前端通过 Vite 的 `?raw` 导入，在构建时将以下 4 个 MD 文件打包到前端 bundle 中：

```typescript
import coreWritingSkillsRaw from '../rag_assets/global/core_writing_skills.md?raw';
import universalPromptRaw from '../rag_assets/global/universal_prompt.md?raw';
import workflowRaw from '../rag_assets/workflows/ai_writing_workflow.md?raw';
import taskBriefTemplateRaw from '../rag_assets/workflows/task_brief_template.md?raw';
```

| 文件 | 路径 | 大小 | 用途 |
|------|------|------|------|
| 核心写作总纲 | `rag_assets/global/core_writing_skills.md` | 16KB | 全局写作方法论 |
| 通用写作提示 | `rag_assets/global/universal_prompt.md` | 1.4KB | 写作时的通用约束 |
| AI写作工作流 | `rag_assets/workflows/ai_writing_workflow.md` | 15.8KB | 工作流说明文档 |
| 任务卡模板 | `rag_assets/workflows/task_brief_template.md` | 204B | 写作任务卡格式 |

---

## 3. 阶段一：用户输入与任务配置

### 3.1 用户需要提供的信息

用户通过前端界面输入以下信息（对应 `WritingTaskOptions` 类型）：

```typescript
interface WritingTaskOptions {
  styleProfile: string;      // 风格库：'fdsm' 或 'latepost'
  genre: string;             // 文体：如"案例分析""趋势解读"
  style: string;             // 风格：如"理性分析""洞察型"
  audience: string;          // 目标受众：如"企业管理者"
  articleGoal: string;       // 文章目标：如"解释趋势并给出判断"
  desiredLength: number;     // 目标字数
  chunkLength: number;       // 单轮写作长度（默认1500字）
  includeTeachingNotes: boolean;  // 是否生成 TN
  enableDeepResearch: boolean;    // 是否启用 Deep Research
  deepResearchPrompt: string;     // Deep Research 补充要求
}
```

此外还需输入：
- **写作主题**（topic）：如"AI 医疗行业的发展趋势"
- **上传文件**（可选）：支持文本和二进制文件

### 3.2 任务简报构建函数

**函数**：`buildTaskBrief(topic, direction, options)` — 在 `geminiService.ts` 第 646-664 行

此函数将用户输入组装成一段结构化简报，后续所有 Prompt 都会引用它：

```
写作主题：{topic}
讨论方向：{direction}
风格库：{styleProfile}
文体：{genre}
风格：{style}
目标受众：{audience}
文章目标：{articleGoal}
目标字数：约 {desiredLength} 字
单轮写作长度：约 {chunkLength} 字
是否生成 TN：是/否
是否启用 Deep Research：是/否
```

---

## 4. 阶段二：运行时资产加载

### 4.1 加载流程

**函数**：`ensureRuntimePromptAssets(profile)` — `geminiService.ts` 第 229-241 行

在每个写作阶段开始时，系统通过后端 API `/api/content/prompt-assets` 加载运行时 Prompt 资产。

### 4.2 后端加载的运行时 MD 文件

**文件**：`server/index.mjs` 第 13-20 行，第 58-76 行

后端从磁盘读取以下 MD 文件并返回给前端：

| 资产名 | 文件路径 | 用途 |
|--------|----------|------|
| `masterPersona` | `rag_assets/global/runtime/master_persona.md` | 主人格定义 |
| `antiAiStyleRules` | `rag_assets/global/runtime/anti_ai_style_rules.md` | 反AI文风规则 |
| `commercialHumanizerRules` | `rag_assets/global/runtime/commercial_humanizer_rules.md` | 去AI化护栏 |
| `commercialHumanizerPatterns` | `rag_assets/global/runtime/commercial_humanizer_patterns.md` | 去AI化检查维度 |
| `commercialHumanizerQuickChecks` | `rag_assets/global/runtime/commercial_humanizer_quick_checks.md` | 去AI化快速检查 |
| `profileAntiPatterns` | `rag_assets/global/runtime/anti_patterns.md` | 风格库反模式 |

**LatePost 风格库额外加载**（4个子人格）：

| 资产名 | 文件路径 | 用途 |
|--------|----------|------|
| `latepostNewsPersona` | `.../subpersonas/news.md` | 快讯与组织变动人格 |
| `latepostFeaturePersona` | `.../subpersonas/feature.md` | 公司深描人格 |
| `latepostProfilePersona` | `.../subpersonas/profile.md` | 人物与公司人格 |
| `latepostIndustryReviewPersona` | `.../subpersonas/industry_review.md` | 行业复盘人格 |

### 4.3 Master Persona 全文

**文件**：`rag_assets/global/runtime/master_persona.md`

```markdown
# 商业中文深度写作系统 Master Persona

## 1. 身份与目标 (Identity & Goals)

**身份定位：**
你是一位拥有全球视野的商业智库总主笔，兼具顶级管理咨询顾问的逻辑感与资深财经记者的叙事力。你不仅是在"写文章"，而是在为企业高管和决策者提供"认知增量"和"决策参考"。

**核心目标：**
- **重塑认知：** 穿透表象，拆解商业底层逻辑。
- **跨界链接：** 擅长将社会学、生物学、哲学、物理学等学科的第一性原理引入商业分析。
- **实战导向：** 将抽象的管理理论转化为可落地的方法论提炼。

## 2. AI 行为纪律

- **拒绝空洞：** 禁止使用"在这个飞速发展的时代"、"众所周知"、"综上所述"等AI常用废话。
- **智力对等：** 假设读者是CEO、投资人或资深学者。不要定义基础概念，要探讨复杂变量。
- **证据至上：** 观点必须锚定在"三维证据"上：具体的企业案例、行业统计数据、权威专家引言。
- **结构先行：** 在动笔前必须构建逻辑框架。
- **克制抒情：** 保持理性且客观的第三方观察视角。

## 3-5. （任务理解、文章理解、输出门槛等）
```

### 4.4 反AI文风规则全文

**文件**：`rag_assets/global/runtime/anti_ai_style_rules.md`

```
去 AI 化不等于口语化或随笔化，商业文章仍然保持客观、分析型、克制。
正文默认使用自然段推进，不把 1. 2. 3. 这种列表直接写进正文，除非本来就在写表格或附录。
避免"不是……而是……""换句话说""更重要的是""说到底"等明显 AI 连接句。
普通概念不要乱加引号，只有原话、专有名词、书名或论文名才用引号。
不要写夸张比喻、拟人化修辞、故作姿态的句子，语气保持克制、结实、自然。
段落靠事实和论证自然推进，不靠口号式转折和空泛抽象词撑场面。
少用"赋能""闭环""抓手""底层逻辑""范式迁移"等万能商业黑话，优先写具体动作和判断。
不要因为追求"像人"就插入第一人称抒情、聊天腔、网络梗或故意制造凌乱。
结尾不要做万能积极收束，回到文中已经建立的判断即可。
```

---

## 5. 阶段三：信息研究（Research）

### 5.1 功能说明

**函数**：`gatherInformation()` — `geminiService.ts` 第 2299-2381 行

系统自动执行 **3条并行研究轨道** + 可选的 **Deep Research**，使用 Gemini Google Search 工具实时搜索互联网信息。

### 5.2 三条研究轨道

| 轨道 | ID | 搜索重点 |
|------|----|----------|
| 综合研究 | `general` | 覆盖事件背景、时间线、关键主体、公开动作、争议点与基础事实 |
| 量化研究 | `quant` | 优先搜集财务数据、业务指标、市场份额、投融资、估值、销量 |
| 人文研究 | `human` | 优先搜集人物履历、公开表态、组织变化、舆论反应、媒体叙事 |

### 5.3 每条研究轨道的 Prompt 全文

**函数**：`generateResearchTrack()` — 第 2214-2256 行

**System Instruction**：
```
你是{track}资料员。先搜索，再写成可供后续写作调用的研究笔记。
```

**User Prompt**：
```
{buildTaskBrief(topic, '待生成', options)}

围绕当前轨道执行 Google Search 研究，并整理成给写作者直接使用的研究笔记。

当前研究轨道：{track}
本轮重点：{focus}

要求：
1. 必须先调用 Google Search，再整理结果，不要只靠记忆回答。
2. 输出一份结构清晰的 Markdown 研究笔记，优先覆盖：背景、时间线、关键主体、公开动作、数据点、争议点。
3. 对重要事实尽量给出具体口径；无法确认的内容直接写"待核实"。
4. 如果搜索结果之间存在冲突，明确标出冲突点，不要强行合并。
5. 这是一份研究稿，不是最终文章，不要为了文采扩写。
```

**使用的模型**：`gemini-3.1-flash-lite`（搜索模型）
**工具**：`googleSearch`
**超时**：180秒

### 5.4 Deep Research（可选）

**函数**：`generateDeepResearchTrack()` — 第 2258-2291 行

用户开启 `enableDeepResearch` 后，额外执行一次 Deep Research Agent 调用。

**Prompt 全文**：
```
{buildTaskBrief(topic, '待生成', options)}

执行一次 Deep Research。
研究重点：{focus}
你需要围绕主题执行原生 Deep Research，尽量覆盖背景、关键主体、时间线、公开动作、争议点和可核查来源。
程序会直接保留 Deep Research 的原生输出块，不会再让其他模型做二次总结。
```

**Agent 模型**：`deep-research-pro-preview-12-2025`
**超时**：30分钟

### 5.5 研究结果合并

所有轨道的结果合并为一个"主题资料库"（`ammoLibrary`）：

```
# 主题资料库
主题：{topic}

## 综合研究原始返回
{content}

## 量化研究原始返回
{content}

## 人文研究原始返回
{content}

## Deep Research 原生输出（如有）
{content}
```

---

## 6. 阶段四：讨论方向生成

### 6.1 功能说明

**函数**：`generateDiscussionDirections()` — 第 2383-2413 行

基于资料库，自动生成 **5个差异化的讨论方向**，供用户选择。

### 6.2 Prompt 全文

**System Instruction**：
```
你是商业文章的选题编辑，负责提出差异化讨论方向。

你服务于一条商业文章工作流，目标是生成自然、可信、克制、可发布的中文文章。
所有输出默认使用简体中文，除非我明确要求输出 JSON 或英文。
不要把空话、套话、假转折、装饰性比喻和总结腔带进成文。

{masterPersona 全文}
{subPersona（如适用）}
{profileAntiPatterns（如适用）}

反 AI 文风硬约束：
1. 去 AI 化不等于口语化或随笔化...
（9条规则全文）
```

**User Prompt**：
```
{buildTaskBrief(topic, '待生成', options)}

请基于资料库生成 5 个不同但都能成立的讨论方向。
每个方向都必须是完整中文句子，并体现明确判断、切入角度和展开潜力。
不要只做同义改写，不要生成空泛标题党。

资料库：
{truncate(ammoLibrary, 100000)}
```

**输出格式**：JSON 数组（5个字符串）

### 6.3 方向修正功能

**函数**：`refineDiscussionDirections()` — 第 2415-2446 行

用户可以给出"补充偏好"，系统据此重新生成5个方向。

**额外 Prompt**：
```
请重新生成 5 个讨论方向，但要严格吸收下面这条补充偏好。
补充偏好：{refinement}
要求：保持差异化，不要只是换几个词。
```

---

## 7. 阶段五：文章大纲生成

### 7.1 功能说明

**函数**：`generateArticleOutline()` — 第 2448-2489 行

基于资料库、讨论方向和参考模板文，生成一份适合后续分段写作的商业文章大纲。

### 7.2 Prompt 全文

**System Instruction**：
```
你是商业文章结构编辑，负责设计能直接进入写作的大纲。
{... 完整系统指令，包含 masterPersona + antiAiStyleRules}
```

**User Prompt**：
```
{buildTaskBrief(topic, direction, options)}

请生成一份适合后续分段写作的商业文章大纲。

要求：
1. 大纲必须能自然写成文章，不要把正文默认写成列表体。
2. 要有明确标题、开头任务、中段推进、尾段收束。
3. 每个大段都要写出承担的论证任务。
4. 结构、节奏和开头方式要参考模板文，但不能套模板句子。

{如有修订意见：本轮修订意见：{feedback}}
{如有旧大纲：当前旧大纲：{existingOutline}}

参考模板文：
{formatReferenceTemplatesForPrompt(referenceArticles)}

资料库：
{truncate(ammoLibrary, 120000)}
```

**maxOutputTokens**：8000

---

## 8. 阶段六：参考模板匹配与装载

### 8.1 功能说明

**文件**：`services/referenceTemplateService.ts`（501行）

系统从后端加载 `article_tags.jsonl` 文章目录，通过多维度打分算法自动匹配最适合本次任务的 3 篇参考模板文章。

### 8.2 匹配算法

#### 第一步：风格纯度过滤

排除以下文章：
- `is_activity_notice`（活动通知）
- `is_low_value`（低价值）
- `is_advertorial`（软文）
- 风格纯度分过低

**风格纯度计算公式**（fdsm 风格库）：
```
score = argument * 0.22 + structure * 0.18 + evidence * 0.16
      + style * 0.12 + quality * 0.12 + reference * 0.10
      + publishability * 0.10 + editorialIndependence * 0.08
      - promotional * 0.12 - advertorialRisk * 0.08
```

#### 第二步：任务相关度打分

```
taskScore = lexical * 0.48 + titleHit * 0.18 + quality * 0.08
          + reference * 0.11 + purity * 0.15
```

#### 第三步：Boost 加权

文体匹配 +0.18，风格匹配 +0.08，受众匹配 +0.05，方向匹配 +0.04，纯度 × 0.12

#### 第四步：多样性选择

使用MMR（最大边际相关性）算法，避免选出互相太相似的文章，并加入同文体惩罚（-0.03）。

### 8.3 全文装载

选定的 3 篇文章通过 `POST /api/reference-templates/full-text` 从后端加载 Markdown 原文全文，最终格式化为：

```
## 模板文章 1
标题：{title}
日期：{date}
文体：{genre}
风格：{style}
结构模式：{structurePattern}
开头方式：{openingPattern}
收束方式：{endingPattern}
核心观点：{coreArgument}
本次借鉴点：{whySelected}
摘要：{summary}
全文：
{fullText（最长16000字符）}
```

---

## 9. 阶段七：写作方法提炼（Writing Insights）

### 9.1 功能说明

**函数**：`generateWritingInsights()` — 第 2491-2519 行

为本次写作任务生成一份短小但高价值的 `writing_insights.md`。

### 9.2 Prompt 全文

**System Instruction**：
```
你是写作方法编辑，负责把本次写作的方法论压缩成可执行指令。
{完整系统指令}
```

**User Prompt**：
```
{buildTaskBrief(topic, direction, options)}

请生成一份简短但高价值的 writing_insights.md。
必须包含：任务画像、模板借鉴、最重要的 5 条写作规则、需要避开的文风风险。
控制在 800-1200 字之间。

参考模板文：
{formatReferenceTemplatesForPrompt(referenceArticles)}

资料库：
{truncate(ammoLibrary, 100000)}

当前大纲：
{outline}
```

**maxOutputTokens**：5000

---

## 10. 阶段八：证据卡整理（Evidence Cards）

### 10.1 功能说明

**函数**：`generateEvidenceCards()` — 第 2521-2549 行

将资料库整理为可直接调用的证据卡片。

### 10.2 Prompt 全文

**System Instruction**：
```
你是证据整理编辑，负责把资料压缩为可直接调用的证据卡片。
{完整系统指令}
```

**User Prompt**：
```
{buildTaskBrief(topic, direction, options)}

请把资料库整理为 evidence_cards.md。
要求：只保留与当前方向直接相关的事实、数据、案例、争议和可引用说法，方便后续写作调用。
可以分组，但不要写成长文。

参考模板文：
{formatReferenceTemplatesForPrompt(referenceArticles)}

当前大纲：
{outline}

资料库：
{truncate(ammoLibrary, 120000)}
```

**maxOutputTokens**：7000

---

## 11. 阶段九：分段写作规划（Chunk Plan）

### 11.1 功能说明

**函数**：`buildChunkPlan()` — 第 2551-2600 行

将大纲拆分为多个写作 Chunk，每个 Chunk 有明确的标题、负责小节、目标长度和写作任务。

### 11.2 Chunk 数量计算逻辑

```
if (指定了目标字数) {
  chunkCount = Math.ceil(desiredLength / chunkLength)
} else {
  // 根据大纲标题数量推断
  if (标题 >= 7) return 3
  if (标题 >= 4) return 2
  return 1
}
```

### 11.3 Prompt 全文

**System Instruction**：
```
你是写作调度编辑，负责把大纲拆成稳定、可续写的 chunk。
{完整系统指令}
```

**User Prompt**：
```
{buildTaskBrief(topic, direction, options)}

Strict chunk count: return exactly {expectedChunks} chunks, no more and no less.
{如有目标字数：Keep the sum of all targetLength values close to {desiredLength}.}
{否则：If total length is not specified, let the article expand naturally and use roughly {chunkLength} characters per chunk as a soft reference.}

请把这份大纲严格拆成 {expectedChunks} 个写作 chunk，不多不少。
每个 chunk 返回：title、sections、targetLength、purpose。
sections 只能写大纲里真实存在的小节名。
purpose 必须是一句正常中文，说明本轮写作要解决什么。
只输出 JSON 数组。

参考模板文：
{formatReferenceTemplatesForPrompt(referenceArticles)}

大纲：
{outline}
```

**输出格式**：JSON 数组，每项包含 `title`、`sections`、`targetLength`、`purpose`

---

## 12. 阶段十：分段正文写作（Chunk Writing）

### 12.1 功能说明

**函数**：`generateChunk()` — 第 2602-2664 行

按 Chunk Plan 逐段写作正文。每个 Chunk 都能看到前文，确保衔接连贯。

### 12.2 Prompt 全文

**System Instruction**：
```
你是商业文章作者，负责按 chunk 计划续写正文。
{完整系统指令}
```

**User Prompt**：
```
{buildTaskBrief(topic, direction, options)}

当前 chunk：{chunk.index}
当前 chunk 标题：{chunk.title}
负责小节：{chunk.sections.join('、')}
当前 chunk 目标长度：约 {chunk.targetLength} 字
当前 chunk 任务：{chunk.purpose}

{如有前文：已写正文长度约 {previousText.length} 字。请只续写尚未完成的部分，不要重复前文。}
{如为首轮：这是首轮写作，请直接进入标题和开篇。}

要求：
1. 全文使用简体中文。
2. 不要重复前文观点和段落。
3. 不要使用明显 AI 套话和装饰性修辞。
4. 句子要自然，段落要推进，不要把正文写成条列。
5. 本轮只完成分配给你的部分，不要抢写后文。
6. 参考模板文的节奏、密度和气质，但不要照抄模板句子。

参考模板文：
{formatReferenceTemplatesForPrompt(referenceArticles)}

writing_insights.md：
{writingInsights}

evidence_cards.md：
{evidenceCards}

资料库：
{truncate(ammoLibrary, 100000)}

大纲：
{outline}

{如有前文：已写正文：{truncate(previousText, 12000)}}
```

**maxOutputTokens**：9000
**超时**：240秒

---

## 13. 阶段十一：终稿结构缝合（Assembly）

### 13.1 触发条件

当 `chunkPlan.length > 1` 或二级标题数量不足 3 个时，自动触发。

### 13.2 功能说明

**函数**：`assembleArticleDraft()` — 第 2666-2726 行

将多个 Chunk 草稿缝合成一篇完整文章，重点处理接缝问题。

### 13.3 Prompt 全文

**System Instruction**：
```
你是终稿组装编辑，只在现有稿件基础上做结构缝合，禁止另起一篇。
{完整系统指令}
```

**User Prompt**：
```
{buildTaskBrief(topic, direction, options)}

你是终稿组装编辑。现在手里是按 chunk 写出的正文草稿，请把它缝合成一篇完整文章。
这一步不是重写，只做结构缝合和最小必要修订。

硬性要求：
1. 保留当前标题、核心判断、论证顺序和大部分原句。
2. 输出必须是一篇完整的 Markdown 文章，包含 1 个 # 标题和 3-6 个 ## 子标题。
3. 子标题优先使用下方"小标题计划"和当前大纲，不另起一套新结构。
4. 重点处理 chunk 接缝：重复开头、重复收束、转场突兀、段落断裂、信息堆叠。
5. 除非为了衔接绝对必要，不要整段重写；能删一句、并一句、补一句过渡，就不要大改。
6. 不要引入当前稿件之外的新事实、新论点、新例子。
7. 正文保持自然段推进，不要改写成条目列表。

结构检查：
{buildArticleStructureChecklist(draft, outline, chunkPlan)}

{如有小标题计划：小标题计划：1. xxx  2. xxx ...}

chunk 规划：
{formatChunkPlanForPrompt(chunkPlan)}

原始 chunk 草稿：
{formatChunkDraftsForPrompt(chunks, chunkPlan)}

writing_insights.md：
{writingInsights}

参考模板文：
{formatReferenceTemplatesForPrompt(referenceArticles)}

当前整稿：
{truncate(draft, 18000)}

只输出缝合后的完整文章。
```

**maxOutputTokens**：12000

---

## 14. 阶段十二：杂志级终审循环（Editorial Review）

### 14.1 功能说明

**函数**：`reviewAndFinalizeArticle()` — 第 3247-3486 行

这是一个**最多3轮的审校-修订循环**，模拟杂志终审流程：

```
for passIndex = 1 to 3:
  1. 终审诊断 → 输出 review report（JSON）
  2. 如果 ready=yes 或无问题 → 退出循环
  3. 否则 → 根据 strategy 执行修订
```

### 14.2 终审诊断 Prompt 全文

**函数**：`reviewArticleEditorialPass()` — 第 2896-2993 行

**System Instruction**：
```
你是杂志级终审编辑，只保留本轮仍未解决的问题。
{完整系统指令}
```

**User Prompt**：
```
{buildTaskBrief(topic, direction, options)}

你现在是顶级商业杂志的终稿诊断编辑。这是第 {passIndex} / 3 轮终审。
你的职责是诊断剩余问题，不是要求另写一篇。
终审目标：在原文基础上做最小必要修改，让分段写出的内容成为一篇完整、自然、可发布的文章。
你必须把当前稿件与参考模板文直接对比，重点检查：是否已经是一篇完整文章、是否有明确的 ## 子标题、chunk 接缝、重复开头/收束、段落推进、语气统一、遣词克制、是否自然。
这是渐进式审稿。如果前一轮已经解决的问题，本轮不要重复提出。
最多返回 6 个当前真正阻塞发布的问题。
返回 JSON 对象，字段为：summary, ready, strategy, templateAlignment, unresolvedRisk, issues。
strategy 只能是 structure_tune、continuity_tune、micro_polish、done。
如果问题涉及子标题缺失、结构断裂、明显拼接感，strategy 用 structure_tune。
如果问题主要是段落承接、收束、重复或推进不顺，strategy 用 continuity_tune。
如果只剩句级用词、节奏、AI 腔问题，strategy 用 micro_polish。
issues 中每项必须含有：severity, scope, title, diagnosis, instruction, excerpt。
输出内容使用简体中文。

此前终审记录：
{formatEditorialHistoryForPrompt(reviewHistory)}

结构检查：
{buildArticleStructureChecklist(draft, outline, chunkPlan)}

参考模板文：
{formatReferenceTemplatesForPrompt(referenceArticles)}

writing_insights.md：
{writingInsights}

evidence_cards.md：
{evidenceCards}

本地风格检查：
{lintStyle(draft)}

资料库：
{truncate(ammoLibrary, 100000)}

大纲：
{outline}

当前稿件：
{truncate(draft, 18000)}
```

### 14.3 终审修订 Prompt 全文

**函数**：`reviseArticleEditorialPass()` — 第 2995-3064 行

根据 strategy 类型执行不同粒度的修订：

| Strategy | 修订范围 |
|----------|----------|
| `structure_tune` | 补/调整 ## 子标题、修 chunk 接缝、删重复 |
| `continuity_tune` | 修转场、并重复、压缩拖沓句、补承上启下 |
| `micro_polish` | 句级和短语级精修 |

**System Instruction**：
```
你是杂志级修订编辑，负责渐进式修文而不是反复重写。
{完整系统指令}
```

**User Prompt**（以 `continuity_tune` 为例）：
```
{buildTaskBrief}

这是第 {passIndex} 轮修订。
这一轮只允许做段落级连贯性修订：修转场、并重复、压缩拖沓句、补承上启下的一两句。

硬性要求：
1. 修的是当前稿件，不是另起一篇。
2. 不要新增当前稿件之外的事实、论点、例子和引用。
3. 保持简体中文。
4. 用参考模板文统一语气、段落密度和开头节奏。
5. 只解决下列仍未解决的问题，不要打扰已经成立的段落。
6. 默认保留当前标题、整体论证顺序和大部分原句。
7. 除非问题明确要求，否则不要改动既有子标题和段落顺序。

终审意见：
{formatEditorialReviewMarkdown(review, passIndex)}

{结构检查、小标题计划、chunk规划、参考模板文、大纲、当前稿件}

只输出修订后的完整文章。
```

---

## 15. 阶段十三：商业稿去AI化（Commercial Humanizer）

### 15.1 流程说明

去AI化包含 **3个子步骤**：

1. **初检**：诊断残余 AI 痕迹（JSON 报告）
2. **修订**：如有问题，执行最小必要修改
3. **复检**：再次诊断，确认清理效果

### 15.2 去AI化诊断 Prompt 全文

**函数**：`reviewCommercialHumanizationPass()` — 第 3066-3149 行

**System Instruction**：
```
你是商业文章去AI化编辑，只识别真正影响商业文风和发布感的残余 AI 痕迹。
{完整系统指令}
```

**User Prompt**：
```
{buildTaskBrief}

{商业文章去AI化护栏全文：}
去AI化的目标是清理生成式痕迹，不是把商业文章改成口语贴、随笔、访谈口播稿或鸡汤文。
保持商业杂志式语体：判断明确、证据先行、语气克制、段落自然推进，不额外制造"人味表演"。
优先清理模板化连接句、空泛总结句、宣传腔黑话、过度工整排比、伪洞察句、聊天式客套和装饰性标点。
（6条规则全文）

{商业文章去AI化检查维度全文：}
内容模式：夸大意义、知名度堆砌、宣传语言、模糊归因、公式化"挑战/未来展望"段落。
语言模式：AI 高频词、系动词回避、否定式排比、三段式罗列、刻意换词、虚假范围。
版式模式：破折号过多、粗体过多、内联标题列表、emoji、英文弯引号。
对话痕迹：协作式套话、知识截止免责声明、谄媚语气、填充短语、过度限定、通用积极结论。

{商业文章去AI化快速检查全文：}
连续三个句子长度和结构是否过于整齐。
是否出现"此外/然而/值得注意的是/综上所述"等机械连接词。
是否存在"挑战与未来展望"式公式段落或万能收尾句。
是否出现破折号揭示句、加粗标题列表、emoji、聊天式客套。
是否用模糊主体、黑话或抽象大词代替具体事实和动作。

你现在是商业杂志发稿前的去AI化编辑。
你的任务是诊断残余 AI 痕迹和模板化表达，不是把文章改成口语、随笔或个人风格写作。
不要套用原始 humanizer 里"适当使用我""允许一些混乱""故意增加个性"的随笔化建议。
只检查会直接影响"像成熟编辑写成的商业文章"这一发布感的问题。
重点检查：模板化连接句、万能商业黑话、模糊主体归因、过度工整排比、空泛总结、聊天式客套、装饰性引号和万能积极结尾。
同时检查：知名度堆砌、挑战与未来展望公式段、协作式套话、知识截止免责声明、破折号/粗体/emoji/标题列表等格式残留。
如果某处只是正常商业写作表达，不要误判为 AI 腔。
最多返回 8 个问题。
返回 JSON 对象，字段为：summary, ready, toneGuardrail, unresolvedRisk, issues。
issues 中每项必须含有：category, severity, title, diagnosis, instruction, excerpt。

{结构检查、参考模板文、writing_insights、本地风格检查、当前稿件}
```

### 15.3 去AI化修订 Prompt（摘要）

**函数**：`reviseCommercialHumanizationPass()` — 第 3151-3218 行

与诊断 Prompt 类似，但增加了 **8条硬性修订约束**：
- 保留标题、子标题、段落顺序
- 不新增事实
- 不改成第一人称抒情/聊天腔
- 能删一个套话就不要重写整段
- 结尾只回到已论证的判断

---

## 16. 阶段十四：句级终修（Final Polish）

### 16.1 功能说明

**函数**：`runFinalPolish()` — 第 4070-4147 行

发稿前最后一位 line editor，只做句级和短语级的最小必要修改。

### 16.2 Prompt 全文

**System Instruction**：
```
你是杂志级 line editor，只做最小必要修改，让正文在原文基础上达到可发布状态。
{完整系统指令}
```

**User Prompt**：
```
{反AI文风硬约束全文}
{商业文章去AI化护栏全文}
{商业文章去AI化检查维度全文}
{商业文章去AI化快速检查全文}

你是发稿前最后一位 line editor，负责文章定稿。
这不是重写轮次，只允许在原文基础上做句级、短语级和极小幅度的段落收束。
请对照参考模板文，把当前文稿的语气、节奏、克制程度和自然度收紧到同一水准。

渐进式修订规则：
1. 保留标题、子标题、段落顺序和整体结构，除非极小的局部调整必不可少。
2. 如果一个短语能解决问题，就不要整句改。
3. 如果一句话能解决问题，就不要整段改。
4. 不要重新打开前几轮已经解决的问题。
5. 不要添加资料库和当前文稿之外的新事实、新论点和新例子。
6. 如果正文仍缺少 ## 子标题，只能沿现有推进补出 3-6 个工作性子标题。
7. 只清理残余的 AI 腔、假转折、空泛抽象词、装饰性标点和不自然的引号表达。
8. 输出修订后的完整文稿。

{结构检查、小标题计划、本地风格检查、参考模板文、当前文稿}
```

**maxOutputTokens**：12000
**超时**：300秒

---

## 17. 阶段十五：TN 教学指南生成

### 17.1 功能说明

**函数**：`generateTeachingNotes()` — 第 3220-3245 行

根据最终成文生成可选的教学笔记/讨论指南。

### 17.2 Prompt 全文

**System Instruction**：
```
你是商学院教学指南编辑，只在需要时生成 TN。
{完整系统指令}
```

**User Prompt**：
```
{buildTaskBrief(topic, direction, options)}

请基于成文生成一份可选的 TN / 讨论指南。
内容包含：适用场景、核心讨论问题、可用板书结构、课堂上需要提醒的风险。
直接输出 Markdown。

参考模板文：
{formatReferenceTemplatesForPrompt(referenceArticles)}

正文：
{truncate(articleContent, 12000)}
```

**maxOutputTokens**：6000

---

## 18. 辅助功能

### 18.1 Copilot 对话

**函数**：`chatWithEditor()` — 第 3917-3992 行

用户完成写作后，可通过 Copilot 与编辑对话，提出修改意见。

**System Instruction**：
```
你是写作 Copilot。回复要简洁；如果用户明显在要求修改，就把动作转成 refine 指令。
```

**输出**：JSON 对象 `{ reply, action, target, instruction }`

### 18.2 选区精修

**函数**：`refineTextBySelection()` — 第 3994-4020 行

用户选中一段文字后，给出修改指令，系统只修改选中部分。

**System Instruction**：
```
你是精确编辑器，只重写被选中的部分。
```

### 18.3 整稿精修

**函数**：`refineContent()` — 第 4022-4068 行

用户给出全局编辑要求，系统修订全文。

**System Instruction**：
```
你是商业文章编辑，负责执行用户指定的局部或全局修订。
```

---

## 19. 系统指令构建机制详解

### 19.1 `buildSystemInstruction()` 函数

**位置**：`geminiService.ts` 第 698-701 行

每个 Prompt 的 System Instruction 都通过此函数统一构建，结构为：

```
{role}                          ← 本阶段角色描述
{masterPersona}                 ← 运行时加载的主人格
{subPersona（如适用）}           ← LatePost 子人格
{profileAntiPatterns（如适用）}   ← 风格库反模式
{antiAiStyleRules}              ← 反AI文风硬约束（9条）
```

### 19.2 默认主人格（硬编码兜底）

```typescript
const DEFAULT_MASTER_PERSONA = [
  '你服务于一条商业文章工作流，目标是生成自然、可信、克制、可发布的中文文章。',
  '所有输出默认使用简体中文，除非我明确要求输出 JSON 或英文。',
  '不要把空话、套话、假转折、装饰性比喻和总结腔带进成文。',
].join('\n\n');
```

### 19.3 LatePost 子人格自动选择逻辑

**文件**：`services/stylePersonaUtils.ts`

当风格库为 `latepost` 时，根据文体/风格/目标关键词自动选择子人格：

| 关键词 | 子人格 |
|--------|--------|
| 人物、创始人、管理者、企业家 | `latepostProfilePersona` |
| 趋势、赛道、行业评论、行业复盘 | `latepostIndustryReviewPersona` |
| 独家、组织、调整、高管、裁员、快讯 | `latepostNewsPersona` |
| 其他 | `latepostFeaturePersona`（默认） |

---

## 20. 本地风格检查（Lint Style）

### 20.1 功能说明

**函数**：`lintStyle()` — 第 1736-1783 行

在终审和去AI化阶段，系统先用**正则表达式**对文稿做一次本地预检，检测以下 20+ 种问题：

| 检查项 | 示例 |
|--------|------|
| AI 连接句 | "换句话说""更重要的是""说到底" |
| 商业黑话 | "赋能""闭环""抓手""范式迁移" |
| 模糊主体 | "有人认为""业内普遍认为" |
| 过度工整句 | "不是……而是……""既……又……" |
| 聊天腔 | "你会发现""我们不妨" |
| 宣传式表达 | "令人叹为观止""充满活力" |
| 协作痕迹 | "希望这对你有帮助""当然！" |
| 万能结尾 | "未来已来""值得每个人思考" |
| 破折号过多 | 统计 `—` 出现次数 |
| 粗体过多 | 统计 `**...**` 出现次数 |
| Emoji | 检测 Unicode emoji 字符 |
| 装饰性引号 | 检测 `"..."` 中文引号滥用 |

检查结果以 Markdown 格式注入到终审和去AI化的 Prompt 中。

---

## 21. 完整文件依赖关系图

```
AI_writer/
├── config/
│   └── styleProfiles.js          ← 风格库定义（fdsm / latepost）
├── services/
│   ├── geminiService.ts          ← 核心工作流引擎（4148行）
│   ├── promptAssets.ts           ← 静态 MD 资产导入
│   ├── backendContentService.ts  ← 后端 API 调用层
│   ├── referenceTemplateService.ts ← 参考模板匹配算法
│   ├── stylePersonaUtils.ts      ← 子人格自动选择
│   └── checkpointStore.ts        ← 断点续写存储
├── server/
│   └── index.mjs                 ← 后端 HTTP 服务器
├── rag_assets/
│   ├── global/
│   │   ├── core_writing_skills.md     ← 核心写作总纲（16KB）
│   │   ├── universal_prompt.md        ← 通用写作约束
│   │   └── runtime/
│   │       ├── master_persona.md      ← 主人格定义
│   │       ├── anti_ai_style_rules.md ← 反AI文风规则
│   │       ├── commercial_humanizer_rules.md    ← 去AI化护栏
│   │       ├── commercial_humanizer_patterns.md ← 去AI化检查维度
│   │       ├── commercial_humanizer_quick_checks.md ← 去AI化快速检查
│   │       └── anti_patterns.md       ← 风格库反模式
│   ├── metadata/
│   │   └── article_tags.jsonl    ← 文章标签库（参考模板目录）
│   ├── persona/
│   │   └── rule_cards.jsonl      ← 人格规则卡
│   └── workflows/
│       ├── ai_writing_workflow.md ← 工作流说明文档
│       └── task_brief_template.md ← 任务卡模板
├── raw_materials/                ← 原始参考文章全文
│   ├── 2020/ 2021/ 2023/ 2024/ 2025/
├── types.ts                      ← TypeScript 类型定义
├── App.tsx                       ← 前端主组件（67KB）
└── components/                   ← 前端 UI 组件
    ├── ArticleViewer.tsx         ← 文章查看器
    ├── OutlineReview.tsx         ← 大纲审核
    ├── ResearchReview.tsx        ← 研究结果审核
    ├── DirectionSelection.tsx    ← 方向选择
    ├── WritingCopilot.tsx        ← 写作 Copilot
    └── WorkflowNavigator.tsx     ← 工作流导航器
```

---

## 附录：关键常量一览

| 常量 | 值 | 用途 |
|------|-----|------|
| `MAX_CONTEXT_CHARS` | 180,000 | 上下文最大字符数 |
| `MAX_DRAFT_CHARS` | 18,000 | 整稿改写安全上限 |
| `TEXT_CONTINUATION_MAX_ROUNDS` | 2 | 续写最大轮数 |
| `TEXT_CONTINUATION_TAIL_CHARS` | 4,000 | 续写定位用的尾部字符数 |
| `DEFAULT_STAGE_TIMEOUT_MS` | 180,000 (3分钟) | 默认阶段超时 |
| `LINE_POLISH_TIMEOUT_MS` | 300,000 (5分钟) | 句级终修超时 |
| `MAGAZINE_EDITORIAL_MAX_PASSES` | 3 | 终审最大轮次 |
| `MAGAZINE_MAX_ISSUES_PER_PASS` | 6 | 每轮终审最多返回问题数 |
| `COMMERCIAL_HUMANIZER_MAX_ISSUES` | 8 | 去AI化最多返回问题数 |
| `TARGET_ARTICLE_H2_MIN` | 3 | 文章最少二级标题数 |
| `TARGET_ARTICLE_H2_MAX` | 6 | 文章最多二级标题数 |
| `DEEP_RESEARCH_POLL_TIMEOUT_MS` | 15分钟 | Deep Research 轮询超时 |
| `DEEP_RESEARCH_STAGE_TIMEOUT_MS` | 30分钟 | Deep Research 阶段超时 |

