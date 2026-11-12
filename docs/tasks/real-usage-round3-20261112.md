# 按实际用法补齐第三轮：飞书字段报错定位 + 物流关联实际影响（2026-11-12）

现役实例 `run-20261026T211500Z-11a22b33`（Web 3011 / PostgreSQL 59345）。本轮只改两个日常操作路径，写操作只在克隆库；现役未点保存/确认/绑定/关联，未改飞书原表。

- 最终 BUILD：**`VzaMvuTYTxxKfHGyko6fA`**，源码快照 `00861f446a8c42160d7c1af4c2c6a700780ae6fee82d282c47b9e1454760d8f9`（BUILD_ID / preview-server / ready / manifest 一致，login 200）。
- 执行方自验：现役只读 **11/11 PASS**；克隆库真实写入 **16/16 PASS**、console/pageerror 0。
- **独立差异复核 PASS、阻断 0**（PASS 由独立复核给出，执行方不自行宣布；报告 [independent-review.md](../../.local/catalog/ux-round-20261114/independent-review.md)；复核人自写只读 Playwright/psql/构建探针，自建克隆库 `…_clone_ux14_ir2` + 3018，结束删库停进程；16/16，构建/源码 30/30 一致，现役只读前后一致）。
- 证据：`.local/catalog/ux-round-20261114/`（`verify-live.json`、`clone-verify.json`、`feishu-e3-check.json`（在 `.local/catalog/feishu-error-20261112/`）、截图 50–62、apply-039*、`independent-review.md`）。

## 一、飞书字段报错：先核对 E3，再决定修读取还是修原表

用户要求先用 `LS101295` 海茴香焕肤水核对飞书 `E3` 的显示值与系统读到的值。

用本机 `lark-cli` 只读读取（证据 `.local/catalog/feishu-error-20261112/raw/`）：

| 读取方式 | `E3` 返回值 |
|---|---|
| `FormattedValue`（界面显示值） | `#REF!` |
| `UnformattedValue` | `#REF!` |
| `Formula` | `=VLOOKUP(G3,'供应商信息'!A:C,3,0)` |
| `ToString` | `VLOOKUP(G3,'供应商信息'!A:C,3,0)` |

`sheets +info` 显示该文档只有 `Sheet1`（`33bab4`），不存在 `供应商信息` 工作表；直接读 `供应商信息!A1:C5` 返回 `[90215] not found sheetId`。结论：**原表 E3 本身就是 `#REF!`，不是系统读取错误**。因此本轮不修改读取器，改为在待处理里把同批「生产工厂」公式错误合并展示。

同批快照事实：133 个业务行中 E 列 93 个公式错误、39 个空、1 个手填值；`LS101295` 在第 3 行，`E3=#REF!`。

## 二、待处理：93 条同类公式错误合并成一条

实现：
- `product-source/service.ts` 新增只读 `readFactoryFormulaErrorGroup()` 与纯函数 `collectFactoryFormulaErrors()`：从**最近一次完整读取快照**扫描 `isBusinessRow && fields.factory.state='parse_failed' && reason='SOURCE_FORMULA_ERROR'`；只取「生产工厂」列，返回 `count / capturedAtDisplay / rows[{iceCode,nameCn,cell,error}]`，`cell=E<row>`。无错误返回 `null`，不伪造成 0。
- `issues/service.ts` 把它追加为一条 `source_formula_errors` 待处理项（`catalog-pending-formula`）：标题 `飞书原表「生产工厂」 · 93 个公式错误（#REF!）`，原因写清「这批更新里这些商品的工厂资料不会被采用；请先在原表修好，再回数据同步「检查更新 → 确认更新」」，展开为 93 行表格（货号/品名/单元格/错误原文），并提供「打开飞书原表」外链（新窗口、noreferrer）。
- 与徽标/总览同一口径：`getCatalogIssuePendingPreview()` 与 `getCatalogIssueToolbarModel()` 都读同一份快照分组，徽标/总览由 5 变 **6**（5 条原事项 + 1 条合并项）；弹窗、完整待处理页、总览一致。
- 去重：确认更新后，数据库会为同一批错误登记逐条 `formula_error` 来源事项；待处理投影会把这些**生产工厂公式错误**吸收进合并项（按 `issue.detail.fieldLabels` 含「生产工厂」判断），不再出现 92 条重复卡片。其它字段的公式错误仍逐条保留。
- 流程：原表修好一行 → 「检查更新」生成新快照 → 合并项按新快照重算为 92 条，E3 从明细消失，其余保留；「确认更新」按新计划写入（本轮克隆库部分完成：已写入 8 款，其中 6 款仍字段待核对；无变化 26；待核对 100；失败 0），合并项仍为 92 条。

克隆库实测（模拟 E3 修好，不改飞书原表）：
- 初始 93 条，首行 `LS101295 / E3 / #REF!`；放入「E3 已修好」的模拟新快照后 → 92 条、E3 消失、E4 起保留、清单仍 6 条。
- 点「确认更新」后：批次 2→3，`item_revision` 226→234（8 款写入），`open` 5→107（其中 92 条工厂公式事项被合并项吸收），待处理卡片 15 条 = 数据库 open 107 − 工厂公式 92 − 已去重缺码候选 1 + 合并项 1；页面上 `data-pending-kind="formula_error"` 的重复卡片为 **0**。

## 三、物流关联：按钮和回执说明实际影响

新增只读 DB 函数 `catalog.read_shipment_association_rule_preview(uuid)`（`db/catalog/039_shipment_association_rule_preview.sql`），**精确复刻 027 `shipment_mapping_apply_core` 的命中条件**：同来源、同规范品名、同市场、最近一次成功快照、排除自身，并区分「未关联」与「按品名自动匹配、保存规则后会改关联」两类。SECURITY DEFINER + `search_path=''` + `require_admin`，只读、PUBLIC 不可执行、app 角色可执行，不新增表、不写业务数据。

页面行为：
- 选择商品后、选沿用规则前，`shipment-assoc-rule-preview` 写清：「当前有 3 条同市场同品名明细（3 票）会按这条规则匹配；以后新到的同市场同品名明细也会自动匹配。」（0 条/市场未提供分别有对应文案）。
- 保存回执（`adoptedCount` 取数据库实际回执）：
  - 关联：`已关联「WM0094 · ICE LERSKIN 7% 乙醇酸爽肤水(泰国特供版)」；已计入货值。已保存「以后同市场同品名沿用」规则；本次按规则另外关联 3 条。`
  - 未保存规则：`未保存沿用规则（市场未提供，未保存通用对应）。`；只本票：`只用于本票，未保存沿用规则。`
- 清除关联：固定 `已清除本条明细的商品关联。`；克隆库该条 `product_id=null`、`association_status='none'`、`association_method='manual_cleared'`，规则命中预告不再包含它。

克隆库实测（泰国同一组 4 条明细/4 票）：
- 保存前预告 3 条（3 票）；保存后本组 4 条全部关联、映射 15→16、关联修订 192→196（+4）。
- 清除其中一条：回执为固定句；未关联 39→36、关联修订 192→197（+5）、映射 16；该条 `manual_cleared`，再次打开其它同组明细的编辑器显示「当前没有其他同市场同品名明细」。

## 四、验证与边界

| 项 | 结果 |
|---|---|
| 现役 3011 只读 | **11/11 PASS**（总览 6 项 = 商品库徽标 6 = 弹窗 6 张；合并项 93 条、展开 E3/LS101295/#REF!、外链正确；检查更新后仍 93；物流预告 3 条/3 票；未点保存；DB 业务计数前后一致；console 0） |
| 克隆库写入 | **16/16 PASS**（E3 修好 93→92→E3 消失；确认更新回执/去重；规则预告/保存回执/清除回执/DB 落库/清除后不再命中；console 0） |
| 单测 | 定向：issues 相关 54、shipment 202、model 61 等全部通过 |
| 类型/风格 | `tsc` 仅既有 BEST 5；改动文件 eslint 0；`git diff --check` 0 |
| 构建 | BUILD `VzaMvuTYTxxKfHGyko6fA`；源码快照 `00861f446a8c4216…`；3011 login 200 |
| 独立差异复核 | **PASS、阻断 0**；复核人自建克隆库 `…_clone_ux14_ir2` + 3018（16/16），构建/源码 30/30 一致，现役只读前后一致；报告 `.local/catalog/ux-round-20261114/independent-review.md` |

边界与订正：
- **写操作只在克隆库**；现役未点确认更新、保存关联、清除关联、绑定、补号，DB 业务计数前后一致（items 126 / revisions 226 / codes 125 / open 5 / mappingConfirmed 512 / associationRevisions 192 / audits 41 / shipments 71 / items 199 / mappings 15）。
- **未改飞书原表**；E3 修好是克隆库模拟快照，现役「检查更新」只读读取后仍为 93 条（内容 unchanged）。
- **038 订正**：`db/catalog/038_shipment_association_history.sql` 是**已应用的只读函数迁移**（只新增一个 SECURITY DEFINER 只读函数），没有新增业务表；本轮 039 同理，只新增一个只读函数，没有新增业务表、未改 026/027/028。
- **13:43 物流分组决定订正**：只能确认该决定记录在管理员账户名下（`decided_by`/审计为启用中管理员），现有记录**不能确定具体操作人**；不写成某位业务人员操作。
- 外部变化：物流定时读取每 10 分钟继续写入新快照（本轮 039 commit 时 `shipment_source_snapshot` 1342→1343 为后台读取，非 039 写入；shipments/items/association 未变）；库存 worker 继续按既有计划运行。
- 已知限制：公式错误只合并「生产工厂」列，其它列公式错误仍逐条；合并项只读，原表修好依赖下一次成功读取生成新快照；克隆库为模拟快照，不代表已修真实飞书原表；未做移动端单独调优、权限矩阵、200% 缩放、多日稳定性。

## 五、证据与命令

- 飞书 E3：`.local/catalog/feishu-error-20261112/feishu-e3-check.json`（含四种读取方式、sheet 列表、供应商表探测、现役基线）。
- 现役只读：`.local/catalog/ux-round-20261114/verify-live.mjs` → `verify-live.json`（11/11）。
- 克隆库：`.local/catalog/ux-round-20261114/clone-verify.mjs` → `clone-verify.json`（16/16）；`make-clone-snapshot.mjs` 生成 E3 修好的模拟快照。
- 039：`db/catalog/039_shipment_association_rule_preview.sql`、`scripts/catalog/apply-039.mjs`、`apply-039-commit.json`（现役 commit：函数安装/权限/幂等/行为探针通过；唯一 FAIL 是并行后台物流读取使 snapshot 数 +1，业务表未变）。
- 截图：`50-clone-formula-93.png`、`51-clone-formula-92.png`、`52-clone-formula-applied.png`、`53-clone-rule-saved.png`、`54-clone-rule-cleared.png`、`60-live-home-6.png`、`61-live-formula-93.png`、`62-live-rule-preview.png`。

## 六、独立差异复核（PASS、阻断 0）

复核人自写只读 Playwright / psql / 构建哈希探针，不采信执行方 JSON；自建独立克隆库 `…_clone_ux14_ir2` + 3018（结束时删库/停进程），复现两条写入路径 **16/16 PASS**。结论：

- 构建：ready / manifest / workspace `.next/BUILD_ID` / staging `next-build-00861f446a8c4216` / preview-server（pid 21060）全部 `VzaMvuTYTxxKfHGyko6fA`；`computePreviewSourceSnapshotHash()` 复算 = `00861f44…`；manifest 抽 30 个 `src/db/scripts` 文件 sha256 **30/30 一致**；login 200；HEAD `cab7537`，无提交/推送。
- 现役只读：总览「商品资料」6 项 = 商品库徽标 6 = 弹窗 6 卡（5 原事项 + 1 合并公式）；93 个 #REF!、展开 93 行、首行 `LS101295 / E3 / #REF!`、外链 wiki/新窗口/noreferrer；点一次检查更新（内容 unchanged）后仍 6/93；物流 4 条/4 票规则预告「当前有 3 条（3 票）…以后新到的…也会自动匹配」；console 0；DB 前后 items 126 / revisions 226 / codes 125 / open 5 / mappingConfirmed 512 / associationRevisions 192 / audits 41 / requests 26 / batches 2 / shipments 71 / items 199 / mapping 15，audit 10:00 后 0 新增。
- 克隆库：E3 修好 93→92、E3 消失、清单仍 6；确认更新 partial 回执「已确认的变更已写入，待核对字段保留原值。」+「已写入 8 款，其中 6 款已写入确认字段、另有字段待核对；无变化 26；待核对 100；失败 0」；确认后 `data-pending-kind="formula_error"` 重复卡 **0**、合并项仍 92、batches 2→3；物流保存回执「已关联「WM0094…」；已计入货值。已保存「以后同市场同品名沿用」规则；本次按规则另外关联 3 条」、DB adopted 4 / mapping 15→16 / association 192→196；清除回执「已清除本条明细的商品关联。」、DB `product_id=null` / `association_method='manual_cleared'`、规则预告不再包含该条。
- 039：条件与 027 `shipment_mapping_apply_core` 逐项对齐；SECURITY DEFINER、`search_path=''`、STABLE、`require_admin`；ACL 仅 owner + app，PUBLIC 不可，app 对 `shipment_item`/`shipment`/`shipment_product_mapping` 无 SELECT；两次调用结果相同、assoc 行数不变；无业务表新增。
- 非阻断观察：O1 克隆脚本对自定义 clone run root 有隐藏前提（首次超时，改用一致 run root 后 16/16）；O2 执行方口述单测 889/890、复核实跑 **904/905**（唯一既有 opt6 基线，以实测为准）；O3 检查更新只更新本地 reader 状态、不写业务 DB；O4 039 只读/权限收敛；O5 13:43 只能确认到管理员账户、不能还原具体操作人。
- 限制：未点现役保存/确认/清除；未改飞书；克隆为模拟快照，不代表真实飞书原表已修；未做权限矩阵/移动端/200%/多日稳定性。
