# P0-03 交付验证报告（样表匹配）

> 历史自验记录（仅代表当时）。本轮现役结论见 [2026-10-19 最小返工报告](./verification-report-p0-03-rework-20261019.md)。原始 217 行计数包含 85 行空白，不代表 217 个商品；本批现役来源为聚水潭合并 887 + BigSeller 530 = 1417 条。以下旧资格字段及发布预览不适用于本轮。

日期：2026-10-15  
状态：**IMPLEMENTED_AWAITING_REVIEW**（执行方自验；待独立审查会话复核）

## 范围核对

| 用户决定 | 实现 |
|---|---|
| 主资料 `Icelerskin 商品库1.xlsx`，G=ICE 货号，H=69 条码字符串 | `load_master()` + `normalize.as_string()` |
| BigSeller + 聚水潭与主库匹配候选 | `build_match_bundle()` |
| 库存发布仅 DEE + 单个SKU | `scope=inventory_publish` 143 行 |
| 冲突/组合/一对多仅待核对 | 全部 `auto_confirm_forbidden`；`apply-review` 拒绝冲突行 `formal_mapping_eligible` |
| 本地隔离 | 证据在 `.local/p0-03/`（gitignore）；无 DB 写入 |

## 自验命令

```text
npm run check:p0-03
```

结果：**exit 0**（2026-10-15）

- Python unittest：7 passed  
- 实跑三份桌面样表 → 证据目录  
  `D:\try one\ICEOS\.local\p0-03\run-20261015-r1\evidence\match-2026-10-15T09-19-58-029Z`

## 匹配汇总（实跑）

| 指标 | 值 |
|---|---|
| 主资料行 | 217 |
| 来源行合计 | 3146 |
| 主资料质量问题 | 13（重复货号 6 组、重复条码 7 组等） |
| `pending_review` | 1706 |
| `unmatched` | 1440 |
| `inventory_publish`（DEE 单 SKU） | 143 |
| `match_only` | 3003 |

标记计数（可叠加）：`COMBO_SKU` 1739，`ONE_TO_MANY` 946，`MANY_TO_ONE` 743，`UNMATCHED` 1440，等。

DEE 发布预览 **143** 行：`pending_review` **122**，`unmatched` **21**（见 `inventory-publish-preview-dee.json`；须人工核对后才会进入后续发布链）。

## 交付文件

| 类型 | 路径 |
|---|---|
| 引擎 | `tools/p0_03_match/` |
| 脚本 | `scripts/p0-03/run-match.mjs`, `run-check.mjs` |
| 任务包 | `docs/tasks/p0-03/2026-10-15-sample-matching.md` |
| 人工核对表 | 证据目录内 `manual-review.xlsx` / `manual-review.csv` |
| 明细 | `match-bundle.json`, `input-manifest.json` |

## 人工核对（审查方可复现）

1. 打开证据目录内 `manual-review.xlsx`。  
2. 填写 `review_decision` / `review_notes`。  
3. `cd tools && python -m p0_03_match apply-review --bundle <match-bundle.json> --review-csv <filled.csv> --output review-outcome.json`

## 未做（符合边界）

- 未写入 PostgreSQL / 未确认正式 `mapping`  
- 未扩大至 DEE 以外仓库库存发布  
- 未接入聚水潭 API  

## 待独立审查确认

- 匹配规则是否覆盖业务期望的 SKU 形态（如 `WM0110-P07` 与主资料货号口径）  
- 主资料 13 项质量问题处理策略（合并/停用/修订）由用户业务决定，非本工具自动处理  
