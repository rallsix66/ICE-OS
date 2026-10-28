# 商品库存与 BigSeller 自动同步 v1（实现与运行说明）

更新：2026-10-28。当前状态：功能验收 **`INVENTORY_SYNC_UI_V1_LOCAL_PASS`**（2026-10-28 主审独立复审通过），文档与 Git 收尾同日完成（**`INVENTORY_SYNC_UI_V1_DOCS_GIT_CLOSED`**）；读取速度 `INVENTORY_RESPONSE_SPEED_V1_LOCAL_PASS` 与 BigSeller 本机接入 `BS_LIVE_INTAKE_V1_LOCAL_PASS` 已收尾。日常运行、恢复与输入依赖见 §0.11。

## 0.11 2026-10-28 收尾交接：职责、日常入口、恢复与输入依赖

本节给下一位维护者；现役事实以 [current-state.md](../current-state.md) 与 [current-task.md](../tasks/current-task.md) 为准，功能验收状态为 **`INVENTORY_SYNC_UI_V1_LOCAL_PASS`**（2026-10-28 主审独立复审通过，仅限本机本包）。

### 三个页面的职责与入口

| 页面 | 负责什么 | 日常入口 |
|---|---|---|
| 商品库 | 商品资料、修订与历史、价格权限；正式库存 SKU 对应的唯一维护入口；飞书商品资料来源的本地模拟更新面板 | `/dashboard/catalog`、`/dashboard/catalog/mappings`、`/dashboard/catalog/sources` |
| 商品库存 | 默认「仓库明细」（来源账号×仓库×SKU 一行，含未对应、真实 0、未知市场、同仓双码）；可切「商品汇总」（标准商品×市场格，国内列只在有效范围包含国内时出现）；详情抽屉与列表同范围；国内数量只读冻结表格快照 | `/dashboard/inventory` |
| 数据同步 | 来源状态、最后成功与下次计划、立即同步/设置（保存只在设置面板）、逐仓结果、任务历史详情（选中后详情进入视口）、待对应处理定位到商品库维护页 | `/dashboard/sync` |

唯一日常入口是 **http://127.0.0.1:3011**（正式实例 `run-20261026T211500Z-11a22b33`、PG 59345、后台 `inv-worker-59345`；自动同步开启、60 分钟、7 个参与仓、configVersion 3）。设置未保存时不会生效；页面上的状态、批次、数量是当前快照，不写死为常量。

### 本次通过范围与已知限制

- 通过范围：本机库存双视图、正式库存对应维护迁移、同步首页与任务详情、国内冻结快照只读展示。独立报告在[尾项独立复审](../../.local/inventory-sync-ui-tail-independent-20261028/independent-review.md)，逐项验收在[尾项验收说明](../tasks/inventory-sync-ui-v1-tail-repair-acceptance.md)。
- 限制：T2 旧量/旧时间是单个受控只读输入，不是正式库自然缺行；T3 只做本机 1280×720 Chromium 单次真实点击；未重跑历史全表、15×20 性能、权限矩阵、200%/断网/多机；PH 双码合计口径、未匹配归属、货值仍未决；商品汇总 1280 宽需横向滚动、同步设置在 720 高需页面滚动为既有边界。通过不等于公网发布、全 ICEOS 验收、未来员工权限或新 API 接入完成。

### 运行、构建与恢复材料

- 日常启动/停止/状态沿用实例脚本：`node scripts/inventory/status.mjs --run-id run-20261026T211500Z-11a22b33`、`scripts/inventory/start-instance.mjs`、`stop-instance.mjs`、`start-worker.mjs`、`stop-worker.mjs`；本机网页用 `CATALOG_PREVIEW_PORT=3011 CATALOG_PREVIEW_NEXT_MODE=start node scripts/catalog/start-local-preview.mjs --run-id run-20261026T211500Z-11a22b33`。
- 构建链：`scripts/catalog/build-preview-workspace.mjs` → `scripts/catalog/promote-preview-build.mjs` → 启动上一条命令；就绪与 PID 记录在实例 `instance/preview-build-ready.json`、`instance/preview-server.json`。
- 恢复材料：[尾轮回退说明](../../.local/inventory-sync-ui-tail-repair-20261028/RESTORE-NOTE.md)（网页回退到 `next-build-6f89fe4d79f3f950`、016 回退脚本 `rollback/rollback-sql.mjs` dry-run 已验）、[保护说明](../../.local/inventory-sync-ui-tail-repair-20261028/PROTECTION.md)、[上一轮恢复说明](../../.local/inventory-sync-ui-v1-20261027/RESTORE-NOTE.md)。21 个 `next-build-*`、3042 旧预览（pid 14028）和全部历史证据保留，未清场。
- 不要为恢复重启 worker 或改 60 分钟计划、7 仓范围、430 条正式对应与库存事实；本轮修复没有动这些。
- Git：2026-10-28 已把自 `1bd0cb8` 以来未提交的已验收实现按依赖顺序提交并普通推送 `origin/codex/ice-v4-planning`（含本收尾文档提交；本地与远端一致，未 force/合并/部署/清场）。`.local`、私有输入、数据库与构建产物未入库；工作区仅剩未跟踪的 `.local`。完整提交号与推送核验见 `.local/inventory-sync-ui-git-closeout-20261028/closeout-record.md`（本地证据不入库）。

### 国内快照的本地输入依赖（私有，不入库）

- 权威输入是 `src/features/catalog/sources/baseline-adapter.ts` 的 `BASELINE_DIRECTORY`：`.local/p0-03/run-20261020-final-acceptance/evidence/final-2026-10-20T03-41-45-834059Z-cd7d4d19/delivery-final-v2/`；其中 `coverage/source-records.json` 固定 SHA256 `bcee12bcb555e73f50a3eabd504766ff3c401d2fb58e194ebb6c24441f6ba25d`。
- 该文件由两份冻结表派生：`input-2.frozen.xlsx`（`9f42843a…`，原名 `商品资料_20261015165159_…xlsx`）与 `input-3.frozen.xlsx`（`7fca9bee…`，原名 `商品资料_20261016111727_…xlsx`）；`match-bundle.json`（`28d8d81c…`）和 `manual-decisions.effective.csv`（`4428f4c8…`）同目录。当前 887 条聚水潭记录、118 条有效选择、118 条可关联商品 UUID，由 `db/catalog/023_inventory_domestic.sql` 的只读函数提供关联。
- 重启后仍从磁盘读取并校验 SHA；缺失或不匹配时国内快照显示不可用原因，不显示 0、不伪造历史，也不重新找桌面 CSV、不写回原表、不启动 JST 自动同步。部署/换机时需把该冻结目录随受限输入一起恢复。

### 后续边界（不自动实施）

人员按市场/仓库/金额分权限、真实飞书 API 与其他新来源接入、PH 双码合计口径、46 同码冲突与 174 未匹配待核的人工决定、货值/费用口径、inactive 与 pending_adoption 真实样本、200%/断网/多机/完整权限矩阵。以上保持原边界，不因本包通过自动开始。

## 0.10 2026-10-27 读取层响应速度优化（执行方自验，待独立审查）

**读取口径与返回语义不变，只把“逐商品×逐仓重复读取”改为一次请求内建上下文并批量汇总。** [任务包](../tasks/inventory-response-speed-v1.md)、[验收说明](../tasks/inventory-response-speed-v1-acceptance.md)、证据 `.local/inventory-response-speed-v1-20261027/`。

- 仅改 `db/catalog/016_inventory_sync_functions.sql`（函数层，无 DDL/新表）：新增请求内上下文 `inventory_read_context`、批量逐仓缺口 `inventory_item_gaps`、共享汇总核心 `inventory_item_summary_core`；`read_inventory_list` / `read_inventory_item` 复用同一核心；旧 `inventory_item_summary` / `inventory_item_warehouse_gap` 保留原签名作为包装。生效库存模型仍是每仓最近完整成功批次 + 仍有效对应，未回退旧 `inventory_current`，未加跨请求缓存。
- 正式 3011 同批次 `0f4b73bf…` 实测（3 样本中位）：50 行列表 SQL 3492→193ms、页面 3442→420ms；10 行 734→97ms；第 2 页 3798→403ms；搜索 391→389ms；仓库筛选 1708→410ms；打开详情 3892→444ms；收起 3814→467ms。一致：隔离副本同快照 288/288、正式库安装前后 288/288、夹具副本（失败/未见/待采用等）288/288 均 0 差异，页面链 34/34。
- schema version 6 不变，`catalog.inventory_schema_state.functions_sha256` 由 `c36c90a0…` 更新为 `0c551192…`（= 当前函数文件哈希）；BUILD `p7im9R07D7iqkV_2mNKNJ`。worker、60 分钟同步计划、业务数据、430 正式对应、历史与原 Excel 均未改。
- 未覆盖：客户端局部刷新（页面已约 0.4–0.5 秒，按任务包停止，请求数未变）、真实断网/多机并发/200%/旧 15×20 矩阵；未提交/推送/合并/公网部署/清场/写长期记忆。

## 0.9 2026-10-27 R1说明条件关闭与本机接入验收

**2026-10-27 主审独立复审通过：`BS_LIVE_INTAKE_V1_LOCAL_PASS`。** [独立报告](../../.local/bs-live-intake-r1-text-independent-20261027/independent-review.md)。R1 最后一处错误空态已关闭：主审实际走查 3011 的 WM0026 越南、MY、菲律宾，正常采用行不再显示“暂无已采用”；1853、672及待核0行、3119/4138双码分别展示和待合计说明均保留。失败旧值/旧时间等分支源码未改，既有受控探针核读沿用，未制造真实失败。

3011 BUILD `MB1i1eT7pYCsG8qdb1iea`，600个构建清单文件一致；唯一业务改动为现有组件+2行。worker PID42072、创建时间及9个冻结文件一致。本轮未连数据库、未触发导出、未重启或改计划；430正式对应/数量对账/R2/定时同步与A1/B/C沿用前轮可信独审，不重跑无关套件。**本机正式接入与统一库存入口v1收尾，无新增修复包。** 未匹配归属、PH双码合计口径、货值暂未计算及旧投影观察项保持原边界；数据、旧现场、失败证据全部保留。本地通过不等于公网部署或全ICEOS验收。

### 本轮执行方自验与恢复信息（保留记录）

- 只改 `src/features/catalog/components/catalog-detail.tsx` 的 `scopeReason`（+2 行）：正常 `current` 且有采用行时返回 `null`，不再与“本仓暂无已采用的 BigSeller 库存行”同屏；failed（保留错误码+上次成功时间）、unseen、unmapped_source、no_source、MY 待核 0 行、PH 双码待合计、真正的列表/详情不一致提示全部保留。
- 现场：3011 / `run-20261026T211500Z-11a22b33` / PG59345，最终 BUILD **`MB1i1eT7pYCsG8qdb1iea`**（源码/编译快照 `a3f0f683…`，无 drift）；worker 未重启（pid 42072，`1db4017a…`）；自动同步开启、60 分钟。真实页面 **42/42**（10:22 批次 VN 1853、MY 672+ICEWM0026=0 行564、PH 3119/4138；4 条新增“有采用行不得出现暂无采用”断言）；`scopeReason` 只读探针确认异常分支说明保留。
- 证据：`.local/bs-live-intake-r1-text-20261027/`（delivery-summary / evidence-index / RESTORE-NOTE / r1-text-page-verification.json 42/42 / scope-reason-after-fix.json / runtime-final.json）；原 38/38 失败现场未改写。

## 0.8 2026-10-27 R1/R2 独立复审（历史）

**2026-10-27 R1/R2 独立复审：`BS_LIVE_INTAKE_V1_NEEDS_FIX`，只剩 R1 一处错误空态说明。** [独立报告](../../.local/bs-live-intake-repair-independent-20261027/independent-review.md)、[唯一最小收尾](../../.local/bs-live-intake-repair-independent-20261027/remaining-repair.md)。R2 `clean brush` 截断已修并独立通过；R1 单码状态、覆盖、切仓、待核0行已修好，但正常单仓仍同时显示“本仓暂无已采用的 BigSeller 库存行”。WM0026：越南1853、MY672、PH3119/4138均真实已采用、数量差额0；仅补现有说明条件，不重开同步/数据库/R2或无关套件。

独立10:33快照：3011 / PG59345 / BUILD `IbVHV6BZXFtK3ft2cEb4k`，600构建文件和9个冻结worker文件一致，自动同步开启60分钟，16次成功（2手动+14计划），最新10:22自然计划成功、pending0。728源行/650批次行/430有效行/116商品小计与同批Excel核对0差异；430正式对应、126/128/126主资料不变；旧数据/原表/构建/worker/证据保留。

`inventory_current`旧投影确实未持续更新，但现役商品/库存/历史读取均从有效批次获取，未影响当前430行；只记观察，不另立包、不回填旧表。PH双码合计、未匹配商品归属仍为业务待决。主审只读复核并更新文档，无业务源码/数据库修改、启停、新导出或清场；A1/B/C等可信证据沿用。正式本地同步继续运行，整包待这一处文案条件修完再关闭。

## 0.7 2026-10-27 R1/R2 集中补修（执行方历史交付）

- **R1 商品库消费库存结果**：普通单码仓不再被标 `pending_total`（`inventory-source.ts` 的仓状态改为 `current`，多码组才 pending_total）；详情覆盖改读 `read_inventory_item` 顶层 `coverage`（单仓 1/1、全仓 6/7；缺失显示“未读取”，不再 0/0）；切仓不再由客户端从全仓详情派生（移除 `deriveWarehouseView`/`allWarehouseAuthorityMatches`），改用本模块已有单仓读取，数量/覆盖/待合计组/待核来源/时间/警告一起切换；详情新增同仓待确认来源表（编码/数量/原表行/未计入原因，0 不当没有来源，不自动绑定），失败旧值/旧时间、未对应/无来源沿用读模型；旧 BS 样表仅历史证据、不回退；当前货值继续“暂未计算”。
- **R2 来源 SKU 完整保存**：`tools/inventory-sync/parser.py` 只对明确 `SKU编号` 表头保留完整字符串（只去首尾空白，内部空格/标点/前导零不变），旧混合 `SKU信息` 列保留原分词兼容；新批次中 `clean brush` 不再截成 `clean`。不猜绑清洁刷、不新增商品、不改 430 正式对应、不回写旧批次/原 Excel；旧 `clean` 截断行保留为历史。
- 现场：3011 / `run-20261026T211500Z-11a22b33` / PG59345；最终 BUILD **`IbVHV6BZXFtK3ft2cEb4k`**；worker `inv-worker-59345` 冻结源 **`1db4017a…`**（parser.py `28348dd6…`，旧源 `9003dd67…` 已备份）；自动同步开启、60 分钟；更新后先做一次明确标注的手动 `fb31d863…`（2026-10-27 09:46:59）立即核对，随后 10:22 真实自动计划 `22fcb140…` 成功接续；未冒充定时。
- 证据：`.local/bs-live-intake-repair-r1r2-20261027/`（delivery-summary / evidence-index / RESTORE-NOTE / r1-page-verification.json 38/38 / r2-offline-parse.json / r2-stock-integrity.json / runtime-final.json）。

## 0.6 2026-10-27 独立复审快照（历史）

**2026-10-27 独立复审：`BS_LIVE_INTAKE_V1_NEEDS_FIX`。** [独立报告](../../.local/bs-live-intake-independent-20261027/independent-review.md)、[两组最小补修](../../.local/bs-live-intake-independent-20261027/remaining-repair.md)。正式下载/保存/430条对应/定时后台/3011切换已实际运行；剩R1商品库状态、覆盖与切仓接线，R2真实SKU `clean brush`被截成`clean`。库存数量对账无采用行差异，单位已确认，9条PH别名已有逐条人工出处，不重新要求业务确认。

独立08:58快照：自动同步开启60分钟，13次成功（交付后自然新增11次），最新08:22:19，下一09:22:02；91批/8450行/当前430行。3011 / PG59345 / BUILD `uktXWUlhRzx0tPGmGp7xK`，600个构建文件、9个worker文件无差异。两原Excel/1300批次行/430当前行/116商品小计核对数量无差异；来源编码截断另列R2。旧资料/实例/原表/失败证据保留。主审只读核验与页面走查，未改业务代码/数据、启停、额外导出或清场；A1/B/C等证据沿用。详细范围与限制以独立报告为准。

## 0.5 2026-10-26 BigSeller 正式本地接入（执行方历史交付记录）

- 复用本模块的下载/解析/逐仓发布/后台/恢复，不改同步主链；新增 schema **v6**（`021_inventory_live_intake.sql` 仅版本握手，读模型在 016 functions 重放）：`catalog.read_inventory_catalog_sources()` 供商品库列表统一读取同一 `inventory_effective_rows` 模型；`inventory_item_summary` 增加同商品同仓多编码的 `pendingTotalWarehouses` / `hasPendingTotal` / `knownSubtotalComplete`（多码组逐行显示、不计入任何“完整合计”），详情 `totals` 与 warnings 同步。
- 正式实例 `run-20261026T211500Z-11a22b33`（3011，PG 59345，当时 BUILD `uktXWUlhRzx0tPGmGp7xK`，现由 §0.7 补修为 `IbVHV6BZXFtK3ft2cEb4k`；worker `inv-worker-59345`）：两次真实导出（手动 21:11、真实自动计划 21:18）均 success；430 条正式 confirmed 对应（69编码 377、56519 货号 30、条码例外 14、仅 56519 的 ICE+货号别名 9），430 当前采用行，46 同码冲突 + 174 未匹配待核；自动同步开启、60 分钟。
- 商品库列表/详情/切仓/刷新改读本模块有效库存，WM0026 双码并列标“合计待核对”，当前货值统一“暂未计算”；旧 BS 样表仅历史证据、失败不回退。
- 证据：`.local/bs-live-intake-20261026/`（delivery-summary / evidence-index / pages / formal-db-evidence.json / mapping-plan.json / RESTORE-NOTE）。


- 原任务正文：[inventory-sync-v1.md](../tasks/inventory-sync-v1.md)。验收表与证据：[inventory-sync-v1-acceptance.md](./inventory-sync-v1-acceptance.md)。
- A1 本轮交付摘要/证据：`delivery-summary.md`、`evidence-index.md`（根 `.local/inventory-sync-repair-v4-final-a1-20261026/`）；依据 [v4 FINAL 独审](../../.local/inventory-sync-independent-v4-final-20261026/independent-review.md)、[唯一剩余修复](../../.local/inventory-sync-independent-v4-final-20261026/remaining-repair.md)。v4 FINAL 首轮：[交付摘要](../../.local/inventory-sync-repair-v4-final-20261026/delivery-summary.md)、[证据索引](../../.local/inventory-sync-repair-v4-final-20261026/evidence-index.md)、[v4 独审](../../.local/inventory-sync-independent-v4-20261026/independent-review.md)。v4 首轮：[delivery-summary.md](../../.local/inventory-sync-repair-v4-20261026/delivery-summary.md)、[evidence-index.md](../../.local/inventory-sync-repair-v4-20261026/evidence-index.md)、[contract-v4.md](../../.local/inventory-sync-repair-v4-20261026/contract-v4.md)。v3 输入：[独立报告](../../.local/inventory-sync-independent-v3-20261026/independent-review.md)、[最小补修清单](../../.local/inventory-sync-independent-v3-20261026/remaining-repairs.md)。
- 历史 v1 独审及 v2 执行输入：[independent-review.md](../../.local/inventory-sync-independent-20261025/independent-review.md)；集中补修执行包：[execution-repair-v2.md](../../.local/inventory-sync-independent-20261025/execution-repair-v2.md)；v2/v3 跨端执行契约：[contract.md](../../.local/inventory-sync-repair-20261026/contract.md)。
- 历史 v2 修复实例：`run-20261026T013000Z-b4d7f2e1`（独立 PostgreSQL 59532、网页 3032、生产 BUILD `v5Pys92JVgCKXGVV9aH2D`）。原 3031/50499 交付现场在 2026-10-26 09:39 出现测试写入（具体来源未确认）（修复前快照保留在 `.local/inventory-sync-repair-20261026/protection-snapshot-before.json`，旧结果 JSON 保留；旧独审探针脚本曾被执行方修改）；现役 3011/3021/3022、126 商品与 BS 530 行只读未改；未提交/推送/合并/部署。

**2026-10-26 用户补充确认（晚于 A1 验收）**：BigSeller 库存数量均按单个商品计数，不是箱，不做装箱数换算；其他国家仓商品编码对商品库“69编码”，菲律宾新创启辰仓主要用货号、少数条码可参考库存辨认。规则唯一正文见[商品身份标准第7节](../product-identity-standard-v1.md)。数量单位已确认，不再作为业务待决；WM0026 该仓两种编码已确认同时展示，各自数量保留、不强制二选一；本次未决定正式合计口径，不阻塞其余明确项。本次只记录规则，程序、数据库验证标记、正式对应与页面入口尚未据此修改；下面验收时的“单位待确认”保留为历史记录。

## 2026-10-26 A1 主审独立复审通过

**2026-10-26 主审独立复审通过：`INV_SYNC_V1_REPAIR_V4_FINAL_A1_LOCAL_PASS`。** [独立报告](../../.local/inventory-sync-independent-v4-final-a1-20261026/independent-review.md)。A1 失败终态恢复已关闭；B/C 保持上一轮通过。本轮已批准修复的本地技术开发收尾，无新增返工包。

独立最终源码离线闭环 13/13、实际新库只读核验 12/12：失败终态可重复读取，核对/旧重试/旧动作入口均不再执行业务；最终页面链证据经主审核读（未重复写页面测试），显示终态后只清本条记录，设置可改。586 个源码/运行文件及 3 个部署函数匹配。执行方旧离线探针缺定时器模拟，已在新独审目录补齐，原失败保留；不要求业务返工。

验收现场：`run-20261026T180500Z-a1b2c3d4` @ 3036 / PG61653，BUILD `L4waWh75n57_sdLsWYaNT`；后台心跳在线，当前自动同步关闭、60 分钟、7 仓、configVersion 9、pending 0。15/105/9750 未变；五商品小计沿用本轮执行对账与上轮独审，不冒充再次全量核对。验收时的单位待确认已由本次用户确认结清；数据库验证对应尚未转为正式关系，验证数据不等于正式库存启用。全部旧实例、原表、历史失败证据保留；本轮未改业务源码/数据、未提交/推送/合并/部署/清场/写长期记忆。

## 2026-10-26 v4 FINAL 主审独立复审

**2026-10-26 主审独立复审：`INV_SYNC_V1_REPAIR_V4_FINAL_NEEDS_FIX`。B/R1 与 C/R4 通过；只剩 A1 一条故障恢复闭环。** [独立报告](../../.local/inventory-sync-independent-v4-final-20261026/independent-review.md)、[唯一剩余修复](../../.local/inventory-sync-independent-v4-final-20261026/remaining-repair.md)。

后台已确认失败结案，但返回通知丢失时，核对仍给 not_found，重试后 NOT_PENDING 被误当参数不一致，本地锁不能解除。独立真实 actions/组件离线探针原12项通过、新增1项失败；PG54164已存在failed行的只读核对确认关键前提。只需可信读取原失败终态并解锁，恢复阶段不再执行业务；错身份/参数、仍未知、成功回执保持保护。

B 独立只读29/29、5个部署函数体一致，最终页面列表/详情口径正确；C真实分支离线3/3，覆盖参数连接前拒绝。五商品验证小计1028/247/23/13059/122110未变，三条新验证对应未计入，原十条来源保留。构建526文件与运行目录一致；3035/PG54164、BUILD `KJUZ9F4ZJuSl2a7qWWAZ6`、冻结后台及进程归属已核。当前自动同步关闭、60分钟、7仓、pending0。

本轮只新增独审证据并同步状态文档，未改业务源码/业务数据、未启停/提交/推送/合并/部署/清场/写长期记忆。全部候选、原表、验证对应和旧失败证据保留。单位仍待业务确认，本地预览不等于正式库存启用；未受影响证据沿用，不重开B/C及无关测试。以下执行方交付与旧独审按历史身份保留。

## 2026-10-26 v4 FINAL A1 最小收尾（执行方实现与自验，待独立审查）

**状态：`INV_SYNC_V1_REPAIR_V4_FINAL_A1_IMPLEMENTED_AWAITING_INDEPENDENT_REVIEW`。** 只修 [v4 FINAL 独审](../../.local/inventory-sync-independent-v4-final-20261026/independent-review.md) 的唯一阻断 A1；B/C 已通过不重开，复用其余可信证据，**不声明 PASS**。

### 0.4.1 本轮实例与构建

| 项 | 值 |
|---|---|
| 新隔离实例 | `run-20261026T180500Z-a1b2c3d4`（3035/54164、3034/61135 及全部旧实例保留只读） |
| 网页 | `http://127.0.0.1:3036/dashboard/sync`、`/dashboard/inventory`；登录 `admin@catalog.test / CatalogAdmin123!` |
| 独立 PG | `127.0.0.1:61653`，库 `iceos_catalog_run_20261026T180500Z_a1b2c3d4`；marker `repair=repair-v4-final` |
| 最终 BUILD | **`L4waWh75n57_sdLsWYaNT`**（staging `next-build-8e2d6de0c201fd4e`，源码快照 `8e2d6de0…`，start 后 `repoDrift=false`） |
| 后台 | `inv-worker-61653`（online/owned，冻结源 `9003dd67…`，9 文件） |
| schema | v5（020 `4e384414…`；functions **`1b2387ad…`**，与源码一致）；未改 00001–00052/017/018/019 |

```powershell
$env:INVENTORY_PREVIEW_PORT='3036'
node scripts/inventory/prepare-instance.mjs --run-id run-20261026T180500Z-a1b2c3d4
node .local/inventory-sync-repair-v4-final-a1-20261026/replay/reset-inventory-state.mjs --run-id run-20261026T180500Z-a1b2c3d4
node scripts/inventory/prepare-instance.mjs --run-id run-20261026T180500Z-a1b2c3d4
node .local/inventory-sync-repair-v4-final-a1-20261026/replay/replay-retained-evidence.mjs --run-id run-20261026T180500Z-a1b2c3d4
node .local/inventory-sync-repair-v4-final-a1-20261026/replay/finalize-replay-evidence.mjs --run-id run-20261026T180500Z-a1b2c3d4
node scripts/catalog/build-preview-workspace.mjs --run-id run-20261026T180500Z-a1b2c3d4
node scripts/catalog/promote-preview-build.mjs --run-id run-20261026T180500Z-a1b2c3d4
$env:CATALOG_PREVIEW_NEXT_MODE='start'
node scripts/inventory/start-instance.mjs --run-id run-20261026T180500Z-a1b2c3d4
node scripts/inventory/status.mjs --run-id run-20261026T180500Z-a1b2c3d4
```

### 0.4.2 A1 实现与结果

- **实现**：`reconcile_inventory_request` 在无业务回执分支读取同 actor/同 intent 的 failed 终态（含原 errorCode，可重复读取，成功回执分支优先且不改判）；`begin_inventory_pending_action` 回放既有行返回 `errorCode`；`actions.ts` 把该终态映射为 `failed_terminal`，重试入口与 begin 回放遇 failed 直接拒绝再次执行原业务；页面显示“原操作失败，已处理完，可以修正后重新操作”，约 1.2s 后只清该 requestId 本地记录并刷新解锁；`types/model/component` 同步。未新增 RPC/表/状态存储。
- **实测**：受控代理在 settle 提交后丢弃业务响应；刷新后本地记录/锁仍在→核对得 `failed_terminal`→显示终态→本地记录清除、写锁解除、设置真实可改并恢复。DB 断言 failed/`INVENTORY_SCOPE_EMPTY`、`inventory_request` 0 行、failed 行保留；恢复阶段 POST 仅 1 条（unknown），**register/business 0**；runs/batches/batchRows 15/105/9750 前后不变。证据 `browser/a1-recovery-report.json`。
- **验证**：独审第 13 项反例原样副本保留（原失败结果不覆盖），适配内存 SQL 终态语义后重放 **13/13 PASS**；PG **44/44**；只读核对 **42/42**；部署函数只读一致；页面纯逻辑 109；tsc 本包 0 新错、eslint 0/0、diff check 0。
- **保护**：旧实例均只读，保护快照 before→final 0 变化；写入仅新实例 61653。未重抓 BigSeller、未删/补造测试对应或历史。误写独审 `settlement-probes.json` 已按运行前副本 sha `e96eaa59…` 恢复并记录。
- **未覆盖**：丢响应为受控代理模拟（非真实断网）；多机/断电/自然过期/200%/完整权限矩阵与旧性能/UI 保持原范围；单位“件”待业务确认，验证数据不等于正式库存启用。

## 2026-10-26 v4 最终收尾 A/B/C（执行方实现与自验，待独立审查）

**状态：`INV_SYNC_V1_REPAIR_V4_FINAL_IMPLEMENTED_AWAITING_INDEPENDENT_REVIEW`。** 只补 [v4 独审](../../.local/inventory-sync-independent-v4-20261026/independent-review.md) 的 A/R2、B/R1、C/R4；复用其余可信证据，**不声明 PASS**。

### 0.3.1 本轮修复实例与构建

| 项 | 值 |
|---|---|
| 新隔离实例 | `run-20261026T164500Z-e8f9a0b1`（3034/61135 候选与全部旧实例保留只读） |
| 网页 | `http://127.0.0.1:3035/dashboard/sync`、`/dashboard/inventory`；登录 `admin@catalog.test / CatalogAdmin123!` |
| 独立 PG | `127.0.0.1:54164`，库 `iceos_catalog_run_20261026T164500Z_e8f9a0b1`，marker `repair=repair-v4-final`、`testWritable/validationInstance=true` |
| 最终 BUILD | **`KJUZ9F4ZJuSl2a7qWWAZ6`**（staging `next-build-6c10f7041c53379c`，promote 后 `repoDrift=false`，源码快照 `6c10f704…`） |
| 后台 | `inv-worker-54164`（pid 31392，online/owned，冻结源 `9003dd67…`，9 文件） |
| schema | v5；`020_inventory_sync_repair_v4_final.sql` sha `4e384414…`；functions sha `7cd92fd3…`（与源码一致）；未改 00001–00052/017/018/019 |
| 数据 | 15 run/105 批次/9750 行/27 回放对应 + 3 条 B 验证对应（confirmed=30）；pending 锁 0；scope 7 仓、enabled=false、interval=60 |

```powershell
node scripts/inventory/prepare-instance.mjs --run-id run-20261026T164500Z-e8f9a0b1   # INVENTORY_PREVIEW_PORT=3035
node .local/inventory-sync-repair-v4-final-20261026/replay/reset-inventory-state.mjs --run-id run-20261026T164500Z-e8f9a0b1
node scripts/inventory/prepare-instance.mjs --run-id run-20261026T164500Z-e8f9a0b1
node .local/inventory-sync-repair-v4-final-20261026/replay/replay-retained-evidence.mjs --run-id run-20261026T164500Z-e8f9a0b1
node .local/inventory-sync-repair-v4-final-20261026/replay/finalize-replay-evidence.mjs --run-id run-20261026T164500Z-e8f9a0b1
node scripts/catalog/build-preview-workspace.mjs --run-id run-20261026T164500Z-e8f9a0b1
node scripts/catalog/promote-preview-build.mjs --run-id run-20261026T164500Z-e8f9a0b1
$env:INVENTORY_PREVIEW_PORT='3035'; $env:CATALOG_PREVIEW_NEXT_MODE='start'
node scripts/inventory/start-instance.mjs --run-id run-20261026T164500Z-e8f9a0b1
node scripts/inventory/status.mjs --run-id run-20261026T164500Z-e8f9a0b1
```

### 0.3.2 A/B/C 实现与结果

- **A/R2 失败结案四态**：DB 新 RPC `catalog.settle_inventory_pending_action(p_request,p_action,p_intent,p_payload,p_error_code)`（单事务 FOR UPDATE；核本人/action/intent/完整 `inventory_payload_key`；已有成功回执返回 HAS_RECEIPT 不改判；返回 SETTLED/NO_PENDING/NOT_ORIGINAL/HAS_RECEIPT/FORBIDDEN/NOT_PENDING）；`settlement.ts` 四态映射 + 唯一清理判据；`actions.ts` 前置失败完整绑定、`executeWithPending/executeRetry` 结案失败不忽略；4 个写入口组件仅业务成功（非 unlockFailed）或 settled/no_pending 才清记录/解锁/刷新。**实测**：页面链“丢登记→本地未知→核对未找到→范围被另一会话清空→重试 `INVENTORY_SCOPE_EMPTY`→结案→本地锁解除→设置真实可改并恢复”1/1；DB pending=failed(error_code=INVENTORY_SCOPE_EMPTY)、无 request 回执、锁 0；离线探针 12/12；PG settle 三态/权限 4/4。
- **B/R1 采用态**：`adoptedSkus` 只取同范围 `inventory_effective_rows`；新增 `pendingAdoptionSkus=mapped−adopted`、summary `pendingAdoptionWarehouses/hasPendingAdoptionWarehouses`；列表/详情统一“已计入合计”与“对应已确认、等待下一次完整同步采用”两态。**实测**：50455 已计入仅 `6974674957325=899`，三条新对应等待采用、未计入；LS101295 小计 1028（899+129），其余 247/23/13059/122110 不变；原十条待确认仍可见；数据 53/53、真实页面 27/27。
- **C/R4 备用 PG 入口**：`run-check.mjs` 的 `pgInstanceDir` 分支先读 `env.catalog.json`，传 `env:pgEnv`（及 instance marker）给连接前守卫，通过后才创建/连接 client；保留连接后只读身份核验。**实测**：真实分支离线探针 2/2——`?port=50499` 连接前 `INVENTORY_TEST_TARGET_ENV_OVERRIDE`、FakeClient 构造 0/connect 0/套件启动 0；合法目标 1 次连接 + `BEGIN READ ONLY→身份 SELECT→ROLLBACK`。

### 0.3.3 本轮验证入口与结果

| 验证 | 命令/入口 | 结果 | 证据 |
|---|---|---|---|
| PG 套件 | `INVENTORY_INSTANCE_DIR=<run>/instance node node_modules/vitest/vitest.mjs run --config tests/inventory/vitest.postgres.config.mts` | **43/43** | `db/pg-suite-run3.log` |
| 只读核对 | `node .local/inventory-sync-repair-v4-final-20261026/verify-repair-v4-final-readonly.mjs --run-id …` | **42/42** | `verify-repair-v4-final.json` |
| A 页面链 | Playwright 代理 3045→3035，`tests/inventory-browser/inventory-settlement-v4-final.browser.pw.ts` | **1/1 + DB 断言** | `a/browser/`、`a/notes.md` |
| A 离线/PG | `node .local/.../a/settlement-probes.cjs`；`vitest -t 'settle RPC'` | **12/12；4/4** | `a/settlement-probes.json`、`a/pg-settle.log` |
| B 数据/页面 | `node .local/.../b/setup-b-adoption-fixture.mjs`；`verify-b-v4-final.mjs`；`verify-b-page.mjs` | **53/53；27/27** | `b/*.json`、`b/screenshots/` |
| C 离线分支 | `node .local/.../c/c-offline-probe.mjs` | **2/2** | `c/c-offline-probe-result.json` |
| 页面纯逻辑 | inventory vitest（排除 postgres） | **109 passed** | 命令输出 |
| 静态 | tsc（本包 0 新错）、eslint `--max-warnings 0`、`git diff --check` | 通过 | — |
| 构建 | staging→promote→start，status/worker/no drift | BUILD `KJUZ9F4ZJuSl2a7qWWAZ6` | `web/build-record.json`、`web/status.json` |

### 0.3.4 数据、保护与未覆盖

- **数据差异（保留不补造）**：PH 54409 旧“五商品全无来源”仅测试前成立；最终 LS101295 `unmapped_source/2`（6974674957332 行471=0、6974674957349 行470=0），其余四商品 `no_source`。候选 61135 的 50455 两条待确认（4967=23 行710、2611=247 行716）来自 48787 额外 4 条测试对应，本回放 27 条基线未含，故不出现；未删除/补造映射。
- **保护**：3011/3021/3022、3031+50499、3032+59532、3033+53442、候选 3034+61135 未写/未启停/未替换构建；保护快照 before→final 端口 0 变化、4 个实例 marker/env/worker 配置 sha 0 变化；写入仅新实例 54164。旧的 3031/50499 未确认事件不归因、不清理。
- **未覆盖**：真实页面仅“确定失败且结案成功”主链（settle_failed/未知/not_original 由离线探针+PG 事务覆盖，未制造真实网络中断）；B 默认视口页面（无 200% 缩放矩阵）；C 未真实连接保护库反例；真实断网/网络分区、自然登录过期、断电/多机并发、旧 15×20/旧 UI/完整权限矩阵、真实 BigSeller 最低频率、国内库存/物流/估值。
- **待业务确认**：27 条回放 + 3 条 B 验证对应均为验证数据（`verification=true/unitConfirmed=false`），单位“件”非业务确认；本地预览不是生产启用。未提交/推送/合并/部署/清场。

## 2026-10-26 v4 主审独立复审

**2026-10-26 主审独立复审：`INV_SYNC_V1_REPAIR_V4_NEEDS_FIX`。** [独立报告](../../.local/inventory-sync-independent-v4-20261026/independent-review.md)、[仅三处剩余收尾](../../.local/inventory-sync-independent-v4-20261026/remaining-repairs.md)。原十条来源缺口、五商品采用小计、身份/请求切换与完整参数绑定主体、R3 混合批量、R4 主守卫已核实；不重开已关闭项。

剩余：**R2** 原操作确定失败且已结案后，本地恢复锁未解除；错意图的拒绝调用反而可结案原锁，须一并收口。**R1** 3 条新确认但未进入库存批次的 SKU 被提前标为“已采用/已计入”，当前数量未错加。**R4** run-check 备用 PG 入口漏把实际配置传给连接前守卫，连后仍会阻止写入。只补这三处及直接相关验证，不新增功能或重跑无关套件。

独立核524个构建源码/运行目录文件一致，候选3034/PG61135、BUILD `BWfdgG5RtlNS3KlwLzYLp`、后台冻结源和进程归属已核；只读数据、真实页面及离线反例另存本轮证据。执行方13条测试映射保留，最终37 confirmed/3 recheck；LS101295 的 PH 无来源对照已因测试映射扩展变为2条来源，旧“五商品全无来源”仅属于测试前记录。五小计仍1028/247/23/13059/122110，单位仍待业务确认；未生产启用。

本轮只改审查证据与状态文档，未改业务源码/库存业务数据、未启停/提交/推送/合并/部署/清场，旧实例与原证据保留。下文执行方自验、旧独审均按当时范围保留，不代替现役独审结论。

## 2026-10-26 集中收尾修复 v4（执行方实现与自验，待独立审查）

**状态：`INV_SYNC_V1_REPAIR_V4_IMPLEMENTED_AWAITING_INDEPENDENT_REVIEW`。** 本轮只做 [v3 独审报告](../../.local/inventory-sync-independent-v3-20261026/independent-review.md) 的 R1–R4，复用真实导出/回放/中途接管/备份正常路径/历史修订/登记原行绑定等可信证据；**不声明 PASS**。

### 0.2.1 本轮修复实例与构建

- run id `run-20261026T153500Z-c4e8a1b2`；网页 `http://127.0.0.1:3034/dashboard/sync`、`/dashboard/inventory`；独立 PG `127.0.0.1:61135`，库 `iceos_catalog_run_20261026T153500Z_c4e8a1b2`；marker `package=inventory-sync-v1, repair=repair-v4, testWritable=true, validationInstance=true`。
- 最终生产预览 BUILD **`BWfdgG5RtlNS3KlwLzYLp`**（隔离 staging `next-build-43d2972ceaa1903e`，源码快照 `43d2972c…`，promote/start 后 no drift）；后台 `inv-worker-61135`（pid 53404，online/owned，冻结源 `9003dd67…`）。
- DB 版本握手 `inventory_schema_state.version=4`：新增 `db/catalog/019_inventory_sync_repair_v4.sql`（`48f856f8…`：R1 查询索引 + version 4 握手）与重放 functions 文件 `a8dff9c0…`；未改 00001–00052、016 结构、017/018。
- 登录：`admin@catalog.test / CatalogAdmin123!`（`instance/password.local.txt`）。

### 0.2.2 R1–R4 实现要点

- **R1 来源存在性与同仓部分未对应**：`inventory_item_warehouse_gap` 的“已知编码”= 本商品全部仓 confirmed mapping ∪ candidate suggested SKU；从本仓最新登记 run 读 `parse_status='ok'` 源行；同仓已有 current 也返回其余 `pendingSourceRows`（文件行号/数量/mapped）；无当前行有源行=`unmapped_source`，真无源行=`no_source`，数量 0 仍是“来源 0、待确认”；`inventory_item_summary` 新增 `pendingSourceWarehouses/hasPendingSourceWarehouses`，详情每仓新增 `pendingSourceRows/pendingSourceRowCount/pendingSkus/adoptedSkus`；列表/详情同范围同解释；pending 源行不自动绑定、不计合计。
- **R2 结果未知请求**：全部写入口先 `registerInventoryRequestAction`（服务端会话身份）再执行原动作；本地 v2 记录含 actorId/accountId/registration，与服务端 pending 共同锁新写；旧 v1 记录保留待核实；恢复状态按 requestId+intent+actor+account 重置；本地回退核对/重试带 originActorId 并由服务端校验当前会话；intent v4 用 `canonicalJson` 结构化编码（confirm mappings 对象数组、settings 结构化对象）；DB `inventory_payload_key` 在 begin/block/request_prior 核完整参数（同旧指纹不同内容 → `INVENTORY_REQUEST_CONFLICT`）；旧 v3 指纹 pending 按持久 intent/payload 核对/重试；业务前置校验确定失败时收口已登记 pending。
- **R3 混合批量**：`buildConfirmBatch` 用 `reconfirmRowKeys` 按行要求版本（首次允许 null、已有对应必须页面所见版本），不再整批 `some(currentMapping)`；服务端旧版本拒绝不变。
- **R4 实际目标一致**：`test-target-guard.mjs` 用安装的 `pg-connection-string` 解析驱动最终目标，连接前拒绝覆盖 host/hostaddr/port/dbname/database/user/password 的查询参数；新增 `assertConnectedTarget`（BEGIN READ ONLY 核 `current_database()/host(inet_server_addr())/inet_server_port()`）；接入 run-manual-sync/rpc-smoke/rpc/run-check/backup-restore-verify/recovery-drill/verify-*/repair-fixture/prepare-instance 等实际连接；保护集合补 53442 与 v3 交付 run。

### 0.2.3 本轮验证入口（执行方实际运行）

```powershell
# 新实例（web 3034；PG 端口由 prepare 自动分配）
$env:INVENTORY_PREVIEW_PORT='3034'
node scripts/inventory/prepare-instance.mjs --run-id run-20261026T153500Z-c4e8a1b2

# PG 套件（干净 seed；连接前 marker/连接后身份核对）
$env:INVENTORY_INSTANCE_DIR='D:\try one\ICEOS\.local\catalog\run-20261026T153500Z-c4e8a1b2'
node node_modules/vitest/vitest.mjs run --config tests/inventory/vitest.postgres.config.mts

# 回放保留批次 + 定稿（reset → prepare → replay → finalize）
node .local/inventory-sync-repair-v4-20261026/replay/replay-retained-evidence.mjs --run-id run-20261026T153500Z-c4e8a1b2
node .local/inventory-sync-repair-v4-20261026/replay/finalize-replay-evidence.mjs

# 只读核对 42/42 与 R1 十条真实源行 38/38
node .local/inventory-sync-repair-v4-20261026/verify-repair-v4-readonly.mjs --run-id run-20261026T153500Z-c4e8a1b2
node .local/inventory-sync-repair-v4-20261026/r1/verify-r1-v4.mjs

# 页面纯逻辑
node node_modules/vitest/vitest.mjs run --config vitest.config.inventory.mts --exclude "**/*.postgres.test.ts"

# 页面浏览器 v4（代理 3044 → 上游 3034；证据根）
# INVENTORY_BASE_URL=http://127.0.0.1:3044 INVENTORY_UPSTREAM_URL=http://127.0.0.1:3034 ...
node node_modules/@playwright/test/cli.js test --config playwright.config.inventory.ts

# 构建（隔离 staging → promote → start，已由执行方运行）
# scripts/catalog/build-preview-workspace.mjs → promote-preview-build.mjs → scripts/inventory/start-instance.mjs
```

### 0.2.4 本轮结果与证据

- 回放：15 个真实成功 run / 105 仓批次 / 9750 行 / 27 confirmed+27 verification mappings / 405 adopted 行全部带发布时修订；WM0049 越南 50455 历史 83,025→83,022（-3）、WM0026 2,001→2,001（0）；证据 `replay/replay-result.json`。
- 只读核对 **42/42**（五商品小计 1028/247/23/13059/122110、覆盖 5/7、市场集合+未知、两条历史前值、7 仓原因、405 修订）；证据 `verify/verify-repair-v4.json`。
- R1 十条真实源行 **38/38**：52074 六条 `not_mapped/unmapped_source`（文件行 692/697/695/665/599/120，源数量 0）；54886/56673 四条 `current` 同时显示已采用 `757577983013=674/3123`、`757577407113=0` 与待确认 `ICEWM0026/WM0049` 行；PH 54409 真无来源 `no_source`；列表/详情一致；证据 `r1/verify-r1-v4-result.json`。
- PG 套件 **38/38**（2 files，0 skipped/flaky，含新增 R1/R2 v4 用例）；证据 `db/pg-suite-run3.log`。
- 页面纯逻辑 **91 passed**（web-model 64 + web-model-v4 16 + web-real-shape 5 + intent-v4 6）。
- 浏览器 v4 **8/8（0 skipped/flaky，79.4s，exit 0）**：R2-1 本地未知锁新写、R2-2 换管理员不能接管、R2-3 换请求重置、R2-7 回执丢失恢复、R2-4 重试一次效果、R2-5 同旧指纹不同内容被拒（23505）、R2-6 旧指纹 pending 恢复、R3-1 页面混合批量（重确认 v1→2、首次 v1）；证据 `r2/browser/report.json`、`r2/r2-verification.json`。
- R4 离线反例 a–l 全 PASS（0 数据库连接、不向保护库试写）；新实例 app/sync/owner 连接后身份核验通过；证据 `ops/`。
- 构建：staging → promote → start，BUILD `BWfdgG5RtlNS3KlwLzYLp`，no drift；证据 `web/build-record.json`。
- 静态：inventory tsc 0 新错误（全仓仅既有 BEST 5）、eslint `--max-warnings 0` exit 0、`git diff --check` 0。

### 0.2.5 未覆盖/待确认（不写成通过）

- 真实断网/网络分区：响应丢失由本地反向代理模拟；自然登录过期、断电/多机并发、旧 15×20 性能、旧 UI 延期项、200% 缩放、完整权限/ACL 矩阵未覆盖。
- 27 条对应仍为执行方验证数据（单位“件”非业务包装单位确认）；来源 BS 样表/导出无单位列，业务单位待用户确认。
- 旧 59532 历史 item_revision 仍 NULL（未回填）；旧 3031/50499 未确认测试写入现场保留、未归因。
- 本地预览不是生产部署；未提交/推送/合并/部署/清场。

## 2026-10-26 v3 主审独立复审

**2026-10-26 主审独立复审：`INV_SYNC_V1_REPAIR_V3_NEEDS_FIX`。** [独立报告](../../.local/inventory-sync-independent-v3-20261026/independent-review.md)与[最小补修清单](../../.local/inventory-sync-independent-v3-20261026/remaining-repairs.md)为当前依据。下文 v3“已实现/自验通过/待审”是执行方交付时记录，不代替本次独审结论。

已关闭：固定五商品当前采用数量与两条历史前值、405/405 新发布采用行的资料修订、F3 登记原行内容绑定、原单条/普通批量确认接线与验证标记、核对异常/解锁失败基本分支、冻结源码保护、备份后后台恢复失败退出。独立核 522 个构建相关文件一致；实际 SQL、只读数据和页面已核，可信原采集/接管/备份/页面证据复用，未整套重跑。

剩余仅四组：**R1/F2** 来源存在性及同仓部分未对应（6 条源行误报不存在、4 条被已有 SKU 掩盖）；**R2/F4** 本地未知请求的新写锁、原身份/账号/换请求状态及完整内容无歧义绑定；**R3/F1** 首次+重确认混合批量误要求首次行旧版本；**R4/F5** 检查地址与驱动最终连接地址不一致。十条来源明细见[逐行记录](../../.local/inventory-sync-independent-v3-20261026/gap-details.csv)；均为 2026-10-26 11:31:13.035 的真实零值来源，当前采用合计未新增错数，不能因此掩盖来源缺口。

候选 `run-20261026T123800Z-d3f4a5b6` @ 3033/PG53442、BUILD `R4hh0kmDKek10Xm-em3Fk` 保留；补修写入另用明确归属隔离目标。保护 3011/3021/3022、3031/50499、3032/59532 及本候选。主审仅只读连接新 53442，未改业务代码/数据、未启停/提交/推送/合并/部署/清场。旧污染来源未确认；验证单位待业务确认，不能作为正式业务库存启用。

只补上述关键结果，已关闭项和旧性能/UI/完整权限矩阵等范围不重开。详见最小补修清单；完整补修后再交独审，执行方不自行宣告 PASS。

## 2026-10-26 v2 主审独立复审（历史）

**2026-10-26 主审结论：`INV_SYNC_V1_REPAIR_V2_NEEDS_FIX`。** 后续仅按[集中补修包 v3](../../.local/inventory-sync-independent-v2-20261026/execution-repair-v3.md)的 F1–F5 完成剩余修复；[独立报告](../../.local/inventory-sync-independent-v2-20261026/independent-review.md)列明具体数据及证据。下文 v2 实现和“通过”保留为执行方自验记录，不代表主审通过。

独立确认：5 个固定商品已采用的 27 行原表、数据库、列表和详情一致，重复数量/同仓漏行已修复；旧 430 条对应已改候选；worker 的 11 个定向反例通过。导出、中途接管及备份正常路径复用可信执行证据，没有重跑全套。

仍需修复：F1 页面确认无法提交、重新确认版本未接通、验证单位边界未落实；F2 历史前驱取错、378 条已采用历史行缺当时商品资料版本、覆盖/缺口与多市场提示错误；F3 登记行号/hash 未绑定实际 SKU/数量；F4 未知结果的失败判断、解锁及操作者/完整意图保护；F5 冻结代码/备份后恢复失败及可写测试目标防护。

具体错数：2026-10-26 11:29:45.675→11:31:13.035，越南青林湾仓库 50455，WM0049/SKU757577407113 实际 83,025→83,022（减少 3），系统历史 83,074→83,022（减少 52，多显示减少 49）；WM0026/SKU757577983013 实际 2,001→2,001（无变化），系统历史 2,010→2,001（减少 9）。这是库存余额变化，不是销量。

27 条确认来自执行方验证脚本，业务包装单位仍待确认，不等于用户确认“件”或正式业务库存启用。审查候选 3032/PG59532、BUILD `v5Pys92JVgCKXGVV9aH2D` 与原 3031/50499、3011/3021/3022 全部保留，补修另建实例。旧 3031/50499 测试写入来源未确认；旧独审探针脚本被执行方修改、旧结果 JSON 保留，不声称全部旧证据未改。本轮只读审查 59532，未连接 50499、未改业务代码/数据、未启停/提交/推送/合并/部署/清场。

只验证本次关键改变，旧性能/UI/完整权限矩阵/自然过期/断电/压力/国内/物流/估值仍保留原范围。修复后停于 `INV_SYNC_V1_REPAIR_V3_IMPLEMENTED_AWAITING_INDEPENDENT_REVIEW`，执行方不自宣通过。

## 0.1 2026-10-26 集中补修 v3（执行方实现与自验，待独立审查）

**状态：`INV_SYNC_V1_REPAIR_V3_IMPLEMENTED_AWAITING_INDEPENDENT_REVIEW`。** 本轮只做[集中补修包 v3](../../.local/inventory-sync-independent-v2-20261026/execution-repair-v3.md) 的 F1–F5，复用 v2 已可信的真实导出/中断接管/备份正常路径证据；**不声明 PASS**。

### 0.1.1 本轮修复实例与构建

| 项 | 值 |
|---|---|
| run id | `run-20261026T123800Z-d3f4a5b6`（新独立修复实例；v2 候选 `run-20261026T013000Z-b4d7f2e1` 与 3031/50499、3011/3021/3022 原样保留） |
| 数据库 | 独立 PG 集群 `127.0.0.1:53442`，库 `iceos_catalog_run_20261026T123800Z_d3f4a5b6`；实例 marker `testWritable:true` / `validationInstance:true` |
| 网页 | `http://127.0.0.1:3033/dashboard/sync`、`/dashboard/inventory`；登录 `admin@catalog.test / CatalogAdmin123!`（`instance/password.local.txt`） |
| 最终 BUILD | `R4hh0kmDKek10Xm-em3Fk`（隔离 staging 生产构建 + promote；promote 后源码快照 `0022256c8e7e67db…` 与工作区一致、无 drift 警告） |
| 后台 | `inv-worker-53442`（pid 41360 的网页进程、worker pid 以 `instance/inventory-worker.pid.json` 为准；冻结源 `9003dd67acb4…`，9 文件，online） |
| 数据库增量 | `db/catalog/018_inventory_sync_repair_v3.sql` sha256 `1941b997…96142`（幂等：item_current/item_revision owner-only SELECT 策略、前驱索引、version=3 握手）；`016_inventory_sync_functions.sql` sha256 `1a37dd2f…9edc53`；未改 017/00001–00052；实际 DB `inventory_schema_state.version=3` 且 source/functions sha 与文件一致 |
| 证据 | `.local/inventory-sync-repair-v3-20261026/`（`delivery-summary.md`、`replay/`、`verify/`、`db/`、`f5/`、`web/`、保护快照 before/after）；旧证据目录不覆盖 |

### 0.1.2 F1–F5 实现要点

- **F1 对应维护**：页面/草稿/选择/提交全链按 `warehouseExternalId::externalSku` 行身份（同 SKU 两仓不合并）；队列返回 `currentMapping{id,status,version,itemId,unit}`/`mappingStatus`/`verification`/`unitUnconfirmed`/`reason`；首次确认 `expectedVersion=null`，任何已存在对应（confirmed/disabled/recheck）再确认必须带页面所见版本；`verification:true` 记录为验证数据、`unitConfirmed=false`；库存页/队列显示“验证数据、业务包装单位待确认”。
- **F2 覆盖与历史**：历史“上一批”改用派生 `inventory_previous_batch_row`（同账号/仓/来源 SKU/同 item，observation_at→published_at→batch_id 紧邻更早），发布写 `previous_batch_id`、历史读取同规则，**不改历史行**；发布保存当时 `catalog.item_current.revision`，adopted 缺修订拒绝发布；018 只给 owner 只读策略解决后台读取，不关 RLS、不给运行账号 owner/superuser/BYPASSRLS；summary/detail 统一范围：`coverage{scopeWarehouses,coveredWarehouses}`、`notMappedWarehouses(reason=unmapped_source|no_source, sourceRowCount/sourceSkus)`、`unseenWarehouses`、`failedWarehouses`、`markets[]`/`hasUnknownMarket`、`verificationOnly`/`unitUnconfirmed`/`itemRevisionMissing`；detail 列出整个筛选范围（含空 rows 仓与 gapReason）。
- **F3 发布绑定登记原行**：`publish_inventory_warehouse` 逐行以 `inventory_run_row` 为唯一业务字段来源（excelRow 对应；SKU 与 raw 文本/解析数量/GTIN 严格核对），保留原行号/hash 改数量=999 或换 SKU 均拒绝；随后用登记行发布，原批次/库存不变。
- **F4 原请求恢复**：客户端生成 requestId+intent，服务端重算校验；`reconcile`/`retry` 只信持久 pending 的 actor/action/intent/payload；仅显式 `found:false` 为未找到，null/畸形/异常/无权限为 failed 保留锁；找到回执后单独解锁，解锁失败 → `found_unlock_failed`；无持久 pending 时找到回执直接判 found（无锁可解，不再调用 complete）；complete 要求真实同 actor/action/intent 回执；他人 pending 只显示忙碌，无 requestId/操作；页面状态按 requestId+intent 绑定、切换重置、重试又未知回到先核对；网络异常保留本地副本并整页恢复，刷新由服务端 pending 恢复。
- **F5 维护失败与测试目标保护**：冻结源 `mode:'first-only'|'refresh'`：已有源校验失败拒绝启动并保留现场，仅全新实例首次冻结，显式 refresh 才换版且 worker 运行中拒绝；备份演练暂停 worker 后重启失败 → `evidence.ok=false`/exit 1，summary 分开备份一致性与 worker 恢复；`test-target-guard.mjs` 在连接前核 marker `package/testWritable/runId/loopback/非 50499/59532/库名归属`，fixture 连接后 `BEGIN READ ONLY` 核 live db/port/run_id 才允许写；缺目标不回退旧实例。

### 0.1.3 本轮验证入口（执行方实际运行）

```powershell
# 只读提取 v2 保留批次证据（BEGIN TRANSACTION READ ONLY + ROLLBACK，不写 59532）
node .local/inventory-sync-repair-v3-20261026/replay/extract-source-59532.mjs
# 新实例：回放 15 个真实成功 run/7 仓/原观测时间，建立 27 条验证对应
node .local/inventory-sync-repair-v3-20261026/replay/replay-retained-evidence.mjs --run-id run-20261026T123800Z-d3f4a5b6
# 只读核对：固定样本、历史两条反例、覆盖/缺口/市场、资料版本
node .local/inventory-sync-repair-v3-20261026/verify/verify-repair-v3.mjs --run-id run-20261026T123800Z-d3f4a5b6
# 真实 PG 事务/恢复套件（32 项）
$env:INVENTORY_INSTANCE_DIR='D:\try one\ICEOS\.local\catalog\run-20261026T123800Z-d3f4a5b6'
node node_modules/vitest/vitest.mjs run --config tests/inventory/vitest.postgres.config.mts
# 页面验证（Build R4hh...；web-ui 执行，代理 3044 → 3033）
# 证据：.local/inventory-sync-repair-v3-20261026/web/
```

### 0.1.4 本轮结果与证据

- 保留批次回放：15 个真实成功 run、105 仓批次、9750 行；文件 sha 与登记一致；27 条 verification-only 对应；405 条 adopted 行均保存当时 item_revision（`replay/replay-result.json` `ok=true`）。
- 只读核对 **42/42**（`verify/verify-repair-v3.json`）：LS101295 1028、LS101302 247、WM0011 23、WM0026 13059（PH 3122+4139、VN 2001、MY 674、龙仔厝 3123）、WM0049 122110（PH 0+39088、VN 83022）；覆盖 5/7 且缺口原因明确；WM0049 历史 83,025→83,022（-3，不是 -52）、WM0026 2,001→2,001（0，不是 -9）；多市场集合+未知单独标记。
- 真实 PG 套件 **32/32**（2 files，0 skipped/flaky，exit 0；`db/pg-suite-run4.log`）：F1 版本/同 SKU 两仓、F2 两历史反例+覆盖/市场、F3 两个等量反例、F4 他人 actor/intent。
- F5 反例：冻结源 8/8、备份失败保护 5/5、测试目标守卫 16/16（`f5/f5-summary.md`）。
- Python 单测 **122 passed**、页面纯逻辑 **69 passed**、本包 eslint `--max-warnings 0` exit 0、最终 tsc 本包 0 新错误（全仓仅既有 BEST 5）、`git diff --check` exit 0。
- 页面验证（最终 BUILD `R4hh0kmDKek10Xm-em3Fk`，代理 3044→3033）：**10 passed / 0 failed / 0 skipped / 0 flaky（84.9s，exit 0）**。F1 单条/批量确认、同 SKU 两仓隔离、重核/停用后按现版本重确认、旧版被拒；F2 覆盖 5/7+四类缺口、市场集合+未知、WM0049 历史 `83,025→83,022`（无 83,074）；F4-A 上游已落库但回执丢失→整页重载恢复→核对 found（DB 一次效果）；F4-A2 核对失败保留、不误判；F4-B 请求未达服务端→明确未找到→同 requestId+intent 重试（DB 一次效果）；F4-C 临时 REVOKE→`found_unlock_failed`（不提示已解锁）→GRANT 后 found（`has_function_privilege=true`）；F4-D 他人 pending 仅显示忙碌并清理 fixture。证据 `.local/inventory-sync-repair-v3-20261026/web/`（`report.json`、`page-verification.md`、11 张截图/trace）。
- 保护：3011/3021/3022、3031/50499、3032/59532 未启停/未写库（59532 仅 `BEGIN TRANSACTION READ ONLY` 提取）；保护快照 before/after 在 `.local/inventory-sync-repair-v3-20261026/`；旧 3031/50499 未确认测试写入事件保留原现场与前后证据，未删除、未指认来源；旧独审 `worker-focused-probes.py` 曾被修改、旧结果 JSON 保留，不声称全部旧证据未改。

### 0.1.5 未覆盖/待确认（不写成通过）

- 页面 F4 恢复链使用本地反向代理制造“上游已落库但响应不返回/请求未达服务端”，不是真实网络故障注入；自然登录过期等待、断电/并发/多机压测不重开。
- 旧 v2 实例 59532 的 9750 条历史 `item_revision` 仍为 NULL（保留原状，未回填）；新实例回放批次保存了当时修订，缺失显示由新读模型覆盖。
- 27 条对应仍为执行方验证数据，业务包装单位、真实市场业务确认仍待用户；不换算、不代确认。
- 本地预览不是生产部署；未设开机自启/多机高可用；未提交/推送/合并/部署/清场。

## 0 执行方 v2 实现与自验记录（R1–R7，保留历史）

原 v1 已跑通“真实账号自动导出 → 下载 → 解析 → 按仓发布 → 页面读取”，但 2026-10-25 独立审查实测出重复计数/串货/漏行、旧样表对应未经本包确认、异常行仍成功、恢复时间失真、页面结果未知未锁住、启停归属与空范围/市场缺口。本轮按执行包 R1–R7 定向修复，**不重开旧性能/UI 延期或无关功能**：

| 编号 | 修复要点（实现） |
|---|---|
| R1 | 唯一“仓级 confirmed 映射 + 每仓最新完整成功批次”的 effective rows 读模型；列表/详情/搜索/合计/缺口共用；详情逐仓×SKU 不再 LIMIT 1；同商品同仓多 SKU 逐行保留、多单位不强行合计；缺行=本次未见（另示上次已知，不入合计）；失败仓保留旧值+旧时间+失败；换绑/停用/重核按批次与版本语义；详情默认沿用列表筛选，显式“查看全仓”才全仓 |
| R2 | 旧 BS 样表 430 条只进“有出处候选”；确认必须显式账号/仓/商品/单位/理由/旧版本；队列支持搜索/分页、无建议可确认、批量只作用勾选行；提供重核、停用、重新确认/换绑（带可见旧版本）；单位冲突拒绝、不换算 |
| R3 | parser 表头精确别名、缺列/重名/歧义整文件拒绝、金额列绝不进数量、识别组合 SKU；发布只发完整仓，坏行按仓阻断、缺仓/组合/表头整文件阻断；**数据库发布核对登记原行（excelRow+rowHash 精确集合）**；账号身份 verified、文件校验 ok、观测时间存在才允许发布；新仓候选/更名不冒认 |
| R4 | 文件 sha256 不再是全局采集身份（两新任务同 sha 均成功、同 run 异 sha 拒绝）；恢复/重放/发布只用原 `exportFinishedAt`，缺失即失败；旧观测只落批次、不推进仓库成功/范围全绿 |
| R5 | 设置/立即同步/确认/停用统一 pending 流程：原请求号+完整参数保留，pending 期间服务端拒绝新写；核对三态（找到/明确未找到/查询失败或无权）分开，核对只读绝不重放；明确未找到提供“重试原操作（同 requestId+intent）”；刷新后可恢复 |
| R6 | start/status/stop 校验规范化 config/冻结 worker 脚本路径 + pid + 进程创建时间，失配拒绝停止、不假报在线；worker 从实例冻结源码运行（不随工作区漂移）；给出 DB→网页→后台→状态检查顺序；016/017 与 `inventory_schema_state` 版本握手，prepare 每次幂等重放函数，不再静默跳过 |
| R7 | 明确空范围可持久保存并停止发布（刷新/重启保持、手动同步给原因、重选恢复）；市场选项来自服务端“有证据仓/市场关系”（只取参与范围，未知不猜），列表/详情同范围 |

页面与动作层的口径：见 §7；数据语义见 §5；对应维护见 §6。

## 1 交付物

| 交付 | 位置 |
|---|---|
| 数据库增量（fresh 结构 + 可重放函数 + 旧 016 升级） | `db/catalog/016_inventory_sync.sql`（sha256 `1c2816dd…a4e01e`）、`016_inventory_sync_functions.sql`（`8e67e702…038522`）、`017_inventory_sync_repair_v2.sql`（`0ef9c08b…b200c4`）；不改 00001–00015 |
| BigSeller 自动导出/会话适配器（只读） | `tools/inventory-sync/bigseller_export.py`、`bigseller_session.py` |
| 后台同步程序（常驻、定时、失败恢复） | `tools/inventory-sync/{worker,parser,publisher,recovery,config,db_gateway}.py` |
| 数据同步页 `/dashboard/sync` | `src/app/dashboard/sync/page.tsx` + `src/features/inventory/{components,server,model,normalize,types}.ts(x)` |
| 商品库存页 `/dashboard/inventory` | `src/app/dashboard/inventory/**` + `src/features/inventory/**` |
| 旧库存地址安全引导 | `/dashboard/inventory/domestic|overseas|in-transit` → `legacy-inventory-guidance` |
| 独立实例/启停/冻结源码/登录/状态/校验脚本 | `scripts/inventory/*.mjs`、`scripts/inventory/verify-raw-vs-detail.py` |
| 定向验证入口 | `scripts/inventory/run-check.mjs`、`rpc-smoke.mjs`、`recovery-drill.mjs`、`verify-fixed-samples.mjs`、`verify-mapping-lifecycle.mjs`、`verify-r5-recovery-chain.mjs`；`vitest.config.inventory.mts`、`playwright.config.inventory.ts` |
| 单测 | `tests/inventory_py/**`（122）、`tests/inventory/**`（web 纯逻辑 62 + 真实 PG 27）、`tests/inventory-browser/inventory.browser.pw.ts`（9） |
| 运行/交付说明 | 本文 + 验收报告 + `.local/inventory-sync-repair-20261026/*.md`（证据不入库） |

## 2 架构与数据流

```
页面（/dashboard/sync 设置/立即同步/对应复核）      页面（/dashboard/inventory 列表/详情/历史）
        │ server action（requestId + sha256 intent + pending 锁）
        ▼
PostgreSQL（catalog 表 + SECURITY DEFINER RPC，FORCE RLS；app 角色只读投影 + 动作函数，sync 角色后台函数）
        ▲                                    ▲
        │ claim / 心跳 / 登记 / 发布 / 结单     │ 读 RPC（只读事务，effective rows 唯一读模型）
        │                                    │
后台 worker（Python 常驻，实例冻结源码）─ BigSeller 会话 ─→ 自动导出 XHR → 下载 xlsx → 解析/校验 → 逐仓发布
```

- **调度全部在数据库**：`inventory_sync_settings.next_run_at` 是唯一计划来源；worker 只执行 `claim_inventory_run` 返回的任务。
- **手动与自动**：手动不改 `next_run_at`；同一账号最多 1 个活动任务（部分唯一索引）；自动/手动重叠返回同一任务。
- **结果未知**：提交响应丢失时保留原请求号与参数（pending 行），先查回执再决定；`outcome_unknown` 只核对不重发。
- **恢复**：租约 token 控权；接管后旧执行者不能发布/结单；重启先 `read_inventory_run_work` 看已发布仓与原观测时间再续；登录失效 → `needs_login`，人工登录后后台 ≤60 秒探测并只在与固定账号一致的可靠身份下恢复 `active`（`disabled` 永不自动恢复）。

## 3 BigSeller 自动导出（真实账号只读）

真实账号 `laiguoyong@KNZX019402`，可见 8 个仓库。导出与页面同一 XHR：

1. `POST /api/v1/excel/inventory/exportAllInventoryList.json`（全部仓库、`isGroup=0` 单 SKU、`hideZeroInventorySku=0`，清空搜索/缺货/在售筛选）→ `exportMark`；
2. `GET /api/v1/excel/inventory/getWarehouseListExportProgress.json?exportMark=…` 轮询到完成，取临时签名下载地址与 `totalNum`；
3. 下载 xlsx，校验 `totalNum == 工作簿数据行数`（本轮实测 728 = 728），登记 sha256/大小/表头/行数/下载时间/导出开始与完成时间。

每次任务都是新导出（新 exportMark/新文件），不扫描下载目录、不手工上传；`isGroup=0` 由“单个 SKU”筛选决定，组合 SKU 不进入导出，且 parser 仍识别并拒绝意外组合行（防依赖导出参数省掉文件校验）。金额列（在途总成本/加权成本价/总成本价）只进私有金额表，公共行与页面不含金额。

**已知坑（已处理）**：BigSeller xlsx 的 worksheet dimension 错误（28 列声明成 1 列），`openpyxl(read_only=True)` 会静默只读第 1 列；解析必须完整加载（本次起 parser 还要求传入本次导出的 `warehouseOptions` 稳定 id+name 用于归属）。

## 4 库存口径与发布

- 数量是**当时余额**（100→80 存 80）；`"0.0"`→0，`"--"`/空→未知（不是 0），非法数字→该行 `invalid_quantity`，不静默跳行。
- 同仓同 SKU 重复 → `duplicate_sku`，不求和、不取第一行；缺仓库/缺 SKU 单独标原因并按 §4 阻断。
- **完整仓发布**：每仓一个事务（批次 + 批次行 + 当前指针 + 成功时间），全成功或全不生效；数据库在发布前核对**该仓已登记原行**（`excelRow + rowHash` 精确集合）与该仓无任何非 ok 行，worker 只传子集也会被拒绝（`INVENTORY_WAREHOUSE_INCOMPLETE/BLOCKED`）。
- 文件级问题（缺仓/无法归属/组合行/表头）阻断整文件；范围外仓行只计数不发布（昕兰仓实测 78 行）。
- **观测时间只来自来源导出完成时间**（`run.export_finished_at`）；恢复/重放不拿 now() 顶替。旧观测只落批次，不推进仓库成功/范围全绿。
- 当前库存 = 每仓**最新完整成功批次**中、仍与有效仓级 confirmed 映射相符的行；`inventory_current` 只由发布函数更新；批次/批次行/文件/回执/审计不可改。
- 范围“最后全部成功时间”只在本次范围每仓都成功且都推进了成功游标时刷新；每仓另有独立成功时间与失败/陈旧标记。

## 5 商品对应（映射）

- 稳定 Variant 层（`inventory_variant`，单位可空；只有确认映射要求单位）＋ `inventory_sku_mapping`（账号/仓库/外部 SKU → 商品/单位，版本+状态 confirmed/disabled/recheck）＋ `inventory_mapping_candidate`（有出处候选）。
- 旧 BS 样表 430 条人工决定只作为**候选**（evidence 保留 export/Excel 行号/历史 selection 状态），prepare 不再直接 confirmed、不预建 variant、不统一猜“件”；管理员确认时记录账号/仓/商品/单位/操作者/理由/版本。
- 新实例 intentionally confirmed=0；本轮验证只对固定核对样本等 **27 条**做了显式管理员确认（含理由与单位），其余 403 条保持候选。
- 发布事务再次核对采用关系仍有效、版本未变、Variant 商品归属与单位适用；期间变化拒绝按旧计划发布。
- 停用/重核**立即**退出当前汇总；换绑/重新确认形成新版本，**等下一次完整批次**才采用；旧批次仍按当时关系和资料版本展示，不迁移旧值到另一商品。
- 账号级（`warehouse_id IS NULL`）历史映射保留为事实但本版不参与发布/读取（页面标注“账号级默认已停用”）；新确认必须带仓。

## 6 页面

`/dashboard/sync`：
- 真实账号标识、参与仓库（含候选/排除状态，服务端给全部账号仓，空范围后仍可重选恢复）、自动同步开关、频率（5–1440 分钟）、下次计划、后台在线/最后联系、登录状态、立即同步；
- 任务列表/详情：等待/下载/检查/保存/成功/部分/失败/结果待核对/需要登录，触发方式、计划时间、本次观测时间、账号身份校验、文件校验（缺列/歧义/组合行/无法归属）、逐仓行数/采用/未对应/坏行/重复 SKU/失败原因、每仓成功时间、范围最后全部成功时间；
- 对应复核：搜索+分页（服务端）、无建议也可手动选商品/仓/单位（无默认）/理由、批量只作用勾选、重核/停用/换绑带旧版本；
- 结果未知：pending 期间锁新写，核对三态，明确未找到可同 requestId 重试原操作，刷新后恢复入口；
- 聚水潭/飞书物流/喜运达显示“未接入”。

`/dashboard/inventory`：
- 货号/69 编码/名称/外部 SKU 搜索，仓库/市场筛选（市场来自服务端有证据的仓/市场关系，与分页无关），清空筛选，分页；
- 列表与详情同一查询上下文（详情默认沿用列表筛选；显式“查看全仓”才切全仓并声明）；
- 详情逐仓×SKU 行、单位分组、多单位不强行合计、本次未见/上次已知、失败仓旧值+旧时间+失败、未对应/缺口；
- 真实 0 / 无有效库存 / 未对应 / 本次未见 / 更新失败分开；国内与物流在途不显示 0；不展示新估值。

## 7 权限与金额

- 页面读取与服务端动作都要求启用中的管理员会话；读取只读事务；动作用 server action + `requestId` + sha256 `intent` 幂等回执；pending 行由服务端强制单账号唯一。
- app 角色只能 EXECUTE app 读/动作函数（15 个）；sync 角色只能 EXECUTE 后台函数（10 个）；私有金额表对 app/sync/auth 全部 REVOKE；FORCE RLS。金额不进公共行/页面/日志。
- 原始 xlsx 保存在受限本地目录（`<run>/inventory-work/exports/`），不进 `public/`、不入 Git。

## 8 运行说明（可复现）

前置：Windows + 本仓库依赖已安装（`node_modules`）、Python 3.13（playwright/openpyxl/psycopg/pytest）、本机有 Chrome、`.local/p0-02/run-20261014-r2/pg/pgsql/bin` 的 PostgreSQL 二进制。

```powershell
$run = "run-YYYYMMDDTHHMMSSZ-8hex"

# 1) 准备独立实例（自建库/角色/表/种子 → 016/017 握手 + 幂等函数 + 候选种子 + 冻结 worker 源码）
$env:INVENTORY_PREVIEW_PORT = "3032"
node scripts/inventory/prepare-instance.mjs --run-id $run

# 2) 生产预览构建（隔离 staging → 校验 → promote；不覆盖现役构建）
node scripts/catalog/build-preview-workspace.mjs --run-id $run
node scripts/catalog/promote-preview-build.mjs --run-id $run

# 3) 从全停状态恢复：数据库 → 网页 → 后台 → 状态检查（一步完成，每步都验归属）
node scripts/inventory/start-instance.mjs --run-id $run
#    登录：admin@catalog.test / CatalogAdmin123!（密码文件在 instance/password.local.txt）
#    网页：http://127.0.0.1:3032/dashboard/sync

# 4) 查看状态（网页/数据库/冻结源码/后台归属与心跳/设置/最近任务/待恢复动作）
node scripts/inventory/status.mjs --run-id $run

# 5) 停止（只停本包实例；归属不符会拒绝）
node scripts/inventory/stop-worker.mjs --run-id $run
node scripts/inventory/stop-instance.mjs --run-id $run

# 6) 仅刷新后台冻结源码（候选源码变更后显式操作，并重启 worker）
node scripts/inventory/freeze-worker-source.mjs --run-id $run --refresh-worker-source
node scripts/inventory/stop-worker.mjs --run-id $run
node scripts/inventory/start-worker.mjs --run-id $run
```

本包 A1 最终现场（2026-10-26，待独立复审）：`run-20261026T180500Z-a1b2c3d4`，网页 3036、独立 PG 61653、BUILD `L4waWh75n57_sdLsWYaNT`、后台 `inv-worker-61653`；启停用 `start-instance/status/stop-instance --run-id run-20261026T180500Z-a1b2c3d4`（不得停 3035/54164、候选 3034/61135 及旧实例）。A1 恢复链验证命令：`INVENTORY_BASE_URL=http://127.0.0.1:3046 INVENTORY_UPSTREAM_URL=http://127.0.0.1:3036 INVENTORY_PROXY_PORT=3046 INVENTORY_INSTANCE_DIR=<...run-20261026T180500Z-a1b2c3d4>/instance INVENTORY_EXPECTED_RUN_ID=run-20261026T180500Z-a1b2c3d4 INVENTORY_BUILD_ID=L4waWh75n57_sdLsWYaNT node node_modules/@playwright/test/cli.js test tests/inventory-browser/inventory-terminal-recovery-a1.browser.pw.ts --config playwright.config.inventory.ts`。

### 8.1 首次使用步骤

1. 打开 `/dashboard/sync`，确认账号、参与仓库、后台在线、登录状态。
2. 设置频率（例如 60 分钟）、勾选参与仓库、打开“自动同步”保存；页面显示下次计划时间（关闭自动只取消以后自动触发）。
3. 点“立即同步”验证链路（不改变自动时间）；或等待计划时间由后台执行。
4. 首次同步后到“商品对应复核”：有出处建议可逐条/勾选确认；无建议也能手动选商品、仓、单位并填写理由；不猜绑、不默认全选、不扩到全账号。
5. 失败排查：任务列表看状态与错误原因 → 任务详情看逐仓结果/文件校验/坏行；“需要登录”按 §8.3。

### 8.2 空范围 / 市场 / 结果未知

- **空范围**：在数据同步页取消全部参与仓库并二次确认保存 → 页面显示“参与仓库为空：已停止发布”，刷新/重启保持；立即同步被禁用并给明确原因；重新勾选原仓库保存后按新范围恢复。
- **市场筛选**：选项来自服务端（仓库名明确市场词：越南/VN、DEE泰国/TH、印尼/ID、PH·菲律宾/PH、喜运达MY/MY；`DEE-龙仔厝` 未确认保持“待确认”），只列参与范围，翻页/搜索不丢；列表与详情同范围。
- **结果未知**：提交响应丢失后，刷新到“原请求待核对”并先点“核对原请求”。找到成功回执时恢复；读到“原操作失败，已处理完”时，页面先显示说明，随后只清这一条本地记录并解锁，修正后以新请求重新操作，旧失败请求不再执行。只有明确未找到且没有失败终态时才允许重试原请求。读取失败、仍未知或身份/参数不符时保留原记录与锁；不得清浏览器数据或换请求号来跳过核对。

### 8.3 登录失效恢复

1. 页面显示“需要登录”，任务停在 `needs_login`，后台不再反复重试。
2. 人工登录：`node scripts/inventory/login-bigseller.mjs --run-id $run`（弹出 Chrome，用户自己登录/过滑块；脚本只持久化会话，不保存密码；登录期间不要同时运行导出）。
3. 后台每次心跳后如账号仍为 `needs_login`，会 ≤60 秒探测一次；探测到**非空且与固定账号一致**的身份才调用 `refresh_inventory_account_status` 转 `active`，随后继续领取任务；身份缺失/不符不会转正常。
4. 若导出先报 `LOGIN_REQUIRED`，后台会做一次有界复核；确为有效会话则重试一次导出（总尝试 ≤2），仍失败才置 `needs_login`。
5. `disabled` 永不自动恢复（需管理员显式处理）。

### 8.4 备份与恢复

```powershell
node scripts/inventory/backup-restore-verify.mjs --run-id $run
```
实际执行：整库 `pg_dump` → 临时库恢复 → 逐表行数与内容摘要比对（含候选、pending、schema_state 等 21 张（去重）库存表）→ 最新导出文件复制并校验 sha256 → 删除临时库。回执写在 `<run>/inventory-backup-restore-verify.json`。手工恢复：停网页与后台 → 同版本二进制 psql 恢复 dump → 启动 → `status.mjs` 核对 runId/表数量 → 再启动后台。

### 8.5 机器重启后

后台是普通进程，不注册系统服务：机器重启后执行 `start-instance.mjs`（数据库→网页→后台→状态检查）。数据库与文件都在实例目录；后台按数据库计划继续，停机期间错过的多个自动时间点只合并一次，不密集补跑、不伪造历史。旧执行者恢复后因租约失效不能继续发布/结单（本轮已做真实 SIGKILL→重启接管演练）。

## 9 验证入口

```powershell
# 集中自验（含 python / 页面纯逻辑 / 归属 / RPC smoke / 会话 / 浏览器 / 独立 PG / 备份）
node scripts/inventory/run-check.mjs --run-id $run --pg-instance-dir <另一个实例目录>

# 真实采集后固定核对点：原始 Excel vs 列表/详情 RPC（LS101295=1028、WM0026 同仓两行 3122+4139 等）
python scripts/inventory/verify-raw-vs-detail.py --run-id $run
node   scripts/inventory/verify-fixed-samples.mjs --run-id $run

# R2 对应维护生命周期（无建议确认/换绑/重核/单位冲突）
node scripts/inventory/verify-mapping-lifecycle.mjs --run-id $run

# R5 结果未知恢复链（设置 + 停用两个入口；核对只读、同请求号只一次效果）
node scripts/inventory/verify-r5-recovery-chain.mjs --run-id $run

# R4.3 受控中途 SIGKILL → 重启接管（真实进程级）
node scripts/inventory/recovery-drill.mjs --run-id $run --hold-ms 90000
```

## 10 已知边界与未覆盖（不写成通过）

- 本包只做海外仓（BigSeller）库存；聚水潭国内库存、飞书物流在途、喜运达轨迹**未接入**（页面显式标注，不补 0）。
- 不做新估值、组合拆分、单位换算、销量/周转/预测、日统计与历史重述；组合 SKU 在来源端排除且文件内识别拒绝。
- 商品包装单位没有来源列：本版确认时由操作者显式选择单位（本轮固定样本用“件”并注明业务包装单位待确认），不做自动换算；单位未知不合计。
- 市场只从仓库名称中明确的市场词带出；`DEE-龙仔厝（ICE专属）` 保持“市场待确认”，不猜。
- 真实“自然登录过期”没有等平台踢会话；本轮在修复实例上制造了 `needs_login` 并用真实有效会话验证“≤60 秒探测→identity verified→自动恢复”，另有一次真实的瞬时导出误判→有界复核/恢复证据（失败 run 保留）。
- 进程级断电未做；做了**一次**真实 SIGKILL 中途停止→租约过期→重启接管（恢复 run success、原观测时间/原文件、已发布仓不重复、旧 token 被拒）。多进程并发压测、多机高可用未做。
- R5 浏览器端到端“注入响应丢失→核对失败→恢复”未做（RPC/动作层链已实测；浏览器测试覆盖 pending 相关页面元素与空范围/流程）。
- 旧 15×20 性能门禁、旧 UI 延期项、完整权限矩阵、真实 200% 缩放不重开；本地预览不等于生产部署；BigSeller 平台频率下限未核实（5 分钟为工程保护）。
- 生产账号/数据库切换、正式发布另行安排；未提交/推送/合并/部署。
