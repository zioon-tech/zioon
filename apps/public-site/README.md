# Zioon 官网与 Docs

独立静态站点，包含产品首页、十九篇文档、搜索、CLI / Skill 下载与官网 Skill 发现接口。构建与预览仅使用 Node.js 内置模块，不依赖 Runtime、数据库或认证 SDK。

在仓库根目录运行：

```sh
npm --prefix apps/public-site run build
npm --prefix apps/public-site run check
npm --prefix apps/public-site run preview -- --port 18868
```

访问 `http://127.0.0.1:18868/` 和 `/docs/`。`check` 复用仓库已安装的 jsdom 开发依赖；尚未安装时先在仓库根目录运行 `npm install`。网站构建与正式静态托管不需要 jsdom。

## 修改内容

- `site.config.mjs`：品牌、正式域名、产品入口、既有登录链接及生成图片来源。
- `content/docs.mjs`：十篇文档、分组、正文、代码和版本边界。
- `build.mjs`：HTML、导航、搜索索引、SEO、资源文件名和构建说明。
- `assets/site.css`：响应式布局、排版、焦点和 reduced-motion 样式。
- `assets/site.js`：搜索、代码复制、菜单和目录状态。
- `serve.mjs`：仅监听回环地址的静态预览服务。
- `check.mjs`：站点链接、文档、HTTP 与 DOM 交互检查。

构建产物在 `dist/`。CSS / JS 文件名带内容摘要，可以设置长期缓存；HTML 与搜索索引应采用短缓存。文档正文无需 JavaScript 即可阅读；搜索页无脚本时显示全部文档。剪贴板 API 不可用时会选中代码，并提示用户使用系统复制快捷键。

## 账号与执行边界

官网与 Docs 公开访问。所有登录与“开始使用”按钮进入现有 `https://runtime.zioon.tech/v1/account/login?returnTo=%2F`，由 Runtime 与 `auth.zioon.tech` 完成登录。官网不持有登录凭据，也不创建额外账号系统。

默认构建为待发布预览。CLI 使用独立 0.1.0 npm 制品，官方 Skill 来自仓库 `.trae/skills/zioon/`。构建前运行 `node scripts/build-zioon-cli.mjs` 准备下载文件。

`ZIOON_SITE_RELEASE_STATE=published node apps/public-site/build.mjs` 生成正式发布候选文案，仅随对应 Runtime 发布使用。`node scripts/prepare-zioon-release.mjs` 将预览、正式候选、Runtime 源码、Workbench 和回滚脚本打包到 `ZIOON-RELEASE-20261025/`。

首页照片通过规定的 text-to-image 服务生成，再保存为本地 JPEG，避免静态站点依赖用户在图片服务中的认证。来源和完整 prompt 保留在 `site.config.mjs` 与 `dist/build-info.json`。

## 检查范围

`check` 检查语义结构、内部链接、十九篇文档的搜索覆盖、登录链接、shell 语法、HTTP 和 DOM 交互。`node scripts/verify-zioon-cli-release.mjs` 进一步从预览 HTTP 安装 CLI，验证登录、API、SDK、扩展打包、Skill 发现和下载摘要。

交互检查使用 jsdom，并模拟原生 dialog、media query 与剪贴板。没有操作浏览器，也没有截图验证；真实浏览器的字体度量、原生弹窗和视觉效果需要用户在预览页面查看。没有执行生产模型、文件任务或扩展调用。
