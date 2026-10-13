# DIS 项目文档树

本文档是 DIS 项目资料的统一入口。规则描述“必须遵守什么”，docs 描述“项目是什么、现在怎样、准备怎么做”。

## ICE v4 方案验证入口

最新交互反馈与验证：[2026-10-13 同步/权限、首页库存、市场物流改进](reports/2026-10-13-ice-v4-feedback.md)。Demo现为八个入口，首版六视图记录仅作历史。

当前任务以 [current-state.md](current-state.md) 与 [current-task.md](tasks/current-task.md) 为准。下面的新文档描述设计与隔离Demo，不代表生产已改造：

- [现状分析](current-analysis.md)：代码事实、Supabase依赖、库存口径、复用与风险。
- [产品方案 v4](product-plan-v4.md)：六视图、商品身份、权限与业务边界。
- [目标架构 v2](architecture-v2.md)：模块归属、隔离层、未来平台迁移与回退门。
- [数据库设计 v2](database-design-v2.md)：增量目标模型、约束、版本、RLS/金额保护；无Migration执行。
- [数据流 v2](data-flow-v2.md)：四源权威、正逆时间序列、去重/缺口/失败规则。
- [架构决策](adr/ADR-ICE-001-identity-snapshot-boundary.md)；[本次验收与Demo访问](reports/2026-10-13-ice-v4-validation.md)。

下列旧文档保留现役历史背景，已知过时项以现状分析和真实代码为准，不能据旧说明恢复“入仓加库存”行为。

## 文档关系图

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

## 阅读路径

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

## 按问题查找

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

## 按任务组合阅读

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
| 项目目标与业务边界 | `project-overview.md` | 只引用，不重复完整描述 |
| 当前状态与技术债务 | `current-state.md` | 其他文档不维护当前进度 |
| 架构与模块职责 | `architecture.md` | Rules 只保留必须遵守的约束 |
| 数据库设计 | `database-design.md` + Migration | 页面和计划只描述使用方式 |
| 页面需求 | `page-specification.md` | 实施计划引用其验收目标 |
| 历史详细实施规格 | `implementation-plan.md` | 不作为每次会话默认执行清单 |
| AI 单次执行范围 | `tasks/current-task.md` | 每次只维护一个 ACTIVE Task Packet |
| 系统优化审计基线与阶段顺序 | `tasks/system-optimization-roadmap-2026-07-17.md` | `current-task.md` 只引用当前优化子任务 |
| 模块任务顺序 | `tasks/phase-*.md` | 只维护模块内任务依赖和状态 |
| 长期 Phase 范围 | `mvp-roadmap.md` | 实施计划不重定义长期范围 |
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
