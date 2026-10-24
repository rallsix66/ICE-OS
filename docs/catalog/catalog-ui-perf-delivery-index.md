# 商品库 Demo 界面复用与访问性能包 — 交付索引

状态：**`U3_LOCAL_UX_PERF_PASS` — 独立复审通过（2026-10-23）**；文档登记与分批提交完成，未 merge/deploy。v6 四项定向补修已独审通过（**`V6_FOUR_ITEMS_LOCAL_PASS`**，2026-10-24）。继承 **`LOCAL_PREVIEW_PASS`**（原范围不变）。U3 的 BUILD `Jq2Y6jz_l7sFTKfSUPYkF` 已由后续 UI 整体改造包、集中补修包 v4、前端展示与交互收尾包 v5 及 **v6 四项定向补修包** 的 staging build → 校验 → promote 替换为 **`UeTuf-hPnkmmIWTQ1LmFU`**（见下节）。历史轮次报告与结论原样保留，不改写。

## 商品库 v6 四项定向补修包（当前，`V6_FOUR_ITEMS_LOCAL_PASS`）

- 状态：**`V6_FOUR_ITEMS_LOCAL_PASS` — 独立复审通过（2026-10-24）**。商品库 v6 四项定向补修已通过独立复审，按不越权、日常正常使用、关键内容不误导的标准完成本包。只覆盖 V6-01 来源缓存版本/迟到/身份权限隔离、V6-02 来源采用状态与库存说明、V6-03 逐条来源价格缺失文案、V6-04 读取失败/无权限/真实空记录区分；**不覆盖**旧 v6 性能门禁/15×20、原 v4 全量后端/准备链/保存回执/真实来源摄取、后续匹配规则；**不代表原 v4/v5 全量验收、全商品库或全 ICEOS 全面通过，也不是真实多账户/撤权/数据库权限矩阵或性能验收**；v5 历史 `UI_REVIEW_NEEDS_FIX` 保留，`U3_LOCAL_UX_PERF_PASS` 与 `LOCAL_PREVIEW_PASS` 原范围不变。独立报告 `.local/catalog/independent-ui-frontend-v6-20261024/independent-review.md`；收尾摘要 [catalog-ui-v6-closeout.md](./catalog-ui-v6-closeout.md)。
- 交付物：`.local/catalog/ui-frontend-v6-20261024/{delivery-summary,repair-matrix,evidence-index,screenshots-index}.md`、`screenshots/`、`browser-probe-result.json`、`preview-status.json`、`source-hashes.json`、`build-hash-check.json`、`main-suite-result.json`、主套件原件 `run-20261021T100700Z-b3c4d5e6/evidence/browser-2026-10-24T09-30-30-635Z-504c56/`。
- 证据分层：独立实际页面走查（WM0043 搜索/详情/真实零仓/有货仓/未采用仓/来源/返回/关闭，WM0072 当前价与历史来源往返，5 张新截图与 AX 记录）；独立重跑 33 项受控浏览器检查 + 6 项边界补验通过；独立定向纯测试与组件接线（source-view 5、detail-cache 13、组件异步接线 5/5、投影与组件探针 20/20，重叠不累加）；本包 6 个受影响文件 eslint `--max-warnings 0` exit 0（`independent-lint.json`；执行方索引所引 `lint-changed-final.log` 原件缺失，以该独立结果为准）。执行方主套件 **22/22（0 skipped/flaky，104.7s）**、单测 **547/548**（唯一既有 opt6 00051）、catalog tsc 0（全仓仅既有 BEST 5）、全仓 lint 0 error/14 条既有 warning、production build 成功，仅由独审核查原始材料，**不是独立全部重跑**。候选 BUILD **`UeTuf-hPnkmmIWTQ1LmFU`** @ 3011（pid 34572，快照 `4cf18e57…`，ownershipVerified=true，login 200）；独审核对 521 个构建源码条目现役零差异、13 个关键文件 hash 一致；已删共享缓存两侧均不存在。
- 未覆盖：失败/无权限/价格失败/真实空为受控响应，不是真实数据库权限/ACL/换号验收；真实 200% 缩放未做；延期项不写成通过。全仓 BEST 5 条类型诊断、opt6 00051、14 条既有 lint warning 原样保留。

## 商品库前端展示与交互收尾包 v5（历史，独审 `UI_REVIEW_NEEDS_FIX`）

- 状态：**独审 `UI_REVIEW_NEEDS_FIX`（2026-10-24）**。独立报告 `.local/catalog/independent-ui-frontend-v5-20261024/independent-review.md`。用户已把原 v4 范围收窄为前端展示与交互；v5 只做 V5-01～V5-05，**不是 UI PASS**，未 commit/push/merge/deploy；v6 只承接用户指定的四项定向补修，v5 其余独审项未纳入本包。
- 范围：V5-01 本批未采用与库存；V5-02 空仓一致性与切仓；V5-03 数据来源业务展示；V5-04 历史来源与返回；V5-05 账户/维护/旧入口与统一返回。
- 交付物：`.local/catalog/ui-frontend-v5-20261024/{delivery-summary,repair-matrix,evidence-index,screenshots-index}.md`、`screenshots/`、`browser-probe-result.json`、`timing-probe.json`、`source-hashes.json`、`capture/smoke-final3/`。
- 执行方自验（非独立结论）：最终 BUILD **`FuW0YdgLlttyIps2oMXSI`** @ 3011（pid 74664，快照 `aff4a313…`，ownershipVerified=true，login 200）；主套件 **22/22（0 skipped/flaky，1.7m，exit 0）**、v5 探针 **37/37**、单测 **546/547**（唯一既有 opt6 00051）、catalog tsc 0（全仓仅既有 BEST 5）、改动文件 eslint 0/0、`git diff --check` 0；五视口、WM0043/WM0110/WM0072、账户/维护/旧 evidence、后退前进实测。
- 未覆盖：来源全空态与“读商品有权限、读来源/价格无权限”无现役自然样本（仅服务端投影单测）；真实 200% 缩放；原 v4 后端/准备链/性能平台延期。

## 商品库 UI 集中补修包 v4（历史，独审 `UI_REVIEW_NEEDS_FIX`）

- 状态：**独审 `UI_REVIEW_NEEDS_FIX`**（2026-10-24）。**不是 UI PASS**，未 commit/push/merge/deploy；独立报告 `.local/catalog/independent-ui-repair-v4-20261024/independent-review.md`。v5 只承接其前端展示与交互部分；V4-07/V4-08、隔离 DB 六态、真实 prepare 四态和 15×20 性能矩阵按用户调整范围延期，不是已修复。
- 范围：仓库切换稳定（固定顺序、选中不改变宽度、不强制回顶）；“数据来源”业务视图（来源系统/编码/名称/每记录仓库/真实对应状态/中文字段差异/价格；历史事实与当前参照分离；JSON/UUID/技术下载退出用户界面）；历史投影隔离、失败重试、跨版本来源返回、短屏首屏实质内容；原请求只认真实回执与完整意图；全仓派生完整投影；返回路径规范化/启用态 from；准备链 recordOnly/manifest DB 核验。
- 交付物：`.local/catalog/ui-repair-v4-20261024/{delivery-summary,repair-matrix,evidence-index,screenshots-index}.md`、`screenshots/`、`ui-probe/`、`capture/smoke/`、`source-hashes.json`、`increments-probe.json`。
- 执行方自验（非独立结论）：最终 BUILD **`Dwnb0Go61UvC1sHZx4Uev`** @ 3011（pid 35400，快照 `57f2c5b2…`，ownershipVerified=true，login 200）；浏览器主套件 **22/22（0 skipped/flaky，1.7m）**；单测 **536/537**（唯一既有 opt6 00051）；V4-04 定向 50/50、V4-05 13/13、V4-06 18/18；五视口首屏库存行 visible、切仓按钮矩形不变；WM0072 历史/跨版本来源返回、issues/旧直链/穿越 from 实测；catalog tsc 0、eslint 0/0、`git diff --check` 0。
- 未完成/未通过：V4-07 v6 内容完成门禁与真实应用负向未完成；V4-08 无最终 15×20 性能矩阵（旧 v5 数字不能写成通过）；V4-04 隔离 DB 六态、V4-05 隔离缓存反例、V4-09 真实隔离库四态/最终回归未跑；200% 真实缩放 pending；保护指纹未覆盖完整测试时窗。

## 商品库 UI 集中补修包 v3（历史，待独立复审）

- 状态：**已实施，待独立复审**（2026-10-24）。**不是 UI PASS**，未 commit/push/merge/deploy；`U3_LOCAL_UX_PERF_PASS` 与 `LOCAL_PREVIEW_PASS` 原范围不变。
- 任务包 / 独审：`.local/catalog/independent-ui-repair-v2-20261024/execution-repair-package-v3.md`（V3-01～V3-08）；同目录 `independent-review.md`（`UI_REVIEW_NEEDS_FIX`）、`user-feedback-addendum-20261024.md`、`code-review/`、`contract-review/`、`perf-review/`。
- 交付物：矩阵 `repair-matrix.md`、摘要 `delivery-summary.md`、证据索引 `evidence-index.md`（源码/测试/docs/db/scripts hash、BUILD/run/归属、截图轮、浏览器轮、fixture、性能原始数据、门禁脚本 hash、v4→v5 差异）、截图文字索引 `screenshots-index.md`；均在 `.local/catalog/ui-repair-v3-20261024/`。
- 执行方自验（非独立结论）：浏览器主套件 **22/22（0 flaky，119.35s）**（`capture/main-suite-final/`；原件 `run-20261021T100700Z-b3c4d5e6/evidence/browser-2026-10-24T02-54-18-308Z-835e1b/`）；v3 UI 采集 **117 checks / 0 failed / 5 uncovered / 70 shots**（`screenshots/2026-10-24T02-59-10-941Z/`、`capture/raw-2026-10-24T02-59-10-941Z/`）；oracle v5 校准 **26/26**（`oracle/runs/2026-10-24T11-02-cal5/`）、merge 自检 20/20、期望 crossChecked=true；15 场景×20 样本矩阵与 merge 判读见 `oracle/runs/` 与证据索引；单测 513/514、tsc 5 条历史基线、eslint 0/0、`git diff --check` 0。
- 预览：staging build → 凭据/源码快照校验 → promote → start → 归属核验；最终 BUILD **`8qFEEnYTJ60Jgk7E_ZiNZ`** @ 3011（pid 21036，快照 `603dc16e7257bb0a…` 与 promote 一致）。
- 待独立复审裁定 / 未覆盖：性能 13/15 桶达标；`warmPagination` p95 114.4ms、`warmListRefresh` p95 472.4ms（等待本次 RSC 刷新响应）超 100ms（真实值，未豁免；merge integrity 另含 unit-cost diag/scroll preSatisfied 工具待收敛项）；现役全 r1 → 历史版本切换 5 视口 uncovered（多版本在隔离 fixture）；真实 200% 浏览器缩放 pending；v5 真实应用负向脚本未新增（15 类由合成校准覆盖，v4 16/16 保留历史）；隔离 fixture 最终行为矩阵结果见 `.local/.../fixture/`；scripts 准备链两处缺口如实未修（包外/需授权）。

## 商品库 UI 集中补修包 v2（历史，独审 `UI_REVIEW_NEEDS_FIX`）

- 状态：**已实施，待独立复审**（2026-10-23）。**不是 UI PASS**，未 commit/push/merge/deploy；`U3_LOCAL_UX_PERF_PASS` 与 `LOCAL_PREVIEW_PASS` 原范围不变。
- 任务包 / 独审：`.local/catalog/independent-ui-review-20261023/execution-repair-package-v2.md`（U1–U8）、`independent-review.md`（R1–R10）、`perf-review/review.md`、`independent-ui-code-review-20261023/code-review.md`。
- 交付物：修复矩阵 `repair-matrix.md`；逐项结果 `u1-u8-r1-r10-results.md`；证据索引 `evidence-index.md`（源码树 hash、预览快照 `3a1d5395…`、BUILD、run、截图轮、浏览器轮、性能原始数据、门禁脚本 hash）；截图文字索引 `screenshots-index.md`；技能记录见矩阵 §0（`emil-design-eng` @ `2d228630…`）。均位于 `.local/catalog/ui-repair-v2-20261023/`。
- 执行方自验（非独立结论）：UI 采集 **76/76**（`runs/ui-2026-10-23T13-31-46-220Z/`，49 张截图）；oracle v4 校准 **27/27**（`oracle/runs/2026-10-23T21-50-cal6/`）；真实负向 **16/16 拒绝**（`oracle/runs/2026-10-23T22-20-neg2/`）；20 样本 × 15 桶矩阵（`oracle/runs/2026-10-23T22-30-final3/`，见下）；浏览器主套件 **22/22（0 flaky）**（`run-20261021T100700Z-b3c4d5e6/evidence/browser-2026-10-23T13-42-08-467Z-6f6453/`，snapshot 与 promote 一致）；隔离 fixture R4 16/16×2、R6 13/13+14/14、R7 7/7+5/5+2/2、R9 8/8+2/2（`ui-repair-v2-20261023/fixture/evidence/`）；`tsc` 全仓 5 条历史基线（商品库 0）、eslint 0/0、单测 457/458、`git diff --check` 0。
- 预览：staging build → 凭据与源码快照校验 → promote → start → 归属核验；当前 BUILD **`7Qzv7GAew213N3WufdT_z`** @ 3011（pid 72784，`ownershipVerified=true`，快照 `3a1d5395…` 与 promote 一致）。
- 待独立复审裁定：`detailWarehouseSwitchRealClick` 四轮 p95 **113.0–159.8ms** 均超 100ms 暖口径（阈值未下调、未豁免，合并门禁 `allRequired=false` 原样交回）；跨文档桶 3 轮各 1–2 例 90s 未就绪且未剔除（独立直链探针 20/20 正常）；维护页“非基线新品候选审计读取失败”待确认项（根因未定位）；new-item 3/4、source-identity 4/5 未在最终 BUILD 复跑；R7“无事项”未覆盖（未伪造）；200% 缩放为模拟。

## 商品库 UI 整体改造（后续包，`UI_IMPLEMENTED_AWAITING_INDEPENDENT_REVIEW`）

- 状态：**已实施，待独立复审**（2026-10-23）。**不是 UI PASS**，未 commit/push/merge/deploy；`U3_LOCAL_UX_PERF_PASS` 与 `LOCAL_PREVIEW_PASS` 原范围不变。
- 任务包 / 走查：`.local/catalog/independent-ui-plan-20261023/{execution-package.md,independent-review.md}`（F01–F17）
- 交付摘要：`.local/catalog/ui-overhaul-20261023/delivery-summary.md`；逐项结果：`f01-f17-results.md`；证据索引：`evidence-index.md`；截图说明：`screenshots-index.md`；视觉转述：`visual-review.md`；影响矩阵：`impact-matrix.md`
- 执行方自验（非独立结论）：UI 采集 87/87；oracle v3 校准 22/22；真实负向 15/15；浏览器回归 18/18（0 flaky）；`tsc` 全仓 5 条历史基线（商品库 0）；eslint 0；单测 444/445（唯一既有 `opt6-production-apply` 00051 换行豁免）；`git diff --check` 0
- 预览：staging build → 凭据校验 → promote → start 共 3 次；当前 BUILD **`GaK8dG26vW574fhA5gEBy`** @ 3011（pid 23136，`ownershipVerified=true`）
- 待独审裁定：`listFirstWarm` p95 504.6ms、`detailModalReopenWarm` p95 289.5ms 超 100ms 暖口径（阈值未下调，合并门禁 exit 2）；隔离 fixture 写入验收与 Demo 浏览器冒烟未执行

## U3 最终独立复审（2026-10-23，U3 结论）

- 独立报告：[independent-ux-perf-u3-final-20261023/independent-review.md](../../.local/catalog/independent-ux-perf-u3-final-20261023/independent-review.md) → **`U3_LOCAL_UX_PERF_PASS`**，三项剩余问题关闭，无阻塞性补修项
- 通过范围：本地样表商品库交互、缓存恢复、性能测量与验收门禁；**不代表**新 UI 完成、真实来源接入、生产发布或全 ICEOS 验收
- 执行摘要：[ux-perf-u3-20261022/progress9-delivery-summary.md](../../.local/catalog/ux-perf-u3-20261022/progress9-delivery-summary.md)；证据索引：[ux-perf-u3-20261022/evidence-index.md](../../.local/catalog/ux-perf-u3-20261022/evidence-index.md)
- 独立重跑：合并器 51 项正负向 + 26 项冷门禁边界；runner 11 项测试 + 6 项真实边界；实际 tsc；19 项单测；eslint；diff-check；冻结原始数据复算；编译凭据/漂移；只读进程归属
- 证据分层：loader cache 7 + recovery 5、oracle 校准 3/3、内容判定 25/25 沿用同审查方上一轮独立结果；完整 Playwright 17/17、暖 15×20、3 次冷进程、staging build/promote、126×252 候选等价为执行日志核验/继承，未重新采样

## U3 progress9（2026-10-23，已并入上节结论）

- 独审输入：[independent-ux-perf-u3-progress9-20261023/review-notes.md](../../.local/catalog/independent-ux-perf-u3-progress9-20261023/review-notes.md)（仅剩 R1 冷门禁、R2 runner 完成数/只读证据）
- 执行摘要：[ux-perf-u3-20261022/progress9-delivery-summary.md](../../.local/catalog/ux-perf-u3-20261022/progress9-delivery-summary.md)
- 证据索引：[ux-perf-u3-20261022/evidence-index.md](../../.local/catalog/ux-perf-u3-20261022/evidence-index.md)
- 串行自验：`ux-perf-u3-20261022/runs/progress9-verify-20261023-final/selfverify-steps.json`（8/8 exit 0，顺序 runner → 合并负向 → 复核 → tsc → 单测 → lint → diff）
- 冷门禁复核（新文件，不改原证据）：`ux-perf-u3-20261022/runs/progress8-final5-recheck-20261023/merge-recheck.json` → `allRequired=true`
- Runner：真实 spawn 边界 **11/11**（新增 completed/readOnlyEvidence 三项拒绝）
- 类型：当前商品库 **0 条**诊断；历史 BEST 测试 **5 条**另列（`external-healthcheck-audit-20261023/progress9/tsc-catalog-check.json`）
- 边界：未改应用源码，未重跑暖 15×20 / 冷 3 次 / 126 项 PG 等价

## U3 progress8（历史）

- 独审输入：[independent-ux-perf-u3-progress8-20261023/review-notes.md](../../.local/catalog/independent-ux-perf-u3-progress8-20261023/review-notes.md)（CHANGES_REQUIRED 三组）
- 摘要：`ux-perf-u3-20261022/progress8-delivery-summary.md`；串行自验 `runs/progress8-final5/selfverify-steps.json`（9/9）
- 其 `allRequired=true` 由旧冷门禁给出，progress9 已用严格门禁复核并保留原证据
- BUILD `Jq2Y6jz_l7sFTKfSUPYkF` / snapshot `3f08ab21…`（staging build → promote → 核对）；预览包 Playwright **17/17**（含恢复 5、loader cache 7）
- 启动脚本提示：`CATALOG_PREVIEW_PORT=3011` 必须经环境变量传入（`--port` 参数不被读取）

## U3 progress7（历史）

- 独审：[independent-ux-perf-u3-progress7-20261023/review-notes.md](../../.local/catalog/independent-ux-perf-u3-progress7-20261023/review-notes.md)（CHANGES_REQUIRED）
- 摘要：`ux-perf-u3-20261022/progress7-delivery-summary.md`；当时的 `allRequired=true` **不能作为通过依据**（计时起点在 DOMContentLoaded 重开、首开前等 audit-ready、负向捕获初始化异常、sourceHashes 回填）
- 旧 BUILD `3iTQd38mCGB0EOYOHd-J8`；旧暖/冷 run 保留不删

## U3 补修（2026-10-22 起点）

- 有效性能脚本：`perf-content-ready-u3.mjs`（v2 计时 + 逐样本分段）· 合并：`merge-perf-json-u3.mjs`
- 旧矩阵降级：`ux-perf-r3-fix-20261022/perf-content-ready-r3.json`（终点断言无效）

## U2 补修（2026-10-22，已被 U3 接替）

- 独审输入：[independent-ux-perf-r2-20261022/independent-review.md](../../.local/catalog/independent-ux-perf-r2-20261022/independent-review.md)（CHANGES_REQUIRED）
- 执行摘要：[ux-perf-r3-fix-20261022/delivery-summary.md](../../.local/catalog/ux-perf-r3-fix-20261022/delivery-summary.md)

## R1–R6 历史（2026-10-22，继承）

- [ux-perf-r2-fix-20261022/delivery-summary.md](../../.local/catalog/ux-perf-r2-fix-20261022/delivery-summary.md)
- 候选等价：`candidate-equivalence.json`（0 差异组；现行继承 `attempts/progress5-20261022-180727`）
- 性能（暖操作，已被 r3 取代为参考）：`perf-content-ready-r2.json`

## 范围（封存 + R4 继承）

- **Legacy 封存**：仓库 `archive/legacy-business-20261022/` 仅清单/指针/说明（`manifest.json`、`EXTERNAL-POINTER.json`、路由白名单、旧入口处置表、`RESTORE.md`）；完整源码外置 `D:/try one/ICEOS-legacy-archive/20261022/`；构建/测试/ts 排除 `archive/**`。
- **现役**：商品库 / 持续新品 / 来源核实 / 管理审计；`/dashboard` → 商品库；旧 URL 封存说明或重定向；旧 API HTTP 410。
- **R4-1**：SQL 增量 PG 独立库 **保持，不重开**。
- **外壳**：`IceV4WorkspaceShell` 导航仅现役四项；`catalog-detail` Pill → `src/ui/ice-v4/primitives`。
- **继承 R3/R2**：013、preview-operating-config、六仓/金额/perf 证据。

## R5 交付摘要

- [repair-delivery-summary.md](../../.local/catalog/ui-perf-r5-cleanup-20261022/repair-delivery-summary.md)
- [verification-index.json](../../.local/catalog/ui-perf-r5-cleanup-20261022/verification-index.json)

## 自验（执行方，非独立结论）

| 项 | 命令 / 证据 | 退出码 |
|---|---|---|
| progress9 串行自验 | `runs/progress9-verify-20261023-final/selfverify-steps.json`（runner → 合并负向 → 复核 → tsc → 单测 → lint → diff） | 8/8 = 0 |
| progress8 串行自验（历史） | `runs/progress8-final5/selfverify-steps.json`（fixture/校准/负向/合并负向/runner/浏览器/暖矩阵/冷测/合并） | 9/9 = 0 |
| Lint | `npm run lint -- --max-warnings 0` | 0 |
| diff --check | 仅 CRLF 提示 | 0 |
| tsc（全仓） | `node node_modules/typescript/bin/tsc --noEmit --incremental false` | 2（总 5 条；商品库 0，历史 BEST 5） |
| R5/R4 历史门禁 | `lint-pass.log`、`preview-start.log`、`logged-in-perf-probe.log`、截图 | 0 |

## 预览（现役）

- **Run** `run-20261021T100700Z-b3c4d5e6`
- **商品库** http://127.0.0.1:3011/dashboard/catalog
- **Demo** http://127.0.0.1:3011/demo/ice-v4
- 当前 v5 BUILD **`FuW0YdgLlttyIps2oMXSI`**（pid 74664，快照 `aff4a313…`，ownershipVerified=true，login 200）
- 尾延迟事实：WM0005 单次 **4377ms** 慢样本保留（历史 U3 事实），p95 合同通过不等于每次请求都低于阈值；v5 局部耗时见 `.local/catalog/ui-frontend-v5-20261024/timing-probe.json`

```powershell
$env:CATALOG_PREVIEW_PORT='3011'
$env:CATALOG_PREVIEW_NEXT_MODE='start'
node scripts/catalog/start-local-preview.mjs --run-id run-20261021T100700Z-b3c4d5e6
node scripts/catalog/status-local-preview.mjs --run-id run-20261021T100700Z-b3c4d5e6
node scripts/catalog/stop-local-preview.mjs --run-id run-20261021T100700Z-b3c4d5e6
```

## 独审报告

| 轮次 | 路径 |
|---|---|
| **最终（现役，`U3_LOCAL_UX_PERF_PASS`）** | `.local/catalog/independent-ux-perf-u3-final-20261023/independent-review.md` |
| progress9（输入） | `.local/catalog/independent-ux-perf-u3-progress9-20261023/review-notes.md` |
| progress8（输入） | `.local/catalog/independent-ux-perf-u3-progress8-20261023/review-notes.md` |
| progress7 | `.local/catalog/independent-ux-perf-u3-progress7-20261023/review-notes.md` |
| R4（更早阻断） | `.local/catalog/independent-ui-perf-r4-20261022/independent-review.md` |

## Git

本包累积成果已按依赖分批提交并 push `codex/ice-v4-planning`（Legacy 封存/删除、ICE v4 外壳、商品库 UI 与缓存、性能与候选等价工具、013–014 增量、预览工具链、测试、文档）；未 merge/deploy，不 force push。提交清单、远端 SHA 与剩余文件盘点见 `.local/catalog/ux-perf-u3-20261022/final-closeout/closeout-record.md`（证据目录不入库）。**下一会话**：新版 UI 打磨与新品/来源核实问题触发式入口。
