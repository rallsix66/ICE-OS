# N1A 两项残余补修执行报告

2026-10-20。**来源身份 N1A 两项残余补修、自验及文档收尾完成，待独立复审。** 仅执行侧自验，不登记 N1A PASS，不进入 N1C/N1B/N2。

[交付索引](../../.local/catalog/source-identity-residual-20261020T124340Z-c4142a46/delivery-index.md)、[本次独立报告](../../.local/catalog/independent-source-identity-repair-review-20261020T123302Z-6919de6b/independent-review.md)、[限定指令](../../.local/catalog/independent-source-identity-repair-review-20261020T123302Z-6919de6b/repair-instructions.md)。独立审查已关闭 N1A-R1；本次仅修 R2/R3 残余路径。旧报告、探针和失败全部保留。商品资料首包及其原 R1—R3、P0_01/02/03_PASS 和 P0-03 收尾结论保持。

## R2：证明覆盖实际观测及来源

修复前原004、新19组回归在全新实例实际得到17通过/2失败（exit1）。R2 soft-collect记录7次错误接受：三种失效后分别将 B 新证明与 A 旧观测/另一 capture 的 A 观测拼接，以及 capture 合同错配。实际请求和完整前后事实保留在[红测入口](../../.local/catalog/source-identity-residual-20261020T124340Z-c4142a46/evidence/red-evidence-index.json)，不是推测或以通过断言代替红灯。

[SQL复核边界](../../db/catalog/004_source_identity_security.sql#L101)仅对 reverify 要求所选观测保存的 evidence_id 等于所用 proof.id，且保存的 capture 合同 id/revision 与所选合同一致。随后仍检查原 claim、CAS、当前不可变失效头、采集 freshness、同 bytes 最早采集、该来源已使用 bytes、原请求和墓碑；不以客户端布尔勾选代替成员事实。初次 register 的范围证明继续合法，同批实际含 A、B 时可各自复核，不作全局一证一次限制。

修后真实 app PG覆盖 open_review/suspend/revoke 后两类同scope错配、合同错配、跨scope证明/观测、错误claim/CAS：record/claim/request/link全状态不变；真正新 A 成员沿原UUID恢复，同批 A/B分别合法，精确原请求重试只读。原 R1 撤销资格及失败/并发矩阵保持。

新增浏览器真实提交 B-only 新证明+A旧观测，HTTP返回安全 conflict，固定中文说明其未覆盖，头及四表状态不前进；随后包含 A 的新采集经相同页面 Action 恢复原UUID/claim。响应由真实服务器产生，测试只原样转发取证，不合成拒绝或成功。

## R3：冻结原行已知范围不得被 support 冲掉

红测 R3 记录8次错误接受：market/warehouse 的首次关联、已关联改挂、撤后重挂及unknown范围证明不足。warehouse优先使用本批真实未关联原行“喜运达MY仓”，不改固定原行。基线market全部unknown；market组合只在事务内复制隔离观测，前序关联也仅回滚fixture，证据明确 rollbackOnlyProbe，不冒称已提交业务事实。

[SQL冻结原行检查](../../db/catalog/004_source_identity_security.sql#L148)同时核 fo.scope 与既有 support 的身份维度。known 的 raw/canonical 必须精确符合受信策略；已知相反拒绝为 IDENTITY_FROZEN_SCOPE_CONTRADICTION，不推断仓别别名、不把known降unknown。unknown/not_applicable/未提供维度只按已有充分范围证明路径；[缺失状态处理](../../db/catalog/004_source_identity_security.sql#L279)避免缺少JSON维度绕过该路径。context的合法补充继续保留。

真实PG逐项覆盖两个维度的first/linked改挂/revoked重挂冲突、known一致、unknown充分/不足证明，共14项（8拒绝、6正例），保存原冻结行、原决定和状态哈希。14项关联尝试均在真实app角色路径事务内验证后回滚；前序关联与market复制行只属rollback fixture，不记为已提交历史。拒绝无半写、旧行/原决定保持；历史坏关联仍可授权撤销，R1 revoke分支未加新建资格。

[代码及原始回执复核](../../.local/catalog/source-identity-residual-20261020T124340Z-c4142a46/evidence/core-final-evidence-check.json)核原17测试标题/顺序保留、16份原body字节相同。唯一旧R3支持观测负例将warehouse策略改为实际原仓“喜运达MY仓”，确保仍抵达原support矛盾检查；所有原断言行不变。R1授权/CAS/撤销继承和link写入两段字节保持。此复核属执行侧，不是独立签收。

新增浏览器使用真实原冻结known仓W2、隔离身份及support W1，实际关联拒绝；中文提示范围冲突、未建立关联，原商品选择和历史DOM仍可见。原文件和548决定不因新观测改变。

## 最小变更与执行自验

功能变化限004、三份N1测试，以及必要的[Action错误码白名单](../../src/features/catalog/source-identity/actions.ts)和[两条固定中文提示](../../src/features/catalog/components/source-identity-panel.tsx)。后两文件仅让实际拒绝路径可解释，不返回原始范围值、raw或金额；无权限、DTO、Repository或入口改变。改Next前按AGENTS读安装版指南。003/001/002、00001—00052、旧脚本/测试/package、原详情挂载不变。[10份实现/文档SHA清单](../../.local/catalog/source-identity-residual-20261020T124340Z-c4142a46/implementation-manifest.json)包含6份功能/测试、3入口和本报告。

- 完整fresh prepare/check `run-20261020T125311Z-9fdccde6`：exit0，**46领域/19真实PG/5浏览器**，10项prepare拒绝保护，隔离Next webpack build通过。非owner/non-superuser/non-BYPASSRLS、FORCE RLS、连接池/金额/raw拒绝、CAS/并发、失败注入/恢复原矩阵保留，未用任意提前拒绝替代预期注入点。
- 另一全新、未装N1 DDL实例 `run-20261020T125623Z-1c84fa60`：旧catalog **41领域/12真实PG/2浏览器**及另一build通过；旧测试不改。N1 browser `run-20261020T125351Z-dc047987`；基础browser `run-20261020T125734Z-346ccbb2`。
- 全仓lint `--max-warnings 0` exit0；普通回归4132通过/1旧失败（00051静态合同，opt6-production-apply.test.ts:43:93）；直接tsc exit2、54条旧诊断/21文件逐条相同，新增0。[逐项比较](../../.local/catalog/source-identity-residual-20261020T124340Z-c4142a46/evidence/regression-comparison-final.json)。没有修旧测试或旧迁移凑绿。
- [实际命令、退出码](../../.local/catalog/source-identity-residual-20261020T124340Z-c4142a46/actual-commands.json)、[完整门禁与输出索引](../../.local/catalog/source-identity-residual-20261020T124340Z-c4142a46/evidence-map.json)、[逐项最终断言](../../.local/catalog/source-identity-residual-20261020T124340Z-c4142a46/evidence/infra-final-assertions.json)、[所有本轮运行技术证据SHA](../../.local/catalog/source-identity-residual-20261020T124340Z-c4142a46/runtime-evidence-manifest.json)。以上是本次实际执行，不是仅核查旧日志，不代替独立复审。

## 基线和工作区保护

唯一业务输入仍delivery-final-v2；[147完整产物和129 JSON/CSV子集](../../.local/catalog/source-identity-residual-20261020T124340Z-c4142a46/input-manifest.json)分别逐文件核大小及SHA。bundle pin `28d8d81c7d62beb95b99ebd188467c8a8ec69a9a6a4fe17df5970d8a0c6816ae`；有效CSV pin `4428f4c80dcdde1c47508ac9eb433baa4f9a941934ae943cdd5e0116d3b49c14`。

[126 anchor→UUID](../../.local/catalog/run-20261020T125311Z-9fdccde6/evidence/source-identity-postgres-2026-10-20T12-53-18-578Z-5c8d64/output-anchor-uuid126.json)、[1417来源](../../.local/catalog/run-20261020T125311Z-9fdccde6/evidence/source-identity-postgres-2026-10-20T12-53-18-578Z-5c8d64/output-frozen-observation1417.json)、[548逐条原目标/JST](../../.local/catalog/run-20261020T125311Z-9fdccde6/evidence/source-identity-postgres-2026-10-20T12-53-18-578Z-5c8d64/frozen-548-exact.json)、[6190历史字段](../../.local/catalog/run-20261020T125311Z-9fdccde6/evidence/source-identity-postgres-2026-10-20T12-53-18-578Z-5c8d64/all-6190-history-exact.json)实际逐条回查；3160行CSV仅历史，不重放、重选或重匹配。122新品一UUID、旧缺码revision、补码/修订后重导不回退当前资料或金融指针由基础门禁核验；WM0072采用5.18/5.68与共享观测5/5.5、两版历史保持。两刷子、缺码、未建档、ignore/reject/defer和public三表完整行保持。

开始固定14,291份既有文件（此前保护14,235+本次审查56）；[最终保护](../../.local/catalog/source-identity-residual-20261020T124340Z-c4142a46/evidence/protection-final.json)核仅9个允许既有文件变化，另新增本报告。分支codex/ice-v4-planning、HEAD c862a8017b91448a8f1c7919f0a5025ea46c499b、暂存空且不变；旧dirty、原资料/HOLD、全部旧证据/嵌套manifest保持。current-state从首包章节、current-task从P0-03章节尾部原字节保持，AGENTS仅当前状态行替换。[链接检查](../../.local/catalog/source-identity-residual-20261020T124340Z-c4142a46/evidence/link-check-final.json)、[neat-freak](../../.local/catalog/source-identity-residual-20261020T124340Z-c4142a46/neat-freak-closeout.md)。

本轮自有 **5个PG实例、2台Next**均按run/marker/端口/精确dataDir停止，[停止/失败总账](../../.local/catalog/source-identity-residual-20261020T124340Z-c4142a46/evidence/own-run-ledger.json)保留每次状态与退出码；不触碰旧实例或其他会话，数据和失败现场保留。新门禁失败另起新实例，未向旧实例追加DDL。新目录manifest递归枚举全部普通文件，仅排除其自身精确路径，不按basename遗漏嵌套同名文件；运行库/private bytes/工作区副本独立保存，不冒称全部运行数据都列入技术证据清单。

起点helper首次将本次审查manifest的files map误作array，在读取阶段失败，修正后固定起点。另一次shell引号解析失败、[无run的路径预检失败](../../.local/catalog/source-identity-residual-20261020T124340Z-c4142a46/evidence/preflight-wrong-path-no-run.json)、[Windows绝对import失败及恢复](../../.local/catalog/source-identity-residual-20261020T124340Z-c4142a46/evidence/evidence-helper-recovery.json)和[只读路径查找失误](../../.local/catalog/source-identity-residual-20261020T124340Z-c4142a46/evidence/root-read-only-preparation-notes.json)均单独保留；这些不是功能门禁通过凭证。未改旧证据，所有实际红测失败和trace由运行总账、技术证据清单保存，不抹除失败。

## 限制及复现

真实身份核实仍0、relationshipUsable=false；飞书仍部分读取（27列表头/16行位置部分字段），稳定行ID和全表完整性未核实。未访问真实账号、写飞书、启用正式关系、换表、采集调度或库存。桌面33份原地保留/归档0的已独立结论继承，本轮不重扫或搬动。无清场/记忆写入/提交/推送/部署。

每次复现生成新运行号，失败现场保留，不续装旧实例：

```powershell
$n1ResidualRun = 'run-' + (Get-Date).ToUniversalTime().ToString('yyyyMMddTHHmmssZ') + '-' + [guid]::NewGuid().ToString('N').Substring(0,8)
node scripts/catalog/prepare-source-identity.mjs --run-id $n1ResidualRun
node scripts/catalog/run-source-identity-check.mjs --run-id $n1ResidualRun
```

**来源身份 N1A 两项残余补修、自验及文档收尾完成，待独立复审。** 按已核实的人类两会话协作授权回报独立审查后停止，等待复审或下一份明确指令。
