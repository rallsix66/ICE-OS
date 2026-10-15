# P0-02 验证报告 — 9fbaf42 审查返工

**Canonical Run：** `run-20261014-r2`  
**审查基线：** `9fbaf4253a1b20989f5f439822f702ac70031a89`  
**总验收：** `npm run check:p0-02` → **exit 0**（`check-2026-10-15T06-43-00-219Z`）  
**源码绑定：** workspace 500 文件 · snapshot `fa9c78ef7a013c1dbc7ed6deba0dabc13c3ec89cc90598ed6cfdde795f632484`

## 本轮修复映射

| 审查项 | 修改 | 回归 |
| --- | --- | --- |
| B505-01 NULL 结论 | `015_sync_publish_unknown_hardening.sql` 规范化结论后再校验 | `sync-publish-unknown`：NULL reconcile 拒绝 + claim 仍拒 |
| B505-01 expiry 授权 | 同文件：admin + 登录；REVOKE PUBLIC | `sync-expiry-authorization`（无身份/操作员/无效 admin） |
| B505-01 锁序 | advisory → 仓锁 → run | `sync-expiry-lock-concurrency`（expire ∥ release，无 40P01） |
| B505-05 隔离 | `legacy_test_isolation.py` 文件/网络全入口 + 自检 | `run-python-legacy-regression.mjs`（89+20+39=148 PASS） |
| A9 发现遗漏 | `vitest.config.p0-02.mts` + `validate-postgres-test-discovery.mjs` | cleanup 与新增 PG 文件实际执行 |

## 测试计数（本轮 check 实际）

| 套件 | 文件 | 用例 | 退出码 |
| --- | ---: | ---: | ---: |
| Vitest 默认 | 105 | 4127 | 0 |
| PG（含 config） | **17**（16×`.postgres.test.ts` + 1×`config-target.test.ts`） | **58**（53 PG + 5 config） | 0 |
| HTTP | — | 19 | 0 |
| Browser A3 | — | 21 | 0 |
| Python legacy | 3 模块 | 148 | 0 |
| opt6 已知基线 | — | 1 fail / 5 pass | 1（豁免） |

PG 文件明细（discovery include **18** 条路径；runner 分 phase 执行 **17** vitest 文件 + config phase）：

- 新增执行：`sync-node-real-write-chain-cleanup.postgres.test.ts`、`sync-expiry-authorization.postgres.test.ts`、`sync-expiry-lock-concurrency.postgres.test.ts`

## 证据路径

| 子项 | 目录 |
| --- | --- |
| 总 check | `.local/p0-02/run-20261014-r2/evidence/check-2026-10-15T06-43-00-219Z/` |
| Postgres | `postgres-2026-10-15T06-43-*`（check 内嵌） |
| Browser | `browser-2026-10-15T06-42-18-987Z` |
| Python legacy | `python-legacy-regression-*`（check 内嵌） |

## B505-03 文档纠正

- `run-restore-contract-negative.mjs`：**仅 RLS/policy 负例**（check 子项仍 PASS）。
- 函数体/签名损坏拒绝：比较器 `restore-schema-contract.mjs` + 独立审查 `restore-function-probe` 证据；**不**虚报为 contract-negative 脚本覆盖。

## A1–A9 映射表（摘要）

| 合同 | 状态 | 主要证据 |
| --- | --- | --- |
| A1 | 已验证 | 迁移矩阵 + 保留页面/API 清单 |
| A2 | 已验证 | build-isolated + legacy 隔离 + bridge fixture |
| A3 | 已验证 | Playwright 21（`browser-2026-10-15T06-42-18-987Z`） |
| A4 | 已验证 | http 19 + 浏览器/API 金额边界 |
| A5 | 已验证 | delivery-rework + Python gateway |
| A6 | 已验证 | effective-acl + identity-chain + 015 权限 |
| A7 | 已验证 | node chain + publish-unknown + expiry 授权/锁序 |
| A8 | 已验证 | backup-restore-drill + fixture-restore-negative |
| A9 | 已验证 | 本 check + discovery 18 include + concurrency |

## 区分

- **已实现 / 已验证：** 上表与本仓库 `db/p0-02/015_*`、隔离 runner、PG 回归。
- **待独立审查：** 整包 P0-02（执行方不自判 PASS）。
- **既有失败（豁免）：** opt6 `00051` 换行 1 failed / 5 passed。
