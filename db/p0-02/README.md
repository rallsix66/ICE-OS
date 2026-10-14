# P0-02 独立 PostgreSQL 基线

**不是** `supabase/migrations/00001–00052` 的运行时重放入口。历史 migration 原件保留；replay 测试仍可使用 Supabase stub，但 P0-02 实例只执行本目录脚本。

## 应用顺序（`scripts/p0-02/apply-schema.mjs`）

| 脚本 | 说明 | 对应 legacy |
|---|---|---|
| `001_instance_and_roles.sql` | `p0_02_meta`、owner/runner 角色 | 新建 |
| `002_session_identity.sql` | `auth.uid()` → 事务 GUC；`ice_auth_user_map` | 替代 Supabase Auth 绑定 |
| `003_extensions.sql` | `uuid-ossp`、`pg_trgm` | 00001 / 00036 |
| `010_public_schema.sql` | 业务 public schema 快照（自 legacy 物化，非 live replay） | 00001–00052 业务合并 |
| `003_auth_schema_grants.sql` | Better Auth schema 所有权 | 新建 |
| Better Auth CLI migrate | `p0_02_auth` 表 | 新建 |
| `004_auth_runtime_grants.sql` | auth runner 表 GRANT | 新建 |
| `007_reference_data.sql` | role 等参考数据 | 00001 seed 节选 |
| `006_least_privilege_grants.sql` | app/sync 分表分函数授权 | 对齐 00049+，收紧过宽 GRANT |

## 身份与权限原则

- 会话：`set_config('request.jwt.claim.sub', profile_uuid, true)` + `auth.uid()` 稳定函数。
- `p0_02_meta.ice_auth_user_map`：**仅** bootstrap/seed owner 写入；app/sync **无** DML。
- `warehouse_shipment_transactional`：**不**授予执行（封存到货累加路径）。
- `claim_sync_run_system`、token lease RPC：**仅** sync runner。
- GoLucky cron 写 `shipment_external_ref` / `tracking_event_external`：**sync runner**（见 006 表 GRANT）。

## 物化说明

`010_public_schema.sql` 由 `run-20261014-r1` 上已验证 schema 做 `pg_dump --schema-only` 生成，作为 frozen 基线；后续增量在本目录追加编号脚本，不修改 00001–00052 原件。
