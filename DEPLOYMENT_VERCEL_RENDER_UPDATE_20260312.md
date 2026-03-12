# Vercel + Render 部署补充说明（2026-03-12）

本文是对 [DEPLOYMENT_VERCEL_RENDER.md](C:/Users/LXG/AI_writer/DEPLOYMENT_VERCEL_RENDER.md) 和 [DEPLOYMENT_VERCEL_RENDER_DETAILED_ZH.md](C:/Users/LXG/AI_writer/DEPLOYMENT_VERCEL_RENDER_DETAILED_ZH.md) 的增量修正。

文件编码要求：`UTF-8（无 BOM）`

## 1. 本次变更的核心结论

当前版本的配图链路已经改成：

- 后端不再把新生成的配图长期写入磁盘
- 图片主数据以浏览器会话内可用为目标
- 当前页面可继续上一版 / 下一版、删除当前版、重生单图、重写图释
- 页面刷新后，浏览器会尝试从当前会话下的本地 IndexedDB 恢复配图 bundle
- 关闭当前浏览器会话后，不再保证恢复旧图

因此：

- Render 不再需要为了配图功能强制挂 `Persistent Disk`
- `render.yaml` 已移除磁盘配置
- 旧文档里凡是“配图必须依赖持久盘”“刷新后图片一定还在”“图片版本长期存后端”的描述，均按旧实现处理，不再适用于当前版本

## 2. 当前部署上真正需要知道的点

### 2.1 前端

前端仍然部署在 `Vercel`，并配置：

```bash
VITE_BACKEND_ORIGIN=https://你的-render-域名
```

### 2.2 后端

后端仍然部署在 `Render Web Service`，并至少保证：

```bash
BACKEND_HOST=0.0.0.0
NODE_VERSION=20
```

`PORT` 由 Render 自动注入，无需手填。

### 2.3 不再强制需要的配置

当前版本里，以下配置不是配图链路的必需项：

- `Persistent Disk`
- `GENERATED_ASSET_ROOT=/var/data/generated_assets`

只有在你还要兼容旧的 `/generated-assets/*` 本地静态图地址时，才需要继续保留这一类目录配置。

## 3. 当前配图链路的真实存储方式

### 3.1 后端

后端现在主要保留：

- 生图任务运行中的内存状态
- 短时可查询的 bundle 缓存

它不再把新图作为长期文件资产保存到 Render 磁盘。

### 3.2 浏览器

浏览器现在负责：

- 保留当前文章的配图 bundle
- 保留每个图位的版本栈
- 支持当前会话中的上一版 / 下一版切换
- 支持当前会话内的 ZIP 导出
- 支持把当前会话里的图片直接提交给公众号接口

## 4. 对使用行为的影响

你现在可以继续使用这些能力：

- 生成整组配图
- 单张重生图
- 单张重写图释
- 当前会话里切上一版 / 下一版
- 下载素材包
- 直接推送公众号

但不再保证这些旧行为：

- Render 重启后还能从后端磁盘恢复配图历史
- 隔天重新打开浏览器还能继续翻昨天的旧版本
- 把后端当成长期图片素材库

## 5. 当前建议

如果你的目标是：

- 云端部署轻量
- 不维护后端图片仓库
- 用户生成完就下载或推公众号

那么现在这版实现就是更合适的默认方案。
