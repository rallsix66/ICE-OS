# P0-03 总验收报告：最后一批商品决定及独立通过

日期：2026-10-20。当前状态：**P0_03_PASS**，依据[独立总验收报告](../../.local/p0-03/reviews/evidence/independent-final-acceptance-20261020-49c832b7/independent-review.md)登记，文档收尾完成。本期范围为主库整理、商品身份标准、本批样表对应及人工决定保存、输出一致及历史可追溯；不表示全部资料核实或后续机制实现。

执行交付时的记录（独立总验收前，保留历史）：**本轮决定已落实，整体自验完成，等待P0-03独立总验收。** 执行侧未发现仍阻塞本期已授权范围的具体缺陷；这不是独立审查结论，也不登记P0_03_PASS。此前各批独立通过仅作为历史，不替代本次总验收。以下执行自验、初检失败、日志及当时停止点仍按原运行归属保留；新增独立结论与本次文档检查见文末。

## 范围、输入及唯一交付

本期验收范围为产品主库整理、[商品身份标准v1](../product-identity-standard-v1.md)、本批样表对应与人工决定保存、各输出一致且可追溯。具体授权见[本轮任务](../tasks/p0-03/2026-10-20-final-acceptance.md)和[明确决定JSON](./final-decisions-20261020.json)。不要求每款同时有BS/JST对应，不要求全部空值补齐，不把775条一般未核对记录交用户逐条决定。

唯一业务输入为已独立通过的 `.local/p0-03/run-20261020-jst-confirmations/evidence/jst-2026-10-20T03-04-57-810433Z-19d1be4d/delivery-final/`，开始前核对：

- match-bundle.json SHA256：`3c2babc9b13ca11fab14cb4bbce5e8617052319d06bc80c922256f6893346159`。
- manual-decisions.effective.csv SHA256：`48544cd03154131970fce220fb2ff7c704e18d7860e2ea7c72e6a0ef1ac8d921`。
- 本轮明确决定及冻结副本SHA256：`5ddd12acb924c9426598aeb7254fa097b4a895fa589c420a6ac2cd01d1318030`。
- 新bundle SHA256：`28d8d81c7d62beb95b99ebd188467c8a8ec69a9a6a4fe17df5970d8a0c6816ae`。
- 新有效CSV SHA256：`4428f4c80dcdde1c47508ac9eb433baa4f9a941934ae943cdd5e0116d3b49c14`。

**唯一最终输出为 [delivery-final-v2/](../../.local/p0-03/run-20261020-final-acceptance/evidence/final-2026-10-20T03-41-45-834059Z-cd7d4d19/delivery-final-v2/)**，覆盖输出在其中coverage/。`delivery-final/`是本轮首次生成、完整差异路径发现问题前的保留证据，不能作为现行交付；`delivery-reproduced/`仅是确定性复现，开发与负向目录均不作业务输入。所有旧批次保留原样。

- [八条完整前后](../../.local/p0-03/run-20261020-final-acceptance/evidence/final-2026-10-20T03-41-45-834059Z-cd7d4d19/delivery-final-v2/final-source-comparison.json)及[简明CSV](../../.local/p0-03/run-20261020-final-acceptance/evidence/final-2026-10-20T03-41-45-834059Z-cd7d4d19/delivery-final-v2/final-source-comparison.csv)。
- [核对页面](../../.local/p0-03/run-20261020-final-acceptance/evidence/final-2026-10-20T03-41-45-834059Z-cd7d4d19/delivery-final-v2/match-review.html)、[BS仓库总览](../../.local/p0-03/run-20261020-final-acceptance/evidence/final-2026-10-20T03-41-45-834059Z-cd7d4d19/delivery-final-v2/bs-warehouse-overview.html)、[主库总览](../../.local/p0-03/run-20261020-final-acceptance/evidence/final-2026-10-20T03-41-45-834059Z-cd7d4d19/delivery-final-v2/master-overview.html)。
- [126份覆盖CSV](../../.local/p0-03/run-20261020-final-acceptance/evidence/final-2026-10-20T03-41-45-834059Z-cd7d4d19/delivery-final-v2/coverage/product-coverage.csv)、[JSON](../../.local/p0-03/run-20261020-final-acceptance/evidence/final-2026-10-20T03-41-45-834059Z-cd7d4d19/delivery-final-v2/coverage/product-coverage.json)、[中文覆盖报告](../../.local/p0-03/run-20261020-final-acceptance/evidence/final-2026-10-20T03-41-45-834059Z-cd7d4d19/delivery-final-v2/coverage/coverage-report.zh.md)。
- [全部字段变化](../../.local/p0-03/run-20261020-final-acceptance/evidence/final-2026-10-20T03-41-45-834059Z-cd7d4d19/delivery-final-v2/all-field-changes.json)、[原22条对照](../../.local/p0-03/run-20261020-final-acceptance/evidence/final-2026-10-20T03-41-45-834059Z-cd7d4d19/delivery-final-v2/current-original-22-comparison.json)、[冻结输入清单](../../.local/p0-03/run-20261020-final-acceptance/evidence/final-2026-10-20T03-41-45-834059Z-cd7d4d19/delivery-final-v2/input-manifest.json)。
- [本轮命令、原始日志、保护哈希与实际diff目录](../../.local/p0-03/run-20261020-final-acceptance/evidence/final-2026-10-20T03-41-45-834059Z-cd7d4d19/verification/)。实际diff文件为 `verification/final-acceptance.diff`，含本轮新增未跟踪文件；按开始工作树比较，不是只看HEAD。

输入有效CSV唯一继承，无桌面CSV发现/合并，无重跑全库匹配替换。`inherited-baseline/`完整冻结上一轮70份交付，根目录另保留原始Excel/人工CSV、早期纠错、价格决定和编号沿革；新manifest、决定文件及显式audit-input-pins把本次授权与旧输入连起来，不接受任意新哈希即视为授权。recorded_at是本次记录时间，不虚构业务有效期。

## 本轮明确决定及真实变化

八条来源中，三条确认已有版本、三条新增有效选择、两条忽略：

- BS菲律宾新创376（mc-e1b56fb81b0db46c）、PH彩妆380（mc-73ac4812d7d8de64）、越南526（mc-b7bd376e964738cd）：SKU6974674957349，原已选主库19行WM0012保持，追加用户确认“升级普通版”，当前版本待决解除。CSV显式目标从原空填写补为同一19/WM0012，validated_manual_target随人工保存生效；原有效目标及JST引用没有变化，旧空填写与待决在事件中保留，不计新增选择。
- JST Sheet1原743行WM0006（mc-e78031a3b38c39f1）、745行WM0008（mc-06e9251af096ae18）：candidate→ignore，有效目标为空，理由仅“用户要求本批忽略”。主资料、来源、候选、数量和历史不删，不推导停产、不经营或全系统停用。
- JST原857行WM0130（mc-75e0ce710d064c4c）：candidate→confirm，主库121行WM0130，新增1条有效选择，仅限该来源记录。
- BS越南220（mc-44b8f0236d346bc7）及菲律宾新创321（mc-c8e6e17fc25361f1）：SKU757577407359、泰国特供版名称，defer→confirm，主库67行WM0073，新增2条选择；旧defer/旧编号及空目标留在前后事件中。DEE/MY/印尼既有选择不变，不建立同条码通用规则。

六项规格说明全部关闭，原问题对象、名称和数值差异保留为历史：WM0006/WM0008按本批忽略关闭，其余四项采用原主库C列，WM0031=20ml/支、WM0062=20ml/支、WM0098=120g/瓶、WM0130=20ml/支。未修改主资料字段、不换算g/ml、不用重量替代规格、空规格未猜填。WM0031/WM0098既有选择、WM0062全部BS选择及JST789行reject保持。历史7项审计说明当前均closed，其中六规格open=0、closed=6；菲越版本pending=0，remaining_user_decisions=0。

WM0081原62行与brush原107行分别可见，保存货号、名称和待确认说明；WM0081 JST候选与5条未确认BS刷子不猜绑、不合并。用户要求后续正式系统继续保留两份及待确认状态，已登记为后续要求，本轮未增加正式页面。

实际重算：126份主资料，125个非空ICE货号唯一，另1份新品缺码；来源1417条（BS530/JST887）。有效选择545→**548=BS430+JST118**，覆盖**114双方/2仅BS/4仅JST/6双方暂无确认**，合计126、已有选择覆盖120份。状态548已选、774待核对、1候选、3拒绝、3忽略、88规则外，合计1417。计数来自记录，未手改摘要。

原Excel数据区217行，其中85行全空、132行非空资料、131行非空货号、125个不同货号；整理后126份资料，不能把非空原始行称为唯一商品，也不能称126份都编码完成。原行锚点、别名、来源版本可互相追溯。

恰好8条candidate对象有授权变化，其余1409条完整相等。原545条有效目标及JST引用保持，原22条完整记录逐条相等。有效CSV3160行，按编号沿革对齐8条变更，其余3152条内容及相对顺序不变。9份主资料总览仅增加本批审计说明/有效来源ID，data、身份、规格、价格与原行追溯不变；完整216处字段差异可重构新bundle，不代表216个商品改变。八个新事件只保存一次，旧4个四项业务确认事件、12个JST事件及纠错历史保持。

## 本期实现与验收证据

- **主库整理及身份标准：已实现/已验证。** 重复资料按用户指定主行和来源整理，WM0128货号更正、WM0093包装条码/原H列分开、单颗/整盒及版本不混并；WM0072仍锚点66，现价5.18/5.68来自216，两版原价格及历史完整。125非空货号唯一是样表验证，不是数据库唯一约束。原121回归和历史基线断言继续通过，未改旧22份测试源码。
- **本批人工对应保存：已实现/已验证。** 校验完整来源、原文件哈希/物理行、货号及完整目标，不按同码批量确认。旧编号/新编号纠正、菲律宾ICEWM0039错误WM0093撤销及新授权WM0039、JST五位货号、原22条及JST冲突保护保持。当前与历史分列，后续clear/reject/ignore/defer均能覆盖有效选择，历史事件不复活旧目标。
- **输出与追溯：已实现/已验证。** 全1417条来源、126份资料及8条授权对照原Excel，JSON、有效CSV、核对页、BS总览、主库及覆盖逐条一致。浏览器读取6份本地文件，3份HTML分别全DOM比对1417/530/126行，另实际检查本轮8条、四C列、两刷子、未建档/价格/图片说明；pageErrors及remoteRequests为空。执行侧另目视本轮截图，不将静态检查冒充独立审查。
- **保护与可重现：已实现/已验证。** 全147份产物（128业务/完整继承文件＋19本轮覆盖）同输入再生成逐字节一致，无字段排除、无路径归一化，8事件不重复。覆盖再生只读使用同一最终业务目录作输入，业务再生从固定旧基线和明确JSON重新生成；两个步骤的原argv分别记录。非空目录及错误哈希保护真实执行，旧产物无覆盖。

## 本轮实际重跑、命令和退出码

以下是本轮执行侧重跑，不是独立审查重跑，也不是仅核查旧日志。`verification/<label>-command.json`有实际argv、cwd、环境、退出码，配套stdout/stderr完整保存。最终需要的检查均exit 0：

- `unittest-final-verified`：`python -B -X utf8 -m unittest discover -s tools/p0_03_match/tests -p test_*.py -v`，**136项＝原121＋本批15**。初版135通过后，修复差异路径再加1项并重跑136，没有删测、跳过或弱化旧断言。
- `gate-final-verified`：`npm run check:p0-03`，136回归、compileall及独立样表smoke均0。子报告 `.local/p0-03/run-20261020-final-acceptance/evidence/check-2026-10-20T03-50-01-522Z/check-report.json`；smoke输出是门禁证据，不作业务基线。门禁自身子日志按现有脚本保留尾部，单独unittest日志完整，不把子报告截断字段说成完整原始stderr。
- `generation-final-v2`、`coverage-final`：明确决定保存和覆盖生成，均0。
- `verify-final-v2`：全量原行、原545/22、3160CSV、全部投影和216字段差异完整重构，0。
- `negative-new-final-v2`：21组（8项错误计划/非空/重复输入拒绝＋13项当前负向操作），0。错误来源/原行/目标/哈希/冲突拒绝，不产生部分结果；当前清空/拒绝/忽略/暂缓真实生效，原历史、价格及其他目标保持。被测拒绝命令预期exit1，保护验收exit0。
- `negative-inherited-corrected`：原12组业务负向在新结果重跑，0；`history-negative-16`：原16组JST保护在它的历史545基线上重跑，0，保留旧数量断言，没有强套旧计数到新授权结果。
- `history-jst-verify`：旧JST交付的原全部历史断言重跑，0；`history-audit-28`与`history-audit-32-corrected`：原审计全量及28/32组负向在各历史基线重跑，均0；`audit-final-v2`：新基线全量＋44组审计负向，0。
- `images-final`：10项图片边界测试，0；`browser-final-verified`：上述6文件真实浏览器，0。
- `regenerate-business`、`regenerate-coverage`、`verify-reproduced`、`regeneration-and-guards-verified`：生成、全量核验、147份字节比对及2项审计CLI保护，均0。19份现行覆盖文件在非空拒绝后逐字节不变，错误哈希不创建输出。
- `lint-final-verified`：`npm run lint -- --max-warnings 0`，0；`build-final`：`npm run build`，0。未修改Next.js业务代码；build后仅Python追溯修复和核验脚本调整，受影响回归/门禁/最后lint已重跑，不为此重复无关构建。
- 最终链接、状态/口径一致性、保护哈希、真实工作树diff与`git diff --check`见本目录closeout凭证；实际diff含所有新增文件。未暂存，HEAD及原未提交修改保留。

复现关键命令（PowerShell，仓库根目录；输出目录须为空且不能覆盖本交付）：

```powershell
$env:PYTHONUTF8='1'
$env:PYTHONDONTWRITEBYTECODE='1'
$env:PYTHONPATH=(Join-Path (Get-Location) 'tools')
$baseline='.local/p0-03/run-20261020-jst-confirmations/evidence/jst-2026-10-20T03-04-57-810433Z-19d1be4d/delivery-final'
$evidence='.local/p0-03/run-20261020-final-acceptance/evidence/final-2026-10-20T03-41-45-834059Z-cd7d4d19'
$newOutput="$evidence/reviewer-replay-new" # 非空目录会拒绝覆盖，重跑须换新目录
python -B -X utf8 -m p0_03_match.cli finalize-sample --evidence $baseline --decisions docs/p0-03/final-decisions-20261020.json --output $newOutput
python -B -X utf8 scripts/p0-03/verify-final-acceptance.py "$evidence/delivery-final-v2" --coverage "$evidence/delivery-final-v2/coverage"
python -B -X utf8 scripts/p0-03/verify-product-coverage.py --delivery "$evidence/delivery-final-v2/coverage" --input-pins "$evidence/verification/audit-input-pins.json" --self-test
```

### 初检失败与既有警告

所有初检均保留，最终采用v2目录而非覆盖首版。开发曾发现完整差异路径未对递归文件名中的“/”转义，已仅在final局部采用JSON Pointer的~0/~1转义，并新增嵌套增删/完整重构回归；旧共用helper和历史断言未改。另有明确文案断言、显式manual字段核验口径、审计hash对象及保留reject名称的开发适配失败，修复/核实后严格验证通过；各开发JSON/stdout/stderr在development-checks/，与正式检查分开。

正式初检非零receipt保留：`history-audit-32`传错pins路径exit1、`negative-inherited-final`传错脚本名exit2；均改为正确现有路径后重跑0。`browser-final-v2`因断言期待“升级普通版/已确认”而报告原文是“三条WM0012已由用户确认升级款”失败exit1，改为核验完整确认句、三原行/原目标、解除待决、不新增及历史保留，产物未改；`regeneration-and-guards`的错误哈希确已被拒绝，但辅助断言期待错误消息不符而exit1，改为精确核验baseline_hash_mismatch后两项保护通过。均未以忽略异常换取通过。`closeout-preliminary`最初误将历史32组实际运行数当成静态rejects调用数，exit1；只读核对发现原脚本共有33个条件分支调用，新脚本逐个AST完全相同，历史28/32实际运行均通过。保留初检helper副本及日志，改正新辅助检查计数，不修改原断言。

开始快照复制碰到现有浏览器runtime缓存的Windows长路径限制，尚未改源文件；改为明确排除runtime/依赖/构建目录的源文件快照，P0-03全部旧证据仍完整哈希。该初检只保存退出码/原因说明，不声称完整原始stderr；`development-checks/snapshot-initial-failure.json`与正式完整命令日志分开。只读盘点另见既有pytest缓存读取权限提示，未触碰缓存。

本次真实出现的既有警告：openpyxl默认样式提示；build一条next.config.ts→sync/server-actions→api/cron/dry-run的NFT tracing警告；Git全局ignore权限及换行提示。未改无关代码消警告，没有把这些写成全阶段PASS。未运行DB/live或真实账号接入测试，没有生产部署可验。

## 执行交付时文档及工作树检查（历史）

本次实际修改15份源文件/文档：修改7份、新增8份，清单与逐文件前后SHA256在verification/final-acceptance-diff-summary.json，完整diff包含新增未跟踪内容。58处Markdown链接有效，状态/实际计数/唯一输出一致，git diff --check退出码0。961份其他源文件、4912份全部旧P0-03证据、22份旧测试源码、5份原始Excel/CSV哈希保持，AGENTS、HOLD及其他原有未提交修改未变，HEAD未变、暂存为空。源文件快照排除.git、node_modules、.next、.local、浏览器runtime；旧P0-03证据另全量保护，不将依赖/运行时缓存包含在源文件保护计数中。P0-02/P0-01文档历史段保持。

上述为本轮执行检查，closeout-report.json和最终命令日志保留实际结果，不回写旧审查哈希。没有把本轮自验、旧批次独立通过或旧日志核查合并成一次独立验收。

## 已批准延期、后续范围与独立验收边界

本轮用户已明确的版本和六项规格不再列待决。以下延期仍是事实，均未被改成0、猜填或自动确认：

- WM0081与brush分别保留，JST唯一候选仍WM0081，5条BS刷子未确认；后续正式系统须保留两份及待确认状态。
- 原122行新品缺货号/条码，工厂失效引用、其他缺失继续保留。规格专列空114、条码空6、成本空2、运营价空7是资料事实，不自动规定全部必填；未认领其他来源商品。
- 图片128锚点、123份找到对象/3未找到；内容全部未核验，未找到不证明实物无图，空单元格不等于没有图片。
- 原3拒绝、88规则外及一般未核对775条继续保留。WM0007ignore仅本批处理，WM0006/8ignore不推导不经营；WM0040旧商品资料未删、不擅自判停产。
- WM0070/WM0072尚未BS建档，等待后续创建是正常状态，不造BS来源、不催要SKU、不据此补库存0。

这些已批准延期不阻塞本期有限范围的执行交付，不宣称产品资料已全部核实。后续通过飞书识别新品、BS通常新品发出时才建档且不以JST匹配为硬前提；飞书接入方向获用户认可，BS考虑抓取，JST API可用性待核实，均非接入已经实现。正式对应关系保存、自动复用、数量归集、组合/换款机制、库存同步与估值仍须业务流程另定。

neat-freak：代码及本地输出changed-and-verified；现役状态/任务/标准/本报告changed-and-verified，标准仍为唯一规则正文；旧证据及未涉及业务verified-current；上述延期pending；真实运行/生产和长期使用实现out-of-scope；记忆generated-read-only未写。保留此前[主库整理独立通过](./verification-report-p0-03-curation-20261019.md)、[四项确认独立通过](./verification-report-p0-03-confirmations-20261019.md)、[审计补修独立通过](./verification-report-p0-03-coverage-audit-repair-20261020.md)、[JST本批独立通过](./verification-report-p0-03-jst-confirmations-20261020.md)，包括原CHANGES_REQUIRED及补修过程，不改写旧报告或旧哈希。

执行侧交付时的停止点（历史）：本期整体自验已完成，未发现仍阻塞上述授权范围的具体缺陷，交回独立总验收。停止于 **P0_03_IMPLEMENTED_AWAITING_REVIEW**；不自行登记独立通过或P0_03_PASS，不入库、不接真实服务、不发布/同步库存、不估值、不提交/推送/合并/部署/清场或推进下一阶段。全部原始资料、旧证据、HOLD及其他未提交修改保留。

## 独立总验收及文档收尾（2026-10-20）

[独立总验收报告](../../.local/p0-03/reviews/evidence/independent-final-acceptance-20261020-49c832b7/independent-review.md)结论为**P0_03_PASS**，没有发现阻塞本期有限范围验收的实质缺陷。依据该结论登记阶段通过，不由执行自验或此前分批通过推定。唯一业务交付仍为上述delivery-final-v2/，决定、产物及其哈希没有因文档登记而改变；原审查源码哈希及执行diff对应收尾前版本，本次五份文档修改不回写那些快照。

独立审查实际重跑与核查：

- 136项回归；1417来源、126主资料、原545目标/JST引用、原22条、八条原Excel来源、3160行CSV及全部保存投影通过。
- 21组本轮业务负向、原12组在新结果上及原16组在历史基线上通过；新结果全量审计及44组负向、原基线全量及28/32组负向、10项图片对象测试通过。
- 6个本地文件实际浏览器核验，3份HTML全DOM1417/530/126行及本轮决定、四款C列、两个刷子、价格与未建档说明通过；pageErrors和remoteRequests为空。主审另外目视精油套盒及WM0081截图。
- 业务和覆盖独立再生成，147份逐字节一致，无排除字段或路径归一化：58份当前业务文件、70份继承基线、19份当前覆盖。八条新事件各一次，旧12条JST及4条业务事件保持；2项审计CLI保护通过。
- 保护哈希、实际修改范围、58处链接及diff检查通过。另有19项冻结基线探针均通过；直接OOXML逐格核验八条来源、目标及C列，并逐份核算覆盖、120份已选主库及6仓汇总。审查中曾将全部master_provenance不变的过宽断言改为逐字段核验授权说明，未修改实现或交付，过程详见独立报告。

**独立审查仅核查执行日志：**完整P0-03门禁、lint、build未独立重跑。审查核对执行命令、原始日志、退出码、子报告及当前源文件关系；最后门禁三步、lint和build均exit 0，build早于最后Python及浏览器核验脚本修订，本轮Next业务源码/构建配置未改，受影响检查在最后代码上重跑。31份执行receipt、首版输出和5条正式初检失败均保留，不改写为一次全绿；长路径快照初检仍仅为退出及原因记录，不称完整原始stderr。openpyxl默认样式、NFT tracing及Git提示仍保留。

**本次文档收尾检查：**仅修改current-state、current-task、本报告、商品身份标准的现状/停止点及P0-03 README当前入口五份文档；链接存在性、状态/范围/延期一致性及实际diff核对通过，`git diff --check`退出码0。未重跑功能测试、门禁、浏览器、lint或build；没有修改功能、决定、交付产物、原始资料、旧证据或HOLD。执行自验、独立重跑、独立日志核查和本次文档检查是分别进行的检查，不合并记录。

本期PASS不要求每款都有BS/JST对应或补齐全部空值。两份刷子及候选、新品缺码、工厂/其他空值、图片内容未核验、775条一般未核对、3拒绝及88规则外继续保留；WM0070/WM0072等待BS建档为正常状态。它们不阻塞本期有限范围PASS，仍是后续实际未完成事项。正式关系保存、真实接入、长期自动复用、数量归集、组合/换款、库存同步及估值仍属后续方案与实施，未因PASS获得开发或生产授权；旧版库存发布要求不作为本期欠账重新引入。

neat-freak本次文档面changed-and-verified，代码/决定/本地交付及旧证据verified-current（沿用独立验收，不在本次重跑），延期pending，真实接入/生产及后续机制out-of-scope，记忆只读未写。历史CHANGES_REQUIRED、补修、执行自验和独立结论各自保留。当前停止于**P0_03_PASS（文档收尾完成）**；不暂存、提交、推送、合并、部署、清场或推进下一阶段。
