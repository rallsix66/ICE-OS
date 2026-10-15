# P0-02 现役迁移矩阵（run-20261014-r2）

**Canonical Run：** `run-20261014-r2` · 基线目录 `db/p0-02/` · **不**再采用 r1 的 PostgREST 仿制或 00001–00052 live replay。

历史矩阵：`.local/p0-02/run-20261014-r1/migration-matrix.md`（仅归档，不作实施指引）。

## 数据库与运行时

| ID | 能力 | 目标实现 | 状态 |
| --- | --- | --- | --- |
| D1 | 实例初始化 | `scripts/p0-02/prepare.mjs` → `db/p0-02/*.sql` + Better Auth migrate | **已验证** |
| D2 | 连接守卫 C1 | `P0_02_*` URL 契约 + loopback | **已验证** |
| D3 | ACL C2 | `006_least_privilege_grants.sql` 白名单 | **已验证** |
| D4 | 身份 C3 | Better Auth + `ice_auth_user_map` + GUC | **已验证** |
| D5 | Sync runner RLS | `007_sync_runner_rls.sql` + GUC scope + golucky + **sync INSERT（variant/inventory）** + **sync_log INSERT/SELECT** | **已验证**（返工 DELIVERY-04） |
| D6 | 部分/批量收货 RPC ACL | `006` 含 `partial_warehouse_shipment(uuid,jsonb,text)` | **已验证**（DELIVERY-03） |

## 应用层（Repository / API）

| ID | 模块 | 独立 PG 路径 | 状态 |
| --- | --- | --- | --- |
| R1 | 库存健康 / 低库存 / 在途 RPC | `callAppRpc` | **已验证** |
| R2 | 仓库访问 / preferences / 补货 numeric | `queryAppRows` + DTO | **已验证**（warehouse-replenishment-numeric PG） |
| R3 | 外部物流 / GoLucky | `externalTrackingRepository` + sync scope | **已验证**（cron + JSONB + sync RLS） |
| R4 | shipments | 列表/读/写/批量入仓等 | **已分支**（行为测试已适配） |
| R5 | products / variants / users | 全 CRUD / 匹配 | **已分支** |
| R6 | sync Node 写路径 | `PostgresSyncRepository` + sync pool RPC | **已验证**（lifecycle + fixture 隔离） |
| R7 | inventory 写路径 | `getByProductId` 独立 SQL；**`updateQuantity` 独立平台封存**；`list` **封存** | **已验证**（DELIVERY-02） |
| R8 | preferences 关注 | `toggleFavorite` / `_variantExists` 带 `profileUserId` | **已验证**（DELIVERY-01） |

## 集成与验收（A1–A9 原合同）

| ID | 含义 | 证据入口 | 状态 |
| --- | --- | --- | --- |
| A1 | 保留功能迁移及证据矩阵 | 本矩阵 + `check-2026-10-15T02-32-41-460Z` | **已验证**（待独立审查复核范围） |
| A2 | 无 Supabase 运行依赖/回退 | `build-isolated` + boundary probes + `P0_02_FIXTURE_INPUT_PATH` bridge | **已验证** |
| A3 | 真实浏览器交互 + 网络/落库 | Playwright **18** 项：关注 DB/DOM/恢复、搜索行集、CSV 内容、egress | **已验证** |
| A4 | 认证/权限/金额 | `test:p0-02:http` + 浏览器运营 inventory API 无 amount 字段 | **已验证** |
| A5 | 业务语义兼容 | vitest + delivery-rework + Python gateway | **已验证** |
| A6 | PG 最小权限/RLS/池隔离 | postgres **46/46** + 011 重复 apply + 发布/审计原子性 | **已验证** |
| A7 | 虚构来源→claim→bridge→real_write→sync_log | `sync-node-real-write-chain.postgres.test.ts` + Python atomicity/real_write | **已验证** |
| A8 | 实例/fixture/负例/备份恢复 | fixture-restore-negative + **`run-backup-restore-drill.mjs`** + repeat-schema | **已验证** |
| A9 | lint/build/diff/opt6/concurrency | `check:p0-02` + **`run-p0-02-concurrency.mjs`** | **已验证**（opt6 已知 1 fail / 5 pass） |

### 子测试挂接（摘要）

- **A2**：`run-python-gateway-negative.mjs` / `run-python-gateway-integration.mjs`
- **A3**：`run-browser-tests.mjs` → `browser-2026-10-15T02-31-59-987Z`
- **DELIVERY**：`delivery-rework.postgres.test.ts`；`test_p0_02_publish_atomicity.py`；`run-repeat-schema-apply.mjs`
- **A7**：`sync-node-real-write-chain.postgres.test.ts`；`run-python-real-write-integration.mjs`
- **A8/A9**：`run-backup-restore-drill.mjs`；`run-p0-02-concurrency.mjs`
- **P002-R6**：`sync-fixture.ts` 独占 UUID；`fixture-integrity.mjs` 无固定 ID 豁免

## Python 同步读/写网关

| 条件 | 行为 |
| --- | --- |
| `P0_02_ENABLED=true` | `postgres_gateway` + `postgres_rpc`（RPC/sync_log）；**禁止** import 时加载 Supabase / `.env.local` |
| 否则 | legacy `supabase_gateway` |

## 停止条件

→ **`P0_02_IMPLEMENTED_AWAITING_REVIEW`**（**非**自行 PASS）。
