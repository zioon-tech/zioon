## 1. Product Overview
面向 Zion Next 的“布局系统”文档与实现接入，梳理当前 docs 信息架构，并明确 Activity Bar 与 Sidebar 的目标接入结构。
输出物用于后续开发/插件作者按统一结构对接。

## 2. Core Features

### 2.1 User Roles
| 角色 | 注册方式 | Core Permissions |
|------|----------|------------------|
| 核心开发者 | 不需要 | 维护布局系统实现；定义扩展点与目标目录结构 |
| 插件作者 | 不需要 | 按扩展点声明贡献（activityBarItems/sideBarViews）；注册对应视图组件 |

### 2.2 Feature Module
当前需求由以下最小页面/载体构成：
1. **布局系统文档（docs/layout）**：目录总览、扩展点说明、Activity Bar 与 Side Bar 规范。
2. **工作台主界面（未来接入点）**：Activity Bar 触发 Sidebar 视图切换的运行时承载界面。

### 2.3 Page Details
| Page Name | Module Name | Feature description |
|-----------|-------------|---------------------|
| 布局系统文档（docs/layout） | 文档目录与分层 | 展示当前 docs/layout 的文件分层：README + 01-09 分主题文档 + api-reference。 |
| 布局系统文档（docs/layout） | 扩展点定义对齐 | 记录扩展点：activityBarItems、sideBarViews 等，并强调 Activity Bar 与 Sidebar 的联动字段（sideBarViewId）。 |
| 工作台主界面（未来接入点） | Activity Bar（左） | 渲染垂直图标列表；点击后根据配置激活对应视图区域（本需求聚焦 sideBarViewId）。 |
| 工作台主界面（未来接入点） | Side Bar（左侧边栏） | 提供“视图容器 + 视图切换（tabs）+ 插件视图渲染生命周期”能力；与 Activity Bar 的激活状态保持一致。 |
| 工作台主界面（未来接入点） | 插件接入（贡献→注册） | 支持两种来源：manifest.json 的 contributes 声明 + 运行时 API registerItem/registerView；并能建立 Activity Item ↔ SideBar View 的映射关系。 |

## 3. Core Process

### 3.1 现状：docs/layout 信息架构（你仓库当前）
- docs/layout/README.md：布局系统总览 + 设备适配表 + 示例 manifest 片段。
- docs/layout/01-extension-points.md：扩展点总览与布局示意。
- docs/layout/02-sidebar-left.md：左侧边栏规范。
- docs/layout/04-activity-bar.md：活动栏规范。
- 其余：03（右侧辅助栏）、05（底部面板）、06（状态栏）、07（编辑器区）、08（响应式）、09（插件指南）、api-reference。

### 3.2 目标：Activity Bar 与 Sidebar 的接入关系（结构层面）
- Activity Bar Item 通过 `sideBarViewId` 指向一个 Side Bar View。
- “激活 Activity Item” = “显示 Side Bar 并激活对应 View”。
- Side Bar 支持在自身区域内进行视图切换（tabs），同时应回写/同步 Activity Bar 的高亮激活态。

```mermaid
graph TD
  A["插件 manifest / 运行时 API"] --> B["注册 Activity Bar Item"]
  A --> C["注册 Side Bar View"]
  B --> D["建立 Item->View 映射 (sideBarViewId)"]
  E["用户点击 Activity Bar 图标"] --> F["激活 Item"]
  F --> G["显示 Side Bar"]
  G --> H["激活 Side Bar View"]
  H --> I["渲染插件视图内容"]