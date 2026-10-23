# Current Project State

更新：2026-10-23（**商品库 U3 独立复审通过 `U3_LOCAL_UX_PERF_PASS`**；文档登记与分批提交完成；**LOCAL_PREVIEW_PASS** 保留）。仓库 ICEOS。

## 商品库 Demo 界面与访问性能（当前包）

**商品库 U3 — `U3_LOCAL_UX_PERF_PASS`（独立复审通过 2026-10-23）** — 独立报告 [independent-review.md](../.local/catalog/independent-ux-perf-u3-final-20261023/independent-review.md)；执行摘要 [progress9-delivery-summary.md](../.local/catalog/ux-perf-u3-20261022/progress9-delivery-summary.md)；证据 [evidence-index.md](../.local/catalog/ux-perf-u3-20261022/evidence-index.md)。**通过范围**仅限本地样表商品库的交互、缓存恢复、性能测量与验收门禁；**不代表**新 UI 打磨完成、真实来源接入、生产发布或全 ICEOS 验收，既有 **`LOCAL_PREVIEW_PASS`** 原范围不变。独立审查关闭三项：**R1** 冷门禁改以 `listSample/detailSample.contentReadyMs` 为唯一输入（摘要须等于 `Math.round(原始值)`，缺失/NaN/Infinity/矛盾即拒绝；执行方合并负向 51/51，独立另跑 26 项边界），用新验证器（`f8dcd797…`）复算 `runs/progress8-final5` 原始证据 → **`allRequired=true`**（原始暖 `cab3706e…`、冷 `d8cd3cfc…`、fixture `2ae987d1…` 未改写；旧验证器 `ed717297…` 单独留存）；**R2** runner 校验 `completed===126`、`completed↔itemCount`、`readOnlyEvidence.transactionReadOnly==='on'`，真实 spawn **11/11**（独立另跑 6 项边界，生产 attempts/latest 前后不变）；**R3** 全仓 tsc 总诊断 **21→5**，当前商品库 **16→0**，历史 BEST 测试 **5 条**按范围保留（不声称全仓 tsc 通过；`next build` 过滤 `*.test.*`，不能替代）。执行自验 `runs/progress9-verify-20261023-final/selfverify-steps.json` 8/8 exit 0；BUILD 未变（**`Jq2Y6jz_l7sFTKfSUPYkF`** @ 3011 pid 42900，未重建/未启停）；继承 **126×252 / 0 差异**（progress5 attempt，未重跑）与 **`LOCAL_PREVIEW_PASS`**。

证据分层（勿混记）：**本次独立重跑**＝合并器 51 项正负向、26 项冷门禁边界、runner 11 项测试与 6 项边界、实际 tsc、19 项单测、eslint、diff-check、冻结原始数据复算、编译凭据/文件漂移、只读进程归属；**沿用上一轮同审查方独立结果**＝loader cache 7 + recovery 5、oracle 校准 3/3 与内容判定 25/25（应用未改）；**执行日志核验/继承**＝完整 Playwright 17/17、暖 15×20 矩阵、3 次冷进程、staging build/promote、126×252 只读候选等价，本轮只复算原始数据，未重新采样或重启。progress8 的 `allRequired=true` 在其原计时门禁下保留为历史结论，progress9 起以原始计时重算复核；progress7 的 `allRequired=true` **不能作为通过依据**（计时在 DOMContentLoaded 重开、首开前等 audit-ready、负向捕获初始化异常、`sourceHashes` 回填、详情预取失败自循环）；progress6 `allRequired=false` 为旧串行断言计时；progress5 `allRequired=true` 为**旧不完整断言口径**。

**既有失败与遗留（不影响本期范围）**：全仓 tsc 仍有历史 BEST 测试 5 条诊断（`src/lib/providers/best/__tests__/client.test.ts` 3 条、`dry-run.test.ts` 2 条，均 TS2352），按用户范围不修；p95 通过伴随 WM0005 单次 **4377ms** 尾延迟，保留事实，不宣传每次即时展示；根目录历史 build 与全量旧回归不因本报告变成全绿。**下一会话**：新版 UI 打磨、新品/来源核实问题触发式入口与进一步清理，本轮不扩开发。

## 本地真实商品预览（历史 PASS）

**`LOCAL_PREVIEW_PASS`** — 本包独立验收完成（[最终独审](../.local/catalog/independent-local-preview-final-20261021T084549Z/independent-review.md)）。通过范围：本地真实商品及本批样表库存预览（126 资料、BS 530 展示、六仓、已确认口径货值、启停与测试证据）；**不代表**实时同步、生产启用或全库 ICEOS 已交付。索引：[local-preview-delivery-index.md](./catalog/local-preview-delivery-index.md)。

**最终独审核验（2026-10-21）**：独立重跑 VM 控制流探针 9 场景 exit 0；独立重算短程 before/after 各 126 行投影 SHA 均为 `330125d4fdf1cddb00b2630822edfdcc87b6ac6cd3f21d9519e1abe2048de0fe`，时间顺序有效；只读 status/登录与进程归属通过（审查时点 PID 与短程记录可不同，见 delivery-index）。短程原始 JSON、历史全链自验与商品/估值/RLS 门禁结论为**原始日志核查或继承**，本轮未重跑 prepare、完整自验或业务回归。

**Git**：catalog 积压与 closeout 测试已推送 `codex/ice-v4-planning`（manifest §4；`package.json` 在 **acb4865**）。本包累积成果（Legacy 封存与删除、ICE v4 外壳、商品库 UI/缓存/性能、013–014 增量、预览工具链、测试与文档）已在独审通过后按依赖分批提交并 push `codex/ice-v4-planning`，未 merge/deploy；提交清单与远端 SHA 见 `.local/catalog/ux-perf-u3-20261022/final-closeout/closeout-record.md`（证据目录不入库）。`.local` 证据与凭据不入库；Git 无待提交变更不等于本地实例/缓存已清理（见 [工作区盘点](../.local/catalog/workspace-git-audit-20261021/workspace-git-audit.md)）。

## 来源身份N1A与持续新品N1C（保留）

**N1A_LOCAL_PASS保持；N1C_LOCAL_PASS仅表示本地隔离独立通过。** 依据[N1C独立总报告](../.local/catalog/independent-new-item-review-20261021T015312Z-e38782af/independent-review.md)登记，原[执行交付](../.local/catalog/new-item-delivery-20261020T142050Z-85800652/delivery-index.md)及其待审时点报告原样冻结，不改写历史。已实现八表/七写动作/五SQL、固定商品观测、四分流、缺码新品、同来源slot复用、证明关联/后补身份及非价修订；不等于整个商品系统、真实接入或生产完成。

独立实际重跑 `run-20261021T015418Z-3825abe1`：C34领域/23PG/4浏览器、A兼容46/19/5、未装A/C旧首包41/12/2和三隔离build全部通过，浏览器无跳过/flaky；另34项独立追加探针为C01封套25项与C09直接成员关联9项，不混入原门禁计数。独立报告记录14,764文件起止零变化，6门禁PG＋2探针PG及3Next停止、数据保留；执行方22PG/9Next停止另列，不混计。本轮仅文档登记，没有重新运行上述测试或启服务。

独立审查对lint退出0、普通回归4132通过/1项既有OPT6失败、直接tsc54旧诊断仅核执行日志，未独立重跑；三build确已独立重跑。框架Page/RSC/Action按批准no-store合同验证，无效Cookie配置已撤回；自有raw/export GET的private/no-store/Cookie实际断言通过，但原GET headers未单独归档，不能声称逐份原始头重解析。

126资料、1417来源、548具体原目标/JST与全部历史、3160 CSV/6190历史索引、147完整产物/129子集保持。原122缺码同UUID，C127仅虚构测试；WM0072采用5.18/5.68与来源观测5/5.5及历史、金融指针、两刷子、未建档及public三表保持。P0_01/02/03_PASS、P0-03收尾、商品首包与N1A结论全部继承。

真实身份核实0、relationshipUsable=false、飞书partial；B provider仍为接口fixture，长期关系和库存未启用。本轮只改三入口当前区，[文档收尾证据](../.local/catalog/docs-closeout-20261021T020835Z-869e3fc6/delivery-index.md)另存，历史尾部及原交付/独立报告/源码SQL测试配置保护。登记与只读复核后双方停止，不准备或启动N1B/N2/真实采集/长期关系/库存或下一任务；不清场、桌面操作、记忆写入、提交推送部署。

## 商品资料首包（已独立签收）

首包及R1/R2/R3已[独立复审通过](../.local/catalog/independent-repair-review-20261020T094514Z-bd17af9f/independent-review.md)，仅本地隔离范围。[补修报告](./catalog/verification-report-repair-20261020T092115Z-2b8397ed.md)、[原首包报告](./catalog/verification-report-run-20261020T081620Z-2a2cc8e4.md)及旧CHANGES_REQUIRED保留。旧独立实际重跑41领域/12PG/2浏览器/隔离build，另5PG探针/2恢复流程；lint/普通回归/tsc当时仅核执行日志，不混为本次独立重跑。桌面33份原地保留、归档0的独立结论保持，本轮没有重扫。

## P0-03 状态

阶段状态：**P0_03_PASS**。[独立总验收报告](../.local/p0-03/reviews/evidence/independent-final-acceptance-20261020-49c832b7/independent-review.md)已确认本期有限范围通过，文档收尾完成。通过范围为产品主库整理、商品身份标准、本批样表对应与人工决定保存、输出一致及历史可追溯；不代表全部产品资料已核实或后续接入与库存使用已实现。

- 规则唯一正文：[商品身份标准v1](./product-identity-standard-v1.md)，已同步当前事实与刷子后续保留要求；未修改已批准身份原则，未实现数据库唯一约束。
- [本轮任务](./tasks/p0-03/2026-10-20-final-acceptance.md)、[明确决定JSON](./p0-03/final-decisions-20261020.json)、[总验收报告](./p0-03/verification-report-p0-03-final-acceptance-20261020.md)。
- [唯一最终输出](../.local/p0-03/run-20261020-final-acceptance/evidence/final-2026-10-20T03-41-45-834059Z-cd7d4d19/delivery-final-v2/)，覆盖在其coverage/；首版delivery-final、再生和负向输出仅作证据，不是并列现行结果。
- 业务基线为最新已独立通过的JST交付，bundle SHA256 `3c2babc9b13ca11fab14cb4bbce5e8617052319d06bc80c922256f6893346159`、有效CSV `48544cd03154131970fce220fb2ff7c704e18d7860e2ea7c72e6a0ef1ac8d921`已核对。只继承该CSV，不重建桌面决定，不重跑匹配替换基线；新输出及决定哈希见报告。

已落实：菲越376/380/526三条WM0012确认升级普通版、解除版本待决、原目标不变，不计新增；JST WM0006/WM0008本批ignore且目标空，理由仅用户要求本批忽略；JST857行WM0130确认主库121行；BS菲越220/321两条WM0073新确认主库67行，当前confirm覆盖旧defer并保存历史。六项规格说明关闭：两项本批忽略，WM0031/WM0062/WM0098/WM0130采用主库C列，不改原名称/数值、不换算g/ml；WM0062 JST789行reject保持。刷子WM0081原62与brush原107行分列可见，继续待确认。

实际重算：126份主资料、125非空唯一ICE货号＋1缺码新品，1417来源（BS530/JST887）；548有效选择＝BS430＋JST118，较原545新增3；覆盖114双方/2仅BS/4仅JST/6双方暂无确认，有选择120份。774待核对、1候选、3拒绝、3忽略、88规则外；一般未核对775。原545目标/JST引用、原22条完整记录、原11JST确认、WM0007ignore、WM0070/WM0072 BS未建档、WM0072现价5.18/5.68及两版历史保持。8来源、9份总览审计/来源ID、216完整字段变化均可追溯；主资料业务字段未改。

当前菲越版本待决0、六项规格open0/closed6，指定业务决定全部落实。继续延期：WM0081与brush及5条BS刷子/1条JST候选不合并不猜绑；新品缺码、工厂/其他缺失、图片内容未核验、一般未核对及未涉及拒绝/规则外/纠错保持。图片128锚点、123份找到对象/3未找到不表示内容已核验或真实无图。BS70/72等待建档正常，不造来源或0库存。后续正式系统也须保留两份刷子及待确认状态，本轮只登记要求。

本轮执行实际重跑：136回归（原121＋15）、完整P0-03门禁、1417/126全量与所有保存投影、21组新业务负向＋原12组在新结果重跑、原16组在历史JST基线重跑、历史审计28/32与新44组负向、10图片测试、2审计CLI保护、6本地文件实际浏览器、147份逐字节再生成、lint/build及保护/文档/diff检查通过。完整命令和退出码在报告；初检失败、首版差异路径修复及既有openpyxl/NFT/Git提示保留，不把初检失败隐藏为全绿。

独立总验收实际重跑：136回归、1417/126全量及原545目标/JST引用/原22条/3160行CSV、21＋12＋16组业务负向、新44及历史28/32组审计负向、10图片测试、6本地文件浏览器、147份逐字节再生成、2审计CLI保护和范围/链接/diff检查均通过；另有19项冻结基线探针及原Excel OOXML逐格、逐份覆盖和仓库汇总核算。完整P0-03门禁、lint、build由独立审查仅核查执行日志，未独立重跑。本次文档收尾仅做链接、一致性及diff检查，未重跑功能测试，不与前两次验证混记。

历史独立通过保留：[主库整理](./p0-03/verification-report-p0-03-curation-20261019.md)、[四项确认](./p0-03/verification-report-p0-03-confirmations-20261019.md)、[两项审计说明补修](./p0-03/verification-report-p0-03-coverage-audit-repair-20261020.md)、[11条JST确认、WM0007忽略及BS未建档说明](./p0-03/verification-report-p0-03-jst-confirmations-20261020.md)及其[独立报告](../.local/p0-03/reviews/evidence/independent-jst-confirmations-20261020-dce89074/independent-review.md)。原CHANGES_REQUIRED、执行自验、独立重跑和仅日志核查各自保持，不改写成同一次检查。本轮此前停于P0_03_IMPLEMENTED_AWAITING_REVIEW，现依据独立总验收登记P0_03_PASS，不由过去分批通过推定整体结论。

后续方向：飞书表格识别新品；BS通常新品发出时建档，可以晚于主库/JST，BS匹配不以JST成功为硬前提；飞书接入方向获确认、BS考虑抓取、JST API可用性待核实。正式关系保存、自动复用、数量归集、组合/换款、库存同步和估值仍未实现且不在本批；不指定飞书全部字段为最终主数据源，不猜货号生成方式。

停止于**P0_03_PASS（文档收尾完成）**，上述已批准延期不阻塞本期有限范围验收；不要求所有商品同时具备两系统对应或全部空值补齐。全部旧报告/证据、原始资料、HOLD和其他未提交修改保留；neat-freak仅本次五份文档对齐，不清场、不写记忆。不入库、不接真实服务、不发布/同步库存、不提交/推送/合并/部署或推进下一阶段。

## P0-02 状态

| 项 | 状态 |
|---|---|
| 现役结论 | **`P0_02_PASS`**（独立审查 @ `9507d86`，2026-10-15） |
| 正式 PASS 报告 | [verification-report-p0-02-pass-20261015.md](./p0-02/verification-report-p0-02-pass-20261015.md) |
| 审查目录 | `.local/p0-02/run-20261014-r2/reviews/independent-p002-delivery-9507d86-20261015-01/` |
| Canonical Run | `run-20261014-r2` |
| 执行方总验收（历史） | `npm run check:p0-02` exit 0（`check-2026-10-15T07-07-04-252Z`） |
| Postgres 规模 | **18** vitest 文件 / **61** 项（**56** PG + **5** config） |
| Browser A3 | **21** 项 Playwright（check 子证据） |

**历史（非现役）：** d082728 审查 **CHANGES_REQUIRED** → 返工交付 **IMPLEMENTED_AWAITING_REVIEW** → 9507d86 独立审查 **PASS**。实施报告：[verification-report-r2-20261015-d082728-rework.md](./p0-02/verification-report-r2-20261015-d082728-rework.md)。

## P0-01 状态（保留）

**P0_01_PASS** · Run `run-20261013-r1`

opt6：**1 failed / 5 passed**（00051 换行，未改；全门禁已知固定豁免）。

## 阶段边界（2026-10-15 用户确认）

- **已完成：** 保留功能脱离 Supabase、本地虚构数据下的独立平台验收（**P0_02_PASS**）。
- **不迁移：** 不迁移旧 Supabase 业务数据，不沿用旧 SKU/商品映射（用户已确认，非延期项）。
- **后续：** 正式账号与权限重建、真实来源接入与用户重新匹配、生产启用；满足既定前置条件后删除旧 Supabase 环境。
- 详见 [product-plan-v4.md](./product-plan-v4.md) 与 [architecture-v3.md](./architecture-v3.md) 的 P0-02 后续方案节。

## 文档清理（2026-10-15）

已删除过时的 DIS 内网部署方案（commit `77b2c4d`，用户单独授权）。现役部署以 [architecture-v3.md](./architecture-v3.md) 与 P0-02 为准。
