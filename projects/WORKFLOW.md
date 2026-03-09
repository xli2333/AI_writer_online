# 文档生产工作流（SOP）| Documentation Workflow SOP

Last Updated: `2026-03-04`  
Standard Version: `v2.0`  
Scope: `project/` 与 `project/final-delivery/` 文档生产与交付

## 1. 文档职责边界 | Documentation Boundaries

### README（项目级主文档）

- 目标：回答“产品是什么、如何运行、如何部署、如何维护”。
- 受众：开发、产品、交接人、维护者。
- 必含内容：定位、能力、架构、运行方式、部署参数、排障入口。
- 强制规则：一个交付目录只允许一个 `README.md`。
- 禁止写法：把 README 写成截图图册或逐步操作教程。

### MANUAL（用户操作手册）

- 目标：回答“用户如何按步骤完成任务”。
- 受众：最终用户、运营、培训、测试。
- 必含内容：步骤截图、动作指令、成功判定、常见错误。
- 写作模板：每步必须包含“看到什么 / 做什么 / 价值是什么”。
- 禁止写法：只贴图不解释，或只讲原理不讲操作。

### WORKFLOW（可复用生产 SOP）

- 目标：回答“如何在其他项目复刻同样交付过程”。
- 受众：文档生产者、自动化脚本维护者、项目经理。
- 必含内容：输入输出契约、命名规范、编码规范、质量门禁、更新策略。
- 禁止写法：混入产品功能介绍或需求评审内容。

## 2. 输入/输出契约 | Input and Output Contract

### 输入（Input）

1. 项目路径或线上地址。
2. 可登录账号（如需）。
3. 截图原始集（覆盖完整任务旅程）。
4. 当前版本信息（分支、提交号、更新日期）。
5. 最新评审意见（commit 评论或交付反馈）。

### 输出（Output）

1. `README.md`（唯一主文档）。
2. `MANUAL.md`（截图驱动手册）。
3. `WORKFLOW.md`（生产标准）。
4. `manual-catalog.json`（步骤-截图结构化映射）。
5. `screenshots/Uxx-*.png`（语义命名截图）。
6. `DELIVERY_NOTE.md`（交付摘要和验证记录）。

## 3. 命名与编码规范 | Naming and Encoding Standard

### 文件命名

1. 截图命名：`U01-meaningful-name.png` 到 `U99-meaningful-name.png`。
2. 禁止无语义命名：如 `IMG_001.png`、`截图(1).png`。
3. 文档命名稳定：`README.md`、`MANUAL.md`、`WORKFLOW.md`、`DELIVERY_NOTE.md`。

### 编码规范

1. Markdown/JSON 统一使用 `UTF-8`。
2. 发布前必须抽查中文段落，确认无乱码字符。
3. Windows 环境出现乱码时，以 `UTF-8` 重新读取和写回。

## 4. 文案规范 | Writing Standard

1. 使用可验证陈述，不写空泛结论。
2. 术语在 `README / MANUAL / WORKFLOW` 三文档中保持一致。
3. 中文优先，可附英文等价标题，不强制整段双语。
4. 避免相对时间词，统一绝对日期。

## 5. 可复用生产流水线 | Reproducible Pipeline

1. 收集并初筛截图，去重并保留高质量版本。
2. 按用户旅程排序并重命名为 `Uxx-*.png`。
3. 生成或更新 `manual-catalog.json`。
4. 编写或更新 `MANUAL.md`（三段式步骤）。
5. 编写或更新 `README.md`（项目级信息，单 README）。
6. 编写或更新 `WORKFLOW.md`（本 SOP）。
7. 执行构建验证（如 `npm run build`）并写入 `DELIVERY_NOTE.md`。
8. 提交前执行安全检查，确认无敏感信息入库。

## 6. 质量门禁 | Release Gates

发布前必须全部满足：

1. `README.md` 可独立解释系统，不依赖 `MANUAL.md`。
2. `MANUAL.md` 每一步有截图且可复现操作。
3. `WORKFLOW.md` 可指导新项目完整复刻流程。
4. 仅保留一个 `README.md`，不存在 `README2.md`/`README_CN.md` 并行主文档。
5. 所有中文文档无乱码，编码为 `UTF-8`。
6. `*.env`、凭证 CSV、云密钥未被暂存/提交。
7. 链接可点开、编号连续、术语一致。

## 7. 安全与合规门禁 | Security Gate

1. 禁止提交含真实密钥的文件（如 `.env`、`render-environment-variables.*`）。
2. 若历史中出现过密钥，必须立即轮换后再继续发布。
3. 提交时优先使用白名单式 `git add <file>`，避免误提交敏感文件。

## 8. 更新策略 | Update Strategy

1. 功能或架构变化：先更新 `README.md`。
2. 用户路径变化：同步更新 `MANUAL.md` + `manual-catalog.json` + 截图。
3. 流程或门禁变化：同步更新两份 `WORKFLOW.md`（`project/` 与 `final-delivery/`）。
4. 每次更新写入绝对日期和版本号（例如 `2026-03-04 / v2.0`）。

## 9. 当前标准目录 | Standard Delivery Structure

```text
final-delivery/
├─ README.md
├─ MANUAL.md
├─ WORKFLOW.md
├─ DELIVERY_NOTE.md
├─ manual-catalog.json
└─ screenshots/
   ├─ U01-*.png
   ├─ ...
   └─ U22-*.png
```
