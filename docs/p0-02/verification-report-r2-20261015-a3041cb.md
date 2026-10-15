# P0-02 验证报告 — a3041cb 返工（2026-10-15）

Canonical Run：`run-20261014-r2`  
总门禁：`npm run check:p0-02` → **通过**（`check-2026-10-15T03-07-42-320Z`）

## 五项返工证据

| ID | 命令/测试 | 结果 |
| --- | --- | --- |
| A304-01 | `validate-postgres-test-discovery.mjs` + `sync-node-real-write-chain.postgres.test.ts`（46 PG 项之一） | 纳入 include；同国 decoy 仓下整链 PASS |
| A304-02 | `test_p0_02_publish_atomicity.py`（含 `CONTROLLED_COMMIT_ACK_LOST`） | PASS |
| A304-03 | `test_p0_02_postgres_real_write_chain.py` | 无前缀扫描；RPC 后 UUID 登记 |
| A304-04 | `run-backup-restore-drill.mjs` / `run-p0-02-concurrency.mjs` | 登记辅助库；restore exit 0；表内容一致 |
| A304-05 | `run-browser-tests.mjs` | 19 项 PASS（行集/关注恢复/operator CSV） |

## 测试发现与执行

| 层 | 文件/脚本 | 用例/项 | 退出码 |
| --- | --- | --- | --- |
| PG vitest | `vitest.config.p0-02.mts` 13 文件 | **46** passed | 0 |
| HTTP | `run-http-tests.mjs` | 19 | 0 |
| Sync | `run-sync-tests.mjs` + Python 集成 | vitest 子集 + gateway/real_write/negative/boundary | 0 |
| Browser A3 | `run-browser-tests.mjs` | **19** | 0 |
| 默认 vitest（check 内） | 排除 postgres/concurrency/opt6 | 4127 passed | 0 |
| opt6 基线 | 已知豁免 | **1 failed / 5 passed**（00051 换行） | 预期 |

## A1–A9 摘要

完整矩阵见 [migration-matrix-r2.md](./migration-matrix-r2.md)。本轮变更后状态：

- **A1–A6、A8–A9**：沿用矩阵条目；本轮以返工五项 + 全门禁复验更新证据绑定（`check` 内 `source-hashes.json`）。
- **A7**：Node `SyncService` → `RealSyncRunner` → bridge → `real_write` 已纳入真实 vitest include 并执行；Python 原子性/整链/regression 在 `test:p0-02:sync` 内执行。

## 构建与源码绑定

- 隔离 build：`check` → `build-isolated` PASS（workspace hash 见 check 证据目录）。
- 77b2c4d 报告删除：用户已授权，**非**阻塞项。

## 待独立审查

不得自判 PASS。阻塞项：无（opt6 换行为登记基线失败）。
