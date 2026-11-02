# Panel Tab 与 PWA Title 栏层级区分

## 目标

在日间默认主题下，让主编辑区 panel 的多标签页栏与 PWA title 栏形成可辨识但克制的背景层级。

## 设计

- 保持 PWA title 栏现有背景色 `#f0f2f6`。
- 将默认日间主题的 panel tabs 栏背景改为 `#f8f9fb`。
- tabs 栏最终样式应使用现有 `--editor-tabsbar-bg` token，避免通用 surface token 覆盖主题定义。
- 保持现有 panel 间分割线、拖拽行为、尺寸、标签样式和底边线不变。
- 其他主题继续使用各自已有的 `--editor-tabsbar-bg`，不新增主题特例。

## 验收

- 默认日间主题中，PWA title 栏与 panel tabs 栏背景肉眼可区分。
- 深色和其他预设主题不发生意外颜色回退。
- panel 分割布局、拖拽热区和编辑区域尺寸不变。
- 构建及相关样式测试通过。
