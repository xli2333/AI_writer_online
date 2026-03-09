# 晚点 LatePost 风格库接入与双风格库改造工作报告

本文档编码：UTF-8（无 BOM）  
编写日期：2026-03-09  
项目目录：`C:\Users\LXG\AI_writer`

## 一、工作背景

本次工作的目标不是重写现有写作流程，而是在保持当前写作链路不变的前提下，完成以下三件核心事情：

1. 将 `晚点LatePost` 作为独立于复旦商业文章（FDSM）的第二套风格库接入系统。
2. 将 `晚点LatePost` 按照与 FDSM 相同的标准完成清洗、结构化分析、主人格提炼与自进化闭环。
3. 调整前后端，使用户在实际使用时可以直接选择两种独立风格，并且运行时继续保持用户自带 Gemini Key 的机制。

本次改造严格遵守以下边界：

1. 不改动现有写作链路的阶段设计。
2. 不增加人工审核步骤。
3. 运行时仍然是用户输入自己的 Gemini API Key。
4. 构建期离线分析与人格演化只使用 Flash 系列模型。
5. 文章总字数不再由系统默认限制，只在用户明确输入时才约束。

## 二、总体结论

本次改造已经完成，结果如下：

1. 系统已从“单风格库”升级为“多风格库”架构。
2. `FDSM` 与 `LatePost` 已成为两套并行、独立、可切换的风格库。
3. `LatePost` 已完成语料清洗、年份归档、全文标准化、文章基因分析、软文标签识别、主人格生成与自进化评测。
4. 前端已新增“风格库”入口，用户可在“复旦商业文章”和“晚点 LatePost”之间切换。
5. 后端已按风格库返回不同的 prompt 资产、不同的参考库 catalog、不同的全文。
6. 运行时仍保留原有模型选择逻辑与 BYOK 机制。
7. 默认总字数限制已移除，字数只由用户显式输入控制。

## 三、完成的核心工作

## 3.1 多风格库架构改造

新增统一风格库配置文件：

- `config/styleProfiles.js`

该文件定义了两套公开风格库：

- `fdsm`
- `latepost`

每个风格库拥有独立的：

- 原文目录
- RAG 目录
- metadata 目录
- summaries 目录
- persona 目录
- evals 目录
- runtime 主人格目录

这意味着系统不再把 `raw_materials`、`article_tags.jsonl`、`master_persona.md` 等资源写死为单一来源。

## 3.2 后端按风格库提供内容

改造文件：

- `server/index.mjs`

新增与调整能力：

1. 新增 `/api/content/style-profiles`
2. `/api/content/prompt-assets` 支持 `profile` 参数
3. `/api/reference-templates/catalog` 支持 `profile` 参数
4. `/api/reference-templates/full-text` 支持 `profile` 参数
5. 后端会根据 `profile` 返回对应风格库的人格、参考文章与全文

当前实际效果：

- `profile=fdsm` 读取复旦商业文章资产
- `profile=latepost` 读取晚点资产

## 3.3 前端风格库选择接入

改造文件：

- `App.tsx`
- `types.ts`
- `services/backendContentService.ts`
- `services/referenceTemplateService.ts`
- `services/geminiService.ts`

完成内容：

1. `WritingTaskOptions` 新增 `styleProfile`
2. 前端界面新增“风格库”选择项
3. 风格库可选：
   - 复旦商业文章
   - 晚点 LatePost
4. 前端会按所选风格库拉取：
   - 对应 `master_persona`
   - 对应参考文章 catalog
   - 对应全文
5. 运行时 prompt 与参考库已经真正实现“按风格库切换”

## 3.4 默认字数限制移除

改造点：

- `App.tsx`
- `services/geminiService.ts`
- `services/promptAssets.ts`
- `scripts/rag/evaluate-persona.mjs`

调整结果：

1. 默认 `desiredLength` 由 `3000` 改为 `0`
2. 前端“目标字数”输入框支持留空
3. 留空时表示“不限定总字数”
4. 系统只在用户明确填写时才把字数写入任务 brief
5. 离线评测时也不再强制固定字数区间，优先遵循任务本身

注意：

- `chunkLength` 仍保留，用于维持现有分段写作机制的稳定性
- 当用户未指定总字数时，系统只把分段长度当作软参考，而不是硬性总篇幅约束

## 四、LatePost 语料处理工作

## 4.1 原始语料结构问题

`晚点LatePost` 原始目录的特点是：

1. 以月份目录组织，如 `2023-01`、`2024-01`
2. 每篇文章是一个独立子目录
3. 子目录中包含：
   - `content.txt`
   - 多张图片文件，如 `image_1.jpg`、`image_2.png`

这与 FDSM 的“按年份直存 txt 文件”结构不同，无法直接复用原链路。

## 4.2 LatePost 清洗与标准化

新增脚本：

- `scripts/rag/import-latepost-corpus.mjs`

执行逻辑：

1. 扫描 `晚点LatePost` 原始目录
2. 仅提取每篇目录中的 `content.txt`
3. 忽略所有图片文件
4. 将正文统一写入 `style_corpora/latepost/raw_materials/<year>/`
5. 生成导入 manifest 与 summary
6. 同步复制 workflow 与 benchmark 资产到 LatePost 独立目录

导入结果：

- 导入正文：1134 篇
- 忽略图片：10529 张
- 缺失 `content.txt`：2 篇
- 空正文：0 篇

输出文件：

- `rag_assets/profiles/latepost/metadata/latepost_import_manifest.jsonl`
- `rag_assets/profiles/latepost/metadata/latepost_import_summary.json`

## 五、LatePost 文章分析与标签系统

## 5.1 分析链路

复用并扩展原有分析脚本：

- `scripts/rag/analyze-articles.mjs`
- `scripts/rag/shared.mjs`

分析模型：

- 使用 Flash 系列实际可用接口：`gemini-3-flash-preview`

说明：

在 2026-03-09 的实际 API 验证中，裸模型名 `gemini-3-flash` 返回 404，因此构建期离线处理统一使用可用的 Flash 族接口名 `gemini-3-flash-preview`。

## 5.2 article_genome v2 扩展字段

本次分析不仅保留了原有摘要标签，还新增了写作机制和软文识别能力，包括：

- `entities`
- `primary_question`
- `thesis_type`
- `thesis_sentence`
- `section_functions`
- `argument_moves`
- `evidence_types`
- `transferable_moves`
- `anti_patterns`
- 各分项评分
- `is_advertorial`
- `advertorial_confidence`
- `advertorial_signals`

## 5.3 广告软文识别

本次特别加入了“广告软文/品牌宣传稿”识别机制。

判断目标包括但不限于：

- 品牌合作稿
- 产品背书稿
- 招商宣传稿
- 定向传播稿
- 带有强烈品牌公关色彩的“采访/报道”

处理原则：

1. 打标签但不删除正文文件
2. 默认不进入参考模板检索
3. 默认不进入主人格提炼
4. 默认不进入 rule cards 和人格自进化链路

LatePost 全量分析后标签分布如下：

- 总文章数：1134
- 软文/宣传稿：287
- 低价值文章：24
- 活动通知类：6

说明：

软文识别本质上仍然是模型判断，边界样本可能存在争议，但当前系统已经能将其与高价值样本分流，避免污染风格库。

## 5.4 全量分析结果

全量执行结果：

- 处理文章：1134 / 1134
- 失败：0
- 并发：6
- API Key 数量：6

输出文件：

- `rag_assets/profiles/latepost/summaries/per_article/*.summary.json`
- `rag_assets/profiles/latepost/metadata/article_tags.jsonl`
- `rag_assets/profiles/latepost/metadata/analyze_summary.json`

## 六、LatePost 主人格与自进化机制

## 6.1 主人格生成

使用脚本：

- `scripts/rag/build-master-persona.mjs`

当前生成的人格文件：

- `rag_assets/profiles/latepost/global/runtime/master_persona.md`

该人格已体现出明显的 LatePost 风格特征：

1. 强调商业深度报道视角
2. 强调底层经营逻辑与组织博弈
3. 强调反公关辞令
4. 强调中距离叙事
5. 强调“为什么发生”和“会走向何处”

## 6.2 自进化闭环

已完成的脚本：

- `scripts/rag/build-rule-cards.mjs`
- `scripts/rag/build-persona-patches.mjs`
- `scripts/rag/evaluate-persona.mjs`
- `scripts/rag/apply-persona-patch.mjs`
- `scripts/rag/run-evolution-cycle.mjs`

LatePost 本次自进化已实际跑通。

结果：

- rule cards 总数：12168
- 评测任务数：6
- patch 胜率：0.5
- 评测结论：通过
- patch 已应用到当前 LatePost 主人格

输出文件：

- `rag_assets/profiles/latepost/persona/rule_cards.jsonl`
- `rag_assets/profiles/latepost/persona/rule_cards.summary.json`
- `rag_assets/profiles/latepost/persona/latest_patch.md`
- `rag_assets/profiles/latepost/persona/persona_patches.jsonl`
- `rag_assets/profiles/latepost/evals/reports/latest.json`

## 七、测试与验证结果

## 7.1 前端构建测试

执行：

- `npm run build`

结果：

- 通过

## 7.2 后端健康检查

验证接口：

- `/api/health`

结果：

- 返回 `{"ok": true}`

## 7.3 风格库列表验证

验证接口：

- `/api/content/style-profiles`

结果：

- 正确返回 `fdsm` 与 `latepost` 两套风格库

## 7.4 Prompt 资产按风格库分流验证

验证：

- `profile=fdsm` 的 `masterPersona`
- `profile=latepost` 的 `masterPersona`

结果：

- 两者内容确认不同
- 说明运行时人格已按风格库分流

## 7.5 Catalog 分流验证

验证结果：

- `fdsm` catalog 数量：1193
- `latepost` catalog 数量：1134

说明：

- 两套风格库的参考文章库已独立

## 7.6 LatePost 全文读取验证

验证：

- 通过 `profile=latepost` 请求全文接口
- 读取《对话李想：大部分企业做产品最大的问题是懒惰》

结果：

- 返回成功
- 正文长度正常

## 八、关键修复记录

本次过程中额外修复了两个关键问题：

1. `advertorial_confidence` 在部分样本中被模型输出为 `0.85`，另一部分输出为 `85`
2. LatePost 主人格文件首次生成时出现字面量 `\n`，导致 Markdown 未被正常换行

处理方式：

1. 在分析写入阶段加入百分制归一化
2. 在人格与 patch 写入阶段加入 Markdown 解码与标准化

## 九、主要新增与修改文件

新增文件：

- `config/styleProfiles.js`
- `scripts/rag/import-latepost-corpus.mjs`
- `portfolio-docs/07-晚点LatePost风格库接入与双风格库改造工作报告.md`

重点修改文件：

- `App.tsx`
- `types.ts`
- `server/index.mjs`
- `services/backendContentService.ts`
- `services/referenceTemplateService.ts`
- `services/geminiService.ts`
- `services/promptAssets.ts`
- `scripts/rag/shared.mjs`
- `scripts/rag/analyze-articles.mjs`
- `scripts/rag/build-master-persona.mjs`
- `scripts/rag/build-rule-cards.mjs`
- `scripts/rag/build-persona-patches.mjs`
- `scripts/rag/evaluate-persona.mjs`
- `scripts/rag/run-evolution-cycle.mjs`
- `package.json`

## 十、当前系统状态

截至本报告生成时，系统已经具备以下能力：

1. 支持两套独立风格库并行运行
2. 支持前端切换风格库
3. 支持后端按风格库返回独立 prompt 和参考库
4. 支持 LatePost 语料的全文检索与全文注入
5. 支持 LatePost 的独立主人格与独立自进化
6. 支持软文/宣传稿标签隔离
7. 支持“用户不填字数就不限制总字数”

## 十一、剩余风险与后续建议

虽然当前目标已完成，但仍有三个现实风险值得记录：

1. 软文识别依赖模型判断，边界样本仍可能误判
2. LatePost 的主人格已经成形，但 benchmark 题集目前仍偏通用商业任务，后续可以加入更贴近报道写作的评测题
3. 当前前端虽然已经能切换风格库，但“风格库”和“文章风格”仍是两个概念，后续可在交互文案上继续区分得更清楚

建议的后续增强方向：

1. 为 `LatePost` 增补更有针对性的 benchmark tasks
2. 为软文识别增加更细的标签，如“品牌合作稿”“高管口径稿”“新品发布稿”
3. 为不同风格库增加单独的反模式黑名单
4. 在前端展示当前风格库对应的人格版本号与最近一次演化时间

## 十二、结论

本次改造已经完成预期目标，并且测试通过。

最终状态可以概括为：

1. `FDSM` 和 `LatePost` 已成为两套独立、并行、可切换的写作风格库。
2. `LatePost` 已经用与 FDSM 对齐的标准完成了清洗、分析、人格构建和自进化。
3. 系统没有改变原有写作链路，但显著提升了风格选择能力、语料隔离能力与最终文章质量控制基础。

