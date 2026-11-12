# 商品库「待处理」页原因/差异/入口精简（2026-11-10）

状态：**独立差异复核 PASS、阻断 0**（[报告](../../.local/catalog/pending-simplify-20261110/independent-review.md)；PASS 由独立复核给出，执行方不自行宣布）。仅限现役实例 `run-20261026T211500Z-11a22b33`（Web 3011 / PostgreSQL 59345）；BUILD **`bE6ov6FDG1VIegDXWaKW4`**（源码快照 `87ff8fdb314e3a83…`）。证据 `.local/catalog/pending-simplify-20261110/`（不入 Git）。

## 1. 用户要求

1. 每条默认只展示：商品名与货号 → 具体原因及必要差异 → 对应处理按钮；原因用正常正文，不放浅色小字。
2. 按真实事项生成原因：同号多行说明同号两行、条码不一致并直接显示逐行差异；缺正式货号说明需人工确认后补录；两条刷子历史事项说明两款分别保留、是否同款未确认。文案与差异来自现有事项数据，不写死示例。
3. 删除每张卡重复的「修正步骤」「标记已处理说明」等长段落；说明放到实际执行动作的位置，来源/批次详情按需展开；关键原因和差异默认可见。
4. 不再统一显示「来源资料待核对」「去处理」；按钮说明具体动作并定位到对应事项；字段名用「商品条码」「正式货号」，去掉「字符串」等技术注释。

范围为展示、必要数据投影与入口定位，沿用现有处理机制；只做相关验证。

## 2. 实现

### 2.1 原因与差异（服务端派生）

- `src/features/catalog/issues/module-facts.ts`：从既有 `product_source_issue.detail` 投影 `duplicate.fields`（字段中文名、逐行原值、是否未填写）与 `pendingCode`；缺码字段显示为「正式货号」。不解析、不猜测、不重算来源。
- `src/features/catalog/issues/issue-index.ts`：新增 `reason`、`differences`、`actionLabel`、`referenceLabel`。
  - 同号多行：`同一货号有两行，商品条码不一致，请选择以后采用哪行资料。`；差异按事项中的行号与值生成，如 `第63行：未填写；第127行：757577407380。`；按钮 `选择采用行`。
  - 商品级缺码：`该商品尚无正式货号，需要人工确认后补录。`；按钮 `确认并补货号`。
  - 刷子历史事项：两条事实共用 `WM0081 与 brush 暂按两款分别保留，是否同款尚未确认。`；入口 `查看资料`。
  - 其他来源类型按既有事项类型给具体原因与动作文案，不再使用统一「去处理」。
- 字段标签：`barcode` 统一为「商品条码」（去掉“字符串”技术注释）；缺码事项的 `iceCode` 显示为「正式货号」。

### 2.2 卡片展示

- `src/features/catalog/issues/issue-index-view.tsx` + `catalog-issues.module.css`：卡片顺序为名称/货号 → 原因（13px 正文色）→ 差异（默认可见）→ 具体动作按钮；删除状态徽标、「无处理入口」、问题字段行、修正步骤与「标记已处理」长说明。
- 来源、来源行、飞书原表、商品资料入口收进默认折叠的「来源信息」；关闭依据仍只保留在 sr-only。
- 缺码事项在货号位置显示「正式货号待补录」。

### 2.3 入口定位

- `productSourceReviewHref(issueId)` 生成 `/dashboard/catalog/sources?issue=<id>&from=… #product-source-issue-<id>`。
- `src/app/dashboard/catalog/sources/page.tsx` 读取 `issue` 参数并传给来源面板；`product-source-panel.tsx` 为每条待核对事项增加稳定 `id`、`data-focused` 高亮、滚动与聚焦，找不到时给出短提示。
- 刷子「查看资料」沿用既有商品详情入口（带 `from`）。

## 3. 当前真实数据（改后页面原文）

- 4 条同号多行：WM0069（63/127）、WM0070（64/128）、WM0071（65/129）、WM0073（67/131）。
- 1 条商品级缺码：`ICE LERSKIN 烟酰胺提亮精华水150ml`。
- 2 条刷子历史事项：WM0081 `ICE LERSKIN 泥膜配套硅胶刷`、brush `硅胶刷`。
- 页面共 **7 项 / 7 款** = 5 条 `product_source_issue` open（4 同号 + 1 缺码）+ 2 条 `decision_evidence` 刷子历史 pending；两者口径不同，故不把 7 写成 7 条 open 事项。

## 4. 验证

- `issue-index` **32/32**、`product-source.test.ts` **75/75**。
- 真实浏览器 **64/64**、console/pageerror 0：4 组同号原因/差异/按钮逐个核对；点击按钮后 URL 带 `issue=` 与锚点、目标卡片高亮且在视口、对照表可见、activeElement 为目标；缺码按钮定位到补号表单；刷子「查看资料」打开商品详情。
- 布局/展开/高亮 **11/11**：1440 与 760 宽无横向溢出，按钮位于原因/差异之后；来源信息可展开。
- 来源面板 **8/8**：无「字符串」，差异表头为「商品条码」，缺码块为「正式货号」。
- `tsc --noEmit` 仅既有 BEST 5；改动文件 eslint 0；DB 计数与改前一致（items 126 / revisions 226 / codes 125 / adoptions 1078 / batches 2 / open 5）。
- BUILD `bE6ov6FDG1VIegDXWaKW4`、源码快照 `87ff8fdb314e3a83…`；ready/manifest/server 一致；3011 login 200。

### 4.1 独立差异复核（PASS、阻断 0）

- **PASS、阻断 0**（[报告](../../.local/catalog/pending-simplify-20261110/independent-review.md)）。复核人自写 Playwright/psql/构建探针，未沿用执行方结论、未覆盖执行方证据。
- 独立复跑：页面 7 条逐项名称/原因/差异/按钮与 DB detail 一致；原因 13px/rgb(39,50,68)；4 个同号入口 URL/锚点/高亮/视口/对照表，缺码定位补号表单，两条刷子「查看资料」分别打开 brush 与 WM0081 详情；1440/760 无溢出；console/pageerror 0；DB 零变化（items 126/revisions 226/codes 125/adoptions 1078/batches 2/open 5，request/audit 时间未变）；12:10 快照仍未采用；BUILD/源码/workspace/staging/server 一致、login 200；issue-index 32/32、product-source 75/75、tsc 仅既有 BEST 5、改动文件 eslint 0、diff check 0。
- 非阻断观察：O1 页面 7 项含 2 条刷子历史 pending（DB open=5），已在 §3 注明口径；O2 卡片折叠的「来源信息」未含批次编号/采集时间，批次记录在来源面板底部；O3 刷子历史项无来源块/历史标记；O4 单字段差异行未加「商品条码：」前缀（原因句已含字段名，与用户示例一致）；O5 sr-only 关闭依据文本视觉不可见。
- 复核未点任何写操作、未应用 12:10、未重跑执行方 64/64 全量脚本（关键子集由复核独立覆盖）；未做 200%/权限矩阵/多日/Mac。

## 5. 边界

- 未关闭/处理任何事项，未补号、未选择采用行，未改写商品或来源，未重新读取/应用飞书快照（12:10 `#REF!` 快照仍未采用）。
- 未新增数据库对象/迁移；未跑全仓全套，只跑相关单测、定向浏览器与静态检查。
- 未提交/推送/部署。
