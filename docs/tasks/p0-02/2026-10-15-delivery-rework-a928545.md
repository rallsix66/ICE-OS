# P0-02 a928545 审查返工任务包

审查基线：`a928545acfd44aef26cd33927ac6a560c827987f`  
审查目录：`.local/p0-02/run-20261014-r2/reviews/independent-p002-delivery-a928545-20261015-01/`  
Canonical Run：`run-20261014-r2`

## B505 剩余项关闭摘要

| ID | 关闭要点 | 证据 |
|---|---|---|
| B505-01 | `PublishCommitUnknownError` 结构化传播；bridge exit 2；SyncService `indeterminate` + `result_summary`；`013_sync_publish_unknown_guard.sql` 阻止未核对 claim；`reconcile_sync_run_publish_unknown` | `sync-publish-unknown.postgres.test.ts`；`test_p0_02_publish_atomicity.py` |
| B505-02 | `addClassCleanup` + `class_cleanup`；清理成功后才注销 `owned_skus`；关联缺失保留登记 | `test_p0_02_fixture_recovery.py`；Node sentinel 完整快照断言 |
| B505-03 | RLS/policy/约束语义采集；角色行为；负例真实 dump/restore + compare | `restore-schema-contract.mjs`；`run-restore-contract-negative.mjs` |
| B505-04 | CSV 比较 SKU+仓库+`当前库存`；金额 sentinel N/A 明示；比较器自检 | `run-browser-tests.mjs`（21 项） |
| B505-05 | 矩阵/报告绑定 `check-2026-10-15T04-43-54-505Z`；legacy Python `test_executor`/`test_name_backfill` 门禁 | `run-python-legacy-regression.mjs` |

## 总门禁

```powershell
Set-Location -LiteralPath 'D:\try one\ICEOS'
$env:P0_02_RUN_ID = 'run-20261014-r2'
npm run check:p0-02
git diff --check
```

最新：`check-2026-10-15T04-43-54-505Z` exit 0（opt6 固定 1 failed / 5 passed）。

完整 A1–A9 映射见 [verification-report-r2-20261015-a928545-rework.md](../../p0-02/verification-report-r2-20261015-a928545-rework.md)。
