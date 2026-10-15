# P0-02 验证报告 — a928545 返工

- **源码绑定**：`check-2026-10-15T04-43-54-505Z` · workspace hash `a3b0277183e8837fc3b2101469b204f93ccdc20067c6a36e706bf30b56faea03`
- **Canonical Run**：`run-20261014-r2`
- **总门禁**：`npm run check:p0-02` exit **0**

## 实测规模（发现清单，非手写）

| 套件 | 文件/项 | 退出码 |
|---|---|---|
| vitest 默认 | 105 files / 4127 tests | 0 |
| Postgres | 14 files / **47** tests + config **5** | 0 |
| Playwright A3 | **21** 项（含 CSV 比较器自检） | 0 |
| Python P0-02 模块 | 5 modules（含 fixture recovery） | 0 |
| Python legacy | `test_executor` 89/89；`test_name_backfill` 必过；CLI 多场景在 p0-02 环境下为适用性记录 | 0 |
| backup/restore/concurrency/aux/restore-contract 负例 | 各脚本证据目录 | 0 |
| opt6 基线 | 1 failed / 5 passed（00051 换行） | 预期 |

## A1–A9 映射（摘要）

| 条款 | 实现/入口 | 测试与证据 |
|---|---|---|
| A1 | 本报告 + [migration-matrix-r2.md](./migration-matrix-r2.md) | check 全步骤 |
| A2 | `P0_02_ENABLED` + loopback + bridge fixture | build-isolated + gateway negative/boundary |
| A3 | Playwright 登录/关注/搜索/CSV/egress | `run-browser-tests.mjs` |
| A4 | HTTP + operator 无 amount 列 | `run-http-tests.mjs` + browser operator CSV |
| A5 | delivery-rework + 业务语义 PG | `delivery-rework.postgres.test.ts` |
| A6 | 011/013 + RLS/ACL PG | postgres 套件 + restore contract |
| A7 | claim→bridge→real_write；**unknown** 链 | `sync-node-real-write-chain` + `sync-publish-unknown` + Python atomicity |
| A8 | fixture 负例 + backup drill + concurrency | 对应 run-*.mjs |
| A9 | lint/build/diff + legacy Python | `check:p0-02` |

## B505 关闭对照

见 [2026-10-15-delivery-rework-a928545.md](../tasks/p0-02/2026-10-15-delivery-rework-a928545.md)。

## 保留项

5054755/a928545 审查已认可的原生 PG 链、ACK-lost、prefix 删除移除、aux finally、browser 守卫等均未回退。

## 非本轮范围

旧 Supabase 数据迁移、正式账号、真实来源、生产删除旧环境 — 见产品/架构后续方案节。
