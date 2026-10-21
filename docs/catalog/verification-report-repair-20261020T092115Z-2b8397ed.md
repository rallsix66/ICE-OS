# 商品资料首包三项限定补修执行自验

日期：2026-10-20。运行：`repair-20261020T092115Z-2b8397ed`。状态：**商品资料首包三项补修、执行自验及文档收尾完成，待独立复审。**

本报告是执行自验，不是独立签收。依据[独立审查](../../.local/catalog/independent-review-20261020T090440Z-a99f8514/independent-review.md)、其[限定补修指令](../../.local/catalog/independent-review-20261020T090440Z-a99f8514/next-execution-instruction.md)及用户粘贴授权，仅修R1、R2、R3。此前结论CHANGES_REQUIRED保留，交回独立复审后才由审查方裁定。P0_01_PASS、P0_02_PASS、P0_03_PASS和P0-03收尾继续保持，没有重开旧验收或登记新阶段PASS。

## R1：未知结果直接核对原请求

[组件](../../src/features/catalog/components/catalog-detail.tsx:36)以一个明确的pending请求保存动作类型及原itemId、requestId、expectedRevision和完整输入。两个表单在请求待核对时禁用；独立的`type="button"`“核对/重试原请求”位于表单外，不依赖已清空的新表单必填校验。即使成功提交产生的RSC更新隐藏了补码表单，核对入口仍存在。

页面展示原完整意图及“其他输入不会作为本次保存内容”；核对仍调用原动作，沿用后端操作者、动作、意图核对、幂等及CAS。结果明确后显示已确认的原请求编号、实际保存值与修订号，清空未提交的新表单值，再允许新操作。请求只放在组件内存，没有localStorage、共享缓存或应用日志载荷保存。页面关闭或完整重载不会持久保存待核对请求，界面对此提示不要盲目新建请求。

[浏览器测试](../../tests/catalog/catalog.browser.pw.ts:38)在真实成功提交后，只替换一次Action成功回执为合成unknown；这是**前端回执注入，不是真实COMMIT网络故障**。两条流程不重新填任何必填字段即可核对，invalid事件为0，首次与重试HTTP body逐字相同；原输入、requestId和expectedRevision均一致。

- 补码：同一隔离fixture UUID `d98f92fd-836a-47cf-aad2-e40bb4acec44`，请求`98cd1b67-a43f-4a19-9675-af80511fb59b`；修订1→2，核对后仍2，成功audit仅1条。测试码仅`TEST-CATALOG-NEW-122`，不是实际业务货号。
- 非价格资料：同一fixture UUID，请求`684cb38d-b6b8-4073-912e-a1d7cb3e6866`；修订2→3，核对后仍3，成功audit仅1条。将不同值强行放入禁用DOM后，原请求摘要、实际持久化值和成功提示均不将该值当作已保存；正常用户无法编辑锁定控件。
- 原Repository实际COMMIT成功后丢失ACK的测试仍在本轮真实PG中重跑；没有拿前端合成回执代替它。

证据：[补码恢复](../../.local/catalog/run-20261020T093230Z-e4c1ad86/evidence/browser-2026-10-20T09-32-33-793Z-20e3ca/unknown-recovery-initial-code.json)、[非价格恢复](../../.local/catalog/run-20261020T093230Z-e4c1ad86/evidence/browser-2026-10-20T09-32-33-793Z-20e3ca/unknown-recovery-nonprice.json)、[Repository未知COMMIT及连接池](../../.local/catalog/run-20261020T093149Z-5c2ff439/evidence/postgres-2026-10-20T09-31-56-208Z-18c730/pool-unknown-commit-final.json)。修前触发引用原独立探针，已核对其文件哈希，见[证据来源登记](../../.local/catalog/repair-20261020T092115Z-2b8397ed/evidence/pre-repair-review-evidence.json)；没有冒称本轮重跑了旧缺陷探针。

## R2：可查看的修订审计

[自有历史DTO](../../src/features/catalog/types.ts:65)新增`revisionAudit`，只含reason、actorId、recordedAt、evidenceRef；[Repository](../../src/features/catalog/repository.ts:46)直接投影已存数据库字段，actor保留原UUID，recordedAt以UTC ISO表示系统记录时间。[历史界面](../../src/features/catalog/components/catalog-detail.tsx:126)明确它不代表来源业务更新时间。

普通资料/list DTO未增加认证信息或金额行。现有服务已返回`detail.history`，受控export路由显式返回该history，因此无需修改service、Action或route，也未扩大其权限。继续由启用管理员授权及RLS保护，export为`private, no-store, max-age=0`，raw和金额仍走各自受限入口。

实际浏览器执行补码和非价格修订，对版本1、2、3分别打开历史页，将理由、原操作者UUID、系统记录时间、证据引用逐字段与数据库和真实HTTP export对照。旧版本仍缺码，旧工厂值保持；金融指针没有随非价格修订移动。WM0072在真实PG中另做非价格并发修订，采用价5.18/5.68及金融指针保持，共享5/5.5仍只作观测。PG还逐字段检查首次补码和WM0072修订的全部历史DTO。

证据：[页面/HTTP/SQL三方对照](../../.local/catalog/run-20261020T093230Z-e4c1ad86/evidence/browser-2026-10-20T09-32-33-793Z-20e3ca/history-page-http-export-sql.json)、[补码历史DTO](../../.local/catalog/run-20261020T093149Z-5c2ff439/evidence/postgres-2026-10-20T09-31-56-208Z-18c730/revision-audit-projection-first-code.json)、[非价格历史DTO](../../.local/catalog/run-20261020T093149Z-5c2ff439/evidence/postgres-2026-10-20T09-31-56-208Z-18c730/revision-audit-projection-nonprice.json)、[金融指针及重导](../../.local/catalog/run-20261020T093149Z-5c2ff439/evidence/postgres-2026-10-20T09-31-56-208Z-18c730/revision-reimport-values.json)。匿名、operator、停用及撤权拒绝路径由本轮浏览器实际重跑；领域测试还向模拟DB行加入session、金额整行和storage handle，确认投影不会泄漏。

## R3：矛盾的有效目标整体拒绝

[受控发布SQL](../../db/catalog/002_catalog_security.sql:136)在candidate_snapshot目标转换时，将原selectedMasterRow/Code与已解析anchor的原行位置、不可变revision 1货号核对。原行必须是数字、货号必须是字符串且相符，必需信息缺失、为null、类型错误或相互矛盾均以`22023 / CATALOG_BASELINE_TARGET_INVALID`拒绝；没有目标却携带目标摘要也拒绝。不存在anchor仍由原STRICT查找拒绝。它只校验这份冻结选择，不定义永久自动匹配或正式关系规则。

实际负向在全新空实例将`/candidates/0`的原`/master_rows/87`（92行WM0098）改为另一真实存在的`/master_rows/0`（2行LS101311），保留原summary、payloadSha256、contentSha256和两份pin。结果拒绝；item、observation、decision、release、published和audit均为0。另有8种缺失/冲突/类型异常及1种未选择却携带目标摘要，共10场景全部整体回滚。

证据：[10场景真实结果](../../.local/catalog/run-20261020T093149Z-5c2ff439/evidence/postgres-2026-10-20T09-31-56-208Z-18c730/invalid-existing-target-and-metadata.json)、[原不存在anchor中途失败](../../.local/catalog/run-20261020T093149Z-5c2ff439/evidence/postgres-2026-10-20T09-31-56-208Z-18c730/atomic-midpublish-failure.json)、[pin/artifact/JST负向](../../.local/catalog/run-20261020T093149Z-5c2ff439/evidence/postgres-2026-10-20T09-31-56-208Z-18c730/invalid-input-and-jst-failures.json)。正常发布后仍[逐条反查548原目标、货号、JST引用及决定历史](../../.local/catalog/run-20261020T093149Z-5c2ff439/evidence/postgres-2026-10-20T09-31-56-208Z-18c730/exact-548-target-jst-history.json)，没有重新匹配或更改任何已确认选择。原独立错误目标探针已完整回滚，本轮不将它当作正式数据污染。

## 本轮实际命令与结果

所有命令从`D:\try one\ICEOS`运行；[外层命令receipt](../../.local/catalog/repair-20261020T092115Z-2b8397ed/evidence/check-catalog-final.json)及各子receipt保存实际argv、cwd、起止时间、退出码、stdout/stderr。外层保存器遇到非0退出会报错退出1；下述数字为实际被检查命令的退出码。

1. `node scripts/catalog/prepare.mjs --run-id run-20261020T093149Z-5c2ff439`：0，新运行号、新空本地PG；[prepare receipt](../../.local/catalog/repair-20261020T092115Z-2b8397ed/evidence/prepare-final.json)。未向旧执行/P0/独立审查实例追加DDL。
2. `node scripts/catalog/run-check.mjs --run-id run-20261020T093149Z-5c2ff439`：0；[最终checker](../../.local/catalog/run-20261020T093149Z-5c2ff439/evidence/check-2026-10-20T09-31-53-510Z-5a43ab/result.json)。41项领域测试、12组真实PG测试、2项Playwright浏览器测试全部通过，浏览器使用独立新实例`run-20261020T093230Z-e4c1ad86`。
3. 隔离workspace内`node node_modules/next/dist/bin/next build --webpack`：0；[构建日志](../../.local/catalog/run-20261020T093230Z-e4c1ad86/evidence/browser-2026-10-20T09-32-33-793Z-20e3ca/build.json)。[源码快照](../../.local/catalog/run-20261020T093230Z-e4c1ad86/evidence/browser-2026-10-20T09-32-33-793Z-20e3ca/source-manifest.json)指纹`3e5c26d9cddee2acccc7f24d06ca3b531e724075d2516a55ea8330a125b23907`，运行器核对构建前后根源码与复制件一致；未在仓库根构建覆盖旧产物。
4. `node node_modules/eslint/bin/eslint.js --max-warnings 0`：0；[最终全仓lint](../../.local/catalog/repair-20261020T092115Z-2b8397ed/evidence/lint-final.json)。
5. `node node_modules/vitest/vitest.mjs run --exclude '**/concurrency.test.ts' --exclude '**/*.postgres.test.ts' --exclude '**/*.live.test.ts' --exclude 'tests/p0-02/**'`：1，4132通过/1失败；[本轮回归日志](../../.local/catalog/repair-20261020T092115Z-2b8397ed/evidence/regression-broad.json)。唯一失败仍为`src/features/database/opt6-production-apply.test.ts:43`的00051字节/换行契约，未修改旧测试、SQL或packet。没有将普通回归排除的PG/live算作已验；本包PG由独立显式命令运行。
6. `node node_modules/typescript/bin/tsc --noEmit --pretty false --incremental false`：2；[最终完整诊断](../../.local/catalog/repair-20261020T092115Z-2b8397ed/evidence/tsc-diagnostic-final.json)。实际重跑仍54条诊断、21份旧测试，本包catalog诊断0；[分类结果](../../.local/catalog/repair-20261020T092115Z-2b8397ed/evidence/tsc-summary-final.json)。这与隔离Next构建成功分别记录，未以改旧测试凑绿。
7. `git diff --check`：0；[结束保护检查](../../.local/catalog/repair-20261020T092115Z-2b8397ed/evidence/workspace-after.json)同时保存status、未暂存binary diff、暂存区、分支和HEAD。

真实PG覆盖RLS、非owner/non-superuser/non-BYPASSRLS、16张FORCE RLS表、金额直查拒绝、幂等/CAS并发、失败整体回滚、未知COMMIT及连接池身份不串用。147份完整产物与129份JSON/CSV子集分别核查；126 anchor→UUID、1417来源及548条具体选择保持；6190条证据索引（含3160 CSV记录、1421决定历史、126主资料历史和66条全局历史）逐项哈希/摘要保持，CSV没有重放为新操作。[完整历史结果](../../.local/catalog/run-20261020T093149Z-5c2ff439/evidence/postgres-2026-10-20T09-31-56-208Z-18c730/all-history-preservation.json)、[公共旧三表不变](../../.local/catalog/run-20261020T093149Z-5c2ff439/evidence/postgres-2026-10-20T09-31-56-208Z-18c730/public-after.json)、[anchor清单](../../.local/catalog/run-20261020T093149Z-5c2ff439/evidence/postgres-2026-10-20T09-31-56-208Z-18c730/anchor-to-uuid126.json)。

## 失败尝试与证据边界

首次新PG运行`run-20261020T092525Z-f5547c3a`：41领域/12PG/隔离build已通过，但其浏览器`run-20261020T092816Z-8b322e91`在新增断言失败，另1个串行测试未执行，checker退出1；[首次外层receipt](../../.local/catalog/repair-20261020T092115Z-2b8397ed/evidence/check-catalog.json)。原因是新增测试将修订级evidence_ref误认为字段级fixture引用，实际Repository一直保存`manual-request:<requestId>`。修正为两者各自精确核对，没有改产品行为或放宽断言；[修正及前后hash](../../.local/catalog/repair-20261020T092115Z-2b8397ed/evidence/browser-evidence-reference-test-fix.json)。原失败日志、截图、trace、源码workspace及数据库均保留；最终门禁在另一对全新实例完整重跑。

领域定向测试、定向lint、两次全仓lint/tsc及只读执行侧自查分别留痕。执行侧自查不冒充独立审查。只读辅助查询遇到一次配置文件扩展名判断错误和Windows默认GBK读/输出错误，改用实际`.mts`及显式UTF-8读取；[辅助操作说明](../../.local/catalog/repair-20261020T092115Z-2b8397ed/evidence/tooling-notes.json)。Git全局ignore权限提示、CRLF提示、Playwright色彩环境提示以及pg_ctl本地化输出解码提示保持原日志，不作为产品通过证据。

## 保护、停服与neat-freak

开始冻结13,633份受保护文件的大小/SHA256及分支、HEAD、status/diff/暂存；结束逐份对照，仅本轮7份实现/测试文件及AGENTS/current-state/current-task三份授权入口改变，其余13,623份保持。原始资料、已确认决定、旧失败/交付/独立报告、.local保护清单、HOLD、旧脚本及00001—00052保持。保护范围以manifest明列文件为准；旧cluster数据及复制workspace没有冒称逐字节全盘审计。没有删除、搬移或再次盘点桌面，上一轮33份原地保留/归档0的独立复核结论不变。

唯一业务基线仍delivery-final-v2；bundle SHA256 `28d8d81c7d62beb95b99ebd188467c8a8ec69a9a6a4fe17df5970d8a0c6816ae`，effective CSV SHA256 `4428f4c80dcdde1c47508ac9eb433baa4f9a941934ae943cdd5e0116d3b49c14`，结束重新核对；[固定基线保护](../../.local/catalog/repair-20261020T092115Z-2b8397ed/evidence/baseline-protection.json)。未从桌面发现/合并CSV，未写真实业务数据。

本轮4个新PG实例按自有运行号、活marker、端口及精确dataDir核验后停止，pg_ctl退出0、status退出3、postmaster.pid消失，数据目录保留；[首次两实例停止](../../.local/catalog/repair-20261020T092115Z-2b8397ed/evidence/instance-stop-first-attempt.json)、[最终停止登记](../../.local/catalog/repair-20261020T092115Z-2b8397ed/evidence/instance-stop.json)。两个隔离Next/浏览器运行器均已收回子进程；根debug.log保持原93字节及原哈希，GPU警告只落在新workspace。

按已读取的`C:\Users\Administrator\.agents\skills\neat-freak\SKILL.md`完成必要知识对齐：代码/本地运行态changed-and-verified，文档/规则changed-and-verified，工作区保护verified-current；记忆写入与生产运行态out-of-scope，独立复审pending。不清场、不写记忆，复核现场保留。现役入口链接到本报告，旧首包报告及独立CHANGES_REQUIRED报告保留原文。

## 复现与停止

使用另一全新`run-YYYYMMDDTHHMMSSZ-8hex`运行`npm run catalog:prepare -- --run-id <新号>`，再`npm run check:catalog -- --run-id <同新号>`；检查器会另建新浏览器实例。不要重用本报告或任何P0/审查实例追加DDL。固定输入、完整历史和原始证据仍是权威。

未启用长期来源身份、正式关系、改绑/撤销/换表或库存；未接真实BS/JST、开放平台或飞书写入/调度；飞书仍是冻结partial。旧角色表无法构造manager账号的限制继续沿用，实际拒绝验证覆盖匿名/operator/停用/撤权，严格admin策略另有代码和RLS依据。不迁移旧Supabase数据，不提交、推送、合并或部署。

停止于**商品资料首包三项补修、执行自验及文档收尾完成，待独立复审。** [交付索引](../../.local/catalog/repair-20261020T092115Z-2b8397ed/delivery-index.md)包含精确变更及SHA、原始字节差异、测试和失败证据、保护与停服入口。
