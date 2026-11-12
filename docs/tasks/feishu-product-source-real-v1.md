# 飞书商品资料真实持续更新 v1（2026-11-10）

状态：**首轮独立审查 PASS（阻断 0，2026-11-10）+ 补修自验通过（同日）+ 日常使用入口 v1 完成（本轮，最终差异复核 PASS、阻断 0）**。
本包把 2026-10-25 的“本地快照模拟接入”换成真实飞书读取（只读），并增加只读定时读取进程；
采用动作仍由人工在页面触发，不自动改写商品。不写回飞书原表；写入分支只在现役库的真实首轮基线与
scratch 库受控场景验证过（见 §6）。本轮只补日常入口（数据同步来源、待处理定位）与文档登记，
不重开已通过的读取/采用/历史机制，也不扩大为整体 UI 改造。

## 1. 来源与真实读取能力（本次实测）

| 项 | 实测事实 |
|---|---|
| 文档 | wiki `TC2AwLgRniqWKhkg9D2cEx79n0b` → `obj_token EMZGs2eIhh0YQ1tPIqMcR8SPnQh`，`obj_type=sheet`，标题「ICE产品库」，文档修改时间 `2026-10-20T06:37:19Z` |
| 工作表 | 唯一工作表 `Sheet1` / `sheet_id=33bab4`，网格 **404 行 × 31 列** |
| 读取方式 | 本机 `lark-cli`（bot 身份），`wiki +node-get` → `sheets +info` → `sheets +read --range 33bab4!A1:AE404 --value-render-option FormattedValue`；不写飞书 |
| 表头 | 第 1 行 27 个已知表头（A–AA），AB–AE 为空；表头按文字定位，列字母只作证据 |
| 数据 | 业务行 **131**（B 列非空）、空行 272；G 列编号非空 130、唯一 **125**；重复编号 `WM0069–WM0073` 各 2 行；第 122 行缺码 |
| 图片 | F 列返回 `embed-image` 对象（fileToken/宽高/type），本次 **128 个图片单元格**；二进制可按 fileToken 下载（Lead 实测 `GET /open-apis/drive/v1/medias/<token>/download?extra={"mount_point":"sheet_image","mount_node_token":"EMZGs2eIhh0YQ1tPIqMcR8SPnQh"}`，PNG 182,439 B） |
| 价格 | I=成本价格 / J=运营价格 / Y=单品运费（按表头定位），非空 **365 格**（I 129 / J 124 / Y 112），只在受限证据中保存 |
| 读取幂等 | 同一内容重复读取返回 `unchanged`，不重复写快照、不生成新批次 |
| 读取失败 | CLI 缺失/失败/超时/坏 JSON、非 sheet、缺工作表、表头不符、维度不符、无业务行都会返回明确错误码；**不写快照、不回退旧数据** |

## 2. 字段接入范围

| 范围 | 字段 | 处理 |
|---|---|---|
| 真实可采纳（21） | 中文名称、规格、英文名称、生产工厂、条码、长宽高、单重、装箱数量、装箱长宽高、单箱重量、是否液体、有效期、单箱/单瓶立方、工厂货期、运输时间、备注 | 按既有“本地值 / 上次采用值 / 本次来源值”三方规则写商品修订；单位未确认字段仍按既有规则永不自动采用 |
| 仅身份/证据（2） | 日期（sourceDate）、聚水潭内部货号（iceCode） | 不写商品字段；货号用于分组/匹配 |
| 图片（imageRef） | 飞书图片引用（fileToken/宽高/type） | **已读取并作为来源证据保存**；不写商品字段、不展示图片、不下载图片文件（二进制能力已实测但未接入）。未完成项 |
| 价格（I/J/Y） | 成本价格 / 运营价格 / 单品运费 | 只进 `catalog_private.product_source_row_amounts`（受限证据），不进入商品字段、差异计划、待核对明细、页面或公开投影；沿用既有金额隔离机制。价格展示/采用未实现（受限字段） |
| 备注（K） | 来源备注自由文本 | 属可采纳字段，按商品资料正常展示；若备注文本自带“供货价/原价”等字样，它是来源自由文本，不是受限价格列 I/J/Y。受限价格列仍然完全不展示 |
| 本次未见 | 来源行消失 | 只标记“本次未见”，不删除商品、不解绑、不清零库存 |

## 3. 实现

- **真实读取**：`src/features/catalog/product-source/feishu-capture.ts`
  - `captureFeishuProductSource({ snapshotDir, cliRunnerPath?, now? })`；子进程 stdout/stderr 走临时文件（本机沙箱不接受 pipe stdio），每条命令 120s 超时；失败返回错误码不抛。
  - 生成契约 `ice-product-source-snapshot-v1`（`origin=real_capture`、`method=feishu_api`）与 `.capture.json`/`.capture-metadata.json` 证据；同内容不重复落盘。
  - 图片引用编码 `image:<canonical JSON>`；`normalize.classifyFieldCell` 将其识别为 observed 证据，但 imageRef 仍不在可采纳白名单。
- **读取状态**：`src/features/catalog/product-source/reader-status.ts`（`reader-status.json`，缺失/坏 JSON 返回 null；合并原子写）。
- **只读定时进程**：`scripts/catalog/feishu-source/{worker,start-worker,stop-worker,status}.mjs`
  - 默认 60 分钟；启动先读一次；只生成待应用快照，不连数据库、不应用批次；marker/归属校验沿用 shipment 模式。
  - 已接入 `scripts/inventory/{start-instance,stop-instance,status}.mjs`（启动顺序：PostgreSQL → Web → 库存 worker → 物流读取 → **商品来源读取**）。
- **服务/页面**：`service.ts` 新增 `readProductSourceNow()`（手动真实读取 + 差异预览，不写商品）；面板新增“立即读取飞书来源”、定时读取状态（运行/间隔/最近结果/最近读取/下次计划/失败原因）、真实模式标识；采用/待核对/历史沿用既有页面与组件。
- **数据库**：应用 **`db/catalog/015_product_source_sync.sql`** 到现役实例（此前现役库未安装）。应用前备份：
  `.local/catalog/fs-catalog-real-20261110/backup-pre-015`（dump 23,609,613 B，sha256 `8638517a…2d226cceb`）；
  应用时间 2026-11-10 09:44（+08），单事务、`ON_ERROR_STOP=1`，exit 0；未修改 001–014。

## 4. 可操作入口

**日常入口（2026-11-10 本轮）**：`http://127.0.0.1:3011/dashboard/sync` 三个来源卡下方的
「飞书商品资料」区块——首屏可看读取状态、计划、已读取待应用、已采用与待核对数；下方是同一份现有来源面板
（立即读取 / 预览 / 应用本批 / 待核对清单 / 批次历史），读写动作全部复用既有 server actions。
商品库工具栏「待处理」现同时列出来源待核对事项：可看货号、问题字段、来源行，并提供商品资料/飞书原表定位入口
与“修正后重新读取、应用本批”的步骤说明；「标记已处理」仍是来源面板原语义（只关闭事项，不改写商品资料）。
原有页面 `http://127.0.0.1:3011/dashboard/catalog/sources` 底部「飞书商品来源」面板保留（同一组件）。

（`admin@catalog.test`，密码见实例 `login.local-preview.txt`。）

| 操作 | 方式 |
|---|---|
| 手动真实读取 | 页面「立即读取飞书来源」→ 生成待应用快照 + 差异预览（不写商品） |
| 应用本批 | 页面「应用本批」→ 按既有计划写商品修订/待核对（人工触发） |
| 预览已保存快照 | 页面「预览已保存快照」 |
| 定时读取 | `node scripts/catalog/feishu-source/start-worker.mjs --run-id run-20261026T211500Z-11a22b33`（默认 60 分钟，`PRODUCT_SOURCE_READER_INTERVAL_MINUTES` 可调） |
| 定时状态 | `node scripts/catalog/feishu-source/status.mjs --run-id run-20261026T211500Z-11a22b33` |
| 停止定时 | `node scripts/catalog/feishu-source/stop-worker.mjs --run-id run-20261026T211500Z-11a22b33` |
| 只跑一轮 | `node scripts/catalog/feishu-source/worker.mjs --config <instance>/product-source-reader.json --once`（0=captured/unchanged，1=failed） |

当前运行现场：定时读取 pid 42864，间隔 60 分钟，最近一次 `unchanged`，下次计划 11:10（+08）；
来源快照在 `<run>/source-snapshots/feishu-20261110T014211Z-3b5051a0.json`（snapshotKey `3b5051a0…febbd`）。
Web BUILD **`w_qGpK0pHV5HbtEyW9SBz`**（源码快照 `09f52be7…`，2026-11-10 10:39 +08 promote，
包含日常使用入口 v1、N1/N5 补修与“仅真正有 failed 项才显示补做按钮”的收口）；同日上一构建
`-wPxwf0J9shnScvTzW27h`（源码快照 `6f91905639ffea88…`）为首轮审查后补修构建，已被本轮替代。

## 5. 本次真实采用结果（现役库，2026-11-10 09:50）

| 项 | 结果 |
|---|---|
| 批次 | 1 批，`origin=real_capture`，`status=partial`，快照 404 行（业务 131 / 空 272） |
| 计数 | 新品 0 · **已更新 91** · 无变化 23 · **待核对 12** · 失败 0 · 本次未见 0 |
| 商品写入 | 94 个商品各 +1 修订（91 update + 3 needs_review 部分写入），商品总数仍 **126**（UUID 不变，无新建/重复） |
| 绑定 | 117 条，全部指向既有 `catalog_item` UUID（0 悬空）；货号沿用 |
| 待核对 | 12 条 open：同号多行不一致 4、字段值非法 7、缺码 1；页面列在待核对清单，可标记处理 |
| 来源采用 | 首轮基线写入 **94 个商品的 104 个字段**（生产工厂 93 项 + 来源备注 11 项，部分商品两者都有）；其余本地有值与来源不同者保留本地并待核对 |
| 价格隔离 | `product_source_row` 403 行、公共 JSON 无价格语义键；私有 `product_source_row_amounts` 130 行；快照价格 365 格 / 130 行 |
| 图片 | 快照记录 128 个图片引用；未写商品字段、未展示、未下载（见 §2 未完成项） |
| 证据 | 批次回执、结果、issue、artifacts(3)、修订均可在库/页面复核；页面与详情/history 已实拍 |

## 6. 验证证据

证据目录：`.local/catalog/fs-catalog-real-20261110/`（不入 Git）。

| 场景 | 结果 |
|---|---|
| 真实读取（首次 / 重复） | `captured` / `unchanged`；业务行 131、唯一码 125、图片 128、价格 365；重复不重复落盘 |
| 读取失败 | 坏 runner → `failed` + `FEISHU_CLI_MISSING`，无新快照；11 项离线测试覆盖各失败码 |
| 差异预览 | 与采用结果一致：0 新品 / 91 更新 / 23 无变化 / 12 待核 / 0 失败 / 0 未见（`verify/live-preview.json`） |
| 采用（现役） | `partial`，94 修订，126 商品不变，117 绑定，12 open issues；`verify/ui/ui-result.json`、截图 01–07 |
| 详情/历史 | `/dashboard/catalog/<itemId>` 显示 生产工厂=来源值、变更记录含「来源首轮基线」；`verify/ui/detail-result.json` |
| 重复采用 | scratch 库对同一快照再应用 → `duplicate`，商品/修订/批次零新增（`verify-real-flow*.json`） |
| 人工修改冲突 | scratch 库 LS101274：人工改规格 + 来源同时改不同值 → `needs_review`/`FIELD_CONFLICT`、本地值保留、无冲突字段照常写入（19 断言通过） |
| 价格隔离 | scratch：私有表 130 行与快照逐行精确一致；公共 cells = 来源−价格列；156 个价格指纹值未出现在任何公共输出（D/D2 21 断言）；现役 130 行 |
| 失败状态展示 | 临时注入失败状态后页面显示“最近失败原因…”；随后恢复原状态（`detail-result.json`） |
| 回归 | `tests/catalog/feishu-capture.test.ts` 11 项 + `product-source*.test.ts` 72 项通过；`npx tsc --noEmit` 仅既有 BEST 5 基线 |
| 现役链路 | 3011 login 200；库存 worker、物流读取、商品来源读取均 `owned`；未改动库存/物流数据 |

### 6.1 首轮独立审查（2026-11-10）—— PASS，阻断 0

独立审查员（只读，未采信执行方汇报）结论 **PASS，阻断 0**，报告
`.local/catalog/fs-catalog-real-20261110/independent-review.md`。独立取证覆盖：真实读取实现与无写飞书调用、
015 对象/权限与文件 sha256、批次/结果/修订/绑定/待核对/私有金额/artifact 逐项查库、126 个商品 UUID 与
015 前备份逐一比对（0 新增/0 缺失）、真实页面与详情/历史（console 0）、原始响应自算计数、73+72 项测试复跑、
tsc 仅既有 BEST 5。审查列出的 9 条非阻断观察中：N1（逐项结果 updated 标签“状态未标注”）与 N5（手动 `--once`
挤动定时计划）已在本包修复并复验（页面 126 条结果中 91 条显示“已更新”、0 条“状态未标注”；
`--once` 前后 `nextRunAt` 保持 11:10、worker 归属仍为 42864）；N2/N3/N4/N7/N9 已补文档/证据
（见任务文档与证据 README）；N6（现役库既有 ISOLATED TEST 污染）、N8（`product_source_row.fields`
未使用）保留记录，不影响本包结论。

### 6.2 审查后补修与自验（2026-11-10，执行方）

- **N1（逐项结果状态未标注）**：`service.ts` 用 `classificationOf(result.action)` 生成分类标签；
  页面上 126 条结果中 91 条显示“已更新”，0 条“状态未标注”。
- **N5（手动 `--once` 挤动定时计划）**：worker 在 `--once` 模式下不回写 `nextRunAt`/worker 归属；
  复验 `--once` 前后 `nextRunAt` 保持 11:10（+08）、worker 仍为 42864。
- **补做按钮收口**：`canRetry` 只在批次状态 `failed`，或 `partial` 且 `failed > 0` 时为真；
  partial 但失败为 0 时“补做失败商品”按钮不显示（最终 BUILD 已复验不存在）。
- 补修后重新构建 BUILD `-wPxwf0J9shnScvTzW27h`（源码快照 `6f91905639ffea88…`，2026-11-10 10:16 +08）；
  定向单测 83 项通过；`tsc` 仍仅仓库既有 BEST 5；`git diff --check` 0。
- 以上补修属于审查后自验，**不替代首轮独立 PASS 的范围**；最终差异复核见 §6.4。

### 6.3 日常使用入口 v1（2026-11-10 本轮）

本轮的改动仅限“日常入口 + 待处理定位 + 文档登记”，读取/采用/历史机制未改：

- **数据同步来源**：`/dashboard/sync` 三卡下方新增「飞书商品资料」区块（`FeishuProductSourceSection`），
  首屏展示 **已读取 / 已读取待应用 / 已采用 / 下次计划 / 待核对**，并嵌入同一份现有来源面板；
  “已读取”只表示生成待应用快照，“已采用”只表示最近一次写入商品资料的批次（DTO 新增 `read` / `applied`）。
- **商品库待处理**：`product_source_issue review_state=open` 投影为 `product_source_review` 事项，
  列表显示货号/名称、问题字段、来源行；每条给出商品资料与飞书原表定位入口，
  并说明“改完回数据同步重新读取、应用本批”；「标记已处理」仍是来源面板原语义（只关闭事项，不改写商品资料）。
- **未扩大范围**：不重建数据库、不重新采用、不改读取/写入分支、不新增审批流或“已读”状态；
  图片/价格采用等未完成项原样保留（§2、§7）。

### 6.4 最终差异复核（2026-11-10）—— PASS，阻断 0

独立复核（只读，自写 Playwright/查库脚本，未采信执行方汇报）结论 **PASS，阻断 0**，报告
`.local/catalog/feishu-source-daily-20261110/independent-diff-review.md`。独立取证覆盖：
真实浏览器全链路「数据同步 → 商品来源 → 预览/结果 → 待处理 → 详情弹窗 → 去处理」（console/pageerror 0）；
「已读取 vs 已采用」语义与「标记已处理只关闭事项」；最终 BUILD `w_qGpK0pHV5HbtEyW9SBz` 的
N1（91 条“已更新”、0 条“状态未标注”）、N5（自行 `--once`：`nextRunAt` 保持 11:10、worker 42864 不变）、
补做按钮 DOM=0；DB 不变（126 商品 / 222 修订 / 1 批次 / 117 绑定 / 12 open，09:54 后零写入、无新迁移、
价格/图片零泄漏）；BUILD/源码快照/工作树四处一致；标准测试 819/820（唯一失败为既有 opt6 换行基线）、
tsc 仅既有 BEST 5、`git diff --check` 0、改动文件 eslint 0；HEAD 未变、无提交/推送、首轮未提交改动与
deploy-prep 改动均保留。

非阻断观察 4 条：O1 顶层 README 运行现场 BUILD 仍为旧值（**已在本轮复核后更新**）；
O2 待处理来源事项未直接显示“同号多行/字段值非法/来源缺码”类型标签（可由问题字段/来源行定位，保留观察）；
O3 来源缺码事项标题回落为“来源第 122 行”、未用 issue detail 中的商品名（保留观察，见 §7）；
O4 复核者为验证 N5 执行一次只读 `--once`，`lastRunAt` 推进到 10:46，`nextRunAt`/worker 归属不变（预期）。

- **图片展示与存储未接入**：只保存引用证据；未下载/缓存图片，未在商品详情展示（二进制下载能力已实测）。
- **价格展示/采用未实现**：按既有规则仅受限证据，不进入页面；金额权限机制沿用。
- 定时读取只生成待应用快照，**不自动采用**；采用仍由管理员确认。
- 同号多行不一致、缺码、单位未确认、非法数值按既有规则进待核对，不在本包自动修复。
- 未做完整权限矩阵、真实撤权、200% 缩放、多日稳定性；未做 Mac 迁移验证。
- 本包结论仅限本机现役实例 + scratch 库；首轮 PASS 与最终差异复核 PASS 均由独立审查给出，
  执行方不自行宣布 PASS。图片展示/下载与价格展示/采用仍未完成（见上）。
- 日常入口保留的 2 条非阻断可读性观察（复核报告 O2/O3）：待处理来源事项未直接显示“同号多行/字段值非法/来源缺码”
  类型标签（可由问题字段与来源行定位）；来源缺码事项标题回落为“来源第 122 行”，未用 issue detail 中的商品名。
  本轮不扩大修改，留待后续小修时一并处理。
