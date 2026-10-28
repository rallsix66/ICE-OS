# 飞书商品来源接入 v1 — 验收记录（执行方自验 + 主审结论登记）

停止状态：`FS_CATALOG_SIM_LOCAL_PASS`（主审独立验收通过 2026-10-25）。§1–§7 为执行方自验与执行证据原文，**不是**独立复审结论；主审结论与证据分层见 §0 与[收尾摘要](./feishu-product-source-v1-closeout.md)。

## 0. 主审独立验收结论（2026-10-25）

主审已独立验收通过，正式结论 **`FS_CATALOG_SIM_LOCAL_PASS`**。本节只登记已有审查结论，**不是本轮重新执行独立验收**。

| 项 | 值 |
|---|---|
| 验收构建 | `KxK3GCNqcL6oawVAbyL0o` |
| 独立预览 | 3022 |
| 证据根 | `.local/catalog/fs-catalog-sim-20261025/repair-20261025/`（本地证据，不入库） |

证据分层（勿混记）：

1. **主审独立验证**：定向测试、真实组件接线、构建源码一致性及只读数据库核验。
2. **执行方证据**：浏览器响应丢失演练、全仓检查与写入演练（下方 §3A R6、§4；原始材料在证据根）。
3. **历史证据**：旧 3021 实例 `run-20261025T074500Z-f5a00006` 与全部旧记录保留，不覆盖、不改写。

主审最后确认：**555 个构建文件与源码及运行目录一致**；未知结果恢复使用**同一 requestId**，数据库只有**1 个批次、1 条回执**。

## 1. 实例与环境

| 项 | 值 |
|---|---|
| 独立 run | `run-20261025T074500Z-f5a00006`（独立 PostgreSQL 实例/数据库/端口，未触碰现役 3011） |
| 预览地址 | `http://127.0.0.1:3021/dashboard/catalog/sources`（pid 见 `instance/preview-server.json`） |
| BUILD | 以 `<run>/instance/preview-build-ready.json` 的 `buildId` 为最终构建凭据（构建源码快照与仓库一致；docs 不入编译产物） |
| 登录 | `admin@catalog.test / CatalogAdmin123!`（`instance/login.local-preview.txt`，不入库） |
| 账号与库存基线 | 126 商品（125 编码 + 1 缺码）、BS 展示 530 行 |
| 证据根 | `.local/catalog/fs-catalog-sim-20261025/`（capture/、evidence/e2e-1-f5a00006、e2e-2-f5a00006、evidence/screenshots、guards.json） |
| 修复轮实例（2026-10-25 三项补修） | `run-20261025T053500Z-f5a00007`，独立 DB 端口 59883，预览 `http://127.0.0.1:3022/dashboard/catalog/sources`；BUILD/pid 以实例 `instance/preview-build-ready.json`、`instance/preview-server.json` 为准；构建源哈希与当前仓库一致、`repoSourceDrift=false`（见 `repair-20261025/guards.json`）。旧 3021 实例与证据保留未改写。 |

## 2. 来源快照事实

- 匿名公开只读网页，名称框 `A1:AE404` + Ctrl+C；页面“登录/注册”“只能阅读”，最新修改时间显示 10 月 20 日。
- 404 数据行（表头 1 行 + 数据 403）；31 列；A–AA 27 个表头；AB–AE 无表头/无数据。
- 有效业务行 131、完全空行 272、G 列非空 130 行/唯一编号 125；`WM0069`–`WM0073` 各 2 行；第 122 行缺码。
- 原始 TSV 34,749B，sha256 `89e265f549ecc4f6badcf8b2f6d6e05956ecfe701dc4141771f5416dc2e63b6f`（含价格，只在 `.local`，未入库；采集后哈希未变）。
- 仓库 fixture `snapshot-001-redacted.json`（I/J/Y 置空 + redaction，真实其余字段派生；snapshotKey `f0ab3cba…`）。
- 采集缺口：无飞书 API 凭据，spreadsheet_token/sheet_id 为用户确认事实、未由 API 复核；图片列在文本复制中无内容。

## 3. 业务闭环（对最终实例实际执行）

| # | 验收点 | 结果 | 证据 |
|---|---|---|---|
| 1 | 已有商品装箱数量修改后详情与历史一致 | **通过**：`LS101274` 装箱数量 80→100（模拟批次），详情显示 100；再 100→120（现场批次）详情显示 120；历史逐版本 `80→100`、`100→120` 可见，UUID `0ec91b30…` 不变 | `e2e-1-f5a00006` S2、`e2e-2-f5a00006` S6、`screenshots/03-detail-ls101274.png`、`04-history-ls101274.png`、`detail-text.txt` |
| 2 | 同编号改名仍是同一商品、UUID 不变 | **通过**：`LS101275` 改名“（模拟改名）”，UUID `6e8507da…` 不变，历史追加修订 | S2、history 截图 |
| 3 | 合法新品创建一次、重复采集不重复创建 | **通过**：`WM9001` 首次 created=1（rev1，UUID `2a4ca69c…`）；重复应用同快照 status=duplicate，items/revisions 前后 127/228 不变 | S2、S4、`screenshots/05-detail-WM9001.png` |
| 4 | 行重排、列重排不产生错误商品或虚假修订 | **通过**：003 在 002 基础上反转行/列顺序，revisions 224→224、0 修订，review 集合与 002 相同 | S3 |
| 5 | 缺码、同号冲突、疑似改码进入待核 | **通过**：真实快照 `WM0069/70/71/73` 同号不一致 → 待核对；第 122 行缺码 → 待核对；`LS101295→WM9101295` 疑似改码 → 待核对不建档；来源 `WM9200`+缺码商品同名 → `missing_code_candidate` 不自动建档 | S1、S2、S9、issues 截图/evidence |
| 6 | 已有缺码商品补号保留原 UUID | **通过**：对原缺码商品（UUID `cec5b055…`）显式补号 `WM9200`，rev1→rev2，UUID 不变；重复补号被拒（编号已存在） | S9、PG 用例 |
| 7 | 本地修改冲突不被覆盖、同值不追加修订 | **通过**：本地编辑工厂后来源再改工厂 → 保留“本地冲突工厂”，同修订中装箱数量 100→120 正常采用；`LS101275` 本地与来源同值 → 不追加修订（rev 4→4） | S6 |
| 8 | 空值/公式错误/截断/读取失败 | **通过**：空白/公式错误/非法数值字段不采用（真实快照解析异常进入待核对）；截断快照批次 failed、0 商品写入、商品/修订指纹不变 | S1、S8 |
| 9 | 旧快照乱序不覆盖新结果 | **通过**：早于最近成功批次的快照 status=`rejected_stale`，无写商品 | S5 |
| 10 | 并发修订 | **通过**：expectedRevision 不符的商品单项 failed（`CATALOG_REVISION_CONFLICT`），其余商品照常提交，批次 partial | S7 |
| 11 | 超时按原 requestId 核对真实回执 | **通过（函数/服务层）**：同 requestId+intent 返回原回执；同快照重复返回 duplicate；service 捕获不确定提交后按 requestId+intent 查 `product_source_request`，不重建请求 | PG 用例、`service.ts` |
| 12 | 无权限与跨来源拒绝 | **通过（函数层）**：null/operator/inactive/unknown 四身份对 5 个函数均 42501；app_runner 无直接 DML、私有价格表不可读；service 固定 profileKey，不接受客户端来源键 | PG 用例 13/13 |
| 13 | 价格不泄露 | **通过**：私有价格表 3,239 行；公共 overview/回执 JSON 无 `costPrice/operatingPrice/shippingPrice/restrictedAmounts` 键、无价格原值；页面无价格来源内容 | `guards.json`、S10 |
| 14 | 库存与既有 BS/JST 对应不变 | **通过**：本实例 BS 展示 530 行前后不变；新增/更新商品不写库存、不建/改 BS/JST 对应 | S1/S2/S11 fingerprint |
| 15 | 原始快照未改、现役实例未被本包写入 | **通过**：原始 TSV sha256 未变、快照文件哈希与 manifest 一致；现役 3011 数据库（`run-20261021T100700Z-b3c4d5e6`）只读核验 126 商品 / BS 530 行 / 未安装 `product_source_*` 表，3011 返回 200 | `guards.json` |
| 16 | 表头校验/列重排按表头名识别 | **通过**：真实快照按 27 个表头文字解析；003 反转列顺序后仍按表头识别，无错误商品 | S3、单测 |

## 3A. 三项定向补修验收（2026-10-25，对修复轮实例实际执行）

| # | 定向验证 | 结果 | 证据 |
|---|---|---|---|
| R1 | 新品 + 已有商品本地为空时，未知单位字段均不被采用 | **通过**：真实快照 baseline 的 changes/adoptions 中 6 个 unit unconfirmed 字段均为 0；`WM9001` 新建结果 6 条 `unit_unconfirmed` issue、`nextFields`/changes/adoptions 均无这些字段，修订 1 中只有 16 个确认字段；`WM9001` 已成为已有商品、本地仍为空时，004 计划仍为 6 条 issue、0 个未确认字段写入；`LS101505` 来源单箱重量变化只产生 issue（sourceRaw 保留），未改修订 | `evidence/rechecks/rechecks.json` R3、`evidence/phase-A-summary.json` A1/A2、`ui/ui-apply-evidence.json` |
| R2 | 一项并发失败后可恢复，成功项不重复修订 | **通过**：snapshot-005 单项 `LS101501` 因过期 expectedRevision failed、其余照常提交（partial，failed=1）；UI 点击“补做失败商品”后生成 `retry_of_batch_id=父批次` 的补做批次，结果仅 `code:LS101501`，失败项规格恢复为“10ml/瓶（并发版本）”，成功项 `LS101274` revision 保持 6→6；父批次仍 partial | `evidence/phase-B-summary.json` B2、`evidence/phase-C-summary.json` C1、`ui/ui-retry-evidence.json`、`ui/03-sources-after-retry.png` |
| R3 | 提交成功但返回丢失后可取得原回执 | **通过**：提交前 `record_product_source_request_intent` 保存原 requestId + intent + profile/batch/plan；提交成功后用**重新生成的计划**重提同 requestId → `CATALOG_REQUEST_CONFLICT`（证明直接重算会撞请求）；用保存的原 intent+原载荷重提 → 返回与首次完全一致的原回执（partial，counts 相同），无冲突、无重复修订。服务层另 5/5 单测覆盖先记录后提交、stored intent 重放、原回执直接返回、只补失败项、无失败项拒绝 | `evidence/rechecks/rechecks.json` R4、`tests/catalog/product-source-recovery.test.ts` 5/5 |
| R4 | 原列顺序 + 列重排下公共数据无金额、私有金额对应正确（非空合成价格） | **通过**：原列序（价格列 I/J/Y）公共行 28 列、无受限价格键、无来自受限列的意外价格值（6 处同一行其他列数值与价格数字巧合，已核对同列来源一致，非泄露），私有金额 130 行三语义键与来源映射 0 差异；列重排（价格列 L/M/N，I/J/Y 为普通文本）合成价格 403 行：公共行无价格键/无价格值，I/J/Y 普通值保留 100 行，私有 403 行 `costPrice/operatingPrice/shippingPrice` 0 差异；`overview`/`itemState`/回执无价格值、无语义金额键 | `evidence/rechecks/rechecks.json` R1/R2、`evidence/phase-C-summary.json` C3、PG 用例 16/16 |
| R5 | 走查装箱数更新、新品入库、历史展示 | **通过**：UI 应用 004 后 `LS101274` 装箱数量 120、工厂保留“本地冲突工厂”、历史可见 `100→120`；`WM9001` created、历史“来源新品建档”、页面无外箱尺寸/重量/体积/单箱体积等未确认字段；`LS101275` 本地与来源同名不追加修订（rev 4→4）；最终 3022 首屏/详情截图通过 6 项文本检查、0 console error | `ui/ui-apply-evidence.json`、`ui/ui-final-evidence.json`、`ui/final-*.png`、`ui/detail-history-*.png` |
| R6 | 提交结果未知的页面处理：动作结构化标识 → 组件保留原 requestId/锁住新操作 → 原请求恢复 | **通过**：动作把 `CATALOG_REQUEST_OUTCOME_UNKNOWN` 映射为 `outcomeUnknown:true`，与确定失败分开；浏览器实测（服务端提交/回执成功但响应被模拟丢失）：页面保留“应用本批来源批次”原请求、刷新/应用按钮禁用、出现“核对/重试原请求”；点击核对时捕获的 requestId 与首次提交完全相同，服务端按原意图返回原回执后 pending 解除、按钮恢复、状态显示“已核对到原请求回执…未重复修订”。页面状态机 5/5 单测覆盖未知保留/确定失败释放/同 requestId 恢复/仅 sentinel 分类；数据库只有 1 个批次、1 条原请求回执 | `ui/ui-unknown-evidence.json`、`ui/04-ui-unknown-locked.png`、`ui/05-ui-unknown-recovered.png`、`tests/catalog/product-source-panel-recovery.test.ts` 5/5、`ui-unknown-final3.log` |

说明：C3 的列重排合成价格快照在 UI 走查之后应用，用于金额隔离；随后为保持演示状态可读，对 `LS101274` 装箱数量 120 与 `LS101501` 规格并发版本做了一次本地恢复修订（`evidence/demo-restore.json`，本地操作，非来源变化）。旧 3021 实例与旧证据目录未改写。

## 4. 门禁与既有失败

| 检查 | 结果 |
|---|---|
| `npm run test` | **619 passed / 620**；唯一失败为既有 `opt6-production-apply` 00051 换行基线（与本包无关，未修复） |
| `tests/catalog/product-source.test.ts` | **62/62 passed**（纯逻辑/脚本/读快照/价格不泄露/补做计划） |
| `tests/catalog/product-source-recovery.test.ts` | **5/5 passed**（提交前保存原请求、原回执核对、只补失败项、无失败项拒绝） |
| `tests/catalog/product-source-panel-recovery.test.ts` | **5/5 passed**（结果未知保留原请求/锁新操作、确定失败释放、同 requestId 恢复、仅 sentinel 分类） |
| `tests/catalog/product-source-db.postgres.test.ts` | **16/16 passed**（修复轮独立 PG 实例 `run-20261025T053500Z-f5a00007` 与 db-eng virgin run 均通过；见 §5） |
| `npm run build` | **成功**（Next 生产构建，exit 0；BUILD 以实例 `preview-build-ready.json` 为准，构建源哈希与仓库一致、drift=false） |
| `npm run lint` | **0 errors / 14 warnings**（全部为既有 warning；修复轮受影响文件 `--max-warnings 0` exit 0） |
| `npx tsc --noEmit` | 全仓仅既有 5 条 BEST 测试诊断；商品库/product-source 0 新增 |
| `git diff --check` | exit 0 |
| 独立 PG 增量 | 全新实例一次性应用 009–015 成功；015 UTF-8 无 BOM、U+FFFD=0；新库 prepare-local-preview 已包含 015（未改 001–014） |
| 保护守卫 | 现役 3011 数据库只读：126 商品 / BS 530 行 / 未安装 product_source 表；3011、3021、3022 均返回 307（<500）；原始 TSV sha256 `89e265f5…e63b6f` 未变；3011 未被本包写入 |

**既有失败（不计入本包新增失败）**：`src/features/database/opt6-production-apply.test.ts` 00051 换行基线 1 项；全仓 tsc 5 条 BEST 测试 TS2352；仓库既有 lint warning（与本次改动无关）。

## 5. 复现步骤（最短）

```powershell
# 隔离实例（新 run，应用 001–002 + 009–015 + 126 商品基线）
node scripts/catalog/prepare-local-preview.mjs --run-id run-<fresh>

# 生成/复制来源快照（真实快照需 .local 原始 TSV；模拟快照由脚本生成）
node scripts/catalog/feishu-source/build-snapshot.mjs
node scripts/catalog/feishu-source/build-simulations.mjs
# 将 snapshot-001/002/003 复制到 <run>/source-snapshots/

# 构建/提升/启动独立预览（修复轮用 3022；3011/3021 不动）
node scripts/catalog/build-preview-workspace.mjs --run-id run-<fresh>
node scripts/catalog/promote-preview-build.mjs --run-id run-<fresh>
$env:CATALOG_PREVIEW_PORT='3022'; node scripts/catalog/start-local-preview.mjs --run-id run-<fresh>

# 页面：http://127.0.0.1:3022/dashboard/catalog/sources
# 登录 admin@catalog.test / CatalogAdmin123!（instance/login.local-preview.txt）
# 面板：读取最新快照（仅预览）→ 应用本批；部分失败后“补做失败商品”；
# 提交结果未知时“核对/重试原请求”；商品库中查看更新商品详情/变更记录
```

修复轮定向脚本与证据（不入库）：`.local/catalog/fs-catalog-sim-20261025/{repair-verify.mjs,repair-rechecks.mjs,repair-ui.mjs,repair-final-smoke.mjs,repair-guards.mjs,repair-20261025/}`。

## 6. 修改文件清单

新增：`db/catalog/015_product_source_sync.sql`、`src/features/catalog/product-source/*`（18 文件）、`src/features/catalog/components/product-source-panel.{tsx,module.css}`、`scripts/catalog/feishu-source/*`（3 脚本）、`scripts/catalog/feishu-source-demo.mjs`、`tests/catalog/product-source.test.ts`、`tests/catalog/product-source-recovery.test.ts`、`tests/catalog/product-source-panel-recovery.test.ts`、`tests/catalog/product-source-db.postgres.test.ts`、`tests/catalog/fixtures/product-source/*`、`docs/catalog/feishu-product-source-v1.md`、`docs/catalog/feishu-product-source-v1-closeout.md`、本文件。
修改（三项补修轮）：`db/catalog/015_product_source_sync.sql`（价格按表头映射/语义私有金额、补做批次 `retry_of_batch_id` 与部分唯一索引、私有 `product_source_request_intent` 及 record/read 函数、create issue item 关联）；`src/features/catalog/product-source/{contract,diff,plan,service,repository,actions,server-types,panel-recovery}.ts`；`src/features/catalog/components/product-source-panel.tsx`（补做/核对文案、锁定态与结果未知）；`tests/catalog/product-source.test.ts`、`tests/catalog/product-source-db.postgres.test.ts`、`tests/catalog/product-source-recovery.test.ts`、`tests/catalog/product-source-panel-recovery.test.ts`、`vitest.config.mts`（+recovery 与 panel-recovery test include）。
既有修改：`scripts/catalog/prepare-local-preview.mjs`（LOCAL_SQL +1 行 015）、`src/app/dashboard/catalog/sources/page.tsx`（挂载面板）、`src/features/catalog/local-display/field-labels.ts`（+3 标签）、`vitest.config.catalog.mts`（+1 include）、`AGENTS.md`、`docs/current-state.md`、`docs/tasks/current-task.md`。
未改：`db/catalog/001–014`、`db/p0-02/**`、冻结 fixture、现役 3011 实例与其数据库、现役 126 商品/BS 530 行。

## 7. 未覆盖 / 待确认（不得写成通过）

以下项不在 `FS_CATALOG_SIM_LOCAL_PASS` 通过范围内，保留原状态，不因本包通过而视为已完成或已确认。

- 真实飞书 API 凭据、权限、分页、限流、token 刷新未验证；本轮为匿名只读网页复制。
- `spreadsheet_token` / `sheet_id` 未经 API 独立复核；仅用户确认。
- 图片列（F）在文本剪贴板无内容，图片内容/对象存储未核验。
- 外箱长宽高、单箱重量、立方单位未在来源表头明确：按“保留来源原文 + 单位未确认”处理，不换算、**不自动采用（含本地为空/新品）**，只进入待核对；这不代表单位已确认或字段可写入商品。
- 列重排合成价格只用于隔离验收，不代表真实飞书价格展示或金额口径；真实价格仍只在 `.local` 受限证据。
- 真实 200% 浏览器缩放与多浏览器矩阵未做。
- 模拟变化（002/003/004）为本地副本变化，不是飞书真实修改；模拟通知与真实 API 同步未接通。
- 本包不开发物流、库存同步、估值、费用分摊或复杂分析。
