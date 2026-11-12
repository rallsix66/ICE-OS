# 五页第二遍按实际用法补齐（待处理统一 / 库存候选 / 物流旧票依据 / 更新回执）—— 2026-11-13

状态：**独立差异复核 PASS、阻断 0**（PASS 只能由独立复核给出，执行方不自行宣布；报告 [independent-review.md](../../.local/catalog/ux-round-20261113/independent-review.md)，复核人自写页面探针 + 自建克隆库，最终定向复核新 BUILD）。执行方自验：现役 3011 只读 38/38、克隆库写入 23/23 通过。仅限本机现役实例 `run-20261026T211500Z-11a22b33`（Web 3011 / PostgreSQL 127.0.0.1:59345）。最终 BUILD **`UgkU0TjyeoLtMreXeu9ff`**，源码快照 **`2461321dcc51b54ed5b8bb84e838626d3bc4a1986f30c57deb05d5842afac34f`**；BUILD_ID / preview-server / preview-build-ready / next-workspace-manifest 与工作树一致，`/auth/login` 200。

## 一、经营总览 + 商品库：待处理统一为同一份数据

- 总览、商品库徽标、待处理弹窗、完整待处理页都取 **`buildCatalogPendingItems()`** 的同一份清单（现役 5 项 = 4 组同号多行 + 1 条飞书补号）；`buildCatalogIssueToolbarModel()` 也改成同一口径，不再用含刷子历史的索引条数。现役原先总览 7 项/点进去 5 项/旧索引 7 项的三处不一致消失。
- 两条刷子历史（WM0081 / brush）只在对应商品详情显示（`catalog-detail-brush-note`：两款刷子历史资料当时分别保留…），完整待处理页底部注明「另有 2 条刷子历史仅在商品详情查看」，不计入数量。
- `/dashboard/catalog/issues` 从只读索引改为**同一套可操作卡片**（与弹窗共用 `catalog-pending-cards.tsx`）：可就地确认同号多行/采用飞书货号、结果与清单即时刷新；不再出现「选择采用行」、不再跳旧来源页。弹窗底部入口改为「打开完整待处理页」。
- 同号多行回执直接写所选资料，例如「已保存，以后更新使用商品条码 757577407380 的这份资料（来源第 127 行）。」（取自两组来源行真实不一致字段；所选行未填写时写「商品条码未填写的这份资料」）。
- 处理最后一项后，`PendingEntry` 新增 `renderPanelWhenEmpty`，弹窗保留正文：成功提示（如「已为原商品补录编号 WM0131（保留原商品身份）。」）与「待处理已清空」同时可见，徽标数量消失。
- 总览另一条「2 款商品缺进货价」的分类从「商品资料」改为「缺价商品」，避免与「商品资料待处理」同名造成「5+2=7」的误读（独立复核 O0 观察项，已改）。

## 二、商品库存：SKU 6974674957332 一眼看出该选哪款

- 待处理弹窗展开该 SKU 只显示 **2 个候选**（不再按「仓×商品」重复列）：
  - `LS101274 · ICE LERSKIN 7% 乙醇酸爽肤水`（普通版），曾选过它的仓：越南青林湾仓库、菲律宾-新创启辰自建仓；
  - `WM0094 · ICE LERSKIN 7% 乙醇酸爽肤水(泰国特供版)`，曾选过它的仓：喜运达MY仓、DEE-龙仔厝。
- 每款显示品名、货号、条码 `6974674957332`、规格 `200ml/瓶`、曾选过它的仓，并逐条写**实际差异**（「品名不同：本款「…(泰国特供版)」，另一款「…」」）；条码/规格/单位相同不冒充差异。
- 已登记库存单位来自各仓已确认绑定的 `inventory_sku_mapping.unit`（两款均为「个」）：直接显示「已登记库存单位：个（核对后直接沿用，无需再填）」并带入选中的单位；只有缺失或各仓不一致时才要求填写。选中后「本次绑定单位：个（沿用该商品已登记库存单位，核对后可直接保存）」。
- 保存后弹窗顶部固定写结果：「本次保存 1 个仓；本组还剩 2 个仓可继续处理。还剩 140 条可继续处理。」；继续处理下一仓后「本组还剩 1 个仓…」；其他仓仍可接着处理。
- 搜索其他商品收进「都不是这两款？搜索其他商品」折叠区；本批样表建议仅在候选之外出现。

## 三、物流在途：用上旧票人工选择，准确说明货值结果

- 总览「查看未计入货票」→ `/dashboard/in-transit?view=value&excluded=open`，首次打开即展开未计入明细（不再需要再点「未计入」）。
- 新增只读 DB 函数 `catalog.read_shipment_association_history(jsonb)`（`db/catalog/038_shipment_association_history.sql`）：按「市场 + 规范化品名」读取历史明细里 **`association_method='manual_selected'`** 的人工选择，返回商品身份、旧票号、确认时间与次数；每个 (市场, 品名) 最多 3 款。只读、SECURITY DEFINER、`search_path=''`、仅 app 角色 EXECUTE、public 无权限、app 仍无 shipment_item/association_revision 表权限；未改 026/027/028，未新增业务数据。
- 现役新票 `POKNZX027667` 四个唇膏色号均能看到旧单依据：
  - 201 → WM0075、204 → WM0078、205 → WM0079、206 → WM0080；
  - 建议按钮写「旧单 POKNZX027378 人工确认过（2026-11-02 10:26）」，`data-old-ticket="POKNZX027378"`；
  - 依据来自 `shipment_item_association_revision.method='manual_selected'` 的真实记录（201 记录原文写明「色号 201、规格 1.1g+0.25g 与商品库 WM0075 唯一对应」）。
- 保存前仍必须选「只用于本票 / 以后同市场同品名也沿用」；全市场与单市场（`market=泰国`）两个入口同一套提示。
- 保存后先写「已关联商品」，再按该条明细的实际结果回写（服务端保存后按 026 详情 + 采用进货价同一口径回读）：「已关联商品；该条已计入货值。」／「已关联商品；该条仍缺进货价，暂未计入货值。」／「已关联商品；该条数量待核，暂未计入货值。」；货票详情抽屉同一套文案。

## 四、商品更新回执：补上部分完成说明

- 数据库回执为 `partial` 时固定显示「已确认的变更已写入，待核对字段保留原值。」，并以数据库回执渲染唯一一套数字：「已写入 N 款，其中 M 款已写入确认字段、另有字段待核对；无变化 X 款；待核对 Y 款；失败 Z 款。」。
- 写入数继续取回执：`updated/created` 与「`needs_review` 且已产生修订」都算实际写入，因此同一款商品可以已更新名称、同时仍有别的字段待核对，两种状态并存（克隆实测 written 9、其中 7 款仍有字段待核对、无变化 29、待核对 97、失败 0，与批次 counts 和逐条结果一致）。
- 核对到原请求（reconciled）时保留数据库回执原始状态 `receiptStatus`，部分完成提示不会因「已核对原请求」而丢失。

## 五、验证

### 现役 3011 只读（`.local/catalog/ux-round-20261113/verify-live.json`，38/38 PASS）

覆盖：总览商品资料 5 项与动作链接、弹窗 5 条/徽标 5、完整待处理页同 5 条/刷子说明/无旧动作、刷子历史在商品详情；SKU 6974674957332 两款候选（品名/条码/规格/曾选仓/单位「个」/实际差异/选中带单位）；总览未计入入口 `excluded=open` 首开展开、四个色号旧单依据与沿用范围、单市场同一提示；DB 前后快照完全一致（items 126 / revisions 226 / codes 125 / openIssues 5 / duplicateDecisions 4 / mappingConfirmed 512 / associationRevisions 192 / shipmentItemsWithProduct 108 / audits 41）；console/pageerror 0。

### 克隆库真实写入（`.local/catalog/ux-round-20261113/clone-verify.json`，23/23 PASS）

克隆库由现役 dump 创建，第二份 Web 用同一份已提升构建在 3012 启动，写完即删库停进程：

- 商品库：逐条处理 5 项（4 组同号多行 + 1 条飞书补号）→ 四条回执分别写「以后更新使用商品条码 757577407380 / 757577407397 / 757577407373 的这份资料（来源第 127/129/128 行）」；最后一条后成功提示与「待处理已清空」同时可见、徽标归零；DB open 5→0、人工选择 0→4、编码 125→126、修订 226→227、audit +5。
- 商品库存：选 LS101274（单位自动「个」）→ 勾菲律宾仓保存「本次保存 1 个仓；本组还剩 2 个仓可继续处理」→ 再选 WM0094 勾泰国仓保存「…本组还剩 1 个仓…」；确认绑定 512→514。
- 物流：201 依据写「旧单 POKNZX027378 人工确认过（2026-11-02 10:26）」并选「只用于本票」→「已关联商品；该条已计入货值。」；再把「均匀提亮精华」关联到缺价商品 WM10012 →「已关联商品；该条仍缺进货价，暂未计入货值。」；未关联明细 39→37、关联修订 192→194。
- 商品更新回执：应用最新待应用快照 → 标题「本批部分完成」、`product-library-receipt-partial` 显示「已确认的变更已写入，待核对字段保留原值。」、数字「已写入 9 款，其中 7 款已写入确认字段、另有字段待核对；无变化 29 款；待核对 97 款；失败 0 款。」与批次 counts 及 `product_source_result` 一致（written 9 = updated 2 + needs_review 且有修订 7；mixed 7）。

### 静态检查

- `npm test` **889/890**（唯一失败为既有 `opt6-production-apply` Windows 换行基线）。
- `tsc --noEmit --incremental false` 仅既有 BEST 5。
- 改动目录 eslint **0 error / 0 warning**（含修掉本轮引入的 2 条无用 disable）。
- `git diff --check` **0**（清掉了既有 inventory.module.css 末尾空行）。

### 新增/修改的数据库增量（只读）

`db/catalog/038_shipment_association_history.sql` + `scripts/catalog/apply-038.mjs`（默认 rollback 验证、`--commit` 到克隆库、现役需显式 `--allow-live-commit`；已登记进 `prepare-local-preview.mjs` 的 LOCAL_SQL）。现役 rollback 与 commit 均通过：函数 SECURITY DEFINER、search_path 锁定、幂等（函数体哈希不变）、app 可执行/public 不可执行、四个色号取到旧单记录、无人工记录不返回、app 仍无表权限、业务数量不变。现役只应用了这个**只读函数**，未新增业务数据。

## 六、边界与未覆盖

- 写操作只在克隆库执行；现役未点同号多行/补号/绑定/关联/确认更新，DB 零写入（前后快照一致）。
- 最新待应用飞书快照（`d5052e5f…`，2026-11-11 17:12 读取，133 业务行）仍未在现役应用；历史 12:10 含 93 个 `#REF!` 的批次同样未应用；未改飞书原表。
- 未提交/推送/部署；`.local` 证据不入 Git；无新增业务表/迁移，只新增只读 RPC。
- 已知非阻断：完整待处理页未做独立移动端适配（沿用 ICE 共用栅格）；库存候选卡片的单位仅在各仓一致时直接带出，各仓不一致时要求填写；旧票建议只覆盖「市场+规范化品名」完全一致的记录，不做模糊匹配（有意不猜）；货值提示在该条明细同时数量待核与缺价时优先显示「数量待核」。
- 本轮未重做上一轮的耗时对比（库存切换 552ms 等基线未回退：首屏仍未同步读 141 行清单）。

## 七、独立差异复核

**PASS，阻断 0**（PASS 由独立复核给出，执行方不自行宣布）。报告：[independent-review.md](../../.local/catalog/ux-round-20261113/independent-review.md)（复核人自写 Playwright/psql/构建探针 + 独立克隆库 `…_clone_ux13_ir` + 3016，结束删库停进程；未采信执行方 JSON）。

- 构建全链路一致：`preview-build-ready` / `next-workspace-manifest` / workspace BUILD_ID / `preview-server`（pid 61740、ready=true）/ login 200 均为 **`UgkU0TjyeoLtMreXeu9ff`** + 源码 **`2461321dcc51b54e…`**；`computePreviewSourceSnapshotHash()` 复算一致；manifest 抽 30 个 `src/db/scripts` 文件 sha256 30/30。
- 四处行为独立通过：商品库弹窗/徽标/issues 同 5 项（无旧索引、无「选择采用行」、刷子说明在详情与本页）、总览 `catalog-issues` 5 项且 `[data-category="商品资料"]` 只有 1 条（缺价事项已单列「缺价商品」，B1 撤回、O0 已修）；库存 SKU `6974674957332` 恰好 2 候选、条码/规格一致仅品名差异、单位「个」沿用、克隆保存两仓 512→514；物流 201/204/205/206 旧单 `POKNZX027378` 人工确认记录对应 WM0075/78/79/80、单市场同提示、克隆 201 已计入 + WM10012 仍缺价、未关联 -2、关联修订 +2；商品更新 partial 回执 9/7/29/97/0 与 DB batch counts 一致。
- 新函数只读/幂等/权限正确；现役前后只读计数一致、audit 无新增；`npm test` 889/890（唯一既有 opt6 换行基线）、tsc 仅 BEST 5、改动目录 eslint 0、`git diff --check` 0、HEAD 未变。
- 复核保留的非阻断观察：O1 复核人运行执行方克隆脚本时第 2–4 条回执采集时序（本次已改为等待回执文本变化）；O2 现役证据为 38/38 而非更早的 70/70（仅线索）；O3 单市场中文筛选正常；O4 未逐一处理全部 4 仓；O5 回执数字随克隆批次；O6 历史建议依赖旧单数据；O7 测试基线为既有 opt6。

## 八、证据索引（`.local/catalog/ux-round-20261113/`，不入 Git）

- `verify-live.mjs` / `verify-live.json`（现役只读 38/38）
- `clone-verify.mjs` / `clone-verify.json`（克隆库写入 23/23；`clone-ux13.dump` 为本次克隆备份）
- `build2.log`–`build5.log`、`promote*.log`、`start*.log`（最终 build `UgkU0TjyeoLtMreXeu9ff` / snapshot `2461321dcc51b54e…`）
- `apply-038.json`、`apply-038-commit.json`（只读 RPC 增量验证）
- 截图：`30-home-pending.png`（总览 5 项）、`31-catalog-pending-5.png`（弹窗 5 条）、`32-catalog-pending-page.png`（完整待处理页）、`33-catalog-brush-detail.png`（刷子历史在详情）、`34-inventory-sku-candidates.png`（两款候选与单位）、`35-shipment-excluded-old-ticket.png`（四色号旧单依据）、`36-shipment-market-old-ticket.png`（单市场同一提示）、`40-clone-catalog-duplicates.png`、`41-clone-catalog-cleared.png`（成功提示 + 已清空）、`42-clone-inventory-bound.png`（连续两仓）、`43-clone-shipment-counted.png`（已计入货值）、`44-clone-shipment-price-missing.png`（仍缺进货价）、`45-clone-receipt-partial.png`（部分完成回执）。
