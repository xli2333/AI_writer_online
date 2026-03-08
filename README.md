# AI Writer

面向商业文章写作的 Gemini 前端工作台。它不是一个“直接出稿”的单轮生成器，而是一条分阶段工作流：

`选题 -> 研究 -> 资料审阅 -> 方向选择 -> 大纲审阅 -> 分段写作 -> 终审 -> 商业稿去AI化 -> 导出`

项目保留了“先研究、再判断、再写作、再终审”的编辑逻辑，目标是把公开资料、上传材料、参考模板文和终稿审校串成一个可反复修订的写作闭环。

## 1. 适用场景

- 商业分析
- 公司 / 行业 / 组织观察
- 趋势解读
- 案例型长文
- 需要“研究 + 结构化写作 + 终稿润色”的中文内容生产

不适合：

- 对外公开的多租户 SaaS 直接部署
- 需要后端权限隔离的生产环境
- 完全不依赖外部 API 的离线写作

原因很直接：当前版本是纯前端 Vite 应用，Gemini API Key 存在浏览器本地存储中，更适合个人、本机或受控内网环境。

## 2. 当前能力

### 2.1 研究层

- 三路研究并行：综合、量化、人文
- 支持上传补充资料：`PDF / TXT / MD / CSV`
- 可选追加 Deep Research
- 研究结果会整理为可复用资料库，供后续方向选择、大纲生成和写作调用

### 2.2 写作层

- 先生成多个讨论方向，再由用户选择切口
- 先做大纲审阅，再进入成文
- 长文按 chunk 计划分段写作，避免一次性长输出失控
- 每段写作后会保留快照，支持恢复和续写

### 2.3 终稿层

- 多轮 editorial review
- 商业稿专用去AI化 pass
- 句级终修
- 可选生成 TN / 讨论指引

### 2.4 导出层

- Markdown
- 正文 PDF
- 纯文字 PDF
- TN PDF

其中“纯文字 PDF”是单独实现的文本排版导出，不走网页截图分页，适合归档、打印和接近 Word 文字稿的阅读场景。

## 3. 核心设计思路

这个项目有四个明确取向：

1. 先研究，后写作  
避免模型在信息不足时直接凑稿。

2. 先结构，后成文  
大纲和方向先定准，长文质量更稳定。

3. 多轮终审，而不是单轮“润色”  
终审会做结构连续性、模板贴合、商业稿去AI化和句级收束。

4. 用户保留编辑主导权  
方向要选，大纲能改，局部可重写，工作流支持回退和恢复。

## 4. 技术栈

- React 19
- TypeScript
- Vite
- `@google/genai`
- `html2pdf.js`
- `jspdf`

## 5. 仓库结构

```text
.
├─ App.tsx                         # 主工作流与页面状态
├─ components/                    # 前端界面组件
│  ├─ ApiKeyInput.tsx             # API Key 输入
│  ├─ ArticleViewer.tsx           # 结果页、导出、Plain PDF
│  ├─ DirectionSelection.tsx      # 方向选择
│  ├─ MarkdownRenderer.tsx        # Markdown 渲染与导出样式
│  ├─ OutlineReview.tsx           # 大纲审阅
│  ├─ ResearchReview.tsx          # 研究资料审阅
│  ├─ SettingsModal.tsx           # 模型配置
│  └─ WorkflowNavigator.tsx       # 快照恢复 / 续写
├─ services/
│  ├─ checkpointStore.ts          # IndexedDB / localStorage 工作流存档
│  ├─ geminiService.ts            # 研究、写作、终审、Deep Research 主链路
│  ├─ promptAssets.ts             # 任务描述拼装
│  └─ referenceTemplateService.ts # 模板文选择与全文载入
├─ public/
│  └─ fonts/yahei.ttf             # 纯文字 PDF 的中文字体
├─ raw_materials/                 # 原始参考文章全文库
├─ rag_assets/                    # RAG 元数据、工作流说明、摘要缓存
├─ scripts/rag/                   # 离线整理语料与生成元数据脚本
├─ portfolio-docs/                # 补充文档
├─ projects/                      # 过程性项目材料
├─ USER_MANUAL.md                 # 用户手册
├─ package.json
└─ README.md
```

## 6. 运行要求

建议环境：

- Node.js 20+ 的现代 LTS 版本
- npm 10+
- Windows / macOS / Linux 均可

## 7. 安装与启动

```bash
npm install
npm run dev
```

构建生产包：

```bash
npm run build
```

本地预览：

```bash
npm run preview
```

## 8. 配置方式

### 8.1 Gemini API Key

当前版本不依赖后端环境变量，直接在界面输入 API Key。

- 页面内输入后保存到浏览器 `localStorage`
- 使用的 key 名：`GEMINI_API_KEY`

这意味着：

- 本地试用很方便
- 但不适合把前端直接公开部署到不受控环境

如果要上线给多人使用，建议改成服务端代理或网关模式。

### 8.2 模型配置

设置面板支持区分：

- 核心写作模型
- 研究模型

当前会写入浏览器本地：

- `GEN_MODEL`
- `SEARCH_MODEL`

### 8.3 任务配置

首页可配置：

- 文体
- 风格
- 目标受众
- 文章目标
- 目标字数
- 单轮写作长度
- 是否生成 TN
- 是否启用 Deep Research
- Deep Research 补充提示词

## 9. 工作流说明

### 9.1 研究阶段

系统会先执行三路研究：

- 综合研究：背景、时间线、关键主体、公开动作
- 量化研究：数据、指标、份额、融资、财务信息
- 人文研究：人物、组织变化、公开表达、舆论反应

如果启用了 Deep Research，会再额外追加一层深挖结果。研究页展示的是整理后的研究文档，不是原始接口返回的混杂日志。

### 9.2 方向选择

系统会先生成多个讨论方向。这里不是让用户选“立场”，而是选文章最值得切入的讨论框架。

### 9.3 大纲审阅

写作前先审结构。这个阶段支持：

- 全局反馈重写
- 选区微调

大纲阶段做对了，后面长文质量会稳很多。

### 9.4 分段写作

长文不会一次性整篇生成，而是：

1. 先生成 chunk plan
2. 每轮只负责指定章节
3. 合并 chunk drafts
4. 再进入终审链路

这样做的目的是减少：

- 重复
- 拼接感
- 结构漂移
- 一次性超长输出导致的失控

### 9.5 终审与去AI化

终稿不是简单润色，而是多轮处理：

1. Editorial review
2. Editorial revision
3. 商业稿去AI化初检
4. 商业稿去AI化修订
5. 商业稿去AI化复检
6. 句级终修

“去AI化”这里不是把文章改成口语或随笔，而是专门清理商业文章里常见的模型痕迹，例如：

- 模板化连接句
- 万能黑话
- 模糊主体
- 空泛正能量收尾
- 过度工整的排比
- 聊天腔和装饰性标点

## 10. 工作流快照与恢复

应用会在关键节点落盘：

- 研究完成
- 方向生成完成
- 大纲完成
- chunk 计划完成
- 每个 chunk 完成
- 合稿完成
- 终稿完成
- TN 完成

存储优先级：

1. IndexedDB
2. localStorage 兜底

对应代码：

- `services/checkpointStore.ts`

这意味着浏览器意外关闭后，通常可以从上次节点恢复，而不是整条链路重跑。

## 11. RAG 资产与脚本

项目内置了一套本地 RAG 语料和脚本，用于把历史文章沉淀成模板选择和风格参考资产。

可用脚本：

```bash
npm run rag:prepare
npm run rag:analyze
npm run rag:skills
npm run rag:task
```

主要目录：

- `raw_materials/`：原始文章全文
- `rag_assets/global/`：全局 prompt / 写作技能
- `rag_assets/metadata/`：文章标签、目录、清洗结果
- `rag_assets/summaries/`：逐篇摘要
- `scripts/rag/`：离线处理脚本

## 12. 导出说明

### 12.1 正文 PDF

用于保留页面视觉样式，适合快速分享和查看。它仍然基于 DOM 导出，所以在复杂分页边界上不如纯文字 PDF 稳定。

### 12.2 纯文字 PDF

用于输出接近 Word 文字稿的版本：

- 不依赖截图分页
- 使用 `jsPDF` 直接做文本排版
- 使用 `public/fonts/yahei.ttf` 保证中文输出
- 更适合长文打印、归档和纯文字阅读

### 12.3 Markdown

适合继续编辑、归档、进入其他内容流程。

### 12.4 TN PDF

如果任务启用了 TN，会额外导出讨论指引版本。

## 13. Deep Research 说明

Deep Research 当前走 Gemini `interactions` 能力，特点是：

- 耗时更长
- 输出更偏原生研究内容
- 更适合补充反向信息、争议点和高价值公开证据

需要注意：

- 这是实验性链路
- 浏览器直连 `interactions` 的稳定性弱于服务端代理
- 当前实现已经加入恢复流和错误诊断，但如果要追求生产级稳定性，仍建议迁移到服务端执行

## 14. 已知限制

### 14.1 前端直连 API

当前版本把 API Key 放在浏览器侧，只适合个人或受控环境。

### 14.2 Deep Research 稳定性

Gemini `interactions` 在浏览器场景下仍有实验性质，偶发错误需要结合控制台日志排查。

### 14.3 可视化 PDF 的分页

如果页面版式很复杂，视觉版 PDF 仍可能出现分页不理想的情况。纯文字 PDF 更稳定。

### 14.4 大语料仓库体积

`raw_materials/` 与 `rag_assets/` 会让仓库明显变大，这是为了保留模板文选择和本地参考能力。

## 15. 常见问题

### 15.1 为什么没有 `.env` 启动配置？

因为这是前端直连模式，Gemini API Key 通过界面输入并保存在浏览器本地，而不是通过 Vite 环境变量读取。

### 15.2 为什么研究和写作要拆成这么多阶段？

这是刻意设计。它牺牲了一点速度，换来更稳的结构、更高的信息密度和更强的可控性。

### 15.3 为什么既有正文 PDF，又有纯文字 PDF？

两者用途不同：

- 正文 PDF：保留页面视觉效果
- 纯文字 PDF：强调排版稳定和文字阅读

### 15.4 Humanizer 是怎么接入的？

当前接入的是“商业文章适配版”去AI化规则，不是把原始 Humanizer 全量人格化风格直接照搬进终稿。

## 16. 编码与文本要求

- 全仓文本文件统一使用 `UTF-8`
- 不要混入 `GBK` / `ANSI`
- PowerShell 中看到中文乱码时，优先检查终端编码，不要先判断成文件损坏

## 17. 相关文档

- [USER_MANUAL.md](./USER_MANUAL.md)
- [portfolio-docs/README.md](./portfolio-docs/README.md)

## 18. 发布建议

如果你准备把这个项目继续往生产环境推进，建议优先做这三件事：

1. 把 Gemini API 调用迁移到服务端代理
2. 把 Deep Research 彻底后端化
3. 为终审和导出链路补齐自动化回归测试
