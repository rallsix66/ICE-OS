# 旧 DIS 方案与交付历史

归档日期：2026-10-13。用户已确认清理范围；旧文档保留用于解释既有代码、审计、兼容与验收，不作为后续实施清单，也不代表当前生产状态。

当前入口：[项目状态](../../current-state.md)、[当前任务](../../tasks/current-task.md)、[产品方案](../../product-plan-v4.md)、[架构 v3](../../architecture-v3.md)、[历史模型](../../history-data-model-v1.md)。

## 完整过程记录

- [清理前完整状态记录](current-state-through-2026-10-13.md)：原 `docs/current-state.md`，包含旧系统与 ICE Demo/架构交付历史。
- [清理前完整任务记录](task-packets-through-2026-10-13.md)：原 `docs/tasks/current-task.md`，包含历史任务边界和验收记录。
- [2026-07-13 项目代码总结](DIS-项目代码总结.md)：原仓库根文件；是当时的代码审查快照，不覆盖最新实现盘点。

## 旧设计方案

以下 6 份来自原 `docs/design/dis-plans/`，保留原有设计与修订内容，只增加归档标记并修复文档链接。

- [实施总顺序](plans/DIS-实施总顺序方案.md)
- [首页排版](plans/DIS-首页排版-实施方案.md)
- [全球库存作战室](plans/DIS-全球库存作战室-实施方案.md)
- [喜运达物流轨迹接入](plans/DIS-喜运达物流轨迹API接入-方案.md)
- [预测式补货引擎](plans/DIS-预测式补货引擎-实施方案.md)
- [库存 UI 升级](plans/inventory-ui-upgrade-plan.md)

原文中的角色分工、Supabase 目标、待办、授权和生产状态均属于当时记录；代码片段和仓库内路径按当时语境阅读，不能据此执行历史迁移或真实环境写入。

## 未移动的证据

- [报告与证据目录](../../reports/)：原位置保留，部分 SQL packet 仍被测试直接读取。
- [既有任务归档](../../tasks/archive/)：原位置保留。
- [52 个历史迁移所在目录](../../../supabase/migrations/)：原位置保留，未修改 SQL。
- [旧系统优化路线图](../../tasks/system-optimization-roadmap-2026-07-17.md)：仅供旧实现与未决风险追溯。

## 本次清理边界

删除对象仅为 5 个未引用默认 SVG、1 个 TypeScript 增量缓存和 33 个 Python 编译缓存；旧文档没有被丢弃。受 Git 跟踪的删除项可从清理前提交恢复，生成缓存可由相应构建/测试重新生成。

业务代码、当前 Demo、测试及 SQL/evidence、环境配置、依赖、`.next` 和两个读取受限的 `.pytest_cache` 均不在删除范围。没有提交、推送或部署。
