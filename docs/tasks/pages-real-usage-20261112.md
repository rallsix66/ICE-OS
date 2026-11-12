# 五页按实际用法改造（经营总览 / 商品库 / 商品库存 / 物流在途 / 数据同步 + 共用交互）—— 2026-11-12

状态：**独立差异复核 PASS、阻断 0**（PASS 只能由独立复核给出，执行方不自行宣布；报告 [independent-review.md](../../.local/catalog/ux-round-20261112/independent-review.md)，复核人自写页面探针 + 独立克隆库 + 独立耗时探针）。
仅限本机现役实例 `run-20261026T211500Z-11a22b33`（Web 3011 / PostgreSQL 127.0.0.1:59345）。
最终 BUILD **`HBBupk-Uh7uTDT1jri-Ub`**，源码快照 `ba3d46bd7768c106`。

- 现役 3011 只读验收：**70/70 PASS**（`.local/catalog/ux-round-20261112/verify-live.json`；DB 前后完全一致、console/pageerror 0）。
- 克隆库真实写入：**29/29 PASS**（同目录 `clone-verify.json`；三条业务写入 + 一条受控复核探针）。
- 切换耗时（同筛选 `source=overseas`，点「商品汇总」到首行可见，5 次中位数）：旧构建 `51fUvaq…` **1246ms** → 新构建 **552ms**；待处理徽标改为首屏后异步读取（中位 147ms 出现）。
- 回归：`npm test` **883/884**（唯一既有 `opt6-production-apply` 换行基线）；`tsc` 仅既有 BEST 5；改动目录 eslint 0；`git diff --check` 仅 1 条既有的 CSS 文件末尾空行提示（`inventory.module.css` 与构建快照一致，非本轮新增、不含功能改动）。

## 一、经营范围

按用户「用户看得懂问题、在当前页面就能办完」的交付标准，改五个页面与共用交互，不新增数据库对象/迁移，不改飞书，不写现役业务数据。

## 二、经营总览（`/dashboard`、新增 `/dashboard/valuation`）

- 去掉右上角「待处理」入口与第 4 张「待处理 N 类」统计卡；`HomePendingEntry` 停用删除。
- 删除各卡重复小字：三张统计卡的 statMeta、三阶段解释段 `stageNote`、各面板标题下的重复说明、`N 类` 徽标、底部来源说明段 `footerNote`。
- 保留会影响判断的信息：三阶段数据时间条（含「三阶段不直接相加」）、国内/在途读取失败原因、海外「含 N 款已知小计、合计待核对」、成本读取失败状态、商品表「—」不是 0 的说明、市场待确认不猜归属、待处理区底部同步状态行。
- 「估值口径与未计入说明」整块移出首页 → 新页面 `/dashboard/valuation`（复用同一 `getBusinessOverviewData()` 与同一份聚合，内容逐项保留，带返回经营总览）；首页底部只留文字链接。
- 首页唯一一处「需要处理」，每类事项用有边框的具体动作按钮（`surface.button`）：
  - 商品资料待处理 →「查看商品资料」→ `/dashboard/catalog?pending=open`
  - 库存待对应 →「查看待绑定商品」→ `/dashboard/inventory?view=warehouse&source=overseas&pending=open`；数量与商品库存页一致（页面实测同为 **141**），删除「同步页 219 条 / 含已排除仓」旧提示
  - 物流待复核 →「复核货票」→ 区块内当场打开与物流在途页相同的复核弹窗（读取失败也保留按钮）
  - 在途未计入 →「查看未计入货票」→ `/dashboard/in-transit?view=value`
  - 缺价商品 →「查看缺价商品」→ 区块内**就地展开**逐款清单（货号 · 品名、已知数量、查看入口），不跳转不新开页；现役 2 款（WM10012 9,360 件、烟酰胺 3,840 件），款数与按钮数字同源
  - 同步状态类 →「查看同步」→ `/dashboard/sync`
- 各项仍显示自己的数量，不做跨类相加；读取失败不补 0。
- 库存待对应数量改用商品汇总同一读取返回的 `unmappedOverseasRows`（同一 022 读模型、同一参与仓范围）：首页不再多跑一次 5 页待绑定队列（实测约 1s 会把首页从 ~1.1s 拖到 ~2.4s）；与商品库存页徽标实测同值，验收脚本会比对两页数字。

## 三、商品库（`/dashboard/catalog` → 待处理弹窗）

- 弹窗条目重做为「当场办完」：每条先显示 **品名 · 货号 · 规格**；同号多行直接问「飞书有两份这款商品的资料，以后更新用哪份？」，两个选项卡写明来源行号与**真实字段值**（如 `商品条码未填写` / `商品条码 757577407380`）；选中后「确认使用这份资料」→ 现有 `decideDuplicateSourceRow`。
- 成功后就地显示结果一句（服务端 message）、该条从清单移除、徽标 -1、`router.refresh()` 拉服务端投影、焦点移到下一款；失败显示服务端原因并保留已选选项卡可重试（同一 requestId 幂等）。
- 飞书已补货号的 WM0131 商品在同一弹窗显示「飞书已补充货号 WM0131」+「确认采用此货号」→ 现有 `assignProductSourceCode`（带 `expectedRevision`）。
- 刷子历史（仅查看）不再进弹窗与徽标：徽标 = 可操作事项数 **5**（4 同号 + 1 缺码），5 条与弹窗行数一致；`/dashboard/catalog/issues` 仍 7 项并注明「另有 2 条刷子历史仅在商品详情查看」，对应商品详情补一句说明。
- 删除「选择采用行」字样与跳旧来源面板/来源页的链接；只保留只读「在商品详情查看」。
- 支持 `/dashboard/catalog?pending=open` 首屏自动打开一次（不新增历史记录，`replaceState` 清参）。

## 四、商品库存（`/dashboard/inventory`）

- **切换提速**：页面首屏不再同步读 141 行待绑定清单；徽标数量改为客户端挂载后经 server action 异步读取（与弹窗/经营总览同一队列口径，失败「读取失败」不补 0）；完整清单只在打开弹窗时懒加载。
  - 实测（5 次中位数）：点「商品汇总」到首行可见 旧构建 1246ms → **552ms**；徽标数量 147ms 后出现。
- **待处理弹窗按来源 SKU 分组**：组头显示来源 SKU、涉及仓（仓名 + 中文市场）、每仓最近出现时间；展开后优先展示「同 SKU 其他仓已绑定商品」（货号/品名/仓名），再给本批建议与商品搜索；多候选时逐条列出条码/规格/单位并标出「与其他候选不同」。
- **弹窗内直接绑定**：选商品 → 勾选本次要绑定的仓（默认当前仓，可多选同 SKU 仓）→ 折叠「补充信息」填单位与理由（必填、无默认值）→「保存绑定」；复用 `registerOriginalRequest` + `confirmInventoryMappingsAction`（幂等 requestId、pending 写锁、原请求核对不变）。成功后**弹窗顶部固定显示结果**（`已提交 N 条对应… 本次保存 N 个仓；还剩 X 条可继续处理`），本组行从清单移除、徽标下调，可继续处理下一项；失败保留选择可重试。
- **市场中文化**：商品汇总市场表头/列、筛选 chip、行详情、待处理弹窗统一中文（泰国/越南/菲律宾/马来西亚/印度尼西亚/新加坡/柬埔寨/市场待确认），筛选 value 不变只改显示。
- 详情/弹窗滚动锁改用共用 `lockPageScroll()`。支持 `?pending=open` 自动打开。

## 五、物流在途（`/dashboard/in-transit`）

- 「货票列表｜货值汇总」改为明确选中态的页签：`role=tab/tablist`、`aria-selected`、`aria-controls`、仅选中项可 Tab、方向键/Home/End 切换；选中白底+边框+600 字重+阴影，未选中透明灰字，均有焦点环。
- 货值汇总按市场展示，点市场在**当前表格内就地展开**（不跳转、不整页刷新），可同时展开多个；展开区显示该市场在途货值/票/明细/未计入、商品构成聚合行与未计入明细；展开状态存 `sessionStorage`，打开/关闭货票详情与数据刷新后仍在。
- 「未计入 N 条」是按钮，点开列出全部市场明细（原因=未关联/数量待核/缺单价/待复核、市场、货票、来源商品与已关联商品、发货量/累计到货/剩余在途、打开货票）；数量与列表同源同一次读取（现役 ~35 条，随数据更新）。
- 未关联明细当场关联：行内「关联商品」打开既有编辑器（搜索复用 `searchProductsForShipment`），上方给「同市场同品名历史确认」建议按钮；保存前必须选「**只用于本票**」（默认）或「**以后同市场同品名也沿用**」（`rememberMapping`，附业务化说明）；新增 `associateShipmentItemFromValue` 先只读 detail 当前 revision 再复用既有写入口，不新增写函数/SQL。
- 打开原票关闭后回到货值汇总、市场展开与滚动位置；**快速关闭（URL 未提交）不再退回上一页**（`router.replace` + in-flight push 收回）。

## 六、数据同步（`/dashboard/sync`）

- 四张来源卡移除「待处理」（海外/国内/物流/商品资料），卡片只保留来源状态与来源操作：立即同步、查看库存明细、查看物流在途、检查更新/查看更新；页头不再有独立待处理入口；删除 `sync-card-pending`、`sync-shipment-pending` 组件与相应读取（`getInventoryPendingBindings`/`getCatalogIssuePendingPreview` 不再进首页）。
- 待处理统一回到各自业务页处理，避免同一事项两套入口。

## 七、共用交互

- 新增 `src/ui/ice-v4/scroll-lock.ts`：打开弹窗/抽屉时锁滚动，**用 `padding-right` 补上 Windows 纵向滚动条宽度**（避免内容区变宽导致背景横移），支持嵌套，关闭恢复原 `scrollX/scrollY`。
- 接入：统一「待处理」弹窗、数据同步设置弹窗、商品库存详情、商品库更新弹窗、物流详情抽屉、物流复核弹窗。
- 验收（1100×640，页面实际出现 17px 纵向滚动条）：打开商品库存待处理弹窗前后的 h1 与按钮 x 偏差 **0px**，关闭后 `scrollY` 恢复（15 → 15）。
- 操作按钮统一有边框/底色、名称明确（查看商品资料/查看待绑定商品/复核货票/查看未计入货票/查看缺价商品/绑定商品/保存绑定/确认使用这份资料/确认采用此货号/打开货票等）；商品名、市场名、数字保持正文样式。

## 八、验收与证据（执行方自验，不是 PASS）

- 现役 3011 只读 **70/70**：`node .local/catalog/ux-round-20261112/verify-live.mjs`（脚本不点任何保存）。覆盖：总览去掉入口/折叠块、需要处理 6 类按钮文案与目标、缺价就地 2 款、估值页可开；商品库徽标 5=弹窗 5、真实差异、WM0131、无刷子/无旧链接、Esc 焦点、`?pending=open` 不增历史；商品库存徽标 141、74 组、中文市场、字段与按钮、`?pending=open`；物流页签选中态/键盘、未计入可点开且条数一致、未关联有搜索与「只用于本票/沿用」、市场就地展开、开票返回位置与快速关闭；四卡无待处理且来源操作仍在；滚动条与不横移；耗时对比；DB 前后一致；console/pageerror 0。
- 克隆库写入 **29/29**（`clone-verify.mjs`，新建 clone DB + 3012 第二份 Web，结束删库停进程）：
  1) 商品库：WM0069 选「来源第 127 行 商品条码 757577407380」→「确认使用这份资料」→ 结果句「已保存同号多行选择：以来源第 127 行为准…」、该条消失、徽标 5→4、DB open issue 5→4、duplicate decision active/127、修订仍 226；
  2) 商品库存：搜索该 SKU 选候选（按候选单位「个」填）→ 勾当前仓 → 填单位/理由 → 保存 → 弹窗顶部「…本次保存 1 个仓；还剩 140 条可继续处理。」、徽标 141→140、DB `inventory_sku_mapping` confirmed 512→513，同组其他仓仍在；
  3) 物流在途：未计入→选一条未关联明细→关联商品→「只用于本票」→保存 →「已保存关联；该条已移入已计入…」、未关联 31→30、未计入 35→34、DB `shipment_item_association_revision` 184→185；
  4) 受控探针：克隆库把一条历史复核改回 pending → 总览出现「复核货票」→ 当场打开与在途页相同的 `shipment-review-modal`（现役当前 pending 0，故只在复刻库做此探针）。
- 耗时对比：`timing-probe.mjs` 自起旧构建（3013，`next-build-a198a5fa38f9d7c7`）与新构建（3011）各 5 次；结果见上。
- DB（现役，只读前后一致）：items 126 / revisions 226 / codes 125 / adoptions 1078 / batches 2 / openIssues 5 / requests 26 / audits 41 / pendingReviews 0 / activeOverrides 1 / mappingConfirmed 512 / shipments 66 / shipmentItems 190 / inventoryCurrent 512 / 历史 12:10 含 93 处 `#REF!` 快照仍未应用。验收窗口之后 15:45:22 飞书物流定时 worker 外部新增 4 票/4 明细（shipments 66→70、shipmentItems 190→194，计划任务，非本轮/复核写入）。
- 外部变化观察：现役 `shipment_grouping_override` 有一条 2026-11-11 13:43:18 创建、两条 review 同时 resolved，导致本轮基线 pendingReviews 0 / activeOverrides 1（上一轮登记 2 / 0）。执行方判断为业务人员当日在页面确认（本轮全部操作为只读，`audit_event` 最新仍为 2026-11-10），不由本轮写入；独立复核需核对。

## 九、边界（本轮未做）

- 现役未点任何确认/保存/绑定/关联（业务人员确认留给他们）；未应用 12:10 批次；未改飞书；未新增 DB 对象/迁移；未提交/推送/部署。
- 「同市场同品名历史确认建议」只读当前明细里已关联的同市场同品名商品（`shipment_product_mapping` 应用角色无读权限，未新增只读 RPC），现役样本中 31 条未关联里 9 条有建议，其余为空态；未扩大为历史规则库。
- 获批单条绑定/关联后要等下一次完整同步/读取批次才进入合计（既有口径，未改）。
- 未做权限矩阵、200% 缩放、多日稳定性；表内行级「详情/货票/库存/在途」仍是文字链接（按导航处理），主操作均为有边框按钮。

## 十、独立差异复核（PASS、阻断 0）

复核人（`independent-review`）自写只读 Playwright（1440×900 / 1100×640）、自建独立克隆库 + 独立第二份 Web（3014）做三条写入、自起旧构建（3015）做耗时复测，不采信执行方结论。裁定 **PASS、阻断 0**，报告 [independent-review.md](../../.local/catalog/ux-round-20261112/independent-review.md)。

独立取证要点：
- 构建：ready `HBBupk-Uh7uTDT1jri-Ub` / 源码 `ba3d46bd7768c106…`；workspace BUILD_ID / staging / manifest / preview-server（pid 31996、ready）一致；manifest **385 个 `src` 文件与工作树逐个 sha256，0 mismatch / 0 missing**；login 200；HEAD 仍 `cab7537`。
- 页面：总览无 `overview-pending-open`/`home-valuation`、估值页可开、唯一「需要处理」动作与目标正确（商品资料→catalog?pending=open、库存 141→inventory…pending=open、未计入 35→in-transit?view=value、缺价 2 款就地展开）、页面无「219」；商品库徽标 5=弹窗 5、WM0069 两选项真实值、未选 disabled/选中 enabled、WM0131 直接补号、无刷子/无「选择采用行」/无旧 sources 链接、Esc 焦点回、`?pending=open` 自动打开并清参；库存徽标 141、74 组、组头中文市场、展开后可选商品/勾仓/空单位理由/保存、`?pending=open`、商品汇总表头中文；物流页签 aria/样式/方向键、未计入 35 条与列表一致、市场就地展开 URL 不变、关联编辑器选品后出现「只用于本票/沿革」、开票关闭回 `view=value` 且展开与 scrollY 保持；四卡无待处理且来源操作仍在；1100×640 实测 17px 滚动条、开关弹窗 h1/按钮 x 232→232（0 偏移）、关闭 scrollY 15→15。
- 克隆库（复核人自建独立库 + 3014）**29/29 PASS**：同三条写入与 DB 断言一致（open issue 5→4、decision active/127、revisions 不变；mapping 512→513、徽标 141→140；未关联 31→30、未计入 35→34、association revision +1）。
- 耗时：复核人自测（旧 3015 / 新 3011，各 5 次中位）旧 **1254ms** → 新 **613ms**，徽标 **290ms** 异步出现；方向与执行方一致（执行方 1246→552/147），绝对值受环境差异影响。
- 现役只读：产品/批次/open issue/adoption/mapping 未变，15:00 后无新 `audit_event`；12:10 未应用；console/pageerror 0；`npm test` 883/884、tsc BEST 5、改动目录 eslint 0、diff 仅 1 条既有 CSS EOF 空行。
- 非阻断观察：O1 现役飞书物流定时 worker 在 15:45:22 新增 4 票/4 明细（`shipments 66→70`、`shipmentItems 190→194`，外部计划任务，非本轮/复核写入；页面「下次同步 15:45」）；O2 耗时绝对值差异；O3 既有 CSS EOF 空行；O4 总览「复核货票/查看同步」按数据条件出现（现役 pending 0、同步健康）；O5 物流历史建议仅部分未关联项有数据；O6 文档已更新至 HBBupk；O7 `pendingReviews 0 / activeOverrides 1` 为 13:43 业务操作、分组 RPC 不写 audit。
- 复核未做：未点现役任何保存/确认/绑定/关联；未逐个展开 74 组；权限矩阵/200%/多日稳定性未做。
