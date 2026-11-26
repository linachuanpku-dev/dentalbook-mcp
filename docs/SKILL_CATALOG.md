# Skill 目录

Skills 是可移植的流程说明，不是后端插件代码。它们调用宿主已经连接的 `dentalbook-user` MCP；工具不存在时必须停止并说明能力尚未实现。

| Skill | 目标 | 关键门禁 |
|---|---|---|
| `dentalbook-literature-discovery` | 将临床问题转为检索、去重并说明可得性 | 不把题录命中说成全文已得 |
| `dentalbook-fulltext-retrieval` | 检查本地/中心/抓取状态并核验 PDF | 没有魔数与 SHA 就没有 PDF verified |
| `dentalbook-evidence-reading` | 从同一文件页码和原句建立证据卡 | OCR 候选不能当 exact |
| `dentalbook-verified-review` | 用已核验证据撰写综述 | 医学事实默认必须有 verified citation |
| `dentalbook-author-exploration` | 浏览作者、机构、地图和关系 | 推断关系必须标来源与置信度 |
| `dentalbook-citation-audit` | 审核题录、PDF、原句和引用覆盖 | 任一哈希/页码/原句冲突即失败 |

## 组合流程

可信综述通常触发四个 Skill 的职责：发现 → 全文 → 证据阅读 → 可信综述。实际事务由 MCP 后面的应用服务完成；Skill 只决定何时调用意图级工具、怎样表达缺口和怎样组织结果。

作者探索可独立使用，也可在文献发现后补充领域脉络。引用审计既可作为综述完成前的门禁，也可单独审阅已有草稿。

## 宿主差异

- Codex 插件可从仓库的 `skills/` 自动发现这些 Skills。
- Claude Code 等宿主可按其 Skill 导入机制复制或链接同一目录。
- 即使宿主不支持 Skills，用户仍可直接调用 MCP；核心数据与权限不依赖 Skill。
