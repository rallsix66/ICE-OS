# 商品资料首包：本地隔离实施与执行自验

日期：2026-10-20。状态：**本地隔离实施、执行自验及文档收尾完成，待独立审查**。P0_01_PASS、P0_02_PASS、P0_03_PASS和P0-03文档收尾继续继承；本报告不登记新的阶段PASS，不代表生产启用或真实来源接通。

执行依据为[已批准合同](../../.local/product-library-discovery/contract-20261020T073206Z-7fdc7658/implementation-contract-v1.md)、[独立审查](../../.local/product-library-discovery/contract-review-20261020-596fb1c2/independent-review.md)及[实施指令](../../.local/product-library-discovery/contract-review-20261020-596fb1c2/next-execution-instruction.md)。证据总入口为[本轮交付目录](../../.local/catalog/run-20261020T081620Z-2a2cc8e4/)。

## 实现与数据边界

新增 `catalog` 资料模块、独立schema、自有DTO/严格字段状态、受控Repository/事务、私有证据和金额投影、列表/详情/历史及管理员入口。旧 `/dashboard/products`、Variant和Inventory消费者保持原语义；catalog不调用旧绑定/解绑或库存写入。SQL在新的隔离实例执行，没有向既有P0实例追加DDL，没有改00001—00052。

只承接唯一delivery-final-v2固定bundle/有效CSV和全部147份原始产物；129份JSON/CSV为另列的类型子集。原始bytes存私有证据，126个anchor只分配一次UUID，1417条BS/JST来源、548条具体选择及所有决定/纠错/价格历史按证据位置保存；3160条CSV只作历史索引，不重放旧操作、不重跑匹配或合并桌面CSV。

第122行 `ICE LERSKIN 烟酰胺提亮精华水150ml` 是126份内的原记录，初始显示“新品，待补货号”。首次补码、非价格修订沿用item UUID，旧revision保留当时缺码；金融指针与普通资料revision分离。测试货号/工厂只用于新隔离fixture，不回写固定基线或实际业务资料。WM0072采用5.18/5.68，来源216和两版价格历史保持，飞书5/5.5只作为受限观测。

飞书只导入已冻结v2和5份原始采集证据，实际仍为159格、27列表头、16个数据行位置的partial观测，7次复读另保留。稳定行ID、全表范围、真实账号权限、更新时间/游标未核实；不从partial未见推断删除/归零。JST/BS分别展示候选与原决定，无候选不冒充实际未建档。三种来源身份策略只有observe_only接口，没有长期来源注册表或可用正式关系。

启用管理员才能访问catalog。默认DTO、页面、一般观测、历史索引不含价格整行；金额显式请求、raw另经evidence与amount授权，服务端重新核验账号与SQL RLS。私有表没有app直读权限；runtime非owner/非superuser/非BYPASSRLS。所有新表FORCE RLS，历史不可改删，受控动作做CAS/请求幂等，同一次事务写资料和成功审计。提交回执未知时先核对同操作者、动作和意图；无法确定时保留原请求完整输入。

## 验证结果

最终整包运行号为 `run-20261020T084451Z-15fc329f`，checker当时的独立浏览器实例为 `run-20261020T084517Z-879924f7`，日志隔离补验的当前最终浏览器实例为 `run-20261020T085751Z-5a507792`。实际 `node scripts/catalog/prepare.mjs --run-id <主运行号>` 和 `node scripts/catalog/run-check.mjs --run-id <主运行号>` 均退出0；checker分别执行40项领域测试、11组真实PG测试和2项Playwright测试，隔离生产构建退出0。[总结果](../../.local/catalog/run-20261020T084451Z-15fc329f/evidence/check-2026-10-20T08-44-55-523Z-9781c4/result.json)、[原命令与退出码](../../.local/catalog/run-20261020T084451Z-15fc329f/evidence/check-2026-10-20T08-44-55-523Z-9781c4/)、[最终证据manifest](../../.local/catalog/run-20261020T081620Z-2a2cc8e4/evidence/final-infra-output-manifest.json)。

- [真实PG证据](../../.local/catalog/run-20261020T084451Z-15fc329f/evidence/postgres-2026-10-20T08-44-58-383Z-7d4c5c/)：147份完整文件逐字节、129份JSON/CSV子集分别核对；126个anchor→UUID；548条逐一原目标/JST引用/决定历史回查；6190条证据索引（1417当前candidate＋1421决定记录＋3160 CSV＋126主资料历史＋66全局历史）。0条unapplied空集合仍在原bytes内，不造记录补数量。
- 相同基线重导不重复创建或回退补码/资料/金融指针；首次码和普通修订的双连接CAS至多一成功；旧revision仍缺码。错pin、错误目标、缺artifact、JST引用/候选ID/哈希异常等在事务内整体回滚；真实COMMIT成功后注入回执丢失，Repository先按同请求/操作者/动作/意图回查，发布RPC只执行一次。
- 非owner、非superuser、非BYPASSRLS实际runtime，16张新表FORCE RLS；私有表直读、无身份/operator/停用拒绝；同一连接事务提交和回滚后身份不串。WM0072非价格修订前后金融指针及5.18/5.68保持，飞书5/5.5另存；缺失/未读/解析失败/明确0严格分开。跨账号同SKU、无市场/仓库的fixture观测可独立保存，测试事务回滚，不造Variant/CN占位。
- [浏览器最终断言](../../.local/catalog/run-20261020T085751Z-5a507792/evidence/browser-2026-10-20T08-57-55-042Z-af640d/browser-final-assertions.json)：实际登录、预览→发布→159格partial→122行新品同UUID补码/修订→旧缺码版本→重导保持→独立来源候选→WM0072受限金额及BS未建档冻结说明。拒绝页、真实Server Action、raw、导出、金额和撤权后请求均验证；无外部网络尝试，Next stderr为空。浏览器等待DOM/持久化状态，无固定延时冒充提交。当前补验另验证Playwright进程cwd位于全新workspace，早期Chromium警告不会再追加仓库原debug.log。日志定向参数曾被早期GPU警告忽略，保护门禁正确退出1，完整失败与恢复证据均保留；原93字节按开始哈希核验后逐字节恢复，最新补验前后哈希未变。
- [实际catalog schema dump](../../.local/catalog/run-20261020T084451Z-15fc329f/evidence/postgres-2026-10-20T08-44-58-383Z-7d4c5c/schema-after-catalog.sql) 与prepare的schema-before空检查分开；新实例先建立一组明确虚构旧public测试fixture，再取边界快照。catalog动作前后public.product/product_variant/inventory逐行不变，不把fixture bootstrap写成catalog改旧三表。

最终全仓ESLint `--max-warnings 0` 退出0，diff检查退出0。结束直接tsc发现新增PG测试环境的类型注解与Next声明不兼容，已仅修正为ProcessEnv类型断言；[修正前后编译JS逐字节相同证据](../../.local/catalog/run-20261020T081620Z-2a2cc8e4/evidence/test-environment-type-only.json)说明无运行行为变化，补跑lint及直接tsc：本包源码/测试均无诊断，仍有54条旧测试诊断。最终运行的完整源码manifest保留当时字节，当前输出manifest明确记录该类型注解差异，不伪称二者源字节相同。

[全仓普通回归原日志](../../.local/catalog/run-20261020T081620Z-2a2cc8e4/evidence/regression-broad.json)实际为4132通过、1失败；失败为既有 `src/features/database/opt6-production-apply.test.ts:43` 的00051迁移正文逐字节契约，与本包无关，原测试及SQL未修改。全仓直接 `tsc --noEmit --incremental false` 亦有旧测试诊断，新增catalog源码无诊断；隔离Next构建单独验证。初期catalog准备失败、Windows预加载路径失败、浏览器字段标签定位/刷新断言时序失败、源码变化守卫拒绝均留存，见[全部运行台账](../../.local/catalog/run-20261020T081620Z-2a2cc8e4/evidence/infra-run-ledger-log-closure.json)，不与最终成功混写。本轮自建测试实例均已停止，数据和失败现场保留，旧P0实例不在停止范围。

没有使用旧P0的历史PASS替代新增PG/RLS验收，也未重开P0-03验收。原始图片内容没有因保存引用而被宣布已核验。manager不是冻结旧角色表允许的可持久化角色，因此没有伪造manager真实登录；实际非管理员operator、匿名、停用及SQL拒绝按本包证据验证，旧admin权限入口保持严格拒绝其他角色。

## 桌面与收尾

[桌面清理报告](../../.local/desktop-cleanup/run-20261020T081620Z-2a2cc8e4/cleanup-report.md)：实际桌面路径由系统接口和注册表核实，33份相关文件逐一记大小、SHA256、用途和引用。原始资料、决定历史、审计证据及用途不明原型全部原地保留；归档0份，恢复映射为空，没有永久删除或扩大到其他项目。

按AGENTS执行neat-freak，仅对齐本报告、current-state、current-task和AGENTS入口；不写记忆，不删除本地实例、失败证据、原始资料、HOLD或用户dirty成果。开始/结束保护清单、源文件manifest和未授权修改检查见[交付索引](../../.local/catalog/run-20261020T081620Z-2a2cc8e4/delivery-index.md)。

## 可复现入口与停止点

使用全新运行号：`npm run catalog:prepare -- --run-id run-YYYYMMDDTHHMMSSZ-8hex`，再执行 `npm run check:catalog -- --run-id <同运行号>`。prepare拒绝缺号、旧号、非空实例目标、非loopback、继承外部连接及链接路径；check要求新实例空基线，PG阶段与浏览器阶段使用不同新实例，保留各自不可变测试历史。命令不默认旧P0运行号，不使用真实供应商账号或飞书在线采集。

尚未实施：正式关系启用/确认/改绑/撤销/停用、长期身份注册、换表执行、真实来源采集/调度、正式商品物化、库存、估值/运费分摊与生产发布。实际新品ICE货号未知只限制真实补码，不阻塞资料承接。下一步为用户另一会话独立审查；不得自行提交、推送、合并、部署或宣称独立验收通过。
