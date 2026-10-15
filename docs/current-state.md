# Current Project State

更新：2026-10-15（**P0-02 审查返工后，待独立审查**）。仓库 ICEOS。

## P0-02 状态

| 项 | 状态 |
|---|---|
| 授权 | 完整迁移保留功能至独立 PostgreSQL + 自有服务端 |
| 上一轮审查 | **CHANGES_REQUIRED** @ `620fac4`（2026-10-14） |
| 返工任务包 | [docs/tasks/p0-02/2026-10-15-delivery-rework.md](./tasks/p0-02/2026-10-15-delivery-rework.md) |
| 任务状态 | **`P0_02_IMPLEMENTED_AWAITING_REVIEW`**（**非** PASS） |
| Canonical Run | `run-20261014-r2` |
| 总验收 | `npm run check:p0-02` **已通过**（`check-2026-10-15T01-24-49-983Z`） |
| Postgres | `test:p0-02:postgres` **43/43**（含 DELIVERY 回归 6 项） |
| HTTP | `test:p0-02:http`（check 内） |
| 浏览器 A3 | Playwright 11 项（`browser-2026-10-15T01-20-26-748Z`） |
| Python A7 | sync：gateway + real_write + boundary probes（check 内） |
| 矩阵 | [docs/p0-02/migration-matrix-r2.md](./p0-02/migration-matrix-r2.md) |
| 验证报告 | [docs/p0-02/verification-report-r2-20261015.md](./p0-02/verification-report-r2-20261015.md) |
| 本地交付摘要 | `.local/p0-02/run-20261014-r2/P0_02_IMPLEMENTED_AWAITING_REVIEW.md` |

**脱离 Supabase：** `P0_02_ENABLED=true` 时主链路走 Better Auth + app/sync pool + Python `postgres_gateway`/`postgres_rpc`；独立模式对 legacy Supabase / `.env.local` 触达在执行前拒绝（boundary probes）。人工 `updateQuantity` 在独立平台**封存**。

## P0-01 状态（保留）

| 项 | 状态 |
|---|---|
| 独立审查 | **PASS**（2026-10-14） |
| Run | `run-20261013-r1` |

opt6 canonical 换行：**已知 1 failed / 5 passed**（未改 00051）。

## 基线

- 保护报告 SHA-256：`9b42a3f9486bd0c377be77c051ff947aaed6b17bc567925f1c09344171a6db2c`
- 历史 Migration 00001–00052：**未改**
- P0-02 DDL：`db/p0-02/`

分支 `codex/ice-v4-planning`；初始六组提交 @ `620fac4` + 返工追加提交（见交付摘要）。
