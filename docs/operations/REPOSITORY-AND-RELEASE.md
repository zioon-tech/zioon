# Repository and release ownership

| 仓库 | 归属 | 发布组件 |
| --- | --- | --- |
| `zioon-tech/zioon` | Runtime、Workbench、Mobile、CLI、Auth、Marketplace、官网和文档 | runtime / workbench / portals / marketplace / public-site / cli |
| `zioon-tech/adc` | 控制面、Connector、SDK、CLI、Agent 集成、官网和文档 | service / connector / console-and-site / plugins |
| `zioon-tech/memory` | Memory 服务、SDK、CLI 登录辅助、Skill、官网和文档 | service / public-site / integrations |
| `zioon-tech/workflows` | 通用 CI 模板 | 固定 SHA 的可复用工作流 |
| `zioon-tech/infra` | 私有生产配置、云身份、发布和回滚 | 经过 CI 的产品制品 |
| `zioon-tech/.github` | 组织主页与默认贡献模板 | GitHub 组织主页 |

产品网站与文档不集中到独立的通用 website/docs 仓库。Zioon 的 `apps/public-site` 与 `docs`、ADC 的 `apps/console` 与 `docs`、Memory 的 `apps/memory-service/web` 与 `docs` 分别由各自维护者负责。

Zioon 当前 Workbench 使用根目录 `src`、`public`、`index.html` 和 Vite 配置；这是现有应用的真实位置。其他入口位于 `apps/mobile-client`、`apps/admin`、`apps/client-portal`、`apps/marketplace`、`apps/public-site`。CLI 位于 `packages/zioon-cli`；统一身份协议与客户端位于 `packages/zioon-account`、Runtime 的 `src/accounts`。

Memory 服务源码归属独立 Memory 仓库。Zioon 保留 Runtime 的 Memory 委托、客户端、Provider 和跨产品验收；不会维护另一份 Memory 服务源码。

账户产品归属 Zioon。生产中已有 ADC 进程承载的登录兼容路由继续使用原数据库、subject 和会话；ADC 自托管认证及工具 OAuth 仍由 ADC 维护。不要通过仓库整理更换 issuer、复制账户或使现有登录失效。后续进程拆分属于单独的账户迁移发布。

## Development

Node 固定 22.18.0；Zioon 使用 npm 10.9.3，ADC 使用 pnpm 9.14.2，Memory 使用 Bun 1.4.1。安装必须使用锁文件。不要提交依赖目录、构建产物或调试记录。

功能分支提交 PR，产品团队 review。官网或文档变更只触发对应组件的构建；依赖、公共协议及 CI 变更触发相关全量检查。每个组件上传独立、关联完整 commit SHA 的 CI 制品。

## Release

从 main 的成功 CI run 选择制品，不在生产机器重新构建。在本产品仓库发起 `Production release`，调用固定 SHA 的共享发布工作流；私有 `infra` 管理生产配置、云权限和运行手册。发布 manifest 与 journal 记录产品、组件、commit、CI run、制品 SHA256、时间和旧指针。发布先核验来源和校验和，检查磁盘及依赖，再切换指针，等待 HTTP readiness，失败时回滚并记录结果。

```sh
gh workflow run release.yml --repo zioon-tech/zioon --ref main \
  -f component=public-site -f ci-run=<successful-main-ci-run-id> -f check-only=true
# 预检通过后，用相同 component 和 ci-run 将 check-only 改为 false。
```

可分别发布 `public-site`、`workbench`、`portals`、`marketplace` 和 `runtime`。CLI 下载包随官网制品发布；Mobile 与 Admin 静态资源由 `portals` 制品承载。

官网与文档发布不能顺带重启 Runtime、ADC 后端或 Memory 服务。ADC 当前官网、文档和控制台共用前端构建，发布静态目录即可；Memory 公开网站制品不覆盖账户和控制台路由。

组织当前使用 GitHub Free。公开仓库可启用分支保护；私有仓库强制分支保护和 CODEOWNERS 审批需要 Team。私有仓库仍使用 PR、CI 和固定制品，但不能把这些约定描述为 GitHub 已强制执行的规则。
