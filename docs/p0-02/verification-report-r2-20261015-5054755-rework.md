# P0-02 验证报告 — 5054755 返工（2026-10-15）

Canonical Run：`run-20261014-r2`  
总门禁：`npm run check:p0-02` → **通过**（`check-2026-10-15T03-49-43-721Z`，exit 0）

源码快照：`source-hashes.json`（同上 check 目录）；隔离 workspace hash `674f08b1f327fe172f78caaeaeb9dc51616406ee50df42671447f984f362e2c1`。

## B505 返工证据

| ID | 入口 / 测试 | 结果 |
| --- | --- | --- |
| B505-01 | `test_p0_02_publish_atomicity.py`（ack 丢失、verify 不可用、重试先失败后成功）；`test_p0_02_web_bridge_commit_outcome.py`；Node 链 `sync-node-real-write-chain.postgres.test.ts` | PASS |
| B505-02 | `test_p0_02_postgres_real_write_chain.py`（post-publish / UUID 读失败 + owned sku finally）；Node 无前缀删除 + sentinel | PASS |
| B505-03 | `run-backup-restore-drill.mjs` + `restore-schema-contract.mjs`；`run-aux-failure-negative.mjs`；`run-restore-contract-negative.mjs` | PASS |
| B505-04 | `run-browser-tests.mjs` | **20** 项 PASS |
| B505-05 | 本报告 + [2026-10-15-delivery-rework-5054755.md](../tasks/p0-02/2026-10-15-delivery-rework-5054755.md) | 已对齐 |

## 测试发现与执行（当前源码）

| 层 | 发现 / 脚本 | 数量 | 退出码 |
| --- | --- | --- | --- |
| 默认 vitest（check 内） | 105 files | **4127** passed | 0 |
| PG vitest | `validate-postgres-test-discovery.mjs` + `vitest.config.p0-02.mts` | **13** files / **46** tests + **5** config | 0 |
| HTTP | `run-http-tests.mjs` | 19 | 0 |
| Browser A3 | `run-browser-tests.mjs` | **20** | 0 |
| Sync | `run-sync-tests.mjs` + Python 集成（含 verify/bridge/atomicity/real_write） | vitest 子集 + 4 Python modules | 0 |
| 负例 | fixture-restore / migrate-auth / aux-failure / restore-contract | 各 0 | 0 |
| opt6 基线 | 已知豁免 | **1 failed / 5 passed**（00051 换行） | 预期 |

## A1–A9 映射（摘要）

| 条款 | 实现 / 入口 | 测试与门禁 |
| --- | --- | --- |
| A1 全功能清单 | `docs/p0-02/migration-matrix-r2.md` + Demo/保留页路由 | HTTP + Browser + PG 覆盖矩阵行 |
| A2 无 Supabase | `env-whitelist.mjs`、loopback preload、network-guard | `run-http-tests.mjs`、browser 零外联 |
| A3 浏览器闭环 | `run-browser-tests.mjs` | 20 项（登录/导航/关注/导出/operator） |
| A4 认证权限 | `run-http-tests.mjs`、PG `effective-acl` / `identity-chain` | HTTP 19 + PG |
| A5 业务兼容 | Repository/RPC 既有语义 | PG + HTTP + Python real_write |
| A6 PG 隔离 | app/sync runner 角色、`set_config` 链 | PG 13 文件 + `test_p0_02_connection_boundary` |
| A7 同步链 | `SyncService` → `RealSyncRunner` → bridge → `execute_plan_v2` | Node chain + Python atomicity/real_write + 负例 |
| A8 历史与恢复 | backup-restore + fixture 负例 | drill + `run-fixture-restore-negative.mjs` |
| A9 完整门禁 | `run-check.mjs` | `check-2026-10-15T03-49-43-721Z` exit 0 |

## 授权删除

`77b2c4d` 删除内网评估报告：用户已确认，**非**阻塞。

## 待独立审查

不得自判 PASS。opt6 仅保留登记的单失败基线。
