# 第四轮：飞书工厂资料修好提示 + 物流按所选商品预告（2026-11-12）

状态：**已完成（2026-11-12 收口）、独立差异复核 PASS、阻断 0**（PASS 只能由独立复核给出，执行方不自行宣布；报告 [independent-review.md](../../.local/catalog/ux-round-20261112b/reviewer/independent-review.md)，复核人自建独立克隆库 **21/21**、自写构建/DB/页面探针）。执行方自验：现役 3011 只读 **8/8**，克隆库 **22/22**，`040` 应用回读 **17/17**。仅限现役实例 `run-20261026T211500Z-11a22b33`（3011 / PostgreSQL 59345）；最终 BUILD **`9RzzfQJdK9-030EksOfPl`**（源码快照 `aef3e7f705463f7e…`）。证据 `.local/catalog/ux-round-20261112b/`。

## 一、飞书工厂资料全部修好后的提示

用户要求：上一批还有已登记的工厂待办时，点「检查更新」后页面只显示一条「飞书工厂资料已修好，等待确认更新」，提供「查看更新」；确认采用后消失；必须区分「成功读到零个错误」与「没读到快照」，不能把读取失败显示成已修好。

实现：
- `src/features/catalog/product-source/service.ts` 新增 `readFactoryFormulaErrorState()`：
  - `errors`：最近完整快照里仍有 `fields.factory.state='parse_failed'` 且 reason `SOURCE_FORMULA_ERROR`；
  - `clean`：完整快照读到，但生产工厂列零个公式错误；
  - `unavailable`：没有完整快照 / 快照不完整 / 读取异常。
  旧 `readFactoryFormulaErrorGroup()` 保留但只返回 `errors`，避免把 `unavailable` 当成已修好。
- `src/features/catalog/issues/service.ts` 的 `buildPendingItems` 按三种状态处理：
  - `errors`：仍把「生产工厂」公式错误合并成一条可展开明细（行为不变）；
  - `clean` 且上一批仍有工厂逐条待办：吸收这些逐条事项，只追加一条 `source_formula_fixed`；
  - `unavailable` 且上一批仍有工厂待办：吸收逐条事项，只追加一条 `source_formula_unreadable`（「暂时无法确认」），绝不显示已修好；
  - 没有工厂待办时不制造提示。
- `src/features/catalog/shell/catalog-pending-cards.tsx` 新增两条提示卡片：`catalog-pending-formula-fixed`（标题「飞书工厂资料已修好，等待确认更新」+「查看更新」链接到 `/dashboard/sync?panel=product-update`）与 `catalog-pending-formula-unreadable`（「检查更新」链接到 `/dashboard/sync`）。
- 徽标/总览计数与弹窗、完整待处理页仍取同一份 `buildPendingItems`：修好提示算 1 条，被吸收的逐条工厂事项不重复计数。

## 二、物流沿用规则按当前所选商品预告

用户要求：预告按用户当前选中的商品计算；已关联到所选商品的其他明细计 0 条；换选商品刷新；零条写「其他明细无需改动」；保存回执按实际变更只写本条规则另外影响几条，不混入同次执行的其它规则。

实现：
- 新增 `db/catalog/040_shipment_association_rule_impact.sql`：
  - `catalog.read_shipment_association_rule_preview_for_product(item uuid, product uuid)`：与 027 `shipment_mapping_apply_core` 同一命中条件，但排除 `product_id = 所选商品` 的明细；「将改关联」只统计会改成所选商品的明细。只读、SECURITY DEFINER、`search_path=''`、require_admin、只给 app 执行。
  - `CREATE OR REPLACE catalog.save_shipment_item_association_with_mapping(...)`：同签名、行为不变；返回值新增 `ruleAdoptedCount`，只统计本次 apply 中同来源、同规范品名、同市场、且改成所选商品的明细。原 `adoptedCount`（全部规则合计）保留供诊断，页面不再使用。
  - 不新增表，不改 026/027/028/039 原文件。
- 服务端：`previewShipmentAssociationRule(itemId, productId)` 改调 040 只读函数；`normalizeAssociationResult` 读取 `ruleAdoptedCount`；回执 DTO 字段改为 `ruleAdoptedCount`。
- 前端 `association-editor.tsx`：选中商品后按商品读取预告，换选商品自动重新读取（用「结果属于哪个商品」派生 loading，避免 effect 内同步 setState）；零条文案「其他明细无需改动；以后新到的同市场同品名明细也会自动匹配。」；非零写「其他明细中有 N 条（T 票）会按这条规则改为「货号 · 品名」；以后新到的…也会自动匹配。」
- 回执文案：`已保存「以后同市场同品名沿用」规则；本次按这条规则另外关联 N 条。`，N 取 `ruleAdoptedCount`。

## 三、验证（执行方自验，不是 PASS）

现役 3011 只读 **8/8**，console/pageerror 0：
- 登录 200；待处理 6 条 = 5 原事项 + 1 条 93 个公式错误合并项，无「已修好/读不到」提示；展开 93 行，首行 E3。
- POKNZX027385 的 P04 唇泥当前关联 WM0046；选回 WM0046 预告「其他明细无需改动」；换选 WM0060 预告「1 条（1 票）」。
- 未点保存/确认/检查更新；DB 前后一致：items 126 / revisions 226 / codes 125 / open 5 / batches 2 / mappingConfirmed 512 / associationRevisions 192 / mappings 15 / shipments 71 / shipmentItems 199 / audits 41。

克隆库 **22/22**（自建 `…_clone_ux17` + 3017，假飞书 CLI 只写克隆快照目录）：
- 初始 6 条；真实点「检查更新」读到 E3 修好 → 合并项 93→92；确认采用后数据库登记 92 条工厂待办；仍合并为一条（15 张卡片、0 张逐条工厂卡）。
- 再点「检查更新」读到工厂列全部修好 → 只显示 1 张 `catalog-pending-formula-fixed`（「飞书工厂资料已修好，等待确认更新」），「查看更新」按钮文字正确；移走全部快照后显示 `catalog-pending-formula-unreadable`（含「暂时无法确认」，不含「工厂资料已修好」），恢复快照后重新显示修好提示。
- 从提示「查看更新」→ 打开 `/dashboard/sync?panel=product-update` → 确认更新 → 92 条工厂待办退出、修好提示消失；卡片数 14 = open 15 − 去重候选 1。
- P04 选 WM0046 预告「其他明细无需改动」；换 WM0060 预告 1 条 1 票；再选回 WM0046 保存沿用规则 → 回执「已关联「WM0046 · CHIC PEAK 唇泥 P04- 1.8g」；已计入货值。已保存「以后同市场同品名沿用」规则；本次按这条规则另外关联 0 条。」；另一票 BSPHS 的 product_id/revision/updated_at 不变；同次 apply 里预置的另一条规则实际改了 4 条，关联修订 192→196，但回执仍写 0 条。
- `040` 安装/回读 **17/17**（克隆库与现役均通过）；现役提交后业务计数不变。

静态：`npm test` **906/907**（唯一失败仍是既有 `opt6-production-apply` 换行基线）、`tsc` 仅既有 BEST 5、改动文件 eslint 0、`git diff --check` 0。

## 四、独立复核（2026-11-12）

**PASS、阻断 0**（[报告](../../.local/catalog/ux-round-20261112b/reviewer/independent-review.md)）。复核人自写 Playwright/DB/构建探针，自建独立克隆库 `…_clone_ux17_ir3` + 3020（结束删库停进程），不采信执行方 JSON：
- 构建：BUILD `9RzzfQJdK9-030EksOfPl` / 源码 `aef3e7f705463f7e…`；ready/manifest/workspace BUILD_ID/staging/preview-server 一致；`computePreviewSourceSnapshotHash()` 复算一致；manifest 抽 30 个 src/db/scripts 文件 sha256 30/30；login 200；HEAD `cab7537`。
- 现役只读：6 卡/93 条 E3，无「已修好/无法确认」；P04 选 WM0046 预告 0、换 WM0060 预告 1 条 1 票；未点保存；DB 前后一致、audit 无 10:00 后新增、console 0。
- 自建克隆 **21/21**：93→92→确认采用登记 92 条工厂待办→全部修好只一条提示→移走快照「暂时无法确认」→恢复并确认后 92 条退出、提示消失；P04 回执「另外关联 0 条」，同次其它规则实际改 4 条不混算、BSPHS product_id/revision/updated_at 不变、association 192→196。
- 040：函数口径/权限/幂等/只读 17/17；保存函数 `ruleAdoptedCount` 只算本条。
- 非阻断：O1 自建克隆首次自定义 run root 时确认更新等待超时（改用与脚本一致的 run root 后 21/21，克隆配置敏感，不是产品写入缺陷）；O2 测试数双方均 906/907；O3 现役仍 93 条，两态只在克隆模拟（符合只读边界）；O4 检查更新只写本地 reader 状态、不写业务 DB；O5 040 按所选商品口径是与 027 的预期组合差异。

## 五、边界与已知限制

- 现役零业务写入：未点确认更新、未保存/清除关联、未改飞书原表；`040` 只应用只读预告函数 + 同签名替换既有保存包装（新增返回字段），不新增业务表，现役计数前后一致。
- 克隆库的「全部修好」来自本机假飞书 CLI 数据，不是真实飞书已修；「没读到快照」通过移走快照文件模拟。真实飞书修好与现役采留待业务人员操作。
- 修好提示只覆盖「生产工厂」列；其它字段公式错误仍逐条显示。提示只在商品库待处理/总览/徽标同源清单中出现，不替代数据同步卡的「检查更新/查看更新」按钮。
- 物流预告只处理同来源、同市场、同规范品名；其它规则/人工绑定/人工清除仍按 027 原逻辑，不因本轮扩大。
- 未做移动端专项、权限矩阵、200%、多日稳定性；未提交/推送/部署。
