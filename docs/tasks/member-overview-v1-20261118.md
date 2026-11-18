# 成员经营总览 v1（2026-11-18）

适用实例：**`run-20261026T211500Z-11a22b33`**（Web `3011` / PostgreSQL `59345`）。
基线：`origin/master` **`ea4a2a7`**（含 PR #22）。
交付状态：**本机实跑完成（执行方自验，未宣布 PASS）**；未推送/部署。
运行构建：**BUILD `0I2tB7lVHJu3R-sjKHiKc`**（3011 pid 30412，login 200）。

## 1. 目标与边界

成员登录后进入 `/dashboard`，一页看清自己负责的海外库存与在途货物，并能点进现有明细核对：

- 库存按账号实际获授的仓库汇总，展示实物、可售与数据时间；有库存金额权限时沿用商品库存页的估算货值与缺价口径；
- 物流按账号独立获授的物流市场展示当前票数、已知剩余在途、待核明细与最近成功读取时间；成员只读、不显示货值；
- 两块分别列数、分别失败，不跨来源相加；只获授一类时显示可用板块，两类都没有时显示空态；
- 管理员继续使用原经营总览（三阶段、货值、待处理、商品概览），本包不改其口径。

## 2. 数据与权限

| 板块 | 读取入口 | 口径 |
|---|---|---|
| 海外库存 | `catalog.read_inventory_warehouse_rows`（043 已按授权仓收窄） | 只统计 `status=adopted`；实物 `onHand`、可售 `warehouseAvailable` 分别求和；未对应/待采用/停用行不计数量 |
| 库存货值 | `catalog.read_member_item_amounts`（仅 `canViewAmount`） | 实物 × 采用单位成本；缺价商品只计数、不计金额；读取失败不写 0 |
| 物流 | `catalog.read_shipment_market_summary`（047 改为成员守卫） | 最近一次成功快照的当前明细；按 `access_member_markets()` 收窄；票数按 `shipmentId` 去重 |
| 物流待核 | 同上 | `remainingState=pending` 或 `manualConflict=true` 的明细；不计入已知剩余 |
| 数据时间 | 库存 `inventory_scope_payload.lastAllSuccessAt` / 逐仓观测时间；物流 028 `latestReadAt` | 时间原样格式化，不补造 |

库存仓库授权与物流市场授权互不代表：测试成员保留原「越南青林湾仓库 + DEE-龙仔厝（ICE专属）」两个仓，物流只授予「越南」；交叉配置时只把物流改为「泰国」，库存数字不变。

## 3. 实现

### 3.1 数据库 `db/catalog/047_member_overview.sql`

只改一个函数，不改表、不写业务行：

- `catalog.read_shipment_market_summary(text)` 守卫由 `require_admin()` 换成 `require_shipment_read()`；
- 非管理员追加 `s.market = ANY(catalog.access_member_markets())`；
- 管理员仍返回全部市场，024/028/030 的明细、剩余、冲突口径不变；
- 幂等：函数已含 `v_markets text[]` 时跳过。

`apply-047.mjs` 现役 **rollback 10/10、commit 10/10**：安装两次、管理员前后口径一致、成员只得到授权市场、无授权 `CATALOG_FORBIDDEN`、换泰国只返回泰国、探针授权复原、业务行数不变。

### 3.2 应用

- `src/features/member-overview/aggregate.ts`：库存/物流纯聚合；库存只计已采用行，物流待核只计未知或人工冲突；
- `src/features/member-overview/server/reads.ts`：两个板块分别读取、分别失败；库存金额只在 `canViewAmount` 时读；
- `src/features/shipment/server/reads.ts`：新增 `getMemberShipmentMarketSource()`，复用 028 的成员范围，不读商品卡片/成本；
- `src/features/member-overview/components/member-overview-page.tsx`：海外库存、物流在途两块；授权仓逐仓、授权市场逐市场列表与下钻链接；
- `src/app/dashboard/page.tsx`：管理员走原 `BusinessOverviewPage`；成员按实际仓库/市场授权渲染新页；两类都没有直接空态，不再重定向；
- `src/ui/ice-v4/workspace-shell.tsx`：经营总览对全部启用账号可见；
- 迁移接入 `prepare-instance.mjs` 与 `prepare-local-preview.mjs`，新实例按 045 → 046 → 047 安装。

## 4. 本机验收

证据目录 `.local/catalog/member-overview-v1-20261118/e2e/`，脚本 `verify-member-overview.mjs`（Playwright + 数据库基准），**21/21 PASS**，console/pageerror **0**。

### 4.1 同批次数字（2026-11-18 17:22 库存 / 17:28 物流）

| 项 | 首页 | 下钻 |
|---|---|---|
| 海外实物 | **1,548,101** | 越南青林湾 390,682（89 条来源行） + DEE-龙仔厝 1,157,419（144 条） |
| 可售 | **1,544,416** | 389,682 + 1,154,734 |
| 数据时间 | **2026-11-18 17:22** | 两仓均 17:22 成功批次 |
| 已知估算货值 | **¥4,102,807.19** | ¥1,299,923.23 + ¥2,802,883.96；缺价 0 款 |
| 越南物流 | **7 票 / 42 明细 / 已知剩余 466,684 / 待核 11** | 同市场货票列表「共 7 票」；打开 `POKNZX027976` 明细可见、无金额入口 |
| 最近成功读取 | **2026-11-18 17:28** | 与 028 当前快照 `latestReadAt` 一致 |

### 4.2 交叉授权

只把物流授权改为「泰国」，库存授权不动：

- 首页库存仍为 **1,548,101 / 1,544,416 / ¥4,102,807.19**，不随物流改变；
- 物流只剩 **泰国 19 票 / 51 明细 / 已知剩余 603,909 / 待核 0**；
- 首页物流表只有泰国行，不出现越南。

### 4.3 单板块 / 空态 / 管理员

- 撤掉物流授权：库存板块保留，物流显示「当前账号未获授物流市场」，不是整页空态；
- 再撤掉库存仓库：显示「暂无业务授权」空态，不显示任何数量或 0；
- 恢复原授权后两块与数字回到基线；
- 管理员 `/dashboard` 仍是原经营总览，不出现成员总览。

截图：`01-member-overview.png`、`02-inventory-drilldown.png`、`03-shipment-drilldown.png`、`04-cross-grant.png`、`05-empty.png`、`06-admin-overview.png`。

## 5. 验证

- `apply-047`：rollback **10/10**、commit **10/10**。
- 成员总览页面验收：**21/21 PASS**，console/pageerror 0。
- 全量标准测试 `npm test`：**975/975 PASS**（原 971 + 本包 4 个聚合单测）。
- `tsc --noEmit`：仅既有 BEST 5 条基线错误；改动文件及 `src/tests/scripts` eslint **0**。
- `git diff --check` 0。

## 6. 入口

- 成员经营总览：<http://127.0.0.1:3011/dashboard>
- 成员库存下钻：<http://127.0.0.1:3011/dashboard/inventory?source=overseas>
- 成员物流下钻：<http://127.0.0.1:3011/dashboard/in-transit>
- 管理员授权：<http://127.0.0.1:3011/dashboard/permissions/accounts> → 「验收成员V1」→ 编辑 → 物流市场

## 7. 构建与运行

```powershell
node scripts/catalog/apply-047.mjs --commit --allow-live-commit --run-id run-20261026T211500Z-11a22b33
node scripts/catalog/build-preview-workspace.mjs --run-id run-20261026T211500Z-11a22b33
node scripts/catalog/promote-preview-build.mjs --run-id run-20261026T211500Z-11a22b33
$env:CATALOG_PREVIEW_PORT="3011"; node scripts/catalog/start-local-preview.mjs --run-id run-20261026T211500Z-11a22b33
```

## 8. 已知边界

- 首页数字是**验收时点**（库存 17:22、物流 17:28）；后台按计划继续更新后，刷新会显示新批次。
- 测试成员实际有两个库存仓（含市场待确认的 DEE-龙仔厝），首页按实际授权全部列出；不是只显示越南一个仓。
- 验收中的物流授权切换/撤销为直接改测试成员授权，结束后已恢复原「越南」；这些切换不写账号审计。
- 物流板块只读、无金额；成员库存金额沿用角色「库存金额查看」。
- 未做多日稳定性、真实撤权压测与 200% 缩放验收；未部署。
