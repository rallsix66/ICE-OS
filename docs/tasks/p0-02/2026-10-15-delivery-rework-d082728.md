# P0-02 — d082728 审查返工交付

状态：**`P0_02_IMPLEMENTED_AWAITING_REVIEW`**（非 PASS）

- 审查基线：`d08272886d4e931bc4939778566e0d439e529a6a`
- 审查目录：`.local/p0-02/run-20261014-r2/reviews/independent-p002-delivery-d082728-20261015-01/`
- Canonical Run：`run-20261014-r2`
- 验证报告：[verification-report-r2-20261015-d082728-rework.md](../../p0-02/verification-report-r2-20261015-d082728-rework.md)

## 完整 A1–A9 合同

原合同条款见 [2026-10-15-delivery-rework.md](./2026-10-15-delivery-rework.md)（A1–A9 全文）。本轮不缩略；逐条证据映射见验证报告 **A1–A9 映射表**。

## 本轮关闭（在已认可部分之上）

| ID | 关闭要点 | 证据 |
| --- | --- | --- |
| B505-05 | 导入前一次安装 **audit hook + 固定边界**；`os.open` 纳入；环境清空 / mock 委托原 `open` 仍拒绝 `.env.local` 与实际外联 | `legacy_test_isolation.py` 自检；`run-python-legacy-regression.mjs`（148 项） |
| A9-CONCURRENCY | expiry/claim 用 **app**、release 用 **sync**；真实 advisory 等待；胜者先 commit 再等败者；42501/40P01/超时失败；三场景 + 42501 负例 | `sync-expiry-lock-concurrency.postgres.test.ts` |
| 文档校正 | PG **18 文件 / 61 项**（56 PG + 5 config）；check 子证据 browser/postgres 路径归属 | 本报告与 `current-state.md` |

## 保留已关闭（不重做）

- B505-01（NULL / expiry 授权 / SQL 锁序）、B505-02、B505-03、B505-04、A9-DISCOVERY（18 路径发现一致）。
- `db/p0-02/015_sync_publish_unknown_hardening.sql` 不重做。

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

最新：`check-2026-10-15T07-07-04-252Z` exit 0（opt6 固定 1 failed / 5 passed）。

**后续：** 独立审查已于 2026-10-15 判定 **PASS** @ `9507d86`；现役结论见 [verification-report-p0-02-pass-20261015.md](../../p0-02/verification-report-p0-02-pass-20261015.md)。本任务包状态仍为交付当时的 **IMPLEMENTED_AWAITING_REVIEW**。
