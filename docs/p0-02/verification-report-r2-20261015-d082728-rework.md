# P0-02 验证报告 — d082728 审查返工

**Canonical Run：** `run-20261014-r2`  
**审查基线：** `d08272886d4e931bc4939778566e0d439e529a6a`  
**总验收：** `npm run check:p0-02` → **exit 0**（`check-2026-10-15T07-07-04-252Z`）  
**源码绑定：** workspace 500 文件 · snapshot `fa9c78ef7a013c1dbc7ed6deba0dabc13c3ec89cc90598ed6cfdde795f632484`（check 内 `source-hashes.json` 记录子集，非全仓库）

## 本轮修复映射

| 审查项 | 修改 | 回归 |
| --- | --- | --- |
| B505-05 隔离边界 | `legacy_test_isolation.py`：`sys.addaudithook` + 模块级 `_BOUNDARY_ARMED`；补丁 `os.open`；自检含 env 清空与 mock 委托原 API | legacy runner 自检 + **148** 项原断言（check 内 `p0-02-sync`） |
| A9 并发假绿 | `sync-expiry-lock-concurrency.postgres.test.ts`：app/sync 分角色、advisory 等待协调、提交后终态核对、42501 负例 | 4 PG 用例（+3 场景 / +1 负例） |
| 文档计数/证据 | 本报告、`current-state.md`、迁移矩阵 | — |

## 测试计数（本轮 check 实际）

| 套件 | 文件 | 用例 | 退出码 |
| --- | ---: | ---: | ---: |
| Vitest 默认 | 105 | 4127 | 0 |
| PG + config | **18**（**17**×`.postgres.test.ts` + **1**×`config-target.test.ts`） | **61**（**56** PG + **5** config） | 0 |
| HTTP | — | 19 | 0 |
| Browser A3 | — | 21 | 0 |
| Python legacy | 3 模块 | 148 | 0 |
| opt6 已知基线 | — | 1 fail / 5 pass | 1（豁免） |

说明：discovery / runner / `filesOnly` 均为 **18** 条路径；不再使用「17 总文件 = 16 PG + 1 config」表述。

## 证据路径（`check-2026-10-15T07-07-04-252Z` 子运行）

| 子项 | 目录 |
| --- | --- |
| 总 check | `.local/p0-02/run-20261014-r2/evidence/check-2026-10-15T07-07-04-252Z/` |
| Postgres | `postgres-2026-10-15T07-08-05-505Z` |
| Browser | `browser-2026-10-15T07-08-28-623Z` |
| Python legacy + bridge | `sync-2026-10-15T07-09-07-072Z` |

较早的 `browser-2026-10-15T06-42-18-987Z` 为历史独立运行，**不**作为本次 check 子证据。

## SQL015 / 并发合同（保留）

独立审查 `real-lock-contract-result.json` 已验证锁序与终态；本轮 **未改** `015_sync_publish_unknown_hardening.sql`，仅加固 TS 回归门禁。

## A1–A9 映射表（摘要）

| 合同 | 状态 | 主要证据 |
| --- | --- | --- |
| A1 | 已验证 | 迁移矩阵 + 保留页面/API 清单 |
| A2 | 已验证 | build-isolated + legacy audit 边界 + bridge fixture |
| A3 | 已验证 | Playwright 21（`browser-2026-10-15T07-08-28-623Z`） |
| A4 | 已验证 | http 19 + 浏览器/API 金额边界 |
| A5 | 已验证 | delivery-rework + Python gateway |
| A6 | 已验证 | effective-acl + identity-chain + 015 权限 |
| A7 | 已验证 | node chain + publish-unknown + expiry 授权 + **并发三场景** |
| A8 | 已验证 | backup-restore-drill + fixture-restore-negative |
| A9 | 已验证 | 本 check + discovery 18 路径 + 并发/legacy 负例可失败 |

## 区分

- **已实现 / 已验证：** 上表与本轮修改文件及 check 子证据。
- **待独立审查：** 整包 P0-02（执行方不自判 PASS）。
- **既有失败（豁免）：** opt6 `00051` 换行 1 failed / 5 passed。
