# 库存与同步 UI 收尾（T1–T3）验收说明

2026-10-28 主审独立复审通过：**`INVENTORY_SYNC_UI_V1_LOCAL_PASS`**。T1–T3 全部关闭，本包不再新增功能返工；已通过布局、分页、采用身份、PH 双码提示和草稿语义沿用。 [独立报告](../../.local/inventory-sync-ui-tail-independent-20261028/independent-review.md)。

主审真实点击确认：未知市场/指定海外仓详情不混国内；仅国内 WM0026 仍为 5,100（文件 2026-10-15），全部无筛选仍分区。旧量 247 与旧 16:22 时间通过独立单个只读受控链（非正式库自然缺行）。同步任务点击/刷新/切换后标题均位于 720px 视口顶部约 13.2px，计划时间正确随所选任务变化，手动收起正常。

现役 3011 BUILD **`ElaITcTkEMZyYxyRD1CaS`**，源码/编译快照 `6f0faba622bd53ae…`、417 产物独立一致、无漂移；现役 read_inventory_item 与当前 016 一致（定义 `8e78ba3b…`，文件 `55922bc9…`）。原全表/映射/性能等可信证据沿用，未重复全套。

通过仅限批准的本机库存双视图与同步 UI，不是公网发布、全 ICEOS 验收、未来员工权限或新 API 接入完成。审查未改业务/SQL/worker/计划/正式对应/库存事实，未保存设置或手动同步。保留所有数据、原表、旧构建、隔离库、脏文件和历史证据；未提交/推送/合并/部署/清场/写长期记忆。

## 执行方交付记录（历史自验，原始证据保留）

2026-10-28。依据 [最终收尾独立复审](../../.local/inventory-sync-ui-final-independent-20261028/independent-review.md)与
[唯一剩余 T1–T3](../../.local/inventory-sync-ui-final-independent-20261028/remaining-repair.md)；
[上一轮 S1–S4 验收说明](inventory-sync-ui-v1-final-repair-acceptance.md)与[原任务包](inventory-sync-ui-v1.md)保留历史。

**状态：`INVENTORY_SYNC_UI_V1_TAIL_REPAIR_IMPLEMENTED_AWAITING_INDEPENDENT_REVIEW`（执行方自验交付，不自行宣布 PASS）。**
[交付摘要](../../.local/inventory-sync-ui-tail-repair-20261028/delivery-summary.md)、
[证据索引](../../.local/inventory-sync-ui-tail-repair-20261028/evidence-index.md)、
[恢复说明](../../.local/inventory-sync-ui-tail-repair-20261028/RESTORE-NOTE.md)、
[保护说明](../../.local/inventory-sync-ui-tail-repair-20261028/PROTECTION.md)。

## 范围

只补独审剩余三处，已通过项不重开：

| 编号 | 要求 | 实施 |
|---|---|---|
| T1 | 详情取数/显示沿用列表有效范围；明确海外仓/市场筛选不带国内；未知下钻与普通国家格一致；仅国内与全部无筛选保持 | `dual-view.ts` 新增唯一判断 `domesticIncludedInScope`；`page.tsx` 详情国内取数与 `inventory-view/layer/panel` 显示共用；列表合并函数改为复用 |
| T2 | 商品汇总详情把旧数量对应的旧时间接到已有 `lastKnownAt`，沿用归一化/组件，不加查询/状态 | `016_inventory_sync_functions.sql` 的 `read_inventory_item` 仓库 JSON 增加 `'lastKnownAt',(v_gap->>'lastKnownObservedAt')::timestamptz` |
| T3 | 选中同步任务后详情直接进入当前视口；刷新/切换任务仍定位；手动收起正常 | `sync-view.tsx` 任务详情锚点 `#sync-run-detail` + “查看详情”带锚点；`sync-controls.tsx` 一次性 `scrollIntoView` + `ResizeObserver` 校正布局变化，1.5 秒断开，同一 run 只定位一次 |

未新增框架、查询、缓存、状态机或功能；未改 worker、60 分钟计划、7 仓范围、正式对应与库存事实。

## 现场

- 唯一日常入口 **http://127.0.0.1:3011**；BUILD **`ElaITcTkEMZyYxyRD1CaS`**；源码/编译快照 `6f0faba622bd53ae…`；
  `validateReadyRecord.ok=true`、`repoSourceDrift=false`、417 个编译产物一致；launcher pid 70904 / next-server pid 74304。
- schema v6；`source_sha256=c08eace8…` 未变；`functions_sha256=55922bc9…`（当前 016 文件，按 prepare-instance 规则登记）；
  已部署 `read_inventory_item` 定义 `8e78ba3b…`；022 未改。
- 数据：650 = 430 adopted + 220 unmapped；116 商品；427 市场格；0 个 `warehouseAvailable`；未知市场 143 行全空；WM0026 搜索 7/3。
- worker `inv-worker-59345` pid 42072 未重启；自动同步开启/60 分钟/7 仓/configVersion 3；09:22 自然批次成功，下次 10:22。
- 21 个构建目录、3042 旧预览（pid 14028）、隔离验证库、原表、历史证据、脏工作区保留；未提交/推送/合并/部署/清场/写记忆。

## 验证（执行方自验）

- **真实点击 17/17**（1280×720，全部通过界面点击/输入/回车；`tail-live-checks.json`）：
  - 未知市场链：详情海外仍 1 仓（757577983013，09:22 批 3,117/3,113），**无国内分区/5,100**；
  - 全部来源+指定海外仓（越南青林湾仓库）：详情 1 行 1,800/1,766，**无国内分区**；
  - 仅国内 WM0026：只有国内 5,100/2026-10-15，无海外各仓；
  - 全部来源无筛选 WM0026：国内 5,100 与海外 8 行（7 仓，PH 两码各一行）分区同显；
  - T3：点击后 `scrollY=1928`、任务详情顶部 0px、标题 13px；刷新同 URL 与切换另一任务仍定位；手动收起后详情移除、未持续拉回。
- **T2 受控 11/11**（`db/t2-install-and-check.json`）：安装前后仓库明细/汇总 0 差异、详情除新增字段外 0 差异；
  复用独审同一受控未见输入（旧量 247、旧时间 2026-10-27 16:22:25+08、最新未见批 17:22），
  最终 DTO `onHand=null / lastKnownQty=247 / lastKnownAt=旧时间`，可见提示“上次已知 247（2026-10-27 16:22）”，未用 17:22 顶替。
- **最终现场 10/10**（`final-state.json`）。
- `tests/inventory` 168 passed / 44 skipped（2 个 postgres 套件因未设置 `INVENTORY_INSTANCE_DIR` 导入期报错，与既有记录一致）；
  tsc 仅既有 BEST 5；改动文件 eslint 0；`git diff --check` 0；未跟踪改动文件空白/BOM 自检 OK。

## 未覆盖（不写成通过）

- T2 为受控只读输入证据，不是 3011 正式库自然缺行；未制造失败/改对应。
- T3 只做本机 1280×720 Chromium 单次真实点击；未做缩放、多机、慢网。
- 未重跑 S1–S4 全套、650/887 全表、映射身份 5 态、A1/B/C、真实保存/手动同步、200%/断网/权限矩阵。
- 商品汇总宽表 1280 横滚、设置面板 720 页滚为既有边界。

下一交审点即上方状态；通过只能由后续独立复审对本包裁定。
