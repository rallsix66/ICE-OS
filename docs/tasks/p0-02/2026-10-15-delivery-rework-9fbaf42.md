# P0-02 — 9fbaf42 审查返工交付

状态：**`P0_02_IMPLEMENTED_AWAITING_REVIEW`**（非 PASS）

- 审查基线：`9fbaf4253a1b20989f5f439822f702ac70031a89`
- 审查目录：`.local/p0-02/run-20261014-r2/reviews/independent-p002-delivery-9fbaf42-20261015-01/`
- Canonical Run：`run-20261014-r2`
- 验证报告：[verification-report-r2-20261015-9fbaf42-rework.md](../../p0-02/verification-report-r2-20261015-9fbaf42-rework.md)

## 完整 A1–A9 合同

原合同条款见 [2026-10-15-delivery-rework.md](./2026-10-15-delivery-rework.md)（A1–A9 全文）。本轮不缩略；逐条证据映射见验证报告 **A1–A9 映射表**。

## B505 本轮关闭（在已认可部分之上）

| ID | 关闭要点 | 证据 |
| --- | --- | --- |
| B505-01-NULL | `reconcile_sync_run_publish_unknown` 显式拒绝 NULL/空白/非法结论；拒绝后 run/lock 不变、后续 claim 仍拒 | `015_sync_publish_unknown_hardening.sql`；`sync-publish-unknown.postgres.test.ts` |
| B505-01-AUTH | `expire_stale_sync_runs_for_warehouse` 须激活管理员；REVOKE PUBLIC EXECUTE；未授权调用零变化 | `015`；`sync-expiry-authorization.postgres.test.ts` |
| B505-01-LOCK | expiry 与 claim/release 同序：advisory → `sync_warehouse_lock` → `sync_run`；双连接无 40P01 | `015`；`sync-expiry-lock-concurrency.postgres.test.ts` |
| B505-05 | 导入前阻断 `open`/`io.open`/`Path.read_*`/socket/DNS/urllib；自检接入 legacy runner | `legacy_test_isolation.py`；`run-python-legacy-regression.mjs`（148 项） |
| A9-DISCOVERY | cleanup + 新 PG 回归进入 `vitest.config.p0-02.mts` 与 discovery required | `validate-postgres-test-discovery.mjs`；check postgres 子项 |

## 保留已关闭（不重做）

B505-02、B505-03、B505-04 及 9fbaf42 审查 `accepted` 列表中的实现与行为。

## 授权与 HOLD

- `77b2c4d` 内网报告删除：已授权，不恢复。
- 00001–00052 migration：未改。
- HOLD：`.claude/context-status.json`、`__pycache__/*.pyc`、全部 `.local/`。

## 验收命令

```powershell
Set-Location -LiteralPath 'D:\try one\ICEOS'
$env:P0_02_RUN_ID = 'run-20261014-r2'
npm run check:p0-02
git diff --check
```

最新：`check-2026-10-15T06-43-00-219Z` exit 0（opt6 固定 1 failed / 5 passed）。
