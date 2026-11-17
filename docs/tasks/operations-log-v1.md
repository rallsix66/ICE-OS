# 操作记录 v1（R1–R5 补修 + 页面优化）

- 日期：2026-11-17
- 分支：`codex/operations-log-v1`（承接 2026-11-16 初版 `9aac123`）
- 实例：`run-20261026T211500Z-11a22b33`（Web 3011 / PostgreSQL 59345）
- 入口：<http://127.0.0.1:3011/dashboard/operations>
- 登录：`admin@catalog.test`（密码见实例 `login.local-preview.txt`，不入 Git）
- 最终 BUILD：**`4gZ0zjpGDrnR58RpmYOQr`**（源码快照 `c926430a75a9c020…`，promote → start、login 200）
- 证据：`.local/catalog/operations-log-r2-20261117/`（`verify.json`、`layout-r2.json`、`fixtures.json`、`apply-042*.json`、截图 01–11）

本轮把 R1–R5 的数据补修与操作记录页 UI 优化作为一个交付包完成；最终是否通过仍由审查方确认，执行方不宣布 PASS。

## 1. 本轮目标

| 编号 | 问题 | 本轮结果 |
| --- | --- | --- |
| R1 | 新版本删除整个字段键时漏显示；`previous_revision` 被误判成首版 | 字段差异按新旧键并集比较；上一版本按实际解析到的历史行判断 |
| R2 | 搜索只取同次操作中一个货号/名称；原 SKU 替换把 warehouseId 当 mappingId | 搜索覆盖同次操作全部货号/名称/来源 SKU/货票号；替换按已保存 detail 读取 |
| R3 | 历史批次只展示前 40 款且无后续；旧批次入口跳到最新批次 | 批次明细全部可达、20 款一段；删除误导入口 |
| R4 | 撤销事件只在原决定行里显示、按撤销时间查不到；pending 复核混入 | 撤销成为独立记录；分组只纳已处理决定；不再统一解释 superseded |
| R5 | 选类别后「全部业务」跟着变成当前类别数；读取失败显示 0 | 全部业务 = 三类之和；失败/日期无效显示「—」 |
| UI | 首屏说明多、筛选散、动作列宽、展开先看技术信息、760 堆叠 | 说明折叠、工具栏成组、对象与结果优先、字段变化/入口跟随商品、来源信息折叠、窄屏重排 |

## 2. 数据补修

### R1 删除字段与前值判断

实际样例 WM0073：第 2 版保存商品条码 `757577407359`，第 3 版 `previous_revision=2`，但 `fields` 里整个 `barcode` 键被删除。

- 042 对 `item_revision.fields` 与解析到的上一版本 `fields` 取**键并集**，逐个字段给出 `changeKind=added|removed|modified`、`beforePresent/afterPresent` 与已保存的 `beforeRaw/afterRaw`；
- 页面把 `removed` 显示为「商品条码：757577407359 → 已移除」；`added` 的前值写「历史未保存」；两端都有键但值为空写「未填写」；
- `previousRevision` 改为实际解析到的上一行版本（`pv.revision`），并保留 `declaredPreviousRevision`；只有确实找不到上一行才标 `item_baseline`；
- 首版说明「没有上一版本」；声明了上一版但历史行缺失时说明「历史里找不到该版本」，不用当前值补。

### R2 搜索文本与原 SKU 替换

- 物流人工关联：同一 `(recorded_at, actor_id, method, shipment)` 合并为一条，搜索文本改为 `string_agg(DISTINCT ...)` 覆盖该次保存的**全部** `product_name_raw / source_sku / ice_code / name_cn / previous_*`，再加货票号、市场与原因；
- POKNZX027675（2026-11-06 14:34:45）涉及 WM0057、WM0058、WM0059、WM0061、WM0089、WM0090、WM0091：七款分别搜索都命中同一条关联，明细仍是 7 条；
- `replace_inventory_mapping` 的 `audit.entity_ref` 实际是 warehouseId。042 改为读取 `detail.oldMappingId / newMappingId / oldExternalSku / newExternalSku / itemId / newVersion / effectiveAt / warehouseId`，并从 `inventory_warehouse` 与 `inventory_sku_mapping` 补仓库名、单位、备注；不再用 `entity_ref` 关联 mapping；
- 现役没有替换记录，已用事务内隔离样例验证正常写入路径（§6.3）。

### R3 历史批次明细

- SQL 返回批次写入/失败的全部 `results`，并带 `resultRowCount`；页面不再截断 40 条；
- 展开后每 20 款一段，显示「已显示 N / 共 94 款」；可「再显示 20 款」或「显示全部 94 款」；
- 4173cf60-dd81-4b1b-a0f2-f84674f0ac99 第 41 款 WM0054 可达，显示 `生产工厂：历史未保存 → 广州圣宝兰生物科技有限公司`；
- 删除「查看本批更新结果」（它指向最新批次，无法定位历史批次）；保留通用入口「打开来源资料处理页」，并在展开里说明本页已保存本批全部明细。

### R4 撤销事件与人工含义

- 字段口径撤销：`product_source_field_decision.revoked_at` 非空即新增 `source_field_decision_revoked`，时间取实际撤销时间，账号优先取 `restore_source_field` 审计；原决定仍保留在 `decided_at`，撤销记录写明原决定时间/字段/值/撤销说明；
- 来源行选择撤销：`state='superseded'` 且有 `superseded_at` 即新增 `duplicate_source_decision_revoked`，一条决定只对应一条撤销记录（`restore_duplicate_source_decision` 的两条审计不会重复计数）；撤销账号取审计，没有审计时写「历史未保存」；
- 实际样例 LS101501：12:36:38 的人工覆盖原决定 + 14:44:50 的撤销记录；14:40–14:50 查询能看到撤销，且不把撤销时间写回原决定；
- 4 条同号选择：原决定（12:36:38）+ 4 条独立撤销（14:44:50），撤销说明使用已保存备注「撤销脚本代选：无真实人工确认记录，恢复待人工确认」；
- `superseded` 不再统一写成「没有真实人工确认 / 重新回待处理」：原决定只写「已被后续操作撤销」，撤销记录按是否有撤销审计区分「撤销」与「被后续选择替代」；
- `shipment_grouping_review` 只取 `status='resolved' AND resolved_at IS NOT NULL AND resolved_by IS NOT NULL`；自动生成、pending 未处理的复核不计入人工操作（隔离样例验证）。

### R5 分类计数

- 042 的 `categoryCounts` 始终返回 `catalog/inventory/shipment` 三个键，口径与搜索/日期/账号一致、不受当前类别影响；
- 页面「全部业务」= 三类之和（365）；当前列表数 = 当前类别结果（商品资料 152 / 库存对应 100 / 物流 113）；
- 读取失败或日期无效时没有执行查询，类别计数显示「—」，不显示 0；成功查询且确实为空才显示 0。

## 3. 修正后的真实记录

| 类别 | 条数 | 构成 |
| --- | --- | --- |
| 商品资料 | **152** | 来源采用 3（按批次）、补货号/初始补号/纠正测试货号/关闭缺货号 4、来源行选择 4、来源行选择撤销 4、字段人工口径 9、字段口径撤销 1、历史修订与首版 127 |
| 库存对应 | **100** | 确认 90、换绑 5、国内复核 5；重核/停用/原 SKU 替换现役 0 条（路径已覆盖） |
| 物流 | **113** | 人工关联 90、清除关联 15、人工修正 3、恢复按原表 2、分合票决定 3（均已处理）；撤销分组 0 |

合计 **365 条**，与数据库独立重算一致。来源采用仍按批次一条，批内商品修订只在展开里；同一次物流保存仍合并一条。

## 4. 只读查询（042）与准备链

`db/catalog/042_operation_records.sql` 仍只有一个只读函数（不建表、不改 001–041、不新增写链）：

```sql
catalog.read_operation_records(
  p_category text, p_actor uuid, p_from timestamptz, p_to timestamptz,
  p_search text, p_limit integer, p_offset integer
) RETURNS jsonb
```

本轮变化：

1. 修订差异改为键并集 + `changeKind/presence`；
2. 批次返回全部明细与 `resultRowCount`；
3. 物流关联搜索覆盖全部相关商品；原 SKU 替换按 detail 读取；
4. 新增字段口径撤销、来源行选择撤销两条记录路径；
5. 分合票只取已处理决定；
6. `categoryCounts` 始终三键，口径与筛选一致。

`SECURITY DEFINER` + `search_path=''` + `STABLE` + `catalog.require_admin()`；app 角色可执行、PUBLIC 不可执行。

- `apply-042.mjs --rollback` **38/38**，`--commit --allow-live-commit` **38/38**；
- 两次安装幂等、单一重载、权限、未登录拒绝、全量 365 = 独立重算、分类计数、排序、id 唯一、三类真实样例、R1/R2/R3/R4/R5 定向、业务行数前后不变、rollback 回到安装前；
- 标准准备链仍为 `prepare-instance.mjs` 在 041 之后安装 042、`prepare-local-preview.mjs` 依赖表就绪时就地补齐（本轮未改链顺序）。

## 5. 页面与 UI

- **首屏**：标题下一句用途说明；记录范围/账号含义/时间口径收进默认折叠的「记录说明」；错误提示只写问题与恢复动作；
- **工具栏**：搜索（≥300px）、记录账号、起止日期（同一组相邻）、清空同组；移除「最多 80 字符」常驻小字，时间口径只出现一次；类别页签计数与当前结果数分别标明；
- **列表**：时间/账号、业务对象与动作、处理结果、详情；动作标签在对象单元格内按文字宽度显示；货号、来源 SKU、货票号完整换行显示，不再 14 字符截断；UUID/快照哈希不进入摘要；
- **展开**：先显示结果句，再显示业务事实；同一商品的字段「修改前 / 修改后」与商品/库存入口放在同一明细；明细 20 条一段；批次号/快照/请求号收进默认折叠的「来源信息」；查看/收起切换文字 + 方向图标；
- **窄屏 760**：摘要按「对象+动作 / 结果 / 时间+账号」重排，详情表格在容器内滚动，整页无横向溢出；
- **入口**：商品 → `/dashboard/catalog/<id>`；货票 → `/dashboard/in-transit?ticket=<id>`（无 id 时按票号搜索）；批次 → `/dashboard/catalog/sources`（准确名称，不再声称定位到某个历史批次）；返回保留 URL 上的筛选与页码。

## 6. 验证（执行方自验，不代表 PASS）

### 6.1 页面（3011，BUILD `4gZ0zjpGDrnR58RpmYOQr`）**38/38**

`verify-r2.mjs` → `verify.json`，console/pageerror 0：

- 首屏说明折叠、无 80 字提示、时间口径一次、工具栏成组、默认列、查看/收起、来源信息折叠；
- R5：全部业务 365、商品资料当前 152、库存对应当前 100、其它类别计数不变、日期反向显示「—」；
- R1：WM0073 第 3 版「上一版本 第 2 版」「商品条码 757577407359 → 已移除」、不出现首版说明；
- R2：七款货号分别搜索都命中 POKNZX027675 同一条关联、明细 7 条；
- R3：4173 批次 94 款、20/60/94 分段展开、第 41 款 WM0054 的工厂变化、无「查看本批更新结果」、来源入口准确；
- R4：LS101501 撤销在 14:44:50 独立显示、原决定时间 12:36:38 保留；WM0069 原决定与撤销各一条、说明使用已保存备注；
- 完整编号显示、UUID 在摘要不可见、来源信息展开后可见；
- 商品/货票入口返回保留筛选；第 2 页进入商品返回仍在第 2 页；
- 760：无横向溢出、摘要 grid areas 为 object/result/time、长品名与分段入口可读；
- 读取失败：临时回收 EXECUTE 后显示失败与「重新读取」、计数「—」、无分页；finally 恢复授权并复核 `app=true/public=false`；
- 无结果、第 8 页 15 条、只读（验证前后 audit 42 / revisions 233 / inventory_audit 4285 / grouping 3）。

### 6.2 布局 **8/8**

`layout-r2.mjs` → `layout-r2.json`：1440 无整页横向溢出、搜索 625px、起止日期同一行相邻、无 <12px 正文；1440 展开无溢出、来源信息默认折叠、字段表不撑破；760 默认/展开无溢出且操作入口可见；console 0。

### 6.3 隔离样例 **7/7**

`fixtures.mjs` → `fixtures.json`：单事务插入 → 调用 042 → 断言 → ROLLBACK，事后核对业务行数与样例 id 均无残留：

- 原 SKU 替换（entity_ref=仓库，detail 带新旧 mapping/SKU/item/newVersion）：按新 SKU、旧 SKU、货号都能搜索到，展示新旧记录号；
- pending 分合票复核不计入人工操作；已处理决定按 resolved_at 显示；
- 正常重新选行（superseded、无撤销审计）：原决定与「被后续选择替代」分开显示，撤销账号如实写「历史未保存」；
- 隔离样例总数 = 365 + 4（pending 不计）。

### 6.4 迁移与准备链

- `apply-042.mjs --rollback` **38/38**、`--commit --allow-live-commit` **38/38**；
- 现役业务行数前后一致：audit_event 42 / item_revision 233 / source_batch 3 / duplicate_decision 4 / field_decision 9 / inventory_audit 4285 / sku_mapping 517 / association_revision 200 / manual_revision 5 / grouping_review 3 / grouping_override 1；
- 准备链代码核对：`prepare-instance.mjs` 在 041 后安装 042，`prepare-local-preview.mjs` 的 `DEPENDENT_SQL` 仍包含 042 且依赖表齐备时执行。

### 6.5 测试与静态检查

- 定向单测：`src/features/operations/model.test.ts` **31/31** + `navigation-config.test.ts` **7/7** = **38/38**；
- `tsc --noEmit` 仅既有 BEST 5 条（`src/lib/providers/best/__tests__/*`），`src/features/operations` 0 条；
- 改动文件 eslint 0；`git diff --check` 0（仅既有 LF/CRLF 提示）；
- 本轮只改操作记录相关文件，不重跑无关全仓套件；初版全仓结果为 942/943（唯一既有 opt6 换行基线），本轮不把它写成新结论。

### 6.6 截图

`01-overview-1440.png`、`02-range-invalid-1440.png`、`03-r1-removed-barcode-1440.png`、
`04-r3-batch-94-1440.png`、`05-r4-revocation-1440.png`、`06-narrow-760-expanded.png`、
`07-read-failure-1440.png`、`08-layout-1440.png`、`09-expanded-1440.png`、`10-layout-760.png`、`11-expanded-760.png`。

## 7. 明确没有保存 / 本机没有记录

1. **重核、停用、原 SKU 替换**：现役 0 条；页面路径已覆盖，替换的隔离样例见 §6.3。
2. **撤销分合票决定**：现役 1 条 active override（keep_separate），撤销 0 条；路径已覆盖。
3. **字段覆盖前的本地值**：`product_source_field_decision` 没有保存覆盖前值，页面不拿当前商品补。
4. **首版前值**：确实没有上一版本时不存在前值；声明了上一版但历史行缺失时如实说明缺失。
5. **具体操作人**：分合票决定/撤销只有管理员账号；记录账号不等于具体操作人。
6. **4 条同号选择的背景**：脚本代选后撤销，页面用已保存备注原样说明，不冒充真实人工确认。
7. **请购/理由/请求号**：`inventory_audit` 无 request_id 与自然语言理由；物流关联无请求号；页面不展示不存在的字段。
8. **自动同步事件**：库存发布/阶段/导出、物流自动读取、飞书后台同步不进入本页。
9. **pending 分合票复核**：未处理前不算人工操作（隔离样例验证排除）。

## 8. 改动文件

| 文件 | 本轮改动 |
| --- | --- |
| `db/catalog/042_operation_records.sql` | 键并集差异、全量批次明细、全量搜索、替换分支、撤销记录、resolved 分组、三键计数 |
| `scripts/catalog/apply-042.mjs` | 期望总数/分类口径、R1–R5 定向探针、无结果三键 0、证据目录 |
| `src/features/operations/model.ts` | 差异状态、全量明细、分段、计数语义、撤销/替换文案、来源信息、完整编号 |
| `src/features/operations/model.test.ts` | 31 条（R1/R2/R3/R4/R5、计数、分段、入口） |
| `src/features/operations/components/operations-view.tsx` | 首屏、工具栏结构、摘要网格、查看/收起、结果条、失败/无效状态 |
| `src/features/operations/components/operations-filters.tsx` | 搜索/账号/日期成组、清空、单一时间口径 |
| `src/features/operations/components/operation-record-detail.tsx` | 新增：展开内容、来源信息折叠、明细分段、商品内联变化 |
| `src/features/operations/components/operations.module.css` | 列表/详情/窄屏重排、字号与间距 |
| `src/app/dashboard/operations/page.tsx` | 沿用读取与越界回读（未改协议） |
| `docs/tasks/operations-log-v1.md` | 本记录 |

## 9. 边界

- 现役零业务写入；隔离样例全部在事务内 ROLLBACK；读取失败探针临时回收并恢复 EXECUTE；
- 未启动库存/物流/飞书后台 worker；
- 未改飞书、未改各模块写入链、未新增业务表；
- 权限矩阵、200% 缩放、多日稳定性、导出/跨页批量未做；
- 工作区中的 Mac 部署准备改动（README 等）保留未提交；`.local/` 不入 Git；
- 最终结论由审查方给出，执行方不宣布 PASS。
