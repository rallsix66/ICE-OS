# 现役数据持续更新恢复与运行交接（2026-11-17）

适用实例：**`run-20261026T211500Z-11a22b33`**（Web `3011` / PostgreSQL `59345`）。
本包目标：让现役库存、物流在途、飞书商品资料三条既有读取链恢复按原计划持续读取，页面能看到真实结果，日常维护有明确入口。
本包**不**新增调度/监控系统，不改商品绑定与人工决定，不把飞书商品资料自动写入商品库。

- 库存自动同步交接：[inventory-sync-v1-runbook.md](inventory-sync-v1-runbook.md)（本包已补入第三个后台与沙箱注意事项）
- 物流在途交接：[shipment-in-transit-v1-runbook.md](shipment-in-transit-v1-runbook.md)
- 飞书商品资料（只读快照 + 管理员确认）：[feishu-product-source-real-v1.md](feishu-product-source-real-v1.md)

## 1. 进场核对（2026-11-17 16:46 前后，全部按实际进程/数据库/文件读取）

三个后台**全部不在运行**，且都停在同一时段：

| 后台 | 进场状态 | 证据 |
|---|---|---|
| 库存 worker `inv-worker-59345` | marker pid `43836` 已不存在（`INVENTORY_WORKER_PID_NOT_ALIVE`，`owned=false`） | `inventory_worker` 心跳 `last_seen_at=2026-11-12T08:59:01Z`（16:59 +08）；最后由计划任务成功于 `2026-11-12 16:22:20 +08` |
| 物流在途读取 `shipment-auto-reader-59345` | marker pid `40476` 已不存在 | 最后心跳 `2026-11-12T08:58:53Z`；最后周期 `2026-11-12 16:56` 为 `failed / SOURCE_CLI_FAILED`（lark-cli `Get wiki/v2/spaces/get_node … EOF`，网络侧读失败） |
| 飞书商品来源读取 `product-source-reader-59345` | marker pid `42864` 已不存在（`reader-status.json` 里 `worker.running=true` 是陈旧值） | `reader-status.json` 的 `nextRunAt` 停在 `2026-11-12T09:14:30Z`；`lastRunAt=2026-11-16T03:39:40Z`（11-16 11:39，上一轮人工一次性读取，非常驻进程） |

排队请求与最近读取结果（进场时）：

- **排队中 1 条**：`871de800-7bfd-48d6-b083-fb23fd2b1666`，`trigger_kind=manual`、`planned_for=2026-11-16 11:39:02 +08`、`attempt=1`、无 `started_at`，从未被领取；`inventory_sync_settings.next_run_at=2026-11-12 17:22 +08` 已过期 5 天。
- 库存最新已发布批次停在 `2026-11-12 16:22`（7 仓，`covered_slots=1`）。
- 物流最近一次成功快照 `948ba0c6…`（`revision 2425`，56 票 / 149 明细，`2026-11-16 11:38:58 +08`）。
- 飞书商品资料最近读取 `2026-11-16T03:39:40Z`（`unchanged`，业务行 133、唯一码 128、图片引用 131）；待应用快照 `feishu-20261111T011216Z-d5052e5f`（2026-11-11 09:12）仍等管理员确认。

停机原因未取得 OS 级证据，不判定根因；与既有交接记录一致：worker 无服务守护，进程消失后不会自动拉起（`inventory_worker.state` 也不会自动下线，判断在线以 `last_seen_at` 为准）。

## 2. 恢复动作（复用既有脚本，未新增启动机制）

按既有顺序一次性启动（等价于 `scripts/inventory/start-instance.mjs` 的 5 步）：

```powershell
node scripts/inventory/start-worker.mjs --run-id run-20261026T211500Z-11a22b33
node scripts/shipment/start-worker.mjs --run-id run-20261026T211500Z-11a22b33
node scripts/catalog/feishu-source/start-worker.mjs --run-id run-20261026T211500Z-11a22b33
```

实际结果（`2026-11-17 16:55`）：

| 后台 | pid | 启动后第一条事实 |
|---|---|---|
| 库存 worker | `42160` | `16:55:35` 领取排队请求 `871de800…`（不是新计划，是那条 11-16 留下的 manual 请求） |
| 物流读取 | `53028` | `16:55:40` 周期成功，56 票 / 151 明细 |
| 商品来源读取 | `53036` | `16:55:44` 周期成功，`unchanged`，133 行 / 128 码 |

会话环境注意：本机该工作区的 `.local`、`docs`、`scripts`、`tools` 没有 Low 完整性标签，DSH 受限沙箱（Low token）写这些目录会 `EPERM`，因此本次是在完全权限下启动的；三个后台进程脱离启动会话常驻，与沙箱无关。普通终端窗口启动不受影响。

## 3. 排队库存请求的真实处理结果

`871de800…` 于 `2026-11-17 16:55:35` 被领取，`16:55:57` 结束，**`success`**：

| 环节 | 事实 |
|---|---|
| 来源导出 | `16:55:54` `export_registered`：`rowCount=733`、`blankRowCount=0`、`parseStatusCounts{ok:733}`、`fileValidationStatus=ok`、`discoveryCount=8`、`accountIdentity=verified`；文件 `…\inventory-work\exports\库存清单20261117085550547.xlsx`（105,808 B），独立复算 SHA-256 `EFE43A4528B1966084A1C99E16E2521B8D85FC66B239317CE9A19F313595DC52`，与登记前缀 `efe43a4528b1` 一致 |
| 覆盖计划点 | `covered_slots=120`：把 `2026-11-12 17:22` → `2026-11-17 16:22` 的 120 个遗漏计划点合并为这一次补跑，不丢点、不重复发布 |
| 发布批次 | 7 个参与仓全部发布（`published=7 / failed=0 / blocked=0 / noRows=0`，`scopeAllSuccess=true`），越界行 78（排除仓 `48787 昕兰PH自建仓(弃用)`） |
| 逐仓行数 | 龙仔厝 144（采纳 101 / 待对应 43）、曼谷 115（91 / 24）、PH-彩妆 21（2 / 19）、印尼 113（92 / 21）、喜运达MY 56（33 / 23）、菲律宾 117（107 / 10）、越南 89（86 / 3），合计 655 行 / 采纳 512 / 待对应 143 |
| 页面 | `/dashboard/sync` 海外卡（16:58 抓取）「正常 / 最近成功 2026-11-17 16:55 / 下次同步 2026-11-17 17:22」；`/dashboard/inventory` 待处理 **143**，与逐仓 `unmapped_count` 合计一致 |

## 4. 三个后台各一次真实读取 + 后续自动周期

| 后台 | 恢复时真实读取 | 之后自动周期（未人工触发） |
|---|---|---|
| 库存 worker | 16:55:35 → 16:55:57 `success`（见 §3） | **17:22:07 → 17:22:25 `success`**（计划点 `17:22:02`、`covered_slots=1`、导出 733 行 `sha256 cd311687a80a` → 文件 `库存清单20261117092221610.xlsx`、7 仓 success、逐仓行数与 §3 相同）；页面「下次同步」推进到 **`2026-11-17 18:22`**，数据库 `next_run_at` 一致 |
| 物流读取 | 16:55:40 `success`，`b16eac71…`，56 票 / 151 明细，按规则自动关联 3 条 | 17:05:44、17:15:48、17:25:52、17:35:56、17:46:00、17:56:04 共 6 次 `unchanged`（`c27ba490…` / `00fb4858…` / `8755a6df…` / `24075526…` / `c2283e4b…` / `fcc7e426…`），每次都写 `shipment_source_snapshot`（`revision 2425 → 2542`），票数/明细数保持 56 / 151；**内容未变化也留下真实读取记录** |
| 商品来源读取 | 16:55:44 `unchanged`，133 行 / 128 码 / 131 图片引用 | **17:55:48 `unchanged`**（133 行 / 128 码 / 131 图片引用，`errorCode=null`），`nextRunAt` 推进到 `18:55:48` |

飞书商品资料沿既有约束：读取只生成待应用快照（`reader-status.json` + 首次出现新内容时的 `feishu-*.json`），**不写商品库、不写飞书原表**；写入仍需管理员在页面确认，本次未做任何采用动作。当日两次读取（16:55、17:55）内容都与已采用批次 `7c9a77bd…` 一致，因此不生成新快照文件，只更新读取状态（页面写「成功读取（内容未变化）」）。

## 5. 页面与数据时间一致性（2026-11-17 17:56 复核）

| 页面 | 实际显示 | 与后台/数据库对齐 |
|---|---|---|
| `/dashboard/sync` | 海外库存：正常 / 最近成功 2026-11-17 17:22 / 下次同步 2026-11-17 18:22；国内库存：快照可用 / 最近成功 暂无记录 / 原文件 2026-10-16 · 887 条 / 下次同步 手动导入；物流在途：正常 / 最近成功 2026-11-17 17:56 · 56 票 / 151 条明细 / 下次同步 2026-11-17 18:06；商品库更新：已是最新 / 最近检查 2026-11-17 17:55 / 已采用来源 2026-11-11 18:12 | 前三项分别对上 §3 计划任务、§4 物流第 7 次读取、§4 商品来源自动周期；采用时间对上 `product_source_batch` 第 3 批 |
| `/dashboard/inventory` | 待处理 **143**，共 1,542 条；数量与货值为当前发布批次 | 143 = 7 仓 `unmapped_count`（43+24+19+21+23+10+3） |
| `/dashboard/in-transit` | 待处理 共 **56 票**；「本次来源未见 28 票 / 77 条明细（历史保留）」 | 56 = 最新快照 `ticket_count`；7 次读取均为 56 票 / 151 明细 |
| `/dashboard/catalog/sources` | 已读取 2026-11-17 17:55（内容未变化）· 待应用 1 批（2026-11-11 09:12）；已采用 2026-11-11 18:12 · 部分完成 · 新品 0 / 已更新 1 / 无变化 26 / 待核对 101 / 失败 0 / 本次未见 0；定时读取运行中 · 每 60 分钟 · 最近读取 2026-11-17 17:55 · 下次计划 2026-11-17 18:55；待应用快照：27 列 / 133 行 / 133 个来源编号 / 131 张图片引用 | 批次计数与 `product_source_batch` 第 3 批 `counts` 逐项一致；待应用快照即磁盘上的 `feishu-20261111T011216Z-d5052e5f` |

四个页面 `console` 与 `pageerror` 均为 **0**（两轮抓取都是 0）。截图与正文抽取见证据目录（`verify-pages-first.json` / 重命名前的首轮截图保留同一目录）。

## 6. 实际改动

- **业务代码、数据库、写入链：零改动**。未新增迁移、未改 `src/`、`db/`、`tools/`、`scripts/`、未改商品绑定与人工决定。
- 文档：本文件；[inventory-sync-v1-runbook.md](inventory-sync-v1-runbook.md) 补入第三个后台（进程/文件、启动第 5 步、停止命令）、日志文件名为本地日期的提示、沙箱 `EPERM` 说明；`docs/current-state.md`、`docs/tasks/current-task.md`、`AGENTS.md` 任务状态更新。
- 证据脚本：`.local/catalog/run-resume-20261117/verify-pages.mjs`（只读登录 + 四页正文抽取与截图，不入 Git）。
- 未提交/推送/部署；工作区中原有的 Mac 部署准备改动保持原样。

## 7. 尚存问题与边界

1. **国内库存仍是冻结快照**（原文件 2026-10-16 · 887 条），页面如实显示「快照可用 / 最近成功 暂无记录 / 下次同步 手动导入」，本包不处理。
2. **飞书商品资料仍待管理员确认**：待应用 1 批（2026-11-11 09:12）；已采用的第 3 批有 101 项待核对（含工厂公式 `#REF!`）；本包只读取，不采用。
3. **worker 无服务守护**：机器重启、进程被杀不会自动拉起，需按 §8 重新启动；长时间停机后由下一次领取按 `covered_slots` 合并补跑（本次 120 个点）。
4. `inventory_worker.state` 不会因心跳超时而改为 `offline`，判断在线必须看 `last_seen_at`。
5. 物流读取在本机停机前最后两次都是 `SOURCE_CLI_FAILED`（lark-cli 网络 `EOF`），本次恢复后连续 **7 次**读取全部成功（16:55 success + 6 次 unchanged），属于外部服务/网络瞬时问题，未改代码；再遇同类失败按运行交接 §7 重试即可。
6. 库存导出 SHA-256 每次导出都不同（文件内时间戳），比对以同一次任务的登记值与文件复算值为准。
7. Mac 迁移、开机自启、长期托管属正式部署交付，本包不做。

## 8. 运行交接（最短路径）

```powershell
# 启动（整实例；已运行的组件不会起第二份）
node scripts/inventory/start-instance.mjs --run-id run-20261026T211500Z-11a22b33
# 只拉起某一个
node scripts/inventory/start-worker.mjs --run-id run-20261026T211500Z-11a22b33
node scripts/shipment/start-worker.mjs --run-id run-20261026T211500Z-11a22b33
node scripts/catalog/feishu-source/start-worker.mjs --run-id run-20261026T211500Z-11a22b33

# 状态（一条汇总三个后台 + 数据库 + 页面）
node scripts/inventory/status.mjs --run-id run-20261026T211500Z-11a22b33
node scripts/shipment/status.mjs --run-id run-20261026T211500Z-11a22b33
node scripts/catalog/feishu-source/status.mjs --run-id run-20261026T211500Z-11a22b33

# 停止（不影响其它组件）
node scripts/inventory/stop-worker.mjs --run-id run-20261026T211500Z-11a22b33
node scripts/shipment/stop-worker.mjs --run-id run-20261026T211500Z-11a22b33
node scripts/catalog/feishu-source/stop-worker.mjs --run-id run-20261026T211500Z-11a22b33
```

判读与失败恢复：

- 三个后台都以「marker 文件 + pid 存活 + 进程创建时间」判归属；`owned=false` 即不是本实例的进程。
- 库存：`lastRuns[0].error_code` 为 `LOGIN_*` → 需人工登录（`python tools\inventory-sync\bigseller_session.py --login --wait-seconds 1800`，窗口内本人完成含滑块验证），登录恢复后 worker 约每 60 秒探测并自动继续，无需重启；其它失败按任务 `error_code`/worker 日志处理，已发布批次不会被覆盖。
- 物流：失败只写失败快照，页面保留上一份成功数据；计划保持启用到点重试，进程不在就按上面的启动命令拉起。
- 商品资料：读取失败看 `source-snapshots/reader-status.json` 的 `errorCode`；读取成功但内容变化时生成新快照，等管理员在 `/dashboard/catalog/sources` 预览后「应用本批」。
- 三个后台都应在**普通终端或完全权限会话**里启动（受限沙箱写 `.local` 会 `EPERM`）。

## 9. 验收状态

**独立复核 PASS，阻断 0**（复核结论由审查方给出，执行方不自宣）。复核覆盖本文件 §1–§8 的实际运行事实：排队请求真实完成、三个后台各一次真实读取 + 各自后续自动周期、四个页面数据时间与后台/数据库一致、console/pageerror 0。

执行方自验证据：`.local/catalog/run-resume-20261117/`（首轮 `verify-pages-first.json` + `*-first.png`，终轮 `verify-pages.json` + `sync.png` / `inventory.png` / `in-transit.png` / `catalog-sources.png`，以及 `verify-pages.mjs`；`checkedAt` 分别为 17:05 与 17:56）。

## 10. 复核登记与两处表述澄清（2026-11-17 补记，本包登记）

### 10.1 复核登记

本包状态：**独立复核 PASS、阻断 0**（2026-11-17）。PASS 与阻断数由审查方给出，执行方不自行宣布；上文 §9 的“执行方自验”与本节复核结论分开记录，不把自验项数计为独立复核项数。

### 10.2 澄清一：数据库结构未改

本包**没有改动数据库结构**：未新增/修改迁移，未新建或替换 `catalog` / `catalog_private` / `public` / `p0_02_*` 的库表、函数、策略、索引、权限，`schema version 6` 与 `functions_sha256` 保持原值，`db/` 目录零改动。

发生变化的只是**既有同步任务按原逻辑产生的业务数据行**（新的 `inventory_sync_run` / `inventory_batch` / `inventory_batch_row` / `shipment_source_snapshot` / `inventory_warehouse_state` 记录，以及快照目录里的 `reader-status.json`）。§6 原来写的“数据库零改动”指的是结构与写入链，指的是同一件事但表述不够具体，以本节为准。

### 10.3 澄清二：遗漏计划合并不等于历史补采

`covered_slots=120` 只表示**计划点账目**：`2026-11-12 17:22` → `2026-11-17 16:22` 之间 120 个到点未执行的计划时点，由这一次运行一次性记为“已覆盖”，因此不会在之后继续逐个补跑，也不会被判为漏点。

它**不是**历史补采：这次运行只按 BigSeller 当时返回的那一份导出读取了一次（`16:55:51` 一个观测时点、733 行、7 仓各一个批次）。`2026-11-12 17:22` 到 `2026-11-17 16:22` 之间**没有**120 份历史快照被回放，历史快照页能看到的仍是各仓实际发布过的批次（本次之前最后一批是 `2026-11-12 16:22`，之后直接跳到 `2026-11-17 16:55`）。需要真正的历史补采必须另行安排数据来源，不在本包能力内。
