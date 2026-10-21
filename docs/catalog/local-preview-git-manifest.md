# 本地真实商品预览包 — Git 三份清单（R6 / F5）

状态：**R5 功能问题已独立关闭**；**交付收尾（VM 门禁 + 短程证据 + 文档）待复核**。积压五 commit 已推送 `codex/ice-v4-planning`；§4.1 记录实际 SHA；§4.2 为本次测试/文档增量。

盘点时点：2026-10-21（R5 closeout）。§1 为已入库路径索引；不再使用「拟提交/已暂存」旧说法。

---

## 1. 拟提交（源码 / SQL / 脚本 / 测试 / 配置 / 必要文档）

### 1.1 横切与 P0-02 辅助（已分散在 §4.1 各 commit）

- `.gitignore` → **acb4865**
- `package.json`（catalog npm scripts）→ **acb4865**（**不在** c3e1cb1）
- `scripts/p0-02/postgres-process.mjs` → **acb4865**
- `scripts/p0-02/process-identity.mjs` → **c3e1cb1**
- `src/app/auth/login/page.tsx`、`src/app/dashboard/_components/sidebar-nav.tsx` → **acb4865**
- `AGENTS.md`、`docs/current-state.md`、`docs/tasks/current-task.md`、delivery/manifest → **c3e1cb1** 与本次 §4.2 增量

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
- `scripts/catalog/preview-control-flow-vm-probes.mjs`（§4.2）
- `scripts/catalog/run-preview-start-control-flow-probe.mjs`（§4.2：spawn VM 探针，无硬编码 pass）
- `scripts/catalog/run-preview-r5-short-verify.mjs`（§4.2：短程证据编排，仅本地运行）
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

## 3. 取消跟踪但保留本地（已在 d6cbeee 提交）

| 路径 | 原因 |
|---|---|
| `.claude/context-status.json` | Claude 会话状态生成物，非源码 |
| `tools/bigseller-scraper/sync/__pycache__/__init__.cpython-313.pyc` | Python 字节码 |
| `tools/bigseller-scraper/sync/__pycache__/config.cpython-313.pyc` | Python 字节码 |
| `tools/bigseller-scraper/sync/__pycache__/plan_generator.cpython-313.pyc` | Python 字节码 |

本地文件仍在磁盘；提交时随 `.gitignore` 更新一并纳入「清理跟踪」commit。

---

## 4. Git 记录

### 4.1 已推送（2026-10-21，`origin/codex/ice-v4-planning`）

| SHA | 摘要 | 主要内容 |
|---|---|---|
| **d6cbeee** | feat(p0-03): matching tools + PASS docs | `tools/p0_03_match/**`、`scripts/p0-03/**`、`docs/p0-03/**`（无原始 Excel）、`docs/product-identity-standard-v1.md`、`docs/tasks/p0-03/**`；§3 取消跟踪 |
| **69144f3** | feat(catalog): SQL + features + tests | `db/catalog/**`、`src/features/catalog/**`、dashboard/API、`tests/catalog/**`、playwright/vitest catalog 配置、verification 报告 |
| **3fdec98** | feat(catalog): prepare/postgres runners | `scripts/catalog/prepare*.mjs`、`run-*-check/postgres/browser`（**不含** start/stop/ownership） |
| **acb4865** | chore: gitignore + **package.json** + UI | `.gitignore`、`package.json`、`postgres-process.mjs`、login/sidebar |
| **c3e1cb1** | fix(catalog-preview): R5 ownership impl | 启停/ownership/launcher/workspace、R5 探针（初版）、`process-identity.mjs`、delivery/manifest/治理文档 |

远端 HEAD：**4e5c01d**（与本地一致；closeout 功能提交 **9a8acb2**，其后 manifest HEAD 修正 **4e5c01d**）。

### 4.2 已推送 — **9a8acb2**（R5 交付收尾：测试门禁 + 文档）

- `scripts/catalog/preview-control-flow-vm-probes.mjs`
- `scripts/catalog/run-preview-start-control-flow-probe.mjs`（spawn VM；start 4 + stop 5 场景，失败非零退出）
- `scripts/catalog/run-preview-r5-short-verify.mjs`（本地短程编排，证据不入库）
- 治理文档：`delivery-index`、本 manifest、`AGENTS.md`、`current-state.md`、`current-task.md`

短程原始证据 **不入库**：`.local/catalog/run-20261021T075139Z-821214d2/evidence/r5-short-verify-2026-10-21T08-24-27-634Z-4ec9e4/`（索引 `r5-short-verify-index.json` 于 run 根）。

不 merge、不 deploy。
