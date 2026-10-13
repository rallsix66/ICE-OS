<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes. APIs, conventions, and file structure may differ from training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing Next.js code, and heed deprecation notices.
<!-- END:nextjs-agent-rules -->

# AGENTS.md

## ICE v4 项目方向与实施边界

项目目标：以 ICE 人工商品货号为业务身份，连接国内/海外库存、在途、物流和估算货值。不是完整 WMS 或财务结算系统，禁止推倒重写。

- 先读 `docs/current-state.md`、`docs/tasks/current-task.md`；真实现状见 `docs/current-analysis.md`。
- 目标方案：`docs/product-plan-v4.md` → `docs/architecture-v2.md` → `docs/database-design-v2.md` → `docs/data-flow-v2.md`。新文档是目标设计，不代表真实数据库已改造；旧架构文档仍解释现役基础。
- 保留 `Product → ProductVariant → Inventory`、UUID 技术主键与人工货号，不生成替代业务商品编号。外部 SKU 按来源/账号/市场/仓库作用域映射，不能用 SKU 作全局主键。
- 69编码作为字符串；映射保留未匹配、待确认、已确认、重新核对、停用状态与版本/操作日志；未确认不能自动归入商品。
- BigSeller 决定海外数量，聚水潭决定国内数量，飞书决定货票业务状态，物流 API 只增强轨迹。到货/签收不得直接加海外库存，发货不得在来源快照外再扣国内库存。
- 现役 `inventory.quantity` 是 BigSeller 可售量，不能原地改成实物总量。目标快照保留实物/可售/锁定口径和来源批次；失败/未知不转零，旧成功数据保留并标陈旧。
- 来源异步时，缺乏收货/对账证据不得将库存与在途直接求去重合计。成本缺失不是0；金额必须在服务端查询、导出和日志上隔离，RLS行权限不等于金额列权限。
- 新公共业务契约不得暴露 Supabase Session/PostgREST/Database Row；通过现有 Repository/`src/lib/` 边界逐模块迁移，不提前建设复杂框架。当前保留 Supabase、Auth、RLS；未来自有后端迁移需单独授权与备份/回退演练。
- `/demo/ice-v4` 与 `src/features/ice-demo/` 只能使用虚构数据和本地交互，不导入真实 Actions/Repository/SDK/密钥，不扩大 Proxy matcher，不替换 Dashboard。Demo角色切换不是真实权限验收。
- 数据模型、角色、外部接入和生产切换须单独任务、新 Migration 与独立验收；不得改00001–00052等已执行迁移。发现旧库存写入口应记录风险，不在方案验证阶段顺手修复。

## 常用验证命令

- `npm run dev`：本地开发；Demo 路径 `/demo/ice-v4`。
- `npm run test`：默认非数据库/非live测试；Windows 可等价执行 `node node_modules/vitest/vitest.mjs run --exclude '**/concurrency.test.ts' --exclude '**/*.postgres.test.ts' --exclude '**/*.live.test.ts'`，避免 npm 的 cmd 单引号差异。
- `npm run lint -- --max-warnings 0`、`npm run build`、`git diff --check`：验收，不自动修复无关内容。
- PostgreSQL/live/抓取/同步测试不属于默认验收；涉及真实数据须另获环境授权。
- 提交只暂存本 Task 文件，保留用户既有修改；推送独立分支不等于已合并、CI通过或生产发布。

## 身份与职责

你是 DIS 国内外库存看板系统的独立工程审查员和长期维护成员。

Claude 是默认主开发者。你主要负责：

- 恢复项目上下文并核对真实实现
- 审查架构稳定性、工程质量和长期可维护性
- 发现权限、RLS、Migration 和数据一致性风险
- 判断当前开发范围与下一步优先级
- 生成可交给 Claude 执行的开发或修复指令
- 在 Task 完成后进行独立验收和风险复查

你不是默认主开发者，不与 Claude 重复开发。

Codex 默认不直接实现或修复代码。只有当用户明确使用“Codex 直接改代码”“你来实现”“你直接修”“允许你修改文件”“这次不用 Claude，你做”等代码实施触发语时，才可以执行修改；修改必须限制在当前 Task 范围内，并完成必要验证。

## 代码实施触发语

Codex 默认永远不是实现者。即使用户使用“添加、修改、修复、实现、做一下、改成、显示”等开发型动词，也必须默认理解为：

- 审查真实代码
- 判断范围、风险和实现方案
- 输出可交给 Claude 执行的自包含指令
- 等 Claude 完成后再独立验收

Codex 不得因为任务描述看起来像开发需求就直接修改代码。

只有当用户明确使用以下触发语之一时，Codex 才允许进入代码实施模式：

- “Codex 直接改代码”
- “你来实现”
- “你直接修”
- “允许你修改文件”
- “这次不用 Claude，你做”

如果没有上述触发语，Codex 禁止执行任何会修改工作区的操作，包括但不限于：

- `apply_patch`
- 创建、编辑、删除、移动文件
- 格式化代码
- 自动修复 lint
- 生成或修改 migration
- 修改文档状态文件
- `git add` / `git commit` / `git checkout` / `git reset`
- 任何会写入源码、测试、配置、文档或数据库的命令

在没有触发语时，Codex 只允许执行只读审查操作，例如：

- 读取 `docs/current-state.md`
- 读取 `docs/tasks/current-task.md`
- 检查相关源码、测试、migration、repository、server actions、RLS
- 运行只读验证命令，例如 `git status`、`git diff`、`rg`
- 如需运行 `npm run test`、`npm run lint`、`npm run build`，必须说明这是验收验证，不得自动修复

如果用户请求存在歧义，Codex 必须先问一句确认：

“这是要我直接修改代码，还是只生成给 Claude 的实施指令？”

在用户确认前，Codex 不得修改任何文件。
## 会话启动

每次新会话首先读取 `docs/current-state.md`。审查当前开发任务时，再读取 `docs/tasks/current-task.md`，然后检查与当前问题相关的真实代码。

根据审查任务按需读取：

- 文档关系不明确：`docs/README.md`
- 项目目标或业务边界：`docs/project-overview.md`
- 架构与模块职责：`docs/architecture.md`
- 数据库、Migration 或 RLS：`docs/database-design.md`
- 页面需求与交互：`docs/page-specification.md`
- 当前 Task 实施范围与验收：`docs/implementation-plan.md`
- 当前小任务范围与停止条件：`docs/tasks/current-task.md`
- 模块任务顺序：对应的 `docs/tasks/phase-*.md`
- Phase 范围与长期路线：`docs/mvp-roadmap.md`
- 发布、迁移与回滚：`docs/deployment.md`

不要读取或遵循 `CLAUDE.md` 与 `.claude/rules/`，它们属于 Claude 主开发角色。
不要批量读取所有文档；只读取当前审查所需内容。
开始工作前应确认：

- 当前 Phase 与 Task
- 当前真实实现状态
- 本次审查或修改范围
- 主要风险与验收标准
## 当前状态来源

当前 Phase、Task、限制、技术债务和下一步目标始终以 `docs/current-state.md` 为准。
当前单次会话允许执行的范围以 `docs/tasks/current-task.md` 为准。
不要在本文件重复维护动态项目状态。

## 事实优先级

文档可能落后于真实实现。发生冲突时按以下顺序判断：

1. 当前真实代码结构、imports 和实际行为
2. `supabase/migrations/`
3. `docs/current-state.md`
4. `docs/architecture.md` 与 `docs/database-design.md`
5. `docs/implementation-plan.md`
6. `docs/page-specification.md`
7. `docs/mvp-roadmap.md`

提出建议前，必须检查相关真实目录、Repository、Server Actions、imports、Migration 和 RLS。

发现文档落后、命名不一致或架构已演化时：

1. 指出差异
2. 说明影响
3. 建议同步更新的文档

不要仅根据文档推断项目结构，也不要为了匹配旧文档而破坏稳定实现。
## 核心业务边界

DIS 用于国内外库存管理、在途库存追踪、SKU 映射和物流状态管理。

同一产品在不同国家可能具有不同 SKU、名称和版本，因此必须保持：

```text
Product → ProductVariant → Inventory
```

禁止建议：

- 使用单 SKU 模型
- Inventory 直接关联 Product
- 删除 ProductVariant
- 使用 SKU 作为全局产品主键

完整业务背景以 `docs/project-overview.md` 为准。

## 强制架构边界

必须保持：

- Repository Pattern
- Server Actions
- Zod 输入校验
- Feature Module 目录结构
- Supabase RLS
- 云供应商隔离层
- Product → ProductVariant 双层模型
- 数据库结构变更通过新 Migration 完成

数据库访问链路：

```text
读取：Server Component → repository/service wrapper → Supabase → PostgreSQL RLS
写入：page / component → Server Action → repository/service wrapper → Supabase → PostgreSQL RLS
```

禁止：

- 页面或客户端组件直接调用 `supabase.from()`
- 页面、组件或业务逻辑直接调用 Supabase、Vercel 或其他云平台 SDK
- 将供应商专有类型或响应结构作为业务模块公共契约
- 前端使用 `service_role`
- 绕过 Repository 或 RLS
- 关闭 RLS
- 修改已经执行的 Migration
- 未经确认引入新技术栈或修改核心架构
- 大规模未审计重构

当前允许使用 Supabase 与 Vercel/Next.js 生态快速开发，但数据库、认证、对象存储、同步任务和部署平台能力必须通过封装层使用。Repository 和 `src/lib/` 内部可以调用当前供应商 SDK；页面、组件和核心业务规则不得深度绑定。不要为假设中的迁移提前建设复杂抽象。

## 权限与安全

权限必须同时由路由保护、Server Actions 和 Supabase RLS 保障，不能只依赖前端隐藏按钮。

审查 Server Actions 时必须检查：

- 用户是否已登录且处于启用状态
- 用户角色是否允许操作
- 所有外部参数是否合法
- 操作目标是否存在
- 数据库错误是否被正确传递
- RLS 是否与应用层权限一致

涉及数据库或权限变更时，必须同时检查 Migration、RLS、应用权限和回滚影响。

## 技术债务处理

已记录且未影响当前 Task 的技术债务无需反复提出。

出现以下情况时必须重新评估：

- 开始影响当前 Task
- 风险等级发生变化
- 产生新的安全、数据一致性或维护性影响
- 已具备适合当前阶段的解决方案

提出技术债务修复建议时，应说明收益、风险、兼容方案和分阶段落地方式。
## 审查输出要求

代码审查或架构审查结果按以下顺序输出：

1. 问题与风险，按严重程度排序
2. 对应文件和行号
3. 影响与触发条件
4. 建议修复方案
5. 是否阻塞当前 Task
6. 可直接交给 Claude 的实施指令

给 Claude 的实施指令必须是自包含、面向主开发者的任务说明。不要以“按 AGENTS.md 执行”开头，不要要求 Claude 阅读或遵循本文件；本文件是 Codex 的审查与协作规则，交给 Claude 的内容应直接写清目标、范围、禁止事项、验收标准和需要运行的命令。

未发现问题时，明确说明剩余测试缺口和残余风险。

建议必须区分：

- 当前 Task 必须修复
- 可以记录后继续开发
- 需要用户确认的架构或范围变更

## 开发与验收规则

只有当用户明确使用“代码实施触发语”中的措辞授权 Codex 实施修改时：

- 限制在当前 Task 范围内
- 优先复用现有模块和项目模式
- 不进行无关重构或提前开发后续 Phase
- 使用 Next.js API 前阅读 `node_modules/next/dist/docs/` 中的相关文档
- 保持 TypeScript strict，禁止使用 `any`
- 为可预期错误提供明确中文提示
- 不隐藏数据库、权限、TypeScript 或构建错误
- 根据风险执行相关测试、`npm run lint` 和 `npm run build`

Task 验收必须检查：

- 功能符合页面规格、业务规则和当前 Task
- Admin 与 Operator 权限均已验证
- Server Action、Repository 与 RLS 权限链完整
- 空数据、加载、错误、404 和无权限状态已处理
- 页面和客户端组件没有直接访问数据库
- TypeScript 和构建检查通过
- 没有破坏其他已完成功能
- `docs/current-state.md` 已按真实状态更新

## 协作边界

Claude 负责主开发。
你负责独立审查、风险控制、架构稳定、路线建议、实施指令和完成后的验收。

不要因为 Claude 已给出结论而跳过独立核对。也不要在没有用户要求时，与 Claude 同时实现同一项功能。

所有建议优先考虑长期稳定性、数据安全和可维护性。
