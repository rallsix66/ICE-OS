# 成员按授权物流市场查看物流在途 v1（2026-11-18）

适用实例：**`run-20261026T211500Z-11a22b33`**（Web `3011` / PostgreSQL `59345`）。
交付状态：**本机现役独立复核 PASS，阻断 0**（验收提交 `7a4dd12`；功能 `76b851d`，四项补修见 [补修记录](member-logistics-markets-v1-fixes-20261118.md)）。
运行构建：**BUILD `-lyX4Pxg5aGgaM_7bUUNS`**（源码快照 `c2720425…`，3011 login 200；含 2026-11-18 补修 046 与账号文案调整，补修记录见 [member-logistics-markets-v1-fixes-20261118.md](member-logistics-markets-v1-fixes-20261118.md)）。

- 前置任务：[permissions-v1-20261117.md](permissions-v1-20261117.md)（角色/账号/仓库范围；物流在途仍是管理员功能）
- 运行交接：[inventory-sync-v1-runbook.md](inventory-sync-v1-runbook.md)、[shipment-in-transit-v1-runbook.md](shipment-in-transit-v1-runbook.md)

## 1. 目标与边界

管理员在现有「权限设置 → 账号管理」里**另外**勾选成员可查看的物流市场；成员登录后可在「物流在途」按票号搜索、按状态筛选、打开授权市场的货票查看商品、物流状态与剩余在途数量，关闭详情回原筛选位置。

- **仓库与物流市场分别授权**：库存仓库范围（`account_access_warehouse`）与物流市场范围（新表 `account_access_market`）互不代表；只给越南仓的成员仍需勾选「越南物流」才能看越南货票。
- **默认没有物流授权**：新表为空；已有成员升级后 `canViewShipment=false`，导航不出现「物流在途」，直接访问显示「暂无物流市场授权」。
- **成员只读**：货值、修正在途、拆合票复核、商品绑定/更换/清除继续只限管理员；服务端不仅隐藏按钮，管理员写函数守卫不变。
- 市场值使用飞书物流情况表的「来源国家/市场」原值（现役：泰国 / 菲律宾 / 越南 / 马来西亚），与库存仓库的 `market` 代码（VN 等）不是同一套，不混用。
- 不做：多市场以外的物流写权限、成员货值、成员导出、跨市场统计给成员。

## 2. 数据库 `db/catalog/045_member_logistics_markets.sql`

| 内容 | 说明 |
|---|---|
| 新表 `catalog.account_access_market` | `(profile_id, market)` 主键；强制 RLS；只有管理员与属主两条策略；不授予运行角色直接表权限 |
| `catalog.access_member_markets()` | 当前登录、启用中的成员被授予的市场（`text[]`）；管理员返回空数组，由调用方短路 |
| `catalog.require_shipment_read()` | 物流读取入口守卫：管理员，或启用中且至少获授一个物流市场的成员；否则 `CATALOG_FORBIDDEN` |
| `catalog.read_my_inventory_access()` | 原字段不变，补 `canViewShipment` 与 `shipmentMarkets`（导航/页面按此渲染） |
| `catalog.read_access_market_options()` | 管理员可勾选的市场 = 飞书物流表出现过的市场 + 当前票数 |
| `catalog.access_account_rows` / `read_access_account` | 账号列表与详情返回 `logisticsMarkets`（仓库范围字段保持原语义） |
| `catalog.create_access_account` / `update_access_account` | 新增 `text[]` 市场参数；入库前只保留物流表真实存在的市场（去空白/去重/丢弃未知）；审计前后值含市场 |
| `catalog.read_shipment_list` | 入口改名守卫；成员在 `scoped` 上加 `s.market=ANY(被授予市场)`，**总票数、5 类状态计数、市场计数、分页行、本次来源未见计数**全部同一范围 |
| `catalog.read_shipment_detail` | 入口改名守卫；成员打开未授权市场的票返回 `NULL`（按不存在处理，不暴露存在性） |
| `catalog.read_shipment_manual_index` | 入口改名守卫；成员只得到授权市场票的有效状态与人工修正数量（与列表/详情同口径） |
| `catalog.read_shipment_manual_history` | 入口改名守卫；未授权市场的票返回空数组 |
| `catalog.read_shipment_source_status` | 入口改名守卫；成员只得到「上次成功读取时间 / 最近尝试状态」，不返回跨市场票数、文档标题或错误正文 |
| 未改 | 028 货值汇总、029 修正在途/恢复、026 关联更新、033 拆合票复核仍是 `require_admin`；026–044 原文件未改 |

函数改写方式：小函数直接 `CREATE OR REPLACE`；026/029 的中大函数用 `pg_get_functiondef` 取现行定义做**精确文本替换**后重装，替换次数必须等于预期，否则整段报错；已替换过则跳过，重复安装幂等。

## 3. 应用层

- `src/features/access/`：`types.ts` 补 `logisticsMarkets` / `AccessMarketOptionDto` / `canViewShipment` / `shipmentMarkets`；`server/reads.ts` 新增 `getAccessMarketOptions()`；`server/actions.ts` 建号/改号提交 `marketKeys`（去空白/去重，真实性由数据库入口校验）；`components/account-manager.tsx` 新增独立「物流市场」勾选区、账号列表「物流市场」列与回执。
- `src/app/dashboard/permissions/accounts/page.tsx`：并行读取角色、仓库选项、物流市场选项、账号列表。
- `src/features/shipment/server/reads.ts`：新增 `requireShipmentReader()`；`getShipmentList` 改用成员守卫（成员不再尝试管理员自动读取状态）；`getShipmentDetail(shipmentId, {member})` 成员不读成本卡片/人工历史/本票货值，有效状态与剩余数量仍用同一份人工索引。
- `src/app/dashboard/in-transit/page.tsx`：先读当前账号摘要；没有物流授权且非管理员时显示「暂无物流市场授权」；成员只读列表与详情，不调用货值、拆合票复核；管理员行为不变。
- `src/features/shipment/components/`：`shipment-view.tsx` 按身份隐藏货值汇总页签、拆合票复核、自动刷新与「查看同步」；`shipment-filter-bar.tsx` 成员隐藏「包含本次来源未见」与列设置；`shipment-table.tsx` 成员空态不引导管理员刷新入口；`shipment-detail-drawer.tsx` 成员只有「货票详情」页签，无单位成本、货值、修正在途、恢复、更换/清除/关联按钮。
- 导航：`workspace-shell.tsx` 新增 `requires: 'shipment'`（管理员或至少一个物流市场）；成员有库存看「商品库存」，有物流市场看「物流在途」。`/dashboard` 对成员按可用能力分流：有库存去库存，否则有物流去在途。
- 迁移接入：`scripts/inventory/prepare-instance.mjs` 在 044 后安装 045；`scripts/catalog/prepare-local-preview.mjs` 增加 045 依赖项（表/函数未就绪时 skipped，由 prepare-instance 后装）。新增 `scripts/catalog/apply-045.mjs`（默认 rollback：安装两次 + 行为探针 + 回滚；现役提交需 `--allow-live-commit`）。

## 4. 本机实跑验收（现役 3011，2026-11-18）

证据目录 `.local/catalog/member-logistics-markets-v1-20261118/`，脚本 `e2e/verify-logistics-markets.mjs`（Playwright，真实页面 + 数据库基准）。

### 4.1 主流程 **23/23 PASS**（console 0 / pageerror 0）

| 步骤 | 结果 |
|---|---|
| 测试成员「验收成员V1」已有越南青林湾仓库库存权限 | 通过（前置任务交付账号） |
| 管理员账号管理可关闭成员「越南物流」授权（复位到默认无物流授权） | 通过 |
| 没有物流授权时成员导航不出现「物流在途」 | 通过（只剩「商品库存」） |
| 没有物流授权时直接访问 `/dashboard/in-transit` | 通过（「暂无物流市场授权」，0 行货票） |
| 没有物流授权时带越南票直链 | 通过（页面仍为无授权提示，不出现票面） |
| 管理员勾选「越南物流」保存，账号列表显示「越南物流」 | 通过 |
| 授予后成员导航出现「物流在途」 | 通过 |
| 成员列表只出现越南货票，计数 **共 6 票**，与数据库当前快照一致 | 通过 |
| 成员不显示「货值汇总」页签与拆合票「待复核」入口 | 通过 |
| 按票号搜索 `POKNZX027976` 只命中该票，`q` 写回 URL | 通过 |
| 按状态筛选「运输在途」结果全部符合且包含目标票 | 通过 |
| 打开货票：5 条商品、状态「运输在途」、发货量/累计到货/剩余在途逐条与数据库一致 | 通过 |
| 成员详情无货值、无单位成本、无修正在途/更换/清除/关联、无变更记录页签 | 通过 |
| 关闭详情回到原筛选位置（`q` + `status` 保留） | 通过 |
| 数量待核票 `POKNZX027575`：剩余在途显示「待核」，不写 0 | 通过 |
| 成员打开未授权市场（泰国）`POKNZX027677` 货票直链 | 通过（「没有找到该货票」，不出现票面） |
| 成员按泰国的票号搜索 | 通过（0 条；服务端范围过滤，不是前端隐藏） |
| 管理员打开同一张 `POKNZX027976`：商品、状态、剩余数量逐条与成员一致，管理员另有单位成本与本票货值 | 通过 |
| 授权保持：成员再次按越南票号搜索仍命中 1 条 | 通过 |

核对票号：**`POKNZX027976`**（越南，运输在途，5 条明细；剩余在途 13,000 / 5,184 / 922 / 40,320 / 41,040，管理员与成员一致）；待核样例 **`POKNZX027575`**；未授权市场直链样例 **`POKNZX027677`**（泰国）；无单号样例 **`261103572394`**、**`无单号·越南·行136`** 也在成员列表中可见。

### 4.2 迁移与结构检查

- `apply-045` 现役 **rollback 23/23 PASS**、**commit 23/23 PASS**：表/RLS/策略、函数守卫与 `search_path`、市场过滤标记、无授权拒绝、授权后只回越南（6 票 = 数据库当前快照）、未授权直链 NULL、管理员同票可读、市场选项、市场入库校验、账号读写与审计、建号、停用、成员仍不能读货值/改绑定、探针回滚后业务行数不变。
- 提交后回读：`account_access_market` 在位，列表/详情成员守卫在位，市场选项 4 个，成员原有授权未被改动（默认无物流市场），业务行数不变。

### 4.3 代码检查

- `tsc --noEmit`：仅既有 BEST 5 条基线错误；改动文件 `eslint` 0。
- 定向单测：access actions **6/6**、shipment model **61/61**、summary **18/18**、导航合同 **8/8**（合计 **93/93**）。
- 全量标准测试 `npm test`：**970/971**；唯一失败为既有慢测试 `get-catalog-list-page.test.ts` 首次 5s 超时，单独重跑 **5/5**，其余 61 个测试文件全部通过（opt6 基线本轮通过）。

## 5. 交付入口与测试账号

| 项 | 值 |
|---|---|
| 物流在途 | <http://127.0.0.1:3011/dashboard/in-transit> |
| 管理员授权入口 | <http://127.0.0.1:3011/dashboard/permissions/accounts> → 「验收成员V1」编辑 → 「物流市场」勾选「越南物流」 |
| 成员库存 | <http://127.0.0.1:3011/dashboard/inventory> |
| 管理员 | `admin@catalog.test` / 见 `…\instance\login.local-preview.txt` |
| 成员 | `member.v1@catalog.test` / 见 `.local/catalog/permissions-v1-20261117/test-accounts.md`（不入 Git） |

交付时成员已授予**越南物流**（验收流程最后一步；保留该授权以便复核）。若要复现「无授权看不到越南货票」，先在账号管理取消「越南物流」保存，再刷新成员页面。

## 6. 构建与运行

```powershell
# 数据库（本机现役 59345）
node scripts/catalog/start-catalog-postgres.mjs --run-id run-20261026T211500Z-11a22b33
# 045（已提交现役库；新库用 apply-045 或 prepare-instance）
node scripts/catalog/apply-045.mjs --commit --allow-live-commit --run-id run-20261026T211500Z-11a22b33
# 构建 → 提升 → 起 Web（3011）
node scripts/catalog/build-preview-workspace.mjs --run-id run-20261026T211500Z-11a22b33
node scripts/catalog/promote-preview-build.mjs --run-id run-20261026T211500Z-11a22b33
$env:CATALOG_PREVIEW_PORT="3011"; node scripts/catalog/start-local-preview.mjs --run-id run-20261026T211500Z-11a22b33
```

本轮最终 BUILD **`-lyX4Pxg5aGgaM_7bUUNS`**（源码快照 `c2720425…`，含 046 与账号文案调整；ready/manifest/preview-server 一致、login 200）；数据库迁移 045/046 已应用到现役库，迁移探针全部在事务内回滚。浏览器验收阶段另临时写入 **1 张票、2 条明细**（用于冲突样例页面读取），读取后已按票 ID 删除；独立复核回查 85 票/231 明细无残留。现役 `account_access_market` 1 行、越南当前快照 6 票。

## 7. 验证与已知边界

> 2026-11-18 收尾：本机现役独立复核 **PASS，阻断 0**（验收提交 `7a4dd12`）。首轮成员查票实跑与四项补修均通过；复核报告 [independent-review.md](../../.local/catalog/member-logistics-markets-v1-20261118/independent-review.md)、[independent-review-followup.md](../../.local/catalog/member-logistics-markets-v1-20261118/independent-review-followup.md)。样例说明已更正：迁移探针在事务内回滚；浏览器验收临时写入 1 张票、2 条明细，页面读取后删除，复核回查 85 票/231 明细无残留。
>
> 2026-11-18 补修：新增 [046](member-logistics-markets-v1-fixes-20261118.md)，恢复 045 漏掉的冲突/原数量字段并修正账号启停审计；成员市场过滤未回退。全量标准测试 **971/971 PASS**。

- 全量标准测试 `npm test` **971/971 PASS**。
- 成员列表/详情只读；货值、改票、商品绑定仍由服务端管理员守卫拒绝（apply-045 已探针验证）。
- 物流市场值来自 `catalog.shipment.market` 原值；若飞书把同一市场写成不同字符串，会按不同市场授权（当前现役 4 个市场值稳定）。
- 本次没有把物流市场并入库存仓库授权，也没有做成员货值、导出或跨市场汇总。
- 「本次来源未见」历史票对成员仍按授权市场范围可见（只能通过 URL `includeAbsent=true` 打开；页面不提供该入口），数量与状态仍是只读。
- 未做多日稳定性、并发撤权压测与 200% 缩放验收。
