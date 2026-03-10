# 微信公众号自动排版模块配置说明

本文件说明本项目公众号自动排版模块用到的 5 个环境变量分别是什么、去哪里找、怎么配置，以及 Windows / PowerShell 下需要注意的编码问题。

本文件建议使用 `UTF-8` 保存。

---

## 1. 这 5 个环境变量分别是什么

当前项目服务端读取逻辑在 `server/wechatOfficialPublisherService.mjs`。

| 环境变量 | 是否必填 | 来源 | 作用 |
| --- | --- | --- | --- |
| `WECHAT_OFFICIAL_APP_ID` | 是 | 微信公众号后台 | 调微信官方接口时使用的公众号 `AppID` |
| `WECHAT_OFFICIAL_APP_SECRET` | 是 | 微信公众号后台 | 调微信官方接口时使用的公众号 `AppSecret` |
| `WECHAT_OFFICIAL_DEFAULT_AUTHOR` | 否 | 你自己配置 | 公众号草稿默认作者名，可在每篇文章里改 |
| `WECHAT_OFFICIAL_DEFAULT_SOURCE_URL` | 否 | 你自己配置 | 公众号草稿默认“原文链接” |
| `WECHAT_OFFICIAL_ENABLE_PUBLISH` | 否 | 你自己配置 | 是否允许系统直接调用微信发布接口 |

补充说明：

- 代码还兼容旧变量名 `WX_APP_ID` 和 `WX_APP_SECRET`，但建议统一使用 `WECHAT_OFFICIAL_APP_ID` / `WECHAT_OFFICIAL_APP_SECRET`。
- 当前项目读取的是 `process.env`，也就是“进程环境变量”。
- 当前项目还没有自动加载 `.env` 文件，所以你不能只是在根目录放一个 `.env` 就指望它自动生效，除非后面再加 `dotenv` 一类的加载逻辑。

---

## 2. 哪些值是微信给你的，哪些值是你自己定的

### 微信给你的

- `WECHAT_OFFICIAL_APP_ID`
- `WECHAT_OFFICIAL_APP_SECRET`

这两个值来自你自己的微信公众号后台。

### 你自己定的

- `WECHAT_OFFICIAL_DEFAULT_AUTHOR`
- `WECHAT_OFFICIAL_DEFAULT_SOURCE_URL`
- `WECHAT_OFFICIAL_ENABLE_PUBLISH`

这 3 个不是微信后台发给你的，是我们这个项目自己的默认配置项。

---

## 3. `WECHAT_OFFICIAL_APP_ID` 是什么，怎么找

### 它是什么

`WECHAT_OFFICIAL_APP_ID` 就是公众号的开发者 ID，也就是 `AppID`。

服务端会用它去换取 `access_token`，再调用微信的草稿、图片上传、发布等接口。

### 去哪里找

通常在微信公众号管理后台里找，公开资料长期一致的路径是：

- `微信公众平台 -> 设置与开发 -> 基本配置`
- 在“开发者 ID”或“公众号开发信息”区域里查看 `AppID`

需要登录地址：

- `https://mp.weixin.qq.com/`

### 关于后台路径变动

2026 年 3 月这个时间点，公开资料显示微信后台的“开发接口管理”相关入口在部分账号上已经逐步迁到 `微信开发者平台`，也就是：

- `https://developers.weixin.qq.com/platform/`

所以你实际看到的菜单可能有两种情况：

1. 仍然能在 `微信公众平台 -> 设置与开发 -> 基本配置` 里看到 `AppID`
2. 被迁移到 `微信开发者平台` 后查看

如果你在旧后台找不到，不要直接判定没有这个字段，先去开发者平台里看。

### 你拿到后应该怎么填

示例：

```powershell
$env:WECHAT_OFFICIAL_APP_ID="wx1234567890abcdef"
```

---

## 4. `WECHAT_OFFICIAL_APP_SECRET` 是什么，怎么找

### 它是什么

`WECHAT_OFFICIAL_APP_SECRET` 就是公众号开发密钥，也常被叫做：

- `AppSecret`
- 开发者密码

它和 `AppID` 配合使用，用来换取 `access_token`。

### 去哪里找

通常和 `AppID` 在同一个页面：

- `微信公众平台 -> 设置与开发 -> 基本配置`

一般会在“开发者密码”或 `AppSecret` 一栏。

### 你可能会遇到的情况

- 有些后台会直接显示“重置”
- 有些后台会要求管理员验证后才能查看或重置
- 一旦你重置 `AppSecret`，旧的 `AppSecret` 通常会失效

所以要注意：

- 不要随便点重置
- 如果你已经把旧值配置到服务器里，重置后必须同步改服务器配置

### 你拿到后应该怎么填

```powershell
$env:WECHAT_OFFICIAL_APP_SECRET="你的真实AppSecret"
```

### 安全要求

- `AppSecret` 只能放服务端，不能放前端
- 不要提交到 GitHub
- 不要写死到浏览器代码里
- 不要随便发给第三方

---

## 5. `WECHAT_OFFICIAL_DEFAULT_AUTHOR` 是什么，怎么配置

### 它是什么

这个值不是微信后台给你的。

它是我们项目里“公众号排版面板”的默认作者名。创建草稿时会作为文章 `author` 字段提交给微信。

### 你应该填什么

一般填这些之一：

- 公众号品牌名
- 编辑部名
- 固定署名，例如“晚点团队”
- 统一的编辑名，例如“AI Writer 编辑部”

### 它会不会写死

不会。

它只是默认值。你在每篇文章的“公众号”标签页里还能继续改。

### 配置示例

```powershell
$env:WECHAT_OFFICIAL_DEFAULT_AUTHOR="晚点编辑部"
```

---

## 6. `WECHAT_OFFICIAL_DEFAULT_SOURCE_URL` 是什么，怎么配置

### 它是什么

这个值也不是微信后台给你的。

它是草稿里的默认“原文链接”，也就是微信接口里的 `content_source_url`。

### 你应该填什么

如果你有自己的网站、详情页、归档页，可以填一个完整的 `http://` 或 `https://` 地址，例如：

- 官网文章页
- 你自己的 CMS 文章地址
- 内部审核系统的只读地址

### 不填可以吗

可以。

如果你没有稳定的原文页，可以留空。

### 需要注意什么

- 必须是完整 URL
- 只接受 `http://` 或 `https://`
- 不是完整 URL 的值会被当前代码当成空值处理

### 配置示例

```powershell
$env:WECHAT_OFFICIAL_DEFAULT_SOURCE_URL="https://your-domain.com/articles/123"
```

---

## 7. `WECHAT_OFFICIAL_ENABLE_PUBLISH` 是什么，怎么配置

### 它是什么

这也是我们项目自己的开关，不是微信后台字段。

它控制的是：

- 是否允许系统直接调用微信的“发布”接口

### 当前代码的判断方式

当前代码逻辑是：

- 只要这个值不是字符串 `"0"`，就视为允许发布
- 只有明确设置成 `"0"`，才视为禁用发布

所以推荐你只用这两个值：

- `1`：允许系统直接发起发布
- `0`：只生成草稿，不允许系统直接发布

### 我建议你怎么用

如果你现在的目标是“自动排版 -> 进公众号草稿箱 -> 人工审核”，那么建议一开始先这样配：

```powershell
$env:WECHAT_OFFICIAL_ENABLE_PUBLISH="0"
```

这样更稳：

- 系统只负责生成草稿
- 人工在公众号后台审核
- 审核通过后你可以在微信后台手动发布

等你流程跑顺了，再改成：

```powershell
$env:WECHAT_OFFICIAL_ENABLE_PUBLISH="1"
```

---

## 8. 最推荐的配置方式

因为当前项目读取的是 `process.env`，所以最直接的方式是在启动服务端之前先设置环境变量。

### 方式 A：PowerShell 当前会话里设置

适合本机调试。

```powershell
$env:WECHAT_OFFICIAL_APP_ID="你的AppID"
$env:WECHAT_OFFICIAL_APP_SECRET="你的AppSecret"
$env:WECHAT_OFFICIAL_DEFAULT_AUTHOR="晚点编辑部"
$env:WECHAT_OFFICIAL_DEFAULT_SOURCE_URL="https://your-domain.com/articles/default"
$env:WECHAT_OFFICIAL_ENABLE_PUBLISH="0"

npm run dev:server
```

特点：

- 关掉这个终端后失效
- 适合先跑通流程

### 方式 B：用 `setx` 写入用户级环境变量

适合本机长期使用。

```powershell
setx WECHAT_OFFICIAL_APP_ID "你的AppID"
setx WECHAT_OFFICIAL_APP_SECRET "你的AppSecret"
setx WECHAT_OFFICIAL_DEFAULT_AUTHOR "晚点编辑部"
setx WECHAT_OFFICIAL_DEFAULT_SOURCE_URL "https://your-domain.com/articles/default"
setx WECHAT_OFFICIAL_ENABLE_PUBLISH "0"
```

注意：

- `setx` 写入后，当前终端通常不会立刻拿到新值
- 你需要重新打开一个新的终端再启动服务

### 方式 C：部署平台里配置

如果你的服务端部署在云平台或服务器上，就去平台的环境变量配置页面设置，比如：

- Vercel
- Railway
- Render
- Docker / Docker Compose
- Windows 服务
- Linux `systemd`

原则只有一条：

- 这些值必须出现在服务端进程的 `process.env` 里

---

## 9. 推荐的最小可用配置

### 只做草稿，不自动发布

```powershell
$env:WECHAT_OFFICIAL_APP_ID="你的AppID"
$env:WECHAT_OFFICIAL_APP_SECRET="你的AppSecret"
$env:WECHAT_OFFICIAL_DEFAULT_AUTHOR="晚点编辑部"
$env:WECHAT_OFFICIAL_DEFAULT_SOURCE_URL=""
$env:WECHAT_OFFICIAL_ENABLE_PUBLISH="0"
```

这是最符合你当前需求的配置：

- 自动排版
- 自动进草稿箱
- 人工审核
- 不让系统直接发出去

### 草稿和发布都允许

```powershell
$env:WECHAT_OFFICIAL_APP_ID="你的AppID"
$env:WECHAT_OFFICIAL_APP_SECRET="你的AppSecret"
$env:WECHAT_OFFICIAL_DEFAULT_AUTHOR="晚点编辑部"
$env:WECHAT_OFFICIAL_DEFAULT_SOURCE_URL="https://your-domain.com/articles/default"
$env:WECHAT_OFFICIAL_ENABLE_PUBLISH="1"
```

---

## 10. 编码问题要怎么处理

这是最容易被忽略、但中文项目里最容易出问题的部分。

### 10.1 环境变量本身

`AppID` 和 `AppSecret` 都是 ASCII 字符，一般不会有编码问题。

真正可能出问题的是：

- `WECHAT_OFFICIAL_DEFAULT_AUTHOR` 里有中文
- 你把配置写进 `.ps1`、`.cmd`、文本文件时用了错误编码

### 10.2 Markdown 文件编码

本说明文件请使用：

- `UTF-8`

不要用：

- `ANSI`
- `GBK`
- `UTF-16`

### 10.3 PowerShell 脚本编码

如果你要把环境变量写进 `.ps1` 脚本：

- 如果你用的是 `PowerShell 7`，建议用 `UTF-8`
- 如果你还要兼容 `Windows PowerShell 5.1`，建议 `.ps1` 保存成 `UTF-8 with BOM`

原因：

- `Windows PowerShell 5.1` 对无 BOM 的 UTF-8 脚本兼容性不稳定
- 你的中文作者名在这种情况下更容易乱码

### 10.4 不要用中文标点

环境变量名和值两侧的语法要保持英文半角格式。

正确示例：

```powershell
$env:WECHAT_OFFICIAL_DEFAULT_AUTHOR="晚点编辑部"
```

错误示例：

```powershell
$env：WECHAT_OFFICIAL_DEFAULT_AUTHOR=“晚点编辑部”
```

错误点包括：

- 中文冒号 `：`
- 中文引号 `“ ”`

### 10.5 如果你以后要加 `.env`

当前项目默认不会自动加载 `.env`。

如果后面你决定接入 `dotenv`，也要注意：

- `.env` 文件请保存为 `UTF-8`
- 不要写成 `UTF-16`
- 不要在变量名里混入中文空格或中文标点

---

## 11. 配完以后怎么确认是否生效

启动服务端后，进入文章终稿页的“公众号”标签。

你会看到一个“配置状态”区域：

- 如果 `AppID` / `AppSecret` 没配好，会提示缺少哪些 key
- 如果配好了，就可以提交公众号草稿

补充说明：

- 即使没配 `AppID` / `AppSecret`，你通常也还能做“生成预览”
- 但“提交草稿箱”和“发布”会依赖服务端真实凭证

---

## 12. 常见问题

### Q1：我找不到 `AppID` / `AppSecret`

先按这个顺序排查：

1. 先去 `https://mp.weixin.qq.com/`
2. 看 `设置与开发 -> 基本配置`
3. 如果没有，再看是否迁到了 `https://developers.weixin.qq.com/platform/`
4. 确认你登录的是正确公众号管理员账号

### Q2：我重置了 `AppSecret`，为什么系统突然报错

因为旧的 `AppSecret` 很可能已经失效了。

你需要把服务器里的：

- `WECHAT_OFFICIAL_APP_SECRET`

同步改成新的值，然后重启服务端。

### Q3：为什么我能预览，但提交草稿失败

常见原因：

- `AppID` / `AppSecret` 没配
- 公众号本身接口权限不够
- 当前文章没有可用封面图

当前实现里，提交草稿时需要有封面图可上传。

### Q4：为什么我改了文章以后，原来的公众号草稿状态没了

这是当前项目故意这样做的。

只要正文或配图变了，系统就会把旧的公众号草稿状态清掉，避免你误把旧版本送审或发布。

---

## 13. 你现在最适合怎么配

如果你当前目标是：

- 自动排版
- 自动生成公众号草稿
- 人工审核
- 不自动发出去

那建议你先用这一组：

```powershell
$env:WECHAT_OFFICIAL_APP_ID="你的AppID"
$env:WECHAT_OFFICIAL_APP_SECRET="你的AppSecret"
$env:WECHAT_OFFICIAL_DEFAULT_AUTHOR="晚点编辑部"
$env:WECHAT_OFFICIAL_DEFAULT_SOURCE_URL=""
$env:WECHAT_OFFICIAL_ENABLE_PUBLISH="0"
```

这组最符合“稳健接公众号自动排版，最后由人审”的工作流。

---

## 14. 参考资料

以下链接是我整理这份说明时参考的资料：

### 项目内代码

- `server/wechatOfficialPublisherService.mjs`

### 微信官方接口文档路径

- 获取 `access_token`：
  `https://developers.weixin.qq.com/doc/offiaccount/Basic_Information/Get_access_token.html`
- 草稿箱：
  `https://developers.weixin.qq.com/doc/offiaccount/Draft_Box/Add_draft.html`
- 发布：
  `https://developers.weixin.qq.com/doc/offiaccount/Publish/Publish.html`
- 永久素材：
  `https://developers.weixin.qq.com/doc/offiaccount/Asset_Management/Adding_Permanent_Assets.html`

### 用于交叉核对后台入口名称的近期公开资料

- 华为云用户指南中对公众号后台入口的说明：
  `https://support.huaweicloud.com/usermanual-astrozero/astrozero_05_0111.html`
- 近期公开资料中关于接口管理入口迁移到微信开发者平台的说明：
  `https://www.ttbobo.com/7991.html`

说明：

- 微信官方开发文档链接是主参考。
- 后台菜单路径这一部分，我额外用近期公开资料做了交叉核对，因为 2025 年后微信后台入口有迁移迹象。

