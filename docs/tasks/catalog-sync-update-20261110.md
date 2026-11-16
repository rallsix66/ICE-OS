# 数据同步页精简 + 飞书商品货号更新闭环（2026-11-10）

状态：**独立差异复核 PASS、阻断 0**（[报告](../../.local/catalog/sync-update-20261110/independent-review.md)；PASS 由独立复核给出，执行方不自行宣布）。仅限现役实例 `run-20261026T211500Z-11a22b33`（Web 3011 / PostgreSQL 59345 / DB `iceos_catalog_run_20261026T211500Z_11a22b33`）；最终 BUILD **`aNPAY7De3Y_X5kShi0RnB`**，源码快照 `f2b16a5470df65010622e490042db4bb630a23b6f46f732cb77941587961eb6a`。

## 1. 用户要求与落地

### 1.1 四卡首页
- `/dashboard/sync` 首屏改为四张来源卡，桌面 **2×2**、≤980px 一列：海外库存（BigSeller）/ 国内库存（聚水潭）/ 物流在途（飞书物流表）/ 商品库更新（飞书商品资料）。
- 删除首页长「飞书商品资料」面板（`product-source-sync-section` 不再挂载）和底部「同步记录与来源详情」折叠区；逐仓结果、任务历史、飞书读取记录、原请求核对等旧详情不再铺在首页。
- 商品库更新卡只保留：状态、最近检查、已采用来源时间、待人工确认数量，以及「查看更新」「检查更新」两个按钮。
- 另外三张卡沿用原有业务操作：立即同步/设置、查看国内明细、刷新来源/查看物流在途；原请求待核对恢复面板只在真实存在待核对请求时出现。

### 1.2 商品库更新弹窗
- 固定尺寸沿用 ICE 共用 `detailDialog`（1440×900 下 1060×810，90dvh），共用页签组件。
- 三个页签：
  - **本次更新**：读取**最新待应用快照**（当前 12:10）按现有 `buildPlan` 生成的真实计划；显示 7 款有变化、26 款无变化、101 项本批需核对；变化商品显示名称、货号、字段、原值→新值；无变化只显示数量；来源错误按字段+原因列出（如「生产工厂：公式错误（#REF!） · 93 处」）；底部「确认更新 7 款」。
  - **待人工确认**：只读已登记 open 事项（当前 5 条：4 组同号 + 1 条货号待确认）；显示具体原因、逐行差异、对应动作；同号复用行选择/保存，缺号复用 `assign_product_source_code`；候选货号排在最前。
  - **采用记录**：按批次时间倒序列出历史批次、状态与计数。
- 确认更新后不显示预览数字冒充结果，而是回执里实际写入数：克隆验证为「8 款商品的对应字段已写入；26 款无变化；101 项保留待核对（未计入已登记待办）」。
- 数据口径：预览与「确认更新」绑定同一个 `snapshotToken`，服务端重新按同一快照生成计划；「已采用来源」只显示最近 applied/partial 批次的来源时间；已登记待办（5）与待采用资料中的需核对项（101）分开显示，不相加。

### 1.3 飞书已补货号闭环
- 新增只读投影：`loadPendingSnapshotPlan`（读最新待应用快照并生成计划）、`buildPanelPreview`（本次更新 DTO）、`readPendingSourceCodeCandidates`（按 itemId 返回候选正式货号）、`dedupePendingCodeIssues`（同商品已有 item 级缺号待办时不再重复显示 batch 级候选）。
- 最新 12:10 快照的计划里 `WM0131` 为 `needs_review/MISSING_CODE_CANDIDATE`，`matchedItemId=dfef3f23-c64e-4646-98d0-045efb4e55f2`、`matchedBy=normalizedName`、原商品无货号；投影接到原商品 **item 级**缺号事项，不新建事项、不写库。
- 商品库「待处理」显示：`飞书已补充货号 WM0131，请确认用于这款商品。` / `正式货号：未填写 → WM0131` / 按钮「确认采用此货号」；来源面板与同步弹窗均显示同样差异，**不再出现手填输入框**。
- 确认按钮直接调用现有 `assign_product_source_code`（不要求先采用整批含 `#REF!` 的资料）：保留原商品 UUID、修订历史、3,840 件在途及关联；RPC 内关闭 item 级缺号事项；写入 `catalog_item_code` 与 active binding，后续按正式货号匹配。
- 克隆验证确认后重新生成同一快照计划，`WM0131` 从「缺码候选」转为正常按货号更新（本次变化由 7 款变 8 款），不再产生重复提醒。

## 2. 主要代码改动
- `src/features/catalog/product-source/service.ts`：新增待应用计划/预览/候选货号投影、去重；`getProductSourcePanel` 增加 `preview` 与每条 issue 的 `pendingCodeCandidate`；`applyProductSourceSnapshot` 返回实际 `status/writtenItems/unchanged/review`。
- `src/features/catalog/product-source/panel-types.ts`：扩展 DTO（`preview`、`pendingCodeCandidate`）。
- `src/features/catalog/components/product-library-update.tsx` + `.module.css`：商品库更新卡与三页签弹窗（新文件）。
- `src/features/inventory/components/sync-view.tsx`、`sync-controls.tsx`、`sync-view.module.css`：四卡 2×2、移除首页长面板与底部汇总区、保留设置/恢复入口。
- `src/features/catalog/issues/issue-index.ts`、`module-facts.ts`：来源缺号事实支持 `sourceCodeCandidate`，原因/差异/按钮改为直接采用来源货号；模块事实读取时接候选并按商品去重。
- `src/features/catalog/components/product-source-panel.tsx`：缺号块/候选关系块在已有来源货号时直接显示 `未填写 → 货号`，隐藏输入，按钮「确认采用此货号」。
- `src/app/dashboard/sync/page.tsx`：传入商品库更新卡，移除长面板与 `?run=` 任务详情读取。

## 3. 验证（执行方自验）

| 验证 | 结果 |
|---|---|
| 现役 3011 页面 `verify-live.mjs` | **28/28 PASS**：四卡 2×2、无旧汇总区/长面板、弹窗 1060×810 + 三页签、5 条待人工确认、7/26/101 与真实字段差异、来源错误字段、确认按钮、采用记录、`检查更新` 只更新本地读取状态/不写商品资料或 DB、760 窄屏一列无横向溢出、商品库待处理 WM0131 直接差异、console/pageerror 0、DB 前后一致 |
| 克隆库第二份 Web `clone-web-verify.mjs`（3012 + 克隆库） | **12/12 PASS**：确认采用 WM0131 → revision 4、item 级缺号事项 resolved、UUID/历史/3,840/关联保留、待人工确认 5→4；随后本次更新 8 款、确认更新结果「8 写入/26 无变化/101 待核对」，WM0092 名称按来源更新，生成 101 待核对 |
| 克隆库直接 RPC `clone-assign-verify.mjs` | **13/13 PASS**：同一 UUID、追加 revision、三条历史保留、3,840 与关联保留、binding WM0131 active、无重复商品、request/audit 记录 |
| 定向单测 | `issue-index` **33/33**、`product-source` **75/75** |
| 静态检查 | `tsc` 仅既有 BEST 5；改动文件 eslint **0 error/warning** |
| 数据 | 现役 DB 未变：items **126** / revisions **226** / codes **125** / adoptions **1078** / batches **2** / open **5** / requests 26 / audits 41 / 在途 3,840；12:10 `#REF!` 快照仍未应用 |
| 现场 | BUILD `aNPAY7De3Y_X5kShi0RnB`，源码快照 `f2b16a54…`，ready/manifest/server 一致，3011 login 200 |

页面截图与原始 JSON 在 `.local/catalog/sync-update-20261110/`：`sync-home.png`、`live-modal-changes.png`、`live-modal-history.png`、`live-home-after-check.png`、`live-modal-narrow.png`、`live-catalog-issues.png`、`clone-code-confirmed.png`、`clone-apply-result.png`、`verify-live.json`、`clone-web-verify.json`、`clone-assign-verify.json`、`probe/plan-dump.json`。

## 4. 边界与未做
- **未在现役应用 12:10 批次**：该快照仍含 93 个工厂列 `#REF!`，用户明确「不能要求先采用含 #REF! 的整批资料」；因此补号与「确认更新」写入均在克隆库验证。现役「确认更新」按钮已接线，可由用户按业务决定执行。
- 未在现役点击「确认采用此货号」「选择采用行/保存」「确认更新」；现役 DB 零写入。
- 未改飞书原表、未新增数据库对象/迁移、未修改既有采用/读取/补号机制。
- 旧 `tests/inventory-browser/inventory.browser.pw.ts` 中依赖已删除「同步记录/逐仓结果/任务详情」的断言未重跑；这些详情按本轮要求从首页移除，其覆盖由本轮页面/克隆验证替代。
- 未做权限矩阵、200% 缩放、多日稳定性；未提交/推送/部署，保留此前所有未提交改动。

## 5. 独立差异复核
- **PASS、阻断 0**。报告：`.local/catalog/sync-update-20261110/independent-review.md`。
- 复核人自写只读 Playwright + psql + 构建/代码探针：四卡 2×2、无旧面板/汇总区、弹窗 1060×810 三页签、12:10 计划 7/26/101、真实差异与来源错误、WM0131 两处直接差异/按钮/无 code 输入、待处理页同商品仅 1 行、DB 零写入、BUILD/源码/ready/manifest/server 一致、login 200、单测与 tsc/eslint/diff 一致。补号与确认更新结果仅核对执行方克隆库证据（复核人未点现役写操作）。
- 非阻断观察：
  - **O1** 商品库待处理页仍 7 项（含 2 条刷子历史事项），而同步卡/弹窗/DB open 为 5；本轮“待办 5 与 101 分开”在卡/弹窗满足，页面口径沿用上一轮。
  - **O2** “检查更新”会真实读飞书并更新本地快照/reader-status（不写商品库/DB）；“只读”表述限定为不写商品资料/DB。
  - **O3** “7 款有变化”=1 款 update + 6 款 needs_review 中部分字段可写；“101 项本批需核对”包含这 6 款，7+26+101 非互斥，属计划分类口径。
  - **O4** 待处理页“确认采用此货号”是跳来源面板并聚焦事项的入口，实际提交在来源面板/同步弹窗（均无需先应用整批）；若要求页内一键提交需另加 action。
  - **O5** `clone-web-verify` 检查名“7 written items”与结果“8 款写入”不一致（断言实际验 updated=1）；旧 `tests/inventory-browser/inventory.browser.pw.ts` 依赖已删除的逐仓/任务详情，本轮未重跑，属已知移除范围，建议后续更新/退役。
  - **O6** 弹窗宽度 1060，高度为共用 `detailDialog` 的 90dvh（1440×900 下 810），其他视口随高度变化。
