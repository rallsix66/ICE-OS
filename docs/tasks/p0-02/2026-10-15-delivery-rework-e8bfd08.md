# P0-02 — e8bfd08 审查返工交付

状态：**`P0_02_IMPLEMENTED_AWAITING_REVIEW`**（非 PASS）

- 审查基线：`e8bfd082bed101da49bff6bed7deb5ff11faa620`
- 审查目录：`.local/p0-02/run-20261014-r2/reviews/independent-p002-delivery-e8bfd08-20261015-01/`
- Canonical Run：`run-20261014-r2`
- 验证报告：[verification-report-r2-20261015-e8bfd08-rework.md](../../p0-02/verification-report-r2-20261015-e8bfd08-rework.md)

## 完整 A1–A9 合同

原合同条款见 [2026-10-15-delivery-rework.md](./2026-10-15-delivery-rework.md)（A1–A9 全文）。本轮不缩略；逐条证据映射见验证报告 **A1–A9 映射表**。

## B505 本轮关闭

| ID | 关闭要点 | 证据 |
| --- | --- | --- |
| B505-01 | 有证据核对（success log / 人工依据+审计）；无证据 reconcile 拒绝；租约过期 real_write 持久化 unknown；`expire_stale_sync_runs_for_warehouse` 独立提交后再 claim；executor 不再以数量差推定 rolled_back | `014_sync_publish_unknown_reconcile_evidence.sql`；`sync-publish-unknown.postgres.test.ts`；`executor.py` |
| B505-02 | Node afterAll 先记录 sentinel 失败再强制清理；清理失败优先抛出；负例证明 mismatch 仍清理本次 UUID | `sync-node-real-write-chain.postgres.test.ts`；`sync-node-real-write-chain-cleanup.postgres.test.ts` |
| B505-03 | `functionMeta` 保留 `identity_args` + `definition_hash`；函数体损坏负例仍拒绝 | `restore-schema-contract.mjs`；`run-restore-contract-negative.mjs`（check 子项） |
| B505-04 | （审查已关闭）CSV 行集比较器 | 保持 `run-browser-tests.mjs` |
| B505-05 | legacy 隔离 runner（虚构 Supabase 配置、阻断 `.env.local`、剥离 P0_02 PG）；CLI 全量 __main__ 纳入 required 门禁；缺文件/零用例/失败非零 | `legacy_test_isolation.py`；`run_legacy_test_module.py`；`run-python-legacy-regression.mjs` |

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

最新：`check-2026-10-15T06-04-49-136Z` exit 0（opt6 固定 1 failed / 5 passed）。
