# Current Project State

更新：2026-10-14（**P0-02 待独立审查**）。仓库 ICEOS。

## P0-02 状态

| 项 | 状态 |
|---|---|
| 授权 | 完整迁移保留功能至独立 PostgreSQL + 自有服务端 |
| 任务状态 | **`P0_02_IMPLEMENTED_AWAITING_REVIEW`**（**非** PASS） |
| Canonical Run | `run-20261014-r2` |
| 总验收 | `npm run check:p0-02` **已通过**（`check-2026-10-14T09-56-06-671Z`） |
| Postgres | `test:p0-02:postgres` **37/37** |
| HTTP | `test:p0-02:http` **19/19** |
| 浏览器 A3 | Playwright（`browser-2026-10-14T09-55-19-809Z`） |
| Python A7 | `python-real-write-integration-2026-10-14T09-49-00-092Z` |
| 矩阵 | [docs/p0-02/migration-matrix-r2.md](./p0-02/migration-matrix-r2.md) |
| 交付包 | `.local/p0-02/run-20261014-r2/P0_02_IMPLEMENTED_AWAITING_REVIEW.md` |

**整体脱离 Supabase：** `P0_02_ENABLED=true` 时主链路走 Better Auth + app/sync pool + Python `postgres_gateway`/`postgres_rpc`；legacy Supabase 路径仅在未启用独立平台时使用。`inventory.list` 已封存（无调用方）。

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

分支 `codex/ice-v4-planning`；六组提交见交付包（Groups 01–02 已推送；03–06 随本批推送）。
