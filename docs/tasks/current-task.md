# Current Task Packet

## 商品库 Demo 界面复用与访问性能（当前）

状态：**`U3_LOCAL_UX_PERF_PASS`（独立复审通过 2026-10-23；文档登记与分批提交完成）**。独立报告 [independent-review.md](../../.local/catalog/independent-ux-perf-u3-final-20261023/independent-review.md)；摘要 [progress9-delivery-summary.md](../../.local/catalog/ux-perf-u3-20261022/progress9-delivery-summary.md)；证据 [evidence-index.md](../../.local/catalog/ux-perf-u3-20261022/evidence-index.md)；执行自验 `runs/progress9-verify-20261023-final/selfverify-steps.json`（8/8 exit 0）。3011 BUILD **`Jq2Y6jz_l7sFTKfSUPYkF`** @ `run-20261021T100700Z-b3c4d5e6`（pid 42900，未重启）。通过范围仅限本地样表商品库交互、缓存恢复、性能测量与验收门禁；**不代表**新 UI 完成、真实来源接入、生产发布或全 ICEOS 验收，**`LOCAL_PREVIEW_PASS`** 原范围不变。已关闭：R1 冷启动门禁以 `listSample/detailSample.contentReadyMs` 重算（摘要须等于取整规则，缺失/NaN/Infinity/矛盾即拒绝；合并负向 51/51 + 独立 26 项边界）+ 新验证器复算 `runs/progress8-final5` 原始证据 → `allRequired=true`（原始暖/冷/fixture SHA 未改写，旧验证器单独留存）；R2 runner 校验 `completed=126`/`completed↔itemCount`/`readOnlyEvidence.transactionReadOnly==='on'`（真实 spawn 11/11 + 独立 6 项边界）；R3 全仓 tsc 总诊断 **21→5**、当前商品库 **16→0**，历史 BEST 5 条按范围保留（不声称全仓 tsc 通过）。继承 126×252 / 0 差异（`progress5-20261022-180727`，未重跑）；暖 15×20 / 冷 3 轮沿用 progress8-final5 原始结果只复算不重采样。progress8 的 `allRequired=true` 在其原门禁下保留为历史；progress7 的 `allRequired=true` 为旧计时口径，**不能**作为通过依据。**无**执行方自注册 PASS，本状态依据独立报告登记。

范围：旧经营模块完整源码外置 `D:/try one/ICEOS-legacy-archive/20261022/`（仓库 `archive/legacy-business-20261022/` 仅 `manifest.json`/`EXTERNAL-POINTER.json`/白名单/处置表/`RESTORE.md`/skills 版本清单）；现役仅商品库/新品/来源核实/管理审计；导航与测试对齐白名单；旧 URL/API 封存或重定向；共享 UI `src/ui/ice-v4`；继承 **`LOCAL_PREVIEW_PASS`** 与预览 run `run-20261021T100700Z-b3c4d5e6`。**下一会话**：新版 UI 打磨与新品/来源核实问题触发式入口，本轮不扩开发。

## 本地真实商品预览包（历史 PASS）

状态：**`LOCAL_PREVIEW_PASS`** — 独立验收完成（2026-10-21）。最终报告：[independent-local-preview-final-20261021T084549Z](../../.local/catalog/independent-local-preview-final-20261021T084549Z/independent-review.md)。交付索引：[local-preview-delivery-index.md](../catalog/local-preview-delivery-index.md)；Git 清单：[local-preview-git-manifest.md](../catalog/local-preview-git-manifest.md)。

范围：126 主资料、BS 530（430/100）、六仓、进货价货值；本地样表预览与启停/测试证据；继承 P0/N1A/N1C 与 R3–R5 已关闭项。**预览 run** `run-20261021T075139Z-821214d2`（历史；R2 自验后已受控停止）。本轮 UI 包现役 run 见交付索引 **`run-20261021T100700Z-b3c4d5e6` @ 3011**。LOCAL_PREVIEW 包不重跑 prepare；不 merge/deploy/清场。

## N1C — 本地隔离独立通过与文档登记（历史）

状态：**N1C_LOCAL_PASS**，仅本地隔离范围。验收依据[N1C独立总报告](../../.local/catalog/independent-new-item-review-20261021T015312Z-e38782af/independent-review.md)；原[执行交付](../../.local/catalog/new-item-delivery-20261020T142050Z-85800652/delivery-index.md)保持当时待审记录，不能回写成独立结论。[文档收尾证据](../../.local/catalog/docs-closeout-20261021T020835Z-869e3fc6/delivery-index.md)已登记。

## P0-03 — 独立总验收通过及文档收尾（历史已完成）

状态：**P0_03_PASS**。[独立总验收报告](../../.local/p0-03/reviews/evidence/independent-final-acceptance-20261020-49c832b7/independent-review.md)已通过，文档收尾完成。本期范围仅为产品主库整理、商品身份标准、本批样表对应与人工决定保存、输出一致及历史可追溯；不表示全部资料核实或后续正式关系、真实接入与库存使用已经完成。

- [本轮任务包](./p0-03/2026-10-20-final-acceptance.md)、[明确决定JSON](../p0-03/final-decisions-20261020.json)、[总验收报告](../p0-03/verification-report-p0-03-final-acceptance-20261020.md)；规则正文仍为[商品身份标准](../product-identity-standard-v1.md)。
- [唯一最终输出](../../.local/p0-03/run-20261020-final-acceptance/evidence/final-2026-10-20T03-41-45-834059Z-cd7d4d19/delivery-final-v2/)，含coverage/。delivery-final首版、delivery-reproduced、开发/负向及门禁smoke均仅作证据。
- 使用最新独立通过的JST545交付，指定bundle与有效CSV哈希已核对；继承有效CSV及全部历史，不回退桌面CSV、不隐式合并、不全库重匹配替换决定。

已完成：菲越三条WM0012确认升级普通版、版本待决解除而原目标保持；WM0006/WM0008本批ignore、目标空、原候选保留；WM0130原857确认主库121；菲越两WM0073原220/321由defer转confirm主库67、旧暂缓留历史。六项规格已关闭：两忽略、其余四款按主库C列；不换算g/ml，WM0062 JST789 reject仍在。WM0081原62与brush原107各自可见、待确认，并登记后续正式系统也应保留两份及状态。

结果：126份主资料（125非空唯一货号＋1缺码），1417来源，548选择＝BS430＋JST118；覆盖114/2/4/6、120份有选择。774待核对＋1候选、3拒绝、3忽略、88规则外。新增选择3、既有版本再确认3、本批忽略2；原545目标/JST引用、原22条完整记录、原11JST、WM0007ignore、BS70/72未建档、WM0072锚点66及现价5.18/5.68/两版历史保持。

执行自验本轮重跑：136回归（原121不改＋15）、完整P0-03门禁、全量投影与216字段差异重构、21新业务负向/原12在新结果/原16在历史基线、旧审计28/32与新44、10图片、2审计CLI、6本地浏览器、147产物字节一致再生、lint/build、保护/链接/口径/diff均通过。实际argv、退出码、初检失败、完整日志及既有警告见总报告，不能写成另一个会话的独立重跑。

独立总验收重跑136回归、全量1417/126/原545/22/3160行CSV、21＋12＋16组业务负向、新44和历史28/32组审计负向、10图片、6本地文件浏览器、147份字节一致再生、2审计CLI及范围/链接/diff均通过，另有19项冻结基线探针和原Excel/覆盖/汇总核算。完整P0-03门禁、lint、build仅核查执行日志，未独立重跑。本次仅更新获准的五份文档，做链接、一致性及diff检查，未重跑功能测试。

保留延期：两刷子及未确认BS记录/唯一WM0081 JST候选、新品缺码、工厂/其他缺失、图片内容未核验、一般未核对775及未涉及拒绝/规则外/纠错。本轮菲越版本待决和六项规格说明已关闭，不能继续显示为需重复选择。BS70/72未建档不表示库存0，不要求所有商品同时有两个系统记录。

历史：[JST本批独立通过](../p0-03/verification-report-p0-03-jst-confirmations-20261020.md)及[独立报告](../../.local/p0-03/reviews/evidence/independent-jst-confirmations-20261020-dce89074/independent-review.md)、[审计补修独立通过](../p0-03/verification-report-p0-03-coverage-audit-repair-20261020.md)、[四项确认独立通过](../p0-03/verification-report-p0-03-confirmations-20261019.md)、[主库整理独立通过](../p0-03/verification-report-p0-03-curation-20261019.md)保留原样，含CHANGES_REQUIRED及补修过程。审查前状态P0_03_IMPLEMENTED_AWAITING_REVIEW保留为历史；当前PASS依据本次独立总验收，不由过去分批通过推定。

业务方向/未核实接入条件见[当前状态](../current-state.md)；正式保存关系、自动复用、数量归集、库存同步及估值仍未实现、不在本期。上述延期不阻塞本期有限范围PASS。保留全部原始Excel/CSV、旧证据、HOLD和其他未提交修改；neat-freak仅本次五份文档对齐，不清场、不写记忆。不入正式库、不访问真实账号、不发布/同步库存、不提交/推送/合并/部署或推进下一阶段。停止于P0_03_PASS（文档收尾完成），下一阶段等待另行授权。

---

## P0-02 — PASS（保留）

状态：**`P0_02_PASS`**

- 正式 PASS 报告：[../p0-02/verification-report-p0-02-pass-20261015.md](../p0-02/verification-report-p0-02-pass-20261015.md)
- Canonical Run：`run-20261014-r2`

---

## P0-02 — 历史任务包（归档含义）

- d082728 返工：[p0-02/2026-10-15-delivery-rework-d082728.md](./p0-02/2026-10-15-delivery-rework-d082728.md)（当时 **IMPLEMENTED_AWAITING_REVIEW**）
- 返工验证报告：[../p0-02/verification-report-r2-20261015-d082728-rework.md](../p0-02/verification-report-r2-20261015-d082728-rework.md)

---

## P0-01 — 独立审查通过（保留）

**P0_01_PASS** — 证据 `.local/p0-01/run-20261013-r1/reviews/independent-r5-closeout-20261014-01/`
