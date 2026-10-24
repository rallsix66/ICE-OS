# Current Project State

更新：2026-10-24（**商品库 v6 四项定向补修包已通过独立复审，`V6_FOUR_ITEMS_LOCAL_PASS`**；v5 独立复审为 `UI_REVIEW_NEEDS_FIX`；`U3_LOCAL_UX_PERF_PASS` 与 `LOCAL_PREVIEW_PASS` 原范围不变）。仓库 ICEOS。

## 商品库 v6 四项定向补修包（当前，独审通过 `V6_FOUR_ITEMS_LOCAL_PASS`）

**状态：`V6_FOUR_ITEMS_LOCAL_PASS`（独立复审通过 2026-10-24）。** 结论：商品库 v6 四项定向补修已通过独立复审，按不越权、日常正常使用、关键内容不误导的标准完成本包。独立报告 [independent-review.md](../.local/catalog/independent-ui-frontend-v6-20261024/independent-review.md)；收尾摘要 [catalog-ui-v6-closeout.md](./catalog/catalog-ui-v6-closeout.md)。通过范围仅限 V6-01 来源缓存版本/迟到响应/身份权限隔离、V6-02 来源采用状态与库存说明、V6-03 逐条来源价格缺失文案、V6-04 读取失败/无权限/真实空记录区分；**不覆盖**旧 v6 性能门禁/15×20、原 v4 全量后端、准备链、保存回执六态、真实来源摄取、后续匹配规则。**不代表原 v4/v5 全量验收、全商品库或全 ICEOS 全面通过，也不是真实多账户/撤权/数据库权限矩阵或性能验收。** v5 历史 `UI_REVIEW_NEEDS_FIX` 保留；延期项保留原记录，不写成已修复或已通过。执行方材料 [delivery-summary.md](../.local/catalog/ui-frontend-v6-20261024/delivery-summary.md)、[repair-matrix.md](../.local/catalog/ui-frontend-v6-20261024/repair-matrix.md)、[evidence-index.md](../.local/catalog/ui-frontend-v6-20261024/evidence-index.md)、[screenshots-index.md](../.local/catalog/ui-frontend-v6-20261024/screenshots-index.md)。

**已实施**：撤销 v5 新增的共享来源结果缓存，库存空态提示与数据来源子视图每次重新走服务端鉴权；详情缓存、切仓、迟到响应与身份/金额上下文保护原样保留（V6-01）；来源“本批已采用对应”与“库存已计入”分开，BS 以已确认 BS 样表行为准、JST 不声称计入国内库存，已采用记录不再显示“尚未建立对应/仅名称相似”，未采用记录早期提示默认收起（V6-02）；WM0072 当前采用进货价/运营价保留，逐条来源价格说明改为“暂未展示”（V6-03）；来源数量仅在成功空集合时显示 0，失败/无权限显示“—”，价格单独失败/无权限保留来源记录并可重试，历史重试不切当前（V6-04）。顺手移除两处状态反馈中的 request UUID。

**证据分层（勿混记）**：独立实际页面走查（WM0043 搜索/详情/真实零仓/有货仓/未采用仓/来源/返回/关闭，WM0072 当前价与历史来源往返，5 张新截图与 AX 记录）；独立重跑 33 项受控浏览器检查 + 6 项边界补验均通过（重跑输出与执行证据分离）；独立定向纯测试与组件接线（source-view 5、detail-cache 13、组件异步接线 5/5、投影与组件探针 20/20，分报告有重叠不累加）；本包 6 个受影响文件 eslint `--max-warnings 0` exit 0（`independent-lint.json`）。**仅核执行方材料（不是独立全部重跑）**：主浏览器套件 **22/22（0 skipped/flaky，104.7s）**、单测 **547/548**（唯一既有 opt6 00051）、catalog tsc 0（全仓仅既有 BEST 5）、全仓 lint 0 error/14 条既有 warning、production build 成功。最终候选 BUILD **`UeTuf-hPnkmmIWTQ1LmFU`** @ 3011（pid 34572，快照 `4cf18e57…`，`ownershipVerified=true`，login 200）；独审核对 521 个构建源码条目现役工作区零差异、13 个关键文件 hash 一致。**未覆盖**：失败/无权限/价格失败/真实空为受控响应，不是真实数据库权限故障或 ACL/换号验收；真实 200% 缩放未做；延期项不写成通过。**未写入现役 126 商品/BS 530 行。**

**Git 收尾（2026-10-24）**：本系列累计 UI/交互代码、测试、延期脚本（现有实现归档、相关验收延期）与文档已按逻辑分组提交并普通推送 `origin/codex/ice-v4-planning`；未 merge/deploy，未启停实例，未清场，未开启下一包。提交清单、最终 HEAD、真实远端 SHA 与 ahead/behind 见本地回执 `.local/catalog/ui-v6-closeout-20261024/closeout-record.md`（本地回执与 `.local` 证据不入库）。

## 商品库前端展示与交互收尾包 v5（历史，独审 `UI_REVIEW_NEEDS_FIX`）

**状态：`UI_REVIEW_NEEDS_FIX`（独立复审 2026-10-24）**。独立报告：[independent-review.md](../.local/catalog/independent-ui-frontend-v5-20261024/independent-review.md)。用户已把原 v4 范围收窄为前端展示与交互；v5 只做 V5-01～V5-05，**不是 UI PASS**，未 commit/push/merge/deploy。v6 只承接用户指定的四项定向补修，v5 其余独审项未纳入本包。

**已实施**：来源“本批未采用/已采用”分组、每条记录自己的仓库与真实状态、未计入库存说明、库存空态来源提示，未采用不计库存、真实 0 与未知分开（V5-01）；详情先读完整库存行再按目标仓展示，列表/详情同仓同状态，删除“仓库投影/正在同步列表”，无 confirmed 行不再当 0，切仓目标内容/滚动/快速选择稳定（V5-02）；来源系统/编码/名称/各记录仓库/已有核对提示、当前采用价与逐条来源价格出处、读取失败/无权限/缺值分开（V5-03）；历史当前参照真正显示 6 条记录，返回恢复 current 身份/分区/滚动/焦点，直接历史仍只读（V5-04）；账户/维护/旧 evidence 去技术内容、按货号名称选择商品、旧来源地址进入统一弹窗、intake/sources/商品弹窗统一安全返回（V5-05）。

**执行方自验（非独立结论）**：最终 BUILD **`FuW0YdgLlttyIps2oMXSI`** @ 3011（pid 74664，快照 `aff4a313…`，`ownershipVerified=true`，login 200）；主浏览器套件 **22/22（0 skipped/flaky，1.7m，exit 0）**、v5 定向浏览器探针 **37/37**、单测 **546/547**（唯一既有 opt6 00051）、catalog tsc 0（全仓仅既有 BEST 5）、改动文件 eslint 0/0、`git diff --check` 0；五视口关闭可达/库存首行可见；WM0043/WM0110/WM0072、账户/维护/旧 evidence、后退前进实测。**未完成/未覆盖**：来源全空态与“读商品有权限、读来源/价格无权限”无现役自然样本（仅服务端投影单测）；真实 200% 缩放未覆盖；原 v4 后端/准备链/性能平台按用户范围延期，保留原问题和 `UI_REVIEW_NEEDS_FIX` 证据，不写成通过。**未写入现役 126 商品/BS 530 行。** 当时待审范围仅限 v5 前端展示与交互；独立复审结论为 `UI_REVIEW_NEEDS_FIX`，v6 只承接用户指定的四项定向补修，其余独审项未纳入本包。

## 商品库 UI 集中补修包 v4（历史，独审 `UI_REVIEW_NEEDS_FIX`）

**状态：`UI_REVIEW_NEEDS_FIX`（独立复审 2026-10-24）**。按用户 v4 包要求处理 V4-01～V4-09；**不是 UI PASS**，未 commit/push/merge/deploy。独立报告 [independent-review.md](../.local/catalog/independent-ui-repair-v4-20261024/independent-review.md)。v5 只承接其中前端展示与交互部分，V4-07/V4-08、隔离 DB 六态、真实 prepare 四态和 15×20 性能矩阵按用户调整范围延期，不是已修复。矩阵 [repair-matrix.md](../.local/catalog/ui-repair-v4-20261024/repair-matrix.md)、摘要 [delivery-summary.md](../.local/catalog/ui-repair-v4-20261024/delivery-summary.md)、证据 [evidence-index.md](../.local/catalog/ui-repair-v4-20261024/evidence-index.md)、截图 [screenshots-index.md](../.local/catalog/ui-repair-v4-20261024/screenshots-index.md)。

**已实施**：仓库切换固定顺序、选中不改变按钮宽度、不强制回顶（V4-01）；“数据来源”业务视图替代 JSON/技术身份/下载，来源记录显示自己的仓库与真实对应状态，历史来源只显示该版本事实、当前参照需显式操作（V4-02）；历史不比较当前仓投影、失败重试真正重发目标 revision、跨版本来源返回原版本/分区/滚动，库存/历史首屏优先实际内容（V4-03）；原请求核对只认真实回执与完整意图，基线核 `audit_event` intent、scoped 核 `catalog.new_item_request`（V4-04）；全仓派生先核完整全仓明细再核目标仓投影（V4-05）；返回路径规范化白名单、启用态链接带 from、不以 UUID 为主文（V4-06）；准备链 recordOnly 与 manifest 命中均核 DB（V4-09 部分）。

**执行方自验（非独立结论）**：最终 BUILD **`Dwnb0Go61UvC1sHZx4Uev`** @ 3011（pid 35400，快照 `57f2c5b2…`，`ownershipVerified=true`，login 200）；浏览器主套件 **22/22（0 skipped/flaky，1.7m）**；单测 **536/537**（唯一既有 opt6 00051）；V4-04 定向 50/50、V4-05 13/13、V4-06 18/18；五视口首屏均有库存明细行、切仓按钮矩形不变；WM0072 历史/跨版本来源返回实测；issues/旧直链/穿越 from 实测；catalog tsc 0、eslint 0/0、`git diff --check` 0。

**未完成/未通过**：V4-07 v6 内容完成门禁与真实应用负向未完成；V4-08 没有最终 15×20 性能矩阵，旧 v5 数字不能写成通过；V4-04 隔离 DB 六态、V4-05 隔离缓存反例、V4-09 真实隔离库四态/最终回归未跑；真实 200% 缩放 pending；现役保护指纹未覆盖全部测试时窗。**未写入现役 126 商品/BS 530 行。**

## 商品库 UI 集中补修包 v3（历史，待独立复审）

**状态：`UI_IMPLEMENTED_AWAITING_INDEPENDENT_REVIEW`（2026-10-24）**。按 `.local/catalog/independent-ui-repair-v2-20261024/execution-repair-package-v3.md` 实施 V3-01～V3-08，并处理同目录 v2 独审（`independent-review.md`、`user-feedback-addendum-20261024.md`、`code-review/`、`contract-review/`、`perf-review/`）未通过项；**不是 UI PASS**，未经独立复审；未 commit/push/merge/deploy。矩阵 [repair-matrix.md](../.local/catalog/ui-repair-v3-20261024/repair-matrix.md)、摘要 [delivery-summary.md](../.local/catalog/ui-repair-v3-20261024/delivery-summary.md)、证据索引 [evidence-index.md](../.local/catalog/ui-repair-v3-20261024/evidence-index.md)、截图索引 [screenshots-index.md](../.local/catalog/ui-repair-v3-20261024/screenshots-index.md)。

**产品决定（V3 摘要）**：商品资料/库存/历史/来源围绕同一固定弹窗完成——移除「在新标签页打开」「技术档案」等日常外部跳转与独立详情壳，历史版本在弹窗内查看（当前标记、旧版本只读切换、原位返回），来源/原始证据在内容区子视图按需展开并原位返回（沿用服务端权限）；旧 `/dashboard/catalog/<id>` 307 到同一弹窗，非法版本显式报错，带安全 `from` 时关闭真实回原页；变更记录只显示业务事实（中文理由、可读时间、字段差异、可核实操作者显示名），UUID/JSON 路径/内部英文原因退出日常记录；全流程清理重复口径与工程说明（列表单行样表、单产品重量 kg、体积可读、包装仅真实值、635/短屏压缩、启用态去 fixture/UUID）；切仓在有效缓存/全仓明细基础上即时切换（切仓 0 次详情请求，同 scope 暖复开后台校验），仓名/数量/货值/明细同 scope；草稿与待核请求按主体+商品+意图分键，旧无主体键隔离不认领，核对只读、仅显式「重试原请求」以同 requestId/参数/expectedRevision 重投；返回链保留合法 from、恢复列表筛选与分页位置；不可变事项保留并如实说明“无处理入口/关闭依据待业务定义”，不虚构按钮或改库指令；V3-08 定位非基线候选失败根因为缺 014 候选索引（统一链 009–014 后 168ms），隔离 lane 用最终源码重跑。

**执行方自验（非独立结论）**：浏览器主套件 **22/22（0 failed/skipped/flaky，119.35s）**；v3 UI 采集 **117 checks / 0 failed / 5 uncovered / 70 shots**（1440/1100/635×800/720×450/635×560，外框与三分区矩形逐视口实测一致，from 链与旧直链+from 往返、切仓同仓同范围、分页 2→5→7→6、证据 back 焦点回 summary、历史无 UUID/JSON/英文内部原因）；oracle v5 合成校准 **26/26**（8 正例+18 反例）、merge 自检 **20/20**、期望 crossChecked=true（20 商品）；性能 15 场景×20 样本见 `oracle/runs/`（阈值未下调，超阈桶原样保留）；`tsc --incremental false` 全仓 5 条历史 BEST 基线（商品库 0）、`eslint --max-warnings 0` 0/0、单测 **513/514**（唯一失败为既有 `opt6-production-apply` 00051 换行）、`git diff --check` 0。预览 staging build→校验→promote→start→归属核验，最终 BUILD **`8qFEEnYTJ60Jgk7E_ZiNZ`** @ 3011（pid 21036，快照 `603dc16e7257bb0a…` 与 promote 一致）。

**待独立复审裁定 / 未覆盖**：① 性能 13/15 桶达标；`warmPagination` p95 114.4ms、`warmListRefresh` p95 472.4ms（等待本次 RSC 刷新响应）超 100ms（真实值，未豁免；merge integrity 另含 unit-cost diag/scroll preSatisfied 工具待收敛项）；阈值未下调、未豁免，原样交回）；② 现役 126 商品全为 r1，历史版本切换 5 视口记 uncovered（多版本由隔离 fixture 覆盖）；③ 真实 200% 浏览器缩放 pending（CDP page scale 只改视觉视口，headless 无 UI；未用 DPR/小视口冒充）；④ v5 真实应用负向脚本未新增（15 类由合成 DOM 校准覆盖，v4 16/16 保留为历史证据）；⑤ 隔离 fixture 最终行为矩阵（V3-04 六态/跨账户、V3-05 0 项、V3-08 最终 lane 重跑）见 `.local/.../fixture/`；⑥ 两个 scripts 准备链缺口（recordOnly 未执行 014、increment manifest 命中跳过 DB 核对）如实未修（包外/需授权）。**未写入现役 126 样本/BS 530 行**。

## 商品库 UI 集中补修包 v2（历史，独审 `UI_REVIEW_NEEDS_FIX`）

**状态：`UI_IMPLEMENTED_AWAITING_INDEPENDENT_REVIEW`（2026-10-23）**。按 `.local/catalog/independent-ui-review-20261023/execution-repair-package-v2.md`（U1–U8）与同目录 [independent-review.md](../.local/catalog/independent-ui-review-20261023/independent-review.md)（R1–R10）实施；**不是 UI PASS**，未经独立复审。合并修复/验证矩阵 [repair-matrix.md](../.local/catalog/ui-repair-v2-20261023/repair-matrix.md)；U/R 逐项结果 [u1-u8-r1-r10-results.md](../.local/catalog/ui-repair-v2-20261023/u1-u8-r1-r10-results.md)；单一证据索引 [evidence-index.md](../.local/catalog/ui-repair-v2-20261023/evidence-index.md)；截图文字索引 [screenshots-index.md](../.local/catalog/ui-repair-v2-20261023/screenshots-index.md)。

**产品决定（U1–U8 摘要）**：日常详情改为固定外壳 + 三分区（商品资料/库存明细/变更记录），弹窗与直链共用；概览按 国内（未接入）/ 海外（当前仓已确认库存 + 同范围已估值货值）/ 在途（未接入）/ 已估值货值 组织，进货价移入商品资料；候选审计、原始 JSON、UUID/SHA、受限金额、证据下载退出日常详情，迁入授权维护页 `/dashboard/catalog/admin/evidence?item=`；包装不再默认展示/编辑（无来源列），尺寸按单产品/外箱分组并改用真实源列标签；列表移除工程横幅与重复小字，只留可点击「样表 · 日期」；底部分页支持页码直选且保持分页控件位置（不再滚回表头）；「新标签」收进「更多」；一级导航仅「ICE 商品库」，「数据维护/原始证据」按管理员权限进账户菜单，侧栏「其它处理入口」删除，旧 URL 保留安全引导；启用态新品/来源页面统一现役 UI，技术谓词只在授权维护层。

**执行方自验（非独立结论）**：UI 采集 **76/76**（1440/1100/635/短屏/缩放模拟；含三分区外框矩形一致、真实滚轮/键盘到底、关闭始终可达、技术块不存在、后退/关闭/切分区草稿保护、历史边界、R8 往返、账户/维护/待处理/旧入口/错误页/Demo 冒烟）；oracle v4 合成校准 **27/27**、真实负向 **16/16 拒绝**；20 样本 × 15 桶性能矩阵（4 轮）**14 桶稳定达标 / `detailWarehouseSwitchRealClick` 四轮 p95 113.0–159.8ms 均超 100ms；跨文档桶 3 轮各 1–2 例 90s 未就绪（独立 20 次直链探针 20/20 正常，未剔除样本）**（阈值未下调、未豁免，合并门禁 `allRequired=false` 原样交付）；暖复开 **81.4ms**（旧 289.5ms，取消真实详情缩放入场后达标）；浏览器主套件 **22/22（0 flaky）**；隔离 fixture：R4 四态 16/16×2、R6 注入 13/13+14/14（含直链 BS 失败就地重试与迟到响应）、R7 启用态 7/7+5/5+2/2、R9 启用页 8/8+2/2，现役库只读指纹前后一致；`tsc --incremental false` 全仓 5 条历史 BEST 基线（商品库 0）、`eslint --max-warnings 0` 0/0、单测 **457/458**（唯一失败为既有 `opt6-production-apply` 00051 换行豁免）、`git diff --check` exit 0。预览经 staging build → 校验 → promote → start，最终 BUILD **`7Qzv7GAew213N3WufdT_z`** @ 3011（pid 72784，`ownershipVerified=true`，源码快照 `3a1d5395…` 与 promote 一致）。ui 技能 `emil-design-eng` 已安装并记录版本/条款。

**待独立复审裁定 / 未覆盖**：① `detailWarehouseSwitchRealClick` p95 113.0ms 超 100ms 暖口径（真实点击库存分区顶部仓 chip + 服务端重新取详情；按原文保留失败）；② 维护页“非基线新品候选审计读取失败”**待确认项**（pw-suite 在 new-item C06 迁移后观察到 `catalog-audit-error`；fixture-lab 未能复现，根因未定位；错误文案已改为明确“不等于没有候选/不代表未启用/不是 0 项”）；③ new-item 3/4、source-identity 4/5 未在最终 BUILD 复跑，阻塞点与②同源（另 1 条为包外既有失效）；④ R7 “无事项（0 项）”未覆盖（fixture 自带不可变 unresolved scope，未伪造）；⑤ 200% 缩放为模拟、像素级视觉基线未建立。**未 commit / push / merge / deploy**，现役 126 样本未被写入。

## 商品库 UI 整体改造（历史包，已被 v2 补修覆盖）

状态：上一包 `UI_IMPLEMENTED_AWAITING_INDEPENDENT_REVIEW`（2026-10-23，F01–F17）；独立复审结论 **`UI_REVIEW_NEEDS_FIX`**，其 R1–R10 已在本包中处理，历史证据与报告原样保留（[delivery-summary.md](../.local/catalog/ui-overhaul-20261023/delivery-summary.md)、[f01-f17-results.md](../.local/catalog/ui-overhaul-20261023/f01-f17-results.md)、[独立复审](../.local/catalog/independent-ui-review-20261023/independent-review.md)）。上一轮 BUILD `GaK8dG26vW574fhA5gEBy`/pid 23136 已由本包预览更新替换；上一包结论不代表本次补修通过。

## 商品库 UI 整体改造（历史记录，F01–F17 原登记）

**状态：`UI_IMPLEMENTED_AWAITING_INDEPENDENT_REVIEW`（2026-10-23）**。按独立走查与任务包实施 F01–F17；**不是 UI PASS**，未经独立复审。交付摘要 [delivery-summary.md](../.local/catalog/ui-overhaul-20261023/delivery-summary.md)；F01–F17 逐项 [f01-f17-results.md](../.local/catalog/ui-overhaul-20261023/f01-f17-results.md)；证据索引 [evidence-index.md](../.local/catalog/ui-overhaul-20261023/evidence-index.md)；截图与文字说明 [screenshots-index.md](../.local/catalog/ui-overhaul-20261023/screenshots-index.md)；视觉转述 [visual-review.md](../.local/catalog/ui-overhaul-20261023/visual-review.md)。任务包与走查报告：`.local/catalog/independent-ui-plan-20261023/{execution-package.md,independent-review.md}`。

**已实施（摘要）**：详情改为固定 header + 唯一内部滚动体（F01，直链复用同一体）；列表 6 主列 + 次级展开 + 响应式（F03）；详情首屏概览（F04）；页码收敛与 URL 规范化（F05）；列表/直链/管理分页错误恢复（F06）；弹窗与直链共用业务投影与附件组件（F07）；一级导航收敛 + 只读问题索引 `/dashboard/catalog/issues` + 旧入口安全引导（F08）；弹窗内切仓与历史/来源上下文（F09）；面板内距/控件/焦点环统一（F10）；来源证据中文摘要 + 原始编码可展开（F11）；管理页默认只读结构化、JSON 在技术层（F12）；编辑资料入口与“当前值/拟采用值/依据/理由 + 留空 vs 明确清空”（F13）；主栏中文角色/能力说明/退出可访问名（F14）；图片与缺值分档文案（F15）；金额统一格式（F16）；删除 3 个无引用文件并同步导航断言（F17）。

**执行方自验（非独立结论）**：UI 采集 **87/87**（1440/1100/635/短屏/200%，含真实滚轮到底、Tab 焦点不逃逸、Esc、六仓、分页/越界页码、深链刷新、前进后退、弹窗切仓、错误页、待处理/账户/管理/编辑/来源/旧入口）；新 oracle v3 校准 **22/22**、真实负向 **15/15**；浏览器回归 **18/18（0 flaky，隔离 build + source-drift）**；`tsc --incremental false` 全仓 5 条（历史 BEST 基线，商品库 0）、`eslint --max-warnings 0` exit 0、单测 **445/446**（唯一失败为 AGENTS 已登记的 `opt6-production-apply` 00051 换行既有豁免）、`git diff --check` exit 0。预览经 staging build → 校验 → promote → start 三次，最终 BUILD **`GaK8dG26vW574fhA5gEBy`** @ 3011（pid 23136，`ownershipVerified=true`）。

**未达标 / 待确认（必须由独立复审裁定）**：① 性能 9 桶中 **7 桶达标、2 桶超 100ms 暖口径**——`listFirstWarm`（客户端导航回列表）p95 **504.6ms**、`detailModalReopenWarm`（暖复开）p95 **289.5ms**；阈值**未下调**，合并门禁 exit 2 原样交付；② 隔离 fixture 的写入验收（F13 保存四态、F07 启用模块两入口一致、F06 故障注入）**未执行**；③ Demo 浏览器冒烟未跑（Demo 应用代码未改）；④ 历史版本逐版本视觉未截图；⑤ `warehouseSwitchInModal` 保留单样本 **1033ms** 长尾（p95 58.3ms 达标）。**未 commit / push / merge / deploy**，现役 126 样本未被写入。

## 商品库 Demo 界面与访问性能（历史 PASS，U3）

**商品库 U3 — `U3_LOCAL_UX_PERF_PASS`（独立复审通过 2026-10-23）** — 独立报告 [independent-review.md](../.local/catalog/independent-ux-perf-u3-final-20261023/independent-review.md)；执行摘要 [progress9-delivery-summary.md](../.local/catalog/ux-perf-u3-20261022/progress9-delivery-summary.md)；证据 [evidence-index.md](../.local/catalog/ux-perf-u3-20261022/evidence-index.md)。**通过范围**仅限本地样表商品库的交互、缓存恢复、性能测量与验收门禁；**不代表**新 UI 打磨完成、真实来源接入、生产发布或全 ICEOS 验收，既有 **`LOCAL_PREVIEW_PASS`** 原范围不变。独立审查关闭三项：**R1** 冷门禁改以 `listSample/detailSample.contentReadyMs` 为唯一输入（摘要须等于 `Math.round(原始值)`，缺失/NaN/Infinity/矛盾即拒绝；执行方合并负向 51/51，独立另跑 26 项边界），用新验证器（`f8dcd797…`）复算 `runs/progress8-final5` 原始证据 → **`allRequired=true`**（原始暖 `cab3706e…`、冷 `d8cd3cfc…`、fixture `2ae987d1…` 未改写；旧验证器 `ed717297…` 单独留存）；**R2** runner 校验 `completed===126`、`completed↔itemCount`、`readOnlyEvidence.transactionReadOnly==='on'`，真实 spawn **11/11**（独立另跑 6 项边界，生产 attempts/latest 前后不变）；**R3** 全仓 tsc 总诊断 **21→5**，当前商品库 **16→0**，历史 BEST 测试 **5 条**按范围保留（不声称全仓 tsc 通过；`next build` 过滤 `*.test.*`，不能替代）。执行自验 `runs/progress9-verify-20261023-final/selfverify-steps.json` 8/8 exit 0；BUILD 未变（**`Jq2Y6jz_l7sFTKfSUPYkF`** @ 3011 pid 42900，未重建/未启停）；继承 **126×252 / 0 差异**（progress5 attempt，未重跑）与 **`LOCAL_PREVIEW_PASS`**。

证据分层（勿混记）：**本次独立重跑**＝合并器 51 项正负向、26 项冷门禁边界、runner 11 项测试与 6 项边界、实际 tsc、19 项单测、eslint、diff-check、冻结原始数据复算、编译凭据/文件漂移、只读进程归属；**沿用上一轮同审查方独立结果**＝loader cache 7 + recovery 5、oracle 校准 3/3 与内容判定 25/25（应用未改）；**执行日志核验/继承**＝完整 Playwright 17/17、暖 15×20 矩阵、3 次冷进程、staging build/promote、126×252 只读候选等价，本轮只复算原始数据，未重新采样或重启。progress8 的 `allRequired=true` 在其原计时门禁下保留为历史结论，progress9 起以原始计时重算复核；progress7 的 `allRequired=true` **不能作为通过依据**（计时在 DOMContentLoaded 重开、首开前等 audit-ready、负向捕获初始化异常、`sourceHashes` 回填、详情预取失败自循环）；progress6 `allRequired=false` 为旧串行断言计时；progress5 `allRequired=true` 为**旧不完整断言口径**。

**既有失败与遗留（不影响本期范围）**：全仓 tsc 仍有历史 BEST 测试 5 条诊断（`src/lib/providers/best/__tests__/client.test.ts` 3 条、`dry-run.test.ts` 2 条，均 TS2352），按用户范围不修；p95 通过伴随 WM0005 单次 **4377ms** 尾延迟，保留事实，不宣传每次即时展示；根目录历史 build 与全量旧回归不因本报告变成全绿。**下一会话**：新版 UI 打磨、新品/来源核实问题触发式入口与进一步清理，本轮不扩开发。

## 本地真实商品预览（历史 PASS）

**`LOCAL_PREVIEW_PASS`** — 本包独立验收完成（[最终独审](../.local/catalog/independent-local-preview-final-20261021T084549Z/independent-review.md)）。通过范围：本地真实商品及本批样表库存预览（126 资料、BS 530 展示、六仓、已确认口径货值、启停与测试证据）；**不代表**实时同步、生产启用或全库 ICEOS 已交付。索引：[local-preview-delivery-index.md](./catalog/local-preview-delivery-index.md)。

**最终独审核验（2026-10-21）**：独立重跑 VM 控制流探针 9 场景 exit 0；独立重算短程 before/after 各 126 行投影 SHA 均为 `330125d4fdf1cddb00b2630822edfdcc87b6ac6cd3f21d9519e1abe2048de0fe`，时间顺序有效；只读 status/登录与进程归属通过（审查时点 PID 与短程记录可不同，见 delivery-index）。短程原始 JSON、历史全链自验与商品/估值/RLS 门禁结论为**原始日志核查或继承**，本轮未重跑 prepare、完整自验或业务回归。

**Git**：catalog 积压与 closeout 测试已推送 `codex/ice-v4-planning`（manifest §4；`package.json` 在 **acb4865**）。本包累积成果（Legacy 封存与删除、ICE v4 外壳、商品库 UI/缓存/性能、013–014 增量、预览工具链、测试与文档）已在独审通过后按依赖分批提交并 push `codex/ice-v4-planning`，未 merge/deploy；提交清单与远端 SHA 见 `.local/catalog/ux-perf-u3-20261022/final-closeout/closeout-record.md`（证据目录不入库）。`.local` 证据与凭据不入库；Git 无待提交变更不等于本地实例/缓存已清理（见 [工作区盘点](../.local/catalog/workspace-git-audit-20261021/workspace-git-audit.md)）。

## 来源身份N1A与持续新品N1C（保留）

**N1A_LOCAL_PASS保持；N1C_LOCAL_PASS仅表示本地隔离独立通过。** 依据[N1C独立总报告](../.local/catalog/independent-new-item-review-20261021T015312Z-e38782af/independent-review.md)登记，原[执行交付](../.local/catalog/new-item-delivery-20261020T142050Z-85800652/delivery-index.md)及其待审时点报告原样冻结，不改写历史。已实现八表/七写动作/五SQL、固定商品观测、四分流、缺码新品、同来源slot复用、证明关联/后补身份及非价修订；不等于整个商品系统、真实接入或生产完成。

独立实际重跑 `run-20261021T015418Z-3825abe1`：C34领域/23PG/4浏览器、A兼容46/19/5、未装A/C旧首包41/12/2和三隔离build全部通过，浏览器无跳过/flaky；另34项独立追加探针为C01封套25项与C09直接成员关联9项，不混入原门禁计数。独立报告记录14,764文件起止零变化，6门禁PG＋2探针PG及3Next停止、数据保留；执行方22PG/9Next停止另列，不混计。本轮仅文档登记，没有重新运行上述测试或启服务。

独立审查对lint退出0、普通回归4132通过/1项既有OPT6失败、直接tsc54旧诊断仅核执行日志，未独立重跑；三build确已独立重跑。框架Page/RSC/Action按批准no-store合同验证，无效Cookie配置已撤回；自有raw/export GET的private/no-store/Cookie实际断言通过，但原GET headers未单独归档，不能声称逐份原始头重解析。

126资料、1417来源、548具体原目标/JST与全部历史、3160 CSV/6190历史索引、147完整产物/129子集保持。原122缺码同UUID，C127仅虚构测试；WM0072采用5.18/5.68与来源观测5/5.5及历史、金融指针、两刷子、未建档及public三表保持。P0_01/02/03_PASS、P0-03收尾、商品首包与N1A结论全部继承。

真实身份核实0、relationshipUsable=false、飞书partial；B provider仍为接口fixture，长期关系和库存未启用。本轮只改三入口当前区，[文档收尾证据](../.local/catalog/docs-closeout-20261021T020835Z-869e3fc6/delivery-index.md)另存，历史尾部及原交付/独立报告/源码SQL测试配置保护。登记与只读复核后双方停止，不准备或启动N1B/N2/真实采集/长期关系/库存或下一任务；不清场、桌面操作、记忆写入、提交推送部署。

## 商品资料首包（已独立签收）

首包及R1/R2/R3已[独立复审通过](../.local/catalog/independent-repair-review-20261020T094514Z-bd17af9f/independent-review.md)，仅本地隔离范围。[补修报告](./catalog/verification-report-repair-20261020T092115Z-2b8397ed.md)、[原首包报告](./catalog/verification-report-run-20261020T081620Z-2a2cc8e4.md)及旧CHANGES_REQUIRED保留。旧独立实际重跑41领域/12PG/2浏览器/隔离build，另5PG探针/2恢复流程；lint/普通回归/tsc当时仅核执行日志，不混为本次独立重跑。桌面33份原地保留、归档0的独立结论保持，本轮没有重扫。

## P0-03 状态

阶段状态：**P0_03_PASS**。[独立总验收报告](../.local/p0-03/reviews/evidence/independent-final-acceptance-20261020-49c832b7/independent-review.md)已确认本期有限范围通过，文档收尾完成。通过范围为产品主库整理、商品身份标准、本批样表对应与人工决定保存、输出一致及历史可追溯；不代表全部产品资料已核实或后续接入与库存使用已实现。

- 规则唯一正文：[商品身份标准v1](./product-identity-standard-v1.md)，已同步当前事实与刷子后续保留要求；未修改已批准身份原则，未实现数据库唯一约束。
- [本轮任务](./tasks/p0-03/2026-10-20-final-acceptance.md)、[明确决定JSON](./p0-03/final-decisions-20261020.json)、[总验收报告](./p0-03/verification-report-p0-03-final-acceptance-20261020.md)。
- [唯一最终输出](../.local/p0-03/run-20261020-final-acceptance/evidence/final-2026-10-20T03-41-45-834059Z-cd7d4d19/delivery-final-v2/)，覆盖在其coverage/；首版delivery-final、再生和负向输出仅作证据，不是并列现行结果。
- 业务基线为最新已独立通过的JST交付，bundle SHA256 `3c2babc9b13ca11fab14cb4bbce5e8617052319d06bc80c922256f6893346159`、有效CSV `48544cd03154131970fce220fb2ff7c704e18d7860e2ea7c72e6a0ef1ac8d921`已核对。只继承该CSV，不重建桌面决定，不重跑匹配替换基线；新输出及决定哈希见报告。

已落实：菲越376/380/526三条WM0012确认升级普通版、解除版本待决、原目标不变，不计新增；JST WM0006/WM0008本批ignore且目标空，理由仅用户要求本批忽略；JST857行WM0130确认主库121行；BS菲越220/321两条WM0073新确认主库67行，当前confirm覆盖旧defer并保存历史。六项规格说明关闭：两项本批忽略，WM0031/WM0062/WM0098/WM0130采用主库C列，不改原名称/数值、不换算g/ml；WM0062 JST789行reject保持。刷子WM0081原62与brush原107行分列可见，继续待确认。

实际重算：126份主资料、125非空唯一ICE货号＋1缺码新品，1417来源（BS530/JST887）；548有效选择＝BS430＋JST118，较原545新增3；覆盖114双方/2仅BS/4仅JST/6双方暂无确认，有选择120份。774待核对、1候选、3拒绝、3忽略、88规则外；一般未核对775。原545目标/JST引用、原22条完整记录、原11JST确认、WM0007ignore、WM0070/WM0072 BS未建档、WM0072现价5.18/5.68及两版历史保持。8来源、9份总览审计/来源ID、216完整字段变化均可追溯；主资料业务字段未改。

当前菲越版本待决0、六项规格open0/closed6，指定业务决定全部落实。继续延期：WM0081与brush及5条BS刷子/1条JST候选不合并不猜绑；新品缺码、工厂/其他缺失、图片内容未核验、一般未核对及未涉及拒绝/规则外/纠错保持。图片128锚点、123份找到对象/3未找到不表示内容已核验或真实无图。BS70/72等待建档正常，不造来源或0库存。后续正式系统也须保留两份刷子及待确认状态，本轮只登记要求。

本轮执行实际重跑：136回归（原121＋15）、完整P0-03门禁、1417/126全量与所有保存投影、21组新业务负向＋原12组在新结果重跑、原16组在历史JST基线重跑、历史审计28/32与新44组负向、10图片测试、2审计CLI保护、6本地文件实际浏览器、147份逐字节再生成、lint/build及保护/文档/diff检查通过。完整命令和退出码在报告；初检失败、首版差异路径修复及既有openpyxl/NFT/Git提示保留，不把初检失败隐藏为全绿。

独立总验收实际重跑：136回归、1417/126全量及原545目标/JST引用/原22条/3160行CSV、21＋12＋16组业务负向、新44及历史28/32组审计负向、10图片测试、6本地文件浏览器、147份逐字节再生成、2审计CLI保护和范围/链接/diff检查均通过；另有19项冻结基线探针及原Excel OOXML逐格、逐份覆盖和仓库汇总核算。完整P0-03门禁、lint、build由独立审查仅核查执行日志，未独立重跑。本次文档收尾仅做链接、一致性及diff检查，未重跑功能测试，不与前两次验证混记。

历史独立通过保留：[主库整理](./p0-03/verification-report-p0-03-curation-20261019.md)、[四项确认](./p0-03/verification-report-p0-03-confirmations-20261019.md)、[两项审计说明补修](./p0-03/verification-report-p0-03-coverage-audit-repair-20261020.md)、[11条JST确认、WM0007忽略及BS未建档说明](./p0-03/verification-report-p0-03-jst-confirmations-20261020.md)及其[独立报告](../.local/p0-03/reviews/evidence/independent-jst-confirmations-20261020-dce89074/independent-review.md)。原CHANGES_REQUIRED、执行自验、独立重跑和仅日志核查各自保持，不改写成同一次检查。本轮此前停于P0_03_IMPLEMENTED_AWAITING_REVIEW，现依据独立总验收登记P0_03_PASS，不由过去分批通过推定整体结论。

后续方向：飞书表格识别新品；BS通常新品发出时建档，可以晚于主库/JST，BS匹配不以JST成功为硬前提；飞书接入方向获确认、BS考虑抓取、JST API可用性待核实。正式关系保存、自动复用、数量归集、组合/换款、库存同步和估值仍未实现且不在本批；不指定飞书全部字段为最终主数据源，不猜货号生成方式。

停止于**P0_03_PASS（文档收尾完成）**，上述已批准延期不阻塞本期有限范围验收；不要求所有商品同时具备两系统对应或全部空值补齐。全部旧报告/证据、原始资料、HOLD和其他未提交修改保留；neat-freak仅本次五份文档对齐，不清场、不写记忆。不入库、不接真实服务、不发布/同步库存、不提交/推送/合并/部署或推进下一阶段。

## P0-02 状态

| 项 | 状态 |
|---|---|
| 现役结论 | **`P0_02_PASS`**（独立审查 @ `9507d86`，2026-10-15） |
| 正式 PASS 报告 | [verification-report-p0-02-pass-20261015.md](./p0-02/verification-report-p0-02-pass-20261015.md) |
| 审查目录 | `.local/p0-02/run-20261014-r2/reviews/independent-p002-delivery-9507d86-20261015-01/` |
| Canonical Run | `run-20261014-r2` |
| 执行方总验收（历史） | `npm run check:p0-02` exit 0（`check-2026-10-15T07-07-04-252Z`） |
| Postgres 规模 | **18** vitest 文件 / **61** 项（**56** PG + **5** config） |
| Browser A3 | **21** 项 Playwright（check 子证据） |

**历史（非现役）：** d082728 审查 **CHANGES_REQUIRED** → 返工交付 **IMPLEMENTED_AWAITING_REVIEW** → 9507d86 独立审查 **PASS**。实施报告：[verification-report-r2-20261015-d082728-rework.md](./p0-02/verification-report-r2-20261015-d082728-rework.md)。

## P0-01 状态（保留）

**P0_01_PASS** · Run `run-20261013-r1`

opt6：**1 failed / 5 passed**（00051 换行，未改；全门禁已知固定豁免）。

## 阶段边界（2026-10-15 用户确认）

- **已完成：** 保留功能脱离 Supabase、本地虚构数据下的独立平台验收（**P0_02_PASS**）。
- **不迁移：** 不迁移旧 Supabase 业务数据，不沿用旧 SKU/商品映射（用户已确认，非延期项）。
- **后续：** 正式账号与权限重建、真实来源接入与用户重新匹配、生产启用；满足既定前置条件后删除旧 Supabase 环境。
- 详见 [product-plan-v4.md](./product-plan-v4.md) 与 [architecture-v3.md](./architecture-v3.md) 的 P0-02 后续方案节。

## 文档清理（2026-10-15）

已删除过时的 DIS 内网部署方案（commit `77b2c4d`，用户单独授权）。现役部署以 [architecture-v3.md](./architecture-v3.md) 与 P0-02 为准。
