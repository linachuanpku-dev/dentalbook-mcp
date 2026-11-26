# ADR-001：使用通用 Agent，不开发独立 Agent 与 DMG

- 状态：已被 ADR-005 部分替代
- 日期：2026-08-17

## 决策

Dentalbook v5 不开发自有推理运行时、Electron 或 DMG。原先“只交付 MCP/Skills/MCP Apps”的界面限制由 [ADR-005](005-web-first-open-mcp.md) 替代；继续保留“使用通用 Agent”的决定。

## 理由

核心资产是数据、关系和可验证引用，不是聊天壳。开放接口可让模型和 Agent 宿主持续替换，管理员也能直接使用代码型 Agent 管理与测试。

## 后果

产品不再控制固定窗口布局、更新机制和宿主会话；必须接受不同宿主的 UI 能力差异，并保证无 UI 降级完整。
