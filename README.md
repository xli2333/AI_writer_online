# Writing Workspace

面向商业文章写作的前端工作台。当前主流程是：

`选题 -> 搜索研究 -> 整理资料 -> 选择讨论方向 -> 审阅大纲 -> 分段成文 -> 审查 -> 导出`

项目保留了原先“先研究、再判断、再生成、再审稿”的骨架，但输出对象已经切换为商业文章。TN / 讨论指南仍然保留，不过由用户在任务启动时自行决定是否生成。

## 当前能力

- 多源研究：网页搜索 + 本地资料上传
- 方向选择：先生成 5 个讨论方向，再由用户决定切口
- 大纲审阅：支持全局反馈和选区微调
- 长文写作：按约 1500 字一轮分段生成，再续写拼接
- 审稿收束：先出审稿意见，再生成终稿
- 可选 TN：按任务配置输出讨论指南
- 编辑闭环：支持 Copilot、局部改写、终稿清洗
- 导出：正文 Markdown / PDF，TN PDF

## 仓库结构

```text
App.tsx
components/
  ApiKeyInput.tsx
  ArticleViewer.tsx
  DirectionSelection.tsx
  MarkdownRenderer.tsx
  OutlineReview.tsx
  SelectionMenu.tsx
  SettingsModal.tsx
  WritingCopilot.tsx
services/
  geminiService.ts
  promptAssets.ts
rag_assets/
  global/
  workflows/
scripts/rag/
```

## Prompt 资产

当前写作约束不再硬编码在大型 TS 字符串里，而是桥接到项目内的 Markdown 资产：

- `rag_assets/global/core_writing_skills.md`
- `rag_assets/global/universal_prompt.md`
- `rag_assets/workflows/ai_writing_workflow.md`
- `rag_assets/workflows/task_brief_template.md`

运行时通过 `?raw` 导入，代码只负责拼装。

## 长文写作机制

- 用户设置目标字数，例如 `3000`
- 系统按单轮目标字数，例如 `1500`，生成 chunk plan
- 每一轮只负责指定章节
- 下一轮会拿到前文正文和剩余计划，只继续未完成部分
- 全部 chunk 合并后，进入审稿和终稿改写

这比单次直出更稳，也更容易控制结构和重复。

## 本地 RAG 资产

仓库里已经包含一套离线 RAG 处理脚本，用于从历史文章中沉淀写作资产：

- `npm run rag:prepare`
- `npm run rag:analyze`
- `npm run rag:skills`
- `npm run rag:task`

相关产物位于：

- `rag_assets/global/`
- `rag_assets/metadata/`
- `rag_assets/cache/current_task/`

前端工作台目前直接使用全局 prompt 资产；批处理、语料标注和离线分析仍由 `scripts/rag/` 负责。

## 运行方式

```bash
npm install
npm run dev
```

构建：

```bash
npm run build
```

## 任务配置

首页可直接配置：

- 文体
- 风格
- 目标受众
- 文章目标
- 目标字数
- 单轮写作长度
- 是否生成 TN / 讨论指南

## 编码要求

- 全仓文本文件统一使用 `UTF-8`
- Markdown / JSON / CSV / TXT 不使用 `GBK` 或 `ANSI`
- Windows 终端如出现乱码，优先检查控制台编码，而不是误判文件损坏

## 当前文档入口

- 用户手册：[`USER_MANUAL.md`](USER_MANUAL.md)
- 作品集说明：[`portfolio-docs/README.md`](portfolio-docs/README.md)
