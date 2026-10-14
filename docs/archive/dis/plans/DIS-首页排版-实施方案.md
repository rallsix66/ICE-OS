> 历史归档（2026-10-13）：原位置 `docs/design/dis-plans/DIS-首页排版-实施方案.md`。保留用于旧实现与验收追溯，不作为当前任务或执行授权；现役入口见 [归档索引](../README.md)。

# DIS · 首页决策看板重构 — 实施方案（v8 · 首页排版修订）

> 状态：**v6 经 Codex 复审发现 4 个收口问题（健康度 RPC 未排 archived、旧在途数据源、Header 契约不彻底、章节编号错位），v7 已逐项修订；v8 继续修正 TypeScript null 契约、未来 7 日到港真实总数来源、abandoned 错误语义，待 Codex 最终确认（仅改方案，不实施、不建 Migration、不交 Claude 落盘）** ｜ 作者：巴蒂 ｜ 修订：2026-07-12（v4：Rall 确认单屏紧凑整页；v5：依 Codex 复审 17 类阻塞 + 2 类口径修正逐项取证修订；v6：依 Codex 终审 9 类收口固定为唯一实施契约，验收扩至 50 条；**v7：依 Codex 复审 4 个问题——① 健康度 RPC 补当前用户 archived Variant 过滤 / ② 首页在途数据源改用 P1 get_in_transit_detail（弃旧 getInTransitByVariant）/ ③ 共享 Header 契约彻底固定（删除临场修改入口）/ ④ 取证附录子章节编号 18.x→19.x 修正，验收扩至 56 条**；**v8：弃用 getInTransitDetail 调用的 null 实参（改无参调用，Repository 内映射 RPC null）/ 未来 7 日到港总数改用 getInTransitDetail 全量去重计数（不取 getUpcomingArrivals Top4 展示列表长度）/ 修正吸收语义（统一 bigseller_absorbed_at IS NOT NULL，删除不存在的 abandoned 字段误用），验收扩至 59 条**）
> 协作约定：巴蒂出方案 → Codex 审查 → Claude 落盘；巴蒂不直接改 overseas-inventory 实现代码。本文件属「方案/设计层」产出。
> 项目路径：仓库根目录（含 src/、supabase/、docs/ 的 inventory-dashboard 仓库根；本文档位于 docs/design/dis-plans/ 下，根目录为其上三级。物理磁盘路径因机器而异，不硬编码）。

---

## 0. 方案定位与实施顺序

### 0.1 产品方向保留，方案定位后移
首页「单屏决策型 Dashboard」的产品方向**保留**；但当前方案存在实施级阻塞，且本方案应在 **P0、P1、P7 全部落地后**实施——首页可直接复用已落地的补货入口、全球库存总览入口与统一风险口径，无需创建「待上线」占位按钮，也**不在首页重复计算 P1/P7 指标**。

推荐顺序：

```
P0 喜运达物流轨迹 API 接入
  → P1 预测式补货引擎
    → P7 全球库存总览 / 作战室
      → 首页决策看板重构（本方案）
```

### 0.2 v4→v5 修订总表（19 类问题逐项处理）
| # | v4 问题（Codex 判定） | v5 处理 | 取证 |
|---|---|---|---|
| 1 | Migration 00038 已与 P0 喜运达冲突 | 健康度 RPC 预留编号改为 **00047**，并写明顺延与回滚规则（§2） | supabase/migrations 最新 00037；P0/P1/P7 已预留 00038–00046 |
| 2 | 库存健康度误用 safety_stock 字段（原误归 product_variant） | 改为 inventory→product_variant→product，**safety_stock 来自 product**（§4.1） | get_overseas_stats(00027) 用 `p.safety_stock`（LEFT JOIN product）；product_variant 无 safety_stock 列 |
| 3 | 健康率只减低库存，漏缺货与未匹配 | 固定四态分类 + `health_rate = normal / (normal+low+out_of_stock) * 100`，unmatched 独立（§4.2–4.3） | 与 P7 v8 口径一致 |
| 4 | 新 RPC 权限设计不完整 | 改为 SECURITY INVOKER + 完整身份/启用/角色/仓库集合校验链（§3.1） | 对齐 get_overseas_stats(00027) 的 INVOKER 范式 |
| 5 | 近期到港遗漏 arrived 状态 | 状态固定 `('departed','arrived','customs')`（§5.1） | shipment.status CHECK(00001) 含 arrived |
| 6 | shipment 无 quantity/product_name，返回契约不成立 | 改为「每个 shipment 一行」，返回 shipment_id/shipment_no/warehouse_id/.../remaining_quantity/item_count/itemNames[]（§5.2/§5.4，v6 改固定 itemNames[]） | shipment_item(00001) 有 quantity/warehoused_quantity；shipment 无 quantity/product_name |
| 7 | Operator shipment RLS 无 warehouse 隔离，Repo 须显式过滤 | Repository 先取 accessibleWarehouseIds 再显式 `warehouse_id IN (...)`，不单靠 RLS（§5.3） | operator_select_shipment(00015) 仅校验角色+warehouse_id；Repo 防御式二次过滤 |
| 8 | upcoming-arrivals 自调 Repo 与 page Promise.all 矛盾 | 统一为 page 编排后传 props，子组件不触 Repository（§6/§7） | page.tsx 现有 Promise.all + 子组件原自调冲突 |
| 9 | 低库存组件最多 15 条非 Top5 | 方案 A：LowStockSummarySection 加 `limit?`(默认15)/`compact?`，首页传 limit=5（§8） | low-stock-summary-section.tsx:40 `MAX_DISPLAY = 15` |
| 10 | 关注产品无 Top4 紧凑 | 方案 A：FollowedProductsSection 加 `limit?`/`compact?`，首页传 limit=4（§8） | followed-products-section.tsx 无 limit/compact |
| 11 | 顶栏「数据导出」无导出对象 | 删除全局导出；导出依赖具体页筛选（海外库存页已有 CSV）（§9） | — |
| 12 | 保留「补货建议待上线」死按钮 | 删除；改为跳转 /dashboard/replenishment（P1 已先实施）（§9/§11） | — |
| 13 | 暗色主题影响全站，非半天小改 | 从本方案拆出，另立「全站主题改造」独立方案（§13） | 根 layout 未挂主题 Provider；globals.css 无 .dark |
| 14 | 「≤780px 不滚动」无 viewport 定义 | 改为明确 viewport 与断点，移动端/200% 允许滚动（§15） | Dashboard layout `main overflow-auto` |
| 15 | 全量测试约 800 不实 | 真实质量门 test/lint/build/diff-check，基线 3524/3524（实施时取最新）（§17） | package.json 无 typecheck；vitest 实测 |
| 16 | package.json 无 typecheck | 删除 typecheck 要求，改用 lint/build（§17） | package.json scripts 仅 test/lint/build |
| 17 | 文件清单遗漏类型/测试/组件改动 | 重写文件清单，补全 RPC 类型、Migration/Repo/页面/组件测试（§16） | — |
| 18 | 同步异常直接指 sync_run 无调用链 | 复用 getSyncWarehouseOverview()→get_sync_warehouse_overview，不直查 sync_run（§10） | get_sync_warehouse_overview(00032) 已存在 |
| 19 | 紧急行动 KPI 用占位/假数 | 去占位，复用 P1/P7 已落地能力或仅展示 low/out_of_stock/同步异常+跳转（§11） | — |

### 0.3 v5→v6 终审收口总表（9 类未闭合点逐项固定为唯一实施契约）
| # | v5 残留问题（Codex 终审） | v6 固定处理 | 落点 |
|---|---|---|---|
| 1 | SECURITY INVOKER 仍写「优先」，保留 DEFINER 备选 | 删除所有「优先/若坚持 DEFINER」措辞；**SECURITY INVOKER 为唯一实现** | §3.1 |
| 2 | 首页查询仍写 getOverseasStats 或健康度 RPC「二选一」 | 删除二选一；固定 6 项 Promise.all 清单，健康 KPI 直接用 getWarehouseHealthOverview | §6 |
| 3 | 同步异常定义仍写「例如/若现有契约不足」 | 固定唯一公式：latestDryRun/latestRealWrite 的 failed 状态决定，不直查 sync_run | §10 |
| 4 | 紧急行动 KPI 仍保留两套可选来源 | 固定 V1 唯一数据源：out_of_stock_count / low_stock_count / sync_error_count + 跳转 | §11 |
| 5 | summary 曾用含义不明的 total_skus（历史问题，非当前契约）与逐仓计数粒度不一致 | 统一为 **inventory_position 粒度**：summary 用 distinct_variant_count + total_position_count；四态按 position 互斥计数 | §3.1 / §4.2–4.3 |
| 6 | 近期到港未明确只保留 remaining_quantity > 0 | 固定有效 item（remaining>0）与整单排除（remaining_quantity<=0 不占 Top4） | §5.2–5.3 |
| 7 | cancelled_at 仍写「P1 落地后加」 | 本方案在 P1 后实施，改为**强制条件** `AND cancelled_at IS NULL` | §5.1 |
| 8 | 每个区块都要求 loading，但统一 Promise.all 返回前子组件不会单独渲染 | 删除子组件独立 loading 要求；新增 `dashboard/loading.tsx` 页面级 Skeleton，区块只处理 data/empty/error/no-permission | §6 / §10 |
| 9 | 仓库详情弹层与紧凑组件曾留临场选择（历史问题，非当前契约） | 删除弹层二选一与临场新建紧凑组件选项；仓库详情复用现有 shadcn Dialog；Top4·Top5 固定方案 A | §8 / §12 / §16 |

### 0.4 v6→v7 复审收口总表（Codex 终审 4 个问题逐项修订）
| # | v6 残留问题（Codex 复审） | v7 固定处理 | 落点 |
|---|---|---|---|
| 1 | 健康度 RPC 未排除当前用户已归档 Variant，首页健康 KPI 与低库存 Top5 口径不一致 | 在 base/inventory_position 集合中强制 `LEFT JOIN user_variant_preference uvp_arch ... preference_type='archived'` + `WHERE uvp_arch.variant_id IS NULL`；过滤置于四态分类、逐仓聚合、summary 聚合之前；与现有 get_overseas_stats / getLowStock 对齐 | §3.1 / §4.2–4.5 |
| 2 | 首页仍调用旧 `getInTransitByVariant()`（仅排除 warehoused，不排 cancelled/已被 BigSeller 吸收/remaining），P1 加 cancelled_at 后会把已取消计划计入在途 | 首页在途数据源改用 P1 `get_in_transit_detail`：`shipmentRepository.getInTransitDetail(user.id)`（无筛选调用，可选 string 字段不传 null，Repository 内映射 RPC `p_warehouse_id/p_variant_id = null`）；KPI 固定为「ETA 已知的计划及在途」，聚合 remaining/SKU/Shipment/未来7日到港真实总数（未来7日到港总数由 getInTransitDetail 全量有效行按 shipmentId 去重计数，非 getUpcomingArrivals Top4 展示列表长度） | §5 / §6 / §11 |
| 3 | 文件清单仍写「若最终需要修改 Header」，与「默认不修改 Header」契约不够彻底 | 删除临场修改入口；彻底固定不修改 `dashboard-header.tsx` / `sidebar-nav.tsx` / `layout.tsx` / `globals.css`；快捷动作只存在于首页内容区；全局 Header 改造须另立独立方案 | §9 / §16 |
| 4 | 取证附录父章节为 §19，子标题仍编号 18.1–18.9 | 子章节统一改为 19.1–19.9 | §19 |

---

## 1. 修订范围与铁律
- **本轮仅修改本方案文档** `docs/design/dis-plans/DIS-首页排版-实施方案.md`。
- 严禁修改：其他四份方案、总纲、current-state.md、current-task.md、.claude/context-status.json、src/ 任何源码、supabase/migrations/ 任何文件、数据库、测试、package.json、vercel.json、环境变量及其他配置。
- 本轮**只修订方案，不实施代码、不创建 Migration、不交 Claude 开工**。
- 本方案**不重新实现 P1 补货公式、不重新实现 P7 断货预测公式**；首页指标优先复用 P1/P7 已落地能力。

---

## 2. Migration 编号修正
- 仓库最新 Migration 为 **00037**（supabase/migrations 实测）。已定稿方案预留：
  - P0：00038、00039、00040
  - P1：00041、00042、00043、00044
  - P7：00045、00046
- 首页健康度 RPC 的方案预留编号改为 **`00047_dashboard_warehouse_health_overview.sql`**，**不得继续使用 00038**（与 P0 喜运达冲突）。
- Claude 实施前**必须重新检查 supabase/migrations/ 最新连续编号**；若 00047 已被占用，按当时最新编号**顺延**，禁止覆盖或修改任何已执行 Migration。
- Migration 必须同时包含：
  - `CREATE FUNCTION ...`（不新增/修改表结构）
  - `REVOKE EXECUTE ON FUNCTION ... FROM PUBLIC`
  - `REVOKE EXECUTE ON FUNCTION ... FROM anon`
  - `GRANT EXECUTE ON FUNCTION ... TO authenticated`
  - 对应回滚说明：`DROP FUNCTION` 精确签名（含参数类型）

---

## 3. 数据层改动（2 处新增）

### 3.1 RPC：`get_warehouse_health_overview(p_user_id uuid) RETURNS jsonb` — NEW（00047）
- 落在新 migration 文件 `00047_dashboard_warehouse_health_overview.sql`（CREATE FUNCTION，**不改表结构**）。
- 驱动表为 `inventory`，经 `product_variant` 再 JOIN `product` 取 `product.safety_stock`（**非 product_variant 上的 safety_stock**）。
- **计算粒度固定为 `inventory_position` = `warehouse_id + variant_id` 的库存位置**（同一 variant 在多个仓库有多条 inventory 行，即多个 position）。
- **当前用户归档 Variant 过滤（强制）**：在 base/inventory_position 集合中 `LEFT JOIN public.user_variant_preference uvp_arch ON uvp_arch.variant_id = inventory.variant_id AND uvp_arch.user_id = p_user_id AND uvp_arch.preference_type = 'archived'`，并 `WHERE uvp_arch.variant_id IS NULL`。该过滤发生在四态分类（§4.2）、逐仓聚合与 summary 聚合**之前**；被当前用户归档的 Variant 不计入 `distinct_variant_count` / `total_position_count` / `total_quantity` / 四态计数 / 逐仓健康状态计数（与现有 `get_overseas_stats` / `getLowStock` 口径对齐）。归档是用户级偏好：用户 A 归档不影响用户 B；Admin / Operator 各自仅排除**自己**归档的 Variant。不修改 `user_variant_preference` 表或 RLS；不把 `favorited` 当作过滤条件。
- `warehouse.type = 'overseas'` 且 `warehouse.is_active = true`；按 `warehouse_id` 聚合；不生成无 inventory 行的虚拟 SKU；仓库数量动态返回，不写死「4 仓」。
- 返回固定为 **JSONB 信封**（summary 与逐仓数组统一使用 inventory_position 粒度，不再使用含义不明的 `total_skus`）：

```json
{
  "summary": {
    "distinct_variant_count": 0,
    "total_position_count": 0,
    "normal_count": 0,
    "low_stock_count": 0,
    "out_of_stock_count": 0,
    "unmatched_count": 0,
    "health_rate": null,
    "total_quantity": 0
  },
  "warehouses": [
    {
      "warehouse_id": "...",
      "warehouse_name": "...",
      "country": "TH",
      "total_position_count": 0,
      "normal_count": 0,
      "low_stock_count": 0,
      "out_of_stock_count": 0,
      "unmatched_count": 0,
      "health_rate": null,
      "lead_time_days": null
    }
  ]
}
```

- **JSONB 契约口径**：`summary` 与 `warehouses[]` 均基于「当前用户可见、未归档、active overseas warehouse 的 inventory_position」生成；已归档 Variant（见上）在任何层级均不出现。
- `total_quantity = SUM(inventory.quantity)`（可见范围内库存总件数，作为库存健康 KPI 辅助数字），随 summary 一并返回，不因此额外调用 getOverseasStats。
- **空数据时也必须返回完整 `summary`（各计数 0、`health_rate` null、`total_quantity` 0）和 `warehouses: []`**，不得返回 NULL 或让页面报错。
- 权限（**唯一实现：`SECURITY INVOKER`，`SET search_path = ''`**）：RPC 内必须校验
  1. `auth.uid() IS NOT NULL`；
  2. `p_user_id IS NOT NULL`；
  3. `p_user_id = auth.uid()`；
  4. `profiles.is_active = true`；
  5. 角色必须为 `admin` 或 `operator`；
  6. Admin 可见全部 active overseas warehouses；
  7. Operator 可见 `get_assigned_warehouse_ids()` ∩ active overseas warehouses；
  8. `p_user_id` 不得来自 Client / URL / searchParams；
  9. `REVOKE` PUBLIC；
  10. `REVOKE` anon；
  11. `GRANT` authenticated；
  12. 不关闭 RLS、不新增宽松 RLS。
- 本方案正文**不再出现「INVOKER / DEFINER 二选一」**；SECURITY INVOKER 为唯一契约。
- 健康率与状态分类口径见 §4。

### 3.2 Repository 方法：`getUpcomingArrivals(userId, days = 7)` — NEW
- 文件：`src/features/shipments/repository.ts`。
- 完整契约与查询口径见 §5。

---

## 4. 库存健康度数据口径

### 4.1 字段归属（修正）
- 删除所有把 safety_stock 误归 product_variant 的用法。
- 真实关系：`inventory` → `product_variant` → `product`，`safety_stock` 来自 `product.safety_stock`。
- 取证：`get_overseas_stats`（00027:224）`LEFT JOIN public.product p ... p.safety_stock`；`product_variant` 不拥有 `safety_stock` 列（00001 中 safety_stock 定义在 product 表）。

### 4.2 固定状态分类顺序（按 inventory_position 粒度，与 P7 v8 一致）
1. `quantity = 0` → **out_of_stock**
2. `product_id IS NULL` 或 `match_status <> 'matched'` → **unmatched**
3. `quantity > 0` 且 `quantity <= product.safety_stock` → **low**
4. 其余 → **normal**

- 分类对象为**每条 inventory position（warehouse_id + variant_id）**，四态互斥计数。
- `distinct_variant_count` = 所有可见仓库中 `COUNT(DISTINCT variant_id)`（同一 variant 跨仓只计一次）。
- `total_position_count` = 所有可见 inventory position 数 = `normal_count + low_stock_count + out_of_stock_count + unmatched_count`。
- 上述「可见」包含当前用户**未归档**约束：已在 §3.1 经 `uvp_arch` 过滤排除的归档 Variant 不进入 `distinct_variant_count` / `total_position_count` / `total_quantity` / 任一四态计数 / 任一逐仓健康状态计数（即同一首页内健康 KPI 与低库存 Top5 口径一致，均不含当前用户已归档 Variant）。

禁止：
- 把 safety_stock 误用于 product_variant；
- 把 `unmatched` 当 `normal`；
- 用 `COALESCE(safety_stock, 0)` 把缺失安全库存误判为 normal/low；
- 把 `quantity = 0` 同时计入 low；
- 同一 inventory position 重复计数（四态互斥）；
- summary 与逐仓数组采用不同统计粒度（统一 inventory_position）。

### 4.3 健康率公式
```
health_denominator = normal_count + low_stock_count + out_of_stock_count
health_rate        = normal_count / health_denominator * 100
```
规则：
- `unmatched_count` 独立展示，**不计入健康分母，也不得视为健康**。
- `health_denominator = 0` 时，`health_rate` 返回 **NULL**，页面显示「暂无可评估数据」。
- 保留 `normal_count` / `low_stock_count` / `out_of_stock_count` / `unmatched_count` / `total_position_count` / `distinct_variant_count`，不得只返回 low_stock_count。
- `health_rate` 统一为 **0–100 数值**（百分数），不在此处用 0–1、彼处用百分数。
- 不得继续用含义不明的 `total_skus` 字段（已被 `distinct_variant_count` / `total_position_count` 取代）。

### 4.4 驱动表、仓库范围与排序
- `inventory` 为驱动表；`warehouse.type = 'overseas'`；`warehouse.is_active = true`；按 `warehouse_id` 聚合；不生成虚拟 SKU；仓库数量动态返回，**不得假设系统只有 4 个仓库**。
- 首页主卡展示**风险最高的前 4 个**可见仓库；完整列表在弹层展示。
- 仓库排序**固定**为：
  1. `health_rate` 非 NULL 优先；
  2. `health_rate` ASC；
  3. `out_of_stock_count` DESC；
  4. `low_stock_count` DESC；
  5. `warehouse_name` ASC。
  - `health_rate = NULL` 的仓库排在最后。
  - 空数组显示「暂无可评估仓库」，**不得显示 100% 健康**。

### 4.5 RPC 返回契约
固定为 §3.1 的 JSONB 信封（summary 用 `distinct_variant_count` + `total_position_count`，逐仓数组用 `total_position_count`）；空数据返回完整 summary（计数 0、`health_rate` null、`total_quantity` 0）+ `warehouses: []`。

---

## 5. 近期到港 `getUpcomingArrivals` 契约

### 5.1 状态口径
真实 `shipment.status` CHECK（00001:140）= `('booking','loading','departed','arrived','customs','warehoused')`。
「已发货、尚未入仓、未来 7 日到港」固定筛选：
```
status IN ('departed', 'arrived', 'customs')
AND estimated_arrival IS NOT NULL
AND estimated_arrival >= today
AND estimated_arrival <= today + 7 days
AND cancelled_at IS NULL
```
- 不含 `booking`、不含 `loading`、不含 `warehoused`。
- `cancelled_at IS NULL` 为**强制条件**（本首页方案明确在 P1 之后实施，cancelled_at 届时已存在，不再写「P1 落地后加」）。
- `partial_warehoused` 仅为 `tracking_event` 的事件状态，**非 shipment.status 合法值**，不得作为 shipment.status 筛选。
- ETA 为 date 语义，边界按 **UTC 日期**统一计算；**不在 SQL 字符串中动态拼接 interval**。

### 5.2 数据粒度
`shipment` 表无 `quantity`，也无 `product_name`，故原返回 `shipment_no, product_name, warehouse_name, estimated_arrival, quantity` 无法直接成立。固定为「**每个 shipment 一行**」，返回：
- `shipment_id`
- `shipment_no`
- `warehouse_id`
- `warehouse_name`
- `country`
- `estimated_arrival`
- `status`
- `remaining_quantity` = `SUM(remaining > 0 的 item remaining)`，其中 `remaining = quantity - warehoused_quantity`
- `item_count` = `remaining > 0` 的有效 `shipment_item` 数量
- `item_names`：`string[]`（由 Repository 返回，**不再返回预拼接、与语言绑定的摘要字符串**，固定返回 `itemNames: string[]`）；由展示组件生成「首项名称 + 等 N 项」

有效 `shipment_item` 定义：`remaining = quantity - warehoused_quantity`，**只保留 `remaining > 0`**：
- `remaining_quantity` 仅汇总 `remaining > 0` 的 item。
- `item_count` 仅计 `remaining > 0` 的 item。
- `item_names` 仅根据 `remaining > 0` 的 item 生成。
- `remaining = 0` 的 item 不计 `item_count`、不进入 `item_names`。

多商品 shipment **不得随便挑一个 product_name 冒充整单商品**；名称优先用 `product_variant.name`，为空时回退 `product_variant.sku`。

### 5.3 查询实现边界
固定 Repository 方法：
```typescript
getUpcomingArrivals(userId: string, days?: number): Promise<UpcomingArrival[]>
```
- `userId` 必须来自服务端 `const user = await requireActiveAuth();` 后的 `user.id`（与 P7 v8 auth 形状结论一致：`requireActiveAuth()` 返回 `CurrentActiveUser`，字段含 `id`，无 `.user` 包裹层）。
- `days` 默认 7，限制为 **1–30 的整数**。
- 先取得 `warehouseAccessRepository.getAccessibleWarehouseIds(userId)`；无可见仓库时直接返回 `[]`。
- shipment 查询**必须显式限制 `warehouse_id IN (accessibleIds)`**；不能只依赖当前 shipment RLS（防御式二次过滤）。
- Admin 同样经 `getAccessibleWarehouseIds` 取得 active overseas warehouse 集合。
- shipment 与 shipment_item / product_variant 数据**批量读取或一次嵌套读取**；禁止按 shipment 做 N+1 查询。
- **Top4 查询顺序固定**（禁止先盲取 Top4 再发现无有效 remaining，也禁止为补足 4 条循环发起查询）：
  1. 一次查询未来 `days` 日内候选 shipment，带出 shipment_item / variant 所需字段（或固定数量的批量查询）；
  2. 批量计算每单 `remaining_quantity` 与有效 `item_count`；
  3. **排除 `remaining_quantity <= 0` 的 shipment**（整单已无剩余数量不占 Top4 名额）；
  4. 按 `estimated_arrival ASC, shipment_no ASC` 稳定排序；
  5. 最后 `slice(0, 4)`。
- 数据库错误必须抛出明确 Repository 错误，由首页转为受控错误状态，**不泄露 SQL 原文**。

### 5.4 最终 `UpcomingArrival` 类型（固定，无二选一）
```typescript
interface UpcomingArrival {
  shipmentId: string;
  shipmentNo: string;
  warehouseId: string;
  warehouseName: string;
  country: string;
  estimatedArrival: string;
  status: 'departed' | 'arrived' | 'customs';
  remainingQuantity: number;
  itemCount: number;
  itemNames: string[];
}
```
- 展示组件依据 `itemNames` 生成摘要：0 项（不应出现，整单已排除）/ 1 项显示首项名称 / 多项显示「首项名称 等 N 项」。

---

## 6. 首页查询编排（page.tsx Server Component）
- `src/app/dashboard/page.tsx` 继续为 Server Component。
- 改用：
  ```typescript
  const user = await requireActiveAuth();
  ```
  不再保留「无 user.id 时仍调用 getOverseasStats」的旧兜底路径（Dashboard Layout 已阻止未登录及停用账号）。
- 所有独立查询放入**同一个 `Promise.all`**，保留每个区块独立错误处理。**固定清单（不再二选一，不再调用 getOverseasStats）**：
  - `inventoryRepository.getWarehouseHealthOverview(user.id)`（§3.1 新 RPC；首页库存健康 KPI 直接用其 `summary`，不额外调用 getOverseasStats，避免对 inventory 重复聚合）
  - `shipmentRepository.getInTransitDetail(user.id)`（复用 P1 `get_in_transit_detail` RPC；契约方法名 `getInTransitDetail(userId, filters?)`，无筛选时直接 `getInTransitDetail(user.id)`、可选 string 字段不传 null（Repository 内映射 RPC `p_warehouse_id = null` / `p_variant_id = null`），§5/§11；**不再使用旧 `getInTransitByVariant`**）
  - `inventoryRepository.getLowStock({ userId: user.id })`
  - `preferencesRepository.getFollowedVariantsBasic(user.id)`
  - `shipmentRepository.getUpcomingArrivals(user.id, 7)`（§5 新 Repo 方法）
  - `getSyncWarehouseOverview()`（§10 同步异常）
- **两项 shipment 读取职责不同，不得重复计数或相加**：
  - `getInTransitDetail`（复用 P1 `get_in_transit_detail`）：返回 **ETA 已知的全部有效计划/在途**（status ∈ booking/loading/departed/arrived/customs；`cancelled_at IS NULL`；`bigseller_absorbed_at IS NULL`；`estimated_arrival IS NOT NULL`；`remaining_quantity > 0`），首页从中聚合在途 KPI（§11）。其中「未来 7 日到港真实总数」`future_7d_arrival_count = COUNT(DISTINCT shipmentId WHERE status IN (departed,arrived,customs) AND estimatedArrival ∈ [today, today+7])`（UTC 日期，边界与 getUpcomingArrivals 契约一致；因 getInTransitDetail 已排除 cancelled/已被吸收/remaining<=0/ETA NULL，首页不再重复上述过滤，仅做 status 窗口 + ETA 日期窗口 + shipmentId 去重计数）。**该值可以大于 4**。
  - `getUpcomingArrivals(user.id, 7)`：仅 **未来 7 日、status ∈ departed/arrived/customs** 的 Top4 到港**展示**列表（§5）；其返回列表长度为展示列表长度，**不是未来 7 日到港总数**，不承担 KPI 总数统计。
  - 「未来 7 日到港」是「ETA 已知的计划及在途」集合的一个时间窗口子集；两者数量**不得相加**成「总在途」（§11）。当 `future_7d_arrival_count > 4`：KPI 显示真实总数，Top4 列表只展示前 4 条，可显示「还有 N 单」（`N = future_7d_arrival_count - 4`）并提供「查看全部」跳转入口；**不得**为取总数把 getUpcomingArrivals 改成无限制大列表，也**不得**用 Top4 展示列表长度冒充总数。
- 首页库存健康 KPI 直接使用 `getWarehouseHealthOverview` 的 `summary`（含 `total_quantity` 辅助数字）；**如页面需「库存总件数」，已在 RPC summary 明确增加 `total_quantity = SUM(inventory.quantity)`，不重新调用 getOverseasStats**。
- 任一查询失败**不得导致整个首页崩溃**；每个 Promise 须独立捕获错误并返回可区分结构，例如 `{ data: ..., error: string | null }`，**不得把 error 转成正常的 0 或空数组后丢失错误信息**（否则会把「查询失败」显示成「库存健康」）。
- 每个区块只处理四种呈现语义：**data / empty / error / no-permission**；**子组件不自行查询、不自行进入 loading 状态**（页面级 loading 由 `dashboard/loading.tsx` 提供，见 §10）。

> 新增 `src/app/dashboard/loading.tsx`：Promise.all 完成前由 Next.js 自动渲染页面级 Skeleton；纯展示子组件不自行实现 loading，只在拿到 props 后处理 data/empty/error/no-permission。

---

## 7. 组件调用链统一（冲突修正）
原方案同时写「page.tsx Promise.all 加载全部并传 props」与「upcoming-arrivals.tsx 是 Server Component 自行调 Repository」——两者冲突。统一为：
```
page.tsx
  → requireActiveAuth()
  → Promise.all 调 Repository / 既有读取封装
  → 结果作为 props 传给纯展示组件
```
- `UpcomingArrivals` 不自行访问 Repository。
- `WarehouseHealthCard` 不自行访问数据库。
- `KpiCards` 不自行访问数据库。
- Client Component 只负责交互与渐进动效。
- 页面或 Client Component **禁止直接调用 Supabase**。
- 同一查询**不得在 page.tsx 与子组件重复执行**。

---

## 8. 现有组件 Top4 / Top5 缺口补齐（固定方案 A）
真实代码：`LowStockSummarySection` 当前 `MAX_DISPLAY = 15`；`FollowedProductsSection` 当前无统一 Top4 紧凑模式。方案声称 Top5/Top4 但文件清单未含对应改动，无法实施。**v6 已固定方案 A（不复用临场新建组件），不保留「方案 A/B 二选一」**：

- `LowStockSummarySection`：新增可选 `limit?: number`（默认 15）、`compact?: boolean`（默认 false）。
- `FollowedProductsSection`：新增可选 `limit?: number`、`compact?: boolean`；默认保持现有完整首页行为。
- 新首页传：`low stock limit=5`、`followed products limit=4`、`compact=true`。

固定方案 A 下仍须满足：
- 保留错误状态、空状态、「查看全部」正确链接；
- 不删除现有关注产品筛选/跳转逻辑而不补替代测试；
- 文件清单与测试清单同步。

---

## 9. 顶栏全局动作收口
当前方案把首页排版扩张成全站 Header 改造，风险过大。**v5 默认改为首页内容区内的「快捷动作条」，不修改共享 `dashboard-header.tsx`**。动作固定为**导航链接**，不直接触发写操作：
- 库存同步 → `/dashboard/sync`
- 补货建议 → `/dashboard/replenishment`
- 全球库存总览 → `/dashboard/products/overview`

因本方案排在 P1/P7 后实施，**不再显示「补货待上线」占位按钮**，也不创建无效占位按钮。
**删除全局「数据导出」按钮**：导出须依赖具体页筛选上下文，现有海外库存页已有 CSV 导出；Header 无明确导出对象、筛选条件与权限语义，不能做全局导出。
若仍要修改共享 `dashboard-header.tsx`，须新增完整全站页面回归范围与 Admin/Operator 权限测试；默认不建议在本方案做。
「手动同步」不在 Header 触发同步写操作，只能导航到 `/dashboard/sync`；真正同步沿用现有受认证、受角色控制流程。
本方案**彻底固定不修改**共享 Header / Sidebar / 根布局 / 全局样式：不修改 `dashboard-header.tsx`、`sidebar-nav.tsx`、`src/app/layout.tsx`、`src/app/globals.css`。快捷动作只存在于**首页内容区**的「快捷动作条」，不触碰共享顶栏。若未来需要全局 Header 改造，应**另立独立方案**，不属于本首页任务；本方案**不再保留任何「若仍需修改共享 Header」的临场修改入口**。

---

## 10. 同步异常数据源（固定唯一公式）
原方案只写「同步异常来自 sync_run」但无调用链。改为**复用现有**：
```
getSyncWarehouseOverview()
  → get_sync_warehouse_overview RPC（00032 已存在）
```
首页**不得自行读取 sync_run 表**，不新增第二套同步异常 RPC。

**单个仓库判定为同步异常，当且仅当**（固定唯一公式，不再写「例如/若现有契约不足」）：
```
latestDryRun?.status === 'failed'
OR latestRealWrite?.status === 'failed'
```
- `sync_error_count` = 满足上述条件的**可见仓库数量**。
- 只看每种模式（dry-run / real-write）的**最新一条**状态。
- `last_failure_reason` 仅用于展示，不直接决定是否仍异常。
- 旧失败后已有更新的 `completed` 记录，不应继续被旧 `last_failure_reason` 判为异常。
- **没有任何同步记录的仓库不算 failed**，可单独显示「从未同步」，但**不计入 `sync_error_count`**。
- Admin / Operator 可见仓库范围继续由 `get_sync_warehouse_overview` 既有权限逻辑控制。

---

## 11. 紧急行动 KPI 固定唯一 V1 方案（去占位）
删除：
- 「断货告警估算（V1 前占位）」
- 「需今日下单数先占位」
- 任何硬编码 0 或假风险数量

因本方案在 P1/P7 后实施，可复用已落地能力。KPI 三卡固定为：
1. **库存健康**：`health_rate` / `low_stock_count` / `out_of_stock_count` / `unmatched_count` / `total_quantity`
2. **「ETA 已知的计划及在途」**（固定 KPI 名称，不得笼统写成「全部在途」）：从 `getInTransitDetail` 返回行聚合——剩余总量 `active_in_transit_quantity = SUM(remainingQuantity)` / SKU 数 `active_in_transit_sku_count = COUNT(DISTINCT variantId)` / Shipment 数 `active_in_transit_shipment_count = COUNT(DISTINCT shipmentId)` / 未来 7 日到港真实总数 `future_7d_arrival_count = COUNT(DISTINCT shipmentId WHERE status IN (departed,arrived,customs) AND estimatedArrival ∈ [today, today+7]，UTC 日期)`（**必须从 `getInTransitDetail` 全量有效行按 shipmentId 去重计数，不得**用 getUpcomingArrivals 返回列表长度或 Top4 展示列表长度冒充总数；该值可以 > 4）。辅助说明文案固定为：「仅统计未取消、未吸收、ETA 已知且 remaining>0 的计划及在途记录。」（`get_in_transit_detail` 只返回 `estimated_arrival` 非 NULL 的记录，故不得把 ETA 缺失数据误称为已完整统计）
3. **紧急行动（V1 唯一数据源，均来自首页已加载数据）**：
   - `out_of_stock_count`（来自健康度 RPC summary）
   - `low_stock_count`（来自健康度 RPC summary）
   - `sync_error_count`（来自 §10 同步异常公式）

展示为「缺货 X / 低库存 Y / 同步异常仓库 Z」，并提供两个入口：
- 查看补货建议 → `/dashboard/replenishment`
- 查看全球库存总览 → `/dashboard/products/overview`

**固定约束**：
- 首页**不额外调用 P1/P7 RPC** 来取得 critical/warning 数，避免增加首页查询成本。
- 首页**不计算** `net_demand` / `suggest_qty` / `latest_order_date` / `stockout_urgency` / `replenishment_urgency`——这些仍由 P1/P7 页面负责。
- **不在首页重新计算 P1/P7 公式**。
- 「ETA 已知的计划及在途」KPI 可含 booking/loading/departed/arrived/customs、排除 `cancelled_at IS NOT NULL` / `bigseller_absorbed_at IS NOT NULL`（已被 BigSeller 吸收）/ `remaining_quantity <= 0` / `estimated_arrival IS NULL` 后聚合全部符合条件的记录；「未来 7 日到港」仅含 departed/arrived/customs 且 ETA 落在 today~today+7、最终 Top4。两者是「全集 vs 时间窗口子集」关系，**不得把两个数量相加形成「总在途」**。
- 首页**不得**继续调用旧 `getInTransitByVariant`、不得直接查询 `shipment`/`shipment_item`、不得复制 `get_in_transit_detail` 的过滤 SQL、不得修改 P1 RPC 或其公式、不得把已取消 booking / 已吸收记录 / remaining<=0 记录计入在途。

---

## 12. 仓库详情弹层固定（复用 Dialog，不新增 Popover）
首页主卡展示风险最高前 4 仓，完整仓库健康列表在弹层中展示。**v6 固定复用现有 shadcn `Dialog`**，不再保留「Popover / Dialog 二选一」：
- 不新增 `popover` 组件；不运行 shadcn CLI 生成 popover 组件。
- 桌面端居中显示完整仓库健康列表；移动端限制 `max-height` 并允许 Dialog 内容区滚动。
- 每个仓库行可跳转：`/dashboard/inventory/overseas?warehouse=<warehouse_id>`。
- Dialog 的关闭、焦点返回、Esc、键盘导航沿用现有组件能力，不新写一套。
- 这样避免本首页任务再生成新的全局 UI 基础组件。

---

## 13. 暗色主题从本方案拆出
项目虽已安装 next-themes，但根 layout 未挂主题 Provider、globals.css 无 `.dark` token，且 Dashboard layout/header/sidebar 与大量页面使用 `bg-gray-*`、`text-gray-*` 硬编码色——只补 `.dark` token 不能让全站正确进入暗色。故 **v5 将暗色主题、根布局主题 Provider 挂载、主题切换组件从本首页方案移出**，记录为独立后续「全站主题改造」方案。

本方案**不得修改**：`src/app/layout.tsx`、`src/app/globals.css`、全站 sidebar/header 的主题颜色。删除：
- 「暗色主题基建必须半天完成」
- 「直接 toggle document.documentElement classList」
- 本方案中的亮暗切换验收
- 原新建的主题切换组件（原方案新建项）

未来独立主题任务若实施，应使用 next-themes 的 Provider 与 `useTheme`，不应手写第二套 class 状态管理，并必须审计 Dashboard 全站硬编码颜色。

---

## 14. 动效边界
可保留轻量动效，但须为渐进增强，**不得影响首页首屏数据正确性**：
- `prefers-reduced-motion` 下关闭所有非必要动画；
- count-up 关闭动画时直接显示最终值；
- 屏幕阅读器读取最终值，不反复朗读递增过程；
- 动画期间不得造成卡片宽度跳动，数字使用 `tabular-nums`；
- 页面首次渲染与 hydration 后数值必须一致；
- 动效失败不影响数据展示；
- 不引入 framer-motion；
- `use-count-up` 仅确实使用时才创建，不为装饰性动画增加无用 hook。

---

## 15. 响应式与「单屏」验收修正
删除绝对表述「首页内容区单屏不滚动（≤780px）」，改为明确 viewport：
- 桌面基准：**1440×900、浏览器缩放 100%**；该基准下主要决策区尽量无需页面滚动，允许弹层内部滚动。
- 1280×720 可紧凑显示主要 KPI 与风险入口，但不得通过隐藏数据或把文字压成不可读来强行无滚动。
- 平板与移动端允许纵向滚动。
- 200% 缩放时不得内容重叠、裁切或无法操作。
- 小屏布局从三列 / 2:1 自动降为单列。
- 不得固定内容高度后使用 `overflow-hidden` 吞掉数据。

注意 Dashboard Layout 已有 `<main className="flex-1 overflow-auto ...">`；首页**不应与布局建立第二层互相冲突的全屏滚动容器**。同时避免当前 page.tsx（`px-6 py-6`）与 Dashboard Layout（`px-6 py-5`）重复叠加页面内边距——方案中明确**只保留一层页面内边距**（建议首页不再重复 `px-6 py-6`，由 Layout 统一提供）。

---

## 16. 文件清单重写

**新增**
- `supabase/migrations/00047_dashboard_warehouse_health_overview.sql`
- `src/app/dashboard/loading.tsx`（页面级 Skeleton，Promise.all 期间由 Next.js 自动渲染）
- `src/app/dashboard/_components/dashboard-kpi-cards.tsx`
- `src/app/dashboard/_components/warehouse-health-card.tsx`
- `src/app/dashboard/_components/upcoming-arrivals.tsx`
- 对应 Migration / Repository / 页面 / 组件测试

**修改**
- `src/app/dashboard/page.tsx`
- `src/app/dashboard/_components/low-stock-summary-section.tsx`（扩展 `limit?` / `compact?`）
- `src/features/preferences/components/followed-products-section.tsx`（扩展 `limit?` / `compact?`）
- `src/features/inventory/types.ts`
- `src/features/inventory/repository.ts`
- `src/features/shipments/types.ts`（**`UpcomingArrival` 为首页新增**；`InTransitDetail` 由 P1 阶段提供、本首页只复用——如实施时 P1 类型已存在，不得重复定义同名类型）
- `src/features/shipments/repository.ts`（**仅新增 `getUpcomingArrivals`**；`getInTransitDetail` 由 P1 阶段已落地（调用 `get_in_transit_detail` RPC），本首页只调用、禁止重写或复制该方法的查询）
- `src/types/database.ts` 中新增 RPC 类型契约（按项目现行类型同步方式）
- 现有 Dashboard 首页测试

> 注：v6 已固定方案 A，**不再保留临场新建首页紧凑组件的选项**；复用并扩展现有 `LowStockSummarySection` / `FollowedProductsSection`。

**首页方案依赖项（P1 已落地，实施前置校验）**
- P1 Migration D / 00044 的 `get_in_transit_detail(p_user_id, p_warehouse_id, p_variant_id)` 已存在。
- P1 Repository 对该 RPC 的映射方法（建议契约名 `getInTransitDetail(userId, filters?)`）已存在；首页无筛选调用为 `getInTransitDetail(user.id)`，可选 string 字段不传 null，Repository 内部把未提供的筛选映射为 RPC `p_warehouse_id = null` / `p_variant_id = null`。
- P1 `InTransitDetail` 返回类型已存在（首页只复用，不重复定义）。
- **若实施时上述任一依赖未落地，首页停止实施**：不得回退到旧 `getInTransitByVariant`，不得临时直查 `shipment`/`shipment_item`，不得自行复制 `get_in_transit_detail` 的过滤 SQL；应先推动 P1 完成。

**默认不修改**
- `dashboard-header.tsx`
- `sidebar-nav.tsx`
- `src/app/layout.tsx`
- `src/app/globals.css`
- P1/P7 的 RPC 或公式
- 已执行 Migration
- RLS 策略

本方案**彻底固定不修改**上述共享文件；任何全局 Header 改造须另立独立方案，不在本方案保留任何临场修改入口（与 §9 一致）。

---

## 17. 测试与验收

删除原方案「约 800 条测试」说法与 typecheck 脚本要求。真实项目当前质量门为：
- `npm run test`
- `npm run lint`
- `npm run build`
- `git diff --check`

当前基线 3524/3524，但实施时以当时最新测试总数为准，不把 3524 写成永久固定值。

### v8 验收清单（59 条：v5 原 38 条 + v6 新增 12 条 + v7 新增 6 条 + v8 新增 3 条）
> 原 v5 38 条验收语义全部保留；v6 新增 #39–#50 覆盖 9 类收口；v7 新增 #51–#56 覆盖本轮 Codex 复审 4 个问题（归档过滤 / 在途数据源 / Header 契约 / 章节编号）；v8 新增 #57–#59 覆盖 TypeScript null 契约 / 未来 7 日真实总数来源 / 吸收语义修正（统一 bigseller_absorbed_at）。原 56 条未删除凑数。
1. Migration 编号不占用 00038–00046（用 00047，冲突时顺延）。
2. RPC `p_user_id` 必须等于 `auth.uid()`。
3. 未登录调用被拒绝。
4. 停用用户调用被拒绝。
5. 非 admin/operator 被拒绝。
6. Admin 只统计 active overseas warehouses。
7. Operator 只统计 assigned ∩ active overseas warehouses。
8. Operator 不能通过 `p_user_id` 查看他人仓库。
9. `safety_stock` 来自 `product`（非 product_variant）。
10. `quantity = 0` 只计 out_of_stock。
11. `unmatched` 不计 normal。
12. low / normal / out_of_stock / unmatched 互斥。
13. `health_rate` 分母不包含 unmatched。
14. 无可评估数据时 `health_rate = NULL`。
15. 空仓库返回完整 JSONB 信封。
16. 仓库数量动态，不写死 4。
17. 近期到港包含 departed / arrived / customs。
18. 近期到港排除 booking / loading / warehoused / cancelled。
19. ETA 今天与第 7 天边界均包含。
20. ETA 为空与过期记录排除。
21. `remaining_quantity` 使用 `quantity - warehoused_quantity`。
22. 多商品 shipment 不虚构单一 product_name。
23. 查询无 N+1。
24. Operator 近期到港按 accessible warehouse 过滤。
25. 首页所有查询保持 Promise.all 并行。
26. 单区块失败不导致整页崩溃。
27. 查询失败不显示成健康 0。
28. Low Stock Top5 与查看全部正确。
29. Followed Products Top4 与查看全部正确。
30. 首页快捷动作链接到既有 P1/P7/同步页面。
31. 不存在补货待上线死按钮。
32. 不存在无定义全局导出按钮。
33. 不修改 P1/P7 公式。
34. Client Component 不直接访问 Supabase。
35. `prefers-reduced-motion` 生效。
36. 1440×900、1280×720、移动端、200% 缩放布局验收。
37. Admin / Operator 首页均可正常渲染。
38. 全量 test / lint / build / diff-check 通过。

**v6 新增（12 条）**
39. `summary` 使用 `distinct_variant_count` 与 `total_position_count`，禁止含义不明的 `total_skus`。
40. `total_position_count` 等于四态计数之和（normal+low+out_of_stock+unmatched）。
41. 同一 variant 在两个仓库产生两个 inventory position，但 `distinct_variant_count` 只计一次。
42. `SECURITY INVOKER` 为唯一实现，正文不存在 DEFINER 备选。
43. 首页查询清单固定，`getOverseasStats` 与健康度 RPC 不再「二选一」。
44. 同步异常只由最新 dry-run / real-write 的 `failed` 状态决定（不直查 sync_run、不写「例如/若不足」）。
45. 从未同步仓库不计 `failed`、不计入 `sync_error_count`（可单独显示「从未同步」）。
46. `cancelled_at IS NULL` 为近期到港强制条件（不再写「P1 落地后加」）。
47. `remaining = 0` 的 item 不进入 `remainingQuantity` / `itemCount` / `itemNames`。
48. `remaining_quantity <= 0` 的 shipment 不占 Top4 名额。
49. `UpcomingArrival` 固定返回 `itemNames: string[]`，不存在与预拼接摘要字段二选一。
50. 页面使用 `dashboard/loading.tsx` 提供页面级 loading，纯展示组件不自行查询、不自行进入 loading 状态。

**v7 新增（6 条）**
51. 健康度 RPC 在四态分类、逐仓聚合与 summary 聚合**之前**排除当前用户 `preference_type='archived'` 的 Variant（`LEFT JOIN user_variant_preference uvp_arch ... WHERE uvp_arch.variant_id IS NULL`）。
52. 用户 A 的归档不影响用户 B 的健康度统计（归档为用户级偏好；Admin / Operator 各自仅排除自己归档的 Variant）；不修改 `user_variant_preference` 表或 RLS；不把 `favorited` 当作过滤条件。
53. 首页不再调用旧 `getInTransitByVariant`，改为复用 P1 `get_in_transit_detail` 的 Repository 方法 `getInTransitDetail(user.id)`（无筛选调用，可选 string 字段不传 null）。
54. 已取消 booking（`cancelled_at IS NOT NULL`）、已吸收记录（`bigseller_absorbed_at IS NOT NULL`）、`remaining_quantity <= 0` 的记录不进入首页有效在途 KPI；首页不直接查询 `shipment`/`shipment_item`、不复制 `get_in_transit_detail` 过滤 SQL。
55. 首页在途 KPI 明确命名为「ETA 已知的计划及在途」，仅聚合 `estimated_arrival` 非 NULL 的有效记录，不把 ETA NULL 记录误称为已完整统计；辅助说明文案固定为「仅统计未取消、未吸收、ETA 已知且 remaining>0 的计划及在途记录」。
56. 首页依赖 P1 `get_in_transit_detail`（Migration D/00044）及其 Repository 映射；若实施时该依赖未落地，首页停止实施，不得回退到旧 `getInTransitByVariant`，也不得临时直查数据库。

**v8 新增（3 条）**
57. `getInTransitDetail` 无筛选时调用为 `getInTransitDetail(user.id)`；可选 string 字段（`warehouseId?` / `variantId?`）不传 null，Repository 内部把未提供的筛选映射为 RPC `p_warehouse_id = null` / `p_variant_id = null`；合法带筛选调用只能传 string 实参（如 `getInTransitDetail(user.id, { warehouseId: someId, variantId: someId })`）。
58. 未来 7 日到港 KPI 使用 `getInTransitDetail` 全量有效行按 `shipmentId` 去重计数 `future_7d_arrival_count`（status ∈ (departed,arrived,customs) 且 ETA ∈ [today, today+7]，UTC 日期）；当符合条件记录超过 4 单时，KPI 显示真实总数，Top4 列表仍只展示 4 条，可显示「还有 N 单」（N = 总数 - 4）并提供「查看全部」跳转入口；不得用 getUpcomingArrivals 返回列表长度或 Top4 展示列表长度冒充总数。
59. 活动正文不存在 `abandoned` 状态或字段；吸收语义统一使用 `bigseller_absorbed_at IS NOT NULL`（「已被 BigSeller 吸收」），不存在 `shipment.status = 'abandoned'` / `shipment.abandoned` / `abandoned_at`。

**最终计数**：原 v5 38 条 + v6 新增 12 条 + v7 新增 6 条 + v8 新增 3 条 = **59 条**（未删除原 56 条凑数）。

---

## 18. 风险与注意
- shipment.status 枚举（§5.1）：已依 00001 CHECK 固定为 departed/arrived/customs，不含 partial_warehoused。
- 仓库详情弹层（§12）：固定复用现有 shadcn `Dialog`，**不新增 Popover 组件、不运行 shadcn CLI 生成 popover 组件**。
- 不新增 RLS 策略；仓库隔离复用 `warehouseAccessRepository` + RPC 内 INVOKER 校验（§3.1）。
- 国内库存：P8 前不在首页展示。
- 暗色主题已拆出，不阻塞首页实施。

---

## 19. 取证附录（真实代码）

### 19.1 Migration 编号
- `supabase/migrations/` 实测最新为 **00037**；P0=00038–00040、P1=00041–00044、P7=00045–00046 已预留 → 首页健康度 RPC 用 **00047**。

### 19.2 safety_stock 字段归属
- `00001_initial_schema.sql:63` `safety_stock` 定义于 **product** 表。
- `00027_overseas_inventory_performance_rpc.sql:224` `LEFT JOIN public.product p ... p.safety_stock`；`00027:248-252` 低库存判定用 `COALESCE(p.safety_stock, 0)`。
- `product_variant` 无 `safety_stock` 列 → 全方案改用 `product.safety_stock`。

### 19.3 shipment.status 合法值
- `00001_initial_schema.sql:140` `CHECK (status IN ('booking','loading','departed','arrived','customs','warehoused'))`。
- `partial_warehoused` 仅出现于 `tracking_event` 状态语境（00017 注释），非 shipment.status。

### 19.4 shipment_item / shipment 字段
- `00001:159` `warehoused_quantity integer NOT NULL DEFAULT 0`；`00001:162` `CHECK (warehoused_quantity <= quantity)`。
- `shipment` 表无 `quantity`、无 `product_name`（关联 `product_variant` 取品名）。

### 19.5 Operator shipment RLS
- `00015_user_warehouses.sql:129-137` `operator_select_shipment` 仅校验 `get_user_role()='operator' AND warehouse_id IN (get_assigned_warehouse_ids())`；Repository 仍须显式二次过滤（防御式）。

### 19.6 组件现状
- `low-stock-summary-section.tsx:40` `const MAX_DISPLAY = 15;`（非 Top5）。
- `followed-products-section.tsx` 为客户端组件，无 `limit`/`compact`/Top4 紧凑参数，渲染全部关注项。

### 19.7 暗色主题现状
- `src/app/layout.tsx` 未挂载主题 Provider；`src/app/globals.css` 无 `.dark` token → 暗色主题从本方案拆出。

### 19.8 质量门与测试规模
- `package.json` scripts 仅 `dev/build/start/lint/test/test:concurrency/test:best-live`，**无 typecheck**。
- 当前全量测试基线 **3524/3524**（实施时以最新为准）。

### 19.9 auth 形状（与 P7 v8 一致）
- `src/lib/auth.ts` `requireActiveAuth(): Promise<CurrentActiveUser>` 直接返回 `CurrentActiveUser`（字段 `id`/`email`/`displayName`/`roleName`/`isActive`），无 `.user` 包裹层 → 正确用法 `const user = await requireActiveAuth(); user.id`。

---

> **文档版本**：v8 ｜ 末次修订：2026-07-12（v4→v5 解决 17 类阻塞 + 2 类口径；v6 依 Codex 终审 9 类收口固定为唯一实施契约，验收扩至 50 条；v7 依 Codex 复审 4 个问题——健康度 RPC 补当前用户 archived Variant 过滤 / 首页在途数据源改用 P1 get_in_transit_detail（弃旧 getInTransitByVariant，KPI 固定「ETA 已知的计划及在途」）/ 共享 Header 契约彻底固定（删临场修改入口）/ 取证附录子章节编号 18.x→19.x 修正，验收扩至 56 条；**v8：弃用 getInTransitDetail 调用的 null 实参（改无参调用 → Repository 内映射 RPC null）/ 未来 7 日到港总数改用 getInTransitDetail 全量去重计数（不取 getUpcomingArrivals Top4 展示列表长度）/ 删除不存在的 abandoned 语义（统一 bigseller_absorbed_at IS NOT NULL），验收扩至 59 条，待 Codex 最终确认**）｜ 协作分工：本文件属「方案/设计层」产出，交付 Codex 终审、Claude 落盘实现，巴蒂不直接修改 overseas-inventory 实现代码。｜ 纪律：仅修改本方案文档；不修改源码 / Migration / 数据库 / 测试 / 其他方案。
