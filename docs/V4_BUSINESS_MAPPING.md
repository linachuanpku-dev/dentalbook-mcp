# v4 业务到 v5 的映射

v4 是业务行为参考，不是代码或数据迁移源。本期没有复制 v4/v3 文件、SQLite、PDF 或人工元数据。

| v4 能力 | v5 决策 | v5 落点 |
|---|---|---|
| 共享文献目录随使用增长 | 保留 | 中心领域服务 + `papers.*` / `sync.*` |
| 缺篇抓取与可见进度 | 保留 | 抓取应用服务 + 状态工具 |
| 本地论文与离线个人资产 | 保留 | 本地领域服务、SQLite、同步 PDF |
| 笔记本 | 保留 | `notebooks.*` + 独立 MCP App |
| PDF 阅读与高亮 | 保留业务，替换 GUI | `papers.open_local`、`evidence.*`；宿主/系统打开 PDF |
| 证据链与引用回溯 | 强化 | 两级证明、证据卡、`citations.*` |
| 综述编辑 | 保留核心工作流 | `reviews.*` + verified-review Skill |
| Pi 对话与运行时 | 替代 | Codex、Claude 等通用 Agent |
| Pi 工具组 | 替代 | MCP 工具目录 |
| Pi Skills / 自建插件 | 替代并标准化 | 可移植 Agent Skills + Codex 插件 |
| Electron 主/渲染进程 | 删除 | 不提供独立客户端 |
| DMG、首启向导、自动更新 | 删除 | 管理员辅助安装通用宿主插件 |
| 三栏改稿、PPT、翻译 | 延后/不在本期 | 未来独立 Skill/MCP 能力评估 |
| 作者/期刊探索 | 保留作者部分 | 作者地图、关系图、`authors.*` |
| 社区作者共建 | 收敛为可信圈子共建 | changeset、审计、回滚、来源 |
| 成品社区 | 不在本期 | 无 |
| 多语言专用界面 | 不设产品壳要求 | Agent 语言能力；MCP App 后续按需 i18n |
| 设备令牌 | 调整 | 每用户 Bearer Token、角色/作用域/过期/吊销 |
| 核心层唯一真相 | 保留 | 领域应用服务唯一实现，MCP/CLI/UI 为适配器 |
| 写入真实回执 | 保留并加强 | 通用 `Receipt`、UI 不做假成功 |
| 高风险确认 | 保留并服务端化 | 一次性确认令牌绑定参数哈希 |
| 协议隔离层 | 重新划界 | Agent/MCP 为开放边界，内部 HTTPS API 为服务边界 |

## v3 交互参考

- 笔记本行为参考旧机本地 `AppShell.jsx:160`，不搬运房间路由和壳层状态。
- 引用交互参考旧机本地 `ReviewStudioV2.jsx:1760`，第一版只做证据卡与外部 PDF 定位。
- 地图参考旧机本地 `CatalogWorkspace.jsx:940` 的 MapLibre 行为，数据改由 MCP 结构化结果提供。
- v3 的作者轨道只表达 Top 10 合作者；v5 关系模型重新设计，不把旧机本地 `CatalogWorkspace.jsx:536` 当成师承图实现。

## 有意中断的兼容性

v5 不继承 v4 的 Electron IPC、Pi 事件、插件 UI 懒加载接口或本地端口约定。业务语义通过 MCP/领域契约重新发布，因此通用 Agent 能随宿主升级而替换。
