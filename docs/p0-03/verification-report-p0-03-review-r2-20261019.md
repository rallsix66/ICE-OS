# P0-03 两项复审补修报告

> 历史报告：本轮两项补修独立通过结论保留。用户随后另行授权主库整理和明确样表对应，现役任务及交付见[本批整理报告](./verification-report-p0-03-curation-20261019.md)。下文“当前”“未授权”“待决”均指R2当时状态，不覆盖后续新授权。

日期：2026-10-19。状态：**本轮两项补修已独立审查通过，文档收尾完成**。

上一轮独立复审为 **CHANGES_REQUIRED**；补修后，用户于 2026-10-19 在本会话确认本轮两项已独立审查通过。本次仅同步该结论，不另行实施或重跑独立审查，也不将通过范围扩展为 P0-03 全业务阶段 PASS。

## 独立审查通过范围与剩余业务待决

通过仅覆盖两项：① `ICEWM0039` 历史撤销事件与当前 CSV 决定分离，明确的新 reject/ignore/clear/defer 生效，错误目标继续被阻止；② 人工引用 JST 与所选主库行的明确矛盾按双方实际已选主库行检查，原填写内容保留并待核对，不要求两系统 SKU 字符串相同。相关负向回归与各输出一致性属于本轮验证范围，实施时证据见下文。

剩余业务待决保持不变：`ICEWM0039` 正确目标未获授权、当前目标为空；主库重复键/缺失资料、其他无唯一目标与旧/新 ID 决定冲突尚未裁决；后续两系统持续绑定、自动匹配及关系使用方案仍未确定。原 22 条人工选择继续保存，不代表正式映射、以后导入复用或库存发布方案通过。这些待决不属于本轮通过范围，本次未处理。

独立审查通过结论依据用户本次明确确认登记。下文 80 项测试及运行记录均为实施时已有证据，本次文档同步未重跑功能测试。

## 已实现

**历史撤销与当前决定分离。**沿用已冻结历史 `correction_events`，不以当前 CSV 的新决定/新备注重写原撤销，也不重复生成事件。`ICEWM0039` 的原 `WM0093` 错绑、原 confirm、原备注及纠错原因继续保留。当前 reject/ignore/clear/defer 分别生效；历史撤销不再强制把它们改成 defer。无新目标授权，当前有效主库/JST 目标始终为空；confirm 仍不能恢复错绑或选替代目标。

历史纠错原因独立保存在 `historical_correction_reason`，页面和 CSV 分开显示。实际原 CSV 仍填 confirm，因此本次交付保留 `review_decision=confirm`、`review_state=pending`、有效目标为空；不把“保留当前输入”解释为通过核对。

**JST 人工引用冲突检查。**先计算所有记录当前实际已选主库行，再检查人工 JST 引用。若来源所选主库行与引用 JST 已选主库行不同，将该人工引用记录标为待核对、有效目标为空；原人工行/ICE、JST ID/SKU、决定、备注、已验证但未生效的目标均保留。`manual_jushuitan_conflict` 记录双方主库行号/ICE 和引用 ID。JST 自身原选择不被改写。

检查不要求 BigSeller SKU 和 JST SKU 字符串相同。同 ICE 货号但不同 Excel 行仍有矛盾；JST 人工已选行优先于其引擎候选；JST 没有有效已选行时不凭候选猜测矛盾，也不替其确认。处理顺序不影响结果。

## 实际交付与保存

唯一现役结果目录：

```text
D:/try one/ICEOS/.local/p0-03/run-20261019-r2/evidence/rework-r2-2026-10-19T03-58-58-100958Z/delivery/
```

新证据根目录下另有 `before/`、`verification/` 和 `negative-cases/`。负向目录是明确标注的注入测试副本，不作为业务结果；不覆盖任何旧批次或原始文件。

输入为上一轮 `rework-2026-10-19T03-13-23-877132Z/delivery-final/`；显式使用其中冻结 CSV 和两份冻结来源沿革 bundle。完整命令、cwd、exit 0 在 `verification/replay-command.json`。当前 CSV 冻结副本与原桌面 CSV 的 SHA-256 均为：

```text
1392022156e2cdd0ae748ddc5424334fc9ef76f175c40a8c56af0cd1d2cc92c5
```

1417 条实际结果、22 条人工选择均通过复核；22 条引用 JST 的实际已选主库行均与原选择一致，无新增冲突。有效状态仍为人工已选 510、待核对 801、有候选 15、拒绝 3、规则外 88。除新增的历史/冲突说明字段，旧输出字段仅 `ICEWM0039` 的 review_decision 从被强制的 defer 改回原 CSV 的 confirm，详见 `verification/actual-data-changes.json`；原目标仍为空，旧撤销事件结构完全相同。没有处理其他业务待决。

`verification/preservation-check.json` 核实：18 个原测试文件字节不变（原 68 项不删、不改、不跳过）；463 个旧证据文件哈希不变（清单排除缓存目录，旧缓存也未写入）。原始 CSV/Excel、22 条选择、旧失败/审查证据及 HOLD/脏修改均保留。

## 计数更正

主库仍为 217 行数据区、85 行全空、132 行非空资料。其中 **131 行 ICE 货号非空，125 个不同的非空 ICE 货号**；原 Excel 第 122 行有资料但无 ICE 货号。此前 126 个不同值包含空字符串，不能表述为非空货号数量。上一轮报告已就地标注更正；不是 132 个唯一商品。来源仍为 JST 887 + BigSeller 530 = 1417 条，本轮不改变其他资料口径。

## 负向验证与各输出一致性

新增 `test_review_r2.py` 共 **12 项**，原 68 项原样保留，总计 **80 项通过**。修复前新增用例运行 exit 1（15 个失败断言/子用例），证据 `verification/regression-before-fix.log`；修复后门禁 exit 0。覆盖：

- 四种明确负向决定、带旧错绑字段的 clear、当前 confirm/新备注不重写历史、没有新目标授权仍为空。
- JST 已选行矛盾、相同 ICE 但不同资料行、跨系统不同 SKU 但同一所选行允许、JST 人工目标覆盖引擎候选、JST 暂缓/拒绝/忽略/清除/未选保持原状、顺序无关、重应用保留原输入且重新检查。
- 各类 CSV、JSON、两页 HTML、主库汇总和串联总览一致；待核对记录不进入已选明细或串联关系，原填写字段和历史事件仍可查看。

另从真实 1417 条冻结 CSV 生成 **5 组测试副本**（每组 1417 条）：

1. `ICEWM0039` 分别注入 reject、ignore、clear、defer，均生效且目标为空，旧撤销事件不变。
2. 给 `CHIC-WM0047-P05`（原选主库第 45 行 WM0047）注入引用 JST `WM0048`（实际已选第 46 行）。该条明确待核对，保留第 45 行与注入的 JST 内容，双方行号 45/46 可见，不自动换到第 46 行。此修改只存在于负向副本。

`negative-cases/negative-report.json` 保存各命令和注入 CSV 哈希；全部 CLI exit 0，语义断言和各输出逐条一致校验通过。当前业务交付 CSV 未改变。

实际交付与上述 5 组负向副本均用 Playwright 验证主核对页 1417 行、仓库页 530 行的实际 DOM。包括当前决定、历史原因、原填 JST、双方冲突行号，搜索/筛选及空目标断言。6 组均 exit 0、页面错误 0。报告在 `verification/browser-r2-report.json`，各 `browser-*` 子目录保存日志和截图；冲突场景有 `*-jst-conflict.png`。旧浏览器缓存不参与结果。

## 命令与退出码

仓库根目录 PowerShell，先设置路径：

```powershell
$r2 = 'D:/try one/ICEOS/.local/p0-03/run-20261019-r2/evidence/rework-r2-2026-10-19T03-58-58-100958Z'
$env:P0_03_RUN_ID = 'run-20261019-r2'
$env:PYTHONDONTWRITEBYTECODE = '1'
npm run check:p0-03
python scripts/p0-03/verify-review-evidence.py "$r2/delivery"
python scripts/p0-03/verify-review-r2.py "$r2/delivery" '<new-negative-evidence-dir>'
node scripts/p0-03/verify-review-browser.mjs "$r2/delivery" '<existing-new-browser-log-dir>'
npm run lint -- --max-warnings 0
npm run build
git diff --check
```

以上实际执行均 **exit 0**。负向脚本拒绝使用已存在的输出目录。浏览器另对 5 组负向输出重复执行，argv/cwd 均记录在浏览器汇总报告。

- 单元独立命令：在 `tools/` 执行 `python -m unittest discover -s p0_03_match/tests -p 'test_*.py' -v`，80 项 exit 0；日志及原 68 项基线在 `verification/`。
- 完整门禁：`../check-2026-10-19T04-02-22-316Z/check-report.json`，80 项、compileall、新证据样表 smoke 均 exit 0。编译缓存仅在新证据目录。
- 实际样表逐条核验：`verification/artifacts.log`，1417 条、22 条选择、原撤销事件与文件哈希均通过。
- lint/build：`verification/lint.log` / `build.log`，exit 0。
- 实际差异：`verification/rework-r2.diff` 为相对本轮开始工作树的文本 diff，含未跟踪任务文件；`rework-r2-diff-summary.json` 为文件清单。不要以 HEAD diff 代替本轮差异。
- 文档链接/新增行空白/保护文件检查及旧证据哈希结果在 `verification/closeout-report.json`。

未消除提示：build 仍有 1 条现有 `next.config.ts`/sync import 链 NFT tracing 警告；openpyxl 提示原工作簿缺默认样式；Git 全局 ignore 权限及 CRLF 提示。未修范围外代码。未执行 DB/live/真实同步/生产测试，本轮无数据库或 Next.js 业务代码改动。

## neat-freak 状态与停止点

- 代码与本地证据视图：`verified-current`，沿用两项修复的实施证据及独立审查通过结论；本次没有代码或视图改动。
- 文档：`changed-and-verified`，本次仅更新 current-state、current-task 和本报告，登记两项补修独立审查通过、通过边界及剩余业务待决；文档链接/一致性/diff 检查通过。实施任务包保留当时待审状态，当前结论以这三份文档为准；其他报告及全部证据不变。
- AGENTS.md：`verified-current`，已读取核对，本轮没有改写规则或增补长期方案。
- 记忆、生产及发布：`out-of-scope`，记忆只读，无入库、发布、同步、迁移、提交或推送。
- 本轮两项独立复核：已通过（用户明确确认）；其余业务待决：`pending`，原样保留，不替用户裁决。
- 工作区：保留全部旧证据/失败记录/缓存、HOLD 与脏文件，不清场；本轮浏览器调试输出限制在新证据目录。

停止于**本轮两项补修独立审查通过、文档收尾完成**。本次仅三份文档改动，未重跑单元、浏览器、lint 或 build；保留其原始结果与既有警告。全部证据和 HOLD 保留，不清场、不提交、不推送，不推进下一阶段。
