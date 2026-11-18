# 成员物流在途 v1 本轮补修：后台恢复 + 冲突字段 + 启停审计 + 授权文案（2026-11-18）

适用实例：**`run-20261026T211500Z-11a22b33`**（Web `3011` / PostgreSQL `59345`）。
基线提交：**`76b851d`**（`feat/member-logistics-market-v1`）。
交付状态：**执行方自验完成，未宣布 PASS**；成员查票主流程沿用上一轮独立复核，本文件只覆盖本轮补修影响面。
运行构建：**BUILD `-lyX4Pxg5aGgaM_7bUUNS`**（源码快照 `c2720425…`，3011 login 200）。

## 1. 恢复三个后台（优先）

15:02 独立检查时三个后台均已退出（最后一次完成：库存 13:22、飞书物流 13:54、飞书商品资料 13:57）。本轮按现有运行手册原配置恢复，未改间隔、来源或实例配置；现有证据不足以判断退出原因，不判定根因。

| 后台 | 启动命令 | 进程 | 恢复后真实读取 | 下次计划 |
|---|---|---|---|---|
| 库存同步（BigSeller，60 分钟） | `node scripts/inventory/start-worker.mjs --run-id …` | pid **49596**（owned=true） | run `98dfd747-cbf8-414a-a042-409b8860f5c2`：planned 14:22，**15:37:03 领取 → 15:37:20 导出 → 15:37:23 success**，**7 仓 / 655 行**（采纳 512 / 待对应 143） | **16:22:02** |
| 飞书物流在途（10 分钟） | `node scripts/shipment/start-worker.mjs --run-id …` | pid **65480**（owned=true） | 启动时 15:37 一次 `SOURCE_CLI_FAILED`（飞书 TLS handshake timeout，保留 13:54 成功数据）；**15:47:40 重试成功**（快照 `50df086a…` / rev 2584），**15:57:47 再次实际读取成功**（快照 `73f5194c…` / rev 2595），均 **53 票 / 137 明细**（已关联 98 / 未关联 39） | **16:07:47**（约 10 分钟一次） |
| 飞书商品资料（60 分钟） | `node scripts/catalog/feishu-source/start-worker.mjs --run-id …` | pid **32696**（owned=true） | **15:45:49 实际读取返回 `unchanged`**（业务行 133 / 唯一码 128 / 图片单元格 131），未应用批次 | **16:45:49** |

- 三个进程均在 `status.mjs` 中 `owned=true`、`workerOnline=true`，本轮交付后保持运行。
- 飞书物流 15:37 失败不掩盖恢复：失败快照保留上次成功数据，15:47 实际读取成功；按任务口径，`unchanged` 也可验收，本轮为真实 `success`。
- 本轮没有改 worker 源码、间隔、来源或数据库调度；库存 worker 仍运行冻结副本，hash `1db4017a…`。

## 2. 修复 045 物流人工修正索引（`db/catalog/046_member_logistics_markets_fixes.sql`）

045 为成员市场过滤重写 `read_shipment_manual_index()` 时，漏掉 030 增加的字段：

- 票级：`manualConflictCount`；
- 明细：`shippedQuantity`、`manualShippedQuantity`、`previousConfirmedShelvedQuantity`、`manualConflict`。

后果：冲突明细不会被识别/排除，详情不显示「原发货量 → 现发货量 / 已确认上架量」，单票货值会把冲突差额算进去。

046 只恢复这些字段，**保留 045 的 `require_shipment_read()` 与 `access_member_markets()` 市场过滤**，不改表、不写业务行。

**隔离样例验证**（`apply-046` 事务内样例 + 页面实际打开，样例已清理）：

- 样例票 `TEST-CONFLICT-046`：人工确认「全部上架」时发货量 100；来源随后调高到 150；已确认上架 100。
- 管理员详情显示：**「待复核 · 原表 100 → 150 · 已确认上架 100」**。
- 索引回读：`shippedQuantity=150`、`manualShippedQuantity=100`、`previousConfirmedShelvedQuantity=100`、`manualConflict=true`、票级 `manualConflictCount=1`。
- 同票另一条正常明细 10 件、采用价 2.2；**本票在途货值 ¥22.00 · 1 条未计入**——冲突明细的 50 件差额不计入（若误计入，货值会是 ¥132.00）。
- 成员仅授予越南时仍能读到该样例的冲突字段；清空物流授权后索引被 `CATALOG_FORBIDDEN` 拒绝，市场过滤未被回退。

## 3. 修正账号保存的启停审计

`update_access_account` 的 `before.isActive` 误取了表单新值（`p_is_active`），应为保存前的 `public.profiles.is_active`。046 已改为 `p.is_active`；`before.displayName` 本来就是表列旧值（参数名是 `p_display_name`），仓库与物流市场 before 也保持原逻辑。

页面实际流程（测试账号「验收成员V1」）：

| 操作 | 审计 `before.isActive` | 审计 `after.isActive` | 结果 |
|---|---|---|---|
| 启用 → 停用 | **true** | **false** | 通过 |
| 停用 → 启用 | **false** | **true** | 通过 |

两次保存各写一条 `access_account_updated` 审计；账号最终保持启用、越南物流授权保留。

## 4. 去掉物流市场旁的「当前 N 票」

账号编辑页只保留市场名称与勾选状态（如「越南物流」+ 勾选），不再显示「当前 N 票」。现役越南的 13 是含历史票的来源计数，而当前列表为 6 票，两者口径不同，容易误读；本轮已移除该提示，数据库仍保留 `ticketCount` 供后台接口使用，不影响授权或取数。

## 5. 验证

- `apply-046`：现役 **rollback 12/12、commit 12/12**（含冲突样例、审计启用/停用、成员过滤、无授权拒绝、样例回滚后行数不变）。
- 补修页面验收 `verify-fixes.mjs`：**9/9 PASS**，console/pageerror 0；截图 `08-conflict-sample-detail.png`、`09-account-dialog-no-count.png`。
- 成员查票主流程回归 `verify-logistics-markets.mjs`：**23/23 PASS**，console/pageerror 0（只回归，不重复独立复核结论）。
- `tsc --noEmit`：仅既有 BEST 5 条基线错误；改动文件 `eslint` 0。
- 全量标准测试 `npm test`：**971/971 PASS**。
- 隔离样例已删除：货票 85 / 明细 231 回到基线（`TEST-%` 票 0 条）；页面验收的两次启停审计按设计保留，期间授权开关回归另产生正常审计。
- 迁移已接入 `scripts/inventory/prepare-instance.mjs` 与 `scripts/catalog/prepare-local-preview.mjs`；新实例按 045 → 046 顺序安装。

## 6. 入口

- 成员物流在途：<http://127.0.0.1:3011/dashboard/in-transit>
- 管理员授权：<http://127.0.0.1:3011/dashboard/permissions/accounts> → 「验收成员V1」→ 编辑 → 物流市场
- 交付账号：`member.v1@catalog.test` / `admin@catalog.test`（密码见本机凭据文件）

## 7. 已知边界

- 三个后台仍无服务守护/开机自启；退出原因缺少 OS 级证据，本轮只恢复并保持运行。
- 冲突样例是临时隔离样例（已清理），不是现役真实冲突票；现役当前无同口径冲突样例。
- 未做多日稳定性、真实撤权压测与 200% 缩放验收。
