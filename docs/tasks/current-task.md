# Current Task Packet

## Task ID: ICE-V4-PLANNING-DEMO

### Status: LOCAL VERIFIED WITH BASELINE GAPS / 待产品评审（2026-10-13）

五份文档、ADR、AGENTS入口、六视图Demo和81项新测试已完成。Next构建/内置TypeScript及lint通过，桌面/390px交互已复验；默认全量4093/4094的唯一失败改动前已存在，直接全仓tsc仍报告旧测试类型问题。完整证据和文件列表见 [验收报告](../reports/2026-10-13-ice-v4-validation.md)。不将这些结果写成生产或新权限模型已验收；代码冻结后仅做本任务Git交付。

本次用户明确选择由 Codex 执行附件中的 ICE v4 方案验证任务。允许分析、设计文档、AGENTS增量更新、隔离Demo、本地验证、独立Git分支提交与推送；不扩大到真实数据接入。

### 交付范围

1. `docs/current-analysis.md`：真实代码、复用/调整/拟退役项与证据。
2. `docs/product-plan-v4.md`、`architecture-v2.md`、`database-design-v2.md`、`data-flow-v2.md`及架构决策。
3. 更新AGENTS和状态/导航入口，保留历史与既有角色约定，不读取或修改CLAUDE专属文件。
4. `/demo/ice-v4`：经营总览、商品库存、ICE商品库、物流详情、库存快照、操作日志。全部虚构fixture；可搜索、筛选、详情、演示时间序列和日志。
5. 新功能单元/隔离契约、默认非数据库测试、lint、build、浏览器可行验证、diff检查，记录新旧失败。
6. 只提交本Task文件，提交标题 `feat: ICE inventory architecture v4 planning`，推送 `codex/ice-v4-planning`，不合并master、不主动部署。

### 验收与停止条件

- 保留Product→ProductVariant；货号是人工业务身份，SKU/69编码不替代技术主键。
- 飞书到货不改变BigSeller快照；新快照才改变海外数量；证据不足不乱加库存/在途，缺成本不填0。
- 演示切换不是真实RLS验收；业务链路、数据库、SDK和生产配置不变。
- 六视图有明确演示标记、空/无匹配状态、可返回的详情、响应式和键盘操作；测试数据无真实资料。
- 保留既有未提交内网部署报告；旧Migration/SQL packet测试失败不绕过、不顺手修。
- 达到文档+Demo+验证+Git推送即停。新增源授权、真实schema/权限/成本或生产发布需要下一任务明确授权。

## Historical task packets（closed，仅供证据追溯）

The corrected 00052 Staging SELECT-only revalidation ran once after its fresh implementation review PASS; all history/version-name/full-payload, product-policy, and active-sync gates passed, with no write or Migration. The designated independent reviewer returned PASS at head a2e319eeb587474b71e66888bdbccbc27f38813c, CI 30266046505, and Vercel 7Py8GVBM1NhfendWozqvRwvLCT2G. The Production 00052 SELECT-only preflight then ran exactly once with every gate true; the designated independent reviewer returned PASS at head 7f83f01c847d685e865d2c4c7c4d8012267ed085, CI 30276563343, and Vercel 4QSHNyh9PDfbnpWMrMeiadV2YBts. Production 00052 apply/postcheck completed once and passed; final evidence review returned PASS at HEAD e92b8720dbc2be29dc371e5de61c6e70d88beeec. PR #11 merged as f8f467f7fc649dd37d584864e2c79505fd53719e, master CI 30330308092 and Vercel production deployment 6EDexdjVENq4CDJgPW7RdSwztT3h passed. Current gate: wait for the user's next instruction; no further Production write, old Migration replay, or Batch 4 is allowed.

## Historical Task ID: ARCH-IN-TRANSIT-REPOSITORY-BOUNDARY

### Status: DONE / 验收 PASS（2026-07-29，返工完成）

`actions.ts` 中 `importGoluckyRefs` / `bindExternalRefToShipment` / `reactivateExternalRef` 原先直接 `createClient()` + `supabase.rpc()`，违反 Server Action → Repository → Supabase/RPC 数据访问链路。

**实施内容：**
- `repository.ts` 新增三个方法封装 RPC 调用、参数映射和错误转换
- `schema.ts` 新增 `goluckyImportResultSchema`（`.int().min(0)` 收紧为非负整数）
- `types.ts` 新增 `GoluckyFailedItem` / `GoluckyImportResult`；`importGoluckyRefs` 返回类型收紧为 `ActionResult<GoluckyImportResult>`
- `actions.ts` 移除 `createClient` import，三个 Action 改为调用 Repository；`ExternalTrackingError` 直接透传 `err.message` 避免重复业务前缀

**测试：**
- `p0-golucky.test.ts`：32 个新增 `it()`、2 个旧测试删除/替换 → 净增 30 项
- `actions-behavior.test.ts`：新增 7 项行为测试
- 合计净增 37 项测试，替换 2 个旧测试
- in-transit：229/229（4 文件）
- `npm run test`：4012/4013，1 个既有失败：`opt6-production-apply.test.ts` "embeds the canonical migration body byte-for-byte"（绑定 00051 Migration 及 Production apply SQL packet，均未被本任务修改）
- `dry-run.live.test.ts` 被 `npm run test` 明确排除，不计入质量门
- lint --max-warnings 0: 0 errors / 0 warnings
- build pass（保留既有 sync NFT trace warning）
- git diff --check pass

**未做：** 不修改 Migration、OPT-6 SQL packet、sync/server-actions.ts 或其他模块，不执行 Staging/Production 写入。

### Historical: OPT-6 Batch 3 gate (2026-07-22)

### Current gate (2026-07-22)

Staging `00051` remote apply/postcheck has its designated independent `PASS`.
Production `00051` apply/postcheck evidence has been captured and the
SELECT-only postcheck passed. The current independent closing review returned
`PASS`, bound to exact head `96c87461afd444b2065059c98ba0cf08522b749e`, CI
`29908869113`, and Vercel Preview `87HAB8w8rTZhDtJAZCvt2kmaRM31`. The earlier
packet-review head
`f7acf211ac66e2b86a22e14254a1ffe75782c224` authorized the controlled
Production execution only; it is not the closing review result. The Batch 3
`public.product` implementation checkpoint is now active, but all remote
writes and every other policy group remain prohibited until this candidate's
own implementation review returns `PASS`.

### Current implementation checkpoint (2026-07-22)

Batch 3 targets only the pure `public.product` SELECT overlap and adds
forward-only `00052_optimize_product_rls_policy_overlap.sql`. Its static and
PostgreSQL behavior contracts, evidence and navigation are recorded in the
[Batch 3 report](../reports/2026-07-22-opt6-quality-governance-batch-3.md) and
[evidence](../reports/evidence/2026-07-22-opt6-batch3-product-policy.md).
The current exact head is `23d92d3e7ed43013e5dbbe0a828a166a05245cfc`, bound to
CI `30230526963` and Vercel Preview `5F5tvSTDP7A14aCaD217Pxh2yFh3`; both
exact-head checks are green. The earlier `ce7e623ff396f099c3bf9256733973ce158beb9e`
/ `29913122480` / `EeNmUmEaEajq3MnRVe7V3RCTfGph` values are historical
implementation-checkpoint evidence only. The approved Staging SELECT-only packet was attempted once on 2026-07-27 and stopped with PostgreSQL 42P01 because its final SELECT referenced an undefined `role_check` CTE; no write, Migration, or apply packet ran.
The packet and static/PostgreSQL contract were corrected and independently re-approved. The retry returned a hard-stop exact_history_payload=false because the expected CTE used the Production variant for Staging rows 00041-00047; no write, Migration, or apply packet ran. A separate SELECT-only comparison matched the recorded Staging postcheck, so the expected CTE was corrected to the approved Staging baseline and now expects payload digest 8ec295c38bc90f769dc35ca5fd64a500. The corrected packet then ran once read-only with every history, payload, policy, and active-sync gate true. The historical Staging checkpoint was later accepted by final independent evidence review at HEAD e92b8720dbc2be29dc371e5de61c6e70d88beeec; Production apply/postcheck then completed once and passed. This task packet is closed after PR #11 merge; no further Production write, old Migration replay, or later candidate group is allowed.

### Production 00052 SELECT-only preflight execution (2026-07-28)

The Production SELECT-only packet was executed exactly once after implementation-review PASS. All history/version-name/full-payload, public.product, and active-sync gates returned true; actual and expected version/name digests both were 2d6174dce487614c3280456fff9169d0, full-payload digests both were 0b7cba5a88fff139fb0ec65e4deaa142, product policy digest was 119e5878b2ddd6d3f7c1c01e614c4112, and in_progress_sync_runs=0. No write, Migration, or apply packet ran. The designated independent reviewer returned PASS at head 7f83f01c847d685e865d2c4c7c4d8012267ed085, CI 30276563343, and Vercel 4QSHNyh9PDfbnpWMrMeiadV2YBts. See the [Production preflight report](../reports/2026-07-28-opt6-00052-production-preflight.md) and [evidence](../reports/evidence/2026-07-28-opt6-00052-production-preflight.md). No Production write, apply packet, Migration, or Batch 4 is authorized.
### Production 00052 apply and postcheck (2026-07-28)

The reviewed Production apply packet was executed once after the packet review PASS.
The transaction committed and the independent SELECT-only postcheck returned:
52 history rows (`00001..00052`), exact old-history digests, canonical 00052
payload (5786 chars / MD5 `580fd279b2f8d07f6c5a550acc82812a`), four reviewed
`public.product` policies, and `in_progress_sync_runs=0`. See the [apply report](../reports/2026-07-28-opt6-00052-production-apply.md) and [evidence](../reports/evidence/2026-07-28-opt6-00052-production-apply.md). Final post-apply evidence review returned PASS at HEAD e92b8720dbc2be29dc371e5de61c6e70d88beeec; PR #11 merged as f8f467f7fc649dd37d584864e2c79505fd53719e and master deployment completed. Batch 4 remains prohibited pending a separate task packet.

OPT-6-PROGRESSIVE-QUALITY-GOVERNANCE - BATCH 2 REMOTE APPLY/POSTCHECK PASS / BATCH 3 IMPLEMENTATION REVIEW PASS / STAGING SELECT-ONLY REVALIDATION FINAL PASS / PRODUCTION SELECT-ONLY PREFLIGHT FINAL PASS / PRODUCTION APPLY AND POSTCHECK PASS / PR #11 MERGED / PRODUCTION DEPLOYMENT COMPLETE / BATCH 4 PROHIBITED

> The title above is a packet label. The current state is
> `STAGING SELECT-ONLY FINAL PASS / PRODUCTION APPLY/POSTCHECK PASS / PR #11
> MERGED / PRODUCTION DEPLOYMENT COMPLETE`; wait for the user's next
> instruction. No further Production write, old Migration replay, or Batch 4 is
> authorized.

## Handoff from OPT-5

- OPT-5 received designated independent `FINAL PASS`.
- PR #8 is merged to `master`; merge commit: `6c71c3f95bd75389b586c0389e01664a8936d053`.
- Master CI run `29719290873` passed both quality and PostgreSQL jobs.
- OPT-6 branch: `agent/opt-6-progressive-quality-governance`, based on that merge commit.
- OPT-5 evidence remains indexed in the [main report](../reports/2026-07-20-opt5-database-least-privilege.md), [Staging evidence](../reports/evidence/2026-07-20-opt5-staging-postcheck.md), and [Production evidence](../reports/evidence/2026-07-20-opt5-production-postcheck.md).

## User-authorized route and stop gates

The user authorized the existing OPT-6 route to continue without repeating stage-by-stage approval, while preserving the gate:

`implement → complete evidence/quality verification → designated independent review → explicit PASS → next stage`.

CHANGES_REQUIRED means stop and fix only the requested scope. This route does not authorize accidental deletion, direct rollback, old Migration replay, RLS bypass, secret exposure, or materially different architecture.

## Batch 1 result (2026-07-20)

- `npm run lint -- --max-warnings 0`: 0 warnings / 0 errors after removing the 31 unused symbols; CI budget is now `--max-warnings 0`.
- 00050 rewrites exactly six reviewed auth init-plan policies. Its pre/post
  catalog gate is exact for command, roles, PERMISSIVE state, and complete
  `USING`/`WITH CHECK`; isolated PostgreSQL tests cover identity plus own/cross
  INSERT and DELETE behavior and reject role/predicate/PERMISSIVE drift.
- `next.config.ts` pins Turbopack root to `__dirname`; the workspace-root warning is gone. The remaining sync NFT trace is a documented residual.
- Historical checkpoints: Draft PR #9 head `4110a65` / CI `29730301451`, then
  remediation code head `1106edc` / CI `29732371606`; both were green.
- Designated independent review returned `OPT-6 BATCH 1 FINAL PASS` for final
  head `d2eef9cbf09d35de3e0ab01bd2f84991ad59cb51`; CI `29732535403` and Vercel
  Preview `BqS7bgtX77Y9wD9t8LUkvgtf9M9W` are green. The next controlled stage is
  remote 00050 apply/postcheck; Batch 2 remains prohibited until that stage is
  separately evidenced and reviewed.
- PR #9 was merged as `d9acf51e0cfbfd2e21f243f41273de7278f4e80a`;
  master CI `29733960202` and production deployment
  `BKDzcK4k9noxQgzAboJB6h2XjmeF` passed. The controlled remote stage then
  applied 00050 to Staging and Production. Both are now exact `00001`–00050`,
  with the canonical one-statement 00050 body and six reviewed optimized
policies. See [remote postcheck evidence](../reports/evidence/2026-07-20-opt6-00050-remote-postcheck.md).
- The documentation-only evidence checkpoint was PR #10 head
  `5c80755f25a48496427e59aaa9635027dd989768`; exact-head CI `29739465796` and
  Vercel Preview `sBfgQG7cstb2n5YZkv1w2mvQgEGM` passed. Any later
  documentation head must bind its own exact CI/Vercel result before review.
- The final evidence head `1fbc6b042caf289698d60d2697a909787002968d`
  passed CI `29739720283` and Vercel Preview
  `obXa1wmkxzMorYz9k8AmpkhBSZmG`. The designated review task independently
  confirmed both remote projects and returned `OPT-6 BATCH 1 REMOTE FINAL
  PASS`. PR #10 was merged as `2510b0e070b7fe637239cf0a8eecc3e63aec9570`.
  Batch 1 is closed; this packet is the separately reviewable Batch 2 role
  policy-overlap candidate.
- OPT-6 policy targets from the reviewed roadmap: 6 `auth_rls_initplan`, 115 `multiple_permissive_policies`, and unused-index findings that must not be bulk-deleted from one Advisor snapshot.
- Turbopack workspace-root misdetection is fixed by `turbopack.root = __dirname`; one NFT trace warning remains because the sync route intentionally uses the project-root runtime path. No further path rewrite is allowed without proving runtime equivalence.
- `npm audit --omit=dev` has 2 moderate PostCSS advisories with no available fix; do not claim audit zero or force an unsafe override.

## Implementation order

1. ✓ Create this isolated branch and record the OPT-5 handoff.
2. ✓ Re-run lint and collect a machine-readable warning inventory; fix unused symbols in small test-backed batches until warning count is zero.
3. ✓ Batch 1: capture the reviewed policy targets, rewrite only six `auth.uid()` init expressions to equivalent scalar subqueries, and prove anonymous, disabled, Admin, Operator, and cross-warehouse behavior unchanged. See [Batch 1 report](../reports/2026-07-20-opt6-quality-governance-batch-1.md).
4. Inventory multiple-permissive policies by table/command/role. The local
   `00001`–00050` replay catalog has 42 policies and 23 concrete overlap
   groups. Batch 2 changes only `public.role`: `00051` proves the Admin OR
   Operator SELECT union and preserves Admin write checks as separate policies.
   The remaining 22 groups stay unchanged until separately proven. Never edit
   00001–0050.
5. Investigate the Turbopack trace warning and dependency residuals without changing runtime artifact paths, cron schedules, secrets, or provider behavior.
6. Run full local tests, lint budget 0, TypeScript/build, PostgreSQL concurrency/contracts, migration replay, `git diff --check`, links, secret/orphan checks, and available Staging/Production postchecks.
7. Record every batch in `docs/reports/` and indexes, then send it to the
   designated review task. Batch 2 must receive explicit PASS before any
   Staging preflight/apply is prepared; Production and all remaining groups
   remain prohibited.

## Batch 2 review result (2026-07-21)

- The designated review task returned `OPT-6 Batch 2 FINAL PASS` for head
  `3885651309ac37f2bf5dd48ce905dfdfe6da8886`. It independently confirmed the
  forward-only `00051` catalog gates, the four-identity CRUD matrix, drift
  rejection before policy removal, documentation navigation, and clean scope.
- Exact-head CI `29798631677` passed the quality and PostgreSQL jobs; the
  associated Vercel Preview and Preview Comments checks are green. Draft PR
  #11 remains open and mergeable.
- At this code-review checkpoint `00051` had not been written to either remote
  environment. Subsequent Staging and Production apply/postcheck results are
  recorded below; this historical checkpoint did not authorize a further
  policy-overlap candidate or PR #11 merge.
- Staging read-only preflight subsequently passed: exact `00001`–00050`, no
  `00051`, and the full `public.role` two-policy catalog all match the
  reviewed baseline. See [preflight evidence](../reports/evidence/2026-07-21-opt6-00051-staging-preflight.md).
  The designated review task returned `PASS` for this preflight evidence. It
  permits preparation, not execution, of the Staging apply/postcheck packet;
  that atomic write packet needs its own review before any remote write.

## Batch 2 Staging remote result (2026-07-21)

- After the designated review returned `PASS` for the atomic packet, the exact
  generated SQL was executed in Staging project `hyarhvsjhkjpallbyifn` as
  role `postgres`. The SQL Editor returned `Success. No rows returned`.
- A separate SELECT-only postcheck returned one row with all nine checks
  `true`: exact 00001–0051 history, unique version/name sets, no timestamp
  versions, exact 00051 body payload, four policies, and exact normalized
  policy catalog. See [Staging apply/postcheck evidence](../reports/evidence/2026-07-21-opt6-00051-staging-preflight.md).
- This is the historical Staging-only remote evidence. The designated independent review
  returned `PASS` on 2026-07-21, bound to documentation head
  `2905b5bfa54ab8a8cebe6ce746186495231af9fe`, CI `29822891836`, and the green
  Vercel Preview. The later Production apply/postcheck is recorded in the
  Production evidence below; Batch 3 and the remaining policy groups remain
  prohibited.

## Production gate preparation (2026-07-21)

- The SELECT-only Production `00051` exact preflight packet is prepared and
  indexed in the [preflight evidence](../reports/evidence/2026-07-21-opt6-00051-production-preflight.md)
  and [SQL packet](../reports/sql/2026-07-21-opt6-00051-production-preflight.sql).
- Its `expected_history` CTE pins all reviewed `00001`–00050` version/name and
  full `statements[]` payload summaries; `exact_version_name_history` and
  `exact_history_payload` are executable row-by-row equality gates, with the
  static read-only contract indexed here:
  [preflight contract](../../src/features/database/opt6-production-preflight.test.ts).
- The packet was executed read-only on 2026-07-22 and all history, full-payload,
  role-catalog, and active-run gates passed. The separately reviewed Production
  apply packet then committed in the approved window; its [apply/postcheck
  evidence](../reports/evidence/2026-07-22-opt6-00051-production-apply.md) and
  [SQL packet](../reports/sql/2026-07-21-opt6-00051-production-apply.sql) record
  exact 00001–0051 history, the canonical payload, four role policies, and
  zero active sync runs. Batch 3 remains a separate implementation/review gate.

## Current prohibitions

- No changes to 00001–0049; all database changes must be 00050+ forward-only and replayable.
- No policy merge without a before/after identity matrix and exact OR/WITH CHECK equivalence evidence.
- No index deletion from a single Advisor snapshot; require a production statistics window and separate approval boundary.
- No Auth platform setting write unless a controlled connector exists and login regression evidence is available.
- Do not touch user synchronization scripts, `.claude` state, or project-summary files.
- Do not execute a remote preflight/apply packet, write Staging/Production, or
  start another candidate. The implementation review `PASS` permits only
  preparation of the controlled Staging SELECT-only preflight.
