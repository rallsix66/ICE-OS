# P0-02 独立审查返工任务包（2026-10-15）

## 状态与基线

| 项 | 值 |
| --- | --- |
| 现役审查结论 | **CHANGES_REQUIRED** @ `d4f7804` |
| 首轮审查基线 | `620fac4d5188055fd0c9bf865937901efd8b3a6f` |
| 分支 | `codex/ice-v4-planning` |
| Canonical Run | `run-20261014-r2` |
| 审查证据（本地） | `.local/.../independent-p002-delivery-d4f7804-20261015-01/`（首轮：`...620fac4-20261014-01/`） |
| 原完整授权包 | `.local/p0-02/run-20261014-r2/reviews/independent-delivery-commit-plan-20261014-01/next-instruction-commit-push-complete-p0-02.md` |

六组初始提交已推送，**不**重新拆组、不撤回、不重写已推送历史。返工完成后追加本地提交并普通推送。

## 唯一目标与停止点

修复 **DELIVERY-01～06**，并继续完成原 P0-02 **A1–A9** 验收合同。六项返工不能替代整体范围。

**唯一正常停止点：** 六项关闭、A1–A9 有当前版本实际证据、必要检查通过、修复提交已推送核实、文档对齐后，交付 **`P0_02_IMPLEMENTED_AWAITING_REVIEW`**（等待独立审查，**不得**自行判 PASS）。

禁止：合并、部署、切生产、清场、进入 P0-03 或真实聚水潭接入。

## 用户授权（本轮）

- 在当前工作树继续 P0-02
- 按逻辑范围追加本地提交
- 普通推送到 `origin/codex/ice-v4-planning`
- 不得 reset/clean/全量暂存掩盖现场

## 六项返工（审查 findings 摘要）

### DELIVERY-01 — 关注丢失身份

- **问题：** `preferences._variantExists` 在独立路径用 null identity → `toggleFavorite` 返回 `VARIANT_NOT_FOUND`。
- **要求：** 可信服务端身份贯穿存在性/范围/写入；PostgreSQL + HTTP/浏览器回归；不放松 RLS。

### DELIVERY-02 — 人工库存改量未封存

- **问题：** operator 经 `updateQuantity` 持久化改量。
- **要求：** 封存 `updateInventoryQuantity` / `updateQuantity`；验证 action、Repository、运行角色；保留授权来源同步。

### DELIVERY-03 — 部分/批量收货 RPC 权限

- **问题：** `app_runner` 对 `partial_warehouse_shipment(uuid,jsonb,text)` 无 EXECUTE。
- **要求：** 最小 GRANT；有效货票成功 + 越权/超量/重复语义；不开放 `warehouse_shipment_transactional`。

### DELIVERY-04 — 同步发布与失败恢复

- **问题：** sync INSERT RLS 42501；日志缺 `sync_run_id`/`triggered_by`；psycopg 异常未记失败；real_write 隔离不足。
- **要求：** 最小 sync INSERT RLS/ACL；运行关联；异常与发布一致性；real_write 独占 fixture；完整 A7 链（非双次 unchanged 计划）。

### DELIVERY-05 — 独立模式旧 Supabase 路径

- **问题：** `P0_02_ENABLED=true` 时 dry_run / name_backfill 仍触达 `.env.local`。
- **要求：** 迁移或执行前明确拒绝；纳入正式回归（boundary probes）。

### DELIVERY-06 — 验收判据

- **问题：** sleep/无身份 COUNT=0/弱网络证据。
- **要求：** 等待真实业务响应；管理员身份 DB 对照；Chromium  egress 阻断；恢复 A1–A9 含义。

## 原 A1–A9（不可被六项替代）

A1 全功能迁移矩阵 · A2 完全独立运行 · A3 浏览器闭环 · A4 认证/范围/金额 · A5 业务语义 · A6 PG 权限/事务 · A7 真实同步发布 · A8 历史/审计/恢复 · A9 综合回归（含 opt6 已知 1 fail / 5 pass 例外）。

## 验证命令

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

## HOLD（不提交）

- `.claude/context-status.json`
- `docs/reports/2026-07-18-内网部署可行性评估报告.md`
- 三份 `tools/bigseller-scraper/sync/__pycache__/*.pyc`
- 全部 `.local/` 证据与 pgdata

保护报告 SHA256：`9b42a3f9486bd0c377be77c051ff947aaed6b17bc567925f1c09344171a6db2c`

## 返工实施记录（2026-10-15）

| ID | 关闭说明 | 主要变更 | 回归 |
| --- | --- | --- | --- |
| 01 | `_variantExists` / favorite 传递 `profileUserId` | `preferences/repository.ts` | `delivery-rework.postgres.test.ts` |
| 02 | 独立平台 `updateQuantity` 抛错；action 拒绝 | `inventory/repository.ts`, `actions.ts` | 同上 |
| 03 | `partial_warehouse_shipment` 入 `app_required` | `006_least_privilege_grants.sql` | 同上 + 既有 shipment 测试 |
| 04 | sync INSERT 策略；`sync_run_id`/`triggered_by`；异常记 log | `007_sync_runner_rls.sql`, Python bridge/RPC | sync + real_write + delivery-rework |
| 05 | executor/name_backfill 执行前拒绝 Supabase | `executor.py`, `name_backfill.py`, `run-python-boundary-probes.mjs` | `test:p0-02:sync` |
| 06 | 浏览器 TX 内 GUC；API/DB 断言；Chromium 阻断 | `run-browser-tests.mjs` | `test:p0-02:browser` |

**总验收（返工后）：** `check-2026-10-15T01-24-49-983Z` exit 0；Postgres **43/43**；Playwright **11** 项。

**d4f7804 返工提交（已推送）：** `9ac3b8b` · `56162d3` · `af28645` · `dbaf953` · 远端 HEAD `dbaf953`

**总验收：** `check-2026-10-15T02-03-22-319Z` · Postgres **45/45** · Browser **14**

**交付状态：** `P0_02_IMPLEMENTED_AWAITING_REVIEW` — 待新一轮独立审查。

## 原 A1–A9 合同（完整，不可缩略）

- **A1** 保留功能逐项：入口 → 链 → Repository/SQL/RPC → 权限表 → 测试 → 证据；区分已实现/已验证/封存。
- **A2** 无 Supabase 凭据与回退；Node/浏览器/Python 阻断下可运行；boundary probes 纳入回归。
- **A3** 真实浏览器登录、业务交互、**写入与导出**、DOM/网络/DB 对照；禁止 sleep/标题/200 代替业务证明。
- **A4** 匿名/篡改/撤权/跨范围/金额拒绝（响应、导出、缓存、日志）；并发保护保留。
- **A5** UUID/ICE 货号、来源权威、到货不加海外库存、发货不二次扣国内、缺失不变零、货值不含运费。
- **A6** 运行角色非 owner/BYPASSRLS；事务内身份；直写拒绝与 sync 正例。
- **A7** 虚构来源 → plan → Node claim → bridge → real_write → 数据/run/log；失败不半成品、不误报成功；非双次 unchanged 计划。
- **A8** 必要历史/审计/修订幂等、实例 init/重复/重启、fixture 负例与虚构备份恢复（非仅 fixture 负例）。
- **A9** TS/Python/并发/ lint/build/diff/opt6；`check:p0-02` 绑定当前源码证据；opt6 00051 唯一例外。

审查指令全文（脱敏副本）：`.local/.../independent-p002-delivery-d4f7804-20261015-01/next-instruction.md`
