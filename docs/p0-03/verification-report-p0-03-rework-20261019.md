# P0-03 最小返工交付报告

日期：2026-10-19。状态：**P0_03_IMPLEMENTED_AWAITING_REVIEW**。

本报告记录上一轮实施与自验，随后独立复审为 **CHANGES_REQUIRED**。仅补两项的现役报告见 [review-r2](./verification-report-p0-03-review-r2-20261019.md)；本报告及原证据保留，不宣告 P0-03 PASS。

## 结果与边界

本轮只整理产品主库并保存样表已有人工核对结果。后续两个系统持续绑定、自动匹配和使用关系的方案未定。没有正式映射入库、以后导入自动复用、库存发布/同步、新业务页面、生产操作、旧数据迁移、提交或推送。

菲律宾-新创启辰自建仓 `ICEWM0039 → WM0093` 已撤销，正确目标为空，状态待核对。原来源记录、原候选、CSV 原 confirm/备注以及追加纠错事件均保留。没有猜测替代 ICE 货号。

22 条人工选择全部恢复为结构化结果：来源 SKU、仓库、主库原始 Excel 行号、ICE 货号、原人工决定/备注、已填聚水潭旧 ID/SKU，以及核实后的当前聚水潭来源记录。所有目标行存在，ICE 货号与该行相符。资料冲突没有被人工选择抹掉。

结果中“人工已选”仅表示显式 CSV 的有效资料选择（其中含 CSV 原有历史确认），不代表本轮新做了 510 次人工操作，不代表后续正式绑定可用。当前候选不输出 `formal_mapping_eligible` 或类似正式资格字段；冻结历史文件保留原内容。

## 证据与决策来源

本轮证据根目录：

```text
D:/try one/ICEOS/.local/p0-03/run-20261019-rework/evidence/rework-2026-10-19T03-13-23-877132Z/
```

**唯一现役交付目录为 `delivery-final/`**。`result/`、`delivery/` 为本轮早期试跑，`same-sample-reapply/` 为同批显式 CSV 重应用验证，均原样保留，不作为现役结果。`before/`、`before-hashes.json` 记录返工前工作树；`verification/` 保存验证日志、浏览器截图、人工待判断清单及实际 diff。

唯一人工 CSV：`C:/Users/Administrator/Desktop/p0-03-manual-review-filled.csv`，3171 条历史/当前 ID 记录，内含 22 条人工目标。

- 冻结文件：`delivery-final/manual-decisions.frozen.csv`。
- SHA-256：`1392022156e2cdd0ae748ddc5424334fc9ef76f175c40a8c56af0cd1d2cc92c5`。
- 停止隐式寻找/合并桌面其他 CSV；也不写回桌面。

以用户指定的 `run-20261015-r1/evidence/match-2026-10-17T03-09-54-338Z/` 为起点。为恢复合并前聚水潭 ID，显式提供下列来源沿革证据，并各自冻结、记录哈希：

- `match-2026-10-16T03-30-19-036Z/match-bundle.json`：包含 22 个原聚水潭 ID。
- `match-2026-10-17T02-50-13-514Z/match-bundle.json`：包含本批别名调整前的 3 个旧 ID。

仅按已保存来源记录的聚水潭款式+商品编码或 BigSeller 原来源行身份追溯到当前唯一记录；没有按相似名称猜测。旧证据不提供新的人工决定，不代表以后导入自动复用机制。无法唯一核实会待核对。同份 CSV 的旧/新 ID 指向同一来源但决定不同，也保留原记录并待核对。

原 Excel、人工 CSV、指定原证据目录内全部文件的哈希均通过复核；原文件及旧批次没有覆盖。

## 修复前后样例

- 菲律宾仓 `ICEWM0039`：原候选主库第 28 行 `WM0093` 泰国特供版，CSV 原值为 confirm；现为 `pending/defer`、有效目标为空。`correction-events.json` 保留原目标、原决定、撤销原因，replacement 为 null。
- 菲律宾仓 `CHIC-WM0047-P05`：原 CSV 选主库第 45 行 `WM0047`，填写聚水潭 `mc-e148ed0d72af79af / WM0047`，原结果没有实际商品；现为人工已选，JSON/CSV/页面均显示第 45 行 `WM0047`。聚水潭旧 ID 仍保留，核实后的当前记录为 `mc-407ee3e2e1d48744`，SKU 仍为 `WM0047`。
- 菲律宾仓 `ICEWM0031`：第 25 行 `WM0031` 的选择保存，同时保留其条码 `757577983068` 在主库第 25/121 行重复的冲突。
- 菲律宾仓 `ICEWM0040`：第 29 行 `WM0040` 的选择保存，同时保留其条码 `757577407083` 在主库第 29/84 行重复的冲突。
- 仓别过滤覆盖唯一命中、别名与人工目标路径。其他无效目标、一对多无明确选择均没有有效商品；仓库明细也不再取第一条候选。

## 资料与计数

- 主库 Excel 数据区 217 行，85 行全空跳过，保留原行号；132 行非空资料，不能称 132 个唯一商品。**计数更正：131 行 ICE 货号非空，125 个不同的非空 ICE 货号，另 1 行资料无 ICE 货号（原 Excel 第 122 行）；此前 126 个不同值包含空字符串，不能当作非空货号计数。**仍存在 6 组重复 ICE 货号、7 组重复条码，共 13 组主资料质量问题；不自动合并。
- 聚水潭两文件按既有款式+商品编码合并 887 条；BigSeller 530 条；合计 1417 条，没有扩大到组合 SKU 或规则外处理。
- 本批有效状态合计：人工已选 510、待核对 801、有候选 15、拒绝 3、规则外 88，共 1417。零条 ignore/defer 原始 CSV 决定；代码和回归用例明确支持 ignore/defer，未把尚未决定的聚水潭项自动确认为已选。
- 3 个拒绝项保留：菲律宾仓 `757577407076`、`757577983020`，聚水潭 `WM0062`。原备注即使含旧自动通过文字，也原样保留，不能据此覆盖拒绝。
- 数量措辞采用“整仓可用数”，`>0` 不解释为存在实物库存；没有汇总发布库存或算估值。

## 人工决定与输出规则

CSV 为完整决定快照。空白决定撤下旧决定，`clear` 显式清除，`reject` 拒绝、`ignore` 忽略、`defer` 暂缓。有效人工选择必须 confirm，且主库行/ICE 一致、仓别及本批范围校验通过；无效项保留原填值与校验原因，不能显示完成。

JSON、CSV、仓库汇总、本地 HTML、串联总览均从同一有效结果生成。串联总览只汇入有效人工选择，另附全量逐行核对记录。汇总按原主库行号分组，不用重复 ICE 货号合并不同资料行。

本地 HTML 改为冻结结果的只读核对视图，保留搜索与状态筛选；不再从 localStorage 拼接生效决定或在页面自动打勾。修改通过显式 CSV 重跑到新的空证据目录。没有修改应用内业务页面。旧报告模板/发布预览不再被当前 CLI 生成；历史文件保留。

`apply-review` 要求含 `master_rows` 的已验证快照；旧批次使用 `rework --evidence ... --review-csv ...` 读取原 Excel 后校验。输出非空目录会失败，不能覆盖旧证据。

## 仍需用户判断的清单

所有路径相对本轮证据根目录，可直接用 Excel 或文本工具查看 CSV：

- `verification/review-blockers.csv`：25 条需要明确目标/决定的记录（包含下面错绑）。其中 15 条 confirm 缺少唯一有效目标、10 条同份 CSV 内旧/新 ID 决定冲突。没有替用户挑首条。
- `verification/selected-master-quality-conflicts.csv`：42 条人工已选来源仍涉及主库重复键，表示资料选择已保存、主资料冲突待用户裁决；不强迫重做已有选择。
- `verification/master-quality-issues.json`：13 组主库重复 ICE/条码及原 Excel 行号。
- `delivery-final/pending-user-review.csv`：816 条待核对/有候选全清单；保留未决定的聚水潭项，不自动扩大本轮处理范围。
- `delivery-final/manual-selections-restored.csv`：22 条恢复的选择及聚水潭原对应项，供用户查看而非重做。

需要核对的具体来源 SKU（各仓别逐条见 blockers CSV）：

- 正确目标尚未确认：菲律宾仓 `ICEWM0039`。
- 无唯一目标：`714855625096`、`WM0095`、`757577407083`、`757577407380`、`757577407397`、`6974674957349`，以及聚水潭 `WM10013`。
- 旧/新 ID 决定冲突：各仓的 `KP0001`、`WM0005`、`757577407359`、`ICEWM0027`。两份原决定在 JSON `decision_records` 内完整保留。

这些是资料核对待决项，不是要求用户现在定义后续长期绑定方案。

## 验证命令及退出码

在仓库根目录设置本轮目录（PowerShell）：

```powershell
$p003 = 'D:/try one/ICEOS/.local/p0-03/run-20261019-rework/evidence/rework-2026-10-19T03-13-23-877132Z'
$env:P0_03_RUN_ID = 'run-20261019-rework'
npm run check:p0-03
python scripts/p0-03/verify-review-evidence.py "$p003/delivery-final"
node scripts/p0-03/verify-review-browser.mjs "$p003/delivery-final" "<new-verification-output-dir>"
npm run lint -- --max-warnings 0
npm run build
git diff --check
```

以上各项实际执行均 **exit 0**。浏览器脚本输出目录须已存在；复验建议使用新目录保留当前截图。

- 单元独立命令：在 `tools/` 执行 `python -m unittest discover -s p0_03_match/tests -p 'test_*.py' -v`，**68 项通过、exit 0**。原 48 项未删除/跳过；保留原测试方法，更新与当前“禁正式资格/禁自动决定”冲突的断言，新增 20 项真实缺陷回归。
- 完整门禁证据：`../check-2026-10-19T03-27-38-459Z/check-report.json`，单元、compileall、样表 smoke 均 exit 0。编译缓存使用该新证据目录内 `pycache/`，未改写旧缓存。
- 带人工 CSV 的实际重放：`verification/replay-final-command.json` 保存完整 argv/cwd/exit 0；标准输出及警告另存 `replay-final.stdout.txt` / `.stderr.txt`。两个历史 bundle 参数均显式列出。
- 逐条校验：`verification/artifact-final.log`，1417 行 JSON/CSV/HTML 内嵌记录与有效目标逐条一致；22 条恢复、错绑撤销、所有原输入和原证据哈希均通过。
- 同批显式 CSV 重应用：`verification/same-sample-reapply.log`，已保存快照再次配同一份冻结 CSV，1417 条有效记录完全一致、exit 0；只沿用本批来源记录 ID 沿革，不向新来源或以后导入复用商品选择。
- 浏览器实际验证：`verification/browser-report.json`，主核对页 1417 行、仓库页 530 行逐条 DOM 对比、筛选、22 条中的恢复样例、错绑空目标断言，页面错误为 0；截图 `*-restored.png` / `*-revoked.png`。
- lint/build：`verification/lint-closeout.log` / `build.log`，exit 0。
- actual diff：`verification/rework.diff` 为**相对本轮开始工作树**的实际文本差异，包含原先未跟踪的 P0-03 文件；`rework-diff-summary.json` 列文件及增删行。Git HEAD diff 含用户先前修改，不能冒充本轮差异。`verification/git-head.diff` 仅作对照。

初次 `npm run check:p0-03` **exit 1**：旧 `__pycache__` 写入被拒，非测试断言失败。失败证据 `../check-2026-10-19T03-21-58-486Z/` 保留；改用新证据缓存后重跑 exit 0，没有降低检查要求。

未消除的警告：openpyxl 提示原工作簿缺默认样式（不写回）；build 的 `next.config.ts` / sync import 链产生 1 个 NFT tracing 警告（相关应用代码未修改，build exit 0）；Git 全局 ignore 读权限及 CRLF 提示。未跑数据库/live/真实同步/生产验收；本轮没有数据库或 Next.js 业务代码改动。P0-01 旧 opt6 失败记录保持原状态，不据本轮门禁宣告解决。

## neat-freak 收尾

- 代码 `changed-and-verified`：人工核对计算与输出、仓别校验、空行处理；实际 diff 与来源哈希保留。
- 本地运行态 `changed-and-verified`：实际样表重放和浏览器静态页面；生产运行态 `out-of-scope`。
- 文档 `changed-and-verified`：current-state、current-task、本任务与本报告；旧任务/报告标为历史，相关相对链接检查通过。
- 规则 `changed-and-verified`：AGENTS.md 仅追加本批范围约束和任务入口；既有权限/高风险边界保持。
- 记忆 `out-of-scope`：只读参考旧索引定位边界，未写记忆。
- 工作区 `pending`：保留原 HOLD/脏修改、所有旧证据/缓存、前几次试跑、首次失败记录。本轮 Chromium 产生的根目录 `debug.log`（93 字节，VizNullHypothesis 提示）也保留，不自动清场。`.claude/context-status.json`、`.gitignore`、`package.json` 与本轮开始哈希相同；BigSeller scraper 既有 pyc 脏修改未处理。

复核现场完整保留。停止于 **P0_03_IMPLEMENTED_AWAITING_REVIEW**，由独立审查会话复核；不自动继续下一阶段。
