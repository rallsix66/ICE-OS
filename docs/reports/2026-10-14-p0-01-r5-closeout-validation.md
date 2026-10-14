# P0-01-R5 收尾补丁验收报告

更新：2026-10-14 · Run `run-20261013-r1` · 状态 **P0_01_PASS**（见 [独立审查 PASS 报告](2026-10-14-p0-01-pass-validation.md)）

> 本文档为 R5 收尾补丁实施记录；最终独立审查 PASS 以 `independent-r5-closeout-20261014-01` 为准。

依据：`.local/p0-01/run-20261013-r1/reviews/independent-r5-20261014-01/review-conclusion.json`（仅 R5-2-remaining、R5-4-remaining）。

## 已关闭项

| ID | 处理 |
|---|---|
| **R5-2** | `nextProcessMatchesRegisteredWorkspace` 要求 `{workspace}/node_modules/next/...` 完整路径段；`verifyRegisteredProcessIdentity` + `stopRegisteredProcesses` 在 taskkill 前校验，不匹配则抛错保留现场；HTTP 仅 `child.kill()`，不再跨进程扫描 |
| **R5-4** | 固定 `scripts/p0-01/opt6-approved-baseline.json`（与审查 `opt6-approved-baseline.json` 一致）；校验三文件 sha256 / normalizedLfSha256 / CRLF 计数；篡改替身拒绝已知失败豁免 |

**保持稳定**：R5-1 bootstrap 凭据、R5-3 十一表 fixture、R5-5 构建凭证（本轮未改语义）。

## 命令与退出码

| 命令 | 结果 | exit |
|---|---|---|
| `npm run test:p0-01:guard-negative` | **22/22**（含 workspace.old、stop 层、opt6 指纹替身） | 0 |
| `tests/p0-01/opt6-baseline.test.ts` | **8/8** | 0 |
| `npm run p0-01:stop` → `p0-01:prepare` | stop + 启动 | 0 |
| `npm run check:p0-01` | 通过；opt6 已知 1 fail | 0 |
| `npm run test:p0-01:postgres` | **20/20** | 0 |
| `npm run p0-01:prepare` → `test:p0-01:http` | **23/23** | 0 |
| `git diff --check` | 通过 | 0 |

## 证据

- 审查目录：`.local/p0-01/run-20261013-r1/reviews/independent-r5-20261014-01/`
- Check：`.local/p0-01/run-20261013-r1/evidence/check-2026-10-14T03-31-30-548Z/`
- 批准指纹源：`scripts/p0-01/opt6-approved-baseline.json`

## 停止点

已由独立审查 **PASS** 收口；现役状态见 [2026-10-14-p0-01-pass-validation.md](2026-10-14-p0-01-pass-validation.md)。
