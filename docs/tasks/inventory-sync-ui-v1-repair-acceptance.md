# 商品库存双视图与数据同步界面 v1 — 集中补修验收说明（R1–R6）

当前裁定：**INVENTORY_SYNC_UI_V1_LOCAL_PASS**（2026-10-28主审独立复审通过）。[独立报告](../../.local/inventory-sync-ui-tail-independent-20261028/independent-review.md)、[尾项验收说明](inventory-sync-ui-v1-tail-repair-acceptance.md)为现役结论；T1–T3已关闭，无剩余功能修复。本文件下方原合同或分轮记录保留原历史身份。

2026-10-27 主审独立复审：**INVENTORY_SYNC_UI_V1_REPAIR_NEEDS_FIX**。布局、单一详情抽屉、固定分页/跳页、唯一对应维护与真实返回、同步来源总览可保留；仍须收尾S1来源/未知市场/计数一致、S2批次采用身份与当前映射版本、S3待合计及旧值警告、S4同步任务详情可见/草稿语义及残余重复文字。仅修剩余四组，不重做整套页面。

执行方47/47等为自验材料，未冒称独立全量重跑。国内887、原A1/B/C/速度包证据复用；不重开旧性能/权限/采集套件。保留所有现场，未提交/推送/合并/部署/清场/写长期记忆。执行交接含完整文字，不假定agent能看截图。下一交审点：`INVENTORY_SYNC_UI_V1_FINAL_REPAIR_IMPLEMENTED_AWAITING_INDEPENDENT_REVIEW`。

以下为执行方R1–R6历史自验记录，原停止点 INVENTORY_SYNC_UI_V1_REPAIR_IMPLEMENTED_AWAITING_INDEPENDENT_REVIEW；“来源贯穿详情/当前范围计数”等完成声明已由上方独审纠正，不代表PASS。
依据：[集中补修（含人工验收）](../../.local/inventory-sync-ui-independent-20261027/remaining-repair.md)、[独立审查](../../.local/inventory-sync-ui-independent-20261027/independent-review.md)、[人工验收文字说明](../../.local/inventory-sync-ui-independent-20261027/user-visual-acceptance.md)；原合同 [inventory-sync-ui-v1.md](inventory-sync-ui-v1.md) 继续有效。
交付证据：[交付摘要](../../.local/inventory-sync-ui-repair-20261027/delivery-summary.md)、[证据索引](../../.local/inventory-sync-ui-repair-20261027/evidence-index.md)、[恢复说明](../../.local/inventory-sync-ui-repair-20261027/RESTORE-NOTE.md)、[保护说明](../../.local/inventory-sync-ui-repair-20261027/PROTECTION.md)；上一轮自验 [inventory-sync-ui-v1-acceptance.md](inventory-sync-ui-v1-acceptance.md) 保留历史。

## 现场

- 唯一日常入口 **http://127.0.0.1:3011**；实例 `run-20261026T211500Z-11a22b33` / PG 59345 / 库 `iceos_catalog_run_20261026T211500Z_11a22b33`。
- 最终 BUILD **`6h01rzCy_6foml5S6u1HH`**：源快照 `8077fb3ad5da34c5…`，`validateReadyRecord` ok、`repoSourceDrift=false`、417 编译产物一致、login 200；web pid 60280。
- schema v6 / `source_sha256=c08eace8…` / `functions_sha256=0c551192…`；022 文件 sha `9f3c5a60…`，函数体 warehouse_rows `30fdbe94…`、product_summary `42534b53…`、warehouse_states `91ce6dc8…`（未变）。
- worker `inv-worker-59345` pid 42072 未重启；自动同步开启/60 分钟/7 仓/configVersion 3；18:22 自然计划成功、下次 19:22。
- 业务数据未写：126 商品/126 货号/430 正式对应/98 待核候选；17:22、18:22 自然批次正常增长。

## 执行方已实现声明（历史自验，须按独审纠正）

- **R1 来源与下钻一致**：来源范围统一约束查询、行集合、计数与列。仅国内 = 118 个有国内有效选择的商品（仓库明细仅国内行）；仅海外 = 116；全部 = 120（含 4 个纯国内商品）。删除独立市场下拉；未知市场格用 `__unknown__` 只定位 market 为空仓（DEE-龙仔厝）；有仓/市场下钻时国内行/列不混入；搜索后计数为当前范围。
- **R2 来源事实与对应状态分开**：`read_inventory_warehouse_rows` 以每仓最后完整成功批次全部批次行为底 + 最新版本对应；`adopted` 计入、`pending_adoption` 保留原数量/时间并标“已确认，待下一完整批次采用（不计入）”、`inactive` 保留当时归属但退出合计、`unmapped` 保持未对应。正式库 650=430+220+0+0 逐行逐值 0 差异；隔离库 WM0094 由 0 行变为可查 pending_adoption（133739/132949，knownSubtotal 仍 null）。
- **R3 不合计未确认数量**：商品汇总市场格移除 `warehouseAvailable`“整仓可用”字段（427 格 0 差异其余字段）；页面不再显示 7251 类确定合计；SKU 计数文案为“来源编码”。
- **R4 唯一维护入口与真实往返**：库存详情移除直接编辑，正式对应只在 `/dashboard/catalog/mappings`；维护页显示目标商品/仓/SKU 并通过来源 SKU 定位目标行；`back` 白名单整段保留原 query；实测 WM0026 未对应行→维护页→返回恢复 `?q=WM0026`；国内无 BS 绑定动作；返回边界 16/16。
- **R5 库存操作面**：首屏 = 标题 + 页签 + 一行工具栏 + 状态行 + 主表 + 固定底栏分页；删除说明墙/图例/未来来源卡；表头与商品列 sticky、行只留一个“详情”（名称可点）、长名称限宽换行；详情为右侧抽屉，点击 20–46ms 可见，仓库行看该仓该 SKU、商品汇总行看当前筛选范围各仓，Esc/关闭/后退回原位，URL 可刷新还原；1280×720 首屏可见表头、完整业务行与分页，可直接跳第 20 页。
- **R6 同步来源总览**：一来源一行（BigSeller 海外库存 / 聚水潭国内表格快照），行内状态、最后成功数据、下次计划、待处理数、立即同步/详情/设置；详情（逐仓结果/任务历史/错误/原请求核对）与设置（频率/参与仓/保存/诊断）默认折叠、同页展开；国内无假同步、未来来源仅一行“未接入”；保留登记→原动作→结果未知核对、写锁与设置保存语义。

## 验证（真实点击，非手工拼 URL）

- 真实页面点击闭环 **47/47**：`verify/live-repair-checks.json`。含默认首屏几何、固定表头/商品列、分页首屏可见、跳第 20 页与上一页、行详情即时出现、Esc/关闭回原列表、名称打开同一详情、仅国内 118、全部 116/120、未知市场下钻（仅未知仓、无国内行）、已知市场下钻、搜索回车与范围计数、汇总行详情（loading→各仓表）、维护页目标上下文与真实返回、同步来源行→详情→设置、1440×900 首屏、无前端异常。
- 导航单次样本：库存默认 613–711ms、同步 505–529ms、1440 库存 501–527ms；交互：行详情出现 20–46ms、汇总详情 21–27ms，内容约 0.5s 内补齐。**不是 p95，不冒充性能验收**。
- 读模型对账：650=430+220+0+0、247 真实 0、7 仓、116 商品/427 市场格且 0 含 warehouseAvailable、`__unknown__` 143 行全空市场、国内冻结文件 sha `bcee12bc…`。
- 静态：全仓 tsc 仅既有 BEST 5；改动文件 eslint 0/0；`git diff --check` 0；`tests/inventory` 纯逻辑 162 通过（postgres 套件需实例环境未跑）。
- 截图 12 张与逐图文字说明见[交付摘要第 5 节](../../.local/inventory-sync-ui-repair-20261027/delivery-summary.md)。

## 未覆盖 / 剩余限制

- `inactive` 分支只有 SQL/类型/展示，正式库无真实样本；未造数据。
- `pending_adoption` 真实样本在隔离副本库，3042 预览仍为旧构建，未在浏览器演示该状态；证据为 SQL + 纯逻辑测试。
- “确认后下一完整批次采用”沿用 v4-final A1 独立证据；本轮未重抓导出。
- 商品汇总多市场列时 1280 宽需横向滚动（商品列固定）；同步设置面板 720 高需页面滚动；详情缺口说明为直接文本。
- 未做 200% 缩放/断网/自然过期/多机断电/完整权限矩阵；旧浏览器套件中 sync 映射 testid 未按新位置重写；弃用仓“（弃用）”仍来自既有数据源。
- 全仓既有 BEST 5、opt6 00051、14 条既有 lint warning 原样；本轮未重跑无关套件。

## 原执行交审停止点（历史）

**`INVENTORY_SYNC_UI_V1_REPAIR_IMPLEMENTED_AWAITING_INDEPENDENT_REVIEW`**。不自行宣布 PASS，不追加新功能，不提交/推送/合并/公网部署/清场/写长期记忆；全部数据、原表、旧构建、隔离库与证据保留。
