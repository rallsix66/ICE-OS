# 操作记录 v1（三类人工业务处理只读入口）

- 日期：2026-11-16
- 实例：`run-20261026T211500Z-11a22b33`（Web 3011 / PostgreSQL 59345）
- 入口：<http://127.0.0.1:3011/dashboard/operations>（一级导航「操作记录」）
- 登录：`admin@catalog.test`（密码见实例 `login.local-preview.txt`，不入 Git）
- 最终 BUILD：`dO1NCoaNmTLVIYJJM-s0S`（源码快照 `0f9a0adbc02a5ab8…`，ready/manifest/server 一致、login 200）
- 证据：`.local/catalog/operations-log-20261116/`（`verify.json`、截图、`apply-042*.json`）

## 1. 合同

交付一个管理员真正能用的「操作记录」入口：能查到已有的人工业务处理，查看记录里的变化和结果，
并进入对应商品、货票或批次继续核对。范围与限制：

1. 覆盖三类**已有持久记录**：
   - 商品资料：商品资料修改、补货号、来源资料行选择、来源采用结果；
   - 库存对应：确认、换绑、重核、停用（以及国内复核采用商品对应）；
   - 物流：商品关联、人工数量/状态修正、分合票决定与撤销。
2. 来源采用按**已有批次结果**展示成一条，不按商品/字段重复堆叠。
3. 直接复用各模块现有 audit/revision 记录，只通过服务端只读查询汇合；不重写写入链。
4. 历史记录没保存的前值不得用当前值反推；记录账号不等于已确认的具体操作人。
5. 自动同步过程继续看「数据同步」及各模块同步结果入口；本包不整合全部后台事件。

## 2. 开工核实：实际保存了什么

先只读核对现役库的表、列与真实行，再决定展示内容（不按印象设计）：

| 来源表 | 已保存字段（用到的） | 没有保存 |
| --- | --- | --- |
| `catalog.item_revision` | item_id、revision、previous_revision、ice_code_snapshot、name_cn、fields（每版全字段快照）、reason、evidence_ref、actor_id、recorded_at | 首版无上一版本；字段级前后值需与 `previous_revision` 的历史快照比较 |
| `catalog.audit_event` | action、actor_id、item_id、result（补货号/采用回执，含 counts、results[].changes 前后值）、request_id、recorded_at | 无独立"原因"列；不存页面上未写入的字段 |
| `catalog.product_source_batch` | status、counts、captured_at、received_at、snapshot_key、request_id | 不存操作人（从同批 `audit_event.apply_product_source_batch` 取） |
| `catalog.product_source_duplicate_decision` | chosen_row_number、chosen_fields、comparison（逐行原值）、state、note、decided_by/at、superseded_at | 不保存"选择理由"（只有 note） |
| `catalog.product_source_field_decision` | field_key、action、state、reason、rule、value_raw、decided_by/at、revoked_at | **不保存覆盖前的本地值**（`value_raw` 为空时不能拿当前资料补） |
| `catalog.inventory_audit` | actor_id、action、entity_ref、detail（confirm 的 applied/committed/skipped；recheck/disable/replace 的 mapping 结果）、at | 无 request_id、无自然语言理由；confirm 的仓库取 `detail.committed[].warehouseExternalId` |
| `catalog.inventory_sku_mapping` | version、supersedes_id、status、item_id、external_sku、unit、actor_id、created_at | 前值只在被替代的对应行（`supersedes_id`），该行仍保留 |
| `catalog.shipment_item_association_revision` | item_id、revision、product_id、previous_product_id、method（manual_selected/manual_cleared）、actor_id、reason、recorded_at | 无请求号；同一次保存只能按"记录时间+账号+方法+票"合并 |
| `catalog.shipment_item_manual_revision` | action（apply/restore）、manual_status、manual_shelved_quantity、previous_*、received_quantity、remaining_quantity、actor_id、actor_name、note、recorded_at | 不保存"修正理由"以外内容；actor_name 是写入时名称快照 |
| `catalog.shipment_grouping_review` | kind、decision、status、evidence（当前/上次票面）、resolved_at、resolved_by、resolution_note | **不保存具体操作人**（只有管理员账号），不能反查谁点的 |
| `catalog.shipment_grouping_override` | kind、spec、active、created_at/created_by、revoked_at/revoked_by | 撤销记录只有 active=false 且 revoked_at 的行 |

按钮/写入链未改：本包没有新增写 RPC，也没有修改任何业务写入函数。

## 3. 展示口径（避免同一次操作重复）

| 类别 | 记录类型（action） | 一条记录代表 | 真实条数（本机） |
| --- | --- | --- | --- |
| 商品资料 | `source_batch_applied` | 一次来源采用（按批次），展开列本批**真正写入**的商品与字段前后值 | 3 |
| 商品资料 | `assign_source_code` / `assign_initial_code` | 补录货号 | 1 |
| 商品资料 | `correct_test_source_code` | 撤销测试货号 | 1 |
| 商品资料 | `resolve_source_issue` | 关闭来源缺货号事项 | 1 |
| 商品资料 | `duplicate_source_decision` | 同号多行选择一行（撤销状态来自历史行） | 4（均已撤销） |
| 商品资料 | `field_decision` | 来源字段暂不处理/人工解释/人工覆盖（含撤销） | 9 |
| 商品资料 | `item_revision` / `item_baseline` | 未被批次或补货号覆盖的历史修订（含首版） | 128（126 首版 + 2 测试修订） |
| 库存对应 | `inventory_confirm` / `inventory_rebind` | 一次确认请求（可多条 committed）；版本>1 即换绑，前值取被替代对应行 | 90 / 5 |
| 库存对应 | `recheck_inventory_mapping` / `disable_inventory_mapping` / `replace_inventory_mapping` | 重核/停用/原 SKU 替换 | 0 / 0 / 0（本机无记录，路径已覆盖） |
| 库存对应 | `domestic_review_decision` | 国内复核采用商品对应（人工复核决定） | 5 |
| 物流 | `shipment_association_manual` / `shipment_association_cleared` | 一次保存的同一票同方法明细（合并成一条） | 90 / 15 |
| 物流 | `shipment_manual_correction` / `shipment_manual_restore` | 人工修正数量/状态、恢复按原表 | 3 / 2 |
| 物流 | `shipment_grouping_decision` / `shipment_grouping_revoked` | 分合票人工决定、撤销人工决定（active=false 且已撤销） | 3 / 0 |

合计 **360 条**（商品资料 147 / 库存对应 100 / 物流 113），与数据库独立重算一致。

**不做重复堆叠**：
- 来源采用的商品级修订只在批次记录里展开，不另立 91/2/7 条"已更新"记录；
- 批次回执中无 `itemRevision` 的 `needs_review` 行只计入 counts，不进"写入商品"明细；
- 补货号同时产生的 item_revision 归到补货号记录，不重复出两条；
- 物流同一次保存的 7 条腮红明细合并成 1 条（本机 111→105 条记录）；
- `begin/complete_inventory_pending_action`、自动同步动作（发布批次/阶段/导出）不单独成条。

## 4. 只读查询（042）

`db/catalog/042_operation_records.sql` 只新增一个只读函数（不建表、不改 001–041）：

```sql
catalog.read_operation_records(
  p_category text,      -- all | catalog | inventory | shipment
  p_actor uuid,         -- 记录账号
  p_from timestamptz,   -- 含
  p_to timestamptz,     -- 不含（页面按 +08 自然日换算）
  p_search text,        -- 货号 / 来源 SKU / 货票号 / 名称 / 批次号
  p_limit integer,      -- 1–200
  p_offset integer
) RETURNS jsonb
```

- `SECURITY DEFINER` + `search_path=''` + `STABLE`，入口 `catalog.require_admin()`；app 角色只能 `EXECUTE`，PUBLIC 不可执行；
- 返回 `total / offset / limit / categoryCounts / actors[] / rows[] / readAt`；
- 排序 `at DESC, id ASC`（id 为各源稳定键，分页不重不漏）；
- 关键词只搜已保存业务标识；批次记录按**本批写入商品**的货号/名称参与搜索；
- 每条记录带 `detail`（批次回执、对应版本、前后值、修正前后、票面等），页面据此展开；
- 分页越界由页面回读最后一页（服务端返回真实 `total`，不伪造空页）。

权限/只读探针见 `scripts/catalog/apply-042.mjs`（rollback **28/28**、commit **28/28**）：
两次安装幂等、单一重载、属主/授权正确、未登录 `CATALOG_FORBIDDEN`、全量=独立重算 360、
分类计数、排序、id 唯一、三类真实样例与原始行逐字段一致、首版无前值、类别/账号/日期/关键词/无结果/分页/越界、
业务行数前后不变、rollback 回到安装前签名。

标准准备链已接入：`scripts/inventory/prepare-instance.mjs`（016–035、038–041 之后安装 042）
与 `scripts/catalog/prepare-local-preview.mjs`（依赖表未建时记录 skipped，表就绪时就地补齐）。

## 5. 页面

- 路由 `/dashboard/operations`，一级导航「操作记录」（`workspace-shell.tsx`、`navigation-config.ts` 同步登记）；
- 默认按时间倒序，每条显示「时间 / 记录账号」「业务对象」「动作」「结果」，点开显示已保存依据；
- 筛选：业务类别页签（带计数）、记录账号下拉、共享搜索框（货号/来源 SKU/货票号/名称，300ms 防抖）、
  起止日期（+08 自然日）；筛选写回 URL（replace，不污染历史），刷新/直接链接/返回都还原；
- 分页 50 条/页，页脚显示「第 a–b 条，共 N 条 · 第 p/P 页」，页码越界回读最后一页；
- 展开依据：
  - 批次：状态/采集/采用时间、写入商品、逐字段「前值 → 后值」；
  - 换绑：来源 SKU、仓库、单位、对应版本、原商品 → 现商品（取被替代行）；
  - 人工修正：修正前/后状态、累计到货、剩余、累计已上架（未保存写「未提供」）；
  - 分合票：复核类型、决定、涉及票号与市场、受影响商品；
- 入口：商品 → `/dashboard/catalog/<id>`；货票 → `/dashboard/in-transit?ticket=<shipmentId>`（无 id 时 `?q=<ticketNo>`）；
  批次 → `/dashboard/catalog/sources`、`/dashboard/sync?panel=product-update`；
- 返回保留：所有筛选与页码都在 URL 上，浏览器返回即回到原筛选/页码（已实测，见 §6）；
- 无结果 / 日期反向 / 读取失败分别有独立状态：读取失败只说没读到，不显示旧缓存或 0 条。

页面文案明确写出：记录账号 ≠ 具体操作人；历史没保存的旧值显示「未保存」，不用当前值反推。

## 6. 验证（执行方自验，不代表 PASS）

### 6.1 页面（3011，新 BUILD，只读）**26/26**

`verify-operations.mjs` → `verify.json`，console/pageerror 0：

- 入口与默认：标题/一级导航、第一条=最新批次 `40b3c87c…`（2026-11-16 11:40:24）、
  时间/账号/结果与数据库一致（`已写入 7 款…待核对 101…失败 0`）、每页 50 条、总数 360 = 三类独立重算；
- 类别计数：商品资料 147 / 库存对应 100 / 物流 113 / 全部 360；
- 三类真实样例逐字段核对：
  - 商品资料：批次 `40b3c87c` 状态 partial、采集 2026-11-11 18:12:58、采用 11-16 11:40:24、
    写入 7 款、WM0049 中文名称前后值；批次入口存在；
  - 库存对应：换绑 喜运达MY仓 `757577983037` 对应第 2 版，原商品 WM0027（历史行）→ 现商品 WM0069；
  - 物流：POKNZX027385 人工关联 12 条原始修订 → 12 条记录、明细合计 12 条；
    POKNZX026710 人工修正 累计到货 0 / 剩余 11440 / 累计已上架「未提供」；
- 筛选：类别（cat=catalog 只剩商品资料）、货号 WM0073（来源采用/商品资料修改/来源行选择）、
  货票号 POKNZX027385、记录账号（显示名不是 UUID）、日期 11-10（18 条且全是 11-10）、
  日期反向只提示不查询、无关键词时无结果空态 + 清空入口；
- 分页：下一页写回 URL、每页 50、与第 1 页不重复；`page=99` 回读最后一页（10 条，8/8）；
- 入口与返回：商品详情→返回 URL/筛选/行数不变；货票详情（`?ticket=`）→返回不变；
  从第 2 页进商品→返回仍在第 2 页；批次→来源核实页→返回 `cat=catalog`；
- 读取失败：临时回收 app 角色 EXECUTE 后页面显示「操作记录读取失败」+「重新读取」、0 条记录；
  探针后立即恢复授权并复核 `has_function_privilege=true`、页面恢复 50 条。

### 6.2 布局（1440×900 / 760×900）**7/7**

`layout-check.mjs` → `layout.json`：两档默认列表与展开来源采用记录后均无整页横向溢出
（`scrollWidth == clientWidth`），筛选区在视口内，变化表在容器内滚动；console 0；截图 `layout-1440.png` / `layout-760.png`。
导航变更后五页冒烟 **8/8**（`smoke.json`）：一级导航 6 项，五个页面 200 且高亮正确（操作记录为「操作记录」），console 0。

### 6.3 迁移与只读

- `apply-042.mjs --rollback` **28/28**，`--commit --allow-live-commit` **28/28**；现役库业务行数前后一致
  （audit_event 42 / item_revision 233 / source_batch 3 / duplicate 4 / field 9 / inventory_audit 4285 /
  sku_mapping 517 / association_revision 200 / manual_revision 5 / grouping_review 3 / override 1）。

### 6.4 测试与静态检查

- 定向单测：`src/features/operations/model.test.ts` **21/21**、`navigation-config.test.ts` **7/7**、
  `inactive-session-guard.test.ts` **20/20**（合计 48/48）；
- `tsc --noEmit` 仅既有 BEST 5 条；改动文件 eslint 0；`git diff --check` 0；
- 全仓 `npm test` 结果见 §6.4。

### 6.5 全仓测试

`npm test` **942/943**：唯一失败是既有 `opt6-production-apply` Windows 换行基线（与本包无关；
同轮 `get-catalog-list-page` 曾一次 5s 超时，单独重跑 5/5 通过）。改动目录 eslint 0、`git diff --check` 0。

## 7. 明确没有保存 / 本机没有记录的信息

1. **重核、停用、原 SKU 替换**：现役库 `inventory_audit` 没有这三类动作（0 条）；页面查询路径已覆盖，
   未来出现即按同一套展示，当前不显示任何样例。
2. **撤销分合票决定**：`shipment_grouping_override` 现有 1 条 active（keep_separate），撤销记录 0 条；
   页面已覆盖 `active=false AND revoked_at IS NOT NULL`，当前无样例。
3. **来源字段覆盖前的本地值**：`product_source_field_decision` 未保存（`value_raw` 为空），
   页面写「未提供」，不拿当前商品资料补。
4. **首版前值**：`item_revision.previous_revision IS NULL`，写「无（首版）」。
5. **具体操作人**：`shipment_grouping_review`/`override` 只保存管理员账号；13:43 的分组决定只能确认记在该账号名下，
   不能确定具体是谁点的；页面脚注与展开说明都写明。
6. **4 条同号选择不是真实人工确认**：由一次性脚本代选后已撤销（note 原文保留），页面显示「已撤销」。
7. **申请/理由**：`inventory_audit` 没有 request_id 与自然语言理由；页面只展示 `detail` 里的 applied/committed/skipped。
8. **物流关联请求号**：表里没有 request_id，同次保存只能按时间+账号+方法+票合并，不做跨时间猜测。
9. **自动同步事件**：库存发布/阶段/导出、物流自动读取等后台事件不进入本页（仍是各同步结果入口）。
10. `assign_initial_code` 当年写入的是测试码 `TEST-PG-NEW122-0`，页面如实显示为「初始补录货号」，
    随后 `correct_test_source_code` 记录撤销；不把测试数据美化成真实货号。

## 8. 改动文件

| 文件 | 改动 |
| --- | --- |
| `db/catalog/042_operation_records.sql` | 新增只读汇合函数（商品资料/库存对应/物流），不建表 |
| `scripts/catalog/apply-042.mjs` | rollback/commit 探针（结构/权限/真实样例/筛选/分页/只读） |
| `scripts/inventory/prepare-instance.mjs` | 标准准备链在 041 之后安装 042 |
| `scripts/catalog/prepare-local-preview.mjs` | 依赖表就绪时就地补齐 042，未就绪记录 skipped |
| `src/features/operations/types.ts` | 记录/分页 DTO |
| `src/features/operations/model.ts` | URL 解析/分页/动作文案/展开依据（纯函数） |
| `src/features/operations/model.test.ts` | 21 条单测（筛选/日期边界/文案/前值/入口） |
| `src/features/operations/server/reads.ts` | app 角色只读调用 + 结构校验 |
| `src/features/operations/components/operations-view.tsx` | 列表/展开/分页/空态/读取失败/无权限 |
| `src/features/operations/components/operations-filters.tsx` | 搜索/账号/日期筛选（写回 URL） |
| `src/features/operations/components/operations.module.css` | 与现役工作台一致的列表/展开样式 |
| `src/app/dashboard/operations/page.tsx` | 页面（force-dynamic、鉴权、越界回读） |
| `src/ui/ice-v4/workspace-shell.tsx` | 一级导航「操作记录」+ 面包屑 |
| `src/ui/ice-v4/navigation-config.ts` | 登记 `/dashboard/operations` |
| `src/ui/ice-v4/navigation-config.test.ts` | 导航合同更新为六个入口 |

## 9. 边界

- 现役库零业务写入；只读函数、只读事务与 `verify` 中的授权回收/恢复均不写业务数据；
- 未启动库存/物流/飞书后台 worker；最新库存批次仍停在 2026-11-12 16:22；
- 未改飞书、未改各模块写入链、未新增业务表；
- 权限矩阵、200% 缩放、多日稳定性未做；
- 页面暂不支持导出与跨页批量操作（不在本包范围）；
- `README.md` 的「当前 BUILD」行本轮未改：该文件带有本包之外的 Mac 部署准备改动（按要求保留、未提交），
  不把两包混进同一个提交；现役 BUILD 以本记录与实例 `preview-build-ready.json` 为准。
