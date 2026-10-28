# 商品库存响应速度优化 v1 — 验收说明（独立复审通过）

日期：2026-10-27。当前状态：**`INVENTORY_RESPONSE_SPEED_V1_LOCAL_PASS`（主审独立复审通过）**。[独立报告](../../.local/inventory-response-speed-independent-20261027/independent-review.md)。下文实施与测量为执行方原记录，主审已独立核对代码、三组288原始输出、当前查询、实际页面与运行版本；不冒充执行方整套测试均由主审重跑。

独审校正：SQL第2页优化前中位/最慢为3440/3443ms；冷加载立即点击前后各一次（3978→540ms），其余6类页面各3次；普通整页打开复用已登录浏览器，不是空缓存/服务冷启动。仅校正报告，原始证据不改写。

任务包见 [inventory-response-speed-v1.md](inventory-response-speed-v1.md)；只读诊断见 `.local/inventory-speed-review-20261027/reads.md`、`frontend.md`。本机唯一日常入口仍为 **http://127.0.0.1:3011**（`run-20261026T211500Z-11a22b33` / PG 59345 / 库 `iceos_catalog_run_20261026T211500Z_11a22b33`）。

## 1. 实施范围（最小改动）

| 文件 | 改动 | 规模 |
|---|---|---|
| `db/catalog/016_inventory_sync_functions.sql` | 列表读取层：新增请求内一次读取上下文 + 复用同一判定的批量汇总；`read_inventory_list` / `read_inventory_item` 改为先建上下文再计算；旧 `inventory_item_summary` / `inventory_item_warehouse_gap` 保留原签名，改为同一核心的包装 | 476 插入 / 275 删除（含搬移与注释） |
| `src/features/inventory/components/inventory-view.tsx` | 列表行“收起详情”在已展开时改用去掉 `item` 的列表地址（保留搜索/仓库/市场/页码）；未展开仍打开目标详情 | +7 / −2 行 |

实现要点：

- 新增内部函数 `catalog.inventory_read_context`（一次取齐当前范围的有效行、逐仓读取状态、仓库、已确认/历史对应、候选、最近登记的来源行、资料版本缺失计数），`catalog.inventory_item_gaps`、`catalog.inventory_item_summary_core` 从该上下文计算；列表与详情复用同一核心，**没有第二套库存判定**。
- 列表按页商品使用上下文里按商品分组的小切片，避免 50 个商品重复解析全量数组；仍不跨请求、不跨用户缓存，不依赖 TTL。
- 未新增/未修改任何业务表、DDL、migration、RPC 签名、返回字段、排序、分页、搜索、仓库/市场过滤或错误语义；未回退旧 `inventory_current`；未降低默认 50 条、未去掉缺口/来源/历史字段、未假返回 0。
- 前端详情/筛选仍为原生整页导航（历史原因：冷加载后立即点击不被 Next Link 吞）；**未新增客户端缓存或状态库**。查询变快后页面操作已约 0.4–0.5 秒，因此按任务包“只改查询和正确收起地址已达到目标就停止”的要求，不再做局部刷新重构。

## 2. 优化前后真实耗时

同一 app 角色、同一数据批次（`0f4b73bf-d492-427c-a571-b055dba1fbd4`，2026-10-27 14:22:22 +08 导出）、同一正式实例，每个场景 1 次预热 + 3 次采样；下表为**中位数/最慢**（ms）。原始样本见 `verify/read-timings-before.json` / `verify/read-timings-after.json`。

| 读取（SQL 往返） | 优化前中位/最慢 | 优化后中位/最慢 | 约 |
|---|---:|---:|---:|
| 默认 50 行列表 | 3492 / 3544 | **193 / 214** | 18 倍 |
| 10 行列表 | 734 / 809 | 97 / 101 | 7.6 倍 |
| 第 2 页（offset 50） | 3440 / 3443 | 164 / 187 | 21 倍 |
| 搜索 WM0026 | 111 / 113 | 88 / 91 | 1.3 倍 |
| 越南仓筛选 | 1515 / 1544 | 98 / 124 | 15 倍 |
| PH 市场筛选 | 1452 / 1462 | 102 / 103 | 14 倍 |
| WM0026 详情（筛选视角） | 213 / 213 | 108 / 110 | 2 倍 |
| WM0026 详情（全仓） | 222 / 223 | 106 / 106 | 2.1 倍 |

浏览器真实页面（同一登录、同一批次，常规操作各 3 次，冷加载立即点击为单次；从用户操作到目标内容在屏幕可见；优化前 BUILD `MB1i1eT7pYCsG8qdb1iea`，优化后 BUILD `p7im9R07D7iqkV_2mNKNJ`）：

| 页面操作 | 优化前中位 | 优化后中位 | 说明 |
|---|---:|---:|---|
| 普通整页打开默认 50 行列表 | 3442 | **420** | SQL 批量后主要剩 Next/React 渲染 |
| 搜索 WM0026 | 391 | 389 | 页面固定开销占比高 |
| 仓库筛选（越南） | 1708 | **410** | |
| 第 2 页（Link 客户端导航） | 3798 | **403** | |
| 打开详情 | 3892 | **444** | 仍整页读取列表+详情 |
| 收起详情（详情面板） | 3814 | **467** | 仍整页回到列表 |
| 新标签加载后立即点详情（各一次） | 3978 | **540** | 单次点击用时；原生 a 可用，非中位数 |

原始页面样本见 `pages/page-timings-before.json`、`pages/page-timings-after-sql.json`（仅 SQL 优化、旧前端构建）、`pages/page-timings-after.json`（最终构建）。

结论：默认 50 行查询从约 3.9 秒降到约 0.19 秒（目标 ≤0.5 秒），日常列表/筛选/详情操作从约 1.7–3.9 秒降到约 0.4–0.5 秒（目标“1 秒左右”）。页面请求数未变（列表 22 个请求、打开详情 23 个、收起 23 个；第 2 页 2 个 RSC 请求），没有用减少行数或假数据凑速。

## 3. 结果一致性证据

所有比较均要求 **同一数据快照**（比较前后 latest success run/批次行/有效行/对应数量完全一致）。

1. **正式数据的隔离副本（优化前/后同一快照）**：把正式库导出恢复到独立副本 `iceos_catalog_speed_verify_20261027`，先以旧函数读取、再安装新函数读取，比较 288 个读取用例（全仓列表 200/50/10 行、分页、7 个仓库筛选、5 个市场筛选、6 种搜索、越界/非法仓库错误、116 个商品各自的筛选视角与全仓详情、WM0026/LS101295 的逐仓/逐市场详情）：**288/288 完全一致（0 差异）**。证据 `verify/compare-old-new2.json`。
2. **正式库安装前后（同一快照）**：安装前、后各抓一遍 288 个用例：**288/288 完全一致（0 差异）**。证据 `verify/compare-formal-old-new.json`。其中 `overview` 的 `worker.online/lastSeenAt` 属心跳时间字段（该函数未改），比较时单独忽略。
3. **失败/本次未见等无法自然出现的分支**：在另一份一次性副本 `iceos_catalog_speed_fixture_20261027` 中注入受控夹具后，同样比较 288 个用例：**288/288 完全一致**；并核对 15 项分支检查全部成立：失败沿用旧值（含上次成功时间/错误码）、本次未见+上次已知、待采用对应、有来源但未对应、无来源、同仓待确认来源、单位冲突、历史资料版本缺失、验证数据标记、双码待合计等。证据 `verify/compare-fixture-old-new.json`、`verify/fixture-branch-check.json`、`verify/fixture-changes.json`。
4. **真实数据已自然覆盖的分支**（116 商品全仓详情统计）：未对应 `unmapped_source` 94 仓次、`no_source` 105 仓次；同仓待确认来源 31 个商品；双码待合计 3 个商品；未知市场 91 个商品；MY 待核 0 行保留。
5. 读取返回字段、排序、分页、搜索、仓库/市场过滤和错误语义均未变化；列表与详情继续使用同一有效库存/采用口径，未回退旧 `inventory_current`。

> 副本只用于“同快照新旧函数对比”和受控夹具，未写入正式库；夹具注入只在一次性副本内完成，正式库未造失败、未改库存/对应/历史。

## 4. 真实页面链（正式 3011，新构建）

`page-verification.json`：**34/34 通过**。数据库期望值在脚本运行时从正式库同批数据推导（不写死数量），覆盖：

- 首开默认 50 行列表；表头范围/最近全部成功日期来自当前批次。
- 搜索 WM0026：列表行覆盖 `覆盖 6/7 仓`、`合计待核对` 与数据库一致；打开详情后逐仓×来源 SKU 行（含数量）与 `inventory_effective_rows` 一致；MY 的 `ICEWM0026=来源 0，待确认归属` 仍显示；PH 56519 双编码两行分别展示且“合计待核对”说明保留。
- **列表行“收起详情”**：地址去掉 `item`、保留 `q=WM0026`，详情面板消失，回到同搜索的列表（原缺陷已修）。
- 详情面板“收起详情（保留当前搜索与筛选）”同样去掉 `item` 并保留搜索。
- 仓库筛选（越南）+ 打开/收起：保留 `warehouse=` 与筛选状态；第 2 页 + 打开/收起：保留 `page=2` 与第 2/3 页。
- 冷加载后立即点“查看详情”能正常打开；匿名访问仍跳登录；页面无 500/未处理异常。
- 商品库（共享 `read_inventory_item` 路径）快速冒烟：搜索 WM0026、打开库存页签正常显示数量（`final-checks.json`）。

截图见 `pages/detail-wm0026.png`、`pages/row-collapse-after-search.png`、`pages/list-after.png`、`pages/catalog-smoke-after.png` 等。

## 5. 安装、构建与保护

- **读取函数安装**：沿用现有目标守卫 + schema/functions 握手。以 owner 只读身份核对库/主机/端口/schema 版本 6，并确认旧 `functions_sha256` 仍为 `c36c90a0…` 后才安装；整文件单事务应用，`catalog.inventory_schema_state.functions_sha256` 更新为 **`0c551192…`**（= 当前 `016_inventory_sync_functions.sql` 的 sha256），`applied_at=2026-10-27T06:45:08.552Z`。安装报告 `verify/apply-functions-report.json`。
- **网页构建**：staging 构建 **BUILD `p7im9R07D7iqkV_2mNKNJ`**（快照 `ed64515dd49649f40f924f02ac9f3f7d4d91a0db02a31333aa9ea92d5e96e054`）→ `promote-preview-build`（停 web、替换、校验 BUILD 一致）→ `start-local-preview`（3011）。当前 web pid **88024**，`sourcesMatchBuild=true`。旧 BUILD `MB1i1eT7pYCsG8qdb1iea` 的 staging `next-build-a3f0f683bce70e2c` 保留。
- **未改**：数据库业务数据（批次/行/对应/库存/历史/原 Excel）、目录商品/UUID/430 正式对应、冻结 worker（pid 42072、冻结源 `1db4017a…`，未重启）、60 分钟自动同步（enabled、next 15:22、最近成功 14:22 自然计划 `0f4b73bf…`）、其它实例与旧证据。运行指纹见 `verify/runtime-final.json`。
- **权限**：新内部函数未授予 app/sync 角色；实测两角色调用均 `PERMISSION_DENIED`（`final-checks.json`）。没有放宽服务端鉴权/账号范围/数据库身份边界。

## 6. 执行方验证命令与结果

| 检查 | 结果 |
|---|---|
| 全仓 `tsc --noEmit --incremental false` | 仅既有 BEST 测试 5 条历史错误；库存相关 0 新错 |
| 改动文件 `eslint --max-warnings 0` | 0 error / 0 warning |
| inventory 纯逻辑单测（web-model、v4、real-shape、adoption、intent、settlement） | **109/109** 通过 |
| `next build`（staging） | 成功，BUILD `p7im9R07D7iqkV_2mNKNJ` |
| `git diff --check` | 0（无空白错误） |
| 页面链 | 34/34 |
| 最终小检查（内部函数权限、商品库冒烟） | 4/4 |

未重跑：旧 15×20 性能矩阵、BigSeller 下载/R2 解析、A1/B/C 恢复、备份恢复演练、多机并发、200% 缩放等无关套件。

## 7. 未覆盖 / 剩余限制（不写成通过）

- 页面仍为整页导航（列表行/详情面板收起会重新加载列表），**没有做客户端局部刷新**；当前实测 0.4–0.5 秒，接近/低于 1 秒目标，按任务包停止。若独审认为仍需局部交互，应另立最小范围，不在本包内自动扩大。
- 详情在正式库实测约 0.10–0.11 秒（副本约 0.03 秒，环境/计划差异未深究）；仍远低于 0.5 秒目标，但不是 0。
- 性能样本为少量样本中位数/最慢值，**不是 p95、不是压力测试、不是多机/生产容量结论**；同步进行中数据/耗时会有正常波动。
- 失败/未见/待采用等分支为受控副本夹具验证（未在正式库造失败）；真实断网/登录过期/时钟边界未重新演练。
- 未提交、未推送、未合并、未公网部署、未清场、未写长期记忆；未覆盖整个 ICEOS 验收。

## 8. 恢复与交回

修改前源码、函数定义/哈希、构建/进程指针、schema 握手旧值均保留；回退步骤见 `.local/inventory-response-speed-v1-20261027/RESTORE-NOTE.md`。停止点 **`INVENTORY_RESPONSE_SPEED_V1_IMPLEMENTED_AWAITING_INDEPENDENT_REVIEW`**，不自行宣布通过、不继续下一包。
