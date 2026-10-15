# DIS 任务执行体系

本目录用于把项目拆成适合 AI 单次会话执行的小任务，避免一次处理整个模块造成上下文过载、范围漂移和遗漏。

## 文档层级

```text
mvp-roadmap.md          长期 Phase 与依赖
tasks/phase-*.md        每个业务模块的任务顺序
tasks/current-task.md   当前唯一允许执行的 Task Packet
tasks/p0-02/2026-10-15-delivery-rework.md  P0-02 审查返工正式包（现役）
tasks/system-optimization-roadmap-2026-07-17.md  当前工程治理路线与安全边界
current-state.md        当前真实状态与当前 Task ID
```

`implementation-plan.md` 保留为历史详细规格参考，不再作为 Claude 每次会话的默认完整执行清单。

## 单次会话规则

Claude 每次会话只执行 `current-task.md` 中的一个 Task Packet。

必须遵守：

1. 开始前读取 `docs/current-state.md` 与 `docs/tasks/current-task.md`。
2. 只读取当前 Task Packet 指向的代码、规则和文档。
3. 不顺带实施相邻任务、后续页面或无关技术债务。
4. 遇到阻塞时记录阻塞原因，不擅自扩大范围。
5. 完成后执行 Task Packet 指定的验证。
6. 更新 `current-state.md`，然后停止等待独立验收。
7. 独立验收通过后，才切换到下一个 Task Packet。

## Task Packet 标准

每个任务包必须包含：

- **目标**：本次会话唯一要实现的结果
- **依赖**：开始前必须成立的条件
- **范围**：允许修改的功能和主要文件
- **非目标**：明确禁止顺带完成的内容
- **验收标准**：能够客观确认完成的条件
- **验证命令**：至少包括相关检查，必要时运行 lint/build
- **停止条件**：完成后停止，不自动进入下一任务

任务包应控制在一次 Claude 会话可以完成并总结的范围内。若预计涉及多个页面、数据库变更和复杂交互，必须继续拆分。

## 模块任务树

| 模块 | 文件 | 状态 |
|---|---|---|
| Phase 0 基础设施与认证 | `phase-0-foundation.md` | 已完成，维护模式 |
| Phase 1 产品与 SKU 映射 | `phase-1-products-variants.md` | Product 已完成，Variant 延期 |
| Phase 2 库存与 Dashboard | `phase-2-inventory-dashboard.md` | 当前优先 |
| Phase 3 在途与物流 | `phase-3-shipments.md` | 待开始 |
| Phase 4 团队账号 | `phase-4-users.md` | 待开始 |
| Phase 5 数据同步 | `phase-5-sync.md` | 待开始 |
| 发布与部署 | `deployment.md` | 平台待定 |
| 系统优化与工程治理 | `system-optimization-roadmap-2026-07-17.md` | ACTIVE；OPT-1–OPT-5 MERGED/FINAL PASS；OPT-6 Batch 1 closed；Batch 2 Production apply/postcheck FINAL PASS；Batch 3 remains separately gated |

## 状态标记

- `DONE`：已实现并通过独立验收
- `ACTIVE`：当前唯一执行任务
- `READY`：依赖满足，可以排为下一任务
- `BLOCKED`：存在明确阻塞
- `DEFERRED`：主动延期
- `BACKLOG`：尚未排期

## 切换任务流程

独立验收通过后：

1. 在对应 Phase 文件中更新任务状态。
2. 将下一任务内容写入 `current-task.md`。
3. 在 `current-state.md` 更新 Current Task 与引用。
4. 新 Claude 会话只执行新的 `current-task.md`。
> Current OPT-6 gate (2026-07-22): Batch 2 Staging remote apply/postcheck has
> independent `PASS`; Production apply/postcheck closing review returned
> `PASS` at exact head `96c87461afd444b2065059c98ba0cf08522b749e`, CI
> `29908869113`, Vercel `87HAB8w8rTZhDtJAZCvt2kmaRM31`. Batch 3 or further
> policy-group write still requires its own implementation and review.
