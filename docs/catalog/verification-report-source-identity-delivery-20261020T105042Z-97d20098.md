# 来源身份N1A执行自验报告

2026-10-20。**来源身份N1A本地隔离实施、自验和文档收尾完成，待独立审查。** 本文记录执行侧检查，不登记功能独立PASS或新P0阶段。

[交付索引](../../.local/catalog/source-identity-delivery-20261020T105042Z-97d20098/delivery-index.md)、[实现说明](../../.local/catalog/source-identity-delivery-20261020T105042Z-97d20098/implementation-notes.md)、[批准消息追溯](../../.local/catalog/source-identity-delivery-20261020T105042Z-97d20098/evidence/approved-n1a-dispatch.json)。合同v2及原审查文件不改写。P0_01/02/03_PASS、首包及R1—R3独立通过结论继续保持。

## 实际改动

26份新代码/SQL/配置/fixture、两处原详情挂载及三份现役入口，另新增本报告。完整文件与SHA见[implementation-manifest](../../.local/catalog/source-identity-delivery-20261020T105042Z-97d20098/implementation-manifest.json)。[003](../../db/catalog/003_source_identity.sql)与[004](../../db/catalog/004_source_identity_security.sql)新增10表和受控SQL；[身份服务](../../src/features/catalog/source-identity/service.ts)复用认证/事务/Repository；[页面](../../src/features/catalog/components/source-identity-panel.tsx)明确fixture、三种资格、旧人工决定及历史。

固定scope canonical、稳定ID/可靠组合键/仅观测三路、墓碑和改键证明、真实合同revision FK、SQL完整意图重算、头部CAS/当前事务事实闭合、同scope观测纠错及不可变历史均已实现。新证据/私有handle/请求账与旧全管理员表隔离；FORCE RLS、服务端当前授权和raw金额保护共同生效。原商品目标、资料采用值、金额、R1/R2表单不改。

原详情仅增加受权的当前核实附注及入口；历史商品revision仍显示当时资料。scope工作区展示原决定目标/JST/状态、局部多目标冲突、必要键缺口、身份before/after及全部关联版本。未知结果只核对完整原意图，独立按钮不依赖表单；撤权仍保留pending但不返回旧回执。

## 本轮实际验证

- 新prepare **10项拒绝保护通过**：缺/旧运行号、已有空根/非空目标、非loopback、继承连接/外部auth URL、URL参数、链接越界等；helper导入/建目录/连库前拒绝，旧marker/sentinel哈希不变。
- N1A **40领域 / 14真实PG / 2浏览器通过**，新隔离Next build通过。PG运行身份非owner/non-superuser/non-BYPASSRLS，10表FORCE RLS；直接DML、跨scope、缺read/manage/evidence/amount、匿名/停用/撤权均按合同拒绝。
- 同请求幂等、两连接注册/复核/合法同scope纠错、record/claim/私有handle/观测/link/head/成功账各写点失败回滚、错误合同revision/头回退/跳版/after_state错配、哈希全文冲突、unresolved与真正身份维度变化均有实际PG断言。旧键/墓碑不复活，改键沿原UUID并保留旧claim。
- Repository实际执行COMMIT后注入ACK丢失，独立receipt核对且仅一次事实；浏览器另测一次合成unknown回执与真实成功后丢浏览器响应，两者不冒称同一种网络故障。原输入/ID/CAS保持，撤权回查无泄漏。HTTP、最终DOM、数据库逐字段对照，缓存头和无localStorage/无金额默认投影均实测。
- 另一套全新、**未装N1**基础实例完整运行旧catalog门禁：**41领域 / 12真实PG / 2浏览器及隔离build通过**。包括122同UUID补码/旧缺码revision/重导不回退、金融指针、R3另一有效错误目标整体拒绝、权限和恢复；未改旧测试适配新表。
- 全仓lint通过（直接node执行eslint，等价npm脚本，max-warnings=0）。普通回归实际重跑**4132通过/1旧失败**；直接tsc实际退出2，**54条旧诊断/21旧文件**逐条与上次补修一致，新增0。[最终SQL补强后的比较](../../.local/catalog/source-identity-delivery-20261020T105042Z-97d20098/evidence/tsc-sql-null-final-comparison.json)。这些不是全绿，不修改旧测试掩盖。
- 最终diff、链接、白名单与保护检查另存收尾凭证。Git已有CRLF/用户全局ignore读取提示保留，构建日志和旧诊断原文保留。

## 业务基线与输出

唯一输入仍是delivery-final-v2：bundle `28d8d81c7d62beb95b99ebd188467c8a8ec69a9a6a4fe17df5970d8a0c6816ae`；有效CSV `4428f4c80dcdde1c47508ac9eb433baa4f9a941934ae943cdd5e0116d3b49c14`。147完整产物和129 JSON/CSV子集分别逐字节核对，[input-manifest](../../.local/catalog/source-identity-delivery-20261020T105042Z-97d20098/input-manifest.json)不包含私有handle。

126 anchor→UUID、1417原来源位置、548每条原目标/JST/hash、全部6190历史key/summary/rawRef/hash逐项相等；3160行CSV只作冻结历史，不重放旧操作。输出入口：[126 UUID](../../.local/catalog/run-20261020T114314Z-d80411cb/evidence/source-identity-postgres-2026-10-20T11-43-20-406Z-e3a919/output-anchor-uuid126.json)、[1417来源](../../.local/catalog/run-20261020T114314Z-d80411cb/evidence/source-identity-postgres-2026-10-20T11-43-20-406Z-e3a919/output-frozen-observation1417.json)、[548核对](../../.local/catalog/run-20261020T114314Z-d80411cb/evidence/source-identity-postgres-2026-10-20T11-43-20-406Z-e3a919/frozen-548-exact.json)、[6190历史](../../.local/catalog/run-20261020T114314Z-d80411cb/evidence/source-identity-postgres-2026-10-20T11-43-20-406Z-e3a919/all-6190-history-exact.json)。新scope/contract/key→source UUID/claim/head与观测关联清单在同PG证据目录及[evidence-map](../../.local/catalog/source-identity-delivery-20261020T105042Z-97d20098/evidence-map.json)。

122缺码新品保持一份记录，BS/JST独立未建档不造数据或库存0；两刷子、ignore/reject及缺码保持。WM0072采用5.18/5.68，冻结飞书partial观测5/5.5和历史保持。旧public Product/Variant/Inventory全行前后相同；N1动作不改旧catalog决定/资料/金融指针。真实长期核实数仍0，relationshipUsable固定false。

## 尝试、失败和服务停止

全部失败/取消与中间成功保留，逐实例/命令/退出码见[own-run-ledger-v2](../../.local/catalog/source-identity-delivery-20261020T105042Z-97d20098/evidence/own-run-ledger-v2.json)，根命令见[actual-commands](../../.local/catalog/source-identity-delivery-20261020T105042Z-97d20098/actual-commands.json)。初期SQL编译、别名遮蔽登记失败、扩展PG测试自身max=1池嵌套自锁、源码未冻结的取消、浏览器标签定位、旧status测试竞态及把有manage但无rawcap的操作者误断言为权限拒绝分别有证据；没有改旧测试/权限凑绿。

最后直接SQL复核补上缺失/NULL command与operation的显式拒绝，防止SQL三值逻辑落入默认撤销分支；服务层Zod此前已拒绝这类客户端输入，不冒称已证明客户端越权。真实app函数另验7种缺失/NULL/action/payload负向，全部范围表、私有handle、原观测和成功账保持。此前完整通过113215和第一版收尾审计仍保留；本交付evidence/closeout-before-sql-null-review保存了当时报告/索引/manifest/入口原字节，后续以本报告的新完整门禁为准。

一次PG自然14/14但旧五表RLS关联耗时偏高；新004以MATERIALIZED CTE优化，仍保留全部RLS。优化后同14组约10秒，原link-chain67.4秒降至不足300毫秒；实际EXPLAIN另存。只说明本fixture测得结果，不外推生产性能。

最终完整check为 `run-20261020T114314Z-d80411cb`。N1浏览器 `run-20261020T114330Z-8097d9cc`，旧基础 `run-20261020T114444Z-739ce319`，旧浏览器 `run-20261020T114521Z-30c29226`。仅核本包marker/run/端口/精确dataDir停止自有PG/Next；数据、失败、workspace均保留。最终停止和PID/端口断言见ledger，不停止其他会话实例。

## 收尾与复现

[neat-freak范围](../../.local/catalog/source-identity-delivery-20261020T105042Z-97d20098/neat-freak-closeout.md)。13,897份既有文件保护集单列5份允许修改；其余文件、旧报告/失败、001/002、00001—00052、旧脚本/package/dirty、HEAD和暂存保持。最终哈希与P0章节逐字节核对见[保护复核v2](../../.local/catalog/source-identity-delivery-20261020T105042Z-97d20098/evidence/protection-final-v2.json)。未扫描或搬移桌面；33份保留/归档0是此前独立复核历史，不冒称本次重验。

```powershell
# 仓库根，每次新号/新空实例；不向旧实例追加DDL
$n1Run = 'run-' + [DateTime]::UtcNow.ToString('yyyyMMddTHHmmssZ') + '-' + [guid]::NewGuid().ToString('N').Substring(0,8)
node scripts/catalog/prepare-source-identity.mjs --run-id $n1Run --host 127.0.0.1
node scripts/catalog/run-source-identity-check.mjs --run-id $n1Run
```

后续N1C/N1B/N2、真实飞书/BS/JST、开放平台、正式关系、库存、调度和生产均未启用；不提交/推送/部署、不清场、不写记忆。飞书仍部分读取，未把fixture或冻结观测冒称正式接通。停止交独立审查。
