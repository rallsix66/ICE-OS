# Current Project State

更新：2026-10-29。当前任务 **CATALOG_BINDING_REVIEW_V1_LOCAL_PASS**（原线程独立复审通过）。

## 当前任务：详情内绑定编辑、界面减字与复核结果采用 v1（本机通过）

[原合同](tasks/catalog-binding-inline-edit-v1.md)；[最终独立报告](../.local/catalog-binding-r1-r4-independent-20261029/independent-review.md)。R1 保存按真实结果反馈、R2 replace 原请求恢复、R3 汇总按真实来源逐条编辑、R4 旧事实及采用状态均关闭。原三页签、主表减字、搜索/取消与510条人工复核目标沿用已核实结果，无剩余功能修复项。

本轮独立核验：R1/R2实际模块受控测试5例；正式/克隆库只读核查33项；3011真实页面确认无SKU行不可编辑、真实行当前身份、旧MY归属754与10-28 18:22:14、新WM0069第2版已计入。执行方隔离写路径与下一批fixture经审读原始脚本/断言/截图并回读克隆库后沿用，没有重复整套测试。8组业务列快照与补修前一致；映射快照不含evidence，不能称全字段核对。024文件实际含6个函数，已核全部现役定义一致。

现役3011 BUILD **`3DRd1EmVjPgeWE7tIkKI_`**，源码`debe1eeb13987b94…`；620源码条目/415产物独立逐文件一致，drift=false、login200。正式库仍`run-20261026T211500Z-11a22b33` / PG59345；映射517（512/5）、请求104、国内决定5、国内有效选择123、商品126/修订128，schema v6未变。核验时最新自然批次09:22，worker/60分钟计划/参与仓未修改。本轮独审未写业务库、未重导510条、未手动同步或重启服务。

通过仅限本机本包；121忽略页、200%、未来权限、新API、公网部署及旧延期项不在通过范围。全仓605/606（既有opt6 00051）、tsc既有BEST5为执行方自验边界，不声称全仓全绿。已对齐任务/规则；2026-10-29 文档与 Git 收尾：实现与文档已按依赖顺序提交并普通推送 `origin/codex/ice-v4-planning`（本地与远端一致；未合并/部署/清场/写长期记忆），`.local`、私有输入、数据库与构建产物未入库，全部复核现场保留。上一轮NEEDS_FIX及执行交付报告保留历史，最终裁定以上述报告为准。

两个绑定入口均在详情内：商品库详情→库存明细→仓库行（固定商品，搜索该仓来源）；商品库存→仓库明细/商品汇总详情→具体仓库/SKU 行（固定来源，搜索商品库）。2026-10-28 人工复核实际采用 510 条（BS 387 = 保持300/新建82/换绑5；JST 123 = 保持118/追加决定5），121 条忽略清单仅保存未建绑定；运行入口、证据位置与提交号见[合同 §11](tasks/catalog-binding-inline-edit-v1.md)。

## 最近已验收：商品库存双视图与数据同步界面 v1（文档与 Git 已收尾）

2026-10-28 补充规则与离线复核：用户批准[菲律宾彩妆货号附带色号](product-identity-standard-v1.md#ph-makeup-shade)。已登记并用于本地 HTML 重匹配，已存人工草稿保留；验证记录见[本地报告](../.local/three-table-view-20261028/verification-ph-color.md)。本轮未修改现役服务、正式绑定或库存，不改变下述已验收包结论；新增规则的正式系统应用尚未实施，规则文档已在 2026-10-29 收尾中提交并推送。

2026-10-28 主审独立复审通过：**`INVENTORY_SYNC_UI_V1_LOCAL_PASS`**。T1–T3 全部关闭，本包不再新增功能返工；已通过布局、分页、采用身份、PH 双码提示和草稿语义沿用。 [独立报告](../.local/inventory-sync-ui-tail-independent-20261028/independent-review.md)、[尾项验收说明](tasks/inventory-sync-ui-v1-tail-repair-acceptance.md)。

主审真实点击确认：未知市场/指定海外仓详情不混国内；仅国内 WM0026 仍为 5,100（文件 2026-10-15），全部无筛选仍分区。旧量 247 与旧 16:22 时间通过独立单个只读受控链（非正式库自然缺行）。同步任务点击/刷新/切换后标题均位于 720px 视口顶部约 13.2px，计划时间正确随所选任务变化，手动收起正常。

现役 3011 BUILD **`ElaITcTkEMZyYxyRD1CaS`**，源码/编译快照 `6f0faba622bd53ae…`、417 产物独立一致、无漂移；现役 read_inventory_item 与当前 016 一致（定义 `8e78ba3b…`，文件 `55922bc9…`）。原全表/映射/性能等可信证据沿用，未重复全套。

通过仅限批准的本机库存双视图与同步 UI，不是公网发布、全 ICEOS 验收、未来员工权限或新 API 接入完成。审查未改业务/SQL/worker/计划/正式对应/库存事实，未保存设置或手动同步。保留所有数据、原表、旧构建、隔离库、脏文件和历史证据。

文档与 Git 收尾（2026-10-28）：自上次提交 `1bd0cb8` 以来的已验收实现已按依赖顺序提交并普通推送到 `origin/codex/ice-v4-planning`（飞书来源归档、同步后端/读取层、双视图与同步 UI、任务文档、状态与交接文档；本地与远端一致，未 force/合并/部署/清场），`.local`、私有输入、数据库与构建产物未入库。完整提交号、推送核验与保留范围见[库存与自动同步实现/运行说明 §0.11](inventory/inventory-sync-v1.md) 和本地收尾记录 `.local/inventory-sync-ui-git-closeout-20261028/closeout-record.md`（不入库）。

下一位维护者的职责分工、日常入口、构建/启动/恢复材料位置与国内快照私有输入依赖，见[库存与自动同步实现/运行说明 §0.11](inventory/inventory-sync-v1.md)；结论仍以本节现役状态为准。

## 补修执行交付记录（历史自验，以下完成声明须以上方独审纠正为准）

主审独审裁定 `INVENTORY_SYNC_UI_V1_NEEDS_FIX`，并把独审缺陷与用户人工视觉验收合并为 R1–R6。[独立报告](../.local/inventory-sync-ui-independent-20261027/independent-review.md)、[集中补修](../.local/inventory-sync-ui-independent-20261027/remaining-repair.md)、[人工验收文字说明](../.local/inventory-sync-ui-independent-20261027/user-visual-acceptance.md)；原合同[inventory-sync-ui-v1.md](tasks/inventory-sync-ui-v1.md)继续有效，本轮验收说明 [inventory-sync-ui-v1-repair-acceptance.md](tasks/inventory-sync-ui-v1-repair-acceptance.md)，上一轮自验 [inventory-sync-ui-v1-acceptance.md](tasks/inventory-sync-ui-v1-acceptance.md) 保留历史。

**执行方已实施并自验（不是独立结论，不自行宣布 PASS）**：

- **R1** 来源范围统一约束查询/行集合/计数/列：仅国内 118、仅海外 116、全部 120；删除独立市场下拉；未知市场格用 `__unknown__` 只定位 market 为空仓；有仓/市场下钻时国内行/列不混入；搜索后计数为当前范围。
- **R2** `read_inventory_warehouse_rows` 以每仓最后完整成功批次全部批次行为来源事实底 + 最新版本对应：adopted 计入、pending_adoption 保留原数量/时间且不计入、inactive 保留当时归属但退出合计；正式库 650=430+220+0+0 逐值 0 差异；隔离库 WM0094 可查到 133739/132949 的 pending_adoption 且 knownSubtotal 仍 null。
- **R3** 商品汇总市场格移除未获批准的“整仓可用”字段（427 格 0 差异其余字段），不再显示 7251 类确定合计。
- **R4** 库存详情移除直接编辑，正式对应唯一入口为商品库 `/dashboard/catalog/mappings`；维护页显示商品/仓/SKU 目标并定位目标行，`back` 白名单整段保留原筛选，真实往返恢复 `?q=WM0026`；国内无 BS 绑定。
- **R5** 首屏=标题+页签+一行工具栏+状态+主表+固定底栏分页；删除说明墙/图例/未来来源卡；表头与商品列 sticky、行只留一个“详情”（名称可点）、长名称限宽；右侧详情抽屉点击 20–46ms 可见，仓库行看该仓该 SKU、汇总行看当前范围各仓，Esc/关闭/后退回原位，URL 可还原；1280×720 首屏见表头、完整业务行和分页，可直达第 20 页。
- **R6** 同步首页一来源一行（BigSeller/国内快照），状态/最后成功数据/下次计划/待处理/操作在行内，详情与设置默认折叠同页展开；国内无假同步、未来来源仅“未接入”。

**现场**：唯一日常入口 **http://127.0.0.1:3011**，最终 BUILD **`6h01rzCy_6foml5S6u1HH`**（源快照 `8077fb3ad5da34c5…`、drift=false、417 编译产物、login 200、web pid 60280）；022 文件 sha `9f3c5a60…`（函数体 warehouse_rows `30fdbe94…`、product_summary `42534b53…`、warehouse_states 未变），schema v6/`functions_sha256=0c551192…`；worker pid 42072、60 分钟计划、参与仓未改，18:22 自然批次成功（下次 19:22）；126 商品/430 正式对应/98 待核/库存事实/历史/原表未改。**验证**：真实点击 47/47、读模型对账全项通过、隔离库 R2 样本、tsc 仅既有 BEST 5、改动文件 eslint 0/0、diff 0、`tests/inventory` 纯逻辑 162 通过；截图 12 张及逐图文字说明在[交付摘要](../.local/inventory-sync-ui-repair-20261027/delivery-summary.md)。**未覆盖**：inactive 无真实样本、pending_adoption 未在浏览器演示（隔离库 3042 仍旧构建）、确认后下一批采用沿用 v4-final A1 证据、商品汇总 1280 需横向滚动、同步设置在 720 高需页面滚动、200%/断网/自然过期/多机/权限矩阵、旧 sync 映射 testid 套件未重写。**下一交审点：`INVENTORY_SYNC_UI_V1_REPAIR_IMPLEMENTED_AWAITING_INDEPENDENT_REVIEW`**；保留全部原表、旧构建、验证库、脏工作区和证据；未提交/推送/合并/公网部署/清场/写长期记忆。

### 上一状态（历史，已被上方补修取代）

**`INVENTORY_SYNC_UI_V1_NEEDS_FIX`（2026-10-27 主审独立复审）**：当时 BUILD `FmTvwhh6Lepdd7MSjJuwJ`（610 源码/415 产物一致，现已由修复轮构建替换）。独审已确认 17:22 自然批次 650 条海外来源、116 商品核心汇总、887 条国内来源及 118 个 UUID 关联逐值 0 差异，但来源筛选、对应状态保留、待核可用合计、唯一维护及返回、表格使用体验未通过。[执行方首轮交付记录（历史自验）]保留在本文件下方原章节。

### 执行方首轮交付记录（历史自验，不代表独审通过）

**执行方报告的已实现（须以上方独审纠正为准）**：商品库改为资料优先主表（名称/货号/69编码/规格单位/资料状态，价格次要、库存与货值改为提示+定位），页头唯一「来源 SKU 对应」入口并新增 `/dashboard/catalog/mappings`（复用既有确认/换绑/重核/停用机制与写锁）；库存页同一入口双视图——默认「仓库明细」（一行=账号×仓库×SKU，名称主/SKU辅，含未对应与真实0、行详情可查原始出处）与「商品汇总」（国内列+各市场格，点格互相定位，未知市场单独成列，双码待合计不合并）；国内数量用冻结聚水潭表格快照只读展示（887条/118条有效选择/文件日期10-15+10-16/未注明仓库单位，不冒充实时、不与海外相加）；数据同步首屏状态总览、立即同步主按钮、设置折叠且保存只在面板、逐仓结果区分“同步成功另有来源待对应”、任务详情按需展开、对应处理迁到商品库唯一入口。新增只读函数 `db/catalog/022_inventory_dual_view.sql`（仓库明细/商品汇总/逐仓状态）与 `023_inventory_domestic.sql`（国内关联），不建表、不改 schema 版本、不改 00001–021；`scripts/inventory/prepare-instance.mjs` 追加两者幂等重放。

**执行方自验**：数据对账 **28/28**（7 仓最后完整成功批次 650 行=430 adopted+220 unmapped+0 pending_adoption，逐仓与独立 SQL 一致；WM0026 越南 1857、PH 双码 3116/4136 各自独立；真实 0 行 247；商品汇总 116 商品与 `read_inventory_list` 逐项一致、102 个单一单位商品 Σ市场格=knownSubtotal；国内 887/118/877+10/111+7/118 全部关联、SHA 一致）；真实页面闭环 **37/37**（无页面脚本错误，11 项导航 346–720ms）；隔离副本库写动作闭环 **11/11**（定位→采用建议→单位/理由→确认→副本库 confirmed v1 + 审计 + 待核 98→97 + 回原筛选）；`tests/inventory` 9 文件 **156 项**通过；tsc 仅既有 BEST 5；改动文件 eslint 0；staging 构建→promote→start 成功。

**最终现场**：唯一日常入口 **http://127.0.0.1:3011**，BUILD **`FmTvwhh6Lepdd7MSjJuwJ`**（pid 45540，`preview-build-ready.json` 源快照 `7574beea…` 与工作区一致、漂移 false）；实例 `run-20261026T211500Z-11a22b33` / PG 59345 / schema v6 / `source_sha256=c08eace8…` / `functions_sha256=0c551192…`（022 `34149eb6…`、023 `ae1551d0…` 单独记录）；worker `inv-worker-59345`（pid 42072，冻结源 `1db4017a…`）未重启，自动同步开启/60分钟/7仓/configVersion 3/下次17:22，最近自然计划批次 16:22 成功（430 adopted/220 unmapped）；126 商品/126 货号/430 正式对应/98 待核候选/库存事实/历史/原 Excel 未改。**未覆盖**：确认后“下一完整批次采用”未在隔离库重抓导出演示（沿用 v4-final A1 独审证据）；失败/无权限/真实空/迟到响应未在正式库制造；200%/断网/自然过期/多机/完整权限矩阵未做；旧 sync 页映射 testid 迁至映射页后历史浏览器套件未重写；弃用仓仍会以“(弃用)”出现在待核队列（既有数据源行为）。未提交/推送/合并/公网部署/清场/写长期记忆；旧实例、旧构建、旧证据与两个速度验证库、本次隔离副本库保留。

## 最近已通过：商品库存响应速度优化v1

**`INVENTORY_RESPONSE_SPEED_V1_LOCAL_PASS`（2026-10-27 主审独立复审通过）**。[独立报告](../.local/inventory-response-speed-independent-20261027/independent-review.md)。该速度包已收尾，无需返工；网页构建已由界面任务替换为 `6h01rzCy_6foml5S6u1HH`（修复轮）。


主审正常app角色只读实测：50行列表227/186/171ms，WM0026详情106/102/104ms；独立重新比较三组原始新旧输出，各288用例、116商品详情、0差异。主审实际搜索、全仓/越南详情、列表行收起、第二页展开/收起和刷新正常，MY待核0行/PH双码分别展示仍保留。执行方同批页面中位约0.4–0.5秒的原始证据核算沿用，不冒充主审再次采样；冷加载点击为单次540ms，普通打开不是空缓存冷启动。SQL第2页优化前中位/最慢应为3440/3443ms，已校正文档。

3011 BUILD `p7im9R07D7iqkV_2mNKNJ`：600源码文件、407编译产物及55个部署函数体一致，schema函数哈希`0c551192…`。worker PID42072/冻结源/60分钟计划未变。15:05只读现场仍为14:22自然批次、430正式对应/430有效行。本轮只新增独审证据并同步文档，未改业务代码/数据/运行态，未重跑无关套件。两个一次性验证库及所有旧证据保留；未提交/推送/合并/公网部署/清场/写长期记忆。

### 本轮执行方交付记录（历史自验，已由上述独审裁定）

**`INVENTORY_RESPONSE_SPEED_V1_IMPLEMENTED_AWAITING_INDEPENDENT_REVIEW`**（2026-10-27 执行方自验交付，待独立审查，不自行宣布 PASS）。[任务包](tasks/inventory-response-speed-v1.md)、[验收说明](tasks/inventory-response-speed-v1-acceptance.md)、[交付摘要](../.local/inventory-response-speed-v1-20261027/delivery-summary.md)、[证据索引](../.local/inventory-response-speed-v1-20261027/evidence-index.md)、[恢复说明](../.local/inventory-response-speed-v1-20261027/RESTORE-NOTE.md)；只读诊断 [查询](../.local/inventory-speed-review-20261027/reads.md)、[前端](../.local/inventory-speed-review-20261027/frontend.md)。

**已实施**：`db/catalog/016_inventory_sync_functions.sql` 改为一次请求内建读取上下文并批量汇总（新增 `inventory_read_context` / `inventory_item_gaps` / `inventory_item_summary_core`，列表与详情复用同一核心；旧 `inventory_item_summary` / `inventory_item_warehouse_gap` 保留原签名作包装），未加跨请求缓存/新表/新授权入口，返回字段、排序、分页、搜索、筛选和错误语义不变；`src/features/inventory/components/inventory-view.tsx` 修正列表行“收起详情”地址（已展开时去掉 `item`，保留搜索/仓库/市场/页码）。
**同批实测（正式3011，批次 `0f4b73bf…`，3样本中位）**：50行列表 SQL 3492→193ms、页面 3442→420ms；10行 734→97ms；第2页 3798→403ms；搜索 391→389ms；仓库筛选 1708→410ms；打开详情 3892→444ms；收起详情 3814→467ms；冷加载立即点击 3978→540ms。
**一致性**：隔离副本同快照 288/288 读取用例 0 差异；正式库安装前后 288/288 0 差异；一次性夹具副本（失败/本次未见+上次已知/待采用/单位冲突/资料版本缺失/验证标记）288/288 0 差异 + 15/15 分支检查；真实页面链 34/34（含收起保留筛选/页码、MY待核0行、PH双码待合计）。
**现场**：BUILD **`p7im9R07D7iqkV_2mNKNJ`**（快照 `ed64515d…`，web pid 88024，sourcesMatchBuild=true）；schema version 6，functions `0c551192…`（由 `c36c90a0…` 更新）；worker 未重启（pid 42072，冻结源 `1db4017a…`）；60 分钟同步未改（next 15:22）；业务数据/430正式对应/历史/原 Excel/其它实例与旧证据未改。
**验证**：tsc 仅既有 BEST 5（库存 0 新错）、改动文件 eslint 0、inventory 纯逻辑 109/109、staging build 成功、`git diff --check` 0。未重跑旧15×20、BigSeller/R2、A1/B/C、备份恢复、多机并发、200% 等无关套件。
**未做/限制**：未做客户端局部刷新（页面已约0.4–0.5秒，按任务包停止；页面请求数与优化前相同，仍整页导航）；详情正式库残余约0.10–0.11秒；少量样本不是 p95；未提交/推送/合并/公网部署/清场/写长期记忆。停止点即上述状态，最终由独立审查裁定。

### 2026-10-27 诊断状态（历史，已在上一节实施后作废）

**原 `INVENTORY_RESPONSE_SPEED_V1_READY_FOR_EXECUTION`**：主审只读诊断显示 50 行列表约 3.94 秒，主要瓶颈为列表请求内部重复读取、列表行“收起详情”错误链接；执行方按该范围完成上述批量读取与收起地址修正。

## 上一任务已通过：BigSeller正式本地接入与统一库存入口v1（独立验收通过）

**2026-10-27 主审独立复审通过：`BS_LIVE_INTAKE_V1_LOCAL_PASS`。** [独立报告](../.local/bs-live-intake-r1-text-independent-20261027/independent-review.md)。R1 最后一处错误空态已关闭：主审实际走查 3011 的 WM0026 越南、MY、菲律宾，正常采用行不再显示“暂无已采用”；1853、672及待核0行、3119/4138双码分别展示和待合计说明均保留。失败旧值/旧时间等分支源码未改，既有受控探针核读沿用，未制造真实失败。

3011 BUILD `MB1i1eT7pYCsG8qdb1iea`，600个构建清单文件一致；唯一业务改动为现有组件+2行。worker PID42072、创建时间及9个冻结文件一致。本轮未连数据库、未触发导出、未重启或改计划；430正式对应/数量对账/R2/定时同步与A1/B/C沿用前轮可信独审，不重跑无关套件。**本机正式接入与统一库存入口v1收尾，无新增修复包。** 未匹配归属、PH双码合计口径、货值暂未计算及旧投影观察项保持原边界；数据、旧现场、失败证据全部保留。本地通过不等于公网部署或全ICEOS验收。

### 2026-10-27 R1说明条件执行交付（历史自验记录）

**2026-10-27 执行方完成 R1 说明条件收尾：`BS_LIVE_INTAKE_V1_R1_TEXT_IMPLEMENTED_AWAITING_INDEPENDENT_REVIEW`（执行方自验，不自行宣布 PASS）。** [本轮交付摘要](../.local/bs-live-intake-r1-text-20261027/delivery-summary.md)、[证据索引](../.local/bs-live-intake-r1-text-20261027/evidence-index.md)、[恢复说明](../.local/bs-live-intake-r1-text-20261027/RESTORE-NOTE.md)、[独审最小收尾](../.local/bs-live-intake-repair-independent-20261027/remaining-repair.md)。

**唯一日常地址仍为 http://127.0.0.1:3011**：正式实例 `run-20261026T211500Z-11a22b33` / PG 59345 / 库 `iceos_catalog_run_20261026T211500Z_11a22b33`，最终 BUILD **`MB1i1eT7pYCsG8qdb1iea`**（源码/编译快照 `a3f0f683…`，无 drift）；worker `inv-worker-59345` 未重启（pid 42072，冻结源 `1db4017a…`）；自动同步 **开启、60 分钟**（next 11:22，最近成功 10:22 自然计划 `22fcb140…`）。

**本轮已实施**：仅改 `src/features/catalog/components/catalog-detail.tsx` 的 `scopeReason`（+2 行）：正常 `current` 且有采用行时返回 `null`，不再与“本仓暂无已采用的 BigSeller 库存行”同屏；failed（保留错误码+上次成功时间）、unseen、unmapped_source、no_source 说明、MY 待核 0 行、PH 双码待合计、真正的列表/详情不一致提示全部保留。真实 3011 页面 **42/42**（越南/全仓→越南/MY/菲律宾，4 条新增“有采用行不得出现暂无采用”断言；10:22 批次 VN 1853、MY 672+ICEWM0026=0 行564、PH 3119/4138 均正确且不写死）；`scopeReason` 生产表达式只读探针：正常 current 三仓空，失败/未对应/无来源/本次未见说明保留。受影响文件 tsc 本包 0 新错、eslint 0/0、diff 0、构建无 drift。**未做**：未改数据库/商品/UUID/430 对应/库存/历史/原 Excel/worker/同步计划/其它实例；未重跑 R2、原有 R1 四项、A1/B/C、备份恢复、并发/性能/权限/200% 或整套 PG/浏览器；`clean brush`、46+174 待核、PH 合计口径、`inventory_current` 观察项保持原状；当前货值仍“暂未计算”。旧 38/38 失败现场与独审/执行证据未改写；未提交/推送/合并/部署/清场/写长期记忆；最终由独立复审裁定。

### 2026-10-27 R1/R2 独立复审快照（历史，非本轮结论）

**`BS_LIVE_INTAKE_V1_NEEDS_FIX`，只剩 R1 一处错误空态说明。** [独立报告](../.local/bs-live-intake-repair-independent-20261027/independent-review.md)、[唯一最小收尾](../.local/bs-live-intake-repair-independent-20261027/remaining-repair.md)。R2 `clean brush` 截断已修并独立通过；R1 单码状态、覆盖、切仓、待核0行已修好，但正常单仓仍同时显示“本仓暂无已采用的 BigSeller 库存行”。WM0026：越南1853、MY672、PH3119/4138均真实已采用、数量差额0。独立10:33快照：3011 / PG59345 / 当时 BUILD `IbVHV6BZXFtK3ft2cEb4k`，自动同步开启60分钟，16次成功，最新10:22自然计划成功；728源行/650批次行/430有效行/116商品小计与同批Excel核对0差异；430正式对应、126/128/126主资料不变；旧数据/原表/构建/worker/证据保留。`inventory_current`旧投影观察项不变；PH双码合计、未匹配商品归属仍为业务待决。

### 2026-10-27 执行方补修交付快照（历史，以下为自验记录）

**2026-10-27 执行方补修完成：`BS_LIVE_INTAKE_V1_REPAIR_IMPLEMENTED_AWAITING_INDEPENDENT_REVIEW`（执行方自验，不自行宣布 PASS）。** [本轮交付摘要](../.local/bs-live-intake-repair-r1r2-20261027/delivery-summary.md)、[证据索引](../.local/bs-live-intake-repair-r1r2-20261027/evidence-index.md)、[恢复说明](../.local/bs-live-intake-repair-r1r2-20261027/RESTORE-NOTE.md)、[独审报告](../.local/bs-live-intake-independent-20261027/independent-review.md)、[两组最小补修](../.local/bs-live-intake-independent-20261027/remaining-repair.md)。

**唯一日常地址仍为 http://127.0.0.1:3011**：正式实例 `run-20261026T211500Z-11a22b33`，PG 59345，BUILD **`IbVHV6BZXFtK3ft2cEb4k`**（源码快照 `9c4cbd00…`，编译/源码一致，无 drift），worker `inv-worker-59345` 冻结源更新为 **`1db4017a…`**（parser.py `28348dd6…`，旧源 `9003dd67…` 已备份可回退），自动同步 **开启、60 分钟**（10:22 真实自动计划 `22fcb140…` 成功，next 11:22）。

**已实施（本轮）**：R1 普通单码仓不再误标 `pending_total`（越南 WM0026 1853 不再假报“列表与详情不一致”）；详情覆盖改读库存读模型顶层 `coverage`（单仓 1/1、全仓 6/7，缺失显示“未读取”不是 0/0）；切仓不再客户端从全仓派生，改用库存模块已有单仓读取，数量/覆盖/待合计组/待核来源/时间/警告随范围切换；同仓待确认来源逐行显示（MY `ICEWM0026=0` 原表 564，未计入、不自动绑定；来源 0 不当没有来源）；失败旧值/旧时间、未对应/无来源沿用读模型，旧 BS 样表仅历史证据不回退；当前货值继续“暂未计算”。R2 明确 `SKU编号` 列保留完整字符串（`clean brush` 不再截成 `clean`，内部空格/标点/前导零保留；旧 `SKU信息` 混合列保持原分词兼容）；新批次 56673 行15=0、56519 行413=10087 以原码登记为 unmapped（未计商品合计），弃用仓 48787 行512=12633 仅源行、未发布；旧 `clean` 截断行 28 条保留为历史，430 正式对应未改。

**执行方自验**：正式 3011 真实页面 **38/38**（普通单仓无假提示/覆盖 1/1、全仓→越南 6/7→1/1 且无残留 PH 警告、MY 672（不完整）+ 待核 0 行 564、PH 3119/4138 双行“合计待核对”、库存页同源）；R2 保留真实 Excel 离线解析通过与更新后一次（明确标注手动）真实批次核对（430 adopted/430 effective/与同批原表差异 0）；catalog 单测 133/133、inventory 纯逻辑 109/109、parser pytest 30/30、tsc 本包 0 新错、eslint 0/0、diff check 0。**未做/待确认**：`clean brush` 不猜绑商品（业务决定）、46+174 待核仍保留、PH 双码合计口径未确认、切仓现走既有单仓读取（旧性能矩阵未重跑）、失败/断网/多机/自然过期/200%/完整权限矩阵未做、`inventory_current` 旧投影停顿但不参与本次读路径（观察项）；A1/B/C 等沿用证据未重跑。未提交/推送/合并/部署/清场/写长期记忆；最终范围由独立复审裁定。

### 2026-10-27 独立复审快照（历史，非本轮结论）

**`BS_LIVE_INTAKE_V1_NEEDS_FIX`。** 正式下载/保存/430条对应/定时后台/3011切换已实际运行；R1 商品库状态、覆盖与切仓接线，R2 真实 SKU `clean brush` 被截成 `clean`。库存数量对账无采用行差异，单位已确认，9条PH别名已有逐条人工出处。独立08:58快照：自动同步开启60分钟，13次成功，91批/8450行/当前430行；3011 / PG59345 / BUILD `uktXWUlhRzx0tPGmGp7xK`。详细范围与限制以[独立报告](../.local/bs-live-intake-independent-20261027/independent-review.md)为准。

### 2026-10-26 执行方交付快照（历史，以下不是独审结论）

**状态：`BS_LIVE_INTAKE_V1_IMPLEMENTED_AWAITING_INDEPENDENT_REVIEW`（历史）。** 完整任务包见[BigSeller正式本地接入任务包](tasks/bigseller-live-intake-v1.md)；[交付摘要](../.local/bs-live-intake-20261026/delivery-summary.md)、[证据索引](../.local/bs-live-intake-20261026/evidence-index.md)、[切换恢复说明](../.local/bs-live-intake-20261026/RESTORE-NOTE.md)。

**唯一日常地址已切换为 http://127.0.0.1:3011**：正式实例 `run-20261026T211500Z-11a22b33`，PG `127.0.0.1:59345`，库 `iceos_catalog_run_20261026T211500Z_11a22b33`，当时 BUILD **`uktXWUlhRzx0tPGmGp7xK`**（已由 2026-10-27 R1/R2 补修替换为 `IbVHV6BZXFtK3ft2cEb4k`；源码快照 `cec807bc…`，无 drift），后台 `inv-worker-59345`，schema v6（021 `c08eace8…`、functions `c36c90a0…`）。商品 UUID/主资料来自切换前 3011 库只读备份（126 商品 / 128 修订 / 126 货号，主资料哈希一致），不是 3036 测试副本的新 UUID。旧 3011 网页构建/配置/库备份与回退命令见 RESTORE-NOTE；旧 65466 库保留未改写。

**已实施**：两次真实导出（手动 `28447db3…` 21:11、真实自动计划 `c3ffacaa…` 21:18，均 success、账号 `laiguoyong@KNZX019402` verified、728 行/范围 650）；按已确认规则经正常管理员确认链形成 **430 条正式 confirmed 对应**（其他仓 69编码精确 377、56519 货号 30、条码例外 14、仅 56519 的 `ICE`+货号精确别名 9；0 verification、0 unitUnconfirmed，旧测试对应未批量转正），430 条当前采用行；46 同码冲突 + 174 未匹配保留待核。商品库列表/详情/切仓/刷新改读库存模块统一有效库存（新增 `read_inventory_catalog_sources` / 021 schema v6；库存页仍用 `read_inventory_item`/`read_inventory_list` 同一 effective-row 模型），旧 BS 样表只作历史证据、读取失败不回退；同仓多编码逐行显示并统一“合计待核对”（WM0026 56519：`757577983013=3119`、`ICEWM0026=4138`，不擅自相加，旧 7261 不作为当前期望）；当前货值统一“暂未计算”，旧价格不乘新库存。自动同步 **开启、60 分钟**、next 22:22，刷新不新增导出（runs/batches 前后 2/14/1300/430）。

**执行方自验**：真实页面链 20/20、三页同源对账 3/3、受影响纯逻辑 catalog 132/132 + inventory 109/109、tsc 本包 0 新错（全仓仅既有 BEST 5）、改动文件 eslint 0/0、构建 promote 后无 drift。**未做/待确认**：当前货值新估值（本包不做）、46+174 待核行的人工决定、PH `ICE`+货号别名规则的独立确认（不接受只影响 9 条）、真实断网/自然过期/多机/断电/旧性能/200%/完整权限矩阵；A1/B/C 等沿用证据未重跑。未提交/推送/合并/部署/清场/写长期记忆；最终范围由独立复审裁定。

## 上一已通过基线：商品库存与 BigSeller 自动同步 v1（A1本地技术验收）

**2026-10-26 用户补充确认（晚于 A1 验收）**：BigSeller 库存数量均按单个商品计数，不是箱，不做装箱数换算；其他国家仓商品编码对商品库“69编码”，菲律宾新创启辰仓主要用货号、少数条码可参考库存辨认。规则唯一正文见[商品身份标准第7节](product-identity-standard-v1.md)。数量单位已确认，不再作为业务待决；WM0026 该仓两种编码已确认同时展示，各自数量保留、不强制二选一；本次未决定正式合计口径，不阻塞其余明确项。本次只记录规则，程序、数据库验证标记、正式对应与页面入口尚未据此修改；下面验收时的“单位待确认”保留为历史记录。

**2026-10-26 主审独立复审通过：`INV_SYNC_V1_REPAIR_V4_FINAL_A1_LOCAL_PASS`。** [独立报告](../.local/inventory-sync-independent-v4-final-a1-20261026/independent-review.md)。A1 失败终态恢复已关闭；B/C 保持上一轮通过。本轮已批准修复的本地技术开发收尾，无新增返工包。

独立最终源码离线闭环 13/13、实际新库只读核验 12/12：失败终态可重复读取，核对/旧重试/旧动作入口均不再执行业务；最终页面链证据经主审核读（未重复写页面测试），显示终态后只清本条记录，设置可改。586 个源码/运行文件及 3 个部署函数匹配。执行方旧离线探针缺定时器模拟，已在新独审目录补齐，原失败保留；不要求业务返工。

验收现场：`run-20261026T180500Z-a1b2c3d4` @ 3036 / PG61653，BUILD `L4waWh75n57_sdLsWYaNT`；后台心跳在线，当前自动同步关闭、60 分钟、7 仓、configVersion 9、pending 0。15/105/9750 未变；五商品小计沿用本轮执行对账与上轮独审，不冒充再次全量核对。验收时的单位待确认已由本次用户确认结清；数据库验证对应尚未转为正式关系，验证数据不等于正式库存启用。全部旧实例、原表、历史失败证据保留；本轮未改业务源码/数据、未提交/推送/合并/部署/清场/写长期记忆。

### A1 执行方交付记录（保留历史，以下不是当前待办）


**2026-10-26 执行方完成 v4 FINAL 独审唯一剩余 A1 并提交自验；状态 `INV_SYNC_V1_REPAIR_V4_FINAL_A1_IMPLEMENTED_AWAITING_INDEPENDENT_REVIEW`，不声明 PASS。** 依据 [v4 FINAL 独立报告](../.local/inventory-sync-independent-v4-final-20261026/independent-review.md) 与 [唯一剩余修复](../.local/inventory-sync-independent-v4-final-20261026/remaining-repair.md)；[交付摘要](../.local/inventory-sync-repair-v4-final-a1-20261026/delivery-summary.md)、[证据索引](../.local/inventory-sync-repair-v4-final-a1-20261026/evidence-index.md)。只修 A1；B/R1、C/R4 已通过，不重开、不新增功能包。

**本轮实现（最小）**：`reconcile_inventory_request` 在无业务回执时读取**同 actor/同 intent 的 failed 终态**并返回可重复的 `terminal:'failed'`/`terminalErrorCode`；`begin_inventory_pending_action` 回放既有行返回 `errorCode`；`actions.ts` 让核对返回 `failed_terminal`、重试入口与 begin 回放遇 failed 直接拒绝再次执行业务；页面显示“原操作失败，已处理完，可以修正后重新操作”，随后只清该 requestId 本地记录并刷新解锁；`types/model/component` 对应状态与文案。未新增 RPC/表/状态存储，未改 B/C 与库存计算/历史。

**本轮实跑（执行方自验）**：新隔离实例 `run-20261026T180500Z-a1b2c3d4` @ 3036、PG 61653，BUILD **`L4waWh75n57_sdLsWYaNT`**（staged snapshot `8e2d6de0…`，start 后 `repoDrift=false`）、worker `inv-worker-61653`、schema v5（functions `1b2387ad…` 与源码一致）；回放 15 run/105 批次/9750 行/27 对应，五商品小计 1028/247/23/13059/122110 不变。A1 最终页面＋数据库链：范围清空→旧页面点立即同步→业务确定失败并 settle 提交→受控代理丢弃响应→刷新仍锁→核对 `failed_terminal`→显示终态→本地记录清除、写锁解除、设置真实可改并恢复；**恢复阶段 POST 仅 1 条（unknown），business/register 0**，runs/batches/batchRows 前后不变、failed 行保留、业务回执 0。复制独审第13项反例（原失败结果保留）并按新 SQL 终态语义重放 **13/13 PASS**；PG **44/44**、只读核对 **42/42**、部署函数只读一致、页面纯逻辑 109、tsc 本包 0 新错、eslint 0/0、diff check 0。

**范围与边界**：B 采用态、C run-check、真实采集/接管/备份、历史前值、旧性能/UI/权限矩阵沿用（未重跑）。3035/54164、3034/61135、3011/3021/3022、3031+50499、3032+59532、3033+53442 保留只读，保护快照 before→final 0 变化；写入仅新实例 61653。未重抓 BigSeller、未删/补造测试对应或历史；误写独审 `settlement-probes.json` 已按运行前副本 sha `e96eaa59…` 恢复并记录。27 条回放验证对应（候选现场另含 3 条测试对应共 30）仍为验证数据（`unitConfirmed=false`），单位“件”待业务确认，验证数据不等于正式库存启用；旧 3031/50499 事件不归因。未覆盖：真实断网（用受控代理）、多机/断电/自然过期/200%/完整权限矩阵、旧性能/UI。未生产启用、未提交/推送/合并/部署/清场/写长期记忆；最终范围由独立复审裁定。

### v4 FINAL 首轮执行方交付记录（保留历史，2026-10-26）


**2026-10-26 执行方完成 v4 独审剩余 A/B/C 三处并提交自验；状态 `INV_SYNC_V1_REPAIR_V4_FINAL_IMPLEMENTED_AWAITING_INDEPENDENT_REVIEW`，不声明 PASS。** 依据 [v4 独立报告](../.local/inventory-sync-independent-v4-20261026/independent-review.md) 与 [三处最小收尾](../.local/inventory-sync-independent-v4-20261026/remaining-repairs.md)；[交付摘要](../.local/inventory-sync-repair-v4-final-20261026/delivery-summary.md)、[执行契约](../.local/inventory-sync-repair-v4-final-20261026/contract-v4-final.md)、证据根 `.local/inventory-sync-repair-v4-final-20261026/`。只补这三处，不新增功能，不重开已关闭项。

**本轮已实现**：**A/R2** 新增 DB `catalog.settle_inventory_pending_action(...)`（单事务 FOR UPDATE，核本人/action/intent/完整 payload；成功回执不改判；返回 SETTLED/NO_PENDING/NOT_ORIGINAL/HAS_RECEIPT/FORBIDDEN/NOT_PENDING）与 `settlement.ts` 四态；`actions.ts` 前置失败不再凭 requestId 结案，`executeWithPending/executeRetry` 业务确定失败回填 settlement 且不忽略结案失败；页面仅在业务成功（非 unlockFailed）或服务端确认结案时清本地记录/锁/状态/刷新，结案失败/未知/非原请求保留记录与锁。**B/R1** `adoptedSkus` 改取同范围 `inventory_effective_rows`，新增 `pendingAdoptionSkus=mapped−adopted`、`pendingAdoptionWarehouses`；列表/详情统一“已计入合计”与“对应已确认、等待下一次完整同步采用”两态，库存计算/历史/测试映射未动。**C/R4** `run-check.mjs` 的 `pgInstanceDir` 分支先读 `env.catalog.json` 并传 `env` 给连接前守卫，通过后才创建连接，保留连接后只读身份核验。

**本轮实跑（执行方自验，非独立结论）**：新隔离实例 `run-20261026T164500Z-e8f9a0b1` @ 3035、PG 54164，BUILD **`KJUZ9F4ZJuSl2a7qWWAZ6`**（no drift）、worker `inv-worker-54164`、schema v5（020 `4e384414…` + functions `7cd92fd3…`，与源码一致）；回放 15 run/105 批次/9750 行/27 对应，B 新增 3 条验证对应（confirmed=30），pending 锁 0。A：页面链“本地未知→明确未找到→范围清空→重试 `INVENTORY_SCOPE_EMPTY`→结案→本地锁解除、设置真实可改”通过 + DB 断言、离线探针 12/12、PG settle 事务 4/4；B：数据 53/53、真实页面 27/27（50455 已计入仅 6974674957325=899，三条等待采用，小计 1028 与其余 247/23/13059/122110 不变，原十条待确认仍可见）；C：离线真实分支 2/2（覆盖参数 connect 0/套件 0，合法目标进入只读身份核验）；PG 套件 43/43、42/42 只读核对、页面纯逻辑 109、tsc 无本包新错、eslint 0/0、diff check 0。

**范围与边界**：PH 54409“五商品全无来源”只属测试前状态；最终现场 LS101295 已因测试映射扩展为 2 条来源（7332 行471=0、7349 行470=0），其余四商品仍无来源，旧断言失败保留、不删映射凑答案。3011/3021/3022、3031+50499、3032+59532、3033+53442、候选 3034+61135 均未写/未启停/未替换构建（保护快照 before→final 端口与 marker 文件 0 变化）；写入仅新实例 54164。27 条回放 + 3 条 B 验证对应均为验证数据（`verification=true/unitConfirmed=false`，单位“件”非业务确认）；旧 59532 历史 item_revision 仍 NULL；旧 3031/50499 未确认事件不归因。未覆盖：真实页面 settle_failed/未知/not_original（离线+事务覆盖）、200% 缩放/完整权限矩阵/真实断网/自然登录过期/断电并发、真实 BigSeller 采集与备份正常路径（沿用旧证据）。未生产启用、未提交/推送/合并/部署/清场。最终通过范围由独立复审裁定。

### v4 首轮执行方交付记录（保留历史，2026-10-26）


**2026-10-26 执行方完成 R1–R4 并提交自验；状态 `INV_SYNC_V1_REPAIR_V4_IMPLEMENTED_AWAITING_INDEPENDENT_REVIEW`，不声明 PASS。** 依据 [v3 独立报告](../.local/inventory-sync-independent-v3-20261026/independent-review.md) 与[四组最小补修清单](../.local/inventory-sync-independent-v3-20261026/remaining-repairs.md)；交付摘要 [delivery-summary.md](../.local/inventory-sync-repair-v4-20261026/delivery-summary.md)、证据索引 [evidence-index.md](../.local/inventory-sync-repair-v4-20261026/evidence-index.md)、执行契约 [contract-v4.md](../.local/inventory-sync-repair-v4-20261026/contract-v4.md)。

**已实现（执行方）**：R1 来源存在性独立于采用关系——已知编码（本商品全部仓 confirmed mapping ∪ candidate）在本仓最新登记 run 的 `parse_status='ok'` 源行单独读取，同仓已有 current 也列出其余 `pendingSourceRows`（文件行号/数量/mapped），无当前行有源行=`unmapped_source`、真无源行=`no_source`，数量 0 不当作无来源；列表/详情新增 `pendingSourceWarehouses/pendingSourceRows/...`，pending 不自动绑定也不计入合计。R2 本地未知请求纳入统一写锁（设置/立即同步/对应确认/详情维护）、本地 v2 记录绑定服务端 actor/account、换管理员不能接管、换请求 keyed 重置、intent v4 结构化编码（`canonicalJson`）消除旧指纹碰撞，DB `inventory_payload_key` 在登记/业务执行/恢复处核对完整参数，旧 v3 指纹服务端 pending 仍可核对/重试。R3 `buildConfirmBatch` 按行 `reconfirmRowKeys` 校验版本，首次+重确认混合批量可一次提交。R4 守卫按驱动最终目标检查并拒绝覆盖 host/port/dbname 等查询参数，新增连接后 `BEGIN READ ONLY` 身份核对并接入 12 个实际连接入口，`prepare-instance` 建库连接后先只读核库名/端口。

**交付现场**：新隔离实例 `run-20261026T153500Z-c4e8a1b2`，网页 `http://127.0.0.1:3034/dashboard/sync`、独立 PG `127.0.0.1:61135`，BUILD **`BWfdgG5RtlNS3KlwLzYLp`**（start 后 no drift），后台 `inv-worker-61135`（冻结源 `9003dd67…`），schema v4（019 `48f856f8…`、functions `a8dff9c0…`）。保留批次回放 15 run/105 批次/9750 行/27 验证对应/405 adopted 修订；五商品小计 1028/247/23/13059/122110 不变；WM0049 越南 50455 历史 83,025→83,022（-3）、WM0026 2,001→2,001（0）。

**执行方自验（不是独立审查结论）**：PG 套件 38/38（含新增 R1/R2 v4 用例）、只读核对 42/42、R1 十条真实源行 38/38（52074 六条 unmapped_source、54886/56673 四条 current+待确认、PH 54409 no_source 对照）、页面纯逻辑 91（含 intent-v4 6、web-model-v4 16）、浏览器 v4 8/8（0 skipped/flaky，79.4s；R2-1..R2-7、R3-1 页面+DB 断言）、R4 离线反例 a–l、生产构建 staging→promote→start 无 drift；inventory tsc 0、eslint `--max-warnings 0` 0、`git diff --check` 0。

**保护与边界**：3011/3021/3022、3031+50499、3032+59532、**3033+53442** 未启停/未写入/未替换构建（3033/53442 仅只读文件读取）；保护快照 before→final 端口 0 变化、保护实例 marker/env/worker 配置与 exports 0 变化。旧 3031/50499 未确认测试写入事件保留；27 条对应仍为验证数据（单位“件”非业务确认）；旧 59532 历史 item_revision 仍 NULL（未回填）。未覆盖：真实断网/网络分区（用本地反代模拟响应丢失）、自然登录过期、断电/多机并发、旧 15×20/旧 UI/200%/完整权限矩阵；本地预览不是生产部署。未提交/推送/合并/部署/清场。v3 独立审查 `INV_SYNC_V1_REPAIR_V3_NEEDS_FIX` 与 v2 输入保留历史身份；最终范围由独立审查裁定。

### v3 执行方交付记录（保留历史）

**2026-10-26 执行方交审时状态：`INV_SYNC_V1_REPAIR_V3_IMPLEMENTED_AWAITING_INDEPENDENT_REVIEW`。** 按[集中补修包 v3](../.local/inventory-sync-independent-v2-20261026/execution-repair-v3.md)完成 F1–F5 并做执行方自验；v2 独审 `INV_SYNC_V1_REPAIR_V2_NEEDS_FIX` 与[独立报告](../.local/inventory-sync-independent-v2-20261026/independent-review.md)保留为历史输入，最终通过范围由独立审查裁定，执行方不声明 PASS。

修复实例 `run-20261026T123800Z-d3f4a5b6`：网页 `http://127.0.0.1:3033`（生产 BUILD **`R4hh0kmDKek10Xm-em3Fk`**），独立 PG `127.0.0.1:53442`，后台 `inv-worker-53442`（冻结源 `9003dd67…`），登录 `admin@catalog.test / CatalogAdmin123!`；实例 marker `testWritable/validationInstance`。数据库增量 `018_inventory_sync_repair_v3.sql`（`1941b997…`）+ 函数文件（`1a37dd2f…`），实际 DB `schema_state.version=3`；未改 00001–00052/017。

**已实现（F1–F5）**：F1 页面/草稿/批量按账号+仓+SKU 行身份、队列返回 currentMapping/版本、首次与重确认版本规则、verification-only 单位标记；F2 历史前驱派生成正（不改历史行）、发布保存当时 item_revision/缺修订拒发、owner-only 只读策略、覆盖/缺口/市场统一读模型（5/7 有缺口、多市场集合+未知）；F3 发布以登记源行为唯一业务字段来源并逐字段核对（保行号/hash 改数量或换 SKU 拒绝）；F4 requestId+intent 绑定、三态核对、找到回执与解锁分离、解锁失败保留、无持久锁直接 found、他人 pending 仅忙碌、页面重载/刷新恢复；F5 冻结源 first-only/显式 refresh、备份恢复失败显式失败、可写测试入口连接前 marker+连接后只读身份核对。

**执行方实测**：保留批次回放 15 真实 run/105 仓批次/9750 行（27 条验证对应，adopted 405 行带当时修订）；只读核对 **42/42**（LS101295 1028、LS101302 247、WM0011 23、WM0026 13059、WM0049 122110；WM0049 历史 **83,025→83,022（-3，不是 -52）**、WM0026 **2,001→2,001（0，不是 -9）**；覆盖 5/7、市场集合+未知）；真实 PG 套件 **32/32**；Python **122**、页面纯逻辑 **69**、页面 v3 闭环 **10/10（0 failed/skipped/flaky，84.9s）**（F1 确认/版本、F2 覆盖历史、F4 A/A2/B/C/D 真实页面+DB 一次效果、F4-C 临时 REVOKE 后 GRANT 并断言 `has_function_privilege=true`）；F5 反例 8/8+5/5+16/16；最终 tsc 本包 0（全仓仅既有 BEST 5）、eslint `--max-warnings 0` 0、`git diff --check` 0。证据 `.local/inventory-sync-repair-v3-20261026/`（`delivery-summary.md`、`replay/`、`verify/`、`db/`、`f5/`、`web/`、保护快照）。

**保护**：3011/3021/3022、原 3031/50499、v2 3032/59532 未启停/未写库（59532 仅 `BEGIN TRANSACTION READ ONLY` 提取）；旧 3031/50499 未确认测试写入事件保留现场与前后证据，未删除、未指认来源；旧独审 `worker-focused-probes.py` 曾被修改、旧结果 JSON 保留。**27 条对应仍是执行方验证数据，业务包装单位与真实市场确认待用户**；旧 59532 历史 item_revision 仍 NULL（未回填）。未覆盖：真实断网/自然登录过期/断电并发多机/旧 15×20/旧 UI/200%/完整权限矩阵；本地预览不是生产部署。未提交/推送/合并/部署/清场。

## ICE 商品库飞书来源模拟接入 v1（最近已验收，本地模拟接入通过）

**状态：`FS_CATALOG_SIM_LOCAL_PASS`（主审独立验收通过 2026-10-25；不是 UI v4 PASS、不是真实飞书 API 接通、不是生产启用）。** 收尾摘要见 [feishu-product-source-v1-closeout.md](./catalog/feishu-product-source-v1-closeout.md)。用户指定飞书普通电子表格为商品资料来源（wiki `TC2AwLgRniqWKhkg9D2cEx79n0b`，Sheet1，spreadsheet_token `EMZGs2eIhh0YQ1tPIqMcR8SPnQh`，sheet_id `33bab4`）。本轮以匿名公开只读网页选择 `A1:AE404`、键盘复制取得真实全表快照：404 行 × 31 列，A–AA 共 27 个表头，AB–AE 无表头/无数据；有效业务行 131、完全空行 272、G 列非空 130 行/唯一编号 125 个（`WM0069`–`WM0073` 各 2 行，第 122 行缺码）；原始剪贴板 TSV 34,749B、sha256 `89e265f549ecc4f6badcf8b2f6d6e05956ecfe701dc4141771f5416dc2e63b6f`（含 I/J/Y 价格，只存 `.local`，未入库）；仓库 fixture 为去价格脱敏派生 `tests/catalog/fixtures/product-source/snapshot-001-redacted.json`。原始结果与模拟变化清单见 [feishu-product-source-v1.md](./catalog/feishu-product-source-v1.md)。

**已实现**：来源快照契约（表头名定位、22 个可采纳字段、价格列隔离）、`ProductSourceReader` 本地快照读取器与未来飞书 API 读取器（同一接口，API 未配置只抛明确错误）、编号分组/同号严格一致合并/缺码/疑似改码/公式与数值异常、首轮基线 + 后续三方比较（本地单方保留、来源更新、同值不追加修订、冲突保留本地且无冲突字段继续）、新品建档（条件校验、不伪造价格/库存/BS-JST）、本次未见仅标记、批次幂等/旧快照拒绝/逐项结果/事务内修订与回执、缺码补号保留原 UUID、价格仅私有表且公共投影/Fixture/计划零价格；数据库增量 `db/catalog/015_product_source_sync.sql`（8 张 catalog 表 + 1 张私有价格表 + 1 张私有原请求意图表、FORCE RLS、SECURITY DEFINER 函数、只读投影，未改 001–014）；最小来源更新面板挂 `src/app/dashboard/catalog/sources/page.tsx`（本地模拟状态/六项计数/逐项原值→新值/待核对清单/重试入口），商品详情与变更记录复用现有商品库。

**三项定向补修（2026-10-25 已实施，随本包通过主审独立验收）**：① 单位未确认字段（外箱长宽高/单箱重量/立方）不再静默采用——已有商品本地为空或不同、新品均不 adopt/不写商品，保留来源原文与 `unit_unconfirmed` 待核对，其他确认字段照常处理；② 恢复链区分“已知部分失败补做”（只补父批次 failed sourceKey，成功商品不重复修订，批次以 `retry_of_batch_id` 关联）与“提交结果未知原请求核对”（提交前保存 requestId+完整意图到私有表，按原 intent/载荷重提返回原回执，不因重新生成计划报请求冲突）；③ 金额隔离改为按 `collection.headers` 实际表头映射剔除公共来源行价格，不写死 I/J/Y，私有金额改语义键 `costPrice/operatingPrice/shippingPrice`；列重排（价格列 L/M/N、I/J/Y 普通文本）验证公共无金额、私有对应正确。

**执行方自验（非独立结论）**：原始实例 `run-20261025T074500Z-f5a00006`（3021）保留未改写；修复轮独立实例 `run-20261025T053500Z-f5a00007`（独立 DB 端口 59883，预览 `http://127.0.0.1:3022/dashboard/catalog/sources`，BUILD `KxK3GCNqcL6oawVAbyL0o`，pid 79708；构建源哈希与当前仓库一致、drift=false）。修复轮实测：真实快照 baseline updated=91/unchanged=23/needsReview=12/missing=1，未确认单位字段 0 adopt/0 write；WM9001 新品 6 条 unit_unconfirmed、0 个未确认字段入修订，成为已有商品且本地为空后仍 0 写入；模拟 002 created=1/updated=2/needsReview=17/missing=3，装箱数量 80→100 正常写入；并发失败 1 项（LS101501）批次 partial，UI“补做失败商品”生成 retry 批次仅含失败项、失败项恢复、成功项 LS101274 revision 6→6 不变；提交前原请求 draft 保存，重建计划的新 intent 被 `CATALOG_REQUEST_CONFLICT` 拒绝、原 intent+原载荷重放返回与首次一致回执；页面动作返回结构化 `outcomeUnknown`（仅未知提交、不与确定失败混同），组件保留原 requestId/操作信息并锁住新操作，核对沿用同一 requestId 取得原回执后解除；浏览器响应丢失演练通过（原请求保留、刷新/应用禁用、同 requestId 核对、1 批次/1 回执）；金额原列序公共 28 列/私有 130 行 0 差异，合成列重排（价格列 L/M/N）公共无价格、I/J/Y 普通值保留 100 行、私有 403 行 0 差异；UI 走查 LS101274 装箱数量 100→120 + 工厂本地冲突保留 + 历史可见、WM9001 新品建档无未确认外箱字段。保护：现役 3011 只读 126 商品/BS 530/未装 product_source 表；原始 TSV sha256 未变。单测 62/62 + 服务恢复链 5/5 + PG 16/16；全仓 test 619/620（唯一既有 opt6 00051）、tsc 仅既有 BEST 5、lint 0 error/14 既有 warning、`git diff --check` 0、build 成功。证据 `.local/catalog/fs-catalog-sim-20261025/repair-20261025/`（不入库）。

**主审独立验收（`FS_CATALOG_SIM_LOCAL_PASS` 依据，2026-10-25）**：验收构建 `KxK3GCNqcL6oawVAbyL0o`、独立预览 3022；主审独立完成定向测试、真实组件接线、构建源码一致性核对与只读数据库核验，并确认 555 个构建文件与源码及运行目录一致、结果未知恢复使用同一 requestId、数据库只有 1 个批次、1 条回执。证据分层：主审独立验证 / 执行方证据（浏览器响应丢失演练、全仓检查与写入演练）/ 历史证据（旧 3021 实例与旧记录，未覆盖、未改写）。本轮仅登记已有审查结论，不是重新执行独立验收。详见 [收尾摘要](./catalog/feishu-product-source-v1-closeout.md)。

**未覆盖 / 待确认**：未开通飞书 API（凭据/权限/分页/限流/token 未验），spreadsheet_token/sheet_id 为用户确认、未由 API 复核；图片列在文本剪贴板中无内容，图片内容未核验；外箱长宽高/单箱重量/立方单位未在来源表头明确，按“保留原值 + 单位未确认”处理，不换算、不自动采用（含本地为空/新品），只进入待核对；真实 200% 缩放与浏览器矩阵未做；模拟变化是本地副本、非飞书真实修改；本包不改库存/物流/估值，不改变现役 126 商品与 BS/JST 对应。停止于 `FS_CATALOG_SIM_LOCAL_PASS`（仅本地模拟接入通过，不代表真实 API 接通、生产启用、旧 UI/性能延期项或整个 ICEOS 全面通过）；不自动开启真实 API 接入或下一包。

## 商品库 v6 四项定向补修包（历史，独审通过 `V6_FOUR_ITEMS_LOCAL_PASS`）

**状态：`V6_FOUR_ITEMS_LOCAL_PASS`（独立复审通过 2026-10-24）。** 结论：商品库 v6 四项定向补修已通过独立复审，按不越权、日常正常使用、关键内容不误导的标准完成本包。独立报告 [independent-review.md](../.local/catalog/independent-ui-frontend-v6-20261024/independent-review.md)；收尾摘要 [catalog-ui-v6-closeout.md](./catalog/catalog-ui-v6-closeout.md)。通过范围仅限 V6-01 来源缓存版本/迟到响应/身份权限隔离、V6-02 来源采用状态与库存说明、V6-03 逐条来源价格缺失文案、V6-04 读取失败/无权限/真实空记录区分；**不覆盖**旧 v6 性能门禁/15×20、原 v4 全量后端、准备链、保存回执六态、真实来源摄取、后续匹配规则。**不代表原 v4/v5 全量验收、全商品库或全 ICEOS 全面通过，也不是真实多账户/撤权/数据库权限矩阵或性能验收。** v5 历史 `UI_REVIEW_NEEDS_FIX` 保留；延期项保留原记录，不写成已修复或已通过。执行方材料 [delivery-summary.md](../.local/catalog/ui-frontend-v6-20261024/delivery-summary.md)、[repair-matrix.md](../.local/catalog/ui-frontend-v6-20261024/repair-matrix.md)、[evidence-index.md](../.local/catalog/ui-frontend-v6-20261024/evidence-index.md)、[screenshots-index.md](../.local/catalog/ui-frontend-v6-20261024/screenshots-index.md)。

**已实施**：撤销 v5 新增的共享来源结果缓存，库存空态提示与数据来源子视图每次重新走服务端鉴权；详情缓存、切仓、迟到响应与身份/金额上下文保护原样保留（V6-01）；来源“本批已采用对应”与“库存已计入”分开，BS 以已确认 BS 样表行为准、JST 不声称计入国内库存，已采用记录不再显示“尚未建立对应/仅名称相似”，未采用记录早期提示默认收起（V6-02）；WM0072 当前采用进货价/运营价保留，逐条来源价格说明改为“暂未展示”（V6-03）；来源数量仅在成功空集合时显示 0，失败/无权限显示“—”，价格单独失败/无权限保留来源记录并可重试，历史重试不切当前（V6-04）。顺手移除两处状态反馈中的 request UUID。

**证据分层（勿混记）**：独立实际页面走查（WM0043 搜索/详情/真实零仓/有货仓/未采用仓/来源/返回/关闭，WM0072 当前价与历史来源往返，5 张新截图与 AX 记录）；独立重跑 33 项受控浏览器检查 + 6 项边界补验均通过（重跑输出与执行证据分离）；独立定向纯测试与组件接线（source-view 5、detail-cache 13、组件异步接线 5/5、投影与组件探针 20/20，分报告有重叠不累加）；本包 6 个受影响文件 eslint `--max-warnings 0` exit 0（`independent-lint.json`）。**仅核执行方材料（不是独立全部重跑）**：主浏览器套件 **22/22（0 skipped/flaky，104.7s）**、单测 **547/548**（唯一既有 opt6 00051）、catalog tsc 0（全仓仅既有 BEST 5）、全仓 lint 0 error/14 条既有 warning、production build 成功。最终候选 BUILD **`UeTuf-hPnkmmIWTQ1LmFU`** @ 3011（pid 34572，快照 `4cf18e57…`，`ownershipVerified=true`，login 200）；独审核对 521 个构建源码条目现役工作区零差异、13 个关键文件 hash 一致。**未覆盖**：失败/无权限/价格失败/真实空为受控响应，不是真实数据库权限故障或 ACL/换号验收；真实 200% 缩放未做；延期项不写成通过。**未写入现役 126 商品/BS 530 行。**

**Git 收尾（2026-10-24）**：本系列累计 UI/交互代码、测试、延期脚本（现有实现归档、相关验收延期）与文档已按逻辑分组提交并普通推送 `origin/codex/ice-v4-planning`；未 merge/deploy，未启停实例，未清场，未开启下一包。提交清单、最终 HEAD、真实远端 SHA 与 ahead/behind 见本地回执 `.local/catalog/ui-v6-closeout-20261024/closeout-record.md`（本地回执与 `.local` 证据不入库）。

## 商品库前端展示与交互收尾包 v5（历史，独审 `UI_REVIEW_NEEDS_FIX`）

**状态：`UI_REVIEW_NEEDS_FIX`（独立复审 2026-10-24）**。独立报告：[independent-review.md](../.local/catalog/independent-ui-frontend-v5-20261024/independent-review.md)。用户已把原 v4 范围收窄为前端展示与交互；v5 只做 V5-01～V5-05，**不是 UI PASS**，未 commit/push/merge/deploy。v6 只承接用户指定的四项定向补修，v5 其余独审项未纳入本包。

**已实施**：来源“本批未采用/已采用”分组、每条记录自己的仓库与真实状态、未计入库存说明、库存空态来源提示，未采用不计库存、真实 0 与未知分开（V5-01）；详情先读完整库存行再按目标仓展示，列表/详情同仓同状态，删除“仓库投影/正在同步列表”，无 confirmed 行不再当 0，切仓目标内容/滚动/快速选择稳定（V5-02）；来源系统/编码/名称/各记录仓库/已有核对提示、当前采用价与逐条来源价格出处、读取失败/无权限/缺值分开（V5-03）；历史当前参照真正显示 6 条记录，返回恢复 current 身份/分区/滚动/焦点，直接历史仍只读（V5-04）；账户/维护/旧 evidence 去技术内容、按货号名称选择商品、旧来源地址进入统一弹窗、intake/sources/商品弹窗统一安全返回（V5-05）。

**执行方自验（非独立结论）**：最终 BUILD **`FuW0YdgLlttyIps2oMXSI`** @ 3011（pid 74664，快照 `aff4a313…`，`ownershipVerified=true`，login 200）；主浏览器套件 **22/22（0 skipped/flaky，1.7m，exit 0）**、v5 定向浏览器探针 **37/37**、单测 **546/547**（唯一既有 opt6 00051）、catalog tsc 0（全仓仅既有 BEST 5）、改动文件 eslint 0/0、`git diff --check` 0；五视口关闭可达/库存首行可见；WM0043/WM0110/WM0072、账户/维护/旧 evidence、后退前进实测。**未完成/未覆盖**：来源全空态与“读商品有权限、读来源/价格无权限”无现役自然样本（仅服务端投影单测）；真实 200% 缩放未覆盖；原 v4 后端/准备链/性能平台按用户范围延期，保留原问题和 `UI_REVIEW_NEEDS_FIX` 证据，不写成通过。**未写入现役 126 商品/BS 530 行。** 当时待审范围仅限 v5 前端展示与交互；独立复审结论为 `UI_REVIEW_NEEDS_FIX`，v6 只承接用户指定的四项定向补修，其余独审项未纳入本包。

## 商品库 UI 集中补修包 v4（历史，独审 `UI_REVIEW_NEEDS_FIX`）

**状态：`UI_REVIEW_NEEDS_FIX`（独立复审 2026-10-24）**。按用户 v4 包要求处理 V4-01～V4-09；**不是 UI PASS**，未 commit/push/merge/deploy。独立报告 [independent-review.md](../.local/catalog/independent-ui-repair-v4-20261024/independent-review.md)。v5 只承接其中前端展示与交互部分，V4-07/V4-08、隔离 DB 六态、真实 prepare 四态和 15×20 性能矩阵按用户调整范围延期，不是已修复。矩阵 [repair-matrix.md](../.local/catalog/ui-repair-v4-20261024/repair-matrix.md)、摘要 [delivery-summary.md](../.local/catalog/ui-repair-v4-20261024/delivery-summary.md)、证据 [evidence-index.md](../.local/catalog/ui-repair-v4-20261024/evidence-index.md)、截图 [screenshots-index.md](../.local/catalog/ui-repair-v4-20261024/screenshots-index.md)。

**已实施**：仓库切换固定顺序、选中不改变按钮宽度、不强制回顶（V4-01）；“数据来源”业务视图替代 JSON/技术身份/下载，来源记录显示自己的仓库与真实对应状态，历史来源只显示该版本事实、当前参照需显式操作（V4-02）；历史不比较当前仓投影、失败重试真正重发目标 revision、跨版本来源返回原版本/分区/滚动，库存/历史首屏优先实际内容（V4-03）；原请求核对只认真实回执与完整意图，基线核 `audit_event` intent、scoped 核 `catalog.new_item_request`（V4-04）；全仓派生先核完整全仓明细再核目标仓投影（V4-05）；返回路径规范化白名单、启用态链接带 from、不以 UUID 为主文（V4-06）；准备链 recordOnly 与 manifest 命中均核 DB（V4-09 部分）。

**执行方自验（非独立结论）**：最终 BUILD **`Dwnb0Go61UvC1sHZx4Uev`** @ 3011（pid 35400，快照 `57f2c5b2…`，`ownershipVerified=true`，login 200）；浏览器主套件 **22/22（0 skipped/flaky，1.7m）**；单测 **536/537**（唯一既有 opt6 00051）；V4-04 定向 50/50、V4-05 13/13、V4-06 18/18；五视口首屏均有库存明细行、切仓按钮矩形不变；WM0072 历史/跨版本来源返回实测；issues/旧直链/穿越 from 实测；catalog tsc 0、eslint 0/0、`git diff --check` 0。

**未完成/未通过**：V4-07 v6 内容完成门禁与真实应用负向未完成；V4-08 没有最终 15×20 性能矩阵，旧 v5 数字不能写成通过；V4-04 隔离 DB 六态、V4-05 隔离缓存反例、V4-09 真实隔离库四态/最终回归未跑；真实 200% 缩放 pending；现役保护指纹未覆盖全部测试时窗。**未写入现役 126 商品/BS 530 行。**

## 商品库 UI 集中补修包 v3（历史，待独立复审）

**状态：`UI_IMPLEMENTED_AWAITING_INDEPENDENT_REVIEW`（2026-10-24）**。按 `.local/catalog/independent-ui-repair-v2-20261024/execution-repair-package-v3.md` 实施 V3-01～V3-08，并处理同目录 v2 独审（`independent-review.md`、`user-feedback-addendum-20261024.md`、`code-review/`、`contract-review/`、`perf-review/`）未通过项；**不是 UI PASS**，未经独立复审；未 commit/push/merge/deploy。矩阵 [repair-matrix.md](../.local/catalog/ui-repair-v3-20261024/repair-matrix.md)、摘要 [delivery-summary.md](../.local/catalog/ui-repair-v3-20261024/delivery-summary.md)、证据索引 [evidence-index.md](../.local/catalog/ui-repair-v3-20261024/evidence-index.md)、截图目录 [screenshots/](../.local/catalog/ui-repair-v3-20261024/screenshots)。

**产品决定（V3 摘要）**：商品资料/库存/历史/来源围绕同一固定弹窗完成——移除「在新标签页打开」「技术档案」等日常外部跳转与独立详情壳，历史版本在弹窗内查看（当前标记、旧版本只读切换、原位返回），来源/原始证据在内容区子视图按需展开并原位返回（沿用服务端权限）；旧 `/dashboard/catalog/<id>` 307 到同一弹窗，非法版本显式报错，带安全 `from` 时关闭真实回原页；变更记录只显示业务事实（中文理由、可读时间、字段差异、可核实操作者显示名），UUID/JSON 路径/内部英文原因退出日常记录；全流程清理重复口径与工程说明（列表单行样表、单产品重量 kg、体积可读、包装仅真实值、635/短屏压缩、启用态去 fixture/UUID）；切仓在有效缓存/全仓明细基础上即时切换（切仓 0 次详情请求，同 scope 暖复开后台校验），仓名/数量/货值/明细同 scope；草稿与待核请求按主体+商品+意图分键，旧无主体键隔离不认领，核对只读、仅显式「重试原请求」以同 requestId/参数/expectedRevision 重投；返回链保留合法 from、恢复列表筛选与分页位置；不可变事项保留并如实说明“无处理入口/关闭依据待业务定义”，不虚构按钮或改库指令；V3-08 定位非基线候选失败根因为缺 014 候选索引（统一链 009–014 后 168ms），隔离 lane 用最终源码重跑。

**执行方自验（非独立结论）**：浏览器主套件 **22/22（0 failed/skipped/flaky，119.35s）**；v3 UI 采集 **117 checks / 0 failed / 5 uncovered / 70 shots**（1440/1100/635×800/720×450/635×560，外框与三分区矩形逐视口实测一致，from 链与旧直链+from 往返、切仓同仓同范围、分页 2→5→7→6、证据 back 焦点回 summary、历史无 UUID/JSON/英文内部原因）；oracle v5 合成校准 **26/26**（8 正例+18 反例）、merge 自检 **20/20**、期望 crossChecked=true（20 商品）；性能 15 场景×20 样本见 `oracle/runs/`（阈值未下调，超阈桶原样保留）；`tsc --incremental false` 全仓 5 条历史 BEST 基线（商品库 0）、`eslint --max-warnings 0` 0/0、单测 **513/514**（唯一失败为既有 `opt6-production-apply` 00051 换行）、`git diff --check` 0。预览 staging build→校验→promote→start→归属核验，最终 BUILD **`8qFEEnYTJ60Jgk7E_ZiNZ`** @ 3011（pid 21036，快照 `603dc16e7257bb0a…` 与 promote 一致）。

**待独立复审裁定 / 未覆盖**：① 性能 13/15 桶达标；`warmPagination` p95 114.4ms、`warmListRefresh` p95 472.4ms（等待本次 RSC 刷新响应）超 100ms（真实值，未豁免；merge integrity 另含 unit-cost diag/scroll preSatisfied 工具待收敛项）；阈值未下调、未豁免，原样交回）；② 现役 126 商品全为 r1，历史版本切换 5 视口记 uncovered（多版本由隔离 fixture 覆盖）；③ 真实 200% 浏览器缩放 pending（CDP page scale 只改视觉视口，headless 无 UI；未用 DPR/小视口冒充）；④ v5 真实应用负向脚本未新增（15 类由合成 DOM 校准覆盖，v4 16/16 保留为历史证据）；⑤ 隔离 fixture 最终行为矩阵（V3-04 六态/跨账户、V3-05 0 项、V3-08 最终 lane 重跑）见 `.local/.../fixture/`；⑥ 两个 scripts 准备链缺口（recordOnly 未执行 014、increment manifest 命中跳过 DB 核对）如实未修（包外/需授权）。**未写入现役 126 样本/BS 530 行**。

## 商品库 UI 集中补修包 v2（历史，独审 `UI_REVIEW_NEEDS_FIX`）

**状态：`UI_IMPLEMENTED_AWAITING_INDEPENDENT_REVIEW`（2026-10-23）**。按 `.local/catalog/independent-ui-review-20261023/execution-repair-package-v2.md`（U1–U8）与同目录 [independent-review.md](../.local/catalog/independent-ui-review-20261023/independent-review.md)（R1–R10）实施；**不是 UI PASS**，未经独立复审。合并修复/验证矩阵 [repair-matrix.md](../.local/catalog/ui-repair-v2-20261023/repair-matrix.md)；U/R 逐项结果 [u1-u8-r1-r10-results.md](../.local/catalog/ui-repair-v2-20261023/u1-u8-r1-r10-results.md)；单一证据索引 [evidence-index.md](../.local/catalog/ui-repair-v2-20261023/evidence-index.md)；截图文字索引 [screenshots-index.md](../.local/catalog/ui-repair-v2-20261023/screenshots-index.md)。

**产品决定（U1–U8 摘要）**：日常详情改为固定外壳 + 三分区（商品资料/库存明细/变更记录），弹窗与直链共用；概览按 国内（未接入）/ 海外（当前仓已确认库存 + 同范围已估值货值）/ 在途（未接入）/ 已估值货值 组织，进货价移入商品资料；候选审计、原始 JSON、UUID/SHA、受限金额、证据下载退出日常详情，迁入授权维护页 `/dashboard/catalog/admin/evidence?item=`；包装不再默认展示/编辑（无来源列），尺寸按单产品/外箱分组并改用真实源列标签；列表移除工程横幅与重复小字，只留可点击「样表 · 日期」；底部分页支持页码直选且保持分页控件位置（不再滚回表头）；「新标签」收进「更多」；一级导航仅「ICE 商品库」，「数据维护/原始证据」按管理员权限进账户菜单，侧栏「其它处理入口」删除，旧 URL 保留安全引导；启用态新品/来源页面统一现役 UI，技术谓词只在授权维护层。

**执行方自验（非独立结论）**：UI 采集 **76/76**（1440/1100/635/短屏/缩放模拟；含三分区外框矩形一致、真实滚轮/键盘到底、关闭始终可达、技术块不存在、后退/关闭/切分区草稿保护、历史边界、R8 往返、账户/维护/待处理/旧入口/错误页/Demo 冒烟）；oracle v4 合成校准 **27/27**、真实负向 **16/16 拒绝**；20 样本 × 15 桶性能矩阵（4 轮）**14 桶稳定达标 / `detailWarehouseSwitchRealClick` 四轮 p95 113.0–159.8ms 均超 100ms；跨文档桶 3 轮各 1–2 例 90s 未就绪（独立 20 次直链探针 20/20 正常，未剔除样本）**（阈值未下调、未豁免，合并门禁 `allRequired=false` 原样交付）；暖复开 **81.4ms**（旧 289.5ms，取消真实详情缩放入场后达标）；浏览器主套件 **22/22（0 flaky）**；隔离 fixture：R4 四态 16/16×2、R6 注入 13/13+14/14（含直链 BS 失败就地重试与迟到响应）、R7 启用态 7/7+5/5+2/2、R9 启用页 8/8+2/2，现役库只读指纹前后一致；`tsc --incremental false` 全仓 5 条历史 BEST 基线（商品库 0）、`eslint --max-warnings 0` 0/0、单测 **457/458**（唯一失败为既有 `opt6-production-apply` 00051 换行豁免）、`git diff --check` exit 0。预览经 staging build → 校验 → promote → start，最终 BUILD **`7Qzv7GAew213N3WufdT_z`** @ 3011（pid 72784，`ownershipVerified=true`，源码快照 `3a1d5395…` 与 promote 一致）。ui 技能 `emil-design-eng` 已安装并记录版本/条款。

**待独立复审裁定 / 未覆盖**：① `detailWarehouseSwitchRealClick` p95 113.0ms 超 100ms 暖口径（真实点击库存分区顶部仓 chip + 服务端重新取详情；按原文保留失败）；② 维护页“非基线新品候选审计读取失败”**待确认项**（pw-suite 在 new-item C06 迁移后观察到 `catalog-audit-error`；fixture-lab 未能复现，根因未定位；错误文案已改为明确“不等于没有候选/不代表未启用/不是 0 项”）；③ new-item 3/4、source-identity 4/5 未在最终 BUILD 复跑，阻塞点与②同源（另 1 条为包外既有失效）；④ R7 “无事项（0 项）”未覆盖（fixture 自带不可变 unresolved scope，未伪造）；⑤ 200% 缩放为模拟、像素级视觉基线未建立。**未 commit / push / merge / deploy**，现役 126 样本未被写入。

## 商品库 UI 整体改造（历史包，已被 v2 补修覆盖）

状态：上一包 `UI_IMPLEMENTED_AWAITING_INDEPENDENT_REVIEW`（2026-10-23，F01–F17）；独立复审结论 **`UI_REVIEW_NEEDS_FIX`**，其 R1–R10 已在本包中处理，历史证据与报告原样保留（[delivery-summary.md](../.local/catalog/ui-overhaul-20261023/delivery-summary.md)、[f01-f17-results.md](../.local/catalog/ui-overhaul-20261023/f01-f17-results.md)、[独立复审](../.local/catalog/independent-ui-review-20261023/independent-review.md)）。上一轮 BUILD `GaK8dG26vW574fhA5gEBy`/pid 23136 已由本包预览更新替换；上一包结论不代表本次补修通过。

## 商品库 UI 整体改造（历史记录，F01–F17 原登记）

**状态：`UI_IMPLEMENTED_AWAITING_INDEPENDENT_REVIEW`（2026-10-23）**。按独立走查与任务包实施 F01–F17；**不是 UI PASS**，未经独立复审。交付摘要 [delivery-summary.md](../.local/catalog/ui-overhaul-20261023/delivery-summary.md)；F01–F17 逐项 [f01-f17-results.md](../.local/catalog/ui-overhaul-20261023/f01-f17-results.md)；证据索引 [evidence-index.md](../.local/catalog/ui-overhaul-20261023/evidence-index.md)；截图与文字说明 [screenshots-index.md](../.local/catalog/ui-overhaul-20261023/screenshots-index.md)；视觉转述 [visual-review.md](../.local/catalog/ui-overhaul-20261023/visual-review.md)。任务包与走查报告：`.local/catalog/independent-ui-plan-20261023/{execution-package.md,independent-review.md}`。

**已实施（摘要）**：详情改为固定 header + 唯一内部滚动体（F01，直链复用同一体）；列表 6 主列 + 次级展开 + 响应式（F03）；详情首屏概览（F04）；页码收敛与 URL 规范化（F05）；列表/直链/管理分页错误恢复（F06）；弹窗与直链共用业务投影与附件组件（F07）；一级导航收敛 + 只读问题索引 `/dashboard/catalog/issues` + 旧入口安全引导（F08）；弹窗内切仓与历史/来源上下文（F09）；面板内距/控件/焦点环统一（F10）；来源证据中文摘要 + 原始编码可展开（F11）；管理页默认只读结构化、JSON 在技术层（F12）；编辑资料入口与“当前值/拟采用值/依据/理由 + 留空 vs 明确清空”（F13）；主栏中文角色/能力说明/退出可访问名（F14）；图片与缺值分档文案（F15）；金额统一格式（F16）；删除 3 个无引用文件并同步导航断言（F17）。

**执行方自验（非独立结论）**：UI 采集 **87/87**（1440/1100/635/短屏/200%，含真实滚轮到底、Tab 焦点不逃逸、Esc、六仓、分页/越界页码、深链刷新、前进后退、弹窗切仓、错误页、待处理/账户/管理/编辑/来源/旧入口）；新 oracle v3 校准 **22/22**、真实负向 **15/15**；浏览器回归 **18/18（0 flaky，隔离 build + source-drift）**；`tsc --incremental false` 全仓 5 条（历史 BEST 基线，商品库 0）、`eslint --max-warnings 0` exit 0、单测 **445/446**（唯一失败为 AGENTS 已登记的 `opt6-production-apply` 00051 换行既有豁免）、`git diff --check` exit 0。预览经 staging build → 校验 → promote → start 三次，最终 BUILD **`GaK8dG26vW574fhA5gEBy`** @ 3011（pid 23136，`ownershipVerified=true`）。

**未达标 / 待确认（必须由独立复审裁定）**：① 性能 9 桶中 **7 桶达标、2 桶超 100ms 暖口径**——`listFirstWarm`（客户端导航回列表）p95 **504.6ms**、`detailModalReopenWarm`（暖复开）p95 **289.5ms**；阈值**未下调**，合并门禁 exit 2 原样交付；② 隔离 fixture 的写入验收（F13 保存四态、F07 启用模块两入口一致、F06 故障注入）**未执行**；③ Demo 浏览器冒烟未跑（Demo 应用代码未改）；④ 历史版本逐版本视觉未截图；⑤ `warehouseSwitchInModal` 保留单样本 **1033ms** 长尾（p95 58.3ms 达标）。**未 commit / push / merge / deploy**，现役 126 样本未被写入。

## 商品库 Demo 界面与访问性能（历史 PASS，U3）

**商品库 U3 — `U3_LOCAL_UX_PERF_PASS`（独立复审通过 2026-10-23）** — 独立报告 [independent-review.md](../.local/catalog/independent-ux-perf-u3-final-20261023/independent-review.md)；执行摘要 [progress9-delivery-summary.md](../.local/catalog/ux-perf-u3-20261022/progress9-delivery-summary.md)；证据 [evidence-index.md](../.local/catalog/ux-perf-u3-20261022/evidence-index.md)。**通过范围**仅限本地样表商品库的交互、缓存恢复、性能测量与验收门禁；**不代表**新 UI 打磨完成、真实来源接入、生产发布或全 ICEOS 验收，既有 **`LOCAL_PREVIEW_PASS`** 原范围不变。独立审查关闭三项：**R1** 冷门禁改以 `listSample/detailSample.contentReadyMs` 为唯一输入（摘要须等于 `Math.round(原始值)`，缺失/NaN/Infinity/矛盾即拒绝；执行方合并负向 51/51，独立另跑 26 项边界），用新验证器（`f8dcd797…`）复算 `runs/progress8-final5` 原始证据 → **`allRequired=true`**（原始暖 `cab3706e…`、冷 `d8cd3cfc…`、fixture `2ae987d1…` 未改写；旧验证器 `ed717297…` 单独留存）；**R2** runner 校验 `completed===126`、`completed↔itemCount`、`readOnlyEvidence.transactionReadOnly==='on'`，真实 spawn **11/11**（独立另跑 6 项边界，生产 attempts/latest 前后不变）；**R3** 全仓 tsc 总诊断 **21→5**，当前商品库 **16→0**，历史 BEST 测试 **5 条**按范围保留（不声称全仓 tsc 通过；`next build` 过滤 `*.test.*`，不能替代）。执行自验 `runs/progress9-verify-20261023-final/selfverify-steps.json` 8/8 exit 0；BUILD 未变（**`Jq2Y6jz_l7sFTKfSUPYkF`** @ 3011 pid 42900，未重建/未启停）；继承 **126×252 / 0 差异**（progress5 attempt，未重跑）与 **`LOCAL_PREVIEW_PASS`**。

证据分层（勿混记）：**本次独立重跑**＝合并器 51 项正负向、26 项冷门禁边界、runner 11 项测试与 6 项边界、实际 tsc、19 项单测、eslint、diff-check、冻结原始数据复算、编译凭据/文件漂移、只读进程归属；**沿用上一轮同审查方独立结果**＝loader cache 7 + recovery 5、oracle 校准 3/3 与内容判定 25/25（应用未改）；**执行日志核验/继承**＝完整 Playwright 17/17、暖 15×20 矩阵、3 次冷进程、staging build/promote、126×252 只读候选等价，本轮只复算原始数据，未重新采样或重启。progress8 的 `allRequired=true` 在其原计时门禁下保留为历史结论，progress9 起以原始计时重算复核；progress7 的 `allRequired=true` **不能作为通过依据**（计时在 DOMContentLoaded 重开、首开前等 audit-ready、负向捕获初始化异常、`sourceHashes` 回填、详情预取失败自循环）；progress6 `allRequired=false` 为旧串行断言计时；progress5 `allRequired=true` 为**旧不完整断言口径**。

**既有失败与遗留（不影响本期范围）**：全仓 tsc 仍有历史 BEST 测试 5 条诊断（`src/lib/providers/best/__tests__/client.test.ts` 3 条、`dry-run.test.ts` 2 条，均 TS2352），按用户范围不修；p95 通过伴随 WM0005 单次 **4377ms** 尾延迟，保留事实，不宣传每次即时展示；根目录历史 build 与全量旧回归不因本报告变成全绿。**下一会话**：新版 UI 打磨、新品/来源核实问题触发式入口与进一步清理，本轮不扩开发。

## 本地真实商品预览（历史 PASS）

**`LOCAL_PREVIEW_PASS`** — 本包独立验收完成（[最终独审](../.local/catalog/independent-local-preview-final-20261021T084549Z/independent-review.md)）。通过范围：本地真实商品及本批样表库存预览（126 资料、BS 530 展示、六仓、已确认口径货值、启停与测试证据）；**不代表**实时同步、生产启用或全库 ICEOS 已交付。索引：[local-preview-delivery-index.md](./catalog/local-preview-delivery-index.md)。

**最终独审核验（2026-10-21）**：独立重跑 VM 控制流探针 9 场景 exit 0；独立重算短程 before/after 各 126 行投影 SHA 均为 `330125d4fdf1cddb00b2630822edfdcc87b6ac6cd3f21d9519e1abe2048de0fe`，时间顺序有效；只读 status/登录与进程归属通过（审查时点 PID 与短程记录可不同，见 delivery-index）。短程原始 JSON、历史全链自验与商品/估值/RLS 门禁结论为**原始日志核查或继承**，本轮未重跑 prepare、完整自验或业务回归。

**Git**：catalog 积压与 closeout 测试已推送 `codex/ice-v4-planning`（manifest §4；`package.json` 在 **acb4865**）。本包累积成果（Legacy 封存与删除、ICE v4 外壳、商品库 UI/缓存/性能、013–014 增量、预览工具链、测试与文档）已在独审通过后按依赖分批提交并 push `codex/ice-v4-planning`，未 merge/deploy；提交清单与远端 SHA 见 `.local/catalog/ux-perf-u3-20261022/final-closeout/closeout-record.md`（证据目录不入库）。`.local` 证据与凭据不入库；Git 无待提交变更不等于本地实例/缓存已清理（见 [工作区盘点](../.local/catalog/workspace-git-audit-20261021/workspace-git-audit.md)）。

## 来源身份N1A与持续新品N1C（保留）

**N1A_LOCAL_PASS保持；N1C_LOCAL_PASS仅表示本地隔离独立通过。** 依据[N1C独立总报告](../.local/catalog/independent-new-item-review-20261021T015312Z-e38782af/independent-review.md)登记，原[执行交付](../.local/catalog/new-item-delivery-20261020T142050Z-85800652/delivery-index.md)及其待审时点报告原样冻结，不改写历史。已实现八表/七写动作/五SQL、固定商品观测、四分流、缺码新品、同来源slot复用、证明关联/后补身份及非价修订；不等于整个商品系统、真实接入或生产完成。

独立实际重跑 `run-20261021T015418Z-3825abe1`：C34领域/23PG/4浏览器、A兼容46/19/5、未装A/C旧首包41/12/2和三隔离build全部通过，浏览器无跳过/flaky；另34项独立追加探针为C01封套25项与C09直接成员关联9项，不混入原门禁计数。独立报告记录14,764文件起止零变化，6门禁PG＋2探针PG及3Next停止、数据保留；执行方22PG/9Next停止另列，不混计。本轮仅文档登记，没有重新运行上述测试或启服务。

独立审查对lint退出0、普通回归4132通过/1项既有OPT6失败、直接tsc54旧诊断仅核执行日志，未独立重跑；三build确已独立重跑。框架Page/RSC/Action按批准no-store合同验证，无效Cookie配置已撤回；自有raw/export GET的private/no-store/Cookie实际断言通过，但原GET headers未单独归档，不能声称逐份原始头重解析。

126资料、1417来源、548具体原目标/JST与全部历史、3160 CSV/6190历史索引、147完整产物/129子集保持。原122缺码同UUID，C127仅虚构测试；WM0072采用5.18/5.68与来源观测5/5.5及历史、金融指针、两刷子、未建档及public三表保持。P0_01/02/03_PASS、P0-03收尾、商品首包与N1A结论全部继承。

真实身份核实0、relationshipUsable=false、飞书partial；B provider仍为接口fixture，长期关系和库存未启用。本轮只改三入口当前区，[文档收尾证据](../.local/catalog/docs-closeout-20261021T020835Z-869e3fc6/delivery-index.md)另存，历史尾部及原交付/独立报告/源码SQL测试配置保护。登记与只读复核后双方停止，不准备或启动N1B/N2/真实采集/长期关系/库存或下一任务；不清场、桌面操作、记忆写入、提交推送部署。

## 商品资料首包（已独立签收）

首包及R1/R2/R3已[独立复审通过](../.local/catalog/independent-repair-review-20261020T094514Z-bd17af9f/independent-review.md)，仅本地隔离范围。[补修报告](./catalog/verification-report-repair-20261020T092115Z-2b8397ed.md)、[原首包报告](./catalog/verification-report-run-20261020T081620Z-2a2cc8e4.md)及旧CHANGES_REQUIRED保留。旧独立实际重跑41领域/12PG/2浏览器/隔离build，另5PG探针/2恢复流程；lint/普通回归/tsc当时仅核执行日志，不混为本次独立重跑。桌面33份原地保留、归档0的独立结论保持，本轮没有重扫。

## P0-03 状态

阶段状态：**P0_03_PASS**。[独立总验收报告](../.local/p0-03/reviews/evidence/independent-final-acceptance-20261020-49c832b7/independent-review.md)已确认本期有限范围通过，文档收尾完成。通过范围为产品主库整理、商品身份标准、本批样表对应与人工决定保存、输出一致及历史可追溯；不代表全部产品资料已核实或后续接入与库存使用已实现。

- 规则唯一正文：[商品身份标准v1](./product-identity-standard-v1.md)，已同步当前事实与刷子后续保留要求；未修改已批准身份原则，未实现数据库唯一约束。
- [本轮任务](./tasks/p0-03/2026-10-20-final-acceptance.md)、[明确决定JSON](./p0-03/final-decisions-20261020.json)、[总验收报告](./p0-03/verification-report-p0-03-final-acceptance-20261020.md)。
- [唯一最终输出](../.local/p0-03/run-20261020-final-acceptance/evidence/final-2026-10-20T03-41-45-834059Z-cd7d4d19/delivery-final-v2/)，覆盖在其coverage/；首版delivery-final、再生和负向输出仅作证据，不是并列现行结果。
- 业务基线为最新已独立通过的JST交付，bundle SHA256 `3c2babc9b13ca11fab14cb4bbce5e8617052319d06bc80c922256f6893346159`、有效CSV `48544cd03154131970fce220fb2ff7c704e18d7860e2ea7c72e6a0ef1ac8d921`已核对。只继承该CSV，不重建桌面决定，不重跑匹配替换基线；新输出及决定哈希见报告。

已落实：菲越376/380/526三条WM0012确认升级普通版、解除版本待决、原目标不变，不计新增；JST WM0006/WM0008本批ignore且目标空，理由仅用户要求本批忽略；JST857行WM0130确认主库121行；BS菲越220/321两条WM0073新确认主库67行，当前confirm覆盖旧defer并保存历史。六项规格说明关闭：两项本批忽略，WM0031/WM0062/WM0098/WM0130采用主库C列，不改原名称/数值、不换算g/ml；WM0062 JST789行reject保持。刷子WM0081原62与brush原107行分列可见，继续待确认。

实际重算：126份主资料、125非空唯一ICE货号＋1缺码新品，1417来源（BS530/JST887）；548有效选择＝BS430＋JST118，较原545新增3；覆盖114双方/2仅BS/4仅JST/6双方暂无确认，有选择120份。774待核对、1候选、3拒绝、3忽略、88规则外；一般未核对775。原545目标/JST引用、原22条完整记录、原11JST确认、WM0007ignore、WM0070/WM0072 BS未建档、WM0072现价5.18/5.68及两版历史保持。8来源、9份总览审计/来源ID、216完整字段变化均可追溯；主资料业务字段未改。

当前菲越版本待决0、六项规格open0/closed6，指定业务决定全部落实。继续延期：WM0081与brush及5条BS刷子/1条JST候选不合并不猜绑；新品缺码、工厂/其他缺失、图片内容未核验、一般未核对及未涉及拒绝/规则外/纠错保持。图片128锚点、123份找到对象/3未找到不表示内容已核验或真实无图。BS70/72等待建档正常，不造来源或0库存。后续正式系统也须保留两份刷子及待确认状态，本轮只登记要求。

本轮执行实际重跑：136回归（原121＋15）、完整P0-03门禁、1417/126全量与所有保存投影、21组新业务负向＋原12组在新结果重跑、原16组在历史JST基线重跑、历史审计28/32与新44组负向、10图片测试、2审计CLI保护、6本地文件实际浏览器、147份逐字节再生成、lint/build及保护/文档/diff检查通过。完整命令和退出码在报告；初检失败、首版差异路径修复及既有openpyxl/NFT/Git提示保留，不把初检失败隐藏为全绿。

独立总验收实际重跑：136回归、1417/126全量及原545目标/JST引用/原22条/3160行CSV、21＋12＋16组业务负向、新44及历史28/32组审计负向、10图片测试、6本地文件浏览器、147份逐字节再生成、2审计CLI保护和范围/链接/diff检查均通过；另有19项冻结基线探针及原Excel OOXML逐格、逐份覆盖和仓库汇总核算。完整P0-03门禁、lint、build由独立审查仅核查执行日志，未独立重跑。本次文档收尾仅做链接、一致性及diff检查，未重跑功能测试，不与前两次验证混记。

历史独立通过保留：[主库整理](./p0-03/verification-report-p0-03-curation-20261019.md)、[四项确认](./p0-03/verification-report-p0-03-confirmations-20261019.md)、[两项审计说明补修](./p0-03/verification-report-p0-03-coverage-audit-repair-20261020.md)、[11条JST确认、WM0007忽略及BS未建档说明](./p0-03/verification-report-p0-03-jst-confirmations-20261020.md)及其[独立报告](../.local/p0-03/reviews/evidence/independent-jst-confirmations-20261020-dce89074/independent-review.md)。原CHANGES_REQUIRED、执行自验、独立重跑和仅日志核查各自保持，不改写成同一次检查。本轮此前停于P0_03_IMPLEMENTED_AWAITING_REVIEW，现依据独立总验收登记P0_03_PASS，不由过去分批通过推定整体结论。

后续方向：飞书表格识别新品；BS通常新品发出时建档，可以晚于主库/JST，BS匹配不以JST成功为硬前提；飞书接入方向获确认、BS考虑抓取、JST API可用性待核实。正式关系保存、自动复用、数量归集、组合/换款、库存同步和估值仍未实现且不在本批；不指定飞书全部字段为最终主数据源，不猜货号生成方式。

停止于**P0_03_PASS（文档收尾完成）**，上述已批准延期不阻塞本期有限范围验收；不要求所有商品同时具备两系统对应或全部空值补齐。全部旧报告/证据、原始资料、HOLD和其他未提交修改保留；neat-freak仅本次五份文档对齐，不清场、不写记忆。不入库、不接真实服务、不发布/同步库存、不提交/推送/合并/部署或推进下一阶段。

## P0-02 状态

| 项 | 状态 |
|---|---|
| 现役结论 | **`P0_02_PASS`**（独立审查 @ `9507d86`，2026-10-15） |
| 正式 PASS 报告 | [verification-report-p0-02-pass-20261015.md](./p0-02/verification-report-p0-02-pass-20261015.md) |
| 审查目录 | `.local/p0-02/run-20261014-r2/reviews/independent-p002-delivery-9507d86-20261015-01/` |
| Canonical Run | `run-20261014-r2` |
| 执行方总验收（历史） | `npm run check:p0-02` exit 0（`check-2026-10-15T07-07-04-252Z`） |
| Postgres 规模 | **18** vitest 文件 / **61** 项（**56** PG + **5** config） |
| Browser A3 | **21** 项 Playwright（check 子证据） |

**历史（非现役）：** d082728 审查 **CHANGES_REQUIRED** → 返工交付 **IMPLEMENTED_AWAITING_REVIEW** → 9507d86 独立审查 **PASS**。实施报告：[verification-report-r2-20261015-d082728-rework.md](./p0-02/verification-report-r2-20261015-d082728-rework.md)。

## P0-01 状态（保留）

**P0_01_PASS** · Run `run-20261013-r1`

opt6：**1 failed / 5 passed**（00051 换行，未改；全门禁已知固定豁免）。

## 阶段边界（2026-10-15 用户确认）

- **已完成：** 保留功能脱离 Supabase、本地虚构数据下的独立平台验收（**P0_02_PASS**）。
- **不迁移：** 不迁移旧 Supabase 业务数据，不沿用旧 SKU/商品映射（用户已确认，非延期项）。
- **后续：** 正式账号与权限重建、真实来源接入与用户重新匹配、生产启用；满足既定前置条件后删除旧 Supabase 环境。
- 详见 [product-plan-v4.md](./product-plan-v4.md) 与 [architecture-v3.md](./architecture-v3.md) 的 P0-02 后续方案节。

## 文档清理（2026-10-15）

已删除过时的 DIS 内网部署方案（commit `77b2c4d`，用户单独授权）。现役部署以 [architecture-v3.md](./architecture-v3.md) 与 P0-02 为准。
