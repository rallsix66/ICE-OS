# ICEOS 项目文档入口

本文档是 ICEOS（原 DIS）项目资料的统一入口。先从当前状态和目标方案进入；旧系统资料用于维护与追溯，不覆盖新方案或当前授权。

- [飞书商品资料真实持续更新 v1](tasks/feishu-product-source-real-v1.md)：真实读取、字段范围、采用/待核对结果、
  定时读取入口与验证证据；日常入口为「数据同步」页的「飞书商品资料」区块，来源待核对事项已接入商品库「待处理」
- [飞书商品资料人工核对与持续采用流程 v1](tasks/feishu-product-source-review-flow-20261110.md)：跨批待办去重、字段级
  暂不处理、同号多行人工选择、缺货号待确认与测试码纠正、LS101501 重量口径；含 2026-11-10 三项补修（同号脚本代选
  撤销、WM0131 名称空格关系提示、重量按来源列解释），本机交付完成；**补修轮独立差异复核 PASS、阻断 0**（上轮独立差异复核亦 PASS）。
- [飞书字段报错定位 + 物流关联实际影响](tasks/real-usage-round3-20261112.md)：
  `LS101295` 的飞书 `E3` 显示值与系统读取值都是 `#REF!`（公式指向不存在的「供应商信息」表，文档只有 Sheet1），
  原表同样报错；待处理把 93 条「生产工厂」公式错误合并成一条（可展开货号/品名/单元格/错误原文、可打开原表，
  检查更新→确认更新后修好一行 93→92、其余保留）；物流选择沿用规则前写清当前 N 条/T 票与以后新到都会匹配，
  保存回执分别写本条关联与货值结果、规则是否保存、本次按规则另关联 N 条（DB 回执），清除固定写
  「已清除本条明细的商品关联」。现役只读 11/11、克隆库写入 16/16；独立差异复核 PASS、阻断 0。
- [五页第二遍按实际用法补齐（待处理统一 / 库存候选 / 物流旧票依据 / 更新回执）](tasks/pages-real-usage-round2-20261113.md)：
  总览/商品库徽标/弹窗/完整待处理页统一同一份 5 项（刷子历史只在商品详情、旧索引改为同一套可操作卡片、
  同号回执写明所选资料、最后一项后成功提示与「待处理已清空」同时可见）；商品库存 SKU `6974674957332`
  两款候选与已登记单位「个」、保存后其他仓继续；物流总览未计入入口首开展开、四色号引用旧单人工确认记录、
  保存后按实际结果写已计入货值/仍缺进货价/数量待核；商品更新部分完成回执补「已确认的变更已写入，待核对字段保留原值」。
  现役只读 38/38、克隆库写入 23/23；独立差异复核 PASS、阻断 0。
- [五页按实际用法改造 + 共用弹窗滚动锁](tasks/pages-real-usage-20261112.md)：
  经营总览去掉右上角待处理与估值说明折叠块、首页唯一「需要处理」用具体动作按钮、缺价就地列出哪几款；
  商品库待处理弹窗当场在「两份真实资料」里选一份并确认、WM0131 直接补号、刷子历史回商品详情；
  商品库存待绑定按来源 SKU 分组并在弹窗内选商品/确认仓/保存（切换首行 1246→552ms）；
  物流在途页签/市场就地展开/未计入可点开/未关联现场关联与建议；数据同步四卡移除待处理；
  共用弹窗滚动锁（真实滚动条下不横移、恢复滚动位置）。现役只读 70/70、克隆库写入 29/29，独立差异复核 PASS、阻断 0。
- [五页「待处理」弹窗统一 + 数据同步四卡各自待处理 + 物流/回执收口](tasks/pending-entries-unified-20261111.md)：
  共用「待处理」按钮点击打开整页居中弹窗（总览 5 类、商品库 7 条、商品库存 141 条、物流复核弹窗）；
  数据同步四卡各自「待处理」（海外 141 / 国内真实状态 / 物流 2 / 商品资料 7 + 本批预览）；
  物流保存决定后同一弹窗当场恢复；商品回执只保留一套数据库数字；现役只读 31/31、克隆库 17/17，独立差异复核 PASS、阻断 0。
- [商品库更新回执 + 物流待复核 + 四卡统一](tasks/catalog-sync-receipt-logistics-20261111.md)：按数据库实际回执显示写入/无变化/待核对/失败，
  物流待复核改为整页遮罩+视口居中弹窗并从两处入口打开，四卡按钮顺序/主次/几何统一；现役只读 35/35、克隆库 13/13，**独立差异复核 PASS、阻断 0**。
- [数据同步页精简 + 飞书商品货号更新闭环](tasks/catalog-sync-update-20261110.md)：四卡 2×2 首页、商品库更新三页签弹窗（本次更新/待人工确认/采用记录）、
  WM0131 从最新待应用快照直接显示并确认采用；执行方 3011 页面 28/28、克隆库 12/12 + RPC 13/13，**独立差异复核 PASS、阻断 0**。
- [待处理页原因/差异/入口精简](tasks/catalog-pending-simplify-20261110.md)：每条直接显示具体原因、逐行差异与
  具体动作按钮，来源详情按需展开，按钮定位到对应事项；执行方定向验证 + **独立差异复核 PASS、阻断 0**。

## ICE v4 当前设计入口

2026-10-13 新方向：[独立PostgreSQL架构 v3](architecture-v3.md) + [历史数据模型](history-data-model-v1.md) + [ADR-ICE-002](adr/ADR-ICE-002-independent-postgres-history.md)。已确认脱离Supabase、预留历史分析基础，暂不开发复杂分析页；运行代码仍为旧平台，迁移未执行。

最新交互反馈与验证：[2026-10-13 同步/权限、首页库存、市场物流改进](reports/2026-10-13-ice-v4-feedback.md)。Demo现为八个入口，首版六视图记录仅作历史。

当前任务以 [current-state.md](current-state.md) 与 [current-task.md](tasks/current-task.md) 为准。下面的新文档描述设计与隔离Demo，不代表生产已改造：

- [现状分析](current-analysis.md)：代码事实、Supabase依赖、库存口径、复用与风险。
- [产品方案（v4 基础，吸收 V5）](product-plan-v4.md)：三种经营视角、现有八入口职责、不含运费估值、历史与后续分析边界。
- [目标架构 v3](architecture-v3.md)：自主数据库/认证、服务边界、迁移与恢复；[v2](architecture-v2.md) 保留首版背景。
- [历史数据模型](history-data-model-v1.md)：原始快照、业务/维度修订、日统计、晚到补数、权限与可追溯查询。
- [数据库设计 v2](database-design-v2.md)：增量目标模型、约束、版本、RLS/金额保护；无Migration执行。
- [数据流 v2](data-flow-v2.md)：四源权威、正逆时间序列、去重/缺口/失败规则。
- [架构决策](adr/ADR-ICE-001-identity-snapshot-boundary.md)；[本次验收与Demo访问](reports/2026-10-13-ice-v4-validation.md)。
- [旧 DIS 方案与交付历史](archive/dis/README.md)：根目录旧代码总结、6 份旧方案及清理前完整状态/任务记录。删除的仅是已确认无引用素材和可再生缓存，验收报告/SQL 仍在原位。

下列旧文档保留现役历史背景，已知过时项以现状分析和真实代码为准，不能据旧说明恢复“入仓加库存”行为。

## 旧系统参考文档关系

```text
project-overview.md
  ├── architecture.md ── database-design.md ── deployment.md
  ├── page-specification.md ── implementation-plan.md
  ├── mvp-roadmap.md
  └── tasks/ ── current-task.md ── system-optimization-roadmap-2026-07-17.md

current-state.md
  ├── 记录上述文档对应内容的当前真实状态
  └── 指向当前 Task Packet 及所需规格、架构和数据库资料
```

`current-state.md` 是动态入口，其他文档分别维护稳定事实。任何 Task 都应从当前状态进入，再按影响范围读取相邻文档。

## 旧系统参考阅读路径

```text
docs/README.md
├── project-overview.md       项目目标、用户、业务范围与核心流程
├── current-state.md          当前 Phase、Task、真实实现、限制与技术债务
├── architecture.md           当前真实架构、模块职责与数据访问链路
├── database-design.md        数据模型、关系、RLS 与 Migration
├── page-specification.md     各页面字段、操作、状态与权限
├── implementation-plan.md    Phase 0–1 历史详细规格与验收参考
├── mvp-roadmap.md            Phase 0–5 长期路线与依赖
├── tasks/                     AI 单次会话任务包、模块任务顺序与停止条件
│   └── system-optimization-roadmap-2026-07-17.md  当前工程治理与优化顺序
├── reports/                   阶段执行报告、维护 SQL 与可复核 evidence
│   ├── 2026-07-18-opt4-production-verification.md  当前 OPT-4 Production 主报告
│   ├── sql/                   非 Migration 的审计/维护/回滚脚本
│   └── evidence/              逐行 postcheck 与摘要证据
└── deployment.md             环境、发布、Migration 与回滚流程
```

## 旧系统追溯索引（不是新方案实施入口）

| 想了解的问题 | 阅读文件 |
|---|---|
| DIS 是什么、解决什么问题 | `project-overview.md` |
| 现在开发到哪里、下一步做什么 | `current-state.md` |
| Claude 当前这一次只做什么 | `tasks/current-task.md` |
| 某个模块拆成哪些小任务 | `tasks/phase-*.md` |
| 代码应该放哪里、模块如何协作 | `architecture.md` |
| 表结构、关系、RLS 如何设计 | `database-design.md` |
| 某个页面应该显示和操作什么 | `page-specification.md` |
| 当前 Task 如何实施和验收 | `tasks/current-task.md`；必要时按引用读取详细规格 |
| 当前系统优化按什么顺序实施 | `tasks/system-optimization-roadmap-2026-07-17.md` |
| OPT-4 已完成的远端执行、Migration history 与终审证据 | [Production 主报告](reports/2026-07-18-opt4-production-verification.md) → [Production postcheck evidence](reports/evidence/2026-07-20-opt4-production-history-postcheck.md) |
| OPT-5 当前权限审计、实施边界与停止门 | [当前任务包](tasks/current-task.md) → [系统优化路线图](tasks/system-optimization-roadmap-2026-07-17.md) |
| OPT-5 实际权限基线、00049 与验证证据 | [OPT-5 主报告](reports/2026-07-20-opt5-database-least-privilege.md) → [Staging postcheck](reports/evidence/2026-07-20-opt5-staging-postcheck.md) → [Production postcheck](reports/evidence/2026-07-20-opt5-production-postcheck.md) |
| OPT-6 Batch 1 lint、RLS init-plan、Turbopack 与远端 00050 证据 | [Batch 1 报告](reports/2026-07-20-opt6-quality-governance-batch-1.md) → [Staging/Production remote postcheck](reports/evidence/2026-07-20-opt6-00050-remote-postcheck.md) |
| OPT-6 Batch 2 policy-overlap inventory, 00051 review PASS, Staging/Production apply evidence (FINAL PASS) | [Batch 2 report](reports/2026-07-21-opt6-quality-governance-batch-2.md) → [Staging evidence](reports/evidence/2026-07-21-opt6-00051-staging-preflight.md) → [Production preflight](reports/evidence/2026-07-21-opt6-00051-production-preflight.md) → [Production apply evidence](reports/evidence/2026-07-22-opt6-00051-production-apply.md) → [preflight SQL](reports/sql/2026-07-21-opt6-00051-production-preflight.sql) → [apply SQL](reports/sql/2026-07-21-opt6-00051-production-apply.sql) → [preflight contract](../src/features/database/opt6-production-preflight.test.ts) → [apply contract](../src/features/database/opt6-production-apply.test.ts) → [inventory evidence](reports/evidence/2026-07-21-opt6-batch2-policy-inventory.md) |
| OPT-6 Batch 3 00052 product-policy overlap (Staging SELECT-only FINAL PASS; Production SELECT-only preflight FINAL PASS; Production 00052 apply/postcheck executed; evidence review pending; Batch 4 prohibited) | [Batch 3 report](reports/2026-07-22-opt6-quality-governance-batch-3.md) -> [Staging report](reports/2026-07-27-opt6-00052-staging-preflight.md) -> [Staging evidence](reports/evidence/2026-07-27-opt6-00052-staging-preflight.md) -> [Production preflight report](reports/2026-07-28-opt6-00052-production-preflight.md) -> [Production preflight evidence](reports/evidence/2026-07-28-opt6-00052-production-preflight.md) -> [Production preflight SQL](reports/sql/2026-07-28-opt6-00052-production-preflight.sql) -> [Production static contract](../src/features/database/opt6-00052-production-preflight.test.ts) -> [Production PostgreSQL contract](../src/features/database/opt6-00052-production-preflight.postgres.test.ts) -> [Production apply report](reports/2026-07-28-opt6-00052-production-apply.md) -> [Production apply evidence](reports/evidence/2026-07-28-opt6-00052-production-apply.md) -> [Production apply SQL](reports/sql/2026-07-28-opt6-00052-production-apply.sql) -> [Production apply contract](../src/features/database/opt6-00052-production-apply.test.ts) -> [Production apply PostgreSQL contract](../src/features/database/opt6-00052-production-apply.postgres.test.ts) |
| 后续 Phase 如何安排 | `mvp-roadmap.md` |
| 如何部署、迁移和回滚 | `deployment.md` |

## 旧系统维护的组合阅读

| 任务类型 | 必须组合阅读 |
|---|---|
| 普通页面开发 | `current-state.md` → `tasks/current-task.md` → `page-specification.md` |
| 新增或修改业务模块 | 上述文件 + `architecture.md`；相关 rules 由 Claude Code 按路径加载 |
| 数据库、Migration、RLS | `current-state.md` → `database-design.md` → `architecture.md` → `deployment.md` |
| 权限与认证 | `current-state.md` → `architecture.md` → `database-design.md` |
| 修改 Phase 或范围 | `current-state.md` → `mvp-roadmap.md` → `implementation-plan.md` |
| 发布与回滚 | `current-state.md` → `deployment.md` → `database-design.md`（如涉及 Migration） |

## 单一事实来源

| 信息 | 主要维护文件 | 其他文档如何引用 |
|---|---|---|
| 当前产品目标与业务边界 | `product-plan-v4.md` | 已选择性吸收 V5；`project-overview.md` 仅作旧系统参考 |
| 当前状态与技术债务 | `current-state.md` | 其他文档不维护当前进度 |
| 目标架构与模块职责 | `architecture-v3.md` | `architecture.md` 说明旧实现与目标入口；Rules 只放边界 |
| 目标数据模型 | `database-design-v2.md` + `history-data-model-v1.md` | 已存在结构以实际 Migration/代码为准，设计不是已建表 |
| ICE 页面需求 | `product-plan-v4.md` | `page-specification.md` 仅作旧系统页面参考 |
| 历史详细实施规格 | `implementation-plan.md` | 不作为每次会话默认执行清单 |
| AI 单次执行范围 | `tasks/current-task.md` | 每次只维护一个 ACTIVE Task Packet |
| 系统优化审计基线与阶段顺序 | `tasks/system-optimization-roadmap-2026-07-17.md` | `current-task.md` 只引用当前优化子任务 |
| 模块任务顺序 | `tasks/phase-*.md` | 只维护模块内任务依赖和状态 |
| 当前范围与后续方向 | `product-plan-v4.md` + `architecture-v3.md` | `mvp-roadmap.md` 只作旧 Phase 历史参考 |
| 发布流程 | `deployment.md` | 其他文档只引用 |

## 维护规则

- `current-state.md`：每个 Task 完成后更新
- `architecture.md`：模块边界或数据访问方式变化时更新
- `database-design.md`：新增 Migration 或 RLS 变化时更新
- `page-specification.md`：页面需求确认变化时更新
- `implementation-plan.md`：历史详细规格确需修订时更新，不维护实时任务状态
- `tasks/current-task.md`：独立验收通过后切换下一 Task Packet
- `tasks/system-optimization-roadmap-2026-07-17.md`：事实基线、优先级或安全边界变化时更新
- `reports/`：每个远端阶段记录实际环境、范围、脚本、验证、PR/CI/部署、停止门和残余风险；新增 SQL/evidence 必须由主报告或本索引可达
- `tasks/phase-*.md`：模块任务状态或顺序变化时更新
- `mvp-roadmap.md`：Phase 范围或优先级变化时更新
- `deployment.md`：环境和发布流程变化时更新
