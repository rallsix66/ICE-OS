# P0-02 — a3041cb 审查返工交付

状态：**`P0_02_IMPLEMENTED_AWAITING_REVIEW`**（非 PASS）

- 审查基线：`a3041cb08dee7df84d4523c4734cc3dacdded339` → 返工 HEAD 见交付摘要
- 上一轮审查：**CHANGES_REQUIRED** @ `a3041cb`（`independent-p002-delivery-a3041cb-20261015-01`）
- Canonical Run：`run-20261014-r2`
- 验证报告：[verification-report-r2-20261015-a3041cb.md](../../p0-02/verification-report-r2-20261015-a3041cb.md)
- 完整 A1–A9 合同：沿用 [migration-matrix-r2.md](../../p0-02/migration-matrix-r2.md) 与本轮验证报告矩阵

## 五项返工关闭

| ID | 关闭要点 | 主要变更 |
| --- | --- | --- |
| A304-01-NODE-CHAIN | `sync-node-real-write-chain` 纳入 `vitest.config.p0-02.mts`；发现门禁；`P0_02_TARGET_WAREHOUSE_ID` 目标仓链；同国多仓 decoy | `vitest.config.p0-02.mts`, `postgres_gateway.py`, `web_bridge.py`, `python-bridge.ts`, Node/Python 测试 |
| A304-02-COMMIT-UNKNOWN | `commit_outcome` + 只读核对；ack 丢失不误报回滚 | `p0_02_publish_verify.py`, `executor.py`, `test_p0_02_publish_atomicity.py` |
| A304-03-FIXTURE | 移除 RW-NEW 前缀清理；RPC 后登记真实 variant UUID | `test_p0_02_postgres_real_write_chain.py`, `p0_02_test_fixture.py`（沿用） |
| A304-04-RESTORE-GATE | 登记式辅助库；`pg_restore` 必须 exit 0；表内容全量对比 | `auxiliary-database.mjs`, `run-backup-restore-drill.mjs`, `run-p0-02-concurrency.mjs` |
| A304-05-BROWSER-CONTRACT | RPC 行集精确比对；关注 finally 完整行恢复；operator CSV 导出 | `run-browser-tests.mjs` |

## HOLD（不提交）

- `.claude/context-status.json`
- 再生成 `tools/bigseller-scraper/sync/__pycache__/*.pyc`
- 全部 `.local/` 证据与 pgdata

## 授权说明

- `77b2c4d` 删除过时内网部署报告：**已获用户单独授权**，无需恢复。
- 52 份历史 Supabase migration（00001–00052）：**未修改**。

## 验收命令

```powershell
Set-Location -LiteralPath 'D:\try one\ICEOS'
$env:P0_02_RUN_ID = 'run-20261014-r2'
npm run p0-02:prepare
npm run test:p0-02:postgres
npm run test:p0-02:http
npm run test:p0-02:sync
npm run test:p0-02:browser
npm run check:p0-02
git diff --check
```
