# DIS 数据库设计

> 本页解释历史基础模型；当前SQL历史到00052，完整事实以Migration为准。ICE v4 增量目标见 [database-design-v2.md](database-design-v2.md)，该设计未执行。现役inventory.quantity是可售量，正常到仓不增加库存；差异和残留写入口见 [current-analysis.md](current-analysis.md)。

> 文档导航：[文档树](README.md) · [架构](architecture.md) · [当前状态](current-state.md) · [部署](deployment.md)

## 事实来源

数据库真实结构以 `supabase/migrations/` 为准。本文用于解释模型和维护约束，不替代 Migration。

当前 Migration：

- `00001_initial_schema.sql`：初始 10 表、函数、触发器、Seed 与 RLS
- `00002_create_shipment_transaction.sql`：事务化创建 Shipment、明细与初始轨迹
- `00003_tighten_variant_rls.sql`：收紧 ProductVariant RLS，移除 operator UPDATE 权限
- `00049_database_least_privilege_hardening.sql`：固定目标函数 search_path、收紧 trigger/RPC EXECUTE，并把 provider token cache 限制为 lease RPC 访问
- `00050_optimize_auth_rls_initplan.sql`：将六条已审 `auth.uid()` RLS 策略改为等价 scalar-subquery init-plan 形式；不改表、函数、ACL、业务数据或历史 Migration

## 核心关系

```text
auth.users
  └── profiles ── role

product
  └── product_variant
        ├── inventory ── warehouse
        └── shipment_item ── shipment ── warehouse
                              └── tracking_event

warehouse
  └── sync_log
```

## 表职责

| 表 | 职责 |
|---|---|
| `role` | `admin`、`operator` 角色 |
| `profiles` | 用户资料、角色和启用状态 |
| `product` | 标准产品、分类、单位和安全库存 |
| `product_variant` | 各国家仓库 SKU 与 Product 映射 |
| `warehouse` | 中国及五个海外仓配置 |
| `inventory` | ProductVariant 在 Warehouse 的当前库存 |
| `shipment` | 在途运输主单 |
| `shipment_item` | Shipment 产品明细与入仓数量 |
| `tracking_event` | Shipment 状态历史 |
| `sync_log` | 仓库同步结果 |

## 关键约束

- `product.code` 唯一
- `product.safety_stock >= 0`
- `product_variant (sku, country)` 唯一
- `product_variant.product_id` 可为空，删除 Product 时设为 NULL
- `inventory (variant_id, warehouse_id)` 唯一
- `inventory.quantity >= 0`
- `shipment_item.quantity >= 1`
- `0 <= warehoused_quantity <= quantity`
- 国家限制为 `TH`、`ID`、`MY`、`PH`、`VN`、`CN`
- Shipment 状态限制为 `booking`、`loading`、`departed`、`arrived`、`customs`、`warehoused`

## 函数与触发器

- `get_user_role()`：返回当前用户角色
- `handle_new_user()`：Auth 用户创建后生成 Profile
- `update_updated_at_column()`：维护更新时间
- `create_shipment_transactional()`：原子创建 Shipment、ShipmentItem 和初始 TrackingEvent

OPT-5 权限约束：trigger-only 函数不作为 PostgREST RPC 暴露；`get_user_role()` 仅供 authenticated/RLS 调用；用户管理 RPC 保持 `SECURITY INVOKER` 与 authenticated-only；`provider_token_cache` 不提供 anon/authenticated policy，service_role 也不直接访问表，只能调用三个经审计的 `SECURITY DEFINER` lease RPC。实现与验证见 [OPT-5 数据库最小权限收口报告](reports/2026-07-20-opt5-database-least-privilege.md)。

业务逻辑不应继续写入普通数据库触发器；复杂写入优先使用经过审计的事务函数或应用服务。

## RLS 模型

所有业务表启用 RLS。

| 角色 | 基础策略 |
|---|---|
| Admin | 所有表读写 |
| Operator | 读取业务表，写入允许的 Inventory、Shipment、ShipmentItem、TrackingEvent；ProductVariant 仅 SELECT（00003 收紧） |
| 未登录用户 | 无业务表访问权限 |

Server Action 权限检查和 RLS 必须同时存在。前端权限不构成安全边界。

## Migration 规则

- 每次结构变更新增独立 Migration
- 禁止修改已执行 Migration
- 新增表必须同时提供约束、索引和 RLS
- 新增字段应考虑已有数据和默认值
- 外键必须明确 `ON DELETE` 行为
- 回滚通过新 Migration 完成
- 禁止手动修改生产数据库

## V1 数据策略

- Inventory 使用当前值覆盖更新，不保存历史快照
- SyncLog 仅记录仓库级同步结果
- ProductVariant 映射由 Admin 人工确认
- Shipment 状态手动推进

这些限制已被接受，变更前需要完整迁移和兼容方案。
