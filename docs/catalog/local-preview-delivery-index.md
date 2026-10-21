# 本地真实商品预览包 — 执行交付索引

状态：**R5 功能问题已独立关闭**；**交付收尾（VM 门禁 + 短程证据）待复核**（商品/估值/RLS 不重开）

| 项 | 路径 |
|---|---|
| **R5 closeout 独审（交付收尾对照）** | [independent-local-preview-r5-closeout-20261021T081737Z-dab40b90/independent-review.md](../../.local/catalog/independent-local-preview-r5-closeout-20261021T081737Z-dab40b90/independent-review.md) |
| 第五轮功能独审（历史） | [independent-local-preview-r5-20261021T080011Z-f432e41a/independent-review.md](../../.local/catalog/independent-local-preview-r5-20261021T080011Z-f432e41a/independent-review.md) |
| **R5 短程证据（当前源码）** | [.local/catalog/run-20261021T075139Z-821214d2/r5-short-verify-index.json](../../.local/catalog/run-20261021T075139Z-821214d2/r5-short-verify-index.json) → `evidence/r5-short-verify-2026-10-21T08-24-27-634Z-4ec9e4/` |
| 第四轮独审（历史） | [independent-local-preview-r4-20261021T073551Z-bbb9b762/independent-review.md](../../.local/catalog/independent-local-preview-r4-20261021T073551Z-bbb9b762/independent-review.md) |
| 第三轮独审（历史） | [independent-local-preview-r3-20261021T064605Z-2a4f3ba5/independent-review.md](../../.local/catalog/independent-local-preview-r3-20261021T064605Z-2a4f3ba5/independent-review.md) |
| Git 三份清单 | [local-preview-git-manifest.md](./local-preview-git-manifest.md) |
| **自验 run** | `run-20261021T075139Z-821214d2` |
| **自验总日志** | [.local/catalog/run-20261021T075139Z-821214d2/evidence/self-verify-2026-10-21T07-51-39-509Z-88f057/self-verify-log.json](../../.local/catalog/run-20261021T075139Z-821214d2/evidence/self-verify-2026-10-21T07-51-39-509Z-88f057/self-verify-log.json) |

## 第五轮 R5 启停补修（R3-2/3/4 保持关闭）

| 项 | 补修 | 证据 |
|---|---|---|
| **R5-1 重复 start** | 已健康且源码未变 → `priorPreviewAction: noop`（无 kill/删 marker）；否则仅 `stop-local-preview`；stop 失败抛错保留 marker | 短程目录 `preview-double-start.json`；VM `preview-control-flow-vm-probes.json`（start 4 场景） |
| **R5-2 去掉 legacy** | 缺 `processCreatedAt` → `CATALOG_PREVIEW_MARKER_INCOMPLETE` | 短程 `preview-ownership-probes.json`（7 例）；VM stop 5 场景（拒绝/超时/端口占用保留 marker） |

### R5 短程验证（2026-10-21，不重开 prepare/业务全套）

- **源码快照**：`4d4178d7eb2e04b7d673f5a446d0af06610d859b7e35efca8c5800525e6a2aa0`（`frozen-source-snapshot.json`）
- **展示投影（stop 前 → restart 后）**：`330125d4fdf1cddb00b2630822edfdcc87b6ac6cd3f21d9519e1abe2048de0fe`；时序 `08:24:52.483Z` → `08:25:04.009Z`（`display-projection-restart-comparison.json`）
- **编排**：`node scripts/catalog/run-preview-r5-short-verify.mjs`（exit 0）

## 第四轮 R4 启停补修（历史）

| 项 | 补修 | 证据 |
|---|---|---|
| **R4-1 归属绑定** | `catalog-next-preview-dev.mjs` 在命令行携带 `--catalog-workspace` / `--catalog-run-id`；marker 写入 `processCreatedAt` 并与 WMI 创建时间、`startedAt` 交叉校验；去掉「同仓库 Next + 端口 + 目录存在」兜底 | `preview-ownership-probes.json`（正例 + 错 workspace / 错 startedAt / 错 runId / 陈旧 processCreatedAt 负例）；`preview-ownership-negative.json`（非 Next listener 仍拒绝） |
| **R4-2 工作区顺序** | `start-local-preview` 先读 marker 与归属，再 `ensurePreviewWorkspace`；源码快照变化时受控 `stop-local-preview` 后刷新；归属拒绝时不改工作区 | `preview-start-workspace-guard.json`（错 marker workspace 拒绝且 sentinel 保留；受控刷新后 sentinel 清除且 `ownershipOk: true`） |

## 第三轮已关闭项（本轮未重开）

- **R3-2 本仓有价**、**R3-3 重启投影**、**R3-4 Git 忽略** — 第四轮独审已确认关闭；本轮自验仍跑 `client-scope-warehouse` 与 restart 投影对比，结果一致。

## 自验 run `run-20261021T075139Z-821214d2`

| 步骤 | exit |
|---|---:|
| prepare-local-preview | 0 |
| preview-ownership-negative / preview-ownership-probes | 0 |
| start / status / preview-start-workspace-guard | 0 |
| isolated build / vitest / Playwright | 0 |
| **display 快照（stop 前）** | 0 @ `2026-10-21T07:57:16.406Z` |
| stop / restart / status-after-restart | 0 |
| **display 快照（restart 后）** | 0 @ `2026-10-21T07:57:25.447Z` |

- **源码快照哈希（自验冻结）**：`69a376fef4e5a62b595fc23641f394fab48786356fa21b5717eee366febb6b41`
- **展示投影哈希（前后一致）**：`330125d4fdf1cddb00b2630822edfdcc87b6ac6cd3f21d9519e1abe2048de0fe`
- **自验总链 exit**：0；`failed: false`；`previewLeftRunning: true`

根目录 `npm run build` 仍未作为本包验收项执行；隔离 `next build --webpack` exit 0。

## 现役预览

| 项 | 值 |
|---|---|
| URL | http://127.0.0.1:3010/dashboard/catalog |
| 登录 | `admin@catalog.test` / `.local/catalog/run-20261021T075139Z-821214d2/instance/login.local-preview.txt` |
| 启动 | `node scripts/catalog/start-local-preview.mjs --run-id run-20261021T075139Z-821214d2` |
| 状态 | `node scripts/catalog/status-local-preview.mjs --run-id run-20261021T075139Z-821214d2` |
| 停止 | `node scripts/catalog/stop-local-preview.mjs --run-id run-20261021T075139Z-821214d2` |
| 完整自验 | `npm run catalog:self-verify-local-preview` |

## 停止与边界

**Git**：积压 + closeout 已推送，远端 **4e5c01d**（manifest §4.1–§4.2，closeout 主体 **9a8acb2**）；**package.json 在 acb4865**。不 merge/deploy。`.local` 短程原始 JSON 与凭据不入库。
