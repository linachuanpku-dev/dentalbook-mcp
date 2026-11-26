# Dentalbook v5 建设规则

## 权威文档

- 产品范围以 `docs/PRD.md` 为准。
- 组件边界与数据所有权以 `docs/ARCHITECTURE.md` 为准。
- 引用状态机以 `docs/VERIFIED_CITATIONS.md` 为准。
- 已实现/未实现状态以 `docs/MCP_TOOL_CATALOG.md` 为准。

## 不可违反的工程约束

1. 不加入独立 Agent、Electron、DMG、Pi 或 ACP 依赖。
2. 业务规则只进入领域应用服务；MCP、CLI 和 UI 都是薄适配层。
3. 未实现工具不得注册。失败必须返回失败，不能用 scaffold 数据伪装成功。
4. MCP App 不得直接访问 SQLite 或文件系统；写入只能通过 `tools/call`。
5. 高风险写入必须由服务端签发并校验一次性确认令牌。
6. 医学事实、综述正文和正式结论默认要求 Dentalbook Verified Citation。
7. `exact` 必须绑定同一 PDF SHA-256；OCR 候选不得升级为 `exact`。
8. 不提交真实令牌、PDF、用户数据或 v3/v4 数据。
9. 不修改 Codex、Claude 或 Cursor 的用户级配置；只维护仓库内示例。
10. 新增业务工具时，同步更新工具目录、权限、错误码、测试和验收条目。

## 提交前

运行 `npm run check`。涉及 Skill 时还要确保对应 `SKILL.md` 简洁、可触发，并继续通过官方 quick validator。
