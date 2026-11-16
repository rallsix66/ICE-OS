# 飞书商品资料人工核对与持续采用流程 v1（2026-11-10）

> 状态：**本机交付完成（含 2026-11-10 三项补修）；独立差异复核 PASS、阻断 0**（[报告](../../.local/catalog/feishu-source-review-fix-20261110/independent-review.md)；PASS 由独立复核给出，执行方不自行宣布）。
> 实例：`run-20261026T211500Z-11a22b33`（Web 3011 / PostgreSQL 59345 / 数据库 `iceos_catalog_run_20261026T211500Z_11a22b33`）。
> 最终 BUILD **`FSM-UJjNO5GvyvCAiZWMH`**，源码快照 `0ba237228224fbe6d67735f00cff3b370f3871d12a9e3afcb32bde8191ef43b8`（3011 login 200）。
> 证据目录 `.local/catalog/feishu-source-review-flow-20261110/`、补修轮 `.local/catalog/feishu-source-review-fix-20261110/`（不入 Git）。

## 1. 用户决定与本轮范围

用户已明确五项决定，本轮只执行这些，不扩大：

1. **修复待办重复累加**：采用新批次后，已解决的问题退出当前待办；仍存在的问题只显示一次；历史记录保留；数据同步、商品库待处理与数量徽标一致。
2. **指定字段暂不处理**：WM0005 / WM0007 / WM10012 / WM0081 / brush 的“单瓶立方”、LS101302 的“运输时间”暂不处理；记录决定、保留现值、后续批次不重复催办、可恢复；不扩大成忽略整商品或所有同类字段。
3. **同号多行交人工选择**：展示两份资料实际差异、人工确认以哪份为准、保存决定、后续读取沿用；行号变化不失效/不选错商品；出现新的实质冲突再提醒。本轮提供能力，不替用户选定四组资料，也不删除飞书原行。
4. **缺货号允许待确认**：显示缺失信息与人工确认/补号入口，不生成测试码或替代业务货号；烟酰胺提亮精华水 150ml 定向纠正 `TEST-PG-NEW122-0`，恢复“货号待确认”，保留原 UUID、真实历史与 3,840 在途关联，不新建重复商品；该缺码待办不因原表行被删除而消失。
5. **落实重量列口径**：LS101501 单个重量取 O 列 `0.05/件`；箱重以专门 T 列 `24.15` 为准，忽略 O 列夹带的 `24.45/箱`；保留原始来源与人工决定，不推及其他商品单位/重量规则。

边界：不改飞书原表；不新增经营/非经营产品分类表；复用现有来源面板、采用流程、历史与人工补号能力；写入场景先在隔离库验证，再做本机交付与差异复核；已有通过证据沿用，不重跑无关全套。

## 2. 交付结构

### 2.1 跨批待办去重（036）

- `catalog.product_source_issue` 增加 `scope`（`batch` / `item`）、`superseded_by`、`superseded_at`；`review_state` 允许 `superseded`。
- 新增事项稳定键 `catalog.product_source_issue_key(kind, source_key, item_id, detail)`：字段级按“商品 + 字段”，缺码按商品/名称，同号按货号；**行号不参与**。
- 新增 `catalog.reconcile_product_source_issues(profile, batch)`：新批应用后
  - 新批仍存在的同一问题：旧事项 `superseded` 并指向新事项，只留下一条 open；
  - 新批未再出现：旧事项 `superseded` 自动退出当前待办；
  - 命中字段级人工决定：旧事项 `ignored`；
  - 命中同号多行人工选择：旧事项 `resolved`；
  - 缺码来源行已删除（`row:*` 且无商品）：自动退出，商品级 `item` 事项继续保留；
  - 整批失败、retry 批次未覆盖的旧事项：保留，不误关。
- 新增 `catalog.apply_product_source_batch_v2(...)`：同一事务内先执行原 `apply_product_source_batch`，再对账事项；服务层改为调用 v2。
- 历史行全部保留（`superseded_by`/`resolution_note` 可追溯）；页面只显示 `open`。

### 2.2 字段级“暂不处理 / 人工口径”（036）

- 新增 `catalog.product_source_field_decision`（profile + item + field 唯一 active；`action=defer|override`、`value_raw`、`reason`、`note`、`state=active|revoked|superseded`、`source_issue_id`、`decided_by/at`、恢复字段）。
- RPC：`set_product_source_field_decision` / `revoke_product_source_field_decision`。
- 计划层 `PlanFieldDecision`：`defer` 时该字段不写、不采用、不生成事项，保留现值；`override` 时按人工确认值采用（见 2.5）。
- 恢复（revoke）只撤销决定，不回滚已写入商品；下次读取/应用重新提示。

### 2.3 同号多行人工选择（036）

- 新增 `catalog.product_source_duplicate_decision`：按 `profile + ice_code` 唯一 active，保存 `chosen_row_number`、`chosen_row_sha256`（该行 21 个可采纳字段的内容指纹）、`basis_sha256`（决定时同组全部行内容指纹排序后的指纹）、`evidence_row_sha256`（原 `row_sha256` 证据）、`chosen_fields`、`comparison`、`state`、`decided_by/at`。
- 内容指纹 `rowBusinessSha256` / `duplicateBasisSha256` **不含行号**；行号变化不影响决定，也不会选错商品。
- 计划层 `PlanDuplicateDecision`：内容指纹与决定时一致 → 以选定行的字段为准正常参与三方差异；内容变化/选定行消失 → 重新 `needs_review` 并在 detail 标 `decisionStale=true`。
- RPC：`decide_product_source_duplicate_row` / `revoke_product_source_duplicate_decision`；保存时关闭当前同号事项，历史保留。

### 2.4 缺货号待确认与测试码纠正（036）

- 事项支持 `scope='item'`，不依赖来源行；原表行删除后仍保留。
- RPC `correct_test_product_code`：仅接受 `TEST-%` 测试码，校验商品当前码完全匹配；在受控事务内禁用 `catalog_item_code` 的不可变触发器、删除测试码、追加一条 `ice_code_snapshot=NULL` 修订（历史修订不重写），写入私有纠正证据，并建立 `item` 级 `missing_code` 事项。保留原商品 UUID、历史与在途关联，不新建商品。
- `assign_product_source_code` 替换：拒绝 `TEST-` 测试码；补正式货号后关闭 `item` 级缺码事项；保留原 UUID。
- 页面：缺码事项显示缺失信息、正式货号/原因输入与“补录正式货号”；无关联商品时只给核对说明，不提供自动建档/测试码。

### 2.5 重量列口径（LS101501）

- `diff` 增加 `unitConfirmed`：只有该商品该字段被人工确认口径时，才允许原本“单位未确认”的字段被采用/写入。
- 计划层 `override` 对目标字段强制采用人工值（即使本地存着旧的不可用原文），写入变更、采用与确认后的 `unit_state=confirmed`。
- 本机对该商品登记 `override / unitWeight = 0.05`，原因记录“O 列 0.05/件；箱重以 T 列 24.15 为准，忽略 O 列夹带的 24.45/箱”；原表原文保留在来源快照/批次证据，不推及其他商品。

### 2.6 页面与只读投影

- `ProductSourcePanel` 新增：同号多行差异对照表（字段 × 行号、空值“（空）”、不一致高亮、单选、备注、保存/重新选择、`decisionStale` 提示）；字段级“暂不处理此字段”“按人工口径采用”；缺码补正式货号；已登记人工决定列表与“恢复处理/撤销选择”。
- 商品库“待处理”：同一商品的缺货号只显示一次（商品来源 `item` 级缺码事项优先，新品缺货号投影不再重复计数）；工具栏徽标随之收敛。
- `read_product_source_overview` 增加 `scope/itemId/itemRevision`；新增 `read_product_source_manual_decisions`；新表仅授予 app runner `SELECT`（plan 读取 active 决定），无写权限、PUBLIC 不可执行。
- 批次行现在同时保存规范化 `fields`（非受限），供同号选择/补号读取真实行内容；`rowsSha256` 不含 fields，批次哈希不变。

## 3. 本机数据库执行

1. **036 安装**：`node scripts/catalog/apply-036.mjs --commit --allow-live-commit`
   - 现役库 rollback 模式 **84/84 PASS**；clone 库 commit ×2 **84/84 PASS ×2**；行为验证 **74/74 PASS**（A30/B12/C8/D15/E9，全部事务内 ROLLBACK）。
   - 发现并修复 1 个 P0：`reconcile` 的 `DECLARE r record` 与批失败子查询别名 `r` 冲突导致 55000；已改为 `res` 并复验。
2. **人工决定落库**：`node scripts/catalog/apply-036-corrections.mjs --commit`
   - 13 步、0 error：6 条字段暂不处理、1 条 LS101501 人工口径、4 组同号选择、1 次测试码纠正、1 条旧 `row:122` 缺码事项关闭。
   - 结果：field decisions **7 active**（6 defer + 1 override）、duplicate decisions **4 active**、测试码 **0**、open 事项 **1**（烟酰胺商品级缺码）。
3. **干净快照采用**：采用 11:10 已复核快照 `99f71044…`（先在克隆库提交验证，再本机提交）
   - 计划/回执：`updated 2 / unchanged 123 / needsReview 0 / failed 0 / missing 0`，`status=applied`。
   - 旧 12 条待办全部退出：4 组同号 `resolved`（人工选择）、6 条字段 `ignored`（暂不处理）、LS101501 `resolved`（人工口径）、旧 `row:122` `resolved`（原表行删除）；新批事项 0。
   - 商品仍 **126**（未新建重复商品）、修订 **225**、批次 **2**、绑定 **125**、采用 **1082**、open **1**。
   - LS101501 当前修订 3：`unitWeight=0.05`（`unit_state=confirmed`）、`cartonWeight=24.15`，原 O 列原文仍在批次证据。
   - 烟酰胺 TEST 商品：修订 3、`ice_code_snapshot=NULL`、无 `catalog_item_code`、`item` 级缺码事项 open；在途明细仍 1 条 3,840 件、关联记录仍 1 条。

## 4. 验收

### 4.1 执行方自验

- **UI 验收 17/17、console/pageerror 0**（`.local/.../acceptance-ui.json`、截图 `acceptance-ui-sync.png`）：登录 → 数据同步；待核对 1 条且为烟酰胺缺货号；补号入口与 TEST- 禁止提示；已登记决定 7 条字段 + 4 条同号；无未决同号对照；已采用批次 `已更新 2 / 待核对 0 / 失败 0`；仍如实显示之后的外部新快照；商品库徽标 3（2 条既有 + 1 条来源）。
- **数据库回读**：见 §3；`probe-after-apply.mjs`、`probe-final-counts.mjs`、`probe-issue-states.mjs`。
- **构建一致性**：BUILD `f01YzlOS-50acpRBPRpAP` ↔ 源码快照 `60f8047b…` ↔ staging `next-build-60f8047b943405ea` ↔ preview-server 一致；3011 login 200。
- **检查**：`tsc --noEmit` 仅既有 BEST 5；改动文件 eslint 0；`npm test` **824/825**（唯一失败为既有 Windows 换行 `opt6-production-apply` 基线）；产品来源单测 67/67、面板恢复/恢复测试 5/5+5/5、issue-index 27/27。

### 4.2 隔离库验证

- 036 安装/幂等/回滚 84/84 ×3；行为 74/74（跨批去重/归并/retry 保留、defer/override、同号选择、测试码纠正、权限负向）。
- 干净快照在 clone 库提交成功（`updated 2 / review 0 / open 1`），再在本机提交；clone 已 DROP，dump 已删。

## 5. 已知边界 / 外部来源变化

- **12:10 外部新快照不可直接采用**：定时读取 12:10 捕获的快照 `a8458b60…` 有 133 行业务数据，但 E 列“生产工厂”有 93 个 `#REF!`。按最终 BUILD 同源代码 + 现役库（126 商品/125 绑定/1082 采用/2 批/7 条字段决定/4 条同号决定）独立 `buildPlan`：`apply / results 128 / created 1（WM0131）/ updated 1（WM0092）/ unchanged 30 / needsReview 96 / failed 0 / missing 0`，其中 96 = `formula_error 93 + group_field_conflict 1 + suspected_code_change 2`；无人工决定时同一快照为 104 条待核对。该快照**未采用**，面板如实显示“待应用 1 批（12:10）”；需等飞书原表修复后再读取/应用。本轮未改飞书，也未把工厂字段扩大为全局忽略。
- 12:10 快照同时出现 WM0131–WM0133 等新货号，其中 WM0131 为“烟酰胺提亮精华水 150ml”；因快照整体不可用，未据此补号/建档；烟酰胺当前仍按用户要求“货号待确认”。
- 同号多行选择以 11:10 快照内容指纹为准；12:10 若修复后内容变化，计划会重新提示（`decisionStale`），不会静默沿用。
- 历史第 1 批的 `product_source_row.fields` 为空（015 当时未存 fields）；服务层读取时用 `batch.collection.headers + row.cells` 重建，再计算内容指纹；4 组同号决定的指纹已按重建值复核（`chosen/basis` 与 11:10 计划一致）。一次性脚本 `apply-036-corrections.mjs` 直接读 `row.fields`，只适用于已有 fields 的新批次；对历史批次重跑需走服务层重建，不要用空 fields 计算。
- 恢复字段决定只撤销决定，不回滚已写入商品；撤销后需等下一次读取/应用重新生成事项。
- 本轮未改飞书原表、未新增产品分类表；未做权限矩阵、200% 缩放、多日稳定性、Mac 迁移验证；未提交/推送/部署，上一部署准备包改动保留未提交。

## 6. 相关文件

- 迁移：`db/catalog/036_product_source_review_flow.sql`
- 安装/验证：`scripts/catalog/apply-036.mjs`、`scripts/catalog/apply-036-corrections.mjs`
- 计划/差异：`src/features/catalog/product-source/{contract,anomaly,plan,diff,service,repository,actions,schema,panel-types,server-types}.ts`
- UI：`src/features/catalog/components/product-source-panel.tsx`、`product-source-panel.module.css`
- 待处理去重：`src/features/catalog/issues/issue-index.ts`
- 测试：`tests/catalog/product-source.test.ts`、`src/features/catalog/issues/issue-index.test.ts`

## 7. 独立复核记录

- **独立差异复核 PASS、阻断 0**（[报告](../../.local/catalog/feishu-source-review-flow-20261110/independent-review.md)；PASS 由独立复核给出，执行方不自行宣布）。
- 首轮复核 9/10 项 PASS，阻断 1（B1）：任务文档对 12:10 快照的只读计划写成“待核对 100 / 87 条 formula”，与最终 BUILD 同源代码 + 现役库复算不符（实测 `created 1（WM0131）/ updated 1（WM0092）/ unchanged 30 / needsReview 96 / failed 0`，96 = formula 93 + group 1 + suspected 2；无人工决定时 104）。
- 修复：任务文档 §5 改为实测值，并同步 `docs/current-state.md`、`docs/tasks/current-task.md`、`AGENTS.md` 的同一数字；未改代码/DB/构建。
- 第 2 轮复核 **PASS、阻断 0**（报告追加“第 2 轮复核”小节；任务文档 sha256 `43446DF9…`）。复核自核 BUILD/源码/DB/HEAD 未变，12:10 快照仍明确未采用、无自宣 PASS。
- 复核覆盖：036 安装与权限、`reconcile` 不再 55000、跨批事项状态、7 条字段决定、4 组同号决定指纹独立重算 4/4、TEST 商品与 3,840 在途、LS101501 `0.05/24.15/confirmed`、真实浏览器 17/17、构建/测试/tsc/eslint、12:10 快照未入批次。
- 非阻断观察（不影响裁定）：`reconcile` 现役探针只证不再 55000，跨批归并语义由 clone 74/74 覆盖；clone commit “×2” 仓内仅一份 commit JSON（日志两段）；一次性脚本 `apply-036-corrections.mjs` 复核期间 mtime 变化但内容未参与运行/构建；3011 的 53644 为 launcher、listener 44368。

## 8. 2026-11-10 补修轮（用户指定的三项）

用户本轮只要求处理三项，不扩大：同号脚本代选核对、WM0131 名称空格关系、LS101501 重量口径。12:10 含工厂 `#REF!` 的快照继续保持未采用；产品分类表不做。

### 8.1 同号多行：撤销脚本代选并恢复可操作入口

- **核对结论**：没有真实人工选行记录。4 条 active `duplicate_decision` 是 `scripts/catalog/apply-036-corrections.mjs` 按“第一个 69 码非空行，否则最后一行”推断写入；4 条 `decided_at` 毫秒级相同、`decided_by` 均为服务管理员 UUID；用户上轮口径明确“提供能力，不替用户选定四组资料”（§1 第 3 条）。审计见 `.local/catalog/feishu-source-review-fix-20261110/item1-duplicate-choice-audit.md`。
- **撤销与重建**：4 条决定全部 `superseded`（备注“撤销脚本代选：无真实人工确认记录，恢复待人工确认”）；在最新已应用批次 `faa9f064…` 重建 4 条 open 同号事项，行号用该批真实行 **63/127、64/128、65/129、67/131**，差异仅 69 码（旧行空、新行有值），页面重新出现逐字段对照、单选、保存入口。
- **已采用字段定向处理**：删除 4 条只来自脚本选行的 `barcode` adoption（adoptions 1082→1078），`nameCn` 等其余 adoption 保留；WM0073 当前 revision 2 的 `barcode=757577407359` 通过追加 **revision 3** 恢复为空（`fields` 去掉 barcode，`previous_revision=2`，原因“撤销脚本代选，恢复待人工确认”），rev1/rev2 原样保留。说明：rev1 的 barcode 是显式空 observation，rev3 省略该键，两者当前值同为“未填”，历史仍在 rev1。
- 现役补修后：open 事项 **5**（4 同号 + 1 商品级缺货号）、duplicate decisions 4 条全部非 active、revisions **226**、adoptions **1078**。

### 8.2 WM0131：名称空格差异只提示关系，不新建/不自动绑定

- `normalizeIdentityName` 对名称去空白后再比较（仅用于提示），`findIdentityHint` 先精确、再“去空格同名”；WM0131 来源名 `ICE LERSKIN 烟酰胺提亮精华水 150ml` 命中现有无货号商品 `ICE LERSKIN 烟酰胺提亮精华水150ml`。
- 12:10 快照只读计划实测：`created 0 / updated 1 / unchanged 26 / needsReview 101 / failed 0`；WM0131 为 `needs_review / MISSING_CODE_CANDIDATE`、`itemId=TEST 商品`、detail 带 `matchedItemName / matchedBy=normalizedName / sourceCode=WM0131`，**不新建**。
- 面板预览追加人工确认提示（真实页面原文）：“需人工确认：来源货号 WM0131 与现有商品「ICE LERSKIN 烟酰胺提亮精华水150ml」名称一致（仅空格不同），确认同一商品后再补号；不会自动新建或绑定。”应用后（或当前批次）事项卡片提供“确认同一商品并补录货号”入口，明确保留原 UUID/历史/在途关联、不自动建档。受控 UI 探针（临时 issue，验证后删除，未点确认）**7/7**。
- 补号闭环：`assign_product_source_code` 补号后除关闭 item 级缺货号外，还关闭 batch 级同码/该商品候选事项（`closedCandidateIssues`）；克隆库探针验证 TEST 商品 UUID、修订历史、3,840 在途、关联 1 条均不变。

### 8.3 LS101501：退出固定 0.05，按指定来源列解释重量

- 撤销 active `override unitWeight=0.05`（revoked，保留历史），登记 2 条 `interpret` 决定（只对 LS101501 的该字段生效，不是全局规则）：
  - `unitWeight = unit_weight_per_unit_fragment`：从 O 列 `0.05/件\n24.45/箱` 取“/件”片段 0.05，忽略“/箱”片段；
  - `cartonWeight = confirmed_source_value`：箱重取专门 T 列 24.15，并确认单位。
- 12:10 快照只读计划（该快照工厂列 `#REF!` 导致整条 `needs_review/SOURCE_FORMULA_ERROR`，属不相关字段）：unitWeight **无变更、无新修订**；cartonWeight adoption 记为 `24.15 / confirmed`；商品 revision 仍 3。把 O 列改为 `0.06/件` 后，**字段级 changes 含 unitWeight `0.05→0.06`**（整条仍因工厂 `#REF!` 为 needs_review）；隔离该无关工厂错误后整条为 update。本地改为 0.055 且来源 0.06 时走原有 `FIELD_CONFLICT` 保留本地，本地 0.055 且来源仍 0.05 时不产生 unitWeight 变更。以上由现役库事实 + 真实快照的内存计划探针 **4/4** 与单测覆盖。
- 不写商品字段、不新增修订（LS101501 revision 仍 3）；其他商品/字段沿用原规则。

### 8.4 验收与现场

- 037 安装：现役 rollback **29/29**、clone commit（两次安装）**34/34**；新 RPC/约束/权限/assign 候选闭环探针通过。
- 补修：clone commit **16/16** ×2（第二次 executed=0/skipped=8 幂等）、独立断言 **22/22**；现役 dry-run **14/14**、commit **16/16**。现役最终：items 126、revisions 226、codes 125、adoptions 1078、batches 2、open 5、active duplicate 0、active field 8（6 defer + 2 interpret）、association 176。
- 产品来源单测 **75/75**（新增 8 项）、issue-index **27/27**、全仓 `npm test` **832/833**（唯一失败为既有 Windows 换行 `opt6-production-apply`）、`tsc` 仅既有 BEST 5、改动文件 eslint 0、`git diff --check` 0。
- 真实浏览器验收 **15/15**、console 0：4 组同号对照/单选/保存、无已登记同号选择；LS101501 2 条“按来源列解释”；预览出现 WM0131 关系提示且 `新品 0 / 待核对 101`；12:10 仍显示待应用、已采用仍是 11:10；商品库待处理徽标 **7**（2 既有 + 5 来源）。
- BUILD **`FSM-UJjNO5GvyvCAiZWMH`**（源码快照 `0ba237228224fbe6…`），3011 login 200。证据 `.local/catalog/feishu-source-review-fix-20261110/`（`apply-037.json`、`apply-037-commit.json`、`corrections-037-dryrun.json`、`corrections-037.json`、`verify-037-behavior.json`、`acceptance-ui.json`、`probe-relation-ui.json`、`SUMMARY-037.md`）；现役修正前备份 `pre-correction.dump`（SHA256 `FD3263DB…8B92CB6`）。
- 边界：12:10 快照（工厂列 93 个 `#REF!`）未采用，未补号、未改飞书；未新增产品分类表；未做权限矩阵/200%/多日稳定性；未提交/推送/部署。

### 8.5 补修轮独立差异复核（PASS）

- **独立差异复核 PASS、阻断 0**（[报告](../../.local/catalog/feishu-source-review-fix-20261110/independent-review.md)；PASS 由独立复核给出，执行方不自行宣布）。
- 复核独立取证：4 条决定同毫秒/同 actor/脚本规则 → 无真实人工确认；4 条 superseded、active 0；重建事项行号与 barcode 差异；WM0073 rev1/2/3 与 barcode adoption；WM0131 只读 buildPlan（created 0 / needsReview 101 / 关系 detail）与 DB 无码/在途 3840；LS101501 override revoked + 2 interpret、同值/0.06/本地冲突三种计划；037 约束/权限；BUILD/源码/workspace/staging/server 一致；浏览器只读 5 事项/4 对照/8 字段决定/徽标 7/console 0；`npm test` 832/833、定向 75+27、tsc BEST5、eslint 0、diff 0；HEAD cab7537、12:10 未采用、未补号、无分类表。
- 非阻断观察：O1 §8.3 的 0.06 在真实快照上整条仍 needs_review（已改为“字段级 changes 0.05→0.06”措辞）；O2 WM0073 rev3 省略 barcode 键而 rev1 为 explicit_empty observation（当前值同为“未填”，历史保留，不影响结论）；O3 assign 补号闭环仅在 clone SAVEPOINT 回滚探针验证（现役未补号）；O4 关系卡片渲染由执行方受控探针 + 复核代码审阅/预览文本确认。
