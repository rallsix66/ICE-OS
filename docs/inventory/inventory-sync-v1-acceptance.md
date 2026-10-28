# 商品库存与 BigSeller 自动同步 v1 — 集中修复 v2/v3/v4 验收结果与证据

日期：2026-10-26。实现说明与运行手册：[inventory-sync-v1.md](./inventory-sync-v1.md)。任务正文：[inventory-sync-v1.md](../tasks/inventory-sync-v1.md)。
**2026-10-27 主审独立复审通过：`BS_LIVE_INTAKE_V1_LOCAL_PASS`。** [独立报告](../../.local/bs-live-intake-r1-text-independent-20261027/independent-review.md)。R1 最后一处错误空态已关闭：主审实际走查 3011 的 WM0026 越南、MY、菲律宾，正常采用行不再显示“暂无已采用”；1853、672及待核0行、3119/4138双码分别展示和待合计说明均保留。失败旧值/旧时间等分支源码未改，既有受控探针核读沿用，未制造真实失败。

3011 BUILD `MB1i1eT7pYCsG8qdb1iea`，600个构建清单文件一致；唯一业务改动为现有组件+2行。worker PID42072、创建时间及9个冻结文件一致。本轮未连数据库、未触发导出、未重启或改计划；430正式对应/数量对账/R2/定时同步与A1/B/C沿用前轮可信独审，不重跑无关套件。**本机正式接入与统一库存入口v1收尾，无新增修复包。** 未匹配归属、PH双码合计口径、货值暂未计算及旧投影观察项保持原边界；数据、旧现场、失败证据全部保留。本地通过不等于公网部署或全ICEOS验收。

### 2026-10-27 R1说明条件执行交付（历史自验记录）

**2026-10-27 R1 说明条件收尾：`BS_LIVE_INTAKE_V1_R1_TEXT_IMPLEMENTED_AWAITING_INDEPENDENT_REVIEW`（执行方自验，待独立复审）。** [本轮交付摘要](../../.local/bs-live-intake-r1-text-20261027/delivery-summary.md)、[证据索引](../../.local/bs-live-intake-r1-text-20261027/evidence-index.md)。仅修 `catalog-detail.tsx` 的 `scopeReason`（+2 行）：正常 current 且有采用行时不再显示“本仓暂无已采用的 BigSeller 库存行”；失败保留旧值/旧时间、未对应/无来源/本次未见、MY 待核 0 行、PH 双码待合计保留。3011 最终 BUILD `MB1i1eT7pYCsG8qdb1iea`；真实页面 42/42。R2 与 R1 原四项接线沿用已独立通过结果，不重开。

### 2026-10-27 R1/R2 独立复审快照（历史）

独立10:33快照：3011 / PG59345 / BUILD `IbVHV6BZXFtK3ft2cEb4k`，600构建文件和9个冻结worker文件一致，自动同步开启60分钟，16次成功（2手动+14计划），最新10:22自然计划成功、pending0。728源行/650批次行/430有效行/116商品小计与同批Excel核对0差异；430正式对应、126/128/126主资料不变；旧数据/原表/构建/worker/证据保留。

`inventory_current`旧投影确实未持续更新，但现役商品/库存/历史读取均从有效批次获取，未影响当前430行；只记观察，不另立包、不回填旧表。PH双码合计、未匹配商品归属仍为业务待决。主审只读复核并更新文档，无业务源码/数据库修改、启停、新导出或清场；A1/B/C等可信证据沿用。正式本地同步继续运行，整包待这一处文案条件修完再关闭。

**此前A1验收基线（历史）**：**状态：`INV_SYNC_V1_REPAIR_V4_FINAL_A1_LOCAL_PASS`（2026-10-26 A1 主审独立复审通过；本轮技术开发收尾，正式业务启用仍待确认）。**
输入：v4 FINAL 独审 `INV_SYNC_V1_REPAIR_V4_FINAL_NEEDS_FIX` 与 [independent-review.md](../../.local/inventory-sync-independent-v4-final-20261026/independent-review.md)、[唯一剩余修复](../../.local/inventory-sync-independent-v4-final-20261026/remaining-repair.md)；v4 FINAL 首轮、v4 首轮、v3/v2 独审与执行包、v1 历史输入保留。

**2026-10-26 用户补充确认（晚于 A1 验收）**：BigSeller 库存数量均按单个商品计数，不是箱，不做装箱数换算；其他国家仓商品编码对商品库“69编码”，菲律宾新创启辰仓主要用货号、少数条码可参考库存辨认。规则唯一正文见[商品身份标准第7节](../product-identity-standard-v1.md)。数量单位已确认，不再作为业务待决；WM0026 该仓两种编码已确认同时展示，各自数量保留、不强制二选一；本次未决定正式合计口径，不阻塞其余明确项。本次只记录规则，程序、数据库验证标记、正式对应与页面入口尚未据此修改；下面验收时的“单位待确认”保留为历史记录。

## 2026-10-26 A1 主审独立复审通过

**2026-10-26 主审独立复审通过：`INV_SYNC_V1_REPAIR_V4_FINAL_A1_LOCAL_PASS`。** [独立报告](../../.local/inventory-sync-independent-v4-final-a1-20261026/independent-review.md)。A1 失败终态恢复已关闭；B/C 保持上一轮通过。本轮已批准修复的本地技术开发收尾，无新增返工包。

独立最终源码离线闭环 13/13、实际新库只读核验 12/12：失败终态可重复读取，核对/旧重试/旧动作入口均不再执行业务；最终页面链证据经主审核读（未重复写页面测试），显示终态后只清本条记录，设置可改。586 个源码/运行文件及 3 个部署函数匹配。执行方旧离线探针缺定时器模拟，已在新独审目录补齐，原失败保留；不要求业务返工。

验收现场：`run-20261026T180500Z-a1b2c3d4` @ 3036 / PG61653，BUILD `L4waWh75n57_sdLsWYaNT`；后台心跳在线，当前自动同步关闭、60 分钟、7 仓、configVersion 9、pending 0。15/105/9750 未变；五商品小计沿用本轮执行对账与上轮独审，不冒充再次全量核对。验收时的单位待确认已由本次用户确认结清；数据库验证对应尚未转为正式关系，验证数据不等于正式库存启用。全部旧实例、原表、历史失败证据保留；本轮未改业务源码/数据、未提交/推送/合并/部署/清场/写长期记忆。

## 2026-10-26 v4 FINAL A1 最小收尾执行结果（执行方自验，待独立审查）

**状态：`INV_SYNC_V1_REPAIR_V4_FINAL_A1_IMPLEMENTED_AWAITING_INDEPENDENT_REVIEW`。** B/R1、C/R4 已通过不重开；本轮只修 A1“结案成功但响应丢失后不能恢复”。**不是独立审查结论，不声明 PASS。**

### v4a1.1 修复实例与构建

- 新隔离实例 `run-20261026T180500Z-a1b2c3d4` @ `http://127.0.0.1:3036`（BUILD **`L4waWh75n57_sdLsWYaNT`**，staging `next-build-8e2d6de0c201fd4e`，start 后 `repoDrift=false`）、独立 PG `127.0.0.1:61653`、后台 `inv-worker-61653`（冻结源 `9003dd67…`）、schema v5（020 `4e384414…` + functions **`1b2387ad…`**，与源码一致）；登录 `admin@catalog.test / CatalogAdmin123!`。
- 3035/54164、3034/61135、3011/3021/3022、3031+50499、3032+59532、3033+53442 保留只读；写入仅新实例 61653。

### v4a1.2 修复内容

- `db/catalog/016_inventory_sync_functions.sql`：`reconcile_inventory_request` 无业务回执时读取同 actor/同 intent 的 failed 终态（`terminal:'failed'`+`terminalErrorCode`，可重复、成功回执优先）；`begin_inventory_pending_action` 回放返回 `errorCode`。
- `src/features/inventory/{types,model,server/actions,components/pending-recovery}`：核对映射 `failed_terminal`、重试入口/begin 回放拒绝再次执行原业务、页面显示“原操作失败，已处理完，可以修正后重新操作”后只清该 requestId 本地记录并刷新解锁。
- 未新增 RPC/表/状态存储；未改 B 采用态、C run-check、库存计算/历史。

### v4a1.3 验证命令与结果（执行方实际运行）

| 验证 | 结果 | 证据 |
|---|---|---|
| A1 最终页面＋DB 链（代理丢弃 settle 响应） | **1/1**：failed/`INVENTORY_SCOPE_EMPTY`、无回执、刷新锁→核对终态→清记录/解锁/设置可改并恢复；恢复 POST 1 条 unknown、business/register 0；runs/batches/batchRows 15/105/9750 不变 | `browser/a1-recovery-report.json`、`browser/terminal-unlocked.png`、`browser/report.json` |
| 独审第13项反例（复制件，内存 RPC 对齐 SQL 终态） | **13/13 PASS**；原失败脚本/结果副本保留 | `settlement-probes-a1.cjs`、`settlement-probes.json`、`settlement-probes-reviewer*` |
| PG 套件（含 failed 终态重复读取、begin 回放、错 intent/他人拒绝、失败行保留） | **44/44** | `db/pg-suite-run2.log` |
| 只读核对（五商品/覆盖/历史/405 修订） | **42/42** | `verify-repair-v4-a1-readonly.json` |
| 部署一致性只读（函数体/哈希/failed 行/无回执/计数） | 通过 | `db/deploy-readonly-verification.json` |
| 页面纯逻辑 / 静态 | 109 passed；tsc 本包 0 新错、eslint 0/0、diff check 0 | 命令输出 |
| 构建 | staging→promote→start，`repoDrift=false` | `web/build-record.json`、`web/status.json` |

### v4a1.4 保护、差异与未覆盖

- 保护快照 before→final：12 端口 + 5 个旧 run 的 marker/env/worker/export 差异 0；旧 3031/50499 事件不归因。
- 未重抓 BigSeller、未删/补造测试对应/历史；五商品验证小计 1028/247/23/13059/122110 保持，27 条回放验证对应（候选现场另含 3 条测试对应共 30）仍为验证数据（`unitConfirmed=false`），单位“件”待业务确认，验证数据不等于正式库存启用。
- 误写独审 `settlement-probes.json` 已按运行前副本 sha `e96eaa59…` 恢复并记录（`RESTORE-NOTE.md`）。
- 未覆盖：丢响应为受控代理模拟（非真实断网）；多机/断电/自然过期/200%/完整权限矩阵、旧性能/UI 保持原范围；未提交/推送/合并/部署/清场。

## 2026-10-26 v4 FINAL 主审独立复审

**2026-10-26 主审独立复审：`INV_SYNC_V1_REPAIR_V4_FINAL_NEEDS_FIX`。B/R1 与 C/R4 通过；只剩 A1 一条故障恢复闭环。** [独立报告](../../.local/inventory-sync-independent-v4-final-20261026/independent-review.md)、[唯一剩余修复](../../.local/inventory-sync-independent-v4-final-20261026/remaining-repair.md)。

后台已确认失败结案，但返回通知丢失时，核对仍给 not_found，重试后 NOT_PENDING 被误当参数不一致，本地锁不能解除。独立真实 actions/组件离线探针原12项通过、新增1项失败；PG54164已存在failed行的只读核对确认关键前提。只需可信读取原失败终态并解锁，恢复阶段不再执行业务；错身份/参数、仍未知、成功回执保持保护。

B 独立只读29/29、5个部署函数体一致，最终页面列表/详情口径正确；C真实分支离线3/3，覆盖参数连接前拒绝。五商品验证小计1028/247/23/13059/122110未变，三条新验证对应未计入，原十条来源保留。构建526文件与运行目录一致；3035/PG54164、BUILD `KJUZ9F4ZJuSl2a7qWWAZ6`、冻结后台及进程归属已核。当前自动同步关闭、60分钟、7仓、pending0。

本轮只新增独审证据并同步状态文档，未改业务源码/业务数据、未启停/提交/推送/合并/部署/清场/写长期记忆。全部候选、原表、验证对应和旧失败证据保留。单位仍待业务确认，本地预览不等于正式库存启用；未受影响证据沿用，不重开B/C及无关测试。以下执行方交付与旧独审按历史身份保留。

## 2026-10-26 v4 最终收尾 A/B/C 执行结果（执行方自验，待独立审查）

**状态：`INV_SYNC_V1_REPAIR_V4_FINAL_IMPLEMENTED_AWAITING_INDEPENDENT_REVIEW`。** 只补 A/R2 失败结案与完整绑定、B/R1 采用态区分、C/R4 run-check 备用 PG 配置接线；复用 v2/v3/v4 可信证据。**不是独立审查结论，不声明 PASS。**

### v4f.1 修复实例与构建

- 新隔离实例 `run-20261026T164500Z-e8f9a0b1` @ 网页 `http://127.0.0.1:3035`（BUILD **`KJUZ9F4ZJuSl2a7qWWAZ6`**，staging `next-build-6c10f7041c53379c`，promote/start 后 `repoDrift=false`）、独立 PG `127.0.0.1:54164`、后台 `inv-worker-54164`（pid 31392，冻结源 `9003dd67…`）、schema v5（020 `4e384414…` + functions `7cd92fd3…`，与源码一致）；登录 `admin@catalog.test / CatalogAdmin123!`。
- 候选 3034/61135 与旧 3011/3021/3022、3031+50499、3032+59532、3033+53442 保持只读、未启停/未替换构建；写入仅新实例 54164。

### v4f.2 A/B/C 结果矩阵（执行方实测）

| 项 | 实现 | 实测结果 | 证据 |
|---|---|---|---|
| A/R2 失败结案四态 | DB `settle_inventory_pending_action`（单事务 FOR UPDATE，核 actor/action/intent/完整 payload，成功回执不改判）+ `settlement.ts` + actions 完整绑定 + 4 组件清理条件 | 页面链 1/1：本地未知→明确未找到→范围被清空→重试 `INVENTORY_SCOPE_EMPTY`→结案→本地锁解除、设置真实可改并恢复；DB pending=failed、无回执、锁 0。离线 12/12；PG settle 4/4 | `a/browser/`、`a/settlement-probes.json`、`a/pg-settle.log` |
| B/R1 采用态 | `adoptedSkus` 仅同范围 effective rows；`pendingAdoptionSkus=mapped−adopted`；summary/detail/list 两态；文案“已计入合计”vs“对应已确认、等待下一次完整同步采用” | 50455 已计入仅 `6974674957325=899`，三条新对应等待采用（7332=14410、7349=0、7356=2007，未计入）；LS101295 小计 1028（899+129），其余 247/23/13059/122110 不变；原十条待确认仍可见；数据 53/53、页面 27/27 | `b/verify-b-v4-final-result.json`、`b/page-verification-result.json`、`b/screenshots/` |
| C/R4 备用 PG 入口 | `run-check.mjs` 的 `pgInstanceDir` 分支先读 pgEnv → 传 `env`/marker 给连接前守卫 → 通过后才创建连接 → 保留连接后只读身份核验 | 真实分支离线 2/2：`?port=50499` 连接前 `INVENTORY_TEST_TARGET_ENV_OVERRIDE`、FakeClient 构造 0/connect 0/套件启动 0；合法目标 1 次连接 + BEGIN READ ONLY/ROLLBACK | `c/c-offline-probe-result.json` |

### v4f.3 验证命令与结果（执行方实际运行）

| 验证 | 结果 | 证据 |
|---|---|---|
| 回放 15 run/105 批次/9750 行/27 对应 + 3 条 B 验证对应（confirmed=30） | ok=true | `replay/replay-result.json` |
| PG 套件（schema v5 + settle + B 采用态 + 原 R1–R4） | **43/43** | `db/pg-suite-run3.log` |
| 只读核对（五商品/覆盖/市场/历史/405 修订） | **42/42** | `verify-repair-v4-final.json` |
| A 页面链 + DB；A 离线/PG | 1/1；12/12、4/4 | `a/` |
| B 数据/页面 | 53/53、27/27 | `b/` |
| C 离线分支 | 2/2 | `c/` |
| 页面纯逻辑 | 109 passed | 命令输出 |
| tsc（本包 0 新错）/ eslint `--max-warnings 0` / `git diff --check` | 通过 | — |
| 构建 staging→promote→start、status、worker、no drift | BUILD `KJUZ9F4ZJuSl2a7qWWAZ6` | `web/build-record.json`、`web/status.json` |

### v4f.4 数据差异与保护（保留，不补造）

- PH 54409 旧“五商品全无来源”仅测试前成立；最终 LS101295 `unmapped_source/2`（6974674957332 行471=0、6974674957349 行470=0），其余四商品仍 `no_source`；旧断言失败保留，不删除测试对应凑答案。
- 候选 61135 的 50455 两条待确认（4967=23 行710、2611=247 行716）来自 48787 额外 4 条测试对应，本回放 27 条基线未含，故不出现；未补造映射。
- 保护快照 before→final：端口 0 变化；4 个旧实例 marker/env/worker 配置 sha 0 变化；旧 3031/50499 未确认事件不归因、不清理。三条 B 验证对应与 27 条回放对应均为验证数据（`verification=true/unitConfirmed=false`），单位“件”待业务确认。

### v4f.5 未覆盖（不写成通过）

- A 真实页面只跑“确定失败且结案成功”主链；settle_failed/未知/not_original/NO_PENDING 由离线探针 + PG 事务覆盖，未在真实页面制造网络中断。
- B 仅默认视口真实页面，无 200% 缩放/全浏览器矩阵。
- C 未真实连接保护库做反例（按任务要求）。
- 通用：真实断网/网络分区、自然登录过期、断电/多机并发、旧 15×20/旧 UI/完整权限矩阵、真实 BigSeller 最低频率、国内库存/物流/估值；本地预览不是生产部署。未提交/推送/合并/部署/清场。

## 2026-10-26 v4 主审独立复审

**2026-10-26 主审独立复审：`INV_SYNC_V1_REPAIR_V4_NEEDS_FIX`。** [独立报告](../../.local/inventory-sync-independent-v4-20261026/independent-review.md)、[仅三处剩余收尾](../../.local/inventory-sync-independent-v4-20261026/remaining-repairs.md)。原十条来源缺口、五商品采用小计、身份/请求切换与完整参数绑定主体、R3 混合批量、R4 主守卫已核实；不重开已关闭项。

剩余：**R2** 原操作确定失败且已结案后，本地恢复锁未解除；错意图的拒绝调用反而可结案原锁，须一并收口。**R1** 3 条新确认但未进入库存批次的 SKU 被提前标为“已采用/已计入”，当前数量未错加。**R4** run-check 备用 PG 入口漏把实际配置传给连接前守卫，连后仍会阻止写入。只补这三处及直接相关验证，不新增功能或重跑无关套件。

独立核524个构建源码/运行目录文件一致，候选3034/PG61135、BUILD `BWfdgG5RtlNS3KlwLzYLp`、后台冻结源和进程归属已核；只读数据、真实页面及离线反例另存本轮证据。执行方13条测试映射保留，最终37 confirmed/3 recheck；LS101295 的 PH 无来源对照已因测试映射扩展变为2条来源，旧“五商品全无来源”仅属于测试前记录。五小计仍1028/247/23/13059/122110，单位仍待业务确认；未生产启用。

本轮只改审查证据与状态文档，未改业务源码/库存业务数据、未启停/提交/推送/合并/部署/清场，旧实例与原证据保留。下文执行方自验、旧独审均按当时范围保留，不代替现役独审结论。

## 2026-10-26 集中收尾修复 v4 执行结果（执行方自验，待独立审查）

**状态：`INV_SYNC_V1_REPAIR_V4_IMPLEMENTED_AWAITING_INDEPENDENT_REVIEW`。** 本轮只处理 v3 独审的 R1–R4，复用 v2/v3 真实导出、回放、接管、备份正常路径、历史修订、登记原行绑定等可信证据；不重开旧性能/UI/权限矩阵。**不是独立审查结论，不声明 PASS。**

### v4.1 修复实例与构建

- 新隔离实例 `run-20261026T153500Z-c4e8a1b2`：网页 `http://127.0.0.1:3034/dashboard/sync`、独立 PG `127.0.0.1:61135`、库 `iceos_catalog_run_20261026T153500Z_c4e8a1b2`；marker `repair-v4/testWritable/validationInstance`。
- 最终 BUILD **`BWfdgG5RtlNS3KlwLzYLp`**（隔离 staging `next-build-43d2972ceaa1903e`，源码快照 `43d2972c…`，promote/start 后 no drift）；后台 `inv-worker-61135`（pid 53404，online/owned，冻结源 `9003dd67…`）。
- 数据库增量 `db/catalog/019_inventory_sync_repair_v4.sql`（`48f856f8…`，R1 索引 + version 4 握手）+ 重放 functions `a8dff9c0…`；实际 DB `inventory_schema_state.version=4`；未改 00001–00052/016 结构/017/018。浏览器验证期间新实例产生的测试数据见 v4.5。

### v4.2 R1–R4 结果矩阵（执行方实测）

| 组 | 原问题 | 最终行为 | 证据 | 完成 |
|---|---|---|---|---|
| R1 来源存在性/同仓部分 | 52074 六条真实源行被报“没有该 SKU 来源”；54886/56673 四条被同仓已采用 SKU 掩盖 | 已知编码（全部仓 confirmed mapping ∪ candidate）在本仓最新登记 run 的源行独立读取；`current` 仓也列 `pendingSourceRows`（文件行号/数量/mapped）；真无源行仍 `no_source`；PH 54409 对照 `sourceRowCount=0`；列表/详情同范围同解释；pending 不自动绑定、不计合计；五商品小计 1028/247/23/13059/122110 不变 | `r1/verify-r1-v4-result.json` 38/38 | 已完成 |
| R2 未知请求锁/身份/内容 | 本地未知记录不锁新写；无原操作者/账号；换请求继承 not_found；完整内容指纹歧义（一条备注 vs 两条映射同 hash） | 全部写入口先登记后执行；本地 v2 记录绑定服务端 actor/account 并与服务端 pending 共同锁新写；旧 v1 记录待核实不执行；换 requestId/intent/actor/account 重置核对；本地回退带 originActorId 由服务端校验当前会话；intent v4 结构化编码 + DB 完整参数核对；同旧指纹不同内容 `INVENTORY_REQUEST_CONFLICT`；旧 v3 指纹服务端 pending 仍可核对/重试；前置失败收口假锁 | `r2/r2-verification.json`、`r2/browser/report.json` 8/8、PG 套件 R2 用例 | 已完成 |
| R3 混合首次+重确认 | 同批存在重确认行时整批要求旧版本，首次行被拒 | `buildConfirmBatch` 按行 `reconfirmRowKeys` 判断：首次允许 null、重确认必须页面所见版本；服务端旧版拒绝不变；页面一次提交两行均落库（重确认 v1→2、首次 v1） | `r2/r2-verification.json` R3-1、纯逻辑 6/6 | 已完成 |
| R4 实际连接目标 | 守卫只看 URL 主部，驱动可用查询参数覆盖 host/port | 按 `pg-connection-string` 驱动最终目标检查；连接前拒绝覆盖参数（`INVENTORY_TEST_TARGET_ENV_OVERRIDE`）；连接后只读核实际库名/端口；12 入口与 prepare 接入；保护集合补 53442/v3 run | `ops/offline-target-guard-results.json` a–l 全 PASS、`ops/connected-target-probe.json` | 已完成 |

### v4.3 验证命令与结果（执行方实际运行）

| 验证 | 结果 | 证据 |
|---|---|---|
| 回放保留批次（15 run/105 仓批次/9750 行/27 验证对应/405 adopted） | ok=true；WM0049 越南 50455 83,025→83,022（-3）、WM0026 2,001→2,001（0） | `replay/replay-result.json` |
| 只读核对（五商品/覆盖/市场/历史/修订） | **42/42 passed** | `verify/verify-repair-v4.json` |
| R1 十条真实源行 + PH 对照 + 列表/详情一致 + 小计 | **38/38 passed** | `r1/verify-r1-v4-result.json` |
| PG 套件（schema v4 + R1/R2 v4 + 原 F1–F4/F3/R5） | **38/38 passed**（2 files，0 skipped/flaky，exit 0） | `db/pg-suite-run3.log` |
| 页面纯逻辑 | **91 passed**（web-model 64、web-model-v4 16、web-real-shape 5、intent-v4 6） | 命令输出 |
| 浏览器 v4 闭环（BUILD `BWfdgG5…`，代理 3044→3034） | **8/8 passed**（0 skipped/flaky/unexpected，79.4s，exit 0） | `r2/browser/report.json`、`r2/r2-verification.json` |
| R4 离线反例 | a–l 全 PASS（0 数据库连接；不向保护库试写） | `ops/offline-target-guard-results.json` |
| 构建 | staging → promote → start，BUILD `BWfdgG5RtlNS3KlwLzYLp`，no drift | `web/build-record.json` |
| 静态 | inventory tsc 0 新错误（全仓仅既有 BEST 5）、eslint `--max-warnings 0` exit 0、`git diff --check` 0 | 命令输出 |

### v4.4 本轮发现并修复的真实问题（页面验证暴露）

本轮浏览器套件迭代中修了 3 处**测试断言/选择器**（非产品缺陷）：其中 R2-6 一次断言写错导致“重试已生效但用例失败”，该轮写入已在 `r2/r2-execution-report.md` 披露；页面/服务端代码在冻结后零改动。未发现新的业务错数。

### v4.5 新实例测试痕迹与保护

- 浏览器测试真实写入 13 条测试 mapping（含 3 条 R3-1 重核历史行）+ 21 条 request，settings configVersion 1→9（enabled=false、interval 60→65）；R2-5/R2-6 fixture pending 已删除、operator 角色已恢复、最终 pending 锁 0；回放基线 15 run/105 批次/9750 行与 27 条回放 mapping 未动。逐条见 `r2/r2-execution-report.md` §7。
- 保护：3011/3021/3022、3031+50499、3032+59532、**3033+53442** 未启停/未写入/未替换构建；保护快照 before→final 端口 0 变化、实例 marker/env/worker 配置与 exports 0 变化；3033/53442 仅只读文件读取。旧 3031/50499 未确认测试写入现场保留、未归因；旧 59532 历史 item_revision 仍 NULL（未回填）。
- 未覆盖：真实断网/网络分区（本地反代模拟）、自然登录过期、断电/多机并发、旧 15×20/旧 UI/200%/完整权限矩阵、真实 BigSeller 平台最低频率、国内库存/物流/估值；本地预览不是生产部署。未提交/推送/合并/部署/清场。

### v4.6 仍待业务确认

- 27 条对应（含回放 27 条）仍为验证数据（`verification=true/unitConfirmed=false`），单位“件”是执行方验证选择，不代表业务包装单位确认，不能作为正式业务库存合计启用。
- 待确认商品/来源 SKU/仓：LS101295(6974674957325)、LS101302(6973517482611)、WM0011(6973517484967)、WM0026(757577983013、ICEWM0026)、WM0049(757577407113、WM0049)；仓 50455/56519/54886/53252/56673（及 52074 待核对来源）。

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

**证据分层（勿混记）**：
- **历史独审输入证据**：2026-10-25 独审报告及原结果 JSON 保留；旧 worker-focused-probes.py 被执行方改为修复后断言，不是全部未改。本轮主审另建独立探针。
- **执行方本轮自验**：本文件 §1–§7，均为执行方命令与原始结果（含失败现场），**不是独立审查结论**。
- **历史执行方证据**：旧 8 次真实导出及旧浏览器结果保留；原 3031/50499 实例出现未明来源测试写入，前后快照保留，详见保护边界事件。

## 2026-10-26 集中补修 v3 执行结果（执行方自验，待独立审查）

**状态：`INV_SYNC_V1_REPAIR_V3_IMPLEMENTED_AWAITING_INDEPENDENT_REVIEW`。** 本轮只处理[集中补修包 v3](../../.local/inventory-sync-independent-v2-20261026/execution-repair-v3.md) 的 F1–F5；复用 v2 真实导出、11 个 worker 反例、中途接管、备份正常路径等可信证据，不重开旧性能/UI/权限矩阵。**不是独立审查结论，不声明 PASS。**

### v3.1 修复实例与构建

| 项 | 值 |
|---|---|
| run id | `run-20261026T123800Z-d3f4a5b6`（新独立实例；旧 3032/59532、3031/50499、3011/3021/3022 原样保留） |
| 数据库 | `127.0.0.1:53442`，库 `iceos_catalog_run_20261026T123800Z_d3f4a5b6`；marker `testWritable:true`/`validationInstance:true`；`inventory_schema_state.version=3`，source sha `1941b997…`、functions sha `1a37dd2f…` 与文件一致 |
| 网页 | `http://127.0.0.1:3033/dashboard/sync`、`/dashboard/inventory`；`admin@catalog.test / CatalogAdmin123!` |
| BUILD | **`R4hh0kmDKek10Xm-em3Fk`**（隔离 staging 生产构建 + promote；promote 后 start 无 drift） |
| 后台 | `inv-worker-53442`，冻结源 `9003dd67acb4…`（9 文件），online |
| 证据 | `.local/inventory-sync-repair-v3-20261026/`（`delivery-summary.md`、`replay/`、`verify/`、`db/`、`f5/`、`web/`、保护快照 before/after/final） |

### v3.2 F1–F5 结果（执行方实测）

| 组 | 修复内容 | 实际结果（页面/DB/命令） | 证据 |
|---|---|---|---|
| F1 对应维护 | 全链按账号+仓+SKU 行身份；队列返回 currentMapping/版本；单条与批量真实提交；重新确认/重核/停用/换绑带所见版本；`verification:true` 记录验证数据/单位未确认；不代填单位 | **页面 4/4 PASS**：无建议行单条确认（LS101295，DB version=1、`manual_confirm_validation`、verification=true/unitConfirmed=false）；同 SKU 两仓只确认 A 仓、B 仓无 mapping；批量 2 条成功；重核/停用后按当前 version 重确认成功、旧版页提交被服务端拒绝且版本不回退。PG 套件覆盖版本/同 SKU 两仓 | `web/page-verification.md` §1 用例 1–4；`db/pg-suite-run4.log` |
| F2 覆盖与历史 | 历史前驱派生（不改历史行）；发布保存当时 item_revision、缺失拒发；owner-only 只读策略解决后台版本可见；覆盖/缺口/市场统一读模型；旧 NULL 版本显示缺失 | **42/42 只读核对**（页面测试后仍通过）：LS101295 1028、LS101302 247、WM0011 23、WM0026 13059（PH 3122+4139、VN 2001、MY 674、龙仔厝 3123）、WM0049 122110（PH 0+39088、VN 83022）；覆盖 5/7 且缺口 reason 明确；WM0049 历史 **83,025→83,022（-3，不是 -52）**、WM0026 **2,001→2,001（0，不是 -9）**；市场集合 `[ID,MY,PH,VN]` + 未知单独标记；405 条 adopted 行均带发布时修订 | `verify/verify-repair-v3.json`；页面 F2 PASS（`web/` 用例 5） |
| F3 发布绑定 | 发布逐行以 `inventory_run_row` 为唯一业务字段来源，严格核对 SKU/数量/raw/GTIN；保留行号/hash 改数量或换 SKU 拒绝 | PG 套件 F3 两反例均 `INVENTORY_WAREHOUSE_CONTENT_MISMATCH`，原成功批次/库存不变；正常回放 105 批次成功 | `db/pg-suite-run4.log` |
| F4 原请求恢复 | 客户端 requestId+intent；服务端以持久 pending 为准；三态核对；找到回执与解锁分离；解锁失败保留；他人 pending 仅忙碌；页面重载/刷新恢复 | **页面 5/5 PASS**：A 上游已落库回执丢失→整页重载出现恢复面板→刷新保留→核对 found（DB request=1、pending completed、settings 只变 1 次）；A2 核对请求失败→“核对失败/不代表未生效”保留、无重试；B 请求未达→明确未找到→同 requestId+intent 重试成功（DB 一次效果）；C 临时 REVOKE→found_unlock_failed（不提示解锁、pending 保持）→GRANT 后 found、`has_function_privilege=true`；D 他人 pending 仅忙碌、无 requestId/按钮，fixture 清理为 0 | `web/report.json`（10/10）、`web/web-report.json`、`page-verification.md` 用例 6–10 |
| F5 维护保护 | 冻结源 first-only/显式 refresh；备份暂停后重启失败显式失败；可写测试入口连接前 marker 守卫、连接后只读身份核对 | 冻结源 8/8、备份失败 5/5、守卫 16/16（含 9 个真实入口拒绝伪造保护端口、无 marker 拒绝）；新实例 marker 被 guard 接受；fixture 连接后 live db/port/run_id 核对通过 | `f5/f5-summary.md`、`f5-*.json` |

### v3.3 验证命令与结果

| 检查 | 结果 |
|---|---|
| 保留批次回放（只读提取 59532 → 新实例原观测时间回放） | 15 个真实成功 run、105 仓批次、9750 行；文件 sha 与登记一致；27 条 verification 对应；adopted 405 行全部带当时 item_revision（`replay/replay-result.json` ok=true） |
| 只读核对 `verify-repair-v3.mjs` | **42/42**（页面测试后复跑仍 42/42；固定样本/历史/覆盖/市场/版本/详情范围） |
| 真实 PG 套件（32 项） | **32 passed / 2 files，0 skipped/flaky，exit 0**（F1/F2/F3/F4 新用例） |
| Python 单测 | **122 passed**（`python-tests.log`） |
| 页面纯逻辑 | **69 passed**（web-model 64 + real-shape 5） |
| 浏览器 v3 页面闭环 | **10 passed / 0 failed / 0 skipped / 0 flaky，84.9s，exit 0**（BUILD `R4hh…`，代理 3044→3033；`web/report.json`） |
| F5 反例 | 冻结源 8/8、备份失败保护 5/5、测试目标守卫 16/16 |
| 类型/静态/差异 | tsc 本包 0（全仓仅既有 BEST 5）；本包 eslint `--max-warnings 0` exit 0；`git diff --check` exit 0 |

### v3.4 本轮发现并修复的真实问题（页面验证暴露）

1. `client-pending.ts` 的 `useSyncExternalStore` snapshot 每次新对象 → 无限渲染/Next 错误页；改为模块级稳定缓存。
2. 网络异常后 `router.refresh()` 落到 Next 错误页，恢复面板不可达；3 个文件的 catch 改为整页 reload（仅异常路径）。
3. `reconcileInventoryRequestAction` 在“无持久 pending 但已有 completed 回执”时仍调用 complete → `INVENTORY_PENDING_ALREADY_RESOLVED` 导致动作不返回/页面卡住；改为无锁时直接 found（不再 complete）。

### v3.5 保护与未覆盖

- 3011/3021/3022、3031/50499、3032/59532 未启停/未写库；59532 仅 `BEGIN TRANSACTION READ ONLY` 提取；保护快照 before/after/final 在 `.local/inventory-sync-repair-v3-20261026/`。旧 3031/50499 未确认测试写入事件保留原现场与前后证据，未删除、未指认来源；旧独审探针脚本曾被修改、旧结果 JSON 保留，不声称全部旧证据未改。
- 未覆盖：页面响应丢失由本地反向代理模拟（非真实断网/多机故障）；自然登录过期等待、断电/并发/多机压测、旧 15×20/旧 UI/200%/完整权限矩阵不重开；旧 59532 历史 item_revision 仍 NULL（未回填）；27 条对应为验证数据，业务包装单位/真实市场仍待用户确认；本地预览不是生产部署，未提交/推送/合并/部署/清场。
- 本轮页面测试在验证实例额外产生 34 条测试用 confirmed 对应与 104 条 pending 历史（pending 锁最终 0、临时 admin/profile 已清理、app EXECUTE 已恢复）；固定样本业务数值与回放批次未改变（42/42 复跑通过）。

## 1 修复实例与交付物

| 项 | 值 |
|---|---|
| 运行号 | `run-20261026T013000Z-b4d7f2e1` |
| 独立数据库 | `127.0.0.1:59532`，库 `iceos_catalog_run_20261026T013000Z_b4d7f2e1`（独立集群；旧 3031/50499 保护事件另列，不能声称旧实例未改） |
| 网页 | `http://127.0.0.1:3032/dashboard/sync`、`/dashboard/inventory` |
| 登录 | `admin@catalog.test / CatalogAdmin123!`（密码文件 `instance/password.local.txt`） |
| 构建 | 隔离 staging 生产构建 + promote；最终 BUILD **`v5Pys92JVgCKXGVV9aH2D`**，`npm start`，promote 时源码快照与仓库一致、无 drift 警告 |
| 后台 | `inv-worker-59532`（冻结源码 `9003dd67…`），DB 心跳 online；进程归属由 pid+创建时间+config/worker 路径校验 |
| 数据库增量 | `016_inventory_sync.sql` `a6425f54…`（fresh 结构，v2 握手）、`016_inventory_sync_functions.sql` `8b617057…`（幂等函数+策略）、`017_inventory_sync_repair_v2.sql` `4b8ee36e…`（旧 016 sha `7f12c313…` 升级）；不改 00001–00015 |
| 保护边界 | 执行方快照称 3011/3021/3022、126 商品与 BS 530 行未改；原 3031/PG50499 已出现未明来源测试写入，前后快照保留。本轮主审未连接 50499。执行方记录 [protection-snapshot.json](../../.local/inventory-sync-repair-20261026/protection-snapshot.json)（HEAD `1bd0cb8`、45 条未提交、端口/进程/旧库计数） |

## 2 R1–R7 修复结果（执行方自验）

| 编号 | 验证内容 | 实测结果（原始证据） | 结论 |
|---|---|---|---|
| R1 | 唯一有效行读模型；固定样本列表/详情/合计一致；同仓多 SKU；缺行/失败仓/换绑/停用语义；详情视角 | 真实新采集后原始 Excel 对账：LS101295 **1028**（899+129）、LS101302 **247**、WM0011 **23**、WM0026 **13068**（菲律宾同仓两行 3122+4139=7261，龙仔厝由 3124 变为 3123 属真实源变化，钉住值差异单独记录）、WM0049 同仓两行 0+39088；列表=详情=原始文件；仓库筛选列表/详情同为 899；市场 PH 列表/详情同为 129；显式全仓 8 仓 | 通过（执行方） |
| R1 | 换绑未发新批次不串货；完整新批次缺行=本次未见、失败仓保留旧值；坏仓/好仓隔离；停用/重核立即退出 | 真实 PG 测试 `tests/inventory/**` **27/27**（含上述场景）；对应生命周期脚本逐项实测 | 通过（执行方） |
| R2 | 430 条旧决定只作候选；确认需账号/仓/商品/单位/理由/版本；无建议可确认；搜索/分页；重核/停用/换绑/单位冲突 | 修复实例 `confirmed=27` 且全部 `evidence.source=manual_confirm`+actor 非空、account-level=0；候选仍 403 pending；生命周期脚本：无建议行可确认 v1→换绑 v2（A disabled/B confirmed、旧值不迁移）→重核（立即退出）→单位冲突被拒（`INVENTORY_MAPPING_UNIT_CONFLICT`）；队列搜索/分页/第 20 条以后可达 | 通过（执行方；验证用映射已标注并重核/停用，不进入业务库存） |
| R3 | 严格表头/组合识别/坏行与整文件阻断/DB 核对登记原行/账号身份/文件校验/观测时间/仓库发现 | Python 122 项+7 离线反例：坏数量/重复 SKU/缺仓/组合/表头/账号缺失不再 success 且 publish=0；真实 PG 27/27：worker 只传子集被 DB 拒（INCOMPLETE）、坏仓保留旧值+好仓独立成功、身份 missing/mismatch/文件 blocked 不发布、缺仓/组合整文件阻断；真实采集 fileValidation=ok、identity=verified | 通过（执行方） |
| R4 | sha 采集身份分离；恢复原 exportFinishedAt；旧观测不推进成功/全绿；真实中断重启 | 真实 PG 27/27（两 run 同 sha 成功/同 run 异 sha 拒绝/恢复原时间/旧观测不推进）；真实 SIGKILL 中途停止→租约过期→重启接管：attempt 1→2、7 仓各一次、已发布仓原 batchId 不变、原文件与原 `exportFinishedAt`、旧 token `INVENTORY_LEASE_LOST`、run success | 通过（执行方；进程级断电/并发压测未做） |
| R5 | 设置/立即同步/确认/停用统一 pending；新写被服务端拒；三态核对；核对只读；同请求号只一次效果；刷新恢复 | 两条真实恢复链（设置 + 停用）：begin→动作提交（模拟响应丢失）→新写 `INVENTORY_PENDING_RECOVERY_REQUIRED`→错误 intent 核对失败但保留 pending→原 intent 核对找到回执→complete 解锁→原请求重放返回原回执、无第二次效果；pending 列表原样返回完整参数 | 通过（执行方；浏览器注入恢复链未做） |
| R6 | 归属校验；冻结 worker 源码；启动顺序；SQL/DB 同步 | 归属负向 7 项（外部 pid/无创建时间/伪造 marker：status owned=false+exit1、start 拒绝、stop 拒绝且不误杀）；冻结源码运行、`status` 显示 frozen=current；prepare 每次幂等重放 functions 并写 schema_state；017 升级与 fresh 结构/函数系统目录一致（db-schema 独立实例比对 allEqual=true） | 通过（执行方） |
| R7 | 空范围持久停止发布+重选恢复；市场来自服务端有证据关系、与分页无关、未知不猜 | 真实浏览器：清空全部参与仓二次确认→“已停止发布”→刷新/再刷新保持→立即同步禁用并给“参与仓库为空”→重选 7 仓恢复（套件后 scope=7、enabled=false）；RPC 侧空范围持久/不建 run/明确拒绝；市场 5 个（ID/MY/PH/TH/VN）+龙仔厝待确认，列表/详情同范围、翻页不丢 | 通过（执行方） |

## 3 原任务验收表逐项结果（v2 口径）

| 检查 | 最低通过结果 | 本轮实测/结论 |
|---|---|---|
| 自动读取 | 至少一次已确认账号自动全仓单 SKU 导出、新文件、逐仓校验保存；覆盖可解释、页面可追文件行 | 修复实例多次真实新导出（新 exportMark/新 sha256，728 行/28 列/每行带仓），7/7 仓发布、fileValidation ok、identity verified；任务详情含文件指纹/行数/表头/逐仓结果/观测时间 | 通过（执行方） |
| 真实定时 | 保存频率后不打开页面后台到期执行；设置/下次时间/结果重启后仍在 | 设置/计划/结果均在 DB；本轮以手动 run + 真实后台执行为主；定时链路沿用原 v1 真实定时 run 证据（`153d4b0a…`），本轮未新增定时触发（不伪造） | 部分继承（定时真实触发为 v1 证据；本轮未重跑） |
| 手动和重叠 | 立即同步有效且不改自动时间；连点/多页面/自动同时触发只一个活动任务；暂停自动仍可手动 | 浏览器用例 2 连点仅 1 个活动任务；手动不改 `next_run_at`（RPC/设置证据）；关闭自动后手动 run 成功（本轮 live-sync 在 enabled=false 下由手动触发） | 通过（执行方） |
| 重启恢复 | 中途停止后台再恢复不丢结果、不密集补跑；过期执行者无法发布；不需重建库 | 真实 SIGKILL→重启接管见 R4；恢复不重建数据库；旧 token 被拒；错过的自动点合并语义由 DB 测试覆盖 | 通过（执行方） |
| 文件正确性 | 表头重排按含义读取；损坏/关键字段错/同仓重复/错仓缺仓不静默采用；零/缺值/空仓分开 | 严格表头、金额列隔离、组合识别、坏行/整文件阻断、DB 原行核对、0/空/非法分离；Python+PG 反例 | 通过（执行方） |
| 更新与历史 | 100→80=80；旧批次可查；同任务重放不新增；两次新导出同内容仍登记；旧文件不假刷新 | PG 27/27 覆盖余额/重放/异内容/同 sha 新 run/旧观测；真实多次新采集均登记新文件与新批次；历史不可改 | 通过（执行方） |
| 部分与未知 | 一仓失败保留旧值且不刷新全范围成功；响应丢失按原请求找回唯一回执 | PG 坏仓/好仓隔离+partial 不全绿；R5 两条真实恢复链 | 通过（执行方） |
| 商品对应 | 未对应不进合计；明确确认后新批次采用；重核/停用立即退出；换绑不改历史、不复制 UUID | R2 生命周期实测；未确认仍 403 候选；验证映射标注并退出；商品 UUID 保持不变 | 通过（执行方） |
| 页面与权限 | 同步→库存→详情→历史完整可用；列表详情一致；匿名/停用/无权被拒；不泄漏价格/会话 | 浏览器 9/9（真实生产构建/真实数据）：同步页/任务详情/立即同步去重/设置/对应复核/列表详情同筛选/全仓/未接入/旧地址/匿名/空范围/无 500与 hydration；app/sync 角色执行面互斥与金额私有表沿用+PG 负向（owner 策略不改变 app 直读语义） | 通过（执行方） |
| 可维护 | 按说明启动/停止/登录恢复/定位失败；恢复一次数据库与文件；原实例未改写 | `start-instance`（DB→网页→后台→状态）、归属负向、登录恢复真实探测、备份恢复 21 张（去重）库存表 + 导出文件 sha256、原实例前后快照（已披露来源未确认的测试写入） | 原执行方记录；保护及维护缺口见本轮 F5 |

## 4 自验命令与结果（执行方）

| 检查 | 命令 | 结果 |
|---|---|---|
| Python 单测 | `python -m pytest tests/inventory_py -q` | **122 passed** |
| 页面纯逻辑/真实形状 | `node node_modules/vitest/vitest.mjs run --config vitest.config.inventory.mts tests/inventory/web-model.test.ts tests/inventory/web-real-shape.test.ts` | **62 passed** |
| 真实 PG 事务/恢复 | `INVENTORY_INSTANCE_DIR=<独立测试实例> node node_modules/vitest/vitest.mjs run --config tests/inventory/vitest.postgres.config.mts` | **27 passed / 2 files（0 skipped/flaky）**（fresh 与 017 升级实例均 27/27，由 db-schema 自验；本轮在 `run-20261026T021500Z-c9f3a1d2` 复跑通过） |
| 浏览器闭环 | `INVENTORY_BASE_URL=http://127.0.0.1:3032 INVENTORY_BROWSER_EVIDENCE_DIR=<证据目录> node node_modules/@playwright/test/cli.js test --config playwright.config.inventory.ts` | **9 passed / 0 failed / 0 skipped / 0 flaky**（BUILD `v5Pys92JVgCKXGVV9aH2D`，真实数据；最终证据 `browser-final4/report.json`，46–63s；测试 1/5 冷加载立即点详情 repeat 6/6，测试 8 repeat 2/2） |
| 真实采集 | `node scripts/inventory/run-manual-sync.mjs --run-id <run>`（或 run-check `--with-sync`） | 多次 success，7/7 仓、728 行、fileValidation ok、identity verified |
| R1 固定样本 | `python scripts/inventory/verify-raw-vs-detail.py` → `node scripts/inventory/verify-fixed-samples.mjs` | allOk=true（原始 Excel vs 列表/详情；钉住值差异单独 INFO） |
| R2 生命周期 | `node scripts/inventory/verify-mapping-lifecycle.mjs` | allOk=true（无建议确认/换绑/重核/单位冲突） |
| R5 恢复链 | `node scripts/inventory/verify-r5-recovery-chain.mjs` | allOk=true（设置+停用两入口；核对只读；同请求号一次效果） |
| R4.3 中断重启 | `node scripts/inventory/recovery-drill.mjs --hold-ms 90000` | allOk=true（真实 SIGKILL→接管 success；原观测时间/原文件/无重复/旧 token 被拒） |
| R6 归属负向 | `node scripts/inventory/check-process-ownership.mjs` | 7/7 拒绝/清理正确 |
| 读性能 | app 角色 `read_inventory_list` 10/50、`read_inventory_item` | 修复前 list10 ~7.2s → **list10 ~0.43s（CLI 含启动）/ p50 130ms、list50 558ms、detail 20ms**（db-schema 临时实例实测；修复实例 CLI 0.43s） |
| 备份恢复 | `node scripts/inventory/backup-restore-verify.mjs --run-id <run>` | 21 张（去重）库存表行数+摘要一致；最新导出文件 sha256 一致；临时库删除；演练前暂停本实例 worker 避免心跳写入、结束后自动恢复（`workerPaused/workerRestarted` 记录在回执） |
| 集中入口 | `node scripts/inventory/run-check.mjs --run-id <run> --pg-instance-dir <另一实例> --with-sync` | **11/11 阶段通过，allOk=true**（python / ts / ownership / rpc-smoke / session / browser / pg-suite / backup / live-sync / raw-fixed-samples / fixed-samples）；receipt `verify/2026-10-26T03-29-00-616Z/` |
| 类型检查 | `node node_modules/typescript/bin/tsc --noEmit --incremental false` | 本包文件 **0**；全仓仅既有 BEST 5 条（历史范围保留） |
| 静态检查 | `node node_modules/eslint/bin/eslint.js --max-warnings 0 <本包范围>` | **exit 0（0 error / 0 warning）** |
| 差异检查 | `git diff --check` | **exit 0**（既有文件 CRLF 提示，无空白错误） |
| 生产构建 | `build-preview-workspace.mjs` → `promote-preview-build.mjs` | 隔离 `next build` 成功；最终 BUILD **`v5Pys92JVgCKXGVV9aH2D`**；promote 后无 source drift |

## 5 交付时实例状态（2026-10-26 最终采集）

| 项 | 值 |
|---|---|
| 网页 | `npm start` 生产构建 **`v5Pys92JVgCKXGVV9aH2D`** @ 3032 |
| 后台 | `inv-worker-59532`（冻结源码 `9003dd67…`）online，进程归属校验通过 |
| 账号 | `laiguoyong@KNZX019402`，`active`，真实会话探测有效 |
| 设置 | 自动同步关闭、频率 60 分钟、`enabled=false`（手动同步可用）；空范围测试后已恢复 7 仓（scope version 17） |
| 真实任务 | 17 条 run（15 success，含 1 次真实 SIGKILL 恢复 run attempt 2；1 条早期瞬时 LOGIN_REQUIRED `needs_login` 保留；1 条 failed 保留）；最近成功 run 7/7 仓、728 行；共 16 个真实导出文件、105 个仓批次 / 9750 批次行 |
| 对应 | confirmed **27**（全部 `manual_confirm`+actor，固定样本/验证用）；候选 pending 403；验证用映射已标注并 disabled/recheck，不计入业务库存；scope 7 仓（version 33+） |
| 库存 | 当前有效行 27（仅已确认固定样本），未确认 SKU 不合计；固定样本数值见 §2 R1 |
| 导出文件 | `<run>/inventory-work/exports/*.xlsx`，每次新 sha256，受限目录 |
| 证据 | `<run>/verify/<时间戳>/`（run-check receipt）、`fixed-sample-verification.json`、`mapping-lifecycle.json`、`r5-recovery-chain.json`、`recovery-drill.json`、`raw-fixed-samples.json` |

## 6 关键证据（本地，不入库）

- `.local/catalog/run-20261026T013000Z-b4d7f2e1/`：实例/数据库、原始导出文件、worker JSONL 日志、各 verify receipt、备份 dump。
- `.local/inventory-sync-repair-20261026/`：`contract.md`、`db-verification.md`（含 017 升级一致性、RLS 性能/负向）、`worker-notes.md`（含联调两处真实缺陷补修）、`web-notes.md`、`api-keys.md`、`upgrade-017-schema-compare.json`、`browser-final/`（9/9 report+截图）、`worker-probes/`（7 反例新结果）、`protection-snapshot.json`、`run-check-final*.log`。
- 旧目录全部保留，但原实例有测试写入、旧独审探针脚本被执行方修改；旧结果 JSON 与原导出保留：`.local/inventory-sync-independent-20261025/`（独审）、`.local/inventory-sync-20261025/`（原交付）、`.local/catalog/run-20261025T175500Z-f7a8b9c0/`（原实例）。
- 原始 xlsx 含金额列，仅存受限目录，不入库、不放 public；公共行/页面/日志不含金额。

## 7 未覆盖 / 待确认（不写成通过）

1. **R5 浏览器端到端“注入响应丢失→核对失败→恢复”未做**：RPC/动作层两条恢复链已实测；浏览器仅覆盖 pending 相关页面元素/空范围。
2. **真实自然登录过期未等**：本轮在修复实例制造 `needs_login`，后台用真实有效会话 ≤60 秒探测→identity verified→自动恢复（另一条为真实瞬时导出误判→有界复核/恢复）；真实平台踢线与人工登录后恢复仍需用户参与。
3. **进程级断电未做**：只做一次受控 SIGKILL 中途停止→租约过期→重启接管；多进程并发压测、多机高可用未做。
4. **包装单位**：来源表无单位列；固定样本由执行方脚本以管理员身份选择“件”作验证，业务包装单位仍待用户确认；本版不做单位换算，单位未知不合计。
5. **市场**：仅按仓库名称中明确市场词带出（越南/VN、DEE泰国/TH、印尼/ID、PH/菲律宾/PH、喜运达MY/MY）；`DEE-龙仔厝（ICE专属）` 保持“待确认”，不猜。
6. **定时真实触发**：本轮未新增真实定时触发证据，沿用 v1 真实定时 run；计划/恢复语义由 DB 测试覆盖。
7. 旧 15×20 性能矩阵、旧 UI 延期项、完整权限矩阵、真实 200% 缩放不重开；国内/飞书物流/喜运达未接入；不做新估值/预测/日统计。
8. 本地预览不是生产部署：不设开机自启、不做多机高可用；未提交/推送/合并/部署。

10. **保护边界事件（如实披露）**：2026-10-26 09:37/09:39 两轮，原 3031/PG50499 交付实例被一批**旧 v1 worker 函数**的测试数据写入（`lease_owner/published_by=db-schema-worker-ae85ba60 / db-schema-worker-49da9e6d`，`inventory_worker.version='db-schema-test'`、pid 4242、warehouse `TEST-<suffix>-A/B`、export `<suffix>-*.xlsx`；旧库仍是 v1 schema、错误码为 `PUBLISH_OBSERVATION_CONFLICT/LOGIN_REQUIRED/PUBLISH_RESPONSE_LOST`）。执行方 db-schema 以只读核查否认其本人脚本/套件（其套件 worker 标识为 `worker-<hex>/repair-v2-test`、fixture `FIX-*`，均不在旧库；helper 不会回退实例目录，且其 helper/套件在写入时间之后才创建）；仓库内未能定位该自称标识，**未确认具体来源**。
9. 独立性说明：以上通过均为**执行方自验**，不是主审独立结论；最终通过范围由独立审查裁定。

## 8 2026-10-26 BigSeller 正式本地接入（执行方历史交付记录）

状态：`BS_LIVE_INTAKE_V1_IMPLEMENTED_AWAITING_INDEPENDENT_REVIEW`。详细交付/证据见 `.local/bs-live-intake-20261026/`。

| 项 | 结果 |
|---|---|
| 唯一日常地址 | http://127.0.0.1:3011（已切换）；正式实例 `run-20261026T211500Z-11a22b33`，PG 59345，BUILD **`uktXWUlhRzx0tPGmGp7xK`**，worker `inv-worker-59345`，schema v6 |
| 主资料 | 来自切换前 3011 只读备份并核对一致（126/128/126、530 行），保留商品 UUID；不是 3036 测试副本 |
| 真实导出 | 2 次：手动 `28447db3…`（21:11:31.916，728 行）、真实自动计划 `c3ffacaa…`（21:18:34.290，728 行）；账号 `laiguoyong@KNZX019402` verified |
| 正式对应 | 430 条 confirmed（69编码 377、56519 货号 30、条码例外 14、仅 56519 的 ICE+货号精确别名 9；0 verification / 0 unitUnconfirmed，全部走正常确认链） |
| 当前采用 | 430 行；第二 run 7 仓全部发布，adopted 430 / unmapped 220 |
| 待核 | 46 同码冲突 + 174 未匹配；队列 298 个 SKU×仓对；不阻塞其它商品 |
| 双编码 | WM0026 56519：`757577983013=3119`、`ICEWM0026=4138` 两行同时显示并“合计待核对”（未相加；旧 7261 不作为当前期望） |
| 三页同源 | 商品库列表/详情/切仓/刷新与商品库存页共用 effective-row 读模型；WM0043 2360、LS101295 1014、WM0049 82657+待核对 均一致 |
| 旧样表/货值 | 旧 BS 样表只作历史证据、失败不回退；当前货值统一“暂未计算”，旧价格不乘新库存 |
| 自动同步 | 开启、60 分钟、next 22:22；刷新前后 runs/batches/batch_rows/current = 2/14/1300/430，无新增导出 |
| 自验 | 页面链 20/20、三页对账 3/3、catalog 纯逻辑 132/132、inventory 纯逻辑 109/109、tsc 本包 0 新错、eslint 0/0、构建无 drift |
| 未做/待确认 | 当前货值新估值、46+174 待核行人工决定、PH 别名规则独立确认、真实断网/自然过期/多机/断电/旧性能/200%/完整权限矩阵；A1/B/C 等沿用未重跑 |


## 9 2026-10-27 正式接入独立复审

**2026-10-27 独立复审：`BS_LIVE_INTAKE_V1_NEEDS_FIX`。** [独立报告](../../.local/bs-live-intake-independent-20261027/independent-review.md)、[两组最小补修](../../.local/bs-live-intake-independent-20261027/remaining-repair.md)。正式下载/保存/430条对应/定时后台/3011切换已实际运行；剩R1商品库状态、覆盖与切仓接线，R2真实SKU `clean brush`被截成`clean`。库存数量对账无采用行差异，单位已确认，9条PH别名已有逐条人工出处，不重新要求业务确认。

独立08:58快照：自动同步开启60分钟，13次成功（交付后自然新增11次），最新08:22:19，下一09:22:02；91批/8450行/当前430行。3011 / PG59345 / BUILD `uktXWUlhRzx0tPGmGp7xK`，600个构建文件、9个worker文件无差异。两原Excel/1300批次行/430当前行/116商品小计核对数量无差异；来源编码截断另列R2。旧资料/实例/原表/失败证据保留。主审只读核验与页面走查，未改业务代码/数据、启停、额外导出或清场；A1/B/C等证据沿用。详细范围与限制以独立报告为准。

| 本次范围 | 独立结论 |
|---|---|
| 正式对应/采用数量/运行与切换 | 已核实，保持运行；别名9条有逐条人工依据 |
| 商品库状态/覆盖/切仓 | R1待修：单仓假不一致、0/0、全仓警告残留、同仓待核行缺展示 |
| 来源SKU原样保存 | R2待修：clean brush被截成clean，三仓数量0/10087/12633未变、未计商品合计 |
| 全包 | NEEDS_FIX；只修上述两组，保留全部新旧数据证据，不重复无关测试 |

## 9 2026-10-27 R1/R2 集中补修（待独立复审）

状态：`BS_LIVE_INTAKE_V1_REPAIR_IMPLEMENTED_AWAITING_INDEPENDENT_REVIEW`。依据[独审 NEEDS_FIX 报告](../../.local/bs-live-intake-independent-20261027/independent-review.md)与[两组最小补修](../../.local/bs-live-intake-independent-20261027/remaining-repair.md)；交付/证据/恢复见 `.local/bs-live-intake-repair-r1r2-20261027/`。

| 项 | 结果 |
|---|---|
| 唯一日常地址 | http://127.0.0.1:3011（保持） |
| 运行版本 | 实例 `run-20261026T211500Z-11a22b33` / PG59345；BUILD **`IbVHV6BZXFtK3ft2cEb4k`**（无 drift）；worker `inv-worker-59345` 冻结源 **`1db4017a…`**（parser.py `28348dd6…`；旧 `9003dd67…` 备份） |
| R1 状态/覆盖/切仓 | 普通单码仓 `current`（越南 WM0026 1853 无假“列表与详情不一致”）；覆盖读顶层字段（单仓 1/1、全仓 6/7，缺失不是 0/0）；切仓走已有单仓读取，数量/覆盖/待合计组/待核来源/时间/警告随范围切换；MY 672（不完整）+ `ICEWM0026=0` 原表 564 待核可见、未计入；PH 3119/4138 双行“合计待核对” |
| R2 完整 SKU | `SKU编号` 保留完整字符串（`clean brush` 不再截断；内部空格/标点/前导零保留）；旧 `SKU信息` 分词兼容；新批次 56673 行15=0、56519 行413=10087 原码 unmapped 未计合计；弃用仓 48787 行512=12633 仅源行未发布；旧 `clean` 28 行保留 |
| 正式库存 | 430 confirmed 对应、最新批次 adopted 430 / effective 430 / unmapped 220；有效行与同批原表数量/原表行差异 0 |
| 自动同步 | 开启、60 分钟、configVersion 3；最近成功为 10:22 真实自动计划 `22fcb140…`（2026-10-27 10:22:24，文件 sha `cf65a50f…`）；手动 `fb31d863…`（09:46:59，`bac228fb…`）仅作更新后立即核对 |
| 自验 | 真实页面 38/38、catalog 133/133、inventory 纯逻辑 109/109、parser pytest 30/30、tsc 本包 0 新错、eslint 0/0、diff check 0、构建无 drift |
| 未做/待确认 | 不猜绑 `clean brush`、46+174 待核、PH 双码合计口径、切仓现每次单仓读取（旧性能矩阵未重跑）、失败/断网/多机/自然过期/200%/完整权限矩阵、`inventory_current` 旧投影观察项；A1/B/C 等沿用未重跑 |


## 11 2026-10-27 R1/R2 独立复审结论

| 范围 | 结论 |
|---|---|
| R2与正式同步运行、同批对账、保留 | 通过；真实728源行/650批次行/430有效行/116商品小计无差异 |
| R1单码状态/覆盖/切仓/待核0行 | 主要接线通过，真实3011已核 |
| R1正常单仓空态文案 | 未通过：已有采用行仍说暂无采用，仅补这一条件 |
| 旧inventory_current投影 | 保留观察，不影响现役有效批次读取，不另立包 |

本次不把执行方38/38改写成独立全通过；其原始结果中的矛盾文字原样保留。正式证据与最小收尾见本页顶部链接。

## 10 2026-10-27 R1 说明条件收尾（待独立复审）

状态：`BS_LIVE_INTAKE_V1_R1_TEXT_IMPLEMENTED_AWAITING_INDEPENDENT_REVIEW`。依据[独审最小收尾](../../.local/bs-live-intake-repair-independent-20261027/remaining-repair.md)；交付/证据/恢复见 `.local/bs-live-intake-r1-text-20261027/`。

| 项 | 结果 |
|---|---|
| 修改 | 仅 `src/features/catalog/components/catalog-detail.tsx` 的 `scopeReason`（+2 行）：正常 `current` 且有采用行时返回 `null`；before/after sha256 `f26bef44…` / `a41e5327…`，diff 见 `change.diff` |
| 保留说明 | failed 分支在前（保留错误码+上次成功时间）、unseen、unmapped_source、no_source、MY 待核 0 行、PH 双码待合计、真正的列表/详情不一致提示均保留 |
| 现场 | 3011 / `run-20261026T211500Z-11a22b33` / PG59345；最终 BUILD **`MB1i1eT7pYCsG8qdb1iea`**（快照 `a3f0f683…`，无 drift）；worker 未重启（pid 42072 / `1db4017a…`）；自动同步开启、60 分钟 |
| 真实页面 | **42/42**：WM0026 越南 1853（无错误空态、覆盖 1/1）、全仓 6/7→越南 1/1、MY 672（不完整）+`ICEWM0026=0` 行564 待核、PH 3119/4138 双行“合计待核对”；4 条新增“有采用行不得出现暂无采用”断言 |
| 表达式探针 | `scopeReason` 生产表达式只读执行：正常 current 三仓 → `null`；受控 failed → 失败+旧时间；unmapped_source/no_source/unseen → 各自说明 |
| 静态/构建 | 受影响文件 tsc 本包 0 新错、eslint 0/0、`git diff --check` 0、staging→promote→start 无 drift |
| 沿用未重跑 | R2 完整 SKU（独审通过）、R1 原四项接线/430 对应/库存/原 Excel 对账（独审确认）、A1/B/C、备份恢复、并发/性能/权限/200%、整套 PG/浏览器 |
| 未做/待确认 | 未改数据库/商品/UUID/430 对应/库存/历史/原 Excel/worker/同步计划/其它实例；业务待决（clean brush、46+174、PH 合计口径）与 `inventory_current` 观察项原样；失败说明为受控探针，不是真实故障 |
