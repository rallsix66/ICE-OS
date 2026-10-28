# 库存与同步 UI — S1–S4 最终收尾验收说明

当前裁定：**INVENTORY_SYNC_UI_V1_LOCAL_PASS**（2026-10-28尾项独立复审通过）。[独立报告](../../.local/inventory-sync-ui-tail-independent-20261028/independent-review.md)、[尾项验收说明](inventory-sync-ui-v1-tail-repair-acceptance.md)。本文件下方 S1–S4 裁定为历史，T1–T3 已关闭。

## 上一轮独审记录（历史）

2026-10-28独立裁定：**INVENTORY_SYNC_UI_V1_FINAL_REPAIR_NEEDS_FIX**。[独立报告](../../.local/inventory-sync-ui-final-independent-20261028/independent-review.md)、[唯一剩余T1–T3](../../.local/inventory-sync-ui-final-independent-20261028/remaining-repair.md)。

仅剩T1未知市场/指定海外仓详情仍混入国内、T2商品汇总详情本次未见旧时间漏传、T3同步任务展开后未定位视口。已通过的布局/分页、国内专属详情、海外未知仓收窄、同范围计数、批次采用身份、PH双码警告和草稿语义不重开。

独立核验3011 BUILD `HZmMgkE6tlWlGBxM3OgLw`、源码 `6f89fe4d…`、417产物一致无漂移；650行/116商品/427市场格原始证据独立复算0差异。正式与既有隔离库仅普通app只读查询；自然08:22批次继续。未保存设置或手动同步，未改业务/SQL/worker/计划/正式对应/库存事实。

执行方38/38、167单测等仅核读，不冒称独立全量重跑；T1实页、T2只读受控链、T3实际视口位置分别有独立证据。全部数据、原表、脏工作区、旧构建、隔离库和历史证据保留。未提交/推送/合并/部署/清场/写长期记忆；未重跑历史性能、权限、采集器、A1/B/C或全套自验。

下一交审点 **INVENTORY_SYNC_UI_V1_TAIL_REPAIR_IMPLEMENTED_AWAITING_INDEPENDENT_REVIEW**；该三处收尾见[本轮收尾验收说明](inventory-sync-ui-v1-tail-repair-acceptance.md)。

## 2026-10-27执行方交付（历史自验）

以下原状态 INVENTORY_SYNC_UI_V1_FINAL_REPAIR_IMPLEMENTED_AWAITING_INDEPENDENT_REVIEW；完成声明须以上方独审纠正为准，不代表PASS。
依据：`.local/inventory-sync-ui-repair-independent-20261027/remaining-repair.md`（S1–S4）与同目录 `independent-review.md`、`data-review.md`、`flow-review.md`；原合同 [inventory-sync-ui-v1.md](inventory-sync-ui-v1.md) 与上一轮 [inventory-sync-ui-v1-repair-acceptance.md](inventory-sync-ui-v1-repair-acceptance.md) 继续有效。**不重做已通过的布局/单一抽屉/固定分页/唯一维护入口/同步来源总览。**

## 范围（只修四组）

| 组 | 要求 | 本轮实现 |
|---|---|---|
| S1 | 来源/国家范围/状态/计数贯穿详情 | 仅国内详情只用国内冻结记录（原数量/编码/文件日期、无 BS 动作）；`__unknown__` 哨兵贯穿详情读取（只 `market IS NULL` 仓），表头/摘要不出现 token；商品汇总未对应计数与搜索/仓/市场/当前对应状态一致；国内商品数按搜索收窄；118/116/120 不退化 |
| S2 | 保留批次当时身份，当前映射版本独立判定 | 022 以本批 `br.mapping_id` 是否仍 confirmed 判定 adopted/inactive；换绑/同商品重确认在下一批前不提前采用；本次未见保留 `lastKnownQty/lastKnownAt`（只展示、不计入）；WM0094 首次待采用继续可搜不计合计 |
| S3 | 抽屉保留必要业务警告，不恢复说明墙 | 同仓多编码短警告（列出仓与编码、说明未并入确定合计）+ 服务端 scopedWarnings；逐仓恢复状态说明、本次未见旧量/旧时间；未知值不转 0 |
| S4 | 同步任务详情可见、草稿语义一致、残余重复文字 | URL 选中 run 时外层详情自动展开、刷新可见、可手动收起；设置“收起”改为保留草稿的准确文案；同步默认页删重复/空占位/收短成功说明、国内日期标“最新文件”+覆盖集合；库存页删长脚注、时间集中显示 |

## 现场

- 唯一日常入口 **http://127.0.0.1:3011**；最终 BUILD **`HZmMgkE6tlWlGBxM3OgLw`**（源码快照 `6f89fe4d79f3f950…`，`repoSourceDrift=false`，417 编译产物，`verifyNextArtifacts` 通过，login 200，未登录 inventory 307）。
- 实例 `run-20261026T211500Z-11a22b33` / PG 59345 / schema v6；`source_sha256=c08eace8…` 未变；`functions_sha256=4fbeec9a…`（016 函数文件哈希，因本次必要只读函数修正更新，version 不变）。
- 数据：650 = 430 adopted + 220 unmapped + 0 + 0；116 商品；427 市场格（0 含 warehouseAvailable）；`__unknown__` 143 行市场全空；430 adopted 与权威 `inventory_effective_rows` 同集且商品身份 0 不一致。
- worker `inv-worker-59345`（pid 42072）未重启；自动同步开启/60 分钟/7 仓/configVersion 3；20:22 自然计划批次成功，next 21:22；126 商品 / 430 正式对应 / 98 待核候选 / 库存事实与历史未改。

## 通过项（执行方自验，不是独立结论）

- **真实页面点击 38/38**：仅国内详情、未知市场下钻→汇总→详情、搜索计数 7/3、未知范围计数一致、表头无 token、PH 双码警告/正常商品无无关警告、商品数 118/116/120、同步选中任务展开+刷新可见+手动收起、设置 120 草稿开合+刷新回 60、默认页无重复文字、无页面异常。见 `final-repair/live-final-checks.json` 与 9 张截图。
- **S2 受控输入 9/9**：隔离副本事务内构造→调用已安装读模型→ROLLBACK；正常采用、换绑、同商品重确认、停用、本次未见旧值、WM0094 待采用、回滚后计数不变。正式库未造对应变化。
- **读模型只读核对**：正式 10 项、隔离 9 项（650 计数、adopted 同集、搜索/未知范围计数同口径、未知市场详情 1/7 仓、143 行未知市场全 null）。
- **安装前后 0 差异**：650 行正常字段（除新增 lastKnown 字段）0 差异；116 商品核心汇总 + 427 市场格 0 差异；schema version/source_sha 不变；搜索 WM0026 未对应 220→3 为预期修复。
- 静态：tsc 仅既有 BEST 5；改动文件 eslint 0；`git diff --check` 0；`tests/inventory` 167 passed / 44 skipped（2 个 postgres 套件因 `INVENTORY_INSTANCE_DIR` 未设置导入期失败，与旧记录一致）。
- 读取耗时（单次样本，非 p95）：库存默认 575ms、同步默认 615ms、1440 库存 483ms，与上一轮同量级。

## 未覆盖 / 限制（不写成通过）

- `inactive`、`pending_adoption` 无 3011 自然样本：仅隔离副本受控输入/只读证据；3042 预览仍旧构建，未在浏览器演示。
- 抽屉“本次未见旧值”展示由受控读模型数据 + 单测覆盖，不是真实浏览器自然样本。
- “确认后下一完整批次采用”沿用 v4-final A1 证据，未重抓导出。
- 商品汇总 1280 需横向滚动；同步设置在 720 高需页面滚动。
- 未做真实 200%/断网/自然过期/多机/完整权限矩阵；未真实保存设置或手动同步（只验 UI/草稿）。
- 旧 sync 映射 testid 套件未重写；两个 postgres inventory 套件未跑；既有 BEST 5、opt6 00051、历史 lint warning 原样。

## 证据

`.local/inventory-sync-ui-repair-20261027/final-repair/`：`delivery-summary.md`（含 9 张截图逐图文字说明）、`evidence-index.md`、`RESTORE-NOTE.md`、`PROTECTION.md`、`live-final-checks.json`、`live-expected.json`、`s2-controlled-inputs.json`、`formal-install.json`、`formal-before/after-install.json`、`sql-formal-check.json`、`sql-isolated-check.json`、`final-state.json`、`final-state-query.json`、`rollback/`、`rollback-sql.mjs`、`pages/`。

## 停止点

**`INVENTORY_SYNC_UI_V1_FINAL_REPAIR_IMPLEMENTED_AWAITING_INDEPENDENT_REVIEW`**。未提交/推送/合并/公网部署/清场/写长期记忆；未改 worker、60 分钟计划、参与仓、正式对应、库存事实；旧构建/隔离库/旧证据保留。等待独立审查，不自行宣布 PASS。
