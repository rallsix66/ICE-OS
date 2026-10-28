# 飞书商品来源接入 v1（本地模拟读取 + 统一处理链）

状态：`FS_CATALOG_SIM_LOCAL_PASS`（主审独立验收通过 2026-10-25；三项定向补修见 §4A；收尾摘要见 [feishu-product-source-v1-closeout.md](./feishu-product-source-v1-closeout.md)）。本包只在独立本地实例内演练，不接真实飞书 API、不写回飞书原表、不修改现役 126 商品与 BS 530 行。**通过范围仅限本地模拟接入**，不代表真实 API 接通、生产启用、旧 UI/性能延期项或整个 ICEOS 全面通过。

## 1. 来源与真实快照

| 项 | 事实 |
|---|---|
| 文档 | 飞书 wiki 节点 `TC2AwLgRniqWKhkg9D2cEx79n0b`（标题“ICE产品库”，所有者侧显示“鼎潮（厦门）供应链管理有限公司”；页面标注最新修改时间为10月20日） |
| spreadsheet_token / sheet_id | `EMZGs2eIhh0YQ1tPIqMcR8SPnQh` / `33bab4`（用户已确认；匿名只读网页无法独立复核，本轮未由 API 复核） |
| 工作表 | `Sheet1`（唯一工作表） |
| 采集方式 | 匿名公开只读网页（页面显示“登录/注册”“只能阅读”）：名称框选择 `A1:AE404`，Ctrl+C，读取剪贴板文本；采集时间 2026-10-25T03:58:00Z–03:58:26Z |
| 网格 | 404 行 × 31 列；表头行 1；A–AA 共 27 个有文字表头；AB–AE 无表头且无数据 |
| 有效业务行 | 131 行（B 列非空）；完全空行 272 行；数据行合计 403 |
| G 列编号 | 非空 130 行、唯一编号 125 个；`WM0069`–`WM0073` 各 2 行；第 122 行无编号（名称 `ICE LERSKIN 烟酰胺提亮精华水150ml`） |
| 与现有商品库关系 | 125 个唯一编号与现有 126 商品库的 125 个已编码货号完全一致；无来源独有或库独有编号 |
| 原始快照 | `.local/catalog/fs-catalog-sim-20261025/capture/run1/clipboard.raw.tsv`（34,749 B，sha256 `89e265f549ecc4f6badcf8b2f6d6e05956ecfe701dc4141771f5416dc2e63b6f`，含受限价格列 I/J/Y，不入库） |
| 仓库脱敏 fixture | `tests/catalog/fixtures/product-source/snapshot-001-redacted.json`（I/J/Y 置空并标记 redaction，其余字段为真实快照派生，snapshotKey `f0ab3cba…`） |

采集缺口：本轮没有飞书开放平台应用凭据，未开通 API 同步；若未来 API 可用，只需替换读取入口，后续处理链不变。真实来源的全表验收以本次匿名只读复制结果为准，**不代表**飞书 API 已接通或生产启用以发生。

## 2. 字段规则（按表头文字定位，列字母只作本次证据）

| 表头原文 | 列 | 字段键 | 采用与单位 |
|---|---|---|---|
| 日期 | A | （仅证据，不写入商品字段） | 静态日期，不当作来源版本或修改时间 |
| 中文产品名称 | B | nameCn | 原文（去首尾空白） |
| 规格 | C | specification | 原文保留，不换算 g/ml、不映射“包装” |
| 英文名称 | D | englishName | 原文 |
| 生产工厂 | E | factory | 原文 |
| 产品图片 | F | imageRef（不采用） | 文本剪贴板读不到图片：`not_read / IMAGE_NOT_READ_BY_SNAPSHOT`；保留现有图片，新品如实未取得 |
| 聚水潭内部货号 | G | iceCode（身份） | 字符串；不丢前导零；允许非 WM 格式（本次有 LS…、brush） |
| 69商品编码 | H | barcode | 字符串；保留前导零 |
| 成本价格 / 运营价格 / 单品运费（自由计算列） | I / J / Y | 受限来源证据 | 只存 `catalog_private.product_source_row_amounts`；不进入商品字段、差异计划、待核对明细或页面 |
| 备注 | K | sourceNote | 原文保留 |
| 长/宽/高(单产品/cm） | L/M/N | length/width/height | 表头明确 cm（confirmed），原值不换算 |
| 单个产品重量(kg） | O | unitWeight | 表头明确 kg（confirmed） |
| 装箱数量 | P | cartonQuantity | 正整数校验（件/箱） |
| 装箱长/宽/高 | Q/R/S | cartonLength/cartonWidth/cartonHeight | 表头无单位：`unitState=unconfirmed`，保留原值/来源原文并待确认，不反推 cm，不写商品 |
| 单箱重量 | T | cartonWeight | 表头无单位：unconfirmed，不写商品 |
| 是否液体 | U | liquid | 原文 |
| 有效期（天数) | V | shelfLifeDays | 天（confirmed） |
| 单箱立方 / 单瓶立方 | W / X | cartonVolume / unitVolume | 表头无单位：unconfirmed，不换算，不写商品 |
| 工厂生产货期(天） | Z | factoryLeadDays | 天（confirmed） |
| 运输时间（海运预估） | AA | shippingDays | 天，仅静态商品资料 |

**单位未确认字段的采纳规则（三项补修之一）**：cartonLength/cartonWidth/cartonHeight/cartonWeight/cartonVolume/unitVolume 一律不 adopt、不写商品，**已有商品本地为空时不采用，新品也不直接采用**；来源非空且与本地不同/本地为空时生成 `unit_unconfirmed` 待核对项并保留 `sourceRaw`，其他有效字段照常按计划处理。来源显式为空、或本地与来源相同时不产生待核对项。`cartonQuantity` 等 confirmed 字段不受影响。

数值比较使用容差（绝对 1e-9 或相对 1e-5），避免 `8.50285714285714e-05` 与 `0.000085029` 这类显示精度差异产生虚假修订；不同时采用来源原文，不做单位换算。

## 3. 处理链

读取本地快照 → 表头/完整性校验 → 字段归一化 → 编号分组与异常分类 → 三方差异计划 → 受控应用（单事务）→ 商品修订/历史/回执 → 页面更新。

- **统一读取接口**：`ProductSourceReader`（`createLocalSnapshotReader` / 未来 `createFeishuApiReader`）。未来 API 只替换读取入口。
- **编号身份**：固定来源文档＋工作表＋G 列稳定编号；沿用商品 UUID；名称、条码、行号、图片都不是主键。
- **同号多行**：先分组；同号各行可采纳字段（含空 vs 非空）严格一致才合并为一个逻辑输入，并保留全部原始行证据；不一致或无法确定当前版本 → 该编号待核对，不取第一/最后/日期最大行。
- **首轮基线**：为每个已存在编号建立来源对应与“上次采用的来源值”；本地无值 → 采用来源；本地有值且相同 → 仅记基线；本地有值且不同 → 保留本地并待核对。单位未确认字段除外（不采用、不写，见 §2）。
- **后续三方比较**：来源≈基线 → 无变化（保留本地单方修改）；本地≈基线或本地无值 → 采用来源；本地≈来源 → 不追加修订（趋同）；双方都改且不同 → 保留本地、待核对，其余无冲突字段继续处理。单位未确认字段始终不写。
- **新品**：编号非空无冲突、中文名称有效、快照完整、字段校验通过（装箱数量等）才在隔离库建档；不伪造价格、库存或 BS/JST 对应；图片未取得如实标注；未确认单位字段不写入新品，但保留来源原文与待核对项。
- **缺码/疑似改码**：缺码行只进入待核对，不以名称自动建档或合并；已有缺码商品补号必须保留原 UUID（显式“补号”动作）；来源编号与现有商品条码/名称关系相近但编号不同 → 疑似改码待核对，不自动换号或建档。
- **空值与异常**：区分空白、明确空串、未读取、解析失败与公式错误（`#N/A`/`#DIV/0!` 等）；空白/读取失败不覆盖现有非空资料；公式/数值解析失败不采用该字段。
- **本次未见**：来源行消失只标记“本次未见”，不删除商品、不解绑来源、不清零库存。
- **批次**：同一快照幂等（不重复建商品/追加修订）；旧快照早于最近成功批次拒绝；每批逐项结果，部分失败显示为部分完成；每商品资料、当前版本、历史、采用基线与回执在同一事务内完成。
- **恢复链**：区分“已知部分失败补做”和“提交结果未知的原请求核对”。前者只重新计划父批次中 failed 的 sourceKey，成功商品不在结果中、不重复修订，新批次以 `retryOfBatchId` 关联父批次；后者在提交前把原请求与完整意图写入 `catalog_private.product_source_request_intent`，按原 requestId + 原 intent + 原载荷重提，返回原回执，**不因重新生成计划造成 `CATALOG_REQUEST_CONFLICT`**。

## 4. 本地模拟变化（非飞书真实修改）

模拟快照基于真实快照副本生成，标记 `origin: local_simulation` 与变化清单（`.local/catalog/fs-catalog-sim-20261025/run/source-snapshots/simulation-changes.{json,md}`）：

- snapshot-002：`LS101274` 装箱数量 80→100、`LS101275` 改名（UUID 不变）、`LS101501` 规格变化、新增合法行 `WM9001`、`LS101276` 编号被清空（缺码）、`LS101295` 改为 `WM9101295`（疑似改码）、`LS101302` 单箱立方公式错误、`WM0003` 工厂清空、`LS101505` 单箱重量变化（单位未确认）、`LS101311` 装箱数量改为 `abc`、`WM0004` 增加不一致重复行。
- snapshot-003：在 002 内容基础上整体反转行顺序与列顺序（验证按表头/编号匹配，不产生虚假修订）。
- snapshot-004（验收现场生成）：`LS101274` 工厂改为“来源冲突工厂”、装箱数量 100→120；`LS101275` 名称改为与本地编辑相同的“本地收敛名称”；`LS101501` 规格变化 → 演示“本地修改冲突不被覆盖”“同值不追加修订”。
- snapshot-005（补做演练）：`LS101501` 规格并发变更、`LS101274` 装箱数量再变；用过期 expectedRevision 制造单项失败。
- snapshot-007（合成价格/列重排）：价格表头与 L/M/N 互换并写入非空合成价格，I/J/Y 保留普通文本；用于验证“按表头映射剔除公共价格、私有金额语义键正确”，不写入仓库。
- snapshot-006/010（恢复演练）：不同字段变更 + 原请求 draft/replay，用于验证提交结果未知时的原回执核对与重建计划冲突反例。

## 4A. 三项定向补修（2026-10-25）

| 项 | 修复后行为 | 定向验证 |
|---|---|---|
| 单位未确认字段 | 已有商品本地为空/不同、新品均不 adopt/write；保留 `sourceRaw` + `unit_unconfirmed` 待核对；其他字段照常；来源空/本地同值不产生待核对 | 真实快照 0 条未确认字段被 adopt/write；`WM9001` 新建 6 条待核对、0 个未确认字段进入修订；`WM9001` 后续来源值仍不写；`LS101505` 来源单箱重量变化只待核对；`cartonQuantity` 80→100/120 正常写修订 |
| 恢复链 | 已知部分失败只补做父批次 failed sourceKey，新批次 `retry_of_batch_id` 关联父批次，成功商品不再进入计划；提交结果未知时用提交前保存的原 requestId + intent + 完整载荷重提，返回原回执，不因重新生成计划报冲突。页面动作返回结构化 `outcomeUnknown`（仅未知提交，不与确定失败混同），组件保留原 requestId/操作信息并锁住新操作，核对成功后再解除 | 并发失败 1 项 + 成功项批次 partial；UI“补做失败商品”生成 retry 批次，仅含 `code:LS101501`，失败项修订恢复、成功项 `LS101274` revision 不变；原请求 draft 重放回执与首次一致；重建计划的新 intent 被 `CATALOG_REQUEST_CONFLICT` 拒绝（证明必须用保留的原意图）；浏览器响应丢失演练中原请求保留、按钮禁用、核对沿用同一 requestId 取得原回执后恢复 |
| 金额隔离 | 公共来源行按 `collection.headers` 表头文字定位价格列并剔除，不依赖固定 I/J/Y；私有金额改语义键 `costPrice/operatingPrice/shippingPrice`，列重排后仍按表头对应 | 原列序：公共行 28 列、无 I/J/Y 价格键、无来自受限列的意外值（6 处同一行其他列数值与价格数字巧合，已核对同列来源一致）、私有 130 行金额与来源映射 0 差异；列重排（价格列 L/M/N、I/J/Y 普通文本）：公共行无价格、I/J/Y 普通值保留 100 行、私有 403 行语义金额 0 差异；`overview`/`itemState`/回执无价格值或语义金额键 |

## 5. 隔离实例与复现

修复轮独立实例：`run-20261025T053500Z-f5a00007`（独立 PostgreSQL 实例/数据库端口 59883；预览 3022；BUILD 与构建源哈希以 `<run>/instance/preview-build-ready.json` 和 `repair-20261025/guards.json` 为准，构建源哈希与当前仓库一致、drift=false），不触碰现役 3011 预览与其数据库。

```powershell
# 1. 独立实例（首次会建库、应用 001–002 与 009–015、灌入 126 商品基线）
node scripts/catalog/prepare-local-preview.mjs --run-id run-<fresh>

# 2. 生成/复制来源快照到 <run>/source-snapshots
#    真实快照与模拟快照由 scripts/catalog/feishu-source/*.mjs 生成（原始 TSV 只在 .local）
node scripts/catalog/feishu-source/build-snapshot.mjs
node scripts/catalog/feishu-source/build-simulations.mjs

# 3. 构建/提升/启动独立预览（端口 3022，不与 3011/3021 冲突）
node scripts/catalog/build-preview-workspace.mjs --run-id run-<fresh>
node scripts/catalog/promote-preview-build.mjs --run-id run-<fresh>
$env:CATALOG_PREVIEW_PORT='3022'; node scripts/catalog/start-local-preview.mjs --run-id run-<fresh>
# 打开 http://127.0.0.1:3022/dashboard/catalog/sources
# 登录 admin@catalog.test / CatalogAdmin123!（密码文件在 instance/login.local-preview.txt）
```

页面：`/dashboard/catalog/sources` 底部“飞书商品来源（本地模拟）”面板（来源名称与本地模拟状态、最近采集/更新结果、六项计数、逐项变化原值→新值、待核对清单与重试入口）；商品详情/变更记录复用现有商品库（来源采用的字段会新增修订并显示修改前后）。

## 6. 实现位置

- 纯逻辑：`src/features/catalog/product-source/{contract,headers,normalize,grouping,anomaly,diff,plan,reader,local-reader,api-reader,simulate}.ts`
- 服务/动作：`src/features/catalog/product-source/{service,repository,actions,schema,server-types,panel-types}.ts`；`service`/`repository` 增加提交前原请求意图保存、原回执核对与“只补做失败项”分支。
- 数据库增量：`db/catalog/015_product_source_sync.sql`（8 张 `catalog` 表 + 1 张私有价格表 + 1 张私有原请求意图表、FORCE RLS、SECURITY DEFINER 应用/核对函数、按表头映射价格剔除、补做批次与部分唯一索引、只读投影；不修改 001–014）。
- 页面：`src/app/dashboard/catalog/sources/page.tsx`、`src/features/catalog/components/product-source-panel.{tsx,module.css}`、`src/features/catalog/product-source/panel-recovery.ts`（结果未知保留原请求/锁新操作；确定失败释放）。
- 快照工具：`scripts/catalog/feishu-source/{build-snapshot,build-simulations,ts-loader}.mjs`
- 测试：`tests/catalog/product-source.test.ts`（纯逻辑/脚本 62 项）、`tests/catalog/product-source-recovery.test.ts`（服务恢复链 5 项）、`tests/catalog/product-source-db.postgres.test.ts`（隔离 PG 16 项）

## 7. 未覆盖 / 待确认

- 未开通飞书 API，未验证真实 API 的权限、分页、限流、token；本轮“真实快照”为匿名只读网页复制。
- spreadsheet_token / sheet_id 来自用户确认，未由 API 独立复核。
- 图片列在文本剪贴板中没有内容，图片内容与对象存储未核验。
- 外箱尺寸/重量/体积单位未在来源表头明确，按“保留原值＋待确认、永不自动采用（含本地为空/新品）”处理，未做换算。
- 真实 200% 缩放、浏览器兼容矩阵未做；本地模拟变化不是飞书侧真实修改。
- 价格为原表序与一次合成列重排两种验证；合成价格只用于隔离测试，未使用真实价格做展示。
- 本包不开发库存同步、物流、估值、费用分摊，不改变现役 126 商品与 BS/JST 对应。
