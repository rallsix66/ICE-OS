# Current Task Packet

> 2026-10-29 追加：三页 UI 整备 v1 已在本地实施并通过商品库浏览器主套件 22/22；未提交/未推送/未部署。范围、构建号与证据见 [ui-refresh-v1.md](ui-refresh-v1.md)。
> 2026-10-30 追加：三页 UI 第二轮（表格排序/显示列/列宽、自定义下拉、待处理页瘦身、商品汇总详情重做、同步详情/设置改抽屉）已完成并在 3011 验证；未提交/推送/部署。范围见 [ui-refresh-v1.md](ui-refresh-v1.md)。
> 2026-10-30 晚追加：三页 UI 第三轮（裸链接按钮化、列宽拖拽重做与百分比列宽、工具栏/列顺序统一、商品库详情过渡、库存来源改名 BigSeller/聚水潭、删实物列加估算货值、两表详情按钮）已完成并在 3011 验证（BUILD `Em1LtKpUBa7DSmmusfOH0`，定向 54/54、商品库 Playwright 22/22）；未提交/推送/部署。范围见 [ui-refresh-v1.md](ui-refresh-v1.md)。

## 当前任务：详情内绑定编辑、界面减字与复核结果采用 v1

状态：**CATALOG_BINDING_REVIEW_V1_LOCAL_PASS**（2026-10-29 原线程独立复审通过）。[原合同](catalog-binding-inline-edit-v1.md)、[最终独立报告](../../.local/catalog-binding-r1-r4-independent-20261029/independent-review.md)。R1–R4四项阻断已关闭，无剩余功能补修；已正确的510条匹配及当前库存保持，原三页签、减字和两方向逐来源编辑均保留。

独立验证包含实际模块R1/R2共5例、正式/克隆库只读33项、3011真实页面与构建逐文件核验；执行方隔离写入/下一批fixture经审读并回读现存克隆库后沿用，未重跑无关旧套件。8组业务投影快照一致；具体证据覆盖及交付措辞更正见最终报告。

当前BUILD **`3DRd1EmVjPgeWE7tIkKI_`**、源码`debe1eeb…`、620源/415产物、drift=false、login200；映射517（512/5）、请求104、国内决定5、国内有效选择123、商品126/修订128。独审未改正式关系/库存事实/worker/60分钟计划，未试绑正式数据或手动同步。通过不含121忽略页、200%、未来权限、新API、公网部署与旧延期项；2026-10-29 文档与 Git 收尾：实现与文档已按依赖顺序提交并普通推送 `origin/codex/ice-v4-planning`（本地与远端一致；未合并/部署/清场），原输入、备份、克隆库和证据全部保留。

两个绑定入口（商品库详情→库存明细→仓库行；商品库存详情→具体仓库/SKU 行）、已采用 510 条复核结果、运行入口、证据位置与提交号见[合同 §11](catalog-binding-inline-edit-v1.md)。

## 最近已验收：商品库存与同步 UI v1（文档与 Git 已收尾）

2026-10-28 补充规则与离线复核：用户批准[菲律宾彩妆货号附带色号](../product-identity-standard-v1.md#ph-makeup-shade)，已登记并在本地 HTML 重新匹配。[验证记录](../../.local/three-table-view-20261028/verification-ph-color.md)。本轮只更新离线复核产物与规则文档，未改现役服务或正式绑定，不重开以下已验收包；正式系统应用待后续实施，规则文档已在 2026-10-29 收尾中提交并推送。

2026-10-28 主审独立复审通过：**`INVENTORY_SYNC_UI_V1_LOCAL_PASS`**（收尾状态 **`INVENTORY_SYNC_UI_V1_DOCS_GIT_CLOSED`**）。T1–T3 全部关闭，本包不再新增功能返工；已通过布局、分页、采用身份、PH 双码提示和草稿语义沿用。 [独立报告](../../.local/inventory-sync-ui-tail-independent-20261028/independent-review.md)、[尾项验收说明](inventory-sync-ui-v1-tail-repair-acceptance.md)。

主审真实点击确认：未知市场/指定海外仓详情不混国内；仅国内 WM0026 仍为 5,100（文件 2026-10-15），全部无筛选仍分区。旧量 247 与旧 16:22 时间通过独立单个只读受控链（非正式库自然缺行）。同步任务点击/刷新/切换后标题均位于 720px 视口顶部约 13.2px，计划时间正确随所选任务变化，手动收起正常。

现役 3011 BUILD **`ElaITcTkEMZyYxyRD1CaS`**，源码/编译快照 `6f0faba622bd53ae…`、417 产物独立一致、无漂移；现役 read_inventory_item 与当前 016 一致（定义 `8e78ba3b…`，文件 `55922bc9…`）。原全表/映射/性能等可信证据沿用，未重复全套。

通过仅限批准的本机库存双视图与同步 UI，不是公网发布、全 ICEOS 验收、未来员工权限或新 API 接入完成。审查未改业务/SQL/worker/计划/正式对应/库存事实，未保存设置或手动同步。保留所有数据、原表、旧构建、隔离库、脏文件和历史证据。

文档与 Git 收尾（2026-10-28）：已按依赖顺序提交并普通推送 `origin/codex/ice-v4-planning`（本地与远端一致，未 force/合并/部署/清场）；`.local`、私有输入、数据库与构建产物未入库。提交范围、日常入口、构建/启动/恢复材料与国内快照输入依赖见[库存与自动同步实现/运行说明 §0.11](../inventory/inventory-sync-v1.md)。

**旧包无剩余修复项。** 原 T1–T3 清单为已关闭历史；本次用户新增需求按顶部新合同执行，不改变旧包验收范围。

### 上一状态（历史）：`INVENTORY_SYNC_UI_V1_FINAL_REPAIR_NEEDS_FIX`

2026-10-28 独立复审：S1–S4 主要修复有效，只剩 T1 未知市场/指定海外仓详情仍混入国内、T2 商品汇总详情本次未见旧时间漏传、T3 同步任务展开后未定位视口。当时 BUILD `HZmMgkE6tlWlGBxM3OgLw`（源码 `6f89fe4d…`、417 产物、无漂移）。上述三处已由尾项修复及独立复审关闭。

### R1–R6执行交付（历史自验，以下不是当前完成裁定）

**状态 `INVENTORY_SYNC_UI_V1_REPAIR_IMPLEMENTED_AWAITING_INDEPENDENT_REVIEW`（2026-10-27 执行方自验交付，不自行宣布 PASS）。** 依据[集中补修](../../.local/inventory-sync-ui-independent-20261027/remaining-repair.md)（R1–R6，含用户人工视觉验收）与[独立报告](../../.local/inventory-sync-ui-independent-20261027/independent-review.md)；原合同[inventory-sync-ui-v1.md](inventory-sync-ui-v1.md)继续有效。本轮[验收说明](inventory-sync-ui-v1-repair-acceptance.md)；[交付摘要](../../.local/inventory-sync-ui-repair-20261027/delivery-summary.md)、[证据索引](../../.local/inventory-sync-ui-repair-20261027/evidence-index.md)、[恢复说明](../../.local/inventory-sync-ui-repair-20261027/RESTORE-NOTE.md)、[保护说明](../../.local/inventory-sync-ui-repair-20261027/PROTECTION.md)。上一轮自验[inventory-sync-ui-v1-acceptance.md](inventory-sync-ui-v1-acceptance.md)保留历史。

已实现并自验：R1 来源范围统一约束查询/行/计数/列（国内 118、海外 116、全部 120；无独立市场下拉；未知市场 `__unknown__` 准确定位；下钻时不混入国内行/列）；R2 读模型以每仓最后完整批次全部行为来源事实底，adopted/pending_adoption/inactive/unmapped 分开表达（正式库 650=430+220+0+0 逐值 0 差异；隔离库 WM0094 pending 133739/132949 且不计入汇总）；R3 市场格移除未获批准的“整仓可用”合计；R4 正式对应唯一入口为商品库维护页，目标商品/仓/SKU 定位 + back 白名单真实往返；R5 首屏去说明墙、固定表头/商品列/分页、单一详情抽屉立即可见/Esc 回原位、可直接跳页；R6 同步首页每来源一行、详情与设置按需展开。

现场：3011 BUILD **`6h01rzCy_6foml5S6u1HH`**（源快照 `8077fb3ad5da34c5…`、drift=false、417 产物、login 200、pid 60280）；022 文件 sha `9f3c5a60…`，schema v6/`functions_sha256=0c551192…`；worker/60 分钟计划/7 仓/430 正式对应/库存事实未改，18:22 自然批次成功（下次 19:22）。验证：真实点击 **47/47**、读模型对账全项、隔离库样本、tsc 仅既有 BEST 5、改动文件 eslint 0/0、diff 0、`tests/inventory` 纯逻辑 162 通过；截图 12 张与逐图文字说明见交付摘要。未覆盖：inactive 无真实样本、pending_adoption 未在浏览器演示、确认后下一批采用沿用 A1 证据、汇总宽表横向滚动、设置面板需页面滚动、200%/断网/多机/权限矩阵等。

下一交审点即上述状态；不自行 PASS、不另开功能、不提交/推送/合并/公网部署/清场或写记忆。正常自动同步继续，全部历史证据和隔离现场保留。

### 上一状态（历史）：`INVENTORY_SYNC_UI_V1_NEEDS_FIX`

2026-10-27 主审独立复审未通过：当时 BUILD `FmTvwhh6Lepdd7MSjJuwJ`。人工验收进一步明确：删除独立市场下拉；每行合并一个详情入口，点击立即打开可见弹窗/抽屉；表格固定表头、商品列和分页底栏；移除库存说明墙；同步首页改为每来源一行，详情与设置按需打开。该状态已由上方 R1–R6 补修取代。

## 最近已通过：商品库存响应速度优化v1

**`INVENTORY_RESPONSE_SPEED_V1_LOCAL_PASS`（2026-10-27 主审独立复审通过）**。[独立报告](../../.local/inventory-response-speed-independent-20261027/independent-review.md)。该速度包已收尾，无需返工；网页构建已由上方界面任务替换为 `FmTvwhh6Lepdd7MSjJuwJ`。

主审正常app角色只读实测：50行列表227/186/171ms，WM0026详情106/102/104ms；独立重新比较三组原始新旧输出，各288用例、116商品详情、0差异。主审实际搜索、全仓/越南详情、列表行收起、第二页展开/收起和刷新正常，MY待核0行/PH双码分别展示仍保留。执行方同批页面中位约0.4–0.5秒的原始证据核算沿用，不冒充主审再次采样；冷加载点击为单次540ms，普通打开不是空缓存冷启动。SQL第2页优化前中位/最慢应为3440/3443ms，已校正文档。

3011 BUILD `p7im9R07D7iqkV_2mNKNJ`：600源码文件、407编译产物及55个部署函数体一致，schema函数哈希`0c551192…`。worker PID42072/冻结源/60分钟计划未变。15:05只读现场仍为14:22自然批次、430正式对应/430有效行。本轮只新增独审证据并同步文档，未改业务代码/数据/运行态，未重跑无关套件。两个一次性验证库及所有旧证据保留；未提交/推送/合并/公网部署/清场/写长期记忆。

### 本轮执行方交付记录（历史自验，已由上述独审裁定）

**`INVENTORY_RESPONSE_SPEED_V1_IMPLEMENTED_AWAITING_INDEPENDENT_REVIEW`**（2026-10-27 执行方自验交付，待独立审查，不自行宣布 PASS）。[任务包](inventory-response-speed-v1.md)、[验收说明](inventory-response-speed-v1-acceptance.md)、[交付摘要](../../.local/inventory-response-speed-v1-20261027/delivery-summary.md)、[证据索引](../../.local/inventory-response-speed-v1-20261027/evidence-index.md)、[恢复说明](../../.local/inventory-response-speed-v1-20261027/RESTORE-NOTE.md)；只读诊断 [查询](../../.local/inventory-speed-review-20261027/reads.md)、[前端](../../.local/inventory-speed-review-20261027/frontend.md)。

**已实施**：`db/catalog/016_inventory_sync_functions.sql` 改为一次请求内建读取上下文并批量汇总（新增 `inventory_read_context` / `inventory_item_gaps` / `inventory_item_summary_core`，列表与详情复用同一核心；旧 `inventory_item_summary` / `inventory_item_warehouse_gap` 保留原签名作包装），未加跨请求缓存/新表/新授权入口，返回字段、排序、分页、搜索、筛选和错误语义不变；`src/features/inventory/components/inventory-view.tsx` 修正列表行“收起详情”地址（已展开时去掉 `item`，保留搜索/仓库/市场/页码）。
**同批实测（正式3011，批次 `0f4b73bf…`，3样本中位）**：50行列表 SQL 3492→193ms、页面 3442→420ms；10行 734→97ms；第2页 3798→403ms；搜索 391→389ms；仓库筛选 1708→410ms；打开详情 3892→444ms；收起详情 3814→467ms；冷加载立即点击 3978→540ms。
**一致性**：隔离副本同快照 288/288 读取用例 0 差异；正式库安装前后 288/288 0 差异；一次性夹具副本（失败/本次未见+上次已知/待采用/单位冲突/资料版本缺失/验证标记）288/288 0 差异 + 15/15 分支检查；真实页面链 34/34。
**现场**：BUILD **`p7im9R07D7iqkV_2mNKNJ`**（快照 `ed64515d…`，web pid 88024，sourcesMatchBuild=true）；schema version 6，functions `0c551192…`（由 `c36c90a0…` 更新）；worker 未重启（pid 42072，冻结源 `1db4017a…`）；60 分钟同步未改（next 15:22）；业务数据/430正式对应/历史/原 Excel/其它实例与旧证据未改。
**验证**：tsc 仅既有 BEST 5（库存 0 新错）、改动文件 eslint 0、inventory 纯逻辑 109/109、staging build 成功、`git diff --check` 0。未重跑旧15×20、BigSeller/R2、A1/B/C、备份恢复、多机并发、200% 等无关套件。
**未做/限制**：未做客户端局部刷新（页面已约0.4–0.5秒，按任务包停止；页面请求数与优化前相同，仍整页导航）；详情正式库残余约0.10–0.11秒；少量样本不是 p95；未提交/推送/合并/公网部署/清场/写长期记忆。停止点即上述状态，最终由独立审查裁定。

### 2026-10-27 诊断状态（历史，已由上一节实施取代）

原 `INVENTORY_RESPONSE_SPEED_V1_READY_FOR_EXECUTION`：主审只读诊断 50 行列表约 3.94 秒，瓶颈为列表请求内部重复读取与列表行收起错误链接；执行方按该范围完成批量读取与收起地址修正。

## 上一任务已通过：BigSeller正式本地接入与统一库存入口v1（独立验收通过）

**2026-10-27 主审独立复审通过：`BS_LIVE_INTAKE_V1_LOCAL_PASS`。** [独立报告](../../.local/bs-live-intake-r1-text-independent-20261027/independent-review.md)。R1 最后一处错误空态已关闭：主审实际走查 3011 的 WM0026 越南、MY、菲律宾，正常采用行不再显示“暂无已采用”；1853、672及待核0行、3119/4138双码分别展示和待合计说明均保留。失败旧值/旧时间等分支源码未改，既有受控探针核读沿用，未制造真实失败。

3011 BUILD `MB1i1eT7pYCsG8qdb1iea`，600个构建清单文件一致；唯一业务改动为现有组件+2行。worker PID42072、创建时间及9个冻结文件一致。本轮未连数据库、未触发导出、未重启或改计划；430正式对应/数量对账/R2/定时同步与A1/B/C沿用前轮可信独审，不重跑无关套件。**本机正式接入与统一库存入口v1收尾，无新增修复包。** 未匹配归属、PH双码合计口径、货值暂未计算及旧投影观察项保持原边界；数据、旧现场、失败证据全部保留。本地通过不等于公网部署或全ICEOS验收。

### 2026-10-27 R1说明条件执行交付（历史自验记录）

**2026-10-27 执行方完成 R1 说明条件收尾：`BS_LIVE_INTAKE_V1_R1_TEXT_IMPLEMENTED_AWAITING_INDEPENDENT_REVIEW`（执行方自验，不自行宣布 PASS）。** [本轮交付摘要](../../.local/bs-live-intake-r1-text-20261027/delivery-summary.md)、[证据索引](../../.local/bs-live-intake-r1-text-20261027/evidence-index.md)、[恢复说明](../../.local/bs-live-intake-r1-text-20261027/RESTORE-NOTE.md)、[任务包](bigseller-live-intake-v1.md)、[独审最小收尾](../../.local/bs-live-intake-repair-independent-20261027/remaining-repair.md)。

**唯一日常地址仍为 http://127.0.0.1:3011**：`run-20261026T211500Z-11a22b33` / PG 59345 / 库 `iceos_catalog_run_20261026T211500Z_11a22b33`；最终 BUILD **`MB1i1eT7pYCsG8qdb1iea`**（无 drift）；worker `inv-worker-59345` 未重启（pid 42072，冻结源 `1db4017a…`）；自动同步 **开启、60 分钟**（next 11:22，最近成功 10:22 自然计划 `22fcb140…`）。

**本轮已实施**：仅改 `catalog-detail.tsx` 的 `scopeReason`（+2 行）：正常 `current` 且有采用行时返回 `null`，不再显示“本仓暂无已采用的 BigSeller 库存行”；failed（保留错误码+上次成功时间）、unseen、unmapped_source、no_source、MY 待核 0 行、PH 双码待合计、真正列表/详情不一致提示全部保留。真实页面 42/42（越南/全仓→越南/MY/菲律宾；4 条新增“有采用行不得出现暂无采用”断言；10:22 批次数值正确且不写死）；`scopeReason` 只读探针确认正常三仓空、异常分支说明保留。tsc 本包 0 新错、eslint 0/0、diff 0、构建无 drift。**未做**：未改数据库/worker/同步计划/其它实例；未重跑 R2、原 R1 四项、A1/B/C、备份恢复、并发/性能/权限/200%；业务待决与 `inventory_current` 观察项原样。未提交/推送/合并/部署/清场/写长期记忆。

### 2026-10-27 R1/R2 独立复审快照（历史，非本轮结论）

**`BS_LIVE_INTAKE_V1_NEEDS_FIX`，只剩 R1 一处错误空态说明。** [独立报告](../../.local/bs-live-intake-repair-independent-20261027/independent-review.md)、[唯一最小收尾](../../.local/bs-live-intake-repair-independent-20261027/remaining-repair.md)。R2 `clean brush` 截断已修并独立通过；R1 单码状态、覆盖、切仓、待核0行已修好，但正常单仓仍同时显示“本仓暂无已采用的 BigSeller 库存行”。WM0026：越南1853、MY672、PH3119/4138均真实已采用、数量差额0。独立10:33快照：3011 / PG59345 / 当时 BUILD `IbVHV6BZXFtK3ft2cEb4k`，自动同步开启60分钟，16次成功，最新10:22自然计划成功；728源行/650批次行/430有效行/116商品小计与同批Excel核对0差异；430正式对应、126/128/126主资料不变；旧数据/原表/构建/worker/证据保留。

### 2026-10-27 执行方补修交付快照（历史，以下为自验记录）

**2026-10-27 执行方补修完成：`BS_LIVE_INTAKE_V1_REPAIR_IMPLEMENTED_AWAITING_INDEPENDENT_REVIEW`（执行方自验，不自行宣布 PASS）。** [本轮交付摘要](../../.local/bs-live-intake-repair-r1r2-20261027/delivery-summary.md)、[证据索引](../../.local/bs-live-intake-repair-r1r2-20261027/evidence-index.md)、[恢复说明](../../.local/bs-live-intake-repair-r1r2-20261027/RESTORE-NOTE.md)、[任务包](bigseller-live-intake-v1.md)、[独审报告](../../.local/bs-live-intake-independent-20261027/independent-review.md)、[两组最小补修](../../.local/bs-live-intake-independent-20261027/remaining-repair.md)。

**唯一日常地址仍为 http://127.0.0.1:3011**：`run-20261026T211500Z-11a22b33` / PG 59345 / 库 `iceos_catalog_run_20261026T211500Z_11a22b33`；最终 BUILD **`IbVHV6BZXFtK3ft2cEb4k`**（无 drift）；worker `inv-worker-59345` 冻结源 **`1db4017a…`**（parser.py `28348dd6…`，旧源 `9003dd67…` 备份可回退）；自动同步 **开启、60 分钟**（10:22 真实自动计划 `22fcb140…` 成功，next 11:22）。

**本轮已实施**：R1 普通单码仓不再误标 `pending_total`（越南 WM0026 1853 无假“列表与详情不一致”）；详情覆盖改读顶层 `coverage`（单仓 1/1、全仓 6/7，缺失不是 0/0）；切仓改用库存模块已有单仓读取，数量/覆盖/待合计组/待核来源/时间/警告随范围切换；同仓待确认行逐行显示（MY `ICEWM0026=0` 原表 564，未计入、不绑定；0 不当没有来源）；失败旧值/旧时间、未对应/无来源沿用读模型；旧 BS 样表仅历史证据、不回退；当前货值“暂未计算”。R2 明确 `SKU编号` 保留完整字符串（`clean brush` 不再截断；内部空格/标点/前导零保留；旧 `SKU信息` 保持原分词兼容）；新批次 56673 行15=0、56519 行413=10087 原码 unmapped 未计合计，48787 行512=12633 仅源行不发布，旧 `clean` 28 行保留，430 正式对应未改。

**执行方自验**：真实页面 38/38；R2 离线解析 + 一次明确标注的手动真实批次核对（430 adopted/430 effective/同批差异 0）；catalog 133/133、inventory 109/109、parser 30/30、tsc 本包 0 新错、eslint 0/0、diff 0。**未做/待确认**：不猜绑 `clean brush`、46+174 待核、PH 双码合计口径、切仓走单仓读取（旧性能矩阵未重跑）、失败/断网/多机/自然过期/200%/完整权限矩阵、`inventory_current` 旧投影观察项；A1/B/C 等沿用未重跑。未提交/推送/合并/部署/清场/写长期记忆。

### 2026-10-26 执行方交付快照（历史，非本轮结论）

**唯一日常地址已切换到 http://127.0.0.1:3011**：正式实例 `run-20261026T211500Z-11a22b33`，PG 59345，库 `iceos_catalog_run_20261026T211500Z_11a22b33`，当时 BUILD **`uktXWUlhRzx0tPGmGp7xK`**（已由本轮补修替换为 `IbVHV6BZXFtK3ft2cEb4k`），后台 `inv-worker-59345`，schema v6；商品 UUID/主资料来自切换前 3011 只读备份并核对一致（126/128/126），旧 65466 库保留。两次真实导出（手动 21:11 `28447db3…`、真实自动计划 21:18 `c3ffacaa…`）均 success、账号身份 verified；按已确认规则经正常确认链建立 **430 条正式对应**（69编码 377、56519 货号 30、条码例外 14、仅 56519 的 ICE+货号精确别名 9；0 verification/0 unitUnconfirmed），430 当前采用行，46 同码冲突 + 174 未匹配待核。商品库列表/详情/切仓/刷新与商品库存页共用库存模块统一有效库存；WM0026 双码 `757577983013=3119`、`ICEWM0026=4138` 并列显示并标“合计待核对”；旧样表只作历史证据；当前货值统一“暂未计算”。自动同步开启、60 分钟、next 22:22；刷新不新增导出。

**执行方自验（历史）**：页面链 20/20、三页对账 3/3、catalog 纯逻辑 132/132、inventory 纯逻辑 109/109、tsc 本包 0 新错、eslint 0/0、构建无 drift。**未做/待确认**：当前货值新估值、46+174 待核行人工决定、PH 别名规则独立确认、真实断网/多机/自然过期/旧性能/200%/完整权限矩阵；A1/B/C 等沿用未重跑。未提交/推送/合并/部署/清场/写长期记忆。

## 上一已通过基线：商品库存与 BigSeller 自动同步 v1（A1本地技术验收）

**2026-10-26 用户补充确认（晚于 A1 验收）**：BigSeller 库存数量均按单个商品计数，不是箱，不做装箱数换算；其他国家仓商品编码对商品库“69编码”，菲律宾新创启辰仓主要用货号、少数条码可参考库存辨认。规则唯一正文见[商品身份标准第7节](../product-identity-standard-v1.md)。数量单位已确认，不再作为业务待决；WM0026 该仓两种编码已确认同时展示，各自数量保留、不强制二选一；本次未决定正式合计口径，不阻塞其余明确项。本次只记录规则，程序、数据库验证标记、正式对应与页面入口尚未据此修改；下面验收时的“单位待确认”保留为历史记录。

**2026-10-26 主审独立复审通过：`INV_SYNC_V1_REPAIR_V4_FINAL_A1_LOCAL_PASS`。** [独立报告](../../.local/inventory-sync-independent-v4-final-a1-20261026/independent-review.md)。A1 失败终态恢复已关闭；B/C 保持上一轮通过。本轮已批准修复的本地技术开发收尾，无新增返工包。

独立最终源码离线闭环 13/13、实际新库只读核验 12/12：失败终态可重复读取，核对/旧重试/旧动作入口均不再执行业务；最终页面链证据经主审核读（未重复写页面测试），显示终态后只清本条记录，设置可改。586 个源码/运行文件及 3 个部署函数匹配。执行方旧离线探针缺定时器模拟，已在新独审目录补齐，原失败保留；不要求业务返工。

验收现场：`run-20261026T180500Z-a1b2c3d4` @ 3036 / PG61653，BUILD `L4waWh75n57_sdLsWYaNT`；后台心跳在线，当前自动同步关闭、60 分钟、7 仓、configVersion 9、pending 0。15/105/9750 未变；五商品小计沿用本轮执行对账与上轮独审，不冒充再次全量核对。验收时的单位待确认已由本次用户确认结清；数据库验证对应尚未转为正式关系，验证数据不等于正式库存启用。全部旧实例、原表、历史失败证据保留；本轮未改业务源码/数据、未提交/推送/合并/部署/清场/写长期记忆。

### A1 执行方交付记录（保留历史，以下不是当前待办）


**2026-10-26 执行方完成 v4 FINAL 独审唯一剩余 A1 并提交自验；状态 `INV_SYNC_V1_REPAIR_V4_FINAL_A1_IMPLEMENTED_AWAITING_INDEPENDENT_REVIEW`，不声明 PASS。** 依据 [v4 FINAL 独立报告](../../.local/inventory-sync-independent-v4-final-20261026/independent-review.md)、[唯一剩余修复](../../.local/inventory-sync-independent-v4-final-20261026/remaining-repair.md)；[交付摘要](../../.local/inventory-sync-repair-v4-final-a1-20261026/delivery-summary.md)、[证据索引](../../.local/inventory-sync-repair-v4-final-a1-20261026/evidence-index.md)。B/R1、C/R4 已通过，不重开；只修 A1。

**本轮实现**：`reconcile_inventory_request` 读取同 actor/同 intent 的 failed 终态（可重复、含原 errorCode，先于成功回执分支保护）；`begin_inventory_pending_action` 回放返回 errorCode；`actions.ts` 核对映射 `failed_terminal`、重试入口/begin 回放拒绝再次执行原业务；页面显示“原操作失败，已处理完，可以修正后重新操作”后仅清该 requestId 本地记录并刷新解锁；`types/model/component` 同步。未新增 RPC/表/存储，未改 B/C、库存计算与历史。

**本轮交付现场**：新隔离实例 `run-20261026T180500Z-a1b2c3d4` @ 网页 `http://127.0.0.1:3036`（BUILD **`L4waWh75n57_sdLsWYaNT`**，no drift）、独立 PG `127.0.0.1:61653`、后台 `inv-worker-61653`（冻结源 `9003dd67…`）、schema v5（functions `1b2387ad…`）；登录 `admin@catalog.test / CatalogAdmin123!`；未改 00001–00052/017/018/019/020。

**执行方自验（非独审）**：A1 页面+DB 链 1/1（failed/`INVENTORY_SCOPE_EMPTY`、无回执、刷新锁→核对终态→清记录/解锁/设置可改并恢复；恢复 POST 1 条 unknown、business/register 0；runs/batches/batchRows 不变）；独审 P13 复制件 13/13（原失败副本保留）；PG 44/44、只读 42/42、部署函数只读一致、页面纯逻辑 109、tsc 本包 0 新错、eslint 0/0、diff check 0、构建 no drift。

**保护与边界**：3035/54164、3034/61135、3011/3021/3022、3031+50499、3032+59532、3033+53442 保留只读，保护快照 before→final 0 变化；写入仅新实例 61653。五商品小计 1028/247/23/13059/122110 沿用不变；PH 最终现场 2 条来源属测试对应扩展、其余四商品无来源。27 条回放验证对应（候选现场另含 3 条测试对应共 30）仍为验证数据，单位“件”待业务确认；旧 3031/50499 事件不归因。未覆盖：真实断网（受控代理模拟）、多机/断电/自然过期/200%/完整权限矩阵、旧性能/UI；未重抓 BigSeller、未删/补造数据。误写独审 json 已按原 sha 恢复并记录。未提交/推送/合并/部署/清场/写长期记忆；最终范围由独立审查裁定。

### v4 FINAL 首轮执行方交付记录（保留历史，2026-10-26）


**2026-10-26 执行方完成 v4 独审剩余 A/B/C 三处并提交自验；状态 `INV_SYNC_V1_REPAIR_V4_FINAL_IMPLEMENTED_AWAITING_INDEPENDENT_REVIEW`，不声明 PASS。** 依据 [v4 独立报告](../../.local/inventory-sync-independent-v4-20261026/independent-review.md)、[三处最小收尾](../../.local/inventory-sync-independent-v4-20261026/remaining-repairs.md)；[交付摘要](../../.local/inventory-sync-repair-v4-final-20261026/delivery-summary.md)、[执行契约](../../.local/inventory-sync-repair-v4-final-20261026/contract-v4-final.md)。只补 A/R2 失败结案四态与完整绑定、B/R1 采用态区分、C/R4 run-check 备用 PG 配置接线；不新增功能、不重开已关闭项。

**本轮实现**：A 新增 DB `catalog.settle_inventory_pending_action(...)`（单事务 FOR UPDATE 核 actor/action/intent/完整 payload；成功回执不改判）+ `settlement.ts` 四态 + `actions.ts`/4 个写入口组件；仅业务成功（非 unlockFailed）或服务端确认结案才清本地记录/解锁/刷新，结案失败/未知/非原请求保留锁。B `adoptedSkus` 只取同范围 `inventory_effective_rows`，新增 `pendingAdoptionSkus`/`pendingAdoptionWarehouses`，列表/详情区分“已计入合计”与“对应已确认、等待下一次完整同步采用”。C `run-check.mjs` 备用 PG 分支先读 pgEnv 并传守卫、通过后才连接，保留连接后只读身份核验。

**本轮交付现场**：新隔离实例 `run-20261026T164500Z-e8f9a0b1` @ 网页 `http://127.0.0.1:3035`（BUILD **`KJUZ9F4ZJuSl2a7qWWAZ6`**，no drift）、独立 PG `127.0.0.1:54164`、后台 `inv-worker-54164`（冻结源 `9003dd67…`）；schema v5（020 `4e384414…` + functions `7cd92fd3…`）；登录 `admin@catalog.test / CatalogAdmin123!`；未改 00001–00052/017/018/019，016 仅改函数体与 GRANT。

**执行方自验（非独审）**：回放 15 run/105 批次/9750 行/27 对应 + 3 条 B 验证对应（confirmed=30）；PG 套件 **43/43**（schema v5、settle、B 采用态、原 R1–R4）；只读核对 **42/42**；A 页面链 1/1 + DB（pending=failed/`INVENTORY_SCOPE_EMPTY`、无回执、锁解除、设置可改并恢复）+ 离线探针 12/12 + PG settle 4/4；B 数据 53/53 + 真实页面 27/27（50455 已计入仅 6974674957325=899、三条等待采用、小计 1028 与其余 247/23/13059/122110 不变、原十条待确认仍可见）；C 离线分支 2/2；页面纯逻辑 109；tsc 本包 0 新错、eslint 0/0、`git diff --check` 0。

**保护与边界**：3011/3021/3022、3031+50499、3032+59532、3033+53442、候选 3034+61135 未写/未启停/未替换构建，保护快照 before→final 0 变化；写入仅新实例 54164。PH 54409 旧“五商品全无来源”仅测试前成立，最终 LS101295 有 2 条来源（7332 行471=0、7349 行470=0），其余四商品仍无来源，旧断言/差异保留不删映射。验证数据不等于正式库存启用（单位“件”待业务确认）。未覆盖：真实页面 settle_failed/未知/not_original（离线+事务覆盖）、200%/完整权限矩阵/真实断网/自然过期/断电并发、真实 BigSeller 采集与备份正常路径（沿用）。未提交/推送/合并/部署/清场。最终范围由独立审查裁定。

### v4 首轮执行方交付记录（保留历史，2026-10-26）


**2026-10-26 执行方完成 R1–R4 并提交自验；状态 `INV_SYNC_V1_REPAIR_V4_IMPLEMENTED_AWAITING_INDEPENDENT_REVIEW`，不声明 PASS。** 依据 [v3 独立报告](../../.local/inventory-sync-independent-v3-20261026/independent-review.md) 与[四组最小补修清单](../../.local/inventory-sync-independent-v3-20261026/remaining-repairs.md)；[交付摘要](../../.local/inventory-sync-repair-v4-20261026/delivery-summary.md)、[证据索引](../../.local/inventory-sync-repair-v4-20261026/evidence-index.md)、[执行契约](../../.local/inventory-sync-repair-v4-20261026/contract-v4.md)。v3 独审 `INV_SYNC_V1_REPAIR_V3_NEEDS_FIX` 与 v2 输入保留历史身份。

**本轮交付**：新隔离实例 `run-20261026T153500Z-c4e8a1b2` @ 网页 `http://127.0.0.1:3034`（BUILD **`BWfdgG5RtlNS3KlwLzYLp`**）、独立 PG `127.0.0.1:61135`、后台 `inv-worker-61135`（冻结源 `9003dd67…`）；schema v4（新增 `019_inventory_sync_repair_v4.sql` `48f856f8…` + functions `a8dff9c0…`）；登录 `admin@catalog.test / CatalogAdmin123!`；未改 00001–00052/017/018。

**已实现**：R1 来源存在性与采用关系分离（已知编码在本仓最新 run 的源行独立读取；同仓 current 也列 pending 源行；unmapped_source/no_source/0 区分；列表详情同解释；不自动绑定/不计合计）；R2 全部写入口先登记后执行、本地未知记录纳入统一写锁并绑定服务端 actor/account、换管理员不能接管、换请求 keyed 重置、intent v4 结构化编码、DB 完整参数核对、旧 v3 指纹 pending 可恢复、前置失败收口假锁；R3 混合批量按行校验版本；R4 驱动最终目标检查 + 覆盖参数拒绝 + 连接后只读身份核对（12 入口与 prepare）。

**执行方自验（非独审）**：回放 15 run/105 批次/9750 行/27 验证对应；只读核对 **42/42**；R1 十条真实源行 **38/38**（52074 六条 unmapped_source、54886/56673 四条 current+待确认、PH 54409 no_source）；五商品小计 1028/247/23/13059/122110；PG 套件 **38/38**；页面纯逻辑 **91**；浏览器 v4 **8/8**（0 skipped/flaky，79.4s）；R4 离线反例 a–l；inventory tsc 0、eslint 0/0、`git diff --check` 0；BUILD 无 drift。

**保护与边界**：3011/3021/3022、3031+50499、3032+59532、**3033+53442** 未启停/未写入；保护快照 before→final 端口 0 变化、实例 marker/配置/exports 0 变化。27 条对应仍为验证数据（单位待业务确认）；旧 59532 历史 item_revision 仍 NULL；旧污染来源未确认。未覆盖：真实断网/自然过期/断电并发/旧性能 UI/200%/完整权限矩阵；本地预览不是生产部署。未提交/推送/合并/部署/清场。四组均已自验，剩独立审查裁定。

### v3 执行方交付记录（保留历史）

**2026-10-26 执行方交审时状态：`INV_SYNC_V1_REPAIR_V3_IMPLEMENTED_AWAITING_INDEPENDENT_REVIEW`。** 按[集中补修包 v3](../../.local/inventory-sync-independent-v2-20261026/execution-repair-v3.md)完成 F1–F5 并做执行方自验；v2 独审 `INV_SYNC_V1_REPAIR_V2_NEEDS_FIX` 与[独立报告](../../.local/inventory-sync-independent-v2-20261026/independent-review.md)保留为历史输入，最终通过范围由独立审查裁定，执行方不声明 PASS。

新独立修复实例 `run-20261026T123800Z-d3f4a5b6`：网页 `http://127.0.0.1:3033`（BUILD **`R4hh0kmDKek10Xm-em3Fk`**），独立 PG `127.0.0.1:53442`，后台 `inv-worker-53442`（冻结源 `9003dd67…`），登录 `admin@catalog.test / CatalogAdmin123!`。数据库增量 `db/catalog/018_inventory_sync_repair_v3.sql`（`1941b997…`，幂等：item_current/item_revision owner-only SELECT 策略、前驱索引、version=3 握手）+ 重放函数文件 `1a37dd2f…`；实际 DB `inventory_schema_state.version=3`；未改 00001–00052/017。旧 3032/59532、3031/50499、3011/3021/3022 原样保留。

**已实现**：F1 页面/草稿/批量按账号+仓+SKU 行身份、队列返回 currentMapping/版本、首次与重确认版本规则、验证数据/单位未确认标记；F2 历史前驱派生（不改历史行）、发布保存当时 item_revision/缺失拒发、owner-only 只读策略、覆盖/缺口/市场统一读模型；F3 发布以登记源行为唯一业务字段来源并严格核对（保行号/hash 改数量或换 SKU 拒绝）；F4 requestId+intent 绑定、三态核对、找到回执与解锁分离、解锁失败保留、无持久锁直接 found、他人 pending 仅忙碌、页面重载/刷新恢复；F5 冻结源 first-only/显式 refresh、备份恢复失败显式失败、可写测试入口 marker+只读身份守卫。

**执行方实测（不是独审结论）**：回放 15 个真实成功 run/105 仓批次/9750 行（27 条验证对应、adopted 405 行带当时修订）；只读核对 **42/42**（5 固定商品 1028/247/23/13059/122110；WM0049 历史 83,025→83,022（-3）、WM0026 2,001→2,001（0）；覆盖 5/7、市场集合+未知）；PG 套件 **32/32**；Python **122**、页面纯逻辑 **69**、页面 v3 闭环 **10/10（0 failed/skipped/flaky，84.9s）**（F1/F2/F4 A/A2/B/C/D）；F5 反例 8/8+5/5+16/16；最终 tsc 本包 0、eslint 0/0、`git diff --check` 0。证据 `.local/inventory-sync-repair-v3-20261026/`。

**保护与边界**：3011/3021/3022、3031/50499、3032/59532 未启停/未写库（59532 仅只读事务提取）；旧 3031/50499 未确认测试写入保留现场、未指认来源；旧独审探针脚本曾被修改、旧结果 JSON 保留；27 条对应仍为验证数据，业务包装单位/真实市场待用户确认；旧 59532 历史 item_revision 仍 NULL（未回填）。未覆盖：真实断网/自然登录过期/断电并发多机/旧 15×20/旧 UI/200%/完整权限矩阵。停于 `INV_SYNC_V1_REPAIR_V3_IMPLEMENTED_AWAITING_INDEPENDENT_REVIEW`，不自行宣布通过，不进入下一功能包。

## ICE 商品库飞书来源模拟接入 v1（最近已验收，`FS_CATALOG_SIM_LOCAL_PASS`）

状态：**`FS_CATALOG_SIM_LOCAL_PASS`（主审独立验收通过 2026-10-25；三项定向补修已完成）**。以用户指定的飞书普通电子表格（wiki `TC2AwLgRniqWKhkg9D2cEx79n0b` / Sheet1 / spreadsheet_token `EMZGs2eIhh0YQ1tPIqMcR8SPnQh` / sheet_id `33bab4`）为商品资料来源；本轮用匿名只读网页复制取得真实全表快照（404×31、有效业务行 131、编号 125、原始 TSV sha256 `89e265f5…e63b6f`，价格列只在受限证据），在独立本地实例完成本地模拟读取 + 统一处理链 + 最小来源更新面板，并完成三项定向补修：单位未确认字段永不自动采用（含本地为空/新品）、恢复链区分部分失败补做与原请求回执核对、金额按实际表头映射隔离。**未开通真实飞书 API、未写回飞书原表、未提交/推送/合并/部署、未改变现役 126 商品与 BS 530 行**；不是 UI v4 PASS、不是生产启用。

- 主审独立验收（`FS_CATALOG_SIM_LOCAL_PASS` 依据）：验收构建 `KxK3GCNqcL6oawVAbyL0o`、独立预览 3022；主审独立完成定向测试、真实组件接线、构建源码一致性核对与只读数据库核验，确认 555 个构建文件与源码及运行目录一致、结果未知恢复使用同一 requestId、数据库只有 1 个批次/1 条回执。证据分层：主审独立验证 / 执行方证据 / 历史证据（旧 3021 与旧记录未覆盖、未改写）。收尾摘要 [feishu-product-source-v1-closeout.md](../catalog/feishu-product-source-v1-closeout.md)。
- 可运行实例（修复轮）：`run-20261025T053500Z-f5a00007` @ `http://127.0.0.1:3022/dashboard/catalog/sources`（独立数据库端口 59883，不影响 3011/旧 3021；BUILD `KxK3GCNqcL6oawVAbyL0o`，pid 79708；构建源哈希与仓库一致 drift=false）；登录 `admin@catalog.test / CatalogAdmin123!`（密码文件在实例 `login.local-preview.txt`）。旧 3021 实例 `run-20261025T074500Z-f5a00006` 与旧证据保留未改写。
- 实现：`src/features/catalog/product-source/*`（契约/表头/归一化/异常/分组/三方差异/计划/读取器/模拟/恢复）、`db/catalog/015_product_source_sync.sql`（含补做批次、私有原请求意图、表头映射价格剔除）、`src/features/catalog/components/product-source-panel.*`、`src/app/dashboard/catalog/sources/page.tsx`、`scripts/catalog/feishu-source/*`；字段与规则见 [feishu-product-source-v1.md](../catalog/feishu-product-source-v1.md)。
- 自验（执行方，不是独立结论）：真实快照 baseline updated=91/unchanged=23/needsReview=12/missing=1，未确认单位 0 adopt/0 write；模拟 002 created=1/updated=2/needsReview=17/missing=3；并发失败 1 项后 UI 补做批次仅含失败项、失败项恢复、成功项 revision 不变；原请求 draft 重放回执一致、重建计划新 intent 被请求冲突拒绝；页面结果未知动作返回结构化标识，保留原 requestId/操作信息并锁住新操作，核对沿用同一 requestId 取回原回执后恢复（浏览器响应丢失演练 + 页面状态机 5/5）；金额原列序与合成列重排公共无金额、私有语义对应 0 差异；UI 走查装箱数量 100→120 + 历史、WM9001 新品建档 + 无未确认外箱字段。单测 62/62 + 恢复链 5/5 + PG 16/16；全仓 test 619/620（唯一既有 opt6 00051）、tsc 仅既有 BEST 5、lint 0 error/14 既有 warning、`git diff --check` 0、build 成功；现役 3011/126/530 只读核验通过，原始快照未改。
- 证据：`.local/catalog/fs-catalog-sim-20261025/repair-20261025/`（phase-A/B/C、rechecks、pg-final、ui、guards.json；本地证据不入库）；旧证据 `.local/catalog/fs-catalog-sim-20261025/` 保留。
- 未覆盖/待确认：真实 API 凭据/权限/分页/限流/token、图片内容、外箱尺寸/重量/体积单位确认（仍按不采用处理）、真实 200% 缩放；模拟变化非飞书真实修改；合成价格仅隔离测试。
- 停止点：**`FS_CATALOG_SIM_LOCAL_PASS`**。仅本地模拟接入通过；不代表真实飞书 API 接通、生产启用、旧 UI/性能延期项或整个 ICEOS 全面通过。不自动开启真实 API 接入或下一包。

## 商品库 v6 四项定向补修包（历史，独审通过 `V6_FOUR_ITEMS_LOCAL_PASS`）

状态：**`V6_FOUR_ITEMS_LOCAL_PASS`（独立复审通过 2026-10-24）**。商品库 v6 四项定向补修已通过独立复审，按不越权、日常正常使用、关键内容不误导的标准完成本包。通过范围仅限 V6-01 来源缓存版本/迟到响应/身份权限隔离、V6-02 来源采用状态与库存说明、V6-03 逐条来源价格缺失文案、V6-04 读取失败/无权限/真实空记录区分；**不覆盖**旧 v6 性能门禁/15×20、原 v4 全量后端、准备链、保存回执六态、真实来源摄取、后续匹配规则。**不代表原 v4/v5 全量验收、全商品库或全 ICEOS 全面通过，也不是真实多账户/撤权/数据库权限矩阵或性能验收**；v5 历史 `UI_REVIEW_NEEDS_FIX` 保留；延期项保留原记录，不写成已修复或已通过。

- 独立报告：[independent-review.md](../../.local/catalog/independent-ui-frontend-v6-20261024/independent-review.md)；收尾摘要：[catalog-ui-v6-closeout.md](../catalog/catalog-ui-v6-closeout.md)；执行方材料：[delivery-summary.md](../../.local/catalog/ui-frontend-v6-20261024/delivery-summary.md)、[repair-matrix.md](../../.local/catalog/ui-frontend-v6-20261024/repair-matrix.md)、[evidence-index.md](../../.local/catalog/ui-frontend-v6-20261024/evidence-index.md)、[screenshots-index.md](../../.local/catalog/ui-frontend-v6-20261024/screenshots-index.md)。
- 实施：撤销 v5 新增的共享来源结果缓存，库存空态提示与数据来源子视图每次重新走服务端鉴权，详情缓存/切仓/迟到保护原样保留（V6-01）；来源“本批已采用对应”与库存计入分开，BS 以已确认库存行为准、JST 不声称计入国内库存，已采用记录不再显示早期筛查结论，未采用记录早期提示默认收起（V6-02）；WM0072 当前价保留，逐条来源价格说明改为“暂未展示”（V6-03）；来源数量仅在成功空集合时显示 0，失败/无权限显示“—”，价格单独失败/无权限保留来源记录并可重试（V6-04）。
- 证据分层：独立实际页面走查（WM0043 搜索/详情/真实零仓/有货仓/未采用仓/来源/返回/关闭；WM0072 当前价与历史来源往返）；独立重跑 **33 项受控浏览器检查 + 6 项边界补验**通过；独立定向纯测试与组件接线（source-view 5、detail-cache 13、组件异步接线 5/5、投影与组件探针 20/20，分报告重叠不累加）；本包 6 个受影响文件 eslint `--max-warnings 0` exit 0（`independent-lint.json`）。执行方主套件 **22/22（0 skipped/flaky，104.7s）**、单测 **547/548**（唯一既有 opt6 00051）、catalog tsc 0（全仓仅既有 BEST 5）、全仓 lint 0 error/14 条既有 warning、production build 成功，**仅由独审核查原始材料，不是独立全部重跑**。候选 BUILD **`UeTuf-hPnkmmIWTQ1LmFU`** @ 3011（pid 34572，快照 `4cf18e57…`，ownershipVerified=true，login 200）；独审核对 521 个构建源码条目现役零差异。
- 未覆盖：失败/无权限/价格失败/真实空均为受控响应，不是真实数据库权限故障或 ACL/换号验收；未做真实 200% 缩放；逐条来源价格完整追溯、精确焦点、旧 URL 分支、旧 v6 性能门禁/15×20、v4 后端/prepare/增量恢复/保存六态、真实来源摄取、后续匹配规则继续延期，不写成通过。全仓 BEST 5 条类型诊断、opt6 00051、14 条既有 lint warning 原样保留。
- 停止点：**`V6_FOUR_ITEMS_LOCAL_PASS`**。2026-10-24 已完成文档与 Git 收尾：累计 UI/交互代码与测试、延期脚本（现有实现归档、相关验收延期）、文档按逻辑分组提交并普通推送 `origin/codex/ice-v4-planning`；未 merge/deploy，未启停实例，未清场，不自动开启下一包。Git 凭证见 `.local/catalog/ui-v6-closeout-20261024/closeout-record.md`（本地证据不入库）。

## 商品库前端展示与交互收尾包 v5（历史，独审 `UI_REVIEW_NEEDS_FIX`）

状态：**`UI_REVIEW_NEEDS_FIX`（独立复审 2026-10-24）**。用户已明确把 v4 范围收窄为前端展示与交互；本包只做 V5-01～V5-05，**不是 UI PASS**，未 commit/push/merge/deploy，现役 126 样本与 BS 530 行未被写入。独立报告：[independent-review.md](../../.local/catalog/independent-ui-frontend-v5-20261024/independent-review.md)。v6 只承接用户指定的四项定向补修，其余独审项未纳入本包。

- 摘要：[delivery-summary.md](../../.local/catalog/ui-frontend-v5-20261024/delivery-summary.md)；矩阵：[repair-matrix.md](../../.local/catalog/ui-frontend-v5-20261024/repair-matrix.md)；证据：[evidence-index.md](../../.local/catalog/ui-frontend-v5-20261024/evidence-index.md)；截图说明：[screenshots-index.md](../../.local/catalog/ui-frontend-v5-20261024/screenshots-index.md)。
- 范围：V5-01 本批未采用与库存关系、V5-02 空仓一致性与切仓、V5-03 数据来源业务展示、V5-04 历史来源与返回、V5-05 用户入口/统一返回。延期：后续匹配规则、真实来源接入、DB prepare/增量恢复、保存回执六态、完整 v6 门禁、15×20 性能矩阵、无关历史遗留；延期项不是通过。
- 执行方自验：最终 BUILD **`FuW0YdgLlttyIps2oMXSI`** @ 3011（pid 74664，快照 `aff4a313…`，ownershipVerified=true，login 200）；主浏览器套件 **22/22（0 skipped/flaky，1.7m，exit 0）**、v5 探针 **37/37**、单测 **546/547**（唯一既有 opt6 00051）、catalog tsc 0（全仓仅既有 BEST 5）、改动文件 eslint 0/0、`git diff --check` 0；五视口、WM0043/WM0110/WM0072、账户/维护/旧 evidence、后退前进实测。未覆盖：来源全空态与“读商品有权限、读来源/价格无权限”无现役自然样本（仅投影单测）；真实 200% 缩放。
- 停止点：历史 **`UI_REVIEW_NEEDS_FIX`**；v6 只承接用户指定的四项定向补修，v5 其余独审项未纳入本包。

## 商品库 UI 集中补修包 v4（历史，独审 `UI_REVIEW_NEEDS_FIX`）

状态：**`UI_REVIEW_NEEDS_FIX`（独立复审 2026-10-24）**。按用户 v4 包实施 V4-01～V4-09：仓库切换稳定、数据来源业务化、历史/来源返回、原请求回执与意图、全仓缓存投影、返回路径/启用态 from、准备链修复；**不是 UI PASS**，未 commit/push/merge/deploy，现役 126 样本与 BS 530 行未被写入。

- 合并矩阵：[repair-matrix.md](../../.local/catalog/ui-repair-v4-20261024/repair-matrix.md)；交付摘要：[delivery-summary.md](../../.local/catalog/ui-repair-v4-20261024/delivery-summary.md)；证据索引：[evidence-index.md](../../.local/catalog/ui-repair-v4-20261024/evidence-index.md)；截图说明：[screenshots-index.md](../../.local/catalog/ui-repair-v4-20261024/screenshots-index.md)。
- 范围：V4-01 仓库固定顺序/选中不改变宽度/不强制回顶；V4-02 “数据来源”业务视图（来源系统、来源编码/名称、每记录自己的仓库、真实对应状态、中文字段差异、价格；历史事实与当前参照分离；移除 JSON/UUID/技术下载）；V4-03 历史投影隔离、失败重试、跨版本来源返回、短屏首屏实质内容；V4-04 原请求只认真实回执与完整意图；V4-05 全仓派生完整明细投影；V4-06 返回路径规范化与启用态 from；V4-09 准备链 recordOnly/manifest DB 核验。继承 `U3_LOCAL_UX_PERF_PASS` / `LOCAL_PREVIEW_PASS` 原范围；不接真实来源、不改业务规则、不新增 migration/schema/审批状态。
- 执行方自验：浏览器主套件 **22/22（0 skipped/flaky，1.7m）**；单测 **536/537**（唯一既有 opt6 00051）；V4-04 定向 50/50、V4-05 13/13、V4-06 18/18；五视口首屏均有库存明细行、切仓按钮矩形不变；WM0072 历史/跨版本来源返回、issues/旧直链/穿越 from 实测；catalog tsc 0、eslint 0/0、`git diff --check` 0。最终 BUILD **`Dwnb0Go61UvC1sHZx4Uev`**（3011，pid 35400，快照 `57f2c5b2…`，ownershipVerified=true，login 200）。
- 独审未通过/未完成：V4-07 v6 内容完成门禁与真实应用负向未完成；V4-08 无最终 15×20 性能矩阵；V4-04 隔离 DB 六态、V4-05 隔离缓存反例、V4-09 真实隔离库四态/最终回归未跑；200% 真实缩放 pending；历史来源返回/全入口技术内容等已由独立报告指出。用户现把范围收窄为 v5 前端展示与交互；上述项延期，**不是已修复或已通过**。
- 停止点：历史 **`UI_REVIEW_NEEDS_FIX`**；v6 现役停止点见上方。

## 商品库 UI 集中补修包 v3（历史，待独立复审）

状态：**`UI_IMPLEMENTED_AWAITING_INDEPENDENT_REVIEW`（2026-10-24）**。按 `.local/catalog/independent-ui-repair-v2-20261024/execution-repair-package-v3.md` 实施 V3-01～V3-08，并处理同目录 v2 独审（UI/产品/性能/代码/合同 + 用户补充）未通过项；**不是 UI PASS**，未 commit/push/merge/deploy，现役 126 样本与 BS 530 行未被写入。

- 合并矩阵：[repair-matrix.md](../../.local/catalog/ui-repair-v3-20261024/repair-matrix.md)；交付摘要：[delivery-summary.md](../../.local/catalog/ui-repair-v3-20261024/delivery-summary.md)；证据索引：[evidence-index.md](../../.local/catalog/ui-repair-v3-20261024/evidence-index.md)；截图目录：[screenshots/](../../.local/catalog/ui-repair-v3-20261024/screenshots)。
- 范围：统一商品弹窗（历史内联、来源/证据子视图、旧 URL 307、from 回跳）、全流程文案与字段收敛（kg/体积/包装/635 短屏/启用态去 fixture/UUID）、切仓缓存复用与内容一致（切仓 0 请求 + 同 scope 后台校验）、草稿与待核请求主体隔离/只读核对/显式重试、返回链与集中问题入口（不可变事项如实说明、真实 0 项独立 fixture）、oracle/merge v5 内容门禁与 15×20 性能矩阵、V3-08 非基线候选失败根因与最终源码隔离重跑。继承 `U3_LOCAL_UX_PERF_PASS` / `LOCAL_PREVIEW_PASS` 原范围；不接真实来源、不改业务规则、不新增 migration/schema/审批状态。
- 执行方自验：浏览器主套件 **22/22（0 flaky）**；v3 UI 采集 **117/117（5 uncovered）**、70 张截图；oracle v5 校准 **26/26**、merge 自检 **20/20**、期望 crossChecked=true；性能矩阵见 `oracle/runs/`（阈值未下调，超阈桶原样交回）；全仓 tsc 5 条历史基线（商品库 0）、eslint 0/0、单测 513/514（唯一失败为既有 opt6 00051）、`git diff --check` 0。最终 BUILD **`8qFEEnYTJ60Jgk7E_ZiNZ`**（3011，pid 21036，快照 `603dc16e7257bb0a…`）。
- 待独立复审裁定/未覆盖：性能 13/15 桶达标；`warmPagination` p95 114.4ms、`warmListRefresh` p95 472.4ms（等待本次 RSC 刷新响应）超 100ms（真实值，未豁免；merge integrity 另含 unit-cost diag/scroll preSatisfied 工具待收敛项）；现役全 r1 → 历史版本切换 5 视口 uncovered；200% 真实缩放 pending；v5 真实应用负向未新增；隔离 fixture 最终行为矩阵结果见 `.local/.../fixture/`；scripts 准备链两处缺口如实未修。
- 停止点：**`UI_IMPLEMENTED_AWAITING_INDEPENDENT_REVIEW`**。等待用户转交独立审查；通过后再安排本包 Git 收尾，不开启下一开发包。

## 商品库 UI 集中补修包 v2（历史，独审 `UI_REVIEW_NEEDS_FIX`）

状态：**`UI_IMPLEMENTED_AWAITING_INDEPENDENT_REVIEW`（2026-10-23）**。按 `.local/catalog/independent-ui-review-20261023/execution-repair-package-v2.md` 实施 U1–U8，并处理同目录 `independent-review.md` 的 R1–R10；**不是 UI PASS**，未 commit/push/merge/deploy，现役 126 样本未被写入。

- 合并矩阵：[repair-matrix.md](../../.local/catalog/ui-repair-v2-20261023/repair-matrix.md)；U/R 逐项结果：[u1-u8-r1-r10-results.md](../../.local/catalog/ui-repair-v2-20261023/u1-u8-r1-r10-results.md)；证据索引：[evidence-index.md](../../.local/catalog/ui-repair-v2-20261023/evidence-index.md)；截图说明：[screenshots-index.md](../../.local/catalog/ui-repair-v2-20261023/screenshots-index.md)。
- 范围：详情固定外壳 + 三分区（商品资料/库存明细/变更记录）、概览按库存阶段与货值组织、技术证据退出日常详情（迁授权维护页）、包装/尺寸字段校准、列表去工程横幅、分页直选与位置保持、导航收口（数据维护进账户菜单）、启用态页面统一；R1–R10：门禁首屏期望分层、可达性/合并器完整性、受影响路径性能、编辑四态与离开保护、历史边界、错误分类、问题索引覆盖、上下文统一、旧 UI 退出、文档证据收敛。继承 `U3_LOCAL_UX_PERF_PASS` 与 `LOCAL_PREVIEW_PASS` 原范围；不接真实来源、不改业务规则、不新增 migration、不恢复封存模块。
- 执行方自验：UI 采集 **76/76**、oracle v4 校准 **27/27**、真实负向 **16/16**、浏览器主套件 **22/22（0 flaky）**、隔离 fixture R4 16/16×2 / R6 13/13+14/14 / R7 7/7+5/5+2/2 / R9 8/8+2/2、`tsc` 全仓 5 条历史基线（商品库 0）、`eslint` 0/0、单测 457/458（唯一失败为既有 `opt6-production-apply` 00051 换行豁免）、`git diff --check` exit 0。最终 BUILD **`7Qzv7GAew213N3WufdT_z`**（3011，pid 72784，源码快照 `3a1d5395…` 与 promote 一致）。
- 待独立复审裁定/未覆盖：① `detailWarehouseSwitchRealClick` 四轮 p95 **113.0–159.8ms** 均超 100ms 暖口径（合并门禁 `allRequired=false` 原样交回，未豁免）；跨文档桶 3 轮各 1–2 例 90s 未就绪（独立直链探针 20/20 正常，未剔除）；② 维护页“非基线新品候选审计读取失败”待确认项（根因未定位，错误文案已明确分类）；③ new-item 3/4、source-identity 4/5 未在最终 BUILD 复跑（与②同源，另 1 条包外既有失效）；④ R7 “无事项”未覆盖（未伪造）；⑤ 200% 缩放为模拟、像素级视觉基线未建立。
- 停止点：**`UI_IMPLEMENTED_AWAITING_INDEPENDENT_REVIEW`**。等待用户转交独立审查；通过后再安排本包 Git 收尾，不开启下一开发包。

## 商品库 UI 整体改造（历史包，已被 v2 补修覆盖）

状态：上一包 `UI_IMPLEMENTED_AWAITING_INDEPENDENT_REVIEW`（2026-10-23，F01–F17），独立复审结论 **`UI_REVIEW_NEEDS_FIX`**（[independent-review.md](../../.local/catalog/independent-ui-review-20261023/independent-review.md)）；其 R1–R10 已在本包处理。上一轮 BUILD `GaK8dG26vW574fhA5gEBy`（pid 23136）已被本包预览更新替换。历史证据原样保留：[delivery-summary.md](../../.local/catalog/ui-overhaul-20261023/delivery-summary.md)、[f01-f17-results.md](../../.local/catalog/ui-overhaul-20261023/f01-f17-results.md)、[evidence-index.md](../../.local/catalog/ui-overhaul-20261023/evidence-index.md)。

## 商品库 UI 整体改造（历史记录，F01–F17 原登记）

状态：**`UI_IMPLEMENTED_AWAITING_INDEPENDENT_REVIEW`（2026-10-23）**。按 `.local/catalog/independent-ui-plan-20261023/execution-package.md` 实施 F01–F17；**不是 UI PASS**，未 commit/push/merge/deploy，现役 126 样本未被写入。

- 交付摘要：[delivery-summary.md](../../.local/catalog/ui-overhaul-20261023/delivery-summary.md)；F01–F17 逐项：[f01-f17-results.md](../../.local/catalog/ui-overhaul-20261023/f01-f17-results.md)；证据索引：[evidence-index.md](../../.local/catalog/ui-overhaul-20261023/evidence-index.md)；截图说明：[screenshots-index.md](../../.local/catalog/ui-overhaul-20261023/screenshots-index.md)；视觉转述：[visual-review.md](../../.local/catalog/ui-overhaul-20261023/visual-review.md)；影响矩阵：[impact-matrix.md](../../.local/catalog/ui-overhaul-20261023/impact-matrix.md)。
- 范围：详情可达性（固定 header + 唯一滚动体）、列表/详情信息层级与响应式、问题触发式只读索引、上下文保持（切仓/历史/来源）、错误恢复、审计只读化、编辑与历史一致性、账户说明、金额显示规范、有限清理。继承 `U3_LOCAL_UX_PERF_PASS` 与 `LOCAL_PREVIEW_PASS` 原范围；不接真实来源、不改业务规则、不新增 migration。
- 执行方自验：UI 采集 **87/87**、oracle v3 校准 **22/22**、真实负向 **15/15**、浏览器回归 **18/18**（0 flaky）、`tsc` 全仓 5 条历史基线（商品库 0）、`eslint` exit 0、单测 **445/446**（唯一失败为既有 `opt6-production-apply` 00051 换行豁免）、`git diff --check` exit 0。预览经 staging build → 校验 → promote → start，最终 BUILD **`GaK8dG26vW574fhA5gEBy`**（pid 23136，归属已校验）。
- 待独立复审裁定：① 性能 9 桶中 7 桶达标，`listFirstWarm` p95 **504.6ms**、`detailModalReopenWarm` p95 **289.5ms** 超 100ms 暖口径（阈值未下调，合并门禁 exit 2 原样保留）；② 隔离 fixture 写入验收（F13 四态 / F07 启用模块两入口 / F06 故障注入）未执行；③ Demo 浏览器冒烟未跑；④ 历史版本逐版本视觉未截图；⑤ `warehouseSwitchInModal` 单样本 1033ms 长尾保留。
- 停止点：**`UI_IMPLEMENTED_AWAITING_INDEPENDENT_REVIEW`**。等待用户转交独立审查；通过后再安排本包 Git 收尾，不开启下一开发包。

## 商品库 Demo 界面复用与访问性能（历史 PASS，U3）

状态：**`U3_LOCAL_UX_PERF_PASS`（独立复审通过 2026-10-23；文档登记与分批提交完成）**。独立报告 [independent-review.md](../../.local/catalog/independent-ux-perf-u3-final-20261023/independent-review.md)；摘要 [progress9-delivery-summary.md](../../.local/catalog/ux-perf-u3-20261022/progress9-delivery-summary.md)；证据 [evidence-index.md](../../.local/catalog/ux-perf-u3-20261022/evidence-index.md)；执行自验 `runs/progress9-verify-20261023-final/selfverify-steps.json`（8/8 exit 0）。3011 BUILD **`Jq2Y6jz_l7sFTKfSUPYkF`** @ `run-20261021T100700Z-b3c4d5e6`（pid 42900，未重启）。通过范围仅限本地样表商品库交互、缓存恢复、性能测量与验收门禁；**不代表**新 UI 完成、真实来源接入、生产发布或全 ICEOS 验收，**`LOCAL_PREVIEW_PASS`** 原范围不变。已关闭：R1 冷启动门禁以 `listSample/detailSample.contentReadyMs` 重算（摘要须等于取整规则，缺失/NaN/Infinity/矛盾即拒绝；合并负向 51/51 + 独立 26 项边界）+ 新验证器复算 `runs/progress8-final5` 原始证据 → `allRequired=true`（原始暖/冷/fixture SHA 未改写，旧验证器单独留存）；R2 runner 校验 `completed=126`/`completed↔itemCount`/`readOnlyEvidence.transactionReadOnly==='on'`（真实 spawn 11/11 + 独立 6 项边界）；R3 全仓 tsc 总诊断 **21→5**、当前商品库 **16→0**，历史 BEST 5 条按范围保留（不声称全仓 tsc 通过）。继承 126×252 / 0 差异（`progress5-20261022-180727`，未重跑）；暖 15×20 / 冷 3 轮沿用 progress8-final5 原始结果只复算不重采样。progress8 的 `allRequired=true` 在其原门禁下保留为历史；progress7 的 `allRequired=true` 为旧计时口径，**不能**作为通过依据。**无**执行方自注册 PASS，本状态依据独立报告登记。

范围：旧经营模块完整源码外置 `D:/try one/ICEOS-legacy-archive/20261022/`（仓库 `archive/legacy-business-20261022/` 仅 `manifest.json`/`EXTERNAL-POINTER.json`/白名单/处置表/`RESTORE.md`/skills 版本清单）；现役仅商品库/新品/来源核实/管理审计；导航与测试对齐白名单；旧 URL/API 封存或重定向；共享 UI `src/ui/ice-v4`；继承 **`LOCAL_PREVIEW_PASS`** 与预览 run `run-20261021T100700Z-b3c4d5e6`。**下一会话**：新版 UI 打磨与新品/来源核实问题触发式入口，本轮不扩开发。

## 本地真实商品预览包（历史 PASS）

状态：**`LOCAL_PREVIEW_PASS`** — 独立验收完成（2026-10-21）。最终报告：[independent-local-preview-final-20261021T084549Z](../../.local/catalog/independent-local-preview-final-20261021T084549Z/independent-review.md)。交付索引：[local-preview-delivery-index.md](../catalog/local-preview-delivery-index.md)；Git 清单：[local-preview-git-manifest.md](../catalog/local-preview-git-manifest.md)。

范围：126 主资料、BS 530（430/100）、六仓、进货价货值；本地样表预览与启停/测试证据；继承 P0/N1A/N1C 与 R3–R5 已关闭项。**预览 run** `run-20261021T075139Z-821214d2`（历史；R2 自验后已受控停止）。本轮 UI 包现役 run 见交付索引 **`run-20261021T100700Z-b3c4d5e6` @ 3011**。LOCAL_PREVIEW 包不重跑 prepare；不 merge/deploy/清场。

## N1C — 本地隔离独立通过与文档登记（历史）

状态：**N1C_LOCAL_PASS**，仅本地隔离范围。验收依据[N1C独立总报告](../../.local/catalog/independent-new-item-review-20261021T015312Z-e38782af/independent-review.md)；原[执行交付](../../.local/catalog/new-item-delivery-20261020T142050Z-85800652/delivery-index.md)保持当时待审记录，不能回写成独立结论。[文档收尾证据](../../.local/catalog/docs-closeout-20261021T020835Z-869e3fc6/delivery-index.md)已登记。

## P0-03 — 独立总验收通过及文档收尾（历史已完成）

状态：**P0_03_PASS**。[独立总验收报告](../../.local/p0-03/reviews/evidence/independent-final-acceptance-20261020-49c832b7/independent-review.md)已通过，文档收尾完成。本期范围仅为产品主库整理、商品身份标准、本批样表对应与人工决定保存、输出一致及历史可追溯；不表示全部资料核实或后续正式关系、真实接入与库存使用已经完成。

- [本轮任务包](./p0-03/2026-10-20-final-acceptance.md)、[明确决定JSON](../p0-03/final-decisions-20261020.json)、[总验收报告](../p0-03/verification-report-p0-03-final-acceptance-20261020.md)；规则正文仍为[商品身份标准](../product-identity-standard-v1.md)。
- [唯一最终输出](../../.local/p0-03/run-20261020-final-acceptance/evidence/final-2026-10-20T03-41-45-834059Z-cd7d4d19/delivery-final-v2/)，含coverage/。delivery-final首版、delivery-reproduced、开发/负向及门禁smoke均仅作证据。
- 使用最新独立通过的JST545交付，指定bundle与有效CSV哈希已核对；继承有效CSV及全部历史，不回退桌面CSV、不隐式合并、不全库重匹配替换决定。

已完成：菲越三条WM0012确认升级普通版、版本待决解除而原目标保持；WM0006/WM0008本批ignore、目标空、原候选保留；WM0130原857确认主库121；菲越两WM0073原220/321由defer转confirm主库67、旧暂缓留历史。六项规格已关闭：两忽略、其余四款按主库C列；不换算g/ml，WM0062 JST789 reject仍在。WM0081原62与brush原107各自可见、待确认，并登记后续正式系统也应保留两份及状态。

结果：126份主资料（125非空唯一货号＋1缺码），1417来源，548选择＝BS430＋JST118；覆盖114/2/4/6、120份有选择。774待核对＋1候选、3拒绝、3忽略、88规则外。新增选择3、既有版本再确认3、本批忽略2；原545目标/JST引用、原22条完整记录、原11JST、WM0007ignore、BS70/72未建档、WM0072锚点66及现价5.18/5.68/两版历史保持。

执行自验本轮重跑：136回归（原121不改＋15）、完整P0-03门禁、全量投影与216字段差异重构、21新业务负向/原12在新结果/原16在历史基线、旧审计28/32与新44、10图片、2审计CLI、6本地浏览器、147产物字节一致再生、lint/build、保护/链接/口径/diff均通过。实际argv、退出码、初检失败、完整日志及既有警告见总报告，不能写成另一个会话的独立重跑。

独立总验收重跑136回归、全量1417/126/原545/22/3160行CSV、21＋12＋16组业务负向、新44和历史28/32组审计负向、10图片、6本地文件浏览器、147份字节一致再生、2审计CLI及范围/链接/diff均通过，另有19项冻结基线探针和原Excel/覆盖/汇总核算。完整P0-03门禁、lint、build仅核查执行日志，未独立重跑。本次仅更新获准的五份文档，做链接、一致性及diff检查，未重跑功能测试。

保留延期：两刷子及未确认BS记录/唯一WM0081 JST候选、新品缺码、工厂/其他缺失、图片内容未核验、一般未核对775及未涉及拒绝/规则外/纠错。本轮菲越版本待决和六项规格说明已关闭，不能继续显示为需重复选择。BS70/72未建档不表示库存0，不要求所有商品同时有两个系统记录。

历史：[JST本批独立通过](../p0-03/verification-report-p0-03-jst-confirmations-20261020.md)及[独立报告](../../.local/p0-03/reviews/evidence/independent-jst-confirmations-20261020-dce89074/independent-review.md)、[审计补修独立通过](../p0-03/verification-report-p0-03-coverage-audit-repair-20261020.md)、[四项确认独立通过](../p0-03/verification-report-p0-03-confirmations-20261019.md)、[主库整理独立通过](../p0-03/verification-report-p0-03-curation-20261019.md)保留原样，含CHANGES_REQUIRED及补修过程。审查前状态P0_03_IMPLEMENTED_AWAITING_REVIEW保留为历史；当前PASS依据本次独立总验收，不由过去分批通过推定。

业务方向/未核实接入条件见[当前状态](../current-state.md)；正式保存关系、自动复用、数量归集、库存同步及估值仍未实现、不在本期。上述延期不阻塞本期有限范围PASS。保留全部原始Excel/CSV、旧证据、HOLD和其他未提交修改；neat-freak仅本次五份文档对齐，不清场、不写记忆。不入正式库、不访问真实账号、不发布/同步库存、不提交/推送/合并/部署或推进下一阶段。停止于P0_03_PASS（文档收尾完成），下一阶段等待另行授权。

---

## P0-02 — PASS（保留）

状态：**`P0_02_PASS`**

- 正式 PASS 报告：[../p0-02/verification-report-p0-02-pass-20261015.md](../p0-02/verification-report-p0-02-pass-20261015.md)
- Canonical Run：`run-20261014-r2`

---

## P0-02 — 历史任务包（归档含义）

- d082728 返工：[p0-02/2026-10-15-delivery-rework-d082728.md](./p0-02/2026-10-15-delivery-rework-d082728.md)（当时 **IMPLEMENTED_AWAITING_REVIEW**）
- 返工验证报告：[../p0-02/verification-report-r2-20261015-d082728-rework.md](../p0-02/verification-report-r2-20261015-d082728-rework.md)

---

## P0-01 — 独立审查通过（保留）

**P0_01_PASS** — 证据 `.local/p0-01/run-20261013-r1/reviews/independent-r5-closeout-20261014-01/`
