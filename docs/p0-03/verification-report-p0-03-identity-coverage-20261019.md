# P0-03 商品身份标准与覆盖核对验证报告

日期：2026-10-19。状态：**P0_03_IMPLEMENTED_AWAITING_REVIEW**，交回独立审查。本报告仅覆盖本批标准登记和只读审计，不登记整个P0-03 PASS。

规则唯一正文：[商品身份标准v1](../product-identity-standard-v1.md)。本轮用户批准的是商品身份原则；正式关系保存、自动复用、数量归集及同步仍须说明业务流程后另定，本批没有实现这些机制或数据库唯一约束。

## 基线、交付及复现

业务数据始终继承已独立通过的四项确认交付：`.local/p0-03/run-20261019-confirmations/evidence/confirmations-2026-10-19T08-58-31-979047Z/delivery-final/`。未从桌面原CSV重建，未运行旧匹配流程，没有改变主资料、人工决定、价格或历史。

开始前和生成/验证时均核对SHA256：

- `match-bundle.json`：`c0fa4bc9814080a9e78d15ad7136276e03156254d67a3fe59e4d49c841e80936`
- `manual-decisions.effective.csv`：`a66c564942220f5df4e1043ab2b076f1cec26c3056fa8dffd5a2e2733844b58f`

本批证据根目录：`.local/p0-03/run-20261019-identity-coverage/evidence/coverage-2026-10-19T10-01-22-161334Z/`。下文路径除另注外均相对该目录。**唯一现役核对输出为 `delivery-final-v2/`**；`delivery/`和`delivery-final/`是执行内试生成保留，不能替代最终输出。业务原结果仍以上述confirmations基线为准，新核对输出没有新增业务决定。

用户可读交付：

- [简明中文覆盖报告](../../.local/p0-03/run-20261019-identity-coverage/evidence/coverage-2026-10-19T10-01-22-161334Z/delivery-final-v2/coverage-report.zh.md)
- [全126份覆盖CSV](../../.local/p0-03/run-20261019-identity-coverage/evidence/coverage-2026-10-19T10-01-22-161334Z/delivery-final-v2/product-coverage.csv)及[JSON](../../.local/p0-03/run-20261019-identity-coverage/evidence/coverage-2026-10-19T10-01-22-161334Z/delivery-final-v2/product-coverage.json)
- [1417条来源出处索引](../../.local/p0-03/run-20261019-identity-coverage/evidence/coverage-2026-10-19T10-01-22-161334Z/delivery-final-v2/source-records.json)
- [后续证据问题清单](../../.local/p0-03/run-20261019-identity-coverage/evidence/coverage-2026-10-19T10-01-22-161334Z/delivery-final-v2/audit-questions.json)：原菲越1项及3项新规格口径复核，均不阻断本批只读收口。

生成器为[scripts/p0-03/audit-product-coverage.py](../../scripts/p0-03/audit-product-coverage.py)，只读审计已保存的有效结果，不导入匹配引擎。JST来源原记录未带文件名，故只读冻结两份Excel的身份/原行/名称/可用数字段，复核既有合并结果的文件出处。887条JST各只有一个原始出处；缺失的账号、市场、关系有效期保持空值，不编造。本轮没有再次调查菲越洗面奶版本，也没有接真实系统。

仓库根目录PowerShell复现，两个新目录必须未使用；生成器拒绝非空输出，验证器不写文件：

```powershell
$base = '.local/p0-03/run-20261019-confirmations/evidence/confirmations-2026-10-19T08-58-31-979047Z/delivery-final'
$env:PYTHONDONTWRITEBYTECODE = '1'
python -X utf8 scripts/p0-03/audit-product-coverage.py --baseline $base --output '<全新核对目录>'
python -X utf8 scripts/p0-03/verify-product-coverage.py --delivery '<全新核对目录>' --self-test
git diff --check
```

`delivery-final-v2/input-hashes.json`保存全部基线文件哈希及两项固定输入哈希；`inputs/`冻结7份直接审计输入，字节与基线一致。所有原始Excel/CSV及已生效决定和纠错历史继续留在原交付，不覆盖。最终输出哈希见 `delivery-final-v2/output-hashes.json`。

## 重算结果及含义

原主库数据区217行，85全空，132行非空资料；原非空货号行131、不同非空货号125。整理后的126份主资料中125份货号非空且唯一，另1份原122行新品缺码，不称126份全部编码。审计完整包含全部126份，保留132条原行出处和原行锚点，没有重排商品身份。

覆盖分类由有效人工选择逐条重算，互斥合计126：两边已有选择104份、仅BS12份、仅JST2份、两边当前未找到已确认对应8份。有效选择534条（BS428/JST106），涉及118份主资料；不是534个商品，也没有合计库存数量或货值。1417条来源（BS530/JST887）身份/数量/决定不变，状态仍为已选534、待核对776、候选16、拒绝3、规则外88。

覆盖表分别保存：

- `master_source`：原Excel文件、SHA256、原行列表、主行及原结果JSON位置；`master_anchor_row`保留原行锚点。
- `bigseller_selected_by_warehouse`、`jushuitan_selected`、`selected_source_details`：有效选择的来源ID、SKU、仓库、名称和原文件/行，直接可追溯。
- `unconfirmed_candidates`及其详情、`name_only_hints`、`inactive_related_sources`：候选、名称提示和原拒绝/规则外分别列明；没有默认取首条或重复计作覆盖。
- `data_gaps`：各字段当前空值，仅记录事实，不规定全部必填；`source_coverage_gap`另列“当前未找到已确认对应”，不推断来源不存在或商品资料不合格。
- `version_review`：菲越三条有有效WM0012选择，同时保留版本待决；其余标“无已登记版本待决；未作全面版本认证”，不宣称全体版本已核实。
- `approved_deferrals`、`context_only_sources`、`price_facts`：既有延期、仅供追溯且不能当对应的背景记录、当前价格与所有来源版本分开。

792条一般未核对分为16条JST单目标候选、776条零候选。后者含2条显式defer、1条新品同名提示、773条当前无候选；不整批要求用户决定。773条为BS10条、JST763条；JST其中634条编码含分段符、101条SY1系列、1条款式与商品编码不同、其余27条现有结果无主库候选。这只是当前来源与结果解释，不制定新的编码或仓别业务规则，不硬套组件/物料成品关系。

仅BS的WM0062在JST原789行已有拒绝记录，不能说JST不存在或重新确认。新品与JST WM0131仅有名称提示，不据此补货号。WM0095的`_x002B_`/`+`文本表现、WM0082备注里的“防晒水”、WM0117名称详略及WM0128既有泰文100g证据，均没有被程序名称提示升级成新的自动确认或确定错绑。

## 资料缺口、延期及真正待核实的产品

资料事实：条码空6份、成本空2份、运营价空7份；规格专列空114份（名称常含规格，不能说114款完全没规格）；工厂列126份空，其中93份保留含`#REF!`的原失效查找公式。所有缺失逐份保留，不填0、不猜值。共享条码8组保持各自编码和包装/版本，不自动合并。

已批准延期继续保留：WM0081与brush两款分开，不猜分BS刷子来源；原122行新品缺货号/条码待补；工厂失效引用及其他未提供资料不补猜；WM0040旧资料保留、不擅称确定停产。菲越757577407359两条defer、原拒绝3条和规则外88条不重新确认。WM0072现价仍5.18/5.68、price_pending=false，66/216行完整价格历史及主资料身份未变，JST仍未确认。

原业务待决仍为菲越洗面奶1项：菲律宾新创启辰376行、PH彩妆仓380行、越南526行三条既有WM0012和历史保留。沿用用户既有只读核查结论：同一SKU在每仓只有一条、无足够区分原款/升级款的记录；没有新版本证据，本轮不重复扫描调查、不根据“氨基酸”改LS101275。

本次新列3项**规格口径证据复核**，没有改基线业务待决或新增人工决定：

- WM0006：主库原13行名称“333克”、单个产品重量0.334kg；JST原743行身体油120ml。当前两边无有效选择，JST仅候选。
- WM0008：主库原14行名称“140克”、单个产品重量0.14kg；JST原745行VC精华60ml。当前两边无有效选择，JST仅候选。
- WM0130：主库原121行20ml/支；JST原857行电动眼霜20g。已有BS选择，JST仅候选。

三项均不能从现有资料证明是不同品，亦不能确认净容量、净重和整件重量的关系。后续需实物/包装证据说明是否同款、各数值口径及应修订的具体字段；证据未齐可以继续暂留。每项商品、当前对应、原文件/行证据、未知点、用户后续选择和不阻断本批收口的说明在 `audit-questions.json`及中文报告中逐项保存。未把其余一般未核对记录整批转交用户，已延期刷子/新品不重复催问。

## 本批检查与沿用证据

本批适用检查及正式日志位于 `verification/`：

- `generation-final-v2-command.json`及同名log：最终生成，exit 0。
- `verify-final-v2-command.json`及同名log：审计全量验证及14组内存负向，exit 0。候选伪装选择、错目标、漏主资料/漏来源、重复货号、把已有选择伪称版本通过、CSV/摘要/数量/出处篡改、WM0072自动确认、正式绑定资格及疑点证据/中文摘要篡改均被拒绝。
- `regenerate-command.json`、同名log及`regeneration-comparison.json`：重新生成exit 0，15份最终文件逐字节一致。
- `cli-guards.json`：非空输出拒绝覆盖、错误输入哈希拒绝且不创建输出，两项CLI保护用例通过（被测命令按预期exit 1，核查exit 0）；不修改旧交付。
- `closeout-report.json`：文档链接/一致性、Python语法、原文件/旧证据/HOLD保护、含新增文件的实际diff及`git diff --check`结果；可用同目录`closeout.py`重新只读核查。

收尾检查exit 0：43个Markdown链接有效，状态/计数/规则引用一致，两份新审计脚本Python语法通过，`git diff --check` exit 0。6378份其他源文件、2592份旧P0-03证据、5份原始Excel/CSV及21份原测试源文件字节未变，含原106项覆盖；全部HOLD和既有脏文件保留。仅4份既有入口/状态文档与5份新增标准/任务/报告/审计脚本形成本批源文件diff，未改匹配引擎、页面或业务数据。

只读审计验证脚本独立实现，不调用生成器或匹配引擎。检查全部126份逐字段及CSV/JSON一致、1417条来源身份/数量/目标/状态/原行出处、覆盖分类/合计、候选不冒充有效选择、原22条完整记录及JST引用、菲越版本仍待决、WM0072现价/两版历史/JST未确认；同时校验全部基线文件哈希及冻结副本。内存负向对篡改结果必须拒绝，运行不改交付文件。具体负向清单与计数见最终验证JSON日志。

原106项功能测试及匹配引擎/页面全部未修改。本批**未运行**旧匹配、106项功能回归、完整P0-03门禁、浏览器、npm lint或build：本次只增加标准/文档和独立只读审计，没有运行态或前端改动。没有DB/live/真实来源测试。不是把旧日志当作本次重跑。

沿用历史证据：[四项确认已独立通过报告](./verification-report-p0-03-confirmations-20261019.md)保持原样，其独立重跑106项、12组负向、15页浏览器和重新生成比对均通过；全门禁/lint/build当时仅核查执行日志，未独立重跑。[主库整理独立通过](./verification-report-p0-03-curation-20261019.md)与更早纠错证据保留。既有Next.js tracing、openpyxl默认样式和Git全局ignore/换行提示没有通过改代码清除；本批不重跑前两者，Git提示与功能失败分开记录。

## neat-freak与停止点

- 文档/规则：`changed-and-verified`，唯一正文在标准文档；AGENTS、current-state、current-task、P0-03入口、本任务和报告仅摘要/链接。旧独立通过报告及任务包历史不覆盖。
- 代码/数据：只读审计脚本已实现；业务引擎、页面、主资料、价格、决定与历史`verified-current`、无修改，保护证据见收尾报告。
- 运行态：本批无新业务运行态，`not-applicable`；本地审计输出逐项核验。
- 业务：菲越版本及3项新规格证据说明`pending`，不阻断只读交付；长期机制`pending`且实现`out-of-scope`。
- 记忆：`out-of-scope`，只读未写；工作区：保留全部原始资料、旧证据、HOLD及其他未提交修改，不清场。

实际文本diff含新增/未跟踪文件，相对本批开始的真实工作树生成，见 `verification/identity-coverage.diff`和`identity-coverage-diff-summary.json`；不只依赖HEAD diff。停止于**P0_03_IMPLEMENTED_AWAITING_REVIEW**，等待独立审查，不宣告整个P0-03 PASS。不入库、不接真实服务、不自动确认、不估值、不发布/同步库存、不提交/推送/合并/部署或推进下一阶段。
