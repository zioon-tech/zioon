# 独立市场

视觉：清晰、安静的现代应用目录，白色画布、浅灰分区和标准蓝色操作，宽版布局与严谨的字号层级。

内容：独立导航与账户入口；发现页搜索、类型与分类筛选；可分享详情页；已安装、我的开发与公开贡献；连接配置、版本与审核。

交互：内容进入时短暂淡入；列表和详情链接在 hover/focus 时明确反馈；菜单、配置弹窗与版本切换使用 Ant Design 的一致动效，遵守 reduced-motion。

技术：React 19、Ant Design 5、React Router、TanStack Query。设计 token：primary #1677ff、text #1f2329、muted #646a73、background #f7f8fa、border #e5e6eb，8px 间距与圆角基准，标准 Lucide 图标。

身份：Zioon 原登录入口、一次性 PKCE handoff、市场独立 HttpOnly host cookie，既有账户安装服务。私有数据不进入公开目录或客户端持久缓存。
