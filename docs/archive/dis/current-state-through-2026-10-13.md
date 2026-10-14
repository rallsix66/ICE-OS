> 历史归档（2026-10-13）：原位置 `docs/current-state.md`。保留用于旧实现与验收追溯，不作为当前任务或执行授权；现役入口见 [归档索引](README.md)。

# Current Project State

## ICE-V5-SELECTIVE-ADOPTION：V5 选择性吸收（2026-10-13）

- 用户确认运费先不计入，并授权把 V5 中适合的内容吸收到现有方案；未授权整份替换、运行代码改造、提交推送或部署。
- [产品方案](../../product-plan-v4.md) 已合并三种业务视角、业务中心与现有入口的职责关系、四层后续分析方向及明确取舍；既有首页与市场物流设计不变。继续完全脱离 Supabase，复杂分析/智能化保持后续范围。
- 估值明确采用不含运费的商品成本，不做费用分摊；含运费或口径不明的综合成本须先澄清。正式成本来源、含税、币种等仍待确认。
- [历史模型](../../history-data-model-v1.md) 补充只读变化解释合同：可比快照差、业务证据和未知原因分开，物流状态历史复用货票修订；不新增第二库存事实源或提前建空流水表。
- 状态为 DESIGN DOCUMENTED：仅修改 Markdown 文档及必要规则入口（AGENTS.md、CLAUDE.md）；现役代码仍依赖 Supabase，历史查询与新平台均未实现。保留既有未提交报告和其他工作。
- 验证限于文档链接、口径一致性、diff、运行文件未改和保护报告哈希；未重跑功能测试，不引用旧 Demo 测试证明新设计已实现。完成后等待独立实施任务授权。

下方保留此前架构与交付记录；当前产品口径以本节链接为准。

## ICE-V4-ARCH-EXIT-HISTORY：独立平台与历史模型设计（2026-10-13）

- 用户已明确批准方向：脱离 Supabase；在 ICE v4 中增加历史能力，为库存/市场趋势与经营分析保留数据模型，暂不做复杂分析页面。项目仅由 DIS 改名为 ICEOS；仓库远端仍为 overseas-inventory，本地基线 HEAD 为 `0749343`。
- 新目标入口：[architecture-v3.md](../../architecture-v3.md)、[history-data-model-v1.md](../../history-data-model-v1.md)、[ADR-ICE-002](../../adr/ADR-ICE-002-independent-postgres-history.md)。平台方向取代 v2 的继续默认依赖 Supabase，保留原商品/Variant、四源权威和数量语义。
- 本轮是文档设计：定义独立数据库/认证/Repository/worker 边界，以及不可变快照、维度/货票/成本版本、日统计和补数重算合同。具体认证组件、数据库版本/部署位置、历史保留期与日界线仍待实施前确认。
- 真实实现没有改变：`src/lib/auth.ts`、登录页、Repository 和 Python 同步仍依赖 Supabase；新历史实体、统计任务、独立认证/数据库适配器均未实现，未执行 Migration、账号迁移或生产切换。
- 下一实施建议先验证独立 PostgreSQL + 会话/权限 + 受限查询，再开发带历史写入的商品/单仓闭环；不再默认先在 Supabase 扩建新模型。执行范围以新的单次任务批准为准。
- 本次仅做文档一致性、相对链接和 diff 检查，不重跑运行测试；下方 109/109 等是前次 Demo 证据，不是新平台/历史功能通过证明。本次不提交/推送、合并、部署或修改外部环境。
- 用户已撤销旧 AGENTS 指令；根规则同步为简明架构入口，不恢复旧固定主开发者/实施触发词限制。既有未提交内网部署报告保持原样。

以下是历史交付记录，其中旧“继续保留 Supabase”的目标表述已被本节取代，但仍准确描述当前尚未迁移的运行代码。

## ICE-V4-HOME-COPY：参考首页移植完成（2026-10-13）

- 用户明确要求直接copy提供的HTML首页，取代此前自行重排的方向。新增 `reference-home.tsx`，保留原home()区域结构和页签；原HTML样式复制到 `reference-home.module.css`，选择器限定在首页根节点，不影响其他页面。
- 保留顶部指标、绿色货值横幅、三阶段、来源提示、市场占比、待处理、商品库存/近期货物流转/预计到货三个页签；不复制首页日志和最近操作区。事件接回当前Demo，不执行原HTML脚本、不复制原商品数据。
- 现有计算口径保持：横幅明确为海外库存已知货值，不照搬未经核对的三阶段总额；无金额权限不显示金额。
- 本地109/109演示测试、lint、Next build/内置TypeScript通过；默认全量4121/4122，仅既有00051换行契约失败。浏览器验证三个页签分别6/7/4条、金额隐藏、390px无页面横向溢出；已直接查看移植后的画面。
- 其他页面/数据模型/数据库/依赖未改。3000原开发服务在验收时不可用，使用临时3104正式构建预览；未终止或修改其他服务。实际Git交付以分支记录为准。

下方为此前反馈与历史验收，首页视觉以本节为准。

## ICE-V4-DEMO-FEEDBACK-01：反馈修改完成（2026-10-13）

- 基于 `509dae9`，按用户参考HTML和本轮反馈修改同一独立Demo；仍推送 `codex/ice-v4-planning`，不合并master、不主动部署。
- 八个入口：新增数据同步与权限设置；首页增加库存数量/商品概览；商品资料卡片改为表格和独立映射分区；物流按市场/状态/关键词集中列表、并列飞书与最新API节点，详情关闭保留筛选。
- 设置均为本地模拟：来源配置/检查不连接外部系统或更新库存；权限市场/金额/映射按钮联动演示数据，空范围不开放全量。不是生产RLS或源接入。
- 验证：107/107演示测试；全仓lint零警告；Next build和内置TypeScript通过；默认全量4119/4120，仅保留旧00051换行契约失败。市场物流、权限保存/切换/空范围、来源模拟不改旧快照、商品资料表、手机布局已浏览器验证。
- [本轮验收](../../reports/2026-10-13-ice-v4-feedback.md)；[当前任务](task-packets-through-2026-10-13.md)。既有内网部署报告保持原样；现役业务、Migration、依赖和生产配置无改动。

下方为首版交付与更早历史，不能用其旧测试数量/六视图说明覆盖本轮状态。

## ICE-V4-PLANNING-DEMO：本地交付完成，待产品评审（2026-10-13）

用户已授权本次由 Codex 实施：现有系统分析、ICE v4 产品/架构/模型/数据流设计、规则增量更新、六视图隔离 Demo、本地验证，以及独立分支提交/推送。不是生产改造授权。

- 基线：`44d0b13`，远端 `origin/master` 在开始时同SHA；本次分支 `codex/ice-v4-planning`。
- 真实现状：[current-analysis.md](../../current-analysis.md)。新设计入口：[product-plan-v4.md](../../product-plan-v4.md)、[architecture-v2.md](../../architecture-v2.md)、[database-design-v2.md](../../database-design-v2.md)、[data-flow-v2.md](../../data-flow-v2.md)。
- 状态：分析、五份设计文档、ADR、规则入口和六视图隔离 Demo 已完成。新增81/81测试、全仓lint零警告、Next构建及其TypeScript检查通过；桌面/390px浏览器及本地正式构建预览通过。默认全量4093/4094，仍有改动前已复现的00051换行契约失败；直接全仓tsc还有未修改历史测试的类型诊断，不能称全部质量门全绿。详见 [本次验收记录](../../reports/2026-10-13-ice-v4-validation.md)。
- Demo：`npm run dev` 后访问 `/demo/ice-v4`；全部虚构数据，三角色仅展示模拟，不是真实RLS验收。Git交付使用独立分支，远端SHA以Git核对和最终交接为准，不宣称已合并/CI通过/上线。
- 保护：保留 Product→ProductVariant、现役业务/认证/RLS、Supabase与52个历史 SQL Migration。不连接外部账号、不迁移、不写Staging/Production、不执行OPT-6 Batch 4、不合并master/主动生产部署。
- 未决：真实公司货号资料、69编码规则、聚水潭与飞书字段/授权、物流账号键、成本口径、三角色金额权限。仅虚构Demo可先行，不得据此接入真实数据。
- 原有未提交 `docs/reports/2026-07-18-内网部署可行性评估报告.md` 保留，不纳入本次提交。

单次范围见 [current-task.md](task-packets-through-2026-10-13.md)。以下全部为旧系统历史记录，不是本次实施授权或当前远端验证。

## Historical closeout: 00052 / OPT-6

The corrected 00052 Staging SELECT-only revalidation returned one row with all history, full statements[] payload, public.product policy, and active-sync hard-stop gates passing. Version/name digests matched at 2d6174dce487614c3280456fff9169d0; full-payload digests matched at 8ec295c38bc90f769dc35ca5fd64a500; in_progress_sync_runs=0. No write, Migration, or apply packet ran during that Staging read-only stage. The designated independent reviewer returned PASS for this read-only stage at head a2e319eeb587474b71e66888bdbccbc27f38813c, CI 30266046505, and Vercel 7Py8GVBM1NhfendWozqvRwvLCT2G. Production 00052 apply/postcheck completed once and passed; final evidence review then returned PASS at HEAD e92b8720dbc2be29dc371e5de61c6e70d88beeec. PR #11 is merged as f8f467f7fc649dd37d584864e2c79505fd53719e, master CI 30330308092 passed both jobs, and Vercel production deployment 6EDexdjVENq4CDJgPW7RdSwztT3h completed successfully. Current gate: wait for the user's next instruction; no further Production write, old Migration replay, or Batch 4 is allowed.

> Current gate (2026-07-22 Batch 3): Batch 2 Staging/Production `00051`
> apply/postcheck remains closed with its historical independent `PASS` at
> `96c87461afd444b2065059c98ba0cf08522b749e` / CI `29908869113` / Vercel
> `87HAB8w8rTZhDtJAZCvt2kmaRM31`. The active Batch 3 `00052` implementation
> exact head is `23d92d3e7ed43013e5dbbe0a828a166a05245cfc`, with CI
> `30230526963` and Vercel Preview `5F5tvSTDP7A14aCaD217Pxh2yFh3` both green
> and exact-head matched. The earlier `ce7e623ff396f099c3bf9256733973ce158beb9e`
> / `29913122480` / `EeNmUmEaEajq3MnRVe7V3RCTfGph` values are historical
> implementation-checkpoint evidence only. Its first independent review found
> only stale PR/documentation bindings; those have been corrected and the
> implementation review `PASS` is recorded, with no Staging/Production
> write authorized.
> The packet now compares all reviewed 00001–00050 version/name rows and full
> statements[] payload summaries through explicit equality booleans; its static
> read-only contract is indexed from the Production preflight evidence.
> Remote Production exact preflight executed read-only on 2026-07-22 and passed
> all history, full-payload, role-catalog, and active-run gates; see the
> [Production preflight evidence](../../reports/evidence/2026-07-21-opt6-00051-production-preflight.md).
> The separately reviewed Production apply packet was executed in the approved
> 2026-07-22 maintenance window and its SELECT-only postcheck passed: exact
> 00001–00051 history, canonical 00051 payload, four reviewed role policies,
> and zero active sync runs. See [apply/postcheck evidence](../../reports/evidence/2026-07-22-opt6-00051-production-apply.md).
> Batch 3 implementation review has returned PASS. The approved 00052 Staging
> SELECT-only packet was attempted once on 2026-07-27 and stopped with PostgreSQL
> 42P01 (role_check CTE missing) before any result; no Staging/Production write,
> Migration, or apply packet ran. The corrected packet was independently
> re-approved and retried once; its full payload gate was false because the
> expected CTE used the Production variant for known Staging rows 00041-00047.
> A separate SELECT-only comparison matched the recorded Staging postcheck, so
> the packet was corrected to the approved Staging baseline. Its expected payload
> digest is now 8ec295c38bc90f769dc35ca5fd64a500. No write ran; the corrected
> SELECT-only revalidation completed with every hard-stop gate true. Its result
> was accepted by the final independent evidence review at HEAD `e92b8720dbc2be29dc371e5de61c6e70d88beeec`. PR #11 was merged as
> `f8f467f7fc649dd37d584864e2c79505fd53719e`; master CI `30330308092` and
> Vercel production deployment `6EDexdjVENq4CDJgPW7RdSwztT3h` are green. See the [00052 preflight report](../../reports/2026-07-27-opt6-00052-staging-preflight.md) and
> [evidence](../../reports/evidence/2026-07-27-opt6-00052-staging-preflight.md).
> Production 00052 SELECT-only preflight was executed exactly once on 2026-07-28 after implementation-review PASS. All history, full-payload, public.product, and active-sync gates returned true; actual/expected full-payload digest was 0b7cba5a88fff139fb0ec65e4deaa142 and version/name digest was 2d6174dce487614c3280456fff9169d0. The product policy digest was 119e5878b2ddd6d3f7c1c01e614c4112 and in_progress_sync_runs=0. No write, Migration, or apply packet ran. The designated independent reviewer returned PASS at head `7f83f01c847d685e865d2c4c7c4d8012267ed085`, CI `30276563343`, and Vercel `4QSHNyh9PDfbnpWMrMeiadV2YBts`. The prepared Production 00052 apply packet received independent FINAL PASS at head c8b679ecbfc00ca7d414a40d8f2a10f1228259a5, CI 30322612198, and Vercel 9cLc8DEK6mH35UdeoFen2i2yr76b. It was then executed once in the controlled Production window and its independent postcheck passed: 52 history rows, exact old-history digests, canonical 00052 payload, four product policies, and zero active sync runs. The execution/postcheck evidence received final independent PASS at HEAD `e92b8720dbc2be29dc371e5de61c6e70d88beeec`; PR #11 is merged and the production deployment completed. Batch 4 remains separately gated.


> 2026-07-21 OPT-6 Batch 2: Batch 1's remote-final-PASS evidence was merged
> as `2510b0e070b7fe637239cf0a8eecc3e63aec9570`. Batch 2 has a narrow 00051
> role-policy-overlap candidate, complete local replay/identity/guard evidence,
> and designated independent `FINAL PASS` for head
> `3885651309ac37f2bf5dd48ce905dfdfe6da8886`. Exact-head CI `29798631677`
> and the Vercel Preview are green. The reviewed 00051 packet has now been
> applied to Staging and Production; both read-only postchecks passed. The
> controlled preflights had passed before each write:
> exact `00001`–`00050`, no `00051`, and the full two-policy `public.role`
> baseline all match. See the [Batch 2 report](../../reports/2026-07-21-opt6-quality-governance-batch-2.md), [Staging evidence](../../reports/evidence/2026-07-21-opt6-00051-staging-preflight.md), [Production evidence](../../reports/evidence/2026-07-22-opt6-00051-production-apply.md), [inventory evidence](../../reports/evidence/2026-07-21-opt6-batch2-policy-inventory.md), and [current task packet](task-packets-through-2026-10-13.md).

> 2026-07-20 System optimization：OPT-1–OPT-5 均已通过指定会话终审并合并。OPT-6 Batch 1 代码与远端阶段也均获指定会话 `FINAL PASS`：PR #9 已合并为 `d9acf51e0cfbfd2e21f243f41273de7278f4e80a`，master CI `29733960202` 与 Vercel production deployment `BKDzcK4k9noxQgzAboJB6h2XjmeF` 全绿；受控 00050 已按 Staging → Production 顺序完成，两环境均为精确 `00001`–`00050`，正文摘要和六条完整 policy catalog 命中审定基线。远端终审绑定 head `1fbc6b042caf289698d60d2697a909787002968d`、CI `29739720283`、Vercel Preview `obXa1wmkxzMorYz9k8AmpkhBSZmG`，结论为 `OPT-6 BATCH 1 REMOTE FINAL PASS`。当前只待合并文档 PR #10；合并后方可建立 Batch 2 任务包。115 条 multiple-permissive-policy 与索引治理继续留在后续批次。详见 [OPT-6 Batch 1 报告](../../reports/2026-07-20-opt6-quality-governance-batch-1.md)、[远端 postcheck 证据](../../reports/evidence/2026-07-20-opt6-00050-remote-postcheck.md)、[OPT-6 当前任务包](task-packets-through-2026-10-13.md) 与 [系统优化路线图](../../tasks/system-optimization-roadmap-2026-07-17.md)。

> 2026-07-17 Preview session hotfix（CODE COMPLETE / DEPLOY PENDING）: 修复 `/dashboard/sync` 点击「重新建立登录会话」后因 `spawn python ENOENT` 冒泡为 Server Components 生产错误的问题。Vercel 环境现作为可预期失败返回明确提示，不再创建锁文件或启动子进程；支持桌面 Chrome 的本地同步主机改为等待 `spawn` 成功事件后才返回启动成功，并支持 `PYTHON_EXECUTABLE` 配置，失败时清理锁与日志句柄。新增 4 项回归测试；全量非并发测试 3883/3883，聚焦 lint 0 errors，build/TypeScript 通过。独立 worktree 未保存 Vercel 项目链接，当前未重新绑定、未部署。

> 2026-07-17 Preview data result（历史验收结果）: Vercel Preview 的三项 Supabase 变量均只指向 `DIS Staging`，Production 变量与数据未改动。Staging 已用 Production 只读脱敏业务快照替换 `CODEX-SMOKE` 数据：1 Product、341 ProductVariant、341 Inventory、6 Warehouse、2 Shipment、5 手工物流事件与 11 外部物流事件；跨库内容哈希逐表一致。未复制 Production Auth、用户偏好、同步历史、Token Cache、Warehouse sync_url 或 Provider raw_payload。Staging Admin 可见全部 341 SKU / 5 个海外仓 / 34 条有效补货建议；Operator 仅分配 ID 仓并通过 RLS 仅可见 40 SKU。Preview 首页、P7 与补货页已用真实快照完成页面复验；对应顺序路线随后已通过 PR #2 合并到 `master`。

> 文档导航：[文档树](../../README.md) · [当前任务包](task-packets-through-2026-10-13.md) · [项目概览](../../project-overview.md) · [架构](../../architecture.md) · [数据库设计](../../database-design.md)

## Historical Phase（v4 之前）

**Stage 1–4 已完成、合并并归档，当前进入系统优化与工程治理。** P0 生产 API 链路、P1 预测式补货（Migration 00041–00044）、P7 全球库存作战室（00045–00046）与首页决策看板（00047）均已完成。OPT-4 最终质量门为 **3932/3932（91 files）**、PostgreSQL 并发 **44/44**、Migration/RPC/RLS contract **14/14**、lint **0 errors / 31 warnings**、Next.js build/TypeScript PASS；PR #7 最终 head 的 GitHub Actions 与 Vercel Preview 全绿。Production 与 Staging 均为 48/48 远端 version 对齐，OPT-4 已获指定会话 FINAL PASS。当前按既定路线进入 OPT-5 数据库最小权限收口。

## Historical Task（v4 之前）

**OPT-5-DATABASE-LEAST-PRIVILEGE-HARDENING — FINAL PASS / MERGED** — 00049 只固定 5 个 search_path、收紧函数 EXECUTE 与 `provider_token_cache` 直接表权限；两环境均为 `00001–00049`，全部 catalog、ACL/RLS、回滚探针、token 数据保持和 Advisor 后检通过。PR #8 已合并；OPT-6 当前状态以顶部事实和 [当前任务包](task-packets-through-2026-10-13.md) 为准。

### P7 阶段拆分（v4 合并整合：P7 与作战室合并为单一产品「全球库存总览」）

| 阶段 | 说明 | 状态 |
|------|------|------|
| P7-PLAN | 文档与口径确认：数据关系图、可复用能力、已知缺口、MVP 不做项、实现任务拆分 | ✅ DONE（Codex 复验通过） |
| P7-A | 全球库存基础总览（先上）：Product/Variant 一行、海外库存汇总、海外在途汇总、基础库存告警、国内占位、Admin/Operator warehouse_id 权限隔离 | ✅ DB + Preview PASS；Admin 341 SKU，Operator 仅 ID 仓 40 SKU |
| P7-B | 作战室增强层（后叠，依赖 P1）：复用 `forecast_stockout(...)` 算 earliest_stockout/urgency/分国 burn-down + 详情弹窗 + 后续 net_demand/suggest_qty/latest_order_date；与 P7-A 共用同一路由/列表 RPC/详情 RPC | ✅ DB + Preview PASS；真实快照列表、队列、分页与详情运行正常 |
| P7-UX | 运营可用性收口：筛选/排序/分页/详情跳转；PDF/截图导出按定稿为非本期 | ✅ CODE DONE |
| P7-REVIEW | 独立验收与文档同步 | ✅ LOCAL + DB + PREVIEW REVIEW DONE + MERGED |
| P8 | 国内库存接入（下游独立）：真实国内数据/生产周期/在途接入，建成 `/dashboard/inventory/domestic` | 待立项（原 TECH-DEBT-01） |
| P7-C | 启用国内补给判断（依赖 P8）：DomesticJudge 由 data_unavailable 占位改为真实计算 | 待 P8 完成 |

### 已知技术债（P7 记录，不实现）

| 编号 | 技术债 | 现状 | 后续任务 |
|------|--------|------|----------|
| TECH-DEBT-01 | 国内库存缺失 | 无数据来源/模型/同步链路，Dashboard 入口为灰色占位 | P8-DOMESTIC-INVENTORY |
| TECH-DEBT-02 | 国内生产周期缺失 | 无字段/表存储生产周期 | 独立任务设计 |
| TECH-DEBT-03 | 市场运输周期精细化缺失 | warehouse.lead_time_days 仅有仓级静态值（30天），无国家对级/动态计算 | 独立任务设计 |

### P7-MVP 核心决策（v4 合并整合）

| 决策项 | 结论 | 理由 |
|--------|------|------|
| 产品定位 | P7 与作战室合并为单一产品「全球库存总览」：P7-A 基础总览 + P7-B 作战室增强层；不建设两个产品级库存总览页 | Rall 终审：两个独立页面/两套 RPC 冲突，须合并 |
| 唯一路由 | `/dashboard/products/overview`（产品分组侧边栏入口，页面标题「全球库存作战室」） | P7 已确认路由；原规划 `/dashboard/war-room` 退役 |
| 唯一列表 RPC | 新增 `get_product_overview`（合并后统一命名，DB 内完成权限过滤→Variant 聚合→warehouse/country 聚合→在途→earliest_stockout→urgency→排序→分页→total_count） | v4 合并：P7 与作战室共用同一列表 RPC，不另设第二套产品总览 RPC |
| 唯一详情 RPC | `get_war_room_variant_detail`（点行弹窗，DB/Repository 层先按 warehouse_id 过滤） | 详情接口唯一，禁止前端传国绕过权限 |
| 新 Migration | 00045（P7 E）+ 00046（P7 F），依赖 P1 的 00043（C）与 00044（D） | 不能修改已执行 Migration，全部作为新 Migration 创建 |
| 新 RLS | 不新增 | 不建新表 |
| 国内库存 | 仅占位「待接入」（NULL / data_unavailable / 生产周期待定），不参与 visible_total_quantity/earliest_stockout/urgency/国内补给判断 | 真实国内接入划归 P8，P7-C 启用国内补给判断 |
| 权限 | Admin/Operator 均可，Operator 仓库隔离 | `requireActiveAuth()` + `warehouseAccessRepository` |
| 分层依赖 | **P7 整体依赖 P1**（P7 E/00045 依赖 P1 C/00043，P7 F/00046 依赖 P1 C/00043 与 D/00044）；P7 实施顺序在 P1 之后；**国内补给判断依赖 P8**（P7-C 启用） | 严格串行 P0→P1→P7→首页；P7 不先于 P1 开工 |

### P6 闭合摘要

P6-OVERSEAS-INVENTORY-UX-V2 A+B+C+D 全部 DONE + D 返工 DONE + P6-UX-V2-F DONE（在途卡片真实联动）+ P6-RECOVERABLE-FIX DONE（URL 参数清洗）。质量门：3348/3354 测试（6 预存失败非本任务引入）、build pass、lint 0 errors / 25 warnings。

详细计划见 `docs/tasks/current-task.md`。

## Completed Tasks

- Task 0.1 — Next.js 项目初始化（create-next-app + TypeScript + Tailwind + shadcn/ui + 13 个 shadcn 组件）
- Task 0.2 — Supabase 项目连接 + Migration 执行 + 数据库初始化 + 类型生成
- Task 0.3 — Auth 登录 + middleware + Dashboard 布局（Sidebar + Header）
- Task 0.4 — 业务模块骨架（5 个业务模块 + dashboard 占位，共 6 个模块）
- Task 0.4 Architecture Audit — 架构审计（2026-06-10，综合评分 9/10，修复 3 个问题）
- Task 1.1 — Product 产品管理 CRUD（2026-06-11，产品列表 + 详情 + 表单 + 数据层收口 + 错误传播修复 + loading/error 状态）
- ProductVariant Mapping 数据层与安全基础（Migration 00003/00004/00005 + RPC 安全收口 + 函数内去重 + 权限收紧）
- Task 2.1 — 国外库存页面 MVP 初版（2026-06-11，统计卡片 + 筛选 + 表格 + 分页）
- `P2-I1` — 海外库存查询与分页正确性（2026-06-12，独立验收通过）
- `P2-I2` — 海外库存页面交互与响应式验收（2026-06-12，独立验收通过）
- `P2-I3` — 海外库存真实数据走查与使用验收（2026-06-12，确认当前无海外库存，数据来源为 BigSeller 页面抓取）
- `P5-SY1` — BigSeller 抓取器只读试跑与首仓字段确认（2026-06-12，独立验收通过）
- `P5-SY3B` — 菲律宾 Inventory 实际写入与新 SKU 创建（2026-06-12，第四次独立验收通过；91 Variants + 91 Inventory + Warehouse 改名，幂等与执行保护验证通过）
- `P5-SY4A` — SyncLog 与失败保留机制设计及任务拆分（2026-06-12，第七次独立设计验收通过）
- `P5-SY4B` — Migration 00006：事务型海外库存同步 RPC（2026-06-13，独立静态验收通过；673 行，26/26 测试，未执行）
- `P5-SY4C` — Executor 适配 RPC 与 SyncLog 写入（2026-06-13，独立验收通过；156/156 测试通过：76 executor + 26 plan + 44 verifier + 10 structural，未执行 Migration，未发生数据库写入）
- `P5-SY4D` — 同步失败模式测试覆盖（2026-06-13，独立验收通过；183/183 测试通过：27 sync_log + 76 executor + 26 plan + 44 verifier + 10 structural，全部通过 CLI 严格验证退出码，compileall/lint/build 通过，未连接 Supabase，未执行 Migration）
- `P5-SY4E` — CLI 集成与 Dry Run 端到端验证（2026-06-13，独立验收通过；修复 plan_drift_check 不再硬编码 PASS，新增 plan_drift_count/differences；193/193 测试通过：10 cli_integration + 27 sync_log + 76 executor + 26 plan + 44 verifier + 10 structural）
- `P5-SY5` — 手动同步入口架构设计与任务拆分（2026-06-14，V5.4.3 第十一次独立设计验收通过；validateJsonValue ~24 场景，P5-SY5F ~46 场景，仅设计文档未实现代码）
- `P5-SY5A` — Migration 00007：sync_run 表与同步运行 RPC（2026-06-14，第五次聚焦返工，独立静态验收通过；59/59 静态契约测试；claim FOR UPDATE 竞态修复 + release NULL exit_code 拒绝）
- `P5-SY5B` — 认证链修复（2026-06-14，独立验收通过；25/25 单元测试；新增 `getCurrentActiveUser()` / `requireActiveAuth()` / `requireActiveAdmin()`，旧函数行为不变）
- `P5-SY5C` — Sync Feature Module 骨架（2026-06-14，独立验收通过；129/129 测试；validateJsonValue V5.4.3 / ArtifactProvider 接口 / GC orchestrator / SyncRunner 契约 / 类型契约 + expectTypeOf 精确断言）
- `P5-SY5C2` — Sync Feature Module 后端实现（2026-06-19，独立验收通过；258/258 测试；types.ts / schema.ts / repository.ts / sync-service.ts / actions.ts / mock-artifact-provider.ts / mock-sync-runner.ts + 7 个测试文件）
- `P5-SY5D` — Sync 页面与客户端组件（2026-06-19，独立验收通过；263/263 测试；查看详情 Sheet + MockArtifactProvider static 存储 + getCurrentActiveUser 认证链；server-actions.ts / page.tsx / sync-page-content.tsx / loading.tsx / error.tsx）
- `P5-SY5E` — 侧边栏集成（2026-06-19，独立验收通过；263/263 测试；sidebar-nav.tsx 新增"数据同步"分组 + RefreshCw 图标 + 库存同步入口，phase 0）
- `P5-SY5F` — Mock E2E 流程验证（2026-06-19，Codex 独立复验通过；281/281 测试；integration.test.ts 18 项集成测试：非确定性序列化 + GC 全管道 + GC 防误删边界 + artifact 生命周期 + 被引用 Dry Run GC 保护 + orphan 反例删除。Repository 接口新增 getActiveRunIds / getRecentlyCompletedRunIds / getReferencedDryRunIds）
- `P5-SY5G` — 并发锁原子 Claim 测试（2026-06-19，Codex 独立复验通过：D2/F2 确定性 FOR UPDATE 行锁断言确认 — D2 A FOR UPDATE 持有 dry_run → B UPDATE lock_timeout → A 释放 B 成功；F2 B FOR UPDATE 持有 in_progress run → A heartbeat lock_timeout → B 释放 heartbeat 成功；无 expect(true).toBe(true) 或"环境差异不强制断言"通过路径；Current Task References 已更新为核心文件。44/44 并发测试（9 静态校验 + 35 双事务并发），281 非并发测试全通过，lint 0 errors，build 通过；未连接生产 Supabase，未执行生产 Migration 00008/00007）
- `P5-SY6` — 定时任务与运行环境评估（2026-06-19，Codex 第三次独立设计验收通过；两次返工：4 项聚焦 + 1 项小修；5 方案 × 10 维度对比，推荐两层架构 Vercel Cron + Worker，架构边界/平台事实/手动路径/验证口径全部修正；未实现代码，未连接生产 Supabase，未执行生产 Migration；评估文档 `docs/tasks/archive/p5-sy6-runtime-design.md`）
- `P5-SY7` — 单仓端到端验收（2026-06-19，Codex 独立复验通过；A~F 全部维度验证通过，6 项已知差距/0 项阻塞项。差距分析文档 `docs/tasks/archive/p5-sy7-gap-analysis.md`。生产 Migration 00006/00007/00008 已执行，P5-SY8 就绪）
- `P5-SY8A` — VN 只读抓取与 Dry Run 方案（2026-06-19，Codex 独立验收通过；64 行抓取 + Dry Run 通过，输出 `bigseller-inventory-20260619-205955.json`）
- `P5-SY8B` — VN 越南青林湾仓库真实写入与端到端验收（2026-06-19 DONE + 2026-06-20 Codex 独立验收通过。首次 RPC 提交 64 Variants (country=VN) + 64 Inventory；幂等重跑通过：0 新增，Phase G/I PASS，sync_log status=success/synced_count=64；修复 6 处硬编码 PH→WAREHOUSE_COUNTRY + Migration 00009 通用化 RPC。执行报告 `p5-sy8b-vn-execute-20260619-215055.json`。Codex 返工 4 项全部通过：令牌国家绑定 / Migration 00009 静态契约测试 13/13 / 执行报告时间戳 / 文档同步。160/160 Python 测试，npm lint 0 errors，npm build 通过）
- `P5-SY8C` — TH 泰国仓（DEE-龙仔厝 ICE 专属）只读抓取与 Dry Run（2026-06-20 DONE，Codex 独立验收通过。A0 仓库改名 + A1 配置切换 + A2 BigSeller 抓取 72 行 + A3 输入校验 + A4 Dry Run（返工：报告身份 token 派生 + Dry Run Phase E 空 DB 兼容）+ A5 全链路国家断言。196/196 Python 测试，13/13 Migration 00009 契约测试，compileall 通过，npm lint 0 errors，npm build 通过。报告区分：130900=stored plan baseline / 133500=CLI execution report。未执行真实写入。）
- `P5-SY8D` — TH 泰国仓（DEE-龙仔厝 ICE 专属）真实写入与端到端验收（2026-06-20 DONE，Codex 独立验收通过。真实 RPC 写入：72 Variants (country=TH) + 72 Inventory；Phase G/I PASS；sync_log status=success。DB 只读核查：72 Variants 全部 country=TH，72 Inventory 全部链接 TH warehouse。新增 P5-SY8D-TH 令牌 + 令牌—模式绑定 + 执行器层安全门 + finished_at 审计语义修复。两轮 Codex 返工全部通过。228/228 Python 测试（25 CLI + 81 executor + 26 plan + 29 sync_log + 44 verifier + 10 structural + 13 Migration 00009），compileall 通过，npm lint 0 errors，npm build 通过。报告：p5-sy8d-th-dry-run-20260620-140012.json / p5-sy8d-th-execute-20260620-140034.json）
- `P5-SY8E` — MY 马来西亚仓（喜运达MY仓）只读抓取与 Dry Run 方案（2026-06-20 DONE，Codex 独立验收通过。BigSeller 抓取 48 行，warehouse=喜运达MY仓 (autoid=warehouse_option_4)。DB 仓库 `马来西亚仓`→`喜运达MY仓` 改名已确认。Stored Plan Baseline `p5-sy3a-dry-run-20260620-232838.json`，CLI Dry Run 报告 `p5-sy8e-my-dry-run-20260620-233129.json`，plan_drift_check=PASS。invalid sidecar: 1 行被拒绝（空包 0000）。新增 P5-SY8E-MY 令牌（仅 --dry-run）+ test_my_full_chain_country_assertions（execute_plan_v2 真实执行，逐条验证 RPC p_variants/p_inventory country=MY + Phase G country=eq.MY + Phase I wh_expected.country=MY + SyncLog warehouse_id/status）。Codex 返工完成：MY 全链路国家断言 + 文档同步。234/234 Python 测试（29 CLI + 83 executor + 26 plan + 29 sync_log + 44 verifier + 10 structural + 13 Migration 00009），compileall 通过，npm lint 0 errors，npm build 通过。未执行真实写入。）
- `P5-SY8F` — MY 马来西亚仓（喜运达MY仓）真实写入与端到端验收（2026-06-21 DONE，Codex 独立验收通过。全新 BigSeller 抓取 48 行 + invalid sidecar 1 行（空包 0000）。P5-SY8F-MY 令牌（唯一 MY --no-dry-run 令牌，P5-SY8E-MY 保持仅 --dry-run）；动态错误提示指向正确写入令牌。首次写入：RPC variants_created=48，inventory_inserted=48，warehouse_renamed=true；Phase G PASS（48 SKU 全部一致），Phase I PASS（name=喜运达MY仓，country=MY）；SyncLog status=success。幂等重跑：0 新增 Variant，0 新增 Inventory，48 unchanged；plan_drift_check PASS。写后验证：RPC 摘要内部一致，所有 Variant country=MY，所有 Inventory 关联 MY warehouse_id，started_at/finished_at 非空。239/239 Python 测试（85 executor + 32 CLI + 26 plan + 29 sync_log + 44 verifier + 10 structural + 13 Migration 00009），compileall 通过，npm lint 0 errors，npm build 通过。执行报告：`p5-sy8f-my-execute-20260621-002507.json`（首次）/ `p5-sy8f-my-execute-20260621-002540.json`（重跑）。）
- `P5-SY8G` — ID 印尼仓（印尼-DEE仓库）只读抓取与 Dry Run 方案（2026-06-21 DONE，Codex 独立复验通过。BigSeller 抓取 35 行 + invalid sidecar 1 行（空包 0000），warehouse=印尼-DEE仓库，autoid=warehouse_option_3。DB 仓库 `印尼仓`→`印尼-DEE仓库` 改名已确认。P5-SY8G-ID 令牌（仅 --dry-run）。Codex 返工 3 项修复通过：1) --no-dry-run 动态提示 P5-SY8H-ID（新增 `_PENDING_WRITE_TOKENS`）；2) `_DRY_RUN_ONLY_TOKENS` 一致性测试改用 ast.parse；3) `_NO_DRY_RUN_EXCLUSIVE_TOKENS` 断言不再被 `except AssertionError: pass` 吞掉。后收口维护：docs/current-state.md 残留状态同步 + Sync GC 测试夹具 finishedAt 时钟控制修复。245/245 Python 测试，256/256 非并发同步测试，compileall/lint/build 通过。未执行真实写入。）
- `P5-SY8H` — ID 印尼仓（印尼-DEE仓库）真实写入与端到端验收（2026-06-21 DONE，Codex 独立验收通过。P5-SY8H-ID 令牌（--no-dry-run 写令牌）。首次写入：RPC variants_created=35 (country=ID)，inventory_inserted=35，warehouse_renamed=true；Phase G PASS（35 SKU 全一致）；Phase I PASS（name=印尼-DEE仓库，country=ID）；SyncLog success。幂等重跑：0 new variants，0 inventory inserted，35 unchanged；plan_drift_check=PASS。Codex 独立验收：代码、报告、真实 DB 只读核查、幂等重跑、质量门均通过。128/128 Python 测试（89 executor + 39 CLI），compileall 通过，npm lint 0 errors，npm build 通过。）
- `P5-SY9B` — BigSeller Session Health Check（2026-06-23 Codex 独立复验通过：新增 health_check.py 只读 headless 健康检查（含 profile_unavailable 真实分类）+ verifyBigSellerSession() Server Action（checked_at → checkedAt 字段转换）+ Sync 页面会话健康状态显示 + syncWarehouse/syncAllWarehouses 服务端 session health guard。7 种状态分类：healthy / need_login / need_verification / profile_unavailable / page_structure_changed / table_not_loaded / unknown_error。27/27 TypeScript 测试 + 15/15 Python 测试，lint 0 errors，build 通过。）
- `P5-SY9C` — 真实 Provider / InputSource / Production wiring（2026-06-23 Codex 独立复验通过。3 项指标：1) server-actions.ts 已移除 MockSyncRunner import + wireActions()，读路径拆为 repository-only，triggerSync 直接返回中文错误不构造 SyncService；2) FileSystemArtifactProvider 支持注入 baseDir（默认 runtime/artifacts），测试使用 os.tmpdir() 隔离；3) production-wiring.test.ts 无 expect(true) placeholder，含源码检查/NODE_ENV=production 拒绝验证/feature gate 拦截测试。98/98 P5-SY9C 测试，15/15 Python，379/379 非并发，lint 0 errors，build 通过。未连接生产 Supabase，未执行真实写入。）

- `P5-SY9D` — 单仓 Web Dry Run → 审核 → Real Write 绑定（2026-06-23 DONE。第三次返工通过 Codex 验收：confirmRealWrite 全部绑定校验强制化 — country 校验不再条件跳过 + 查询契约除杂（SyncRunAdminRow 不含 hash）+ 60 分钟边界修复。51/51 P5-SY9D 测试，430/430 非并发同步测试，Python 85/85 通过，lint/build 通过。Web 真实写入入口保持 server-side disabled。）
- `P5-SY9E` — heartbeat / timeout / 子进程控制（2026-06-23 DONE。Codex 独立验收通过。统一 terminate(reason) 管线 + 可注入 heartbeatIntervalMs + prepareRunnerContext 异常清理 + capabilities 抛错 release 失败 → indeterminate + 23 项测试。453/453 非并发同步测试，Python 85/85，lint/build 通过。Web 真实写入入口保持 server-side disabled。未连接生产 Supabase，未执行真实写入。）
- `P5-SY9F` — 批量全部海外仓 Dry Run（2026-06-23 DONE。Codex 独立复验通过（含 7 项返工）。Admin 可触发"批量 Dry Run / 审核总览"；每仓独立 claim/execute/release；单仓失败不影响其他仓；返回 BatchDryRunResult 含 warehouse name/country/runId/status/fetched rows/valid/invalid SKU/new variants/inventory/warehouseRenamePlan/planDriftCheck/failureReason。planDriftCheck !== 'PASS' → status='blocked'（非 ready）。warehouseRenamePlan 包含 action/currentName/targetName/message 详情。页面"批量 Dry Run"按钮调用 triggerBatchDryRun() 而非 syncAllWarehouses()；展示逐仓审核卡片。MockSyncRunner 新增 planDriftCheck/planDriftCount/renamePlan 可配置属性。删除 __debug.test.ts。495/495 非并发同步测试（17 文件），Python 15/15，lint 0 errors / 14 warnings，build 通过。Web 真实写入入口保持 disabled。）
- `P5-SY9G` — 批量审核后真实写入（2026-06-24 DONE，Codex 独立验收通过。Admin 在批量 Dry Run 审核总览中勾选 ready 仓库，输入确认短语「确认写入」后逐仓真实写入。每仓独立 claim/release/sync_log，单仓失败不影响其他仓。confirmRealWrite 签名新增 confirmToken 参数，消除硬编码 P5-SY3B-PH。新增 triggerBatchRealWrite Server Action + 17 项测试。批量写入页面 UI：就绪仓库复选框 + 全选/取消 + 确认短语输入 + 写入结果总览。511/511 非并发同步测试（17 文件），lint 0 errors / 15 warnings，build 通过。WEBSYNC_REAL_WRITE_ENABLED 仍 disabled；Web 真实写入入口保持 server-side disabled。）
- `P5-SY9H` — 页面体验与运营可用性收口（2026-06-24 DONE，Codex 独立验收通过。6 项体验改进：仓库聚合概览卡片 + Operator 失败原因可见 + 客户端分页 + 海外库存同步状态列 + 页间导航 + sync_log 明细。新增 SyncLogRecord/WarehouseSyncStatus 类型 + getSyncLog() repository + getOverseasWarehouseSyncStatus()/getSyncLogDetail() Server Action + 12 项测试 + 清理标记。523/523 非并发同步测试（19 文件），lint 0 errors / 15 warnings，build 通过。WEBSYNC_REAL_WRITE_ENABLED 仍 disabled。）
- `P5-SY9I` — 独立验收与生产启用准备（2026-06-24 DONE，Codex 独立验收通过。含一次返工：拆分 `npm run test`/`npm run test:concurrency` 脚本解决 concurrency.test.ts 缺少 PG 环境变量时退出码 1 的问题。最终质量门：523/523 TS 测试（18 文件）+ lint 0 errors / 15 warnings + build 通过 + 242/242 Python 测试（compileall + health_check 15 + plan 26 + verifier 44 + executor 89 + sync_log 29 + cli_integration 39）。架构边界合规审查通过。WEBSYNC_REAL_WRITE_ENABLED 仍 disabled；生产启用待用户明确授权。）
- `P5-SY9J` — 生产启用受控验证（2026-06-24 DONE，用户授权后执行。WEBSYNC_REAL_WRITE_ENABLED=true 已在 .env.local 启用。受控验证选 PH 仓（菲律宾-新创启辰自建仓）：Web Dry Run（104 行 → 6 新 variants + 80 更新 + 18 未变更）→ 审核（plan_drift_check=PASS）→ Real Write 成功（sync_log status=success，new_variants_count=6，库存更新已确认：SKU 7148556251712 数量 100,716→80,481）。修复 web_bridge.py execute_plan_v2 调用签名不匹配（移除已废弃的 warehouse/confirm_token/dry_run_report_path/input_json_path 参数）。已知小问题：execute_plan_v2 返回 summary 全为零（不影响实际写入，sync_log 记录正确），记入技术债务。）
- `P5-SY9K` — 返工：禁用旧同步入口 + 修复 Web Real Write summary（2026-06-24 DONE。两项返工：1) syncWarehouse / syncAllWarehouses 永久禁用，不再执行真实写入，返回中文错误引导用户使用 Dry Run → 审核 → 确认写入流程；sync-page-content.tsx 移除 syncWarehouse import / handleTrigger / 「快速同步」按钮。2) web_bridge.py Real Write summary 从 rpc_result["rpc_summary"] 读取（而非直接从 rpc_result 顶级键读取），修复返回全零问题。新增 TypeScript 测试（production-wiring.test.ts 7 项源码检查 + session-health.test.ts 4 节重写）和 Python 测试（test_web_bridge_summary_reads_from_rpc_summary）。质量门：526/526 TS 测试 + 252/252 Python 测试 + lint 0 errors + build 通过。WEBSYNC_REAL_WRITE_ENABLED=false 已恢复到安全状态。）
- `P5-SY10A` — 规则引擎核心：类型 + 纯函数 + 单元测试（2026-06-24 DONE。新增 `rules-engine.ts`：`evaluateRules(input)` 纯函数，11 条规则 R1~R11，冷启动/有基线双路径，BLOCK > WARN > PASS 决策推导。新增 `evaluateSessionHealth()` 辅助函数。新增 `types.ts` 中 `RuleLevel` / `RuleEvaluation` / `RuleInput` / `RuleVerdict` 类型。60 项测试覆盖每规则命中/不命中/边界 + 组合场景 + 冷启动双路径。质量门：586/586 TS 测试，lint 0 errors，build pass。不涉及 DB/Cron/UI/Real Write。）
- `P5-SY10B` — 历史上下文提供器：基线追踪 + 连续失败检测（2026-06-24 DONE，Codex 返工复验通过。SyncRepository 接口新增 `getWarehouseHistory(warehouseId)`，MockRepository + SupabaseSyncRepository 实现。从 sync_run 推导 hasBaseline / consecutiveFailures（仅 dry_run failed，real_write 屏障）/ lastSuccess / stats（最近 5 次完成均值）。`sync-service.ts` 中 `buildResultSummary()` 将 scraperMeta 字段持久化到 result_summary JSONB。35 项测试覆盖冷启动/有基线/连续失败 1~3/real_write 屏障不穿透/成功重置/跨仓隔离/缺失 result_summary/混合格式。质量门：621/621 TS 测试，lint 0 errors，build pass。不新增 DB 表，不改 Migration。）
- `P5-SY10C` — 自动预审编排 Server Action（2026-06-24 DONE，Codex 独立复验通过。返工完成：① 在 triggerBatchDryRun 之前逐仓预取 getWarehouseHistory 并缓存，确保 cold start 仓库 hasBaseline=false，已有历史仓库 stats 不含当前 run；② history 获取失败 → BLOCK（history_unavailable 规则），含中文原因，不 fallback 冷启动；③ 新增冷启动 R7/R11 路径测试 + 预取历史排他性测试。`runAutoPreReview` Server Action：requireActiveAdmin + session health guard + wireRealActions。30 项测试。质量门：651/651 TS 测试，lint 0 errors，build pass。WEBSYNC_REAL_WRITE_ENABLED 仍 disabled。）
- `P5-SY10D` — 预审页面 UI（2026-06-24 DONE，Codex 独立验收通过。Sync 页面新增「自动预审」入口（调用 `runAutoPreReview()`）。BatchReviewCard 扩展：RuleBadge（PASS 绿/WARN 黄/BLOCK 红）+ 可展开规则详情（evaluations[].message）+ WARN 可选带警告 / BLOCK 不可选含阻断原因。统计栏 PASS/WARN/BLOCK 三色计数。保留「批量 Dry Run」按钮（不运行规则引擎）。Operator 只读。`AutoPreReviewItem.dryRun` 补全 `warehouseRenamePlan` 字段。复选框：独立 `autoReviewSelectedItems` Set，PASS/WARN + status=ready 可选（checked 状态可变化），BLOCK/failed/blocked 不可选。清理 unused imports（BatchRealWriteItemResult 等）。30 项新测试（含 8 项复选框行为源码检查 + 1 项 Codex 验收追加）。质量门：681/681 TS 测试（22 文件），lint 0 errors，build pass。WEBSYNC_REAL_WRITE_ENABLED 仍 disabled。）
- `P5-SY10E` — 调度机制：Vercel Cron Route Handler + 手动触发入口（2026-06-24 DONE，2026-06-24 返工完成。返工原因：Cron Route 通过 API key 后无 Supabase 用户 session，`claim_sync_run` 要求 `auth.uid()`，Cron 生产路径会失败。返工方案：① Migration 00010 新增 `claim_sync_run_system` RPC（SECURITY DEFINER，service_role only，校验 p_triggered_by 是激活 admin，仅允许 dry_run，复用并发锁/warehouse 校验/lease/僵尸回收逻辑）；② Repository 新增 `claimSyncRunSystem` 方法；③ SyncService 新增 `_systemClaimConfig` 配置项；④ 移除 `actions.ts` 中 `systemTriggeredBy` 绕权参数（`triggerBatchDryRun`/`runAutoPreReview` 始终调用 `requireActiveAdmin`）；⑤ `server-actions.ts` `runScheduledAutoPreReview` 直接构造带 `_systemClaimConfig` 的 SyncService，不经过 `createSyncActions`。新增 Migration 00010 静态测试 + claim_sync_run 未修改验证 + 系统 claim 路径 Mock 测试 + real_write 拒绝测试。744/744 TS 测试（23 文件），lint 0 errors，build pass，253 Python 通过。）
- `P5-SY11-REWORK` (P5-SY11G A~F) — 语义返工：用户级 Variant 归档偏好（2026-06-25 DONE。全局 product_variant.is_archived 迁移为用户级 user_variant_preference。Migration 00012 新建 user_variant_preference 表 + RLS + 移除 operator_select_variant 的 is_archived 全局过滤。variantRepository archive/restore/list/getUnmatched 全部改用 user_variant_preference，每人独立归档。Server Actions 改为 requireActiveAuth，Admin/Operator 均可操作。Inventory 层按当前用户归档偏好过滤。UI 所有登录用户可归档/恢复。P5-SY11G 返工（2026-06-25）：修复 4 项阻塞问题 — 1) inventory repository getOverseasList/getLowStock 从 v.id 改为 row.variant_id 判断归档；2) list() 归档过滤从 JS 后置改为 DB 层 notIn/in 在分页前完成；3) archive/restore 返回实际变更数；4) list() active tab 改用 query.notIn() 替代 query.not('id','in',...)，.not() 期望 PostgREST 原始括号语法而 JS 数组无括号导致过滤失效。质量门：896/896 TS 测试，30 文件，lint 0 errors，build pass。Python：315 passed + 5 collection errors。）
- `P5-SY11G-RUNTIME` — 运行时修复与生产验证（2026-06-25 DONE。两项修复：1) Migration 00012 由用户在 Supabase Dashboard 手动执行（Pooler 不识别 tenant，自动连接不可用），验证 user_variant_preference 表 + 4 条 RLS 策略存在，PostgREST schema cache 已刷新；2) getSyncRuns limit 契约修正：Zod schema max(500).default(200) → max(100).default(100)，server-actions.ts limit:500→100，与 DB RPC get_sync_runs p_limit > 100 强制拒绝一致。人工验收通过：/dashboard/inventory/overseas 正常加载（不再报 schema cache 错误），/dashboard/sync 正常加载，/dashboard/variants 归档/恢复正常，A 归档后 B 视图不受影响，归档是个人偏好非全局。质量门：896/896 TS 测试，lint 0 errors，build pass。）
- `P5-SY12` — 特别关注阶段 B 最小闭环（2026-06-25 DONE + 2026-06-25 返工修复。Migration 00013 扩展 `user_variant_preference.preference_type` CHECK 约束支持 `'favorited'`（不新建表，需用户手动执行）。新增 `src/features/preferences/` 模块：types（PreferenceError / PreferenceResult / FollowedVariantBasic）+ schema（toggleFavoriteSchema）+ repository（getFavoritedVariantIds / isFavorited / favorite / unfavorite / toggleFavorite / getFollowedVariantsBasic）+ actions（toggleFavoriteAction — requireActiveAuth）。海外库存列表每行新增星标按钮（乐观更新 + 失败 toast 回滚 + 成功 router.refresh）。Dashboard 首页新增「关注产品动态」区（空状态 / 表格 + 低库存置顶 + 告警摘要条 / 加载失败错误状态）。阶段 B 告警临时用 `product.safety_stock`。归档与关注可共存（UNIQUE 按 user_id+variant_id+preference_type）。不新增 variant_follows 表、不新增 daily_sales/est_days/lead_time_days、不改 sync RPC / Python。2026-06-25 返工修复：1) 星标按钮失败回滚 + toast；2) 关注查询失败不再静默空列表；3) 清理未使用 imports/warnings。979/979 tests、lint 0 errors / 25 warnings、build pass。）
- `P5-SY12C` — Dashboard 关注产品动态告警升级（2026-06-26 DONE。Migration 00014：`inventory.daily_sales NUMERIC NULL` + `inventory.estimated_days NUMERIC NULL` + `warehouse.lead_time_days INTEGER NULL` + `CREATE OR REPLACE sync_warehouse_inventory` 扩展支持写入 daily_sales/estimated_days（NaN/Infinity 拒绝，缺失/null/'—'/空→NULL，INSERT/UPDATE/UNCHANGED 三路径均写入，签名不变）。Python sync 链路：plan_generator 透传 daily_sales/estimated_days 到所有 plan entry + executor `_build_rpc_payload` 校验（None/'-'/''→omit，NaN/Infinity→reject，有效有限值→包含）。TypeScript：`FollowedVariantBasic` 新增 dailySales/estimatedDays/leadTimeDays/alertLevel/alertReason；`getFollowedVariantsBasic()` 升级动态告警规则（estimatedDays < leadTimeDays→critical「可售天数低于补货周期」优先，quantity < safetyStock→warning「低于安全线」，未匹配+数据缺失→unknown「数据不足」，其余→normal）；排序 critical→warning→normal/unknown，同级 estimatedDays asc（null 最后）→quantity asc。Dashboard 表格新增日销/可售天数/补货周期三列 + 状态 badge（critical 红/ warning 琥珀/ normal 绿/ unknown 灰）。告警摘要按 alertReason 展示。1006/1006 TS 测试（35 文件），lint 0 errors / 24 warnings（all pre-existing），build pass，Python compileall pass。RUNTIME VERIFIED 2026-06-26：Migration 00014 手动执行成功，5 仓 lead_time_days=30，daily_sales 全部写入；estimated_days 按 BigSeller 可用数据写入（部分 SKU 为空属正常），PH expired in_progress 已清理，Dashboard 动态告警正常运作。）
- `P5-SY12D` — Dashboard 关注产品动态运营可用性收口（2026-06-26 DONE。新增 `FollowedProductsSection` Client Component：状态筛选（全部/紧急/低库存/正常/数据不足）+ 每行跳转入口（→海外库存 SKU 搜索）+ 未匹配提示（title tooltip "该 SKU 未匹配产品，不参与安全库存判断。仍可通过预计可售天数进行动态告警"）+ 筛选无结果/加载失败/空关注/全未匹配边界状态。Dashboard page.tsx 数据获取链路不变（Repository Pattern），仅渲染替换为客户端组件。不改数据模型/Migration。1014/1014 TS 测试（35 文件），lint 0 errors / 24 warnings，build pass。）
- `P5-SY13A` — 仓库分配权限：权限基础与读路径收紧（2026-06-26 DONE，production migration verified。Migration 00015 已于 Supabase SQL Editor 执行成功：user_warehouses 表 + 22 条 RLS 策略 + get_assigned_warehouse_ids() 辅助函数 + get_sync_runs/get_sync_run_detail operator 分支 assigned warehouse 过滤。user_warehouse_assignments=0 是当前单用户/Admin 场景可接受状态（无 operator 需要分配）。返工修复 3 项阻塞：1) `get_assigned_warehouse_ids()` GRANT EXECUTE TO authenticated；2) 移除 `accessibleWhIds.size > 0` 防误放守卫（空分配→空结果）；3) `getSyncLogDetail()` 应用层补强 `canAccessWarehouse` 校验。1101/1101 TS 测试（37 文件），lint 0 errors / 24 warnings，build pass。下一步：P5-SY13B 仓库分配管理 UI。）
- `P5-SY13B` — 仓库分配管理 UI（2026-06-26 DONE，production migration verified。Migration 00016 已于 Supabase SQL Editor 手动执行并验证通过：rpc_exists=true / authenticated_can_execute=true / anon_can_execute=false。返工 Round 1 修复 2 项阻塞（写入前业务校验 + 事务性 RPC）+ Round 2 修复 2 项收口（RPC REVOKE/GRANT 授权 + 测试纳入 Vitest）。1199/1199 TS 测试（38 文件），lint 0 errors / 24 warnings，build pass。下一步：等待用户确认下一任务。）
- `P3-S1A` — 百世只读在途同步边界与数据模型（2026-06-26 DONE。Migration 00017 新建 `shipment_external_ref` / `shipment_external_item` / `tracking_event_external`（路径 B）三张外部在途表，含 CHECK 约束、唯一索引、外键、RLS 策略（authenticated 可读 / admin 可写）及 updated_at 触发器。新建 `src/features/in-transit/` 模块（types.ts + schema.ts）。database.ts 已同步三表类型。64 项静态契约测试通过，1263/1263 非并发测试通过，lint 0 errors，build 通过。2026-06-28 用户确认 Migration 00017 已在 Supabase SQL Editor 成功执行。未创建 API Client / Repository / Server Action / UI / 库存联动。）

- `P3-S3` — 手动创建/补录在途记录（2026-06-28 **DONE**，Codex 独立验收通过。表单页 `/dashboard/shipments/new` 就绪：船名/航次/起运港/目的港/国家/仓库/预计到仓日期/备注 + 可增删产品明细表格。`createShipment()` 使用 `requireActiveAuth()` + 仓库数据一致性校验（存在/启用/类型/国家一致）。**P3-S2E 已将创建/编辑/状态推进收紧为 Admin-only**（`roleName !== 'admin'` 拒绝），Repository 内 Operator 仓库校验分支保留为防御性代码。复用 `create_shipment_transactional` RPC（Migration 00005）。searchVariants 所有查询 error 检查 + notIn 归档过滤在 limit 前 + LIKE 转义 \\/%、_ + 独立 Repository 行为测试（mock createClient + variantRepository，不 mock shipmentRepository）+ 真实 Server Action 链路测试（Supabase 错误 → ShipmentError → ActionResult 中文错误）。目标测试 96/96，全量 1439/1439（44 文件），lint 0 errors / 26 warnings，build pass，git diff --check pass。未实现列表/详情/状态推进/入仓/库存联动。）

- `P3-S1B` — 百世 API Client、签名与 Dry Run 拉取（2026-06-28 **CODE COMPLETE / BLOCKED_EXTERNAL**。`src/lib/providers/best/` 模块完成：types.ts / signature.ts / schema.ts / parse-response.ts / client.ts / dry-run.ts / index.ts + 3 测试文件。百世开放平台 MD5 签名协议适配、API Client 封装、queryOrderInfoByOrderNo / 物流轨迹查询、Dry Run 入口全部就绪。本地测试（fake credentials + mock fetch）全部通过。真实只读 Dry Run 在签名正确时返回"未授权"，确认当前 partnerId 尚未获得 queryOrderInfoByOrderNo / trackingQuery 接口权限。**阻塞原因**：百世账号 API 权限尚未开通。代码和测试已保留，不删除。**恢复条件**：百世确认 partnerId 已授权两个只读接口后，重新执行 `npm run test:best-live`。在外部账号授权完成且真实 Dry Run 通过前不标记 DONE，不进入 P3-S1C。）

- `P3-S2A` — 内部手动在途只读页面（2026-06-29 **DONE** → P3-S2B 扩展为可维护管理台）
- `P3-S2B` — 内部手动在途维护收口（2026-06-29 **DONE → 返工完成**。Migration 00018 新增 `shipment_no` 字段 + RPC 10 参数；Migration 00019 新增 `change_shipment_status_transactional` RPC（原子化状态更新 + tracking_event 插入，GET DIAGNOSTICS 行确认）。`update()` 使用 `.select('id').single()` 确认命中 1 行（PGRST116 → NOT_FOUND）。`changeStatus()` 改为调用 RPC，移除两阶段分离写入。Repository 新增 `update()` / `changeStatus()` 方法（Operator 仓库隔离 + RLS 兜底，禁用 warehoused）。Server Actions 新增 `updateShipment()` / `changeShipmentStatus()`。列表页：单号为主标识 + 品名聚合列。详情页：`ShipmentEditForm` + `ShipmentStatusChange`。创建表单新增单号输入。全量 1526/1527 测试（47 文件，concurrency / best live 预存失败），lint 0/26，build pass。）

- `P3-S2C` — 库存视图接入内部手动在途只读聚合（2026-06-30 **DONE**。`shipmentRepository.getInTransitByVariant()` 按 variant_id 聚合在途数量（`quantity - warehoused_quantity`），排除 warehoused 状态，Admin/Operator 仓库隔离。海外库存页新增"在途"和"库存+在途"列 + 在途统计卡片。Dashboard 关注产品动态新增"在途"列。Dashboard 在途库存入口卡片从占位替换为真实数据（SKU 数 + 在途总量）。不新增 Migration，不写 inventory，不接 Best 外部表。14 项 repository 行为测试。全量 1541/1541 测试（46 文件），lint 0/26，build pass。）

- `P3-S2D` — 在途库存聚合精确到仓库（2026-06-30 **DONE**。`shipmentRepository.getInTransitByVariantAndWarehouse()` 按 (variant_id, warehouse_id) 聚合在途数量。海外库存页每行在途数量匹配 item.variantId + item.warehouseId，不再串仓。`getOverseasInventory` action 计算 variant 总在途供统计卡片使用。Dashboard 保持按 variant 总在途（用户确认可接受）。16 项 repository 行为测试含跨仓隔离验证。全量 1558/1558 测试（47 文件，concurrency/best live 预存失败），lint 0 errors / 27 warnings（all pre-existing），build pass。不新增 Migration，不写 inventory。）

- `P3-S2E` — 在途入口收口 + 采购单号 + 海外库存轻量展开（2026-06-30 **DONE**。Migration 00020：`shipment.purchase_order_no` nullable text + `create_shipment_transactional` RPC 升级为 11 参数（`RETURNING id INTO v_shipment_id`，Admin-only 权限）。Migration 00021：`change_shipment_status_transactional` 覆盖为 Admin-only。采购单号全链路：database.ts → types → Zod schema → Repository（create/update/list）→ Server Actions → UI 表单/列表/详情。海外库存行展开：`InTransitDetailRow` 客户端组件按 (variantId, warehouseId) 查询在途明细（单号/采购单号/在途数量/预计到货/详情链接），不串仓。入口收口：侧边栏移除"在途库存"入口，`/dashboard/inventory/in-transit` 重定向 `/dashboard/shipments`；Operator 隐藏新建/编辑/变更按钮。权限：Server Action + RPC 双层 Admin-only 写保护。测试：`getInTransitDetailsByVariantAndWarehouse` 17 项 repository 行为测试 + 27 项 action/Zod/源码检查（44 项 P3-S2E 合计）。全量 1603/1603 测试（49 文件，concurrency/best live 预存失败），lint 0 errors / 26 warnings，build pass。Supabase 生产库已手动执行并验证 Migration 00020/00021：`purchase_order_no` 字段存在，两个 RPC 均为 Admin-only。）

- `P3-S4A` — 内部手动在途状态轨迹收口（2026-06-30 **DONE**，2026-06-30 **返工完成**）。Migration 00022：`change_shipment_status_transactional` SELECT 当前状态 → 校验流转规则（booking→loading→departed→arrived→customs）→ UPDATE + INSERT。状态流转规则三层一致校验：Zod schema 排除 warehoused + Repository `changeStatus()` 预读 status 校验 + RPC 层 SELECT 校验。`SHIPMENT_STATUS_FLOW` 常量 + `isValidStatusTransition()` 纯函数 + `getNextValidStatus()` 工具函数。Repository `getById()` tracking_event 查询 join profiles + 按 `occurred_at` 升序排列 + 返回 `TrackingEventDetail`（含 creatorName）。Actions `advanceShipmentStatus()` 收紧为 Admin-only + 中文错误传播 + 禁用 warehoused。**返工**：`advanceStatus()` 改为直接委托 `this.changeStatus()` → RPC，删除内部 `from('shipment').update` + `from('tracking_event').insert` 两步分离写入；Actions `advanceShipmentStatus()` 使用 `parsed.data.*` 而非原始参数。`ShipmentStatusChange` 组件仅展示下一合法状态（移除下拉选择），无可推进时显示"已是最终状态"。详情页轨迹时间线升序 + 创建人显示 + 首个节点蓝色高亮。测试：79 项 P3-S4A 新测试（18 纯函数 + 13 Zod schema + 11 Migration 源码检查 + 22 详情页/组件/actions/repository 源码检查）+ 7 项追加行为测试（p3-s2a-behavior.test.ts：2 倒退/跳步 + 5 advanceStatus RPC 收口）。全量 1688/1688 测试（50 文件，concurrency/best live 预存失败），lint 0 errors / 25 warnings，build pass。Migration 00022 已在 Supabase SQL Editor 手动执行并验证。）

- `ARCH-IN-TRANSIT-REPOSITORY-BOUNDARY` — in-transit actions 数据访问收口（2026-07-29 **DONE → 返工完成 → 验收 PASS**）。`actions.ts` 中 `importGoluckyRefs` / `bindExternalRefToShipment` / `reactivateExternalRef` 三个 Server Action 原先直接 `createClient()` 并调用 `supabase.rpc()`，违反项目 Server Action → Repository → Supabase/RPC 数据访问链路。修复内容：1) `repository.ts` 新增 `importGoluckyRefs` / `bindExternalRefToShipment` / `reactivateExternalRef` 三个方法，封装 createClient、RPC 参数映射（camelCase→snake_case）、数据库错误转换为 ExternalTrackingError；2) `schema.ts` 新增 `goluckyImportResultSchema` Zod Schema（`.int().min(0)` 收紧为非负整数），替换 `import_golucky_refs` 返回值的 `as` 未校验类型断言；3) `types.ts` 新增 `GoluckyFailedItem` / `GoluckyImportResult` 类型，`importGoluckyRefs` 返回类型从 `ActionResult<{ succeeded: number; duplicated: number; failed: unknown[] }>` 收紧为 `ActionResult<GoluckyImportResult>`；4) `actions.ts` 移除 `createClient` import，三个 Action 改为调用 Repository 方法，保留 requireActiveAuth、Zod 输入校验、中文错误、revalidatePath 不变；5) **返工修复**：三个 Action catch 块对 `ExternalTrackingError` 直接返回 `err.message`（避免"重激活失败：重激活失败：..."重复前缀），仅对未知异常使用 Action 级兜底前缀。未修改 00001–00052 Migration。未处理 sync/server-actions.ts 或其他模块。测试：`p0-golucky.test.ts` 32 个新增 `it()` + 2 个旧测试删除/替换（净增 30 项）+ `actions-behavior.test.ts` 新增 7 项行为测试，合计净增 37 项测试并替换 2 个旧测试，覆盖 Repository 边界静态检查（RPC 名称/参数/参数映射/requireActiveAuth/revalidatePath 回归）、Repository RPC Mock 行为（DB 错误/非法返回结构）和 Action ExternalTrackingError 不重复前缀行为。in-transit 229/229（4 文件）通过。`npm run test` 4012/4013，1 个既有失败：`opt6-production-apply.test.ts` "embeds the canonical migration body byte-for-byte"（绑定 00051 Migration 及 Production apply SQL packet，均未被本任务修改）。`dry-run.live.test.ts` 被 `npm run test` 明确排除，不计入质量门。lint --max-warnings 0: 0 errors / 0 warnings，build pass（保留既有 sync/server-actions.ts NFT trace warning），git diff --check pass。不修改 Migration，不执行 Staging/Production 写入。

- `P3-S5A` — 手动确认入仓事务与库存联动（2026-06-30 **DONE**，2026-06-30 **返工完成**，2026-06-30 **Migration 00023 已执行并验证**）。Migration 00023 新增 `warehouse_shipment_transactional` RPC（SECURITY INVOKER，Admin-only）。**返工修复**：① v_shipment record 变量替代重复 INTO 目标 + IF NOT FOUND 判断；② 库存写入改为原子 `INSERT ... ON CONFLICT (variant_id, warehouse_id) DO UPDATE SET quantity = inventory.quantity + EXCLUDED.quantity` 替代旧 select-then-insert；③ 详情页抽取 `canWarehouseShipment` / `warehouseBlockReason` 统一判断，修复 customs + 无仓库不显示原因的 bug。同事务内：SELECT shipment FOR UPDATE → IF NOT FOUND / 校验非 warehoused / warehouse_id IS NOT NULL / customs → FOR shipment_item FOR UPDATE（逐行 remaining > 0 超量保护）→ 原子 UPSERT inventory → UPDATE shipment_item.warehoused_quantity = quantity → UPDATE shipment.status = 'warehoused' → INSERT tracking_event。Repository `warehouseShipment()` → Actions `warehouseShipment()` Admin-only + Zod → UI `WarehouseShipmentButton` Dialog 二次确认。104 项测试（8 Zod + 6 变量绑定 + 7 原子 UPSERT + 10 业务规则 + 9 入库操作 + 11 详情页 canWarehouseShipment/warehouseBlockReason + 13 按钮组件 + 7 仓库行为 + 13 actions + 10 仓库/actions 源码检查）。全量 1793/1793 测试（51 文件，concurrency/best live 预存失败），lint 0 errors / 25 warnings（all pre-existing），build pass。**Migration 00023 已在 Supabase SQL Editor 手动执行并验证通过**：no_duplicate_into=true / has_not_found_check=true / has_atomic_upsert=true / checks_warehouse_id=true / checks_customs_only=true / admin_only=true。）

- `P3-S6` — 在途模块权限、RLS 与端到端验收（2026-06-30 **DONE**，源码级权限/RLS/架构审计 + mock 行为测试）。权限链路矩阵：9 个 Server Action 全部 requireActiveAuth + Zod + 中文错误传播，5 个写操作 Admin-only，4 个读操作 Admin/Operator 均可。Repository 13 个方法通过 createClient() RLS session + ShipmentError 四类错误码。RLS 46 条策略全部启用，shipment/shipment_item/tracking_event/inventory 四表三层防御（Server Action → Repository warehouseAccessRepository → PostgreSQL RLS policies + RPC SECURITY INVOKER）。页面 3 个 + 客户端组件 5 个均无直接 supabase.from()/supabase.rpc()。边界状态全覆盖（空数据/notFound/无权限/DB error/loading/error）。新增 161 项测试（9 类：Actions 权限源码检查 + Repository 仓库隔离源码检查 + RLS 策略存在性 + Arch 合规 + 边界状态 + 权限链路矩阵完整性 + Migration 权限 + 详情页入仓条件收口 + 创建页权限校验）。1955/1955 测试（52 文件），lint 0 errors / 25 warnings，build pass，git diff --check pass。不新增 Migration/功能/重构。**剩余风险**：未执行生产库真实 RLS 行为测试（仅源码级策略关键词检查），生产 RLS 策略实际行为依赖 Supabase Dashboard 已验证的 46 条策略。

- `P4-U1` — 用户数据层、邮箱字段与权限收口（2026-06-30 **DONE**，2026-07-01 **返工完成**）。修复 7 项数据层/权限问题：① `UserItem.email` 从 `auth.users.email` 获取（`createServiceClient().auth.admin.listUsers()` / `.getUserById()`），不再返回空字符串；② DB error 不再静默吞掉（Repository 全部 throw `UserError`）；③ actions 收口到 `requireActiveAuth` + `roleName !== 'admin'`；④ `updateUserRole` 自降级检查修正为查询目标 `roleId` 角色名（不再用当前 `targetUser.roleName`）；⑤ 新增最后管理员保护（降级/禁用均拦截）；⑥ 新增 `listUsers` / `getUserById` Server Actions；⑦ `updateRole`/`toggleActive` 改为 `Promise<void>`。`service_role` 仅在 repository 内部 email helper（`fetchEmailMap` / `fetchUserEmail`）中使用。**返工修复 5 项真实行为风险**：① `fetchEmailMap` 的 `auth.admin.listUsers()` error 不再 `break` 静默返回空 Map，改为 throw `UserError`；② `fetchUserEmail` 的 `auth.admin.getUserById()` error 不再返回空字符串，改为 throw `UserError`（auth user 不存在时无 error 返回 `''` 并附注释）；③ `updateRole`/`toggleActive` 增加 `.select('id').single()` 确认行存在，0 行 → `UserError('NOT_FOUND', '用户不存在')`；④ `countByRole` 改为两步查询（先查 role 表 roleId → 再 count profiles.role_id），不再使用未 join 的 `.eq('role.name', ...)`，roleError PGRST116 → return 0，DB error → throw；⑤ `getRoleName` 区分 PGRST116（角色不存在 → null）与真实 DB error（throw）。新增 13 项行为/源码测试（63 项 total）。2018/2018 tests（53 文件），lint 0 errors / 24 warnings（pre-existing），build pass。不新增 Migration。P4-U2 已解除阻塞。

- `P4-U2` — 用户列表只读页面（2026-07-01 **DONE**，2026-07-01 **返工完成**）。`src/app/dashboard/users/page.tsx` 替换占位页为真实只读列表（Server Component）：Admin 可访问，Operator 显示无权限。数据经 `listUsers`/`listRoles`/`getUserById` Server Actions 获取，页面和组件不直接调用 Supabase/service_role。列表列：邮箱、显示名、角色 Badge、状态 Badge、创建时间、用户 ID（短显示）。筛选：状态（全部/启用/禁用）+ 角色（全部/管理员/运营），通过 URL searchParams 实现；分页：20 条/页，上一页/下一页。行点击 → `UserDetailSheet`（Sheet 组件）：加载 Skeleton → 获取 `getUserById` → 只读展示（邮箱、显示名、角色、状态、创建时间、ID），无修改角色/启用禁用等写操作按钮。新增 `listRoles` Server Action + repository 方法。`src/features/users/p4-u2.test.ts` — 42 项测试（架构合规 + 权限 + 只读 + 筛选/Zod + UI 状态 + 详情 Sheet + listRoles + P4-U1 回归）。**返工修复**：`listRoles` 失败时不再静默降级为空数组（`rolesResult.success ? ... : []`），改为 throw error 交给页面 error boundary 处理。2060/2060 tests（54 文件，concurrency 与 best live 预存 env 依赖），lint 0 errors / 24 warnings（all pre-existing），build pass，git diff --check pass（LF/CRLF warning only）。不新增 Migration。P4-U3 修改角色已解除阻塞。

- `P4-U3` — 修改用户角色（2026-07-01 **DONE**）。在 `UserDetailSheet` 详情 Sheet 中新增"修改角色"按钮。单击后弹出 `UserRoleChangeDialog` 确认对话框：选择新角色（过滤当前角色避免重复提交）、提交中显示 Loader2 pending 状态、失败展示中文错误。成功后关闭 Sheet 并 `router.refresh()` 刷新页面列表。复用现有 `updateUserRole` Server Action（Admin-only + 自降级保护 + 最后管理员保护），不新增 Migration。新增 `src/features/users/components/user-role-change-dialog.tsx`。`src/features/users/p4-u3.test.ts` — 36 项测试（架构合规 + 导入控制 + Dialog 行为 + Sheet 集成 + 透传 + 权限 + P4-U1/P4-U2 回归）。2096/2096 tests（55 文件，concurrency 与 best live 预存 env 依赖），lint 0 errors / 24 warnings（all pre-existing），build pass，git diff --check pass。不新增 Migration，不实现启用/禁用，不实现仓库分配。P4-U4 启用禁用已解除阻塞。**P4-UX（2026-07-03）覆盖**：原实现关闭 Sheet + `router.refresh()`；P4-UX 后改为 `getUserById` 局部刷新 Sheet + `onUserChanged` 通知父组件，不再关闭 Sheet、不整页刷新。

- `P4-U4` — 启用/禁用用户账号（2026-07-01 **DONE**）。在 `UserDetailSheet` 详情 Sheet 状态行新增"启用"/"禁用"按钮。单击后弹出 `UserActiveToggleDialog` 确认对话框（shadcn/ui Dialog）：区分启用/禁用文案、提交中 Loader2 pending 状态、失败展示中文错误。成功后关闭 Sheet 并 `router.refresh()` 刷新页面列表。复用现有 `toggleUserActive` Server Action（Admin-only + 自禁用保护 + 最后管理员保护），不新增 Migration，不实现仓库分配，不修改权限模型。新增 `src/features/users/components/user-active-toggle-dialog.tsx`。`src/features/users/p4-u4.test.ts` — 29 项测试（架构合规 + 导入控制 + Dialog 行为 + Sheet 集成 + 权限 + P4-U1/P4-U2/P4-U3 回归）。2125/2125 tests（56 文件，concurrency 与 best live 预存 env 依赖），lint 0 errors / 24 warnings（all pre-existing），build pass，git diff --check pass。P4-U5 用户模块安全与流程验收已解除阻塞。**P4-UX（2026-07-03）覆盖**：原实现关闭 Sheet + `router.refresh()`；P4-UX 后改为 `getUserById` 局部刷新 Sheet + `onUserChanged` 通知父组件，不再关闭 Sheet、不整页刷新。

- `P4-U5` — 用户模块安全与流程验收（2026-07-01 **DONE**，2026-07-01 **返工完成**，2026-07-01 **Migration 00024/00025 已执行并 smoke test 通过**）。安全审计发现最后活跃管理员保护存在 TOCTOU 竞态条件：`updateUserRole` 和 `toggleUserActive` 的 countByRole 检查与数据库写入非原子，两个管理员可互相禁用/降级导致 0 管理员。**首次修复**：新增 Migration 00024（`update_user_role_protected` / `toggle_user_active_protected` RPC），使用 `pg_advisory_xact_lock` 序列化 Admin 写操作 + `FOR UPDATE` 行锁 + SECURITY INVOKER。**返工修复**：新增 Migration 00025（不修改 00024）解决 RPC 直接调用权限缺口：① RPC 内部新增 `auth.uid()` 身份绑定（IS NOT NULL / = p_operator_user_id / 活跃 Admin 校验），非 Admin → RAISE EXCEPTION 中文错误；② REVOKE EXECUTE FROM PUBLIC, anon + GRANT EXECUTE TO authenticated；③ 新增 `check_operator_profile_update` BEFORE UPDATE 触发器，禁止 operator 通过 UPDATE 直接修改自己的 role_id / is_active。Repository `updateRole()` / `toggleActive()` 改为调用 RPC，Actions 简化为 Auth + Zod + RPC 调用。Migration 静态契约测试从 25 → 49 项（新增 auth.uid 绑定 / REVOKE/GRANT / trigger 测试）。2174/2174 tests（57 文件，concurrency 与 best live 预存 env 依赖），lint 0 errors / 24 warnings（all pre-existing），build pass，git diff --check pass。不新增业务功能，不实现仓库分配，不修改权限模型。Phase 4 用户管理全模块完成。

- `P4-UX` — 用户管理页局部刷新收口（2026-07-03 **DONE**）。移除 `UserDetailSheet` 内 `useRouter` / `router.refresh()`，P4-U3/P4-U4 成功后改为 `getUserById(userId)` 局部刷新 Sheet 详情 + `onUserChanged?.()` 通知父组件（不再关闭 Sheet、不整页刷新）。`UsersPageContent` 新增 `users`/`localTotal` 本地 state + `useEffect` 同步 `data`/`initialTotal` props（筛选/分页导航后覆盖旧数据）+ `handleUserChanged` callback 通过 `listUsers` 局部刷新列表。保留 `useRouter` 仅用于筛选/分页 `router.push` 导航。p4-u2.test.ts 新增 8 项 P4-UX 断言（useEffect + props 同步 + 无 router.refresh + onUserChanged + 导入控制 + handleUserChanged + useRouter 仅导航）。全量 2660/2660 tests（63 文件），lint 5 errors / 25 warnings（all pre-existing），build pass，git diff --check pass。不修改 Server Actions、Repository、Migration、RLS、权限模型。

- `P3-S5B0` — 封存旧版 00023 入仓入口（2026-07-02 **DONE**）。`warehouseShipment()` Server Action 改为阻断桩（保留签名，返回 `{ success: false, error: '旧版入仓入口已停用。请使用新的确认到仓流程。' }`，不调用 requireActiveAuth / repository / RPC / revalidatePath）。详情页隐藏 `WarehouseShipmentButton`（import 移除、渲染移除、`canWarehouseShipment` 变量保留供 P3-S5B3）。新增 `p3-s5b0-block-old-path.test.ts`（20 项测试：阻断桩行为 8 + 详情页不渲染按钮 5 + 函数体不含旧路径调用 7）。P3-S5A 和 P3-S6 测试已适配阻断行为。全量 2185/2186 测试（concurrency 预存失败），lint 5 errors / 27 warnings（all pre-existing），build pass，git diff --check pass。**2026-07-02 收口返修**：`warehouseShipment` 函数体新增 `void _formData;` 消除 lint warning；p3-s5a 测试中"导入 WarehouseShipmentButton"用例改为验证不 import 且不渲染（非注释匹配）。不修改 Migration 00023，不实现 P3-S5B1~B5。

- `P3-S5B1` — Migration 00026 + types/schema + migration tests（2026-07-02 **DONE**，2026-07-02 **返修完成**）。Migration 00026：`shipment.bigseller_absorbed_at TIMESTAMPTZ NULL` 列 + `partial_warehouse_shipment` RPC（173 行，SECURITY INVOKER，Admin-only）。**返修**：RPC 输入预检加固 — jsonb_typeof 校验 p_items array + elem object → 正则预检 variant_id UUID / quantity 正整数 → 安全 cast → 所有失败路径中文 RAISE EXCEPTION（不泄漏 PG 英文 cast 错误）。核心逻辑：FOR UPDATE 锁定 shipment/shipment_item → 逐行累加 warehoused_quantity → 全部入仓 status='warehoused' → tracking_event 区分 warehoused/partial_warehoused → RETURN JSONB。**不写 inventory**。database.ts 同步 `bigseller_absorbed_at` 列 + `partial_warehouse_shipment` 函数签名。feature types 新增 `PartialWarehouseItem` / `PartialWarehouseShipmentData` / `PartialWarehouseResult` + Zod schema（`partialWarehouseItemSchema` / `partialWarehouseShipmentSchema` 含重复 SKU 检测）。93 项静态契约测试（15 组：文件结构 / 权限模型 / Admin-only / 参数签名 / shipment 校验 / jsonb_typeof 预检 / elem 结构预检 / shipment_item 校验 / 原子写入 / 不写 inventory / 中文错误 ≥15 条 / JSONB 返回 / types.ts / schema.ts / database.ts）。全量 2268/2268 测试（59 文件），lint 5 errors / 26 warnings（all pre-existing），build pass，git diff --check pass。**Migration 00026 已于 2026-07-02 手动执行并验证通过**（bigseller_absorbed_at 列 + partial_warehouse_shipment RPC + 权限）。不实现 Repository/Actions/UI。

- `P3-S5B2` — Repository 方法 + Server Actions（2026-07-02 **DONE**，2026-07-02 **返修完成**）。Repository 新增 5 个方法：`partialWarehouse()` 调用 partial_warehouse_shipment RPC（snake_case→camelCase 映射 + ShipmentError 中文错误传播）、`listEligibleForBatchWarehousing()` 查询 customs+有仓库的 shipments（Admin/Operator 仓库隔离）、`getConfirmedWarehousedQuantity()` 两步聚合（shipment→shipment_item）、`getConfirmedWarehousedByWarehouse()` 按 variant 聚合仓库已确认入仓、`confirmBigsellerAbsorption()` UPDATE bigseller_absorbed_at（仅 warehoused + 未确认）。Actions 新增 3 个：`partialWarehouseShipment()` Admin-only + Zod + RPC + revalidate、`batchWarehouseShipments()` Admin-only + Zod + 逐笔串行（单笔失败不影响后续）、`confirmBigsellerAbsorption()` Admin-only + UUID Zod + Repository + revalidate。**不写 inventory.quantity**，不调 00023 RPC。types 新增 `BatchWarehouseEntry` / `BatchWarehouseData` / `BatchWarehouseItemResult` / `EligibleShipmentFilters` / `EligibleShipmentItem` / `ConfirmedWarehousedAggregation`。schema 新增 `confirmBigsellerAbsorptionSchema` / `batchWarehouseShipmentsSchema`。**返修**：`getConfirmedWarehousedQuantity()` / `getConfirmedWarehousedByWarehouse()` shipment 查询新增 `.or()` 过滤，仅纳入 `status='customs'` 或 `(status='warehoused' AND bigseller_absorbed_at IS NULL)`，已确认 BigSeller 吸收的 warehoused shipment 不再计入已确认到仓聚合。87 项测试（10 组：partialWarehouse RPC 行为 / listEligible 源码检查 / getConfirmedWarehousedQuantity 含口径分支 / getConfirmedWarehousedByWarehouse 含口径分支 / confirmBigsellerAbsorption 行为 / 3 个 actions / Schema 校验 / 静态源码检查）。权限审计测试适配（9→12 actions）。全量 2367/2367 测试（60 文件），lint 5 errors / 26 warnings（all pre-existing），build pass，git diff --check pass。不实现 UI。

- `P3-S5B3` — 详情页双模式按钮 + PartialWarehouseDialog + BigsellerAbsorptionButton（2026-07-02 **DONE**，2026-07-02 **收口返修**）。在 `page.tsx` 操作区新增双模式按钮：`PartialWarehouseEntry`（Admin + customs + warehouse_id 时渲染）→ 打开 `PartialWarehouseDialog`（shadcn/ui Dialog + 产品明细表格/数量输入/全额确认一键填入/Zod 前端校验/字段级错误）；`BigsellerAbsorptionButton`（Admin + warehoused + bigseller_absorbed_at IS NULL 时渲染）→ 确认 Dialog + `confirmBigsellerAbsorption` action。移除 `canWarehouseShipment` 冗余变量，保留 `warehouseBlockReason`（无仓库/非 customs 时展示原因）。**返修**：`PartialWarehouseEntry` 渲染条件新增 `shipment.warehouse_id` 检查（无仓库时仅显示 blockReason，不渲染可点击按钮）；`PartialWarehouseDialog` 前端校验重写 — 移除 `parseInt` 静默截断，改用原始字符串存储 + `partialWarehouseItemSchema` Zod 校验 + 小数/负数/零/超量中文错误 + 字段级 `fieldErrors` 逐行展示。新增 11 项源码测试（warehouse_id 条件断言 + dialog 校验源码检查）。全量 2381/2381 测试（60 文件），lint 5 errors / 26 warnings（all pre-existing），build pass，git diff --check pass。不实现批量 UI/海外库存列（P3-S5B4），不改 Migration。

- `P3-S5B4` — 批量入仓 UI + 海外库存"已确认到仓"列（2026-07-02 **DONE**，2026-07-02 **返修完成**）。**批量入仓 UI**：新建 `/dashboard/shipments/batch` 路由（Server Component Admin-only + `BatchWarehousePage` 客户端组件）。列表展示 customs + 已分配仓库的 eligible shipments（复用 `listEligibleForBatchWarehousing`），支持选择/全选/展开查看产品明细（`getShipmentDetail` 按需加载）。每行展开后显示产品明细表格，支持数量输入 + 字段级校验（`validateEntry`：小数/负数/零/超量中文错误）+ "全额确认"一键填入在途余量。批量提交调用 `batchWarehouseShipments` action（逐笔串行，单笔失败不影响后续），提交结果显示每笔成功/失败，已成功 shipment 自动从选中列表移除并刷新。空数据/加载/错误/提交中状态完整覆盖。分页 20 条/页。新增 `listEligibleForBatchWarehousingAction` Server Action（Admin-only + `eligibleShipmentFiltersSchema` Zod 校验（country enum/warehouseId uuid/page coerce int min(1)/pageSize coerce int min(1) max(100)）+ `safeParse` 失败返回中文错误不进入 repository + 仓库隔离）。**海外库存"已确认到仓"列**：`getOverseasInventory` action 新增每仓并行查询 `getConfirmedWarehousedByWarehouse`（单仓失败不阻塞页面），返回 `confirmedMap`（warehouseId→variantId→confirmedQuantity）。`OverseasPageContent` 表格新增"已确认到仓"列，从 `confirmedMap` 读取对应行的已确认数量，仅展示 customs 或 warehoused + bigseller_absorbed_at IS NULL 的 DIS 确认事实。展开行 colSpan=13（与表头 13 列一致）。**侧边栏**：物流组下新增"批量入仓"链接（`PackageCheck` 图标，Admin-only）。70 项源码级测试（海外库存数据层 14（含表头列数/colSpan 校验）+ 批量页 Server Component 5 + Client Component 33 + listEligible Action 9（含 safeParse/Zod 错误）+ Zod schema 6 + 侧边栏 5 + 架构合规 4）。权限审计测试适配（actions 计数 12→13）。**不写 inventory.quantity**，不调 00023 RPC，不新增 Migration。返修质量门：shipments 890/890（14 文件），全量 2452/2452（61 文件），build pass，lint 5 errors / 26 warnings（all pre-existing）。


- `PERF-B1` — DIS 性能优化 Phase B 第一轮：request-scope cache + dashboard layout 接入（2026-07-04 **DONE**，收口修复完成。6 个文件：`src/lib/auth.ts` 新增 `cachedGetAuthProfile` React `cache()` 合并 auth + profile 查询；`src/app/dashboard/layout.tsx` 替换直接 Supabase 调用为 `getCurrentUser()`；`src/features/shipments/repository.ts` `getUserRole` 包裹 `cache()`；`src/features/warehouse-access/repository.ts` 新增 `cachedGetAccessibleWarehouseIds`；`src/features/variants/repository.ts` 新增 `cachedGetUserArchivedVariantIds`；`src/lib/auth.test.ts` PGRST116 行为测试。质量门：全量 2754/2754 + 1 项 PGRST116 测试，build pass，lint 5 errors / 25 warnings（all pre-existing）。残余风险：React `cache()` 仅在单次 render/Server Action 内共享缓存，跨 render→action 不共享；Phase C 如需跨边界缓存需评估 `AsyncLocalStorage` 方案。下一步：Phase C（页面查询并行重排）/ Phase D（同步页分页）/ Phase E（索引优化），建议 Phase C 优先。）
- `PERF-C1` — Dashboard 首页查询并行重排（2026-07-04 **DONE**。`src/app/dashboard/page.tsx` 使用 `Promise.all` 并行执行 `getOverseasStats` / `getInTransitByVariant` / `getFollowedVariantsBasic` / `getLowStock` 四个独立查询，每个保留独立 `.catch()` 错误处理。`src/features/inventory/p2-d2-low-stock-summary.test.ts` 新增 10 项并行编排测试。全量测试通过，build pass。仅限 Dashboard 首页；产品页/海外库存 actions/同步页分页/索引未开始。下一步：PERF-C2 或其他未阻塞任务。）
- `P6-CSV-EXPORT` — 海外库存 CSV 导出（2026-07-07 **DONE**。新增 `exportOverseasInventoryCsv` Server Action + `toCsv()` 纯函数 + 导出按钮，36 项测试。在途数据按 (variantId, warehouseId) 回填。2998/2998 测试、build pass、lint 0/25。）
- `NEXTJS16-PROXY-MIGRATION` — middleware.ts 迁移至 proxy.ts（2026-07-08 **DONE**。`src/middleware.ts` → `src/proxy.ts`，函数 `middleware` → `proxy`，matcher 不变，cookie/session 刷新逻辑完全不变。21 项新测试。3018/3019 测试（1 预存失败：WEBSYNC_REAL_WRITE_ENABLED=true）、build pass 且 middleware deprecation warning 消失、lint 0/25。）
- `P6-OVERSEAS-PRODUCT-NAME-VISIBILITY` — 海外库存产品名称显示修正（2026-07-08 **DONE**。表格列顺序：产品名称移到 SKU 前；productName 为空显示"未匹配产品"+"未匹配"黄色 Badge；34 项新测试。3052/3053 测试、build pass、lint 0/25。）
- `P6-OVERSEAS-INVENTORY-UI-CLARITY` — 海外库存 UI 清晰度优化（2026-07-08 **DONE**。全阶段 A~D：① 已确认到仓列从主表移除 + colSpan 13→12；② 未匹配行"绑定产品"UI 占位按钮；③ 展开物流明细新增 tracking_event.occurred_at 最近物流更新时间；④ 筛选器中文化（全部国家/仓库/状态）；⑤ 统计卡片可点击 + scroll:false 防跳顶。40 项新测试。3090/3091 测试、build pass、lint 0/26。）
- `P6-OVERSEAS-INVENTORY-UX-V2 A+C` — BigSeller 风格分页 + 筛选状态可见化（2026-07-08 **DONE**。① 新建 `src/components/ui/pagination.tsx` 通用分页组件（页码按钮 + 省略号 + 每页 20/50/100 + 上一页/下一页）；② `overseas-page-content.tsx` 接入 Pagination + 筛选标签（国家/仓库/状态/搜索各带 X 清除 + 清空筛选）；③ `page.tsx` 解析 pageSize searchParam（仅 20/50/100 有效）；④ buildUrl 支持 pageSize（变更重置 page=1，默认 20 不写入 URL）。48 项新测试。3138/3139 测试、build pass、lint 0 errors。）
- `P6-OVERSEAS-INVENTORY-UX-V2 B` — 统计卡片真实联动列表（2026-07-08 **DONE**。① 审计并强化 handleStatCardClick：库存总量/SKU 数量 → 清空所有筛选（裸路径）；低库存 → buildUrl({ stockStatus: 'low' })保留 pageSize、page 回到 1；所有导航 scroll: false。② 在途库存卡片显式注释不可点击原因（shipment 聚合非 inventory 筛选维度，需后端扩展），不制造无效跳转。③ 低库存点击后筛选标签"状态：低库存"可见（C 已实现）。④ 18 项新测试。3159/3160 测试、build pass、lint 0 errors。）
- `P6-OVERSEAS-INVENTORY-UX-V2 D` — 真实产品绑定（2026-07-08 **DONE**。① 新建 `searchProducts` Server Action（requireActiveAuth，仅返回启用产品）；② 新建 `bindOverseasVariant` Server Action（requireActiveAdmin + Zod variantMatchSchema → variantRepository.match → revalidatePath + router.refresh）；③ 新建 `BindProductDialog` 组件（搜索→选择→确认绑定，loading/empty/error 中文状态）；④ `overseas-page-content.tsx` 替换 toast 占位为真实 Dialog；⑤ 49 项新测试。不新增 Migration/RPC/RLS，不绕过 Repository，不破坏 Product→ProductVariant→Inventory 模型。3208/3209 测试、build pass、lint 0 errors。）
- `P6-OVERSEAS-INVENTORY-UX-V2 D 返工` — 字段语义修正 + 搜索增强 + 写后校验（2026-07-08 **DONE**。① **字段语义修正**：新增 `InventoryItem.variantName`（BigSeller 原始品名 = product_variant.name）、`standardProductName`（DIS 标准产品名 = product.name）、`standardProductCode`（DIS 标准产品编码 = product.code）。`productName` 保持向后兼容但语义改为 BigSeller 品名。海外库存列表主品名列显示 BigSeller 品名，标准产品名仅作为辅助信息展示。matched + standardProductName 为空 → "已匹配标准品缺失"。Migration 00034 新增 `get_overseas_inventory` / `get_low_stock` RPC 返回 `v.name AS variant_name`。② **搜索增强**：`searchProducts` 改用 `productRepository.search` 分词搜索（按空格/连字符/下划线/斜杠/括号拆 token → 每个 token ILIKE code + name → 同时通过 product_variant.sku 反向查找 Product → 仅返回启用产品 → escapeLike 防止破坏 .or() 语法）。Migration 00035：RPC 搜索升级为分词 AND 语义（`regexp_split_to_array` → `unnest` → `NOT EXISTS` + COALESCE），支持"水杯 玻璃"匹配"玻璃水杯"。③ **写后校验**：`bindOverseasVariant` 成功后读回 variant.getById 校验 product_id / match_status / 关联 product 可读，失败返回中文错误不假成功。④ 新增 60+ 项测试。3269/3270 测试、build pass、lint 0 errors / 25 warnings（all pre-existing）。）
- `P6-OVERSEAS-INVENTORY-UX-V2 搜索性能 + 列宽拖拽修复`（2026-07-08 **DONE**。① **搜索性能**：Migration 00036 启用 pg_trgm 扩展 + 为 product_variant.sku/name 和 product.name/code 建 GIN trigram 索引，加速 ILIKE '%keyword%' 模糊搜索。不修改 00034/00035，不改变搜索逻辑/函数签名/RLS/权限模型。00035 解决搜索准确性（连续子串 + 分词 AND），00036 通过 trigram index 优化性能。未来数据量继续增大时再考虑 dedicated search_vector / materialized search_text。② **列宽拖拽修复**：表格改为 tableLayout fixed + totalTableWidth 控制；resize handle 从透明 w-1.5 改为可见分隔线（w-6 命中区 + w-px 竖线，默认灰 hover/drag 蓝，title/aria-label）；封装 ResizeHandle 组件消除重复；新增 activeResizeKey 高亮拖拽中列；未匹配分支保持 flex w-full min-w-0 + badge/button shrink-0。）
- `P6-RECOVERABLE-FIX` — 海外库存页 Recoverable Error 修复（2026-07-10 **DONE**。**根因**：`page.tsx` Server Component 将原始 URL searchParams 直接传给 `getOverseasInventory()`，其中 `warehouseId`（`z.string().uuid()`）、`country`（`z.enum(...)`）、`stockStatus`（`z.enum(...)`）遇到非法值（如 `warehouse=all`、`country=undefined` 等旧 URL/书签参数）时 Zod `safeParse` 失败 → `throw new Error('筛选参数校验失败')` → Server Component 渲染抛错 → Suspense 边界兜底为浏览器"Recoverable Error"。**修复**：在 `page.tsx` 新增 4 个轻量 normalize 函数（`normalizeCountry`/`normalizeStockStatus`/`normalizeWarehouse`/`normalizeSearch`），在调用 `getOverseasInventory` 前清洗 URL 参数（非法值 → `undefined`），清洗后的值同时传给客户端 `filters` prop 避免 UI 再次带出坏 query。不改 repository/schema/Migration/RPC/RLS，不修改库存查询业务口径。保留完整 `InTransitDetailRow` mini-table（物流状态标签 + overflow-x-auto + min-w-[760px]）。32 项新测试。3348/3354 测试（6 pre-existing failures 非本任务引入）、build pass、lint 0/25、git diff --check pass。）

- `P6-UX-IN-TRANSIT-OPTIMIZATION` — 在途明细 mini-table UI 优化 + 交互重做（2026-07-10 **DONE**。① UI 优化：全部左对齐、固定列宽 `grid-cols-[220px_180px_120px_260px_180px_28px]`、更轻边框 `border-gray-100`、更紧凑间距 `px-3 py-1.5`。② 交互重做：整行从 `<Link>` 改为普通 `<div>`（不再整行可点击），最后一列独立 `<Link>` + `<ExternalLinkIcon>`（text-gray-400 → hover:text-blue-600），`aria-label="查看物流详情"` + `title="查看物流详情"`。匹配 FollowedProductsSection 跳转模式。不改 Migration/RPC/RLS/Repository/Server Action。34/34 测试通过。）

- `P7-PLAN` — 标准产品总看板前置方案与任务文档落地（2026-07-10 **DONE**，Codex 复验通过。只读方案梳理：数据关系图、可复用 RPC/Repository/Server Action/UI 组件、3 项已知技术债（国内库存/生产周期/运输周期）、P7-MVP 范围与不做项、2 阶段任务拆分。文件范围：`docs/tasks/current-task.md`（完整 P7 任务包）+ `docs/current-state.md`（Current Phase/Task 同步）。未修改源码/测试/Migration/RPC/RLS。）

- `P7-V4-MERGE` — P7 与作战室合并为单一产品「全球库存总览」（2026-07-12 **DONE**，方案层）。将 P7 全球库存基础总览与作战室（原 P2）预测增强层合并：统一产品定位（P7-A 基础总览 + P7-B 作战室增强层）、统一唯一路由 `/dashboard/products/overview`、统一列表 RPC `get_product_overview`、统一详情 RPC `get_war_room_variant_detail`、解除 `BLOCKED_BY_DOMESTIC_INVENTORY`（海外先行、国内占位）、统一实施顺序 P7-A→P1→P7-B→P8→P7-C。同步文件：`DIS-全球库存作战室-实施方案.md`（升 v4 合并整合）、`DIS-实施总顺序方案.md`（§1/§3 重排 + 里程碑 M0–M5）、`docs/current-state.md`、`docs/tasks/current-task.md`。未修改源码/测试/Migration/RPC/RLS；待 Codex 终审通过后交 Claude 实施。

- `P7-PRODUCT-LIST-EXPAND` — 产品列表展开行与编辑 Sheet 体验增强 + 表头列宽拖拽伸缩（2026-07-10 **DONE**，Codex 复验通过。含一轮视觉返工 + 列宽拖拽 + 多轮视觉调整。① 产品列表表格新增展开/收起按钮，展开后显示 SKU 绑定明细（国内 SKU + 海外仓 SKU 统一表含国家/SKU/仓库产品名/匹配状态/最后同步列），复用现有匹配状态 badge 和时间格式。② 编辑 Sheet 产品编码不再 disabled；后端 updateProduct + repository.update 支持更新 code，含重复编码校验（应用层预检 + DB 23505 兜底）。③ 编辑 Sheet 内新增 SKU 绑定展示区（只读，add 模式不展示）。④ ProductItem 新增 bindings?: ProductSkuBindingSummary；productRepository.list() 批量查询 product_variant 代替仅做计数。⑤ 视觉返工：编辑 Sheet 宽度修复为 760px（`!max-w-[760px]` 覆盖默认 `sm:max-w-sm`）；Sheet 改为 Header / Body（独立滚动）/ Footer 三段式布局；SKU 绑定区改为统一表格（国家 badge + 等宽 SKU + 仓库产品名 truncate + 匹配状态/最后同步 whitespace-nowrap + overflow-x-auto）；列表展开行同步改为统一 SKU 表格 + 统计摘要行。⑥ 产品列表新增表头列宽拖拽伸缩栏（复用海外库存页 P6 交互模式，使用独立 `productsListColumnWidths` localStorage key 和产品列表专属列宽默认值 expand 44 / code 210 / name 320 / category 150 / safetyStock 120 / skuCount 120 / status 120 / actions 130；COL_MIN/COL_MAX 限制范围；ResizeHandle 模块级组件（w-6 命中区 + w-px 分隔线，hover/active 变蓝，双击恢复默认）；totalTableWidth 区分 Admin 含 actions（~1214px）/ Operator 不含（~1084px）；`<colgroup>` + `tableLayout: 'fixed'`；useEffect 延迟读取 localStorage 防 hydration mismatch。⑦ 多轮视觉调整：全字段统一左对齐（表头与单元格一致，操作按钮 justify-start）；容器结构改为双层 — 外层 `overflow-x-auto` 仅负责横向滚动，内层 `rounded-md border` 的 `style width/minWidth` 绑定 totalTableWidth 使边框只包住表格本体，宽屏右侧自然留白。不改 Migration/RPC/RLS，保持 Repository Pattern + Server Actions + RLS。文件范围：types.ts / repository.ts / actions.ts / product-form.tsx / products-page-content.tsx / product-detail-client.tsx / product-list-expand-bindings.test.ts。质量门：product-list-expand-bindings.test.ts 96/96（含列宽/对齐/容器结构断言）+ 产品模块 116/116 + 全量 3446/3452（6 个 P6 海外库存旧断言失败非本任务引入）、lint 0 errors / 25 warnings、build pass、git diff --check pass。）

- `TEAM-ACCOUNTS-SIDEBAR` — 团队账号侧边栏入口开放（2026-07-10 **DONE**。仅开放侧边栏入口，不修改用户模块核心业务逻辑。① `USERS_ITEM.phase` 从 `'4'` 改为 `'0'`，`renderItem(USERS_ITEM)` 直接渲染（移除 `phase: '4'` spread 覆写）；② Admin 侧边栏可点击「团队账号」→ `/dashboard/users`；③ Operator 侧边栏不显示「团队账号」（含在 `isAdmin` 条件守卫内）；④ `/dashboard/users` 页面权限逻辑不变：Operator 直接访问仍显示「仅管理员可访问用户管理」；⑤ 不改 users page.tsx、repository.ts、actions.ts、Migration、RPC、RLS。新增 8 项 sidebar-assertions 测试（P5-SY13B describe "侧边栏团队账号入口"：团队账号存在 / phase='0' / href / 无 P4 标记 / isAdmin 守卫 / Operator 隔离 / 仓库分配不变 / 国内库存灰显不变）。质量门：warehouse-access 191/191 + users 227/227 + 全量 3454/3460（6 个 P6 预存失败非本任务引入）、lint 0 errors / 25 warnings、build pass、git diff --check pass。修改文件：`src/app/dashboard/_components/sidebar-nav.tsx`（USERS_ITEM phase + renderItem 调用）、`src/features/warehouse-access/p5-sy13b.test.ts`（+8 项新断言）、`docs/current-state.md`。）

- `QUALITY-GATE-FIX-P6-ASSERTIONS` — 全量测试恢复通过（2026-07-10 **DONE**。修复 6 个 P6 旧断言失败，根因为 P6-UX-IN-TRANSIT-OPTIMIZATION 后 UI 结构调整导致测试过时。① `p6-product-name-visibility.test.ts`：3 处 span 匹配修复 — TableHead 内 span 现含 `className="block min-w-0 truncate overflow-hidden"`，旧正则 `<span>标签</span>` 改为 `<span[^>]*>标签</span>`（含表头标签提取逻辑同步修复）；② `p6-ux-v2-d-bind-product.test.ts`：3 处 unmatched 分支断言更新 — 外层容器从 `flex w-full min-w-0 items-center` 改为 `flex flex-col min-w-0`（纵向两行布局）、品名 span 从 `min-w-0 flex-1 truncate` 改为 `block min-w-0 truncate`、badge `shrink-0` 上下文窗口从 200 扩至 350 chars。不改业务逻辑、Repository、Server Action、Migration、RPC、RLS。质量门：3460/3460 测试（0 failures）、lint 0 errors / 25 warnings、build pass、git diff --check pass。修改文件：`src/features/inventory/p6-product-name-visibility.test.ts`（3 处）、`src/features/inventory/p6-ux-v2-d-bind-product.test.ts`（3 处）、`docs/current-state.md`。）

- `TEAM-ACCOUNTS-SELECT-CONTROLLED` — UserRoleChangeDialog Select controlled/uncontrolled 修复（2026-07-10 **DONE**。修复 `/dashboard/users` 页面 Base UI Select uncontrolled→controlled console warning。根因：`useState<string | undefined>()` 初始值为 `undefined`，选择角色后变为 role id 字符串触发 Base UI 警告。修复：`useState('')` 空字符串 sentinel 全生命周期保持 controlled；`resetAndClose` 中 `setSelectedRoleId(undefined)` → `setSelectedRoleId('')`；`onValueChange` 中 `v ?? undefined` → `v`。不改 updateUserRole / repository / RPC / Migration / RLS。不改用户权限逻辑（Admin-only 不变）。质量门：users 228/228 测试、全量 3460/3460 测试、lint 0 errors / 25 warnings、build pass、git diff --check pass。修改文件：`src/features/users/components/user-role-change-dialog.tsx`（3 处）、`src/features/users/p4-u3.test.ts`（2 处断言更新 + 1 新增）、`docs/tasks/current-task.md`（同步当前状态）、`docs/current-state.md`。）

- `SKU-MANAGEMENT-UNMATCHED-MERGE` — 待处理 SKU 并入 SKU 管理（2026-07-10 **DONE**。导航与信息架构收口，不涉及数据库和业务逻辑变更。① 侧边栏：移除独立的「待处理 SKU」入口，产品管理组仅保留「SKU 管理」；移除 `AlertTriangle` import；`/dashboard/variants/unmatched` 仍让 SKU 管理入口 active（`pathname.startsWith` 语义）。② 新增 `variants/layout.tsx`：统一标题「SKU 管理」+ 两个视图标签「全部 SKU」/「待处理 SKU」（样式与现有活跃/已归档/全部筛选一致）。③ 两个现有页面移除独立标题和 `px-6` 外层包装：`page.tsx` 保留活跃/已归档/全部筛选/搜索/分页/归档恢复逻辑；`unmatched/page.tsx` 保留说明文字/空状态/分页/getUnmatched 查询。④ 不改 ProductVariant 数据模型/查询口径/权限规则/匹配业务逻辑。⑤ Admin/Operator 均可查看两个标签，匹配/取消匹配仍仅 Admin，归档/恢复仍是用户偏好。测试：新增 27 项（sidebar-nav / layout.tsx / 页面标题去重 / 权限不变），p5-sy11g-e-ui 和 p5-sy13b 测试全部通过。质量门：3524/3524（0 failures）、lint 0 errors / 25 warnings、build pass、git diff --check pass。修改文件：`sidebar-nav.tsx`、`variants/layout.tsx`（新增）、`variants/page.tsx`、`variants/unmatched/page.tsx`、`p6-ux-v2-d-bind-product.test.ts`、`p5-sy11g-e-ui.test.ts`、`p5-sy13b.test.ts`、`docs/current-state.md`、`docs/tasks/current-task.md`。）

- `P6-OVERSEAS-PRODUCT-NAME-SIMPLIFY` — 海外库存产品名称列展示简化（2026-07-10 **DONE**。仅移除 matched 分支中标准产品辅助信息（"标准品：xxx"/"已匹配标准品缺失"），已匹配行直接显示单个 BigSeller 原始品名 span。未匹配分支完全不变（品名 + Badge + 绑定按钮）。标准产品字段、绑定关系、Repository 映射及权限均保持不变。质量门：3524/3524（0 failures）、lint 0 errors / 25 warnings、build pass、git diff --check pass。修改文件：`overseas-page-content.tsx`、`p6-ux-v2-d-bind-product.test.ts`、`p6-product-name-visibility.test.ts`、`p6-ui-clarity.test.ts`、`docs/current-state.md`、`docs/tasks/current-task.md`。）

## P6-OVERSEAS-INVENTORY-UX-V2 — 最终验收（2026-07-09 FINAL CLOSED）

### 自动化质量门

| 检查项 | 结果 |
|--------|------|
| `npm run test` | 3328/3328（0 failures） |
| `npm run lint` | 0 errors / 25 warnings（all pre-existing） |
| `npm run build` | Turbopack 通过，23 条路由正常（Turbopack tracing warning 为 Sync 模块既有技术债，不阻塞 P6） |
| `git diff --check` | 通过 |

### Migration 生产验证

| Migration | 内容 | 状态 |
|-----------|------|------|
| 00034 | RPC 增加 variant_name（BigSeller 原始品名） | ✅ 已执行，`prosrc LIKE '%variant_name%'` = true |
| 00035 | RPC 分词搜索（regexp_split_to_array + unnest + NOT EXISTS） | ✅ 已执行，`prosrc LIKE '%regexp_split_to_array%'` = true |
| 00036 | pg_trgm GIN trigram 索引（搜索性能优化） | ✅ 已执行并验证（2026-07-09，pg_trgm 扩展 + 8 个 trigram 索引） |

### 代码层验收

| 验收项 | 结果 |
|--------|------|
| 分页 20/50/100 | ✅ PAGE_SIZE_OPTIONS + URL 校验 |
| 筛选标签单清/全清 | ✅ 国家/仓库/状态/搜索各 × 清除 + 清空筛选按钮 |
| 低库存卡片联动 | ✅ handleStatCardClick('low') → stockStatus=low + scroll:false |
| 在途卡片不可点击 | ✅ StatCard 无 onClick + 显式注释原因 |
| Admin 产品绑定 | ✅ UI canBindProduct + Server Action requireActiveAdmin 双层保护 |
| Operator 无绑定 | ✅ UI 隐藏按钮 + Server Action requireActiveAdmin 拒绝 |
| Column Resize | ✅ tableLayout fixed + ResizeHandle 组件 + localStorage + hydration-safe |
| 搜索分词 | ✅ 连续子串 + tokenized AND（00035 NOT EXISTS + unnest）+ pg_trgm 索引（00036） |
| WEBSYNC_REAL_WRITE_ENABLED | ✅ 已恢复为 false |

### 非阻塞残余风险

| 风险 | 等级 | 说明 |
|------|------|------|
| 搜索无防抖 | 低 | `searchProducts` 每次键入触发 Server Action，产品数小时可忽略 |
| 绑定后 router.refresh | 低 | 保留筛选/分页/pageSize，不丢上下文 |
| Operator 无法绑定 | 设计 | 与 variantRepository.match 的 requireAdmin 一致 |
| E 仅计划 | 信息 | 产品看板长期方向已记录，等待用户激活 |

P6-OVERSEAS-INVENTORY-UX-V2 FINAL CLOSED。Migration 00034/00035/00036 全部生产已执行并验证通过，所有功能已实现并验收，质量门全部通过。

## P5-SY12C-RUNTIME — 生产运行时验证完成（2026-06-26）

P5-SY12C 阶段 C 动态告警已在生产环境验证通过：

1. **Migration 00014 手动执行成功**：已于 Supabase SQL Editor 执行 `00014_dynamic_alert_fields.sql`，`inventory.daily_sales` / `inventory.estimated_days` / `warehouse.lead_time_days` 列 + `CREATE OR REPLACE sync_warehouse_inventory` RPC 均生效。
2. **warehouse.lead_time_days 已写入**：5 个海外仓（PH/VN/TH/MY/ID）均设为 30。
3. **daily_sales / estimated_days 已写入**：5 个海外仓全部 inventory 行的 `daily_sales` 已按 BigSeller 抓取数据全部写入；`estimated_days` 已按 BigSeller 可用数据写入（部分 SKU 为空属正常，BigSeller 不提供可用天数时 sentinel 占位符或缺失字段均写入 NULL）。
4. **PH 仓 expired in_progress 已清理**：批量写入中 PH 仓出现过期 `in_progress`，已通过 `cleanup_expired_sync_runs()` 清理，无残留 `in_progress`。
5. **质量确认**：Dashboard 关注区动态告警正常运作（日销/可售天数/补货周期列 + alertLevel badge + 告警摘要）。

Migration 00013（preference_type `'favorited'` 扩展）已于 2026-06-25 手动执行。

P5-SY11-REWORK（P5-SY11G A~F）+ P5-SY11G-RUNTIME 已完成并通过验收（详见上方 Completed Tasks）。

**Current Task**: Stage 0 治理 — Stage 0A 审计完成（2026-07-13）。P6 全部已完成（P6-OVERSEAS-PRODUCT-NAME-SIMPLIFY DONE）。五份定稿方案（P0/P1/P7/首页/总顺序）已通过 Codex 终审。下一步进入 Stage 1 P0 喜运达物流轨迹 API 接入（Migration 00038–00040），P1/P7/首页严格串行后续。全量测试 3524/3524（0 failures）。P6-OVERSEAS-INVENTORY-UX-V2 FINAL CLOSED（2026-07-09）。P3-S1B（百世 API 恢复）BLOCKED_EXTERNAL。

### 同步验证状态

- **手动真实同步验证**：已连续 4/5 天正常（2026-07-09 更新）。今日（2026-07-09）用户已完成手动真实同步并通过写后验收。
- **WEBSYNC_REAL_WRITE_ENABLED=false**：手动真实写入入口已禁用（2026-07-09 写入完成后恢复，无活跃写入授权）。
- **自动同步启用前置条件**：需连续 5 天手动同步成功后，才进入自动同步评估。当前进度 4/5 天，自动同步仍未启用。

## Authentication Status

已完成：

- Supabase Auth（邮箱密码登录）
- Session 管理（`@supabase/ssr`）
- `src/proxy.ts` — 路由守卫（未登录 → `/auth/login`）
- `src/lib/auth.ts` — `getCurrentUser()` / `requireAdmin()` / `requireAuth()` / `getCurrentActiveUser()` / `requireActiveAdmin()` / `requireActiveAuth()`
- `/auth/login` — 登录页（自定义 UI，中文错误提示）
- `/auth/callback` — Auth 回调处理
- Dashboard Header — 用户信息 + 角色标签 + 退出按钮
- 角色体系：admin（管理员）/ operator（运营）
- 管理员账号已创建

## Database Status

| 项目 | 状态 |
|---|---|
| Supabase 项目 | `hzlhqyditalumhnxbaim.supabase.co`（Singapore） |
| 数据表 | 14 张（role, profiles, warehouse, product, product_variant, inventory, shipment, shipment_item, tracking_event, sync_log, sync_run, sync_warehouse_lock, user_variant_preference, user_warehouses） |
| RLS | 46 条策略，全部启用 |
| 新 Migration（P3-S2E） | 00020（purchase_order_no + create_shipment_transactional 11 参数 admin-only）已执行并验证；00021（change_shipment_status_transactional admin-only 覆盖）已执行并验证 |
| 新 Migration（P3-S4A） | 00022（change_shipment_status_transactional 状态流转规则校验）已手动执行并验证 |
| 新 Migration（P3-S5A） | 00023（warehouse_shipment_transactional 确认入仓事务 RPC）已在 Supabase SQL Editor 手动执行并验证通过 |
| 新 Migration（P4-U5） | 00024（update_user_role_protected / toggle_user_active_protected TOCTOU 原子保护）已在 Supabase SQL Editor 手动执行并验证；00025（RPC auth.uid() 身份绑定 + REVOKE/GRANT + operator trigger）已在 Supabase SQL Editor 手动执行并 smoke test 通过 |
| 新 Migration（PERF-S1） | 00027（get_overseas_inventory / get_overseas_stats / get_in_transit_confirmed_aggregate RPC）已手动执行并验证（2026-06-30） |
| 新 Migration（LOW-STOCK-PAGINATION） | 00028（get_low_stock RPC）已手动执行并验证（runtime smoke test 通过） |
| 新 Migration（PHASE-D） | 00029（get_sync_runs_paginated RPC — 服务端分页，返回 { rows, total, page, pageSize }）已执行；00030（修复 Operator 分页 RPC 已分配仓库过滤）已执行 |
| 新 Migration（PHASE-E） | 00031（Phase E 索引优化 — 返工修正后 7 个索引，仅索引变更，不改表结构/RPC/RLS/权限）已在 Supabase SQL Editor 手动执行成功（2026-07-07） |
| 新 Migration（PERF-D-OVERVIEW） | 00032（get_sync_warehouse_overview RPC — 服务端全量仓库同步概览，SECURITY DEFINER + Admin/Operator 仓库隔离）已在 Supabase SQL Editor 手动执行成功（2026-07-07） |
| 新 Migration（PERF-H） | 00033（drop idx_inventory_low_stock / idx_inventory_quantity — 删除两个未使用的 quantity 部分索引）已在 Supabase SQL Editor 手动执行成功（2026-07-07）。执行后验证查询 No rows returned |
| 新 Migration（P6-UX-V2-D） | 00034（get_overseas_inventory / get_low_stock RPC 增加 variant_name 字段 — BigSeller 原始品名 via product_variant.name）已在 Supabase SQL Editor 手动执行并验证通过（2026-07-09） |
| 新 Migration（P6-UX-V2-D 分词搜索） | 00035（get_overseas_inventory RPC 分词搜索增强 — regexp_split_to_array + unnest + NOT EXISTS + COALESCE）已在 Supabase SQL Editor 手动执行并验证通过（2026-07-09） |
| 新 Migration（P6-UX-V2 搜索性能） | 00036（pg_trgm 扩展 + GIN trigram 索引 — product_variant.sku/name + product.name/code，8 个索引）已在 Supabase SQL Editor 手动执行并验证通过（2026-07-09） |
| 新 Migration（P6-UX-V2-F） | 00037（`CREATE OR REPLACE get_overseas_inventory` — 签名不变，`p_stock_status` 白名单扩展 `in_transit`；口径与 `get_in_transit_confirmed_aggregate` 一致）**已在 Supabase SQL Editor 手动执行并验证通过（2026-07-09）**。验证：`SELECT prosrc LIKE '%in_transit%' FROM pg_proc WHERE proname='get_overseas_inventory'` = true |
| 新字段（00014 已执行） | inventory.daily_sales / inventory.estimated_days / warehouse.lead_time_days + RPC sync_warehouse_inventory 扩展（2026-06-26 手动执行，已生产验证） |
| 函数 | `get_user_role` / `handle_new_user` / `update_updated_at_column` / `create_shipment_transactional` / `batch_match_variants` / `sync_warehouse_inventory` / `claim_sync_run` / `claim_sync_run_system` / `release_sync_run` / `heartbeat_sync_run` / `cleanup_expired_sync_runs` / `get_sync_runs` / `get_sync_runs_paginated` / `get_sync_run_detail` / `trg_sync_warehouse_lock_insert` / `change_shipment_status_transactional` / `warehouse_shipment_transactional` / `update_user_role_protected` / `toggle_user_active_protected` / `check_operator_profile_update` / `get_overseas_inventory` / `get_overseas_stats` / `get_in_transit_confirmed_aggregate` / `get_low_stock` / `get_sync_warehouse_overview` |
| 触发器 | 5 个 updated_at + 1 个 on_auth_user_created + 1 个 trg_check_operator_profile_update |
| Seed 数据 | 2 角色（admin/operator）+ 6 仓库（CN/TH/ID/MY/PH/VN） |
| 类型文件 | `src/types/database.ts`（从 migration DDL 解析生成） |

## Environment Status

| 变量 | 位置 | 状态 |
|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | `.env.local` | ✅ 已配置 |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | `.env.local` | ✅ 已配置 |
| `SUPABASE_SERVICE_ROLE_KEY` | `.env.local` | ✅ 已配置 |
| 模板 | `.env.example` | ✅ 已创建（仅变量名，无真实值） |

限制：

- `service_role` 禁止前端使用（`createServiceClient()` 含 throw guard）
- `.env.local` 在 `.gitignore` 中，不提交

## Pending Modules

| 模块 | 预计实现 | 当前状态 |
|---|---|---|
| Products CRUD 页面 | Phase 1 | ✅ 已完成（列表 + 详情 + Sheet 表单 + 启停确认） |
| Variants 页面 | Phase 1 | ✅ 已完成（P5-SY11E：列表 + 搜索 + 归档/恢复 + unmatched） |
| Dashboard 首页 | Phase 2 | ✅ 已实现（库存概览 + 海外库存入口 + 快捷操作） |
| Overseas Inventory 页面 | Phase 2 | ✅ 已完成（PERF-S1 迁移至 RPC，分页/筛选/统计卡片稳定运行） |
| Domestic Inventory 页面 | Phase 2 | 仅骨架，无页面 |
| In-Transit Inventory 页面 | Phase 3 | 内部路径已完成（S2A~S5B）；P3-S1B CODE COMPLETE / BLOCKED_EXTERNAL（百世 API 权限未开通，外部在途路径阻塞） |
| Shipments 页面 | Phase 3 | ✅ 已完成（P3-S2A/S2B/S2E/S3/S4A/S5A/S5B 全部 DONE） |
| Users 页面 | Phase 4 | ✅ 已完成（P4-U1~U5 + P4-UX，列表/详情/角色修改/启用禁用/TOCTOU 修复） |
| Sync 脚本 + 页面 | Phase 5 | ✅ P5-SY3B 完成：91 Variants + 91 Inventory + Warehouse 改名，幂等 3 次重跑验证 |

## Deferred Items

以下事项已记录但暂不处理：

- ~~ProductVariant 页面开发（`/dashboard/variants`、`/dashboard/variants/unmatched`）~~ — ✅ 已完成（P5-SY11E）
- 8 个现有 lint warnings — 不影响功能，在最终验收时批量修复
- `middleware.ts` → `proxy.ts` 迁移已完成（NEXTJS16-PROXY-MIGRATION，2026-07-08）
- `profiles.is_active` 认证函数已新增（P5-SY5B），旧调用方逐步迁移
- P5-SY5C 已完成（types / validateJsonValue / ArtifactProvider 接口 / GC orchestrator / SyncRunner 接口 / contract.test.ts）。P5-SY5C2 独立验收通过。
- 库存历史快照（`inventory_snapshots` 表）— P5-SY9 暂不新增；BigSeller 已提供趋势/预测数据，后续如需自有趋势再单独评估
- 自动同步与部署 — 手动执行同步，无 CI/CD
- 当前使用 Vercel/Next.js 与 Supabase 快速开发；正式部署平台、免费方案和公司内部使用条款待上线前评估

## Current Implementation Limits

- Domestic Inventory 页面仍为占位实现（`src/app/dashboard/inventory/domestic/page.tsx` 仅骨架）；Users 页面已由 Phase 4（P4-U1~U5）全模块完成
- Dashboard 首页已实现（库存概览 + 海外库存入口 + 在途卡片 + P2-D2 低库存汇总 + P5-SY12C/D 关注产品动态）
- 侧边栏产品列表、海外库存、SKU 管理、待处理 SKU 均已启用（Phase 0）
- 海外库存查询已由 PERF-S1（Migration 00027）迁移至数据库 RPC 函数（get_overseas_inventory / get_overseas_stats / get_in_transit_confirmed_aggregate），低库存查询已由 LOW-STOCK-PAGINATION（Migration 00028）迁移至 get_low_stock RPC，均不再使用 JS 全量过滤分页
- 库存状态规则：quantity=0→缺货，已匹配+0<qty≤safetyStock→低库存，已匹配+qty>safetyStock→正常，未匹配+qty>0→未匹配



## Technical Debt

### 已修复（2026-06-10 Audit）

- ~~Shipment 创建非事务性~~ → 新增 `create_shipment_transactional` PostgreSQL 函数（Migration 00002 初版 → Migration 00005 修复，当前版本 9 参数 SECURITY INVOKER）
- ~~Inventory 分页 count 不准确~~ → country/warehouseType 过滤下推到 Supabase 查询层
- ~~Supabase join 嵌套类型转换重复 9+ 次~~ → 提取 `lib/supabase/helpers.ts` 的 `unwrapJoin()` 工具函数

### 现存技术债务

- `inventory` 仍为当前库存覆盖更新；库存趋势优先复用 BigSeller 可抓取数据，暂不把 `inventory_snapshots` 作为 P5-SY9 范围

- `getLowStock()` 已补 SQL 层 RPC 分页（LOW-STOCK-PAGINATION，Migration 00028：`get_low_stock(p_user_id, p_limit)` RPC，SQL 层归档/仓库/低库存过滤 + gap DESC, quantity ASC + LIMIT）
- ProductVariant 匹配仍依赖人工（`product_variant.match_status = 'unmatched'`）
- `sync_log` 仅仓库级别，不记录每条 SKU 变更
- ~~入仓库存联动待 P3-S5 实施~~ → ✅ P3-S5A 已完成（Migration 00023 已执行并验证，原子 UPSERT 入仓联动库存）
- `database.ts` 从 migration DDL 解析生成，非 `supabase gen types`（缺少 `SUPABASE_ACCESS_TOKEN`）
- `userRepository` email 字段硬编码为空字符串（Phase 4 解决）
- 预览/生产环境尚未建立
- 正式部署平台尚未确定；上线前需评估平台条款、免费额度、Next.js/Supabase 兼容性和迁移成本
- 云供应商轻量隔离已确认为强制架构规则：当前允许 Supabase 与 Vercel/Next.js 生态快速开发，供应商调用集中在 Repository、Service 与 `src/lib/`，不为未来迁移提前建设复杂抽象

## Recent Changes

| 日期 | 变更 |
|---|---|
| 2026-07-09 | **P3-S2E-EXPAND-FIELDS DONE。海外库存展开「内部在途明细」mini-table 化 + 物流状态列。** `InTransitDetailRow` 从 flex 链接列表改为轻量 mini-table：外层 `overflow-x-auto` + 白底细边框圆角，内层 `min-w-[760px]`，表头浅灰底 + 下边框，列宽用 `minmax(...)`（`grid-cols-[minmax(120px,1.1fr)_minmax(120px,1.1fr)_90px_minmax(170px,1.4fr)_130px_28px]`）。五列：单号（可点击跳 `/dashboard/shipments/{id}`）/ 采购单号（空 `—`）/ 数量（右对齐蓝色）/ **物流状态**（主行中文状态标签，镜像主表 STATUS_MAP 颜色；下方小字「最近物流更新 MM-DD HH:mm」/「最近物流更新 —」）/ 预计到货时间（`formatDate`，空 `—`）。数据契约扩展（用户批准 A 方案）：`InTransitDetailItem` 新增 `status: string`；`getInTransitDetailsByVariantAndWarehouse` 的 shipment select 增 `status` 并回填（原始枚举，组件层映射中文，不下沉展示逻辑到 repository）。不新增 Migration / RPC / RLS，不改 Product→ProductVariant→Inventory 模型，客户端组件不直接访问 DB，Operator 仓库隔离不变，不引入 vessel/voyage 字段。测试同步：`p3-s2e-in-transit-expand.test.ts`（表头改「物流状态」+ mini-table 结构断言 + status 映射）、`p3-s2e-repository.test.ts`（展开字段键集合 +`status`）、`p6-ui-clarity.test.ts`（repository select 断言 +`status`）。目标 3 文件 89/89 + 全量 `src/features/shipments` 1024/1024，lint 0 errors / 25 warnings（均既有），build pass，git diff --check pass。改动文件：`in-transit-detail-row.tsx` / `repository.ts` / `types.ts` + 上述 3 测试文件 + 本文档。 |
| 2026-07-07 | **P6-CSV-EXPORT DONE。海外库存 CSV 导出。** (1) `src/lib/csv.ts` 新增 `toCsv()` 纯函数（UTF-8 BOM + 逗号分隔 + RFC 4180 双引号转义）。(2) `exportOverseasInventoryCsv` Server Action：复用 `getOverseasList` 分页循环（pageSize=100，max 10000）+ `getInTransitConfirmedAggregate` 按 (variantId, warehouseId) 回填在途数量。(3) 海外库存页新增"导出 CSV"按钮（loading/disabled/error 状态，Blob 下载）。(4) `exportCsvSchema`（不含 page/pageSize，country 仅海外五国）。(5) 36 项测试（8 纯函数 + 14 Server Action 源码 + 10 页面源码 + 3 在途回填 + 2 架构边界）。(6) 不新增 Migration / RPC / RLS，不改 Repository 签名。返修：在途列修复为 aggregate 回填（初版仅 getOverseasList 默认 inTransitQuantity=0）。 |
| 2026-07-07 | **PERF-H Migration 00033 已在 Supabase SQL Editor 手动执行成功。** 删除 idx_inventory_low_stock + idx_inventory_quantity 两个 quantity 部分索引（执行前均 idx_scan=0 / idx_tup_read=0 / idx_tup_fetch=0 / index_size=16 kB）。执行后 pg_stat_user_indexes 验证查询返回 No rows returned，确认索引已删除。不改 00001 旧 migration / RPC / RLS / 业务代码。 |
| 2026-07-04 | **PERF-C2B DONE。产品页查询编排优化。** 产品列表页 `getCurrentUser()` + `productRepository.list()` 改为 `Promise.all` 并行；产品详情页 `getCurrentUser()` + `productRepository.getById(id)` 改为 `Promise.all` 并行；`repository.getById` 内 variants + inventory 改为 `Promise.all` 并行。新增 `perf-c2b-orchestration.test.ts` 20 项测试。全量测试通过，build pass，lint 仍为既有 5 errors / 25 warnings。**Phase C 性能优化（PERF-C1/C2A/C2B）全部完成。** |
| 2026-07-04 | **PERF-C2A DONE。海外库存 getOverseasInventory 查询编排优化。** `src/features/inventory/actions.ts` 重构 `getOverseasInventory`：`getOverseasWarehouses` / `getOverseasList` 与 `getInTransitConfirmedAggregate` 提前并行启动（不再等待 aggregate 完成），`getOverseasStats` 等 `variantTotalMap` 就绪后加入第二轮 `Promise.all`。新增 `seal()` helper 防止提前启动的 promise unhandledRejection。`p3-s5b4-batch-warehouse.test.ts` 新增 10 项 PERF-C2A 编排测试。全量测试通过，build pass，lint 仍为既有 5 errors / 25 warnings，未发现本轮新增。仅海外库存 actions；产品页留到 PERF-C2B。 |
| 2026-07-04 | **PERF-C1 DONE。Dashboard 首页查询并行重排。** `src/app/dashboard/page.tsx` 使用 `Promise.all` 并行执行 4 个独立查询（`getOverseasStats` / `getInTransitByVariant` / `getFollowedVariantsBasic` / `getLowStock`），消除串行 waterfall。每个查询保留独立 `.catch()` 错误处理。`p2-d2-low-stock-summary.test.ts` 新增 10 项并行编排测试。全量测试通过，build pass。仅限 Dashboard 首页；产品页/海外库存/同步页/索引未开始。 |
| 2026-07-04 | **PERF-B1 DONE（收口修复完成）。DIS 性能优化 Phase B 第一轮：request-scope cache + dashboard layout 接入。** 6 个文件修改：`src/lib/auth.ts`（`cachedGetAuthProfile` React `cache()` 合并 auth + profile 查询，`getCurrentUser()`/`getCurrentActiveUser()` 复用）、`src/app/dashboard/layout.tsx`（移除直接 Supabase 调用，改用 `getCurrentUser()`）、`src/features/shipments/repository.ts`（`getUserRole` 包裹 `cache()`）、`src/features/warehouse-access/repository.ts`（`cachedGetAccessibleWarehouseIds` 返回 `string[]`）、`src/features/variants/repository.ts`（`cachedGetUserArchivedVariantIds` 返回 `string[]`）、`src/lib/auth.test.ts`（PGRST116 行为测试，确认 `getCurrentActiveUser()` 在 profile 未创建时返回 `null`）。全量测试通过，build pass，lint 仅 smoke-test-00025.ts 既有。残余风险：React `cache()` 跨 render→Server Action 不共享缓存；Phase C 优先。 |
| 2026-07-04 | **LOW-STOCK-PAGINATION runtime smoke test 通过。** Migration 00028 `get_low_stock` 已在 Supabase SQL Editor 手动执行并验证（`is_security_definer=false`、`authenticated EXECUTE=true`、`anon EXECUTE=false`）。Dashboard 首页 `/dashboard` 低库存汇总区正常渲染绿色空态："当前所有海外仓库存均高于安全库存线，无低库存项目"。无 `get_low_stock` / function not found / schema cache 错误。 |
| 2026-07-02 | **P3-S5B4 DONE + 返修完成。批量入仓 UI + 海外库存"已确认到仓"列。** (1) 新建 `/dashboard/shipments/batch` 路由：Server Component Admin-only + `BatchWarehousePage` 客户端组件（checkbox 全选/选择 + 行展开加载产品明细 + 逐项数量校验 + "全额确认"一键填入 + 批量提交结果汇总）。(2) `listEligibleForBatchWarehousingAction` Server Action（Admin-only + `eligibleShipmentFiltersSchema` Zod 校验 + `safeParse` 失败返回中文错误不进入 repository + 仓库隔离）。(3) `getOverseasInventory` 新增每仓并行查询 `getConfirmedWarehousedByWarehouse`，返回 `confirmedMap`（warehouseId→variantId→confirmedQuantity）。(4) 海外库存页新增"已确认到仓"列（口径仅 customs 或 warehoused + bigseller_absorbed_at IS NULL）；展开行 colSpan 13（与表头 13 列一致）。(5) 侧边栏物流组下新增"批量入仓"链接（PackageCheck 图标，Admin-only）。(6) 70 项源码级测试（+9 返修：Zod schema 6 + safeParse/Zod 错误 + 表头 13 列断言 + schema import）；权限审计测试适配（actions 12→13）。全量 2452/2452（61 文件），lint 5 errors / 26 warnings（all pre-existing），build pass。不写 inventory.quantity，不调 00023 RPC，不新增 Migration。 |
| 2026-06-30 | **P3-S2E DONE。在途入口收口 + 采购单号 + 海外库存轻量展开。** (1) Migration 00020：`shipment.purchase_order_no` 字段 + `create_shipment_transactional` RPC 11 参数 Admin-only + `RETURNING id`。(2) Migration 00021：`change_shipment_status_transactional` 覆盖为 Admin-only。(3) 采购单号全链路：types → Zod → Repository → Actions → 创建/编辑表单 + 列表副行 + 详情页。(4) `shipmentRepository.getInTransitDetailsByVariantAndWarehouse()` — 按 (variantId, warehouseId) 查询在途明细（单号/采购单号/在途数量/预计到货），`InTransitDetailRow` 客户端组件集成海外库存行展开。(5) 入口收口：侧边栏移除"在途库存"，`/dashboard/inventory/in-transit` → redirect；Operator 隐藏写按钮。(6) 权限链：Server Action + RPC 双层 Admin-only。(7) Supabase 生产库已验证 `purchase_order_no` 字段存在，两个 RPC 均为 Admin-only。(8) 44 项 P3-S2E 测试（17 repository 行为 + 27 action/Zod/源码）。全量 1603/1603（49 文件，2 预存失败），lint 0 errors / 26 warnings，build pass。 |
| 2026-06-30 | **P3-S2D DONE。在途库存聚合精确到仓库。** (1) `shipmentRepository.getInTransitByVariantAndWarehouse()` — 按 (variant_id, warehouse_id) 聚合在途数量，返回 `Map<variantId, Map<warehouseId, qty>>`。(2) `getOverseasInventory` action 改用仓库维度在途，每行 inTransitQuantity = variantId + warehouseId 精确匹配，实现防串仓。(3) Dashboard 保持 variant 总在途（关注产品动态）。不新增 Migration，不写 inventory。16 项测试含跨仓隔离验证。全量 1558/1558（47 文件，2 预存失败），lint 0 errors / 27 warnings，build pass。 |
| 2026-06-30 | **P3-S2C DONE。库存视图接入内部手动在途只读聚合。** (1) `shipmentRepository.getInTransitByVariant()` — 按 variant_id 聚合 `SUM(quantity - warehoused_quantity)`，排除 warehoused，Admin/Operator 仓库隔离。(2) 海外库存页：新增"在途"和"库存+在途"列 + 在途统计卡片。(3) Dashboard 关注产品动态：新增"在途"列。(4) Dashboard 在途库存卡片：从占位替换为真实数据（SKU 数 + 在途总量）。(5) 14 项 repository 行为测试。全量 1541/1541（46 文件），lint 0/26，build pass。不新增 Migration，不写 inventory。 |
| 2026-06-29 | **P3-S2B 返工 DONE。** (1) Migration 00019 新增 `change_shipment_status_transactional` RPC — 同一事务完成 shipment.status 更新 + tracking_event 插入，GET DIAGNOSTICS 行确认，禁用 warehoused，SECURITY INVOKER。(2) `update()` 使用 `.select('id').single()` 确认命中 1 行，PGRST116 → NOT_FOUND。(3) `changeStatus()` 改为调用 RPC 替代两阶段分离写入。(4) 新增 32 项 P3-S2B 行为测试：Schema（updateShipment/changeStatus）+ Action（updateShipment/changeShipmentStatus）+ Repository（update 行确认/changeStatus RPC 调用）。全量 1526/1527（47 文件），lint 0/26，build pass。 |

| 2026-06-29 | **P3-S2A DONE 返工完成。** (1) `getById()` 主查询区分 PGRST116 not-found → null 与 DB/RLS error → ShipmentError。(2) `getUserRole()` profiles 查询 error 检查：DB error → ShipmentError，不静默降级为 unknown 放宽权限。(3) Repository 行为测试重写：mock createClient + warehouseAccessRepository，真实调用 repository，51 项新测试覆盖 list Operator/Admin/getUserRole error + getById 全子查询 error/profiles 容忍/Operator 拒绝。(4) docs 同步。质量门：全量测试通过，lint 0 errors，build 通过。 |
| 2026-06-28 | **P3-S3 DONE（Codex 独立验收通过）。** 目标测试 96/96，全量 1439/1439（44 文件），lint 0 errors / 26 warnings，build pass。3 轮返工收口：Variant 服务端校验 + 仓库数据一致性校验 + 服务端 Variant 搜索（error 检查/notIn 在 limit 前/LIKE 转义/ilike 参数断言）+ 独立 Repository 行为测试 + 真实 Server Action 链路测试。P3-S1B 保持 CODE COMPLETE / BLOCKED_EXTERNAL。Phase 3 等待百世 API 授权或用户明确批准调整依赖。 |
| 2026-06-28 | **P3-S3 REWORK 第三轮微修复。** 3 项：(1) 文档 stale 数据清理；(2) LIKE 测试 ilike 参数断言（`createQueryMock.callLog`，直接断言第二参数）；(3) 真实 Server Action 链路测试（删除 `searchVariantsAction` 模拟，mock requireActiveAuth + createClient + variantRepository，不 mock shipmentRepository，调用 actions.ts 真实 searchVariants）。 |
| 2026-06-28 | **P3-S3 REWORK 第二轮返工。** 3 类修复：(1) Repository 查询错误检查 — 所有 Supabase 查询读取 error，抛出 ShipmentError('查询 SKU 列表失败', 'DB_ERROR')；LIKE 转义同时处理 \\、%、_；notIn 归档过滤放在 limit() 之前。(2) 独立 Repository 行为测试 — 新建 repository-behavior.test.ts，mock createClient() + variantRepository，不 mock shipmentRepository 本身，直接调用真实 searchVariants()。(3) 文档清理 — 三份文档统一 P3-S3 REWORK，删除 1386/1388、2 个预存失败等旧数据。等待 Codex 复验。 |
| 2026-06-28 | **P3-S1B 收口为 CODE COMPLETE / BLOCKED_EXTERNAL。** 百世 API Client、签名与 Dry Run 代码全部就绪，本地测试通过。真实只读 Dry Run 返回"未授权"，确认当前 partnerId 尚未获得 queryOrderInfoByOrderNo / trackingQuery 接口权限。阻塞原因：百世账号 API 权限尚未开通。恢复条件：百世确认 partnerId 已授权两个只读接口后，重新执行 `npm run test:best-live`。代码和测试保留，不删除。当前任务切换至 P3-S3：手动创建/补录在途记录任务设计。 |
| 2026-06-26 | **Phase 3 启动。P3-S1A ~ P3-S6 任务拆分完成。** Phase 5 全部 DONE，下一阶段回到 Phase 3：在途与物流。详细任务包见 `docs/tasks/phase-3-shipments.md`。同日 **P3-S1A DONE** — Codex 独立验收通过：Migration 00017（`shipment_external_ref` / `shipment_external_item` / `tracking_event_external` 路径 B）+ `src/features/in-transit/` 类型与 Zod + database.ts 同步 + 64 静态契约测试 + 1263/1263 非并发测试 + lint 0 errors + build 通过。Migration 待用户在 Supabase SQL Editor 手动执行。下一步：P3-S1B 百世 API Client。 |
| 2026-06-26 | **P5-SY13B DONE。仓库分配管理 UI。** Migration 00016 已于 Supabase SQL Editor 手动执行并验证通过（rpc_exists=true / authenticated_can_execute=true / anon_can_execute=false）。返工 Round 1 修复 2 项阻塞（写入前业务校验 + 事务性 RPC）+ Round 2 修复 2 项收口（RPC REVOKE/GRANT 授权 + 测试纳入 Vitest）。1199/1199 TS 测试（38 文件），lint 0 errors / 24 warnings，build pass。P5-SY13B Codex 独立验收通过。下一步：等待用户确认下一任务。 |
| 2026-06-26 | **P5-SY13A DONE。Migration 00015 已由用户在 Supabase SQL Editor 执行成功（user_warehouses 表 + 22 条 RLS 策略 + get_assigned_warehouse_ids() + get_sync_runs/get_sync_run_detail operator assigned warehouse 过滤）。user_warehouse_assignments=0 当前可接受（单用户/Admin 场景）。返工修复 3 项阻塞：(1) get_assigned_warehouse_ids() GRANT EXECUTE TO authenticated；(2) 移除 accessibleWhIds.size > 0 防误放守卫；(3) getSyncLogDetail() 补强 canAccessWarehouse。1101/1101 TS 测试（37 文件），lint 0 errors / 24 warnings，build pass。下一步：P5-SY13B 仓库分配管理 UI。** |
| 2026-06-26 | **P5-SY12D DONE。Dashboard 关注产品动态运营可用性收口。** 新增 FollowedProductsSection Client Component：5 态筛选（全部/紧急/低库存/正常/数据不足）+ 每行 ExternalLink 跳转海外库存 SKU 搜索 + 未匹配 SKU 明确 tooltip 提示（不参与 safety_stock 判断，仍可用 estimated_days）+ 筛选无结果/加载失败/空关注/全未匹配边界状态。Dashboard page.tsx 数据获取链路不变（Repository Pattern）。不改数据模型/Migration。1014/1014 TS 测试（35 文件），lint 0 errors / 24 warnings，build pass。|
| 2026-06-26 | **P5-SY12C-RUNTIME DONE。生产运行时验证通过。** Migration 00014 已于 Supabase SQL Editor 手动执行成功：`inventory.daily_sales` / `estimated_days` + `warehouse.lead_time_days` + RPC 扩展均生效。5 个海外仓 lead_time_days 已设为 30。5 仓 daily_sales 已全部写入，estimated_days 按 BigSeller 可用数据写入（部分 SKU 为空属正常）。PH 仓批量写入中出现的 expired in_progress 已通过 cleanup_expired_sync_runs() 清理，无残留。Dashboard 关注区动态告警（日销/可售天数/补货周期 + alertLevel badge）正常运作。文档收口：current-state.md / current-task.md / phase-5-sync.md 已同步。等待用户确认下一任务。|
| 2026-06-25 | **P5-SY11G 返工 DONE。4 项阻塞修复：(1) inventory repo getOverseasList/getLowStock 过滤改用 row.variant_id（variant join select 不含 id，v.id 始终 undefined 导致所有行被过滤）；(2) variants repo list() 归档过滤从 JS 后置改为 DB 层 notIn/in 在分页前完成，total 准确；(3) archive/restore 先查询已有偏好再操作，返回实际新增/恢复数；(4) list() active tab 改用 query.notIn() 替代 query.not('id','in',...)，not() 期望 PostgREST 原始语法 `(id1,id2)` 而 JS 数组直接字符串化无括号导致过滤失效。补 5 项行为测试（含 notIn URL 生成 not.in.(...) 括号语法 vs .not() 无括号对比）。质量门：896/896 TS（30 文件），lint 0 errors/24 warnings（pre-existing），build pass。Python：315 passed + 5 collection errors（pre-existing）。WEBSYNC_REAL_WRITE_ENABLED=false。** |
| 2026-06-25 | **P5-SY11-REWORK DONE。语义返工完成：归档从全局 product_variant.is_archived 迁移为用户级 user_variant_preference。Migration 00012 新建表 + RLS；operator_select_variant 移除 is_archived 全局过滤。variantRepository 全部改用 user_variant_preference；archiveVariants/restoreVariants 改为 requireActiveAuth；Inventory 层按当前用户偏好过滤；UI 所有用户可归档/恢复。869/869 TS 测试 pass，lint 0 errors，build pass。旧列当时停止业务读写；00011 保持不可变，最终由 OPT-4 的 00048 前向清理。** |
| 2026-06-24 | **P5-SY9J 生产启用受控验证通过。P5-SY9 全子任务（A~J）DONE。** WEBSYNC_REAL_WRITE_ENABLED=true 已在 .env.local 启用。受控验证：PH 仓 Web Dry Run（104 行 → 6 新 + 80 更新 + 18 未变）→ 审核通过 → Real Write 成功（sync_log status=success，new_variants_count=6，库存验证通过）。修复 web_bridge.py execute_plan_v2 签名不匹配。已知小问题：RPC summary 返回全零（仅显示，sync_log 正确）。 |
| 2026-06-24 | **P5-SY9I Codex 独立验收通过，标记 DONE。P5-SY9 全子任务（A~I）完成。** 质量门确认：523/523 TS + 242/242 Python，lint 0 errors，build 通过，架构合规。WEBSYNC_REAL_WRITE_ENABLED 仍 disabled。下一步：用户授权后生产启用。 |
| 2026-06-24 | P5-SY9H Codex 独立验收通过，标记 DONE。P5-SY9I IN_PROGRESS。 |
| 2026-06-24 | P5-SY9H 实现完成（AWAITING_REVIEW）：6 项页面体验改进 + 12 项测试 + lint 清理。523/523 TS 测试通过。 |
| 2026-06-24 | P5-SY9G Codex 独立验收通过，标记 DONE。P5-SY9H IN_PROGRESS：页面体验与运营可用性收口。 |
| 2026-06-23 | P5-SY9G 实现完成（AWAITING_REVIEW）：批量审核后真实写入 — Admin 勾选 ready 仓库 + 输入确认短语后逐仓真实写入。confirmRealWrite 签名新增 confirmToken 参数消除硬编码。新增 triggerBatchRealWrite Server Action + BatchRealWriteResult 类型 + 17 项测试。页面批量审核总览新增复选框/全选/确认短语/批量写入按钮/写入结果展示。511/511 非并发同步测试（17 文件），lint 0 errors / 15 warnings，build 通过。WEBSYNC_REAL_WRITE_ENABLED 仍 disabled。 |
| 2026-06-23 | P5-SY9F Codex 独立复验通过，标记 DONE。P5-SY9G IN_PROGRESS：批量审核后真实写入。 |
| 2026-06-23 | P5-SY9F 实现完成（AWAITING_REVIEW）：Admin 批量全部海外仓 Dry Run + 每仓独立 claim/execute/release + 单仓失败不影响其他 + 批量审核总览类型 + triggerBatchDryRun Server Action + session health guard。31 项 actions 测试 + 22 项 P5-SY9F 专项测试。486/486 非并发同步测试，Python 85/85，lint 0 errors，build 通过。未连接生产 Supabase，未执行真实写入。 |
| 2026-06-23 | P5-SY9E Codex 独立验收通过，标记 DONE。P5-SY9F IN_PROGRESS：批量全部海外仓 Dry Run。 | — (1) python-bridge.ts 统一 terminate(reason) 管线：timeout 和 AbortSignal 均走 SIGTERM → 5s grace → SIGKILL（settled 标志幂等）；close/error 时清理所有 timers + abort listener；返回中文错误；不再使用 proc.killed 判断；(2) SyncServiceDeps 新增 heartbeatIntervalMs 可注入参数（生产默认 LEASE_DURATION/3 ≈ 100s），测试设 20ms 实现真实 heartbeat 触发断言；(3) prepareRunnerContext 异常时清理 heartbeat + release failed，dry_run/real_write 双路径覆盖；(4) MockSyncRunner 新增 shouldThrowCapabilities。新增 5 项测试：注入 20ms 间隔 → heartbeat 真实触发 ≥1 次 + heartbeat 抛错仍完成 + SIGTERM→SIGKILL mock spawn + abort→SIGTERM→SIGKILL + terminate 幂等 + capabilities 抛错清理 dry_run/real_write。20/20 P5-SY9E 测试，450/450 非并发同步测试，Python 85/85，lint 0 errors，build 通过。未连接生产 Supabase，未执行真实写入。 |
| 2026-06-23 | P5-SY9E 实现完成（AWAITING_REVIEW，等待 Codex 独立验收）：(1) python-bridge.ts 新增 timeoutMs 参数 — 超时后 SIGTERM → 5s grace → SIGKILL；(2) sync-service.ts 新增 heartbeat 续租循环（间隔 LEASE_DURATION/3 ≈ 100s），executeDryRun/executeRealWrite 均启动 heartbeat；新增 prepareRunnerContext — 根据 Runner capabilities.maxTimeoutMs 创建 AbortSignal.timeout；(3) real-sync-runner.ts 传递 capabilities.maxTimeoutMs 到 callPythonBridge；(4) MockSyncRunner 新增 delayMs + signal 检测 + _setCapabilities 用于 timeout/abort 测试；(5) 新增 15 项 P5-SY9E 测试（heartbeat 调用/失败不中断/claim 前不触发 + timeout 创建/不创建 + abort 预触发 + lease 过期回收/heartbeat 续租后不可抢占/invalid heartbeat 拒绝 + schema 边界 + capabilities 类型检查）。445/445 非并发同步测试，Python 85/85 通过，lint 0 errors/10 warnings，build 通过。未连接生产 Supabase，未执行真实写入。 |
| 2026-06-23 | P5-SY9D Codex 验收通过，标记 DONE。P5-SY9E IN_PROGRESS：heartbeat / timeout / abort / 子进程控制 / 失败落库 / 并发锁测试。 |
| 2026-06-23 | P5-SY9D rework 第三次返工完成（AWAITING_REVIEW，等待 Codex 独立验收）：3 项修复 — (1) confirmRealWrite country 校验强制化：plan artifact 缺少 country / country 非字符串 / country 空字符串 / 不一致全部阻断；(2) 查询契约除杂：SyncRunAdminRow 移除 input_artifact_hash / plan_artifact_hash，MockRepository getSyncRuns/getSyncRunDetail admin 视图不再返回此二字段；(3) 60 分钟边界修复：ageMs >= DRY_RUN_EXPIRY_MS。新增 6 项测试（country 缺失/非字符串/空字符串阻断 + getSyncRuns/getSyncRunDetail 不含 hash + 恰好 60 分钟阻断）。51/51 P5-SY9D 测试，430/430 非并发同步测试，Python 85/85 通过，lint 0 errors，build 通过。未连接生产 Supabase，未执行真实写入。 |
| 2026-06-23 | P5-SY9D rework 第二次返工完成（AWAITING_REVIEW，等待 Codex 独立验收）：修复 confirmRealWrite 应用层 hash 校验在生产路径被跳过的问题 — (1) 新增 SyncRepository.getDryRunBindingMetadata(runId) 方法，返回 DryRunBindingMetadata（id/warehouse_id/mode/status/finished_at/plan_drift_check/input_artifact_hash/plan_artifact_hash）；(2) SupabaseSyncRepository 使用 serviceClient 直查 public.sync_run 绕过 get_sync_run_detail RPC 脱敏；(3) MockRepository 同步实现该方法；(4) confirmRealWrite 全部绑定校验改为从 getDryRunBindingMetadata 取值，移除旧的 `adminDetail.input_artifact_hash &&` 条件跳过逻辑；(5) hash 强制校验：input/plan hash 缺失则阻断，不再"字段存在才校验"；(6) 新增 14 项测试（input hash 缺失阻断、plan hash 缺失阻断、metadata 全部字段有效/hash 一致 happy path、metadata 缺失/warehouse/mode/status/drift/finished_at 各字段不一致阻断）；(7) plan hash 不一致测试 hash 注入修复（必须通过 input hash 校验才能到达 plan hash 路径）；(8) re-scrape 禁止测试 hash 注入修复。保留 DB claim_sync_run 二次防御，不修改已执行 migration。45/45 P5-SY9D 测试，424/424 非并发同步测试，Python 测试（26 plan + 44 verifier + 15 health_check = 85），compileall 通过，lint 0 errors，build 通过。未连接生产 Supabase，未执行真实写入。不提交 runtime/artifacts、__pycache__。 |
| 2026-06-23 | P5-SY9D rework 完成（AWAITING_REVIEW，等待 Codex 独立验收）：修复 3 项关键缺陷 — (1) Dry Run plan artifact 修复：web_bridge.py 新增 result['plan'] = plan_summary 暴露完整 plan（含元数据 country/generated_at/warehouse_id + 结构字段 new_variants/inventory_inserts/inventory_updates/inventory_unchanged/warehouse_rename_required），python-bridge.ts 新增 plan 字段，real-sync-runner.ts 使用 bridgeResult.plan（非 summary）作为 planArtifact；(2) Real Write 禁止重新抓取：confirmRealWrite 改为从 ArtifactProvider 加载绑定 Dry Run input + plan artifact，不再调用 inputArtifactSource.getInputArtifact(…, 'real_write')；(3) 应用层绑定校验新增 5 项：Dry Run 未过期（finished_at + 24h 窗口）、country 一致（plan 元数据 vs warehouse country）、input hash 一致（repo 存储 vs artifact 当前 hash）、plan hash 一致、input/plan artifact 加载失败阻断。新增 6 项失败测试（过期阻断、缺少 finished_at 阻断、country 不匹配阻断、input hash 不匹配阻断、plan hash 不匹配阻断、plan artifact 结构性验证）+ 2 项正确性测试（re-scrape 禁止验证、完整 plan 非 summary 验证）+ mock repository 新增 input_artifact_hash/plan_artifact_hash 到 admin 视图。SyncActionsDeps 新增 artifactProvider 依赖。35/35 P5-SY9D 测试，414/414 非并发同步测试，15/15 非 concurrency 文件，Python compileall 通过，lint 0 errors/3 warnings，build 通过。未连接生产 Supabase，未执行真实写入。不提交 runtime/artifacts、__pycache__、bound-plan-*.json。 |
| 2026-06-23 | P5-SY9D 实现完成（AWAITING_REVIEW，等待 Codex 独立验收）：(1) web_bridge.py 修复 compare_plans(plan, plan) 自比较→真实 stored_plan 漂移比较 + --prior-dry-run-path；(2) TS pipeline 线 priorDryRunPath 传递；(3) actions.ts triggerDryRun + confirmRealWrite 拆分（含 dryRunRunId/warehouse_id/status/plan_drift_check 绑定校验）；(4) server-actions.ts 新增 Server Actions + feature gate；(5) sync page UI Dry Run 审核摘要 + 确认写入 Dialog；(6) MockRepository._injectRunDetail 测试辅助；(7) 27 项 P5-SY9D 测试；(8) 文档同步。406/406 TS 测试，15/15 Python，lint 0 errors，build 通过。未连接生产 Supabase，未执行真实写入。 |
| 2026-06-23 | P5-SY9C Codex 独立复验通过（DONE）。3 项返工全部通过：MockSyncRunner 移除 + baseDir 注入 + production-wiring 补强。P5-SY9D 启动（IN_PROGRESS）：单仓 Web Dry Run → 审核 → Real Write 绑定设计与实现。Web 真实写入入口 WEBSYNC_REAL_WRITE_ENABLED 保持 disabled。 |
| 2026-06-23 | P5-SY9C 返工完成（AWAITING_REVIEW，等待 Codex 再验收）：(1) 移除 server-actions.ts 中 MockSyncRunner import + wireActions() 函数，getSyncRuns/getSyncRunDetail 改为 repository-only 读路径，triggerSync 直接返回中文错误不构造 SyncService；(2) FileSystemArtifactProvider 支持注入 baseDir（默认仍为 runtime/artifacts），新增 getBaseDir() 方法，测试使用 os.tmpdir() 隔离，afterEach 只删除测试目录；(3) production-wiring.test.ts 移除所有 expect(true) placeholder，新增：server-actions.ts 源码不含 Mock import、NODE_ENV=production createSyncService 拒绝 Mock 组合/接受真实组合、sync 页面源码不含 supabase.from()、feature gate 默认 false 且拦截 healthy session；(4) session-health.test.ts 新增 syncWarehouse/syncAllWarehouses feature gate 拦截测试（healthy session + gate disabled → gate error）。98/98 P5-SY9C 测试，15/15 Python 测试，lint 0 errors/10 warnings，build 通过，379/379 非并发测试。未连接生产 Supabase，未执行真实写入，未删除真实 runtime/artifacts。 |
| 2026-06-23 | P5-SY9C 实现完成（AWAITING_REVIEW）：(1) 新增 `FileSystemArtifactProvider` — 文件系统持久化 ArtifactProvider，替代 MockArtifactProvider；(2) 新增 `WebInputArtifactSource` — 通过 Python bridge 真实抓取的 InputArtifactSource，替代 hardcoded mockInputArtifactSource；(3) `server-actions.ts` 生产 wiring 重连：`wireRealActions` 使用 FileSystemArtifactProvider + RealSyncRunner + WebInputArtifactSource，`wireActions` 使用 FileSystemArtifactProvider；(4) 新增 `WEBSYNC_REAL_WRITE_ENABLED` feature gate，默认 disabled；(5) 新增 53 项测试（25 FileSystemArtifactProvider + 28 production wiring 结构性测试）。361/361 TypeScript 测试，15/15 Python 测试，lint 0 errors，build 通过。P5-SY9B 移入 Completed Tasks（Codex 独立复验通过）。未连接生产 Supabase，未执行真实写入。 |
| 2026-06-23 | P5-SY9B Codex 独立复验通过：session health guard 回归测试（27/27）+ Python 健康检查测试（15/15）+ lint/build 全部通过。P5-SY9B 移入 Completed Tasks。 |
| 2026-06-23 | P5-SY9B 返工完成（AWAITING_REVIEW）：(1) syncWarehouse/syncAllWarehouses 加入服务端 session health guard，非 healthy 拒绝进入 wireRealActions；(2) verifyBigSellerSession 内 checked_at→checkedAt 字段转换；(3) health_check.py 实现 profile_unavailable 真实分类（profile 目录/coffee 文件缺失时在启动浏览器前返回）；(4) docs/tasks/current-task.md 停止条件更新为 P5-SY9B 范围；(5) .codex/hooks.json 已从暂存区移除。未执行真实写入，未连接生产 Supabase。 |
| 2026-06-23 | P5-SY9A 第二轮返工（Session 差距补充）：新增 CRITICAL 差距 — BigSeller Session 复用不可靠。`establishBigSellerSession()` headed Chrome 登录成功不等于 `web_bridge.py` headless Chrome 可复用同一 profile。当前无 `verifyBigSellerSession()` 健康检查；0 行时无法区分未登录/验证码/profile 不可用/页面结构异常/表格未加载。新增 P5-SY9B 子任务（BigSeller Session Health Check），原 P5-SY9B~H 重编号为 P5-SY9C~I。Session Health Check 必须早于真实 Provider / Web Dry Run 生产化。仅文档修订，未修改代码。 |
| 2026-06-21 | P5-SY9A 现状审查完成：27 个核心文件逐行审查（TypeScript sync feature 11 文件 + sync page/component + python-bridge + auth + Python sync 7 文件），输出 6 维度差距清单。CRITICAL: (1) `web_bridge.py` L156 `compare_plans(plan, plan)` 假比较；(2) `syncWarehouse`/`syncAllWarehouses` 自动串联 dry_run→real_write 无审核；(3) `wireRealActions` 仍使用 `MockArtifactProvider` + `mockInputArtifactSource`。HIGH: (4) Python bridge 无 timeout/heartbeat/abort。MEDIUM: (5) `getOverseasWarehouses` 在 server-actions.ts 中直接调用 `supabase.from()`。PASS: (6) Admin/Operator 权限链正确。仅审查未修改代码。 |
| 2026-06-21 | P5-SY8H DONE — Codex 独立验收通过：ID 印尼仓（印尼-DEE仓库）真实写入与端到端验收完成。P5-SY8H-ID 令牌（--no-dry-run 写令牌）。首次 RPC 写入：35 Variants (country=ID) + 35 Inventory + Warehouse 改名（"印尼仓"→"印尼-DEE仓库"）。Phase G/I PASS，SyncLog success。幂等重跑：0 新增/35 unchanged，plan_drift_check=PASS。Codex 独立验收：代码、报告、真实 DB 只读核查、幂等重跑、质量门均通过。128/128 Python 测试（89 executor + 39 CLI），compileall/lint/build 通过。逐仓 P5-SY8A~H 全部完成，随后进入 P5-SY9 生产化任务包。 |
| 2026-06-21 | P5-SY8G DONE — Codex 独立复验通过：ID 印尼仓只读抓取与 Dry Run 方案完成。BigSeller 抓取 35 行（warehouse=印尼-DEE仓库，autoid=warehouse_option_3）+ invalid sidecar 1 行（空包 0000）。DB 仓库 `印尼仓`→`印尼-DEE仓库` 改名已确认。P5-SY8G-ID 令牌（仅 --dry-run）。Codex 返工 3 项修复通过 + 后收口维护（docs 残留同步 + GC 测试夹具）。Stored Plan Baseline `p5-sy3a-dry-run-20260621-005154.json`，CLI Dry Run 报告 `p5-sy8g-id-dry-run-20260621-005202.json`，plan_drift_check=PASS。245/245 Python 测试，256/256 非并发同步测试，compileall/lint/build 通过。未执行真实写入，P5-SY8H 保持 PENDING。 |
| 2026-06-21 | P5-SY8F DONE — Codex 独立验收通过：MY 马来西亚仓首次真实写入 — 48 Variants (country=MY) + 48 Inventory + Warehouse 改名（"马来西亚仓"→"喜运达MY仓"）。P5-SY8F-MY 令牌（唯一 MY --no-dry-run 令牌，P5-SY8E-MY 保持仅 --dry-run）。CAPTCHA 检测修复（仅可见元素触发）。全新抓取 48 行 + invalid sidecar 1 行。Stored Plan `p5-sy3a-dry-run-20260621-002437.json`，Dry Run `p5-sy8f-my-dry-run-20260621-002458.json`，首次写入 `p5-sy8f-my-execute-20260621-002507.json`。幂等重跑：0 新增/48 unchanged，`p5-sy8f-my-execute-20260621-002540.json`。Phase G/I PASS，SyncLog success。239/239 Python 测试（85 exec + 32 CLI + 26 plan + 29 sync_log + 44 verifier + 10 structural + 13 Migration 00009），compileall/lint/build 通过。 |
| 2026-06-20 | P5-SY8E DONE — Codex 独立验收通过：MY 马来西亚仓只读抓取与 Dry Run 方案完成。48 行抓取 + Dry Run PASS + MY 全链路国家断言（test_my_full_chain_country_assertions，execute_plan_v2 真实执行，逐条验证 RPC p_variants/p_inventory country=MY + Phase G country=eq.MY + Phase I wh_expected.country=MY + SyncLog warehouse_id/status）。invalid sidecar: 1 行（空包 0000）。P5-SY8E-MY 令牌（仅 --dry-run）。234/234 Python 测试，compileall/lint/build 通过。文档收口完成。未执行真实写入，P5-SY8F 保持 PENDING。 |
| 2026-06-20 | P5-SY8E Codex 返工完成（AWAITING_REVIEW 阶段）：新增 MY 全链路国家断言 + invalid sidecar 文档 + 测试基线 233→234。保持 AWAITING_REVIEW，未执行真实写入。以下是返工前的首次执行摘要。 |
| 2026-06-20 | P5-SY8E 首次执行完成：MY 马来西亚仓只读抓取与 Dry Run。BigSeller 抓取 48 行（warehouse=喜运达MY仓，autoid=warehouse_option_4）。config.py/bigseller_scraper.py 切换至 MY。新增 P5-SY8E-MY 令牌（仅 --dry-run，--no-dry-run 在 I/O 前拒绝）。Stored Plan Baseline `p5-sy3a-dry-run-20260620-232838.json`，CLI Dry Run 报告 `p5-sy8e-my-dry-run-20260620-233129.json`（plan_drift_check=PASS）。DB 仓库名 `马来西亚仓`→`喜运达MY仓` 改名已确认。233/233 Python 测试（28 CLI + 83 executor + 26 plan + 29 sync_log + 44 verifier + 10 structural + 13 Migration 00009），compileall 通过，npm lint 0 errors，npm build 通过。未执行真实写入，P5-SY8F 保持 PENDING。 |
| 2026-06-20 | P5-SY8D DONE — Codex 独立验收通过：两轮返工全部通过（Fix 1 令牌—模式安全门 + Fix 2 finished_at 审计语义 + Fix 3 测试 mock 修复）。executor.py 新增 _DRY_RUN_ONLY_TOKENS 安全门（P5-SY8C-TH 仅 dry_run=True）、finished_at 移至 Phase G/I 通过后、审计失败路径设 result.finished_at。228/228 Python 测试（25 CLI + 81 executor + 26 plan + 29 sync_log + 44 verifier + 10 structural + 13 Migration 00009），compileall 通过，npm lint 0 errors（8 个既有 warnings），npm build 通过。P5-SY8E 保持 PENDING。 |
| 2026-06-20 | P5-SY8C Codex 独立验收通过：全部 A0–A5 子任务确认，A4 返工（报告身份 token 派生 + Dry Run Phase E 空 DB 兼容）确认。196/196 Python 测试，13/13 Migration 00009 契约测试，compileall/lint/build 通过。报告路径：130900=stored plan baseline / 133500=CLI execution report。P5-SY8C 标记 DONE。P5-SY8D 保持 PENDING/BLOCKED，等待用户明确授权 TH 真实写入。 |
| 2026-06-20 | P5-SY8C A4 独立验收返工完成：(1) 修复 `cli_execute.py` 报告身份 — `report.task` 和文件名前缀从 confirm token 派生，不再硬编码 'P5-SY3B'/'p5-sy3b'/'p5-sy4c'；(2) 修复 `executor.py` Dry Run Phase E 对空 DB 的兼容；(3) 新增 3 项 report identity 测试（PH/VN/TH）；(4) 重新执行 CLI Dry Run — 新报告 `p5-sy8c-th-dry-run-20260620-133500.json`（与 stored plan baseline 130900 明确区分）。196/196 Python 测试，13/13 Migration 00009 契约测试，compileall/lint/build 通过。未执行真实写入，未开始 P5-SY8D。保持 AWAITING_REVIEW，等待 Codex 独立验收。 |
| 2026-06-20 | P5-SY8C DONE：TH 泰国仓只读抓取与 Dry Run 全部完成（A0 仓库改名 → A1 配置切换 → A2 BigSeller 抓取 72 行 → A3 输入校验 → A4 Dry Run PASS → A5 全链路验收）。新增 2 项测试：TH full-chain 国家断言 + _TOKEN_COUNTRY_MAP 一致性。193/193 Python 测试（+2 增量），npm lint 0 errors，npm build 通过。3 项写入前强制验收项全部满足。未执行真实写入，未开始 P5-SY8D。停止等待 Codex 独立验收。 |
| 2026-06-20 | P5-SY8B Codex 独立验收通过：4 项返工全部确认 — 令牌国家绑定 / Migration 00009 静态契约测试 13/13 / 执行报告时间戳 / 文档同步。160/160 Python 测试，npm lint 0 errors，npm build 通过。P5-SY8C 任务包已创建（TH 泰国仓只读抓取与 Dry Run 方案，PENDING 待用户确认目标仓）。未连接生产 Supabase，未执行真实写入。 |
| 2026-06-20 | P5-SY8B Codex 独立验收返工完成：4 项修复 — (1) 令牌国家绑定：`cli_execute.py` / `executor.py` 中确认令牌绑定目标国家（P5-SY3B-PH→PH, P5-SY8B-VN→VN），不匹配则 fail-fast 在任何 I/O 前；(2) Migration 00009 静态契约测试：新建 `supabase/tests/test_migration_00009_contract.py`（13/13 通过）；(3) 执行报告时间戳：`cli_execute.py` 从 `result_v2` 透传 `started_at`/`finished_at` 到最终 report，新增 1 项测试；(4) 文档同步。160/160 Python 测试（16 cli_integration + 26 plan + 76 executor + 29 sync_log + 13 migration_00009_contract），npm lint 0 errors，npm build 通过。未连接生产 Supabase，未执行真实写入。 |
| 2026-06-19 | P5-SY8B DONE：VN 真实写入与端到端验收通过。(1) 首次 RPC 提交 64 Variants (country=VN) + 64 Inventory (warehouse_id=c0b661fa...) 成功，但 Phase G 审计因硬编码 `country=eq.PH` 失败 → executor.py 3 处 URL 修复为 `WAREHOUSE_COUNTRY`；(2) Migration 00009 通用化 RPC（移除 4 处硬编码 PH 检查）；(3) 幂等重跑：plan_drift_check=PASS (0 diffs)，0 新增 Variant/Inventory，64 unchanged，Phase G/I PASS，sync_log status=success/synced_count=64；(4) executor.py 另 3 处硬编码 PH（Phase I expected country + variant country 默认值）修复为 `WAREHOUSE_COUNTRY`。`current-task.md` / `current-state.md` / `phase-5-sync.md` 已同步。停止等待 Codex 独立验收，不进入 P5-SY8C。 |
| 2026-06-19 | P5-SY8B 写入前准备完成：(1) A1 仓库改名已执行 — Supabase `warehouse.name` 从 `越南仓` 改为 `越南青林湾仓库`；(2) `P5-SY8B-VN` 确认令牌已实现 — `cli_execute.py` / `executor.py` 均接受，测试 41/41 通过；(3) 新 P5-SY8B prewrite 基线报告已生成 — `p5-sy8b-vn-prewrite-dry-run-20260619-213335.json`（warehouse_rename_required.action=none, 64/64/0）；(4) plan_drift_check PASS（0 diffs，使用新基线报告）。`current-task.md` / `current-state.md` / `phase-5-sync.md` 已同步。**未执行真实写入。** |
| 2026-06-19 | P5-SY8A Codex 独立验收通过。P5-SY8A 标记 DONE。`current-task.md` 重写为 P5-SY8B（VN 真实写入与端到端验收，PENDING/BLOCKED，两个阻断决策待用户确认）。`current-state.md` Current Task → P5-SY8B，Next Step 更新。`phase-5-sync.md` P5-SY8A → DONE（Codex 验收通过）。未实现功能代码，未执行真实写入，未开始 P5-SY8B。 |
| 2026-06-19 | P5-SY8A 执行完成：VN 越南青林湾仓库只读抓取 64 行 + Dry Run 报告生成。BigSeller 显示 `越南青林湾仓库`（autoid=warehouse_option_7），Supabase 存储 `越南仓`（名称不一致已记录）。64/64 行公式验证通过，0 无效 SKU，0 拒绝行。全仓选项清单已记录（8 个 autoid，供后续逐仓扩展）。config.py / bigseller_scraper.py / supabase_gateway.py / cli.py / cli_execute.py 已切换至 VN 仓。Python 测试 183/183 通过。未执行真实写入。 |
| 2026-06-19 | P5-SY8 第一次 Codex 独立设计审查未通过 → 文档返工完成：修正 GAP-01→GAP-05 编号、修正"等待 SyncService 真实实现"表述为"等待真实 adapter 接入"并明确 SyncService 已存在不重写、拆分 P5-SY8A~H 子任务（每仓两步：只读 Dry Run → 真实写入与验收）、补充 11 项验收标准（7 通用 + 4 架构边界）、补充 P5-SY8A 第一子任务启动条件（VN 越南青林湾仓库，含 6 项启动前确认 + 3 项不执行声明）。`current-task.md`/`current-state.md`/`phase-5-sync.md` 已同步。未实现功能代码，未连接 Supabase，未触发真实写入，未开始 VN 实现。 |
| 2026-06-19 | P5-SY8 逐仓扩展任务包创建：P5-SY7 → P5-SY8 状态文档收口。`current-task.md` 重写为 P5-SY8 任务包（PENDING，待 Codex 审查）。`current-state.md` Current Task / References / Blockers / Next Step 全部对齐 P5-SY8。数据库供应商隔离约束写入所有相关文档。未实现功能代码，未连接 Supabase，未触发真实写入。 |
| 2026-06-19 | 生产 Migration 00006/00007/00008 执行完成（通过 Supabase Dashboard SQL Editor）：新增 2 张表（sync_run/sync_warehouse_lock）、sync_log 扩展 5 列、7 个 RPC 函数（sync_warehouse_inventory/claim_sync_run/release_sync_run/heartbeat_sync_run/cleanup_expired_sync_runs/get_sync_runs/get_sync_run_detail）+ trigger 函数。sync_warehouse_lock 补建 5 行（5 个活跃海外仓）。REST API 只读验证全部通过。新增数据库供应商隔离约束（DB Vendor Isolation）。P5-SY8 就绪。 |
| 2026-06-19 | P5-SY7 Codex 独立复验通过：2 项文档返工修正已确认（B5 Python json.dumps NaN/Infinity 表述 + 未来约束；F4 移除 .claude/rules/security.md 引用）。差距分析 6 已知差距/0 阻塞项不变。P5-SY7 标记 DONE。 |
| 2026-06-19 | P5-SY6 Codex 第三次独立设计验收通过：全部返工项确认（架构边界/平台事实/手动路径/验证口径/架构安全表述）。评估文档 `docs/tasks/archive/p5-sy6-runtime-design.md`。未实现代码，未连接生产 Supabase，未执行生产 Migration。Current Task → P5-SY7。 |
| 2026-06-19 | P5-SY6 第二次返工完成（Codex 第二次设计复验差 1 项小修）：修正架构安全表述 — Python CLI 经 executor → Supabase gateway → RPC → DB 约束，不经过 Next.js Server Actions/SyncService；Web UI Mock 经 Server Actions → SyncService → Mock* 组件，不产生真实写入。综合对比表"手动 (CLI)"列"经过 Server Actions/SyncService 编排"从 ✅ 修正为 ❌ 不经过。两条路径当前不是同一条生产架构边界，统一生产入口待 P5-SY6F。评估文档 `docs/tasks/archive/p5-sy6-runtime-design.md`。等待 Codex 第三次独立设计验收。 |
| 2026-06-19 | P5-SY5G Codex 独立复验通过：D2/F2 确定性 FOR UPDATE 行锁断言确认，无 expect(true).toBe(true) 或"环境差异不强制断言"通过路径。281 非并发测试全通过，lint 0 errors（8 pre-existing warnings），build 通过。未连接生产 Supabase，未执行生产 Migration 00007/00008。Current Task → P5-SY6。 |
| 2026-06-19 | P5-SY5F Codex 独立复验通过：返工修复经 Codex 独立复验确认通过。GC 防误删三层保护完整（active ∪ recent ∪ referenced），integration.test.ts 18 项集成测试（含被 Real Write 引用的 Dry Run GC 保护 + orphan 反例删除）。281/281 测试，lint 0 errors，build 通过。下一步 P5-SY5G。 |
| 2026-06-19 | P5-SY5F 独立验收通过：新增 integration.test.ts（16 项集成测试）— 非确定性序列化安全（5）+ GC 全管道（3）+ GC 防误删边界（4）+ artifact 生命周期（4）。279/279 测试，lint 0 errors，build 通过。Codex 指出 GC 防误删缺一项，已返工修复。 |
| 2026-06-19 | P5-SY5E 独立验收通过：侧边栏新增"数据同步"分组 + RefreshCw 图标 + 库存同步入口（phase 0，Admin/Operator 可见）。263/263 测试，lint 0 errors，build 通过。 |
| 2026-06-19 | P5-SY5D 独立验收通过：聚焦返工已通过 Codex 独立代码复验。263/263 测试，lint 0 errors，build 通过。 |
| 2026-06-19 | P5-SY5D 实现完成：顶层 `'use server'` Actions（server-actions.ts）+ Server Component 页面（page.tsx）+ 客户端交互（sync-page-content.tsx）+ loading.tsx / error.tsx。258/258 测试通过，lint 0 errors，build 通过。待独立验收。 |
| 2026-06-19 | P5-SY5C2 独立验收通过：types.ts / schema.ts / repository.ts / sync-service.ts / actions.ts / mock-artifact-provider.ts / mock-sync-runner.ts + 7 个测试文件（contract / schema / repository / sync-service / actions / mock-artifact-provider / mock-sync-runner）。258/258 测试通过，lint 0 errors，build 通过。 |
| 2026-06-19 | P5-SY5C2 任务包第五次修订完成（第四次复审未通过 → 4 项修正）：(1) 统一 triggerSync 返回映射 success=(status==='completed')；(2) 统一失败 Artifact 保留规则消除 delete/保留矛盾；(3) Plan Artifact rejected_rows.row 改为 Record<string, JsonValue>；(4) 日期同步。仅修订设计文档，未实现代码。 |
| 2026-06-19 | P5-SY5C2 任务包第四次修订完成（第三次复审未通过 → 7 项修正）：(1) SyncServiceResult 类型；(2) release 失败 indeterminate 状态；(3) Artifact 保留规则修正；(4) inputArtifact 改为必需；(5) Plan Artifact 精确对齐 plan_generator 实际输出；(6) createSyncActions 仅为工厂；(7) 新增强化测试。仅修订设计文档，未实现代码。 |
| 2026-06-14 | P5-SY5 V5.4.1 第九次修订完成：第八次独立设计验收聚焦返工未通过，V5.4.1 覆盖全部 3 项返工要求 — (1) 调整 claim_sync_run 验证顺序：dry_run_run_id PERFORM 验证移至 advisory lock + FOR UPDATE 之后、任何 UPDATE/INSERT 之前，锁保护区内消除 TOCTOU 窗口，更新 SQL 草案和 P5-SY5G 测试；(2) 修复 GC 时间模型：cutoff 直接使用 `now - 7 days`（移除错误的 max()），恢复 getRecentlyCompletedRunIds(now-60min) 双层保护（Layer 1: 7 天存储截止 + Layer 2: 60 分钟业务保护），禁止 artifact.createdAt 推导 sync_run.finished_at（独立时间戳）；(3) 定义 JsonValue 运行时验证器：validateJsonValue() 递归拒绝 undefined/function/Symbol/BigInt/NaN/Infinity/toJSON/自定义原型，prepare() 先验证再 stringify，新增 ~12 项 validateJsonValue 测试和 GC 防误删边界测试。修订 D27 为"GC cutoff 固定为审计保留期 + 双层保护"，新增 D28（validateJsonValue 运行时验证）。仅修改设计和状态文档，未实现代码。等待第九次独立设计验收。 |
| 2026-06-14 | P5-SY5A Migration 00007 第二次聚焦返工完成：修复 8 项缺陷 — (1) claim_sync_run IS DISTINCT FROM 'admin' 拒绝 NULL role + triggered_by 绑定 auth.uid()；(2) 查询 RPC 脱敏矩阵：禁止 input_artifact_hash/plan_artifact_hash/lease_expires_at/heartbeat_at/原始 triggered_by UUID，Admin 返回 display_name，Operator 返回脱敏邮箱 + controlled result_summary + Chinese 失败摘要；(3) failed_requires_fields 增加 finished_at IS NOT NULL；(4) cleanup 仅遍历过期 in_progress warehouse；(5) sync_log.exit_code 移除 DEFAULT 1 + CHECK (IS NULL OR IN (0,1,2))；(6) release v_pre_wh_id/v_post_wh_id 独立变量 + warehouse lock 行存在校验；(7) get_sync_runs p_limit 显式拒绝 + jsonb_agg ORDER BY；(8) 强化契约测试 32→47 项。未执行 Migration，未连接 Supabase。等待 P5-SY5A 独立静态验收。 |
| 2026-06-14 | P5-SY5A Migration 00007 第一次聚焦返工完成：补齐 sync_run 5 列（triggered_by/triggered_from/heartbeat_at/result_summary/created_at）；release_sync_run 锁后 SELECT sync_run FOR UPDATE + 终态重校验；get_sync_runs CTE ORDER BY + LIMIT before jsonb_agg；claim_sync_run 全部锁后 clock_timestamp()；sync_log FK/CHECK/DEFAULT 约束；修复 dry_run_run_id SELECT INTO 重复写入。静态 SQL 契约测试 32/32 通过。等待独立静态验收。 |
| 2026-06-14 | P5-SY5A Migration 00007 第四次聚焦返工完成：修复 5 项缺陷 — (1) release_sync_run 删除 p_finished_at 参数；(2) 全部锁后单次 v_now := clock_timestamp()；(3) completed/failed 统一使用 v_now 写入 finished_at；(4) claim_sync_run dry_run 过期判断 <= 60 分钟（恰好 60 分钟拒绝）；(5) REVOKE/GRANT 签名更新 10→9 参数。强化契约测试 51→54 项。未执行 Migration，未连接 Supabase。等待 P5-SY5A 独立静态验收。 |
| 2026-06-14 | P5-SY5A Migration 00007 第三次聚焦返工完成：修复 7 项缺陷 — (1) 查询 RPC 邮箱来源 profiles→auth.users（profiles 无 email 字段）；(2) Operator get_sync_run_detail 删除 plan_drift_differences；(3) Operator result_summary 白名单仅含 variantsCreated + inventoryUpdated；(4) get_sync_runs/get_sync_run_detail 新增 warehouse_name (LEFT JOIN warehouse)；(5) heartbeat_sync_run 单次 clock_timestamp() 用于 heartbeat_at + lease_expires_at；(6) 契约测试强化 47→51 项（auth.users.email、branch-level 分支验证、warehouse_name、白名单、heartbeat v_now）；(7) 文档同步。未执行 Migration，未连接 Supabase。等待 P5-SY5A 独立静态验收。 |
| 2026-06-14 | P5-SY5 V5.4.3 第十一次修订完成：第十次独立设计验收聚焦返工未通过，V5.4.3 覆盖全部 4 项返工要求 — (1) 修复数组验证：仅接受规范数组索引（String(index)===key, index<length）拒绝 "01"/"4294967295"、Object.getPrototypeOf(array) === Array.prototype 拒绝子类、'toJSON' in value 拒绝数组 toJSON；(2) 修复对象验证：Reflect.ownKeys 遍历全部字符串键 + 拒绝不可枚举属性（enumerable===false）+ 使用 descriptor.value 读取值；(3) 修复循环检测：WeakSet try/finally 删除（仅代表递归祖先链），共享引用通过、真正循环拒绝；(4) 新增 ~8 项聚焦测试（非规范索引/不可枚举/Array 子类/数组 toJSON/共享引用/循环祖先链），validateJsonValue ~16→~24 场景，P5-SY5F ~38→~46 场景。仅修改设计和状态文档，未实现代码。等待第十一次独立设计验收。 |
| 2026-06-14 | P5-SY5 V5.4.2 第十次修订完成：第九次独立设计验收聚焦返工未通过，V5.4.2 覆盖全部 2 项返工要求 — (1) 完善 validateJsonValue 草案：WeakSet 循环引用检测（含路径）、Reflect.ownKeys 明确拒绝 Symbol 键（对象和数组）、拒绝稀疏数组（`!(i in value)` 空洞检测）、拒绝数组额外属性（非数字索引字符串键）、拒绝 accessor/getter 属性（Object.getOwnPropertyDescriptor 检测 descriptor.get/set）、全面禁止 any 类型（使用 unknown/object/Record<string, unknown>）；(2) 清理冲突文档：删除 current-task.md 验收标准中 V5.4 旧 GC 单层截止项和"取代旧安全性证明"引用；修正 p5-sy5-design.md D22 非确定性描述（移除 replacer/Date 仅保留 toJSON，明确 toJSON 在 prepare() 第 1 步由 validateJsonValue 拒绝）；全文检查并删除与 V5.4.1/V5.4.2 冲突的现行结论。仅修改设计和状态文档，未实现代码。等待第十次独立设计验收。 |
| 2026-06-14 | P5-SY5 V5.4 第八次修订完成：第七次独立设计验收聚焦返工未通过，V5.4 覆盖全部 4 项返工要求 — (1) 绑定 Runner 执行内容：Artifact content 类型限制为严格 JsonValue，prepare() 返回 `{ bytes, hash, normalizedContent }`（normalizedContent = JSON.parse(bytes)），Runner 只能执行 normalizedContent（JsonValue），不得执行原始 object；(2) 原子验证 Real Write 绑定：claim_sync_run 在同一事务内原子验证 dry_run_run_id（warehouse 匹配 + mode=dry_run + status=completed + plan_drift_check=PASS + finished_at < 60 min + hashes 匹配），消除 TOCTOU 窗口；(3) 收紧 GC：GC cutoff 强制 ≥ 审计保留期（7 天），安全性证明（7 天 ≫ 60 分钟），删除 getRecentlyCompletedRunIds；(4) 删除旧 store(content) 契约，同步全部状态文档。新增 D25/D26/D27 设计决策。仅修改设计和状态文档，未实现代码。等待第八次独立设计验收。 |
| 2026-06-14 | P5-SY5 V5.3 第七次修订完成：第六次独立设计验收聚焦返工未通过，V5.3 覆盖全部 4 项返工要求 — (1) 重做 ArtifactProvider bytes 契约：引入 `prepare(content) → { bytes, hash }` 唯一序列化点，`store()` 改为接受 `PreparedArtifact`，claim/store/verify 使用同一份 bytes；(2) 重做 GC 所有权：ArtifactProvider 不查询 sync_run，`gc()` 替换为 `listCandidates()` + GC orchestrator + `deleteMany()`；(3) 新增 `completed_dry_run_requires_plan_artifact` CHECK，共 11 个 CHECK；(4) 清理支持文档。仅修改设计和状态文档，未实现代码。等待第七次独立设计验收。 |
| 2026-06-14 | P5-SY5 V5.1 内部修订：修复 cleanup_expired_sync_runs 的 v_failed_count 计数逻辑（从 fragile error_message 文本匹配+时间窗口改为从 expired CTE 直接 `SELECT count(*) INTO v_batch_count`）；修正 P5-SY5A 验收 CHECK 约束计数（6→7）。仅修改设计文档，未实现代码。等待第五次独立设计验收。 |
| 2026-06-13 | P5-SY5 V5 第五次修订完成：第四次独立设计验收未通过，V5 覆盖全部 4 项返工要求 — 真正统一 claim/release/cleanup 锁顺序（全部按 advisory → FOR UPDATE → sync_run，重写 release/cleanup SQL 草案，删除不符合 PG 可见性的 cleanup 分步交错描述，P5-SY5G 增加 claim-vs-release/claim-vs-cleanup deadlock 验证要求无 deadlock）、修复 artifact 与 runId 生命周期（SyncService 预生成 UUID，`claim_sync_run` 接收 `p_run_id`，hash 基于 canonical JSON 规范化内容，claim 后 store 失败 release 为 failed）、落实终态字段约束（新增 `plan_drift_check_enum`/`plan_drift_count_non_negative`/`failed_requires_fields` CHECK，`completed_requires_fields` 扩展至含 plan_drift_count+plan_drift_differences，release RPC 校验 plan_drift_check 枚举+plan_drift_count 非负，cleanup 设置 exit_code=2 + 返回标记 failed 运行数）、修正文档（删除残留"143"、CLAUDE.md→AGENTS.md、P5-SY5A 严格前向 Migration 不用 IF NOT EXISTS）。`docs/tasks/archive/p5-sy5-design.md`（第五次修订）、`current-task.md`、`phase-5-sync.md` 已同步更新。未实现代码。等待第五次独立设计验收。 |
| 2026-06-13 | P5-SY5 V4 第四次修订完成：第三次独立设计验收未通过，V4 覆盖全部 5 项返工要求。`docs/tasks/archive/p5-sy5-design.md`（第四次修订）、`current-task.md`、`phase-5-sync.md` 已同步更新。未实现代码。等待第四次独立设计验收。 |
| 2026-06-13 | P5-SY5 V3 第三次修订完成：第二次独立设计验收未通过，V3 覆盖全部 6 项返工要求。`docs/tasks/archive/p5-sy5-design.md`（第三次修订，约 950 行）、`current-task.md`、`phase-5-sync.md` 已同步更新。未实现代码。等待第三次独立设计验收。 |
| 2026-06-13 | P5-SY5 V2 第二次修订完成：第一次独立设计验收未通过，V2 覆盖全部 10 项返工要求。`docs/tasks/archive/p5-sy5-design.md`（第二次修订，约 650 行）。未实现代码。等待第二次独立设计验收。 |
| 2026-06-13 | P5-SY5 架构设计完成：`docs/tasks/archive/p5-sy5-design.md` 覆盖 10 项设计要点（用户/权限/调用链/凭据隔离/SyncRunner 接口/并发锁/确认流程/sync_log 展示），拆分 P5-SY5A~F 共 6 个子任务。未实现代码。等待独立设计验收。 |
| 2026-06-13 | P5-SY4E 独立验收通过。P5-SY5 开始：手动同步入口架构设计与任务拆分。暂不实现代码。 |
| 2026-06-13 | P5-SY4E 第一次返工完成：修复 plan_drift_check 不再硬编码 PASS — diffs 为空→PASS，非空→DRIFT_DETECTED；新增 plan_drift_count 和 plan_drift_differences 字段；新增 2 项漂移真实性测试。193/193 测试通过（10 cli_integration + 27 sync_log + 76 executor + 26 plan + 44 verifier + 10 structural），compileall/lint/build 通过。真实 Dry Run 报告路径 `tools/bigseller-scraper/runtime/p5-sy3b-dry-run-20260613-145329.json`，plan_drift_check=DRIFT_DETECTED，plan_drift_count=6。 |
| 2026-06-13 | P5-SY4E 完成：CLI --dry-run/--no-dry-run 互斥组 + 报告 sync_log 摘要 + 8 项聚焦测试 + 真实只读 Dry Run exit 0 无写入。191/191 测试通过（8 cli_integration + 27 sync_log + 76 executor + 26 plan + 44 verifier + 10 structural），compileall/lint/build 通过。报告路径 `tools/bigseller-scraper/runtime/p5-sy3b-dry-run-20260613-143813.json`，sync_log.enabled=True, written=False, reason="Dry Run 模式下不执行实际写入"。等待独立验收。 |
| 2026-06-13 | P5-SY4D 独立验收通过。P5-SY4E 开始：CLI 显式 --dry-run 标志 + sync_log 报告摘要 + 真实只读 Dry Run 端到端验证 + 聚焦测试。 |
| 2026-06-13 | P5-SY4D 最终收尾完成：场景 17 新增文件 I/O（os.path.isfile/builtins.open/json.load）和 Supabase 网关（fetch_ph_warehouse/fetch_ph_variants/fetch_inventory_by_warehouse）NOT-called 断言，完整验证拒绝发生在参数解析后、所有外部依赖调用前。183/183 测试通过，compileall/lint/build 通过。未连接 Supabase，未执行 Migration。 |
| 2026-06-13 | P5-SY4D 第二次返工完成：场景 17 使用完整 Mock 链 + stdout 捕获严格断言禁止消息 + 所有后续操作均未调用；场景 18 Dry Run Mock 链新增 RPC/Phase G/Phase I/SyncLog/fallback mocks 并严格断言均未调用。27/27 测试通过 + 全部现有测试通过（183/183 total），compileall 通过，lint 0 errors 8 warnings，build 通过。未连接 Supabase，未执行 Migration。等待独立验收。 |
| 2026-06-13 | P5-SY4D 第一次返工完成：全部 27 场景重写为通过 `cli_execute.main()` 严格验证退出码 0/1/2。s18 完整 Mock Dry Run CLI 流程 → SystemExit.code == 0，删除 `except Exception: pass`。s02–s12/s16/s19/s23/s24 断言 RPC 恰好 1 次 + Phase G/I 审计未调用 + failed SyncLog + fallback 未调用。s14 CLI exit 2，s15 CLI exit 1。s21/s22 断言 RPC/审计/SyncLog/fallback 均未调用。183/183 测试通过，compileall/lint/build 通过。未连接 Supabase，未执行 Migration。等待独立验收。 |
| 2026-06-13 | P5-SY4D 开始：P5-SY4C 独立验收通过。新建 test_sync_log.py Mock 覆盖 24 场景。禁止连接 Supabase 或执行 Migration。 |
| 2026-06-13 | P5-SY4C 第六次返工完成：4 项修复 — (1) _write_sync_log 成功响应身份校验增强：warehouse_id 必须严格等于请求 warehouse_id；id/status/warehouse_id 必须为非空字符串（拒绝数字/布尔）；list 响应必须恰好包含 1 条记录；非法响应重试 1 次后进入 fallback/exit 路径 (2) 新增 4 项聚焦测试（warehouse_id 不匹配、id 为数字、warehouse_id 为数字、list 多条记录） (3) 修复 2 项旧测试断言适配新校验消息。156/156 测试通过（76 executor + 26 plan + 44 verifier + 10 structural），compileall 通过，lint 0 errors 8 warnings，build 通过。禁止执行 Migration 或数据库写入。等待独立验收。 |
| 2026-06-13 | P5-SY4C 第五次返工完成：7 项修复 — (1) RPC/摘要校验/审计失败时若 sync_log+fallback 双失败，向 stderr 输出明确警告（含 sync_log 错误和 fallback 错误原因），保持原始业务错误为主错误 (2) _write_sync_log 成功响应严格校验：拒绝对空 dict {}/[{}]、要求非空 id/status/warehouse_id、status 必须与请求 status 一致 (3) 新增 7 项聚焦测试（{} 拒绝、[{}] 拒绝、status 不匹配、缺 id、缺 warehouse_id、RPC 失败双失败 stderr 捕获、审计失败双失败 stderr 捕获）。152/152 测试通过（72 executor + 26 plan + 44 verifier + 10 structural），compileall 通过，lint 0 errors 8 warnings，build 通过。禁止执行 Migration 或数据库写入。等待独立验收。 |
| 2026-06-13 | P5-SY4C 第四次返工完成：5 项修复 — (1) _write_sync_log 严格拒绝 list 首元素非 dict（[null]/[string]/[number]） (2) _save_fallback_log 自身异常保护：4 个调用点全部 try/except，原始 RPC/审计主错误不丢失，CLI exit 2 不再依赖 fallback_path (3) 新增 6 项聚焦测试 (4) eslint globalIgnores 加入 .pytest_cache (5) 文档同步。145/145 测试通过（65 executor + 26 plan + 44 verifier + 10 structural），compileall 通过，lint 0 errors，build 通过。禁止执行 Migration 或数据库写入。等待独立验收。 |
| 2026-06-13 | P5-SY4B 独立静态验收通过：Migration 00006（673 行）`quantity` 严格校验移至步骤 5b + 测试场景 1 前置条件修正 + 新增场景 16b。26/26 测试通过，未执行 Migration。 |
| 2026-06-12 | P5-SY4B 返工完成：`quantity` 严格校验（4 层：非 null / JSON number / 严格整数 / >= 0）移至步骤 5b（所有 Variant/Inventory/Warehouse 写入前），步骤 8 复用已校验 quantity；SQL 注释测试场景 1 修正 WM0074 前置条件（已有 Inventory qty=21289 → UNCHANGED），可实际验算 inserted=1 / updated=1 / unchanged=1；新增场景 16b（5 子场景覆盖非严格整数）。673 行，26/26 测试通过。未执行 Migration，未发生数据库写入。等待独立验收。 |
| 2026-06-12 | P5-SY4B 第一次独立验收未通过：`quantity` 严格校验仍位于 Variant INSERT 之后，不符合关键输入校验先于全部业务写入的验收条件；SQL 注释测试场景 1 的前置条件实际产生 2 个 Inventory INSERT，与预期 `inserted=1 / unchanged=1` 冲突。26/26 纯函数测试通过；未执行 Migration，未发生数据库写入。 |
| 2026-06-12 | P5-SY4B Migration 00006 创建完成：`supabase/migrations/00006_sync_warehouse_inventory.sql`（642 行）— 完整 13 步事务 RPC（统一快照时间解析与全量一致性校验在所有业务写入前完成）+ SECURITY INVOKER + SET search_path = '' + 所有对象 public. 限定 + REVOKE/GRANT 权限收口 + 23 个注释形式 SQL 测试场景。26/26 纯函数测试通过。未执行 Migration，未发生数据库写入。等待独立验收。 |
| 2026-06-12 | P5-SY4A 第七次独立设计验收通过：SQL 草案执行顺序已调整为统一快照时间解析与全量一致性校验先于所有业务写入；26/26 纯函数测试通过；未创建 00006 Migration，未发生数据库写入。完整设计归档至 `docs/tasks/archive/p5-sy4a-design-review.md`，当前任务切换至 P5-SY4B。 |
| 2026-06-12 | P5-SY4A 第六次返工完成：SQL 执行顺序修正确保统一快照时间校验在所有业务写入之前。步骤 6a/6b（解析统一快照时间 + 全量一致性校验）移至步骤 7（Variant INSERT）之前；步骤 8（Inventory 写入）/ 步骤 10（写后核对）/ 步骤 11（Warehouse 改名）/ 步骤 12（Warehouse 写后核对）/ 步骤 13（返回摘要）同步重编号。流程描述、P5-SY4B 验收要求（22 项更新）、验收清单（17 项）已同步修正。未创建 00006 Migration，未发生数据库写入。 |
| 2026-06-12 | P5-SY4A 第六次独立验收未通过：CLI 空快照拒绝与 26/26 纯函数测试通过，统一 v_sync_at 已用于 Inventory 三向写入和写后核对；但 SQL 步骤 6 先执行 Variant INSERT，步骤 7a/7b 才校验统一快照时间，与”任何业务写入前完成校验”的要求不一致。未创建 00006 Migration，未发生数据库写入。 |
| 2026-06-12 | P5-SY4A 第五次返工完成：修复 2 项设计与真实实现不一致 — (1) 真实 `validate_json()` 新增 `len(rows)==0` → ValidationError，新增纯函数测试验证空 rows 被拒绝；(2) SQL 步骤 7a/7b/7c 重写：在任何业务写入前解析首条 last_sync_at 为统一 v_sync_at，遍历全部条目强制一致（任一条不同→回滚），全部 INSERT/UPDATE/UNCHANGED 和写后核对使用统一 v_sync_at。P5-SY4B 必须包含从 21 项扩展至 22 项，SQL 测试方案从 16+ 扩展至 17+ 场景，测试矩阵从 23 扩展至 24 场景。 |
| 2026-06-12 | P5-SY4A 第五次独立验收未通过：真实 `validate_json()` 仍接受空 rows，与文档描述不一致；SQL 草案逐条接受不同 `last_sync_at`，未落实同一快照统一同步时间约束。 |
| 2026-06-12 | P5-SY4A 第四次返工完成：修复 2 项可信度阻塞 — (1) RPC 步骤 3 新增 `jsonb_array_length(p_inventory) = 0` → RAISE EXCEPTION，CLI 同步拒绝空快照，防止抓取异常误记 success；(2) UNCHANGED 分支改为 metadata-only UPDATE 刷新 `inventory.last_sync_at`，新增 last_sync_at 非空/可解析校验，写后核对同时验证 quantity 与 last_sync_at。测试矩阵从 21 扩展至 23 场景，P5-SY4B 必须包含从 19 项扩展至 21 项，SQL 测试方案从 14+ 扩展至 16+ 场景。 |
| 2026-06-12 | P5-SY4A 第三次返工完成：修复 2 项正常业务缺口 + 1 项文档修正 — (1) p_inventory 为本次来源完整库存快照（合并全部四类），RPC 内三向分类写入（INSERT/UPDATE/UNCHANGED），返回摘要区分 inventory_received/inserted/updated/unchanged；(2) 新增步骤 4c：每个 p_variants 的 (sku,country) 必须存在于 p_inventory，缺失则 RAISE EXCEPTION；(3) 修正 service_role key 安全描述。测试矩阵从 19 扩展至 21 场景，P5-SY4B 必须包含从 17 项扩展至 19 项，SQL 测试方案从 12+ 扩展至 14+ 场景。 |
| 2026-06-12 | P5-SY4A 第二次返工完成：修复 4 项细节阻塞 — (1) 去重从 `jsonb_agg(DISTINCT value)` 改为 `GROUP BY (sku,country) HAVING COUNT(*)>1`；(2) 新增 Warehouse country='PH' 校验 + 名称白名单 + 逐条 Variant/Inventory country 一致性校验；(3) 新增事务内写后逐 SKU SELECT 核对 + Warehouse 写后 SELECT 核对；(4) 新增显式 `GRANT ... TO service_role`。测试矩阵从 11 扩展至 19 场景，P5-SY4B 必须包含从 12 项扩展至 17 项，SQL 测试方案从 8+ 扩展至 12+ 场景。 |
| 2026-06-12 | P5-SY4A 第二次独立验收未通过：SQL 草案使用整段 JSON 去重而非 `(sku,country)` 业务键；未限制 Inventory/Variant country 与 Warehouse country 一致；未验证允许的 Warehouse 名称及写后逐项状态；REVOKE 后缺少显式 `GRANT ... TO service_role`。 |
| 2026-06-12 | P5-SY4A 返工完成：修复 4 项阻塞 — RPC 输入改用 sku+country+quantity、事务内解析 variant_id、全部关键验证在事务内提交前、SELECT FOR UPDATE 串行化、SECURITY INVOKER + search_path='' + REVOKE 权限收口、SyncLog 规则统一（仅记录已尝试写入的运行、--no-sync-log 仅 Dry Run 可用、success 写入失败 → sys.exit(2)）、新增 network_timeout_unknown 分类与恢复策略。任务拆分 P5-SY4B/C/D/E 已更新，测试矩阵扩展至 11 场景。 |
| 2026-06-12 | P5-SY4A 设计审查完成：确认 4 处部分写入风险位置，判定当前 REST-only 架构无法满足"失败保留上次成功数据"，设计事务 RPC 方案、sync_log 写入时机与自保机制，拆分 P5-SY4B/C/D/E 四个子任务，产出 9 场景测试矩阵。未发生数据库写入。 |
| 2026-06-12 | P5-SY3B 第四次独立验收通过：确认 Phase E fail-fast、Phase I Warehouse 最终状态验证及真实模式计划漂移阻断；83 项 Python 测试、语法检查、lint 与 build 独立通过。切换至 P5-SY4。 |
| 2026-06-12 | P5-SY3B 菲律宾首次真实录入完成：91 ProductVariants 创建（product_id=null, match_status=unmatched）+ 91 Inventory UPSERT（quantity=available_quantity）+ Warehouse 改名（"菲律宾仓"→"菲律宾-新创启辰自建仓"）。幂等验证：3 次连续重跑，0 重复 Variant，91→91→91 核对一致。14 项 executor 测试通过。|
| 2026-06-12 | P5-SY3A 独立验收返工完成：新增 inventory_after_variant_create（91 条）、未知 Warehouse 必须失败、严格 int 校验（拒绝 bool/float 1.0）、product_name 非空、逐行 warehouse 校验、25 项测试、分离分类与动作计数核对 |
| 2026-06-12 | P5-SY3A 菲律宾库存写入映射 Dry Run 完成：sync/ 模块搭建（Supabase 只读网关 + 输入校验 + 计划生成 + CLI）+ 17 项测试 + Dry Run 报告（91→91 全部新 SKU + warehouse rename 计划）|
| 2026-06-12 | P5-SY2 测试与文档收尾：FakePage 测试覆盖 VXE 容器绑定失败和容器标记丢失（10/10 通过）+ README 删除旧回退/跳过/column_mismatch 描述，改为 fail-fast + data 属性绑定 |
| 2026-06-12 | P5-SY2 第二次独立验收返工完成：删除所有 table 回退 + VXE 容器 data 属性绑定 + 列数不匹配/容器绑定失败均明确失败 + 纯函数提取 + 8 项结构保护测试 + 统计公式修正 |
| 2026-06-12 | P5-SY1 独立验收通过并切换至 P5-SY2；发现抓取器会过滤 available=0 且 transit=0 的真正缺货 SKU，正式写入前必须修复 |
| 2026-06-12 | P5-SY2 菲律宾单仓抓取加固完成：91条（98原始-1组合-6无SKU-0重复），零库存13条全保留，表头适配新版13列，遮罩仅处理已知引导层 |
| 2026-06-12 | P5-SY1 BigSeller 只读试跑完成：5仓182条（PH 79/VN 62/TH 19/MY 17/ID 5），available=cur-locked，autoid 仍有效，需处理 language_switch_guide_mask 遮罩；首仓确认为菲律宾 |
| 2026-06-12 | 确认当前无海外库存数据，数据来源为 BigSeller 页面抓取；旧抓取器以只读 JSON 试跑方式归档到 `tools/bigseller-scraper/`，切换至 P5-SY1 |
| 2026-06-12 | P2-I2 独立验收通过：筛选与分页 URL 行为正确，移动端表格可横向滚动，loading 布局一致；切换至 P2-I3 |
| 2026-06-12 | P2-I2 交互与响应式验收完成：搜索输入 key 强制重新挂载、表格 overflow-x-auto、loading 骨架布局对齐 |
| 2026-06-12 | P2-I1 独立验收通过：国家/仓库/搜索/状态筛选在分页前完成，错误页不泄露数据库文本；切换至 P2-I2 |
| 2026-06-12 | P2-I1 返工完成：国家筛选从 DB 层 .eq() 移至 JS 层过滤 + 错误页改为固定中文提示 |
| 2026-06-12 | P2-I1 独立验收未通过：国家筛选关联未使用 inner，可能混入其他国家主记录；错误页直接展示数据库错误文本 |
| 2026-06-12 | P2-I1 海外库存查询与分页正确性 — lint 0 errors + build 通过，等待独立验收 |
| 2026-06-12 | 撤销正式免费部署平台指定：当前仅使用 Vercel/Next.js + Supabase 快速开发，正式部署方案待上线前评估 |
| 2026-06-12 | 明确云服务原则：当前使用 Supabase 与 Vercel/Next.js 生态快速开发，但供应商依赖必须集中封装，页面与核心业务不得深度绑定 |
| 2026-06-12 | 新增强制架构规则：数据库、认证、存储、同步与部署能力必须通过轻量封装使用，为迁移其他平台保留替换空间 |
| 2026-06-11 | 国外库存 MVP 功能修正：重构海外库存查询（全量加载 + JS 筛选分页 + 搜索去 .or() + stockStatus 筛选后分页 + 未匹配状态规则 + loading.tsx/error.tsx） + Dashboard 首页入口 |
| 2026-06-11 | 开发优先级调整：ProductVariant 页面延期，优先交付国外库存看板 MVP |
| 2026-06-11 | ProductVariant Mapping 数据层：Migration 00003/00004/00005 最终修复 + 已执行通过验收（RPC 安全收口 + 函数内去重 + p_items 校验 + public. schema） |
| 2026-06-11 | Task 1.1 — 最终验收修复：关联查询全部 throw ProductError、getByCode DB_ERROR 不静默、eslint exit 0、database.ts 生成类型忽略 |
| 2026-06-11 | Task 1.1 — Product CRUD 验收修复：Repository ProductError 精确错误传播、23505 唯一约束识别、toggleActive 行存在性检测、编辑模式 code 修复、关联 SKU 列名修正、loading.tsx + error.tsx |
| 2026-06-11 | Task 1.1 — Product CRUD 完成：产品列表页 + 详情页 + Sheet 表单 + 数据层收口（UUID 校验/错误日志/code 重复检测/库存关联） |
| 2026-06-11 | 文档与 Claude 配置治理 — 建立按路径 rules、项目文档树并清理冲突规则 |
| 2026-06-10 | Task 0.4 Architecture Audit — 综合评分 9/10，修复 3 个架构问题 |
| 2026-06-10 | Fix — Shipment 创建事务化（新增 migration 00002 + PostgreSQL 函数 + RPC 调用） |
| 2026-06-10 | Fix — Inventory country/warehouseType 过滤下推到 Supabase 查询层 |
| 2026-06-10 | Fix — 提取 `unwrapJoin()` 工具函数，消除 9 处重复类型转换 |
| 2026-06-10 | Task 0.4 完成 — 建立 6 个 feature 模块骨架（30 个文件） |
| 2026-06-10 | Zod v4 `.errors` → `.issues` 修复（3 个文件） |
| 2026-06-10 | Zod v4 `z.enum` `errorMap` → `error` 修复 |
| 2026-06-10 | `common.ts` `ReactNode` import 修复 |
| 2026-06-10 | Task 0.3 完成 — Auth + Dashboard 布局 |
| 2026-06-10 | Task 0.2 完成 — Migration 执行 + 类型生成 |
| 2026-06-10 | Task 0.1 完成 — 项目初始化 |

## Current Build Status

✅ P3-S2C DONE（2026-06-30）：全量 1541/1541 测试通过（46 文件，concurrency / best live excluded），lint 0 errors / 26 warnings，build pass。P3-S2C 新增 `shipmentRepository.getInTransitByVariant()` 在途聚合；海外库存页新增"在途"/"库存+在途"列；Dashboard 关注产品动态新增"在途"列；Dashboard 在途库存卡片替换为真实数据。不新增 Migration。

## Known Limitations

- `profiles.is_active` 认证函数已新增（P5-SY5B）— 旧调用方不受影响，后续任务逐步迁移。
- ~~`middleware.ts` 尚未迁移为 Next.js 16 的 `proxy.ts`~~ — ✅ 已完成（NEXTJS16-PROXY-MIGRATION，2026-07-08）
- Migration 00029/00030（`get_sync_runs_paginated` RPC + Operator 仓库隔离）已执行，Operator 测试账号已验证
- Migration 00031（Phase E 索引优化，返工修正后 7 个索引）已在 Supabase SQL Editor 手动执行成功
- 仓库聚合概览卡片仅展示当前页 rows（非全量），可能遗漏非首页仓库的最新状态 — 运营可接受的范围

## Current Database Migration

- `supabase/migrations/00001_initial_schema.sql` — 初始 schema（10 表 + 42 RLS）✅ 已执行
- `supabase/migrations/00002_create_shipment_transaction.sql` — Shipment 创建事务函数 ✅ 已执行
- `supabase/migrations/00003_tighten_variant_rls.sql` — 删除 operator_update_variant_match 策略，收紧 ProductVariant RLS ✅ 已执行
- `supabase/migrations/00004_batch_match_variants.sql` — SECURITY INVOKER + admin 校验 + 函数内去重 + FOR UPDATE + count 验证 + REVOKE/GRANT ✅ 已执行
- `supabase/migrations/00005_fix_shipment_rpc.sql` — DROP 旧版 10 参数函数 + SECURITY INVOKER + 角色校验 + p_items 输入校验 + auth.uid() + REVOKE/GRANT ✅ 已执行
- `supabase/migrations/00006_sync_warehouse_inventory.sql` — 事务型海外库存同步 RPC（674 行，SECURITY INVOKER + search_path='' + REVOKE/GRANT）✅ 已执行（2026-06-19）
- `supabase/migrations/00007_sync_run.sql` — sync_run 表 + sync_warehouse_lock 表 + sync_log 扩展 5 列 + 6 个 SECURITY DEFINER RPC + 11 CHECK + 补建 + 权限收口（1392 行）✅ 已执行（2026-06-19）
- `supabase/migrations/00008_sync_run_for_update_dry_run.sql` — claim_sync_run Step 6 FOR UPDATE on dry_run 行，关闭 TOCTOU 窗口（244 行）✅ 已执行（2026-06-19）
- `supabase/migrations/00009_generalize_sync_warehouse_country.sql` — CREATE OR REPLACE sync_warehouse_inventory RPC，移除 4 处硬编码 PH 检查，改为动态校验（~500 行）✅ 已执行（2026-06-19）
- `supabase/migrations/00018_add_shipment_no.sql` — P3-S2B：新增 shipment_no NOT NULL UNIQUE + 旧数据回填 + RPC 更新为 10 参数 ✅ 已执行（2026-06-29）
- `supabase/migrations/00019_change_shipment_status_rpc.sql` — P3-S2B 返工：change_shipment_status_transactional RPC（原子化状态更新 + tracking_event 插入，GET DIAGNOSTICS 行确认，禁用 warehoused，SECURITY INVOKER）
- `supabase/migrations/00033_drop_unused_inventory_quantity_indexes.sql` — PERF-H：删除 idx_inventory_low_stock + idx_inventory_quantity（两个 pg_stat_user_indexes 中 idx_scan=0 的未使用部分索引）✅ 已执行（2026-07-07，验证查询 No rows returned）

## Database Vendor Isolation（新增约束）

用户确认后续可能切换国内数据库厂商。当前 Supabase/PostgreSQL 为落地层，但业务层不得新增 Supabase 直接绑定：

- **允许**：Migration 使用 Supabase/PostgreSQL 专用语法（属于落地层）
- **禁止**：P5-SY8 及后续业务代码新增页面/组件/业务逻辑直接依赖 Supabase SDK
- **边界**：UI / Server Actions / SyncService 只依赖接口；数据库实现藏在 Repository / adapter 层
- **命名**：若需要新增真实数据库访问实现，命名为 Supabase/Postgres adapter（如 `SupabaseSyncRepository`），而不是把 Supabase 调用写进通用 SyncService
- **未来切换**：替换 adapter/migration 层，业务层契约不变
- **Python CLI 现状**：现有 `SUPABASE_SERVICE_ROLE_KEY` + Supabase REST 路径继续作为已知差距（GAP-01），不在本次扩散

## Current Blockers

1. **P3-S1B CODE COMPLETE / BLOCKED_EXTERNAL**：百世账号 API 权限尚未开通。`src/lib/providers/best/` 模块代码和测试已完成并保留。恢复条件：百世确认 partnerId 已授权 `queryOrderInfoByOrderNo` / `trackingQuery` 两个只读接口后，重新执行 `npm run test:best-live`。在此之前不标记 DONE，不进入 P3-S1C。

## Next Step

- **PERF-S1A**（DONE，2026-07-03 两次返修）：Migration 00027 + 79 项静态契约测试。
- **PERF-S1B**（DONE，2026-07-03）：Repository + Actions 接入 00027 三个 RPC。
- **PERF-S1C**（DONE，2026-07-03）：在途+已确认聚合，并入 PERF-S1B 完成。
- **PERF-S1D**（DONE，2026-07-03，含两次返修）：关键按钮局部更新，移除 router.refresh()。四个详情页操作组件全部接入 onSuccess 局部刷新链。ShipmentEditForm 进入编辑态时从最新 props 重置表单字段。
- **PERF-S1E**（DONE，2026-07-03）：质量门 / 文档收口 / 性能验收。PERF-S1 全系列完成。
- **PERF-B1**（DONE，2026-07-04）：Phase B 第一轮 request-scope cache + dashboard layout 接入。
- **PERF-C1**（DONE，2026-07-04）：Dashboard 首页查询并行重排（Promise.all）。
- **PERF-C2A**（DONE，2026-07-04）：海外库存 getOverseasInventory 查询编排优化（aggregate/warehouses/list 提前并行）。
- **PERF-C2B**（DONE，2026-07-04）：产品页查询编排优化（列表页/详情页/repository.getById 并行重排）。
- **Phase C 性能优化全部完成。**
- **Phase D（同步页服务端分页）已完成**（2026-07-07，Migration 00029/00030 已执行；Operator 测试账号已创建并验证仓库隔离）。
- **Phase E（索引优化）已完成 + 返工修正 + 生产执行**（2026-07-07，Migration 00031 返工后 7 个索引已在 Supabase SQL Editor 手动执行成功）。
- **PERF-D-CACHE**（DONE，2026-07-07）：移除 server-actions.ts 模块级进程缓存，8 项源码测试。
- **PERF-D-OVERVIEW**（DONE，2026-07-07）：同步页仓库概览改为服务端全量聚合（Migration 00032 RPC + Repository + Server Action + 页面改造），26 项测试，全量 2939/2939 通过 71 文件，build pass，lint 仅既有 5e/25w。Migration 00032 已在 Supabase SQL Editor 手动执行成功。
- **PERF-F-TURBOPACK**（DONE，2026-07-07）：移除 --webpack flag，切换 Next.js 16 默认 Turbopack。修复 1 个 Turbopack 发现的真实 Bug（actions.ts type-only re-export）。不添加 optimizePackageImports（lucide-react 已默认优化，无其他需求）。9 项新测试，全量 2948/2948 通过 72 文件，build pass（Turbopack 3.9s + TS 6.2s），lint 仅既有 5e/25w。
- **PERF-G-IDX-INVENTORY-LOW-STOCK-EVALUATION**（DONE，2026-07-07，2026-07-07 返修口径）：静态评估 `idx_inventory_low_stock` + `idx_inventory_quantity` 两个 quantity 部分索引。`idx_inventory_low_stock` — 建议删除（12 条查询路径分析，RPC 动态参数无法命中）。`idx_inventory_quantity` — 候选删除，需运行时验证（`get_overseas_inventory` out_of_stock 分支仍有 `quantity = 0`，静态分析不能排除命中）。Migration 草案已记录但本轮不实施：`idx_inventory_low_stock` 可直接删除，`idx_inventory_quantity` 待 pg_stat_user_indexes + EXPLAIN 确认后纳入。
- **PERF-H-DROP-UNUSED-INVENTORY-QUANTITY-INDEXES**（DONE，2026-07-07，Migration 00033 已执行）：新增 Migration 00033 删除 `idx_inventory_low_stock` 和 `idx_inventory_quantity`。基于 PERF-G 静态分析 + pg_stat_user_indexes 运行时验证（两个索引均 idx_scan=0 / idx_tup_read=0 / idx_tup_fetch=0 / index_size=16 kB）。14 项静态契约测试。Migration 00033 已在 Supabase SQL Editor 手动执行成功，执行后验证查询 No rows returned（确认已删除）。
- **P6-CSV-EXPORT**（DONE，2026-07-07）：海外库存 CSV 导出 — `toCsv()` 纯函数 + `exportOverseasInventoryCsv` Server Action（分页循环 pageSize=100 / max 10000 / `getInTransitConfirmedAggregate` 回填在途）+ 页面导出按钮（Blob 下载 / UTF-8 BOM）+ 36 项测试。不新增 Migration / RPC / RLS，不改 Repository 签名。
- **P6-OVERSEAS-INVENTORY-UX-V2**（FINAL CLOSED，2026-07-09）：A+B+C+D 全部完成并验收，E 仅计划。Migration 00034/00035/00036 生产已执行并验证。
- **P6-UX-V2-F**（在途库存卡片真实联动，2026-07-09 **DONE**）：在途库存统计卡片改为可点击 → `stockStatus=in_transit`；点击后列表仅显示有在途数量的行（`in_transit` 口径与 `get_in_transit_confirmed_aggregate` 一致：非 warehoused shipment 按 variant_id+warehouse_id 判断 `quantity - warehoused_quantity > 0`）；筛选下拉 raw `all` 修复为中文 placeholder（全部国家/全部仓库/全部状态）。新增 Migration 00037（`CREATE OR REPLACE get_overseas_inventory`，签名不变，仅扩展 `p_stock_status` 白名单增 `in_transit`）。**Migration 00037 已在 Supabase SQL Editor 手动执行并验证通过（2026-07-09），运行时验证通过**。相关测试 160/160 通过，lint 0 errors，build 通过。
- **下一步**：Stage 0 方案确认完成（Stage 0A 审计通过，2026-07-13）。进入 Stage 1 P0 喜运达物流轨迹 API 接入（Migration 00038–00040）。后续严格串行 P0→P1→P7→首页。自动同步仍保持未启用。
- **P3-S1B**：仍 BLOCKED_EXTERNAL（百世 API 权限未开通）。
- **P4-UX**（DONE，2026-07-03）：用户管理页局部刷新收口。全量 2660/2660（63 文件），build pass，lint 仅既有 smoke-test-00025.ts 5e/25w。
- **P2-D2**（DONE，2026-07-04）：Dashboard 低库存汇总看板。全量 2703/2703（64 文件）。
- **SIDEBAR-ENABLE**（DONE，2026-07-04）：侧边栏 SKU 管理/待处理 SKU 入口启用。sidebar-nav.tsx phase '1'→'0' + 4 项测试 + 文档修正。全量 2707/2707（64 文件），lint 仅既有 5e/25w，build pass。不新增 Migration/RLS/权限变更。
- **UNMATCHED-PAGINATION**（DONE，2026-07-04 + 边界空态返修）：待处理 SKU 页面分页补齐 + Pending Modules 文档修正。getUnmatched 改为分页查询（count exact + range + notIn）+ unmatched/page.tsx 分页导航 + 超页 redirect（`?page=999` 超出总页数时跳转最后一页，空态仅 `total===0` 显示）+ 13 项新测试。全量 2720/2720（64 文件），lint 仅既有 5e/25w，build pass。不新增 Migration/RPC。
- **LOW-STOCK-PAGINATION**（DONE，2026-07-04 + RPC 返修）：getLowStock() RPC 分页补齐。Migration 00028 新增 `get_low_stock(p_user_id, p_limit)` RPC（SECURITY INVOKER，SQL 层归档/仓库/低库存过滤 + gap DESC, quantity ASC + LIMIT）。Repository 调用 RPC 替代 JS 全量过滤。移除 getUserArchivedVariantIds / warehouseAccessRepository 导入。25 项 migration 测试 + 10 项 repository 测试 + 5 项相关测试适配。全量 2754/2754（65 文件），lint 仅既有 5e/25w，build pass。
- **P3-S5B**：全部完成（B0~B5 ✅）。
- **P4-U1~U5**：全部完成。Phase 4 用户管理全模块完成。
- **P3-S1B**：CODE COMPLETE / BLOCKED_EXTERNAL。恢复条件：百世确认 partnerId 已授权。
- **P3-S1C**：依赖 P3-S1B，BLOCKED。
- **P3-S1D**：依赖 P3-S1C，BLOCKED。
- **P3-S2**：依赖 P3-S1D，BLOCKED。
- **P3-S4**：依赖 P3-S2 + P3-S3，BLOCKED。

**2026-07-13 历史检查点（已被本文顶部当前状态取代）**：当时 Stage 1 P0 第二轮修复等待复验，质量门为 3596/3596、lint 0 errors / 33 warnings、build pass，Migration 00038–00040 尚未进入 Production。该段仅保留历史上下文，不是当前停止条件；P0/P1/P7 与 00038–00048 的现行状态以本文顶部为准。P3-S1B（百世 API 恢复）仍为 `BLOCKED_EXTERNAL`。

当前业务口径：Admin 维护在途和入仓，Operator 只读查看已分配仓库数据。

## P5-SY3A Dry Run 结果摘要（返工后）

| 指标 | 值 |
|------|-----|
| 输入行数 | 91 |
| Warehouse 改名计划 | `rename`: "菲律宾仓" → "菲律宾-新创启辰自建仓"（复用 ID adc5ec45） |
| 新 SKU (new_variants) | 91 |
| Inventory 新增 (inserts) | 0（现有 variant 无库存记录的场景，当前 DB 无 variant） |
| Inventory 更新 (updates) | 0 |
| Inventory 不变 (unchanged) | 0 |
| Inventory 后建 (after_variant_create) | **91**（P5-SY3B 创建 Variant 后必须执行的 Inventory INSERT） |
| 拒绝行 | 0 |
| **输入行分类总计** | **91 == 91** ✓ |
| **Inventory 动作总计** | **91 == 91** ✓ |
| 数据库 PH variants | 0（首次同步） |
| 数据库仓库名 | "菲律宾仓"（旧名） |

### 返工修复项

| # | 修复项 | 实现 |
|---|--------|------|
| 1 | 显式 Inventory 写入动作 | 新增 `inventory_after_variant_create`，每条含 sku/warehouse_id/new_quantity/depends_on，明确 P5-SY3B 创建 Variant 后必须 INSERT Inventory |
| 2 | 分离计数核对 | 输入行分类总计（91）与 Inventory 动作总计（91）分别核验 |
| 3 | 未知 Warehouse 必须失败 | `_plan_warehouse_rename()` 对旧名/正式名外的任何名称抛出 RuntimeError，不再自动规划改名 |
| 4 | 严格 int 校验 | `type(available) is not int` 拒绝 bool（int 子类）和 float（含 1.0） |
| 5 | product_name 非空 | 逐行校验 product_name 必须非空（product_variant.name 为 NOT NULL） |
| 6 | 逐行 warehouse 校验 | 每行 warehouse 必须精确等于 "菲律宾-新创启辰自建仓" |

### sync/ 模块结构

```text
tools/bigseller-scraper/sync/
├── __init__.py          # 模块标识
├── config.py            # 常量（仓库名、国家代码、新 SKU 默认值）
├── supabase_gateway.py  # Supabase REST API 只读网关（urllib，无额外依赖）
├── input_validator.py   # 输入校验纯函数（仓库名、计数、SKU 唯一性、数量合法性）
├── plan_generator.py    # 写入计划生成纯函数（供应商无关）
├── cli.py               # CLI 入口（argparse --json，显式路径，分离分类计数与 Inventory 动作计数）
└── test_plan.py         # 25 项不依赖 Supabase 的测试
```

### 验证状态

- P5-SY2 结构保护测试: 10/10 PASS
- P5-SY3A 计划生成测试: **25/25 PASS**（含 8 项新增：float 1.0 / bool / 空 product_name / 逐行 warehouse / 未知 warehouse 失败 / inventory_after_variant_create / 动作计数分离 / 混合场景核对）
- ESLint: 0 errors (8 pre-existing warnings)
- `npm run build`: PASS
- Dry Run 报告: `tools/bigseller-scraper/runtime/p5-sy3a-dry-run-*.json`
- 无数据库写入

## P5-SY3B 执行结果（2026-06-12）

### 写入摘要

| 指标 | 值 |
|------|-----|
| 执行批次 | 3 次（首次创建 + 2 次幂等重跑） |
| Warehouse ID | `adc5ec45-cd98-42a8-a1d1-26600e80d481` |
| Warehouse 改名 | "菲律宾仓" → "菲律宾-新创启辰自建仓" |
| 首次 Variant 创建 | 91 |
| 首次 Inventory UPSERT | 91 |
| 第 2 次: Variant 重复创建 | 0（91 跳过） |
| 第 2 次: Inventory 更新 | 91 |
| 第 3 次: Variant 重复创建 | 0（91 跳过） |
| 第 3 次: Inventory 更新 | 91 |
| 幂等验证 | ✅ 3/3 重跑一致，无重复数据 |

### 执行报告

- `tools/bigseller-scraper/runtime/p5-sy3b-execute-20260612-141445.json`（第 2 次 — 完成改名）
- `tools/bigseller-scraper/runtime/p5-sy3b-execute-20260612-143059.json`（第 3 次 — 幂等验证）

### sync/ 模块结构（更新后）

```text
tools/bigseller-scraper/sync/
├── __init__.py          # 模块标识
├── config.py            # 常量（仓库名、国家代码、新 SKU 默认值）
├── supabase_gateway.py  # Supabase REST API 只读网关（urllib，无额外依赖）
├── input_validator.py   # 输入校验纯函数
├── plan_generator.py    # 写入计划生成纯函数（供应商无关）
├── executor.py          # P5-SY3B 执行器（幂等 Variant INSERT + Inventory INSERT/UPDATE + Warehouse 改名，含重试 + Phase G 完整逐项验证）
├── verifier.py          # P5-SY3B 验证器（compare_plans 计划漂移比较 + verify_inventory_post_write 写后逐项验证）
├── cli.py               # P5-SY3A CLI（Dry Run 模式）
├── cli_execute.py       # P5-SY3B CLI（--input-json + --dry-run-report + --execute --confirm P5-SY3B-PH 安全门 + 执行前计划漂移检测）
├── test_plan.py         # 25 项计划生成/校验测试
├── test_executor.py     # 14 项执行器纯函数测试
└── test_verifier.py     # 24 项验证器纯函数测试（15 compare_plans + 9 verify_inventory_post_write）
```

### 约束遵守

- [x] 必须 --execute --confirm P5-SY3B-PH 安全门
- [x] 禁止覆盖已匹配 Variant 的 product_id / match_status
- [x] 复用原 Warehouse ID adc5ec45，不创建新 Warehouse
- [x] Inventory 核验通过后改名 Warehouse
- [x] 幂等可重跑：3 次连续执行无重复数据
- [x] 执行报告不含密钥（supabase_url/service_role_key）
- [x] 不写 sync_log
- [x] 不开始 P5-SY4

### 独立验收返工（2026-06-12）

返工修复项：

| # | 修复项 | 实现 |
|---|--------|------|
| 1 | 完整写后逐项验证 | Phase G 逐 SKU 验证 quantity、检测缺记录/计划外记录/总量不一致，任一差异 fail-fast 阻止 Warehouse 改名 |
| 2 | CLI 显式接收输入 JSON | `--input-json` 与 `--dry-run-report` 均为必需参数 |
| 3 | 执行前计划漂移检测 | 重新查询 Supabase + 从输入 JSON 重新生成计划 + `compare_plans()` 逐项比较 SKU/quantity/Warehouse ID/改名目标 |
| 4 | 漂移检测分级处理 | Dry-run 模式漂移仅警告继续；`--no-dry-run` 模式漂移立即 fail-fast |
| 5 | 补充验证测试 | `test_verifier.py`: 15 项 compare_plans + 9 项 verify_inventory_post_write = 24 项纯函数测试 |

新增/修改文件：

| 文件 | 说明 |
|------|------|
| `sync/verifier.py` | 纯函数验证器：`compare_plans()` 计划漂移比较 + `verify_inventory_post_write()` 写后逐项验证 |
| `sync/executor.py` | Phase G 替换为完整逐项验证，fail-fast 阻止 Phase H；移除弱校验 `_validate_execution()` |
| `sync/cli_execute.py` | 新增 `--input-json` 必需参数；执行前计划漂移检测（dry-run 警告，no-dry-run 阻止） |
| `sync/test_verifier.py` | 24 项纯函数测试（15 compare + 9 verify） |

测试结果：

- `test_plan.py`: 25/25 PASS
- `test_executor.py`: 14/14 PASS
- `test_verifier.py`: 24/24 PASS
- **总计: 63/63 PASS**
- Python 语法: 全部通过
- ESLint: 0 errors (8 pre-existing warnings)
- `npm run build`: PASS

只读验证 CLI 运行结果：

- 计划漂移检测: 6 项差异（预期 — DB 已写入数据，与原始 Dry Run 报告状态不同）
- Dry-run 执行: 91 variants 已存在全部跳过，91 inventory UPDATE 核对一致
- 写后核对: Inventory 计划 91 == 实际 91 [OK]
- Warehouse: 已是目标名称 "菲律宾-新创启辰自建仓"

### P5-SY3A Dry Run 结果摘要（返工后）

（见上方 P5-SY3A 相关章节）

## P5-SY2 加固成果（首次）

### 关键修复

| 修复项 | 变更 |
|--------|------|
| 仓库范围 | 5仓 → 菲律宾单仓（名称过滤 + 反选非目标仓） |
| 零库存保留 | 删除 `available=0 && transit=0` 过滤，13条零库存全部保留 |
| 表头校验 | 新增 `_validate_headers()`，全文档搜索 thead th + VXE 回退，13列按关键词校验 |
| 遮罩处理 | 仅处理 `.language_switch_guide_mask`，不通用删除 `.ant-modal-mask` |
| 统计输出 | 原始行数→非目标仓→组合SKU→无效SKU→去重→最终行数，全链可解释 |

### 表头适配

BigSeller 表头已从旧版更新，`EXPECTED_HEADERS` 同时兼容新旧两套关键词：

| 列 | 旧关键词 | 新关键词 |
|----|----------|----------|
| 3 | 当前库存 | **现有库存** |
| 4 | 锁定库存 | **订单已锁** |
| 5 | 可用库存 | **整仓可用** |
| 6 | 在途库存 | **在途中** |
| 8 | 预警库存 | **警戒库存** |
| 9 | 日均销量 | **预测日销量** |

### 数据概况

| 指标 | 值 |
|------|-----|
| 抓取时间 | 2026-06-12 10:31 CST |
| 原始行数 | 98 |
| 非目标仓库 | 0 |
| 组合SKU排除 | 1 |
| 无效SKU | 6 |
| 去重去除 | 0 |
| **最终行数** | **91** |
| 零可用库存 | 13（含12条纯零库存） |
| 页数 | 2 |

### 字段关系验证

- `cur_stock - locked == available` 91/91 ✅
- SKU 提取成功率: 85/91 (93.4%，6条无SKU码)
- 仓库唯一性: 仅菲律宾-新创启辰自建仓 ✅

## P5-SY2 独立验收返工（2026-06-12 10:46 CST）

### 验收未通过原因

1. 6 条无效 SKU 被 `invalid_sku_count += 1` 后静默丢弃，无法追溯具体内容
2. 仓库选择仍以硬编码 `warehouse_option_6` 为主要定位方式，未真正实现名称优先
3. 表头与表体从分离的 `<table>` 元素独立获取，未绑定同一 VXE 容器；`tds.length < 7` 允许后半字段静默缺失

### 返工修复

| # | 修复项 | 实现 |
|---|--------|------|
| 1 | 无效 SKU 可追溯 | `invalid_sku_rows` 列表收集完整字段（sku_info/warehouse/cur_stock/locked/available/transit），保存到 `runtime/debug/invalid_sku_rows.json` 和 `runtime/output/invalid-sku-rows-*.json` |
| 2 | 仓库名称优先 | 打开下拉后枚举所有 `label.ant-checkbox-wrapper` 的 autoid + text，严格按 `TARGET_WAREHOUSE_NAME` 精确文字匹配；名称匹配失败时回退 `warehouse_option_6` 并验证其文字一致，不一致则抛出 RuntimeError |
| 3 | 表头表体绑定 | `_validate_headers()` 优先在 `.vxe-table` 容器内同时定位 `.vxe-table--header table` 和 `.vxe-table--body table`，通过 xid 返回绑定信息；行提取时 `tds.length === header_count` 严格校验（不再 `< 7`），列数不匹配行单独计数并跳过 |

### 返工后数据概况

| 指标 | 首次 (10:31) | 返工后 (10:46) |
|------|-------------|---------------|
| 原始行数 | 98 | 98 |
| 列数不匹配 | N/A（未校验） | **0** |
| 非目标仓库 | 0 | 0 |
| 组合SKU排除 | 1 | 1 |
| 无效SKU | 6 | 6（**已保存完整记录**） |
| 去重去除 | 0 | 0 |
| **最终行数** | **91** | **91** |
| 零可用库存 | 13 | 13 |
| 表头来源 | N/A | vxe-container（thead th） |

### 无效 SKU 记录（6 条）

| sku_info | 可用库存 | 在途 | 日销 | 原因 |
|----------|---------|------|------|------|
| 硅胶刷头-暗紫色 Brush-darkpurple | 0 | 0 | 0 | 无 SKU 码 |
| 硅胶按摩刷头-绿色 Brush-Green | 0 | 0 | 0 | 无 SKU 码 |
| 硅胶刷头-粉色 Brush-Pink | 0 | 0 | 0 | 无 SKU 码 |
| 硅胶刷头-紫色 Brush-Purple | 0 | 0 | 0 | 无 SKU 码 |
| 硅胶美容刷（菲律宾）--颜色随机 Brush | 0 | 0 | 0.03 | 无 SKU 码 |
| 清洁刷 clean brush | 10,531 | 0 | 17.09 | 无 SKU 码 |

## P5-SY2 第二次独立验收（2026-06-12）

数据结果核对通过：91 条正式结果、6 条无效 SKU 可追溯、13 条零可用库存保留、仓库唯一、91/91 库存关系成立、未发现 Supabase 写入。

第二次验收仍未通过：

1. `_validate_headers()` 仍可回退到任意表头，行提取最终仍可回退到任意含数据行的表格，无法保证同一 VXE 容器绑定。
2. `column_mismatch` 当前只跳过异常行并继续输出，页面结构变化时可能生成不完整 JSON。
3. `raw_row_count` 已排除异常行，但统计公式再次减去 `column_mismatch_count`，异常场景统计不可核对。

## P5-SY2 第二次独立验收返工（2026-06-12 11:07 CST）

### 返工内容

| # | 修复项 | 实现 |
|---|--------|------|
| 1 | 删除所有 table 回退 | `_validate_headers()` 仅通过 `.vxe-table` 容器 + `table.vxe-table--header` / `table.vxe-table--body` 定位，无 thead th 全文档搜索、无 `.vxe-cell--title` 回退。行提取仅通过 `data-bigseller-scraper` 标记属性定位，无任意 VXE 容器搜索、无任意 table 回退 |
| 2 | VXE 绑定失败明确失败 | 无法找到同时含 header/body table 的 VXE 容器时抛出 RuntimeError；行提取时标记属性未找到时抛出 RuntimeError。无静默降级 |
| 3 | 列数不匹配明确失败 | `_extract_page_rows()` 内任意一行 `tds.length !== header_count` 立即抛出 RuntimeError，不生成 JSON。异常详情包含行号、实际列数、期望列数和预览数据 |
| 4 | 修复统计公式 | 删除 `column_mismatch_count`（fail-fast 下始终为 0），公式简化为 `raw - other_wh - combo - invalid - dup = final` |
| 5 | 纯函数提取 | `_validate_header_keywords(headers)` 和 `_parse_cell_rows(cell_rows, header_count)` 提取为纯函数，供测试直接调用 |
| 6 | 最小结构保护测试 | `test_structural_protection.py`：8 项测试，不依赖 BigSeller 登录 — 正常表头通过/关键词失败/列数不足失败/正常数据解析/12列失败/14列失败/混合列失败/字段映射正确 |

### VXE 容器绑定机制

BigSeller 实际 VXE 结构：
```html
<div class="vxe-table">
  <div class="vxe-table--header-wrapper">
    <table class="vxe-table--header"><thead><tr><th>...</th></tr></thead></table>
  </div>
  <div class="vxe-table--body-wrapper">
    <table class="vxe-table--body"><tbody><tr><td>...</td></tr></tbody></table>
  </div>
</div>
```

绑定流程：
1. `_validate_headers()` 在 `.vxe-table` 容器内同时定位 `table.vxe-table--header` 和 `table.vxe-table--body`，在容器上设置 `data-bigseller-scraper="target"` 标记
2. `_extract_page_rows()` 仅通过 `[data-bigseller-scraper="target"]` 定位同一容器，无回退
3. 翻页时 VXE 容器 DOM 复用，标记属性保持有效

### 结构保护测试结果

```
10/10 通过 (0 失败):
  PASS: 正常 13 列表头通过校验
  PASS: 正常 13 列数据行通过解析
  PASS: 表头关键词不匹配时抛出 RuntimeError
  PASS: 表头列数不足时抛出 RuntimeError
  PASS: 任意行少于表头列数(12列)时抛出 RuntimeError
  PASS: 任意行超过表头列数(14列)时抛出 RuntimeError
  PASS: 混合行(13列+12列)中任意一行不匹配即抛出 RuntimeError
  PASS: 解析后的字段映射正确
  PASS: _validate_headers() VXE_CONTAINER_NOT_FOUND 时抛出 RuntimeError
  PASS: _extract_page_rows() CONTAINER_NOT_FOUND 时抛出 RuntimeError
```

## P5-SY2 第三次独立验收（2026-06-12）

生产实现与最新抓取结果通过：任意表格回退已删除，VXE 同容器绑定和列数异常均 fail-fast；最新输出 91 条，统计一致，未发现 Supabase 写入。

## P5-SY2 测试与文档收尾（2026-06-12）

已完成：

1. **FakePage 测试**：新增 2 项测试覆盖 VXE 容器绑定失败和容器标记丢失场景。通过 FakePage 类模拟 `page.evaluate()` 返回值，验证 `_validate_headers()` 在 VXE_CONTAINER_NOT_FOUND 时抛出 RuntimeError，`_extract_page_rows()` 在 CONTAINER_NOT_FOUND 时抛出 RuntimeError。总测试数 10/10 通过。
2. **README 修正**：删除 `column_mismatch_count` 元数据字段、`column_mismatch` 统计项、xid 回退描述、"列数不匹配跳过"描述；改为 `data-bigseller-scraper` 标记属性绑定同一 VXE 容器 + fail-fast + 不生成正式 JSON。

### 返工后数据概况（2026-06-12 11:07 CST）

| 指标 | 值 |
|------|-----|
| 原始行数（全部通过列数校验） | 98 |
| VXE 容器绑定 | ✅ `data-bigseller-scraper` 标记 |
| 表头来源 | `table.vxe-table--header` (VXE 容器内) |
| 非目标仓库 | 0 |
| 组合SKU排除 | 1 |
| 无效SKU | 6（已保存完整记录） |
| 去重去除 | 0 |
| **最终行数** | **91** |
| 零可用库存 | 13 |
| 统计公式 | `98 - 0 - 1 - 6 - 0 = 91` |

> 6 条无效 SKU 均无标准 SKU 码（非 WM/ICEWM/条码格式）。其中 `clean brush` 库存 10,531 为真实库存但无法匹配到 product_variant.sku，后续 P5-SY3 需处理。

## P5-SY1 试跑发现

### 数据概况

| 仓库 | 国家 | 行数 | 可用库存总量 |
|------|------|------|-------------|
| 菲律宾-新创启辰自建仓 | PH | 79 | 806,626 |
| 越南青林湾仓库 | VN | 62 | 348,010 |
| DEE-龙仔厝（ICE专属） | TH | 19 | 565,199 |
| 喜运达MY仓 | MY | 17 | 95,194 |
| 印尼-DEE仓库 | ID | 5 | 74,766 |

### 字段验证

- `cur_stock - locked == available` 全部 182 条成立
- `available_quantity` 已由业务确认作为 `inventory.quantity`
- SKU 提取成功率 100%，产品名称提取 0 缺失
- 182/182 条有日销字段，其中 172 条大于 0
- 现有抓取结果不能证明缺货 SKU 完整：页面读取阶段会过滤 `available=0 && transit=0` 的行

### 选择器状态

| 选择器 | 状态 |
|--------|------|
| `warehouse_option_0/3/4/6/7` (5 仓 autoid) | ✅ 全部有效 |
| `.inp_box` (仓库下拉) | ✅ 有效 |
| `.ant-pagination-next` (翻页) | ✅ 有效 |
| `[autoid="single_sku"]` (单个SKU筛选) | ✅ 有效 |
| `.language_switch_guide_mask` (新增遮罩) | ⚠️ 需在操作前移除（脚本已添加 JS 层关闭逻辑） |

### 首仓推荐

**菲律宾-新创启辰自建仓 (PH)** — 数据量最大（79 条），日销数据完整，包含零库存边界，建议作为首个单仓闭环目标。

## Current Task References

**Phase 4 用户模块核心文件（P4-U1~P4-U5 完成）：**

| 文件 | 说明 |
|---|---|
| `src/features/users/types.ts` | `UserItem` / `UserError`（DB_ERROR / NOT_FOUND / FORBIDDEN / LAST_ADMIN） |
| `src/features/users/schema.ts` | `listFiltersSchema` / `userIdSchema` / `updateRoleSchema` / `toggleActiveSchema` |
| `src/features/users/repository.ts` | `list()` / `getById()` / `getRoleName()` / `countByRole()` / `updateRole()` → RPC / `toggleActive()` → RPC / `listRoles()` |
| `src/features/users/actions.ts` | `listUsers()` / `getUserById()` / `listRoles()` / `updateUserRole()` / `toggleUserActive()` — Admin-only + Zod + RPC 原子保护 |
| `src/features/users/components/user-detail-sheet.tsx` | 用户详情 Sheet（加载/错误/空状态）+ 修改角色 + 启用/禁用入口 |
| `src/features/users/components/user-role-change-dialog.tsx` | 角色变更 Dialog（resetAndClose + pending） |
| `src/features/users/components/user-active-toggle-dialog.tsx` | 启用/禁用 Dialog（resetAndClose + pending） |
| `src/app/dashboard/users/page.tsx` | Server Component：Admin-only 访问控制 + 数据加载 + error boundary |
| `src/app/dashboard/users/_components/users-page-content.tsx` | 列表 + 筛选（状态/角色）+ 分页 + 空数据 + 行点击 → Sheet |
| `supabase/migrations/00001_initial_schema.sql` | role / profiles 表 + RLS 4 策略（admin_all / operator_select / operator_update_own / user_read_own） |
| `supabase/migrations/00024_atomic_user_admin_guard.sql` | P4-U5 新增：`update_user_role_protected` / `toggle_user_active_protected` RPC（pg_advisory_xact_lock + SECURITY INVOKER） |
| `supabase/migrations/00025_rpc_caller_identity_binding.sql` | P4-U5 返工：`auth.uid()` 身份绑定 + REVOKE/GRANT 权限加固 + `check_operator_profile_update` 触发器 |

**P4-U5 验收关注点：**

- **访问控制**：`/dashboard/users` → `getCurrentActiveUser()` → `roleName !== 'admin'` → 无权限提示（不调用任何数据操作）。RLS 四层保护（admin_all_profiles / operator_select_profiles / operator_update_own_profile / user_read_own_profile）。
- **读操作**：`listUsers` / `getUserById` / `listRoles` — `requireActiveAuth()` + Admin-only + Zod safeParse + UserError 转 ActionResult。
- **写操作**：`updateUserRole` / `toggleUserActive` — Admin-only + Zod + RPC 原子保护（自保护 + 最后管理员保护在数据库层原子执行）。
- **客户端组件**：`UserDetailSheet` / `UserRoleChangeDialog` / `UserActiveToggleDialog` — 通过 Server Actions 间接调用，不直接访问 Supabase / service_role / auth.admin。
- **竞态修复**：Migration 00024 RPC 使用 `pg_advisory_xact_lock(987654321)` 序列化 Admin 写操作 + `FOR UPDATE` 锁定目标行，消除「两个管理员互相禁用/降级」TOCTOU 竞态窗口。Migration 00025 叠加 `auth.uid()` 身份绑定（auth.uid() IS NOT NULL / auth.uid() = p_operator_user_id / 活跃 Admin 校验）+ REVOKE EXECUTE FROM PUBLIC, anon + GRANT EXECUTE TO authenticated + `check_operator_profile_update` 触发器禁止 operator 自升 role_id / is_active。
- **错误消息**：所有 RPC RAISE EXCEPTION 使用中文错误消息，Repository 捕获并通过 `UserError('DB_ERROR', error.message)` 传播至 ActionResult。
