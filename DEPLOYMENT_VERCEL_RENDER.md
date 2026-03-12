# Vercel + Render 部署说明

这套仓库按下面方式部署最稳：

- 前端：Vercel
- 后端：Render Web Service
- 生成图片目录：Render Persistent Disk

## 1. Vercel

项目类型：

- Framework Preset: `Vite`
- Build Command: `npm run build`
- Output Directory: `dist`

前端环境变量：

- `VITE_BACKEND_ORIGIN=https://<your-render-service>.onrender.com`

如果你后面给 Render 绑了自定义域名，把这个变量改成你的后端正式域名。

## 2. Render

仓库里已经提供了 [render.yaml](C:/Users/LXG/AI_writer/render.yaml)。

核心配置：

- Build Command: `npm ci`
- Start Command: `npm run server:start`
- Health Check Path: `/api/health`
- Persistent Disk Mount Path: `/var/data`

后端环境变量：

- `BACKEND_HOST=0.0.0.0`
- `GENERATED_ASSET_ROOT=/var/data/generated_assets`

说明：

- 端口不需要手填，Render 会注入 `PORT`
- 后端代码现在会优先读取 `PORT`
- 生成图片、manifest 等运行时文件会写到持久盘，不会因为重启丢失

## 3. 当前架构边界

这次部署改造已经解决：

- Vercel 前端访问 Render 后端的接口基地址
- 前后端分域后 `/generated-assets/*` 图片访问
- Render 的 `0.0.0.0 + PORT` 监听
- 跨域下载生成图片时的静态资源响应头

当前仍然保留的产品特性：

- 写作主链仍是 BYOK，用户在前端输入 Gemini API Key
- 配图、图释、公众号排版相关能力走后端接口

所以这版是“Vercel 前端 + Render 后端可稳定部署版”，不是“全部模型调用都收回后端版”。

## 4. 上线前检查

1. 先部署 Render，确认 `/api/health` 返回 `{ "ok": true }`
2. 再部署 Vercel，并配置 `VITE_BACKEND_ORIGIN`
3. 打开前端后验证：
   - 风格库列表能加载
   - 参考模板目录能加载
   - 配图生成后图片能正常显示
   - ZIP 导出能把图片一并打包
   - 微信排版预览能正常请求后端

## 5. 可选环境变量

如果你启用了公众号能力，再补这些：

- `WECHAT_OFFICIAL_APP_ID`
- `WECHAT_OFFICIAL_APP_SECRET`
- `WECHAT_OFFICIAL_ENABLE_PUBLISH=1`
