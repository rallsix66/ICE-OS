# P0-03 — 样表匹配与人工核对（2026-10-15）

> 历史任务记录，非现役操作合同。2026-10-19 用户已收窄为主库整理与本批人工核对结果保存；当前边界、命令与停止点见 [最小返工任务](./2026-10-19-minimal-rework.md)。以下发布预览、自动/正式绑定资格及旧 XLSX 流程不适用于本轮。

状态：**IMPLEMENTED_AWAITING_REVIEW**

## 用户确认边界

1. 主资料：`Icelerskin 商品库1.xlsx`；G 列「聚水潭内部货号」= ICE 人工货号；H 列「69商品编码」按字符串保留。
2. BigSeller：`库存清单20261015083723474.xlsx`；聚水潭：`商品资料_20261015165159_200874071_1.xlsx`。
3. 首批库存闭环 **仅** BigSeller「DEE-龙仔厝（ICE专属）」+「单个SKU」；组合 SKU、其他仓库、聚水潭均为 `match_only`。
4. 重复货号/条码、规格冲突、一对多、组合 SKU → 仅候选 + 待核对；**不得**自动合并或写入正式映射。

## 禁止

- 生产启用、旧 Supabase 迁移、未授权真实写入、自动确认映射。

## 交付物

| 项 | 路径 |
|---|---|
| 匹配引擎 | `tools/p0_03_match/` |
| 生成候选 | `npm run p0-03:match` / `python -m p0_03_match match ...` |
| 验收 | `npm run check:p0-03` |
| 人工核对表 | `.local/p0-03/<run>/evidence/match-*/manual-review.xlsx` |
| 明细 JSON | `match-bundle.json`、`inventory-publish-preview-dee.json` |

## 人工核对流程

1. 打开 `manual-review.xlsx`（或 CSV）。
2. 对每条候选填写 `review_decision`：`confirm` / `reject` / `defer`（可留空表示仍待核对）。
3. 运行 `python -m p0_03_match apply-review --bundle match-bundle.json --review-csv <filled.csv> --output review-outcome.json`。
4. 带 `COMBO_SKU`、`ONE_TO_MANY`、主资料重复等标记的行，即使用户填 `confirm` 也不会进入 `formal_mapping_eligible`（P0-03 硬边界）。

## 验证

- `npm run check:p0-03`：单元测试 + 桌面三份样表实跑证据（输出在 `.local/p0-03/`，不入库）。
