# Mobile Client Demo

React + TypeScript 交互原型，用于评审 Mobile Client 的信息架构和关键流程。所有业务数据
均为 mock，不连接真实 Runtime。

## 本地运行

从仓库根目录执行：

```bash
npm run dev
```

然后打开：

```text
http://127.0.0.1:<vite-port>/docs/product/mobile/demo/
```

## 独立构建

```bash
npx vite build --config docs/product/mobile/demo/vite.config.ts
```

## 当前覆盖

- 会话列表、搜索、新建、消息发送和模拟 Run projection；
- Thinking、Tool、Todo、Changes 和 Artifact 消息卡片；
- 工作中心：Run、Approval、Agent/Todo、Scheduler；
- 远程终端：会话列表、WebRTC 状态、命令和虚拟按键；
- 文件与 Changes；
- Skills、插件、模型、Identity/Memory、评论、设备与移动设置。

产品范围与正式实现边界见
[Workbench 到 Mobile Client 功能取舍矩阵](../WORKBENCH-MOBILE-FEATURE-MATRIX.md)。
