# 本地真实商品预览包 — 执行交付索引

状态：**`LOCAL_PREVIEW_PASS`**（2026-10-21 最终独审；本地样表预览范围，非生产/全库 ICEOS）

| 项 | 路径 |
|---|---|
| **最终独审（现役结论）** | [independent-local-preview-final-20261021T084549Z/independent-review.md](../../.local/catalog/independent-local-preview-final-20261021T084549Z/independent-review.md) |
| R5 closeout 独审（历史） | [independent-local-preview-r5-closeout-20261021T081737Z-dab40b90/independent-review.md](../../.local/catalog/independent-local-preview-r5-closeout-20261021T081737Z-dab40b90/independent-review.md) |
| 第五轮功能独审（历史） | [independent-local-preview-r5-20261021T080011Z-f432e41a/independent-review.md](../../.local/catalog/independent-local-preview-r5-20261021T080011Z-f432e41a/independent-review.md) |
| **R5 短程证据** | [r5-short-verify-index.json](../../.local/catalog/run-20261021T075139Z-821214d2/r5-short-verify-index.json) → `evidence/r5-short-verify-2026-10-21T08-24-27-634Z-4ec9e4/` |
| 第四轮 / 第三轮独审（历史） | [R4](../../.local/catalog/independent-local-preview-r4-20261021T073551Z-bbb9b762/independent-review.md) · [R3](../../.local/catalog/independent-local-preview-r3-20261021T064605Z-2a4f3ba5/independent-review.md) |
| Git 三份清单 | [local-preview-git-manifest.md](./local-preview-git-manifest.md) |
| 工作区 Git 盘点 | [workspace-git-audit-20261021](../../.local/catalog/workspace-git-audit-20261021/workspace-git-audit.md) |
| **自验 run** | `run-20261021T075139Z-821214d2` |
| **自验总日志（历史）** | [self-verify-log.json](../../.local/catalog/run-20261021T075139Z-821214d2/evidence/self-verify-2026-10-21T07-51-39-509Z-88f057/self-verify-log.json) |

## 最终独审登记（2026-10-21）

| 类别 | 结论 |
|---|---|
| **独立重跑** | `run-preview-start-control-flow-probe.mjs` exit 0 — VM 内真实 start/stop 源码共 **9** 场景（start 4 + stop 5） |
| **独立重算** | 短程 before/after 展示投影各 **126** 行，SHA256 均为 `330125d4fdf1cddb00b2630822edfdcc87b6ac6cd3f21d9519e1abe2048de0fe`；时间顺序 before `08:24:52.483Z` → stop/restart 命令 → after `08:25:04.009Z` 有效 |
| **只读运行态** | status/登录 HTTP 200，`ownershipVerified: true`（审查时点 PID 可与短程双 start 记录 72052 不同） |
| **原始日志核查** | 短程目录归属 7 例、decoy negative、双 start marker/PID、命令 exit 0 — 索引文件齐全，T2 关闭 |
| **继承、未重跑** | 07:57 完整自验（旧源码快照 `69a376fe…`）、隔离 build、商品/库存/估值/RLS 历史验收 — 结论保持，不回写为本次重跑 |

R5 功能项（重复 start noop、无 legacy 归属、VM 门禁）在 closeout 轮已关闭；本轮 T1/T2 关闭。**历史** CHANGES_REQUIRED 与旧执行交付索引保持当时表述，不 retroactive 改为 PASS。

## 第五轮 R5 启停（历史补修，R3-2/3/4 保持关闭）

| 项 | 补修 | 证据 |
|---|---|---|
| **R5-1** | 健康且源码未变 → noop；否则受控 stop | 短程 `preview-double-start.json`；VM `preview-control-flow-vm-probes.json` |
| **R5-2** | 缺 `processCreatedAt` 拒绝 | 短程 `preview-ownership-probes.json`（7 例） |

短程冻结源码：`4d4178d7eb2e04b7d673f5a446d0af06610d859b7e35efca8c5800525e6a2aa0`。编排：`node scripts/catalog/run-preview-r5-short-verify.mjs`（执行方 exit 0，2026-10-21）。

## 第四轮 R4 / 第三轮 R3（历史）

见上文历史独审链接；R4 归属绑定与工作区顺序、R3-2/3/4 关闭项不再重开。

## 自验 run `run-20261021T075139Z-821214d2`（历史全链，R5 前源码）

| 步骤 | exit |
|---|---:|
| prepare-local-preview | 0 |
| ownership / start / workspace-guard / build / vitest / Playwright | 0 |
| display 快照 stop 前 @ `2026-10-21T07:57:16.406Z` | 0 |
| stop / restart / after @ `2026-10-21T07:57:25.447Z` | 0 |

- 当时源码快照：`69a376fef4e5a62b595fc23641f394fab48786356fa21b5717eee366febb6b41`
- 投影 SHA（与最终短程一致）：`330125d4fdf1cddb00b2630822edfdcc87b6ac6cd3f21d9519e1abe2048de0fe`

根目录 `npm run build` 非本包验收项；历史隔离 `next build --webpack` exit 0。

## 现役预览

| 项 | 值 |
|---|---|
| URL | http://127.0.0.1:3010/dashboard/catalog |
| 登录 | `admin@catalog.test` / `.local/catalog/run-20261021T075139Z-821214d2/instance/login.local-preview.txt` |
| 启动 | `node scripts/catalog/start-local-preview.mjs --run-id run-20261021T075139Z-821214d2` |
| 状态 | `node scripts/catalog/status-local-preview.mjs --run-id run-20261021T075139Z-821214d2` |
| 停止 | `node scripts/catalog/stop-local-preview.mjs --run-id run-20261021T075139Z-821214d2` |
| 完整自验（历史门禁） | `npm run catalog:self-verify-local-preview` |

## 停止与边界

**通过范围**：本地真实商品及样表库存预览、启停与测试证据。**不表示** BigSeller/聚水潭/飞书实时同步、生产切换或 ICEOS 全项目完成。

**Git**：本包源码与 closeout 测试已全部推送 `origin/codex/ice-v4-planning`（提交序列见 manifest §4；**`package.json` 在 acb4865**）。不 merge/deploy。`.local` 原始 JSON、pgdata、凭据不入库。
