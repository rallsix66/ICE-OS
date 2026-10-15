# P0-02 run-20261014-r2 验证报告（2289acf 审查返工后）

日期：2026-10-15（第三轮）· 审查基线：`2289acf` · Run：`run-20261014-r2`

## 总入口

```powershell
Set-Location -LiteralPath 'D:\try one\ICEOS'
$env:P0_02_RUN_ID = 'run-20261014-r2'
npm run check:p0-02
git diff --check
```

**结果：** exit 0 · 证据 `.local/p0-02/run-20261014-r2/evidence/check-2026-10-15T02-32-41-460Z`

## 2289acf 五项返工关闭

| ID | 回归 |
| --- | --- |
| P002-011-REPEAT | `run-repeat-schema-apply.mjs` 双次 `-f` 应用 `011` exit 0 |
| DELIVERY-04-AUDIT | `executor.py` success `sync_log` 与发布同事务；`test_p0_02_publish_atomicity.py` |
| DELIVERY-04-FIXTURE | `p0_02_test_fixture.py` + real_write 链 teardown/负例 |
| DELIVERY-06 | `run-browser-tests.mjs`：关注 DB/DOM/恢复、搜索行集、CSV 内容、运营无金额泄漏、egress 自检 |
| A1–A9-COMPLETION | Node 整链 `sync-node-real-write-chain.postgres.test.ts`；A8 `run-backup-restore-drill.mjs`；A9 `run-p0-02-concurrency.mjs` |

## 计数（本版）

- Postgres vitest：**46/46**（含 Node→bridge 整链）
- Python real_write：`publish_atomicity` + `real_write_chain`（分模块 unittest）
- Browser：**18** 项（`browser-2026-10-15T02-31-59-987Z`）
- check 步骤含 repeat-schema、backup-restore、concurrency

## 审查摘要

[independent-review-summary-2289acf-20261015.md](./independent-review-summary-2289acf-20261015.md)

## opt6

已知 **1 failed / 5 passed**（00051 换行契约，未扩大豁免）。
