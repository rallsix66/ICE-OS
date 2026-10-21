# 来源身份 N1A 三项补修执行报告

2026-10-20。**来源身份 N1A 三项补修、自验及文档收尾完成，待独立复审。** 本文是执行侧自验；不登记独立 PASS，不进入 N1C/N1B/N2。

[交付索引](../../.local/catalog/source-identity-repair-20261020T120334Z-fec7b094/delivery-index.md)、[本次独立审查及 CHANGES_REQUIRED](../../.local/catalog/independent-source-identity-review-20261020T115053Z-3dc4a0c0/independent-review.md)、[限定补修指令](../../.local/catalog/independent-source-identity-review-20261020T115053Z-3dc4a0c0/repair-instructions.md)。原审查、原交付及全部失败证据不改写。P0_01/02/03_PASS、商品资料首包及其旧 R1/R2/R3 独立通过结论保持。

## 三项回应与实现边界

本次功能变化恰为[004 SQL](../../db/catalog/004_source_identity_security.sql)及三份 N1A 测试：[领域](../../tests/catalog/source-identity.test.ts)、[真实 PG](../../tests/catalog/source-identity.postgres.test.ts)、[浏览器](../../tests/catalog/source-identity.browser.pw.ts)。另更新三个现役入口并新增本报告，准确差异和 SHA 见[implementation-manifest](../../.local/catalog/source-identity-repair-20261020T120334Z-fec7b094/implementation-manifest.json)。无需改003/001/002、原详情挂载、服务/DTO/UI、旧脚本和测试或 package。

**N1A-R1。** 新增/改关联继续验证 active、当前身份键和范围资格。撤销当前已有关联仅验证当前授权、原 record、同 scope、linked 前序、record/link CAS 和本次 proof/reason，不要求原关联重新通过当前 active/新键的新建资格。撤销事件保留原 record、合同、证明、观测及原选择引用；本次成功请求单独保存当前 proof/理由。五种状态 active/review_required/suspended/revoked/合法换键（含合同升版）均真实验过；原请求幂等、双连接单次提交、错误对象/不存在前序/旧 CAS/跨 scope/撤权拒绝、成功审计失败整笔回滚均有全状态断言。撤销观测关联不恢复身份，也不修改548个商品目标。

**N1A-R2。** 新证明资格随该来源当前不可变头请求及全部已核实/失效事实前进；相同原始 bytes 的最早采集事实不会因技术 UUID、capture key 或重导改变。身份成功事实用持锁后实际 clock_timestamp() 记录，已验提前 BEGIN 的失效事务不能把其后采到但失效前的证明误判为新证明。针对该 record 的 claim/request 已用证明 bytes 防止再次核实，不做全库一次性消费；一个真正新批次仍可分别服务多个来源。原请求回执读取/精确幂等重试先验证当前授权，返回原事实而不推进头。open_review/suspend/revoke 后，已用旧证明及失效前未使用的旧 capture 换 UUID 均拒绝；正确 CAS 不能使旧证明变新。真正新证明显式复核沿原 UUID/claim，保留墓碑和全部历史；并发与两写点失败回滚已验。此处采集时间是隔离证明入系统的时间，不伪造真实来源逐条更新时间。

**N1A-R3。** SQL 统一验证 identity 市场/仓库的已知 canonical 值与受信 scope 政策；明确相反的已知维度只能留观测，不能登记、精确复用、复核或新增/改关联。冻结观测的支持资料也不能用矛盾或无证明资料冒充有效支持。context 维度的 unknown→known 继续沿同 scope/source UUID/claim，不改变身份粒度。行上 unknown/not_applicable 与 known-other 分开：仅在 identity_ready、固定 canonical 和同 scope 初始证明充分时，缺失路径可依范围证明核实，行本身仍原样保留；证明不足仅观测，不能猜补或把矛盾降 unknown。市场/仓库分别有匹配正例、四类动作矛盾负向、历史坏关联的改关联拒绝和无充分证明负向。这里是可信 fixture 的真实 app SQL 语义检查，不声称固定页面可以提交任意 prepared payload 或证明客户端越权。

## 实际执行自验

- 修复前以原004和新增回归在全新实例实际红测：17组中14通过、R1/R2/R3三组失败，退出1。R1先检出撤销时原证明引用被当前 proof 替换，R2检出旧证明被再次采用，R3检出明确矛盾被登记；暂停/撤销/换键失败的原独立探针仍保留。红测不是通过凭证。
- 修复后完整 prepare/check：`run-20261020T122054Z-4f86b03a`，退出0；10项 prepare 拒绝保护；**44领域 / 17真实 PG / 3浏览器**，隔离 Next webpack build 通过。最终状态覆盖范围/权限/金额/raw/连接池、CAS/头事实、原请求、真实 COMMIT 后 ACK 注入、失败写点、完整历史与新三项组合。注入回滚须实际到达 P0001/ISOLATED_INJECTED_FAILURE，不以任意提前拒绝充数。
- 另一套全新、未装 N1 DDL 的基础实例：**41领域 / 12真实 PG / 2浏览器**及独立 build 通过，未修改旧测试适配新结构。N1浏览器 `run-20261020T122121Z-56273da5`、旧基础 `run-20261020T122325Z-0c5ec18f`、旧浏览器 `run-20261020T122421Z-35f19de4`。
- 新第3浏览器场景真实执行“关联→暂停身份→撤销关联”，逐次核 HTTP/DOM/DB、身份仍暂停、旧 link 历史保留；再用新证明复核→新墓碑→同旧证明新请求被拒且头/历史不变→真正新证明恢复，同 UUID/claim，完整旧历史保留。受控新证明在测试内创建，导入走非 owner app SQL；复核/撤销操作走原页面 Action。固定 fixture 和生产准备入口未改变。
- 全仓 lint `--max-warnings 0` 退出0。普通回归 **4132通过/1既有失败**（opt6-production-apply.test.ts:43，00051静态合同）；直接 tsc **退出2，54条旧诊断/21旧文件**逐条与旧日志一致，新增0。[逐条比较](../../.local/catalog/source-identity-repair-20261020T120334Z-fec7b094/evidence/regression-comparison-transport-final.json)。不修改旧测试或旧迁移掩盖问题。
- [实际命令/退出码](../../.local/catalog/source-identity-repair-20261020T120334Z-fec7b094/actual-commands.json)、[运行与原始证据索引](../../.local/catalog/source-identity-repair-20261020T120334Z-fec7b094/evidence-map.json)、[本轮实例账](../../.local/catalog/source-identity-repair-20261020T120334Z-fec7b094/evidence/own-run-ledger.json)。独立审查此前实际重跑的旧完整门禁及其只核 lint/普通回归/tsc 日志的层级保持，不冒称本次补修已独立重跑或签收。

## 固定基线与业务保护

唯一输入仍为 delivery-final-v2，bundle `28d8d81c7d62beb95b99ebd188467c8a8ec69a9a6a4fe17df5970d8a0c6816ae`、有效CSV `4428f4c80dcdde1c47508ac9eb433baa4f9a941934ae943cdd5e0116d3b49c14`；[147完整产物/129 JSON与CSV子集](../../.local/catalog/source-identity-repair-20261020T120334Z-fec7b094/input-manifest.json)分别按大小与 SHA 核验，不按子集冒称全集。

[126 anchor→UUID](../../.local/catalog/run-20261020T122054Z-4f86b03a/evidence/source-identity-postgres-2026-10-20T12-21-02-183Z-f518e0/output-anchor-uuid126.json)、[1417原来源](../../.local/catalog/run-20261020T122054Z-4f86b03a/evidence/source-identity-postgres-2026-10-20T12-21-02-183Z-f518e0/output-frozen-observation1417.json)、[548逐条原目标/JST](../../.local/catalog/run-20261020T122054Z-4f86b03a/evidence/source-identity-postgres-2026-10-20T12-21-02-183Z-f518e0/frozen-548-exact.json)和[6190全部历史字段](../../.local/catalog/run-20261020T122054Z-4f86b03a/evidence/source-identity-postgres-2026-10-20T12-21-02-183Z-f518e0/all-6190-history-exact.json)真实逐项核对，3160行CSV仅作历史，不重放/重选/重匹配。122缺码新品仍一份 UUID，旧缺码revision及补码后重导不回退由另一套基础门禁验证。WM0072采用5.18/5.68，共享观测5/5.5、两版历史和金融指针保持。两刷子、缺码、未建档、ignore/reject/defer保持；public Product/Variant/Inventory完整行不变。

飞书仍部分读取（27列表头、16行位置部分字段），稳定行身份及全表完整性未核实；本包真实长期核实数0，relationshipUsable=false。没有真实账号、真实采集、换表、正式关系、目标生命周期、库存或调度操作。

## 文档、保护、失败和停止

开始固定14,126份既有文件；最终[保护检查](../../.local/catalog/source-identity-repair-20261020T120334Z-fec7b094/evidence/protection-final.json)核仅7个允许既有文件变化，其他历史证据、原资料/HOLD/dirty、旧脚本/迁移、HEAD/分支/暂存保持，首包及P0历史章节逐字节保持。[链接及索引检查](../../.local/catalog/source-identity-repair-20261020T120334Z-fec7b094/evidence/link-check-final.json)、[neat-freak记录](../../.local/catalog/source-identity-repair-20261020T120334Z-fec7b094/neat-freak-closeout.md)。只更新新报告和三入口当前状态，不改旧 CHANGES_REQUIRED，不清场、不扫/搬桌面、不写记忆。

曾有一次完整门禁在新增第3浏览器的 response.text 取证处遇到 CDP Network.getResponseBody 错误：当次44领域/17PG/build及原2浏览器通过，完整check仍退出1，旧基础阶段尚未开始。只修测试HTTP取证helper，改为 route.fetch 读取真实响应再原样 fulfill，保留同一页面Action和HTTP/DOM/DB断言；失败trace/截图及源码snapshot保持，以本报告最终全新完整门禁为准。

本轮自有 **7个PG实例、3台Next**已按精确 marker/run/端口/dataDir停止，数据、失败和复制源码现场保留；旧22实例不重停，不触碰其他会话服务。每次失败另开新号/实例，不向旧实例追加 DDL。[实例与失败总账](../../.local/catalog/source-identity-repair-20261020T120334Z-fec7b094/evidence/own-run-ledger.json)记录包括修复前预期红测及后续每次实际失败；不能把预期红测和偶发自验失败合并成通过。

交付 manifest 递归枚举本次目录所有普通文件，仅排除根目录自身那个精确路径；不按 basename 排除历史同名文件。运行目录另以[技术证据哈希清单](../../.local/catalog/source-identity-repair-20261020T120334Z-fec7b094/runtime-evidence-manifest.json)、源快照/命令/停止账追溯；旧交付的历史 nested manifest 仍在保护集固定，未声称当前目录直接枚举所有运行数据。

复现时每次生成新号，运行现有入口（保留失败目录，不续装旧实例）：

```powershell
$n1RepairRun = 'run-' + (Get-Date).ToUniversalTime().ToString('yyyyMMddTHHmmssZ') + '-' + [guid]::NewGuid().ToString('N').Substring(0,8)
node scripts/catalog/prepare-source-identity.mjs --run-id $n1RepairRun
node scripts/catalog/run-source-identity-check.mjs --run-id $n1RepairRun
```

以上是本地隔离执行自验完成，**待独立复审**。不提交、推送、合并、部署，不自行进入其他包。
