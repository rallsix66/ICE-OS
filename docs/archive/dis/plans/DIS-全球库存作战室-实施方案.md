> 历史归档（2026-10-13）：原位置 `docs/design/dis-plans/DIS-全球库存作战室-实施方案.md`。保留用于旧实现与验收追溯，不作为当前任务或执行授权；现役入口见 [归档索引](../README.md)。

# DIS · 全球库存总览（P7-A 基础总览 + P7-B 作战室增强）· 实施方案（v8 · P7 合并整合）

> 状态：**v7 经 Codex 最终复审，架构结论全部通过；仅 auth 返回对象形状 1 处事实错误，修正为 v8（`requireActiveAuth()` 直接返回 `CurrentActiveUser`，须先 `const user = await requireActiveAuth();` 再取 `user.id`）** ｜ 作者：巴蒂 ｜ 修订：2026-07-12（v2：Codex 审查 10 项；v3：Codex 终审 5 类问题；v4：Rall 终审合并为单一产品；v5：Codex 架构复审 10 类；v6：Codex 最终收口 8 类；v7：Codex 复审最终两项——Repository 接收服务端 userId（禁止客户端构造 p_user_id）/ P7 详情行动字段复用 P1 v8 get_replenishment_suggestions（禁 Migration F 重算行动公式）/ Migration E 依赖 C、F 依赖 C+D / 新增验收 #59–#61，全量 61 条；v8：仅修正 auth 返回对象形状——`const user = await requireActiveAuth(); user.id`，不改任何架构 / RPC / Migration / 公式 / 验收数量，验收保持 61 条）
> 协作分工：本文件属「方案/设计层」产出，交付 Codex 评审、Claude 落盘实现，巴蒂不直接修改 overseas-inventory 实现代码。
> 关联方案：`DIS-首页排版-实施方案.md`、`DIS-喜运达物流轨迹API接入-方案.md`（v8）、`DIS-预测式补货引擎-实施方案.md`（v8）、`inventory-ui-upgrade-plan.md`
> **本轮纪律**：仅修改方案文档；不修改源码 / Migration / 数据库 / 测试。v4 在 v3 已确认修复（算法执行位置统一 / 在途字段拆分 / 读取链路明确 / 伪代码边界补全 / 8 条验收）基础上，将「P7 全球库存基础总览」与「作战室预测增强层」**合并为同一产品的两层（P7-A / P7-B）**，不再建设两个产品级库存总览页面；待 Codex 终审通过，再交 Claude 进入实施。

---

## 0. 修改原因（Codex 审查 10 项，逐条取证）

v1 草案经 Codex 审查，指出方向可行但不能直接实施。巴蒂**逐项读取真实代码核实**后，确认 10 项均属实，本节为修订驱动因素；逐条取证结论见 [§11 取证附录]。

| # | Codex 审查项 | v2 处理 | 取证结论 |
|---|-------------|---------|----------|
| 一 | 路由用根路由 `/war-room`、独立 `app/war-room/page.tsx`，绕过 Dashboard Layout / middleware | **统一为 `/dashboard/war-room`**（页面 `src/app/dashboard/war-room/page.tsx`、模块 `src/features/war-room/`）；经 Dashboard Layout + `getCurrentActiveUser()` + 登录/停用保护 + `SidebarNav`；禁用根路由 | 属实：`src/app/dashboard/layout.tsx` 包裹所有 `/dashboard/*`，调用 `getCurrentUser()`(redirect login) / `getCurrentActiveUser()`(停用阻断) / `SidebarNav`；不存在 `app/war-room` 目录 |
| 二 | 权限按「可见国家」授权，先按 country 聚合再过滤，Operator 可因同国一个仓看到其他仓 | **改为 warehouse_id 级**：`auth.uid()` → `get_assigned_warehouse_ids()` → 过滤 `inventory/shipment/shipment_item` → 再按 country/warehouse 聚合展示；country 仅展示聚合、非授权边界；禁止前端传国绕过 RLS | 属实：`user_warehouses` 表 + `get_assigned_warehouse_ids` RPC（`database.ts:591`）+ `warehouseAccessRepository.getAccessibleWarehouseIds`（admin=全部 active overseas、operator=分配仓）；v1 §2/§4.3 确为「按可见国家过滤」 |
| 三 | 喜运达被当作 ETA+数量数据源 | **V1 前向推演用现有 `shipment`+`shipment_item`**（ETA=`estimated_arrival`、数量=`quantity-warehoused_quantity`，过滤 `cancelled_at`/`bigseller_absorbed_at`/无效状态）；喜运达 `tracking_event_external` 仅外部轨迹展示，不当可计算 ETA/inbound | 属实：`DIS-喜运达物流轨迹API接入-方案.md` §31/§67 明确喜运达**无 ETA 字段**、绝不回写 `estimated_arrival`/`shipment_item`，只 upsert `tracking_event_external` |
| 四 | 缺数据层契约，只写组件拆分 | **补全 `src/features/war-room/{types,schema,repository,actions,components}`**；Server Component/Server Action 取数，Client 不直接连 Supabase；外部参数 Zod 校验；Admin/Operator 同接口由 RLS+warehouse_id 过滤；全状态覆盖；分页采用方案 B 只读 RPC `get_war_room_overview` | 属实：现有 feature 均遵循 `types/schema/repository/actions/components`（`warehouse-access` 等）；Server Action 范式 `'use server'`+Zod+`revalidatePath`（`warehouse-access/actions.ts`）；v1 §7 仅 `lib/war-room/`+`components/war-room/`，无 Repository/Server Action/RPC |
| 五 | 作战室另写 `stockout_day` 算法，与补货引擎不一致 | **复用补货引擎 v6 规范算法**，或抽取共享域函数 `forecastStockout`；统一 remaining/status/cancelled_at/bigseller_absorbed_at/ETA 非空/GROUP BY+SUM/cursor_date/ETA 当天 cur==consume/过期 today/晚到不抵扣/daily_sales 与 lead 边界/`effective_inbound` COALESCE/不写死天数 | 属实：v1 §5.1 `stockout_day(c)` 为独立实现，与补货引擎 v6 §4.3 算法语义不同（无 GROUP BY ETA、无 cancelled_at/bigseller 过滤、写死 12 天 lead） |
| 六 | 国内库存假设为 0，给出「国内无法支援」等基于假 0 的结论 | **国内库存尚未接入**：国内列显示「待接入」，q/daily_sales/inbound 用 NULL（非 0），不参与 `visible_total_quantity`/`earliest_stockout`/`stockout_urgency`；`DomesticJudge` 返回 `data_unavailable`；不展示基于假 0 的结论；生产周期「待定」 | 属实：`warehouse.type` 含 `domestic`，但 `/dashboard/inventory/domestic` 为 phase '2' 未建、无 domestic inventory 数据接入；v1 §5.3 用「国内在手/日销」算 d_cover 并给建议，属假 0 |
| 七 | 行以 sku/name 合并，无稳定主键 | **默认行主键 `product_variant.id`**；每行含 `variant_id`/`product_id`(nullable)/`sku`/`variant_country`/`product_name`/`variant_name`；禁止只按 sku/name 合并 | 属实：`product_variant`（`database.ts:93`）`id` 为 PK、`product_id` 可空、`sku`/`country`/`name` 均存在；v1 §2/§4.2 以「每个 SKU 一行」为键 |
| 八 | 字段名 `net_sellable` 暗示国家间可调拨 | **改名 `visible_total_quantity`**，明确仅当前用户可见范围内库存总量，不代表国家间可调拨/可替代；最早断货与紧急度仍按国家/仓库独立计算 | 属命名与语义修正：v1 §4.2 用 `net_sellable` |
| 九 | 验收标准缺权限/算法/数据完整性边界 | **新增 20 条验收**（见 §9，含未登录/停用拦截、Operator 仅 assigned、同国不跨仓、国内缺失待接入、喜运达不当 inbound、同 ETA 只扣一次、effective_inbound 空集合 0 等） | 属实：v1 §9 仅 8 条 UI 交互验收 |
| 十 | 总纲 P2 声称喜运达已提供 ETA+数量 | **同步总纲 P2**：不声称喜运达提供 ETA+数量；明确 V1 用 shipment/shipment_item 人工 ETA；明确 `/dashboard/war-room`、warehouse_id 权限、国内仅待接入、复用补货引擎算法、API/RPC 方案、更新前置与验收 | 属实：总纲 L112 交付物写 `/war-room`、L114 评审重点写「权限按可见国家过滤」、L127 M0「解锁作战室在途 ETA」措辞过度 |

### 0.1 v3 终审修改（Codex 复审 5 类问题，逐条取证）

v2 经 Codex 复审，指出仍不能直接实施。巴蒂**逐项读取真实代码/文档核实**后，确认 5 类问题属实（算法执行位置、字段语义、读取链路为架构级）；本节为 v3 修订驱动因素，逐条取证结论见 [§11.1 取证附录]。总纲同步要求见 [§11.1 七 / 总纲修订]。

| # | Codex 终审问题 | v3 处理 | 取证结论 |
|---|---------------|---------|----------|
| 二 | 预测算法执行位置未统一：方案同时写 `src/lib/forecast/stockout.ts`、`get_war_room_overview` 内调 `forecastStockout`、RPC 内「等价 SQL」→ TypeScript 与 SQL 各维护一套，违反「作战室与补货引擎必须共用同一实现」 | **选定推荐路径：新增统一数据库内部函数 `forecast_stockout(p_on_hand, p_daily_sales, p_lead_time_days, p_inbound jsonb)`**；`get_replenishment_suggestions`（P1）与 `get_war_room_overview`（P2）**都调用该 DB 函数**；删除 `src/lib/forecast/stockout.ts` 与「等价 SQL」未决表述；同步 P1 方案 §4.3/§6.2 抽取同一函数 | 属实：P1 v6 §4.3/§6.2 算法为 RPC 内联 CTE（无独立函数）；war-room v2 §5.1/§7.1/§7.3 同时引用 TS 域函数 +「或等价 SQL」，确为两套实现风险 |
| 三 | `visible_total_quantity = visible_on_hand + effective_inbound`，但 `effective_inbound` 仅含 `eta <= est_stockout_date` 数量 → 晚到在途不显示于可见总量，字段语义冲突 | **拆分**：`visible_inbound_quantity`（全部有效在途 remaining，含 ETA NULL）+ `effective_inbound`（仅 `eta <= est_stockout_date`，用于断货预测/net_demand/补货建议）+ `eta_missing_quantity`（ETA=NULL 在途，数据质量标记）；`visible_total_quantity = visible_on_hand + visible_inbound_quantity` | 属语义修正：v2 §4.2/§4.4 将 `effective_inbound` 直接并入可见总量，与 §5.1 口径矛盾 |
| 四 | §7.1「Server Component 调用 Server Action 取数」链路不清；缺详情接口定义 | **明确 `page.tsx → Repository → RPC`**；Server Action 仅用于客户端触发写入/revalidate；详情接口采用方案 B 新增只读 RPC `get_war_room_variant_detail`（返回 variant 聚合 + assigned 仓库明细 + country 聚合 + eta_missing 等，DB/Repository 层先按 warehouse_id 过滤） | 属链路澄清：v2 §7.1/§7.2 混用「Server Action 取数」与「Repository」表述，缺详情接口契约 |
| 五 | §5.1 伪代码缺 `daily_sales`/`lead_time_days` 多仓混合与稳定排序边界 | **补全伪代码边界**：`ds` NULL/<=0 不进事件模拟、`est_stockout_date=NULL`/`stockout_urgency=data_incomplete`/`effective_inbound=0`；`lead` NULL/<=0 不生成 `latest_order_date`、标 `lead_time_status=data_incomplete`、不写死天数；多仓仅 `ds` 有效者参与 `earliest_stockout`、`ds` 无效不当 0、全无效行级 `earliest_stockout=NULL`+`data_incomplete`、部分有效标 `partial_data`；分页 `ORDER BY earliest_stockout NULLS LAST, variant_id` | 属边界补全：v2 §5.1 仅含单仓模拟，未定义多仓混合与稳定排序 |
| 六 | 验收缺多仓混合 / ETA 缺失 / 晚到 / 稳定排序 / 详情权限 / 读取链路 / P1-P2 同函数等 | **新增 8 条验收（§9.3，#29–36）** | 属验收补全：v2 §9.1 仅覆盖单仓 `daily_sales=NULL` 的部分场景，未覆盖多仓混合/ETA 缺失/晚到/稳定排序/详情权限/读取链路/同函数 |

### 0.2 v4 合并整合（Rall 终审：P7 与作战室合并为单一产品）

v3 技术问题基本修复，但 Rall 终审发现 **P7（全球库存基础总览）与作战室（预测增强层）仍是两个独立产品级库存总览页面 / 两套方案 / 两套 RPC**，须合并为单一产品的两层。巴蒂**逐项读取真实文档/代码核实**后，确认合并必要；本节为 v4 修订驱动因素，逐条取证见 [§11.2 合并取证]。

| # | Rall 终审合并项 | v4 处理 | 取证结论 |
|---|----------------|---------|----------|
| 一 | 产品定位分裂：P7（`/dashboard/products/overview`）+ 作战室（`/dashboard/war-room`）是两个产品级库存总览页 | **合并为单一产品「全球库存总览」**：P7-A 基础总览 + P7-B 作战室增强层，不再建设两个页面 | 属实：`current-state.md:38` P7 路由 `/dashboard/products/overview`；本方案 v2/v3 路由 `/dashboard/war-room`；二者均为产品级总览，冲突 |
| 二 | 路由未统一：P7 用 `/dashboard/products/overview`，作战室用 `/dashboard/war-room` | **唯一正式路由 `/dashboard/products/overview`**（P7 已确认路由）；页面标题显示「全球库存作战室」；旧规划路由 `/dashboard/war-room` **退役**（不存在第二页面，若曾建须 301 重定向） | 属路由统一：v3 §2#1 用 `/dashboard/war-room`，与 P7 已确认路由冲突 |
| 三 | 列表 RPC 未统一：P7 原计划「暂不新增 RPC」、作战室新增 `get_war_room_overview` → 两套产品总览 RPC | **唯一列表 RPC `get_product_overview`**（合并后统一命名）；详情 RPC 保留 `get_war_room_variant_detail`；不得再设计第二套产品总览 RPC | 属实：`current-state.md:34` P7「新 RPC 暂不新增（待验证）」；本方案 v3 §7.3 新增 `get_war_room_overview` |
| 四 | 国内库存边界：两方案各自描述，未对齐「待接入 / NULL / data_unavailable」 | **P7-A、P7-B 的 V1 均统一**：国内数量/日销/在途 = NULL、`domestic_status=data_unavailable`、页面「待接入」、生产周期「待定」；不得参与 `visible_total_quantity`/`earliest_stockout`/`stockout_urgency`/国内补给判断；真实国内接入统一放到 P8 | 属边界统一：两方案均已有 NULL/占位描述，v4 显式合并并划归 P8 |
| 五 | P7 阻塞状态：`BLOCKED_BY_DOMESTIC_INVENTORY` 阻止 P7 启动 | **解除阻塞**：改为「P7-MVP 可实施海外基础总览，国内字段待接入」；明确 P7-A 不依赖 P8、P7-B 依赖 P1 预测函数、国内补给判断依赖 P8、P8 完成后启用 P7-C | 属实：`current-state.md:7` / `current-task.md:7` P7 状态 `BLOCKED_BY_DOMESTIC_INVENTORY` |
| 六 | 实施顺序未统一：P7 与作战室各自排期 | **统一顺序**：P7-A（基础总览）→ P1（补货引擎）→ P7-B（作战室增强层）→ P8（国内接入）→ P7-C（启用国内补给判断）；P0 喜运达并行（V1 仅外部轨迹展示） | 属顺序统一：原总纲 P2 独立、P7 独立，v4 合并重排 |

### 0.3 v4 → v5 修订（Codex 架构复审 10 类实施级问题，逐条取证）

v4 定位（合并为单一产品、唯一路由/唯一列表 RPC/唯一详情 RPC/国内占位/warehouse_id 权限/复用 forecast_stockout）均正确，但 Codex 复审指出 10 类实施级阻塞，暂不能直接交 Claude。巴蒂**逐项读取真实代码/文档核实**后确认均属实；本节为 v5 修订驱动因素，逐条取证结论见 [§11.3 取证附录]。总纲当前存在顺序旧描述，本轮**禁止修改总纲**，仅在 [§8 待同步事项] 记录，等总纲单独审查时处理。

| # | Codex 复审问题 | v5 处理 | 取证结论 |
|---|---------------|---------|----------|
| 一 | 实施顺序与 RPC 依赖冲突：v4 同时写「P7-A 不依赖 P1」「get_product_overview 一次性返回全部字段」「get_product_overview 调用 forecast_stockout」，三者不能同时成立 | 明确实施顺序 **P0 → P1 → P7-A → P7-B → P8 → P7-C**；P7-A 基础展示业务语义不使用预测字段，但按当前实施顺序 P7 的 DB/页面实施发生在 P1 之后；get_product_overview 保持稳定完整返回契约，P7-A 页面只展示基础字段、P7-B 再开启预测列；删除「P7-A 可在 P1 Migration 之前独立创建完整预测 RPC」表述；不再设计两版同名 RPC、不增临时 RPC | 属实：P1 v8 已固定 Migration A=00041/B=00042/C=00043_forecast_stockout/D=00044；P7 实施在 P1 之后，Rpc 若返回预测列须 forecast_stockout 已落盘 |
| 二 | P1 Migration 引用错误：v4 活动正文曾误将创建 forecast_stockout 的 Migration 写作 D（实际为 C/00043） | 活动正文全部改为 **forecast_stockout 由 P1 Migration C（当前预定 00043）创建**；P1 版本统一写 v8、P0 版本统一写 v8；历史取证段（§0.1 / §11.1）保留旧过程但标注「历史记录，非当前契约」 | 属实：P1 v8 §5.4 明确 C=`00043_forecast_stockout.sql` 创建共享函数；v4 活动正文误写 Migration 编号 |
| 三 | 缺 P7 自身 Migration 设计 | 新增 **Migration E（00045_product_overview_rpc.sql，创建 get_product_overview）/ F（00046_war_room_variant_detail_rpc.sql，创建 get_war_room_variant_detail）**；执行 P1 A→B→C→D → P7 E→F，回滚 F→E；均含 SECURITY INVOKER / SET search_path / REVOKE PUBLIC·anon / GRANT authenticated；不建新表、不改 RLS、不改既有 Migration | 属实：v4 设计了两个 RPC 却无 Migration 文件、执行/回滚顺序 |
| 四 | Admin 仓库过滤逻辑与真实函数不符：v4 称 `get_assigned_warehouse_ids()` 对 admin 返回全部 active overseas，但真实 SQL 仅查 `user_warehouses` | 统一权限逻辑：RPC 先校验 auth.uid() 非空 / p_user_id=auth.uid() / profile 存在且 is_active / 角色仅 admin·operator；**Admin 可见集合 = warehouse.type='overseas' AND is_active=true（不依赖 user_warehouses）**；**Operator 可见集合 = get_assigned_warehouse_ids() 与 active overseas 取交集**；无角色/停用/未登录直接拒绝；先生成可见 warehouse_id 集合再过滤 inventory/shipment/shipment_item，最后按 warehouse/country 聚合；country 仅展示/筛选、非授权边界；保留 SECURITY INVOKER + RLS | 属实：`supabase/migrations/00015_user_warehouses.sql:49-59` 的 `get_assigned_warehouse_ids()` 仅 `SELECT warehouse_id FROM user_warehouses WHERE user_id=auth.uid()`，不返回 admin 全量；admin 全量由 `cachedGetAccessibleWarehouseIds`（`warehouse-access/repository.ts`）在应用层计算，须下推到 RPC |
| 五 | 列表 Variant 驱动集合未定义，可能笛卡尔积/虚假数据 | **inventory 为列表驱动表**：只展示当前用户可见 active overseas warehouse 中存在 inventory 行的 variant；每个可见 variant_id 聚合一行；quantity=0 现有行保留显示缺货；无 inventory 行不生成合成仓库数据、不进列表；shipment_item 只对已进入驱动集合的 (variant_id,warehouse_id) 聚合；不为「只有在途、无 inventory」的 variant 虚构 on_hand=0；该能力记后续增强；product_variant.product_id 可 NULL、product 用 LEFT JOIN；行键恒为 product_variant.id | 属语义修正：与 P1 v8 inventory 驱动表一致，避免 variant×warehouse 笛卡尔积 |
| 六 | 详情弹窗真实调用链缺失：v4 误将详情读取写成由页面在点击时直接取数，点击行后 Server Component 不会自动重执行 | 固定两条调用链：① 列表首屏 `page.tsx → productOverviewRepository.getProductOverview() → get_product_overview RPC → RLS`（不经 Server Action）；② 点击行懒加载 `ProductModal/客户端 → getProductVariantDetailAction → requireActiveAuth → Zod(variantId) → productOverviewRepository.getProductVariantDetail → get_war_room_variant_detail RPC → RLS`；actions.ts 仅承载客户端懒加载详情读取；Client 不得直连 Supabase；Server Action 不信任前端 userId/角色/可见仓/国家，userId 取自 requireActiveAuth，variantId 仅查询条件；RPC 仍按 warehouse_id 过滤；只返回友好中文错误；详情读取不需 revalidatePath。删除「详情由页面在点击时直接取 Repository」不可能链路 | 属链路澄清：v4 §7.4 的详情读取链路在点击交互下不可行 |
| 七 | P7 断货风险（stockout_urgency）与 P1 下单紧迫度（replenishment_urgency）同名冲突（均曾称 urgency） | 固定命名：**P7 断货风险 = `stockout_urgency`**（critical/warning/ok/data_incomplete）；**P1 下单紧迫度 = `replenishment_urgency`**（来自补货建议 urgency/最晚下单日语义）；get_product_overview 筛选参数改 `p_stockout_urgency`；P7 决策队列用 stockout_urgency；详情 P1 行动层用 replenishment_urgency；禁止两规则共用同一字段名 | 属命名冲突：同名会导致 RPC/TS/UI 混淆 |
| 八 | 基础告警使用魔法数字 8，又列为开放问题 | V1 直接复用现有库存状态语义：**quantity=0 → out_of_stock**；`match_status='matched' AND quantity>0 AND quantity<=product.safety_stock` → **low**；matched 且 quantity>product.safety_stock → **normal**；product_id=NULL/unmatched → **unmatched**（不用 safety_stock=0 制造「正常」）；行级按可见仓库最严重聚合 out_of_stock>low>normal>unmatched；删除魔法数字阈值与「低库存阈值待确认」开放问题；不增另一套低库存公式；不以 visible_total_quantity 判断单仓低库存 | 属告警修正：现有 `get_overseas_inventory`/`get_low_stock` 已用 quantity 与 product.safety_stock 判断状态，无需新阈值 |
| 九 | P0 外部轨迹在 P7 无落地契约 | V1 固定收口：**P7 V1 不直接读 tracking_event_external**；在途计算只用 shipment+shipment_item；P0 外部轨迹继续在 Shipment 详情页展示；P7 如需跳转用 shipment_id 跳现有 Shipment 详情，不在本期复制轨迹列表；P0 不是 P7-A/P7-B 的计算或页面前置依赖；「P7 直接展示外部轨迹」移后续增强，不作 V1 已交付能力 | 属实：v4 §4.1/§8 声称 P0 tracking_event_external 用于 P7 展示，但两 RPC 返回字段均无外部轨迹、页面无轨迹区、Variant→外部运单粒度未定义 |
| 十 | 缺 RPC 返回与分页计数契约 | 明确 get_product_overview 稳定返回契约（含 base_stock_status / stockout_urgency / partial_data / queue_counts / total_count / domestic_status='data_unavailable' 等）；queue_counts 在 DB 中对搜索+country 等基础过滤后的完整结果计算，选中档位不改变各档原始计数；分页在全局排序+筛选后执行；排序固定 stockout_urgency 优先级 → earliest_stockout NULLS LAST → variant_id；P7-A 不显示决策队列但可忽略稳定契约中的预测字段；参数 p_user_id/p_page/p_page_size(默认20最大100)/p_search/p_stockout_urgency/p_country(仅展示) | 属契约补全：v4 未定义 queue_counts 计算时机与排序/分页契约 |

### 0.4 v5 → v6 最终收口（Codex 复审 8 类最终收口问题，逐条取证）

v5 十类架构问题已通过（实施顺序 / P1 Migration C / P7 E·F Migration / Admin-Operator 权限方向 / inventory 驱动 / LEFT JOIN / 两条调用链 / urgency 分离 / 复用 safety_stock / P0 V1 不用外部轨迹计算 / 50 条验收），不得改回。但 Codex 复审指出 v5 活动正文仍有 8 类**局部自相矛盾/契约不闭合**问题，须最终收口。巴蒂**逐项读取真实代码/文档核实**后确认均属实；逐条取证结论见 [§11.4 取证附录]。本轮**仅改本方案文档**，不改总纲/其他方案/源码/Migration。

| # | Codex 收口问题 | v6 处理 | 取证结论 |
|---|---------------|---------|----------|
| 一 | 产品决策摘要（§2 决策 3）仍写 `auth.uid() → get_assigned_warehouse_ids() → 过滤`，未体现 Admin 分支，会误导实施者对 Admin 直接调 `get_assigned_warehouse_ids()` | §2 决策 3 改为完整分支：`auth.uid()` → 校验 `profiles.is_active` 与角色 → 按角色生成可见集合（Admin=全部 active overseas；Operator=`get_assigned_warehouse_ids()` 与 active overseas 交集）→ 过滤 `inventory/shipment/shipment_item` → 再聚合 warehouse/country；§4.2 一行描述改为「每个当前用户可见、且至少存在一条 inventory 行的 `product_variant.id` 聚合为一行」 | 属实：v5 §2 决策 3 摘要与 §4.3 分支逻辑不一致（`00015_user_warehouses.sql:49-59` 证明 `get_assigned_warehouse_ids()` 不含 admin 全量） |
| 二 | P0 外部轨迹仍被列为 P7 活动数据源：§3 数据层、§4.1 数据源表/说明、§8 图仍写「P7 展示 tracking_event_external / 喜运达外部节点」，与后文「P7 V1 不读取」矛盾 | 活动正文统一：P7 V1 数据源仅 `inventory`/`product_variant`·`product`/`warehouse`/`shipment`/`shipment_item`/P1 `forecast_stockout` 及补货契约；`tracking_event_external` 不属 P7 V1 数据源；P0 外部轨迹只在现有 Shipment 详情页展示，P7 仅用 `shipment_id` 跳转；§8 图 P0 改指向 Shipment 详情页、明确 P0 非 P7 前置依赖；历史章节保留旧描述并标注「历史问题，已在 v6 移出 P7 V1」 | 属实：v5 §3/§4.1/§8 仍列外部轨迹为 P7 展示数据源，与 §4.1 🔒 收口 / §8 说明矛盾 |
| 三 | `partial_data` 仍错误进入 `stockout_urgency` 枚举（§4.2 L175「部分仓库 ds 无效:partial_data」），与「partial_data 是独立 boolean」冲突 | `stockout_urgency` 固定四值 `critical/warning/ok/data_incomplete`；`partial_data` 为独立 boolean（部分有效→取有效仓库最小断货日正常算档 + partial_data=true；全部无效→earliest_stockout=NULL + data_incomplete + partial_data=false）；`queue_counts` 只统计四档 | 属契约冲突：v5 §4.2 枚举与 §5.3/§7.3 独立 boolean 描述不一致 |
| 四 | §7.1 模块注释仍写「Server Action 仅用于写入/revalidate」，与 v5 详情懒加载走 Server Action 读取冲突 | page.tsx 注释改「Server Component：列表首屏直接调用 Repository，不经 Server Action」；actions.ts 注释改「客户端触发的详情懒加载 Server Action：requireActiveAuth + Zod → Repository → 详情 RPC；不用于列表首屏读取，不执行 revalidatePath」 | 属注释冲突：v5 §7.1 注释与 §7.2 链 ②/§7.4 详情懒加载矛盾 |
| 五 | 列表 RPC 把 `queue_counts`/`total_count` 写成随行返回字段，当前页为空时元数据一起消失 | `get_product_overview` 固定 `RETURNS jsonb` 信封 `{items[], total_count, queue_counts{critical,warning,ok,data_incomplete}}`；items 为空仍返回 total_count 与完整 queue_counts；`ProductOverviewResult` 与信封一致；删除「queue_counts 随行返回」描述 | 属契约缺陷：v5 §4.2/§7.3 将 queue_counts/total_count 描述为随行字段 |
| 六 | `queue_counts`/`total_count`/筛选顺序未分开，且「分页与筛选都不改变计数」表述过宽 | 固定流水线 visible_scope→base_cohort→queue_counts（从 base_cohort 统计，受 search/country、不受 stockout_urgency/分页）→filtered_cohort（应用 p_stockout_urgency）→total_count（从 filtered_cohort）→items（排序+分页）；明确 search/country 改变 queue_counts 与 total_count、stockout_urgency 只改 total_count、分页都不改；「选中文档档」错字改「选中档位」 | 属口径不清：v5 §7.3 步骤 8 未区分 base_cohort/filtered_cohort，表述过宽 |
| 七 | 详情 RPC 签名与行动字段粒度不明确：§7.4 标题写 `get_war_room_variant_detail(p_variant_id)` 但入参含 `p_user_id`；P1 行动字段作为 Variant 顶层无仓库字段返回 | 固定双参数签名 `get_war_room_variant_detail(p_user_id uuid, p_variant_id uuid) RETURNS jsonb`（p_user_id 来自 requireActiveAuth、RPC 强制 =auth.uid()、variant_id 仅查询条件）；F Migration REVOKE/GRANT 与 Repository 调用一致；P1 行动字段（net_demand/suggest_qty/latest_order_date/replenishment_urgency）移入 `assigned_warehouse_detail[]` 按 warehouse_id 返回，顶层不放无仓库归属字段；V1 不跨仓求和 suggest_qty | 属实：P1 v8 建议粒度为 variant_id+warehouse_id；v5 §7.4 标题单参数、行动字段在顶层 |
| 八 | `base_stock_status` 判断优先级有歧义：未定义「未匹配且 quantity=0」归属 | 固定 CASE 顺序：`quantity=0→out_of_stock` → `product_id IS NULL OR match_status<>'matched'→unmatched` → `quantity<=safety_stock→low` → `else normal`；unmatched 不参与 low/normal、不 COALESCE(safety_stock,0)；行级严重度 out_of_stock>low>normal>unmatched；§4.5/#46/取证附录统一 | 属歧义修正：v5 同时写 quantity=0→out_of_stock 与 unmatched，未定义交叉场景 |

### 0.5 v6 → v7 最终两项收口（Codex 复审最终两项，逐条取证）

v6 的 8 类收口（JSONB 信封 / queue_counts·total_count 流水线 / partial_data 独立 boolean / P0 外部轨迹移出 P7 V1 / 双参数详情 RPC / 行动字段按仓库返回 / base_stock_status CASE 顺序 / RPC 内部输入校验 / 58 条验收）均已通过，**不得改回**。但 Codex 复审指出 v6 活动正文仍有 2 类**契约不闭合**：① Repository 未强制接收服务端 userId，`p_user_id` 可能被误写成客户端来源；② P7 详情行动字段虽规定放入 `assigned_warehouse_detail[]`，但未规定这些字段如何取得，存在 Migration F 重算 P1 行动公式的风险。巴蒂**逐项读取真实代码/文档核实**后确认均属实；逐条取证结论见 [§11.5 取证附录]。本轮**仅改本方案文档**，不改总纲/其他方案/源码/Migration；P1 v8 预测算法与补货公式保持不变。

| # | Codex 复审问题 | v7 处理 | 取证结论 |
|---|---------------|---------|----------|
| 一 | Repository 未强制接收服务端 userId：v6 §7.1/§7.2 的 Repository 调用漏写 `userId` 第一参数，但 RPC 签名需 `p_user_id` 且该值不能来自客户端 | **固定 Repository 接口携带服务端 userId**：`getProductOverview(userId, params)` / `getProductVariantDetail(userId, variantId)`；`userId` 来自 `requireActiveAuth()`，列表 `page.tsx` 经 Server Component 直接调用 Repository（不经 Server Action），详情 `getProductVariantDetailAction` 经 Server Action 调 Repository；Client 输入只含 `variantId`、不得含 `userId`/角色/仓库列表/国家权限；Repository 不得用客户端数据构造 `p_user_id`；两个 RPC 继续强制 `p_user_id=auth.uid()`（§7.1/§7.2/§7.3/§7.4/§11.5 一） | 属实：§7.3/§7.4 的 RPC 签名均为 `(p_user_id uuid, ...)`，v6 §7.1/§7.2 的 Repository 调用漏写 `userId` 参数，与 RPC 契约不自洽 |
| 二 | P7 详情行动字段未规定取得方式，存在 Migration F 重算 P1 行动公式风险：v6 仅写「P1 行动字段放入 assigned_warehouse_detail[]」，未说明来自何处，可能重实现 `safety_stock`/`target_stock`/`net_demand`/`suggest_qty`/`latest_order_date`/`replenishment_urgency` | **固定 Migration F 复用 P1 v8 唯一实现 `get_replenishment_suggestions`**：为每个已权限过滤的可见仓库调用该 RPC（`p_variant_id`+`p_warehouse_id` 指定、其余 NULL、`p_include_zero:=true`、`p_page:=1`、`p_page_size:=1`），从返回 `data[0]` 映射行动字段（含 `urgency→replenishment_urgency` 重命名）；**禁止 Migration F 复制 P1 行动层公式**（含 `round(ds*lead*buffer)`/`round(ds*lead*cover)`/`greatest(0, target_stock - ...)`）；P7 自身的 `stockout_urgency` 仍按 `earliest_stockout` 计算，与 `replenishment_urgency` 分离；P1 RPC 缺失对应仓库行时返回受控错误、由 Server Action 转友好中文、不暴露 SQL（§7.4/§7.5/§11.5 二） | 属实：P1 v8 `get_replenishment_suggestions` 为行动层唯一实现，v6 未规定 P7 如何取得这些字段，存在重复实现风险 |

> **依赖修正（v7）**：v6 写 Migration F 缺漏对 P1 Migration D 的依赖（仅提 `forecast_stockout` 来自 Migration C）；因 Migration F 现须调用 `get_replenishment_suggestions`（由 P1 **Migration D/00044** 创建），故改为：**Migration E 依赖 P1 Migration C/00043**（生成列表预测字段）；**Migration F 依赖 P1 Migration C/00043 + P1 Migration D/00044**（调用 `get_replenishment_suggestions` 复用行动层）；整体执行顺序保持 **P1 A→B→C→D → P7 E→F**，回滚 **F→E**（§7.5 / §8 / §11.5 三）。

### 0.6 v7 → v8 事实修正（Codex 最终复审：auth 返回对象形状，逐条取证）

v7 架构结论 Codex 最终复审**全部通过**（Repository 接收服务端 userId / Client 不传 userId / Migration F 复用 P1 `get_replenishment_suggestions` / P1 行动公式不在 P7 重复实现 / Migration E 依赖 C、F 依赖 C+D / 多仓行动字段按 `warehouse_id` 返回 / 61 条验收计数正确），**不得修改以上架构结论、不改变 P1 v8 公式**。唯一需修正的是 v7 活动正文对 `requireActiveAuth()` 返回对象**形状**的事实性写法错误。巴蒂**读取真实代码 `src/lib/auth.ts:131-134` 核实**后确认属实；逐条取证见 [§11.6 取证附录]。本轮**仅改本方案文档**，不改任何架构 / RPC / Migration / 公式 / 验收数量。

| # | Codex 最终复审问题 | v8 处理 | 取证结论 |
|---|-------------------|---------|----------|
| 一 | v7 §7.1/§7.3/§7.4 误把 `userId` 来源写成对 `requireActiveAuth()` 返回值再链式取 `user` 子属性的 id；但 `requireActiveAuth()` 直接返回 `CurrentActiveUser`（字段 `id`/`email`/`displayName`/`roleName`/`isActive`），无 `user` 包裹层，此类链式取子属性会在运行时取到 `undefined` | 统一改为 `const user = await requireActiveAuth();` 后取 `user.id`：**列表** `const user = await requireActiveAuth(); productOverviewRepository.getProductOverview(user.id, params)`；**详情** `const user = await requireActiveAuth(); productOverviewRepository.getProductVariantDetail(user.id, variantId)`；§7.1/§7.2/§7.3/§7.4/#59/§11.5/footer 全部核对为同一写法；活动正文不出现对返回值再链式取 `user` 的错误写法（即 `requireActiveAuth()` 后接 `.user` 或 `.user` 再 `.id`，以及 `user`·`activeUser` 的双层 `.user` 取 id） | 属实：`src/lib/auth.ts:131-134` `export async function requireActiveAuth(): Promise<CurrentActiveUser>` 返回值即 `CurrentActiveUser` 本体，`user.id` 才是正确取值；对该返回值再取 `user` 子属性会访问不存在的属性 |

> **不变量声明（v8）**：本轮仅修正 auth 返回对象形状；架构 / RPC 签名 / Migration 依赖与顺序 / P1 v8 公式 / 验收总数（61 条）**均不变**。v7 的两项收口（Repository 服务端 userId 传递、P7 详情复用 P1 `get_replenishment_suggestions`）结论保持。

---

## 1. 背景与要解决的问题

DIS 当前已具备五个相对独立的功能模块：国内外库存、SKU 绑定管理、在途货物、库存同步、团队账号与可见仓库分配。这些模块**以「仓库」或「功能」为颗粒度**，彼此是孤岛。

当运营想回答「瑜伽垫在国内外总共什么情况、哪个国家的仓先断」时，必须在多个页面间来回跳转、人工拼凑。现有视图缺少一个**"产品级全局态势"的原语**——不是表不够大，而是组织轴不对。

**本方案定义单一产品「全球库存总览」**，由两层构成，不再建设两个产品级库存总览页面：

- **P7-A 全球库存基础总览（先上）**：产品/Variant 一行、海外库存汇总、海外在途汇总、基础库存告警、国内库存待接入占位、Admin/Operator `warehouse_id` 权限隔离。不依赖预测算法。
- **P7-B 全球库存作战室增强层（后叠，依赖 P1）**：复用 P1 的 `forecast_stockout(...)` 数据库函数，提供最早断货日 `earliest_stockout`、断货风险 `stockout_urgency`、分国 burn-down、点行详情弹窗；P1 落盘后再叠加 `net_demand` / `suggest_qty` / `latest_order_date` 补货建议（行动层 `replenishment_urgency` 语义，与 `stockout_urgency` 命名分离）。

两层共用同一路由 `/dashboard/products/overview`、同一列表 RPC `get_product_overview`、同一详情 RPC `get_war_room_variant_detail`。P7-B 是在 P7-A 之上的预测与决策增强，**不是独立页面**。

### 关键业务约束（来自 Rall 确认）
- **面向东南亚跨境卖家**：小国家通常只长期合作 **1 个海外仓**，因此「海外仓之间调拨」是伪需求（不同老板/员工/不同 ERP，数据都对不上）。
- ❌ 故早期设想的「海外仓 A 积压 → 建议调拨至海外仓 B」洞察**已剔除**，不成立。
- ✅ 替换洞察为**国家/仓维度补货优先级**：哪个国仓先断 → 优先从**国内**补给。国内补给判断**仅当国内库存已接入后**才有数据支撑；V1 国内未接入，判断块返回「待接入」。

---

## 2. 产品决策记录（已与 Rall 拍板，v2 修订）

| # | 决策项 | 结论 |
|---|--------|------|
| 1 | 落位方式（唯一路由） | **单一产品级路由 `/dashboard/products/overview`**（页面 `src/app/dashboard/products/overview/page.tsx`、模块 `src/features/product-overview/`），位于**产品分组**侧边栏入口，由 Dashboard Layout 包裹；页面标题显示「全球库存作战室」。**禁用根路由 `/war-room`**；旧规划路由 `/dashboard/war-room` **退役**（不存在第二产品级库存总览页；若曾误建须 301 重定向至本路由） |
| 2 | 组织轴 | **产品（variant）为中心**：每个 `product_variant.id` 一行，国内 + 各海外仓 + 在途同框 |
| 3 | 权限 | **warehouse_id 级（分角色，禁止直接对所有用户调 `get_assigned_warehouse_ids()`）**：`auth.uid()` → 校验 `profiles.is_active` 与角色 → 按角色生成可见仓库集合（**Admin**：全部 active overseas warehouse；**Operator**：`get_assigned_warehouse_ids()` 与 active overseas 取交集）→ 过滤 `inventory`/`shipment`/`shipment_item` → 再按 country/warehouse 聚合展示；country **仅展示聚合**、非授权边界；禁止前端传可见国家绕过 RLS（详见 §4.3） |
| 4 | 国内角色 | **补给源语义**，但 V1 **国内库存未接入** → 国内列显示「待接入」，q/daily_sales/inbound 为 NULL，不参与 `visible_total_quantity`/`earliest_stockout`/`stockout_urgency`；生产周期标「待定」 |
| 5 | 前向推演（P7-B 职责） | **调用统一数据库函数 `forecast_stockout(...)`**（与补货引擎 P1 同一实现）：逐仓库算 `est_stockout_date`，行 `earliest_stockout` = 可见仓库中最小断货日；分国 burn-down 每国独立线。该能力属 **P7-B 增强层**，依赖 P1 落盘 |
| 6 | 详情交互 | 点行 → **居中弹窗**（非 Tab），内含：国内补给判断 / KPI 四宫格 / 分国推演 / 产品库存小表 |
| 7 | 决策队列 | 顶部紧急/预警/正常三档 chip，**可点击筛选**（再点取消），计数保持全量 |
| 8 | 与补货引擎关系（P7-B） | P7-B 前向推演与补货引擎**共用同一数据库函数 `forecast_stockout(...)`**（定义在 P1 补货引擎方案 §4.3，**由 P1 Migration C（当前预定 00043）创建**）；补货引擎的 `net_demand`/最晚下单日作为行动层（`replenishment_urgency` 语义），P1 落盘后**后叠**到 P7-B，不阻塞 P7-A |
| 9 | 分层边界（P7-A / P7-B） | **P7-A 基础总览**：产品/Variant 一行 + 海外库存汇总 + 海外在途汇总 + 基础库存告警 + 国内占位 + Admin/Operator `warehouse_id` 权限隔离；**不含** `earliest_stockout`/`stockout_urgency`/分国 burn-down/预测弹窗。**P7-B 增强层**：复用 `forecast_stockout(...)` 算 `earliest_stockout`/`stockout_urgency`/分国 burn-down + 详情弹窗 + 后续 `net_demand`/`suggest_qty`/`latest_order_date`（行动层 `replenishment_urgency`，与 `stockout_urgency` 命名分离）；依赖 P1。两层共用同一路由/列表 RPC/详情 RPC，P7-A 先上、P7-B 后叠 |

---

## 3. 信息架构

```
┌─ 侧边栏（产品分组下新增入口「全球库存总览」，Dashboard Layout 包裹；Admin + Operator 均可见）
│
└─ /dashboard/products/overview  全球库存总览（页面标题显示「全球库存作战室」；Dashboard 下唯一产品级总览路由，非根路由）
   ├─ 顶部：运营视角（自动按 warehouse_id 权限，无手动国家下拉）
   ├─ 决策队列：紧急 / 预警 / 正常 三档 chip（P7-B 增强层，可点击筛选）
   ├─ 主表：产品为中心一张表（Server Component → Repository → RPC 取数）
   │     列(P7-A 基础) = variant/SKU ｜ 国内(待接入) ｜ 各可见仓库/国家 ｜ 在途 ｜ visible_total_quantity ｜ 基础告警
   │     列(P7-B 增强) = + 最早断货(可见) ｜ 紧急度 ｜ 分国 burn-down 入口
   │     行 = 每个 product_variant.id，P7-B 按最早断货日升序（全局排序后分页）
   └─ 点行 → 弹窗（产品详情视图，非独立路由；P7-B 含分国推演/预测）
          ├─ 国内补给判断块（data_unavailable）
          ├─ KPI 四宫格
          ├─ 前向推演：分国 burn-down（按钮切换，P7-B）
          └─ 产品库存明细小表（按 warehouse_id 权限显示）
```

**三层关系**
- **页面层**：决策队列 + 产品主表（本页核心，P7-A 先上、P7-B 增强列与弹窗后叠）。
- **详情层**：点行弹窗 = 该产品详情视图（不另开路由）。
- **数据层（P7 V1 数据源，固定清单）**：`inventory`（库存/日销驱动表）/ `product_variant`·`product`（LEFT JOIN）/ `warehouse` / `shipment`+`shipment_item`（在途 ETA 与数量，V1 唯一在途来源）/ P1 `forecast_stockout(...)` 及补货建议契约（P7-B 行动层，后接）。**`tracking_event_external` 不属于 P7 V1 数据源**；P0 外部轨迹只在现有 Shipment 详情页展示，P7 如需查看轨迹仅用 `shipment_id` 跳转 Shipment 详情（见 §4.1 🔒 收口）。

---

## 4. 数据模型与契约

### 4.1 上游数据源（V1 实际可用）
| 数据 | 来源 | 用途 |
|------|------|------|
| `daily_sales`（近 30 天均值） | `inventory.daily_sales`（BigSeller 同步） | 推演消耗速度；NULL/<=0 → `data_incomplete` |
| `quantity`（在手） | `inventory.quantity`（按 warehouse_id 权限过滤） | 可售天数分母 |
| `eta` + `inb_qty`（在途到港日/数量） | **`shipment`+`shipment_item`**（`estimated_arrival`、`quantity-warehoused_quantity`，按 warehouse_id 权限过滤，过滤 `cancelled_at`/`bigseller_absorbed_at`/无效状态） | 有效在途补给 |
| 权限 | `user_warehouses` + `get_assigned_warehouse_ids()`（Operator）/ `warehouse.type='overseas' AND is_active=true`（Admin） | warehouse_id 级过滤 |
| `net_demand` / `last_order_day`（行动层，待接） | 预测式补货引擎 RPC（调用同一数据库函数 `forecast_stockout(...)`） | 补货建议（后叠） |

> **P7 V1 数据源固定清单**：`inventory` / `product_variant`·`product` / `warehouse` / `shipment` + `shipment_item` / P1 `forecast_stockout(...)` 及补货建议契约。**`tracking_event_external` 不属于 P7 V1 数据源**（既不作展示数据源，也不作计算数据源）。

> ⚠️ **喜运达不提供 ETA 与数量映射**：喜运达方案 P0 v8 明确「无 ETA 字段、绝不回写 `estimated_arrival`/`shipment_item`、只 upsert `tracking_event_external`」。故作战室 V1 在途推演**只用 `shipment`+`shipment_item` 的人工 `estimated_arrival`**。未来若要把喜运达接入计算，须另建后续方案，明确链路：**运单 → `shipment_external_ref` → `shipment` → `shipment_item` → `variant` → ETA 预测**。

> 🔒 **P0 外部轨迹在 P7 的 V1 收口（v5 确立，v6 全文对齐）**：P7 V1 **既不读取也不展示 `tracking_event_external`**；在途计算只用 `shipment`+`shipment_item`。P0 外部轨迹**只在现有 Shipment 详情页展示**；P7 如需查看轨迹，仅使用 `shipment_id` 跳转现有 Shipment 详情，**不在本期复制轨迹列表**。P0 **不是** P7-A/P7-B 的计算或页面前置依赖；「P7 直接展示外部轨迹」移为**后续增强**，不作 V1 已交付能力。

### 4.2 视图聚合字段（每个当前用户可见、且至少存在一条 inventory 行的 `product_variant.id` 聚合为一行）

> **行入选条件（inventory 驱动，见 §4.5）**：只有「当前用户可见 active overseas warehouse 中至少存在一条 `inventory` 行」的 `product_variant.id` 才聚合为一行；**并非所有 `product_variant` 都无条件进入列表**（无 inventory 行者不进列表）。
> **字段分层（P7-A / P7-B）**：本 RPC（`get_product_overview`）在 `items[]` 中一次性返回全部字段，由前端按层展示。
> - **P7-A 基础总览展示**：`variant_id`/`product_id`/`sku`/`variant_country`/`product_name`/`variant_name`、各 `per_warehouse` 的 `q`/`daily_sales`/`inb`/`base_stock_status`、海外库存汇总、`visible_on_hand`、`visible_inbound_quantity`、`eta_missing_quantity`、`visible_total_quantity`、基础库存告警（`base_stock_status`，非「≤8」魔法数字）、国内占位。**不含** `earliest_stockout`/`stockout_urgency`/分国 burn-down/预测弹窗（这些列在稳定契约中存在，P7-A 页面忽略不展示）。
> - **P7-B 增强层额外展示**：`earliest_stockout`（复用 `forecast_stockout(...)`）、`stockout_urgency`、`partial_data`、分国 burn-down、预测详情弹窗。依赖 P1 落盘。

> **返回结构（v6 固定 JSONB 信封）**：`get_product_overview` 一次 `RETURNS jsonb`，形如 `{ items: [ <每行字段> ], total_count, queue_counts: {critical,warning,ok,data_incomplete} }`。`total_count` 与 `queue_counts` 是**信封级元数据、不随行重复**；即便 `items` 为空数组，`total_count` 与完整 `queue_counts` 仍返回（保证空页也能显示完整计数与页码越界判断）。完整信封与流水线见 §7.3；`ProductOverviewResult` 与此信封一致。

**① `items[]` 每行字段（每个入选 variant 一个对象）：**
```
variant_id          uuid PK
product_id          uuid | null        // 未匹配产品的 variant 为 null，LEFT JOIN product 后仍独立成行
sku                 text
variant_country     text               // 该 variant 所属国（展示用）
product_name        text | null
variant_name        text

per_warehouse[w]: {                      // w ∈ 当前用户可见 active overseas warehouse 中「存在本 variant inventory 行」的仓库（inventory 驱动，见 §4.5）
  q, daily_sales,
  inb: [{eta, qty}]                     // 仅 status∈(booking..customs)、cancelled_at IS NULL、bigseller_absorbed_at IS NULL、remaining>0；eta 可为 NULL（ETA 未录入）
  base_stock_status: out_of_stock | unmatched | low | normal   // 单仓基础状态，按 §4.5 固定 CASE 顺序，复用 product.safety_stock（禁用「≤8」魔法数字）
}
visible_on_hand          = Σ q            (仅驱动集合内仓库)
visible_inbound_quantity = Σ inb_qty      (仅驱动集合内仓库，**全部有效在途 remaining，含 eta IS NULL**；用于「可见总量」展示)
effective_inbound        = Σ inb_qty WHERE eta <= est_stockout_date   (仅用于断货预测 / net_demand / 补货建议；见 §5 同 ETA 聚合 + COALESCE；晚到与 eta NULL 不计入；空集合恒 0 非 NULL)
eta_missing_quantity     = Σ inb_qty WHERE eta IS NULL   (数据质量标记，随行返回，提示「有在途但缺 ETA」；不计入 effective_inbound，不得静默丢弃让用户误以为没有在途)
visible_total_quantity   = visible_on_hand + visible_inbound_quantity   // 仅「当前用户可见范围」内总量（含全部有效在途，含 eta NULL）
base_stock_status        = 行级按可见仓库最严重聚合：out_of_stock > low > normal > unmatched（按 §4.5 固定 CASE 顺序判定单仓状态后聚合，复用 product.safety_stock，非「≤8」魔法数字）
earliest_stockout        = date | null   // 【P7-B】min(各有效驱动仓库 forecast_stockout 断货日)，仓库级独立、非国家间调拨（多仓混合规则见 §5.3；全部 ds 无效时为 NULL）
stockout_urgency         = 【P7-B】枚举**只有四值**：断货日<CURRENT_DATE+3:critical / <=CURRENT_DATE+7:warning / 其他有效日期:ok / 全部仓库无有效 daily_sales:data_incomplete（与 P1 replenishment_urgency 命名分离，禁止共用 urgency 字段；**partial_data 绝不作为第五个枚举值**）
partial_data             = boolean       // **独立 boolean，不是 stockout_urgency 枚举值**：部分仓库 daily_sales 有效、部分无效 → earliest_stockout 取有效仓库最小值、stockout_urgency 按该日期正常算档、partial_data=true；全部仓库 daily_sales 无效 → earliest_stockout=NULL、stockout_urgency='data_incomplete'、partial_data=false（见 §5.3）
domestic_status          = 'data_unavailable'   // V1 国内未接入（P7-A/P7-B 均统一）；domestic 明细（q/daily_sales/inb 均为 NULL）仅供详情展示，不参与任何计算
```

**② 信封级元数据（不随行重复）：**
```
total_count              = bigint // filtered_cohort（应用 p_stockout_urgency 后）总行数，用于分页；items 为空时仍返回（见 §7.3 流水线）
queue_counts             = jsonb  // 决策队列计数，**只统计四种 stockout_urgency**：{critical, warning, ok, data_incomplete}（不含 partial_data 档位）；从 base_cohort（未应用 p_stockout_urgency）统计，受 search/country 影响、不受 p_stockout_urgency 与分页影响；items 为空时仍返回完整对象（见 §7.3）
```

### 4.3 权限过滤语义（warehouse_id 级，重要）

> ⚠️ **真实函数取证**：`supabase/migrations/00015_user_warehouses.sql:49-59` 的 `get_assigned_warehouse_ids()` 仅执行 `SELECT warehouse_id FROM public.user_warehouses WHERE user_id = auth.uid()`，**不会**自动给 admin 返回全部 active overseas warehouse。故 RPC 不能对所有用户直接按该函数过滤，否则 admin 可能得到空集。

- **RPC 前置校验（任何查询前）**：
  1. `auth.uid()` 非空（未登录直接拒绝）；
  2. 入参 `p_user_id` 必须等于 `auth.uid()`（不相等拒绝，不信任前端传入的其它用户）；
  3. `profiles` 中调用者存在且 `is_active = true`（停用用户直接拒绝）；
  4. 调用者角色只能是 `admin` 或 `operator`（无角色/其他角色拒绝）。
- **可见仓库集合生成（按角色分支，在 RPC 内完成）**：
  - **Admin**：`warehouse.type = 'overseas' AND warehouse.is_active = true`（**不依赖 `user_warehouses` 分配记录**）；
  - **Operator**：`get_assigned_warehouse_ids()` 的结果 **与** `warehouse.type='overseas' AND is_active=true` 取**交集**（只看到被分配且确实 active overseas 的仓）。
- **过滤顺序**：先生成可见 `warehouse_id` 集合 → 再据此过滤 `inventory`/`shipment`/`shipment_item` → 最后按 `warehouse`/`country` 聚合展示（country 列是过滤后的派生展示，**仅展示/筛选维度，非授权边界**）。
- **禁止**：先按 country 聚合再过滤；把「可见国家」当成授权边界；Operator 因被分配某国一个仓而看到该国其他未授权仓；前端自行传入可见国家列表绕过 RLS。
- 同一国家多个仓库**不能跨授权汇总**：Operator 只被分配该国仓 A 未分配仓 B，则仅 A 的数据进入聚合，B 完全不可见。
- `earliest_stockout` / `stockout_urgency` 只基于**可见（已权限过滤）仓库**计算。
- 保留 `SECURITY INVOKER` 与现有 RLS；RPC 内过滤**叠加**于 RLS 之上，不能只依赖 RPC 内过滤（double safety）。

### 4.4 `visible_total_quantity` 语义澄清
- 该字段 = **当前用户可见范围内** `on_hand + visible_inbound_quantity` 的总量（含全部有效在途，含 eta NULL 的在途）。**属 P7-A 基础总览即可展示。**
- **`effective_inbound` 不进入 `visible_total_quantity`**：`effective_inbound` 仅用于断货预测 / `net_demand` / 补货建议（口径 = `eta <= est_stockout_date`），晚到与 eta NULL 的在途不计入；它反映「能赶在断货前到达的补给」，不是「可见在途总量」。
- **不代表国家之间可调拨或可替代**：不同国家仓是独立库存、独立断货、独立补货；该聚合值仅用于「一眼看总量」，不暗示可互相支援。
- 最早断货 `earliest_stockout` 与断货风险 `stockout_urgency` **属 P7-B 增强层**，始终按国家/仓库独立计算（取 min），不因该总量而被平滑。P7-A 不展示这两项（仅展示基础库存告警）。

### 4.5 列表驱动集合（inventory 为驱动表，V1 固定）

> 与 P1 v8 一致：**`inventory` 是列表的驱动表**，禁止 variant×warehouse 笛卡尔积与无库存归属的虚假总览数据。

1. **inventory 为列表驱动表**：只展示「当前用户可见 active overseas warehouse 中存在 `inventory` 行的 variant」组成的列表。
2. **每个可见 `variant_id` 聚合为一行**（行键恒为 `product_variant.id`）。
3. **`inventory.quantity = 0` 的现有行必须保留**，显示为 `out_of_stock`，不得丢弃。
4. **完全没有 `inventory` 行的 variant 不生成合成仓库数据、不进入列表**（不因在途/其它信号虚构归属）。
5. `shipment_item` 只对已进入驱动集合的 `(variant_id, warehouse_id)` 组合聚合；不为驱动集合外的在途数据生成列表行。
6. **不为「只有在途、没有 `inventory`」的 variant 虚构 `on_hand = 0` 仓库归属**。
7. 「只有在途、没有 `inventory` 行」的展示能力，记录为**后续数据模型增强**（如引入「在途驱动」集合），**不在 V1 绕过**（V1 不为此类 variant 生成列表行）。
8. `product_variant.product_id` 可为 NULL；`product` 使用 **LEFT JOIN**，未匹配 variant 仍保留成行、不误删。
9. **禁止按 SKU/name 合并**，行键始终为 `product_variant.id`。
10. 多仓混合与 `stockout_urgency` 计算见 §5.3；驱动集合外的仓库不进入任何聚合。

#### 4.5.1 `base_stock_status` 判断顺序（固定 CASE，全文统一）

> 为兼容现有 `get_overseas_inventory` 状态规则、消除「未匹配且 quantity=0」归属歧义，**单仓 `base_stock_status` 按以下固定 CASE 顺序判定**（`quantity` 优先，其次匹配态，最后安全库存）：

```sql
CASE
  WHEN quantity = 0
    THEN 'out_of_stock'
  WHEN product_id IS NULL OR match_status <> 'matched'
    THEN 'unmatched'
  WHEN quantity <= product.safety_stock
    THEN 'low'
  ELSE 'normal'
END
```

- 任何现有 `inventory` 行 `quantity = 0` 都属于 `out_of_stock`（含未匹配且 `quantity=0`）。
- 未匹配但 `quantity > 0` 属于 `unmatched`；**unmatched 不参与 low/normal 安全库存判断**。
- **不使用 `COALESCE(safety_stock, 0)`** 把未匹配 variant 误判为 `normal`。
- 行级严重度聚合顺序：`out_of_stock > low > normal > unmatched`。
- 本 CASE 顺序在 §4.2 `items[]`、§7.3/§7.4 RPC、#46 及取证附录（§11.4）保持完全一致。

---

## 5. 核心算法（统一数据库函数 `forecast_stockout(...)`）

> **禁止 P7-B 单独维护另一套 `stockout_day` 算法，也不允许 TypeScript 与 SQL 各维护一套，或写「共享域函数 / 等价 SQL」等未决表述。** P7-B（作战室增强层）与补货引擎（P1）**调用同一个数据库内部函数 `forecast_stockout(...)`**（定义在 P1 补货引擎方案 §4.3，由 **P1 Migration C（当前预定 00043）`CREATE FUNCTION` 创建**；P1 `get_replenishment_suggestions` 与 P7-B `get_product_overview` 均调用之）。

### 5.1 统一数据库函数 `forecast_stockout(...)`（单仓库粒度）

**函数契约**（P1 / P7-B 共用同一实现）：

```sql
CREATE FUNCTION forecast_stockout(
  p_on_hand         integer,
  p_daily_sales     numeric,
  p_lead_time_days  integer,
  p_inbound         jsonb          -- [{eta: date|null, remaining: integer}, ...]，已由调用方按 warehouse_id 权限过滤
)
RETURNS TABLE (
  est_stockout_date date,     -- daily_sales 有效时算；否则 NULL
  effective_inbound  integer, -- = COALESCE(Σ remaining WHERE eta <= est_stockout_date, 0)，空集合恒 0 非 NULL
  ds_incomplete      boolean, -- daily_sales NULL/<=0 时为 true
  lead_incomplete    boolean  -- lead_time_days NULL/<=0 时为 true
)
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = '' AS $$ ... $$;
```

**调用方职责（在 RPC 内完成）**：按 `warehouse_id` 权限收集 inbound —— `status IN (booking,loading,departed,arrived,customs)`、`cancelled_at IS NULL`、`bigseller_absorbed_at IS NULL`、`remaining = quantity - warehoused_quantity > 0`；组装 `p_inbound`（含 `eta` 可能为 NULL 的项），再调用本函数。**本函数只做事件模拟，不接触表、不做权限过滤。**

**函数体（与 P1 补货引擎 v6 §4.3 完全一致）**：

```
-- 边界（#五.1 / #二.3）：daily_sales 无效 → 不进事件模拟，不生成虚假断货日
IF p_daily_sales IS NULL OR p_daily_sales <= 0 THEN
    RETURN (NULL, 0, true, (p_lead_time_days IS NULL OR p_lead_time_days <= 0));
END IF
ds := p_daily_sales
lead := p_lead_time_days

-- 有效事件：ETA NOT NULL 且 remaining>0，同 ETA 先 GROUP BY + SUM（#二.3）
events := SELECT eta, SUM(remaining) AS total_remaining
          FROM jsonb_array_elements(p_inbound) AS t(eta date, remaining integer)
          WHERE t.eta IS NOT NULL AND t.remaining > 0
          GROUP BY t.eta ORDER BY t.eta ASC

-- 事件模拟（游标 cursor_date 只扣一次日期差；ETA 当天 cur==consume；过期按 today）
cur := p_on_hand
today := CURRENT_DATE
cursor_date := today
stockout := NULL
FOR EACH (eta, total_remaining) IN events:
    event_date := greatest(eta, today)
    days := event_date - cursor_date
    IF days > 0:
        consume := ds * days
        IF cur < consume:
            stockout := cursor_date + ceil(cur / ds)   -- 到达前断货（晚到不补入）
            BREAK
        cur := cur - consume
    cur := cur + total_remaining
    cursor_date := event_date
IF stockout IS NULL:
    stockout := cursor_date + ceil(cur / ds)

-- effective_inbound：仅计「断货日前到达」（#二.3），晚到不抵扣；空集合 COALESCE 0
effective_inbound := COALESCE(SUM(total_remaining) FILTER (WHERE eta <= stockout), 0)::integer
lead_incomplete := (lead IS NULL OR lead <= 0)
RETURN (stockout, effective_inbound, false, lead_incomplete)
```

> **说明**：`lead_time_days` 仅在调用方需要 `latest_order_date`/`target_stock` 时使用（P1 行动层）；P7-B 只取 `est_stockout_date` + `effective_inbound` 用于断货投影。`lead` 缺失时 `lead_incomplete=true`，调用方据此不生成 `latest_order_date`、不写死天数（#五.2 / #二.3）。

### 5.2 统一边界规则（P1 与 P7-B 必须相同）
- `remaining = quantity - warehoused_quantity`；
- `status` 仅计 `booking/loading/departed/arrived/customs`；
- `cancelled_at IS NULL`；
- `bigseller_absorbed_at IS NULL`；
- `estimated_arrival IS NOT NULL`（进入事件模拟的事件）；ETA=NULL 的在途由调用方记为 `eta_missing_quantity`，不进模拟；
- 同一 ETA 先 `GROUP BY` 并 `SUM(remaining)`，游标 `cursor_date` 只扣减一次日期差；
- ETA 当天按 `cur == consume` 规则（先扣消耗再补入）；
- 过期 ETA 按 `today` 处理；
- ETA 晚于断货日不抵扣（`effective_inbound` 仅计 `eta <= est_stockout_date`）；
- `daily_sales` NULL 或 `<=0` → `est_stockout_date=NULL`、`effective_inbound=0`、`ds_incomplete=true`、`stockout_urgency=data_incomplete`（不生成虚假断货日）；
- `lead_time_days` NULL 或 `<=0` → `lead_incomplete=true`，调用方不生成 `latest_order_date`/`target_stock`（断货日仍可算）；
- `effective_inbound` 使用 `COALESCE(SUM(...), 0)::integer`（空集合恒 0 非 NULL）；
- **不允许写死 12 天**等常数——lead 一律取 `warehouse.lead_time_days`（真实列，NULL/<=0 走 data_incomplete）。

### 5.3 行级聚合（产品为中心，多仓混合规则 #五.4）
- 对当前 variant 的每个 **assigned 仓库**调用 `forecast_stockout(...)`（在 RPC 内完成）；
- **多仓混合**：只有 `ds_incomplete = false`（daily_sales 有效）的仓库参与 `earliest_stockout` 之 min；`ds_incomplete = true` 的仓库**不得按 0 参与** min；
  - 若**部分**仓库有效、部分无效 → 行级输出 `partial_data = true`（数据质量标记），`earliest_stockout` 取有效仓库之 min；
  - 若**全部** assigned 仓库 `ds_incomplete = true` → 行级 `earliest_stockout = NULL`、`stockout_urgency = data_incomplete`、`partial_data = false`；
- `stockout_urgency` 由 `earliest_stockout` 推导，**枚举只有四值** `critical`/`warning`/`ok`/`data_incomplete`（<3 天 critical / <=7 天 warning / 其他有效日期 ok / 全部仓库 ds 无效 data_incomplete）；`partial_data` 是**独立 boolean**、额外提示「部分仓缺日销」，**绝不作为 `stockout_urgency` 的第五个枚举值**；`queue_counts` 只统计这四档，不含 partial_data；
- `visible_total_quantity` = 各 assigned 仓库 `on_hand + visible_inbound_quantity` 之和（见 §4.4 语义；**不含 `effective_inbound`**）；
- 分国 burn-down：按 `warehouse.country` 分组后各自画消耗线（国家列是过滤后派生，不跨授权汇总）。
- **稳定排序（#五.5）**：主表分页 `ORDER BY` 先 `stockout_urgency` 优先级（critical>warning>ok>data_incomplete），再 `earliest_stockout NULLS LAST`，最后 `variant_id` 决胜（翻页不重复、不遗漏，见 §7.3 步骤 6）。

### 5.4 国内补给判断（V1 返回 data_unavailable）
```
if domestic 库存未接入:
    return data_unavailable           // 弹窗显示「国内库存待接入」，不计算、不给出支援结论
// 未来国内接入后（不在 V1）：再用 国内 q/daily_sales 计算 d_cover 并给建议
```
> V1 不展示「国内无法支援」「优先从国内补货至{国}」等基于假 0 / 未接入数据的结论。生产周期**待定**。

---

## 6. 交互规格

| 交互 | 行为 |
|------|------|
| 运营视角 | 真实环境自动按 warehouse_id 权限加载；无手动国家切换 |
| 决策队列 chip | 点「紧急」→ 主表仅留紧急 variant；再点取消；计数数字始终全量 |
| 主表行 | 按断货风险升序（**全局排序后分页**，非每页内排序）；基础库存状态按 `base_stock_status` 展示（out_of_stock / low 标红，复用 product.safety_stock 判定，非「≤8」魔法数字）/ 零标红 |
| 点行 | 弹出产品详情弹窗 |
| 弹窗关闭 | 点遮罩 / Esc / ✕ |
| 弹窗内分国按钮 | 点国家 → 下方画该单国 burn-down；默认选中最早断货国 |
| 排序 | 默认按可见范围最早断货日升序 |
| **状态** | 页面/弹窗必须支持：**空数据**（无 variant/无权限可见）、**错误**（RPC 失败）、**加载中**（骨架屏）、**无权限**（assigned 仓库为空 → 提示联系管理员）四种状态，禁止客户端拉全量后自行过滤权限 |

---

## 7. 数据层与组件拆分（v2 补全契约）

### 7.1 模块结构（遵循现有 feature 范式）
```
src/app/dashboard/products/overview/
  page.tsx                      // Server Component：列表首屏直接调用 Repository（→ get_product_overview RPC），不经 Server Action
src/features/product-overview/
  types.ts                      // ProductOverviewResult（{items[], total_count, queue_counts}）/ ProductOverviewRow / ProductOverviewParams / ProductVariantDetail / DomesticStatus
  schema.ts                     // Zod：分页/筛选参数校验（列表）+ variantId 校验（详情）
  repository.ts                 // getProductOverview(userId, params) / getProductVariantDetail(userId, variantId)  // userId 取自 requireActiveAuth，禁止客户端构造
  actions.ts                    // 'use server'：客户端触发的详情懒加载 Server Action —— requireActiveAuth + Zod → Repository → 详情 RPC；不用于列表首屏读取，不执行 revalidatePath
  components/
    DecisionQueue.tsx           // 顶部三档 chip（可筛选，P7-B）
    ProductOverviewTable.tsx    // 产品为中心主表（Server 数据驱动）
    ProductOverviewRow.tsx
    ProductModal.tsx            // 点行弹窗
    DomesticJudge.tsx           // 国内补给判断块（data_unavailable）
    KpiGrid.tsx                 // 四宫格
    CountryBurnDown.tsx         // 分国 burn-down（SVG，P7-B）
    WarehouseMiniTable.tsx      // 产品库存明细小表（按 warehouse_id 权限）
  -- 核心预测算法为数据库函数 forecast_stockout(...)，定义在 P1 补货引擎方案 §4.3 / **P1 Migration C（当前预定 00043）**（不在此放 TS 域函数，避免 TS/SQL 两套实现）
```

> **Repository 接口契约（v7 补强，types/interface 唯一来源）**：
> ```typescript
> interface ProductOverviewRepository {
>   getProductOverview(
>     userId: string,
>     params: ProductOverviewParams
>   ): Promise<ProductOverviewResult>;
>
>   getProductVariantDetail(
>     userId: string,
>     variantId: string
>   ): Promise<ProductVariantDetail>;
> }
> ```
> - `userId` **必须由调用方（page.tsx / Server Action）在服务端取得**：`const user = await requireActiveAuth();`，再传 `user.id`（`requireActiveAuth()` 直接返回 `CurrentActiveUser`，字段为 `id`/`email`/`displayName`/`roleName`/`isActive`，**无 `user` 包裹层**，见 `src/lib/auth.ts:131-134`）；**Repository 不得用任何客户端传入数据构造 `p_user_id`**。
> - `ProductVariantDetail` 的行动字段（`safetyStock` / `targetStock` / `netDemand` / `suggestQty` / `latestOrderDate` / `replenishmentUrgency`）**只存在于 `assignedWarehouseDetail[]` 每项的仓库归属下**；顶层 `ProductVariantDetail` **禁止**出现 `netDemand` / `suggestQty` / `latestOrderDate` / `replenishmentUrgency`（见 §7.4 / §11.5 四）。
> 视觉风格沿用 `inventory-ui-upgrade-plan.md`：纯灰阶 oklch 中性色、极简 B2B。

### 7.2 取数契约（关键纪律：两条调用链）

**① 列表首屏（常规读取，不经 Server Action）**
`page.tsx`（Server Component）→ `requireActiveAuth()` → Zod 校验 `searchParams` → `productOverviewRepository.getProductOverview(user.id, params)` → `get_product_overview(p_user_id := user.id, ...)` RPC → RLS。
- `page.tsx` 直接调用 Repository；**`user.id` 来自 `requireActiveAuth()`，作为 `userId` 第一个参数传给 Repository**，Repository 据此向 RPC 传 `p_user_id = user.id`；**Server Action 不参与列表首屏读取**；`userId` 不能从 URL / `searchParams` / Client 传入。

**② 点击行懒加载详情（经受认证 Server Action）**
`ProductModal`/客户端组件 → `getProductVariantDetailAction(input)` → `requireActiveAuth()` → Zod 校验 `variantId` → `productOverviewRepository.getProductVariantDetail(user.id, variantId)` → `get_war_room_variant_detail(p_user_id := user.id, p_variant_id := variantId)` RPC → RLS。
- `actions.ts` 存在，但**仅承载客户端触发的懒加载详情读取**；不得让 Client Component 直接调用 Supabase。
- Server Action **不接收或信任前端传入的 userId、角色、可见仓库列表或国家权限**；`userId` 必须取自 `requireActiveAuth()`，`variantId` 只是查询条件、不是授权凭证；**Action 输入只包含 `variantId`**，Client 不得传 `userId`/角色/仓库列表/国家权限。
- Repository 向 RPC 传 `p_user_id = user.id`（服务端取得），**不得用任何客户端数据构造 `p_user_id`**；RPC 仍须按 `warehouse_id` 权限过滤、继续强制 `p_user_id = auth.uid()`。
- Server Action 只返回友好中文错误，**不暴露数据库原文**。
- 详情读取**不需要 `revalidatePath`**。

**通用纪律**
- **Client Component 不直接调用 Supabase**；可见数据一律经 Repository/RPC 获取。
- 所有外部参数经 **Zod 校验**（`schema.ts`）。
- **Admin / Operator 使用同一接口**：可见仓库集合由 RPC 按 §4.3 角色分支（admin=全部 active overseas；operator=分配交集）在 DB 内生成，**不在应用层按角色分支数据范围**。
- **禁止客户端拉取所有数据后再自行过滤权限**；权限过滤一律在 DB / Repository 层完成（列表与详情接口均先按 `warehouse_id` 过滤，不由前端传可见国家列表后再过滤）。
- 必须支持空数据、错误、加载、无权限四种状态。

### 7.3 列表 RPC（唯一产品级总览 RPC：`get_product_overview`，采用方案 B）

> **v4 合并要求**：P7-A 与 P7-B **共用同一个列表 RPC `get_product_overview`**，不再为作战室单独设计 `get_war_room_overview`、也不再为 P7 另设第二套产品总览 RPC。该 RPC 一次性返回 §4.2 稳定完整契约（`items[]` 含 P7-B 的 `earliest_stockout`/`stockout_urgency`/`partial_data` 等），前端按层（P7-A 先上只展示基础字段、P7-B 增强列后叠）展示。

> **v6 返回结构：`RETURNS jsonb` 信封（不随行返回元数据）**。`total_count` 与 `queue_counts` 是**信封级字段、只出现一次**，绝不写进每一行；当前页为空（页码越界/筛选无结果）时，`items` 为空数组但 `total_count` 与完整 `queue_counts` 仍返回，页面据此判断「完整结果数量 / 决策队列数量 / 是否只是页码超出范围」。`ProductOverviewResult` 与本信封完全一致。

**信封示例（items 为空也保持结构）：**
```json
{
  "items": [
    {
      "variant_id": "...",
      "product_id": null,
      "sku": "...",
      "variant_country": "...",
      "product_name": null,
      "variant_name": "...",
      "per_warehouse": [],
      "visible_on_hand": 0,
      "visible_inbound_quantity": 0,
      "eta_missing_quantity": 0,
      "visible_total_quantity": 0,
      "base_stock_status": "normal",
      "earliest_stockout": null,
      "stockout_urgency": "data_incomplete",
      "partial_data": false,
      "domestic_status": "data_unavailable"
    }
  ],
  "total_count": 0,
  "queue_counts": {
    "critical": 0,
    "warning": 0,
    "ok": 0,
    "data_incomplete": 0
  }
}
```

- **列表 Repository 契约（v7 补强 · v8 修正 auth 形状）**：`productOverviewRepository.getProductOverview(userId: string, params: ProductOverviewParams): Promise<ProductOverviewResult>`；`userId` 由 `page.tsx` 服务端取得——`const user = await requireActiveAuth();`，`userId` 取 `user.id`（**不是 `requireActiveAuth()` 的子属性**，`requireActiveAuth()` 直接返回 `CurrentActiveUser`），**不得来自 URL / searchParams / Client**；固定为：
  ```typescript
  const user = await requireActiveAuth();
  productOverviewRepository.getProductOverview(user.id, params);
  ```
  Repository 调用 `get_product_overview(p_user_id := user.id, ...)`，RPC 继续强制 `p_user_id = auth.uid()`；该调用链为 Server Component 直接调用，**不经 Server Action**（对应 §7.2 链 ① / §11.5 一 / §11.6）。
- **方案 A（弃用）**：V1 每个 `product_variant` 一行，复用现有 Variant/库存查询分页。但「产品级分页 + 最早断货全局排序 + 国家列聚合」需多个分页 RPC 在应用层拼接，无法保证全局排序正确、且难做 warehouse_id 内聚聚合。
- **方案 B（采用，推荐，唯一列表 RPC）**：新增**只读 RPC `get_product_overview` `RETURNS jsonb`**，在数据库内按**固定查询流水线**一次完成：
  1. **visible_scope**（前置校验 + 可见仓库集合，§4.3）：`auth.uid()` 非空、`p_user_id = auth.uid()`、`profiles` 存在且 `is_active`、角色仅 admin/operator；据此生成可见 `warehouse_id` 集合——**Admin = `warehouse.type='overseas' AND is_active=true`**；**Operator = `get_assigned_warehouse_ids()` 与 active overseas 取交集**；
  2. **base_cohort**（inventory 驱动聚合 + 基础筛选，**尚不应用 `p_stockout_urgency`**）：按可见 `warehouse_id` 过滤 `inventory`（驱动表，见 §4.5）/`shipment`/`shipment_item` → 按 `product_variant` 聚合 → 逐仓库调用 `forecast_stockout(...)`（与 P1 同一实现）算 `est_stockout_date`/`effective_inbound`/`ds_incomplete`/`lead_incomplete` → 行级补 `earliest_stockout`（多仓混合见 §5.3）/`base_stock_status`（§4.5 CASE）/`stockout_urgency`（四值，§4.2/§5.3）/`partial_data`（独立 boolean）/`visible_total_quantity`/`eta_missing_quantity`/`domestic_status='data_unavailable'` → 再应用 `p_search`、`p_country` 等**基础筛选**；
  3. **queue_counts**（信封字段）：从 **base_cohort** 统计四档 `stockout_urgency`（critical/warning/ok/data_incomplete）数量。**受 `p_search`/`p_country` 影响；不受 `p_stockout_urgency` 影响；不受分页影响**（始终基于完整 base_cohort）；
  4. **filtered_cohort**：在 base_cohort 上应用 `p_stockout_urgency`（未传则等于 base_cohort）；
  5. **total_count**（信封字段）：从 **filtered_cohort** 统计。故选择 `critical` 后 `total_count` 必须等于 critical 结果数量；不受分页影响；
  6. **items**：对 filtered_cohort 执行**固定排序** `stockout_urgency` 优先级（critical > warning > ok > data_incomplete）→ `earliest_stockout NULLS LAST` → `variant_id` 决胜，再 `LIMIT p_page_size OFFSET (p_page-1)*p_page_size`（**排序 + 分页在最后，先 sort 再 LIMIT/OFFSET**，稳定翻页不重复不遗漏）；
  7. 组装信封 `{ items, total_count, queue_counts }` 返回。
- **计数口径（修正过宽表述）**：`p_search`/`p_country` **会改变** `queue_counts` 与 `total_count`；`p_stockout_urgency` **不改变** `queue_counts`、**会改变** `total_count`；**分页不改变** `queue_counts` 或 `total_count`。（不再写「分页与筛选都不改变计数」这类过宽表述。）
- **入参 + 内部校验（除应用层 Zod 外，RPC 内部亦须校验，因 authenticated 用户可直接调用 RPC）**：
  - `p_user_id`（服务端取 `auth.uid()`）：非空且 `= auth.uid()`，否则拒绝；
  - `p_page`：`>= 1`；
  - `p_page_size`：`1..100`（默认 20）；
  - `p_stockout_urgency?`：只能为 `NULL`/`critical`/`warning`/`ok`/`data_incomplete`；
  - `p_country?`：`NULL` 或系统允许的国家码（**仅展示过滤，非授权**；仍先 warehouse_id 过滤再按 country 筛）；
  - `p_search?`：trim 规范化，空字符串按 `NULL` 处理。
- `SECURITY INVOKER` + `SET search_path=''` + `auth.uid()` 绑定；`REVOKE PUBLIC, anon` + `GRANT authenticated`；库内完成权限过滤，前端不传可见国家。

### 7.4 详情接口（方案 B：新增只读 RPC `get_war_room_variant_detail`）

点行弹窗的数据接口采用**方案 B**：新增只读 RPC，签名固定为**双参数**（避免复用 `get_product_overview` 加重载参数把全局排序分页逻辑耦合进详情）：

```sql
get_war_room_variant_detail(
  p_user_id    uuid,
  p_variant_id uuid
) RETURNS jsonb
```

- **真实调用链（点击行懒加载，见 §7.2 链 ②）**：`ProductModal`/客户端组件 → `getProductVariantDetailAction(input)` → `requireActiveAuth()` → Zod 校验 `variantId` → `productOverviewRepository.getProductVariantDetail(user.id, variantId)` → `get_war_room_variant_detail(p_user_id := user.id, p_variant_id := variantId)` RPC → RLS。**禁止「详情由页面在点击时直接调用 Repository」的不可能链路**（点击交互下 Server Component 不会自动重执行）。
- **详情 Repository 契约（v7 补强 · v8 修正 auth 形状）**：`productOverviewRepository.getProductVariantDetail(userId: string, variantId: string): Promise<ProductVariantDetail>`；`userId` 由 Server Action 服务端取得——`const user = await requireActiveAuth();`，`userId` 取 `user.id`（`requireActiveAuth()` 直接返回 `CurrentActiveUser`，无 `user` 包裹层）；固定为：
  ```typescript
  const user = await requireActiveAuth();
  productOverviewRepository.getProductVariantDetail(user.id, variantId);
  ```
  **Repository 不得用任何客户端数据构造 `p_user_id`**；Action 输入仅含 `variantId`，Client 不得传 `userId`/角色/仓库列表/国家权限；RPC 继续强制 `p_user_id = auth.uid()`（对应 §7.2 链 ② / §11.5 一 / §11.6）。
- **签名纪律**：`p_user_id` 来自 Server Action 的 `requireActiveAuth()`；RPC 强制 `p_user_id = auth.uid()`；`p_variant_id` **只是查询条件、不是权限凭证**。F Migration（§7.5）的 `REVOKE`/`GRANT` 必须使用**准确的双参数签名** `get_war_room_variant_detail(uuid, uuid)`；Repository 调用契约与双参数签名一致。
- **权限过滤在 DB / Repository 层先按 `warehouse_id` 完成**（逻辑同 §4.3 角色分支）：RPC 内先校验 `auth.uid()` 非空 / `p_user_id = auth.uid()` / `profiles` 存在且 `is_active` / 角色仅 admin·operator，再生成可见 `warehouse_id` 集合（Admin=全部 active overseas；Operator=`get_assigned_warehouse_ids()` 与 active overseas 交集），据此过滤 `inventory`/`shipment`/`shipment_item`；**禁止前端传 `variantId`/`country`/可见国家列表绕过仓库权限**——即便传入 `p_variant_id`，仍执行仓库隔离，operator 只能看到 assigned 仓库明细。
- **RPC 内部输入校验（除 Zod 外）**：`p_user_id` 非空且 `= auth.uid()`；`p_variant_id` 非空；**该 variant 必须属于 inventory 驱动的可见仓库集合**（当前用户在某可见仓存在该 variant 的 inventory 行）；不可见或不存在**统一返回明确结果 / 友好错误，不泄露未授权 variant 是否存在**。
- **返回字段（明确清单，`RETURNS jsonb`）**：
  - 顶层标识：`variant_id` / `product_id`（nullable）/ `sku` / `variant_country` / `product_name` / `variant_name`
  - 顶层可见汇总（可跨仓求和，仅表示可见范围库存量、不代表可跨国调拨）：`visible_on_hand` / `visible_inbound_quantity` / `effective_inbound` / `eta_missing_quantity` / `earliest_stockout` / `stockout_urgency`（四值，见 §4.2）/ `partial_data`（独立 boolean）/ `domestic_status`
  - **`assigned_warehouse_detail[]`（行动字段按仓库返回，粒度 = variant_id + warehouse_id）**：每个**已通过权限过滤的可见仓库**一项，含
    - **P7 自身查询补充**：`warehouse_id` / `country` / `on_hand` / `daily_sales` / `inbound`（`[{eta, remaining}]`）/ `visible_inbound_quantity` / `eta_missing_quantity` / `est_stockout_date` / `effective_inbound` / `base_stock_status`（§4.5 CASE，复用 product.safety_stock）
    - **P1 行动层（复用 P1 v8 唯一实现 `get_replenishment_suggestions`，禁止 Migration F 重算）**：`safety_stock` / `target_stock` / `net_demand` / `suggest_qty` / `est_stockout_date` / `effective_inbound` / `latest_order_date` / `urgency → replenishment_urgency`（P1 下单紧迫度，**独立命名，不与 `stockout_urgency` 共用字段**）
  - `country_agg[]`：按 `warehouse.country` 聚合（仅展示派生，非授权边界）
  - **顶层禁止**放置无法说明属于哪个仓库的 `net_demand` / `suggest_qty` / `latest_order_date` / `replenishment_urgency`（P1 v8 建议粒度为 variant_id + warehouse_id，同一 variant 可能多仓多结果）。**V1 不跨仓求和 `suggest_qty`、不把不同国家建议合成一个「全球补货量」**，避免暗示库存/补货可跨国替代。
- **P7 行动字段取得方式（v7 强制，禁止 Migration F 重算 P1 行动公式）**：`get_war_room_variant_detail` 在权限过滤后，对**每一个可见仓库**调用 P1 唯一实现 `get_replenishment_suggestions`（见 §7.5 / P1 v8）：
  ```sql
  get_replenishment_suggestions(
    p_user_id        := p_user_id,
    p_variant_id     := p_variant_id,
    p_warehouse_id   := 当前 warehouse_id,
    p_country        := NULL,
    p_urgency        := NULL,
    p_search         := NULL,
    p_include_zero   := true,
    p_page           := 1,
    p_page_size      := 1
  )
  ```
  从返回 `data[0]` 映射至对应 `assigned_warehouse_detail[]` 项（P1 字段 → P7 字段）：`safety_stock` / `target_stock` / `net_demand` / `suggest_qty` / `est_stockout_date` / `effective_inbound` / `latest_order_date` / `urgency → replenishment_urgency`。**P7 自身的 `stockout_urgency` 仍按 `earliest_stockout` 计算，与 P1 `replenishment_urgency` 分离**（P7-B 的 `stockout_urgency` 由 `forecast_stockout` 推导，不来自 P1 RPC）。**强制边界**：① Migration F 不得复制 P1 行动层公式；② Migration F 不得重新写 `round(ds * lead * buffer)` / `round(ds * lead * cover)` / `greatest(0, target_stock - ...)`；③ `p_include_zero` 必须为 `true`，否则 `net_demand=0` 与 `data_incomplete` 仓库可能被 P1 RPC 过滤掉；④ 指定 `p_variant_id`+`p_warehouse_id` 后，P1 RPC 预期返回 0 或 1 行，不允许返回其他仓库数据；⑤ 若当前可见 inventory 组合存在、但 P1 RPC 未返回对应行：**不得在 P7 内回退重算公式**，视为数据契约异常——RPC 返回受控错误、由 Server Action 转友好中文、不暴露 SQL/数据库原文；⑥ 多仓 Variant 逐仓映射，每个仓库用各自的 P1 结果；⑦ V1 仍不得跨仓汇总 `suggest_qty`。
- `SECURITY INVOKER` + `SET search_path=''` + `auth.uid()` 绑定；`REVOKE PUBLIC, anon` + `GRANT authenticated`。

> v4 选定方案 B（唯一详情 RPC `get_war_room_variant_detail`），隔离更清晰、不与列表分页耦合；列表与详情均以 §4.3 角色分支在 DB 内完成仓库权限过滤。

---

### 7.5 P7 Migration 设计（E / F）

> v4 设计了两个只读 RPC 却无对应 Migration 文件、执行顺序与回滚设计；本轮补齐（不创建新表、不修改 RLS、不改动既有 Migration）。

**Migration E — `00045_product_overview_rpc.sql`**
- 职责：创建 `get_product_overview(p_user_id uuid, p_page int, p_page_size int, p_search text, p_stockout_urgency text, p_country text) RETURNS jsonb`（§7.3 唯一列表 RPC）。
- 不创建新表；不新增或关闭 RLS；不修改已有 Migration。
- **E 依赖 P1 Migration C/00043**：`00043_forecast_stockout.sql` 已落盘（RPC 内调用其 `forecast_stockout` 生成列表预测字段）。
- 返回 §4.2 / §7.3 稳定完整 **JSONB 信封**（`{items[], total_count, queue_counts}`；基础字段 + P7-B 预测字段）。
- 必须包含：`SECURITY INVOKER`、`SET search_path = ''`、`REVOKE EXECUTE ON FUNCTION ... FROM PUBLIC, anon`、`GRANT EXECUTE ... TO authenticated`（`REVOKE`/`GRANT` 使用准确签名）。

**Migration F — `00046_war_room_variant_detail_rpc.sql`**
- 职责：创建 **`get_war_room_variant_detail(p_user_id uuid, p_variant_id uuid) RETURNS jsonb`**（§7.4 唯一详情 RPC，**双参数签名**）。
- 不创建新表；不新增或关闭 RLS。
- **F 依赖 P1 Migration C/00043（`forecast_stockout`）与 P1 Migration D/00044（`get_replenishment_suggestions`）**：RPC 内部对每个已权限过滤的可见仓库调用 P1 v8 唯一实现 `get_replenishment_suggestions`，复用其行动层结果（`safety_stock`/`target_stock`/`net_demand`/`suggest_qty`/`est_stockout_date`/`effective_inbound`/`latest_order_date`/`replenishment_urgency`），**不复制 P1 行动公式**；P7 自身查询补充 `warehouse_id`/`country`/`on_hand`/`daily_sales`/`inbound`/`visible_inbound_quantity`/`eta_missing_quantity`/`base_stock_status`（见 §7.4）。
- 只返回当前用户有权访问仓库的详情（§4.3 角色分支在 RPC 内完成）；P1 行动层字段随 `assigned_warehouse_detail[]` 按 warehouse_id 返回；**`P7-B` 的 `stockout_urgency` 仍由 `forecast_stockout` 推导，与 P1 `replenishment_urgency` 分离**。
- **强制边界（v7，禁止 Migration F 重算 P1 行动公式）**：① 不得复制 `get_replenishment_suggestions` 内的 `safety_stock`/`target_stock`/`net_demand`/`suggest_qty`/`latest_order_date` 行动层公式；② 不得重新写 `round(ds * lead * buffer)` / `round(ds * lead * cover)` / `greatest(0, target_stock - ...)`；③ 调用 `get_replenishment_suggestions` 时 `p_include_zero` 必须为 `true`；④ 指定 `p_variant_id`+`p_warehouse_id` 后预期返回 0 或 1 行；⑤ 若可见 inventory 组合存在但 P1 RPC 未返回对应行：**不得在 P7 内回退重算**，视为数据契约异常，RPC 返回受控错误、由 Server Action 转友好中文、不暴露 SQL；⑥ 多仓逐仓映射、不串仓；⑦ V1 不跨仓汇总 `suggest_qty`。
- 必须包含：`SECURITY INVOKER`、`SET search_path = ''`、`REVOKE EXECUTE ON FUNCTION get_war_room_variant_detail(uuid, uuid) FROM PUBLIC, anon`、`GRANT EXECUTE ON FUNCTION get_war_room_variant_detail(uuid, uuid) TO authenticated`（**REVOKE/GRANT 使用准确的双参数签名**）。

**执行 / 回滚顺序**
- 整体顺序：**P1 A→B→C→D → P7 E→F**。
- P7 回滚顺序：**F→E**。
- **Dependency（v7）**：**E 依赖 P1 Migration C/00043**（生成列表预测字段）；**F 依赖 P1 Migration C/00043 + P1 Migration D/00044**（直接依赖 `get_replenishment_suggestions` 复用行动层，不复制行动公式）。
- 约束：Claude 实施前必须检查 `supabase/migrations` 最新编号；若 `00045`/`00046` 已被占用，两份**整体顺延为连续新编号**（如 00047/00048），不得覆盖或修改已执行 Migration；E/F 必须含 `SECURITY INVOKER` / `SET search_path` / `REVOKE PUBLIC,anon` / `GRANT authenticated`。

---

## 8. 与既有方案/模块的依赖与落地顺序

```
BigSeller 同步(已有)  ──┐
库存/权限模块(已有)   ──┼──► P7-A 全球库存基础总览（/dashboard/products/overview，用 shipment+shipment_item 人工 ETA 做在途汇总）
shipment/shipment_item(已有) ──┘
                            │
P0 外部轨迹(喜运达/tracking_event_external) ──► Shipment 详情页（P0 不指向 P7 页面；P0 不是 P7-A/P7-B 的计算或页面前置依赖；P7 仅用 shipment_id 跳转 Shipment 详情）
                            │
预测式补货引擎(v8)   ──────► P7-B 作战室增强层·补货建议(行动层, 调用同一数据库函数 forecast_stockout(...)，由 P1 Migration C/00043 创建)
P7 Migration E/F    ──────► get_product_overview / get_war_room_variant_detail（见 §7.5，须在 P1 C/D 之后）
```

**统一实施顺序（v5）**：`P0 → P1（补货引擎，Migration A→B→C→D）→ P7-A（基础总览）→ P7-B（作战室增强层）→ P8（国内库存接入）→ P7-C（启用国内补给判断）`；P7 的 DB/页面实施**发生在 P1 之后**（Migration 顺序 **P1 A→B→C→D → P7 E→F**）。P0 喜运达并行（外部轨迹**仅在 Shipment 详情页展示**，不进入 P7 V1 数据源）。

- **P7-A 基础展示业务语义不使用预测字段**：P7-A 页面只展示 §4.2 基础字段（`visible_*`/`base_stock_status`/国内占位）；但按当前实施顺序，P7 的数据库与页面实施发生在 P1 之后，`get_product_overview`（§7.5 Migration E）一次性返回稳定完整契约（含 P7-B 预测列），P7-A 页面忽略预测列、P7-B 再开启。删除「P7-A 可以在 P1 Migration 之前独立创建完整预测 RPC」表述；不设计两版同名 RPC、不增临时 RPC。
- **P7-B 依赖 P1**：前向推演（`earliest_stockout`/`stockout_urgency`/分国 burn-down/详情弹窗）调用 P1 的 `forecast_stockout(...)`（Migration C/00043）；补货建议（net_demand/suggest_qty/latest_order_date，`replenishment_urgency` 语义）在 P1 落盘后叠加。P7-B 必须在 P1 Migration C 落盘后启用。
- **国内补给判断依赖 P8**：V1 国内 `data_unavailable`；P8 完成国内真实接入后，P7-C 启用国内补给判断（DomesticJudge 由占位改为真实计算）。
- **V1 在途推演不依赖喜运达提供 ETA**：ETA 来自 `shipment.estimated_arrival`（人工录入）；喜运达 `tracking_event_external` 仅在 **Shipment 详情页**展示（见 §4.1 🔒 收口），**不属于 P7 V1 数据源，P7 既不读取也不展示**。
- **P7 不依赖首页**：本产品为 `/dashboard/products/overview` 唯一产品级总览页。
- **国内库存未接入**：V1 国内列 `data_unavailable`，不参与计算；接入为独立后续工作（P8）。

> **待同步事项（总纲不一致，本轮禁止修改总纲）**：总纲当前仍写「P7 与作战室合并」「P7-A→P1→P7-B→P8→P7-C」等旧顺序描述，且未含 P7 Migration E/F 与「P7 实施在 P1 之后」的澄清。本轮**仅在本方案记录**，待总纲单独审查时同步：① 实施顺序统一为 `P0 → P1 → P7-A → P7-B → P8 → P7-C`；② 新增 P7 Migration E（00045）/F（00046），执行 P1 A→B→C→D → P7 E→F、回滚 F→E；③ P1 版本统一 v8、P0 统一 v8；④ `forecast_stockout` 由 P1 Migration C/00043 创建（非 Migration D）。

---

## 9. 验收标准

### 9.1 权限与路由（Codex 九 · 新增 20 条核心）
1. 未登录访问 `/dashboard/products/overview` 被拦截（Dashboard Layout `getCurrentUser()` → redirect login）。
2. 停用用户访问被拦截（`getCurrentActiveUser()` 返回 null → InactiveAccountPage）。
3. Operator 只能看到 assigned `warehouse_id` 的数据。
4. Operator 不能因 country 相同而看到该国其他未授权仓（warehouse_id 级，非 country 级）。
5. Admin 可看到全部 active overseas warehouse。
6. 国内库存缺失时显示「待接入」，不显示假 0。
7. 喜运达 `tracking_event_external` 不被当作 inbound 数量 / 可计算 ETA。
8. 无 `shipment_item` 时不产生在途数量（`remaining>0` 过滤）。
9. 同 ETA 多批次只扣一次日期差（GROUP BY eta + SUM）。
10. ETA 当天按补货引擎规则计算（`cur == consume` 先扣再补）。
11. ETA 晚于断货日不抵扣（`effective_inbound` 仅计 `eta <= est_stockout_date`；该在途仍计入 `visible_inbound_quantity`，见 §4.2）。
12. `daily_sales` NULL/<=0 显示 `data_incomplete`，不生成虚假断货日。
13. `lead_time_days` NULL/<=0 不生成虚假最晚下单日（`data_incomplete`）。
14. `effective_inbound` 空集合返回 0（COALESCE，非 NULL）。
15. `product_id` 为 NULL 的 variant 仍可展示（独立成行）。
16. 同 SKU 不同国家 variant 不被错误合并（行键 = `product_variant.id`）。
17. 分页后排序仍然全局正确（DB 内全局排序再分页，非每页内排序）。
18. 空数据 / 错误 / 加载中 / 无权限四种状态完整。
19. **详情弹窗调用链固定**：点击行懒加载走 `Client → getProductVariantDetailAction`（Server Action，`requireActiveAuth` + Zod 校验 `variantId`）→ `productOverviewRepository.getProductVariantDetail` → `get_war_room_variant_detail` RPC → RLS；点击交互下 Server Component 不自动重执行，禁止「页面在点击时直接调用 Repository」的不可能链路（对应 §7.2 链 ② / §7.4）。
20. **列表首屏调用链固定**：`page.tsx`（Server Component）→ `productOverviewRepository.getProductOverview` → `get_product_overview` RPC → RLS，**不经 Server Action**；全部查询经 Repository / Server Action，Client 不得直连 Supabase；前端不传可见国家列表（对应 §7.2 链 ① / §7.3）。

### 9.2 交互与功能（沿用 v1 并修正）
21. 侧边栏**产品分组**出现「全球库存总览」入口（页面标题显示「全球库存作战室」），Admin + Operator 均可见，点击进入 `/dashboard/products/overview`；不存在第二产品级库存总览页（原规划 `/dashboard/war-room` 退役）；现有首页与其他模块不受影响。
22. 按阶段验收：**P7-A 只显示基础字段**（`visible_*`/`base_stock_status`/国内待接入）；**P7-B 才显示** `earliest_stockout`/`stockout_urgency`/预测详情；主表每个 `product_variant.id` 一行（inventory 驱动，见 §4.5），按稳定排序（stockout_urgency 优先级 → earliest_stockout NULLS LAST → variant_id）。
23. 切换运营账号，不可见仓库整列/整行数据消失，earliest_stockout/stockout_urgency 仅按可见范围计算。
24. 点行弹出产品详情（国内补给判断 `data_unavailable` + KPI + 分国推演 + 库存小表），Esc/遮罩/✕ 可关。
25. 分国 burn-down 正确呈现在途台阶与断货点；「最晚下单日危险区」仅在 P1 补货引擎行动层数据（`replenishment_urgency` 语义）随 P1 Migration C 落盘后存在时展示，P7-B 不自行推算下单建议；国内为「待接入」占位、不标断货。
26. 顶部三档 chip 可点击筛选，计数保持全量。
27. 国内字段在弹窗小表中显示「待接入」（即便国内库存页未建），生产周期标「待定」。
28. **P7-B 必须在 P1 Migration C（00043_forecast_stockout.sql）落盘、共享函数 `forecast_stockout(...)` 可用后启用**；启用前 P7-A 仅呈现基础字段，不展示 `earliest_stockout`/`stockout_urgency`/预测；删除「补货引擎未接入时前向推演独立可用」表述（对应 §8 实施顺序）。

### 9.3 v3 终审新增（#29–36，算法位置 / 字段拆分 / 读取链路 / 边界）

29. **多仓混合（部分 ds 无效）**：同一 variant 多仓库，其中一个 `daily_sales = NULL`、另一个有效 → 无效仓库**不参与** `earliest_stockout`（不得当作 0），有效仓库正常参与；部分有效时行级 `partial_data = true`。
30. **多仓全 ds 无效**：所有 assigned 仓库 `daily_sales = NULL` → `earliest_stockout = NULL`、`stockout_urgency = data_incomplete`。
31. **ETA=NULL 在途**：某仓库存在 `eta IS NULL` 的 inbound → `visible_inbound_quantity` 可显示该在途；`effective_inbound` 不计入；随行返回 `eta_missing_quantity`（或等价数据质量标记），不得静默丢弃。
32. **晚到在途**：`eta > est_stockout_date` 的 inbound → 不计入 `effective_inbound`；仍按 `visible_inbound_quantity` 统计（可见总量包含晚到）。
33. **稳定排序**：两个 variant 的排序键相同（同 `stockout_urgency` 且同 `earliest_stockout`）→ 按 `variant_id` 决胜排序，翻页不重复、不遗漏（`ORDER BY stockout_urgency 优先级, earliest_stockout NULLS LAST, variant_id`）。
34. **详情接口权限（沿用 §4.3 角色分支）**：`get_war_room_variant_detail` 内部先按 `auth.uid()` 生成可见 warehouse 集合（Admin = `warehouse.type='overseas' AND is_active=true`，不依赖 `user_warehouses`；Operator = 与 `get_assigned_warehouse_ids()` 交集），再按 `warehouse_id` 过滤；不能经 `variant_id` / `country` / 前端参数绕过仓库权限。
35. **page 读取链路**：`page.tsx` 必须为 Server Component → Repository → RPC；不得强制经过无必要的 Server Action 取数。
36. **P1/P7-B 同一算法**：P1 补货引擎与 P7-B 作战室增强层必须调用同一个数据库预测函数 `forecast_stockout(...)`，不能分别实现两套算法（禁止 TS 域函数 + SQL 内联各一套）。

> 全量验收（v3 终审基线，未含 v4/v5 新增）共 **36 条**（§9.1 核心 20 + §9.2 交互 8 + §9.3 终审新增 8）。

### 9.4 v4 合并整合验收（#37–38，P7 与作战室合并为单一产品）

37. **唯一产品级路由**：全站仅存在 `/dashboard/products/overview` 一个产品级库存总览页；不存在第二个产品级总览页（原规划 `/dashboard/war-room` 退役，若曾误建须 301 重定向）；P7-A 与 P7-B 共用同一路由与页面。
38. **唯一列表 RPC**：全站仅存在 `get_product_overview` 一个产品级总览列表 RPC；不存在第二套产品总览 RPC（原 `get_war_room_overview` 不再单独设计）；详情接口统一使用 `get_war_room_variant_detail`（唯一详情 RPC）。

> 全量验收（含 v4 合并整合）更新为 **38 条**（§9.1 核心 20 + §9.2 交互 8 + §9.3 终审新增 8 + §9.4 合并整合 2）。

### 9.5 v5 架构修订验收（#39–50，对应 Codex 10 类实施级问题）

39. **实施顺序与 RPC 依赖（fix 一）**：实施顺序严格为 `P0 → P1 → P7-A → P7-B → P8 → P7-C`；P7 的 DB/页面实施发生在 P1 之后，`get_product_overview` 返回稳定完整契约、P7-A 只展示基础字段、P7-B 再开启预测列；删除「P7-A 可在 P1 前创建完整预测 RPC」表述；不设计两版同名 RPC、不增临时 RPC（对应 §8）。
40. **P1 Migration 引用（fix 二）**：全文对 `forecast_stockout` 共享函数的创建归属统一为 **P1 Migration C（00043_forecast_stockout.sql）**，不再写为 Migration D；P1 / P0 版本统一标注 v8（对应 §2 决策 8 / §5 / §7.1 / §11.1 历史标注）。
41. **P7 自身 Migration（fix 三）**：P7 新增两个 RPC Migration **E = 00045_product_overview_rpc.sql**（创建 `get_product_overview`）/ **F = 00046_war_room_variant_detail_rpc.sql**（创建 `get_war_room_variant_detail`）；执行顺序 **P1 A→B→C→D → P7 E→F**，回滚 **F→E**；两 RPC 均 `SECURITY INVOKER` + `SET search_path=''` + `REVOKE PUBLIC, anon` + `GRANT authenticated`；不建新表、不改 RLS、不改既有 Migration（对应 §7.5）。
42. **Admin-Operator 权限（fix 四）**：列表/详情 RPC 先校验 `auth.uid()` 非空 / `p_user_id = auth.uid()` / `profiles.is_active` / 角色仅 `admin`·`operator`；**Admin 可见集合 = `warehouse.type='overseas' AND is_active=true`（不依赖 `get_assigned_warehouse_ids()`）**；**Operator 可见集合 = `get_assigned_warehouse_ids()` 与 active overseas 取交集**；无角色/停用/未登录直接拒绝；先生成可见 `warehouse_id` 集合再过滤 `inventory`，最后按 warehouse/country 聚合；`country` 仅展示/筛选、非授权边界（对应 §4.3）。
43. **列表驱动集合（fix 五）**：列表以 **`inventory` 为驱动表**（variant×warehouse 库存行），只展示可见 active overseas 中存在 `inventory` 行的 variant，每个 `variant_id` 聚合一行；不为「只有在途、无 inventory」的 variant 虚构 `on_hand=0`；`product_variant.product_id` 可 NULL、`product` 用 LEFT JOIN；行键恒为 `product_variant.id`，避免 variant×warehouse 笛卡尔积（对应 §4.5 十规则 / §9.2 #22）。
44. **详情弹窗真实调用链（fix 六）**：详情弹窗固定走 `Client → getProductVariantDetailAction`（Server Action，`requireActiveAuth` + Zod）→ Repository → `get_war_room_variant_detail` RPC → RLS；点击行不重执行列表 RPC；禁止「详情由页面在点击时直接调用 Repository」的不可能链路（对应 §7.2 链 ② / §7.4）。
45. **urgency 命名分离（fix 七）**：P7 断货风险命名为 **`stockout_urgency`**（critical/warning/ok/data_incomplete），P1 下单紧迫度命名为 **`replenishment_urgency`**；两者不共用裸 `urgency` 字段，列表筛选参数用 `p_stockout_urgency`，弹窗分别展示（对应 §4.2 / §7.3 / §7.4）。
46. **基础告警复用 safety_stock（fix 八）**：基础告警不写死阈值「8」；复用 `product.safety_stock` 计算 `base_stock_status`，按 §4.5.1 固定 CASE 顺序 `quantity=0 → out_of_stock` → `product_id IS NULL OR match_status<>'matched' → unmatched` → `quantity<=safety_stock → low` → `else normal`；unmatched 不参与 low/normal、不 `COALESCE(safety_stock,0)`；行级按可见仓库最严重聚合 `out_of_stock>low>normal>unmatched`；无「低库存阈值待确认」开放问题（对应 §4.2 / §4.5.1）。
47. **P0 外部轨迹收口（fix 九）**：V1 不直接读 `tracking_event_external`；在途计算只用 `shipment` + `shipment_item`；P0 外部轨迹继续在 Shipment 详情页展示，P7 用 `shipment_id` 跳现有详情；P0 不是 P7-A/P7-B 的计算或页面前置依赖（对应 §4.1 🔒 收口）。
48. **RPC 返回与分页计数契约（fix 十）**：`get_product_overview` `RETURNS jsonb` 信封稳定返回 `items[]`（含 `base_stock_status` / `stockout_urgency` / `partial_data` / `domestic_status='data_unavailable'`）+ 信封级 `total_count` / `queue_counts`；`queue_counts` 从 base_cohort 统计四档、受 search/country、不受 stockout_urgency 与分页；`total_count` 从 filtered_cohort 统计、受 stockout_urgency、不受分页；分页在全局排序后执行；排序固定 `stockout_urgency 优先级 → earliest_stockout NULLS LAST → variant_id`（对应 §4.2 / §7.3；详见 v6 #51–#53）。
49. **列表 RPC 步骤契约（fix 十细化）**：`get_product_overview` 实现步骤固定——步骤 1 按角色生成可见集合、步骤 2 按 `inventory` 驱动表过滤、步骤 5 补充 `base_stock_status`/`stockout_urgency`/`domestic_status`、步骤 6 固定排序、步骤 8 `queue_counts`、步骤 9 分页在排序后；入参 `p_stockout_urgency?` 替代裸 `p_urgency`（对应 §7.3）。
50. **v5 文档自洽（总验收）**：全文档 v5 修订自洽——§0.3 修订表、§2/§4/§5/§7/§8/§11 引用一致（Migration C/D/E/F、两条调用链、inventory 驱动、urgency 分离、safety_stock 复用、P0 收口）；活动正文无 5 类违禁措辞（Migration D 创建 forecast_stockout / 低库存 ≤8 / P7-A 可在 P1 前创建完整预测 RPC / 详情点击由 page.tsx 直接调用 Repository / 裸 urgency 字段）；grep 复检通过；待 Codex 复审定稿后交 Claude。

> 全量验收（含 v5 架构修订）更新为 **50 条**（§9.1 核心 20 + §9.2 交互 8 + §9.3 终审新增 8 + §9.4 合并整合 2 + §9.5 v5 架构修订 12）。

### 9.6 v6 最终收口验收（#51–58，对应 Codex 8 类最终收口问题）

> 本组为 v6 新增，逐条对应 §0.4 的 8 类收口。**不得删除 #1–50 任一旧条目凑数**；#51–58 与旧条目并存。

51. **列表 RPC JSONB 信封（收口五）**：`get_product_overview` 必须 `RETURNS jsonb` 返回稳定信封 `{ "items": [...], "total_count": <int>, "queue_counts": { "critical": <int>, "warning": <int>, "ok": <int>, "data_incomplete": <int> } }`；`total_count` 与 `queue_counts` 为**信封级字段、绝不随 `items` 行返回**；当前页 `items` 为空数组时仍返回正确的 `total_count`（可为 0）与四档齐全的 `queue_counts`（对应 §4.2 / §7.3）。
52. **查询流水线与计数口径（收口六）**：`get_product_overview` 内部固定流水线 `visible_scope → base_cohort → queue_counts → filtered_cohort → total_count → items`；`queue_counts` 从 `base_cohort` 统计（受 `p_search`/`p_country`，**不受 `p_stockout_urgency` 与分页**）；`total_count` 从 `filtered_cohort` 统计（受 `p_stockout_urgency`，**不受分页**）；`p_search`/`p_country` 同时改变 `queue_counts` 与 `total_count`，`p_stockout_urgency` 只改 `total_count`，分页都不改；活动正文不得出现「分页与筛选都不改变计数」这类过宽表述（对应 §7.3）。
53. **partial_data 与枚举分离（收口三）**：`stockout_urgency` 枚举**只有四值** `critical / warning / ok / data_incomplete`，`partial_data` **绝不作为第五个枚举值**；`partial_data` 为独立 boolean——部分 assigned 仓库 `daily_sales` 有效时取有效仓库最小断货日正常算档 + `partial_data=true`；全部无效时 `earliest_stockout=NULL` + `stockout_urgency=data_incomplete` + `partial_data=false`；`queue_counts` 只统计四档 `stockout_urgency`、不含 `partial_data` 档位（对应 §4.2 / §5.3 / §7.3）。
54. **详情 RPC 双参数签名 + 行动字段按仓库（收口七）**：详情 RPC 固定 `get_war_room_variant_detail(p_user_id uuid, p_variant_id uuid) RETURNS jsonb`（`p_user_id` 来自 `requireActiveAuth`、RPC 内强制 `= auth.uid()`，`p_variant_id` 仅查询条件）；Migration F 的 `REVOKE`/`GRANT` 与 Repository 调用均使用准确双参数签名 `get_war_room_variant_detail(uuid, uuid)`；P1 行动字段 `net_demand`/`suggest_qty`/`latest_order_date`/`replenishment_urgency` 只出现在 `assigned_warehouse_detail[]` 内按 `warehouse_id` 返回，**顶层不出现任何无仓库归属的行动字段**；V1 不跨仓求和 `suggest_qty`（对应 §7.4 / §7.5）。
55. **base_stock_status 固定 CASE 顺序（收口八）**：`base_stock_status` 判定固定为 `quantity=0 → out_of_stock` → `product_id IS NULL OR match_status<>'matched' → unmatched` → `quantity<=safety_stock → low` → `else normal`（含「未匹配且 quantity=0」归入 `out_of_stock`）；`unmatched` 不参与 `low`/`normal`、不 `COALESCE(safety_stock,0)`；行级按可见仓库最严重聚合 `out_of_stock>low>normal>unmatched`；§4.2 / §4.5.1 / #46 / 取证附录口径一致（对应 §4.5.1）。
56. **决策摘要 Admin 分支 + 一行描述（收口一）**：§2 决策 3 权限摘要必须体现完整分支 `auth.uid() → 校验 is_active 与角色 → 按角色生成可见集合（Admin=全部 active overseas；Operator=get_assigned_warehouse_ids() 与 active overseas 交集）→ 过滤 inventory/shipment/shipment_item → 聚合 warehouse/country`，**不得直接写 `auth.uid() → get_assigned_warehouse_ids()`**；§4.2 一行聚合描述为「每个当前用户可见、且至少存在一条 `inventory` 行的 `product_variant.id` 聚合为一行」，不得暗示所有 variant 无条件进列表（对应 §2 决策 3 / §4.2 / §4.3）。
57. **P0 外部轨迹移出 P7 V1 数据源（收口二）**：活动正文中 P7 V1 数据源仅 `inventory`/`product_variant`·`product`/`warehouse`/`shipment`/`shipment_item`/P1 `forecast_stockout` 及补货契约；`tracking_event_external` **不属于 P7 V1 数据源**，P7 V1 既不读取也不展示；P0 外部轨迹只在现有 Shipment 详情页展示，P7 仅用 `shipment_id` 跳转；P0 不是 P7-A/P7-B 的计算或页面前置依赖；`§3` 数据层 / `§4.1` 数据源表·说明 / `§8` 图均已对齐，历史章节保留旧描述但标注「历史问题，已在 v6 移出 P7 V1」（对应 §3 / §4.1 / §8 / §11.3 九）。
58. **模块注释对齐 + RPC 内部校验 + v6 自洽（收口四 + 补充）**：§7.1 模块注释与 v5 详情懒加载链路一致——`page.tsx`「Server Component：列表首屏直接调用 Repository，不经 Server Action」、`actions.ts`「客户端触发的详情懒加载 Server Action：requireActiveAuth + Zod → Repository → 详情 RPC；不用于列表首屏读取，不执行 revalidatePath」，删除「Server Action 仅用于写入/revalidate」；两个 RPC **内部亦须做输入校验**（`p_user_id` 非空且 `=auth.uid()`、`p_page>=1`、`p_page_size` 1..100、`p_stockout_urgency ∈ {NULL,critical,warning,ok,data_incomplete}`、`p_country` 限 NULL/合法国家码、`p_search` trim 后空串按 NULL、`p_variant_id` 非空），不得仅依赖前端 Zod（authenticated 用户可直接调用 RPC）；全文档 v6 修订自洽、活动正文无 6 类违禁措辞（见 §11.4 grep 复检），待 Codex 最终复审后交 Claude（对应 §7.1 / §7.3 / §7.4 / §11.4）。

> 全量验收（含 v6 最终收口）更新为 **58 条**（§9.1 核心 20 + §9.2 交互 8 + §9.3 终审新增 8 + §9.4 合并整合 2 + §9.5 v5 架构修订 12 + §9.6 v6 最终收口 8）。

### 9.7 v7 最终两项收口验收（#59–61，对应 Codex 复审最终两项）

> 本组为 v7 新增，逐条对应 §0.5 的两类收口。**不得删除 #1–58 任一旧条目凑数**；#59–61 与旧条目并存。最终全量验收 = 原 58 条 + 新增 3 条 = **61 条**。

59. **服务端 userId 传递链（fix v7 一）**：① 列表 `page.tsx` 调用 `requireActiveAuth()` 后，将 `user.id` 作为第一个参数传给 `productOverviewRepository.getProductOverview(user.id, params)`；② 详情 `getProductVariantDetailAction` 调用 `requireActiveAuth()` 后，将 `user.id` 作为第一个参数传给 `productOverviewRepository.getProductVariantDetail(user.id, variantId)`；③ Client 输入中**不存在** `userId`；④ Repository 向 RPC 传 `p_user_id = user.id`，**不使用任何客户端数据构造 `p_user_id`**；⑤ 两个 RPC 继续校验 `p_user_id = auth.uid()`（对应 §7.1/§7.2/§7.3/§7.4/§11.5 一）。
60. **P1 行动层唯一实现（fix v7 二）**：① Migration F 调用 P1 v8 唯一实现 `get_replenishment_suggestions`；② 调用时**同时指定** `p_variant_id` 与 `p_warehouse_id`；③ `p_include_zero = true`；④ 每个可见仓库映射**自己的** P1 结果到 `assigned_warehouse_detail[]`；⑤ Migration F 中**不存在** P1 行动公式副本（`safety_stock`/`target_stock`/`net_demand`/`suggest_qty`/`latest_order_date` 计算公式）；⑥ P1 `urgency` 映射为 `replenishment_urgency`；⑦ P7 自身的 `stockout_urgency` 仍按 `earliest_stockout` 计算，与 `replenishment_urgency` 分离（对应 §7.4/§7.5/§11.5 二）。
61. **Migration 依赖与异常边界（fix v7 依赖修正）**：① Migration E 依赖 P1 Migration C/00043；② Migration F 依赖 P1 Migration C/00043 + P1 Migration D/00044（直接依赖 `get_replenishment_suggestions`）；③ P1 RPC 缺失对应仓库行时返回**受控错误**；④ 不得在 P7 回退重算公式；⑤ 多仓结果**不串仓**；⑥ `suggest_qty` **不跨仓求和**；⑦ 整体执行顺序 **P1 A→B→C→D → P7 E→F**，回滚 **F→E**（对应 §7.5/§8/§11.5 三）。

> 全量验收（含 v7 最终两项收口）更新为 **61 条**（§9.1 核心 20 + §9.2 交互 8 + §9.3 终审新增 8 + §9.4 合并整合 2 + §9.5 v5 架构修订 12 + §9.6 v6 最终收口 8 + §9.7 v7 最终两项收口 3）。

---

## 10. 待确认 / 开放问题（不阻塞本期）
- 补货引擎接入后，弹窗「补货建议」区的具体呈现形式（文字结论 / 计划发货表）待补货引擎方案定稿后补。
- 国内库存接入方案（独立后续）：数据来源、`domestic` warehouse 的 inventory 同步、接入后 `DomesticJudge` 算法。
- 是否需要「导出 PDF / 截图汇报」类运营动作？（非本期）
- 喜运达接入计算的后续方案：运单 → `shipment_external_ref` → `shipment` → `shipment_item` → `variant` → ETA 预测模型（独立方案，不阻塞 V1）。

---

## 11. 取证附录（Codex 10 项逐条核实）

- **一（路由）**：`src/app/dashboard/layout.tsx:23-35` — `getCurrentUser()` 未登录 `redirect('/auth/login')`；`getCurrentActiveUser()` 停用返回 `InactiveAccountPage`；`SidebarNav` 渲染。无 `src/app/war-room` 目录（Bash `ls src/app/dashboard` 仅见 dashboard 子路由）。→ 属实。v2 改 `/dashboard/war-room`。
- **二（权限）**：`src/types/database.ts:570` `user_warehouses`、`591` `get_assigned_warehouse_ids`；`src/features/warehouse-access/repository.ts:21-64` `cachedGetAccessibleWarehouseIds`（admin=全部 active overseas、operator=`user_warehouses`）、`:77` `canAccessVariant` 经 `inventory` 校验。→ 属实。v2 改 warehouse_id 级。
- **三（喜运达）**：`DIS-喜运达物流轨迹API接入-方案.md:31`「喜运达无 ETA 字段，故不能自动写 `estimated_arrival`」、`:67`「`shipment.estimated_arrival` 仅由运营手工维护，喜运达无 ETA 字段」、`:92`「绝不回写 `shipment.status`/`tracking_event`/`inventory`/`estimated_arrival`/`warehoused`」、`:220`「P0 只保存 `tracking_event_external.status`…」、`:244` RLS 仅 `shipment_external_ref`。→ 属实。v2 V1 用 shipment+shipment_item。
- **四（数据层）**：`src/features/warehouse-access/` 含 `types.ts`/`schema.ts`/`repository.ts`/`actions.ts`/`components`；`actions.ts:1` `'use server'`、`:6` `requireActiveAdmin`、`:79` `updateUserWarehousesSchema.safeParse`、`:90` `revalidatePath`。→ 属实。v2 补全 `src/features/war-room/{types,schema,repository,actions,components}` + `get_war_room_overview` RPC（方案 B）。
- **五（算法）**：v1 §5.1 `stockout_day(c)` 独立实现（无 GROUP BY ETA、无 `cancelled_at`/`bigseller` 过滤、写死 `LEAD(…, 演示 12 天)`）；补货引擎 v6 §4.3 已规范（GROUP BY+SUM、cursor_date、COALESCE、lead 取真实列）。→ 属实。v2 复用 `forecastStockout`。
- **六（国内）**：`src/types/database.ts:143` `warehouse.type` 含 `domestic`；`src/app/dashboard/_components/sidebar-nav.tsx:43` `/dashboard/inventory/domestic` 标记 `phase:'2'`（未建）；v1 §5.3 用「国内在手/日销」算 `d_cover` 并给建议。→ 属实。v2 国内 `data_unavailable`、NULL、不参与计算。
- **七（行键）**：`src/types/database.ts:93-107` `product_variant`：`id` PK、`product_id` **nullable**、`sku`/`country`/`name`；`:174-185` `inventory`：`variant_id`+`warehouse_id`+`quantity`+`daily_sales`(nullable)。→ 属实。v2 行键 `product_variant.id`。
- **八（字段名）**：v1 §4.2 用 `net_sellable`。→ 命名/语义修正。v2 改 `visible_total_quantity`。
- **九（验收）**：v1 §9 仅 8 条 UI 交互验收。→ 属实。v2 补 20 条核心验收（§9.1）。
- **十（总纲）**：总纲 L112 交付物 `/war-room`、L114 评审重点「权限按可见国家过滤」、L127 M0「解锁作战室在途 ETA」措辞过度。→ 属实。v2 同步总纲 P2（见总纲修订）。

### 11.1 v3 终审取证（5 类问题 + 总纲同步）

- **二（算法执行位置）**：P1 v6 §4.3/§6.2 算法为 `get_replenishment_suggestions` RPC **内联 CTE**（`inbound` CTE + 事件模拟 + `effective_inbound`），无独立函数；war-room v2 §5.1 标题「共享域函数 `forecastStockout`（单仓库粒度）」+ §7.1 `lib/forecast/stockout.ts // 共享域函数` + §7.3「逐仓库调用 `forecastStockout`（或等价 SQL）」——确为 TS 域函数 + SQL 内联 + 「等价 SQL」三套并存风险，违反「同一实现」。→ 属实。v3 选定推荐路径：抽取数据库函数 `forecast_stockout(...)`（**P1 Migration C/00043 创建；早期 v3 评审曾记为 Migration D，历史记录非当前契约**），P1/P2 均调用之；删除 TS 域函数与「等价 SQL」表述。
- **三（字段语义冲突）**：v2 §4.2 `visible_total_quantity = visible_on_hand + effective_inbound`，但同段 `effective_inbound = Σ inb_qty`（见 §5 同 ETA 聚合 + COALESCE）而 §5.1 `effective_inbound` 口径为 `eta <= est_stockout_date` → 晚到在途不进 `visible_total_quantity`，与「可见总量」语义矛盾。→ 属语义冲突。v3 拆分 `visible_inbound_quantity`（全部有效在途，含 eta NULL）/ `effective_inbound`（仅 eta<=断货日）/ `eta_missing_quantity`，`visible_total_quantity = visible_on_hand + visible_inbound_quantity`。
- **四（读取链路）**：v2 §7.1 `page.tsx // Server Component：调用 Server Action 取数` + §7.2「页面经 Server Component / Server Action 获取数据」——未明确 Repository 位置、未排除「强制经无必要 Server Action 取数」、缺详情接口契约。→ 属链路不清。v3 明确 `page.tsx → Repository → RPC`，Server Action 仅用于写入/revalidate，新增 §7.4 详情 RPC `get_war_room_variant_detail`。（**历史记录，非当前契约**：v5 起详情懒加载改走 `getProductVariantDetailAction` Server Action 读取，v6 §7.1 模块注释已对齐，「Server Action 仅用于写入/revalidate」不再是当前口径，见 §11.4 四。）
- **五（伪代码边界）**：v2 §5.1 仅含单仓事件模拟，无 `daily_sales` NULL/<=0 早退、`lead` NULL 处理、多仓混合（ds 无效不当 0 / partial_data）、稳定排序 `ORDER BY ... variant_id` 等边界。→ 属边界缺失。v3 §5.1/§5.3 补全（#五.1–#五.5）。
- **六（验收补全）**：v2 §9.1 仅 #12 覆盖单仓 `daily_sales` NULL→data_incomplete，未覆盖多仓混合/ETA 缺失/晚到/稳定排序/详情权限/读取链路/同函数。→ 属验收缺失。v3 §9.3 新增 #29–36。
- **七（总纲同步）**：总纲 P2 段（L107–126）仍写「v2」「共用 `forecastStockout` 域函数」「Server Component/Server Action 取数」，未含 `visible_inbound_quantity`/`eta_missing_quantity` 区分、详情接口、`page → Repository → RPC` 链路、国内 NULL/数据质量标记。→ v3 同步总纲 P2（见总纲修订：版本 v3、状态「等待本轮修订后 Codex 复审」、共用数据库函数、字段区别、国内规则、详情接口+warehouse_id、读取链路、评审重点第 6 项更新）。

### 11.2 v4 合并整合取证（Rall 终审：P7 与作战室合并为单一产品）

- **一（产品定位分裂）**：`current-state.md:38` P7 路由 `/dashboard/products/overview`（产品分组侧边栏入口）；本方案 v2/v3 路由 `/dashboard/war-room`（§2#1、§3）。二者均为「产品为中心的产品级库存总览页」→ 确为两个独立页面，违反「单一产品」原则。→ 属实。v4 合并为 `/dashboard/products/overview` 单一路由，P7-A/P7-B 共用。
- **二（路由未统一）**：v3 §2#1 用 `/dashboard/war-room`，与 P7 已确认路由 `/dashboard/products/overview`（current-state.md L38）冲突。→ 属路由冲突。v4 唯一正式路由 `/dashboard/products/overview`，旧 `/dashboard/war-room` 退役。
- **三（列表 RPC 未统一）**：`current-state.md:34` P7「新 RPC 暂不新增（待验证）」；v3 §7.3 新增 `get_war_room_overview` → P7 与作战室各有一套产品总览 RPC 设计。→ 属 RPC 分裂。v4 唯一列表 RPC `get_product_overview`，详情 RPC 保留 `get_war_room_variant_detail`。
- **四（国内边界）**：两方案（P7 current-state.md L37「国内库存仅占位待接入」；本方案 §4.4/§5.4 `data_unavailable`）均已有 NULL/占位描述，但分属两个文档、未对齐到同一产品。→ v4 显式合并：P7-A/P7-B V1 国内统一 NULL/`data_unavailable`/待接入/待定，真实接入划归 P8。
- **五（P7 阻塞状态）**：`current-state.md:7` 与 `current-task.md:7` 均记 `P7-PRODUCT-OVERVIEW — BLOCKED_BY_DOMESTIC_INVENTORY`（P7-MVP 不接通国内库存前不启动）。→ 该阻塞基于「必须含真实国内库存」假设，与「海外先行、国内占位」范围矛盾。v4 解除阻塞（见 current-state.md / current-task.md 同步）。
- **六（实施顺序）**：原总纲将 P7 与 P2（作战室）列为独立阶段（总纲 §3 Phase 2 · P2 作战室、P7 仅在 current-state.md 内部）。→ v4 统一顺序：P7-A→P1→P7-B→P8→P7-C（见总纲 §1/§3 重排）。

### 11.3 v5 架构复审取证（Codex 10 类实施级问题，逐条核实）

- **一（实施顺序与 RPC 依赖）**：P1 v8 §5.4 固定 Migration 顺序 A=00041_warehouse_params / B=00042_cancellation / C=00043_forecast_stockout / D=00044_replenishment_rpcs；`get_product_overview` 若返回 `earliest_stockout`/`stockout_urgency`（依赖 `forecast_stockout(...)`）则须 C 已落盘；v4 同时写「P7-A 不依赖 P1」与「RPC 返回全字段且调 forecast_stockout」矛盾 → 统一顺序 **P0→P1→P7-A→P7-B→P8→P7-C**（见 §8）。→ 属实。
- **二（P1 Migration 引用错误）**：P1 v8 §5.4 明确 `forecast_stockout` 由 **Migration C（00043_forecast_stockout.sql）** 创建；v4 活动正文误写作 Migration D。→ 属实。全文改为 Migration C；历史取证段（§0.1 / §11.1）保留旧过程但标注「历史记录，非当前契约」。
- **三（缺 P7 自身 Migration）**：v4 设计 `get_product_overview` / `get_war_room_variant_detail` 两个 RPC 但无 Migration 文件与执行/回滚顺序 → 新增 **E=00045_product_overview_rpc.sql** / **F=00046_war_room_variant_detail_rpc.sql**（见 §7.5），执行顺序 **P1 A→B→C→D → P7 E→F**，回滚 **F→E**；均 `SECURITY INVOKER` + `SET search_path=''` + `REVOKE PUBLIC, anon` + `GRANT authenticated`。
- **四（Admin 仓库过滤与真实函数不符）**：`supabase/migrations/00015_user_warehouses.sql:49-59` 的 `get_assigned_warehouse_ids()` 仅 `SELECT warehouse_id FROM public.user_warehouses WHERE user_id = auth.uid()`，**不返回 admin 全量 overseas**；admin 全量由 `cachedGetAccessibleWarehouseIds`（`src/features/warehouse-access/repository.ts:21-64`）在应用层计算。→ 属实。v5 将 Admin 可见集合下推到 RPC 内按 `warehouse.type='overseas' AND is_active=true` 生成（见 §4.3），Operator 取交集。
- **五（列表 Variant 驱动集合）**：`inventory` 为 variant×warehouse 库存事实表（`src/types/database.ts:174-185`），与 P1 v8 一致；若不固定驱动表，列表易对 variant×warehouse 做笛卡尔积或虚构 `on_hand=0`。→ 属语义修正。v5 固定 `inventory` 为驱动表（见 §4.5 十规则）。
- **六（详情弹窗真实调用链缺失）**：`page.tsx` 为 Server Component，点击行触发的详情是客户端交互，Server Component 不会在点击事件下自动重执行；v4 误将详情读取写成页面在点击时直接取数。→ 属链路澄清。v5 固定两条调用链（见 §7.2 / §7.4）：① 列表 `page.tsx → Repository → get_product_overview RPC → RLS`（不经 Server Action）；② 详情 `Client → getProductVariantDetailAction(Server Action, requireActiveAuth + Zod) → Repository → get_war_room_variant_detail RPC → RLS`。
- **七（urgency 命名冲突）**：v4 中 P7 断货风险与 P1 下单紧迫度均曾称 `urgency`，导致 RPC/TS/UI 字段混淆。→ 属命名冲突。v5 分离为 `stockout_urgency`（P7 断货风险：critical/warning/ok/data_incomplete）/ `replenishment_urgency`（P1 下单紧迫度），列表筛选参数 `p_stockout_urgency`（见 §4.2 / §7.3 / §7.4）。
- **八（基础告警魔法数字 8）**：现有 `get_overseas_inventory` / `get_low_stock` 已用 `quantity` 与 `product.safety_stock` 判定状态（`safety_stock` 来自 `product` 表），v4 却写死阈值 8 并列为开放问题。→ 属告警修正。v5 复用 `product.safety_stock`：`quantity=0 → out_of_stock` / `matched AND quantity<=safety_stock → low` / 其余 `normal` / `product_id=NULL` 或 unmatched → `unmatched`（见 §4.2 / §4.5），删除魔法数字与「低库存阈值待确认」开放问题。
- **九（P0 外部轨迹无落地契约）**：v4 §4.1/§8 声称 P0 `tracking_event_external` 用于 P7 展示，但两 RPC 返回字段均无外部轨迹、页面无轨迹区、Variant→外部运单粒度未定义（`DIS-喜运达物流轨迹API接入-方案.md` 明确喜运达无 ETA、绝不回写 inventory/tracking_event；P0 仅存 `tracking_event_external`）。→ 属实（**历史问题，已在 v6 移出 P7 V1**）。v5 收口方向确立、v6 全文对齐：P7 V1 既不读取也不展示 `tracking_event_external`，在途只用 `shipment`+`shipment_item`；P0 外部轨迹只在 Shipment 详情页展示（见 §4.1 🔒 收口 / §3 数据层 / §8 图）。
- **十（缺 RPC 返回与分页计数契约）**：v4 未定义 `queue_counts` 计算时机、稳定排序键与分页边界。→ 属契约补全。v5 明确 `get_product_overview` 稳定返回 `base_stock_status`/`stockout_urgency`/`partial_data`/`queue_counts`/`total_count`/`domestic_status='data_unavailable'`；`queue_counts` 在 DB 内对「搜索+country 基础过滤后的完整结果」统计各档，分页/筛选不改变原始计数；排序固定 `stockout_urgency 优先级 → earliest_stockout NULLS LAST → variant_id`，分页在全局排序+筛选后执行（见 §4.2 / §7.3）。（**历史记录，非当前口径**：v6 收口六将「分页/筛选不改变原始计数」这一过宽表述细化为——`p_search`/`p_country` 改变 `queue_counts` 与 `total_count`、`p_stockout_urgency` 只改 `total_count`、分页都不改，见 §7.3 计数口径 / §11.4 六。）

### 11.4 v6 最终收口取证（Codex 8 类最终收口问题，逐条核实）

> 本附录逐条核实 §0.4 的 8 类收口。取证以真实代码/Migration/文档为准；巴蒂对本仓库有只读核查权，实现代码仍由 Claude 落盘。

- **一（决策摘要 Admin 分支）**：`supabase/migrations/00015_user_warehouses.sql:49-59` 的 `get_assigned_warehouse_ids()` 仅 `SELECT warehouse_id FROM public.user_warehouses WHERE user_id = auth.uid()`，**不含 admin 全量 overseas**；admin 全量在应用层由 `src/features/warehouse-access/repository.ts:21-64` `cachedGetAccessibleWarehouseIds` 计算。v5 §2 决策 3 摘要直写 `auth.uid() → get_assigned_warehouse_ids() → 过滤`，若被实施者照搬会让 Admin 只看到自己 `user_warehouses` 分配仓（通常为空）。→ 属实。v6：§2 决策 3 改完整分支（校验 is_active/角色 → Admin=全部 active overseas / Operator=交集 → 过滤 → 聚合）；§4.2 一行描述改「每个当前用户可见、且至少存在一条 `inventory` 行的 `product_variant.id` 聚合为一行」，不再暗示所有 variant 无条件进列表。
- **二（P0 外部轨迹移出 P7 V1 数据源）**：`DIS-喜运达物流轨迹API接入-方案.md` 明确喜运达无 ETA 字段、绝不回写 `estimated_arrival`/`inventory`/`tracking_event`，P0 仅 upsert `tracking_event_external`；两 RPC（`get_product_overview`/`get_war_room_variant_detail`）返回字段均无外部轨迹，页面无轨迹区。v5 §3 数据层 / §4.1 数据源表·说明 / §8 图仍将 `tracking_event_external`（喜运达外部节点）列为 P7 展示数据源，与后文「P7 V1 不读取」矛盾。→ 属实。v6：活动正文统一 P7 V1 数据源固定清单（`inventory`/`product_variant`·`product`/`warehouse`/`shipment`/`shipment_item`/P1 `forecast_stockout` 及补货契约），`tracking_event_external` 明确不属 P7 V1；P0 外部轨迹只在 Shipment 详情页展示、P7 用 `shipment_id` 跳转、非前置依赖；§11.3 九等历史章节保留旧描述并标注「历史问题，已在 v6 移出 P7 V1」。
- **三（partial_data 与枚举分离）**：v5 §4.2 曾在 `stockout_urgency` 枚举行列出「部分仓库 ds 无效:partial_data」，而 §5.3/§7.3 又将 `partial_data` 定义为独立 boolean，二者冲突（枚举被污染成五值）。→ 属契约冲突。v6：`stockout_urgency` 固定四值 `critical/warning/ok/data_incomplete`；`partial_data` 为独立 boolean（部分有效→有效仓库最小断货日算档 + `partial_data=true`；全部无效→`earliest_stockout=NULL` + `data_incomplete` + `partial_data=false`）；`queue_counts` 只统计四档。§4.2 / §5.3 / §7.3 已统一。
- **四（模块注释与详情懒加载对齐 + RPC 内部校验）**：v5 §7.2 链 ②/§7.4 已确立「详情懒加载走 `getProductVariantDetailAction` Server Action 读取」，但 §7.1 模块注释仍写「Server Action 仅用于写入/revalidate」，自相矛盾。另 authenticated 用户可绕过前端直接调用 RPC，仅靠前端 Zod 不足。→ 属注释冲突 + 校验缺口。v6：§7.1 注释改 `page.tsx`「Server Component：列表首屏直接调用 Repository，不经 Server Action」、`actions.ts`「客户端触发的详情懒加载 Server Action：requireActiveAuth + Zod → Repository → 详情 RPC；不用于列表首屏读取，不执行 revalidatePath」；两 RPC 内部补输入校验（见 §7.3/§7.4）。
- **五（列表 RPC JSONB 信封）**：v5 §4.2/§7.3 将 `queue_counts`/`total_count` 描述为随行返回字段，当前页 `items` 为空时元数据一并消失，前端无法渲染四档 chip 与总数。→ 属契约缺陷。v6：`get_product_overview` 固定 `RETURNS jsonb` 信封 `{items[], total_count, queue_counts{critical,warning,ok,data_incomplete}}`，`items` 为空仍返回 `total_count` 与完整 `queue_counts`；`ProductOverviewResult` 与信封一致；§7.3 增信封示例 JSON。
- **六（查询流水线与计数口径）**：v5 §7.3 步骤 8 未区分 `base_cohort`/`filtered_cohort`，且出现「分页与筛选都不改变计数」这类过宽表述，导致 `p_stockout_urgency` 是否影响 `total_count` 语义不清；另有「选中文档档」错字。→ 属口径不清。v6：固定流水线 `visible_scope→base_cohort→queue_counts→filtered_cohort→total_count→items`；明确 `p_search`/`p_country` 改变 `queue_counts` 与 `total_count`、`p_stockout_urgency` 只改 `total_count`、分页都不改；错字改「选中档位」。
- **七（详情 RPC 双参数签名 + 行动字段按仓库）**：`src/types/database.ts:93-107`（`product_variant`）与 `:174-185`（`inventory` variant×warehouse）表明行动粒度须落到 warehouse 级；P1 v8 补货建议粒度为 `variant_id + warehouse_id`。v5 §7.4 标题写单参数 `get_war_room_variant_detail(p_variant_id)`（但入参又含 `p_user_id`），且把 P1 行动字段放在 Variant 顶层无仓库归属。→ 属实。v6：固定双参数签名 `get_war_room_variant_detail(p_user_id uuid, p_variant_id uuid) RETURNS jsonb`（`p_user_id` 来自 `requireActiveAuth`、RPC 强制 `=auth.uid()`）；Migration F 的 `REVOKE`/`GRANT` 用 `get_war_room_variant_detail(uuid, uuid)`；`net_demand`/`suggest_qty`/`latest_order_date`/`replenishment_urgency` 移入 `assigned_warehouse_detail[]` 按 `warehouse_id` 返回，顶层不放无仓库归属字段；V1 不跨仓求和 `suggest_qty`。
- **八（base_stock_status CASE 顺序）**：现有 `get_overseas_inventory`/`get_low_stock` 用 `quantity` 与 `product.safety_stock` 判定状态；`product_variant.product_id` 可 NULL、匹配态由 `match_status` 标识。v5 同时写 `quantity=0→out_of_stock` 与 `unmatched`，未定义「未匹配且 quantity=0」交叉归属。→ 属歧义。v6：§4.5.1 固定 CASE 顺序 `quantity=0→out_of_stock` → `product_id IS NULL OR match_status<>'matched'→unmatched` → `quantity<=safety_stock→low` → `else normal`；`unmatched` 不参与 low/normal、不 `COALESCE(safety_stock,0)`；行级 `out_of_stock>low>normal>unmatched`；§4.2 / §4.5.1 / #46 / #55 一致。

### 11.5 v7 最终两项收口取证（Codex 复审最终两项，逐条核实）

- **一（Repository 必须接收服务端 userId）**：v6 §7.3/§7.4 的 RPC 签名均为 `(p_user_id uuid, ...)`，且 §4.3 明确 RPC 前置校验 `p_user_id = auth.uid()`；但 v6 §7.1 模块注释与 §7.2 调用链漏写 `userId` 第一参数，与 RPC 契约不自洽，且存在把 `p_user_id` 写成客户端来源的隐患。`requireActiveAuth()`（`src/features/*/actions.ts` 范式）在服务端返回当前用户，`user.id` 即 `auth.uid()`，可作 Repository 第一参数；Client 输入经 Zod 仅含 `variantId` / `searchParams`，不得含 `userId` / 角色 / 仓库列表 / 国家权限。→ 属实。v7：§7.1 Repository 接口改为 `getProductOverview(userId, params)` / `getProductVariantDetail(userId, variantId)` 并补 `interface ProductOverviewRepository`；§7.2 两条调用链补 `requireActiveAuth()` 与 `user.id` 传递；§7.3/§7.4 补 Repository 契约；（grep 复检见输出摘要，活动正文不再出现漏写 userId 的 Repository 调用）。
- **二（P7 详情行动字段必须复用 P1 主 RPC）**：P1 v8 `get_replenishment_suggestions(p_user_id, p_variant_id, p_warehouse_id, p_country, p_urgency, p_search, p_include_zero, p_page, p_page_size) RETURNS jsonb {data[], total}` 为行动层**唯一实现**（粒度 variant_id + warehouse_id），其公式 `safety_stock` / `target_stock` / `net_demand` / `suggest_qty` / `latest_order_date` / `replenishment_urgency` 不得被 P7 重写；v6 仅写「P1 行动字段放入 assigned_warehouse_detail[]」却未规定来源，存在 Migration F 重算风险。→ 属实。v7：§7.4/§7.5 固定 Migration F 对每个可见仓库调用 `get_replenishment_suggestions`（`p_variant_id`+`p_warehouse_id` 指定、`p_include_zero:=true`、其余 NULL、`p_page:=1`、`p_page_size:=1`），从 `data[0]` 映射 `safety_stock` / `target_stock` / `net_demand` / `suggest_qty` / `est_stockout_date` / `effective_inbound` / `latest_order_date` / `urgency→replenishment_urgency`；**Migration F 不得复制 P1 行动层公式、不得写 `round(ds*lead*buffer)` / `round(ds*lead*cover)` / `greatest(0, target_stock - ...)`**；P7 自身 `stockout_urgency` 仍由 `forecast_stockout` 推导、与 `replenishment_urgency` 分离；P1 RPC 缺失对应行时返回受控错误、Server Action 转友好中文、不暴露 SQL。
- **三（Migration 依赖修正）**：v6 §7.5 写 Migration F「依赖 `forecast_stockout`（同 Migration C）」，但 F 现须调用 `get_replenishment_suggestions`（由 P1 **Migration D/00044** 创建，非 C）；若仅依赖 C 则 F 实施时该 RPC 不存在。→ 属依赖缺口。v7：Migration E 依赖 P1 Migration C/00043（生成列表预测字段）；Migration F 依赖 P1 Migration C/00043 + P1 Migration D/00044（调用 `get_replenishment_suggestions` 复用行动层）；整体顺序 **P1 A→B→C→D → P7 E→F**、回滚 **F→E** 不变；不复制行动公式。
- **四（顶层禁止无仓库归属行动字段 + 类型契约）**：P1 v8 建议粒度为 variant_id + warehouse_id，同一 variant 的多仓建议不可合并为顶层单一值。v7：§7.1 补 `interface ProductOverviewRepository`（两方法均带 `userId` 第一参数）；`ProductVariantDetail` 的行动字段（`safetyStock` / `targetStock` / `netDemand` / `suggestQty` / `latestOrderDate` / `replenishmentUrgency`）**只存在于 `assignedWarehouseDetail[]`**，顶层 `ProductVariantDetail` **禁止** `netDemand` / `suggestQty` / `latestOrderDate` / `replenishmentUrgency`；§7.4/§11.5 二同步。活动正文 `顶层禁止` 条款保留，且不再于顶层 schema 出现无归属 `suggest_qty` / `replenishment_urgency`（grep 复检见输出摘要）。

### 11.6 v8 事实修正取证（Codex 最终复审：auth 返回对象形状，逐条核实）

> 本附录逐条核实 §0.6 的 1 类事实修正。取证以真实代码为准；巴蒂对本仓库有只读核查权，实现代码仍由 Claude 落盘。

- **一（auth 返回对象形状）**：`src/lib/auth.ts:131-134`

  ```typescript
  export async function requireActiveAuth(): Promise<CurrentActiveUser> {
    const user = await getCurrentActiveUser();
    if (!user) throw new Error('未登录或账户已停用');
    return user;
  }
  ```

  返回类型为 `CurrentActiveUser`，字段为 `id` / `email` / `displayName` / `roleName` / `isActive`（`src/lib/auth.ts:118-125`），**不含 `user` 属性**。因此正确用法是 `const user = await requireActiveAuth();` 后取 `user.id`；若对 `requireActiveAuth()` 返回值再链式取 `user` 子属性，会访问不存在的属性、运行时得 `undefined`，与后续 `p_user_id = auth.uid()` 校验冲突。v7 §7.1（接口说明）与 §7.3（列表 Repository 契约）曾误写为对返回对象再取 `user` 子属性的 id。→ 属实。v8：§7.1 / §7.3 / §7.4 统一改为 `const user = await requireActiveAuth();` 后取 `user.id`；§7.2 两条调用链、#59、§11.5 一 与 footer 一并核对；活动正文经 grep 复检不含「对 `requireActiveAuth()` 返回值再链式取 `user`」及 `user`·`activeUser` 双层取 id 的错误写法（见输出摘要）。**本轮仅修正 auth 形状，未改任何架构 / RPC / Migration / 公式 / 验收数量（保持 61 条）。**

---

> **文档版本**：v8 ｜ 末次修订：2026-07-12（Codex 最终复审：v7 架构结论全部通过；仅修正 auth 返回对象形状——`requireActiveAuth()` 直接返回 `CurrentActiveUser`，须先 `const user = await requireActiveAuth();` 再取 `user.id`；不改架构 / RPC / Migration / 公式 / 验收数量，验收保持 61 条）｜ 历史：v6 八类收口定稿 → v7 Repository 服务端 userId 传递 + P7 详情行动层复用 P1 v8 `get_replenishment_suggestions` → v8 auth 形状事实修正。｜ 协作分工：本文件属「方案/设计层」产出，交付 Codex 评审、Claude 落盘实现，巴蒂不直接修改 overseas-inventory 实现代码。｜ 纪律：仅修改本方案文档；不修改源码 / Migration / 数据库 / 测试 / 其他方案。
