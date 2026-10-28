# 商品库存双视图与数据同步界面 v1 — 执行交付说明

当前裁定：**INVENTORY_SYNC_UI_V1_LOCAL_PASS**（2026-10-28主审独立复审通过）。[独立报告](../../.local/inventory-sync-ui-tail-independent-20261028/independent-review.md)、[尾项验收说明](inventory-sync-ui-v1-tail-repair-acceptance.md)为现役结论；T1–T3已关闭，无剩余功能修复。本文件下方原合同或分轮记录保留原历史身份。

独立核实（改前基线）：17:22自然批次650条海外来源逐值0差异、116商品原核心汇总0差异、887条国内来源逐值0差异及118个UUID关联；当时 BUILD `FmTvwhh6Lepdd7MSjJuwJ` 的610源码文件/415编译产物一致。R1–R6 已集中补修并更新到 BUILD `6h01rzCy_6foml5S6u1HH`；未修改业务数据、worker、计划或正式对应；旧接入/速度包不重开。

人工验收进一步明确：删除独立市场下拉；每行合并一个详情入口，点击立即打开可见弹窗/抽屉；表格固定表头、商品列和分页底栏；移除库存说明墙；同步首页改为每来源一行，详情与设置按需打开。执行交接以完整文字为准，不假定agent能看见截图。

以下为首轮执行方历史交付记录，原停止点 INVENTORY_SYNC_UI_V1_IMPLEMENTED_AWAITING_INDEPENDENT_REVIEW；“唯一入口、返回恢复、双码不合并”等完成声明须以上方独审纠正为准，不代表通过。
执行合同：[inventory-sync-ui-v1.md](inventory-sync-ui-v1.md)。本文件只记录**已实现 / 已自验 / 待确认 / 未覆盖**，不代表通过，也不代替独立审查。

## 1. 已实现（代码与运行态）

### UI-01 商品库：资料优先 + 唯一「来源 SKU 对应」入口
- `/dashboard/catalog` 主表列改为商品资料（图片/名称主、ICE 货号、69 编码、规格/单位、资料状态），采用进货价降为次要小字；库存与货值不再占主表中心，改为「N/M 仓有当前库存」+「查看库存」定位链接（货值仍显示“暂未计算”）。
- 搜索/仓库筛选/刷新/清空/待处理入口/分页/详情弹窗保留；详情默认分区为「商品资料」；修订历史与来源查看沿用原组件。
- 页头新增唯一入口「来源 SKU 对应」→ `/dashboard/catalog/mappings`（带 `from`/`back` 上下文）。
- 新增 `/dashboard/catalog/mappings`：服务端 `requireInventoryAdmin` + 现有 `read_inventory_mapping_queue`；复用 `MappingQueue`（确认/换绑）与 `ConfirmedMappingList`（重核/停用/换绑），动作机制与服务端语义未改；页面区分 BigSeller 正式库存对应 / 旧 BS·JST 样表「本批采用」/ 飞书商品资料来源（`/dashboard/catalog/sources` 链接保留）；`back` 只接受 `/dashboard/{catalog|inventory|sync}` 站内路径。
- `workspace-shell` 面包屑新增 `/dashboard/catalog/mappings` → 「来源 SKU 对应」，侧栏仍归属「ICE 商品库」。

### UI-02 仓库明细（默认视图）
- `/dashboard/inventory` 默认 `view=warehouse`：一行 = 来源账号 × 仓库 × SKU，**产品名称为主、来源 SKU 为辅**；SKU 为次要文字、可复制；未对应行显示来源名称并标「待确认归属」，来源缺名才退回 SKU。
- 行来自每仓 `inventory_warehouse_state.last_batch_id`（最后完整成功批次）的 adopted + unmapped 行，加 `pending_adoption` 说明行；来源原名/GTIN/原始数量文本来自同批 `inventory_run_row`（run + excelRow 对齐）。
- 列：商品（名称/SKU）、国家/仓库（市场待确认单独标注）、实物库存、可售库存、状态/数据时间、操作；行详情（`?row=`）含原始数量文本、锁定/预留/在途、批次/原表行、资料版本、原始文件、来源说明。
- 全部参与仓（7 个 confirmed）可查；弃用仓不出现；真实 0 原样展示（本批 adopted 行中 247 行为 0）；未对应 220 行保留且不计入；`pending_adoption` 本批 0 行（逻辑已实现）。
- 搜索覆盖商品名称/货号/69 编码/来源 SKU/来源原名；市场/仓库筛选与既有列表语义一致；未知仓库按 `INVENTORY_WAREHOUSE_UNKNOWN` 明确失败。

### UI-03 商品汇总
- `view=product`：一行一个标准商品，列为商品、国内（表格快照）、各市场（ID/MY/PH/TH/VN…）、市场待确认、海外实物合计、状态、操作。
- 每格按**完整筛选范围**计算；数据复用 `inventory_read_context` + `inventory_item_summary_core`（与 `read_inventory_list` 同口径）并按市场聚合；单位冲突/同仓双码待合计时显示“多单位，不合计 / 合计待核对”，不凑数。
- 点击市场数量 → 同商品同市场仓库明细（`focus` 高亮）；明细行「商品汇总」反向定位；返回保持视图与筛选。
- 商品集合 = 既有有效库存/对应/待核线索的标准商品 + 国内快照有已核对关联的商品（纯国内商品补行，不伪造海外数量）；无标准商品归属的来源行不计入，给出可定位提示。

### UI-04 国内冻结表格快照
- 权威输入：`BASELINE_DIRECTORY` 下 `coverage/source-records.json`（SHA256 `bcee12bc…a25d`，校验通过）；不重找桌面 CSV、不覆盖冻结输入。
- 只读展示 887 条聚水潭来源：`review_state='manual_selected'` 且关联到标准商品 UUID 的 118 条计入国内汇总，其余 769 条可查不计入；文件分布 877（`商品资料_20261015165159…`=2026-10-15）+10（`商品资料_20261016111727…`=2026-10-16），选择分布 111+7；118 条全部关联到 118 个不同商品 UUID。
- 字段：`实际库存数`←`source.extra.actual_qty`，`可用数`←`source.available_qty`，`运营云仓可用数`原文单独保留（不并入）；单位/仓库/确切观测时间未注明；仓库列固定「国内 · 原表未注明仓库」；文件日期只从原文件名取得。
- 服务端：新增 `catalog.read_inventory_domestic_links()`（`db/catalog/023_inventory_domestic.sql`，只读、`require_admin`、GRANT 仅 app 角色）+ `getInventoryDomesticSnapshot()`；进程级只缓存校验通过的冻结快照（22ms 解析，后续复用），每次读取仍先服务端鉴权；读取失败返回 `available=false` + 中文原因，不显示 0。
- 不接 JST 实时同步、不写回原表、不写历史，也不与海外数量相加。

### UI-05 数据同步
- 首屏「当前状态」：BigSeller 账号登录、后台程序在线、最近一次任务结果、最近全部成功时间、下次自动同步、参与仓库、待处理来源对应；只有真实异常才出现醒目异常条（登录失效/账号停用/后台未登记或离线/空范围/任务失败或部分成功/结果待核对/原请求待核对），正常显示「运行正常」。
- 操作分级：「立即同步」主按钮常驻；「刷新状态」「同步设置」次要；设置面板默认折叠（空范围默认展开），保存按钮只在面板内，默认摘要显示已保存频率/范围/下次计划；有草稿时提示“立即同步仍使用已保存范围”。
- 逐仓结果表以新只读函数 `read_inventory_warehouse_states` 为准：仓库、最近一次任务结果（标“本次任务”）、当前数据时间 + 发布时间、待处理（未对应）数量、失败/旧值说明；「同步成功，另有 N 条来源待对应」与「已全部对应」分开；文件保存成功 ≠ SKU 全部已对应。
- 记录/任务详情（`?run=`）/原文件与问题行/后台诊断按需展开；对应处理从本页移出，改为 `sync-mapping-entry-link` 定位到商品库唯一维护入口；不搬 Demo 模拟按钮；国内快照标明“不建议为自动同步成功”。

### 共用
- 视图/来源范围（海外 / 国内快照 / 全部）/搜索/市场/仓库/分页/展开行/商品明细均走 URL，刷新、前进后退不丢上下文；两个来源分开计时、分开计数，不提供跨来源“全球总库存”。
- 新增只读读模型 `db/catalog/022_inventory_dual_view.sql`：`read_inventory_warehouse_states()` / `read_inventory_warehouse_rows(p_search,p_warehouse,p_market)` / `read_inventory_product_summary(p_search,p_warehouse,p_market,p_limit,p_offset)`；全部 `SECURITY DEFINER` + `search_path=''` + `require_admin()` + 固定账号，EXECUTE 仅 `ice_p0_02_app_runner`；不建表、不改 schema version、不改 00001–021。
- `scripts/inventory/prepare-instance.mjs` 追加 022/023 幂等重放（新实例/重新 prepare 后即可用）。

## 2. 执行方自验（不是独立审查结论）

| 项 | 结果 | 证据 |
|---|---|---|
| 数据对账（新读模型 vs 批次事实/既有读模型/冻结表格） | **28/28 通过** | `.local/inventory-sync-ui-v1-20261027/verify/data-reconcile.json` |
| 真实页面闭环（登录 → 商品库 → 仓库明细 → 搜索/单仓/国内 → 未对应/真实 0 → 行详情 → 商品汇总 → 点市场回明细 → 库存明细 → 分页/刷新 → 对应入口 → 同步页 → 设置面板） | **37/37 通过**，无页面脚本错误 | `.local/.../verify/page-checks.json`、`pages/*.png` |
| 受影响路径补验（旧库存 URL 安全引导、商品详情弹窗默认「商品资料」、映射页返回带原筛选） | **9/9 通过** | `.local/.../verify/affected-paths.json` |
| 隔离环境写动作闭环（待核来源定位 → 采用建议 → 填单位/理由 → 确认 → 回原筛选） | **11/11 通过**（副本库写入 version 1 / verification=true / 待核 98→97 / 审计 `confirm_inventory_mapping`） | `.local/.../isolated/mapping-flow.json` |
| 纯逻辑单测（双视图合并/分页、读模型归一化、国内快照解析） | `tests/inventory` **9 文件 156 项通过**（新增 47 项） | vitest 输出 |
| 类型检查 | 全仓仅既有 BEST 5 条基线错误，本包文件 0 新错 | tsc |
| Lint（改动文件 `--max-warnings 0`） | 通过 | eslint |
| 生产构建 | staging 构建成功并 promote；最终 BUILD **`FmTvwhh6Lepdd7MSjJuwJ`** | `build-webpack.log`、`preview-build-ready.json` |
| 页面耗时（最终 3011，导航复位 11 项） | 346–720ms（仓库明细 526、汇总 583、搜索 351、单仓 346、国内 359、第二页 359、商品库 720、映射页 400、同步 352） | `page-checks.json` |
| 读模型耗时（app+admin，3 次中位） | states 3.7ms、rows(650) 59.6ms、summary(116) 347.3ms；国内 RPC 约 204–233ms | `db-model/README.md`、`domestic/README.md` |

### 数据对账要点（正式库当次自然批次 `aad9190a…`，2026-10-27 16:22 成功）
- 7 个参与仓最后完整成功批次合计 650 行：adopted 430 / unmapped 220 / pending_adoption 0，逐仓行数与独立 SQL 一致（VN 88=78/10、TH 114=91/23、ID 112=91/21、PH 彩妆 21=0/21、MY 56=26/30、PH 新创启辰 116=53/63、DEE 143=91/52）。
- WM0026：越南仓 `757577983013=1857`（excelRow 663）；菲律宾新创启辰仓同商品两码 `757577983013=3116` 与 `ICEWM0026=4136` 各自独立展示、不合并；汇总 `knownSubtotal=5646` 并按既有规则标「合计待核对」。
- 真实 0：adopted 行中 247 行 onHand=0 原样返回（`rawOnHand='0'`）。
- 商品汇总 116 个商品的 `knownSubtotal / unitConflict / hasPendingTotal / 覆盖仓 / unitGroups / markets` 与 `read_inventory_list` 同筛选逐项一致；102 个单一单位且无待合计商品满足 Σ市场格 = knownSubtotal；marketCells 与独立按市场聚合 0 差异；未知市场单独成格（91 个商品含未知市场仓）。
- 国内：887 / 118 / 877+10 / 111+7 / 118 条全部关联；`actual_qty` 非法或缺失不转 0（当前 118 条均为整数文本，含 0 值）；可用数负数原样保留（14 条）。
- 权限：无 JWT / 非管理员调用新函数均 `CATALOG_FORBIDDEN(42501)`；未知仓库 `INVENTORY_WAREHOUSE_UNKNOWN(22023)`。

## 3. 最终现场（本机 3011）

- 入口：**http://127.0.0.1:3011**（登录 `admin@catalog.test`，密码见实例 `login.local-preview.txt`，不入库）。
- BUILD **`FmTvwhh6Lepdd7MSjJuwJ`**（pid 45540，workspace 源快照 `7574beea…` 与 `preview-build-ready.json` 一致，源码漂移 false）。
- 实例 `run-20261026T211500Z-11a22b33` / PG 59345 / 库 `iceos_catalog_run_20261026T211500Z_11a22b33`；schema version 6、`source_sha256=c08eace8…`、`functions_sha256=0c551192…`（022/023 为独立增量只读函数，文件哈希单独记录）。
- worker `inv-worker-59345`（pid 42072，冻结源 `1db4017a…`）未重启；自动同步仍开启、60 分钟、7 仓、configVersion 3、下次 17:22；最近自然计划批次 16:22 成功。
- 业务数据未改：126 商品 / 126 货号 / 430 正式对应 / 98 待核候选 / 7 参与仓 / 22 runs / 154 批次 / 14300 批次行 / 1576 来源观察。

## 4. 未覆盖 / 待确认（不得写成通过）

- 隔离闭环只到“确认写入 + 回原筛选”；**“下一完整批次采用”需真实导出/发布**，本包未重抓导出于隔离库，未演示“确认后下一批次才计入”的时间线（沿用 v4-final A1 独立通过证据，未重跑）。
- 失败/无权限/真实空/迟到响应等仍为既有受控探针或单测覆盖，本包未在正式库制造失败，也未重跑完整权限矩阵；未来多角色/人员数据范围不在本包。
- 真实 200% 浏览器缩放未专项验证；网络断开、自然登录过期、多机/断电并发未覆盖。
- 同步页“逐仓结果”以 `read_inventory_warehouse_states` 的当前批次为准，最近一次任务仅作“本次任务”列；任务详情 `?run=` 保留原口径。旧 `/dashboard/sync` 上的映射队列 testid 已迁至 `/dashboard/catalog/mappings`，历史浏览器套件（v3/v4/final）中针对旧位置的步骤未重跑/未改写。
- 弃用仓（昕兰PH自建仓）仍会以“(弃用)”字样出现在待核队列（既有队列数据源行为，未在本包改动）；双视图与本包新增读模型只显示参与仓。
- 未接 JST 实时同步、未写回原表、不做估值/运费/销量/预警；未提交/推送/合并/公网部署/清场/写长期记忆。
- 两个一次性验证库（speed verify/fixture）与本次隔离副本库、旧实例、旧构建、全部旧证据保留，不自动清场。

## 5. 恢复方式（摘要）

见 `.local/inventory-sync-ui-v1-20261027/RESTORE-NOTE.md`：网页回退到上一构建、函数回退（DROP 022/023 三个+一个函数、`functions_sha256` 保持 016 哈希）、隔离副本库清理命令、以及本包不涉及的业务数据/worker/计划无需恢复。
