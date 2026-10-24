# Current Task Packet

## 商品库 v6 四项定向补修包（当前，独审通过 `V6_FOUR_ITEMS_LOCAL_PASS`）

状态：**`V6_FOUR_ITEMS_LOCAL_PASS`（独立复审通过 2026-10-24）**。商品库 v6 四项定向补修已通过独立复审，按不越权、日常正常使用、关键内容不误导的标准完成本包。通过范围仅限 V6-01 来源缓存版本/迟到响应/身份权限隔离、V6-02 来源采用状态与库存说明、V6-03 逐条来源价格缺失文案、V6-04 读取失败/无权限/真实空记录区分；**不覆盖**旧 v6 性能门禁/15×20、原 v4 全量后端、准备链、保存回执六态、真实来源摄取、后续匹配规则。**不代表原 v4/v5 全量验收、全商品库或全 ICEOS 全面通过，也不是真实多账户/撤权/数据库权限矩阵或性能验收**；v5 历史 `UI_REVIEW_NEEDS_FIX` 保留；延期项保留原记录，不写成已修复或已通过。

- 独立报告：[independent-review.md](../../.local/catalog/independent-ui-frontend-v6-20261024/independent-review.md)；收尾摘要：[catalog-ui-v6-closeout.md](../catalog/catalog-ui-v6-closeout.md)；执行方材料：[delivery-summary.md](../../.local/catalog/ui-frontend-v6-20261024/delivery-summary.md)、[repair-matrix.md](../../.local/catalog/ui-frontend-v6-20261024/repair-matrix.md)、[evidence-index.md](../../.local/catalog/ui-frontend-v6-20261024/evidence-index.md)、[screenshots-index.md](../../.local/catalog/ui-frontend-v6-20261024/screenshots-index.md)。
- 实施：撤销 v5 新增的共享来源结果缓存，库存空态提示与数据来源子视图每次重新走服务端鉴权，详情缓存/切仓/迟到保护原样保留（V6-01）；来源“本批已采用对应”与库存计入分开，BS 以已确认库存行为准、JST 不声称计入国内库存，已采用记录不再显示早期筛查结论，未采用记录早期提示默认收起（V6-02）；WM0072 当前价保留，逐条来源价格说明改为“暂未展示”（V6-03）；来源数量仅在成功空集合时显示 0，失败/无权限显示“—”，价格单独失败/无权限保留来源记录并可重试（V6-04）。
- 证据分层：独立实际页面走查（WM0043 搜索/详情/真实零仓/有货仓/未采用仓/来源/返回/关闭；WM0072 当前价与历史来源往返）；独立重跑 **33 项受控浏览器检查 + 6 项边界补验**通过；独立定向纯测试与组件接线（source-view 5、detail-cache 13、组件异步接线 5/5、投影与组件探针 20/20，分报告重叠不累加）；本包 6 个受影响文件 eslint `--max-warnings 0` exit 0（`independent-lint.json`）。执行方主套件 **22/22（0 skipped/flaky，104.7s）**、单测 **547/548**（唯一既有 opt6 00051）、catalog tsc 0（全仓仅既有 BEST 5）、全仓 lint 0 error/14 条既有 warning、production build 成功，**仅由独审核查原始材料，不是独立全部重跑**。候选 BUILD **`UeTuf-hPnkmmIWTQ1LmFU`** @ 3011（pid 34572，快照 `4cf18e57…`，ownershipVerified=true，login 200）；独审核对 521 个构建源码条目现役零差异。
- 未覆盖：失败/无权限/价格失败/真实空均为受控响应，不是真实数据库权限故障或 ACL/换号验收；未做真实 200% 缩放；逐条来源价格完整追溯、精确焦点、旧 URL 分支、旧 v6 性能门禁/15×20、v4 后端/prepare/增量恢复/保存六态、真实来源摄取、后续匹配规则继续延期，不写成通过。全仓 BEST 5 条类型诊断、opt6 00051、14 条既有 lint warning 原样保留。
- 停止点：**`V6_FOUR_ITEMS_LOCAL_PASS`**。2026-10-24 已完成文档与 Git 收尾：累计 UI/交互代码与测试、延期脚本（现有实现归档、相关验收延期）、文档按逻辑分组提交并普通推送 `origin/codex/ice-v4-planning`；未 merge/deploy，未启停实例，未清场，不自动开启下一包。Git 凭证见 `.local/catalog/ui-v6-closeout-20261024/closeout-record.md`（本地证据不入库）。

## 商品库前端展示与交互收尾包 v5（历史，独审 `UI_REVIEW_NEEDS_FIX`）

状态：**`UI_REVIEW_NEEDS_FIX`（独立复审 2026-10-24）**。用户已明确把 v4 范围收窄为前端展示与交互；本包只做 V5-01～V5-05，**不是 UI PASS**，未 commit/push/merge/deploy，现役 126 样本与 BS 530 行未被写入。独立报告：[independent-review.md](../../.local/catalog/independent-ui-frontend-v5-20261024/independent-review.md)。v6 只承接用户指定的四项定向补修，其余独审项未纳入本包。

- 摘要：[delivery-summary.md](../../.local/catalog/ui-frontend-v5-20261024/delivery-summary.md)；矩阵：[repair-matrix.md](../../.local/catalog/ui-frontend-v5-20261024/repair-matrix.md)；证据：[evidence-index.md](../../.local/catalog/ui-frontend-v5-20261024/evidence-index.md)；截图说明：[screenshots-index.md](../../.local/catalog/ui-frontend-v5-20261024/screenshots-index.md)。
- 范围：V5-01 本批未采用与库存关系、V5-02 空仓一致性与切仓、V5-03 数据来源业务展示、V5-04 历史来源与返回、V5-05 用户入口/统一返回。延期：后续匹配规则、真实来源接入、DB prepare/增量恢复、保存回执六态、完整 v6 门禁、15×20 性能矩阵、无关历史遗留；延期项不是通过。
- 执行方自验：最终 BUILD **`FuW0YdgLlttyIps2oMXSI`** @ 3011（pid 74664，快照 `aff4a313…`，ownershipVerified=true，login 200）；主浏览器套件 **22/22（0 skipped/flaky，1.7m，exit 0）**、v5 探针 **37/37**、单测 **546/547**（唯一既有 opt6 00051）、catalog tsc 0（全仓仅既有 BEST 5）、改动文件 eslint 0/0、`git diff --check` 0；五视口、WM0043/WM0110/WM0072、账户/维护/旧 evidence、后退前进实测。未覆盖：来源全空态与“读商品有权限、读来源/价格无权限”无现役自然样本（仅投影单测）；真实 200% 缩放。
- 停止点：历史 **`UI_REVIEW_NEEDS_FIX`**；v6 只承接用户指定的四项定向补修，v5 其余独审项未纳入本包。

## 商品库 UI 集中补修包 v4（历史，独审 `UI_REVIEW_NEEDS_FIX`）

状态：**`UI_REVIEW_NEEDS_FIX`（独立复审 2026-10-24）**。按用户 v4 包实施 V4-01～V4-09：仓库切换稳定、数据来源业务化、历史/来源返回、原请求回执与意图、全仓缓存投影、返回路径/启用态 from、准备链修复；**不是 UI PASS**，未 commit/push/merge/deploy，现役 126 样本与 BS 530 行未被写入。

- 合并矩阵：[repair-matrix.md](../../.local/catalog/ui-repair-v4-20261024/repair-matrix.md)；交付摘要：[delivery-summary.md](../../.local/catalog/ui-repair-v4-20261024/delivery-summary.md)；证据索引：[evidence-index.md](../../.local/catalog/ui-repair-v4-20261024/evidence-index.md)；截图说明：[screenshots-index.md](../../.local/catalog/ui-repair-v4-20261024/screenshots-index.md)。
- 范围：V4-01 仓库固定顺序/选中不改变宽度/不强制回顶；V4-02 “数据来源”业务视图（来源系统、来源编码/名称、每记录自己的仓库、真实对应状态、中文字段差异、价格；历史事实与当前参照分离；移除 JSON/UUID/技术下载）；V4-03 历史投影隔离、失败重试、跨版本来源返回、短屏首屏实质内容；V4-04 原请求只认真实回执与完整意图；V4-05 全仓派生完整明细投影；V4-06 返回路径规范化与启用态 from；V4-09 准备链 recordOnly/manifest DB 核验。继承 `U3_LOCAL_UX_PERF_PASS` / `LOCAL_PREVIEW_PASS` 原范围；不接真实来源、不改业务规则、不新增 migration/schema/审批状态。
- 执行方自验：浏览器主套件 **22/22（0 skipped/flaky，1.7m）**；单测 **536/537**（唯一既有 opt6 00051）；V4-04 定向 50/50、V4-05 13/13、V4-06 18/18；五视口首屏均有库存明细行、切仓按钮矩形不变；WM0072 历史/跨版本来源返回、issues/旧直链/穿越 from 实测；catalog tsc 0、eslint 0/0、`git diff --check` 0。最终 BUILD **`Dwnb0Go61UvC1sHZx4Uev`**（3011，pid 35400，快照 `57f2c5b2…`，ownershipVerified=true，login 200）。
- 独审未通过/未完成：V4-07 v6 内容完成门禁与真实应用负向未完成；V4-08 无最终 15×20 性能矩阵；V4-04 隔离 DB 六态、V4-05 隔离缓存反例、V4-09 真实隔离库四态/最终回归未跑；200% 真实缩放 pending；历史来源返回/全入口技术内容等已由独立报告指出。用户现把范围收窄为 v5 前端展示与交互；上述项延期，**不是已修复或已通过**。
- 停止点：历史 **`UI_REVIEW_NEEDS_FIX`**；v6 现役停止点见上方。

## 商品库 UI 集中补修包 v3（历史，待独立复审）

状态：**`UI_IMPLEMENTED_AWAITING_INDEPENDENT_REVIEW`（2026-10-24）**。按 `.local/catalog/independent-ui-repair-v2-20261024/execution-repair-package-v3.md` 实施 V3-01～V3-08，并处理同目录 v2 独审（UI/产品/性能/代码/合同 + 用户补充）未通过项；**不是 UI PASS**，未 commit/push/merge/deploy，现役 126 样本与 BS 530 行未被写入。

- 合并矩阵：[repair-matrix.md](../../.local/catalog/ui-repair-v3-20261024/repair-matrix.md)；交付摘要：[delivery-summary.md](../../.local/catalog/ui-repair-v3-20261024/delivery-summary.md)；证据索引：[evidence-index.md](../../.local/catalog/ui-repair-v3-20261024/evidence-index.md)；截图说明：[screenshots-index.md](../../.local/catalog/ui-repair-v3-20261024/screenshots-index.md)。
- 范围：统一商品弹窗（历史内联、来源/证据子视图、旧 URL 307、from 回跳）、全流程文案与字段收敛（kg/体积/包装/635 短屏/启用态去 fixture/UUID）、切仓缓存复用与内容一致（切仓 0 请求 + 同 scope 后台校验）、草稿与待核请求主体隔离/只读核对/显式重试、返回链与集中问题入口（不可变事项如实说明、真实 0 项独立 fixture）、oracle/merge v5 内容门禁与 15×20 性能矩阵、V3-08 非基线候选失败根因与最终源码隔离重跑。继承 `U3_LOCAL_UX_PERF_PASS` / `LOCAL_PREVIEW_PASS` 原范围；不接真实来源、不改业务规则、不新增 migration/schema/审批状态。
- 执行方自验：浏览器主套件 **22/22（0 flaky）**；v3 UI 采集 **117/117（5 uncovered）**、70 张截图；oracle v5 校准 **26/26**、merge 自检 **20/20**、期望 crossChecked=true；性能矩阵见 `oracle/runs/`（阈值未下调，超阈桶原样交回）；全仓 tsc 5 条历史基线（商品库 0）、eslint 0/0、单测 513/514（唯一失败为既有 opt6 00051）、`git diff --check` 0。最终 BUILD **`8qFEEnYTJ60Jgk7E_ZiNZ`**（3011，pid 21036，快照 `603dc16e7257bb0a…`）。
- 待独立复审裁定/未覆盖：性能 13/15 桶达标；`warmPagination` p95 114.4ms、`warmListRefresh` p95 472.4ms（等待本次 RSC 刷新响应）超 100ms（真实值，未豁免；merge integrity 另含 unit-cost diag/scroll preSatisfied 工具待收敛项）；现役全 r1 → 历史版本切换 5 视口 uncovered；200% 真实缩放 pending；v5 真实应用负向未新增；隔离 fixture 最终行为矩阵结果见 `.local/.../fixture/`；scripts 准备链两处缺口如实未修。
- 停止点：**`UI_IMPLEMENTED_AWAITING_INDEPENDENT_REVIEW`**。等待用户转交独立审查；通过后再安排本包 Git 收尾，不开启下一开发包。

## 商品库 UI 集中补修包 v2（历史，独审 `UI_REVIEW_NEEDS_FIX`）

状态：**`UI_IMPLEMENTED_AWAITING_INDEPENDENT_REVIEW`（2026-10-23）**。按 `.local/catalog/independent-ui-review-20261023/execution-repair-package-v2.md` 实施 U1–U8，并处理同目录 `independent-review.md` 的 R1–R10；**不是 UI PASS**，未 commit/push/merge/deploy，现役 126 样本未被写入。

- 合并矩阵：[repair-matrix.md](../../.local/catalog/ui-repair-v2-20261023/repair-matrix.md)；U/R 逐项结果：[u1-u8-r1-r10-results.md](../../.local/catalog/ui-repair-v2-20261023/u1-u8-r1-r10-results.md)；证据索引：[evidence-index.md](../../.local/catalog/ui-repair-v2-20261023/evidence-index.md)；截图说明：[screenshots-index.md](../../.local/catalog/ui-repair-v2-20261023/screenshots-index.md)。
- 范围：详情固定外壳 + 三分区（商品资料/库存明细/变更记录）、概览按库存阶段与货值组织、技术证据退出日常详情（迁授权维护页）、包装/尺寸字段校准、列表去工程横幅、分页直选与位置保持、导航收口（数据维护进账户菜单）、启用态页面统一；R1–R10：门禁首屏期望分层、可达性/合并器完整性、受影响路径性能、编辑四态与离开保护、历史边界、错误分类、问题索引覆盖、上下文统一、旧 UI 退出、文档证据收敛。继承 `U3_LOCAL_UX_PERF_PASS` 与 `LOCAL_PREVIEW_PASS` 原范围；不接真实来源、不改业务规则、不新增 migration、不恢复封存模块。
- 执行方自验：UI 采集 **76/76**、oracle v4 校准 **27/27**、真实负向 **16/16**、浏览器主套件 **22/22（0 flaky）**、隔离 fixture R4 16/16×2 / R6 13/13+14/14 / R7 7/7+5/5+2/2 / R9 8/8+2/2、`tsc` 全仓 5 条历史基线（商品库 0）、`eslint` 0/0、单测 457/458（唯一失败为既有 `opt6-production-apply` 00051 换行豁免）、`git diff --check` exit 0。最终 BUILD **`7Qzv7GAew213N3WufdT_z`**（3011，pid 72784，源码快照 `3a1d5395…` 与 promote 一致）。
- 待独立复审裁定/未覆盖：① `detailWarehouseSwitchRealClick` 四轮 p95 **113.0–159.8ms** 均超 100ms 暖口径（合并门禁 `allRequired=false` 原样交回，未豁免）；跨文档桶 3 轮各 1–2 例 90s 未就绪（独立直链探针 20/20 正常，未剔除）；② 维护页“非基线新品候选审计读取失败”待确认项（根因未定位，错误文案已明确分类）；③ new-item 3/4、source-identity 4/5 未在最终 BUILD 复跑（与②同源，另 1 条包外既有失效）；④ R7 “无事项”未覆盖（未伪造）；⑤ 200% 缩放为模拟、像素级视觉基线未建立。
- 停止点：**`UI_IMPLEMENTED_AWAITING_INDEPENDENT_REVIEW`**。等待用户转交独立审查；通过后再安排本包 Git 收尾，不开启下一开发包。

## 商品库 UI 整体改造（历史包，已被 v2 补修覆盖）

状态：上一包 `UI_IMPLEMENTED_AWAITING_INDEPENDENT_REVIEW`（2026-10-23，F01–F17），独立复审结论 **`UI_REVIEW_NEEDS_FIX`**（[independent-review.md](../../.local/catalog/independent-ui-review-20261023/independent-review.md)）；其 R1–R10 已在本包处理。上一轮 BUILD `GaK8dG26vW574fhA5gEBy`（pid 23136）已被本包预览更新替换。历史证据原样保留：[delivery-summary.md](../../.local/catalog/ui-overhaul-20261023/delivery-summary.md)、[f01-f17-results.md](../../.local/catalog/ui-overhaul-20261023/f01-f17-results.md)、[evidence-index.md](../../.local/catalog/ui-overhaul-20261023/evidence-index.md)。

## 商品库 UI 整体改造（历史记录，F01–F17 原登记）

状态：**`UI_IMPLEMENTED_AWAITING_INDEPENDENT_REVIEW`（2026-10-23）**。按 `.local/catalog/independent-ui-plan-20261023/execution-package.md` 实施 F01–F17；**不是 UI PASS**，未 commit/push/merge/deploy，现役 126 样本未被写入。

- 交付摘要：[delivery-summary.md](../../.local/catalog/ui-overhaul-20261023/delivery-summary.md)；F01–F17 逐项：[f01-f17-results.md](../../.local/catalog/ui-overhaul-20261023/f01-f17-results.md)；证据索引：[evidence-index.md](../../.local/catalog/ui-overhaul-20261023/evidence-index.md)；截图说明：[screenshots-index.md](../../.local/catalog/ui-overhaul-20261023/screenshots-index.md)；视觉转述：[visual-review.md](../../.local/catalog/ui-overhaul-20261023/visual-review.md)；影响矩阵：[impact-matrix.md](../../.local/catalog/ui-overhaul-20261023/impact-matrix.md)。
- 范围：详情可达性（固定 header + 唯一滚动体）、列表/详情信息层级与响应式、问题触发式只读索引、上下文保持（切仓/历史/来源）、错误恢复、审计只读化、编辑与历史一致性、账户说明、金额显示规范、有限清理。继承 `U3_LOCAL_UX_PERF_PASS` 与 `LOCAL_PREVIEW_PASS` 原范围；不接真实来源、不改业务规则、不新增 migration。
- 执行方自验：UI 采集 **87/87**、oracle v3 校准 **22/22**、真实负向 **15/15**、浏览器回归 **18/18**（0 flaky）、`tsc` 全仓 5 条历史基线（商品库 0）、`eslint` exit 0、单测 **445/446**（唯一失败为既有 `opt6-production-apply` 00051 换行豁免）、`git diff --check` exit 0。预览经 staging build → 校验 → promote → start，最终 BUILD **`GaK8dG26vW574fhA5gEBy`**（pid 23136，归属已校验）。
- 待独立复审裁定：① 性能 9 桶中 7 桶达标，`listFirstWarm` p95 **504.6ms**、`detailModalReopenWarm` p95 **289.5ms** 超 100ms 暖口径（阈值未下调，合并门禁 exit 2 原样保留）；② 隔离 fixture 写入验收（F13 四态 / F07 启用模块两入口 / F06 故障注入）未执行；③ Demo 浏览器冒烟未跑；④ 历史版本逐版本视觉未截图；⑤ `warehouseSwitchInModal` 单样本 1033ms 长尾保留。
- 停止点：**`UI_IMPLEMENTED_AWAITING_INDEPENDENT_REVIEW`**。等待用户转交独立审查；通过后再安排本包 Git 收尾，不开启下一开发包。

## 商品库 Demo 界面复用与访问性能（历史 PASS，U3）

状态：**`U3_LOCAL_UX_PERF_PASS`（独立复审通过 2026-10-23；文档登记与分批提交完成）**。独立报告 [independent-review.md](../../.local/catalog/independent-ux-perf-u3-final-20261023/independent-review.md)；摘要 [progress9-delivery-summary.md](../../.local/catalog/ux-perf-u3-20261022/progress9-delivery-summary.md)；证据 [evidence-index.md](../../.local/catalog/ux-perf-u3-20261022/evidence-index.md)；执行自验 `runs/progress9-verify-20261023-final/selfverify-steps.json`（8/8 exit 0）。3011 BUILD **`Jq2Y6jz_l7sFTKfSUPYkF`** @ `run-20261021T100700Z-b3c4d5e6`（pid 42900，未重启）。通过范围仅限本地样表商品库交互、缓存恢复、性能测量与验收门禁；**不代表**新 UI 完成、真实来源接入、生产发布或全 ICEOS 验收，**`LOCAL_PREVIEW_PASS`** 原范围不变。已关闭：R1 冷启动门禁以 `listSample/detailSample.contentReadyMs` 重算（摘要须等于取整规则，缺失/NaN/Infinity/矛盾即拒绝；合并负向 51/51 + 独立 26 项边界）+ 新验证器复算 `runs/progress8-final5` 原始证据 → `allRequired=true`（原始暖/冷/fixture SHA 未改写，旧验证器单独留存）；R2 runner 校验 `completed=126`/`completed↔itemCount`/`readOnlyEvidence.transactionReadOnly==='on'`（真实 spawn 11/11 + 独立 6 项边界）；R3 全仓 tsc 总诊断 **21→5**、当前商品库 **16→0**，历史 BEST 5 条按范围保留（不声称全仓 tsc 通过）。继承 126×252 / 0 差异（`progress5-20261022-180727`，未重跑）；暖 15×20 / 冷 3 轮沿用 progress8-final5 原始结果只复算不重采样。progress8 的 `allRequired=true` 在其原门禁下保留为历史；progress7 的 `allRequired=true` 为旧计时口径，**不能**作为通过依据。**无**执行方自注册 PASS，本状态依据独立报告登记。

范围：旧经营模块完整源码外置 `D:/try one/ICEOS-legacy-archive/20261022/`（仓库 `archive/legacy-business-20261022/` 仅 `manifest.json`/`EXTERNAL-POINTER.json`/白名单/处置表/`RESTORE.md`/skills 版本清单）；现役仅商品库/新品/来源核实/管理审计；导航与测试对齐白名单；旧 URL/API 封存或重定向；共享 UI `src/ui/ice-v4`；继承 **`LOCAL_PREVIEW_PASS`** 与预览 run `run-20261021T100700Z-b3c4d5e6`。**下一会话**：新版 UI 打磨与新品/来源核实问题触发式入口，本轮不扩开发。

## 本地真实商品预览包（历史 PASS）

状态：**`LOCAL_PREVIEW_PASS`** — 独立验收完成（2026-10-21）。最终报告：[independent-local-preview-final-20261021T084549Z](../../.local/catalog/independent-local-preview-final-20261021T084549Z/independent-review.md)。交付索引：[local-preview-delivery-index.md](../catalog/local-preview-delivery-index.md)；Git 清单：[local-preview-git-manifest.md](../catalog/local-preview-git-manifest.md)。

范围：126 主资料、BS 530（430/100）、六仓、进货价货值；本地样表预览与启停/测试证据；继承 P0/N1A/N1C 与 R3–R5 已关闭项。**预览 run** `run-20261021T075139Z-821214d2`（历史；R2 自验后已受控停止）。本轮 UI 包现役 run 见交付索引 **`run-20261021T100700Z-b3c4d5e6` @ 3011**。LOCAL_PREVIEW 包不重跑 prepare；不 merge/deploy/清场。

## N1C — 本地隔离独立通过与文档登记（历史）

状态：**N1C_LOCAL_PASS**，仅本地隔离范围。验收依据[N1C独立总报告](../../.local/catalog/independent-new-item-review-20261021T015312Z-e38782af/independent-review.md)；原[执行交付](../../.local/catalog/new-item-delivery-20261020T142050Z-85800652/delivery-index.md)保持当时待审记录，不能回写成独立结论。[文档收尾证据](../../.local/catalog/docs-closeout-20261021T020835Z-869e3fc6/delivery-index.md)已登记。

## P0-03 — 独立总验收通过及文档收尾（历史已完成）

状态：**P0_03_PASS**。[独立总验收报告](../../.local/p0-03/reviews/evidence/independent-final-acceptance-20261020-49c832b7/independent-review.md)已通过，文档收尾完成。本期范围仅为产品主库整理、商品身份标准、本批样表对应与人工决定保存、输出一致及历史可追溯；不表示全部资料核实或后续正式关系、真实接入与库存使用已经完成。

- [本轮任务包](./p0-03/2026-10-20-final-acceptance.md)、[明确决定JSON](../p0-03/final-decisions-20261020.json)、[总验收报告](../p0-03/verification-report-p0-03-final-acceptance-20261020.md)；规则正文仍为[商品身份标准](../product-identity-standard-v1.md)。
- [唯一最终输出](../../.local/p0-03/run-20261020-final-acceptance/evidence/final-2026-10-20T03-41-45-834059Z-cd7d4d19/delivery-final-v2/)，含coverage/。delivery-final首版、delivery-reproduced、开发/负向及门禁smoke均仅作证据。
- 使用最新独立通过的JST545交付，指定bundle与有效CSV哈希已核对；继承有效CSV及全部历史，不回退桌面CSV、不隐式合并、不全库重匹配替换决定。

已完成：菲越三条WM0012确认升级普通版、版本待决解除而原目标保持；WM0006/WM0008本批ignore、目标空、原候选保留；WM0130原857确认主库121；菲越两WM0073原220/321由defer转confirm主库67、旧暂缓留历史。六项规格已关闭：两忽略、其余四款按主库C列；不换算g/ml，WM0062 JST789 reject仍在。WM0081原62与brush原107各自可见、待确认，并登记后续正式系统也应保留两份及状态。

结果：126份主资料（125非空唯一货号＋1缺码），1417来源，548选择＝BS430＋JST118；覆盖114/2/4/6、120份有选择。774待核对＋1候选、3拒绝、3忽略、88规则外。新增选择3、既有版本再确认3、本批忽略2；原545目标/JST引用、原22条完整记录、原11JST、WM0007ignore、BS70/72未建档、WM0072锚点66及现价5.18/5.68/两版历史保持。

执行自验本轮重跑：136回归（原121不改＋15）、完整P0-03门禁、全量投影与216字段差异重构、21新业务负向/原12在新结果/原16在历史基线、旧审计28/32与新44、10图片、2审计CLI、6本地浏览器、147产物字节一致再生、lint/build、保护/链接/口径/diff均通过。实际argv、退出码、初检失败、完整日志及既有警告见总报告，不能写成另一个会话的独立重跑。

独立总验收重跑136回归、全量1417/126/原545/22/3160行CSV、21＋12＋16组业务负向、新44和历史28/32组审计负向、10图片、6本地文件浏览器、147份字节一致再生、2审计CLI及范围/链接/diff均通过，另有19项冻结基线探针和原Excel/覆盖/汇总核算。完整P0-03门禁、lint、build仅核查执行日志，未独立重跑。本次仅更新获准的五份文档，做链接、一致性及diff检查，未重跑功能测试。

保留延期：两刷子及未确认BS记录/唯一WM0081 JST候选、新品缺码、工厂/其他缺失、图片内容未核验、一般未核对775及未涉及拒绝/规则外/纠错。本轮菲越版本待决和六项规格说明已关闭，不能继续显示为需重复选择。BS70/72未建档不表示库存0，不要求所有商品同时有两个系统记录。

历史：[JST本批独立通过](../p0-03/verification-report-p0-03-jst-confirmations-20261020.md)及[独立报告](../../.local/p0-03/reviews/evidence/independent-jst-confirmations-20261020-dce89074/independent-review.md)、[审计补修独立通过](../p0-03/verification-report-p0-03-coverage-audit-repair-20261020.md)、[四项确认独立通过](../p0-03/verification-report-p0-03-confirmations-20261019.md)、[主库整理独立通过](../p0-03/verification-report-p0-03-curation-20261019.md)保留原样，含CHANGES_REQUIRED及补修过程。审查前状态P0_03_IMPLEMENTED_AWAITING_REVIEW保留为历史；当前PASS依据本次独立总验收，不由过去分批通过推定。

业务方向/未核实接入条件见[当前状态](../current-state.md)；正式保存关系、自动复用、数量归集、库存同步及估值仍未实现、不在本期。上述延期不阻塞本期有限范围PASS。保留全部原始Excel/CSV、旧证据、HOLD和其他未提交修改；neat-freak仅本次五份文档对齐，不清场、不写记忆。不入正式库、不访问真实账号、不发布/同步库存、不提交/推送/合并/部署或推进下一阶段。停止于P0_03_PASS（文档收尾完成），下一阶段等待另行授权。

---

## P0-02 — PASS（保留）

状态：**`P0_02_PASS`**

- 正式 PASS 报告：[../p0-02/verification-report-p0-02-pass-20261015.md](../p0-02/verification-report-p0-02-pass-20261015.md)
- Canonical Run：`run-20261014-r2`

---

## P0-02 — 历史任务包（归档含义）

- d082728 返工：[p0-02/2026-10-15-delivery-rework-d082728.md](./p0-02/2026-10-15-delivery-rework-d082728.md)（当时 **IMPLEMENTED_AWAITING_REVIEW**）
- 返工验证报告：[../p0-02/verification-report-r2-20261015-d082728-rework.md](../p0-02/verification-report-r2-20261015-d082728-rework.md)

---

## P0-01 — 独立审查通过（保留）

**P0_01_PASS** — 证据 `.local/p0-01/run-20261013-r1/reviews/independent-r5-closeout-20261014-01/`
