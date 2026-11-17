# 操作记录 v1（R4 收尾 + 日期还原 + 整页系统样式统一）

- 日期：2026-11-17
- 分支：`codex/operations-log-v1`（承接 `e3b3466` + `880a66b` + `2660a82`）
- 实例：`run-20261026T211500Z-11a22b33`（Web 3011 / PostgreSQL 59345；PG pid 40076，preview pid 50072）
- 入口：<http://127.0.0.1:3011/dashboard/operations>
- 登录：`admin@catalog.test`（密码见实例 `login.local-preview.txt`，不入 Git）
- 最终 BUILD：**`C7jyVlverZoBnOnYAcJ72`**
- 源码快照：**`a47ba1d2e469c1b0ed3da84fdc6fc91a43b3a34824a7e54ea2daacdff2befaa2`**（与运行构建一致）
- 证据：`.local/catalog/operations-log-r4-20261117/`（`verify-r4.json`、截图 `r4-01`–`r4-12`、`style-compare-1440.png`、`style-compare-760.png`）

本轮执行最终指令 V4：**日期恢复原方式、整页统一系统样式、保留 R1–R5 业务修复**。只撤回上一轮新增的日期范围面板，不回滚整次提交。最终是否通过由审查方确认，执行方不宣布 PASS。

## 1. 日期恢复为原来的方式

### 1.1 使用方式

- 恢复“开始日期 / 结束日期”两个独立原生单日控件，直接使用系统日期选择弹窗；没有页面内日历、没有快捷范围、没有“应用 / 取消”。
- 选择或清空任一侧日期立即写回 URL（`replace`，不新增历史），页码回到第 1 页。
- 保留 `max/min` 交叉约束；开始晚于结束时仍显示提示、不查询、不显示 0 条。
- 日期仍按北京时间 +08 自然日查询，结束日包含当天；单边日期、URL、刷新、返回、详情返回能力不变。
- 只优化控件外观：与搜索框 / 账号下拉同高 40px、同 10px 圆角、同边框与字号；标签“开始日期 / 结束日期”放在控件内，两个控件与破折号成组对齐。

### 1.2 撤回与清理

| 上一轮新增 | 本轮处理 |
| --- | --- |
| `src/features/operations/components/date-range-picker.tsx` | 删除 |
| `src/features/operations/date-range.ts` | 删除 |
| `src/features/operations/date-range.test.ts` | 删除 |
| `operations.module.css` 日历面板 / 触发器 / 快捷范围样式 | 删除 |
| `package.json` / `package-lock.json` 的 `react-day-picker@10.0.2`、`date-fns@4.1.0` | 移除（其他代码未使用） |

上一轮关于 `resetOnSelect` 与月份箭头的 B1/B2 补修要求随日期面板撤回而取消，不再实施。

## 2. 整页统一系统样式

以现役「商品库存」为主要视觉参照，结合「商品库」「物流在途」的共用数据面；所有控件优先复用系统组件与 CSS module。

| 区域 | 本轮做法 | 复用的系统资源 |
| --- | --- | --- |
| 标题 | `PageHeading`：20px / 650 字重；下方一句“时间：北京时间”；右侧状态点“只读” | `PageHeading`、`StatusDot` |
| 记录说明 | 标题下轻量一行，默认收起；展开为浅色说明块 | 系统字号/边框/圆角变量 |
| 业务页签 | 与库存“仓库明细 / 商品汇总 / 历史快照”同一分段控件（3px 底、10px 圆角、选中白底）；计数用 11px 浅灰 | 与 `inventory.module.css` `.viewTabs` 同值 |
| 工具栏 | 搜索 → 账号 → 开始日期 → 结束日期 → 清空 → 总数，同一行；窄屏自动换行 | `surface.toolbar`、`SearchField`、`SelectMenu`、`surface.button`、`surface.count` |
| 日期 | 两个原生 `input[type=date]`，40px 高，与搜索/下拉同圆角同焦点样式 | 系统表单与焦点样式 |
| 列表 | 面板固定高度、表头固定、列表内部滚动；表头 #f8f9fb / 11px；行 11×14px 内边距；长名称/货号/结果自然换行；展开行左侧靛蓝强调 | 与库存/在途面板同边框、10px 圆角 |
| 状态标签 | 动作继续用系统 `Pill`，与外层元信息同一行，减少一行高度（行高约 70px） | `Pill` |
| 展开详情 | 事实网格 → 字段变化表 → 商品/货票 → 入口 → 说明；变化表固定列宽；数量多时 20 条一段；来源信息使用系统折叠组件 | `Disclosure`、`surface.buttonSmall` |
| 分页 | 面板底部固定分页条；分页按钮、当前页、信息文字全部用系统共用样式 | `surface.pager`、`surface.pageBtn` |
| 提示信息 | 日期反向用系统暖色提示条；读取失败用系统红色提示条；空态用 `EmptyState` 并居中于面板 | `EmptyState`、`surface.button` |

实测对照（1440，浏览器 computed style）：

| 项目 | 操作记录 | 商品库存 |
| --- | --- | --- |
| 标题 | 20px / 650 / `rgb(39,50,68)` | 20px / 650 / `rgb(39,50,68)` |
| 正文 | 13px / 20.8px 行高 | 13px / 20.8px 行高 |
| 页签底 | `rgb(241,243,248)` / 10px 圆角 / 38px 高 | 同左 |
| 选中页签 | 白底 / `rgb(49,68,155)` / 8px 圆角 / 32px 高 | 同左 |
| 控件高度 | 搜索/账号/日期/清空均 40px | 搜索/清空 40px |
| 面板 | 10px 圆角 / `rgb(228,231,236)` 边框 / 白底 | 同左 |
| 表头 | `rgb(248,249,251)` / 11px / 浅灰字 | 同左 |
| 分页 | 面板内部底栏，系统 pager | 同左 |

## 3. 保留的 R1–R5 业务修复

- **R4 撤销 vs 替代**：只有存在 `restore_duplicate_source_decision` 审计的来源行选择才显示“撤销”；原决定保留决定时间，并显示撤销时间/账号，撤销独立成条。正常改选只把旧决定标为 `superseded`，原记录显示“已被后续选择替代”、时间写“替代时间”、给后续选择行号，不虚构撤销账号、不另造撤销记录；字段口径被新口径替代同样写“替代”。
- **R1 字段差异**：修订差异按新旧字段键并集比较，WM0073 第 3 版仍显示 `757577407359 → 已移除`、上一版本第 2 版。
- **R2 搜索覆盖**：同一次关联搜索覆盖全部货号/名称/来源 SKU/货票号，POKNZX027675 七款分别搜索都命中同一条 7 明细。
- **R3 批次可达**：4173 批次 94 款全部可达，20 款一段，第 41 款 WM0054 可看。
- **R5 计数**：全部业务 = 三类之和 **365**（商品资料 **152** / 库存对应 **100** / 物流 **113**）；读取失败、日期无效显示“—”，不冒充 0 条。
- **来源品名 vs 关联商品**：物流明细写“来源品名：WM0057 CHIC PEAK 腮红4.8g-M07”，下一行写“关联商品：WM0090 · CHIC PEAK 腮红4.8g-M07”，并说明同一条来源品名可能对应不同货号；列表摘要显示“7 条明细 · 关联 7 款商品”。

本轮没有修改 `db/catalog/042_operation_records.sql`，也没有改动任何写入链；R1–R5 的数据口径与上一轮一致。

## 4. 验证（执行方自验，不代表 PASS）

### 4.1 页面与样式 **38/38**

`verify-r4.mjs` → `verify-r4.json`，console/pageerror 0：

- 页头标题、单一“时间：北京时间”、只读状态、记录说明默认收起；
- 两个原生日期控件、无日历/快捷范围/触发器；日期两个控件 40px；搜索/账号/清空 40px；
- 顺序与库存页一致：类别页签 → 工具栏 → 列表面板；
- 标题/正文/页签/控件/面板/表头/分页与商品库存 computed style 一致；
- 列表首屏 50 条、行高约 70px；分页在面板内且首屏可见；滚动到末尾分页仍固定；
- 开始日期即查：从 `2026-11-10` 起 **26** 条；加结束 `2026-11-16` 仍 **26** 条（本来都在当天）；同一天 `11-10` **23** 条；只填结束 `11-10` **362** 条，均与数据库 +08 查询一致；
- 刷新保留日期与结果；清空恢复 365 条；日期反向显示提示且不查询；
- 类别+关键词+日期（商品资料 / WM / 10-01 至 11-17）**133** 条，与数据库一致；第 2 页保留全部筛选；
- 展开 → 商品资料 → 返回，URL 与第 2 页保留；货票入口 → 返回保留筛选；
- R4 撤销/原决定、物流来源品名/关联商品、94 款批次、R5 计数回归通过；
- 1440 无整页横向溢出；760 无横向溢出，日期控件 `w=197,h=40` 完整可见，面板/页签/分页不裁切；760 页高 991 与商品库存 991 完全一致（外壳把导航置顶后两者同一档），展开详情可读；
- 业务行数前后一致；console/pageerror 0。

### 4.2 布局实测

| 视口 | 结果 |
| --- | --- |
| 1440×950 | 面板 `x=240,y=314,w=1168,h=635`；分页 `y=902,h=46`，首屏可见；无横向溢出 |
| 760×900 | 日期 `x=23,w=197` 与 `x=244,w=197`，均高 40；面板宽 714 不溢出；页高 991 与商品库存相同；无横向溢出 |

### 4.3 定向测试与静态检查

- `model.test.ts` **36/36**、`navigation-config.test.ts` **7/7**，共 **43/43**；
- `tsc --noEmit` 仅既有 BEST 5 条（`src/lib/providers/best/__tests__/*`），`src/features/operations` 0 条；
- `src/features/operations` eslint 0；
- `git diff --check` 无空白错误（仅既有 LF/CRLF 提示）；
- 未重跑无关全仓套件；上一轮已通过的数据证据继续沿用（`apply-042` 40/40、真实改选 5/5、365 计数）。

### 4.4 截图

桌面：`r4-01-overview-1440.png`（首屏）、`r4-03-date-filter-1440.png`（开始+结束日期）、`r4-04-range-error-1440.png`（反向提示）、`r4-05-list-1440.png`（展开与分页）、`r4-06-r4-revocation-1440.png`（R4 撤销）、`r4-07-association-1440.png`（来源品名/关联商品）、`r4-08-batch-94-1440.png`（94 款批次）、`r4-09-list-scrolled-1440.png`（分页固定）。

窄屏：`r4-10-list-760.png`、`r4-12-detail-760.png`。

样式对照：`style-compare-1440.png`（操作记录 vs 商品库存）、`style-compare-760.png`；原始参照 `r4-02-compare-inventory-1440.png`、`r4-11-compare-inventory-760.png`。

## 5. 改动文件

| 文件 | 本轮改动 |
| --- | --- |
| `src/features/operations/components/operations-filters.tsx` | 恢复两个原生日期控件；工具栏改用 `surface.toolbar`；总数移到工具栏 |
| `src/features/operations/components/operations-view.tsx` | 系统页头/页签/面板/分页结构；说明轻量；动作与元信息同一行；空态居中 |
| `src/features/operations/components/operation-record-detail.tsx` | 来源信息改用系统 `Disclosure`；小按钮改用共用样式 |
| `src/features/operations/components/operations.module.css` | 按系统变量重写整页样式；删除日历面板样式；760 重排 |
| `src/features/operations/components/date-range-picker.tsx` | 删除 |
| `src/features/operations/date-range.ts` / `date-range.test.ts` | 删除 |
| `package.json` / `package-lock.json` | 移除 `react-day-picker`、`date-fns` |
| `docs/tasks/operations-log-v1.md` / `docs/tasks/current-task.md` / `docs/current-state.md` / `AGENTS.md` / `docs/README.md` | 本轮记录 |

## 6. 边界

- 本轮只改操作记录页与日期控件，没有修改 042 查询、R1–R5 语义或其他模块；未新增/删除业务数据。
- 现役零业务写入；未启动库存/物流/飞书后台 worker；未改飞书与各模块写入链。
- 未提交/推送/部署此前未纳入的 Mac 部署准备改动；`pnpm-lock.yaml` 属于工作区既有未提交部署准备，`package-lock.json` 已同步；`.local/` 证据不入 Git。
- 未做 200% 缩放、完整权限矩阵、长期多日稳定性；760 下端到端仅有约 91px 纵向滚动，与商品库存同一外壳行为。
- 最终结论由审查方给出，执行方不宣布 PASS。
