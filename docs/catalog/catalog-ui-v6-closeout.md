# 商品库 v6 四项定向补修包 — 收尾摘要

日期：2026-10-24（Asia/Shanghai）。独审状态：**`V6_FOUR_ITEMS_LOCAL_PASS`**。

结论：**商品库 v6 四项定向补修已通过独立复审，按不越权、日常正常使用、关键内容不误导的标准完成本包。**

本摘要可随仓库提交。完整证据（独审报告、截图、原始日志、探针原始结果、构建核对 JSON）保留在执行方与审阅方本地 `.local/`，**不随仓库推送**；本文不声称远端已包含这些证据，也不含口令、会话令牌、数据库连接凭据或原始业务数据。

## 1. 通过范围

| 项 | 通过内容 |
|---|---|
| V6-01 来源缓存边界 | 撤销 v5 新增的共享来源结果缓存；库存空态提示与“数据来源”子视图每次重新走服务端鉴权；迟到旧结果不覆盖新结果；原详情缓存与退出清理保护保留 |
| V6-02 采用与库存 | 资料“本批已采用对应”与“库存已计入”分开；BS 以库存明细中已确认的 BS 样表行为准，JST 国内库存未接入、不据此计入；已采用记录不再显示早期筛查结论，未采用记录保留且提示默认收起 |
| V6-03 来源价格 | 逐条来源价格说明改为“暂未展示”；WM0072 当前采用进货价 5.18、运营价 5.68 保持；未把未展示写成没有记录/未采用/0 |
| V6-04 失败与空态 | 加载/失败/无权限计数显示“—”，仅成功空集合显示 0；失败与无权限文案分开；价格单独失败/无权限保留来源记录、清价格旧值并可重试；历史重试不切当前 |

**通过范围仅限这四项。** 不代表原 v4/v5 全量验收通过，不代表全商品库或全 ICEOS 全面通过，不代表真实多账户/真实撤权/数据库权限矩阵通过，不代表完整性能验收通过，也不代表真实来源接入或生产上线。v5 历史结论 `UI_REVIEW_NEEDS_FIX` 保留；`U3_LOCAL_UX_PERF_PASS`、`LOCAL_PREVIEW_PASS` 保持原范围。

## 2. 候选绑定

- 仓库：`D:/try one/ICEOS`；分支 `codex/ice-v4-planning`；收尾前已提交 HEAD `72d4dd2bd66ced4d8c03700b85bce3f4009b6c8d`。
- 现役预览：`http://127.0.0.1:3011/dashboard/catalog`，run `run-20261021T100700Z-b3c4d5e6`。
- BUILD：`UeTuf-hPnkmmIWTQ1LmFU`；已审源码快照 `4cf18e571fc4bb382bfbb43492dff43600b2aa686da670cc6a48b45594dc1aac`，pid 34572，`ownershipVerified=true`，login 200。
- 独审核对 521 个构建源码条目：现役工作区零差异；仅 `docs/catalog/catalog-ui-perf-delivery-index.md` 为构建后文档差异。398 个构建产物零差异，13 个关键文件 hash 一致。已删 `src/features/catalog/shell/source-view-cache.ts` 在仓库与现役构建工作区均不存在。

## 3. 证据分层（勿混记）

| 类别 | 结果 | 不外推的边界 |
|---|---|---|
| 独立实际页面走查 | WM0043 搜索/详情/真实零仓/有货仓/未采用仓/来源/返回/关闭；WM0072 当前价与“当前→旧版来源→显式当前参照→返回当前”；5 张新截图与 AX 文字记录 | 普通桌面视口 1280×720，不是五视口、200% 或性能矩阵 |
| 独立重跑 | 33 项受控浏览器检查通过；另补 6 项边界：价格单独失败时 12 条来源集合不变、重试确有新读取、新无权限先回而旧成功后回仍清空、历史失败重试两次 revision 均为 1 | 本地真实浏览器对受控响应的 UI 分支验证，不是现役数据库故障或真实撤权 |
| 独立定向纯测试与组件接线 | source-view 5、detail-cache 13 全部通过；组件异步接线 5/5、投影与组件探针 20/20；本包 6 个受影响源码/测试文件 eslint `--max-warnings 0` exit 0 | 后两类用实际代码与受控 Promise/hook 接线，无数据库；分报告有重叠，不累加成新的总覆盖数 |
| 仅核执行方材料 | 主浏览器套件 22 expected / 0 unexpected / 0 skipped / 0 flaky（104.7s）；单测 547/548（唯一既有 opt6 00051）；catalog 类型 0（全仓仅既有 BEST 5）；全仓 lint 0 error / 14 条既有 warning；production build 成功 | 独审只核查原始材料，**不是独立全部重跑**；主 22 项运行于同快照另建 BUILD `dgDyvJSg2dAHHWnmbdqd9` |
| 继承 | 未受影响的布局、分页、返回与详情缓存基线；原 `U3_LOCAL_UX_PERF_PASS` / `LOCAL_PREVIEW_PASS` 原范围 | 未把历史通过升级为本轮全系统通过 |

## 4. 证据位置（本地，不入库）

- 独审主报告：`.local/catalog/independent-ui-frontend-v6-20261024/independent-review.md`
- 同目录：`ui-observations.md`、`code-review/independent-code-review.md`、`contract-review/contract-review.md`、`evidence-review/review.md`、`evidence-review/{replay,extra}/browser-probe-result.json`、`evidence-review/{status-elevated,audit-results}.json`、`independent-lint.json`、`evidence-hashes.json`
- 执行方材料：`.local/catalog/ui-frontend-v6-20261024/{delivery-summary,repair-matrix,evidence-index,screenshots-index}.md` 与同目录原始结果
- Git 收尾凭证：`.local/catalog/ui-v6-closeout-20261024/closeout-record.md`

**lint 指针修正**：执行方证据索引引用的 `lint-changed-final.log` 原件缺失。独审已另行对本包 6 个相关文件运行 eslint `--max-warnings 0`，exit 0，真实结果见 `independent-lint.json`；本摘要以该结果为准，未补造旧执行日志，也未改写独审报告或覆盖历史证据。

## 5. 延期项与既有失败（不是通过）

逐条来源价格完整追溯、精确焦点恢复、少数旧 URL 分支、200% 缩放/像素基线、旧 v6 性能门禁与 15×20、原 v4 全量后端/prepare/增量恢复/保存回执六态、后续匹配规则、飞书/BS/JST 真实摄取——全部继续延期。全仓 BEST 5 条类型诊断、`opt6-production-apply` 00051 换行单测、14 条既有 lint warning 原样保留，未为清零修改历史代码或测试。

## 6. 本次累计提交范围与“归档现状”的区别

本系列的未提交内容不止 v6 的少量文件，还包含前几轮 UI 改造与补修。本次按实际依赖分逻辑提交：

1. 累计商品库 UI/交互、服务端投影、样式、路由与对应测试（组成当前最终候选的完整代码）；
2. 已有工具脚本（prepare/增量准备链相关改动）单独提交，**标注“现有实现归档，相关验收延期”**：只保存现状，不在收尾时继续修复、执行或宣布通过；
3. 文档与独审收尾（本摘要及四处现役入口）。

**“代码已提交归档”不等于“相关事项已验收通过”**：归档说明代码进入仓库历史；通过说明只覆盖上表四项，且以独审报告为界。

## 7. Git 收尾

已按逻辑分组提交并普通推送 `origin/codex/ice-v4-planning`（`git push origin HEAD:refs/heads/codex/ice-v4-planning`），未使用强推、未推送标签、未推送 `.local`。未 merge、未发布、未启停实例、未清场、未开启下一包。提交 SHA、最终 HEAD、真实远端 SHA 与 ahead/behind 以本地回执 `.local/catalog/ui-v6-closeout-20261024/closeout-record.md` 为准；推送成功不等于 CI 通过、合并或发布。
