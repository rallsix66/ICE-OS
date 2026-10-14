# DIS 系统优化路线图（2026-07-17）

Batch 3 closeout update (2026-07-28): the corrected 00052 Staging SELECT-only revalidation passed, the reviewed Production 00052 apply packet executed once and its independent postcheck passed, and final independent evidence review returned PASS at HEAD e92b8720dbc2be29dc371e5de61c6e70d88beeec. PR #11 merged as f8f467f7fc649dd37d584864e2c79505fd53719e; master CI 30330308092 and Vercel production deployment 6EDexdjVENq4CDJgPW7RdSwztT3h completed successfully. Current gate: wait for the user's next instruction; no further Production write, old Migration replay, or Batch 4 is allowed.

## 文档定位

本路线图把 [DIS 项目代码总结](../archive/dis/DIS-项目代码总结.md)（2026-07-13，42 个 Migration / 3524 个测试）中仍然有效的建议，按 2026-07-17 的真实代码、Migration、测试和线上 Supabase 状态重新校准。

事实来源优先级：

1. 当前真实代码与 Git 历史
2. `supabase/migrations/`
3. `docs/current-state.md`
4. 本路线图
5. [DIS 项目代码总结](../archive/dis/DIS-项目代码总结.md)（仅作为 2026-07-13 的历史审计快照）

## 当前事实基线

| 项目 | 2026-07-17 事实 |
|---|---|
| 主线 | `master` 已合并 `codex/sequential-roadmap`，HEAD 包含 P0–P7、首页及 Preview 验收归档 |
| Migration | 仓库包含 00001–00047，共 47 个 SQL Migration |
| 默认测试 | OPT-1 基线为 88 个文件、3883 个测试；OPT-2 已把 2 个漏跑 Migration 测试纳入默认套件 |
| 全部测试文件 | OPT-2 新增 1 个隔离 PostgreSQL replay/RPC/RLS 行为测试；并发与 live provider 测试继续独立运行 |
| Lint | 0 error / 31 warning，均为未使用变量 |
| 构建 | Next.js build / TypeScript 通过 |
| Staging | 从空库连续重放 00001–00047，真实脱敏快照与 Admin/Operator RLS 验收通过 |
| Production | 业务 Schema 已包含大量早期对象，但 Migration 历史只登记 00041–00047；与 Staging 存在已确认 Schema 漂移 |
| 自动化 | OPT-1/OPT-2 已通过终审并合并；`master` run `29627444830` 的默认质量门、PostgreSQL 17 并发与数据库行为 job 均通过 |

## 对旧总结的校准

### 已完成，不再作为优化缺口

- P0–P7 与首页实现。
- Vercel Preview、独立 Supabase Staging 和真实脱敏数据验收。
- Production 的 00041–00047 部署与只读 RPC/RLS 冒烟。
- ProductVariant、海外库存、在途、团队账号和同步链路的既定 MVP 范围。
- 缺少 CI 的历史缺口已由 OPT-1 关闭：阶段终审 PASS、PR #3 已合并，`master` 两个 GitHub Actions job 均通过。

### 仍然成立

- 测试中过度依赖源码文本契约，真实 PostgreSQL/RLS/RPC 行为覆盖不足。
- Production 的迁移历史尚未基线化，不能安全启用 `supabase db push`。
- 国内库存、动态运输周期、库存历史快照、自动匹配、逐 SKU 同步审计仍属于产品路线技术债务。

### 本次审计新增或提高优先级

- 两个 `supabase/migrations/*.test.ts` 曾不在 `vitest.config.mts` 的 `src/**/*.test.ts` 扫描范围内；OPT-2 已显式纳入默认套件并发现、修正 00014 的 3 条过期测试断言。
- Production/Staging 数据库顾问均无 ERROR，但存在需人工分级的既有 WARNING：
  - 5 个函数未固定 `search_path`；
  - `get_user_role()`、`handle_new_user()` 继承了 `PUBLIC/anon EXECUTE`；
  - 多个 `SECURITY DEFINER` RPC 可由 `authenticated` 执行，必须逐个核对调用者身份绑定和业务授权，不能批量改成 `SECURITY INVOKER`；
  - 6 个 RLS policy 存在 auth init-plan 优化项；
  - 115 个 multiple permissive policy 告警，需要按表核对语义后逐步合并，禁止为消警告改变 Admin/Operator 可见范围。
- 当前状态文档中“等待 Preview 确认后合并”的旧描述已在 OPT-1 文档同步中改为历史验收结果。

## 总体实施顺序

```text
OPT-1 CI 基线
  ↓
OPT-2 测试覆盖加固
  ↓
OPT-3 Production Migration 基线审计（只读）
  ↓ 用户确认基线报告与备份
OPT-4 Migration 历史修复 + Schema 前向补齐
  ↓
OPT-5 数据库最小权限收口
  ↓
OPT-6 Lint / 文档 / 性能告警渐进治理
```

数据库任务必须串行。OPT-3 完成前，不得对 Production 执行 `db push`、旧 Migration 重放或新的 Production Schema 变更。

## OPT-1：CI 基线（DONE）

**目标**：让每次 PR 和 `master` push 自动验证当前稳定基线。

**范围**：

- 新增 GitHub Actions workflow。
- Quality Job：`npm ci` → 默认测试 → lint → build → `git diff --check`。
- PostgreSQL Job：启动隔离的 PostgreSQL service，执行 `npm run test:concurrency`。
- 初期以 `--max-warnings 31` 固定 warning 上限，禁止新增 warning；后续逐步归零。
- 确认并固定与 Vercel 兼容的 Node 主版本，写入 workflow 和项目版本约束。

**非目标**：

- PR CI 不连接 Production/Staging。
- `test:best-live` 不进入普通 PR；仅允许手动或计划任务并使用受保护 secrets。
- 本任务不部署 Vercel、不修改数据库。

**验收**：PR 与主线质量任务通过；故意破坏测试时 workflow 明确失败；并发测试在隔离 PostgreSQL 中稳定执行。

**2026-07-17 本地结果**：已新增 `.nvmrc`（与 Vercel Project Settings 的 Node `24.x` 对齐）和 `.github/workflows/ci.yml`。YAML 结构解析通过；默认测试 3883/3883、lint 0 error / 31 warning budget、占位 Supabase 环境 build 均通过。

**2026-07-18 远程结果**：PR #3（`agent/opt-1-ci-baseline` → `master`）通过指定独立审查并完成合并，merge commit 为 `222b2f2`。`master` GitHub Actions run `29626065160` 的 `PostgreSQL concurrency tests` 44/44 与 `Tests, lint, and build` 全部通过。workflow 未连接 Supabase Production/Staging，也未执行手动 Vercel deploy/promote。

**关闭结果**：阶段终审 PASS → PR #3 Ready 并合并 → `master` 两个 CI job PASS，全部完成；OPT-1 已关闭并切换 OPT-2。

## OPT-2：测试覆盖加固（DONE）

**目标**：保留有效架构护栏，同时把关键结论从“源码包含某段文本”升级为“数据库实际行为成立”。

**范围**：

1. 将以下漏跑测试移入 `src/` 对应 feature，或显式纳入默认 Vitest：
   - `supabase/migrations/00013_extend_user_variant_preference_favorited.test.ts`
   - `supabase/migrations/00014_dynamic_alert_fields.test.ts`
2. 为 00041–00047 增加隔离数据库 replay / RPC contract 测试。
3. 补 Admin、Operator、disabled user、anon、跨仓访问的 RLS 行为测试。
4. 补 P1、P7、首页聚合 RPC 的边界数据与权限测试。
5. 保留以下负向架构护栏：页面不直连 Supabase、客户端无 `service_role`、Repository/Server Action 边界、已执行 Migration 不被修改。

**验收**：所有测试进入可见的 CI job；权限测试验证返回行集，而不是只匹配 SQL/TS 源码文本。

**2026-07-18 关闭结果**：默认 Vitest 已纳入 00013/00014，90 files / 3926 tests 通过；新增 `migrations-00041-00047.postgres.test.ts`，在 PostgreSQL 17 中按顺序执行真实 00041–00047 SQL，并验证 Schema/ACL、P1/P7/首页 RPC 边界与 Admin、Operator、disabled、anon、跨仓返回行集。阶段独立终审 PASS；PR #4 已合并，merge commit `7a85ccd`；`master` run `29627444830` 的质量 job、并发 44/44 与数据库行为 10/10 全部通过。

## OPT-3：Production Migration 基线审计（DONE）

**目标**：在不写 Production 的前提下，生成可复核的 00001–00040 历史与对象级差异报告。

**步骤**：

1. 记录 Production 备份/恢复点和当前 Migration 历史。
2. 从 00001 到 00040 逐条提取预期 Schema effect。
3. 对 Production 与 Staging 做只读对象比对：表、列、类型、默认值、约束、索引、触发器、函数签名/定义/owner/ACL、RLS 和 policy。
4. 每条 Migration 分类：
   - `EXACT_PRESENT`：效果完整且一致，可候选只修历史；
   - `PRESENT_DIVERGENT`：对象存在但定义不同，必须影响评审；
   - `MISSING_REQUIRED`：缺失且当前仍需要，使用 00048+ 前向 Migration 补齐；
   - `OBSOLETE_SUPERSEDED`：已被后续 Migration 完整替代，记录证据，不重放旧 SQL；若不登记会导致 CLI 尝试重放，则仅在完整替代与最终状态均已证明后标记 applied。
5. 输出 SQL、对象证据、风险、回滚和建议动作，等待用户确认。

**硬性边界**：

- `supabase migration repair` 只允许在以下三类证据成立时标记 applied：实际 Schema effect 已存在；或后续 Migration 已被证明完整替代且最终状态正确；或缺失对象已由 00048+ 前向 Migration 补齐并验证。它只修历史，不执行 SQL。
- 禁止把 00001–00040 直接重放到 Production。
- 禁止为了让 CLI 显示一致而伪造对象状态。
- 审计阶段只读，不修改 Migration、Production Schema 或历史表。

**2026-07-18 审计结果**：Production 历史仅登记 00041–00047，Staging 在 OPT-4 前登记 00001–00047。相同只读目录查询确认 Policy 42/42、Table/RLS 18/18、Trigger 13/13 完全一致；精确差异只有 00010 的 `claim_sync_run_system(...)` 在 Production 缺失，以及 00011 的三列/FK/索引只存在于 Staging。00010 为 `MISSING_REQUIRED`，须由 00048+ 前向补齐；00011 已被 00012 的用户级偏好语义替代，不得在 Production 复活。00001–00040 汇总为 28 `EXACT_PRESENT`、11 `OBSOLETE_SUPERSEDED`、1 `MISSING_REQUIRED`、0 `PRESENT_DIVERGENT`。三轮独立阶段审查已 PASS。详见 [只读审计报告](../reports/2026-07-18-production-migration-baseline-audit.md)。用户随后确认继续，并完成了 Production 逻辑备份、SHA-256 与归档可读性校验，因此 OPT-4 前置恢复点门禁已满足。

**关闭结果**：阶段终审 PASS、用户确认报告与恢复点、PR #5 合并（merge commit `e3e4c60`）；OPT-3 已关闭并进入 OPT-4。

## OPT-4：历史修复与 Schema 前向补齐

**前置条件**：OPT-3 报告通过人工确认，Production 有可用备份/恢复点。

**范围**：

- 对 `EXACT_PRESENT` 在对象证据复核后执行受控 migration history repair，标记 applied。
- 对 `OBSOLETE_SUPERSEDED` 不重放旧 SQL；仅在逐条证明后续 Migration 已完整替代且当前最终状态正确后，通过 history repair 标记 applied，避免 CLI 把旧 SQL 当作待执行。
- 对 `MISSING_REQUIRED` 先用 00048+ 前向 Migration 补齐并验证，再把对应旧 Migration 标记 applied；00010 严格按此顺序处理。
- 对缺失或分歧对象创建新的 00048+ 前向 Migration；不修改 00001–00047。
- 先在全新本地/临时数据库重放 00001–最新，再部署 Staging。
- Staging 完成 Admin/Operator/RLS/关键页面和回滚演练后，才安排 Production 维护窗口。
- Production 执行后重新核对 Schema、Migration 历史和数据库顾问结果。

**2026-07-18 Staging 结果（历史检查点）**：00048 已在 Staging 成功应用并登记。`claim_sync_run_system(...)` 的 owner、`SECURITY DEFINER`、空 `search_path` 与 service-role-only ACL 均通过；00011 遗留的三列/FK/索引已在零有效旧归档数据门禁下移除。事务内合法 Dry Run、Real Write 拒绝和 Operator 拒绝通过且回滚无残留，本机 PostgreSQL 17 契约测试 14/14。三轮独立阶段审查最终 PASS；Draft PR #6 GitHub Actions run `29635961807` 的 quality 与 PostgreSQL job 全部 PASS。当时状态为 `STAGING REVIEW PASS / PRODUCTION APPROVAL PENDING`；现行停止条件以 2026-07-20 段落为准。详见 [OPT-4 Staging 验证报告](../reports/2026-07-18-opt4-staging-verification.md)。

**2026-07-18 Production 结果与终审返工（历史检查点）**：用户明确批准维护窗口后，先复核 Production 备份与 0 个运行中同步任务，再应用与 Staging 正文一致的 00048。Production version `20260718074910`；函数 owner、ACL、空 `search_path` 与事务内 Dry Run/拒绝路径均通过，回滚后 run/hash/lock 残留为 0。随后在单一受控事务中只修复 00001–00040 的 `schema_migrations` 历史，不执行旧 SQL；40 条 version/name/statements 均来自 Staging 已登记记录，并在提交前逐条校验 MD5 与长度。Schema 最终收敛为 Production/Staging canonical catalog 14 组摘要差异 0，顾问没有新增与 00048 相关的告警。指定独立终审随后发现两环境远端 48 条 timestamp `version` 均与仓库 `00001–00048` 前缀不匹配；当时状态为 `CHANGES REQUIRED / STAGING REALIGNMENT APPROVED / EXECUTION DEFERRED FOR ENVIRONMENT HANDOFF`。该问题已按下面的 2026-07-20 两阶段 history-only 对齐修复，本文本仅保留历史上下文。

**2026-07-20 Staging history version 对齐**：在已获批窗口和即时 preflight（项目 `ACTIVE_HEALTHY`、PostgreSQL 17.6、48 条 timestamp、0 aligned、0 个运行中同步任务）后，执行已验证的 history-only 单事务脚本。48/48 version 已对齐为 `00001–00048`，所有非 version payload 的事务内逐行不变断言通过；写入后 name/statements digest 仍为 `3566222cba075216b6c9a0d3065b7b93`，14 组 canonical catalog count/digest 全部不变。Supabase 官方连接器直接确认真实 Staging 48 条 version 精确完整；固定 CLI `2.109.1` 在该真实 version 集合的同构临时 PostgreSQL history 上输出 48/48 local=remote 且 `db push --dry-run` 为 up to date。由于新环境缺少 CLI platform access token，CLI 未直接连接远端，这一证据边界已如实披露。指定审查会话独立复算真实远端 48 行、两套 history digest、逐行 statement 证据、0 个运行中任务、14 组 catalog 摘要与脚本哈希后给出 Staging PASS。详见 [Staging History Version 对齐报告](../reports/2026-07-18-opt4-staging-history-version-realignment.md)。

**2026-07-20 Production history version 对齐与最终关闭**：用户把 OPT-4 剩余项及后续既定路线改为持续授权，但保留“每阶段完整验证与指定会话 PASS 后才能进入下一阶段”的停止门。Production 专用脚本先在一次性 PostgreSQL 17 测试库验证首次 48/48 成功和重复执行拒绝，再以 `ACTIVE_HEALTHY`、PostgreSQL 17.6、48 timestamp / 0 aligned、version+name digest `06c450dcf0e265c7d20f3cf7b8ed71e1`、0 个运行中任务和 14 组 catalog 精确命中为即时门禁。单事务只更新 `schema_migrations.version`，所有非 version payload 逐行不变；写后 Production 为 0 timestamp / 48 aligned，name/statements digest 仍为 `8f08a8dee32cbca3aebe5f5861206699`，两环境 14 组 catalog 再次逐项一致。指定会话随后独立核验 base `ed203f1` 至 head `1a914bd` 的 10 文件范围、两套真实远端 history 与逐行 evidence、14 组 catalog、函数 ACL/RLS、Advisor、CI run `29714460569` 和 Vercel Preview `dpl_FfeeXgiXMkE2eVYUjyjseQkhZHjK`，结论为 `OPT-4 FINAL PASS`。`npm audit --omit=dev` 的 2 个 moderate PostCSS advisory 无可用修复且无仓库利用路径，记录到 OPT-6，不宣称 audit 为零。OPT-4 已关闭，允许进入 OPT-5。详见 [OPT-4 Production 验证报告](../reports/2026-07-18-opt4-production-verification.md) 与 [Production postcheck evidence](../reports/evidence/2026-07-20-opt4-production-history-postcheck.md)。

## OPT-5：数据库最小权限收口

**目标**：解决高信号安全告警，同时保持现有权限语义和 RLS 行为。

**已确认事实**：

- `get_user_role()` 为 `SECURITY DEFINER`，已 `SET search_path = ''`，查询绑定 `auth.uid()` 和 `profiles.is_active`；anon 调用通常返回空，但无需保留 anon 执行权。
- `handle_new_user()` 为 Auth 用户创建触发器函数，已固定空 `search_path`；应撤销不必要的直接执行权，并保证 Auth trigger 所需 owner 权限不受影响。
- `check_operator_profile_update()`、`update_updated_at_column()`、`update_shipment_external_updated_at()`、`toggle_user_active_protected()`、`update_user_role_protected()` 未固定 `search_path`；其中后两个已有 `auth.uid()`、活跃 Admin 和操作者参数绑定。

**实施原则**：

1. 逐函数记录 owner、SECURITY 模式、调用角色、内部鉴权、RLS 依赖和现有调用点。
2. 优先撤销不需要的 `PUBLIC` / `anon EXECUTE`，只向实际调用角色显式授权。
3. 所有保留函数固定安全 `search_path` 并显式限定对象 schema。
4. `SECURITY DEFINER` 只有确需越过 RLS 的内部读取/原子操作才保留；不得为了消除告警批量切换模式。
5. 检查 `provider_token_cache` 的 Data API grant。若仅 service role/服务器使用，保持无 anon/authenticated policy 可能是正确设计；先验证 grant，再决定是否新增 policy。
6. Supabase Auth 的 leaked-password protection 属于平台设置，单独评估启用后的登录影响并做回归。
7. 通过新的前向 Migration 实施，先 Staging，后 Production。

**验收身份矩阵**：anon、未登录、活跃 Admin、活跃 Operator、disabled user、跨仓 Operator、service role/系统同步调用。

**2026-07-20 最终结果**：两环境只读函数定义、ACL、RLS 与 `provider_token_cache` grants 基线逐项一致。00049 以最小 ALTER/REVOKE 固定 5 个 mutable search path、移除不必要直接调用面、保持用户管理 RPC 为 authenticated-only invoker，并把 token cache 收敛到 service-role-only definer lease RPC。默认测试 3939/3939、lint 0/31、build/TypeScript、并发 44/44、00001–00049 空库重放与 contract 27/27 均通过；两环境最终 49/49、全部七类 catalog、ACL/RLS、回滚探针、token 数据保持与 Advisor 全绿。首轮终审只要求修正文档/PR 过期状态；返工 head `9d52ad5`、CI `29718642505`、Vercel `dpl_EhLhGoqpysRmRj49BNgDASrnWsGJ` 全绿后，指定会话给出 `OPT-5 FINAL PASS`。当前仅待主会话合并 PR #8；详见 [OPT-5 主报告](../reports/2026-07-20-opt5-database-least-privilege.md)、[Staging evidence](../reports/evidence/2026-07-20-opt5-staging-postcheck.md) 与 [Production evidence](../reports/evidence/2026-07-20-opt5-production-postcheck.md)。

## OPT-6：渐进式质量治理

**当前状态（2026-07-21）**：Batch 1 remote final PASS evidence 已合并为 `2510b0e070b7fe637239cf0a8eecc3e63aec9570`。Batch 2 的代码与本地验证已完成，并获指定独立审查 `FINAL PASS`（head `3885651309ac37f2bf5dd48ce905dfdfe6da8886`；CI `29798631677` 与 Vercel Preview 全绿）。Staging 已在受控窗口应用 `00051`，原子事务返回成功，后续 SELECT-only postcheck 九项全部为 `true`：`00001`–`00051` 精确 history、00051 payload 与四条 `public.role` policy catalog 全部命中。该 Staging apply/postcheck 证据现提交指定独立审查；Production 与其余候选组仍禁止。回放 inventory 有 42 条 policy、将 `FOR ALL` 展开后有 23 个 table/action overlap group。`00051` 仅处理 `public.role` 的 Admin/Operator SELECT union，并以完整 catalog 与身份矩阵证明等价；其余 22 组仍待逐组证明。详见 [Batch 2 报告](../reports/2026-07-21-opt6-quality-governance-batch-2.md)、[Staging apply/postcheck evidence](../reports/evidence/2026-07-21-opt6-00051-staging-preflight.md) 与 [inventory evidence](../reports/evidence/2026-07-21-opt6-batch2-policy-inventory.md)。

- 清理 31 个 unused-vars warning；CI warning budget 从 31 逐步降至 0。
- 对 6 个 auth init-plan policy 使用 `(select auth.uid())` 等等价形式优化，并验证权限矩阵不变。
- 115 个 multiple permissive policy 按热点表和可读性分批治理；每批必须先证明 OR 语义等价。
- 未使用索引只在取得足够生产统计窗口后处理，不能根据单次 advisor 输出批量删除。
- 调查 Next.js build 的既有 Turbopack NFT 全项目 trace warning；重点审查 `next.config.ts → sync/server-actions.ts → api/cron/dry-run` 的动态文件系统路径，修复前不得改变同步产物路径或 Vercel 运行行为。
- 持续校验 `current-state.md` 的 Preview/合并/部署描述，防止完成态再次回退为历史停止条件。

## 产品路线：不混入本轮工程治理

以下项目保留在产品 Backlog，需要单独确认业务规则、数据源和验收口径：

- P8 国内库存接入；
- 仓库/线路级动态运输周期；
- 库存历史快照；
- ProductVariant 自动/半自动匹配；
- 逐 SKU 同步变更审计；
- 百世 API 权限恢复。

## 全局停止条件

- 任一任务发现现有行为与文档不一致，先记录事实并停止扩大范围。
- 任一数据库任务无法证明 Admin/Operator/RLS 语义等价，不进入 Production。
- 任一 Migration 无法在空库连续重放，不部署 Staging/Production。
- 用户已对 OPT-4 剩余项与 OPT-5/OPT-6 既定路线给出持续授权；仍须逐阶段完成“实施/执行 → 完整验证与证据 → 指定会话明确 PASS”，且 PASS 前不得进入下一阶段。意外数据删除、直接回滚、重放旧 Migration、绕过 RLS、密钥暴露、范围外架构变更或 materially different 的操作仍必须停止并取得单独确认。
The preceding 2026-07-21 Batch 2 paragraph is a historical checkpoint only;
its Production-prohibited wording is superseded by this current gate.

**Current gate (2026-07-22)**: Staging `00051` remote apply/postcheck has
designated independent `PASS`. Production `00051` apply/postcheck evidence has
been captured and the SELECT-only postcheck passed, but the current independent
closing review returned `PASS` at exact head `96c87461afd444b2065059c98ba0cf08522b749e`,
CI `29908869113`, and Vercel Preview `87HAB8w8rTZhDtJAZCvt2kmaRM31`. The
earlier packet-review head `f7acf211ac66e2b86a22e14254a1ffe75782c224` authorized
execution only; it is not the closing review result. Batch 3 and every other
policy group remain blocked until their own implementation and independent
review.
This current-gate note supersedes the earlier Batch 2 paragraph that described
the Staging evidence as still pending review.
The corrected Production exact preflight packet was executed read-only on
2026-07-22 and all history, full-payload, role-catalog, and active-run gates
passed. The separately reviewed apply packet then committed in the approved
window; its postcheck confirmed exact 00001–00051 history, canonical 00051
payload, four reviewed role policies, and zero active sync runs. Batch 3 remains
blocked by its separate implementation/review gate.
The packet's `expected_history` CTE pins the reviewed `00001`–`00050`
version/name and full `statements[]` payload summaries. Its
`exact_version_name_history` and `exact_history_payload` booleans are the
row-by-row hard stop; the read-only static contract is indexed from the
preflight report. No digest-only output can authorize the next step.

**Batch 3 implementation checkpoint (2026-07-22)**: the next bounded
candidate is the pure `public.product` SELECT overlap. Forward-only Migration
`00052_optimize_product_rls_policy_overlap.sql` and its static/PostgreSQL
behavior contracts are implemented and indexed in the [Batch 3 report](../reports/2026-07-22-opt6-quality-governance-batch-3.md)
and [evidence](../reports/evidence/2026-07-22-opt6-batch3-product-policy.md).
Status is IMPLEMENTATION COMPLETE / IMPLEMENTATION REVIEW PASS / STAGING SELECT-ONLY REVALIDATION FINAL PASS / PRODUCTION SELECT-ONLY PREFLIGHT FINAL PASS / PRODUCTION APPLY AND POSTCHECK PASS / FINAL EVIDENCE REVIEW PASS / PR #11 MERGED / PRODUCTION DEPLOYMENT COMPLETE / BATCH 4 PROHIBITED.
The remaining policy groups are unchanged. The designated independent review returned `PASS` for implementation head
`23d92d3e7ed43013e5dbbe0a828a166a05245cfc`; audit submission
`024a946fa16facaba22fbb85a2af3ff54323832c` records that result. The 00052 Staging SELECT-only preflight packet was independently approved and attempted once; PostgreSQL stopped the first revision with 42P01 for an undefined role_check CTE before any result or write. The corrected packet was independently re-approved and retried once; its full statements[] payload gate returned false because the expected CTE used the Production variant for known Staging rows 00041-00047. A separate SELECT-only comparison matched the prior Staging postcheck, so the packet expected baseline was corrected to the approved Staging variant and now expects digest 8ec295c38bc90f769dc35ca5fd64a500. No write occurred. The corrected SELECT-only revalidation then completed with every history, payload, policy, and active-sync gate true. Final independent evidence review later returned PASS at HEAD e92b8720dbc2be29dc371e5de61c6e70d88beeec; the Production apply/postcheck completed once and PR #11 was merged. This historical Staging checkpoint is closed; no further Production write, old Migration replay, or later candidate is allowed.
The current submitted exact head is `23d92d3e7ed43013e5dbbe0a828a166a05245cfc`,
bound to CI `30230526963` and Vercel Preview `5F5tvSTDP7A14aCaD217Pxh2yFh3`;
both are green and exact-head matched. The earlier
`ce7e623ff396f099c3bf9256733973ce158beb9e` / `29913122480` /
`EeNmUmEaEajq3MnRVe7V3RCTfGph` values are historical implementation-checkpoint
evidence only. The first independent review returned `CHANGES_REQUIRED` only
because PR/documentation carried stale historical bindings; those bindings
are now corrected and the implementation review `PASS` is recorded; documentation-only status
sync is bound to CI `30232410813` and Vercel `D9hYAYzUJ88yp7zwQtfqKM2hfa7f`.

**Production 00052 SELECT-only preflight execution (2026-07-28)**: after implementation-review PASS, the prepared packet ran exactly once in Production SQL Editor. All history/version-name/full statements[] payload, public.product policy, and zero-active-sync gates passed; actual/expected full-payload digest was 0b7cba5a88fff139fb0ec65e4deaa142, version/name digest was 2d6174dce487614c3280456fff9169d0, product policy digest was 119e5878b2ddd6d3f7c1c01e614c4112, and in_progress_sync_runs=0. No write, Migration, or apply packet ran. The designated independent reviewer returned PASS at head `7f83f01c847d685e865d2c4c7c4d8012267ed085`, CI `30276563343`, and Vercel `4QSHNyh9PDfbnpWMrMeiadV2YBts`. The Production apply was then executed once in the controlled window; its postcheck and final evidence review passed.
**Production 00052 apply and postcheck (2026-07-28)**: the reviewed packet was executed once in the controlled Production window. Its transaction committed and the independent SELECT-only postcheck confirmed 52 history rows, exact old-history digests `0b7cba5a88fff139fb0ec65e4deaa142` / `2d6174dce487614c3280456fff9169d0`, canonical 00052 payload (5786 chars, MD5 `580fd279b2f8d07f6c5a550acc82812a`), four product policies, and zero active sync runs. Final post-apply evidence review returned PASS at HEAD e92b8720dbc2be29dc371e5de61c6e70d88beeec; no old Migration was replayed, PR #11 was merged, and Batch 4 remains separately gated.
