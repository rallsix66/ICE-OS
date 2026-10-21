# P0-03 产品主库整理＋本批已确认样表对应验证报告

日期：2026-10-19。状态：**本轮主库整理及已确认样表对应已通过独立审查，文档收尾完成**。

本轮先前实施交付状态为 `P0_03_IMPLEMENTED_AWAITING_REVIEW`；现依据用户于2026-10-19在本会话明确确认，登记本轮独立通过结论。通过仅覆盖本轮本地产品主资料整理、已明确样表对应、相关工具修复及回归/输出一致性验证，不登记整个P0-03 PASS，不授权下一阶段。下文96项测试、浏览器及门禁均为实施时证据；本次仅更新current-state、current-task和本报告，完成文档链接、一致性与diff检查，未重跑功能测试或独立审查。

本批依据用户在R2两项补修独立通过后给出的新逐项决定。前轮通过结论保留在[历史R2报告](./verification-report-p0-03-review-r2-20261019.md)，本次新授权取代对应的旧待决口径，不覆盖历史事实。

## 交付与输入

唯一现役本批交付：

```text
D:/try one/ICEOS/.local/p0-03/run-20261019-curation/evidence/curation-2026-10-19T07-45-16-885265Z/delivery-final/
```

同级 `delivery/` 为首次生成的验证前副本，保留作历史，不是现役结果；`negative-cases/` 为6组注入测试副本，不构成业务决定。`verification/` 保存命令、日志、浏览器和保护核验；`source-before/`及实际diff用于本轮代码复核。

原始基线为用户指定的R2 `delivery/`。显式原CSV取该目录 `manual-decisions.frozen.csv`，SHA-256仍为 `1392022156e2cdd0ae748ddc5424334fc9ef76f175c40a8c56af0cd1d2cc92c5`。使用[本批明确纠正JSON](./curation-decisions-20261019.json)，不扫描或合并其他桌面CSV。

`input-manifest.json`冻结原始Excel四份、原CSV、历史bundle、原交付bundle、本批纠正记录及哈希；检查原Excel/基线哈希后再处理。原CSV不改，另派生 `manual-decisions.effective.csv`，其来源和哈希单列。27条显式纠正的原CSV/旧决定/当前决定关系在 `explicit-correction-audit.json`，不按CSV行序或confirm优先通用规则解决冲突。

## 已实现：主资料

`master-overview.json` / `.csv` / `.html`为同一126份主资料，保留所有字段、来源行、原始资料、价格版本与已选来源列表；`master-row-lineage.json`包含132条原非空行到整理后原行锚点的对照，不重排原Excel行号。`source-formulas-and-errors.json`单独保存Excel公式/错误单元格，四份原Excel字节副本也保留，不猜填工厂失效引用。

- WM0069用213行、保留63行；WM0070用214行、保留64行；WM0071用215行、保留65行；WM0095用115行、保留218行。主行所有资料及价格照用户指定保留，其他来源价格版本另存，不做估值。
- WM0073的67/217行为同一资料，以67行为追溯锚点，两行原日期均保存；不据日期选择。WM0072的66/216行为同一商品，以66行为追溯锚点，主资料成本/运营价为null（CSV为空），5.00/5.50和5.18/5.68两版均在价格版本中。主行日期也不任选一版，不填0。
- 116行仅WM00128更正为WM0128，原值、授权依据、原引用均留存；旧人工行/货号通过原行追溯解析，不丢选择，不批改其他相似编号。
- 28行WM0093包装条码改为757577407076；原H列ICEWM0039留在原始记录。同条码WM0039/WM0093仍为两个版本，单颗WM0005/整盒WM0004仍为两个包装单位，不按条码合并。
- WM0081和brush仍是两份资料；122行新品保留、货号与条码为空；WM0040保留，不标确定停产。未提供资料继续缺失。

计数分别为：原数据区217行（85全空），132行非空资料，131行非空ICE货号，125个不同非空ICE货号；整理后126份主资料，其中125份有货号、125个不同非空货号，1份新品无货号。不能把132或126直接混称原始唯一商品数。

## 已实现：本批对应与前后变化

`all-correspondence-changes.json`逐条列37条变化的来源、前后状态/候选/目标/JST项/校验错误、原因及本次授权依据。27条显式记录含2条本来已正确的对应重申，均另存审计；37条变化中25条来自显式记录，另12条为主资料整理及识别修复派生变化。

- 五仓714855625096整盒：空目标→WM0004（第16行）；DEE/越南WM0005单颗：冲突空目标→WM0005（第12行）。保留包装单位，不换算数量。
- DEE/MY/印尼/越南四条757577407083：多候选空目标→WM0082（84行）。原22条中的PH ICEWM0040→WM0040（29行）未变，其他旧喷雾记录未批改。
- 泰马6974674957349：116行WM00128→WM0128。菲越普通洗面奶的既有WM0012保留，并明确具体普通版仍待决；印尼未选版本，保持原状态。
- DEE原257行、MY原455行757577407076：WM0039→WM0093（28行）；越南普通WM0039重申且原值未变。PH ICEWM0039：空目标→WM0039（27行）。历史撤销错误WM0093事件完全不变，错误目标负向测试仍不能生效。PH先前reject的同码记录不重启。印尼仍保留既有WM0039，并标注版本待决。
- 印尼仅757577407380→WM0069、757577407397→WM0071、757577407359→WM0073三条明确泰版记录生效。例外按冻结来源身份和目标逐条校验，没有“全印尼默认泰文版”。JST无市场字段，不套BigSeller仓别约束、不编造市场。
- 10条旧新编号冲突：印尼/DEE KP0001→WM0117两条，DEE/越南WM0005→WM0005两条，MY ICEWM0027→WM0027一条，DEE/MY/印尼757577407359→WM0073三条，PH/越南757577407359两条defer且目标空。8条整理、2条暂留，原空白及原confirm均保留。来源编号沿革保存初次/后续候选编号，不因match_methods变化丢决定；同来源有冲突时仍需显式记录裁决。

额外12条变化逐项解释：PH WM0095的原confirm在115/218行合并后成为唯一目标115；JST WM0069、WM0070、WM0071、WM0072、WM0073、WM0095六条仅重复候选整理、保持未确认；JST WM0093只改所指资料的包装条码、确认不变；JST WM0128恢复116行候选但不新增确认；JST WM10012恢复39行候选未确认；JST WM10013恢复18行候选并继承原CSV confirm。识别修复单独应用原132行主库时，887条JST仅WM10012/WM10013两条新增候选，见 `verification/jst-five-digit-isolated.json`。

`original-22-comparison.json`保存原22条人工选择完整前后记录。逐条核对原人工主库行/ICE、JST旧ID/SKU、备注、当前决定、有效主库和有效JST引用全部一致。`manual-selections-restored.csv`现含原22条及本批新的显式目标，不能用该文件总行数当作原22条数量。

本批1417条来源（JST887、BigSeller530）状态：人工已选532、待核对777、有候选17、拒绝3、规则外88；相对基线510/801/15/3/88，新增有效已选22条、减少待核对24条、增加仅候选2条。无未应用的显式CSV决定，规则外88条及原拒绝/暂缓未被扩大处理。

## 仍待决与延期

以下5项业务待决及其他延期项均保留，不因本轮独立通过而视为已解决；本次文档收尾不改功能、原始资料或核对结果。

`pending-business.json`和各核对页面/CSV的 `batch_business_pending`保存以下5项，原值和历史保留，不新增确认：

1. 菲越普通洗面奶：LS101275原款或WM0012升级普通版；三条既有WM0012保持。
2. 印尼洗面奶：WM0128、WM0012、LS101275或暂留；原confirm无唯一目标，继续待核对，不取第一条。
3. 印尼防晒乳：保留WM0039或改WM0093；本轮既有WM0039保持。
4. WM10012眼部精华是否新增人工确认；仅有第39行候选。
5. WM0072选哪组价格或继续两版；当前不选价、不填0。

其他延期及资料缺失：WM0081/brush、122行新品缺货号/条码、工厂失效引用和其他未提供字段、WM0040历史资料保留；共享条码仍有8组（含不同版本/单位，不全是错误），不再自动合并。完整794条待核对/候选在 `pending-user-review.csv`，规则外在 `outside-rules.csv`；本批不扩展其他业务待决。后续持续绑定、自动复用及关系使用方案仍未定。

## 实施时已验证：命令与退出码

仓库根目录PowerShell：

```powershell
$batch = Get-Content .local/p0-03/curation-current-path.txt
$env:PYTHONDONTWRITEBYTECODE = '1'
$env:PYTHONUTF8 = '1'
$env:PYTHONPATH = Join-Path (Get-Location) 'tools'
$env:P0_03_RUN_ID = 'run-20261019-curation'
python -m unittest discover -s tools/p0_03_match/tests -p 'test_*.py' -v
npm run check:p0-03
python scripts/p0-03/verify-curation-evidence.py "$batch/delivery-final"
python scripts/p0-03/verify-curation-negative.py "$batch/delivery-final" '<new-empty-negative-dir>'
node scripts/p0-03/verify-curation-browser.mjs "$batch" '<new-browser-dir>'
npm run lint -- --max-warnings 0
npm run build
git diff --check
```

上述适用检查最终均exit 0。完整生成命令在 `verification/curation-final-command.json`，明确基线、原CSV、纠正JSON和新输出；CLI拒绝覆盖非空目录。负向脚本要求全新目录；浏览器验证本批主交付和已生成负向目录，浏览器日志/截图写新证据目录。

- 单元：原80项（19个原测试文件）字节不变，新增 `test_sample_curation.py` 16项，共96项。覆盖WM五位整品/组件排除、来源编号沿革/歧义失败、明确冲突裁决、PH新授权/错误目标/四负向、印尼逐条例外、JST不受市场限制、原行/货号纠正、WM0072不选价格、同码版本/单位不合并、各输出一致。
- 门禁：`../check-2026-10-19T08-01-30-574Z/check-report.json`，96项、compileall、新样表smoke均exit 0；编译缓存写新证据目录。门禁smoke为原始样表候选生成，不冒充整理后交付，整理后全量断言另在下项。
- 实际交付：`verification/verify-final.log`，1417条各输出逐条一致，原22条不变、10条裁决、主资料/价格/原行追溯、5项待决、所有输入哈希与历史撤销事件通过。
- 负向：`negative-cases/negative-report.json`，6组各1417条：reject、ignore、clear、defer、PH再填WM0093、JST已选行冲突。各组当前决定生效、原填写和历史保留，目标为空；JSON/CSV/主库总览/HTML/统一视图一致。
- 浏览器：`verification/browser/browser-report.json`，主交付＋6负向，各3页共21页，核对页1417行、仓库页530行、主库总览126行实际DOM逐字段比较，筛选/搜索和WM0072空价验证通过，pageErrors为空；截图同目录。
- lint/build：`verification/lint-command.json`、`build-command.json`及日志，exit 0。仅Python/本地证据导出代码，不改Next.js业务页，无DB/live/真实服务测试。
- 文件保护及文档收尾：`verification/closeout-report.json`；旧证据、原Excel/CSV及原80项测试哈希不变，HOLD和其他脏修改保留。实际diff在 `verification/curation.diff`，文件清单与来源在 `curation-diff-summary.json` / `source-baseline-provenance.json`；含未跟踪文件，非仅HEAD差异。

既有警告保留：build一条 `next.config.ts`/sync导入链NFT tracing提示；openpyxl原工作簿缺默认样式；Git全局ignore权限及CRLF提示。辅助验证最初从根目录未设PYTHONPATH导致import错误，已用标准环境修正；重建差异基线时README换行归一化触发哈希失败，改为原字节并按旧最终哈希核实。见 `verification/tooling-notes.txt`，未通过放松产品断言处理失败。

## neat-freak与停止点

- 代码、本地运行证据：`verified-current`，沿用本批实施时96项及真实保存结果/DOM证据与本轮独立通过结论；本次未改功能、原始资料、核对结果或证据，未重跑功能测试。
- 文档：`changed-and-verified`，本次仅更新current-state、current-task和本报告，登记本轮通过范围，保留5项业务待决及其他延期；链接、一致性与diff检查通过。任务包保留当时待审状态，当前结论以这三份文档为准；README、旧R2报告和全部旧证据不改。
- 规则：`verified-current`，AGENTS.md已核对，原边界仍适用，无需增加长期规则；本批具体授权只在冻结JSON中，不升级为通用仓别方案。
- 本轮独立复核：已通过，依据用户本次明确确认登记；5项业务待决及其他延期：`pending`，不替用户裁决，不登记整个P0-03 PASS。
- 生产、发布、长期绑定：`out-of-scope`；无入库、真实服务、库存发布/同步、迁移、提交、推送、合并或部署。
- 记忆：`out-of-scope`、只读未写。工作区：`verified-current`，保留所有旧/本批证据、失败副本、HOLD及无关未提交文件；不清场。

停止于**本轮独立审查通过结论文档收尾完成**，不推进下一阶段；保留全部证据和HOLD，不提交或推送。
