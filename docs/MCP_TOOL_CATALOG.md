# MCP 工具目录

本文件是工具是否存在的权威清单。`planned` 工具在实现、测试和权限门禁完成前不得注册。

## 1. 当前已实现

| 工具 | MCP | 风险 | 说明 |
|---|---|---|---|
| `system.health` | user、admin | 只读 | 报告本地适配器、配置、Linux 中心可达性；user 侧另含 `localMcpVersion`、`latestMcpVersion`、`upgradeRecommended`、`upgradeRequired`、`upgradeHint` |
| `system.capabilities` | user、admin | 只读 | 分别列出当前实际注册的用户或管理员工具 |
| `system.render_ui_probe` | user | 只读、渲染 | 关联 `ui://dentalbook/system-probe/v2`，验证内联、浅色样式、`tools/call` 和可选全屏 |
| `papers.get` | user | 只读，`catalog:read` | 以 DOI 或稳定 `paperId` 查询题录、`metadata_only` / `central_cached` / `local` 状态、并列 `pdfs[]`（多版本时），以及元信息/PDF 两步入库回执（admin/user、时间、渠道） |
| `papers.list` | user | 只读，`catalog:read` | 分页列出共享题录，并结合当前 Mac 本地库计算 PDF 状态；每条可带并列 `pdfs[]`、元信息与 PDF 入库回执 |
| `papers.search` | user | 只读，`catalog:read` | 作者别名解析到唯一 `authorId` 后，在该人 `author_works`∩库内题录上做 FTS5 检索，覆盖题名、摘要、keywords、MeSH 与 DOI（`AND`/`OR`，斜杠视为 `OR`）；bm25 排序题名权重最高，其次 keywords/MeSH，再摘要，DOI 最低；作者未命中失败，不退化成全库搜；返回 `resolvedAuthorId`，每条含 `hasAbstract` |
| `library.stats` | user | 只读，`catalog:read` | 返回共享题录、共享 PDF、仅题录与当前 Mac 本地 PDF 数量 |
| `authors.list` | user | 只读，`catalog:read` | 按作者、机构或稳定 `authorId` 搜索作者名录，返回中文名、规范英文、论文索引、五路 `sourceStatuses`（绿/淡黄/灰）和（若有）国家/学校/医院/学科码与旧号 alias。`importEvents` 仅 `authors:admin` |
| `authors.get` | user | 只读，`catalog:read` | 解析一个作者（新 `authorId` 或 v3 旧号 alias），返回中文名、英文别名合集、论文索引、已通过的作者关系和判断文档，以及五路 `sourceStatuses`；有 DOI 的作品读时按 DOI 对照文献库，带上与 `papers.get` 相同的题录/PDF 状态。同名须人工用 `authorId` 确认，不自动消歧。`importEvents` 仅管理员 |
| `authors.submit_note` | user | 中心写入，`authors:contribute` | 追加一条人工判断（师承、缩写认定或消歧）；成功返回 `author_note_*` 回执 |
| `authors.submit_relation` | user | 中心写入，`authors:contribute` | 提交作者关系评论（导师/学生/说明）；成功返回 `author_relation_*` 回执，公开显示需管理员审核 |
| `papers.import_local` | user | 中心写入，`fulltext:import` | 从配置允许的本地目录读取 PDF，经中心 DOI/PDF/SHA 校验后共享；同 DOI 新 SHA 并列新增，同 DOI 同 SHA 返回 `alreadyPresent`；成功返回 `import_*` 回执 |
| `sync.pull_pdf` | user | 中心读取 + 本地写入，`fulltext:read` | 下载中心已验证 PDF（多版本时需 `sha256`），复核 SHA-256 后写入当前 Mac 的隔离本地库；成功返回 `local_sync_*` 回执 |
| `ui.render_library` | user | 只读、渲染 | 关联 `ui://dentalbook/library/v1`，显示共享列表、数量和下载按钮 |
| `admin.papers.fetch_fulltext` | admin | 中心写入，`fulltext:fetch` | 管理员将 Linux 已配置来源强校验后写入共享库；fixture SHA 已在该篇下则 `alreadyPresent`，否则并列追加，不覆盖已有用户上传；成功返回 `ingest_*` 回执 |
| `admin.papers.ingest_metadata` | admin | 中心写入，`fulltext:fetch` | 管理员批量写入最多 50 条仅题录（DOI+题名，可选 `abstract` / `keywords[]` / `meshTerms[]`），不附加、不编造 PDF；省略富集字段时不擦除已有摘要/关键词/MeSH；传入 `keywords`（含空数组）会盖 `keywords_fetched_at`：有词为绿、空为黄、未传为灰；已有 PDF 的题录仍可补 enrichment，不改题名；首次写入盖元信息时间/渠道戳（`admin_fetch`），后补 enrichment 不覆盖元信息戳；每条写入独立 `metadata_*` 回执，公开列表记为元信息上传 / admin fetch |
| `admin.papers.ingest_corpus` | admin | 中心写入，`fulltext:fetch` | 为 Linux 仓库固定 batch（`batchSha256` + `manifestSha256` + `entryCount`）签发一次性确认令牌；实际上传由 `scripts/linux-corpus-ingest.mjs` 逐篇 POST；同 DOI 新 SHA 并列新增，同 DOI 同 SHA 为 `alreadyPresent` |
| `admin.library.stats` | admin | 只读，`catalog:read` | 管理员查看共享题录与 PDF 数量 |
| `admin.authors.upsert` | admin | 中心写入，`authors:admin` | 更新规范英文、机构或英文别名候选；成功返回 `author_admin_*` 回执 |
| `admin.authors.list_relations` | admin | 只读，`authors:admin` | 列出待审/已通过/已驳回的作者关系投稿 |
| `admin.authors.review_relation` | admin | 中心写入，`authors:admin` | 通过或驳回一条作者关系；成功返回 `author_review_*` 回执 |
| `admin.authors.list_merges` | admin | 只读，`authors:admin` | 按作者列出元数据合并审核：人是否钉住、五路是否问过、作品数、状态 |
| `admin.authors.get_merge` | admin | 只读，`authors:admin` | 读取一人的合并详情：各源命中（含空结果）、作品并集来源、冲突和操作历史 |
| `admin.authors.review_merge` | admin | 中心写入，`authors:admin` | 确认完成或退回待审；成功返回 `author_merge_review_*` 回执 |
| `admin.users.list` | admin | 只读，`admin:audit` 或现有管理员 scope | 列出令牌用户文件夹：姓名（有 `displayName` 则显示）、身份（医生/管理员）和最近一次打中心的时间 |
| `admin.users.get` | admin | 只读，`admin:audit` 或现有管理员 scope | 打开一个用户文件夹：用过的 Agent，以及按时间交错的检索组与文献动作；`papers.list` 搜索词不当成文献，空搜索不出现 |

管理员 MCP 不注册用户上传、下载或 UI 工具；用户 MCP 不注册管理员 Fetch。两侧工具列表均由测试断言精确名称。离线脚本 `npm run import:authors` 通过中心 HTTP `POST /v1/authors/merges/ingest` 写入合并（回执 `author_merge_*`）；`npm run import:v3-authors` 只 mint 名录 JSONL；`npm run import:v3-author-works` 经 `POST /v1/authors/works/ingest` 写入 `author_works` 并记 v3 论文导入事件（回执 `author_works_ingest_*`）。**不**把 ingest 注册成 MCP 工具，也**不**注册 `authors.resolve` 或 OpenAlex hydrate。本版不做师承图、行政任职、单位维表或共著次数。

## 2. v1 计划数据工具

| 模块 | 计划工具 | 用例边界 |
|---|---|---|
| notebooks | `notebooks.list`、`notebooks.create`、`notebooks.rename`、`notebooks.move_paper`、`notebooks.delete` | 本地笔记本与论文归属；永久删除需确认 |
| papers | `papers.open_local` | 本地定位。`papers.search` 已实现 |
| evidence | `evidence.read_page`、`evidence.create_card`、`evidence.list_for_paper` | 同一文件 SHA 上的页文本、位置与证据卡 |
| citations | `citations.verify`、`citations.audit`、`citations.open_evidence` | 两级证明、失败原因与证据卡 |
| reviews | `reviews.create`、`reviews.update_section`、`reviews.validate_claims` | 综述编辑、版本与医学事实引用门禁 |
| authors | `authors.map_data`、`authors.graph_data`、`authors.submit_changeset` | 作者地图、关系证据和可信提交；名录三层与 note/upsert 已实现。本版不注册 `authors.resolve` / hydrate，不做师承图或共著 |
| sync | `sync.status`、`sync.pull_catalog` | 目录增量与同步状态 |

## 3. v1 计划渲染工具

只有以下工具关联 UI 资源；相应数据工具不会自动弹 UI。

| 渲染工具 | 资源 URI | 先决数据工具 |
|---|---|---|
| `ui.render_library` | `ui://dentalbook/library/v1` | `papers.list`、`library.stats`、`sync.pull_pdf` |
| `ui.render_notebooks` | `ui://dentalbook/notebooks/v1` | `notebooks.list` |
| `ui.render_citation` | `ui://dentalbook/citations/v1` | `citations.audit` 或 `citations.open_evidence` |
| `ui.render_author_map` | `ui://dentalbook/author-map/v1` | `authors.map_data` |
| `ui.render_author_graph` | `ui://dentalbook/author-graph/v1` | `authors.graph_data` |

## 4. 管理面计划工具

- `admin.backup.create`、`admin.backup.verify`、`admin.restore.plan`、`admin.restore.execute`
- `admin.index.rebuild`
- `admin.tokens.issue`、`admin.tokens.revoke`、`admin.tokens.list`
- `admin.changesets.list`、`admin.changesets.rollback`
- `admin.fulltext.takedown`

恢复、回滚、下架、令牌签发与吊销属于高风险动作。工具必须返回影响摘要和确认令牌，再进行第二次提交。

## 5. 通用返回原则

- 读工具返回足以继续推理的 `structuredContent` 和简明文字。
- 写工具返回 `Receipt`；没有 `ok: true` 与 `receiptId` 就不能声称完成。
- 长任务返回任务 ID、状态和下一次安全轮询时间。
- “未找到题录”“仅题录”“PDF 缺失”“原句未定位”使用不同错误或状态码。
- UI 专用的大型布局数据可进入结果 `_meta`，但权限判断和关键事实不能只藏在 UI 数据中。
