# 海外库存历史快照查询 v1（2026-11-16）

状态：**已完成（2026-11-16 收口）、独立差异复核 PASS、阻断 0**（PASS 由独立复核给出，执行方不自行宣布；最终报告
[independent-review-r3.md](../../.local/catalog/inventory-snapshot-20261116/reviewer/independent-review-r3.md)）。
仅限本机现役实例 `run-20261026T211500Z-11a22b33`（Web 3011 / PostgreSQL 59345）。
最终 BUILD **`S1prE-Z5-Gb9BRJNwaKIT`**（源码快照 `f19186de20ab2a3f…`）。
访问地址：<http://127.0.0.1:3011/dashboard/inventory>（登录 `admin@catalog.test` / `CatalogAdmin123!`）。

## 1. 任务与范围

运营从「商品库存」进入「历史快照」，按仓库和一次已发布批次，查询当时有哪些来源 SKU、
各有多少库存、对应哪款 ICE 商品；切换批次时保留来源 SKU 搜索，返回当前库存时保留原筛选。

本轮只做这条使用链：

- 在商品库存页内新增第三个页签「历史快照」，沿用现有页面/表格/分页/下拉组件语言；
- 新增两个只读查询（`db/catalog/041_inventory_snapshot_reads.sql`），直接读
  `catalog.inventory_batch` / `catalog.inventory_batch_row`；
- 不改同步机制、不改商品身份/绑定、不新增业务表、不写任何业务数据；
- 不做金额/货值、图片、导出、跨仓合计。

## 2. 页面与交互

入口：`/dashboard/inventory` 页签「仓库明细 | 商品汇总 | 历史快照」。

历史快照 URL 在保留库存筛选（`q / warehouse / market / view / source / page / sort / dir`）的基础上追加：

| 参数 | 含义 |
| --- | --- |
| `snap=1` | 进入历史快照视图 |
| `snapWarehouse` | 快照所选海外仓（与库存列表 `warehouse` 筛选互不覆盖） |
| `snapBatch` | 选定批次；为空时取该仓最新批次 |
| `snapQ` | 来源 SKU 搜索（只属于快照视图） |
| `snapPage` | 明细分页（每页 50 行） |

行为：

- **按仓选择**：下拉只列当前账号 `confirmed` 的 BigSeller 仓；换仓只改 `snapWarehouse` 并回到该仓最新批次。
- **按观测时间选批次**：左栏「已发布批次」按 `observation_at DESC, published_at DESC, id DESC` 列出，
  每条显示观测时间、行数、已绑/未绑数量；当前批次高亮。单仓最多列最近 200 个批次，超出时如实提示
  （现役每仓 186 个，全部可选）。
- **明细按需加载**：只读取选定批次；首屏最多 50 行，分页可翻页；不预读其他批次。
- **切换批次保留搜索**：批次是链接，携带当前 `snapQ`、`snapWarehouse`；切换后仍按同一来源 SKU 过滤。
- **搜索**：300ms 防抖，按来源外部 SKU 子串匹配（ILIKE），仅作用于选定批次。
- **本批未见**：有搜索但该批 `matched=0` 时显示「本批未见」和实际搜索词；不显示空表冒充。
- **返回当前库存**：工具栏「返回当前库存」与「仓库明细/商品汇总」页签都只去掉 `snap*` 参数，
  原 `q/warehouse/market/view/source/page/sort/dir` 原样保留，不会重开库存详情或待处理弹窗。
- 只读提示固定显示：采集时间使用来源观测时间（`observation_at`）。

## 3. 数据口径

- 仓库：`catalog.inventory_warehouse`（显示 `external_name`；市场为空显示「市场待确认」）。
- 批次：`catalog.inventory_batch`（`id`、`observation_at`、`published_at`、`row_count`、`adopted_count`、`unmapped_count`）。
- 明细：`catalog.inventory_batch_row`（`external_sku`、`excel_row`、`status`、`item_id`、`mapping_id`、
  `item_revision`、`unit`、`on_hand`、`order_locked`、`warehouse_available`）。
- **历史归属**：只用批次行保存的 `item_id/mapping_id/item_revision`：
  - 货号取 `catalog.catalog_item_code.ice_code`（商品 UUID 身份）；
  - 品名优先取 `item_revision` 中该 `revision` 的历史品名，缺该版本时才回退当前版本；
  - 映射版本取 `inventory_batch.mapping_snapshot->'mappings'` 中与该 `mapping_id` 相同的 `version`，
    **不查当前 `inventory_sku_mapping`**；
  - 页面在商品归属下显示「映射 vN · 商品版本 N」。
- **未绑定 SKU**：`item_id IS NULL` 的行照常返回，数量/单位原样显示，商品归属显示「未绑定商品」，
  并注明「本批未对应商品，数量照常保留」。
- **数量/单位**：真实 `0` 显示 `0`；`NULL` 显示「未提供」（数量与单位同一规则）。
- 搜索：只按来源 SKU；用 ICE 货号搜索时若不匹配外部 SKU，会如实显示「本批未见」。

## 4. 只读查询（041）

`db/catalog/041_inventory_snapshot_reads.sql` 只新增两个只读函数，`CREATE OR REPLACE`，可重复安装；
旧签名 `(uuid)` / `(uuid,text,int,int)` 在文件内显式 `DROP`，避免分页/明确批次语义出现重载歧义：

```sql
catalog.read_inventory_snapshot_batches(p_warehouse uuid, p_limit integer, p_offset integer) RETURNS jsonb
catalog.read_inventory_snapshot_rows(
  p_warehouse uuid, p_batch uuid, p_search text, p_limit integer, p_offset integer) RETURNS jsonb
```

- `SECURITY DEFINER` + `search_path=''` + `STABLE`，入口 `catalog.require_admin()`；
- 仓库/批次必须属于当前账号绑定的 BigSeller 账号（`inventory_bound_account_id()`），
  越权/不存在返回 `ok=false` 或 `INVENTORY_WAREHOUSE_UNKNOWN`，不伪造空批次；
- **批次列表分页**：按 `observation_at DESC, published_at DESC, id DESC` 分页（`p_limit` 1–200，
  返回 `batchTotal/offset/limit`），页码超出末页回退最后一页；页面按 50 条/页翻到任意更早批次；
- **明确批次独立读取**：`p_batch` 不依赖是否落在当前批次列表页；`p_warehouse` 非空时核对所属仓，
  不一致返回 `status='warehouse_mismatch'` + 实际仓库名，不存在返回 `status='not_found'`，
  两者都不返回行/数量；成功时返回 `batchRank/batchTotal`，页面据此把批次列表翻到同一页；
- 明细 `p_limit` 限制 1–200；页码超出末页时回退到最后一页（不出现「有匹配但空页」）；
- 只读事务沿用 `withReadOnlyAppDb`（app 角色），与库存现有读取同一套鉴权；
- 未新增表/迁移业务数据、未改 016–040；`PUBLIC` 不可执行，app 角色可执行。
- 应用脚本：`scripts/catalog/apply-041.mjs`（默认 rollback 探针；现役提交需 `--allow-live-commit`）。
- **标准实例准备**：041 已接入 `scripts/inventory/prepare-instance.mjs`（在 016–035 之后、
  038–040 之后）与 `scripts/catalog/prepare-local-preview.mjs`（依赖表就绪时就地补齐，未就绪记录跳过）；
  正常准备实例即可使用，不依赖单独执行 `apply-041.mjs`。

## 5. 代码改动

| 文件 | 改动 |
| --- | --- |
| `db/catalog/041_inventory_snapshot_reads.sql` | 两个只读函数与授权（批次分页 + 明确批次核对所属仓） |
| `scripts/catalog/apply-041.mjs` | 041 的 rollback/commit 探针（分页/排名/仓库不匹配/不存在批次/真实数据对账） |
| `scripts/inventory/prepare-instance.mjs` | 标准准备链在 016–035 之后安装 038–040、041 |
| `scripts/catalog/prepare-local-preview.mjs` | 依赖表就绪时补齐 038–041；未就绪记录跳过（不再整步失败） |
| `src/features/inventory/types.ts` | 快照批次分页/明确批次状态 DTO |
| `src/features/inventory/normalize.ts` | 两个只读结果的归一化（status/batchRank/batchTotal） |
| `src/features/inventory/server/reads.ts` | `getInventorySnapshotBatches`（分页）/ `getInventorySnapshotRows`（带仓核对） |
| `src/features/inventory/model.ts` | `snap*` query（`snapBPage` 0=未指定 / ≥1=明确页）解析、链接构造、实际查看批次与展示函数 |
| `src/app/dashboard/inventory/page.tsx` | 明确批次先独立读取并核对所属仓；批次列表按页读取；批次坏时不退回最新 |
| `src/features/inventory/components/inventory-view.tsx` | 第三个页签与快照视图切换 |
| `src/features/inventory/components/inventory-snapshot-view.tsx` | 选仓/批次分页/搜索/明细/不可用提示/返回（新增） |
| `src/features/inventory/components/inventory.module.css` | 快照布局、批次分页与窄屏样式 |
| `src/features/inventory/snapshot.test.ts` | 15 条纯逻辑单测（解析/链接/批次分页/实际查看批次/展示口径） |

## 6. 验证（执行方自验）

### 6.1 真实页面使用链（3011，Playwright，只读）

`26/26 PASS`，console/pageerror 0，DB 前后完全一致：

- 从「商品库存 → 历史快照」进入，保留 q/warehouse/source/view，只追加 `snap*`；
- 换仓只改 `snapWarehouse`，不改库存 `warehouse`；
- 批次列表按观测时间倒序，条目行数/绑定数与数据库一致；
- 同一仓同一来源 SKU 两个真实批次：页面数量与 `inventory_batch_row` 原数逐列一致；
- 切换批次保留 `snapQ`，页面仍 1 行且数量切换正确；
- 搜索不存在的 SKU 显示「本批未见」；清空搜索保留批次；
- 未绑定 SKU 可查、显示「未绑定商品」；单位缺失显示「未提供」；真实 0 显示 0；
- 明细分页（144 行 → 3 页）第 2 页 50 行；
- 「返回当前库存」去掉全部 `snap*`，保留原筛选，仍为商品汇总视图；
- 只读：items 126 / revisions 226 / codes 125 / batches 1302 / batchRows 121257 /
  inventory_current 512 / mappings 517 / audits 41 前后一致。

补充样例核对 **3/3**（`examples-extra.json`）：未绑定且有数量的 `0000` 显示 1,494/0/1,494、单位「未提供」；
已绑定真实零 `757577983006`→WM0024 显示 0/0/0、单位「个」；console 0。

### 6.2 布局

`7/7 PASS`：1440×900 整页无横向溢出，批次栏 300px、明细 856px，明细表在 478px 内滚动；
760×900 整页无横向溢出，批次与明细上下堆叠、页面自然增高（明细表随内容展开）；
两档 console 0。

### 6.3 测试与静态检查

- 新增纯逻辑单测 `src/features/inventory/snapshot.test.ts` 首轮 **12/12**；二轮补充分页状态用例后 **15/15**（见 §6.6）；
- 库存定向回归（web-model / dual-view / domestic / settlement）**155/155**；
- `npm test` **918/919**，唯一失败为既有 `opt6-production-apply` Windows 换行基线（首轮另有一次
  `get-catalog-list-page` 5s 超时，单独重跑 5/5 通过；第二轮全仓仅 opt6）；
- `tsc --noEmit` 仅既有 BEST 5 条；
- 改动文件 eslint 0；`git diff --check` 0。

### 6.4 041 应用回读

`scripts/catalog/apply-041.mjs` rollback **28/28**、commit **27/27**：两次安装幂等、签名/安全属性/
属主/授权正确、批次列表倒序与分页（第 6–10 批、页码超出末页回退）、批次排名、第 61 批独立读取并
定位所在列表页、仓库不匹配/不存在批次不返回行与数量、不带仓直链、SKU 搜索、未绑定/真实零/历史版本、
明细分页、只读前后行数不变；业务行数未变。rollback 后函数签名回到安装前（旧签名不被半替换）。

### 6.5 复核后两项收口（2026-11-16，B1/B2）

独立复核报告（[independent-review.md](../../.local/catalog/inventory-snapshot-20261116/reviewer/independent-review.md)）
判定 NEEDS_FIX 两项，本轮集中修复：

- **B1 完整历史可达性 + 明确批次一致性**：批次列表改分页（50 条/页，页脚「第 a–b 个 · 共 N 批」
  +「更新批次 / 更早批次」+ 当前页）；`snapBatch` 明确时先独立读取该批并按批自身仓库核对，
  不再要求它出现在当前批次列表；不存在/与所选仓不一致时只给提示，不显示任何其他批次数量；
  直链批次不在第 1 页时列表自动翻到它所在页并高亮；离页时提示「当前查看的批次在批次列表第 N 页」可跳回。
- **B2 标准实例准备纳入 041**：`prepare-instance.mjs` 在 016–035 之后安装 038–040、041；
  `prepare-local-preview.mjs` 在依赖表未创建时记录跳过（此前 038–040 在 026 之前执行会让整步
  `type "catalog.shipment_item" does not exist` 失败，041 也因此到不了），表就绪时就地补齐。

**临时实例（全新标准准备链）验收**：`run-20261116T040500Z-b1f10002`（Web 3037 / PG 51074），
`prepare-instance.mjs` 一条命令完成：prepare-local-preview（009–015/036–037 应用，038–041 因表未建记录跳过）
→ 016–035 → 038–040 → 041 → seed。随后在该临时库造 **210 个已发布批次**（另一仓 3 个）：

- 页面 **17/17 PASS**（`b1-temp-page.json`）：第 205 批直链显示自身观测时间与数量 1,205/215/1,195；
  批次列表自动到 5/5（第 201–210 个，共 210 批）并高亮；页面翻 4 次到第 5 页点选同一批，摘要与数量
  与直链完全一致；只有 `snapBatch` 的直链按批次自身仓库读取；不存在批次显示「这批不存在或不可用」、
  无摘要/无行/无数量；仓库不匹配显示「这批不属于所选仓库」+实际仓名、无数量，「切换到该仓查看」显示该批；
  第 5 页切换第 210 批仍保留 `snapQ`；「跳到该页」回到第 1 页；返回当前库存去掉全部 `snap*` 保留
  q/warehouse/source/view；console/pageerror 0。
- 应用角色读取 **PASS**：临时库 app 连接对两个函数 `has_function_privilege=EXECUTE`，真实读取
  `batchTotal=210`、第 205 批 `onHand=1205`（与页面一致）；不回退管理员/owner。
- 标准链回读：`inventory-instance.json.schema.applied` 含 `038/039/040/041`；preview 阶段
  `local-display-sql.json` 的 `skipped` 记录 038–041 及缺失表原因（可追溯，不静默）。

**现役页面（3011，新 BUILD，只读）**：

- B1 专项 **11/11 PASS**（`b1-live-page.json`）：第 61 批（不在首批 50 条）直链显示该批观测时间与
  SKU 数量，列表翻到 2/4 并高亮；页面翻页点选与直链摘要/数量一致；同页切第 62 批保留 `snapQ` 且数量随批变化；
  不存在批次只给提示、无摘要/无行；仓库不匹配给出实际仓名、无数量，切仓后显示该批；只有 `snapBatch`
  直链按批次自身仓库读取；返回当前库存去掉 `snap*`（含 `snapBPage`）保留原筛选；console 0。
- 上一轮 26 项真实使用链在最终 BUILD 重跑仍 **26/26 PASS**（`verify.json` 已更新），
  两批数量与未绑定/真实零/本批未见/分页/返回行为未回归；布局 **7/7** 重跑通过
  （批次面板新增页脚后 1440/760 仍无整页横向溢出，桌面批次栏 300px、明细 856px、明细表 478px 内滚动）。
- 临时库与现役库前后业务行数一致；`apply-041` 业务行数不变。

### 6.6 第二轮复核：批次分页状态（2026-11-16）

第二轮复核（[independent-review-r2.md](../../.local/catalog/inventory-snapshot-20261116/reviewer/independent-review-r2.md)）
只余一项 B1：分页状态没有区分「未指定列表页」与「明确第 1 页」，且列表/明细分页链接只带 URL 里
可能为空的 `snapBatch`，默认最新时翻列表会把右侧详情换成该页第一批。最小修复：

- `snapBPage` 用 **0 = 未指定**（可按所选批次所在页自动定位）、**≥1 = 明确停留该页**；
  `buildInventorySnapshotHref` 对明确页（含第 1 页）写参数，未指定不写。于是第 61 批直链自动到第 2 页，
  点「更新批次」回到第 1 页且不再被批次位置拉回。
- 新增纯函数 `snapshotViewedBatchId()`：优先取服务端实际读取的批次，`query.snapBatch` 只作回退；
  批次列表翻页、明细分页、搜索/清空都带上「当前实际查看的 batchId」，只有点击批次或切仓才改变选择。
- 未指定批次时右侧详情始终是最新批次；列表翻到更早页只影响左栏（不再用该页第一批替换详情）。
  切仓链接改为不指定列表页，由新仓自动定位到该批所在页。

定向验证（现役 3011，新 BUILD，**10/10 + 11/11**，console/pageerror 0）：

- 第 61 批直链在第 2 页（2/4）；点「更新批次」后 URL 明确 `snapBPage=1`、列表回到第 1–50 个，
  摘要与数量仍是第 61 批 `8fea3893…`（2026-11-10 04:22）。
- 默认最新（URL 无 `snapBatch`）为 `13dd11d1…` 2026-11-12 16:22；点「更早批次」到第 2 页后，
  摘要/观测时间/数量完全不变（链接自动补上实际 `snapBatch`）；再从第 2 页回第 1 页仍不变。
- 第 2 页点第 62 批 `4d742296…`（2026-11-10 03:22）后才更换详情，来源 SKU 搜索保留（URL `snapQ`
  与输入框都仍是该 SKU）。
- 明细分页点第 2 页时 URL 自动带上当前批次，摘要不变；返回当前库存去掉全部 `snap*`，保留
  `q/warehouse/source/view`。
- 上一轮 B1 直接链接/坏批次/切仓 11 项在最终 BUILD 重跑 **11/11 PASS**；新增/更新单测
  `snapshot.test.ts` **15/15**（含「未指定 vs 明确第一页」「沿用实际查看批次」）；`tsc` 仅既有 BEST 5、
  改动文件 eslint 0、`git diff --check` 0。B2、210 批场景与布局证据继续沿用，未重跑。

### 6.7 最终独立复核（2026-11-16）

最终独立复核报告 [independent-review-r3.md](../../.local/catalog/inventory-snapshot-20261116/reviewer/independent-review-r3.md)
结论 **INVENTORY_SNAPSHOT_V1_LOCAL_PASS**、独立复核 PASS、阻断 0，B1/B2 全部关闭，完成本机历史快照查询包验收。

- 复核对象为现役 `run-20261026T211500Z-11a22b33`（3011/59345）、BUILD `S1prE-Z5-Gb9BRJNwaKIT`、
  源码快照 `f19186de20ab2a3f…`；独立核对 `page.tsx`、`model.ts`、`inventory-snapshot-view.tsx`、041 SQL
  当前 SHA256 与 ready 构建源码清单，4/4 一致。
- 复核方自写 Playwright 探针实点 7 项集中检查全部通过、console/pageerror 0：第 61 批直链 2/4 →
  「更新批次」回 1/4 且详情仍是该批；默认最新翻列表 2/4 再回 1/4 详情完全不变、链接补齐真实 batchId；
  第 2 页点第 62 批才换详情且 `snapQ` 保留；明细分页沿用当前批次；返回库存去掉全部 `snap*`
  并保留 q/warehouse/source/view。
- 代码审阅确认 `snapBPage` 0=未指定 / 1=显式第一页、`snapshotViewedBatchId()` 将实际批次用于搜索/清空与
  列表/明细分页；无明确 batchId 但带后页的直链仍读最新批次；本次范围内无新的确定阻断项。
- 复用边界：B1 无效批次/错仓不替换数量已在二轮页面复核通过；210 批完整可达性沿用已审阅临时实例证据；
  B2 沿用二轮标准准备链/迁移哈希/app 角色读取证据；本轮未重建临时实例、未重跑全套测试。

## 7. 可照着核对的真实例子

仓库：**DEE-龙仔厝（ICE专属）**（`4d6821a7-4439-4913-98d5-bd787b8fb5bd`，外部仓 56673，市场待确认）。
来源 SKU **`6974674957332`** → **WM0094**（映射 v1 · 商品版本 2）。

| 批次 | 观测时间（+08） | 批次 ID | 本批行数 | 实物 | 锁定 | 仓库可用 | 单位 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 最新 | 2026-11-12 16:22:18 | `13dd11d1-54fa-45c5-95ff-2f3cfa85f1e3` | 144（已绑 101 / 未绑 43） | **139,887** | **723** | **139,164** | 个 |
| 上一批 | 2026-11-12 15:22:22 | `a94b8e5c-9b68-4330-892a-b6c31645312b` | 144（已绑 101 / 未绑 43） | **140,177** | **881** | **139,296** | 个 |

页面操作：历史快照 → 仓选「DEE-龙仔厝（ICE专属）」→ 左栏选 `2026-11-12 16:22` → 搜索 `6974674957332`；
应显示上述最新批次四个数字；再点 `2026-11-12 15:22` 批次，搜索词保留、数字变为上一批四列。

其他核对点：

- **当时未绑定**：同一最新批次搜索 `780103214237`（原文件第 4 行）→ 商品归属「未绑定商品」，
  实物/锁定/仓库可用 `0 / 0 / 0`，单位「未提供」（批次行为 `item_id=null`、`unit=null`）。
  另有数量不为 0 的未绑定 SKU `0000`（原文件第 57 行）→ 实物 **1,494** / 锁定 **0** / 仓库可用 **1,494**、
  单位「未提供」，商品归属「未绑定商品」。
- **真实零**：上述 `780103214237` 的 `on_hand=0` 显示 `0`，不是「未提供」；已绑定且为 0 的行
  `757577983006`→WM0024（原文件第 31 行）页面显示 `0 / 0 / 0`、单位「个」，映射 v1 · 商品版本 2。
- **本批未见**：在任一批次搜索 `__NO_SUCH_SKU__` → 「本批未见」。
- **分页**：该批 144 行，第 2 页 50 行、`snapPage=2`；第 3 页 44 行。

数据库复核 SQL（owner 只读）：

```sql
SELECT b.observation_at, r.external_sku, r.on_hand, r.order_locked, r.warehouse_available, r.unit
FROM catalog.inventory_batch b
JOIN catalog.inventory_batch_row r ON r.batch_id = b.id
WHERE b.id IN ('13dd11d1-54fa-45c5-95ff-2f3cfa85f1e3',
               'a94b8e5c-9b68-4330-892a-b6c31645312b')
  AND r.external_sku IN ('6974674957332', '780103214237', '0000', '757577983006')
ORDER BY b.observation_at DESC, r.excel_row;
```

## 8. 边界与仍有的实际问题

- **批次列表可达**：单仓批次列表按 50 条/页分页，页脚显示「第 a–b 个 · 共 N 批」并可翻更早/更新；
  现役每仓 186 个全部可选；临时库 210 个时第 201–210 个可从页面选择，直链与页面选择同一批。
  单次 RPC 上限仍是 200 条/页，但页面不再有「超过 200 不可选」的截断。
- **数据时点**：本次只启动 PostgreSQL 与 Web，未启动库存 worker / 物流读取 / 飞书来源读取；
  页面显示的是数据库里已发布的批次，最新观测时间停在 **2026-11-12 16:22:18**。
  启动自动同步后才会出现新批次（未在本轮验证）。
- **市场为空**：「DEE-龙仔厝」仓库没有市场证据，页面写「市场待确认」，不猜国家。
- **搜索范围**：按需求只搜来源 SKU；不搜 ICE 货号/品名，搜货号会得到「本批未见」。
- **缺失数量**：现役 121,257 条批次行的三个数量列都非空，因此页面的「数量缺失→未提供」目前只有
  单测覆盖，没有真实 null 数量样本；单位缺失有真实样本（未绑定 SKU）。
- **历史品名回退**：若批次行 `item_revision` 对应的历史修订不存在，品名回退到当前版本；
  货号仍按商品 UUID 身份读取。页面同时显示商品版本号，便于识别。
- **表权限现状**：app 角色本来就对 `inventory_batch`/`inventory_batch_row` 有 SELECT（既有状态），
  041 没有新增表权限；页面读取仍只经 RPC。
- **未做**：金额/货值、导出、跨仓合计、权限矩阵、200% 缩放、多日稳定性；
  独立复核提出的 B1/B2 已修复并关闭，本包独立复核 PASS。
- **现场清理**：启动前发现上一轮遗留的 `preview-server.json` 指向已退出进程（pid 41744）；
  将该文件改名为 `preview-server.json.stale-20261116` 后按标准流程重建/启动，未改业务数据。

## 9. 现场与证据

- 实例：`run-20261026T211500Z-11a22b33`；Web 3011（launcher pid 63200 / listener 65020）；PostgreSQL 59345（pid 64120）。
- BUILD：`S1prE-Z5-Gb9BRJNwaKIT`；源码快照 `f19186de20ab2a3f…`；`preview-build-ready.json` /
  `next-workspace-manifest.json` / `.next/BUILD_ID` 三处一致；3011 login 200。
- 临时实例（B2 标准准备链 + B1 210 批场景）：`run-20261116T040500Z-b1f10002`；验证完成后已停止
  （Web 3037 与 PostgreSQL 51074 均已关闭），不占用现役端口。
- 证据目录：`.local/catalog/inventory-snapshot-20261116/`（`b1-page-state.json` 10/10、
  `b1-live-page.json` 11/11、`verify.json` 26/26、`b1-temp-page.json` 17/17、`b1-temp-seed.json`、
  `apply-041.json` 28/28、`apply-041-commit.json` 27/27、截图），不入 Git；
  复核报告 `reviewer/independent-review.md`（首轮）、`reviewer/independent-review-r2.md`（第二轮）
  与 `reviewer/independent-review-r3.md`（最终 PASS）。
- 数据库只读回读：`041` 已提交到现役库；验证前后业务行数一致
  （items 126 / revisions 233 / codes 125 / batches 1302 / batchRows 121257 / current 512 /
  mappings 517 / audits 42；与上一轮记录的 226/41 不同是两轮之间现役业务活动，本包只读）。