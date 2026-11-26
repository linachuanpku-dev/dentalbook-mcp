# 数据与安全

## 1. 数据分类

| 分类 | 示例 | 默认位置 | 日志策略 |
|---|---|---|---|
| 公共元数据 | DOI、题名、期刊、公开作者资料 | 中心目录 | 可记录查询摘要 |
| 受控全文 | PDF、HTML、页面缩略图 | 中心内容库与获准本地副本 | 记录访问者、论文、时间和结果，不记录全文内容 |
| 个人资产 | 笔记本、高亮、证据卡、综述 | 本地 SQLite/文件 | 默认不上传正文 |
| 共建资产 | 作者纠错、关系、changeset | 中心 | 记录提交者、来源、修订和回滚 |
| 秘密 | Bearer Token、管理凭据 | 系统秘密存储/运行环境 | 永不记录明文 |

## 2. 中心存储

- SQLite 开启 WAL、外键与事务；备份流程先处理 WAL 一致性。
- PDF 以 SHA-256 内容寻址。当前测试 schema 记录大小、页数、MIME 核验、操作者、回执和审计；来源、许可与下架状态仍是生产 schema 待实现项。
- 用户本地上传只允许读取 `user.json` 明确配置的绝对 `importRoots`；拒绝相对路径、目录外路径、symlink、空文件和超限文件。
- 上传文件必须在中心 staging 中重新核验 PDF 魔数、页数、DOI 身份与完整 SHA-256，成功后才原子发布并生成 `import_*` 回执。
- 下载只能通过鉴权 API，不暴露永久裸文件 URL。
- 下架后阻止新同步；本地副本处置按许可和管理员政策执行并审计。

## 3. 本地存储

- 个人 SQLite 保存笔记本、阅读状态、高亮、证据卡和综述。
- 同步 PDF 与证明均绑定文件 SHA；清理文件不会删除题录，但会改变 PDF 可用状态。
- MCP App iframe 不拥有数据库路径、SQLite 连接或长期令牌。
- Web 登录只用长期 Token 换取内存中的短期会话；浏览器仅保存 `HttpOnly`、`SameSite=Strict` Cookie，不把 Token 写入 localStorage、sessionStorage 或前端 bundle。

## 4. 身份与权限

v1 使用每用户独立 Bearer Token。令牌包含不透明随机值；服务端只保存慢哈希或带密钥哈希、用户 ID、角色、作用域、签发/过期/吊销时间。令牌不写入仓库、命令行参数或日志。

当前共享文献竖切使用：

- `catalog:read`
- `fulltext:read`
- `fulltext:import`
- `fulltext:fetch`（管理员 Fetch 全文与仅题录入库）
- `authors:contribute`（用户判断文档与作者关系投稿）
- `authors:admin`（管理员维护名录字段、审核作者关系，以及按作者查看/确认/退回元数据合并）
- `admin:audit`（管理员查看用户文件夹；有 `authors:admin` 或 `fulltext:fetch` 的现有管理员也可看）

调用中心即同意记录工具痕迹。默认同意只覆盖动作、资源 ID、结果、时间和可选宿主名；令牌、PDF、原句和查询全文不写入 `audit_events.host`。

后续计划作用域：

- `personal:write`
- `admin:changesets`
- `admin:storage`
- `admin:tokens`

管理 MCP 必须与医生 MCP 使用不同端点和作用域。生产环境只允许 HTTPS；当前 HTTP 骨架默认绑定 `127.0.0.1`，不能直接公网暴露。

中心 Web 与 API 继续只绑定 Linux 回环地址。公网入口使用 Cloudflare Tunnel 映射到回环服务，不开放路由器或 Linux 公网入站端口。受控 PDF 响应使用 `private, no-store`，不允许边缘公共缓存。

## 5. 写入、changeset 与审计

可信作者提交使用乐观并发版本号。一个提交生成一个 changeset，包含提交者、理由、来源、字段级 revision、父版本和时间。回滚生成新的反向 changeset，不篡改历史。

审计至少记录：主体、动作、资源 ID、结果、receipt/changeset ID、时间和请求关联 ID。可选 `host` 只接受白名单宿主（`workbuddy|trae|cursor|codex|claude|qoder|admin|web`）；非法头丢弃。日志避免全文、原句和令牌；需要排障时记录哈希或长度。

## 6. 威胁与控制

| 威胁 | 控制 |
|---|---|
| Agent 越权调用管理动作 | 分离 MCP、作用域校验、服务端确认令牌 |
| UI 绕过业务规则 | iframe 只用 `tools/call`，无数据库访问 |
| 题录冒充全文 | `PdfProof` 状态机和 PDF 魔数/SHA 门禁 |
| PDF 更新后沿用旧引文 | `QuoteProof.fileSha256` 强绑定与自动失效 |
| OCR 错误 | `ocr_candidate` 与 `exact` 分离 |
| 作者关系污染 | 来源、置信度、changeset、冲突检测与回滚 |
| 地图供应链与追踪 | CSP 最小域、固定供应商、无通配、失败降级 |
| 重放破坏性确认 | 一次性、短时、绑定用户/工具/参数哈希的令牌 |

## 7. 当前实现限制

仓库不包含真实数据或凭据。`.env.example` 只提供空值与无效示例域。中心测试服务使用哈希 Token 和 TLS；本机管理员 MCP 仅回环监听并要求临时 Bearer Token，但尚未实现管理员 MCP 自身的生产级哈希存储、TLS 终止或令牌管理工具。
