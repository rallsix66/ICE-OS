> 历史归档（2026-10-13）：原位置 `docs/design/dis-plans/DIS-喜运达物流轨迹API接入-方案.md`。保留用于旧实现与验收追溯，不作为当前任务或执行授权；现役入口见 [归档索引](../README.md)。

# DIS 接入喜运达物流轨迹 API — 实施方案（v8，Codex v7→v8 修订版）

> 状态：v8 — 2026-07-12 由巴蒂据 Codex 首轮 + 第三轮 + v3 复审（第四轮）+ v4 复审（第五轮）+ v5→v6 修订 + v6→v7 修订 + **v7→v8 修订**全面修订
> 性质：**可落地实施方案**。API 事实（鉴权/响应/承接）经 OpenAPI + 正式环境实测双重确认；表结构/RLS/枚举/路由/测试基线/字段与现有 RPC 存在性经读取 `supabase/migrations` 与 `src/` 源码核实（含 `change_shipment_status_transactional` 事务 RPC、00021 admin-only 收紧、`profiles.is_active`、00025 调用者身份绑定范式等逐项取证）。
> 协作约定：巴蒂出方案 → Codex 评审 → Claude 落盘。巴蒂不直接编辑 DIS 实现代码。
> 关联方案：`DIS-实施总顺序方案.md`（总纲，本方案为 P0）

### 修改记录（v1 → v8）

| 版本 | 日期 | 主要变更 |
|------|------|----------|
| v1–v4 | 2026-07-10~11 | Codex 首轮 / 第三轮 / v3 复审（第四轮）/ v4 复审（第五轮）累计修订（详见 §15） |
| v5 | 2026-07-11 | 落实第五轮 5 项（换仓 DB 触发器双保险、批量原子性/重复项语义、Token 租约两阶段事务边界、P0 依赖最终选择）；明确 golucky cron route 为「新增非既有」 |
| v6 | 2026-07-12 | 见下方「v5→v6 四项修改原因」 |
| v7 | 2026-07-12 | 见下方「v6→v7 三项修改原因」 |
| v8 | 2026-07-12 | 见下方「v7→v8 修改原因」 |

**v5→v6 四项修改原因**
1. Migration 编号不能继续使用 `0003x` 占位符。
2. 现有 dry-run Cron 与新的 golucky Cron 必须明确共存边界。
3. `CRON_API_KEY` 与 `CRON_SECRET` 必须明确分属不同 Cron。
4. 新增 waybill 唯一索引前必须进行历史重复数据预检。

**v6→v7 三项修改原因**
1. 固定 `CRON_SECRET` 缺失时的唯一处理方式和鉴权顺序（取消「启动失败 / 500」二选一，统一为请求返回 500，并明确配置检查优先于请求鉴权）。
2. 将 waybill 重复预检从「人工查看 SELECT」改为明确的**可执行阻断机制**（重复即非零退出 / 抛异常，阻止唯一索引创建）。
3. 明确 golucky Cron 的具体 schedule（`0 2 * * *`，每天一次 UTC 02:00 / 北京时间 10:00，兼容 Hobby）与时区（UTC）。

**v7→v8 修改原因**
取消 waybill 预检实现方式二选一，固定采用 Migration 内 DO 块阻断；异常必须直接输出重复 provider、waybill_no 和数量。

---

## 0. 可行性结论（v4 更新）

**方向可行，已可进入 Migration 设计阶段。v4 已封死"绕过现有状态事务""Token 刷新竞态""批量部分成功""ETA 表述矛盾""换仓不一致""RPC 安全规范""provider 一致性""arrived 映射""Migration 过大"等缺口；v5 进一步落实 v4 复审（第五轮）的 5 项：补 `shipment` 侧换仓 DB 触发器（双保险）、批量导入原子性/重复项语义、Token 租约两阶段事务边界、P0 依赖最终选择（仅文本+CSV / Cron 平台二选一）。**

- 喜运达是标准 REST：`GET https://openapi.goluckyvip.com/tmsapi/tracking/list` + Header `Access-Token`，比 best 更简单（best 要 body 签名，喜运达只一个 header）。
- DIS **已有完整的「百世(best)」物流商 provider**（`src/lib/providers/best/`），且 `shipment_external_ref` + `shipment_external_item` + `tracking_event_external` 三表结构就是为外部物流商预留的。喜运达**照 best 模式加 `lib/providers/golucky/`**，复用其 fetch 封装、错误分类、zod 校验、dry-run 不写库的安全模式。**Provider 接口设计 Codex 首轮已确认可保留。**
- 🔴 **v3 复审（第四轮）确定的最大约束**：现有 `change_shipment_status_transactional` RPC（00019/00021/00022）负责状态更新并**写入内部 `tracking_event` + 审计**，且 00021 已将其收紧为 **admin-only**。因此 **P0 绝不自动回写 `shipment.status`**（采用 Codex 方案 A），避免绕过现有状态事务与审计。

---

## 1. 喜运达 API 事实（实测，已确认无误）

| 项 | 值 |
|----|----|
| Base URL | `https://openapi.goluckyvip.com`（仅正式环境有效，test 环境报「appKey 不存在」） |
| 端点 | `GET /tmsapi/tracking/list` |
| 认证 | 先 `GET /api/account/gettoken?appKey=&appSecret=` 换 token（返回 `data.accessToken`，`expiresIn=7200` 秒=2h），再塞 `Access-Token` header 调业务接口 |
| 查询参数 | `transportNumber`（运单号）或 `extTransportNumber`（商家运单号），二选一 |
| 调用形态 | **按运单号查单个运单全量轨迹**，无批量接口 |
| 单节点字段 | `code` / `title` / `desc` / `enDesc` / `time`（**无 ETA 字段**） |

> 🔴 响应数组混有「仅含 `title/enTitle`、无 `code/time`」的分组标题节点 → 解析层**必须 `filter(node => node.code)`** 跳过。`time` 实测为**毫秒** → `to_timestamp(time/1000)`。喜运达**无 ETA 字段**，故不能自动写 `estimated_arrival`（§6 / §11）。

---

## 2. DIS 现有承接结构（读取 00017 源码核实）

### 2.1 `lib/providers/best/`
- `client.ts` / `schema.ts` / `parse-response.ts` / `dry-run.ts` / `types.ts` / `signature.ts` / `index.ts`：完整参照物。
- **经 grep 确认：`lib/providers/best/` 中没有任何写入 `tracking_event` 的代码** → 现有外部同步仅落 `tracking_event_external`（路径 B）。

### 2.2 三张外部表（migration 00017，真实结构 + v4 计划变更）
```sql
-- ① shipment_external_ref（外部主单引用）— v4 变更见 §5
provider        text NOT NULL CHECK (provider IN ('best','golucky'))
external_order_no text                      -- v4 可空、非唯一（商家单号可重复）
waybill_no      text                        -- v4 部分唯一索引 (provider, waybill_no) WHERE waybill_no IS NOT NULL
country         text NOT NULL CHECK (country IN ('TH','ID','MY','PH','VN','CN'))
warehouse_id    uuid REFERENCES warehouse(id) ON DELETE SET NULL
sync_status     text NOT NULL DEFAULT 'active' CHECK (IN ('active','stale','error'))
shipment_id     uuid REFERENCES shipment(id) ON DELETE SET NULL   -- v4 新增：两阶段绑定

-- ② shipment_external_item（外部商品明细）— P0 明确不参与（见 §4.6 / §11）

-- ③ tracking_event_external（路径 B）— v4 变更见 §5/§10
external_ref_id   uuid NOT NULL REFERENCES shipment_external_ref(id) ON DELETE CASCADE
provider          text NOT NULL CHECK (provider IN ('best','golucky'))
external_event_id text NOT NULL            -- v4：解析层生成确定性哈希 + 唯一约束
external_category text NOT NULL DEFAULT 'unknown'
                  CHECK (external_category IN ('created','loaded','in_transit','customs','delivered','exception','unknown'))
status            text                      -- provider 专有字符串，无 CHECK
description / occurred_at / location / raw_payload
```

### 2.3 `shipment` 表与状态枚举（读取 00001 核实）
- `shipment.status` CHECK（00001:140）= `IN ('booking','loading','departed','arrived','customs','warehoused')`。
- `shipment` 真实含 **`warehouse_id`(00001:139)** 和 **`country`(00001:138)** → 绑定一致性校验（§4.2）可落地。
- `shipment.estimated_arrival` 为 **`date`(00001:141)**，仅由运营手工维护，喜运达无 ETA 字段。
- 🔴 **状态变更是受控事务**：`change_shipment_status_transactional`（00019 创建、00021 收紧为 **admin-only**、00022 加状态流校验）负责更新 `shipment.status` 并写入内部 `tracking_event`（审计）。**外部同步不得绕过该 RPC 直写 `shipment.status`**（§6 / §0）。

### 2.4 现有可复用基础设施（核实）
- `get_user_role()`（00001:229）；既有 RPC（00004/00005）用 `v_role := public.get_user_role();` 做角色校验。
- `user_warehouses(user_id, warehouse_id)`（00015）→ warehouse 级 RLS / 写入授权校验可落地。
- `profiles.is_active boolean NOT NULL DEFAULT true`（00001:50）；00025_rpc_caller_identity_binding 提供现成范式：`SELECT ... p.is_active ... IF NOT FOUND OR v_caller_is_active IS NOT TRUE THEN RAISE` → v4 的 SECURITY DEFINER RPC 安全规范（§7.3）对齐此范式。
- `src/app/api/cron/`、`src/features/in-transit/` 目录真实存在（无 `(dashboard)` 路由组）；但 **`src/app/api/cron/golucky/route.ts` 为「本方案新增交付物」，当前仓库不存在**——现有 `src/app/api/cron/` 仅有 `dry-run/route.ts`，该 golucky route 由实施阶段（Claude）新建。

---

## 3. 接入架构（v4：仅写外部表，绝不回写内部状态）

```
[喜运达 API]
   │ GET /tmsapi/tracking/list?transportNumber=<waybill_no>  Header: Access-Token
   ▼
src/lib/providers/golucky/client.ts   -- GET 封装；内部先 gettoken 换 token(2h 缓存+刷新) 再调 tracking
src/lib/providers/golucky/schema.ts   -- zod 校验
src/lib/providers/golucky/parse-response.ts -- 过滤标题节点、毫秒→timestamptz、生成 external_event_id 哈希、归类 external_category、provider 取自父 ref
src/lib/providers/golucky/dry-run.ts  -- dryRunWaybill()：只拉+解析+校验，不写库
   ▼
src/features/in-transit/golucky-sync.ts -- 编排：遍历 external_ref(provider='golucky')
   ├─► upsert tracking_event_external（external_event_id 唯一键去重，provider 由父 ref 派生）
   ├─► 更新 external_ref.sync_status / last_synced_at / raw_payload
   └─► 🔴 绝不回写 shipment.status / tracking_event / inventory / estimated_arrival / warehoused
   ▼
src/app/api/cron/golucky/route.ts     -- 【新增】cron 触发（CRON_SECRET 鉴权，service role 写库，仅可信服务端；当前仓库不存在，实施阶段新建）
```

> v4 与 v3 差异：① **移除一切 `shipment.status` 回写**（采用 Codex 方案 A）；② 批量导入改 `import_golucky_refs(p_items jsonb)`；③ Token 刷新改租约模型（§8.2）；④ Migration 拆三分（§5）。

---

## 4. 关联方式：两阶段绑定（v4 重写）

### 4.1 两阶段生命周期
1. **导入期（未绑定）**：运营/系统导入运单 → 建 `shipment_external_ref`（`shipment_id = NULL`，`warehouse_id` + `country` 必填，供 RLS 与展示）。仅出现在「外部物流记录」列表，不参与详情/推演/回写。
2. **绑定期（已绑定）**：运营在「外部物流记录」列表将 ref **绑定到内部 `shipment`**（或系统自动匹配）。绑定后：
   - Shipment 详情页经 `shipment → shipment_external_ref(shipment_id) → tracking_event_external` 展示外部轨迹（§9）。
   - 🔴 **修正 v3 矛盾表述**：绑定本身**不**使该记录进入在途推演。P0 仅有运单号/轨迹事件/外部状态，**无货物数量、无 ProductVariant/ShipmentItem 映射、无外部 ETA、无可计算 ETA 的预测模型**，因此无法参与在途推演或库存计算。只有后续完成 ShipmentItem/Variant 数量映射 + ETA 预测模型（属作战室/补货模块），才允许进入在途推演。

### 4.2 绑定一致性校验（Codex 第三轮 #4；v4 保留）
绑定必须走受保护 RPC `bind_external_ref_to_shipment`，校验通过才写：
- `external_ref.provider = 'golucky'`（或匹配）；
- 🔴 `external_ref.warehouse_id = shipment.warehouse_id`；
- 🔴 `external_ref.country = shipment.country`；
- `external_ref.shipment_id IS NULL`（未绑定；重绑需先解绑）；
- 成功 → `UPDATE shipment_external_ref SET shipment_id = $shipmentId, warehouse_id = shipment.warehouse_id WHERE id = $refId`。

### 4.3 已绑定仓库锁（Codex 第三轮 #5；v4 保留）
- 未绑定时 `warehouse_id` 由导入提供；已绑定后必须与 `shipment.warehouse_id` 一致。
- DB 触发器 `tg_shipment_external_ref_warehouse_lock`（BEFORE UPDATE）：若 `OLD.shipment_id IS NOT NULL AND NEW.warehouse_id IS DISTINCT FROM OLD.warehouse_id` → `RAISE EXCEPTION`。

### 4.4 导入入口（双）+ 批量 RPC（Codex 第四轮 #3 / 第五轮 #2）
1. **手动批量录入**：UI 粘贴一串运单号（一行一个 / 逗号分隔）→ 组装 `p_items` 数组 → 调 `import_golucky_refs`。
2. **表格导入**：P0 仅支持 **CSV**（文本粘贴 + CSV）；**Excel 解析（xlsx 依赖）推迟为独立增强项**，不纳入 P0（§5 / §12）。上传 CSV 解析运单号列 → 组装 `p_items` 数组 → 调 `import_golucky_refs`。
3. 每条 item 必须带 `waybill_no` + `warehouse_id` + `country`（`external_order_no` 可空）。
4. 🔴 **采用批量 RPC（方案 A）**：`import_golucky_refs(p_items jsonb)` 在**一个事务**内完成：全量参数校验 → 仓库授权校验 → provider 校验 → 运单号去重 → 批量写入 → 返回 `{succeeded, duplicated, failed}` 明细。**避免逐条调用产生大量部分成功状态**。
5. 🔴 **原子性与重复项语义（Codex 第五轮 #2，验收必须明确）**：
   - **参数格式错误**（jsonb 无法解析 / item 不满足最小 schema）→ **整批回滚**，不写任何行；`failed` 返回格式错误明细。
   - **未授权仓库**（`warehouse_id` ∉ 调用者 `user_warehouses`）→ **整批回滚**；`failed` 返回越权 item。
   - **同批次内重复 `waybill_no`** → 仅首条写入，其余标记 `duplicated`，**不重复插入**。
   - **已存在于库（同 `provider+waybill_no`）** → 标记 `duplicated`，并按 `ON CONFLICT DO UPDATE` 规则：
     - 更新 `raw_payload` / `updated_at`；
     - 🔴 **重置 `sync_status`：`error`/`stale` → `active`**（重新纳入 cron 同步）；但 `raw_payload` 中的异常标记（如 LOST）由轨迹层覆盖，不在此处保留。
   - **数据库异常**（唯一约束冲突 / 连接中断等）→ **整批回滚**。
   - 🔴 **禁止出现"部分成功但调用方不知情"的状态**：写入前先完成**全量预校验**（参数 + 授权 + 同批去重），预校验通过才进入写入事务；需要逐条失败明细的，明细来自预校验阶段，不在写入中途产生。
   - RPC 返回值 `failed[]` 仅含**预校验失败**明细（格式/授权/同批重复），不含数据库写入失败（写入失败即整批回滚，由异常统一处理）。

### 4.5 唯一键与去重（Codex 第三轮 #1；v4 保留）
- 删旧 `UNIQUE(provider, external_order_no)`；新增部分唯一 `idx_shipment_external_ref_provider_waybill ON (provider, waybill_no) WHERE waybill_no IS NOT NULL` —— **`waybill_no` 主去重键**；`external_order_no` 可空非唯一。
- > 说明：Codex 第三轮 #1 另建议 `(provider, external_order_no, waybill_no)` 复合唯一，因 `(provider, waybill_no)` 已唯一而被蕴含、冗余，v4 仅建 waybill 唯一索引。
- 重复导入：`ON CONFLICT (provider, waybill_no) WHERE waybill_no IS NOT NULL DO UPDATE`（更新 `raw_payload`/`sync_status`）。

### 4.6 P0 禁止已绑定 Shipment 换仓（Codex 第四轮 #5 + **第五轮 #1 必须修**）
- 🔴 **P0 明确"已绑定 Shipment 不支持换仓"**。若管理员修改 `shipment.warehouse_id`，已绑定 `external_ref` 不会自动跟随，将出现 `shipment.warehouse_id != external_ref.warehouse_id` 不一致，破坏 RLS 隔离 / 详情展示 / 未来作战室口径。
- 🔴 **v4 复审（第五轮）指出 v4 只加了 external_ref 侧触发器（`tg_shipment_external_ref_warehouse_lock`），但 `src/features/shipments/actions.ts` 的 `updateShipment()`（仅校验 admin 角色 + `validateWarehouseForShipment` 后直接 `shipmentRepository.update`）仍可改 `shipment.warehouse_id`，external_ref 侧锁无法拦截** → 必须补 `shipment` 侧数据库级保护。已读取真实代码核实：`updateShipment` 对"已绑定 external_ref 的 shipment 改 warehouse_id"零保护。
- 采用方案 A，**双保险（DB 触发器为主，应用层预校验为辅）**：
  1. 🔴 **DB 触发器（权威，不可绕过）** — Migration B 新增 `tg_shipment_no_rewarehouse_if_bound`（见 §5）：
     ```sql
     -- BEFORE UPDATE OF warehouse_id ON public.shipment
     CREATE OR REPLACE FUNCTION public.fn_shipment_no_rewarehouse_if_bound()
     RETURNS trigger LANGUAGE plpgsql AS $$
     BEGIN
       IF OLD.warehouse_id IS DISTINCT FROM NEW.warehouse_id
          AND EXISTS (
            SELECT 1 FROM public.shipment_external_ref
            WHERE shipment_id = NEW.id
          ) THEN
         RAISE EXCEPTION '该 Shipment 已绑定外部物流记录，P0 不支持换仓';
       END IF;
       RETURN NEW;
     END; $$;
     CREATE TRIGGER tg_shipment_no_rewarehouse_if_bound
       BEFORE UPDATE OF warehouse_id ON public.shipment
       FOR EACH ROW EXECUTE FUNCTION public.fn_shipment_no_rewarehouse_if_bound();
     ```
     无论走页面 `updateShipment`、还是任何其它写入路径（含 service_role / 未来迁移），只要改 `warehouse_id` 且存在绑定 ref，一律抛错。
  2. **应用层预校验（友好提示，非唯一防线）** — `updateShipment` Server Action 在 `shipmentRepository.update` 前增加：
     - 若 `parsed.data.warehouseId` 与 `OLD.warehouse_id` 不同，且 `existsBoundExternalRef(shipmentId)` 为真 → 直接返回中文错误 `'该在途记录已绑定外部物流，暂不支持换仓'`，不进入 DB 写。
     - 该检查仅作 UX 兜底；**真正的强制约束是上面的 DB 触发器**。
- §4.3 的 external_ref 侧锁保持不变（防止 `external_ref.warehouse_id` 被独立改动）。

---

## 5. 文件清单（v4：Migration 拆三分，Codex 第四轮 #9）

**新增**
- `src/lib/providers/golucky/{client,schema,parse-response,dry-run,types,index}.ts`
- `src/features/in-transit/golucky-sync.ts` — 同步编排（仅 upsert tracking_event_external + 更新 sync_status）
- `src/features/in-transit/golucky-import.ts` — 导入逻辑（解析**粘贴文本 / CSV** → 组装 `p_items` → 调 `import_golucky_refs` RPC；**Excel 解析推迟为独立增强，P0 不实现**）
- `src/app/api/cron/golucky/route.ts` — cron（CRON_SECRET 鉴权，service role 写库）【新建文件：当前仓库 `src/app/api/cron/` 仅有 `dry-run/route.ts`，此 route 由实施阶段新建】
- `src/app/dashboard/shipments/import/golucky/page.tsx` — 导入页（手动批量粘贴 / **CSV**；Excel 推迟）
- `src/features/in-transit/repository.ts` 新增：`getExternalRefsByProvider` / `upsertGoluckyEvents` / `updateExternalRefSync` / `getExternalTrackingByShipment` / `listUnboundExternalRefs`

**修改（Migration 拆为 A / B / C 三份）**

> 🔴 **Migration 编号（v6 修订）**：当前仓库最新 Migration 为 `00037`，故本方案三份依次定为 **`00038_golucky_schema.sql` / `00039_golucky_rls_rpc.sql` / `00040_golucky_token_cache.sql`**（基于 `00037` 基线的推荐连续编号）。Claude 实施前**必须重新检查 `supabase/migrations/` 最新编号**；若 `00038/00039/00040` 已被其他 Migration 占用，须**顺延为连续的三个新编号**（如 `00041/00042/00043`）。方案正文、§14 落地步骤、§5 文件清单、§16 验收标准中的 Migration 名称已统一为上述命名；**方案中不再出现 `0003x` 这类不可执行的占位编号**。
- **Migration A — `00038_golucky_schema.sql`（数据结构 + 历史回填）**
  1. 两处 `CHECK (provider IN ('best'))` → `IN ('best','golucky')`。
  2. `shipment_external_ref`：加 `shipment_id uuid REFERENCES shipment(id) ON DELETE SET NULL`；`external_order_no` 去 NOT NULL；**DROP** 旧 `idx_shipment_external_ref_provider_order`；加部分唯一 `idx_..._provider_waybill ON (provider, waybill_no) WHERE waybill_no IS NOT NULL`；加仓库锁触发器。
     - 🔴 **waybill 唯一索引迁移前预检（v6 引入；v7 改为可执行阻断机制；v8 固定唯一实现）**：在 `00038_golucky_schema.sql` 内，创建 `(provider, waybill_no) WHERE waybill_no IS NOT NULL` 部分唯一索引**前**，必须先执行历史重复数据预检。**不新增独立 preflight 脚本，不把实现选择留给 Claude**——固定采用方式 A：在同一 Migration 文件内、`CREATE UNIQUE INDEX` 语句之前放置 `DO $$ ... $$` 块，检测到重复即 `RAISE EXCEPTION`，使整个 Migration 失败并回滚、`CREATE UNIQUE INDEX` 不被执行。
       - 🔴 **预检结果必须为 0 条重复才允许执行 `CREATE UNIQUE INDEX`**；否则预检**抛出 Migration 异常**，**阻止后续唯一索引创建**，并在异常 `DETAIL` 中直接输出重复的 `provider`、`waybill_no` 及数量（见下 SQL）；**不删除、不合并、不随机保留**任何数据。
       - 🔴 **固定唯一实现（方式 A，v8 取消「二选一」）**：
         ```sql
         -- 迁移前预检：存在重复即中止，绝不自动删改数据
         DO $$
         DECLARE
           v_dup_group_count bigint;
           v_dup_details jsonb;
         BEGIN
           SELECT
             count(*),
             COALESCE(
               jsonb_agg(
                 jsonb_build_object(
                   'provider', provider,
                   'waybill_no', waybill_no,
                   'count', duplicate_count
                 )
                 ORDER BY provider, waybill_no
               ),
               '[]'::jsonb
             )
           INTO v_dup_group_count, v_dup_details
           FROM (
             SELECT
               provider,
               waybill_no,
               count(*) AS duplicate_count
             FROM public.shipment_external_ref
             WHERE waybill_no IS NOT NULL
             GROUP BY provider, waybill_no
             HAVING count(*) > 1
           ) duplicates;

           IF v_dup_group_count > 0 THEN
             RAISE EXCEPTION
               '发现 % 组重复 (provider, waybill_no)，Migration 已中止',
               v_dup_group_count
               USING
                 DETAIL = v_dup_details::text,
                 HINT = '请人工处理重复记录后重新执行 Migration；系统不会自动删除、合并或随机保留数据';
           END IF;
         END $$;

         -- 只有预检为 0 条重复时才执行
         CREATE UNIQUE INDEX idx_shipment_external_ref_provider_waybill
           ON public.shipment_external_ref (provider, waybill_no)
           WHERE waybill_no IS NOT NULL;
         ```
       - 🔴 **重复数据必须由人工确认后再继续迁移**：Migration/预检本身绝不自动删除、合并或随机保留任何重复记录。
       - 🔴 **不得只写「需要提供测试」**：必须明确「预检失败不得继续执行索引创建」——预检抛异常时，`CREATE UNIQUE INDEX` 一定不被执行。
       - 需提供重复数据场景的迁移验收测试或静态验证脚本（计入 §16 #14 / #15 / #20 / #21）。
  3. `tracking_event_external`：**回填** `external_event_id = md5(...||id)`（保非空且唯一）→ `SET NOT NULL` → `CREATE UNIQUE INDEX idx_tracking_event_external_dedup ON (external_ref_id, external_event_id)`；加 `external_category text NOT NULL DEFAULT 'unknown' CHECK(...)`；加 provider 一致性触发器（§10）。
- **Migration B — `00039_golucky_rls_rpc.sql`（权限 + RPC + 触发器）**
  1. 三张外部表补 **warehouse 级 SELECT RLS**（DROP 旧宽泛 operator SELECT 策略）；**不给 operator 任何 INSERT/UPDATE/DELETE 策略**。
  2. 三个 SECURITY DEFINER RPC（§7.2/§7.3）：
     - `import_golucky_refs(p_items jsonb)`
     - `bind_external_ref_to_shipment(p_ref_id uuid, p_shipment_id uuid)`
     - `reactivate_external_ref(p_ref_id uuid)`
     - `GRANT EXECUTE ON FUNCTION ... TO authenticated;`（并 `REVOKE ... FROM PUBLIC, anon`）
  3. 🔴 **Shipment 换仓保护触发器（Codex 第五轮 #1 必须修）**：`fn_shipment_no_rewarehouse_if_bound` + `tg_shipment_no_rewarehouse_if_bound`（`BEFORE UPDATE OF warehouse_id ON public.shipment`），当存在绑定 `shipment_external_ref` 且 `warehouse_id` 变化 → `RAISE EXCEPTION`。与 §4.6 双保险。
- **Migration C — `00040_golucky_token_cache.sql`（Token 缓存安全表）**
  1. 新建 `provider_token_cache`（含 `lease_owner` / `lease_until`，§8.2）。
  2. `ENABLE ROW LEVEL SECURITY` + `REVOKE ALL ON provider_token_cache FROM anon, authenticated;`（无 anon/authenticated 策略 → 普通用户不可读写）。

**不改动**
- `inventory` 任何逻辑；BigSeller 吸收链路 / 00026 入仓原子事务；best provider 文件（仅非破坏性回填其 `tracking_event_external`）。
- `tracking_event` 表结构（P0 不写）；`shipment_external_item` 表结构（P0 不读写）；`change_shipment_status_transactional`（P0 不调用）。

---

## 6. 状态映射：P0 只存外部状态，不回写内部（v4 重写，Codex 第四轮 #1/#8）

> 现有 `shipment.status` 枚举（00001:140）：`booking / loading / departed / arrived / customs / warehoused`，由 `change_shipment_status_transactional`（admin-only，00021）受控更新并写内部 `tracking_event` 审计。

### 6.1 三层（P0 只落地前两层）
```
外部原始状态 (golucky node code → 存 tracking_event_external.status)
        ▼
外部标准分类 (external_category → 落 tracking_event_external)
        ▼
是否回写内部 shipment.status  →  🔴 P0 不回写（方案 A）
```

### 6.2 🔴 P0 不自动回写 shipment.status（Codex 第四轮 #1，方案 A）
- **P0 只保存** `tracking_event_external.status` / `external_category` / 原始轨迹 / `sync_status`。**内部 `shipment.status` 继续由现有 `change_shipment_status_transactional` 流程维护。**
- 下方映射表**仅作为未来「系统同步 RPC（方案 B）」的参考**，不在 P0 实现：

| 喜运达节点（示例） | external_category | 未来方案 B 是否回写 | 说明 |
|-------------------|-------------------|---------------------|------|
| SHIPPED / MAIN_LINE_SHIPPED | in_transit | 拟回写 `departed` | 需方案 B 专门 RPC |
| DST_PORT_CHECK* | customs | 拟回写 `customs` | 需方案 B 专门 RPC |
| DELIVERYED | delivered | ❌ 不写 `warehoused` | 入仓由 00026 负责 |
| CREATED / CONFIRMED | created | ❌ | 发货前 |
| LOST / CANCELED / RETURNED / DESTROYED / DELIVERY_FAILED | exception | ❌ 仅存外部 | 异常不改性主状态 |

- 🔴 `warehoused` 永远不由喜运达同步写入（绕过 00026 吸收事务）。
- 🔴 **`arrived` 映射（Codex 第四轮 #8）**：当前**没有可靠的喜运达到港节点**可稳定映射 `arrived`，且 P0 本就不回写任何 `shipment.status`，故 P0 不写 `arrived`；`arrived` 节点映射推迟到方案 B，须先确认可靠节点 code 并补测试。

### 6.3 状态机（保留作方案 B 参考，P0 不实现）
未来方案 B 若实现回写，须遵循前进-only：`booking<loading<departed<arrived<customs<warehoused`，仅允许 `new_level > current_level`，旧节点不得覆盖新状态，`warehoused` 永不由同步写入。

---

## 7. RLS 设计：warehouse 级 SELECT + Operator 写入链路（v4）

### 7.1 warehouse 级 SELECT（修正既有仅按角色策略）
| 表 | operator 可见条件 |
|----|-------------------|
| `shipment_external_ref` | `warehouse_id IN (SELECT warehouse_id FROM user_warehouses WHERE user_id = auth.uid())`；`warehouse_id IS NULL` → 仅 admin |
| `shipment_external_item` | 经父表 `external_ref_id` 满足上述 warehouse 条件 |
| `tracking_event_external` | 经 `external_ref_id` → ref 满足上述 warehouse 条件 |

- **admin**：三表 `FOR ALL` 全量。
- 替换旧宽泛 operator SELECT 策略（DROP `authenticated_select_*`），改为 warehouse 限定 SELECT。

### 7.2 Operator 写入链路（RPC 模型）
RLS **只给 operator SELECT**；导入/绑定/重激活写入**不走直接表 INSERT/UPDATE**，统一走受保护 RPC：
```
页面/组件 → Server Action（requireActiveAuth() + Zod 校验）
  → 调用 SECURITY DEFINER RPC（import_golucky_refs / bind_external_ref_to_shipment / reactivate_external_ref）
      └─ RPC 内：校验 auth.uid() + profile.is_active + 角色 + 仓库授权 → 受控写库（definer 身份绕过 RLS）
```
- **Operator 不直接获得外部表任意 INSERT/UPDATE 权限**。
- 🔴 **禁止 Operator 直接更新**：`shipment_id` / `warehouse_id` / `provider` / `raw_payload` / `sync_status`（仅 RPC / cron（service_role）改）。
- **Cron 写入**：`src/app/api/cron/golucky/route.ts`【**新建文件**，当前仓库不存在，实施阶段由 Claude 新建】用 **service_role**（绕过 RLS），路由层 `CRON_SECRET` 鉴权，**绝不对 anon/authenticated 暴露**。

### 7.3 🔴 SECURITY DEFINER RPC 安全规范（Codex 第四轮 #6）
所有新增 RPC 必须：
- `SET search_path = ''`；函数体内**所有表名用 `public.` 限定**（对齐 00024/00025 项目范式）。
- `REVOKE EXECUTE ON FUNCTION ... FROM PUBLIC, anon;` 然后 `GRANT EXECUTE ON FUNCTION ... TO authenticated;`
- 函数首行校验 `auth.uid() IS NOT NULL`（未登录拒绝）。
- 校验当前用户 `profiles.is_active = true`（对齐 00025：`SELECT ... p.is_active ... IF NOT FOUND OR v_caller_is_active IS NOT TRUE THEN RAISE`）。
- operator 仅能操作 `user_warehouses` 授权仓库（绑定/重激活/导入的 `warehouse_id` 须 ∈ 授权集）。
- 🔴 **RPC 不接收调用者 `user_id` 参数**，身份一律取自 `auth.uid()`，**禁止通过传入任意 user_id 绕过当前用户身份**。
- 批量导入 RPC 在单事务内完成校验+写入，返回 `{succeeded, duplicated, failed}` 明细（§4.4）。

---

## 8. Cron 与 Token 缓存：工程化定义（v4）

### 8.1 Cron 鉴权与路径边界（golucky route 为本方案新增文件，非既有；dry-run 保持独立）

#### 8.1.1 golucky route 为本方案新增文件
- 🔴 **`src/app/api/cron/golucky/route.ts` 是「本方案新增交付物」，当前仓库不存在**——现有 `src/app/api/cron/` 仅有 `dry-run/route.ts`，该 golucky route 由实施阶段（Claude）新建。

#### 8.1.2 dry-run 与 golucky 的共存边界（v6 修订）
现有项目**已存在** `src/app/api/cron/dry-run/route.ts`（由 `CRON_API_KEY` 鉴权），且 `vercel.json` 已配置 `/api/cron/dry-run`。v6 明确以下共存边界：
1. **P0 新增** `src/app/api/cron/golucky/route.ts`（由 `CRON_SECRET` 鉴权）。
2. 🔴 **现有 dry-run Cron 必须保留**：不得删除、替换或改造成 golucky Cron；它是独立的既有调度，与 golucky 互不影响。
3. 🔴 **实施阶段应在 `vercel.json` 中新增 golucky 调度配置，同时保留 dry-run 配置**（本轮仅记录要求，不修改 `vercel.json`）：新增一条 `/api/cron/golucky` 的 cron 项，原有 `/api/cron/dry-run` 项保持不变。
4. 🔴 **golucky Cron 的具体 schedule 与时区（v8 最终）**：
   - golucky 同步**每天一次**（兼容 Vercel Hobby 计划限制）；
   - schedule 表达式明确写为 **`0 2 * * *`**（UTC 02:00，北京时间 10:00）；
   - 🔴 **该表达式按 UTC 执行**（Vercel Cron 的 cron 表达式以 UTC 解释，非本地时区）；
   - `vercel.json` 最终应**同时存在** `/api/cron/dry-run` 与 `/api/cron/golucky` 两条配置；
   - 🔴 **golucky 只能有一个配置**，不得重复添加第二条 golucky Cron。
5. 🔴 **「只调一条路径」只针对 golucky 同步任务**，含义是：
   - golucky 同步只能有一个调度入口；
   - 不得同时配置两个 golucky Cron；
   - 不得同时使用 Vercel Cron 和 Supabase Scheduled Functions 调用 golucky；
   - 现有 dry-run Cron **不属于** golucky 同步路径，不算重复实现。
6. 实施阶段若部署环境非 Vercel（改用 Supabase Scheduled Functions），**必须移除 golucky 的 Vercel 调度，不能双线运行**；但二选一、不留 Vercel + Supabase 双套 golucky 调度；**dry-run 调度不受影响**，维持原样。

#### 8.1.3 golucky route 鉴权与失败关闭
- 路由校验 `Authorization: Bearer $CRON_SECRET`（env）；写库用 **service_role**（绕过 RLS）。
- 🔴 **该 route 绝不对 `anon` / `authenticated` 暴露**：仅由 Vercel Cron（或部署环境等效定时任务）以 `CRON_SECRET` 调用，service_role 写库。
- 🔴 **golucky 同步只允许一条调度路径；现有 dry-run Cron 保持独立运行**（取代旧述「Vercel Cron 只调一条路径」）。
- 🔴 **`CRON_SECRET` 缺失必须失败关闭（fail-closed，v6 引入；v7 固定唯一行为）**，鉴权顺序固定为「配置检查优先于请求鉴权检查」：
  1. **配置检查（第一步，优先于鉴权）**：route 每次请求开始时先读 `process.env.CRON_SECRET`。
  2. 🔴 **唯一失败关闭方式（v7 固定）**：若 `CRON_SECRET` 不存在或为空字符串，**直接返回 HTTP 500 配置错误**——不再保留「启动/部署检查失败 或 每次请求返回 500」的二选一，统一为**请求返回 500 配置错误**；且**绝不把空字符串视为合法 secret**。
  3. `CRON_SECRET` 缺失（返回 500）时**不得读取 `Authorization`、不得访问数据库、不得刷新 Token、不得调用物流 API**。
  4. **请求鉴权检查（第二步，仅在 `CRON_SECRET` 已配置后执行）**：校验 `Authorization: Bearer $CRON_SECRET`——
     - 缺少 `Authorization` → **401**；
     - `Bearer` 格式错误 → **401**；
     - secret 错误 → **401**；
     - 正确且**非空** secret → 才能进入同步逻辑。
  5. 🔴 鉴权失败（401）或配置缺失（500）时**一律不得访问数据库、不得刷新 Token、不得调用物流 API**。

### 8.2 Token 缓存 + 安全边界 + 刷新租约（Codex 第四轮 #2/#8）
- 新建 `provider_token_cache(provider text PRIMARY KEY, access_token text NOT NULL, expires_at timestamptz NOT NULL, lease_owner uuid, lease_until timestamptz, updated_at timestamptz NOT NULL DEFAULT now())`。
- 🔴 **安全边界**：`ENABLE ROW LEVEL SECURITY` + `REVOKE ALL ON provider_token_cache FROM anon, authenticated;`（不建 anon/authenticated 策略 → 普通用户不可读写；仅 service_role / definer 可访问）。页面与普通 Repository **不得**直接查询此表。
- 🔴 **明文 Token 风险**：`access_token` 明文存储（喜运达要求 bearer 原值出站）。建议后续用 Supabase 列加密（pgsodium / Vault）做 at-rest 加密；P0 靠 RLS + service_role-only + DB at-rest 加密兜底。
- 🔴 **刷新租约模型（修正 v3 的 SKIP LOCKED 误述；第五轮 #3 补事务边界）**：`SKIP LOCKED` 语义是**跳过被锁行而非读取该行**，原描述不准确。v4/v5 改用租约字段，且**严格两阶段、DB 行锁绝不跨网络调用**：
  1. **阶段一·抢租约（短事务，无网络）**：`SELECT ... FROM provider_token_cache WHERE provider=$p FOR UPDATE;`（普通 `FOR UPDATE`）→ 判断是否需要刷新 → `UPDATE ... SET lease_owner=my_id, lease_until=now()+interval '30s' WHERE provider=$p AND (lease_until IS NULL OR lease_until < now())` → **立即 `COMMIT`，释放行锁**。此事务内**绝不调用外部 `gettoken`**。
  2. 若 `expires_at - now() > 5min` 且未被他者租约占用 → 直接使用，不抢租约。
  3. **阶段二·调外部 API（无 DB 锁）**：仅在抢到租约（阶段一提交成功）后，才在**事务之外**调用 `gettoken` 网络请求；期间**不持有任何数据库行锁**。
  4. **写回校验所有权**：外部返回后，写回 `access_token` 必须用 `UPDATE provider_token_cache SET access_token=..., expires_at=..., lease_owner=NULL, lease_until=NULL WHERE provider=$p AND lease_owner=my_id;` —— 确认**自己仍持有租约**才写；若租约已被他人抢占（`lease_owner != my_id`），**丢弃本次结果、不覆盖新 Token**。
  5. **缓存未命中（无行）**：`INSERT INTO provider_token_cache(...) VALUES(...) ON CONFLICT (provider) DO NOTHING;` 再重查，避免重复插入竞态。
  6. **刷新失败处理**：
     - 旧 `expires_at > now()` → **继续用旧 Token**，仅释放本实例租约（`lease_owner=NULL`）；
     - 旧 Token 也已过期 → **返回明确错误**（cron 记录该 ref 失败，不阻塞整批），并释放/标记租约，避免永久占用；
     - 阶段二网络超时但未拿回 Token → 同样释放租约，不长期持有。

### 8.3 批处理与失败隔离
- 拉取 `sync_status='active'` 且未终态 golucky `external_ref`，**固定并发上限（默认 5）**逐单查询。
- 单条失败：`catch` → 写 `sync_status='error'` + `raw_payload.error`，**不中断整批**。
- 限频：cron 间隔保守（默认 6h），单请求间小延迟；遇 `429` 读 `Retry-After` 指数退避。

### 8.4 终态与重激活
- 终态节点 → `sync_status='stale'`，后续 cron 跳过（降频）。
- 手动重激活：运营点某 ref → 调 `reactivate_external_ref` RPC 重置 `sync_status='active'`。

### 8.5 🔴 `CRON_API_KEY` 与 `CRON_SECRET` 职责隔离（v6 新增）

> 现有项目已有 `/api/cron/dry-run` 使用 `CRON_API_KEY`；P0 新增 `/api/cron/golucky` 使用 `CRON_SECRET`。v6 明确两者严格分属不同 Cron，不得混用：

- 🔴 **`CRON_API_KEY` 继续只用于现有 `/api/cron/dry-run`**（既有调度，鉴权变量不变）。
- 🔴 **`CRON_SECRET` 只用于新增 `/api/cron/golucky`**（P0 同步调度）。
- 🔴 **两个 secret 不能混用**：不得为复用配置而修改 dry-run route 的鉴权变量，也不得让 golucky route 读取 dry-run 的 secret。
- 🔴 **golucky route 不得读取或接受 `CRON_API_KEY`**；其鉴权仅认 `CRON_SECRET`。
- 🔴 **dry-run route 不得读取或接受 `CRON_SECRET`**；其鉴权仅认 `CRON_API_KEY`。
- 后续实施需同步更新部署配置（Vercel 项目 env / CI secret）与环境变量说明，将 `CRON_SECRET` 与既有 `CRON_API_KEY` 并列配置；**本轮仅在方案中记录，不修改任何项目文件（`vercel.json` / `.env.example` / 源码）**。

---

## 9. Shipment 详情页数据链路（v4）
```
Shipment 详情页 (shipments/[id])
   └─ Repository.getExternalTrackingByShipment(shipmentId)
        └─ SELECT tracking_event_external.*
           FROM shipment_external_ref r
           JOIN tracking_event_external e ON e.external_ref_id = r.id
           WHERE r.shipment_id = $shipmentId
           ORDER BY e.occurred_at
   └─ 渲染「外部物流轨迹」区块（原始节点 + external_category 标签）
```
- 仅**已绑定** ref 出现；未绑定记录只在「外部物流记录」列表（走 `listUnboundExternalRefs`，受 §7.1 RLS）。

---

## 10. 外部事件幂等 + provider 一致性（v4）

### 10.1 幂等唯一约束（Codex 第三轮 #2；v4 保留）
- 喜运达节点无事件 ID → `external_event_id` 由解析层生成确定性哈希：
  ```ts
  const external_event_id = crypto.createHash('sha256')
    .update([provider, node.code ?? '', node.title ?? '', node.desc ?? '', String(occurred_at ?? '')].join('|'))
    .digest('hex');
  ```
- DB 层：`UPDATE tracking_event_external SET external_event_id = md5(...||id) WHERE external_event_id IS NULL;` → `ALTER COLUMN external_event_id SET NOT NULL;` → `CREATE UNIQUE INDEX idx_tracking_event_external_dedup ON (external_ref_id, external_event_id);`（彻底消除 NULL 唯一规则失效）。

### 10.2 🔴 provider 一致性校验（Codex 第四轮 #7）
- `tracking_event_external` 同时有 `external_ref_id` 与 `provider`，须保证二者一致：`tracking_event_external.provider = 父 ref.provider`。
- v4 在 `upsertGoluckyEvents` 中**始终从父 `shipment_external_ref` 派生 provider**，绝不独立传入。
- 加触发器 `tg_tracking_event_external_provider_consistent`（BEFORE INSERT/UPDATE）：`IF NEW.provider IS DISTINCT FROM (SELECT provider FROM public.shipment_external_ref WHERE id = NEW.external_ref_id) THEN RAISE EXCEPTION; END IF;`（强一致兜底）。

---

## 11. P0 边界清单（v4 汇总，Codex 第四轮 #10）

**P0 做（13 项）**：
1. golucky Provider 接入 2. Token 获取 + 安全缓存（租约模型）3. dry-run 4. 手动批量运单导入（文本粘贴）5. **CSV 运单导入（Excel 推迟为独立增强）** 6. external_ref 两阶段绑定（含仓库·国家一致）7. tracking_event_external 轨迹同步 8. external_category 分类 9. 仓库级 RLS 10. Shipment 详情页展示外部轨迹 11. Cron 批处理/限频/失败隔离/重试 12. 未绑定外部物流记录列表 13. 手动重激活同步

**P0 不做（11 项）**：
1. ❌ 不写 `tracking_event`（仅 `tracking_event_external`）
2. ❌ 不写 `inventory.quantity`
3. ❌ 不写 `warehoused`（不绕过 00026）
4. ❌ 不写 `estimated_arrival`（喜运达无 ETA 字段）
5. 🔴 **不自动回写 `shipment.status`**（不绕过 `change_shipment_status_transactional` 事务/审计/admin-only）
6. ❌ 不导入 `shipment_external_item`
7. ❌ 不做 `matched_variant_id` 匹配
8. ❌ 不参与作战室库存计算
9. ❌ 不参与补货引擎计算
10. 🔴 **不支持已绑定 Shipment 换仓（DB 触发器强制 + 应用层预校验）**
11. 🔴 **暂不强制加入 Excel 解析依赖（xlsx）**——P0 仅文本粘贴 + CSV

---

## 12. 待 Rall / Codex 确认（v5 已解决项）
- ✅ 凭证与鉴权 / 响应结构（标题节点过滤、毫秒、无 ETA）/ 两阶段绑定+一致性 / 状态不回写（方案 A）/ RLS warehouse SELECT + RPC 写入 / 唯一键 / 幂等+哈希 / external_category / token 安全+租约 / shipment_external_item 非 P0 / 仓库锁 / 换仓禁止（**DB 触发器 + 应用层双保险**）/ SECURITY DEFINER 规范 / provider 一致性 / Migration 拆分 / **批量原子性与重复项语义** / **Token 租约两阶段事务边界** / **Shipment 侧换仓触发器**。
- ✅ **表格解析依赖（第五轮 #4 已定）**：P0 **仅文本粘贴 + CSV**，不引入 `xlsx` 依赖；Excel 解析推迟为独立增强项（后续评估依赖体积与解析安全风险后再决定）。
- ✅ **Cron 调度平台（第五轮 #4 已定）**：P0 采用 **Vercel Cron** 周期调用本方案新增的 `src/app/api/cron/golucky/route.ts`（**当前仓库不存在，由实施阶段新建**；现有 `src/app/api/cron/` 仅有 `dry-run/route.ts`）；`CRON_SECRET` 走环境变量（Vercel 项目 env / CI secret），轮换通过更新 env 实现。Supabase Scheduled Functions 作为备选架构，**不双线并行实现**——若最终部署环境非 Vercel，Claude 落地前改走 Supabase Scheduled Functions，但二选一、不留两套路径。
- ⏳ 方案 B（系统同步 RPC 回写 status）的 `arrived` 节点映射与测试 — 推迟，不在 P0。

---

## 13. 风险与注意（v4）
- 🔴 三份 Migration 各自独立、可单独回滚（A 结构回填 / B 权限 RPC / C Token 表）。
- 🔴 解析**必须 `filter(node => node.code)`**；`time` 毫秒转换；喜运达无 `location`。
- 🔴 **P0 绝不回写 `shipment.status`**（绕过 00021 admin-only + 00022 状态流校验 + 内部 tracking_event 审计）。
- 🔴 三表 RLS warehouse 级 + Operator 写入仅走 RPC；`provider_token_cache` 必须 `REVOKE anon/authenticated`。
- 🔴 Token 刷新用租约模型（两阶段：抢租约短事务 → 事务外调外部 API → 写回校验 `lease_owner=my_id`），**DB 行锁绝不跨网络调用**，不可声称 SKIP LOCKED 自动读新鲜值。
- 🔴 已绑定 Shipment 不支持换仓：`shipment` 侧 DB 触发器 `tg_shipment_no_rewarehouse_if_bound` 强制 + `updateShipment` 应用层预校验（§4.6 双保险）。
- 🔴 批量导入 `import_golucky_refs` 整批原子：参数/授权错误整批回滚；无"部分成功不知情"状态（§4.4）。
- dry-run 先行验证解析，再接 cron 落库，与 best 一致。

---

## 14. 落地步骤顺序（v4）
1. **Migration A**（`00038_golucky_schema.sql`）：CHECK 扩展 + `shipment_id` + `external_order_no` 可空 + 删旧唯一 + waybill 部分唯一 + 仓库锁触发器 + `external_event_id` 回填/NOT NULL/唯一 + `external_category` 字段 + provider 一致性触发器。
2. **Migration B**（`00039_golucky_rls_rpc.sql`）：三表 warehouse SELECT RLS（DROP 旧宽泛策略）+ 三个 SECURITY DEFINER RPC（含 §7.3 安全规范）+ REVOKE/GRANT + 🔴 `shipment` 侧换仓保护触发器 `tg_shipment_no_rewarehouse_if_bound`（§4.6）。
3. **Migration C**（`00040_golucky_token_cache.sql`）：`provider_token_cache` 表（含租约字段）+ RLS + REVOKE anon/authenticated。
4. 扩展 `ExternalProvider` 类型 + `externalProviderSchema`。
5. `lib/providers/golucky/` 六件套（client/schema/parse-response【哈希+分类+provider 派生】/dry-run/types/index）。
6. repository 新方法（getExternalRefsByProvider / upsertGoluckyEvents【派生 provider】/ updateExternalRefSync / getExternalTrackingByShipment / listUnboundExternalRefs）。
7. `golucky-sync.ts` 编排（仅写 `tracking_event_external` + 更新 sync_status）+ cron route【**新建** `src/app/api/cron/golucky/route.ts`】（CRON_SECRET 失败关闭：先配置检查再鉴权 + token 租约 + 批处理/失败隔离/终态降频）；`vercel.json` 新增 `/api/cron/golucky` 项，**schedule 为 `0 2 * * *`（每天一次，UTC 02:00 / 北京时间 10:00，兼容 Hobby）**，同时**保留既有 `/api/cron/dry-run` 项**，golucky 仅此一条配置。
8. 导入入口页 + 导入逻辑（手动文本粘贴 / **CSV** → 组装 `p_items` → 调 `import_golucky_refs`；Excel 推迟）。
9. Shipment 详情页「外部物流轨迹」+「外部物流记录」列表（绑定/重激活走 RPC）。
10. **dry-run 验证**（样本运单 `GLLAN26062906249PHE`：gettoken→tracking→过滤标题节点→落 `tracking_event_external`，不写 `tracking_event`/`shipment.status`）。
11. typecheck + **全量测试（CI 基线 3524/3524）** 无回归。
12. Shipment 详情页确认外部轨迹可见（§9 链路）。

---

## 15. Codex 评审结论对照

### 15.1 首轮 / 第三轮
（同 v3 §15.1 / §15.2，均已落实。）

### 15.2 v3 复审（第四轮，2026-07-11）
| # | Codex 第四轮意见 | v4 处理 | 取证 |
|---|----------------|--------|------|
| 1 | 回写 status 绕过现有事务 | ✅ 采用方案 A：P0 不回写 `shipment.status` | `change_shipment_status_transactional` 存在(00019/21/22)，00021 收 admin-only → 绕过属实 |
| 2 | SKIP LOCKED 误述 | ✅ 改租约模型（lease_owner/lease_until），纠正语义 | Postgres SKIP LOCKED=跳过锁行，非读新鲜值 |
| 3 | 批量 RPC 不一致 | ✅ 改 `import_golucky_refs(p_items jsonb)` 单事务批量 | — |
| 4 | ETA 推演表述矛盾 | ✅ §4.1 改写：绑定≠进入推演，需后续数量映射+ETA 模型 | 喜运达无 ETA/数量基础 |
| 5 | 已绑定换仓锁不全 | ✅ §4.6 采用方案 A：P0 禁止已绑定 Shipment 换仓 | — |
| 6 | SECURITY DEFINER 安全要求 | ✅ §7.3 补全 search_path/is_active/auth.uid/REVOKE/禁传 user_id | `profiles.is_active`(00001:50)+00025 范式存在 |
| 7 | provider 一致性 | ✅ §10.2 派生 provider + 一致性触发器 | — |
| 8 | arrived 映射不明确 | ✅ P0 不回写任何 status；arrived 推迟方案 B | 无可靠到港节点 |
| 9 | Migration 过大 | ✅ 拆 A/B/C 三份（结构/权限/Token） | — |
| 10 | P0 边界 | ✅ §11 对齐为做 13 / 不做 10（含不回写 status、不支持换仓） | — |

### 15.3 v4 复审（第五轮，2026-07-11）
| # | Codex 第五轮意见 | v5 处理 | 取证 |
|---|----------------|--------|------|
| 1（必须修） | 禁止换仓没落到 Shipment 更新链路（`updateShipment` 仍可改 `warehouse_id`） | ✅ 新增 `shipment` 侧 DB 触发器 `tg_shipment_no_rewarehouse_if_bound`（BEFORE UPDATE OF warehouse_id，存在绑定 ref 即抛错）+ `updateShipment` 应用层预校验双保险 | 读 `src/features/shipments/actions.ts:82-114`：`updateShipment` 仅校验 admin + `validateWarehouseForShipment` 后 `shipmentRepository.update`，对改 `warehouse_id` 零保护；v4 §4.6 仅 external_ref 侧锁 → 属实 |
| 2 | 批量 RPC 原子性/重复项语义不清 | ✅ §4.4 列明：参数/授权错误整批回滚、同批重复→duplicated、已存在→重置 `error/stale`→`active`、DB 异常整批回滚、禁止部分成功不知情 | — |
| 3 | Token 租约事务边界（不可跨网络持锁） | ✅ §8.2 改两阶段：抢租约短事务（无网络）→ 事务外调 gettoken → 写回校验 `lease_owner=my_id`；失败释放租约 | Postgres `FOR UPDATE` 持锁期间不能做外部网络调用 |
| 4 | P0 依赖最终选择 | ✅ §12 已定：P0 仅文本粘贴+CSV（Excel 推迟）；Cron 用 Vercel Cron 调本方案新增 route（当前仓库不存在，实施阶段新建；现有 `src/app/api/cron/` 仅 `dry-run/route.ts`，dry-run 与 golucky 独立共存），CRON_SECRET 走 env，golucky 二选一不双线（dry-run 不受影响） | `src/app/api/cron` 目录存在，但 `golucky/route.ts` 为新增文件、当前不存在 |
| 5（通过确认） | v4 已通过部分（不回写 status / 外部表独立 / RLS / RPC 安全 / Migration 拆分等） | ✅ 维持 v4 结论，v5 仅补上述 4 项 | — |

*本方案为设计文档，落地由 Claude 执行。v8 已据 Codex 首轮 + 第三轮 + v3 复审（第四轮）+ v4 复审（第五轮）+ v5→v6 修订 + v6→v7 修订 + v7→v8 修订全面修订；若无新的结构性问题，第一份喜运达方案即可判定为「可进入 Migration 设计与 Claude 实施阶段」。*

---

## 16. 验收标准（Cron 路由 / 写入边界 / Migration 编号 / Cron 共存 / secret 隔离 / 索引预检 / 失败关闭 / schedule，v7 更新）

> #1–#8 为 v5 已定验收；#9–#16 为 v6 新增（Migration 编号 / dry-run 共存 / vercel 单配置 / secret 不混用 / CRON_SECRET 失败关闭 / waybill 索引预检）；#17–#23 为 v7 新增（CRON_SECRET 唯一 500 + 鉴权顺序 / 401 / 鉴权失败不碰库 / 预检可执行阻断 / schedule UTC / dry-run 保留单 golucky）。#1–#6 直接对应「golucky cron route 为新增文件」的事实修正。

1. **`src/app/api/cron/golucky/route.ts` 必须新建且存在**：实施阶段由 Claude 新建该 route；仓库基线仅有 `dry-run/route.ts`，验收需确认本 route 已落地（非既有文件）。
2. **`CRON_SECRET` 鉴权拒绝**：未带 / 带错 `Authorization: Bearer $CRON_SECRET` 的请求返回 401；仅正确 secret 可触发同步。
3. **`anon` 不可直写外部表**：`anon` 角色无 `tracking_event_external` / `shipment_external_ref` 任何 INSERT/UPDATE 权限；外部表写入仅经 RPC（authenticated）或 cron（service_role）。
4. **`service_role` 写外部表**：cron route 以 `service_role` 绕过 RLS 写入 `tracking_event_external` + 更新 `sync_status`，不依赖普通用户 RLS。
5. **golucky 同步只允许一条调度路径；现有 dry-run Cron 保持独立运行**：golucky 同步只能有一个调度入口，不得同时配置两个 golucky Cron，不得同时用 Vercel Cron 与 Supabase Scheduled Functions 调 golucky；现有 `/api/cron/dry-run` 属独立既有调度，不计入 golucky 路径重复。
6. **不双线**：非 Vercel 部署时才改走 Supabase Scheduled Functions，二者二选一，不留 Vercel + Supabase 双套调度。
7. **不回写 `shipment.status`**：cron 同步全程只写 `tracking_event_external` + `sync_status`，绝不调用 `change_shipment_status_transactional`、绝不写 `shipment.status` / `tracking_event` / `inventory` / `shipment_external_item` / `estimated_arrival`。
8. **只写 `tracking_event_external` + 外部表 sync 字段**：P0 写入边界严格限定为 `upsert tracking_event_external` 与更新 `shipment_external_ref` 的 `sync_status` / `last_synced_at` / `raw_payload`，不触碰任何内部表结构或回写主状态。

9. **Migration 编号基于当前最新编号连续生成，不使用 `0003x` 占位符**：实施阶段三份 Migration 命名为 `00038_golucky_schema.sql` / `00039_golucky_rls_rpc.sql` / `00040_golucky_token_cache.sql`（基于 `00037` 基线）；若被占用须顺延为连续三个新编号；方案中无 `0003x` 占位。
10. **现有 `/api/cron/dry-run` 配置仍保留**：不得删除、替换或改造成 golucky Cron；dry-run 调度与 golucky 调度独立共存。
11. **`vercel.json` 中 golucky 只有一个调度配置**：新增 `/api/cron/golucky` 项的同时保留既有 `/api/cron/dry-run` 项，无第二个 golucky Cron 配置。
12. **`CRON_API_KEY` 与 `CRON_SECRET` 不混用**：dry-run route 仅认 `CRON_API_KEY`、golucky route 仅认 `CRON_SECRET`，两 route 互不读取对方 secret。
13. **`CRON_SECRET` 缺失时 route 失败关闭**：env 缺失或为空字符串时不得进入同步；缺失时**统一每次请求返回 500 配置错误**（v7 已取消「启动/部署检查失败 或 请求返回 500」二选一）；`Authorization` 缺失 / Bearer 格式错 / secret 错统一 401；仅正确非空 `CRON_SECRET` 可进入同步；鉴权失败不访问 DB / 不刷新 Token / 不调物流 API。
14. **创建 waybill 唯一索引前，历史重复数据预检必须通过**：`(provider, waybill_no) WHERE waybill_no IS NOT NULL` 索引创建前须先跑重复查询，仅 0 条重复才允许建索引。
15. **历史存在重复 waybill 时，Migration 必须中止且不得自动删除数据**：重复行须输出 `provider` / `waybill_no` / 数量并由人工确认；Migration 不得自动删除、合并或随机保留。
16. **golucky 不得同时由 Vercel Cron 和 Supabase Scheduled Functions 双重调度**：golucky 同步二选一，不留两套调度路径（dry-run 不受影响）。

17. **`CRON_SECRET` 缺失时固定返回 500，且优先于 Authorization 检查**：route 每次请求先做配置检查（读 `process.env.CRON_SECRET`），不存在或为空串时**直接返回 500 配置错误**（唯一方式，非启动/500 二选一），且此时**不读取 `Authorization`**；配置检查通过后才进入请求鉴权检查。
18. **`CRON_SECRET` 已配置但鉴权失败时返回 401**：`Authorization` 缺失、`Bearer ` 空值 / 格式错误、secret 错误一律返回 401；仅正确且非空 secret 才能进入同步逻辑。
19. **鉴权失败时不得产生副作用**：无论 500（配置缺失）还是 401（鉴权失败），route 都**不得访问数据库、不得刷新 Token、不得调用物流 API**。
20. **waybill 重复预检失败时必须非零退出并阻止唯一索引创建**：构造重复 `(provider, waybill_no)` 数据时，预检（固定为 Migration 内 `DO` 异常阻断，v8 已取消 preflight 脚本二选一）必须**非零退出 / 抛异常**，使 `CREATE UNIQUE INDEX` **不被执行**，并在异常 `DETAIL` 中输出重复的 provider / waybill_no / 数量。
21. **waybill 无重复时预检通过并允许创建唯一索引**：0 条重复时预检通过，正常执行 `CREATE UNIQUE INDEX idx_shipment_external_ref_provider_waybill`。
22. **预检失败不得修改或删除历史数据**：预检中止时绝不删除、合并或随机保留任何重复记录，历史数据保持原样，须人工确认后再迁移。
23. **golucky Cron schedule 为 `0 2 * * *`、时区 UTC**：`vercel.json` 中 golucky 项 schedule 固定为 `0 2 * * *`（每天一次，UTC 02:00 / 北京时间 10:00，兼容 Hobby 计划限制）；现有 `/api/cron/dry-run` 保留，且**只存在一个 golucky Cron 配置**。
