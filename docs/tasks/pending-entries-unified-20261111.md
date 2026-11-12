# 五页「待处理」弹窗统一 + 数据同步四卡各自待处理 + 物流/回执收口（2026-11-11）

状态：**独立差异复核 PASS、阻断 0**（[报告](../../.local/catalog/pending-entry-20261111/independent-review.md)；PASS 由独立复核给出，执行方不自行宣布）。
基线现役实例 `run-20261026T211500Z-11a22b33`（Web 3011 / PostgreSQL 59345），上一轮交付 BUILD **`rTtqiHYEDumTkYU2iu99X`**，
本轮最终 BUILD **`51fUvaqHICkrjR9mFQm-G`**（源码快照 `a198a5fa38f9d7c7…`）。本包不提交、不推送、不部署。

## 一、目标

### 1. 五个主页面统一「待处理」按钮

以 ICE 商品库现有按钮为样板（`src/features/catalog/shell/catalog-products-page.tsx` 的
`IssueToolbarEntry`）：同一图标、字号、按钮样式与数量徽标，**整个按钮可点**。
有待办显示数量；确实为零保留按钮，点开显示「暂无待处理事项」；读取失败显示「读取失败」。
位置：每页顶部工具栏/页头操作区，作为该行最后一个交互控件（商品库保持原位置：清空之后、计数之前）。

| 页面 | 路由 | 点开后 |
|---|---|---|
| 经营总览 | `/dashboard` | 弹窗按业务分类列出 5 类（商品资料 / 库存待对应 / 物流待复核 / 在途未计入 / 缺进货价），每类写明数量与处理入口；物流分类先关弹窗再打开复核弹窗；按钮数字写「N 类」 |
| ICE 商品库 | `/dashboard/catalog` | 弹窗直接列出待处理事项：商品、需要核对的原因/差异、具体操作；条数与 `/dashboard/catalog/issues` 一致 |
| 商品库存 | `/dashboard/inventory` | 弹窗列出参与库存计算、仍需人工绑定商品的海外仓记录；每行仓库、来源 SKU、「绑定商品」；徽标=清单总数（排除仓、已绑定等待下次同步都不计入） |
| 物流在途 | `/dashboard/in-transit` | 直接打开现有整页居中复核弹窗；数量=待复核记录数 |
| 数据同步 | `/dashboard/sync` | 四张卡信息栏第三行各自「待处理」，各自打开本卡弹窗：海外库存（与商品库存页同一数量）/ 物流在途（复核弹窗）/ 商品资料（已登记待办 + 本批更新预览）；国内库存为真实状态（快照可用 0 项/未读取 1 项），不再写死「待处理 0 项」 |

## 二、已确认数据事实（本机现役，只读）

- 库存对应队列：全量 **219**（= 141 + 排除仓 78）；排除仓为 `48787 昕兰PH自建仓(弃用)`（78 行）。
  参与仓范围 = `overview.scope.warehouseIds`；过滤后 **141** = 商品库存页可处理数量。
- 队列行身份：`bigseller:<warehouseId>:<externalSku>`（`022_inventory_dual_view.sql` row_key）。
  仓库行详情 URL：`/dashboard/inventory?view=warehouse&source=overseas&row=<rowKey>&q=<sku>`，
  该行详情内含「绑定商品 / 更换商品」编辑入口（`inventory-detail-panel.tsx`）。
- 物流待复核：**2** 条；市场越南，采购单 `POKNZX027485`，运单 `baisu1029-250box`、`261103572394`；
  上次/本次 1→2 与 2→1。
- 商品来源：已登记 open 事项 5；12:10 快照仍待应用（7 款变化 / 26 无变化 / 101 待核对 / 0 失败），
  含 93 个 `#REF!`，**继续不应用**。
- 上一轮克隆库应用回执：`partial`，写入 7（1 updated + 6 needs_review 写入），无变化 26，待核对 101，失败 0。

## 三、实现约定

- 共用按钮：`src/ui/ice-v4/pending-entry.tsx` + `pending-entry.module.css`（由 Lead 提供）。
  三种用法：`href`（链接）、`panel`（点击展开弹层）、`onOpen`（点击执行，如打开物流弹窗）。
- 弹层 portal 到 `body`，`position: fixed` 跟随按钮，点击外部 / Esc 关闭，焦点回到按钮，正文滚动。
- 数字来源一律服务端真实读取；读不到时 `state='failed'`，不得补 0。
- 组件 props 以 Lead 写入的最终文件为准（API 见文件头注释）。

## 四、文件分工（互不重叠）

| 包 | 负责人 | 写入范围 |
|---|---|---|
| P0 共用按钮 + 商品库入口 + 经营总览 + 数据同步页头/国内卡 | Lead | `src/ui/ice-v4/pending-entry.tsx`、`pending-entry.module.css`、`catalog-products-page.tsx`、`catalog-list.module.css`、`business-overview-page.tsx`、`business-overview.module.css`、`overview/server/reads.ts`、`overview/model.ts`、`sync-view.tsx`、`sync-view.module.css`、`app/dashboard/sync/page.tsx`、`app/dashboard/page.tsx`、`src/app/dashboard/layout.tsx`（如需） |
| P1 商品库存待绑定清单 + 入口 | teammate-a | `src/features/inventory/server/pending-bindings.ts`（新）、`inventory-view.tsx`、`inventory-filter-bar.tsx`、`inventory.module.css`、相关测试 |
| P2 物流复核同一弹窗恢复 + 实际决定文案 + 在途页入口 | teammate-b | `shipment-grouping-review.tsx`、`grouping-review-summary.ts`、`shipment-filter-bar.tsx`、`shipment-view.tsx`、`shipment-sync-source.tsx`、`shipment.module.css`、`grouping-review-summary.test.ts` |
| P3 商品回执单套数字 | teammate-c | `product-source/service.ts`、`product-library-update.tsx`、`product-library-update.module.css`、相关测试 |

`sync-view.tsx` 的国内卡改动由 Lead 完成；teammate-a 只导出读取函数，不改同步页。

## 五、验收

- 现役 3011 逐页点一次「待处理」：按钮可见、数量与点开后一致、能直达具体事项；
  海外库存点开只列可绑定记录（141）；物流两个入口（在途页工具栏、同步页分组/卡片）打开同一弹窗。
- 克隆库两条写入：① 同一弹窗「保存物流决定 → 当场恢复」；② 上一轮同一批商品数据核对新回执
  （7/6 样例、无变化/待核对/失败各一次）。
- 现役只读，DB 前后一致；12:10 快照继续待应用；现役待确认货号/货票不动。
- 截图：五个页面入口 + 两条克隆库结果；独立复核只看本轮改动，沿用上轮已通过的四卡与补号验证。

## 六、实施记录

### 1. 共用「待处理」按钮与弹窗

- 新增 `src/ui/ice-v4/pending-entry.tsx` + `pending-entry.module.css`：整块可点的按钮（图标 15px、40px 高、13px 字、padding 0 12px、图标左距 13px、18px 数量徽标），点击打开**整页居中弹窗**（portal 到 body、fixed 遮罩、`role="dialog"`、标题与关闭按钮固定、正文独立滚动、Esc/点遮罩关闭、关闭后焦点回按钮）。
  有待办显示数量；确实为零保留按钮并显示「暂无待处理事项」；读取失败显示「读取失败」，弹窗内可重试。卡片内使用时 `label=""`（信息栏 `dt` 已写「待处理」，避免重复文字），按钮只留图标+徽标。
- 五页入口：`overview-pending-open`、`catalog-pending-open`、`inventory-pending-open`、`shipment-pending-open`、`sync-*` 四卡入口。

### 2. 经营总览

- 新增客户端 `HomePendingEntry`：按钮「N 类」→ 弹窗按业务分类列出 5 类事项（商品资料 7 / 库存待对应 141 / 物流待复核 2 / 在途未计入 36 / 缺进货价 2），每条写明数量与处理入口；物流分类先关弹窗再打开与物流在途页相同的复核弹窗。
- 页面原「需要处理」清单保留（`#home-pending`），统计卡仍是「N 类」，不再把商品、库存行与货票相加。
- 服务端 `buildPending` 补「商品资料」分类（商品库待处理索引数量，读不到时显示读取失败、不补 0）。

### 3. ICE 商品库

- 新增客户端 `CatalogPendingEntry` + 服务端只读投影 `getCatalogIssuePendingPreview()`（`nameCn/iceCode/reason/differences/actionLabel/actionHref`）：按钮 7 → 弹窗直接列 7 条事项（商品、原因/差异、具体操作），与 `/dashboard/catalog/issues` 列表 7 条一致；弹窗底部「查看完整待处理索引」。
- 空态文案改为「暂无待处理事项」，与其余页一致。

### 4. 商品库存

- 新增纯函数 `src/features/inventory/pending-bindings.ts`（参与仓过滤、`bigseller:<warehouseId>:<externalSku>` 行身份、建议文案、行详情链接）与 server-only `src/features/inventory/server/pending-bindings.ts`（分页读取 `catalog.read_inventory_mapping_queue`，最多 5 页；超过上限返回读取失败而不是截断数量）。
- 工具栏「待处理」141 → 弹窗列出 141 行（队列 219 − 排除仓 48787「昕兰PH自建仓(弃用）」78 行）；每行仓库名 · 市场、来源 SKU、建议商品、「绑定商品」→ 对应行详情（`row=bigseller:…`，详情内含绑定编辑器）。

### 5. 物流在途

- `ShipmentGroupingReviewEntry` 新增 `variant="custom"` + `trigger` render prop：在途页工具栏渲染统一「待处理」（数量=待复核 2），点击打开同一整页居中复核弹窗；同步卡仍用 `count` 变体。
- 保存「仍然分开 / 仍是一票」后，同一弹窗立即出现该决定的「已有人工决定」行（市场、采购单/首单号、运单、时间），可直接点「恢复按飞书判断」；恢复后该行消失并提示「已恢复按飞书判断；待复核数量已刷新」，`router.refresh()` 同步数量；恢复不再被 `savedIds` 阻挡；本地行与服务端行按 reviewId 去重。
- `decisionSavedText` 去掉写死的「（本次按两票处理）」，只写实际决定；人工决定行标题优先用实际 decision。

### 6. 数据同步（每张卡各自的「待处理」）

- 删除页头独立「待处理」，四张卡信息栏第三行统一为「待处理」，各自打开本卡弹窗：
  - 海外库存（`sync-overseas-pending-open`，141）：弹窗列出与商品库存页同一份待绑定记录；
  - 国内库存（`sync-domestic-pending-open`）：快照可用时 0 项、弹窗「暂无待处理事项」；未读取时 1 项并说明原因，不再写死「待处理 0 项」；
  - 物流在途（`sync-shipment-pending-open`，2 项，按钮为统一图标+徽标）：打开与在途页相同的复核弹窗；
  - 商品库更新（`sync-product-pending-open`，已登记待办 7）：弹窗分「已登记待办」与「本批更新预览 7 款变化、101 项需核对」，后者「查看本次更新」直接打开商品库更新弹窗。
- 「已登记待办」与商品库待处理索引同一口径（7，含两条刷子历史）；读不到时退回来源面板 open 事项数，不补 0。
- 国内卡第三行改为真实「待处理」后，「原文件」信息回到「最近成功」下方小字（2026-10-16 · 887 条），保留「查看库存明细」。

### 7. 商品更新回执

- `ApplyProductSourceSnapshotResult` 增加 `writtenNeedsReview`（results 中 `needs_review` 且已产生修订的条数）；带 counts 的 message 不再内嵌数字。
- 新增纯函数 `receipt-copy.ts` 的 `receiptSentence`：`已写入 X 款`（其中 N 款仍有字段待核对）+ `；无变化 X 款；待核对 X 款；失败 X 款`（+ 本次未见）；counts 缺失返回 null，页面只显示结果说明、不补 0。
- 克隆库同批页面只显示一句：`已写入 7 款，其中 6 款仍有字段待核对；无变化 26 款；待核对 101 款；失败 0 款。`，不再出现「已更新 1」第二套数字。

## 七、验证

- **现役 3011 只读 31/31 PASS**（`verify-live.json`）：总览「5 类」→ 920 宽居中弹窗（遮罩 1440×900、中心偏差 0）且 5 条分类、物流项关弹窗后开复核弹窗；商品库 7 → 弹窗 7 条（每条商品/原因/差异/操作）；商品库存 141 → 弹窗 141 行可滚动、无排除仓、首行「绑定商品」打开对应行详情绑定区；物流 2 → 复核弹窗（遮罩 1440×900、920×774 居中、两条摘要含市场/采购单/运单/票数、关闭焦点回入口）；同步四卡 `dt` 均为「待处理」、页头无独立入口，海外卡弹窗 141 行、国内卡弹窗真实状态、物流卡 2 项开同一弹窗、商品资料卡「已登记待办 7 + 本批预览 7/101」且「查看本次更新」打开更新弹窗；760 窄屏弹窗 460 宽不溢出；console/pageerror 0；DB 前后完全一致（items 126 / revisions 226 / codes 125 / adoptions 1078 / batches 2 / open 5 / requests 26 / audits 41 / pendingReviews 2 / activeOverrides 0 / mapping confirmed 512）。
- **克隆库 17/17 PASS**（`clone-verify.json`）：合票复核保存「仍然分开」→ 同一弹窗出现「仍然分开 … 恢复按飞书判断」且按钮可用 → 恢复后行消失、override 停用、回执说明已恢复、pending 2→1；同批商品应用回执单句与 DB `partial`（updated 1 / unchanged 26 / needsReview 101 / failed 0）一致，修订 226→233、open 5→108。
- 单测 **868/869**（唯一失败为既有 `opt6-production-apply` 换行基线）；`tsc` 仅既有 BEST 5；改动文件 eslint 0；`git diff --check` 0。
- 最终 BUILD **`51fUvaqHICkrjR9mFQm-G`**（源码快照 `a198a5fa38f9d7c7…`），ready/manifest/BUILD_ID 与 3011 实际运行一致，login 200。

## 八、边界与已知限制

- 12:10 含 93 个 `#REF!` 的快照**仍未在现役应用**；现役未点确认更新、物流决定、绑定或补号，DB 零写入；未改飞书、未新增 DB 对象/迁移、未提交/推送/部署。
- 构建期间修复的集成问题：①总览服务端组件向客户端传 render prop 导致 `/dashboard` 500（改为客户端 `HomePendingEntry`）；②同步页弹层内渲染复核组件、关闭弹层会把弹窗一起卸载（改为根节点常驻 + ref）；③卡片内按钮重复显示「待处理」文字（卡片内 `label=""`，保留图标+徽标）；④商品资料卡「已登记待办」数量与商品库索引口径不一致（统一为 7）；⑤物流卡仍用复核组件的 `count` 变体（无图标，独立复核 B1），改为统一 `PendingEntry`（图标 15×15 + 徽标）作为 `variant="custom"` 的 trigger。均已在最终 BUILD 复验。
- 商品库存队列超过 500 行（5 页上限）时入口显示「读取失败」而不是截断数量（现役 219，不触发）。
- 经营总览「在途未计入」「缺进货价」为状态/数量随来源变化，验收以页面实时数值核对，不写死样例。
- 独立差异复核结论见 [independent-review.md](../../.local/catalog/pending-entry-20261111/independent-review.md)。
