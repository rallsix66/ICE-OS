# P0-02 验证报告 — e8bfd08 返工

- Run：`run-20261014-r2`
- 源码快照：`eecd14911fce584ed5764447f07ca76bb1999d74d7b1404aebca731186c1af9d`（check 采集）
- 总门禁：`check-2026-10-15T06-04-49-136Z` **exit 0**
- 状态：**已实现 / 已验证（门禁）** → **`P0_02_IMPLEMENTED_AWAITING_REVIEW`**（非 PASS）

## 门禁摘要

| 子项 | 结果 |
| --- | --- |
| vitest 默认 | 105 files / 4127 tests passed |
| lint + build-isolated | exit 0 |
| Postgres | 15 文件 / **48** vitest + 5 config |
| HTTP / Browser | exit 0（21 Playwright） |
| sync + python boundary + legacy regression | exit 0 |
| restore/backup 负例 + 并发 | exit 0 |
| opt6 已知基线 | **1 failed / 5 passed**（00051 换行，固定豁免） |
| git diff --check | exit 0 |

## B505 返工关闭依据

### B505-01

- `reconcile_sync_run_publish_unknown(run_id, conclusion, basis)`：`confirmed_committed` 须 success sync_log；`confirmed_not_committed` 须 ≥8 字符依据且无 success log；写入核对审计字段。
- `assert_no_unreconciled_publish_unknown` 覆盖 `commitOutcome=unknown`、租约过期未 release、summary 为空且 error 含租约过期。
- `expire_stale_sync_runs_for_warehouse` 在 claim 前单独 RPC 提交，避免 assert 回滚过期标记。
- `executor._commit_publish_with_verification` 移除“数量不符即 rolled_back”。

### B505-02

- 主链 afterAll：sentinel 断言失败仍执行 `cleanupNodeChainFixtures`；清理错误优先于原断言错误抛出。
- `sync-node-real-write-chain-cleanup.postgres.test.ts`：强制 sentinel mismatch 负例，验证本次 UUID 已删、哨兵仓仍在。

### B505-03

- `compareRestoreContracts` 的 `functionMeta` 保留签名与 `definition_hash`，仅丢弃 OID。
- `p0-02-restore-contract-negative` check 子项 exit 0。

### B505-05

- `SYNC_LEGACY_TEST_ISOLATED=1`：`executor`/`supabase_gateway` 虚构 Supabase 配置；`legacy_test_isolation` 阻断 `.env.local` 读取。
- `test_cli_integration.py` 经隔离 runner 全量执行（required）；`capture_sync_log` 接受 `sync_run_id` 等新参数。
- 原 29 FAIL / required:false 已移除；CLI 现与 executor/name_backfill 同门禁。

## A1–A9 映射表（摘要）

完整条款见 [2026-10-15-delivery-rework.md](../tasks/p0-02/2026-10-15-delivery-rework.md)。

| 条款 | 本轮证据 |
| --- | --- |
| A1 全功能 | check 全入口 + Postgres/Browser/HTTP/sync 套件 |
| A2 无 Supabase | network-guard、python boundary、legacy 隔离 |
| A3 浏览器 | `run-browser-tests.mjs` 21 项 |
| A4 权限 | effective-acl、auth-directory、sync-runner-authorization |
| A5 业务兼容 | delivery-rework、warehouse-replenishment-numeric |
| A6 PG 隔离 | identity-chain、rpc-dependency、concurrency |
| A7 同步链 | node real_write chain、publish unknown、Python sync 模块 |
| A8 历史/恢复 | backup-restore-drill、restore-contract-negative、fixture-restore-negative |
| A9 门禁 | 本 report + opt6 固定例外 |

## 区分

- **已实现**：上述代码与 SQL 增量。
- **已验证**：`check-2026-10-15T06-04-49-136Z` 子项（本机 canonical run）。
- **待独立审查**：独立审查员 PASS（执行方不自判）。
- **既有失败**：opt6 00051 换行 1/5。
