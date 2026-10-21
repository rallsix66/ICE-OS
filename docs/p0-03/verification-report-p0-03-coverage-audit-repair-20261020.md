# P0-03 两项审计说明补修验证报告

日期：2026-10-20。执行交付时状态：**P0_03_IMPLEMENTED_AWAITING_REVIEW**。本轮仅补齐图片对象说明及三款已选商品规格差异，执行交付时交回独立审查；现依据[本轮独立审查报告](../../.local/p0-03/reviews/evidence/independent-coverage-repair-20261020-472a6fae/independent-review.md)登记：**本轮两项审计说明补修独立审查通过，文档收尾完成**。通过范围仅为图片对象说明和规格差异审计补齐，不代表产品资料已全部核实、业务待决或长期方案已完成，不登记整个P0-03 PASS，阶段状态保留。

## 依据及唯一最终交付

[原独立审查](../../.local/p0-03/reviews/evidence/independent-identity-coverage-20261020-90b3e4f1/independent-review.md)当时结论为CHANGES_REQUIRED，仅两项P2审计说明。身份标准和覆盖统计核对通过，当时未登记整批独立通过。[附加原行/图片证据](../../.local/p0-03/reviews/evidence/independent-identity-coverage-20261020-90b3e4f1/additional-findings-evidence.json)、[旧覆盖报告](./verification-report-p0-03-identity-coverage-20261019.md)和旧 `delivery-final-v2/`全部保留，未覆盖或改写旧日志。补修按用户粘贴指令执行，指令与审查两文件的冻结副本及哈希在新证据 `review-inputs/`中；以下保留执行过程与验证历史。

业务基线保持：`.local/p0-03/run-20261019-confirmations/evidence/confirmations-2026-10-19T08-58-31-979047Z/delivery-final/`。开始前、生成、验证及收尾核对：

- `match-bundle.json` SHA256：`c0fa4bc9814080a9e78d15ad7136276e03156254d67a3fe59e4d49c841e80936`
- `manual-decisions.effective.csv` SHA256：`a66c564942220f5df4e1043ab2b076f1cec26c3056fa8dffd5a2e2733844b58f`

新证据根目录：`.local/p0-03/run-20261020-coverage-audit-repair/evidence/repair-20261020-020419-06fb82d8/`。**唯一最终输出是其中 `delivery-final/`**。`delivery-trial/`仅执行内试生成，`delivery-reproduced/`仅复现比较，均保留。下文未注明路径均相对此证据根目录。新输出只是审计说明，不能作为人工决定源。

- [完整覆盖CSV](../../.local/p0-03/run-20261020-coverage-audit-repair/evidence/repair-20261020-020419-06fb82d8/delivery-final/product-coverage.csv)及[JSON](../../.local/p0-03/run-20261020-coverage-audit-repair/evidence/repair-20261020-020419-06fb82d8/delivery-final/product-coverage.json)
- [中文覆盖报告](../../.local/p0-03/run-20261020-coverage-audit-repair/evidence/repair-20261020-020419-06fb82d8/delivery-final/coverage-report.zh.md)、[来源索引](../../.local/p0-03/run-20261020-coverage-audit-repair/evidence/repair-20261020-020419-06fb82d8/delivery-final/source-records.json)和[摘要](../../.local/p0-03/run-20261020-coverage-audit-repair/evidence/repair-20261020-020419-06fb82d8/delivery-final/coverage-summary.json)
- [图片对象证据](../../.local/p0-03/run-20261020-coverage-audit-repair/evidence/repair-20261020-020419-06fb82d8/delivery-final/image-object-evidence.json)
- [6项规格审计＋原菲越问题](../../.local/p0-03/run-20261020-coverage-audit-repair/evidence/repair-20261020-020419-06fb82d8/delivery-final/audit-questions.json)

## 两项分别修了什么

图片：保留126份“产品图片”单元格值空的事实，并新增每份 `image_evidence`，明确空单元格不等于缺少嵌入图片。只读解析业务基线冻结商品库Excel（SHA256 `930e763d5c161d7452061344c99d547ecb9b4a7561d157cc2998a536c717f0f8`），保存原文件、工作表、锚点原行列及零基坐标、sheet→drawing关系、drawing、embed关系、媒体目标/存在性和媒体字节哈希。没有提取展示、视觉核验、补图或修改Excel。

实际读取结果：128个锚点全部可解析到存在的媒体文件；按每份主资料全部 `source_rows`关联、按主资料去重后，123份找到关联对象、3份未找到、0份无法判断。未找到的三份是WM10012原39行、WM0117原108行、缺码新品原122行。128是锚点数，不能说成128个商品。**找到对象不代表图片内容正确；未找到对象不证明商品确实无图**，全部 `content_verified=false`。解析不全时以unknown和原因表达，不伪装无图。重复资料同时保留各原行锚点，没有只查primary_row。

规格：保留原WM0006、WM0008、WM0130三项，再补以下三项已选商品差异，并在覆盖表 `spec_audit_question_ids`中逐份定位。所有原文件哈希、页、行号、原值、来源ID和当前选择在问题证据中保存：

- **WM0031**：主库原25行 `20ml/支`；JST首份文件Sheet1原758行名称含 `20g`，来源 `mc-6cc7fbd3df5c1d06`，保持有效选择。另3条BS选择亦保持，总4条选择。原22条BS351引用的旧JST编号保留，不改历史引用。
- **WM0062**：主库原83行 `20ml/支`；BS“单个SKU”230、313、383、384、385行名称含防晒棒 `20g`，涉及DEE、菲律宾新创启辰、MY、越南、印尼，5条选择全部保持。JST原789行 `mc-d10dd266982ba120`仍reject、目标为空，仅作拒绝证据，不重新确认。
- **WM0098**：主库原92行 `120g/瓶`；JST原825行、BS“单个SKU”2、188、189、221、223行名称含 `120ml`，6条有效选择全部保持。BS223原SKU为WM0098，其余四条为780103214060，原值不改。

新增三项含12条有效差异来源和1条拒绝旁证；三款所有既有选择共15条，均未变。差异不能证明错品，也不能证明g与ml等价，不换算、不猜哪边正确、不修改主库规格。原3＋新增3＝**6项规格审计事项**，只是审计说明，**不写基线pending-business或人工决定文件，不要求用户现在提供包装或作答**；是否补正资料留待后续。本轮验收要求是准确记录差异。

## 业务事实及保护

新输出从同一业务基线重算，未重跑旧匹配或从桌面CSV重建。126份资料、125个非空且唯一货号＋1份缺码；覆盖104双方、12仅BS、2仅JST、8双方暂无已确认对应；534条有效选择（BS428/JST106），涉及118份；1417条来源（BS530/JST887），状态为已选534、待核对776、候选16、拒绝3、规则外88。

新旧覆盖逐份比较，业务列完全相同；仅增加图片说明/规格问题ID并澄清图片空值备注。来源索引1417条与旧输出字节一致，126份 `price_facts`不变；原菲越问题不变，原三项规格证据保留，只按本轮要求取消现在作答的措辞。新增三项只在审计输出，不改业务基线或决定文件。比较明细见 `verification/business-invariance.json`。

特别保护：原22条完整记录及JST引用；菲越三条WM0012选择和原1项版本业务待决；WM0072现价5.18/5.68、两版历史及JST未确认；所有拒绝/defer/规则外和刷子、新品等延期。身份标准与AGENTS均未修改。原始Excel/CSV、全部旧证据（含独立审查）、HOLD及其他无关未提交文件按开始哈希逐项核对，结果在 `verification/closeout-report.json`。

保护核对结果：6382份其他源文件、2702份旧P0-03证据、5份原Excel/CSV、21份原测试源文件均字节未变；原14组负向调用AST完整保留，新增至28组。仅5份既有审计脚本/当前文档修改，另新增图片helper、隔离测试、任务包和本报告共4份。49个Markdown链接有效、语法与状态/计数检查通过，`git diff --check` exit 0；含新增文件的实际diff相对本轮开始工作树生成。

## 补修执行批次的验证与复现（历史）

所有正式命令的argv、cwd、实际退出码和输出均在 `verification/*-command.json`及同名log；本次执行：

- `image-object-tests`：10项隔离合成OOXML测试，exit 0。覆盖空单元格但有对象、仅secondary来源行有对象、按主资料去重、缺对象不证明无图、缺关系/缺媒体/错误drawing等unknown及原因、错误输入哈希拒绝。合成媒体为虚拟字节，不提取真实图片。
- `generation-final`、`verify-final`：exit 0，全量126/1417逐项核验、CSV/JSON/摘要/问题/中文报告一致。验证器独立解析冻结OOXML，不调用生成器或图片helper作为正确答案；原14组负向保留，新增14组图片/已选规格负向，合计28组均拒绝篡改。
- 新负向涵盖图片错商品关联、漏锚点/漏主资料证据、统计篡改、只查primary丢来源、错误标注内容已核验、空单元格等于无图、未找到等于真实无图、unknown无原因、媒体哈希篡改；已选规格漏问题/漏来源/错目标/漏拒绝证据。
- `regenerate`、`verify-reproduced`：exit 0，第二个全新目录同样通过全量及28组负向。`regeneration-comparison.json`递归盘点实际**17份完整产物**，逐字节及哈希完全一致，不排除任何业务字段或文件；两输出目录为同层级兄弟目录，中文报告相对标准链接相同。
- `cli-guards.json`：两项原CLI保护重跑通过。非空输出拒绝且17份原内容哈希未变；错误CSV输入哈希拒绝且未创建输出。两条被测命令按预期exit 1，保护验收exit 0，不把预期拒绝写成失败或放行。
- `closeout-report.json`：Python语法、文档链接及状态/计数一致性、输入及保护哈希、原14负向保留检查和 `git diff --check`；实际命令/退出码及含新增文件的diff同目录。

仓库根目录PowerShell复现；两个输出必须是同层级的全新目录：

```powershell
$base = '.local/p0-03/run-20261019-confirmations/evidence/confirmations-2026-10-19T08-58-31-979047Z/delivery-final'
python -B -X utf8 scripts/p0-03/test-coverage-image-evidence.py
python -B -X utf8 scripts/p0-03/audit-product-coverage.py --baseline $base --output '<新父目录>/delivery-final'
python -B -X utf8 scripts/p0-03/verify-product-coverage.py --delivery '<新父目录>/delivery-final' --self-test
python -B -X utf8 scripts/p0-03/audit-product-coverage.py --baseline $base --output '<新父目录>/delivery-reproduced'
python -B -X utf8 scripts/p0-03/verify-product-coverage.py --delivery '<新父目录>/delivery-reproduced' --self-test
git diff --check
```

`delivery-final/input-hashes.json`保存全部业务基线文件哈希，`inputs/`冻结原7份输入加商品库Excel共8份；`output-hashes.json`含新图片证据。其余原始冻结Excel按出处引用及原哈希保留。复查实际差异及现场保护可用新证据 `verification/closeout.py`（默认只读打印JSON，`--save`只允许首次保存）以及 `business-invariance.py`。

## 未运行、历史与执行收尾（历史）

本轮**未运行**106项匹配功能测试、完整P0-03门禁、浏览器、lint/build，也未改这些测试或引擎/页面。旧覆盖批次的14组/15产物/43链接及历史保护数是当时执行证据，不冒充本轮重跑。本轮新执行结果如上；四项确认及主库整理的[既有独立通过历史](./verification-report-p0-03-confirmations-20261019.md)与[主库整理报告](./verification-report-p0-03-curation-20261019.md)不变。既有Next.js tracing和openpyxl样式提示本轮未重跑；Git全局ignore权限/换行提示与失败分开，不通过修改无关代码消除。

本批新增且已解决的收尾初检失败：任务页将货号简写为WM0031/0062/0098，一致性检查按完整WM0098检查而exit 1；已逐项写完整货号，未放松断言，后续收尾exit 0。`closeout-initial-failure.json`仅保留exit 1、断言和原因记录，初次preliminary stdout log为空，未保留完整初次stderr；`closeout-preliminary-v2.log`及正式收尾日志保留后续重跑结果。不将该失败记录称为完整原始stderr日志，不涉及业务数据或功能失败。

neat-freak：审计代码与输出`changed-and-verified`；业务基线/规则`verified-current`，AGENTS与[身份标准](../product-identity-standard-v1.md)只检查一致性；状态、当前任务、任务包、本报告和入口`changed-and-verified`，旧报告保留历史。菲越1项业务待决、六项规格后续补正和既有延期`pending`，不阻断本次审计说明交付；正式保存/复用/归集/同步`out-of-scope`且方案未定。无业务运行态变更`not-applicable`，记忆只读未写，工作区不清场。

实际diff：`verification/coverage-audit-repair.diff`，相对本次开始的真实工作树，包含新增/未跟踪辅助测试、任务和报告，不只提供HEAD diff。

执行交付时停止于**P0_03_IMPLEMENTED_AWAITING_REVIEW**，等待独立审查；当时不自行登记本轮独立通过或整个P0-03 PASS。该交付过程及其检查历史保留。

## 2026-10-20 独立审查通过及文档收尾

依据[本轮独立审查报告](../../.local/p0-03/reviews/evidence/independent-coverage-repair-20261020-472a6fae/independent-review.md)：**本轮两项审计说明补修独立审查通过，文档收尾完成**。只登记图片对象说明与规格差异审计补齐通过；此前CHANGES_REQUIRED及上述补修执行记录保留，不覆盖历史检查，不登记整个P0-03 PASS。

独立审查另行重跑10项图片测试、交付全量核验及28组负向，重新生成并再次全量核验及28组负向，均exit 0；17份完整产物递归逐字节一致。2项CLI保护独立重跑通过：非空输出拒绝且17份文件不变，错误CSV哈希拒绝且未创建输出；两条被测拒绝命令按预期exit 1。独立命令和日志保留在上述审查目录，未与执行批次混为同一次运行。

本次独立审查未重跑106项引擎功能测试、完整P0-03门禁、浏览器、lint/build。独立审查的额外只读核验及CLI包装初检修正详见独立报告；它与执行侧仅保存退出码、断言和原因的初检失败是不同记录。

本次文档收尾仅更新 `docs/current-state.md`、`docs/tasks/current-task.md` 和本报告。已核对三份文档全部链接、状态/口径一致性及相对开始工作树的实际修改范围，`git diff --check` exit 0；本次检查不运行功能测试或重写执行/独立审查证据。neat-freak限于文档对齐：文档为`changed-and-verified`；功能、业务数据、规则及运行态为`out-of-scope`，未修改；旧证据与HOLD保留，记忆只读未写，工作区不清场。

继续保留菲越洗面奶原1项版本待决及三条既有WM0012对应；六项规格仅登记差异，后续资料补正仍待定；刷子、新品、工厂资料等既有延期及一般未核对记录不变。长期正式保存对应关系、自动复用、数量归集和库存同步方案未定；不宣称产品资料已全部核实。

文档收尾完成后停止，阶段仍为**P0_03_IMPLEMENTED_AWAITING_REVIEW**，整个P0-03未判定PASS，等待用户后续指令。不改功能、决定、价格或原始Excel/CSV，不入库、不接真实系统、不自动确认、不发布/同步库存、不暂存/提交/推送/合并/部署或推进下一阶段；全部旧证据、HOLD及其他未提交修改保留。
