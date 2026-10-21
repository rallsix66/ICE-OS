# 本地真实商品预览包 — Git 三份清单（R6 / F5）

状态：**R5 启停补修自验完成，待第五轮独审**；P0-03 / 商品首包 / N1A / N1C 等已验收积压 **可** 按 §4 推送；预览启停最后一 commit 单独标注待审。

盘点时点：2026-10-21（R3）。含商品首包、N1A/N1C、P0-03、本地预览 009–012 及 R3 启停/覆盖/自验脚本与测试。

---

## 1. 拟提交（源码 / SQL / 脚本 / 测试 / 配置 / 必要文档）

### 1.1 已跟踪且已有工作区修改（`git diff --name-only`）

- `.gitignore`
- `AGENTS.md`
- `docs/current-state.md`
- `docs/tasks/current-task.md`
- `package.json`
- `scripts/p0-02/postgres-process.mjs`（catalog/postgres 无窗启动复用）
- `scripts/p0-02/process-identity.mjs`（WMI 命令行与进程创建时间；预览严格归属依赖）
- `src/app/auth/login/page.tsx`（登录后跳转 `NEXT_PUBLIC_ICE_POST_LOGIN_PATH`）
- `src/app/dashboard/_components/sidebar-nav.tsx`

### 1.2 商品首包 — SQL（`db/catalog/`）

- `db/catalog/001_catalog.sql`
- `db/catalog/002_catalog_security.sql`
- `db/catalog/003_source_identity.sql`
- `db/catalog/004_source_identity_security.sql`
- `db/catalog/007_new_item_intake.sql`
- `db/catalog/008_new_item_intake_security.sql`
- `db/catalog/009_local_display.sql`
- `db/catalog/010_local_display_security.sql`
- `db/catalog/011_local_display_read_rpc.sql`
- `db/catalog/012_local_display_table_rls.sql`

### 1.3 商品首包 / N1A / N1C / 本地预览 — 应用与 API

- `src/instrumentation.ts`（已撤回 `CATALOG_LOCAL_PREVIEW` 隔离豁免；若与 HEAD 一致则本批无 diff）
- `src/features/catalog/actions.ts`
- `src/features/catalog/authorization.ts`
- `src/features/catalog/candidate-service.ts`
- `src/features/catalog/evidence-store.ts`
- `src/features/catalog/identity-contract.ts`
- `src/features/catalog/repository.ts`
- `src/features/catalog/schema.ts`
- `src/features/catalog/service.ts`
- `src/features/catalog/types.ts`
- `src/features/catalog/components/catalog-admin-panel.tsx`
- `src/features/catalog/components/catalog-bs-sample-panel.tsx`
- `src/features/catalog/components/catalog-detail.tsx`
- `src/features/catalog/components/catalog-table.tsx`
- `src/features/catalog/components/new-item-intake.tsx`
- `src/features/catalog/components/source-identity-panel.tsx`
- `src/features/catalog/local-display/adopted-price.ts`
- `src/features/catalog/local-display/client-scope.ts`
- `src/features/catalog/local-display/decimal.ts`
- `src/features/catalog/local-display/display-types.ts`
- `src/features/catalog/local-display/service.ts`
- `src/features/catalog/local-display/warehouse-valuation.ts`
- `src/features/catalog/new-item/actions.ts`
- `src/features/catalog/new-item/authorization.ts`
- `src/features/catalog/new-item/field-projection.ts`
- `src/features/catalog/new-item/fixture-adapter.ts`
- `src/features/catalog/new-item/repository.ts`
- `src/features/catalog/new-item/schema.ts`
- `src/features/catalog/new-item/service.ts`
- `src/features/catalog/new-item/types.ts`
- `src/features/catalog/source-identity/actions.ts`
- `src/features/catalog/source-identity/authorization.ts`
- `src/features/catalog/source-identity/fixture-adapter.ts`
- `src/features/catalog/source-identity/key-codec.ts`
- `src/features/catalog/source-identity/repository.ts`
- `src/features/catalog/source-identity/schema.ts`
- `src/features/catalog/source-identity/service.ts`
- `src/features/catalog/source-identity/types.ts`
- `src/features/catalog/sources/baseline-adapter.ts`
- `src/features/catalog/sources/bs-sample-inventory-adapter.ts`
- `src/features/catalog/sources/frozen-feishu-adapter.ts`
- `src/app/api/catalog/evidence/[artifactId]/route.ts`
- `src/app/api/catalog/product-evidence/[evidenceId]/route.ts`
- `src/app/api/catalog/source-evidence/[evidenceId]/route.ts`
- `src/app/dashboard/catalog/page.tsx`
- `src/app/dashboard/catalog/[id]/page.tsx`
- `src/app/dashboard/catalog/admin/page.tsx`
- `src/app/dashboard/catalog/intake/page.tsx`
- `src/app/dashboard/catalog/sources/page.tsx`

### 1.4 脚本 — catalog

- `scripts/catalog/prepare.mjs`
- `scripts/catalog/prepare-local-preview.mjs`
- `scripts/catalog/prepare-new-item.mjs`
- `scripts/catalog/prepare-source-identity.mjs`
- `scripts/catalog/ensure-preview-workspace.mjs`
- `scripts/catalog/extract-bs-sample-inventory.py`
- `scripts/catalog/start-catalog-postgres.mjs`
- `scripts/catalog/stop-catalog-postgres.mjs`
- `scripts/catalog/list-catalog-postgres.mjs`
- `scripts/catalog/start-local-preview.mjs`
- `scripts/catalog/stop-local-preview.mjs`
- `scripts/catalog/status-local-preview.mjs`
- `scripts/catalog/stop-all-local-catalog.mjs`
- `scripts/catalog/preview-process-ownership.mjs`
- `scripts/catalog/catalog-next-preview-dev.mjs`
- `scripts/catalog/run-preview-ownership-negative.mjs`
- `scripts/catalog/run-preview-ownership-probes.mjs`
- `scripts/catalog/run-preview-start-workspace-guard.mjs`
- `scripts/catalog/preview-start-prior-action.mjs`
- `scripts/catalog/run-preview-start-control-flow-probe.mjs`
- `scripts/catalog/run-preview-double-start.mjs`
- `scripts/catalog/run-check.mjs`
- `scripts/catalog/run-postgres-tests.mjs`
- `scripts/catalog/run-browser-tests.mjs`
- `scripts/catalog/run-local-preview-self-verify.mjs`
- `scripts/catalog/run-new-item-check.mjs`
- `scripts/catalog/run-new-item-postgres.mjs`
- `scripts/catalog/run-new-item-browser.mjs`
- `scripts/catalog/run-source-identity-check.mjs`
- `scripts/catalog/run-source-identity-postgres-tests.mjs`
- `scripts/catalog/run-source-identity-browser-tests.mjs`

### 1.5 脚本与工具 — P0-03

- `scripts/p0-03/audit-product-coverage.py`
- `scripts/p0-03/common.mjs`
- `scripts/p0-03/coverage_image_evidence.py`
- `scripts/p0-03/run-check.mjs`
- `scripts/p0-03/run-match.mjs`
- `scripts/p0-03/test-coverage-image-evidence.py`
- `scripts/p0-03/verify-confirmations-browser.mjs`
- `scripts/p0-03/verify-confirmations-evidence.py`
- `scripts/p0-03/verify-confirmations-negative.py`
- `scripts/p0-03/verify-curation-browser.mjs`
- `scripts/p0-03/verify-curation-evidence.py`
- `scripts/p0-03/verify-curation-negative.py`
- `scripts/p0-03/verify-final-acceptance.py`
- `scripts/p0-03/verify-final-acceptance-browser.mjs`
- `scripts/p0-03/verify-final-acceptance-negative.py`
- `scripts/p0-03/verify-jst-confirmations.py`
- `scripts/p0-03/verify-jst-confirmations-browser.mjs`
- `scripts/p0-03/verify-jst-confirmations-negative.py`
- `scripts/p0-03/verify-product-coverage.py`
- `scripts/p0-03/verify-review-browser.mjs`
- `scripts/p0-03/verify-review-evidence.py`
- `scripts/p0-03/verify-review-r2.py`
- `tools/p0_03_match/__init__.py`
- `tools/p0_03_match/__main__.py`
- `tools/p0_03_match/apply_review.py`
- `tools/p0_03_match/auto_clean_review.py`
- `tools/p0_03_match/bigseller_centric.py`
- `tools/p0_03_match/bigseller_sku_aliases.py`
- `tools/p0_03_match/business_confirmations.py`
- `tools/p0_03_match/cli.py`
- `tools/p0_03_match/config.py`
- `tools/p0_03_match/export.py`
- `tools/p0_03_match/export_bigseller_gap.py`
- `tools/p0_03_match/export_bs_unmatched_status.py`
- `tools/p0_03_match/export_bs_warehouse_overview.py`
- `tools/p0_03_match/export_html.py`
- `tools/p0_03_match/export_jushuitan.py`
- `tools/p0_03_match/export_market_pairs.py`
- `tools/p0_03_match/export_master_centric.py`
- `tools/p0_03_match/export_matched_total.py`
- `tools/p0_03_match/export_name_report.py`
- `tools/p0_03_match/export_priority.py`
- `tools/p0_03_match/export_review_outcome.py`
- `tools/p0_03_match/final_decisions.py`
- `tools/p0_03_match/html_databases.py`
- `tools/p0_03_match/jst_confirmations.py`
- `tools/p0_03_match/jushuitan_centric.py`
- `tools/p0_03_match/jushuitan_master_keys.py`
- `tools/p0_03_match/loaders.py`
- `tools/p0_03_match/manual_unified.py`
- `tools/p0_03_match/market_disambiguation.py`
- `tools/p0_03_match/master_centric.py`
- `tools/p0_03_match/master_quality.py`
- `tools/p0_03_match/match_engine.py`
- `tools/p0_03_match/match_policy.py`
- `tools/p0_03_match/models.py`
- `tools/p0_03_match/name_review.py`
- `tools/p0_03_match/normalize.py`
- `tools/p0_03_match/priority_review.py`
- `tools/p0_03_match/requirements.txt`
- `tools/p0_03_match/review_exports.py`
- `tools/p0_03_match/review_result.py`
- `tools/p0_03_match/sample_curation.py`
- `tools/p0_03_match/table_catalog.py`
- `tools/p0_03_match/unified_view.py`
- `tools/p0_03_match/tests/test_apply_review.py`
- `tools/p0_03_match/tests/test_auto_clean_review.py`
- `tools/p0_03_match/tests/test_bigseller_sku_aliases.py`
- `tools/p0_03_match/tests/test_bs_warehouse_overview.py`
- `tools/p0_03_match/tests/test_business_confirmations.py`
- `tools/p0_03_match/tests/test_final_decisions.py`
- `tools/p0_03_match/tests/test_html_databases.py`
- `tools/p0_03_match/tests/test_jst_confirmations.py`
- `tools/p0_03_match/tests/test_jushuitan_master_keys.py`
- `tools/p0_03_match/tests/test_loaders_merge.py`
- `tools/p0_03_match/tests/test_manual_unified.py`
- `tools/p0_03_match/tests/test_market_disambiguation.py`
- `tools/p0_03_match/tests/test_master_centric.py`
- `tools/p0_03_match/tests/test_match_engine.py`
- `tools/p0_03_match/tests/test_match_policy.py`
- `tools/p0_03_match/tests/test_name_review.py`
- `tools/p0_03_match/tests/test_normalize.py`
- `tools/p0_03_match/tests/test_priority_review.py`
- `tools/p0_03_match/tests/test_review_r2.py`
- `tools/p0_03_match/tests/test_review_regressions.py`
- `tools/p0_03_match/tests/test_sample_curation.py`
- `tools/p0_03_match/tests/test_unified_view.py`
- `tools/p0_03_match/tests/test_workbench_queue.py`

### 1.6 测试与配置

- `vitest.config.catalog.mts`
- `vitest.config.catalog-new-item.mts`
- `vitest.config.catalog-source-identity.mts`
- `playwright.config.catalog.ts`
- `playwright.config.catalog-new-item.ts`
- `playwright.config.catalog-source-identity.ts`
- `tests/catalog/baseline-and-domain.test.ts`
- `tests/catalog/catalog.postgres.test.ts`
- `tests/catalog/catalog.browser.pw.ts`
- `tests/catalog/local-preview-seed.postgres.test.ts`
- `tests/catalog/local-preview-display.postgres.test.ts`
- `tests/catalog/local-preview-workspace.test.ts`
- `tests/catalog/local-preview.browser.pw.ts`
- `tests/catalog/local-preview-snapshot.postgres.test.ts`
- `tests/catalog/client-scope-warehouse.postgres.test.ts`
- `tests/catalog/local-preview-seed-helper.ts`
- `tests/catalog/warehouse-valuation.test.ts`
- `tests/catalog/new-item.test.ts`
- `tests/catalog/new-item.postgres.test.ts`
- `tests/catalog/new-item.browser.pw.ts`
- `tests/catalog/source-identity.test.ts`
- `tests/catalog/source-identity.postgres.test.ts`
- `tests/catalog/source-identity.browser.pw.ts`
- `tests/catalog/fixtures/new-item-bootstrap.json`
- `tests/catalog/fixtures/new-item-fixture-manifest.json`
- `tests/catalog/fixtures/new-item-scope-a.json`
- `tests/catalog/fixtures/new-item-scope-b.json`
- `tests/catalog/fixtures/new-item-scope-unresolved.json`
- `tests/catalog/fixtures/source-identity/products-v1.json`
- `tests/catalog/fixtures/source-identity/products-reordered-v2.json`
- `tests/catalog/fixtures/source-identity/products-conflicts-v3.json`
- `tests/catalog/fixtures/source-identity/scope-grants.fixture.json`

### 1.7 文档与契约（必要部分；原始 Excel 见 §2）

- `docs/product-identity-standard-v1.md`
- `docs/catalog/local-preview-delivery-index.md`
- `docs/catalog/local-preview-git-manifest.md`（本文件）
- `docs/catalog/local-sample-valuation-basis-20261021.json`
- `docs/catalog/verification-report-run-20261020T081620Z-2a2cc8e4.md`
- `docs/catalog/verification-report-repair-20261020T092115Z-2b8397ed.md`
- `docs/catalog/verification-report-source-identity-delivery-20261020T105042Z-97d20098.md`
- `docs/catalog/verification-report-source-identity-repair-20261020T120334Z-fec7b094.md`
- `docs/catalog/verification-report-source-identity-residual-20261020T124340Z-c4142a46.md`
- `docs/p0-03/README.md`
- `docs/p0-03/business-confirmations-20261019.json`
- `docs/p0-03/curation-decisions-20261019.json`
- `docs/p0-03/final-decisions-20261020.json`
- `docs/p0-03/jst-confirmations-20261020.json`
- `docs/p0-03/verification-report-p0-03-delivery-20261015.md`
- `docs/p0-03/verification-report-p0-03-curation-20261019.md`
- `docs/p0-03/verification-report-p0-03-confirmations-20261019.md`
- `docs/p0-03/verification-report-p0-03-identity-coverage-20261019.md`
- `docs/p0-03/verification-report-p0-03-review-r2-20261019.md`
- `docs/p0-03/verification-report-p0-03-rework-20261019.md`
- `docs/p0-03/verification-report-p0-03-coverage-audit-repair-20261020.md`
- `docs/p0-03/verification-report-p0-03-jst-confirmations-20261020.md`
- `docs/p0-03/verification-report-p0-03-final-acceptance-20261020.md`
- `docs/tasks/p0-03/2026-10-15-sample-matching.md`
- `docs/tasks/p0-03/2026-10-19-curation.md`
- `docs/tasks/p0-03/2026-10-19-four-confirmations.md`
- `docs/tasks/p0-03/2026-10-19-minimal-rework.md`
- `docs/tasks/p0-03/2026-10-19-product-identity-coverage.md`
- `docs/tasks/p0-03/2026-10-19-review-r2.md`
- `docs/tasks/p0-03/2026-10-20-coverage-audit-repair.md`
- `docs/tasks/p0-03/2026-10-20-final-acceptance.md`
- `docs/tasks/p0-03/2026-10-20-jst-confirmations.md`
- `docs/current-state.md`
- `docs/tasks/current-task.md`
- `AGENTS.md`

---

## 2. 仅本地保留 / 按内容忽略（勿 `git add`）

- `.local/**`（catalog/p0-03/p0-02/p0-01 实例、pgdata、`env.catalog.json`、`login.local-preview.txt`、证据、workspace 快照、独审报告）
- `.local/product-library-discovery/`（242 文件，R3 已 ignore；2026-10-21 `git ls-files --others` 对该路径 0 条）
- `.local/desktop-cleanup/`（9 文件，已 ignore）
- `.local/preview-*/`（含 `preview-20261020-140128/` 2 日志，已 ignore）
- `docs/p0-03/` 下原始业务 Excel/CSV、HOLD、冻结 xlsx 副本（若存在且未在 §1 列出）
- 任意 `*.log`、凭据、`.env.local` 数据库连接串、私有 evidence 包
- `**/__pycache__/**`、`**/*.pyc`（生成物，不应入库）
- Playwright 输出：`.local/catalog/**/browser/output/**`

`.gitignore` 已含 `.local/catalog/` 等；**禁止** `git add .`。

---

## 3. 取消跟踪但保留本地（已暂存 `git rm --cached`）

| 路径 | 原因 |
|---|---|
| `.claude/context-status.json` | Claude 会话状态生成物，非源码 |
| `tools/bigseller-scraper/sync/__pycache__/__init__.cpython-313.pyc` | Python 字节码 |
| `tools/bigseller-scraper/sync/__pycache__/config.cpython-313.pyc` | Python 字节码 |
| `tools/bigseller-scraper/sync/__pycache__/plan_generator.cpython-313.pyc` | Python 字节码 |

本地文件仍在磁盘；提交时随 `.gitignore` 更新一并纳入「清理跟踪」commit。

---

## 4. 分批 commit 方案（→ `codex/ice-v4-planning`）

预览启停（§1.4 中 start/stop/ownership 与 R5 探针）建议 **单独最后一 commit**，正文注明 **R5 待独审**；其余 §1 已验收块可先行推送。

1. **P0-03 工具与文档**：`tools/p0_03_match/**`、`scripts/p0-03/**`、`docs/p0-03/**`（不含原始 Excel）、`docs/product-identity-standard-v1.md`、`docs/tasks/p0-03/**`
2. **商品首包 SQL + 核心 catalog**：`db/catalog/001–008`、`src/features/catalog`（不含 local-display/new-item/source-identity 子包若需拆分则并入 3/4）、`tests/catalog/baseline*.`、`catalog.postgres/browser`
3. **N1A 来源身份**：`003–004` 已在 2；`source-identity/**` 源码与测试、对应 verification 报告
4. **N1C 新品**：`007–008`、 `new-item/**` 与测试
5. **本地预览 009–012 + 展示**：`local-display/**`、预览脚本、011/012、`instrumentation`、dashboard catalog 页、local-preview 测试
6. **横切**：`.gitignore`、`package.json`、`postgres-process.mjs`、login/sidebar、`AGENTS.md`、`current-state`、`current-task`、delivery/manifest
7. **取消跟踪生成物**：§3 四项 + `.gitignore` 规则确认

不合并、不部署；推送前再次 `git diff --check` 与 staging 区无凭据/数据库文件。
