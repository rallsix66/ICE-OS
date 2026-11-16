# 数据同步：商品库更新回执 + 物流待复核 + 四卡统一（2026-11-11）

状态：**实现完成；现役只读 35/35、克隆库写入 13/13 通过；独立差异复核 PASS、阻断 0**
（[报告](../../.local/catalog/sync-receipt-review-20261111/independent-review.md)；PASS 由独立复核给出）。仅限现役实例
`run-20261026T211500Z-11a22b33`（3011/59345）。最终 BUILD **`rTtqiHYEDumTkYU2iu99X`**，
源码快照 `0c95a3397e13fd5b…`。本轮未提交/推送/部署，未在现役写入任何业务数据。

## 一、商品库更新回执

- `applyProductSourceSnapshot` 不再用预览计划拼页面结果，改为读取数据库回执
  `status`、`counts`、`results[].itemRevision`：
  - `counts` 用于「无变化 / 待核对 / 失败」；`actions=update/create` 或
    `needs_review` 且已产生修订的 `results` 计入「写入」；
  - 回执缺少 `counts` 时页面只显示结果说明，不补成「更新完成 0 款」。
- 页面按实际状态显示标题与语气：`本批部分完成` / `本批未改商品资料` / `重复采用` /
  `旧快照已拒绝` / `已核对原请求` / `本次更新完成`；回执里的状态前缀与标题不重复。
- 采用后实际结果提示「需核对事项已登记到商品库『待处理』」；预览只说明「尚未登记为
  待处理事项，确认更新后才登记」。删除「未计入已登记待办」错误文案。
- 克隆库实测：12:10 批次回执 `partial`，页面 `写入 7 款；无变化 26 款；待核对 101 款；
  失败 0 款`，与 DB `updated=1 / unchanged=26 / needsReview=101 / failed=0` 及新增
  7 条 item_revision、open issue 5→108 一致；重复采用不新增批次、不重复修订。
  `旧快照已拒绝` 与 `已核对原请求` 为回执分支（缺数量时只显示说明），本轮未在页面
  点出对应真实样本，按代码路径与克隆库回执结构核对。

## 二、物流在途待复核

- 同步卡信息栏改为「待复核」+ 可点击「N 项」；物流在途页工具栏保留「待复核 N 项」。
- `ShipmentGroupingReviewEntry` 弹窗 `createPortal` 到 `body`，`position: fixed; inset: 0`
  相对整个浏览器视口居中；遮罩覆盖整页；标题与关闭按钮固定在弹窗头部，正文独立滚动
  （实测 body 684 高 / scrollHeight 983，滚动后 header y 不变）。
- 同步页与物流在途页共用同一组件；关闭写回打开前滚动位置、把焦点还给入口，不改 URL。
- 每条复核第一句由真实 evidence 生成：
  `越南 · 采购单 POKNZX027485（运单 baisu1029-250box、261103572394） · 上次 2 票，本次 1 票。`
  下方上次/本次的单号、市场、运单/采购单、商品与数量：桌面两列并排，≤900px 上下排列。
- 保留原四个决定与「恢复按飞书判断」；保存后显示实际采用的决定（例如
  `已保存决定：仍然分开；待复核数量已刷新。`），并立即从列表/数量移除该项；若
  `SHIPMENT_GROUPING_REINGEST_FAILED`，同时说明「决定已保存」与「货票分组更新失败」，
  提示不要重复确认。

## 三、四卡统一

- 海外库存 / 国内库存 / 物流在途 / 商品库更新共用标题、状态徽标、三字段信息栏与底部
  操作区；信息栏内待处理数量统一为可点击的「N 项」。
- 底部顺序与样式：
  - 海外库存：`立即同步`（主）+ `同步设置`（次）
  - 国内库存：`查看库存明细`（次，沿用 `/dashboard/inventory?source=domestic`）
  - 物流在途：`立即同步`（主）+ `查看物流在途`（次）
  - 商品库更新：`检查更新`（主，只读飞书）+ `查看更新`（次；真正写入仍叫「确认更新」）
- 同一排按钮底边实测对齐：第一行 321.14 = 321.14，第二行 523.92 = 523.92；按钮高度
  全部 34px、字号 13px、图标距按钮左缘 14px 一致。国内库存原文件日期/条数移入
  「最近成功」小字，避免按钮下方多一行破坏对齐。
- 复核补修：国内库存「待处理」原为 `—`，不符合四卡统一；已改为可点击 `0 项`，链接到
  既有 `/dashboard/inventory?source=domestic`（`sync-source-domestic-pending-link`）。
  国内库存没有待处理同步事项，0 项只表示待处理数，入口仍是原有明细。

## 四、验证

- 现役 3011 只读验收：**35/35 PASS**，console/pageerror 0；四卡文案/顺序/主次样式、
  四卡待处理「N 项」（国内为可点击 0 项并指向既有明细）、按钮几何、弹窗遮罩=视口
  （1440×900）、modal 居中偏差 0、正文滚动、桌面并排、760 窄屏上下、关闭后 URL/滚动/焦点、
  物流在途页同一入口；现役 DB 前后完全一致：items 126 / revisions 226 / codes 125 /
  adoptions 1078 / batches 2 / openIssues 5 / requests 26 / audits 41 /
  pendingReviews 2 / activeOverrides 0。
- 克隆库第二份 Web（3012，clone 库 `…_clone_receipt_review`）：**13/13 PASS**：
  - 部分完成回执 `写入 7 / 无变化 26 / 待核对 101 / 失败 0`，与 DB 回执、7 条新修订、
    open issue 5→108 一致；
  - 重复采用显示 `重复采用` 与原始计数，未新增批次/修订；
  - 物流复核保存 `keep_separate`：页面提示实际决定，DB `resolved / keep_separate`、
    active override 1 条、pending 2→1，卡片显示「1 项」；console 0。
- 单元测试：`grouping-review-summary` 4/4；标准套件 **842/843**（唯一失败为既有
  `opt6-production-apply` 换行基线）；`tsc` 仅既有 BEST 5；改动文件 eslint 0；
  `git diff --check` 0。
- 构建：BUILD `rTtqiHYEDumTkYU2iu99X`；`preview-build-ready.json`、manifest、
  `BUILD_ID` 三处一致；源码快照 `0c95a3397e13fd5b…`；3011 login 200。
- 复用上一轮已通过的四卡和 WM0131 补号证据：[catalog-sync-update-20261110.md](catalog-sync-update-20261110.md)，
  本轮不重复执行补号/采用整批。
- **独立差异复核 PASS、阻断 0**（2026-11-11，[报告](../../.local/catalog/sync-receipt-review-20261111/independent-review.md)）：
  复核人自写只读 Playwright/psql/构建探针，确认四卡（含国内 0 项可点击并实际导航到国内明细）、按钮
  34px/13px/图标左距 14px/同排底边 0px 差、弹窗 portal/视口遮罩/居中/header 固定/body 滚动/桌面并排/
  760 上下、两处同一弹窗、关闭焦点与 URL、商品库回执取 DB 且缺数量不补 0、预览“尚未登记”、
  “未计入已登记待办”已清除、DB 零写入、BUILD/源码/ready/manifest/staging/server 一致、login 200、
  单测 842/843、tsc BEST 5、eslint 0、diff 0。首轮 B1（国内「待处理 —」）已修复并复验闭环；
  O3（写入回退）已按建议改为无 results 时显示「—」。保留非阻断 O1/O2/O4（见下）。

## 五、边界与非阻断

- **12:10 快照仍未在现役应用**；现役未点确认更新、未保存物流决定、未补号，DB 零写入；
  物流拆合决定与商品货号留给用户确认。
- 未改飞书原表、未新增 DB 对象/迁移、未跑全仓浏览器全套、未提交/推送/部署。
- 非阻断：
  1. `旧快照已拒绝` / `已核对原请求` 分支未在页面点出真实样本（克隆库只实测部分完成与
     重复采用；两者均只在回执异常时出现）。
  2. 现役 1440×900 页面不可滚动，关闭恢复滚动位置实测为 0；焦点与 URL 恢复已实测，
     760 窄屏弹窗位置/上下排列已实测。
  3. 海外库存「待处理 219 项」沿用既有口径（含排除仓），不是本轮新增。
  4. 商品库回执「写入 7」= 1 条 update + 6 条已有部分字段写入的 needs_review；
     DB `updated` 仍为 1、`needsReview` 101，两者口径不同但都来自实际回执。若回执本身
     没有 `results` 明细，页面显示「写入 —」而不是用 created+updated 估算，避免漏算部分写入。
  5. 复核报告 O5 提到 docs 未更新；本轮已同步 `current-state`、`current-task`、`AGENTS.md`、
     `README.md`、`docs/README.md` 与本任务文档到最终 BUILD/35/35/PASS 口径。

## 六、证据与截图

- 现役：`.local/catalog/sync-receipt-review-20261111/verify-live.json`、`sync-home.png`、
  `sync-review-modal.png`、`sync-review-modal-narrow.png`、`in-transit-review-modal.png`。
- 克隆库：`.local/catalog/sync-receipt-review-20261111/clone-verify.json`、`clone-web.log`。
- 复核报告：`.local/catalog/sync-receipt-review-20261111/independent-review.md`（完成后补）。
