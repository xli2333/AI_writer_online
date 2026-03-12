# AI Writer 云端部署文档（Vercel 前端 + Render 后端）

文档编码要求：`UTF-8（无 BOM）`

请不要用 ANSI、GBK、UTF-16 重新保存本文件，否则中文在部分终端和编辑器里会出现乱码。

---

## 1. 文档目的

这份文档用于把当前仓库稳定部署到：

- 前端：`Vercel`
- 后端：`Render Web Service`
- 后端运行时持久化：`Render Persistent Disk`

目标不是“能跑一次”，而是：

- 前后端分离部署
- 前端稳定访问后端 API
- 生图结果、manifest、运行时图片不因 Render 重启而丢失
- ZIP 导出、图片展示、公众号预览都能正常工作
- 部署配置后续可以重复复用

---

## 2. 当前项目的真实架构

当前仓库不是一个纯静态前端项目，也不是一个完全后端托管的 AI 平台，而是一个“混合架构”：

1. 前端是 React + Vite，适合部署到 Vercel。
2. 后端是常驻 Node 服务，负责：
   - 风格库和 prompt 资产读取
   - 参考模板目录与全文读取
   - 配图生成
   - 图释重生成
   - 公众号预览 / 草稿 / 发布相关接口
   - 生成图片静态资源服务
3. 写作主链当前仍然是前端 BYOK：
   - 用户在浏览器输入 Gemini API Key
   - 浏览器直接调用 Gemini 完成写作主链
4. 因此，这一版部署是：
   - “前端独立部署 + 后端独立部署”
   - 但不是“所有模型调用都收回后端”

这点必须明确，因为它决定了部署后的行为边界：

- 写作功能：仍需要用户在前端输入自己的 Gemini Key
- 配图和公众号相关功能：走后端
- Prompt 资产：当前仍会有一部分通过后端接口进入浏览器运行时

如果你以后要做“严格企业版”，那是下一轮架构改造，不是这份部署文档的范围。

---

## 3. 推荐部署拓扑

推荐拓扑如下：

```text
用户浏览器
   |
   | HTTPS
   v
Vercel Frontend
   |
   | HTTPS API / generated-assets
   v
Render Backend Web Service
   |
   | 本地持久盘
   v
Render Persistent Disk (/var/data)
```

职责划分：

- `Vercel`
  - 只托管前端静态产物 `dist`
  - 通过环境变量指向 Render 后端
- `Render`
  - 运行 Node 后端
  - 提供 `/api/*`
  - 提供 `/generated-assets/*`
  - 读写持久化图片与运行时文件

---

## 4. 这次已经处理好的部署问题

当前仓库已经针对 Vercel + Render 做了下面这些修正：

1. 后端默认监听 `0.0.0.0`
2. 后端优先读取 Render 注入的 `PORT`
3. 前端支持通过 `VITE_BACKEND_ORIGIN` 指向独立后端
4. 前后端分域后，`/generated-assets/*` 的图片地址会自动解析到后端域名
5. ZIP 导出下载图片时也会走正确的后端资源地址
6. Render 挂持久盘后：
   - 生图模块会写到持久盘
   - 公众号预览读取图片也会从同一持久盘读取

已经对齐的关键文件：

- 后端入口：[server/index.mjs](C:/Users/LXG/AI_writer/server/index.mjs)
- 配图服务：[server/articleIllustrationService.mjs](C:/Users/LXG/AI_writer/server/articleIllustrationService.mjs)
- 公众号服务：[server/wechatOfficialPublisherService.mjs](C:/Users/LXG/AI_writer/server/wechatOfficialPublisherService.mjs)
- 前端运行时地址解析：[services/runtimeConfig.ts](C:/Users/LXG/AI_writer/services/runtimeConfig.ts)
- Render 蓝图：[render.yaml](C:/Users/LXG/AI_writer/render.yaml)

---

## 5. 部署前准备

正式部署前，请先确认以下事项：

### 5.1 GitHub 仓库状态

确保你要部署的仓库分支已经包含：

- 前端代码
- 后端代码
- `rag_assets`
- `style_corpora`
- `render.yaml`
- `vercel.json`

不要把下面这些本地原始抓取目录当成部署必需品：

- `虎嗅APP/`
- `华尔街见闻/`

它们不是线上运行必须文件，不需要进入 Render 的运行镜像。

### 5.2 Node 版本

要求：

- `Node.js >= 20`

Render 上建议固定：

- `NODE_VERSION=20`

### 5.3 第三方账号

你需要准备：

- 一个 Vercel 账号
- 一个 Render 账号
- 一个 GitHub 仓库访问权限

如果要启用公众号发布能力，还需要：

- 微信公众号 AppID / AppSecret

---

## 6. 环境变量总表

下面按“必须 / 可选”分开写。

### 6.1 Vercel 必须环境变量

#### `VITE_BACKEND_ORIGIN`

作用：

- 告诉前端后端 API 的真实地址
- 告诉前端生图静态资源 `/generated-assets/*` 应该从哪里加载

示例：

```bash
VITE_BACKEND_ORIGIN=https://your-backend-name.onrender.com
```

如果你后面给 Render 绑了自定义域名，比如：

```bash
VITE_BACKEND_ORIGIN=https://api.yourdomain.com
```

### 6.2 Render 必须环境变量

#### `BACKEND_HOST`

固定写：

```bash
BACKEND_HOST=0.0.0.0
```

#### `GENERATED_ASSET_ROOT`

固定写：

```bash
GENERATED_ASSET_ROOT=/var/data/generated_assets
```

作用：

- 所有生成图片
- 图片 manifest
- 版本切换后的图片文件

都会写到 Render 持久盘路径下，而不是写到临时文件系统。

#### `NODE_VERSION`

建议：

```bash
NODE_VERSION=20
```

### 6.3 Render 自动提供，无需手填

#### `PORT`

Render 会自动注入，不用自己手填。

当前后端代码已经支持优先读取：

1. `PORT`
2. `BACKEND_PORT`
3. 默认 `8787`

### 6.4 微信公众号功能可选环境变量

如果你要开公众号功能，再配这些：

```bash
WECHAT_OFFICIAL_APP_ID=你的公众号AppID
WECHAT_OFFICIAL_APP_SECRET=你的公众号AppSecret
WECHAT_OFFICIAL_ENABLE_PUBLISH=1
```

可选补充项：

```bash
WECHAT_OFFICIAL_DEFAULT_AUTHOR=AI Writer
WECHAT_OFFICIAL_DEFAULT_SOURCE_URL=https://yourdomain.com
```

### 6.5 网络代理可选环境变量

如果你的 Render 环境需要走代理访问外部网络，再配：

```bash
HTTPS_PROXY=...
HTTP_PROXY=...
```

### 6.6 生图调试可选环境变量

仅本地调试或测试环境可用：

```bash
ILLUSTRATION_PROVIDER=mock
MOCK_NANOBANANA=1
```

生产环境不要开。

---

## 7. Render 部署步骤

推荐直接使用仓库里的 [render.yaml](C:/Users/LXG/AI_writer/render.yaml)。

### 7.1 创建方式

两种都可以：

1. 在 Render 里 `New + Blueprint`，直接读取仓库根目录的 `render.yaml`
2. 手动创建 `Web Service`，然后按本文档逐项配置

推荐方式：

- `Blueprint`

因为后面你重新部署或迁移仓库时更稳定。

### 7.2 Render 服务推荐配置

服务类型：

- `Web Service`

Runtime：

- `Node`

Root Directory：

- `.`

Build Command：

```bash
npm ci
```

Start Command：

```bash
npm run server:start
```

Health Check Path：

```text
/api/health
```

### 7.3 Render 磁盘配置

必须加 `Persistent Disk`。

建议：

- Mount Path：`/var/data`
- 容量：至少 `10GB`

如果你后面会大量生图，建议直接上：

- `20GB` 或更高

原因：

- 生成图片会累计
- 图片版本切换会保留多个版本
- manifest 和相关运行文件也在同一目录

### 7.4 Render 环境变量填写

至少填：

```bash
NODE_VERSION=20
BACKEND_HOST=0.0.0.0
GENERATED_ASSET_ROOT=/var/data/generated_assets
```

如果开公众号，再补：

```bash
WECHAT_OFFICIAL_APP_ID=...
WECHAT_OFFICIAL_APP_SECRET=...
WECHAT_OFFICIAL_ENABLE_PUBLISH=1
```

### 7.5 Render 首次部署后检查

部署完成后，先访问：

```text
https://你的-render-域名/api/health
```

预期返回：

```json
{"ok":true}
```

如果这里不通，不要继续配 Vercel，先把 Render 修好。

---

## 8. Vercel 部署步骤

### 8.1 创建项目

在 Vercel 中导入 GitHub 仓库。

项目设置：

- Framework Preset：`Vite`
- Build Command：`npm run build`
- Output Directory：`dist`

仓库里已有 [vercel.json](C:/Users/LXG/AI_writer/vercel.json)，可以继续沿用。

### 8.2 Vercel 环境变量

必须添加：

```bash
VITE_BACKEND_ORIGIN=https://你的-render-域名
```

注意：

- 一定要写完整协议头 `https://`
- 不要带结尾 `/`

正确示例：

```bash
https://your-backend-name.onrender.com
```

错误示例：

```bash
your-backend-name.onrender.com
https://your-backend-name.onrender.com/
http://127.0.0.1:8787
```

### 8.3 重新部署

设置完环境变量后，必须重新部署一次前端。

否则前端构建产物仍然会保留旧地址。

---

## 9. 自定义域名建议

推荐最终域名结构：

- 前端：`app.yourdomain.com`
- 后端：`api.yourdomain.com`

优点：

- 职责清晰
- 便于后续做网关和权限收口
- 更容易定位是前端问题还是后端问题

如果你启用自定义域名，记得同步更新：

- Vercel：`VITE_BACKEND_ORIGIN`

---

## 10. 持久化目录说明

### 10.1 当前需要持久化的核心目录

当前运行时真正需要落到持久盘的是：

- `/var/data/generated_assets`

这对应仓库本地开发时的：

- `generated_assets/`

### 10.2 为什么必须持久化

如果不用持久盘，Render 重启或重新部署后会丢失：

- 已生成图片
- 图片版本文件
- 图片 manifest

直接后果：

- 页面里的旧图会失效
- ZIP 导出里的图片会下载失败
- 公众号预览引用本地图时会失败

### 10.3 当前已统一的路径逻辑

现在以下模块已经统一使用 `GENERATED_ASSET_ROOT`：

- 后端静态资源服务
- 配图服务
- 公众号服务

所以只要这个环境变量和 Render 挂盘路径一致，就不会出现“生图写到 A，公众号去 B 目录找图”的问题。

---

## 11. 上线顺序

正确顺序如下：

1. 先部署 Render
2. 验证 `/api/health`
3. 再部署 Vercel
4. 设置 `VITE_BACKEND_ORIGIN`
5. 重新部署 Vercel
6. 做完整验收

不要反过来。

如果你先部署 Vercel，而后端还没通：

- 前端会直接请求失败
- 风格库和参考模板都加载不出来
- 生图也会失败

---

## 12. 完整验收清单

部署完成后，请按下面顺序验收。

### 12.1 后端健康检查

访问：

```text
GET /api/health
```

预期：

- HTTP 200
- 返回 `{"ok":true}`

### 12.2 风格库接口

访问：

```text
GET /api/content/style-profiles
```

预期：

- 正常返回风格库列表
- 至少能看到你当前接入的 profile

### 12.3 Persona 状态接口

访问：

```text
GET /api/content/persona-status?profile=huxiu
```

以及：

```text
GET /api/content/persona-status?profile=wallstreetcn
```

预期：

- 返回版本号
- 返回主人格样本数
- 返回子人格列表

### 12.4 参考模板目录接口

访问：

```text
GET /api/reference-templates/catalog?profile=wallstreetcn
```

预期：

- 返回模板目录

### 12.5 前端页面基础检查

打开前端页面后检查：

- 页面能正常加载
- 风格库列表能正常切换
- 参考模板目录能正常加载
- Persona 状态能正常显示

### 12.6 配图链路检查

使用一篇现成文章测试：

1. 生成 1 到 2 张图
2. 等待完成
3. 检查图片是否显示
4. 检查刷新页面后图片是否仍能显示

如果刷新后图消失，优先检查：

- Render 持久盘是否配置
- `GENERATED_ASSET_ROOT` 是否正确
- 前端 `VITE_BACKEND_ORIGIN` 是否正确

### 12.7 ZIP 导出检查

执行文章导出，确认：

- 正文文件存在
- 教学笔记文件存在
- 图片文件成功打包

### 12.8 微信预览检查

如果启用了公众号功能，再测试：

- 预览接口是否正常
- 预览图是否正常读到生成图

---

## 13. 常见故障排查

### 13.1 前端加载后所有接口都报错

常见原因：

- `VITE_BACKEND_ORIGIN` 没配
- 配了但没重新部署 Vercel
- 写成了错误域名

排查方法：

1. 打开浏览器开发者工具
2. 看请求是不是还在打当前前端域名的 `/api/*`
3. 确认构建后的前端是否已经指向 Render 域名

### 13.2 Render 服务启动失败

常见原因：

- 没有监听 `0.0.0.0`
- 没读取 `PORT`
- Node 版本过低

当前代码已处理 `0.0.0.0` 和 `PORT`，如果还失败，优先检查：

- Render 日志
- `NODE_VERSION=20`

### 13.3 图片生成了，但前端不显示

常见原因：

- `VITE_BACKEND_ORIGIN` 错
- 图片 URL 解析到了错误域名
- 后端持久盘没挂好
- 图片实际没写到 `GENERATED_ASSET_ROOT`

排查顺序：

1. 看浏览器 Network 中图片请求地址
2. 确认地址是否是 Render 域名
3. 确认请求路径是否以 `/generated-assets/` 开头
4. 看 Render 日志有没有 404

### 13.4 刷新页面后旧图失效

常见原因：

- 没用持久盘
- Render 重启后临时文件系统清空

解决：

- 确保 Render 使用 `Persistent Disk`
- 确保 `GENERATED_ASSET_ROOT=/var/data/generated_assets`

### 13.5 微信预览里图片读不到

常见原因：

- 公众号服务读图目录和生图目录不一致

当前这点已修复，但前提是你必须正确设置：

```bash
GENERATED_ASSET_ROOT=/var/data/generated_assets
```

### 13.6 前端构建成功，但页面白屏

常见原因：

- 某个运行时请求失败导致初始化中断
- 环境变量没生效

优先检查：

- 浏览器 Console
- 浏览器 Network

### 13.7 Render 上长任务超时或卡住

项目特点决定了部分任务很长：

- 配图
- 图释
- Deep Research
- 长文写作某些阶段

当前已经把 Node 侧超时拉长，但这依然是“长请求模型”，不是消息队列模型。

如果以后你发现：

- 高并发不稳
- 长任务挤占 Web Service
- 响应时间过长

下一步应该做的是：

- Web Service + Queue + Worker 分离

不是单纯继续加超时时间。

---

## 14. 安全与边界说明

这版部署的安全边界如下：

### 14.1 已经做到的

- 前端与后端可以分域部署
- 生成图文件不会直接暴露整个仓库
- 后端只静态暴露：
  - `dist`
  - `generated-assets`

### 14.2 还没有做到的

- 写作主链并没有完全托管在后端
- 用户 Gemini API Key 仍在浏览器会话里使用
- Prompt 资产当前仍可能通过接口进入浏览器运行时

所以这不是一个“企业级密钥托管”和“提示词完全后端封装”的版本。

如果你以后要做到：

- 平台统一付费
- 后端托管 API Key
- Prompt 完全不下发到前端
- 更严格的权限控制

需要单独做一轮后端化改造。

---

## 15. 版本回滚建议

如果线上部署后出问题，建议按下面顺序回滚：

1. 先回滚 Vercel 到上一版
2. 如果问题仍在，再回滚 Render 到上一版
3. 不要第一时间删除持久盘

因为很多问题并不是磁盘数据坏了，而是：

- 前端地址指错
- 构建变量未生效
- 新代码和旧静态资源不匹配

---

## 16. 日常运维建议

### 16.1 日志

重点看：

- Render Runtime Logs
- 浏览器 Network
- 浏览器 Console

### 16.2 磁盘空间

需要定期关注：

- `/var/data/generated_assets`

如果长期生图很多，磁盘会持续增长。

### 16.3 重新部署顺序

如果同时改了前后端：

1. 先发后端
2. 验证后端健康接口
3. 再发前端

### 16.4 不要做的事

- 不要把 `VITE_BACKEND_ORIGIN` 留空
- 不要把 Render 临时文件系统当持久存储
- 不要把调试用 mock 生图环境变量开到生产
- 不要手工改出一个与 `GENERATED_ASSET_ROOT` 不一致的图片目录

---

## 17. 最终推荐配置清单

### 17.1 Vercel

- Framework Preset: `Vite`
- Build Command: `npm run build`
- Output Directory: `dist`
- Env:
  - `VITE_BACKEND_ORIGIN=https://your-backend-name.onrender.com`

### 17.2 Render

- Service Type: `Web Service`
- Runtime: `Node`
- Build Command: `npm ci`
- Start Command: `npm run server:start`
- Health Check Path: `/api/health`
- Disk:
  - Mount Path: `/var/data`
  - Size: `10GB` 起步
- Env:
  - `NODE_VERSION=20`
  - `BACKEND_HOST=0.0.0.0`
  - `GENERATED_ASSET_ROOT=/var/data/generated_assets`

### 17.3 可选公众号环境变量

- `WECHAT_OFFICIAL_APP_ID`
- `WECHAT_OFFICIAL_APP_SECRET`
- `WECHAT_OFFICIAL_ENABLE_PUBLISH=1`
- `WECHAT_OFFICIAL_DEFAULT_AUTHOR`
- `WECHAT_OFFICIAL_DEFAULT_SOURCE_URL`

---

## 18. 文档更新约定

如果后续发生下面任一变化，这份文档必须同步更新：

1. 前端不再 BYOK，写作主链收回后端
2. `generated_assets` 持久化路径变化
3. Render 服务拆成 `web + worker`
4. 公众号功能的密钥配置项变化
5. 前端不再通过 `VITE_BACKEND_ORIGIN` 指向后端

---

## 19. 当前可直接使用的文件

本仓库中与你这次部署直接相关的文件如下：

- 详细部署文档：
  [DEPLOYMENT_VERCEL_RENDER_DETAILED_ZH.md](C:/Users/LXG/AI_writer/DEPLOYMENT_VERCEL_RENDER_DETAILED_ZH.md)
- 简版部署文档：
  [DEPLOYMENT_VERCEL_RENDER.md](C:/Users/LXG/AI_writer/DEPLOYMENT_VERCEL_RENDER.md)
- Render 蓝图：
  [render.yaml](C:/Users/LXG/AI_writer/render.yaml)
- Vercel 配置：
  [vercel.json](C:/Users/LXG/AI_writer/vercel.json)

如果你只看一份，请看这份详细版。
