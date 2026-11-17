# 操作记录 v1（R4 收尾 + 日期范围选择器 + 第二轮 UI）

- 日期：2026-11-17
- 分支：`codex/operations-log-v1`（承接已审查提交 `e3b3466` + `880a66b`）
- 实例：`run-20261026T211500Z-11a22b33`（Web 3011 / PostgreSQL 59345；PG pid 40076，preview pid 10688）
- 入口：<http://127.0.0.1:3011/dashboard/operations>
- 登录：`admin@catalog.test`（密码见实例 `login.local-preview.txt`，不入 Git）
- 最终 BUILD：**`VzVOTmdMgVQD2xOh5lKba`**
- 源码快照：**`410844eb0980c0cc98574109df1468c2214f51dd44832e3373387505bcbb77d3`**（与运行构建一致）
- 证据：`.local/catalog/operations-log-r3-20261117/`（`verify-r3.json`、`real-reselect.json`、`apply-042*.json`、截图 `r3-01`–`r3-09`）

本轮把 R4 剩余语义、日期范围选择器与整页 UI 作为一个交付包完成；最终是否通过由审查方确认，执行方不宣布 PASS。

## 1. R4：撤销与正常改选分开

### 1.1 真实撤销（现役数据）

现役 4 条来源行选择（WM0069 / WM0070 / WM0071 / WM0073）和 1 条字段口径（LS101501）都有明确撤销事实：

- 原决定发生在 **2026-11-10 12:36:38**；撤销发生在 **2026-11-10 14:44:50**（+08）。
- 原决定记录仍保留在决定时间，摘要、当前状态、时间字段、详情统一写“已撤销”；详情显示撤销时间与撤销账号（来自 `restore_duplicate_source_decision` / `restore_source_field` 审计）。
- 撤销是独立记录：动作徽标“撤销来源行选择 / 撤销字段人工口径”，结果写“撤销来源第 128 行选择；该选择不再生效。”，不再写“重新回到待处理”这类没有保存依据的状态。
- 一条决定只对应一条撤销记录：同一决定存在两条审计（撤销 + 重建事项修正）时也只取一条，不重复计数。
- 来源行比较改用“来源行差异 / 其他来源行 / 采用行”，不再把来源行比较写成商品字段的“修改前 / 修改后”。

### 1.2 正常改选（不写成撤销）

正常改选的实际流程是：旧选择被替代 → 新选择生效 → 事项解决。042 现在按“是否存在撤销审计”区分：

- 只有 `restore_duplicate_source_decision` 审计存在时，才在 042 第 14 段生成“撤销来源行选择”独立记录；
- 正常改选只把旧决定标为 `superseded`，不写撤销审计：原记录显示“已被后续选择替代”，时间字段写“替代时间”，详情写“后续选择：第 N 行（时间）”，不显示撤销账号；
- 新决定仍是另一条 `duplicate_source_decision`（`state=active`），摘要写“已选择来源第 N 行资料”；
- 原记录与新记录合起来表达完整过程，不再为正常改选另造“撤销”记录；
- 字段口径被同一商品同一字段的新口径替代时，写“已被后续字段口径替代”，不写撤销。

### 1.3 验证方式与边界（重要）

- **真实业务函数事务探针**：`real-reselect.mjs` 在同一个事务内调用 `catalog.decide_product_source_duplicate_row` 两次（WM0069 第 63 行 → 第 127 行），再调用 042 查询，最后 **ROLLBACK**。结果：旧决定 `superseded`、`revoked=false`、替代行号 127；新决定 `active`；没有撤销记录。**5/5**。
- **查询投影探针**：`apply-042.mjs` 在 SAVEPOINT 内直接插入一条“正常改选”旧决定 + 新 active 决定，验证查询投影，随后回滚。它验证的是投影，不是完整业务写入链。
- **边界**：上述两个探针都没有提交，不能表述成“现役完整正常改选写入链已验证”。现役库也没有可展示的正常改选样本；4 条现役来源行选择都是明确撤销。页面上的正常改选语义由模型单测 + 查询投影 + 真实函数事务探针共同覆盖。
- 上一轮 `fixtures.mjs` 通过直接插入构造记录后查询，只能证明“事务内构造记录的查询投影与回滚”，本轮文档按此修正，不再把它写成完整正常业务写入链。

## 2. 日期范围选择器

新增职责清楚的客户端组件：

- `src/features/operations/date-range.ts`：纯日期计算（北京时间今天、严格 `YYYY-MM-DD` 校验、自然日加减、触发器文案、近 N 天）。
- `src/features/operations/components/date-range-picker.tsx`：触发器 + 页面内日历面板。
- 日历底层使用成熟组件 **`react-day-picker@10.0.2`**（`date-fns@4.1.0`），不引入库自带样式表；通过 `classNames` 映射到本页 CSS module，沿用 ICE v4 的靛蓝、圆角、边框和字号。

交互：

1. 工具栏只有一个“日期范围”触发器：未筛选显示“日期不限”；完整范围显示“YYYY-MM-DD 至 YYYY-MM-DD”；仅开始显示“自 YYYY-MM-DD 起”；仅结束显示“截至 YYYY-MM-DD”；同一天显示“YYYY-MM-DD（单日）”。
2. 点击打开页面内日历：中文年/月（“2026年”“11月”）、星期、今天/选中/区间起点/区间中间/区间终点样式；年/月下拉可定位历史月份，左右按钮可翻月。
3. 面板内是待应用范围：选择日期只改输入与日历，不刷新页面；点“应用”才一次更新 URL。取消、Esc、点击外部都保留上一次已应用范围。
4. 起止日期也可直接输入 `YYYY-MM-DD`，不再调用任何系统日期弹窗；非法格式或开始晚于结束在面板内提示并保留输入。
5. 近 7 天 / 近 30 天 / 不限日期只写入待应用值，与手动选择一样点“应用”生效。
6. 按北京时间 +08 自然日筛选，结束日期包含当天；应用后保留关键词、账号与类别，页码回到第 1 页。
7. URL、刷新、浏览器返回、重新打开面板都与已应用范围一致；打开时定位到已选日期，没有选择时定位当前月份。
8. 面板 portal 到 `body` + fixed 定位，桌面和 760 宽都完整可见，不被工具栏/页面容器裁切，不撑宽页面。
9. 键盘：打开后焦点进入日历（已选日期或今天），方向键选日、Enter 选日、Esc 关闭并回焦触发器，Apply 可 Tab 聚焦后 Enter 应用。

## 3. 第二轮整页 UI

- **顶部**：“记录说明”改为标题附近的轻量文字入口，默认不占整条卡片；展开才显示说明。页面只保留一句“时间：北京时间”，移除了同义的 +08 长句。
- **筛选**：搜索为主控件，账号、日期范围、清空同组；宽屏四列，900 以下搜索独占一行、账号/日期/清空在第二行，620 以下两组换行。搜索、账号、日期、清空统一 40px 高。
- **类别与结果**：类别页签与“共 N 条 · 按处理时间倒序”合并在一行；不再重复“全部业务”标题；分页只写“第 x–y 条 · 第 x/y 页”，不重复总数。
- **列表**：去掉每行重复的分类文字；动作标签紧凑；对象、结果仍为主层级；长名称/完整货号/重要结果自然换行；悬停、键盘焦点、展开分别有背景/左侧强调条。
- **详情**：移除摘要与展开区重复的同一段结果句；展开先给事实、字段变化和明细；顶层变化表固定列宽，商品变化与商品/库存入口放在同一明细；批次号/请求号/哈希继续收在折叠的“来源信息”；大批次仍 20 款一段、显示进度、可继续或全部显示。
- **来源品名 vs 关联商品**：物流明细标题写“来源品名：…”，下一行写“关联商品：WM0090 · …”，并说明“来源品名保留原始表名称；关联商品是保存后的正式商品；同一条来源品名可能对应不同货号”。列表摘要显示“7 条明细 · 关联 7 款商品”，不再重复货票号。

## 4. 记录总数与真实样例

合计仍 **365 条**（商品资料 **152** / 库存对应 **100** / 物流 **113**），与数据库独立重算一致。本轮没有新增/删除业务记录。

- R4 现役样本：WM0069 原决定 12:36:38 + 独立撤销 14:44:50；LS101501 原决定 12:36:38 + 独立撤销 14:44:50。
- R2 七款样本仍为 POKNZX027675 同一条人工关联、7 条明细；R1 WM0073 第 3 版仍显示 `757577407359 → 已移除`；R3 4173 批次仍 94 款，WM0054 位于第 41 款；R5 全部业务仍 365。

## 5. 查询与准备链

`db/catalog/042_operation_records.sql` 仍只有一个只读函数：

```sql
catalog.read_operation_records(
  p_category text, p_actor uuid, p_from timestamptz, p_to timestamptz,
  p_search text, p_limit integer, p_offset integer
) RETURNS jsonb
```

本轮变化：

1. 来源行决定详情补 `revoked/revokedAt/revokedByName/replacementRowNumber/replacementAt`；
2. 第 14 段只在存在 `restore_duplicate_source_decision` 审计时生成撤销记录；
3. 正常改选不另造撤销，替代行按同一 profile/code 的下一条决定（优先 active）解析；
4. 字段口径 superseded 与 revoked 继续沿用已保存的 `superseded_at` / `revoked_at`；
5. 注释同步说明“正常改选不是撤销”。

`apply-042.mjs --rollback` **40/40**、`--commit --allow-live-commit` **40/40**。两次安装幂等、权限、未登录拒绝、全量 365 = 独立重算、分类计数、排序、id 唯一、三类真实样例、R1–R5 定向、正常改选投影、业务行数前后不变、rollback 回到安装前。

## 6. 验证（执行方自验，不代表 PASS）

### 6.1 页面 **47/47**

`verify-r3.mjs` → `verify-r3.json`，console/pageerror 0：

- 首屏轻量说明、单一“时间：北京时间”、无原生日期输入；
- 搜索/账号/日期/清空同组且 40px；日历打开、中文年月/星期、今天焦点、范围选中、应用 URL、结果数与 DB 查询一致（26 条）；
- 取消/外部点击/Esc 回焦、键盘方向键+Enter、同一天、单侧范围、非法格式、起止反向、近 7 天、年/月切换；
- R4：真实撤销记录、原决定“已撤销”+撤销时间/账号、来源行差异列名；字段撤销与原决定对照；
- 物流来源品名/关联商品、列表不重复货票号；
- R1/R2/R3/R5 关键回归；
- 日期+关键词+类别+第 2 页 → 展开 → 商品 → 返回，URL 与第 2 页保留；货票入口返回保留筛选；
- 1440 无整页横向溢出；760 无溢出、控件同高、日历面板完整可见（`x=282,y=358,w=368,h=530`，视口 760×900）；760 展开可读；
- 业务行数前后一致（audit 42 / revisions 233 / inventory_audit 4285 / grouping 3 / duplicate_decision 4）。

### 6.2 真实改选事务探针 **5/5**

`real-reselect.mjs` → `real-reselect.json`：

- 第一次真实 RPC 写入 active 决定；
- 第二次真实 RPC 写入新 active 决定；
- 业务表旧决定 superseded、新决定 active、无撤销审计；
- 042 查询旧决定 `revoked=false`、`replacementRowNumber=127`、无撤销记录；新决定 active；
- 回滚后现役无新增 active 决定。

### 6.3 迁移与准备链

- `apply-042` rollback **40/40**、commit **40/40**；
- 现役业务行数前后一致：audit_event 42 / item_revision 233 / source_batch 3 / duplicate_decision 4 / field_decision 9 / inventory_audit 4285 / sku_mapping 517 / association_revision 200 / manual_revision 5 / grouping_review 3 / grouping_override 1；
- 准备链代码未改：`prepare-instance.mjs` 在 041 后安装 042，`prepare-local-preview.mjs` 的 `DEPENDENT_SQL` 仍包含 042。

### 6.4 定向测试与静态检查

- `date-range.test.ts` 6 + `model.test.ts` 36 + `navigation-config.test.ts` 7 = **49/49**；
- `tsc --noEmit` 仅既有 BEST 5 条（`src/lib/providers/best/__tests__/*`），`src/features/operations` 0 条；
- 改动文件 eslint 0；
- `git diff --check` 无空白错误（仅既有 LF/CRLF 提示）；
- 本轮只改操作记录页面、日期组件、042 与依赖，不重跑无关全仓套件；上一轮全仓基线 942/943 不写成本轮新结论。

### 6.5 截图

`r3-01-overview-1440.png`（桌面首屏）、`r3-02-calendar-open-1440.png`（日历打开）、`r3-03-calendar-range-1440.png`（区间选中）、`r3-04-r4-revocation-1440.png`（R4 原决定/撤销）、`r3-05-association-detail-1440.png`（来源品名/关联商品）、`r3-06-batch-94-1440.png`（94 款批次）、`r3-07-calendar-760.png`（窄屏日历）、`r3-08-list-760.png`（窄屏列表）、`r3-09-detail-760.png`（窄屏展开）。

## 7. 明确没有保存 / 本机没有记录

1. **现役正常改选样本**：没有；4 条来源行选择都是明确撤销。正常改选由真实函数事务探针 + 查询投影 + 模型单测覆盖，未提交到现役库。
2. **重核、停用、原 SKU 替换**：现役 0 条；替换路径沿用上一轮隔离样例。
3. **撤销分合票决定**：现役 0 条；字段/来源行撤销有真实样本。
4. **字段覆盖前的本地值、首版前值**：未保存；页面不拿当前商品补。
5. **inventory_audit 请求号/理由、物流关联请求号**：未保存；页面不展示不存在的字段。
6. **具体操作人**：记录账号只代表写入账号；分合票无法反查具体操作人。
7. **4 条同号选择的背景**：脚本代选后撤销，页面用已保存备注原样说明。
8. **自动同步事件**：不进入本页。

## 8. 改动文件

| 文件 | 本轮改动 |
| --- | --- |
| `db/catalog/042_operation_records.sql` | 撤销审计判定、正常改选详情、替代行解析、注释 |
| `scripts/catalog/apply-042.mjs` | 期望总数按撤销审计、原决定撤销断言、正常改选投影、证据 |
| `src/features/operations/date-range.ts` | 新增：纯日期计算与校验 |
| `src/features/operations/date-range.test.ts` | 新增：6 条日期单测 |
| `src/features/operations/components/date-range-picker.tsx` | 新增：日历面板、触发器、键盘、portal |
| `src/features/operations/model.ts` | 撤销/替代语义、字段口径替代、来源行差异列名、来源品名/关联商品、结果去重、商品入口去重 |
| `src/features/operations/model.test.ts` | 36 条（新增正常改选/撤销/字段替代/来源品名） |
| `src/features/operations/components/operations-view.tsx` | 轻量说明、筛选/页签/结果合并、列表密度、去分类文字 |
| `src/features/operations/components/operations-filters.tsx` | 日期组件接入、输入关键词随日期应用保留 |
| `src/features/operations/components/operation-record-detail.tsx` | 去掉重复结果句、变化表列名/标题 |
| `src/features/operations/components/operations.module.css` | 日历面板、工具栏网格、列表/详情密度、760/620 重排 |
| `package.json` / `package-lock.json` | 新增 `react-day-picker@10.0.2`、`date-fns@4.1.0` |
| `docs/tasks/operations-log-v1.md` | 本记录 |

## 9. 边界

- 现役零业务写入；`real-reselect.mjs` 与 `apply-042` 的正常改选投影都在事务内 ROLLBACK；
- 不把事务探针写成“完整正常改选业务写入链已验证”；不把构造投影写成真实业务样本；
- 未启动库存/物流/飞书后台 worker；
- 未改飞书、未改各模块写入链、未新增业务表；
- 日期组件新增两个前端依赖；`pnpm-lock.yaml` 属于工作区既有未提交部署准备，未随本包提交；`package-lock.json` 已同步；
- 未做 200% 缩放、完整权限矩阵、长期多日稳定性；
- 工作区中的 Mac 部署准备改动保留未提交；`.local/` 不入 Git；
- 最终结论由审查方给出，执行方不宣布 PASS。
