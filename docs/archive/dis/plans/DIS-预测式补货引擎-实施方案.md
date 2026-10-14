> 历史归档（2026-10-13）：原位置 `docs/design/dis-plans/DIS-预测式补货引擎-实施方案.md`。保留用于旧实现与验收追溯，不作为当前任务或执行授权；现役入口见 [归档索引](../README.md)。

# DIS 预测式补货引擎 — 实施方案（v8）

> 状态：v1 初稿 2026-07-09 巴蒂 → 2026-07-10 Rall 确认参数 → v2 2026-07-12 Codex 架构复审（删 planned_shipments / 补 ETA 明细 / 去循环依赖 / 25 项测试）→ v3 2026-07-12 Codex 实施阻塞复审（修 8 项真实实现冲突）→ v4 2026-07-12 Codex 终审复审（修 4 项文档/算法：残留待入账口径、ETA=断货日边界、lead NULL 输出契约、shipment_no 唯一性）→ **v5 2026-07-12 Codex 终终审复审（修 3 项实施级：shipment_no 改用 ASCII 规则、主 RPC inbound 缺 bigseller_absorbed_at 过滤、残留 operator 可取消语义）→ v6 2026-07-12 Codex 六终终审复审（修 4 项实施级：ETA 事件模拟同 ETA 重复扣减、shipment_no country 未规范化、向 CreateShipmentData 误传 status、operator RLS 测试边界）→ v7 2026-07-12 Rall 独立复核实际落盘文件（8 项实施级修订：Migration 编号与依赖顺序 / safety_stock 赋值 / shipment_no 重试错误元数据 / 取消唯一写入路径 / 读取架构链路 / inventory 驱动表语义 / 测试数量 57 / 旧引用同步）→ **v8 2026-07-12 Codex 复审收口（修 3 项：ShipmentError 真实位置纠正 repository.ts、PostgreSQL 约束名确定性提取与重试边界、V1 不新增 shipment_no 字符集 CHECK）。本轮仅改方案文档，未动源码/Migration/数据库/测试，待 Codex / Rall 终审通过后进入 Migration 设计 + Claude 实施。**
> 定位：从「断货告警」升级到「净需求补货建议」——回答运营两个问题：**该不该补？补多少？**
> 落地方式：参照现有 RPC / RLS 范式（shipment / get_in_transit_confirmed_aggregate / get_overseas_inventory），由 Claude 落 DIS 代码。

---

## 0. 本轮修改原因（累计修订 v1 → v7）

v2 经 Codex 实施阻塞复审，提出 8 项真实实现冲突。巴蒂**逐条取证仓库真实代码**（`repository.ts:522-551`/`584-597`、`00018`、`00020`、`00026`、`00027` 等）后，确认核心冲突属实，本节为本轮修订驱动因素；逐条取证结论见 [§12 取证附录]。**v3 目标：修完 8 项后即可进入 Migration 设计 + Claude 实施。**

| # | Codex 阻塞项 | v3 处理 | 取证结论 |
|---|-------------|---------|----------|
| 一 | operator 创建计划发货与现有 admin-only RPC 冲突 | **默认方案 B（V1 仅 admin 创建/取消，复用现有 `createShipment`/`create_shipment_transactional`，零新增 RPC）；方案 A（新增 `create_planned_shipment` 允许 operator）作为[待 Rall 确认]备选**。明确内部 `shipment_no` 生成规则 | 属实：`repository.ts:522-551`→`create_shipment_transactional`；`00020:46-50` 仅 admin；`:52-55` 强制 `shipment_no`；`shipment_no` 列 NOT NULL+UNIQUE（00018）；无现成生成函数 |
| 二 | `cancelPlannedShipment` 无真实写入路径（`repository.update` 不写 `cancelled_at`） | **新增 `shipmentRepository.cancelPlannedShipment()`（或 `cancel_planned_shipment` RPC），仅 `UPDATE cancelled_at`，强约束 `booking`+`cancelled_at IS NULL`** | 属实：`repository.ts:584-597` 的 `update()` 仅更新 10 字段，不含 `cancelled_at` |
| 三 | `net_demand` 仍把晚于断货日到来的在途计入 → 矛盾 | **改为先事件模拟定 `est_stockout_date`，再 `effective_inbound = Σ remaining WHERE eta ≤ est_stockout_date`；`net_demand`/`suggest_qty`/`est_stockout_date` 使用同一有效集合，单向无循环** | 属实：v2 §4.3 `effective_inbound=全部 ETA 非 NULL 的 remaining 总和` 与验收"晚到不抵扣"矛盾 |
| 四 | "待入账补给"口径未在查询/输出落地 | **采用方案 A（V1 只计算未入仓 `remaining`，删除 `confirmed_inbound`/待入账补给口径；已 warehoused 一律不计入）** | 吸收：V1 收敛范围，避免与 `inventory.quantity` 重复计入 |
| 五 | RPC 缺 `p_variant_id`，但产品详情页调用了 | **§6.2 输入补 `p_variant_id uuid DEFAULT NULL`；§7.2 调用合法** | 属实：v2 §6.2 无该参数、§7.2 已调用 |
| 六 | operator 权限未最终确认 | **§11 改为决策项提请 Rall 拍板，不再"假定开放"；默认方案 B** | 属流程约束：Rall 要求权限变更须显式确认 |
| 七 | `updateWarehouseParams` 归 `shipmentRepository` 错 | **改 `warehouseRepository.updateReplenishmentParams()`，`requireActiveAdmin`+Zod+active 校验+read-back** | 属实：v2 §4.5 误写 `shipmentRepository` |
| 八 | Migration 后代码同步范围缺失 | **§8.5 明确须同步的文件清单（types/schema/repository/actions + 新增 warehouse Repository）** | 吸收：否则 TS 类型与 Repository 不一致 |

**v3 → v4（Codex 终审复审，4 项文档/算法修正，全部取证属实）**：

| # | Codex 终审问题 | v4 处理 | 取证结论 |
|---|---------------|---------|----------|
| 一 | "待入账补给" / `confirmed_inbound` / `warehoused_quantity` 旧描述残留（§4.2 / §4.4 / §6.1） | **全文删除旧口径**：`get_in_transit_detail` 不再返回 `warehoused_quantity`；统一 `effective_inbound` = 未入仓 `remaining`（`status IN (booking,loading,departed,arrived,customs)` 且 `cancelled_at IS NULL` 且 `eta IS NOT NULL` 且 `remaining > 0`）；`warehoused` 一律不计入；无 `confirmed_inbound` | 属实：§4.2 L103、§4.4 L203、§6.1 L342-344 仍含旧语义 |
| 二 | ETA = 断货日当天，`cur <= consume` 提前判断货导致当天补给未计入 | **改 `IF cur < consume`**：`cur == consume` 时先扣消耗再补入，ETA 当天计入抵扣（与 §9.1.1 #33 一致） | 属实：§4.3 L148 边界条件错误 |
| 三 | `lead_time_days` 为 NULL / <= 0 时先算 `target_stock/net_demand` → NULL 传播，与 integer 输出契约冲突 | **提前处理**：`lead IS NULL OR lead <= 0` → `target_stock=NULL`、`net_demand=0`、`suggest_qty=0`、`latest_order_date=NULL`、`urgency='data_incomplete'`；`est_stockout_date` 在 `daily_sales` 有效时仍可算 | 属实：§4.3 L168-173 先算后判顺序错误 |
| 四 | 内部 `shipment_no`（`PLN-...-{seq6}`）无冲突处理，非绝对无碰撞 | **明确唯一性保证（方案 C）**：Server Action 生成后经唯一约束兜底，冲突自动重试最多 3 次，失败返回中文错误；禁止前端传入；补充并发创建 + 唯一约束冲突测试 | 属实：§7.3 L421 仅写随机 seq6，无重试/兜底 |

**v4 → v5（Codex 终终审复审，3 项实施级修正，全部取证属实）**：

| # | Codex 终终审问题 | v5 处理 | 取证结论 |
|---|-----------------|---------|----------|
| 一 | `shipment_no` 仍引用不存在的 `warehouse_code`（`warehouse` 表仅 `id/name/country`，无 code 字段；中文仓库名也不符合 `shipment_no` 字符约定） | **改 ASCII 规则 `PLN-{country}-{warehouse_id 前 8 位}-{YYYYMMDD}-{seq6}`**（示例 `PLN-TH-a1b2c3d4-20260712-X8K2P9`，总长 31 ≤ 50）；不新增 `warehouse_code`、不使用中文、仅 `[A-Za-z0-9_-]`；Server Action 生成 + 唯一约束兜底 + 冲突重试 ≤3 次 + 中文错误；禁止前端传入；补长度/字符集/并发/唯一冲突测试 | 属实：`warehouse` 表（00001:98-108）无 `warehouse_code`；`shipment_no`（00018）仅 NOT NULL+UNIQUE，**无字符集 CHECK**（charset 由服务端生成规则保证，V1 不新增字符集 CHECK） |
| 二 | 主 RPC 的 inbound CTE 缺 `bigseller_absorbed_at IS NULL`，与 §4.2/§4.7/§6.1 声明不一致（异常数据可能重复计入） | **全处统一加 `AND s.bigseller_absorbed_at IS NULL`**：§4.3 inbound CTE、§6.2 内部 CTE（按 §4.3 条件）、§4.2/§4.7/§6.1 口径、§9.1.1 新增 4 条排除测试 | 属实：§4.3 L145-148 仅 `status IN (...)` 排除 `warehoused`，未显式排除「非 warehoused 但 `bigseller_absorbed_at IS NOT NULL`」的异常数据 |
| 三 | V1 默认 admin-only，但 §4.4 仍写"operator 仅可取消其授权仓库 booking" | **统一 V1 admin-only 权限文字**：operator 不能创建/取消计划发货，仅查询已授权仓库；删除所有"operator 可取消"描述；方案 A（operator 路径）封为[待 Rall 确认]后续增强（新增 RPC + RLS + 跨仓 + 审计测试，未确认不实现） | 属实：§4.4 L218 残留 operator 可取消语义，与默认方案 B 矛盾 |

**v5 → v6（Codex 六终终审复审，4 项实施级修正，全部取证属实）**：

| # | Codex 六终终审问题 | v6 处理 | 取证结论 |
|---|-------------------|---------|----------|
| 一 | §4.3 事件模拟按 shipment 逐条循环，`days := eta - today; consume := ds * days` 对同 ETA 多 shipment 重复扣减同一段日期销量 | **改为先按 `estimated_arrival` 分组**（inbound CTE `GROUP BY eta` + `SUM(remaining)`），再按分组事件升序走游标 `cursor_date` 只扣减一次日期差；同 ETA 的 remaining 先聚合只补一次 | 属实：§4.3 L147-158 inbound 返回逐 shipment 行（含 `s.id`），L160-178 `FOR EACH (eta, rem)` 对每行重算 `days`、重扣 `ds*days`，同 ETA 必然重复扣减 |
| 二 | `warehouse.country` 为 `text NOT NULL` 无国家代码 CHECK，`shipment_no` 直接嵌 `country` 不保证 ASCII | **服务端 `upper(trim(warehouse.country))`，仅允许 TH/ID/MY/PH/VN/CN，非法/空返回中文错误；单号用规范化国家码**（`PLN-{country}-{warehouse_id前8位}-{YYYYMMDD}-{seq6}`，`country` 取规范化码，总长 ≤ 50，仅 `[A-Za-z0-9_-]`） | 属实：`warehouse` 表（00001:101）`country text NOT NULL` 无 CHECK；`shipment.country`（00001:138）才有 6 码 CHECK，故未规范化会令 `create_shipment_transactional` 插入 `shipment.country` 触发 CHECK 失败；`product_variant.country`（00001:89）也有 6 码 CHECK |
| 三 | §7.3 向 `shipmentRepository.create()` 传 `status:'booking'`，但真实 `CreateShipmentData` 无 status 字段、`create_shipment_transactional` 也无 status 参数 | **不向 `CreateShipmentData` / RPC 传 status**，依赖 DB 默认 `status='booking'`（`shipment.status` 00001:140 `DEFAULT 'booking'`），创建后 read-back 校验 `status='booking'` | 属实：`CreateShipmentData`（`types.ts:102-114`）无 status 字段；`create_shipment_transactional`（00020:23-35）11 参数无 status，INSERT（00020:69-77）未写 status，靠列默认；`shipment.status` 默认 `'booking'`（00001:140） |
| 四 | §9.1 #19「operator 写入未授权仓库计划被 RLS 拒绝」与真实 RLS 不符，且会误导未来改动 | **删除该绝对表述**，改为「operator 调用现有 `create_shipment_transactional` / `createPlannedShipment` / `cancelPlannedShipment` 因 admin-only 被拒」；既有 operator shipment RLS 宽权限记录为历史技术债，本轮不改既有 RLS | 属实：`operator_insert_shipment`（`00001:386-388`）仅 `WITH CHECK (get_user_role()='operator')`，无 warehouse assignment 过滤；`operator_update_shipment`（00001:390-393）同 |

**v6 六终终审补充修订（Rall 独立复核实际落盘文件，2 项实施级修正，全部取证属实）**：

| # | Rall 复核问题 | 处理 | 取证结论 |
|---|-------------|------|----------|
| 一 | §4.3 `effective_inbound := SUM(total_remaining) FROM events WHERE eta <= est_stockout_date` 对空集合返回 NULL，经 `net_demand` 传播为 NULL，违反 integer 输出契约 | **改为 `COALESCE(SUM(total_remaining) FILTER (WHERE eta <= est_stockout_date), 0)::integer`**，覆盖 7 类空/零场景（无在途 / 全晚到 / 全取消 / 全吸收 / remaining<=0 / 全 warehoused / ETA 全 NULL）恒为 0 非 NULL；§6.2 返回类型列、§4.3 内部说明、§9.1.2 新增 #53–55 同步 | 属实：L196-199 原写为裸 `SUM(...)` 无 COALESCE；PostgreSQL 对空集合 `SUM` 返回 NULL，与 L210 `greatest(0, target_stock - (on_hand + effective_inbound))` 共现即 NULL 传播 |
| 二 | v6 文档版本号未完全同步（标题 / §0 累计 / §11 第 5 项 / §8.5 / 总纲交付物仍写 v5），"完全同步"结论不准确 | **全量同步为 v6**：标题→（v6）、§0 累计→v1→v6、§11 第 5 项→v6 已定、§8.5/§7.5 测试覆盖补全至 §9.1.2 #44–52 + 本轮 #53–55（共 51 条）、总纲 P1 交付物（v5）→（v6）；历史取证附录中 P0 v5 / v5→v6 修订过程文字保留 | 属实：Rall 独立核对实际落盘文件，标题 L1 为（v5）、§0 累计 L9 为 v1→v5、§11 L613 为 v5 已定、§8.5 L505 仅引 14 条、总纲 L67 交付物（v5）；巴蒂前轮"完全同步"摘要与实际不符，已纠正 |

**v6 → v7（Rall 独立复核实际落盘文件，8 项实施级修订，全部取证属实）**：

| # | Rall 复核问题 | v7 处理 | 取证结论 |
|---|-------------|---------|----------|
| 一 | Migration 使用 `0003x` 占位且依赖顺序错误，Phase 1 遗漏 `forecast_stockout` Migration；原结构 C=两读取 RPC、D=共享函数，reading RPC 依赖共享函数却先建（倒序） | **固定 A→B→C→D（推荐 00041–00044）**：A=`00041_replenishment_warehouse_params.sql`（warehouse 3 列）、B=`00042_replenishment_cancellation.sql`（shipment.cancelled_at）、C=`00043_forecast_stockout.sql`（共享函数）、D=`00044_replenishment_rpcs.sql`（两读取 RPC）；执行顺序固定 **A→B→C→D**、回滚 **D→C→B→A**（`get_replenishment_suggestions` 依赖 warehouse 新列 + shipment.cancelled_at + forecast_stockout，必须最后建）；Phase 1 必须含四份，不得遗漏共享函数 | 属实：原 §5.4 C/D 倒序、`0003x_*.sql` 占位；Phase 1 原仅"A/B/C（warehouse 3 列 + shipment.cancelled_at + 两 RPC）"，遗漏共享函数 Migration |
| 二 | `safety_stock` 在输出（§6.2）与测试（#5）中存在，但 §4.3 算法只读取 `buffer_ratio`、未给 `safety_stock` 赋值 | **§4.3 补 `safety_stock` 赋值**：`ds`/`lead` 有效时 `safety_stock := round(ds * lead * buffer)::integer`；`ds` 或 `lead` 无效时 `safety_stock := NULL`；`target_stock` 不重复叠加 `safety_stock`（避免 buffer 与 cover 重复计入） | 属实：§4.3 L160-234 全程无 `safety_stock` 赋值语句，而 §6.2 L430 输出含 `safety_stock`、§9.1 #5 用之 |
| 三 | `shipment_no` 冲突重试无法实施：现有 `shipmentRepository.create()` 遇 DB 错误统一抛 `ShipmentError('创建在途记录失败，请稍后重试','DB_ERROR')`，原始 PostgreSQL `error.code` 被丢弃，无法判断是不是 `23505` | **扩展 `ShipmentError` 可选 meta（`dbCode`/`constraint`/`dbMessage`）**，`repository.create()` 保留 `error.code`/`message`/`details`/可识别 `constraint`；`createPlannedShipment` 仅当 `dbCode === '23505' && constraint === 'shipment_no_unique'` 重试，其他错误（权限/FK/CHECK/网络/tracking_event 写入）均不重试；每次重试重新生成 `seq6`，最多 3 次 | 属实：`repository.ts:522-551` 的 `create()` 调 `create_shipment_transactional` 后仅抛 `ShipmentError(...,'DB_ERROR')`，未透传 PG 错误码 |
| 四 | `cancelPlannedShipment` 同时保留 Repository / RPC 二选一，与 V1「零新增写 RPC」冲突 | **固定 V1 走 `shipmentRepository.cancelPlannedShipment(shipmentId)`（不接收 userId），不新增 `cancel_planned_shipment` RPC**；UPDATE 仅 `SET cancelled_at = now()`，强约束 `status='booking' AND cancelled_at IS NULL`；权限身份来自当前用户 session，并发重复取消仅一个成功 | 属实：§7.4 L519 仍写「（或专用 RPC `cancel_planned_shipment`）」二选一 |
| 五 | 页面读取链路误写成必须经过 Server Action | **改正为现有架构**：读取 = Server Component→Repository→Supabase RPC→PostgreSQL RLS；写入 = Client Component/表单→Server Action→Repository→Supabase→PostgreSQL RLS；`/dashboard/replenishment/page.tsx` 直接调 Repository 读取，常规 Server Component 读取不强制过 Server Action | 属实：§4.8 L299「所有读写经 Server Action + Repository」、§7.1 L489「经 Server Action / Repository」与现有范式不符 |
| 六 | 无 `inventory` 行的 variant 没有 warehouse 归属，不能凭空生成补货建议（自动生成会致 variant×warehouse 笛卡尔积与虚假建议） | **固定 `inventory` 为驱动表**：仅为已存在 `(variant_id, warehouse_id)` inventory 行的组合计算；无 inventory 行的 variant 不生成合成 warehouse 建议、不参与补货列表；inventory 行存在但 `quantity=0` 仍 `on_hand=0` 正常计算 | 属实：§4.3 L153 `COALESCE(inventory.quantity, 0)` 暗示无库存行也 on_hand=0 计算，会触发笛卡尔积 |
| 七 | 测试条目实际为 57 条，不是 51 条 | **全文「51 条」改为「57 条」**（#1–25=25 + #26–43=18 主编号 + #28a/#28b=2 + #44–55=12 = 57）；不删测试凑数；v7 新增 #56–67 后合计 69 条 | 属实：Phase 1 / §8.5 误写 51 条 |
| 八 | P0/P7/warehoused 旧描述未完全同步 | **活动正文统一**：`P0 v5`→`P0 v8`、「作战室 P2」→「P7-B 作战室增强层」、`get_war_room_overview`→`get_product_overview`、当前列表 RPC `get_product_overview`、当前详情 RPC `get_war_room_variant_detail`、当前路由 `/dashboard/products/overview`；§4.7 残留旧过滤语句改为现行 `status IN ('booking','loading','departed','arrived','customs')` 且 `bigseller_absorbed_at IS NULL` | 属实：L62/L141/L257/L340/L650 仍写 P0 v5、L62 仍写「作战室 P2」「get_war_room_overview」、L287 残留旧过滤 |

**v7 → v8（Codex 复审收口，仅改文档 3 项，全部取证属实）**：

| # | Codex 收口问题 | v8 处理 | 取证结论 |
|---|--------------|---------|----------|
| 一 | §8.5 误写 `ShipmentError` 在 `types.ts` 扩展，而真实定义/导出在 `repository.ts:28-36`，会误导 Claude 在错误文件重复定义/移动，产生循环依赖 | **`ShipmentError` 与 `ShipmentDbErrorMeta` 均保留在 `src/features/shipments/repository.ts`**；`types.ts` 仅同步 `Shipment`/`cancelledAt`/`CancelPlannedShipmentResult` 等业务类型；不重复创建第二个 `ShipmentError`；现有两参数 `new ShipmentError(msg, code)` 调用继续兼容；第三参数 `meta` 仅供服务端 Repository/Server Action 内部判断 `23505` + `shipment_no_unique`，不返回页面 | 属实：`repository.ts:28-36` 当前 `export class ShipmentError extends Error {...}` 为两参数构造、无第三参数；`types.ts` 无 `ShipmentError` 定义 |
| 二 | 约束名不能假定来自运行时错误对象的结构化 `constraint` 字段（Supabase/PostgREST 错误对象通常无稳定约束名字段）；原 §7.3/§8.5 仅写"透传可识别约束名"，Claude 实施后可能拿不到约束名导致重试永不触发 | **确定性约束识别规则**：`create()` 保留 `error.code`/`message`/`details`/`hint`；`constraint` 先取运行时结构化约束名（若有），否则仅从 `error.message` 精确匹配 PostgreSQL 标准文本 `duplicate key value violates unique constraint "shipment_no_unique"` 提取 `shipment_no_unique`；禁用宽松"含 duplicate/unique 即重试"；仅 `dbCode==='23505' && constraint==='shipment_no_unique'` 重试；其余（23505 但约束名非 shipment_no_unique / 无法确认 / FK / CHECK / 权限 / 网络 / tracking_event / shipment_item / P0001 / 不可解析）一律不重试；总调用 `repository.create()` 最多 3 次、每次重生成 `seq6`；三次均冲突仅返回"生成计划单号失败，请重试"，不暴露 PG 原文 | 属实：真实约束名 `shipment_no_unique` 在 `supabase/migrations/00018_add_shipment_no.sql:45` `ADD CONSTRAINT shipment_no_unique UNIQUE (shipment_no)`；`create()` 抛 `ShipmentError('创建在途记录失败，请稍后重试','DB_ERROR')` 未透传 PG 错误码 |
| 三 | §7.3 残留"字符集 CHECK 留待 Migration 补"类开放措辞，使 V1 Migration 范围不确定 | **V1 不新增 `shipment_no` 字符集 CHECK**：字符集与长度由 Server Action 内部生成器保证；DB 继续沿用现有 `NOT NULL + shipment_no_unique`；字符集 CHECK 如未来确有需要，单独立项，不属于 00041–00044；删除所有字符集 CHECK 类的开放措辞；不增加第五份 P1 Migration | 属实：L543 原写"字符集 CHECK 留待 Migration 补"类开放措辞，§0 v5→v6 取证行亦含同款开放措辞；`shipment_no`（00018）仅 `NOT NULL+UNIQUE`、无字符集 CHECK |

**本轮不变的核心前提**（Rall 已拍板，见 §3）：`buffer_ratio=0.25`、`target_cover_multiplier=1.5`、V1 单值 `daily_sales`、V2 仅数据驱动后启用。
**本轮不变的实施纪律**：仅改方案文档；不修改源码 / Migration / 数据库 / 测试；v7 八项实施级修订已落盘，待 Codex / Rall 复核通过后，再交 Claude 进入 Migration 设计 + 实施。

**v6 → 同步修订（作战室 v3 终审要求，仅改算法落地位置，不改算法语义）**：

为消除「作战室与补货引擎各维护一套算法」的风险，将 §4.3 的核心事件模拟**抽取为统一的数据库内部函数 `forecast_stockout(p_on_hand, p_daily_sales, p_lead_time_days, p_inbound jsonb)`**（Migration C `CREATE FUNCTION`，见 §5.4）。本方案 `get_replenishment_suggestions`（§6.2）与 P7-B 作战室增强层 `get_product_overview` / `get_war_room_variant_detail`（路由 `/dashboard/products/overview`）**都调用同一函数**，禁止 TypeScript 域函数与 SQL 内联各一套、禁止「等价 SQL」未决表述。算法语义（remaining / status / cancelled_at / bigseller_absorbed_at / eta 非空 / GROUP BY+SUM / cursor_date / ETA 当天 cur==consume / 过期 today / 晚到不抵扣 / lead 真实列 NULL→data_incomplete / effective_inbound COALESCE）与 v6 §4.3 **完全一致**，仅落地位置从「RPC 内联 CTE」改为「共享 DB 函数」。总纲与作战室方案已同步（见各方案 v3/v4 修订）。本同步修订未改变 v6 任何算法边界或输出契约，故该次同步修订未升版本号（记为 v6）；现行版本已升至 v7（见本节 v6→v7）。

---

## 1. 目标

现有「关注产品动态」做**断货预警**（est_days < lead_time 或 quantity < safety_stock）。补货引擎做**行动层**：基于销售速度 + 补货周期 + 已承诺补给，算出**每个 variant（某仓某货）的建议补货量 + 最晚下单日**。运营看到的是"该补 320 件，最晚 7 月 15 日下单"，而非"快没了"。

---

## 2. 已确认前提（2026-07-08 与 Rall 钉死，非假设）

| 前提 | 结论 | 来源 |
|------|------|------|
| 业务模式 | **现货直发，非定做** | Rall 确认 |
| 补货周期 | `lead_time_days`（物流 + 2 天缓冲）即真实有效补货周期，无需叠加生产天数 | Rall 确认；字段 `warehouse.lead_time_days` 已存在于 00014 |
| 销售速度数据 | `inventory.daily_sales` 为**覆盖写**（每次 BigSeller 同步覆盖），**无历史序列**，可 NULL | 已查 00014_dynamic_alert_fields.sql 确认 `daily_sales NUMERIC NULL` |
| 安全库存口径 | `SS = 日均销量 × lead_time × buffer_ratio` | Rall 确认（buffer_ratio 已拍板 0.25） |
| 已承诺补给 | **在途 + 计划发货统一计入**，计划发货 = 运营手动录入的"确定要发"的货（复用 `shipment` 的 `booking` 状态），按 ETA 感知抵扣 | Rall 提议 + 确认；v2 落点为复用 shipment |
| 砍掉的部分 | 供应商 MOQ / 箱规 / 运费计算 | Rall 确认 |
| v1 / v2 边界 | v1 用单值 `daily_sales`；`variant_daily_snapshot` **不在 V1 建表**（见 §5.3 延期理由） | Rall 确认；v2 是否启用取决于 90 天订单数据 |

---

## 3. 已确认参数（Rall 2026-07-10 拍板，默认值生效）

| 参数 | 确认默认值 | 落点 | 是否按仓库可调 |
|------|-----------|------|----------------|
| `buffer_ratio` | **0.25** | `warehouse.buffer_ratio`（缺省 0.25） | 是，admin 可改 |
| `target_cover_multiplier` | **1.5** | `warehouse.target_cover_multiplier`（缺省 1.5） | 是，admin 可改 |

### 3.1 V1 / V2 决策路径（数据驱动，待 90 天订单数据）

**当前默认落地 V1**：单值 `daily_sales` 驱动净需求（§4.3 算法即 v1 形态）。`variant_daily_snapshot` **不在 V1 建表**（见 §5.3）。

**90 天订单数据到位后**，巴蒂先做一轮分析（CV > 0.5 / 显著周季节性 / 显著趋势 → 进 V2），再决定重构 §4.3 为「移动平均 / 季节性 / 趋势外推」。分析与重构是拿到数据后的独立动作，不在本次落地范围。

---

## 4. 核心架构决策（回应 Codex 12 项）

### 4.1 事实来源：复用 `shipment` + `shipment_item`（方案 A，删除 `planned_shipments`）

**决策：不新增 `planned_shipments` 表。** 计划发货与在途统一以 `shipment` 为事实来源：

- **`booking` 状态 = 已确定但尚未发出的计划发货**（含运营手动录入的"确定要发"的货）。
- **`loading` / `departed` / `arrived` / `customs` = 运输中的补给**（继续计入在途）。
- **`warehoused` 或 `bigseller_absorbed_at IS NOT NULL` = 已被 BigSeller 吸收**，停止计入在途（与现有 `get_in_transit_confirmed_aggregate` 口径一致）。
- **不新增状态**：现有 `booking` 已精确表达"已确定未发"，无需新状态；如未来确需区分"内部计划"与"承运商订舱"，通过新增可空列或备注，不在 V1 引入。
- **不重复建表**：同一批货只存在于 `shipment` + `shipment_item`，杜绝"一套 shipment + 一套 planned_shipments 表示同一批货"的双重计数风险。

#### 4.1.1 计划发货创建入口与权限（Codex 一 / 六）

**取证结论**：现有 `shipmentRepository.create()`（`repository.ts:522-551`）调用 `create_shipment_transactional`；该 RPC（`00020:46-50`）**仅 admin 可调用**，且（`:52-55`）**强制 `shipment_no` 非空**；`shipment_no` 列（00018）为 **NOT NULL + UNIQUE**，无现成生成函数。因此 v2 写的"operator + admin 复用 `shipmentRepository.create`"在现有代码下**无法实现**（operator 会被 RPC 拒绝，且计划发货表单无 `shipment_no`）。

**v3 决策（[待 Rall 最终确认权限面]，默认方案 B）**：

- **默认方案 B（V1 采用，零新增 RPC、不碰现有 admin 规则）**：
  - V1 仅 **admin** 可创建 / 取消计划发货。
  - 新增 Server Action `createPlannedShipment`（admin-only），**复用现有 `shipmentRepository.create`（`create_shipment_transactional`）**，**依赖 DB 默认 `status='booking'`（不传 status，见 §7.3）+ 强制 ETA（见 §4.4）**。
  - **`shipment_no` 生成规则（必填，满足 NOT NULL+UNIQUE，仅 ASCII）**：由 Server Action 在调用前生成**唯一内部单号**，格式 `PLN-{country}-{warehouse_id 前 8 位}-{YYYYMMDD}-{seq6}`（`country` = **服务端规范化后的仓库所属国代码**，须 `upper(trim(warehouse.country))` 且 ∈ {TH,ID,MY,PH,VN,CN}，否则返回中文错误，如 `TH`；见 §7.3 规范化规则；`warehouse_id 前 8 位` = uuid 字符串前 8 个十六进制字符；`seq6` = 服务端随机或基于 `gen_random_uuid()` 派生的 6 位串）。示例：`PLN-TH-a1b2c3d4-20260712-X8K2P9`（总长 31，≤ 50）。**不新增 `warehouse_code` 字段、不使用中文仓库名、仅使用 `[A-Za-z0-9_-]`**。该单号仅内部标识，非真实运单号，禁止前端传入。
  - 现有 `createShipment`（Admin 专属建完整在途记录）**保持不变**，与计划发货录入互不干扰。
  - 不修改 `create_shipment_transactional` 的任何 admin / `shipment_no` 业务规则。

- **方案 A（若 Rall 确认开放 operator 自录，作为后续增强，本 v3 先备好设计不实现）**：
  - 新增专用 RPC `create_planned_shipment`：`SECURITY INVOKER` + `auth.uid()` 绑定；operator 仅可建 assigned 仓库、admin 任意 active 仓库；强制 `status='booking'` + ETA（此为新 RPC，可显式设置 status；**V1 复用现有 `create_shipment_transactional` 时不传 status，依赖 DB 默认，见 §7.3**）；RPC 内 `generate_shipment_no()` 生成内部单号（ country 须 `upper(trim)` 规范化，见 §7.3）；原子创建 `shipment`+`shipment_item`+初始 `booking` tracking_event；`p_items` 校验非空/variant_id/quantity/warehouse-country 一致性；`REVOKE PUBLIC,anon` + `GRANT authenticated`。
  - 启用方案 A 须同步：新增 RPC、RLS/权限测试、跨仓拒绝测试、operator 创建 booking 的审计字段与 read-back（见 §9.1 新增项）。
  - **未获 Rall 确认前，Claude 不得自行启用方案 A、不得修改 `create_shipment_transactional` 的 admin 规则。**

> 权限变更属业务规则调整，必须由 Rall 显式拍板；v3 默认方案 B 即可进入 Migration 设计，方案 A 为可选增强。

### 4.2 在途 ETA 计算链路：新增 `get_in_transit_detail`（方案 A）

`estimated_arrival`、`remaining_quantity`、`status` 实际已存在于 `shipment` / `shipment_item`（V1 仅消费这三个字段），但现有 `get_in_transit_confirmed_aggregate` 仅返回聚合 4 字段（warehouse_id / variant_id / in_transit_quantity / confirmed_quantity），不足以支撑"ETA ≤ 断货日才抵扣"。

**新增只读明细 RPC `get_in_transit_detail`（见 §6.1）**，返回逐 shipment 明细：

- `variant_id` / `warehouse_id` / `shipment_id` / `status` / `estimated_arrival` / `remaining_quantity` / `is_planned`（status='booking'）。**V1 不返回 `warehoused_quantity`**（该字段不参与补货计算，见 §4.7）。
- 口径：非 `warehoused` 且 `bigseller_absorbed_at IS NULL` 的 `remaining_quantity` 计入在途（`remaining = quantity - warehoused_quantity` 仅用于算出未入仓剩余，本身不作为补给输入）；已 `warehoused` 一律不计入（无论是否已吸收）。
- `estimated_arrival` 为 NULL：V1 **不计入 ETA 感知结果**（保守，见 §4.3 / §4.6）；但因计划发货创建时强制要求 ETA（§4.4），实际录入的计划发货均有 ETA。承运商外部轨迹（P0 喜运达 v8）不写 `estimated_arrival`、不建 `shipment_item` 数量映射，故**不进入本引擎计算**（与 P0 v8 一致）。

主 RPC `get_replenishment_suggestions`（§6.2）内部直接以同一口径的 CTE 计算（不依赖 `get_in_transit_confirmed_aggregate` 的粗聚合），保证 ETA 感知抵扣可落地。

### 4.3 计算模型：ETA 升序事件模拟算法（消除循环依赖 + 修晚到抵扣矛盾）

> **算法落地位置（v6 同步修订，作战室 v3 终审要求；v4 合并整合定调 P7-B）**：以下事件模拟即**统一数据库函数 `forecast_stockout(p_on_hand, p_daily_sales, p_lead_time_days, p_inbound jsonb)`** 的函数体（Migration C `CREATE FUNCTION`，见 §5.4）。调用方（本方案 `get_replenishment_suggestions` §6.2、P7-B 作战室增强层 `get_product_overview` / `get_war_room_variant_detail`）负责按 `warehouse_id` 权限收集 inbound（见 §4.1 口径）并组装 `p_inbound jsonb` 后调用；**函数只做模拟，不接触表、不做权限过滤**。本方案在取得 `est_stockout_date` + `effective_inbound` 后，再算行动层 `target_stock` / `net_demand` / `suggest_qty` / `latest_order_date` / `urgency`（见 §6.2 步骤 4）。P7-B（作战室增强层）只取 `est_stockout_date` + `effective_inbound` 用于断货投影。P1 与 P7-B **同一函数、同一算法语义**，禁止 TS 域函数与 SQL 各一套。

**删除 v1「先全量估算断货日，再反推有效补给」的循环写法**，并**修正 v2 `effective_inbound` 与 `est_stockout_date` 的矛盾**：v2 把"全部 ETA 非 NULL 的 remaining"计入 `effective_inbound`，导致晚于断货日到来的在途也被抵扣（如库存 0、日销 10、5 天断货、ETA 30 天 1000 件 → 建议变 0，实际无法救急）。改为**单向无循环**：先事件模拟定 `est_stockout_date`（晚到不救急），再筛"断货日前到达"的批次作为 `effective_inbound`。

```
  ── 驱动表（v7 六）：`inventory` 是补货建议的驱动表，本循环只遍历已存在
     (variant_id, warehouse_id) inventory 行的组合；无 inventory 行的 variant
     不进入本循环，也不生成合成 warehouse 建议（避免 variant×warehouse 笛卡尔积）──
对单个 (variant_id, warehouse_id)：
  on_hand   := COALESCE(inventory.quantity, 0)             -- inventory 行存在时取 quantity；quantity=0 即 on_hand=0
  ds        := inventory.daily_sales                       -- numeric，可 NULL
  lead      := warehouse.lead_time_days                    -- integer，可 NULL
  buffer    := COALESCE(warehouse.buffer_ratio, 0.25)
  cover     := COALESCE(warehouse.target_cover_multiplier, 1.5)

  ── 数据充分性（Codex 六 / v4 三）──
  IF ds IS NULL OR ds <= 0 THEN
      urgency := 'data_incomplete'        -- 不生成虚假断货日
      est_stockout_date := NULL           -- ds 无效则无法推算消耗
      safety_stock := NULL                -- ds 无效则安全库存无意义
      target_stock := NULL
      net_demand := 0; suggest_qty := 0
      latest_order_date := NULL
      RETURN
  END IF

  ── 收集候选 inbound（ETA 感知，先按 estimated_arrival 分组聚合）──
  ── 关键（v6 一修复）：同一 estimated_arrival 的多条 shipment 必须先
     SUM(remaining) 聚合为单条事件，再只扣减一次日期差，避免重复扣减 ──
  events := SELECT s.estimated_arrival                        AS eta,
                   SUM(si.quantity - si.warehoused_quantity)  AS total_remaining
            FROM shipment s JOIN shipment_item si ON si.shipment_id = s.id
            WHERE si.variant_id = :variant
              AND s.warehouse_id = :wh
              AND s.cancelled_at IS NULL
              AND s.bigseller_absorbed_at IS NULL          -- v5 二：已吸收（任意状态）一律不计入
              AND s.status IN ('booking','loading','departed','arrived','customs')
              AND (si.quantity - si.warehoused_quantity) > 0
              AND s.estimated_arrival IS NOT NULL         -- V1 排除 NULL ETA；warehoused 不在集合内
            GROUP BY s.estimated_arrival
            ORDER BY s.estimated_arrival ASC

  ── 事件模拟（第一步）：按 ETA 分组事件升序、用游标 cursor_date 推进，求 est_stockout_date，晚到不救急 ──
  cur    := on_hand
  today  := CURRENT_DATE
  cursor_date := today                          -- 游标：上一次事件发生日（初始为今天）
  stockout := NULL
  FOR EACH (eta, total_remaining) IN events:
      event_date := greatest(eta, today)        -- 过期 ETA 统一按今天处理，不重复扣减（v6 一）
      days := event_date - cursor_date          -- 距上一次事件的日期差；同 ETA 只算一次
      IF days > 0 THEN                          -- 距离为正：先扣该段消耗
          consume := ds * days
          IF cur < consume THEN
              stockout := cursor_date + ceil(cur / ds)   -- 到达前断货（晚到批次不补入）
              BREAK
          END IF
          cur := cur - consume                  -- cur == consume 时不 break，继续到货补入
      END IF
      cur := cur + total_remaining              -- 当天到货补入（同 ETA 已 SUM，只补一次）
      cursor_date := event_date                 -- 推进游标到本次事件日
  END LOOP
  IF stockout IS NULL THEN
      stockout := cursor_date + ceil(cur / ds)  -- 所有补给到位后仍正：用剩余推算
  END IF
  est_stockout_date := stockout

  ── effective_inbound（第二步）：仅计"断货日前到达"的分组事件（与模拟同集合，单向）──
  effective_inbound :=
    COALESCE(
      SUM(total_remaining) FILTER (WHERE eta <= est_stockout_date),
      0
    )::integer
  ── 说明：eta > est_stockout_date 的批次（晚到）不计入；空集合 / 全部晚到 / 全部取消·吸收·remaining<=0 / 全部 warehoused / ETA 全 NULL → SUM 对空集合返回 NULL，COALESCE(...,0) 保证恒为 0、不向 net_demand 传播 NULL（输出契约：effective_inbound 始终为 integer 非 NULL）──

  ── target_stock / net_demand（v4 三：lead 缺失提前处理，避免 NULL 传播）──
  IF lead IS NULL OR lead <= 0 THEN
      safety_stock := NULL                -- lead 无效则安全库存无法按周期推算
      target_stock := NULL
      net_demand := 0
      suggest_qty := 0
      latest_order_date := NULL
      urgency := 'data_incomplete'
  ELSE
      safety_stock := round(ds * lead * buffer)::integer   -- SS = ds × lead × buffer_ratio（安全阈值展示值）
      target_stock := round(ds * lead * cover)
      net_demand   := greatest(0, target_stock - (on_hand + effective_inbound))
      suggest_qty  := net_demand
      latest_order_date := est_stockout_date - lead
      urgency := CASE
          WHEN latest_order_date <= today            THEN 'critical'   -- 红
          WHEN latest_order_date <= today + 3        THEN 'warning'    -- 黄
          ELSE 'ok'                                                 -- 绿
      END
  END IF
```

**统一规则（写入契约）**：
- 日期差按游标推进：`days = event_date - cursor_date`，`event_date = greatest(eta, today)`；同 ETA 已聚合为一条事件，故同一天多 shipment 只扣减一次日期差（v6 一）；`eta=今天` → `event_date=today=cursor_date` → `days=0` → 当天即补入、无前置消耗。
- **同一 estimated_arrival 多条 shipment（v6 一）**：inbound CTE `GROUP BY eta` + `SUM(remaining)` 聚合为单条事件；`total_remaining` 先汇总再补入；事件模拟按事件升序、游标 `cursor_date` 只推进一次，杜绝重复扣减（示例：两 shipment 均 ETA 明天、库存 10、日销 10 → 合并后 `total_remaining` 只扣一次明天消耗，不误判断货）。
- **ETA = 断货日当天**（`cur == consume`）：不提前判断货，先扣消耗（库存恰好耗尽）再补入，当天补给计入 `effective_inbound`（与 §9.1.1 #33 一致）；仅 `eta` **严格晚于** `est_stockout_date` 的批次不计入。
- 已过期（eta < today）：`event_date = greatest(eta, today) = today`，`days = today - cursor_date`；若 cursor_date=today（首事件即过期）则 `days=0`，直接补入 `cur`、不重复扣减；计入 `effective_inbound`（因 eta ≤ est_stockout_date 通常成立），不报错、不崩溃（Codex 二/三 ETA 过期处理 + v6 一）。
- 晚到（eta > est_stockout_date）：**不计入 `effective_inbound`**，不抵扣（Codex 三）。
- **lead 缺失输出契约（v4 三）**：`lead IS NULL OR lead <= 0` → `target_stock=NULL`、`net_demand=0`、`suggest_qty=0`、`latest_order_date=NULL`、`urgency='data_incomplete'`；`est_stockout_date` 在 `daily_sales` 有效时仍按消耗推算（仅供展示），`daily_sales` 无效时亦为 NULL。
- 时区：`CURRENT_DATE` 取 Supabase 服务端时区（UTC）；所有 `estimated_arrival` / `planned_ship_date` 均为 `date` 类型，无时区歧义。
- 取整：`SS` / `target_stock` 用 `round()`；天数用 `ceil()`；`remaining` 为 `shipment_item` 整数差；`on_hand` 为整数；`ds` 为 numeric，模拟中 `cur` 以 numeric 累计，最终 `stockout` 经 `ceil` 得整数天。
- 字段类型/空语义：`safety_stock` `integer`（ds 或 lead 缺失时 NULL）、`est_stockout_date` `date`（可 NULL）、`target_stock` `integer`（lead 缺失 NULL）、`net_demand`/`suggest_qty` `integer`（lead 缺失 0）、`latest_order_date` `date`（可 NULL）、`urgency` `text`（lead 缺失 `'data_incomplete'`）。`safety_stock` 为安全阈值**展示值**，不计入 `target_stock`（避免 buffer 与 cover 重复计入；`target_stock` 仍仅按 `cover` 计算 `net_demand`）。
- `est_stockout_date`、`effective_inbound`、`net_demand`、`suggest_qty` 使用**同一套 inbound 数据**，单向（先模拟定断货日，再筛有效补给），**无循环依赖**。

### 4.4 计划发货生命周期（复用 booking + `cancelled_at`）

**计划发货 = `shipment(status='booking')`**，生命周期规则：

- **创建**：`createPlannedShipment` 强制要求 ETA（Codex 四）：
  - 若填 `expected_arrival_date` → 直接用；
  - 若只填 `planned_ship_date` → `estimated_arrival = planned_ship_date + warehouse.lead_time_days` 推算（`lead_time_days` 为 NULL 则拒绝保存）；
  - 两者均无法确定 → **拒绝保存**（Codex 四：禁止保存无确定 ETA 的计划）。
- **状态推进**：`booking → loading/departed/...`（复用现有 `change_shipment_status`，前进-only，受 P0 v8 §6.3 状态流约束）。
- **部分完成**：`shipment_item.warehoused_quantity` 跟踪，`remaining = quantity - warehoused_quantity`；已入仓部分由 BigSeller 同步覆盖 `inventory.quantity` 体现，**不计入本引擎补给**（无"待入账补给"口径，见 §4.7）。
- **取消**：新增 `shipment.cancelled_at timestamptz`（软删除，不触碰状态枚举，不与 P0 v8 状态流冲突）。`cancelPlannedShipment` Server Action 置 `cancelled_at = now()`；引擎排除 `cancelled_at IS NOT NULL`。**V1 仅 admin 可取消**（默认方案 B）；operator 不能创建或取消任何计划发货，仅能查询已授权仓库的建议结果（operator 取消为[待 Rall 确认]的方案 A 后续增强，见 §4.1.1 / §11）。
- **转正式 shipment**：状态从 `booking` 推进即可，无需新建行；同一 `shipment` 行即是计划也是正式记录，不重复。
- **仅 active 且 remaining > 0 的计划参与计算**：引擎过滤 `cancelled_at IS NULL` 且 `remaining > 0`（见 §4.3 inbound 条件）。

### 4.5 数据库兼容性

- **身份模型（Codex 五.1）**：项目既有的写入者引用统一为 `profiles(id)`（`shipment.created_by` 即 `REFERENCES profiles(id)`，见 00001）。v1 误写的 `planned_shipments.created_by REFERENCES auth.users(id)` 随表删除而消除；**今后任何新表若需 created_by，一律 `REFERENCES profiles(id)`**。RLS 同时校验 `auth.uid()` 与 `profiles.is_active`（`get_user_role()` 内部已 `AND p.is_active = true`）。
- **warehouse 参数（Codex 五.2）**：新增 3 列（完整约束见 §5.2 / Migration A）：
  - `buffer_ratio numeric NOT NULL DEFAULT 0.25 CHECK (buffer_ratio >= 0)`
  - `target_cover_multiplier numeric NOT NULL DEFAULT 1.5 CHECK (target_cover_multiplier > 0)`
  - `updated_at timestamptz NOT NULL DEFAULT now()` + 触发器
  - 已有 6 个仓库：`ADD COLUMN ... DEFAULT` 在同事务内回填默认值，无需单独 UPDATE。
  - 按仓库修改入口：**`warehouseRepository.updateReplenishmentParams()`**（非 `shipmentRepository`），由 Server Action `updateWarehouseParams` 调用，保护链：`requireActiveAdmin()` + Zod 校验 + `warehouse_id` 存在且 `is_active` + `buffer_ratio >= 0` + `target_cover_multiplier > 0`；写后 read-back 校验，失败返回中文错误；触发 `updated_at`。
- **variant_daily_snapshot（Codex 五.3）**：**V1 不建表**。理由：V1 用单值 `daily_sales`，快照当前不写入、不读、不参与任何 RPC；提前建空表会造成结构膨胀与技术债。待 90 天数据确认进 V2 后，再在 Phase 4 新建并接入采集（见 §8）。

### 4.6 daily_sales 与 lead_time 边界（Codex 六）

- V1 使用 `inventory.daily_sales`（当前快照，可 NULL）。
- `daily_sales IS NULL` → 结果显示"数据不足"，`urgency='data_incomplete'`，**不当作 0**。
- `daily_sales <= 0` → 不计算虚假断货日，`urgency='data_incomplete'`，`suggest_qty=0`。
- `lead_time_days IS NULL` 或非法（<=0）→ 不生成 `latest_order_date`，`urgency='data_incomplete'`（但 `est_stockout_date` 仍可按 `ds` 推算，仅供展示）。
- 严禁写死 12 天：一律用 `warehouse.lead_time_days`；无值则按上条处理。

### 4.7 在途 / 已确认到仓口径（Codex 七 / 四）

**v3 采用方案 A（V1 只计算未入仓 `remaining`，删除"待入账补给"口径与 `confirmed_inbound` 输出）**，以收敛 V1 范围、杜绝与 `inventory.quantity` 重复计入：

- **计入 `effective_inbound` 的仅是未入仓剩余**：`status IN (booking,loading,departed,arrived,customs)` 且 `bigseller_absorbed_at IS NULL` 的 `remaining = quantity - warehoused_quantity`（与 §4.3 inbound 集合一致）。
- **已 `warehoused` 的记录（无论是否已 BigSeller 吸收）一律不计入**本引擎补给——它们物理上已到仓，将由 BigSeller 同步覆盖写 `inventory.quantity` 后自然体现为 `on_hand`（与 §4.3 `status IN ('booking','loading','departed','arrived','customs')` 且 `bigseller_absorbed_at IS NULL` 的过滤完全一致）。

**统一口径（v7 八）**：任意 `status` 下只要 `bigseller_absorbed_at IS NOT NULL` 即不计入；`warehoused` 无论是否已吸收均不计入；不存在「仅 status=warehoused 且 absorbed 才排除」的旧语义。
- **删除原 v2「待入账补给 / `confirmed_inbound`」口径**：V1 不输出 `confirmed_inbound`，不在查询里区分 `customs`/`warehoused` 的 `warehoused_quantity`，避免与 `inventory.quantity` 重复计入（Codex 四方案 A）。
- **已吸收**（`status='warehoused' AND bigseller_absorbed_at IS NOT NULL`）→ 更不计入（已被 `inventory.quantity` 体现）。
- 若未来需"已到仓未吸收"的可见性（作战室叠加层），在 V2 独立设计 `confirmed_inbound`，不污染 V1 的 `effective_inbound` 公式。
- 口径与现有 `get_in_transit_confirmed_aggregate`（00027）的"未吸收即在途"原则一致，仅下推到逐 shipment 明细。

### 4.8 RPC 安全边界（Codex 八）

- `get_replenishment_suggestions` / `get_in_transit_detail` 均：**`SECURITY INVOKER` + `SET search_path = ''`**（对齐现有 `get_overseas_inventory` / `get_in_transit_confirmed_aggregate` 范式，非 `DEFINER`）。
- 强制 `auth.uid() IS NOT NULL`，且 `p_user_id` 必须 `= auth.uid()`（拒绝伪造）。
- 仓库隔离：`get_user_role() = 'admin'` 看全部有效仓库；operator 仅 `warehouse_id IN (SELECT get_assigned_warehouse_ids())`。
- `REVOKE EXECUTE FROM PUBLIC, anon;` + `GRANT EXECUTE TO authenticated;`。
- **前端禁止直连 Supabase（v7 五修正读取链路）**：
  - **读取链路**：Server Component → Repository → Supabase RPC → PostgreSQL RLS（`get_replenishment_suggestions` / `get_in_transit_detail` 由 Server Component 直接经 Repository 以用户会话客户端调用，`auth.uid()` 即当前用户；常规 Server Component 读取**不强制过 Server Action**）。
  - **写入链路**：Client Component / 表单 → Server Action（'use server'）→ Repository → Supabase → PostgreSQL RLS（创建 / 取消 / 修改仓库参数及客户端触发的服务端操作）。
  - 所有外部查询参数先经 Zod 校验；不依赖前端隐藏数据。

### 4.9 性能与返回契约（Codex 九）

- `get_replenishment_suggestions` 入参含 `p_page` / `p_page_size`（默认 20，上限 100，越界钳制）；`p_warehouse_id` / `p_country` / `p_urgency` / `p_search`（sku/名称/product code 分词）过滤；`p_include_zero`（默认 false，仅返回 `net_demand > 0`）。
- 返回 `{ data: [...], total: integer }`；`total` 为过滤后总数（分页用）。
- 默认排序：紧急度降序（`critical > warning > ok > data_incomplete`）→ `net_demand` 降序。
- 空结果：`data = []`，`total = 0`，不报错。
- 所有聚合在**单次 SQL（CTE）**内完成，禁止逐行 N+1；inbound 计算与库存 JOIN 同查询。

### 4.10 前端落位（Codex 十，V1 唯一入口）

- **V1 唯一入口**：新增 **`/dashboard/replenishment`** 独立只读列表页（`src/app/dashboard/replenishment/page.tsx`）。
- **产品详情页**：仅增加只读"补货建议"卡片（调用 `get_replenishment_suggestions` 按 `variant_id` 过滤），不新增其他互动。
- **不放入"关注产品动态"**：避免把"用户关注"与"全量补货建议"混为一谈；若未来要嵌入关注区，须仅显示用户已关注的 variant（本期不做）。
- 路径统一用 `src/app/dashboard/...`（不使用不存在的 `app/dashboard/...`）。Client Component 内**不直连数据库**（读取走 Server Component→Repository→RPC；写入走 Server Action→Repository→Supabase）；常规只读读取不强制经过 Server Action。
- 计划发货录入 / 取消：列表页弹窗 → `createPlannedShipment` / `cancelPlannedShipment` Server Action。

---

## 5. 数据模型变更（最终表 / 字段清单）

### 5.1 复用现有表（不重建）

| 表 | 复用字段（与补货引擎相关） | 说明 |
|----|--------------------------|------|
| `shipment` | `id, warehouse_id, country, status('booking'/'loading'/'departed'/'arrived'/'customs'/'warehoused'), estimated_arrival(date), created_by→profiles(id), bigseller_absorbed_at(timestamptz)` | **新增 `cancelled_at`（§5.2）** |
| `shipment_item` | `shipment_id, variant_id, quantity, warehoused_quantity` | `remaining = quantity - warehoused_quantity` |
| `warehouse` | `id, name, country(text NOT NULL，无国家码 CHECK，须服务端规范化，见 §7.3), type, is_active, lead_time_days(int NULL)` | **新增 3 列（§5.2）** |
| `inventory` | `variant_id, warehouse_id, quantity, daily_sales(numeric NULL), estimated_days(numeric NULL)` | 无变更 |
| `product_variant` | `id, product_id(NULL 允许), sku, country, name, match_status` | 无变更 |
| `product` | `id, name, code, safety_stock` | 无变更 |

### 5.2 新增 / 修改列（最终）

**`shipment` 新增：**
```sql
ALTER TABLE shipment ADD COLUMN cancelled_at timestamptz DEFAULT NULL;
CREATE INDEX idx_shipment_cancelled_at ON shipment(cancelled_at);
```
- 语义：软删除/取消标记；引擎与 `get_in_transit_detail` 排除 `cancelled_at IS NOT NULL`。
- 不改动 `status` 枚举（避免与 P0 v8 状态流冲突）。

**`warehouse` 新增（Migration A）：**
```sql
ALTER TABLE warehouse
  ADD COLUMN buffer_ratio           numeric NOT NULL DEFAULT 0.25,
  ADD COLUMN target_cover_multiplier numeric NOT NULL DEFAULT 1.5,
  ADD COLUMN updated_at             timestamptz NOT NULL DEFAULT now();

ALTER TABLE warehouse
  ADD CONSTRAINT warehouse_buffer_ratio_check      CHECK (buffer_ratio >= 0),
  ADD CONSTRAINT warehouse_cover_mult_check        CHECK (target_cover_multiplier > 0);

CREATE TRIGGER trg_warehouse_updated_at
  BEFORE UPDATE ON warehouse
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
```
- `ADD COLUMN ... DEFAULT NOT NULL` 在同事务回填现有 6 仓库默认值。
- admin 经 `updateWarehouseParams` 按仓库修改；`updated_at` 由触发器维护。

### 5.3 删除 / 延期（明确不建）

- **`planned_shipments`：不建**（方案 A 复用 `shipment`）。
- **`variant_daily_snapshot`：V1 不建**（§4.5 理由；待 90 天数据进 V2 时再建）。

### 5.4 Migration 设计（可回滚）

| Migration | 文件（推荐编号） | 内容 | 回滚 |
|-----------|----------------|------|------|
| **A** | `00041_replenishment_warehouse_params.sql` | `warehouse` 加 `buffer_ratio` / `target_cover_multiplier` / `updated_at` + 2 CHECK + 触发器 | `DROP TRIGGER` / `DROP COLUMN` 三列 / `DROP CONSTRAINT` |
| **B** | `00042_replenishment_cancellation.sql` | `shipment` 加 `cancelled_at` + 索引 | `DROP INDEX` / `DROP COLUMN cancelled_at` |
| **C** | `00043_forecast_stockout.sql` | 新建共享预测函数 `forecast_stockout(p_on_hand, p_daily_sales, p_lead_time_days, p_inbound jsonb)`（P1 与 P7-B 作战室增强层共用，见 §4.3 / §6.3） | `DROP FUNCTION forecast_stockout(...)` |
| **D** | `00044_replenishment_rpcs.sql` | 新建读取 RPC `get_in_transit_detail` + `get_replenishment_suggestions`（含 REVOKE/GRANT，依赖 A/B/C） | `DROP FUNCTION` 两个 |

**执行顺序固定：A → B → C → D**（依赖：`get_replenishment_suggestions` 依赖 warehouse 新列（A）、`shipment.cancelled_at`（B）、`forecast_stockout`（C），故读取 RPC 必须最后创建）。
**回滚顺序固定：D → C → B → A**。
四份（A/B/C/D = `00041`–`00044`）各自独立、可回滚、不修改已执行 00001–00037；若 `00041`–`00044` 已被占用，须整体顺延为连续四个新编号；正文不再使用 `0003x_*.sql` 占位。不涉及 P0 喜运达表结构（P0 已预留 `00038`–`00040`）。

---

## 6. 后端 RPC（最终输入输出契约）

### 6.1 `get_in_transit_detail`（只读明细，方案 A）

```sql
CREATE OR REPLACE FUNCTION public.get_in_transit_detail(
  p_user_id      uuid,
  p_warehouse_id uuid DEFAULT NULL,
  p_variant_id   uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
  -- 身份绑定：auth.uid() 非空 + p_user_id = auth.uid()
  -- 仓库隔离：admin 全量；operator 仅 assigned（get_assigned_warehouse_ids）
  -- 返回 jsonb 数组，元素：
  --   shipment_id, variant_id, warehouse_id, status,
  --   estimated_arrival(date), remaining_quantity(int),
  --   is_planned(bool = status='booking')
  --   （V1 不返回 warehoused_quantity，该字段不参与补货计算）
  -- 口径：status IN (booking,loading,departed,arrived,customs)
  --       且 bigseller_absorbed_at IS NULL 且 estimated_arrival IS NOT NULL
  --       的 remaining_quantity 计入在途；warehoused 一律不计入；
  --       排除 cancelled_at IS NOT NULL
  -- REVOKE PUBLIC, anon; GRANT authenticated
$$;
```

### 6.2 `get_replenishment_suggestions`（主 RPC）

**输入：**
```sql
p_user_id      uuid,          -- 身份绑定（= auth.uid()）
p_variant_id   uuid DEFAULT NULL,   -- NULL=列表模式；非 NULL=仅返回该 variant（仍走仓库权限过滤）
p_warehouse_id uuid DEFAULT NULL,
p_country      text DEFAULT NULL,
p_urgency      text DEFAULT NULL,   -- 'critical'|'warning'|'ok'|'data_incomplete'
p_search       text DEFAULT NULL,   -- sku/名称/product code 分词
p_include_zero boolean DEFAULT false,
p_page         integer DEFAULT 1,
p_page_size    integer DEFAULT 20
```

**输出（jsonb）：** `{ "data": [ ... ], "total": integer }`，每行：
```
variant_id, warehouse_id, sku, product_name, variant_name, country,
avg_daily_sales    numeric,
lead_time          integer,
buffer_ratio       numeric,
cover_mult         numeric,
safety_stock       integer,   -- 安全阈值展示值 SS = round(ds*lead*buffer)；ds 或 lead 缺失时为 NULL，不计入 target_stock
on_hand            integer,
effective_inbound  integer,   -- = COALESCE(Σ remaining WHERE eta <= est_stockout_date, 0)（仅断货日前到达；空集合恒为 0，非 NULL）
target_stock       integer,   -- lead 缺失时为 NULL
net_demand         integer,   -- lead 缺失时为 0
suggest_qty        integer,   -- = net_demand；lead 缺失时为 0
est_stockout_date  date,      -- daily_sales 有效时可算；否则 NULL
latest_order_date  date,      -- lead 缺失时为 NULL
urgency            text       -- 'critical'|'warning'|'ok'|'data_incomplete'；lead 缺失时为 data_incomplete
```
（**V1 不输出 `confirmed_inbound`**；待入账补给口径已删除，见 §4.7）

**内部：** 单条 SQL（CTE）：
1. 仓库隔离（admin / operator assigned）；
2. JOIN `inventory` → `product_variant` → **LEFT JOIN** `product` → `warehouse`（`inventory` 为驱动表：仅已存在 `inventory` 行的 `(variant_id, warehouse_id)` 组合参与；`product` 用 LEFT JOIN：`product_variant.product_id` 可为 NULL、未关联 product 的 variant 仍参与；搜索条件用 `COALESCE(product_name, '')` 等，不因 product 字段 NULL 排除正常结果）；
3. `inbound` CTE：按 §4.3 条件收集（含 `bigseller_absorbed_at IS NULL`、`cancelled_at IS NULL`、`status IN (...)`、`remaining>0`、`estimated_arrival IS NOT NULL`）的 `remaining` 与 `eta`，组装为 `p_inbound jsonb`；**主 RPC 调用共享数据库函数 `forecast_stockout(p_on_hand, p_daily_sales, p_lead_time_days, p_inbound)`**（v6 同步修订抽取，与 P7-B 作战室增强层同一实现，见 §6.3）得 `est_stockout_date` / `effective_inbound`；`get_in_transit_detail`（§6.1）仍返回逐 shipment 明细；
4. 取得 `est_stockout_date` + `effective_inbound` 后，按 §4.3 行动层公式算 `target_stock / net_demand / latest_order_date / urgency`（lead NULL/<=0 时 `target_stock=NULL`/`net_demand=0`/`suggest_qty=0`/`latest_order_date=NULL`/`urgency='data_incomplete'`）；
5. 过滤（`p_variant_id` / `warehouse_id` / `country` / `urgency` / `search` / `include_zero`）；`p_variant_id` 非 NULL 时仅返回该 variant，**仍执行仓库隔离**（operator 不能借 `p_variant_id` 绕过 assigned 仓库）；
6. 排序（urgency 降序 → net_demand 降序）+ 分页（`LIMIT p_page_size OFFSET (p_page-1)*p_page_size`）。

**安全：** `SECURITY INVOKER` + `SET search_path = ''` + `auth.uid()` 绑定 + `p_user_id = auth.uid()` + 仓库隔离；`REVOKE PUBLIC, anon; GRANT authenticated;`；声明 `STABLE`（不写库）。

**范围：** 默认 `net_demand > 0`（建议补的）；`p_include_zero=true` 返回全部（含 `data_incomplete` / `ok`）。

### 6.3 `forecast_stockout`（共享预测函数，P1 / P7-B 共用）

**创建（Migration C）**：

```sql
CREATE FUNCTION forecast_stockout(
  p_on_hand         integer,
  p_daily_sales     numeric,
  p_lead_time_days  integer,
  p_inbound         jsonb          -- [{eta: date|null, remaining: integer}, ...]，调用方已按 warehouse_id 权限过滤
)
RETURNS TABLE (
  est_stockout_date date,     -- daily_sales 有效时算；否则 NULL
  effective_inbound  integer, -- = COALESCE(Σ remaining WHERE eta <= est_stockout_date, 0)，空集合恒 0 非 NULL
  ds_incomplete      boolean, -- daily_sales NULL/<=0 时为 true
  lead_incomplete    boolean  -- lead_time_days NULL/<=0 时为 true
)
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = '' AS $$
  -- 函数体见 §4.3（与 P7-B 作战室增强层同一实现）：ds NULL/<=0 早退不生成虚假断货日；
  -- inbound 按 eta 分组聚合；事件模拟得 est_stockout_date；
  -- effective_inbound = COALESCE(SUM(remaining) FILTER (WHERE eta <= est_stockout_date), 0)::integer；
  -- lead 缺失置 lead_incomplete；不写死天数
$$;
```

- `REVOKE PUBLIC, anon; GRANT authenticated;`
- 调用方负责按 `warehouse_id` 权限收集 inbound、组装 `p_inbound`；本函数只做模拟，不接触表、不做权限过滤。
- P7-B 作战室增强层 `get_product_overview` / `get_war_room_variant_detail` 调用同一函数，仅取 `est_stockout_date` + `effective_inbound`（行动层 `target_stock` 等由本方案 §6.2 步骤 4 计算）。

---

## 7. 前端（V1 落位）

### 7.1 补货建议列表（V1 唯一入口）

- 路由：`src/app/dashboard/replenishment/page.tsx`（Server Component，**直接调用 Repository 读取** `get_replenishment_suggestions`，不走 Server Action）。
- 列：产品名/SKU、仓库、日均销、在手、有效补给、目标库存、**建议补货量（高亮）**、最晚下单日、紧急度（红/黄/绿/灰标签）。
- 过滤：仓库 / 国家 / 紧急度 / 搜索；分页；紧急度红行置顶（由 RPC 排序保证）。
- 只读展示，不在此页直接编辑库存。

### 7.2 产品详情页卡片（只读）

- 该 variant 的补货建议：日均销 / 在手 / 有效补给 / 建议补货量 / 最晚下单日 / 紧急度。
- 调用 `get_replenishment_suggestions(p_variant_id=:variantId)`（§6.2 已补该入参）过滤单行；只读；仍受仓库权限过滤约束。

### 7.3 计划发货录入（`createPlannedShipment`）

- 入口：列表页「计划发货」按钮 → 弹窗（variant / 仓库 / 数量 / 预计发出日 / 预计到达日）。
- **权限（默认方案 B）**：Server Action `createPlannedShipment` **admin-only**（与现有 `createShipment` 一致，复用 `create_shipment_transactional` 的 admin 规则）。operator 自录为[待 Rall 确认]的方案 A 备选（届时需要新增 `create_planned_shipment` RPC，见 §4.1.1）。
- 写逻辑（`createPlannedShipment`，admin）：
  - `requireActiveAdmin()`（或 `requireActiveAuth()` + 角色校验为 admin）；
  - 校验 `warehouse_id` 为 active 仓库（admin 任意）；
  - 校验 variant 存在且国家与仓库一致；
  - **ETA 强制**：填 `expected_arrival_date` 直用；填 `planned_ship_date` 则 `estimated_arrival = planned_ship_date + warehouse.lead_time_days`（`lead_time_days` 为 NULL 则拒绝保存）；两者皆无 → 拒绝（中文报错）；
  - **`shipment_no` 生成（必填，v4 四唯一性 + v5 一 ASCII 规则 + v6 二 country 规范化）**：
    - **country 规范化（v6 二，强制前置）**：调用 `create_shipment_transactional` 前，先 `country_code := upper(trim(warehouse.country))`；**仅允许 `TH`/`ID`/`MY`/`PH`/`VN`/`CN`**；为空或不在集合内 → **返回明确中文错误**（如"仓库国家不合法，无法生成计划单号"），**不得继续写入**。`shipment.country` 有 6 码 CHECK（00001:138），未规范化会触发 CHECK 失败，故服务端必须先校验（不依赖 DB CHECK 报错）。
    - 单号格式：`PLN-{country_code}-{warehouse_id 前 8 位}-{YYYYMMDD}-{seq6}`（`country_code` = 规范化后国家码；`warehouse_id 前 8 位` = uuid 前 8 个十六进制字符；`seq6` = 服务端生成如 `gen_random_uuid()` 派生 6 位）；满足 `shipment_no` NOT NULL+UNIQUE，总长 ≤ 50，仅 `[A-Za-z0-9_-]`，**禁止前端传入**。
    - **唯一约束冲突自动重试最多 3 次（依赖真实 PG 错误元数据，v7 三 / v8 二确定性提取）**：
      - 现有 `shipmentRepository.create()` 捕获 RPC 错误时**保留原始错误对象字段**：`error.code`、`error.message`、`error.details`、`error.hint`，并传入 `ShipmentError` 第三参数 `meta`（类型 `ShipmentDbErrorMeta`，见 §8.5；`ShipmentError` 仍定义在 `src/features/shipments/repository.ts`，不在 `types.ts`）。
      - **`constraint` 确定性识别（v8 二，不假定错误对象提供稳定的 `constraint` 字段）**：先读取运行时错误对象若确实提供结构化约束名则取其值；**否则仅在服务端从 `error.message` 中匹配 PostgreSQL 标准文本 `duplicate key value violates unique constraint "shipment_no_unique"` 提取精确名称 `shipment_no_unique`**；只能用精确名称匹配，**禁止"只要 message 含 duplicate/unique 即重试"的宽松判断**；识别不到精确名称时 `constraint` 保持 `undefined`。
      - `meta` 写入规则：`{ dbCode: error.code, constraint: 仅在明确识别后填写, dbMessage: error.message, dbDetails: error.details, dbHint: error.hint }`。
      - `createPlannedShipment` **仅在 `error.meta?.dbCode === '23505'` 且 `error.meta?.constraint === 'shipment_no_unique'` 两条件同时满足时**才重新生成 `seq6` 并重试。
      - **以下情况一律不重试**：`23505` 但约束名非 `shipment_no_unique`；`23505` 但无法确认约束名；FK 错误；CHECK 错误；权限错误；网络错误；`tracking_event`/`shipment_item` 写入错误；`P0001` 业务校验错误；无法解析的数据库错误。
      - 每次重试重新生成完整 `seq6`（不复用旧号）；**"最多 3 次"指总共最多调用 `repository.create()` 三次（首次 + 至多两次重试），非首次失败后再额外重试三次**。
      - 三次均为 `shipment_no_unique` 冲突时，仅返回明确中文错误"生成计划单号失败，请重试"；**不得向页面返回 PostgreSQL 原始 `message` / `details` / `hint` / 约束名 / SQL 内容**（仅 `ShipmentError` 友好中文，`meta` 仅供服务端判断）。
      - 字符集/长度由 Server Action 内部生成器保证（**V1 不新增 `shipment_no` 字符集 CHECK**；DB 继续沿用现有 `NOT NULL + shipment_no_unique`；字符集 CHECK 如未来确有需要，单独立项，不属于 00041–00044）。
  - 调 `shipmentRepository.create({ shipmentNo: 内部单号, estimated_arrival, items:[{variantId, quantity}], country: country_code, ... })`（即 `create_shipment_transactional`，admin 可调用；**不传入 `status`**，由 `shipment.status` 列默认 `'booking'` 生效，RPC 自动建初始 `booking` tracking_event）；
  - 写后 **read-back 校验**：查回确认 `id` 落盘**且 `status = 'booking'`**（依赖 DB 默认，见 §4.1.1 / §8.5），失败中文报错；`revalidatePath('/dashboard/replenishment')`。

### 7.4 取消计划发货（`cancelPlannedShipment`）

**取证**：现有 `shipmentRepository.update()`（`repository.ts:584-597`）只更新 10 个字段，**不写 `cancelled_at`**，故不能复用 `update` 来取消。v3 新增专用写入路径。

- **固定 V1 写入路径：`shipmentRepository.cancelPlannedShipment(shipmentId)`（不新增 `cancel_planned_shipment` RPC，v7 四）**：
  - 调用链（V1，零新增写 RPC）：
    ```
    弹窗 → cancelPlannedShipment Server Action
         → requireActiveAdmin()
         → Zod UUID 校验
         → shipmentRepository.cancelPlannedShipment(shipmentId)
         → authenticated Supabase client → RLS → UPDATE shipment
    ```
  - 精确 UPDATE（仅一列）：
    ```sql
    UPDATE public.shipment
    SET cancelled_at = now()
    WHERE id = :shipment_id
      AND status = 'booking'
      AND cancelled_at IS NULL
    RETURNING id, status, cancelled_at;
    ```
  - Repository 方法**不接收 `userId`**：权限身份来自当前用户 session（`requireActiveAdmin()` 已校验），不接受调用方传入身份，杜绝越权。
- 取消规则：
  - 只能取消 `status='booking'` 且 `cancelled_at IS NULL` 的记录（WHERE 强约束，无法通过参数绕过）；
  - **V1 仅 admin**：Server Action 层 `requireActiveAdmin()` 拒 operator；operator 取消为[待 Rall 确认]的方案 A 备选（届时另增 RPC 内加 assigned 仓库校验）；
  - **只写 `cancelled_at`**，绝不借取消接口修改 `status` / `warehouse_id` / `country` / `estimated_arrival` / `shipment_item`（UPDATE 仅含 `cancelled_at` 一列）；
  - 取消后 **read-back 校验**（确认 `cancelled_at IS NOT NULL`），失败中文报错；
  - **0 行命中时回查当前记录并区分**：不存在或不可见 → 中文错误"计划不存在或无权限"；已取消（`cancelled_at IS NOT NULL`）→ 中文错误"该计划已取消"；非 `booking`（如 `loading`/`departed`）→ 中文错误"仅计划发货（booking）可取消"；不抛异常；
  - **并发重复取消**：两请求同毫秒到达，仅一个 `UPDATE` 命中 1 行成功，另一个命中 0 行 → 按"已取消"分支返回"该计划已取消"，不重复写、不报错；
  - 引擎与 `get_in_transit_detail` 自动排除 `cancelled_at IS NOT NULL`，取消后不再计入。

---

## 8. 分阶段实施（交 Claude）

| 阶段 | 内容 | 关键文件 | 验收 |
|------|------|----------|------|
| **Phase 1** | Migration A/B/C/D（`00041_replenishment_warehouse_params.sql` / `00042_replenishment_cancellation.sql` / `00043_forecast_stockout.sql` / `00044_replenishment_rpcs.sql`：warehouse 3 列 + shipment.cancelled_at + 共享函数 forecast_stockout + 两读取 RPC，含 REVOKE/GRANT）；**顺序固定 A→B→C→D，不得遗漏共享函数 Migration**；同步 §8.5 类型与 Repository；RPC 单测（§9.1 原有 25 条 + §9.1.1 新增边界 18 主编号 + #28a/#28b 额外 2 条 + §9.1.2 v6 新增 #44–55 共 12 条 = 57 条；v7 新增 #56–67 共 12 条；v8 新增 #68–72 共 5 条 → **合计 74 条**） | `supabase/migrations/0004x_*.sql`（以 00041 起；Claude 实施前须复检 `supabase/migrations/` 最新编号，若 00041–00044 已被占用须整体顺延为连续四个新编号） + §8.5 文件 | RPC 单测全绿（含 §9.1 的 25 条 + §9.1.1 的 20 条 + §9.1.2 v6 的 #44–55 + v7 的 #56–67 + v8 的 #68–72，**合计 74 条映射**） |
| **Phase 2** | `createPlannedShipment`（admin-only，复用 `createShipment`/`create_shipment_transactional` + 内部 `shipment_no`）/ `cancelPlannedShipment`（新增 `shipmentRepository.cancelPlannedShipment`，仅写 `cancelled_at`）/ `updateWarehouseParams`（改调 `warehouseRepository.updateReplenishmentParams`）Server Action + 写后校验 | `src/features/shipments/actions.ts` + `src/features/warehouse/*` + schema | 写后 read-back；operator 调现有 RPC 被拒；shipment_no 唯一；取消 booking 成功/重复取消失败/非 booking 取消失败；admin 改 warehouse 参数生效 |
| **Phase 3** | `/dashboard/replenishment` 列表页 + 产品详情卡片（只读，含 `p_variant_id` 过滤调用） | `src/app/dashboard/replenishment/*` + 详情页组件 | 列表渲染 + 紧急度排序 + 分页/过滤 + 权限（operator 仅见授权仓，且 `p_variant_id` 不绕过） |
| **Phase 4（v2）** | `variant_daily_snapshot` 建表 + 采集 + 趋势/季节性预测替换单值 | 新 Migration + cron/同步 + RPC 升级 | 历史均值/趋势测试（数据到位后） |

### 8.5 Migration 后必须同步的代码范围（Codex 八）

新增 `shipment.cancelled_at` / `warehouse.buffer_ratio` / `warehouse.target_cover_multiplier` / `warehouse.updated_at` 及新 RPC 后，Claude **必须同步以下文件**，否则 TypeScript 类型与现有 Repository 会不一致：

- `src/types/database.ts` —— 补齐 `shipment.cancelled_at`、`warehouse.buffer_ratio`/`target_cover_multiplier`/`updated_at` 列类型，以及新 RPC 的返回/参数类型契约。
- `src/features/shipments/types.ts` —— `Shipment` 类型加 `cancelledAt`；`CreateShipmentData` 不变（仍走现有 `create_shipment_transactional`）；新增 `CancelPlannedShipmentResult`。**`ShipmentError` 不在 `types.ts` 定义（v8 一纠正）：`types.ts` 仅同步业务数据类型（`Shipment` / `cancelledAt` / `CancelPlannedShipmentResult`），不重复定义错误类。**
- `src/features/shipments/schema.ts` —— 补 `cancelledAt` 字段 schema；`updateWarehouseParams` 相关 schema 移至 warehouse schema。
- `src/features/shipments/repository.ts` —— `ShipmentError` 与 `ShipmentDbErrorMeta` **均定义并保留在本文件**（v8 一：`export class ShipmentError` 现有两参数构造 `ShipmentError(message, code)` 继续兼容；新增可选第三参数 `meta: ShipmentDbErrorMeta`，`interface ShipmentDbErrorMeta { dbCode?: string; constraint?: string; dbMessage?: string; dbDetails?: string; dbHint?: string }`；不移动、不在 `types.ts` 重复定义）；新增 `cancelPlannedShipment(shipmentId)` 方法（仅 `UPDATE cancelled_at`，强约束 `booking`+`cancelled_at IS NULL`；不接收 userId，身份来自当前会话）；`create` / `update` 行为保持不变，但 `create()` 须在捕获 Supabase/PostgreSQL 错误时**保留 `error.code`/`message`/`details`/`hint` 并确定性识别约束名**（`constraint` 先取运行时结构化名，否则仅从 `error.message` 精确匹配 `duplicate key value violates unique constraint "shipment_no_unique"`；识别不到则 `constraint` 为 `undefined`），写入 `ShipmentError.meta`（供 `createPlannedShipment` 判断 `dbCode==='23505' && constraint==='shipment_no_unique'` 重试；其他错误一律不重试）。
- `src/features/shipments/actions.ts` —— `createPlannedShipment`（admin-only，生成内部 `shipment_no`，复用 `create`）、`cancelPlannedShipment`（调 `repository.cancelPlannedShipment`）。
- `src/features/warehouse/` —— 新增 `warehouseRepository.updateReplenishmentParams()`、`schema.ts`（Zod 校验 `buffer_ratio>=0` / `target_cover_multiplier>0`）、Server Action `updateWarehouseParams`（admin-only，read-back）。
- 新增 RPC 类型契约与调用封装（若 Rall 确认方案 A，还需 `create_planned_shipment` / `cancel_planned_shipment` RPC 类型）。
- 新增/补全测试：取消、计划创建、分页、权限、公式（含晚到不抵扣）测试，覆盖 §9.1 原有 25 条 + §9.1.1 新增边界 18 主编号 + #28a/#28b 额外 2 条 + §9.1.2 v6 新增 #44–55 共 12 条（共 57 条；`effective_inbound` 空集合恒为 0 非 NULL）；v7 新增 #56–67（共 69 条）；v8 新增 #68–72（共 74 条；含 `ShipmentError` 位置兼容 / 精确提取 `shipment_no_unique` / 其他唯一约束不重试 / 无法识别约束名不重试 / 重试次数边界）。

---

## 9. 验收标准（全阶段通用）

```bash
npm run test     # 全绿（含新增 RPC 单测 + 权限测试 + 写后校验 + §9 边界）
npm run build    # 成功
npm run lint     # 0 errors
```

### 9.1 必测边界（Codex 十一，至少覆盖）

| # | 场景 | 期望 |
|---|------|------|
| 1 | `on_hand > target_stock` | `suggest_qty = 0` |
| 2 | `daily_sales = NULL` | `urgency = data_incomplete`，不生成虚假断货日 |
| 3 | `daily_sales = 0` | 不生成虚假断货日，`suggest_qty = 0` |
| 4 | `lead_time_days = NULL` 或 `<= 0` | `target_stock = NULL`、`net_demand = 0`、`suggest_qty = 0`、`latest_order_date = NULL`、`urgency = data_incomplete`；`est_stockout_date` 在 `daily_sales` 有效时仍算 |
| 5 | `buffer_ratio = 0`（ds/lead 有效） | `safety_stock = round(ds*lead*0) = 0`，公式 `SS = ds*lead*buffer` 成立 |
| 6 | `target_cover_multiplier = 1` | `target_stock = round(ds*lead)` |
| 7 | 小数 / round 规则 | `round()` / `ceil()` 行为符合 §4.3 |
| 8 | ETA 早于断货日 | 计入抵扣，断货日推迟 |
| 9 | ETA 晚于断货日 | 不抵扣（断货后才到），`est_stockout_date` 不受影响 |
| 10 | ETA 为 NULL | V1 不计入 ETA 感知结果 |
| 11 | ETA 已过期（< today） | 仍计入（视为应到未到），不崩溃 |
| 12 | `shipment.status = 'warehoused'` | 不计入在途 |
| 13 | `bigseller_absorbed_at` 非空 | 不计入（已吸收） |
| 14 | 计划发货取消（`cancelled_at` 非空） | 不参与计算 |
| 15 | 计划发货部分完成（`warehoused_quantity > 0`） | 仅 `remaining` 计入 |
| 16 | 同一 variant 多仓库 | 按 (variant, warehouse) 分别计算 |
| 17 | 同一仓库多 shipment | 多批 ETA 升序模拟累加 |
| 18 | operator 查询未授权仓库 | 结果不含该仓 |
| 19 | operator 调用现有 `create_shipment_transactional` / `createPlannedShipment` / `cancelPlannedShipment` | 因 admin-only 被拒（不依赖 RLS 仓库过滤）；既有 operator shipment RLS（`00001:386-393`）仅判角色、无 warehouse assignment 过滤，记为历史技术债，本轮不改 |
| 20 | admin 查看全部仓库 | 全量可见 |
| 21 | 写入后 read-back 失败 | 中文报错 |
| 22 | 重复提交计划发货 | 允许（不同 shipment 行；不幂等去重，由业务控制） |
| 23 | `product_variant.product_id` 为 NULL | 仍计算（`product_name` 可为空） |
| 24 | `inventory` 行存在且 `quantity = 0` | `on_hand = 0`，正常计算（variant 参与补货列表） |
| 25 | 无匹配产品的 variant | 仍计算，`product_name` 为空 |

### 9.1.1 本轮新增必测（Codex 九，v3 补充）

| # | 场景 | 期望 |
|---|------|------|
| 26 | operator 调用现有 `create_shipment_transactional` | 被拒（RPC 仅 admin） |
| 27 | operator 调用新 `create_planned_shipment`（仅当 Rall 启用方案 A） | 仅能写授权仓；越权仓拒绝 |
| 28 | 计划发货 `shipment_no` | 由 Server Action 自动生成且唯一（满足 NOT NULL+UNIQUE）；**仅 `[A-Za-z0-9_-]`，总长 ≤ 50，禁止中文/前端传入**；格式 `PLN-{country}-{warehouse_id前8位}-{YYYYMMDD}-{seq6}` |
| 28a | 并发创建计划发货（多请求同毫秒） | 唯一约束兜底 + 自动重试（≤3 次）成功；或返回中文错误"生成计划单号失败，请重试" |
| 28b | 注入已存在的 `shipment_no` | 唯一约束拒绝（前端传入被禁，内部生成重试兜底） |
| 29 | 取消 `booking` 计划 | 成功，`cancelled_at` 置位，引擎排除 |
| 30 | 重复取消同一 booking | 返回明确中文错误（非异常） |
| 31 | 取消非 `booking`（如 `loading`） | 失败（WHERE `status='booking'` 命中 0 行），中文错误 |
| 32 | ETA 晚于断货日的在途（如库存 0/日销 10/5 天断货/ETA 30 天 1000 件） | **不计入 `effective_inbound`**，`net_demand`/`suggest_qty` 不为 0 |
| 33 | ETA = 断货日当天（`cur == consume`） | 不提前断货，先扣消耗再补入，计入抵扣（当天补入）；仅 `eta` 严格晚于 `est_stockout_date` 才不计入 |
| 34 | ETA 已过期（< today） | 计入（视为应到未到），不崩溃，符合 §4.3 规则 |
| 35 | `effective_inbound` 口径与输出一致 | = 未入仓 `remaining` 且 `eta ≤ est_stockout_date`；**无 `confirmed_inbound` 输出** |
| 36 | 产品详情页 `p_variant_id` 过滤 | 返回该 variant；operator 不能借 `p_variant_id` 绕过 assigned 仓库 |
| 37 | `updateWarehouseParams` 调用链 | **经 `warehouseRepository.updateReplenishmentParams`**，不经过 `shipmentRepository` |
| 38 | Migration 新字段 | `src/types/database.ts` 等 §8.5 文件 TypeScript 类型已同步，编译通过 |
| 39 | 全量校验 | `npm run test` / `build` / `lint` 全绿（含 §9.1 + §9.1.1） |
| 40 | 非 `warehoused` 但 `bigseller_absorbed_at IS NOT NULL` | 不计入 `effective_inbound`（v5 二统一过滤） |
| 41 | `warehoused` 且未吸收（已到仓未确认） | 不计入（V1 仅未入仓 `remaining`） |
| 42 | `cancelled_at IS NOT NULL` | 不计入 |
| 43 | `remaining = quantity - warehoused_quantity <= 0` | 不计入 |

### 9.1.2 v6 新增必测（Codex 六终终审，4 项实施级）

| # | 场景 | 期望 |
|---|------|------|
| 44 | ETA 事件模拟：同一 `estimated_arrival` 两条 shipment（各 remaining=R，当前库存 10，日销 10） | 合并为单事件 `total_remaining=2R`，只扣减一次 `days`；不得误判断货（例：两 shipment 均 ETA 明天、库存 10、日销 10 → 不判断货，明天补入 2R） |
| 45 | ETA 事件模拟：同一 ETA 多条 shipment | `remaining` 先 `SUM` 聚合，仅扣减一次日销量，结果等同于单条 `total_remaining` 的 shipment（v6 一） |
| 46 | ETA 事件模拟：过期 shipment（eta < today）与当天 shipment（eta = today）混合 | 过期者 `greatest(eta,today)=today`、`days=0` 直接补入；当天者亦补入；计时无重复扣减，结果正确（v6 一） |
| 47 | ETA 事件模拟：ETA 当天（event_date = today） | `days=0`，不前置消耗，当天补给计入 `effective_inbound`（cur==consume 亦先扣再补，见 #33） |
| 48 | `shipment_no` country 小写 | `upper(trim('th'))` → `TH`，单号正常生成（v6 二） |
| 49 | `shipment_no` country 中文 / 未知 / 空 | 服务端校验拒绝，返回明确中文错误，不写入 `shipment.country`（避免 CHECK 失败）（v6 二） |
| 50 | 生成的 `shipment_no` 字符集 | 仅含 `[A-Za-z0-9_-]`，无中文 / 空格 / 非法字符（v6 二） |
| 51 | 生成的 `shipment_no` 长度 | ≤ 50（规范化 country 仍 2 位）（v6 二） |
| 52 | 创建计划发货不传 status | `CreateShipmentData` / `create_shipment_transactional` 无 status 参数；DB 默认 `status='booking'`；read-back 校验 `status='booking'`（v6 三） |
| 53 | `effective_inbound` 空集合：无任何在途记录（无 shipment / 全 NULL ETA / 全 warehoused） | `effective_inbound = 0`；`net_demand` / `suggest_qty` 正常计算，均**非 NULL**（COALESCE 兜底） |
| 54 | 所有 ETA 均晚于 `est_stockout_date`（晚到货不抵扣） | `effective_inbound = 0`；`net_demand` / `suggest_qty` 正常计算，不为 NULL（晚到批次不计入，不把建议量压成 0） |
| 55 | 所有 inbound 被取消（`cancelled_at IS NOT NULL`）/ 被吸收（`bigseller_absorbed_at IS NOT NULL`）/ `remaining <= 0` | `effective_inbound = 0`；结果不为 NULL，不报错、不崩溃 |

> 注（v6 六终终审补充）：`effective_inbound` 原写为 `SUM(total_remaining) FROM events WHERE eta <= est_stockout_date`，PostgreSQL 对空集合 `SUM` 返回 NULL，会经 `net_demand := greatest(0, target_stock - (on_hand + effective_inbound))` 传播为 NULL，违反 integer 输出契约。已改为 `COALESCE(SUM(...) FILTER (WHERE eta <= est_stockout_date), 0)::integer`，覆盖上述 7 类空/零场景，恒为 0 非 NULL。

### 9.1.3 v7 新增必测（Rall 独立复核，8 项实施级修订 + 测试数量校正）

| # | 场景 | 期望 |
|---|------|------|
| 56 | `safety_stock` 计算 | 按 `safety_stock = round(ds * lead * buffer)::integer`；ds/lead 有效、`buffer=0.25` 时值正确；`buffer=0` 时 `=0`；`ds` 无效或 `lead` 无效时为 NULL（不计入 `target_stock`） |
| 57 | `target_stock` 不重复叠加 `safety_stock` | `target_stock = round(ds*lead*cover)`、`net_demand = greatest(0, target_stock - (on_hand + effective_inbound))`；`buffer` 仅作用于 `safety_stock` 展示值，不二次计入 `suggest_qty`（避免 buffer 与 cover 重复计入） |
| 58 | `repository.create` 保留 `shipment_no` 唯一约束错误元数据 | 捕获 RPC 错误时 `ShipmentError.meta` 含 `dbCode`(`error.code`) / `constraint`(确定性识别) / `dbMessage`(`error.message`) / `dbDetails`(`error.details`) / `dbHint`(`error.hint`)；`constraint` 先取运行时结构化名否则仅从 `error.message` 精确匹配 `duplicate key value violates unique constraint "shipment_no_unique"` 提取 `shipment_no_unique`，识别不到则 `undefined`；页面不接触原始 DB 错误文本 |
| 59 | 仅 `shipment_no_unique` 的 `23505` 可重试 | `createPlannedShipment` 仅当 `meta.dbCode === '23505' && meta.constraint === 'shipment_no_unique'` 两条件同时满足才重新生成 `seq6` 重试；`23505` 但约束名非 `shipment_no_unique` / 无法确认约束名 / FK / CHECK / 权限 / 网络 / `tracking_event` / `shipment_item` / `P0001` / 不可解析等其它错误均不重试；总调用 `repository.create()` 最多 3 次，每次重生成 `seq6`，第三次仍冲突仅返回"生成计划单号失败，请重试"，不暴露 PG 原文 |
| 60 | `cancelPlannedShipment` 固定走 Repository | V1 仅 `shipmentRepository.cancelPlannedShipment(shipmentId)`，不存在 `cancel_planned_shipment` 写 RPC；UPDATE 仅 `SET cancelled_at` |
| 61 | 并发取消只有一个成功 | 两请求同毫秒取消同一 booking，仅一个 `UPDATE` 命中 1 行成功，另一个命中 0 行返回"该计划已取消"，不重复写、不报错 |
| 62 | 读取链路 | 列表页 Server Component 直接经 Repository 调 `get_replenishment_suggestions`，链路为 Server Component→Repository→RPC→RLS；常规只读读取不过 Server Action |
| 63 | `inventory` 行存在且 `quantity=0` | `on_hand=0`，正常计算补货建议（见 #24） |
| 64 | 完全无 `inventory` 行的 variant | 不生成合成 warehouse 建议、不参与补货列表（避免 variant×warehouse 笛卡尔积与虚假建议） |
| 65 | `product_id = NULL` | 经 LEFT JOIN `product` 保留 variant，仍参与计算，`product_name` 可为 NULL |
| 66 | `p_variant_id` 多仓库返回 | 同一 variant 在多个可见仓库可返回多行；仅当同时传 `p_warehouse_id` 才限定到单仓，不承诺固定单行 |
| 67 | Migration 顺序 | 执行固定 `warehouse 参数(A) → cancelled_at(B) → forecast_stockout(C) → 读取 RPC(D)`，回滚 `D→C→B→A`；不得遗漏共享函数 Migration |

### 9.1.4 v8 新增必测（Codex 复审收口，3 项修复 + 测试补强）

| # | 场景 | 期望 |
|---|------|------|
| 68 | `ShipmentError` 位置与兼容性 | `ShipmentError` 仍从 `src/features/shipments/repository.ts` 导出；不在 `types.ts` 重复定义；原有两参数构造 `new ShipmentError(message, code)` 调用继续通过；第三参数 `meta` 可选 |
| 69 | 精确提取 `shipment_no_unique` | 模拟 `code = 23505`、`message = duplicate key value violates unique constraint "shipment_no_unique"`；期望 `meta.dbCode = '23505'`、`meta.constraint = 'shipment_no_unique'`、触发重新生成 `seq6` |
| 70 | 其他唯一约束不得重试 | 模拟 `code = 23505`、但 `message` 指向其他约束（如 `external_ref_unique`）；期望不重试、按普通创建失败处理、不向页面暴露数据库原文 |
| 71 | 无法识别约束名不得重试 | 模拟 `code = 23505`、`message`/`details` 中无可确认约束名；期望 `constraint` 保持 `undefined`、不重试、不得仅凭 `23505` 重试 |
| 72 | 重试次数边界 | 模拟 `shipment_no_unique` 连续冲突：对 `repository.create()` 总调用次数最多为 3、每次使用不同 `seq6`、第三次仍冲突后返回"生成计划单号失败，请重试"、不发生第四次调用 |

> 验收条目合计：§9.1（25）+ §9.1.1（20）+ §9.1.2（12）+ §9.1.3（12）+ §9.1.4（5）= **74 条**。

### 9.2 权限与安全

- operator 看不到无授权仓库的 variant；**operator 不能创建或取消任何计划发货（V1 仅 admin 可创建/取消），仅能查询已授权仓库的补货建议结果**；方案 A（operator 路径）未经 Rall 确认不实现。
- 所有 RPC：`SECURITY INVOKER` + `auth.uid()` 绑定 + `REVOKE PUBLIC, anon` + `GRANT authenticated`。
- 读取：Server Component → Repository → Supabase RPC → PostgreSQL RLS；写入：Client Component / 表单 → Server Action → Repository → Supabase → PostgreSQL RLS。Client Component 不直连数据库；常规只读读取不强制过 Server Action。

---

## 10. 与现有模块的关系（不冲突）

- **关注产品动态**：补货建议**不嵌入**关注区（V1 独立页）；二者数据可并行展示但不混淆。
- **断货告警**：保留为预警层，补货建议为行动层。
- **在途管理**：复用 `shipment` / `shipment_item` + 新增 `get_in_transit_detail`；现有 `get_in_transit_confirmed_aggregate` 保留供在途库存卡片。
- **P0 喜运达**：本引擎**不依赖 P0**（ETA 来自 `shipment.estimated_arrival` 人工录入；P0 v8 不写 `estimated_arrival`、不建 `shipment_item` 数量映射，故承运商外部轨迹暂不计入本引擎）。P0 解锁的是作战室外部轨迹可见性，非 P1 计算前置。
- **同步模块**：`daily_sales` / `estimated_days` 由 BigSeller 同步覆盖写（00014），不重复实现。

---

## 11. 待 Rall 确认清单（权限变更须显式拍板）

1. ~~`buffer_ratio` 默认值 0.25 / `target_cover_multiplier` 1.5~~ → **已确认**
2. ~~计划发货是否复用 `shipment`（方案 A）~~ → **v2/v3 已定为复用 `shipment`，删除 `planned_shipments`**
3. ~~ETA 为 NULL 的计划发货是否允许~~ → **v2/v3 禁止（创建时强制 ETA）**
4. **【V1 已确定：仅 admin】计划发货创建/取消向 operator 开放为后续增强（待 Rall 确认）**：
   - **V1 仅 admin 创建/取消（已确定，非待拍板）**：复用现有 `create_shipment_transactional`（admin-only）+ `shipmentRepository.cancelPlannedShipment`（admin-only），零新增 RPC，不碰现有 admin 规则，**可直接进 Migration 设计 + Claude 实施**。
   - 方案 A（operator 增强，**[待 Rall 确认]**）：仅当 Rall 明确确认开放 operator 自录，才新增 `create_planned_shipment` / `cancel_planned_shipment` RPC（operator 仅 assigned 仓）+ 对应权限/跨仓/审计测试。
   - **在 Rall 确认前，Claude 不得实现 operator 创建或取消路径、不得修改 `create_shipment_transactional` 的 admin 规则、不得改动既有 shipment RLS。**
5. ~~计划发货 `shipment_no` 生成规则~~ → **v6 已定：Server Action 生成唯一内部单号 `PLN-{country}-{warehouse_id前8位}-{YYYYMMDD}-{seq6}`（ASCII，总长 ≤ 50，满足 NOT NULL+UNIQUE，禁止前端传入；`country` 服务端 `upper(trim)` 规范化且仅 TH/ID/MY/PH/VN/CN，非法返回中文错误）**

---

## 12. 取证附录（Codex 12 项逐条核实结论）

本轮修订前，巴蒂读取仓库真实代码核实 Codex 每项：

- **一（planned_shipments 重复）**：`00001_initial_schema.sql` 证实 `shipment` 含 `status` 枚举（含 `booking`）、`estimated_arrival date`、`created_by→profiles(id)`；`shipment_item` 含 `quantity` / `warehoused_quantity`。`src/features/shipments/actions.ts:42` `createShipment` 为 **Admin 专属**；`create_shipment_transactional`（00018）原始允许 admin/operator，但 `00020` 已收紧为仅 admin。→ 删 `planned_shipments`，复用 `shipment`；**V1 默认方案 B（admin-only）创建/取消计划发货**，operator 自录为[待 Rall 确认]方案 A 增强（不默认实现）。
- **二（ETA 链路）**：`00027_overseas_inventory_performance_rpc.sql` 证实 `get_in_transit_confirmed_aggregate` 仅返回 `warehouse_id/variant_id/in_transit_quantity/confirmed_quantity`，无 `shipment_id/estimated_arrival/remaining/status`。→ 新增 `get_in_transit_detail`。
- **三（循环依赖）**：v1 §4 确为"先全量估算断货日再反推有效补给"。→ 改写为 §4.3 事件模拟。
- **四（生命周期）**：`shipment` 无 `planned_ship_date` / 取消标记。→ 复用 `booking` + 新增 `cancelled_at`，强制 ETA。
- **五.1（created_by）**：v1 误写 `auth.users`；`00001` 证实项目用 `profiles(id)`。随删表消除，并立规今后新表 `created_by→profiles(id)`。
- **五.2（warehouse 参数）**：`00001` 证实 `warehouse` 仅有 `id/name/country/type/is_active/sync_url/last_sync_at/created_at`，**无** `buffer_ratio/target_cover_multiplier/updated_at`。→ Migration A 补齐 + 完整约束 + 回滚。
- **五.3（variant_daily_snapshot）**：v1 建空表无写入/读取。→ V1 不建，延期 V2。
- **六（daily_sales/lead_time）**：`00014` 证实 `inventory.daily_sales NUMERIC NULL`、`warehouse.lead_time_days INTEGER NULL` 均存在。→ §4.6 边界写死。
- **七（在途/已确认口径）**：`00026` 证实 `shipment.bigseller_absorbed_at timestamptz` 存在；`00027` 的 `confirmed_agg` 口径（`customs` 或 `warehoused AND bigseller_absorbed_at IS NULL`）可对齐。→ §4.7 复用。
- **八（RPC 安全）**：`00027` / `00037` 证实现有 RPC 均为 `SECURITY INVOKER` + `auth.uid()` 绑定 + `REVOKE PUBLIC, anon`。v1 写 `security definer` 与现有范式不符。→ 改为 INVOKER 对齐。
- **九（性能）**：v1 RPC 无分页/过滤/上限。→ §4.9 补齐。
- **十（前端落位）**：v1 同时写关注区子区块 / 独立页 / 详情卡片。→ V1 唯一入口 = `/dashboard/replenishment` + 详情卡片，不入关注区。
- **十一（必测）**：v1 仅 4 条。→ §9.1 补 25 条。
- **十二（总纲）**：`DIS-实施总顺序方案.md` P1 段同步（见总纲修订）。

### 12.1 v3 实施阻塞复审取证（Codex 8 项逐条核实）

本轮 v3 修订前，巴蒂读取仓库真实代码核实 Codex 每项：

- **一（operator 创建冲突）**：`repository.ts:522-551` 的 `create()` 调 `create_shipment_transactional`；`00020:46-50` 仅 admin 可调用；`:52-55` 强制 `shipment_no` 非空；`shipment_no` 列（00018）NOT NULL+UNIQUE，无现成生成函数；计划发货表单无 `shipment_no`。→ 属实。v3 改默认方案 B（admin 复用现有链路 + 生成内部单号），方案 A 待 Rall 确认。
- **二（取消无写入路径）**：`repository.ts:584-597` 的 `update()` 仅更新 10 字段（shipment_no/purchase_order_no/vessel_name/voyage_number/origin_port/destination_port/country/warehouse_id/estimated_arrival/note），**不含 `cancelled_at`**。→ 属实。v3 新增 `shipmentRepository.cancelPlannedShipment()` 仅写 `cancelled_at`。
- **三（net_demand 晚到仍抵扣）**：v2 §4.3 `effective_inbound = 全部 ETA 非 NULL 的 remaining 总和`，与验收"ETA 晚于断货日不抵扣"矛盾（库存0/日销10/5天断货/ETA30天1000件会把建议压成0）。→ 属实。v3 改先模拟定断货日、再筛 `eta ≤ est_stockout_date` 的有效补给。
- **四（待入账未落地）**：v2 §4.7 声明"待入账补给/confirmed_inbound"，但 §4.3 inbound 只筛未 warehoused、§6.2 无 `confirmed_inbound` 输出。→ 属实。v3 采用方案 A（V1 只算未入仓 remaining，删除 confirmed_inbound/待入账口径）。
- **五（RPC 缺 p_variant_id）**：v2 §6.2 输入无 `p_variant_id`，但 §7.2 调用了。→ 属实。v3 §6.2 补 `p_variant_id uuid DEFAULT NULL` 并写清过滤与权限。
- **六（operator 权限未确认）**：v2 §11 写"v2 假定 operator 开放"，属未决权限变更。→ 属流程约束（Rall 要求显式确认）。v3 §11 改为决策项，默认方案 B，方案 A 待 Rall 拍板。
- **七（Repository 归属错）**：v2 §4.5 误写 `updateWarehouseParams` 经 `shipmentRepository`。→ 属实。v3 改 `warehouseRepository.updateReplenishmentParams()`。
- **八（代码同步范围缺失）**：v2 未列 Migration 后须同步的 TS 类型/Repository 文件。→ 吸收。v3 §8.5 明确列出 §8.5 文件清单。

### 12.2 v4 终审复审取证（Codex 4 项逐条核实）

本轮 v4 修订前，巴蒂再次读取方案全文，核实 Codex 终审 4 项：

- **一（待入账补给旧描述残留）**：grep 方案全文，确认 §4.2（原 L103）、§4.4（原 L203）、§6.1（原 L342-344）仍含"`customs`/warehoused 的 `warehoused_quantity` 计入待入账补给""confirmed_inbound""待入账补给 = 未吸收部分"等旧语义。→ 属实。v4 删除 `get_in_transit_detail` 对 `warehoused_quantity` 的返回，统一口径为"仅未入仓 `remaining` 计入，warehoused 一律不计"。
- **二（ETA=断货日边界）**：§4.3 伪代码 `IF cur <= consume THEN BREAK` 在 `cur == consume`（如库存 50/日销 10/ETA 5 天）时提前判断货，导致 ETA 当天补给未补入，与 §9.1.1 #33"ETA 当天计入抵扣"矛盾。→ 属实。v4 改 `IF cur < consume`，`cur == consume` 时先扣消耗再补入。
- **三（lead NULL 输出契约）**：§4.3 先算 `target_stock := round(ds*lead*cover)` 与 `net_demand`，再判 `IF lead IS NULL`，导致 lead 为 NULL 时两字段为 NULL，与 §6.2 `integer` 输出契约冲突。→ 属实。v4 提前在 `lead IS NULL OR lead <= 0` 分支置 `target_stock=NULL`/`net_demand=0`/`suggest_qty=0`/`latest_order_date=NULL`/`urgency='data_incomplete'`，`est_stockout_date` 在 `daily_sales` 有效时仍按消耗推算。
- **四（shipment_no 唯一性）**：§7.3 原写 `PLN-{warehouse_code}-{YYYYMMDD}-{seq6}`，`seq6` 仅随机生成、无冲突处理，非绝对无碰撞。→ 属实。v4 明确方案 C：服务端生成 + 唯一约束兜底 + 自动重试 ≤3 次 + 中文错误，禁止前端传入，并补并发创建/注入冲突测试（§9.1.1 #28a/#28b）。v5 进一步修正：`warehouse_code` 字段不存在（`warehouse` 表仅 `id/name/country`），改 ASCII 规则 `PLN-{country}-{warehouse_id前8位}-{YYYYMMDD}-{seq6}`，并确认 `shipment_no` 现有约束仅 NOT NULL+UNIQUE、无字符集 CHECK（字符集由生成规则保证）。

---

### 12.3 v5 → v6 六终终审复审取证（Codex 4 项逐条核实）

本轮 v6 修订前，巴蒂读取仓库真实代码核实 Codex 六终终审 4 项：

- **一（ETA 事件模拟重复扣减）**：§4.3 `inbound` 返回逐 shipment 行（`SELECT s.id, s.estimated_arrival, ...`），事件模拟 `FOR EACH (eta, rem) IN inbound` 对每行重算 `days := eta - today` 并重扣 `ds * days`。同一 `estimated_arrival` 有多条 shipment 时，`days` 对同一日期差被重复计算、销量被重复扣减（如两 shipment 均 ETA 明天、库存 10、日销 10 → 第二条可能被误判断货）。→ 属实。v6 改 inbound CTE `GROUP BY eta` + `SUM(remaining)` 聚合为单条事件，事件模拟用游标 `cursor_date` 推进，只扣减一次日期差。
- **二（country 未规范化）**：`warehouse.country`（`00001:101`）为 `text NOT NULL`、**无国家代码 CHECK**；而 `shipment.country`（`00001:138`）有 `CHECK (country IN ('TH','ID','MY','PH','VN','CN'))`、`product_variant.country`（`00001:89`）同。故 §7.3 直接把 `warehouse.country` 拼进 `shipment_no` 且未规范化，一旦仓库国家为中文/小写/异常字符串，既破坏单号 ASCII 契约，又令 `create_shipment_transactional` 插入 `shipment.country` 触发 CHECK 失败。→ 属实。v6 改服务端 `upper(trim(warehouse.country))` + 仅允许 6 码 + 中文错误，单号用规范化码。
- **三（误传 status）**：`CreateShipmentData`（`types.ts:102-114`）字段为 `shipmentNo/purchaseOrderNo/vesselName/voyageNumber/originPort/destinationPort/country/warehouseId/estimatedArrival/note/items`，**无 `status` 字段**；`create_shipment_transactional`（`00020:23-35`）11 参数列表亦**无 `status`**，`INSERT`（`00020:69-77`）未写 `status`；`shipment.status`（`00001:140`）`DEFAULT 'booking'`。→ 属实。v6 改不向 `CreateShipmentData`/RPC 传 `status`，依赖 DB 默认 `booking`，read-back 校验。
- **四（operator RLS 测试边界）**：`operator_insert_shipment`（`00001:386-388`）`FOR INSERT WITH CHECK (get_user_role() = 'operator')`、`operator_update_shipment`（`00001:390-393`）同，**均只判角色、无 warehouse assignment 过滤**。→ 属实。§9.1 #19 原"operator 写入未授权仓库被 RLS 拒绝"与真实 RLS 不符；v6 改为测试 operator 调 admin-only RPC/Server Action 被拒，并将既有宽 RLS 记为技术债，本轮不改既有 RLS。

*本方案为设计文档，落地由 Claude 执行（协作约定：巴蒂出方案 → Codex 审查 → Claude 落盘）。**本轮 v8 修订仅修订本方案文档，未修改任何源码 / Migration / 数据库 / 测试 / 配置文件 / 其他方案 / 总纲 / current-state / current-task。** Codex 复审收口 3 项（ShipmentError 真实位置纠正 repository.ts / PostgreSQL 约束名确定性提取与重试边界 / V1 不新增 shipment_no 字符集 CHECK）已逐条取证核实并修复，原 v7 通过的补货核心公式、Migration 顺序、inventory 驱动表、取消唯一路径、读取链路、69→74 条验收等均保持不变；修订后方案待 Codex / Rall 终审通过，通过后再交 Claude 进入 Migration 设计 + 实施。*
