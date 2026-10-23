# 商品库 Demo 界面复用与访问性能包 — 交付索引

状态：**`U3_LOCAL_UX_PERF_PASS` — 独立复审通过（2026-10-23）**；文档登记与分批提交完成，未 merge/deploy。继承 **`LOCAL_PREVIEW_PASS`**（原范围不变）。BUILD 未变（`Jq2Y6jz_l7sFTKfSUPYkF`），未重建/未启停 3011。历史轮次报告与结论原样保留，不改写。

## U3 最终独立复审（2026-10-23，现役结论）

- 独立报告：[independent-ux-perf-u3-final-20261023/independent-review.md](../../.local/catalog/independent-ux-perf-u3-final-20261023/independent-review.md) → **`U3_LOCAL_UX_PERF_PASS`**，三项剩余问题关闭，无阻塞性补修项
- 通过范围：本地样表商品库交互、缓存恢复、性能测量与验收门禁；**不代表**新 UI 完成、真实来源接入、生产发布或全 ICEOS 验收
- 执行摘要：[ux-perf-u3-20261022/progress9-delivery-summary.md](../../.local/catalog/ux-perf-u3-20261022/progress9-delivery-summary.md)；证据索引：[ux-perf-u3-20261022/evidence-index.md](../../.local/catalog/ux-perf-u3-20261022/evidence-index.md)
- 独立重跑：合并器 51 项正负向 + 26 项冷门禁边界；runner 11 项测试 + 6 项真实边界；实际 tsc；19 项单测；eslint；diff-check；冻结原始数据复算；编译凭据/漂移；只读进程归属
- 证据分层：loader cache 7 + recovery 5、oracle 校准 3/3、内容判定 25/25 沿用同审查方上一轮独立结果；完整 Playwright 17/17、暖 15×20、3 次冷进程、staging build/promote、126×252 候选等价为执行日志核验/继承，未重新采样

## U3 progress9（2026-10-23，已并入上节结论）

- 独审输入：[independent-ux-perf-u3-progress9-20261023/review-notes.md](../../.local/catalog/independent-ux-perf-u3-progress9-20261023/review-notes.md)（仅剩 R1 冷门禁、R2 runner 完成数/只读证据）
- 执行摘要：[ux-perf-u3-20261022/progress9-delivery-summary.md](../../.local/catalog/ux-perf-u3-20261022/progress9-delivery-summary.md)
- 证据索引：[ux-perf-u3-20261022/evidence-index.md](../../.local/catalog/ux-perf-u3-20261022/evidence-index.md)
- 串行自验：`ux-perf-u3-20261022/runs/progress9-verify-20261023-final/selfverify-steps.json`（8/8 exit 0，顺序 runner → 合并负向 → 复核 → tsc → 单测 → lint → diff）
- 冷门禁复核（新文件，不改原证据）：`ux-perf-u3-20261022/runs/progress8-final5-recheck-20261023/merge-recheck.json` → `allRequired=true`
- Runner：真实 spawn 边界 **11/11**（新增 completed/readOnlyEvidence 三项拒绝）
- 类型：当前商品库 **0 条**诊断；历史 BEST 测试 **5 条**另列（`external-healthcheck-audit-20261023/progress9/tsc-catalog-check.json`）
- 边界：未改应用源码，未重跑暖 15×20 / 冷 3 次 / 126 项 PG 等价

## U3 progress8（历史）

- 独审输入：[independent-ux-perf-u3-progress8-20261023/review-notes.md](../../.local/catalog/independent-ux-perf-u3-progress8-20261023/review-notes.md)（CHANGES_REQUIRED 三组）
- 摘要：`ux-perf-u3-20261022/progress8-delivery-summary.md`；串行自验 `runs/progress8-final5/selfverify-steps.json`（9/9）
- 其 `allRequired=true` 由旧冷门禁给出，progress9 已用严格门禁复核并保留原证据
- BUILD `Jq2Y6jz_l7sFTKfSUPYkF` / snapshot `3f08ab21…`（staging build → promote → 核对）；预览包 Playwright **17/17**（含恢复 5、loader cache 7）
- 启动脚本提示：`CATALOG_PREVIEW_PORT=3011` 必须经环境变量传入（`--port` 参数不被读取）

## U3 progress7（历史）

- 独审：[independent-ux-perf-u3-progress7-20261023/review-notes.md](../../.local/catalog/independent-ux-perf-u3-progress7-20261023/review-notes.md)（CHANGES_REQUIRED）
- 摘要：`ux-perf-u3-20261022/progress7-delivery-summary.md`；当时的 `allRequired=true` **不能作为通过依据**（计时起点在 DOMContentLoaded 重开、首开前等 audit-ready、负向捕获初始化异常、sourceHashes 回填）
- 旧 BUILD `3iTQd38mCGB0EOYOHd-J8`；旧暖/冷 run 保留不删

## U3 补修（2026-10-22 起点）

- 有效性能脚本：`perf-content-ready-u3.mjs`（v2 计时 + 逐样本分段）· 合并：`merge-perf-json-u3.mjs`
- 旧矩阵降级：`ux-perf-r3-fix-20261022/perf-content-ready-r3.json`（终点断言无效）

## U2 补修（2026-10-22，已被 U3 接替）

- 独审输入：[independent-ux-perf-r2-20261022/independent-review.md](../../.local/catalog/independent-ux-perf-r2-20261022/independent-review.md)（CHANGES_REQUIRED）
- 执行摘要：[ux-perf-r3-fix-20261022/delivery-summary.md](../../.local/catalog/ux-perf-r3-fix-20261022/delivery-summary.md)

## R1–R6 历史（2026-10-22，继承）

- [ux-perf-r2-fix-20261022/delivery-summary.md](../../.local/catalog/ux-perf-r2-fix-20261022/delivery-summary.md)
- 候选等价：`candidate-equivalence.json`（0 差异组；现行继承 `attempts/progress5-20261022-180727`）
- 性能（暖操作，已被 r3 取代为参考）：`perf-content-ready-r2.json`

## 范围（封存 + R4 继承）

- **Legacy 封存**：仓库 `archive/legacy-business-20261022/` 仅清单/指针/说明（`manifest.json`、`EXTERNAL-POINTER.json`、路由白名单、旧入口处置表、`RESTORE.md`）；完整源码外置 `D:/try one/ICEOS-legacy-archive/20261022/`；构建/测试/ts 排除 `archive/**`。
- **现役**：商品库 / 持续新品 / 来源核实 / 管理审计；`/dashboard` → 商品库；旧 URL 封存说明或重定向；旧 API HTTP 410。
- **R4-1**：SQL 增量 PG 独立库 **保持，不重开**。
- **外壳**：`IceV4WorkspaceShell` 导航仅现役四项；`catalog-detail` Pill → `src/ui/ice-v4/primitives`。
- **继承 R3/R2**：013、preview-operating-config、六仓/金额/perf 证据。

## R5 交付摘要

- [repair-delivery-summary.md](../../.local/catalog/ui-perf-r5-cleanup-20261022/repair-delivery-summary.md)
- [verification-index.json](../../.local/catalog/ui-perf-r5-cleanup-20261022/verification-index.json)

## 自验（执行方，非独立结论）

| 项 | 命令 / 证据 | 退出码 |
|---|---|---|
| progress9 串行自验 | `runs/progress9-verify-20261023-final/selfverify-steps.json`（runner → 合并负向 → 复核 → tsc → 单测 → lint → diff） | 8/8 = 0 |
| progress8 串行自验（历史） | `runs/progress8-final5/selfverify-steps.json`（fixture/校准/负向/合并负向/runner/浏览器/暖矩阵/冷测/合并） | 9/9 = 0 |
| Lint | `npm run lint -- --max-warnings 0` | 0 |
| diff --check | 仅 CRLF 提示 | 0 |
| tsc（全仓） | `node node_modules/typescript/bin/tsc --noEmit --incremental false` | 2（总 5 条；商品库 0，历史 BEST 5） |
| R5/R4 历史门禁 | `lint-pass.log`、`preview-start.log`、`logged-in-perf-probe.log`、截图 | 0 |

## 预览（现役）

- **Run** `run-20261021T100700Z-b3c4d5e6`
- **商品库** http://127.0.0.1:3011/dashboard/catalog
- **Demo** http://127.0.0.1:3011/demo/ice-v4
- BUILD `Jq2Y6jz_l7sFTKfSUPYkF`（pid 42900）
- 尾延迟事实：WM0005 单次 **4377ms** 慢样本保留，p95 合同通过不等于每次请求都低于阈值

```powershell
$env:CATALOG_PREVIEW_PORT='3011'
$env:CATALOG_PREVIEW_NEXT_MODE='start'
node scripts/catalog/start-local-preview.mjs --run-id run-20261021T100700Z-b3c4d5e6
node scripts/catalog/status-local-preview.mjs --run-id run-20261021T100700Z-b3c4d5e6
node scripts/catalog/stop-local-preview.mjs --run-id run-20261021T100700Z-b3c4d5e6
```

## 独审报告

| 轮次 | 路径 |
|---|---|
| **最终（现役，`U3_LOCAL_UX_PERF_PASS`）** | `.local/catalog/independent-ux-perf-u3-final-20261023/independent-review.md` |
| progress9（输入） | `.local/catalog/independent-ux-perf-u3-progress9-20261023/review-notes.md` |
| progress8（输入） | `.local/catalog/independent-ux-perf-u3-progress8-20261023/review-notes.md` |
| progress7 | `.local/catalog/independent-ux-perf-u3-progress7-20261023/review-notes.md` |
| R4（更早阻断） | `.local/catalog/independent-ui-perf-r4-20261022/independent-review.md` |

## Git

本包累积成果已按依赖分批提交并 push `codex/ice-v4-planning`（Legacy 封存/删除、ICE v4 外壳、商品库 UI 与缓存、性能与候选等价工具、013–014 增量、预览工具链、测试、文档）；未 merge/deploy，不 force push。提交清单、远端 SHA 与剩余文件盘点见 `.local/catalog/ux-perf-u3-20261022/final-closeout/closeout-record.md`（证据目录不入库）。**下一会话**：新版 UI 打磨与新品/来源核实问题触发式入口。
