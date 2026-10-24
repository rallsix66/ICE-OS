<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know
Read the relevant guide in `node_modules/next/dist/docs/` before writing Next.js code; this version may differ from training data.
<!-- END:nextjs-agent-rules -->

# ICEOS / ICE v4 项目指令

## 入口与状态

- 先读 `docs/current-state.md` 和 `docs/tasks/current-task.md`，真实代码优先于旧文档。
- 当前包：**商品库 v6 四项定向补修包 — `V6_FOUR_ITEMS_LOCAL_PASS`（独立复审通过 2026-10-24）**。用户在前序 v5 独审后收窄为四项，均已完成独立复审：V6-01 来源缓存版本/迟到响应/身份权限隔离；V6-02 来源采用状态与库存说明；V6-03 逐条来源价格缺失文案；V6-04 读取失败/无权限/真实空记录区分。**不重开**旧 v6 性能门禁/15×20、原 v4 全量后端、准备链、保存回执六态、真实来源摄取、后续匹配规则；延期项保留原记录，不是通过。**通过范围仅限这四项**；不代表原 v4/v5 全量验收、全商品库或全 ICEOS 全面通过，也不是真实多账户/撤权/数据库权限矩阵或性能验收；v5 历史 `UI_REVIEW_NEEDS_FIX`、`U3_LOCAL_UX_PERF_PASS`、`LOCAL_PREVIEW_PASS` 保持原范围。现役 126 商品与 BS 530 行只读。已实施：撤销 v5 新增的共享来源结果缓存，库存空态提示与数据来源子视图每次重新走服务端鉴权，详情缓存/切仓/迟到响应保护保留（V6-01）；来源“本批已采用对应”与“库存已计入”分开，BS 以已确认 BS 样表库存行为准、JST 不声称计入国内库存，已采用记录不再显示早期筛查结论，未采用记录提示默认收起（V6-02）；WM0072 当前采用价保留、逐条来源价格说明改为“暂未展示”（V6-03）；来源数量仅成功空集合显示 0，失败/无权限显示“—”，价格单独失败/无权限保留来源记录并可重试，历史重试不切当前（V6-04）；顺手去两处 request UUID。执行方主套件 22/22（0 skipped/flaky，104.7s）、单测 547/548（唯一既有 opt6 00051）、catalog tsc 0（全仓仅既有 BEST 5）、全仓 lint 0 error/14 条既有 warning、build 成功仅由独审核查原始材料，不是独立全部重跑；独立实际页面走查 WM0043/WM0072 正常流程、独立重跑 33 项受控浏览器检查 + 6 项边界补验、定向纯测试与组件接线通过、本包 6 个受影响文件 eslint `--max-warnings 0` exit 0。**未覆盖**：失败/无权限/价格失败/真实空为受控响应，不是真实数据库权限/ACL/换号验收；真实 200% 缩放未做；延期项不写成通过。独立报告 `.local/catalog/independent-ui-frontend-v6-20261024/independent-review.md`；仓库摘要 [catalog-ui-v6-closeout.md](docs/catalog/catalog-ui-v6-closeout.md)；Git 收尾凭证 `.local/catalog/ui-v6-closeout-20261024/closeout-record.md`（本地证据不入库）。
- 上一个包（v5）：**商品库前端展示与交互收尾包 v5 — `UI_REVIEW_NEEDS_FIX`（独立复审 2026-10-24）**。独立报告 `.local/catalog/independent-ui-frontend-v5-20261024/independent-review.md`；用户已明确把此前 v4 范围收窄为前端展示与交互；本包只做 V5-01～V5-05，**不重开** v4 全量后端、准备链或性能平台，也不把 v4 独审未通过项自动纳入。**不是 UI PASS**，未 commit/push/merge/deploy，现役 126 商品与 BS 530 行只读。已实施：来源“本批未采用”与已采用分组、每条记录自己的仓库/真实状态、未计入库存说明与库存空态来源提示（V5-01）；详情改读完整库存行后再按仓展示、列表/详情同仓同状态、删除“仓库投影/正在同步列表”、无 confirmed 行不再当 0、切仓目标内容/滚动/快速选择稳定（V5-02）；来源系统/编码/名称/仓库、已有核对提示、当前采用价与逐条来源价格出处、失败/无权限/缺值分开（V5-03）；历史当前参照真正显示记录、返回恢复 current 身份/分区/滚动/焦点、直接历史仍只读（V5-04）；账户/维护/旧 evidence 去技术内容、按货号名称选择商品、旧来源地址进入统一弹窗、intake/sources/商品弹窗统一安全返回（V5-05）。执行方自验：最终 BUILD **`FuW0YdgLlttyIps2oMXSI`** @ 3011（pid 74664，快照 `aff4a313…`，ownershipVerified=true，login 200）；主浏览器套件 **22/22（0 skipped/flaky，1.7m，exit 0）**、v5 定向浏览器探针 **37/37**、单测 **546/547**（唯一既有 opt6 00051）、catalog tsc 0（全仓仅既有 BEST 5）、改动文件 eslint 0/0、`git diff --check` 0。**未完成/未覆盖**：来源全空态与“读商品有权限、读来源/价格无权限”无现役自然样本（仅投影单测）；真实 200% 缩放未覆盖；原 v4 后端/准备链/性能平台按用户范围延期，未写成通过。证据 `.local/catalog/ui-frontend-v5-20261024/`（delivery-summary / repair-matrix / evidence-index / screenshots-index）。
- 上一个包（v4）：**商品库 UI 集中补修包 v4 — `UI_REVIEW_NEEDS_FIX`（独立复审 2026-10-24）**；独立报告 `.local/catalog/independent-ui-repair-v4-20261024/independent-review.md` 未通过内容完成门禁/性能/历史来源返回/全入口技术内容等；按用户 v4 包处理 V4-01～V4-09；**不是 UI PASS**，未 commit/push/merge/deploy，现役 126 商品与 BS 530 行只读。已实施：仓库切换固定顺序/选中不改变按钮宽度/不强制回顶（V4-01）；“数据来源”业务视图替代 JSON/UUID/内部键名/技术下载，来源记录显示自己的仓库与真实对应状态，历史事实与当前参照分离（V4-02）；历史不比较当前仓投影、失败重试真正重发目标 revision、跨版本来源返回原版本/分区/滚动，五视口首屏露出库存明细（V4-03）；原请求核对只认真实回执与完整意图，基线核 `audit_event` intent、scoped 核 `catalog.new_item_request`（V4-04）；全仓派生核完整全仓与目标仓投影（V4-05）；返回路径规范化白名单、启用态链接带 from、不以 UUID 为主文（V4-06）；准备链 recordOnly/manifest 命中均核 DB（V4-09 部分）。执行方自验：最终 BUILD **`Dwnb0Go61UvC1sHZx4Uev`** @ 3011（pid 35400，快照 `57f2c5b2…`，ownershipVerified=true，login 200）；浏览器主套件 **22/22（0 skipped/flaky，1.7m）**、单测 **536/537**（唯一既有 opt6 00051）、V4-04 定向 50/50、V4-05 13/13、V4-06 18/18、五视口首屏均有库存行、WM0072 历史/跨版本来源返回与 issues/旧直链/穿越 from 实测、catalog tsc 0、eslint 0/0、diff check 0。**未完成/未通过**：V4-07 v6 内容完成门禁与真实应用负向未完成；V4-08 无最终 15×20 性能矩阵（旧 v5 数字不能写成通过）；V4-04 隔离 DB 六态、V4-05 隔离缓存反例、V4-09 真实隔离库四态/最终回归未跑；200% 真实缩放 pending；保护指纹未覆盖完整测试时窗。证据 `.local/catalog/ui-repair-v4-20261024/`（delivery-summary / repair-matrix / evidence-index / screenshots-index）。
- 上一个包（v3）：**商品库 UI 集中补修包 v3 — `UI_IMPLEMENTED_AWAITING_INDEPENDENT_REVIEW`（2026-10-24）**，按 `.local/catalog/independent-ui-repair-v2-20261024/execution-repair-package-v3.md` 实施 V3-01～V3-08，并处理同目录 v2 独审 `independent-review.md` / `user-feedback-addendum-20261024.md` / `code-review` / `contract-review` / `perf-review` 未通过项；**不是 UI PASS**，未 commit/push/merge/deploy，现役 126 样本与 BS 530 行只读。最终 BUILD **`8qFEEnYTJ60Jgk7E_ZiNZ`**（3011，pid 21036，promote 快照 `603dc16e7257bb0a…`；staging build→校验→promote→start→归属核验）。执行方自验：统一弹窗/历史内联/授权证据子视图（浏览器主套件 **22/22，0 flaky**；v3 UI 采集 **117 checks / 0 failed / 5 uncovered / 70 shots**，5 视口外框与分区矩形实测一致，from 链与旧直链往返通过）；oracle v5 合成校准 **26/26**（8 正例+18 反例）、merge 自检 20/20、期望 crossChecked=true；性能 15 场景×20 样本见 `.local/catalog/ui-repair-v3-20261024/oracle/runs/`（阈值未下调；超阈桶原样交回）；单测 513/514（唯一失败为既有 `opt6-production-apply` 00051 换行基线）、tsc 全仓 5 条历史 BEST（商品库 0）、eslint 0/0、`git diff --check` 0。修复矩阵 `.local/catalog/ui-repair-v3-20261024/repair-matrix.md`、摘要 `delivery-summary.md`、证据 `evidence-index.md`、截图 `screenshots-index.md`。**待独立复审裁定/未覆盖**：性能 13/15 桶达标；`warmPagination` p95 114.4ms、`warmListRefresh` p95 472.4ms（等待本次 RSC 刷新响应）超 100ms（真实值，未豁免；merge integrity 另含 unit-cost diag/scroll preSatisfied 工具待收敛项）；现役商品全 r1 导致历史版本切换 5 视口未覆盖（多版本在隔离 fixture）；真实 200% 浏览器缩放 pending；v5 真实应用负向脚本未新增（15 类由合成校准覆盖，v4 16/16 为历史证据）；隔离 fixture 最终行为矩阵与 V3-08 统一链结果见 `.local/.../fixture/`；两个 scripts 准备链缺口如实未修（包外/需授权）。v3 取代 v2 的「新标签收进更多 / 商品跳维护页看来源 / 独立详情页」三项安排；其余未受影响边界继续有效。
- 上一个包：**商品库 UI 集中补修包 v2 — `UI_REVIEW_NEEDS_FIX`（独立复审 2026-10-24）**，按 `.local/catalog/independent-ui-review-20261023/execution-repair-package-v2.md` 实施 U1–U8 并处理同目录 `independent-review.md` 的 R1–R10；**不是 UI PASS**，未 commit/push/merge/deploy，现役样本未被写入。执行方自验：UI 采集 76/76、oracle v4 校准 27/27、真实负向 16/16、浏览器主套件 22/22（0 flaky）、隔离 fixture R4 16/16×2 / R6 13/13+14/14 / R7 7/7+5/5+2/2 / R9 8/8+2/2、`tsc --incremental false` 全仓 5 条历史基线（商品库 0）、eslint 0/0、单测 457/458（唯一失败为既有 `opt6-production-apply` 00051 换行豁免）、`git diff --check` 0；预览经 staging build→校验→promote→start，当前 BUILD **`7Qzv7GAew213N3WufdT_z`**（3011，pid 72784，`ownershipVerified=true`，源码快照 `3a1d5395…` 与 promote 一致）。**待独立复审裁定**：`detailWarehouseSwitchRealClick` p95 113.0ms 超 100ms 暖口径（阈值未下调，合并门禁 `allRequired=false` 原样保留）；维护页“非基线新品候选审计读取失败”待确认项（根因未定位）；new-item 3/4、source-identity 4/5 未在最终 BUILD 复跑；R7“无事项”未覆盖。修复矩阵 `.local/catalog/ui-repair-v2-20261023/repair-matrix.md`，逐项结果 `u1-u8-r1-r10-results.md`，证据 `evidence-index.md`。
- 上一个包：**商品库 U3 — `U3_LOCAL_UX_PERF_PASS`（独立复审通过 2026-10-23）**。通过范围仅限本地样表商品库的交互、缓存恢复、性能测量与验收门禁；**不代表**新 UI 打磨完成、真实来源接入、生产发布或全 ICEOS 验收，既有 **`LOCAL_PREVIEW_PASS`** 保持原范围。独立复审 `.local/catalog/independent-ux-perf-u3-final-20261023/independent-review.md` 关闭三项：**R1** 冷启动门禁改以 `listSample/detailSample.contentReadyMs` 为唯一输入（摘要须等于 `Math.round(原始值)`，缺失/NaN/Infinity/矛盾即拒绝；执行方合并负向 51/51，独立另跑 26 项边界），新验证器 `f8dcd797…` 复核 `runs/progress8-final5` 原始证据得 `allRequired=true`（原始暖 `cab3706e…`/冷 `d8cd3cfc…`/fixture `2ae987d1…` 未改写，旧验证器 `ed717297…` 单独留存；`sourceOverrides` 仅复核入口可用，正常测量仍按磁盘校验）；**R2** runner 校验 `completed===126`、`completed↔itemCount`、`readOnlyEvidence.transactionReadOnly==='on'`（真实 spawn 11/11，另 6 项独立边界）；**R3** 全仓 tsc 总诊断 **21→5**，当前商品库 **16→0**，历史 BEST 测试 5 条按范围保留（不声称全仓 tsc 通过；`next build` 过滤 `*.test.*`，不能替代）。3011 BUILD **`Jq2Y6jz_l7sFTKfSUPYkF`** @ `run-20261021T100700Z-b3c4d5e6`（现已由本包 staging build→promote 替换为 `GaK8dG26vW574fhA5gEBy`）；执行自验 `runs/progress9-verify-20261023-final/selfverify-steps.json` 8/8 exit 0；126×252 **0 差异**继承 attempt `progress5-20261022-180727`，未重跑；暖 15×20 / 冷 3 轮沿用 progress8-final5 原始结果，只复算不重采样。摘要 `.local/catalog/ux-perf-u3-20261022/progress9-delivery-summary.md`；证据 `.local/catalog/ux-perf-u3-20261022/evidence-index.md`。旧经营模块完整源码外置 `D:/try one/ICEOS-legacy-archive/20261022/`，仓库 `archive/legacy-business-20261022/` 仅清单、指针与恢复说明。013/014 增量 DDL 不重改 00001–00052。
- 当前目标：`docs/architecture-v3.md`；历史模型：`docs/history-data-model-v1.md`；基础业务实体：`docs/database-design-v2.md`；来源规则：`docs/data-flow-v2.md`。
- 产品范围以 `docs/product-plan-v4.md` 的 V5 选择性吸收为准，不将整份 V5 附件直接替换现役方案或扩展本期页面。
- 已批准脱离 Supabase、保存历史、暂不开发复杂分析页面。P0-01 与 P0-02 本地独立平台验收均已独立审查通过（**P0_01_PASS** / **P0_02_PASS**）；生产启用、真实来源与旧环境删除仍属后续，不要把设计写成全面生产迁移或 Supabase 已删除。
- 本入口替代用户已撤销的旧规则；不固定开发者角色，也不要求特定实施触发词。按用户本次请求区分讨论、审查、实施与发布。

## 架构与数据边界

- 目标为标准 PostgreSQL + 自有服务端；推荐复用 Next.js、Repository、Zod、Feature Module，不推倒重写，不默认在 Supabase 上扩建新模型。
- 迁移需替换 Auth/SDK/PostgREST/RPC传输及后台 service-role 路径；只换连接地址或自托管整套 Supabase 不算脱离。
- 保留 UUID、人工 ICE 货号、Product → ProductVariant → Inventory；外部 SKU 按来源/账号/市场/仓库映射，69编码保存字符串。
- 商品身份规则唯一正文为 `docs/product-identity-standard-v1.md`；区分已批准规则、样表已验证事实与待实现机制，不将本批检查写成数据库约束或长期绑定已实现。
- BigSeller 决定海外数量，聚水潭决定国内数量，飞书决定货票业务状态，API只增强轨迹。到货不加海外库存，发货不二次扣国内库存。
- 旧 inventory.quantity 仍为可售量，不冒充实物量；缺失/失败不转零，缺成本不是0，来源异步且证据不足不合计库存与在途。
- 本期估算货值不含运费、不做费用分摊；单位成本也须明确不含运费，含运费或未知口径成本未澄清前不得参与估值。详细口径见产品方案。
- 历史事实不可变，修订追加版本；保存业务与系统时间、当时映射/资料/成本版本。当前投影和日统计可重算，不成为新的事实源。
- 日统计带日历、截止时间、覆盖率、质量和计算版本；余额不跨日期相加，库存差不当销量，没有来源不补造历史。
- 新业务公共契约使用自有 DTO，不导出供应商 Session/Database Row；客户端不直连数据库、不持有数据库或高权限凭据。
- 权限由服务端认证、启用检查、动作/范围授权及 PostgreSQL RLS共同保障；金额另行保护查询、导出、缓存与日志。
- 数据库运行身份非表owner/非superuser/非BYPASSRLS；事务局部身份仅由验证后的服务端设置，连接池隔离必须验收。
- Demo保持虚构数据隔离，不接真实服务/密钥；演示角色切换不是生产权限验收。
- P0-03 本批仅整理主库并保存样表人工核对；使用显式人工 CSV 和冻结哈希，仓别约束仅限本批。后续持续绑定、自动复用和使用方案未定；不得输出正式绑定资格或执行库存发布/同步。现役任务见 `docs/tasks/current-task.md`。

## 高风险操作与兼容

- 不修改00001–00052历史Migration；目标平台使用审定的新基线及增量脚本，保留UUID和旧语义的兼容核对。
- 真实环境访问、账号/数据迁移、生产切换、删除旧数据/环境、合并和发布须有对应授权。迁移方向获批不等于允许立即切生产。
- 切换前停旧写入、备份并恢复演练、核对水位与权限；生产只保留一个写入方。新系统开放写入后的回退必须对账增量。
- 保留用户未提交修改；只暂存当前任务文件，不顺手清理无关报告、凭据、依赖或代码。

## 文档收尾（neat-freak）

- 本批功能交付前，须读取并执行 `C:\Users\Administrator\.agents\skills\neat-freak\SKILL.md`（或触发词「洁癖」/ `/neat`），对齐 `docs/current-state.md`、`docs/tasks/current-task.md`、验证报告与 AGENTS.md，区分**已实现 / 已验证 / 待确认 / 既有失败**。
- 不借此扩大代码修改、删除用户文件或写入未授权记忆；清场须用户确认后再执行。

## 验证

- 开发：`npm run dev`；Demo：`/demo/ice-v4`（虚构数据隔离，**不**依赖 Supabase 真实凭据）。
- 单元：`npm run test`；Windows等价命令：`node node_modules/vitest/vitest.mjs run --exclude '**/concurrency.test.ts' --exclude '**/*.postgres.test.ts' --exclude '**/*.live.test.ts'`。
- 代码改动按风险运行 `npm run lint -- --max-warnings 0`、`npm run build` 与 `git diff --check`；只改文档可做链接/一致性/diff检查，明确没有重跑功能测试。
- 数据库/权限/历史实现另验RLS、并发、幂等、乱序、部分失败、补数、修订、金额拒绝与恢复；live/真实同步测试需具体环境授权。
- 报告区分已实现、已验证、待确认；推送不等于合并、CI通过或生产上线。
