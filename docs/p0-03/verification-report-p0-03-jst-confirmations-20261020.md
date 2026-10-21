# P0-03：11条聚水潭确认与WM0007忽略验证报告

日期：2026-10-20。阶段保持：**P0_03_IMPLEMENTED_AWAITING_REVIEW**。现依据[本轮独立审查报告](../../.local/p0-03/reviews/evidence/independent-jst-confirmations-20261020-dce89074/independent-review.md)登记：**本轮11条JST确认、WM0007忽略及BS未建档说明独立审查通过**，文档收尾完成。通过仅限本批决定及相关保存、输出和审计支持，不登记整个P0-03 PASS。下文保留实施执行自验历史，独立重跑和仅日志核查范围另列于末节。

## 交付与授权

本轮落实用户原意：“那12条没错的……0007可以忽略了，这个没在经营。0070和0072在bs上确实是还没有创建，可以先不绑定。”具体范围见[任务包](../tasks/p0-03/2026-10-20-jst-confirmations.md)及[本轮明确决定文件](./jst-confirmations-20261020.json)。没有再次请求确认，没有新增通用同码确认规则。

唯一最终输出：`.local/p0-03/run-20261020-jst-confirmations/evidence/jst-2026-10-20T03-04-57-810433Z-19d1be4d/delivery-final/`，覆盖审计在其 `coverage/` 子目录，属于同一交付。证据根目录是该 `delivery-final/` 的父目录。下文相对路径均以证据根目录为准。

- [12条完整前后对照](../../.local/p0-03/run-20261020-jst-confirmations/evidence/jst-2026-10-20T03-04-57-810433Z-19d1be4d/delivery-final/twelve-source-comparison.json)及[简明CSV](../../.local/p0-03/run-20261020-jst-confirmations/evidence/jst-2026-10-20T03-04-57-810433Z-19d1be4d/delivery-final/twelve-source-comparison.csv)
- [核对页面](../../.local/p0-03/run-20261020-jst-confirmations/evidence/jst-2026-10-20T03-04-57-810433Z-19d1be4d/delivery-final/match-review.html)、[主资料总览](../../.local/p0-03/run-20261020-jst-confirmations/evidence/jst-2026-10-20T03-04-57-810433Z-19d1be4d/delivery-final/master-overview.html)、[BS仓库总览](../../.local/p0-03/run-20261020-jst-confirmations/evidence/jst-2026-10-20T03-04-57-810433Z-19d1be4d/delivery-final/bs-warehouse-overview.html)
- [126份覆盖CSV](../../.local/p0-03/run-20261020-jst-confirmations/evidence/jst-2026-10-20T03-04-57-810433Z-19d1be4d/delivery-final/coverage/product-coverage.csv)、[覆盖JSON](../../.local/p0-03/run-20261020-jst-confirmations/evidence/jst-2026-10-20T03-04-57-810433Z-19d1be4d/delivery-final/coverage/product-coverage.json)及[中文覆盖报告](../../.local/p0-03/run-20261020-jst-confirmations/evidence/jst-2026-10-20T03-04-57-810433Z-19d1be4d/delivery-final/coverage/coverage-report.zh.md)
- [命令、完整stdout/stderr、浏览器及实际diff目录](../../.local/p0-03/run-20261020-jst-confirmations/evidence/jst-2026-10-20T03-04-57-810433Z-19d1be4d/verification/)

`delivery-reproduced/`仅用于同输入再生成比较；`development-checks/`、`audit-agent-checks/`为开发自验；`negative-final/`、`negative-inherited-final/`及`audit-cli-guards/`为注入保护用例。它们均保留，不作为当前业务结果。

## 固定基线与哈希

开始前核对用户指定的已通过confirmations交付：`.local/p0-03/run-20261019-confirmations/evidence/confirmations-2026-10-19T08-58-31-979047Z/delivery-final/`。

- 输入bundle SHA256：`c0fa4bc9814080a9e78d15ad7136276e03156254d67a3fe59e4d49c841e80936`。
- 输入有效CSV SHA256：`a66c564942220f5df4e1043ab2b076f1cec26c3056fa8dffd5a2e2733844b58f`。
- 本轮明确决定及冻结副本 `jst-decisions.frozen.json` SHA256：`09a930afecd041640b66e20b56a94451eab75861d56b341267841d84ac1c0698`。
- 新bundle SHA256：`3c2babc9b13ca11fab14cb4bbce5e8617052319d06bc80c922256f6893346159`。
- 新有效CSV SHA256：`48544cd03154131970fce220fb2ff7c704e18d7860e2ea7c72e6a0ef1ac8d921`。

`input-manifest.json`冻结指定基线、有效CSV、明确决定及原始资料/旧纠错历史，`audit-input-pins.json`显式连接新输入哈希、旧固定基线和决定哈希；不是接受任意新哈希即自动授权。没有回退桌面原CSV、隐式合并其他CSV或用审计输出作决定源。原人工CSV仅继承为历史副本。

## 实际落实与变化

11条JST记录由候选、目标为空变为人工confirm和指定有效主库目标：WM0069、WM0070、WM0071、WM0072、WM0073、WM0082、WM0092、WM0095、WM0117、WM0128、WM0129。每条同时核对完整来源对象、身份沿革、原文件哈希、Sheet1原行及原值、目标锚点与完整主库身份；没有按candidate_id或货号字符串扩展到其他记录。

WM0007原744行由候选变为ignore，目标仍为空。理由为用户不再经营，本批不继续处理。原15行主资料、原候选、来源数量和历史保留；不是reject，不推导全系统停用或删除。

WM0070、WM0072仅新增JST选择；BS保持没有选择、没有新增来源，在主库及覆盖输出分列“用户确认尚未在BigSeller建档，等待后续创建”。未建档是正常业务状态，不表示库存为0，不催要SKU或代建商品。WM0072仍为主库锚点66，成本5.18、运营价5.68、price_pending=false；66行5.00/5.50与216行5.18/5.68两版来源、价格选择与历史完整不变。本轮解除的是JST未确认状态，不是再次选价。

从记录重算：有效选择534→**545**，BS **428不变**，JST106→**117**；本组12候选转11确认＋1忽略，其余4条JST候选保留。1417条来源状态为已选545、待核对776、候选4、拒绝3、忽略1、规则外88；一般未核对共780条，不等于新增用户业务待决。

覆盖由104双方/12仅BS/2仅JST/8双方暂无确认，变为**113双方/3仅BS/4仅JST/6双方暂无确认**，互斥合计126；已有选择覆盖120份。原主库数据区217行、85行全空、132行非空资料、131行非空货号/125个不同货号保持；整理后126份主资料，其中125份非空货号且唯一，另1份新品缺码。WM0007忽略不减少产品数量。

`all-correspondence-changes.json`精确12条；`all-master-changes.json`11份仅有效来源ID列表及WM0070/72的BS建档审计注释变化，不改data、身份或价格。`all-field-changes.json`完整280处字段变化含CSV投影、事件、摘要及出处更新，已独立重构回新bundle；不能理解为280个商品变化。`jst-confirmation-events.json`追加12个本批事件，保留原CSV记录、原候选、原状态和新决定；旧business_confirmation_events及全部纠错事件未改写。当前clear/defer/reject/ignore仍可覆盖当前选择，事件和有效数量分别表达。

## 保留事项与业务方向

原534条有效选择及其完整候选记录未变，尤其原22条人工选择和JST历史引用；原1405条未操作来源记录逐份相等。菲越洗面奶原1项版本待决（三条WM0012）保留，未重查相同样表；WM0073在菲越两条BS defer保留，不因JST确认解除。

JST四条候选继续为WM0006、WM0008、WM0130、WM0081；WM0081与brush分开及其既有延期保持。六项规格审计仅登记差异、后续补正仍待定；新品缺码、工厂失效引用/缺失及其他资料空值均不猜填。WM0040旧资料、所有reject/defer/规则外及纠错历史保留。

图片仍为128个锚点、123份找到对象/3份未找到，全部内容未核验；空单元格与对象存在分列，未找到不证明无图。新旧图片证据及七项问题（原菲越1项＋六项规格）除20处输入冻结位置迁移外结构和值一致，物理文件哈希、锚点及原行证据未变。该对照与70文件再生成比较分别记录，不用路径迁移解释业务变化。

用户补充：后续通过飞书表格识别新品；BS通常在新品发出时才创建，BS对应可晚于主资料及JST，等待建档正常，不要求两系统同时对应，BS匹配不以JST匹配成功为前提。用户确定飞书文档可以接入，BS按抓取考虑，JST API是否可用尚待核实。这些只是业务方向和待核实条件，不表示任何接入已实现，不规定飞书所有字段为最终主数据源，也不推测货号生成方式。

正式保存对应关系、自动复用、数量归集和库存同步方案仍未定；不实现API、抓取、定时任务、外部建档、组合展开、库存扣增或估值。

## 实施执行自验与可复现命令（历史）

以下均为实施时执行重跑，本次文档收尾未运行这些命令。正式命令的argv、cwd、环境覆盖、退出码及完整stdout/stderr分别在 `verification/<label>-command.json`、`<label>.stdout.log`、`<label>.stderr.log`，实施最终验收退出码均0：

- `unittest-final`：**121项**（原106项＋新增15项），21份旧测试源文件未改。新增覆盖本批精确确认/ignore、错身份/原行/目标/冲突、输入哈希、一次事件、未建档不造来源、价格历史及当前负向决定/摘要。
- `gate-final`：完整 `npm run check:p0-03` 通过；子报告 `.local/p0-03/run-20261020-jst-confirmations/evidence/check-2026-10-20T03-10-38-844Z/check-report.json`。包含121项、compileall及样表smoke；smoke单独输出，仅用于门禁，未作为本批决定输入或替换基线。
- `verify-final`：全部1417条来源、126份主资料、原534条及原22条完整记录/引用、12条授权及原Excel物理行、所有CSV/JSON/既有HTML投影、价格/延期/历史、完整字段差异重构通过。对照另在 `verification/independent-twelve-comparison.json`，这是执行侧独立于实现的核验脚本结果，不等于另一个会话独立审查通过。
- `negative-new-final`：**16组**，六项错来源/原行/目标货号/目标行/冲突/输入哈希拒绝且无部分输出，非空输出保护；另九组当前reject/ignore/clear/defer及WM0007 clear，逐案保存完整输出、核对有效目标/动态摘要与各投影。七条拒绝命令预期exit 1，保护验收exit 0。
- `negative-inherited-final`：原12组在新结果上重新执行通过，包括菲律宾错误目标及JST冲突、历史/当前确认的撤销与暂缓；没有用历史日志代替重跑。
- `images-final`：10项图片对象边界测试通过。`audit-old-final`：旧已通过审计交付仍通过全量及**原28组**负向，原28调用AST不变。`audit-new-final`：新批全量及**32组**负向通过；旧WM0072“不能擅自confirm”在旧模式保留，本批获授权后对应测试为“不能丢失已授权confirm”，其余原27组继续执行，另加4组本批BS说明/伪造选择/ignore错写reject/未建档误作0库存检查。没有放松断言获得通过。
- `audit-cli-guards`：审计非空输出拒绝、19份文件不变；错误输入哈希拒绝、不创建输出。两条被测命令预期exit 1，保护验收exit 0。
- `browser-final`：实际打开6个本地文件，其中3个既有HTML逐条DOM对照（核对1417行、BS530行、主库126行），另读取覆盖JSON、问题JSON和中文报告。12条记录搜索/状态/目标、WM0070/72未建档、WM0072价格与JST已选、菲越待决、图片/规格说明均通过，有截图；pageErrors和remoteRequests均为空。执行方另查看WM0072确认、WM0007忽略截图，显示正确。没有新建业务页面。
- `regenerate-business`、`regenerate-coverage`、`verify-reproduced`、`audit-reproduced`、`regeneration-compare`：同输入另生完整目录，**70份文件（51业务＋19审计）全部逐字节一致**，不排除任何字段或文件；12事件不重复。业务输出从原固定基线独立再生；两份审计均以同一新业务结果为只读输入，固定路径相同且兄弟输出同层，未做归一化后冒充字节一致。对照在 `verification/regeneration-comparison.json`。
- `lint-final`、`build-final`：`npm run lint -- --max-warnings 0` 和 `npm run build` 均exit 0。未改Next.js业务页面。
- 文档链接/状态/计数、Python语法、原文件/旧证据/HOLD和无关工作树哈希及 `git diff --check` 通过，记录在 `verification/closeout-report.json`。实际修改6份、新增8份共14份文件；6385份其他源文件、2833份旧P0-03证据、5份原始Excel/CSV、21份原测试源文件及HOLD未变，AGENTS、身份标准及原28负向调用保留；41处文档链接有效。实际diff含未跟踪新增文件，相对本轮开始工作树生成：`verification/jst-confirmations.diff`、`jst-confirmations-diff-summary.json`，不是仅相对HEAD。

仓库根目录PowerShell复现主交付；输出必须全新，不覆盖本轮证据：

```powershell
$env:PYTHONUTF8 = '1'
$env:PYTHONDONTWRITEBYTECODE = '1'
$env:PYTHONPATH = Join-Path (Get-Location) 'tools'
$base = '.local/p0-03/run-20261019-confirmations/evidence/confirmations-2026-10-19T08-58-31-979047Z/delivery-final'
python -B -X utf8 -m p0_03_match confirm-jst-sample --evidence $base --decisions docs/p0-03/jst-confirmations-20261020.json --output '<全新目录>/delivery-final'
python -B -X utf8 scripts/p0-03/verify-jst-confirmations.py '<全新目录>/delivery-final'
```

覆盖复现须复制本轮 `audit-input-pins.json`，将其中新结果哈希核对到复现结果，旧固定基线及明确决定哈希保持；再以 `audit-product-coverage.py --baseline <复现结果> --output <新覆盖目录> --input-pins <显式配置>` 生成，并以 `verify-product-coverage.py --delivery <新覆盖目录> --self-test --input-pins <同配置>`核验。其余回归/负向/浏览器命令精确参数见上述command JSON；`verification/compare_regeneration.py`及`closeout.py`默认只读，可复核本轮证据。

## 历史、警告及实施neat-freak（历史）

[四项确认独立通过](./verification-report-p0-03-confirmations-20261019.md)及[两项审计说明补修独立通过](./verification-report-p0-03-coverage-audit-repair-20261020.md)作为原历史保留，旧CHANGES_REQUIRED、补修、失败记录及审查证据均未覆盖。旧报告中的WM0072 JST候选是当时事实，当前现状已在本报告及当前状态更新。

本轮最终检查没有新增阻塞失败。开发试验与正式验收分别存放，没有把试验stdout当正式日志。已保留本次实际出现的既有提示：openpyxl缺默认样式；build一条 `next.config.ts → sync/server-actions → api/cron/dry-run` 的NFT tracing警告；Git全局ignore权限/换行提示。未改无关代码消除警告。没有运行DB/live、真实账号或库存同步测试，也没有把本地build解释为上线。

neat-freak：代码及本地输出`changed-and-verified`，原业务资料/旧证据/规则`verified-current`，文档`changed-and-verified`；菲越版本、六规格补正、刷子/新品/工厂等延期及一般未核对`pending`；真实接入和长期方案`out-of-scope`且尚未实现。AGENTS、身份标准、README与全部旧任务/报告不改，记忆只读未写；工作区保留HOLD及其他未提交修改，不清场。

实施交付时停止于**P0_03_IMPLEMENTED_AWAITING_REVIEW**，等待独立审查，当时不自行登记本轮独立通过或整个P0-03 PASS。上述执行过程、检查及原证据保留。

## 2026-10-20 独立审查结论与文档收尾

依据[独立审查报告](../../.local/p0-03/reviews/evidence/independent-jst-confirmations-20261020-dce89074/independent-review.md)，结论为PASS_SCOPED_INDEPENDENT_REVIEW，未发现本轮需要补修的缺陷。登记：**本轮11条JST确认、WM0007忽略及BS未建档说明独立审查通过**。仅覆盖本批决定及相关保存、输出和审计支持，不表示整个P0-03通过、业务待决解除或长期使用方案完成。

独立审查实际重跑通过：121项回归；1417来源、126主资料、原534/22完整记录、12条原Excel证据及保存投影；16组本轮与原12组业务负向；旧审计全量/28组与新审计全量/32组负向；10项图片对象测试；6份本地文件浏览器核验（其中3份HTML逐行DOM对照，pageErrors/remoteRequests为空）；70份完整产物（51业务＋19覆盖）逐字节独立再生成、12事件不重复；2项审计CLI保护；保护哈希、14文件实际diff、41处链接及git diff检查。另有15项实现探针、原Excel只读核查与覆盖重算。独立命令、退出码及完整stdout/stderr保留在上述审查目录，与实施执行日志分开。

**仅日志核查：** 完整P0-03门禁、lint、build未在独立审查侧重跑；独立审查核查实施命令、完整stdout/stderr、子门禁报告及退出码0，确认与审查时交付代码/产物一致。既有NFT tracing、openpyxl样式及Git提示保留，不把日志核查表述为独立重新执行。

**本次仅文档检查：** 按neat-freak限定三文档对齐，仅更新current-state、current-task和本报告，登记结论与证据范围，未重跑功能测试。三份文档链接、状态/口径一致性及相对本次开始工作树的实际diff检查通过，`git diff --check` exit 0；功能、业务决定、交付产物、原始资料、历史证据及HOLD未改。原执行diff/保护报告及独立审查时源哈希保留原样，描述各自检查时点；获准的本次三文档修改不回写旧哈希或历史检查。

菲越洗面奶原1项版本待决及三条既有WM0012、六项规格后续补正、刷子/新品/工厂等延期和一般未核对记录继续保留；图片内容仍未核验。长期正式保存对应关系、自动复用、数量归集及库存同步方案仍未定，真实接入尚未实现，不新增业务待决，不宣称资料已全部核实。

文档收尾完成后停止，阶段保持**P0_03_IMPLEMENTED_AWAITING_REVIEW**，整个P0-03未判定PASS，等待用户后续指令。不暂存、提交、推送、合并、部署或推进下一阶段，不清场、不写记忆。
