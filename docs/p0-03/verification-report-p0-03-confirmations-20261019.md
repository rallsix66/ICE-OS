# P0-03 四项业务确认落实验证报告

日期：2026-10-19。状态：**本轮四项业务确认独立审查通过，文档收尾完成**。通过仅限本轮四项本批业务决定及相关实现验证，不登记整个P0-03 PASS，不推进下一阶段。

用户本轮决定优先于上一轮待决描述。上一轮[主库整理及已确认样表对应独立通过结论](./verification-report-p0-03-curation-20261019.md)及所有证据原样保留。本轮先前实施交付状态为 `P0_03_IMPLEMENTED_AWAITING_REVIEW`，现依据用户于2026-10-19在本会话明确确认，登记本轮独立通过结论。

## 独立审查结论与核验范围

独立重跑106项测试、12组负向、15页浏览器及重新生成比对均通过；完整门禁、lint、build仅核查执行日志，未独立重跑。执行日志记录的退出码0保留为执行方实施证据，不表述为独立审查重新执行这些命令。

本次仅更新current-state、current-task和本报告，完成文档链接、一致性及diff检查，未重跑功能测试或独立审查。下文执行命令、106项自验与浏览器等记录均保留为实施时历史证据；上述独立复核范围依据用户本次明确说明登记。

本轮通过不解决菲越洗面奶版本待决，不扩大长期绑定及使用方案，也不授权下一阶段；其他延期和一般未核对记录均保留。

## 基线、决定与交付

唯一现役本批交付：

```text
D:/try one/ICEOS/.local/p0-03/run-20261019-confirmations/evidence/confirmations-2026-10-19T08-58-31-979047Z/delivery-final/
```

原始对照为用户指定的curation `curation-2026-10-19T07-45-16-885265Z/delivery-final/`。先核对以下SHA-256，均一致后继承处理：

- 基线 `match-bundle.json`：`d661805b4652ee9501753512a82c9eac9896f10f5cfe57bff33965765e117d27`。
- 基线 `manual-decisions.effective.csv`：`14d4d18b33af35d27d6b2d82de6d89b1c8163187217f80fafe656466a5f87316`。

本轮[明确决定JSON](./business-confirmations-20261019.json)及交付内 `business-decisions.frozen.json` 的哈希为 `33e1704d25eafefbe59f1df76283ab042e957666688df809d72aa08d2ae86fdc`。派生 `manual-decisions.effective.csv` 为 `a66c564942220f5df4e1043ab2b076f1cec26c3056fa8dffd5a2e2733844b58f`；最终 `match-bundle.json` 为 `c0fa4bc9814080a9e78d15ad7136276e03156254d67a3fe59e4d49c841e80936`。

`input-manifest.json`记录基线bundle/有效CSV/输入清单、明确决定的冻结副本及哈希、全部基线文件哈希。继承原行追溯、上轮纠正审计、原22条对照、原始资料副本、历史bundle等；原人工CSV副本仅作历史证据，决策源始终是指定基线的有效CSV，不扫描/合并桌面其他CSV。

同级 `delivery/`、`negative-cases/`、`verification/browser/`为本轮初版自验现场，保留但不是最终交付。最终代码还避免给未操作记录推进previous_review投影，原22条因此完整记录逐字典相等；对应最终证据为 `delivery-final/`、`negative-final/`和 `verification/browser-final/`。未覆盖初版或上一轮证据。

## 已实现的四项决定

1. **印尼洗面奶新增有效选择。** `mc-59f065c77b77953a`，单个SKU513行、6974674957349，由原confirm但无有效目标→有效人工选择原19行WM0012。没有选WM0128或LS101275。
2. **印尼防晒乳再次明确确认现值。** `mc-5131dbfa1ad6207d`，单个SKU482行、757577407076，仍为原27行WM0039；追加本次明确确认及前后CSV关系，解除版本待决，目标不变，不计新增有效选择。
3. **WM10012成为实际有效人工选择。** `mc-0b2c37c654a967b1`，JST859行、WM10012、外贸GreTeam眼部精华7.5ml，由候选→原39行有效人工确认。其基线CSV仍沿用历史ID `mc-adf896ec635d7a7f`，按冻结来源沿革解析到当前ID；原空白及旧ID在审计中保留，不按行序或confirm优先规则处理。
4. **WM0072只选现行价格B。** 主资料锚点仍为66行，身份/原行追溯/其他字段不变；当前成本5.18、运营价5.68、price_pending=false，`current_price_selection`指向216行、2026-07-13。66行5.00/5.50与216行5.18/5.68的source_records、price_versions完整保留；`price_decision_history`追加原未定价状态及本次选择。没有将整行替换为216行，也没有填0、写JST confirm或计算库存估值。JST WM0072仍为未确认候选。

`current-decision-audit.json` / `business-confirmation-events.json`保存4项新事件，含三条确认的原CSV记录/旧决定及本次决定、价格的原未定价状态和完整价格来源。上轮 `correction_events`、27条纠正的审计、8条整理/2条暂留以及批次具体授权列表均未改写。

## 实际结果与完整变化

结果从有效记录重算，不手改摘要：4项业务问题已落实＝新增有效商品选择2条＋对既有选择再次明确确认1条＋现行价格选择1项。1417条来源（BS530、JST887）为人工已选534、待核对776、有候选16、拒绝3、规则外88；相对基线532/777/17/3/88，已选只增加2条，待核对与仅候选各减少1条。

126份主资料、来源身份及所有数量原值不变。原Excel数据区217行、85行全空、132行非空资料、131行非空货号/125个不同非空货号；整理后126份主资料中125份有货号、125个不同非空货号，另1份新品缺货号。本轮未重建主库或更改计数口径。

- `all-correspondence-changes.json`：4条核对记录变化，前三条为本次明确确认，另1条是JST WM0072仅移除价格业务待决提示，核对状态/候选/决定/有效目标均未变。
- `all-master-changes.json`：3份主资料输出变化；66行只有价格/价格状态及新增审计，19/39行只有有效来源ID列表增加新选择，其他资料字段不变。
- `all-field-changes.json`：完整119处保存bundle字段差异，含新增事件、输入清单、CSV/历史投影等技术出处，不能理解为119个商品变化。冻结基线与新bundle可逐字段复核。
- `current-original-22-comparison.json`：原22条完整记录前后相等，人工主库行/ICE、JST旧ID/SKU、备注、决定、有效目标、历史投影全部未改。

所有页面、JSON、CSV、主资料及仓库总览均由同一有效结果生成。主库CSV支持仅部分商品存在的现行价格/历史字段，避免新增价格元数据导致导出不完整。重应用clear/defer时，新增选择数及再次确认数也随当前有效选择重算，历史确认事件仍保留，不伪装为当前有效目标。

## 剩余待决与其他延期

原5项业务待决仅余**菲越洗面奶版本**1项，`pending-business.json`保留其三条具体记录：

- 菲律宾-新创启辰自建仓376行，`mc-e1b56fb81b0db46c`。
- PH-彩妆日均万单简简单单仓380行，`mc-73ac4812d7d8de64`。
- 越南青林湾仓库526行，`mc-b7bd376e964738cd`。

三条SKU均6974674957349，现有WM0012和完整历史原样保留，版本仍待核对。已知本份BS每仓只有一条该SKU，名称、GTIN、重量、尺寸、图片相同且备注为空，组合页没有可区分版本记录；沿用用户提供的只读核查结论，本轮没有再次全表调查。不能据此全部确认WM0012或根据“氨基酸”改成LS101275，后续须有可区分原款/升级款的资料分别核对。

其他延期保持：WM0081/brush不合并；122行新品缺货号/条码不编造；工厂失效引用及未提供字段不补猜；WM0040历史资料保留；共享条码的版本/单位不合并；规则外88条、原拒绝及暂缓决定不重启。792条一般待核对/候选仍在 `pending-user-review.csv`，其口径不同于1项业务待决。WM0072的JST候选仍待核对，**价格已选定**。长期绑定、自动复用及关系使用方案未定。

## 实施时重跑与沿用证据（历史）

执行方实施时重跑最终结果均exit 0；本次文档收尾未执行下列命令。仓库根目录PowerShell：

```powershell
$batch = Get-Content .local/p0-03/confirmations-current-path.txt
$env:PYTHONUTF8 = '1'
$env:PYTHONDONTWRITEBYTECODE = '1'
$env:PYTHONPATH = Join-Path (Get-Location) 'tools'
$env:P0_03_RUN_ID = 'run-20261019-confirmations'
python -m unittest discover -s tools/p0_03_match/tests -p 'test_*.py' -v
npm run check:p0-03
python scripts/p0-03/verify-confirmations-evidence.py "$batch/delivery-final"
python scripts/p0-03/verify-confirmations-negative.py "$batch/delivery-final" '<new-negative-dir>'
node scripts/p0-03/verify-confirmations-browser.mjs "$batch" '<new-browser-dir>'
npm run lint -- --max-warnings 0
npm run build
git diff --check
```

最终生成命令、cwd和exit 0在 `verification/confirm-final-command.json`。命令为 `python -m p0_03_match confirm-sample --evidence <指定已通过交付> --decisions <本轮明确JSON> --output <全新目录>`，无需桌面原CSV。输出非空或基线哈希不符会拒绝执行。负向目录必须全新；浏览器脚本读取本批 `delivery-final/`及已生成的 `negative-final/`，不改桌面文件或历史证据。

- **回归106项：** 原96项及20个测试文件字节不变，新增 `test_business_confirmations.py` 10项。覆盖两条新增/一条现值确认/一项价格的独立计数，眼部精华实际选择，价格不换整行/不确认JST、菲越三条不变、旧ID沿革、输入不变/无效目标及价源拒绝、当前负向决定和统计、哈希错误拒绝。完整原始日志在 `verification/unittest-final.log`，命令/退出码同名command JSON。
- **完整P0-03门禁：** `../check-2026-10-19T09-18-50-898Z/check-report.json`；106项、compileall、新样表smoke均exit 0，编译缓存仅写新证据目录。smoke沿用原始样表候选生成；本轮决定并未从该smoke或桌面原CSV重建，真实交付另做全量检查。
- **真实1417条：** `verification/verify-final.log`及command JSON。逐条比较全部身份/来源数量、候选和有效关系；126份主资料、4项落实、22条完整记录、上轮纠错/8条整理/2条暂留、剩余三条版本待决与所有输出/冻结哈希均通过。`verification/verify-complete-diff.log`另将完整119处字段差异应用到冻结基线，确认能精确还原最终保存bundle，exit 0。
- **12组负向完整样本：** `negative-final/negative-report.json`。PH reject/ignore/clear/defer、再填WM0093、JST已选行冲突；本轮印尼洗面奶、WM10012和印尼防晒乳分别clear/defer。每组1417条，各输出逐条一致，当前负向决定生效、目标为空、旧事件/现价保留，新增选择/现值确认统计相应减少。
- **15页实际浏览器DOM：** `verification/browser-final/browser-report.json`。主交付及PH clear、印尼洗面奶clear、WM10012 defer、印尼防晒乳clear四组副本，各核对页1417行、仓库页530行、主资料页126行。逐字段比较、搜索/筛选、本轮3条有效目标及已确认文本、菲越版本待决、WM0072现价和两版历史均通过，pageErrors为空；截图同目录。
- **lint/build/diff：** `verification/lint-final-command.json`、`build-final-command.json`及日志；`verification/diff-check.log`，最终均exit 0。未改Next.js业务页，无DB/live/真实服务操作。
- **保护与实际diff：** `verification/closeout-report.json`核对原文件、全部旧证据、原96项测试、AGENTS和其他脏文件；`verification/confirmations.diff`及 `confirmations-diff-summary.json`为相对本轮开始工作树的实际文本差异，含未跟踪文件，不仅是HEAD diff。当前源码/交付哈希在 `source-hashes-final.json`、`delivery-hashes.json`。

沿用证据：上一轮独立通过结论、原始行/货号纠正与重复资料整理依据、原22条历史人工输入、原始Excel/CSV和过去失败/审查证据。本次没有重做这些业务判断，全部保留；已在本次结果中重新验证其有效状态未回退。

既有警告：build仍有1条 `next.config.ts`/sync导入链NFT tracing提示；完整门禁原Excel读取仍有openpyxl缺默认样式提示；Git全局ignore权限/换行提示。没有通过删测、跳过、放松断言或改范围外代码消除提示。本轮所有最终检查无新增失败；初版自验及初版证据也保留。

## neat-freak收尾与停止点

- 代码/本地证据运行态：`verified-current`，沿用实施证据及本轮独立通过结论；本次不改功能、决定、原始资料或证据，未重跑功能测试。独立审查重跑与仅核查日志的范围见本报告首节。
- 文档：`changed-and-verified`，本次仅更新current-state、current-task和本报告，登记本轮四项业务确认独立审查通过、核验范围及阶段边界；链接、一致性与diff检查通过。任务包保留当时待审记录，当前结论以这三份文档为准；README及其他报告不改，1项业务待决、其他延期和一般未核对记录均保留。
- 规则：`verified-current`，已核对AGENTS，原边界仍适用，无需新增通用仓别或长期绑定规则。
- 本轮独立复核：已通过，依据用户本次明确确认登记；菲越版本：`pending`，保留三条既有对应，不替用户补判断。长期绑定及使用方案仍未确定，不登记整个P0-03 PASS。
- 生产、真实服务、库存发布/同步、长期复用：`out-of-scope`。无入库、迁移、提交、推送、合并、部署或下一阶段动作；无库存估值。
- 记忆：`out-of-scope`、只读未写。工作区：`verified-current`，保留原始资料、全部旧/本批证据、HOLD及其他未提交修改，不清场。

停止于**本轮四项业务确认独立审查通过结论文档收尾完成**，保留全部证据及HOLD，不提交、推送或推进下一阶段。
