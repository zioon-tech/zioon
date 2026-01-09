1. 新增扩展目录 extensions/dev.paste-image，包含 extension.json 与 main.js，用于处理粘贴图片并插入到文档中。
2. 在 extension.json 中声明扩展元信息与 activationEvents（onStartupFinished）。
3. 在 main.js 的 activate() 中注册 paste handler（id: dev.paste-image.handler，priority: 100）。
4. paste handler 支持：剪贴板文件（File/Blob image/*）、clipboardData.items 中的 image、HTML 中的 <img src="...">、以及直接的图片 URL 文本。
5. 对于本地图片文件，读取为 DataURL 并以 Markdown 图像语法插入：![](data:... )；对于远程/HTML 图片使用原始 src URL 插入。
6. 将返回的 Disposable 推入 ctx.subscriptions，确保扩展停用时能正确清理。