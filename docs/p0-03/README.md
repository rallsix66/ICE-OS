# P0-03 样表匹配

本地产品主资料整理与样表核对工具；不写正式数据库，不发布库存，不定义长期绑定或自动复用。

- 现役任务：[../tasks/current-task.md](../tasks/current-task.md)
- 商品身份唯一标准：[../product-identity-standard-v1.md](../product-identity-standard-v1.md)
- 当前总验收：[verification-report-p0-03-final-acceptance-20261020.md](./verification-report-p0-03-final-acceptance-20261020.md)
- 独立结论：[P0_03_PASS](../../.local/p0-03/reviews/evidence/independent-final-acceptance-20261020-49c832b7/independent-review.md)
- 唯一最终交付：[delivery-final-v2/](../../.local/p0-03/run-20261020-final-acceptance/evidence/final-2026-10-20T03-41-45-834059Z-cd7d4d19/delivery-final-v2/)，含本轮coverage/；[明确决定](./final-decisions-20261020.json)
- 代码：`tools/p0_03_match/`
- 证据目录：`.local/p0-03/`（gitignore）

2026-10-20本期独立总验收已通过，状态为**P0_03_PASS**，文档收尾完成。范围为产品主库整理、商品身份标准、本批样表对应与人工决定保存、输出一致及历史可追溯。126份主资料含125个非空唯一货号及1份缺码新品，1417来源、548选择（BS430/JST118），覆盖114/2/4/6。菲越洗面奶版本及六项规格说明已按用户决定关闭。

执行自验、独立重跑和仅日志核查的明细见总验收报告；独立审查未重跑完整门禁、lint/build，仅核查执行日志。本次仅文档链接、一致性和diff检查，未重跑功能测试。两份刷子及候选、新品缺码、工厂/其他缺失、图片内容和一般未核对继续延期；WM0070/WM0072等待BS建档是正常状态。PASS不代表全部资料已核实或正式关系、真实接入、自动复用、数量归集、库存同步与估值已实现。文档收尾后停止，不提交、推送或推进下一阶段。

历史审计批次仅补图片对象与单元格空值说明及六项规格差异记录，见[审计补修报告](./verification-report-p0-03-coverage-audit-repair-20261020.md)与[旧覆盖报告](./verification-report-p0-03-identity-coverage-20261019.md)。当时继承四项确认交付、只读生成覆盖，不代表当前业务基线；旧报告、原CHANGES_REQUIRED、独立审查及全部证据保留。审计脚本支持显式基线与输入pins，当前可复现命令以总验收报告为准，不用旧批命令重建当前决定。

以下为历史实施工具说明，不用于重建本轮基线。

四项确认在 `tools/` 使用 `python -m p0_03_match confirm-sample --evidence <已通过的curation交付目录> --decisions <明确本批决定JSON> --output <新的空目录>`。决定源为 [business-confirmations-20261019.json](./business-confirmations-20261019.json)，校验指定bundle与 `manual-decisions.effective.csv` 哈希，再继承有效决定；不回退桌面原CSV，不重跑商品匹配。新决定追加事件，派生新的有效CSV，不覆盖历史来源。

四项确认交付当时的历史：WM0072只选现价5.18/5.68（原216行），不替换整行，原66/216及两版价格保留，不开展估值；当时JST候选未自动确认，菲越三条WM0012版本仍待核对。后续JST明确确认及本轮升级款确认已落实，当前状态见总验收报告，不沿用上述历史待决。原始资料、历史bundle、纠正记录和哈希均保留；`apply-review`重应用时重新生成主资料总览和有效统计，当前reject/ignore/clear/defer始终优先于历史确认。

上一轮主库整理用 `curate-sample --evidence <当轮明确基线目录> --review-csv <当轮明确CSV> --corrections <当轮纠正JSON> --output <新的空目录>`，其[纠正记录](./curation-decisions-20261019.json)和[独立通过报告](./verification-report-p0-03-curation-20261019.md)保留作历史；不能用原CSV重新生成来替代当前有效决定。

新批次只认本批具体来源和目标的授权；印尼个别泰版例外不扩为仓别通用规则。JST没有市场字段，不套BigSeller仓别约束。历史规则和报告按当时状态保留，不能作为下次导入复用关系的依据。
