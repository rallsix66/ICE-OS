> 历史归档（2026-10-13）：原位置 `docs/design/dis-plans/DIS-实施总顺序方案.md`。保留用于旧实现与验收追溯，不作为当前任务或执行授权；现役入口见 [归档索引](../README.md)。

# DIS 实施总顺序方案（v3 · 四方案最终定稿收口）

> 状态：2026-07-12 由巴蒂汇总并同步四方案最终 v8 定稿；v3 收口修订（§0 区分「用户确定顺序 P0→P1」与「真实技术依赖 P1→P7→首页」／ Stage 1 明确只限制 golucky 单一调度并保留 dry-run ／ §14 由「全文 grep 0」改为「活动实施语义复检」）｜ **v3 待 Codex 最终确认；通过前不交 Claude 开工** ｜ 用途：供 Codex 评审四方案可行性 + 统一实施顺序，再交 Claude 落盘
> 协作分工：巴蒂出方案/设计 → Codex 评审（本文件目标）→ Claude 落盘实现。巴蒂不直接改 DIS 实现代码。
> 本文件夹包含：本总纲 + 四份独立方案。四份方案均已通过 Codex 终审正式定稿，字段 / 枚举 / 表结构以各方案 v8 为准（非推测）。

---

## 0. 为什么需要这个总纲

四份方案虽然分别定稿，但 P1、P7 与首页之间存在明确的数据库函数、RPC、Repository 和页面能力依赖；如果跳序实施，会造成下游调用契约尚未落地。本总纲把四份串成一条**严格串行关键路径 P0 → P1 → P7 → 首页（Stage 1 → Stage 4）**，并给 Codex 一个统一评审入口。

关键区分（避免误解 P0 为 P1/P7 的数据源）：

- **P0 → P1 是用户确定的实施顺序，不是计算依赖。** P0 不写 ETA、不写 `shipment.status`、不写 `tracking_event`、不写 `inventory`；P0 外部轨迹不进入 P1/P7 的 V1 预测计算，P1 在途数据来自 `shipment` + `shipment_item`，P7 V1 不读取 `tracking_event_external`。P0 优先实施仅为：外部物流接入范围独立且已定稿、先完成 P0 可降低后续并行变更冲突——**不是**因为 P1/P7 计算依赖 P0。
- **P1 → P7 → 首页是真实技术依赖。** P1 创建 `forecast_stockout` 与 `get_in_transit_detail` / `get_replenishment_suggestions` RPC；P7 依赖 P1 的 RPC 与共用预测函数；首页依赖 P1 的 `getInTransitDetail` 与 P7 已落地的页面能力。

首页不再穿插到 P0/P1/P7 之间，必须等 P1 与 P7 落地后再实施。

---

## 1. 四份方案最终状态（v8 定稿）

四份方案均已通过 Codex 终审，正式定稿。以下为总纲须同步的最终契约。

### 1.1 P0 喜运达物流轨迹 API 接入
- 文件：`DIS-喜运达物流轨迹API接入-方案.md`
- 最终版本：**v8** ｜ 状态：已通过 Codex 终审，正式定稿。
- Migration 预留：00038_golucky_schema.sql（A）／00039_golucky_rls_rpc.sql（B）／00040_golucky_token_cache.sql（C）。执行顺序 A→B→C，回滚 C→B→A。
- 核心边界：
  - 新建 `src/app/api/cron/golucky/route.ts`；现有 `/api/cron/dry-run` 保留。
  - `CRON_SECRET` 只用于 golucky；`CRON_API_KEY` 只用于 dry-run；两个 secret 不得混用。
  - golucky schedule 固定 `0 2 * * *`（UTC 02:00 / 北京时间 10:00，兼容 Hobby 计划每天一次）；`vercel.json` 中 golucky 只能保留一个调度来源；不允许 Vercel Cron 与 Supabase Scheduled Functions 双调度 golucky。
  - 缺失 `CRON_SECRET` 时先返回 HTTP 500，不读取 Authorization、不访问 DB、不刷新 Token、不调用物流 API；鉴权失败返回 401。
  - P0 只写 `tracking_event_external` 及外部表同步字段；不回写 `shipment.status`；不写 `tracking_event`；不写 `inventory`；不写 `estimated_arrival`。
  - P0 外部轨迹不进入 P1/P7 的 V1 预测计算。
  - waybill 唯一索引创建前，Migration 内部 `DO` 块检查历史重复；存在重复时输出 `provider`/`waybill_no`/`count` 并中止 Migration，不删除、不合并历史数据。

### 1.2 P1 预测式补货引擎
- 文件：`DIS-预测式补货引擎-实施方案.md`
- 最终版本：**v8** ｜ 状态：已通过 Codex 终审，正式定稿。
- Migration 预留：00041_replenishment_warehouse_params.sql（A）／00042_replenishment_cancellation.sql（B）／00043_forecast_stockout.sql（C）／00044_replenishment_rpcs.sql（D）。执行顺序 A→B→C→D；回滚 D→C→B→A。
- 依赖：C 创建 `forecast_stockout`；D 创建 `get_in_transit_detail` 与 `get_replenishment_suggestions`；D 依赖 A、B、C。不得把 `forecast_stockout` 误写成 Migration D 创建。
- 核心公式（保持）：
  - `safety_stock = round(ds * lead * buffer_ratio)`
  - `target_stock = round(ds * lead * target_cover_multiplier)`
  - `net_demand = greatest(0, target_stock - (on_hand + effective_inbound))`
  - `suggest_qty = net_demand`
  - `safety_stock` 仅为安全阈值展示值，不再叠加进 `target_stock`。
  - V1 不加入 reorder_point、MOQ、箱规、运费、季节系数；后续增强在真实数据积累后进入 V1.1/V2，本阶段不修改公式。
  - `inventory` 为驱动表；无 `inventory` 行的 variant 不生成虚假仓库建议。
  - `get_in_transit_detail` 排除 `cancelled_at IS NOT NULL`、排除 `bigseller_absorbed_at IS NOT NULL`、只统计 `remaining > 0`。
  - Migration C 是 P1 与 P7 共用预测函数唯一实现；P7 不得复制补货公式。
- P1 最终验收：**74 条**。

### 1.3 P7 全球库存总览 / 作战室
- 文件：`DIS-全球库存作战室-实施方案.md`
- 最终版本：**v8** ｜ 状态：已通过 Codex 终审，正式定稿。
- Migration 预留：00045_product_overview_rpc.sql（E）／00046_war_room_variant_detail_rpc.sql（F）。
- 依赖：E 依赖 P1 C/00043；F 依赖 P1 C/00043 与 D/00044；F 调用 `get_replenishment_suggestions`，F 禁止复制 P1 行动层公式。
- 执行顺序：P1 A→B→C→D → P7 E→F；P7 回滚 F→E。
- 核心边界：
  - 唯一路由 `/dashboard/products/overview`；P7-A 与 P7-B 是同一产品的两层，不是两个页面。
  - 唯一列表 RPC：`get_product_overview`；唯一详情 RPC：`get_war_room_variant_detail`。
  - Repository 必须接收服务端 `userId`；`requireActiveAuth()` 直接返回 `CurrentActiveUser`，正确调用为 `const user = await requireActiveAuth(); user.id`。
  - Client 不得传 `userId`、角色、仓库权限或国家权限。
  - Admin 查看全部 active overseas warehouses；Operator 查看 `assigned ∩ active overseas warehouses`。
  - P7 V1 不读取 `tracking_event_external`；P0 不是 P7 V1 数据依赖。
  - 国内库存 P8 前保持 `data_unavailable` 占位。
  - `stockout_urgency` 与 `replenishment_urgency` 分离；`partial_data` 为独立 boolean。
  - P1 行动字段按 `warehouse_id` 放入 `assigned_warehouse_detail[]`；不跨仓汇总 `suggest_qty`。
- P7 最终验收：**61 条**。

### 1.4 首页决策看板
- 文件：`DIS-首页排版-实施方案.md`
- 最终版本：**v8** ｜ 状态：已通过 Codex 终审，正式定稿。
- Migration 预留：00047_dashboard_warehouse_health_overview.sql。
- 依赖：必须在 P1 与 P7 实施完成后实施；依赖 P1 `get_in_transit_detail` 及其 Repository 映射；依赖 P1/P7 已落地页面入口；依赖缺失时停止，不得回退旧 `getInTransitByVariant`，不得临时直查数据库。
- 核心边界：
  - 首页不是并行快赢；首页不再穿插到 P0/P1/P7 之间。
  - 暗色主题已从本方案拆出。
  - 不修改共享 `dashboard-header` / `sidebar` / 根 `layout` / `globals.css`；不新增 Popover，复用现有 shadcn Dialog。
  - 首页快捷动作只放首页内容区；不提供全局导出按钮；不提供补货待上线死按钮。
  - 健康度 RPC 使用 `SECURITY INVOKER`；统计粒度为 `inventory_position`；`safety_stock` 来自 `product`；排除当前用户已归档 Variant。
  - 首页在途调用 P1 `getInTransitDetail(user.id)`；不调用旧 `getInTransitByVariant`。
  - `getUpcomingArrivals` 只负责 Top4 展示；`future_7d_arrival_count` 从 `getInTransitDetail` 全量有效行按 `shipmentId` 去重计算。
  - 页面级 loading 使用 `dashboard/loading.tsx`。
- 首页最终验收：**59 条**。

---

## 2. 优先级与关键路径（结论）

固定顺序：**P0 → P1 → P7 → 首页（Stage 1 → Stage 4）**。

- 关键路径为单一串行：P0 外部轨迹接入 → P1 预测式补货引擎 → P7 全球库存总览/作战室 → 首页决策看板。
- 首页不是并行快赢，必须在 P1 与 P7 实施完成后实施。
- 暗色主题已从首页方案拆出，不作为任何 Stage 前置。
- P8 国内库存与 P7-C 国内补给判断不属于当前四方案，移出实施批次（见 §5 未来路线）。

---

## 3. 排序依据（三维）

| 维度 | 说明 |
|------|------|
| 就绪度 | 能不能马上开干（方案是否实测 / 参数是否拍板 / 是否仍草案） |
| 依赖关系 | 是否卡着下游（前置 blocker） |
| 业务价值 | 对运营决策的直接价值高低 |

逐份判定见下方各 Stage。

---

## 4. 最终实施顺序（Stage 0–4）

### Stage 0 · 实施前治理门

1. Claude / 项目维护者检查当前 Git 状态。
2. 单独审查此前误修改的 `.claude/context-status.json`、`docs/current-state.md`、`docs/tasks/current-task.md`。
3. 上述三份文件由 Claude / 项目维护者决定保留、修正或恢复。
4. 巴蒂不得修改这些文件。
5. 确认 `docs/design/dis-plans/` 中的五份方案是否纳入 Git 跟踪。
6. 确认 `supabase/migrations/` 当前最新实际编号。
7. 若 00038–00047 被占用，按实际最新编号整体连续顺延，并同步本次实施记录。
8. 不允许覆盖、重命名或修改已执行 Migration。
9. 确认当前测试、lint、build 基线。
10. Stage 0 未完成，不进入代码实施。

### Stage 1 · P0 喜运达

实施：
- Provider 六件套。
- 外部数据表结构 / RLS / RPC / Token 租约。
- golucky Cron route。
- golucky 在 `vercel.json` 中只允许一个调度配置；现有 `/api/cron/dry-run` 调度必须保留，禁止 golucky 同时由 Vercel Cron 与 Supabase Scheduled Functions 双重调度。（`/api/cron/dry-run` 使用 `CRON_API_KEY`、`/api/cron/golucky` 使用 `CRON_SECRET`，两个 secret 不得混用；dry-run 与 golucky 是两个独立 Cron，「单一调度」仅指 golucky 自身不能重复配置，不得删除 / 替换 / 改造现有 dry-run route。）
- Shipment 详情外部轨迹展示。
- 文本粘贴 + CSV 导入。

Migration：00038 → 00039 → 00040。

验收完成后：Claude 提交实施结果 → Codex 独立验收。P0 未通过，不进入 Stage 2。

### Stage 2 · P1 预测式补货引擎

Migration：00041 → 00042 → 00043 → 00044。

实施：
- warehouse 补货参数。
- `shipment.cancelled_at`。
- `forecast_stockout`。
- `get_in_transit_detail`。
- `get_replenishment_suggestions`。
- admin-only 创建 / 取消计划发货。
- `/dashboard/replenishment`。
- Repository / Server Action / RLS / 类型 / 测试。

验收：74 条方案验收 + 项目全量质量门。P1 未通过，不进入 Stage 3。

### Stage 3 · P7 全球库存总览 / 作战室

Migration：00045 → 00046。

实施：
- `/dashboard/products/overview`。
- `get_product_overview`。
- `get_war_room_variant_detail`。
- P7-A 基础总览。
- P7-B 预测与补货增强。
- 详情弹窗。
- Admin / Operator 仓库隔离。
- 国内 `data_unavailable` 占位。

验收：61 条方案验收 + 项目全量质量门。P7 未通过，不进入 Stage 4。

### Stage 4 · 首页决策看板

Migration：00047。

实施：
- `get_warehouse_health_overview`。
- 首页 KPI。
- 仓库健康 Dialog。
- LowStock Top5 compact。
- Followed Products Top4 compact。
- 「ETA 已知的计划及在途」KPI。
- 未来 7 日到港 Top4。
- 同步异常。
- 页面级 loading。
- 响应式与 reduced-motion。

验收：59 条方案验收 + 项目全量质量门。

---

## 5. P8 / P7-C 边界（未来路线）

P8 国内库存与 P7-C 不属于当前四份已定稿实施方案。总纲中保留为"未来路线"，但移出当前 Claude 实施批次。

### Future 1 · P8 国内库存接入
当前未立项，需另行确认：国内数据源 / 国内 Inventory 模型 / 同步链路 / 生产周期 / 国内在途 / 权限 / 验收标准。未单独完成方案和 Codex 审查前，不得实施。

### Future 2 · P7-C 国内补给判断
依赖 P8 真实数据。未单独评审前：国内列保持 `data_unavailable`；不用 0 模拟国内库存；不让国内占位数据进入 `visible_total_quantity`；不让国内占位数据进入断货与补货计算。

---

## 6. Migration 总顺序（00038–00047）

若实施时编号仍未占用，完整顺序固定为：

```
00038 P0 A
→ 00039 P0 B
→ 00040 P0 C
→ 00041 P1 A
→ 00042 P1 B
→ 00043 P1 C
→ 00044 P1 D
→ 00045 P7 E
→ 00046 P7 F
→ 00047 首页
```

全局依赖：
- P1 D 依赖 P1 A/B/C。
- P7 E 依赖 P1 C。
- P7 F 依赖 P1 C+D。
- 首页依赖 P1 D 及 P7 页面能力；首页 00047 不能早于 P1/P7 实施。

若需全局逆序回滚：

```
00047 → 00046 → 00045 → 00044 → 00043 → 00042 → 00041 → 00040 → 00039 → 00038
```

但必须注明：
- 优先按模块回滚，不默认执行全局全部回滚。
- 回滚 P1 前必须先回滚依赖 P1 的首页和 P7。
- 回滚 P7 不要求回滚 P0。
- P0 与 P1 不存在计算依赖，但按用户确定顺序串行实施。
- 任何回滚都必须先备份并评估生产数据，不得直接执行破坏性操作。

---

## 7. 纠正 P0 与 P7 关系

删除旧表述：P0 解锁 P7-B 外部轨迹展示 / P0 与 P7-B 并行汇入旧表述 / P7-B 消费 tracking_event_external。

最终固定：
- P0 与 P1/P7 V1 没有计算依赖。
- P0 不写 ETA。
- P0 不写 ShipmentItem 数量映射。
- P7 V1 不读取 tracking_event_external。
- P0 外部轨迹只在 Shipment 详情 / 外部物流记录中展示。
- 未来若 P7 需要承运商外部轨迹，须另立增强方案，不能默认属于当前 P7 v8。
- P0 仍按用户确定顺序最先实施，原因是：外部物流接入范围独立且已定稿；先完成 P0 可降低后续并行变更冲突；不是因为 P1/P7 计算依赖 P0。

---

## 8. 纠正 P1 与 P7 关系

删除旧表述：提前单独实施 P7-A / P7-A 早于 P1 先上 / forecast_stockout 误归 Migration D。

最终固定：
- P1 Migration C/00043 创建 `forecast_stockout`。
- P1 Migration D/00044 创建两个读取 RPC。
- P7 Migration E/00045 依赖 P1 C。
- P7 Migration F/00046 依赖 P1 C+D。
- 因 P7 使用统一 RPC 与统一页面，本轮按 P1 完整通过后再实施 P7。
- 不再建议提前单独实施 P7-A。
- P7-A / P7-B 仍可作为页面内部交付层次，但属于同一个 Stage 3，不改变全局顺序。

---

## 9. 共同架构边界纠正

删除总纲中错误的统一表述（如"所有方案都不新增 RLS 策略"、"所有读取都不经过 Server Action"、"Server Action 仅作为写入通道"、"覆盖全部方案的 security definer 表述"等），改为按方案区分：

### 读取
- 常规读取：Server Component → Repository / 既有服务端读取封装 → Supabase RPC → PostgreSQL RLS。
- 客户端触发的懒加载详情：Client Component → 受认证 Server Action → Zod → Repository → RPC / RLS。

### 写入
- Client / 表单 → Server Action → `requireActiveAuth` / `requireActiveAdmin` → Zod → Repository → Supabase / RPC → RLS。

### 安全模式
- P0 部分写 RPC 使用 `SECURITY DEFINER`，但必须完整身份、角色、仓库、`search_path`、`REVOKE`/`GRANT` 防护。
- P1 读取 RPC 使用 `SECURITY INVOKER`。
- P7 读取 RPC 使用 `SECURITY INVOKER`。
- 首页健康 RPC 使用 `SECURITY INVOKER`。
- 不允许用一句覆盖全部方案的 security definer 表述。
- 不允许关闭 RLS。
- 只有 P0 方案明确新增外部表 RLS。
- P1 / P7 / 首页不得临时新增宽松 RLS。

---

## 10. 每阶段统一质量门

每个 Stage 完成后必须执行：对应方案专项测试、`npm run test`、`npm run lint`、`npm run build`、`git diff --check`。

测试数量：
- 当前仓库基线曾为 3524/3524。
- 实施时以当时最新测试总数为准；不把 3524 写成永久固定值。
- 不得删除旧测试凑数。
- 不得修改断言只为掩盖真实回归。
- lint / build 失败不得进入下一 Stage。
- Migration 静态测试不能替代真实数据库安全审查。
- 涉及 RPC / RLS 必须覆盖 Admin、Operator、未登录、停用账号、跨仓越权。

---

## 11. 每阶段停止条件

1. Claude 只实施当前 Stage。
2. 不提前实现下一 Stage。
3. 不在同一批同时创建多个 Stage 的 Migration。
4. Claude 完成后停止。
5. Codex 独立验收。
6. 用户确认后才进入下一 Stage。
7. 验收失败则只修当前 Stage。
8. 不借修复当前 Stage 重构无关模块。

---

## 12. 文件清单同步

| 文件 | 最终版本 | 当前顺序 | 状态 |
|------|---------:|---------:|------|
| `DIS-喜运达物流轨迹API接入-方案.md` | v8 | Stage 1 | 已定稿 |
| `DIS-预测式补货引擎-实施方案.md` | v8 | Stage 2 | 已定稿 |
| `DIS-全球库存作战室-实施方案.md` | v8 | Stage 3 | 已定稿 |
| `DIS-首页排版-实施方案.md` | v8 | Stage 4 | 已定稿 |
| `DIS-实施总顺序方案.md` | v3 | 总纲 | 待 Codex 最终确认 |
| `inventory-ui-upgrade-plan.md` | 参考基线 | 非独立 Stage | 不单独实施 |

---

## 13. 总纲自身验收清单（40 条）

1. 四份方案版本全部为 v8。
2. 顺序固定 P0 → P1 → P7 → 首页。
3. 首页不再标并行。
4. 首页无暗色主题前置。
5. P0 Migration 为 00038–00040。
6. P1 Migration 为 00041–00044。
7. P7 Migration 为 00045–00046。
8. 首页 Migration 为 00047。
9. `forecast_stockout` 明确由 P1 Migration C/00043 创建。
10. P1 D 依赖 A/B/C。
11. P7 E 依赖 P1 C。
12. P7 F 依赖 P1 C+D。
13. 首页依赖 P1 D 与 P7。
14. P0 不作为 P1/P7 计算依赖。
15. P7 V1 不读 `tracking_event_external`。
16. P1 公式与 v8 一致且未被总纲改写。
17. P1 验收 74 条。
18. P7 验收 61 条。
19. 首页验收 59 条。
20. P8 / P7-C 移入未来路线。
21. Stage 0 包含此前误修改状态文件的独立验收。
22. 巴蒂不修改 current-state / current-task / context-status。
23. 每阶段必须 Claude 实施 → Codex 验收 → 用户确认。
24. 每阶段质量门 test / lint / build / diff-check。
25. 不修改已执行 Migration。
26. 实施前重新检查 Migration 连续编号。
27. 回滚依赖顺序正确。
28. 不存在覆盖全部方案的 security definer 错误表述。
29. 不存在"所有方案禁止新增 RLS"的错误表述。
30. 不存在首页可穿插实施的旧表述。
31. §0 没有暗示 P0 为 P1/P7 提供 ETA 或补货计算数据源。
32. 明确 P0 → P1 是用户确定的实施顺序，不是计算依赖。
33. Stage 1 明确只限制 golucky 单一调度来源，禁止 Vercel Cron 与 Supabase Scheduled Functions 双调度 golucky。
34. 现有 `/api/cron/dry-run` route 和 Cron 配置必须保留，不得删除 / 替换 / 改造。
35. `CRON_API_KEY` 与 `CRON_SECRET` 职责隔离（dry-run 用前者、golucky 用后者），不得混用。
36. §14 不再声称相关关键词全文 0 匹配。
37. §14 使用「活动实施语义」复检，而不是简单关键词计数。
38. 历史纠错、否定约束和未来路线可以保留必要关键词（并行 / 穿插 / P7-A / forecast_stockout 误归 / tracking_event_external / SECURITY DEFINER / RLS / Popover / P8 / P7-C / 3524 等）。
39. 总纲没有扩大巴蒂对项目文件（current-state / current-task / context-status 等）的修改权限。
40. 本轮只修改总纲一份文件，未修改其他四份方案或任何非总纲文件。

---

## 14. 复检（活动实施语义，非全文关键词计数）

以下关键词（并行、穿插、P7-A 早于 P1、forecast_stockout 误归 Migration D、tracking_event_external、SECURITY DEFINER、RLS、Popover、P8、P7-C、3524 等）仍可能出现在**历史纠错、禁止事项、未来路线或正确边界说明**中，因此**不能使用简单全文关键词计数**作为是否清理完成的依据。复检标准为：**活动实施指令中不得存在旧的肯定性实施语义。**

**允许出现（不视为未清理）：**
- 历史纠错（如「删除旧表述：P0 解锁 P7-B 外部轨迹展示」）
- 否定约束（如「首页不再标并行」「首页不穿插」）
- 未来路线（P8 / P7-C）
- 正确安全设计（SECURITY INVOKER 与 SECURITY DEFINER 的差异说明、RLS 边界）
- 历史测试基线说明（3524 曾为基线，但明确非永久固定值）

**必须为 0（活动实施语义层面）：**
- 不得把首页安排为并行或穿插实施
- 不得要求 P7-A 早于 P1
- 不得把 `forecast_stockout` 写成由 Migration D 创建
- 不得把 P0 写成 P7 V1 的外部轨迹依赖
- 不得让 P7 V1 读取 `tracking_event_external`
- 不得用统一 `SECURITY DEFINER` 覆盖全部 RPC
- 不得写成所有方案都不新增 RLS
- 不得要求首页引入 Popover 或 ThemeProvider
- 不得把 3524 写成永久测试总数

这是**语义复检**，不是简单全文关键词计数。

---

> **文档版本**：v3 ｜ 末次修订：2026-07-12（v2 同步四方案 v8 定稿；v3 收口——§0 区分「用户确定顺序 P0→P1」与「真实技术依赖 P1→P7→首页」／ Stage 1 明确只限制 golucky 单一调度并保留 dry-run ／ §14 由「全文 grep 0」改为「活动实施语义复检」／ 总纲验收 30→40 条；**v3 待 Codex 最终确认，通过前不交 Claude 开工**）｜ 协作分工：本文件属「方案/设计层」产出，交付 Codex 终审、Claude 落盘实现，巴蒂不直接修改 overseas-inventory 实现代码。｜ 纪律：仅修改本方案文档；不修改其他四份方案 / 源码 / Migration / 数据库 / 测试 / 配置。
