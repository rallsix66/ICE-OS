# P0-02 独立审查摘要（d4f7804 返工轮）

审查结论：**CHANGES_REQUIRED** · 审查 HEAD：`d4f7804c5e3f1fa1648ee91b3ca993f59545600e` · Run：`run-20261014-r2`

原始探针与 JSON 证据（不入 Git）：`.local/p0-02/run-20261014-r2/reviews/independent-p002-delivery-d4f7804-20261015-01/`

## 已保留的有效修复（审查 verifiedSubfixes）

- DELIVERY-01：身份传递与 toggleFavorite 原生 PG 回归
- Action/Repository 人工改量拒绝
- `partial_warehouse_shipment` 精确 GRANT
- sync INSERT 正例与失败日志 `sync_run_id` / `triggered_by`
- name_backfill 冷启动 true 拒绝
- 浏览器事务 GUC、响应等待、路由拦截（判据仍不足）

## 本轮关闭项（实施对应）

| ID | 审查问题 | 实施要点 |
| --- | --- | --- |
| 02 | app runner 直写 quantity | `011_seal_app_inventory_quantity.sql`：REVOKE UPDATE + RLS 只读 |
| 03 | partial_warehoused CHECK | `012_tracking_event_partial_warehoused.sql` + 有效部分入仓 PG 回归 |
| 04 | 半成品发布 / bridge 伪成功 | 发布事务 defer commit；`web_bridge` / `real-sync-runner` 传播失败 |
| 05 | name_backfill 缓存绕过 | 守卫先于缓存；`1/yes/true` 统一解析；扩展 boundary probes |
| 06 | A3/A7/A8/A9 缩水 | 浏览器关注/导出/外网自检；独占 real_write；check 增 Python boundary |

## 验证入口（返工后）

```powershell
Set-Location -LiteralPath 'D:\try one\ICEOS'
$env:P0_02_RUN_ID = 'run-20261014-r2'
npm run check:p0-02
```

Postgres **45/45**（含 delivery-rework 8 项）；sync 含重写 `test_p0_02_postgres_real_write_chain`。

正式任务包（完整 A1–A9 合同）：[docs/tasks/p0-02/2026-10-15-delivery-rework.md](../tasks/p0-02/2026-10-15-delivery-rework.md)
