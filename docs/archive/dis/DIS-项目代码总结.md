> 历史归档（2026-10-13）：原位置 `DIS-项目代码总结.md`。保留用于旧实现与验收追溯，不作为当前任务或执行授权；现役入口见 [归档索引](README.md)。

# DIS 项目代码总结（基于实读代码与文档，2026-07-13）

> 说明：本总结由只读审查得出，未修改 DIS 任何文件。信息来源 = 实际目录结构 + `CLAUDE.md` / `AGENTS.md` + `docs/` 四份核心文档（project-overview / architecture / current-state / database-design）+ 85 个测试文件分布 + 42 个 migration + `docs/design/dis-plans/` 下四份 v8 定稿实施方案与《实施总顺序方案》(v3)。**2026-07-13 已与 Codex 终审 v8 方案同步。**

---

## 一、一句话定位

DIS 是一个**国内外库存看板系统**：把中国 + 5 个海外仓（泰国/印尼/马来/菲律宾/越南）的库存、SKU 映射、在途物流，集中到一个后台里，让供应链运营团队一眼看清"哪里缺货、货到哪了、哪个 SKU 对应哪个标准产品"。

- **两类用户**：Admin（管产品/安全库存/SKU映射/权限/同步配置）、Operator（看库存与在途，维护被允许的记录）
- **明确不做**：完整进销存、WMS、财务结算、移动端。（边界收得很清楚，这点对防膨胀很重要）

---

## 二、技术栈

| 层 | 选型 |
|---|---|
| 框架 | Next.js 16（App Router）+ React 19 |
| 语言 | TypeScript **strict**（禁止 `any`） |
| 数据库/后端 | Supabase（PostgreSQL + Auth + RLS 行级权限） |
| 样式/组件 | Tailwind CSS 4 + shadcn/ui |
| 校验 | Zod（全链路输入校验） |
| 外部抓取 | Python 写的 BigSeller 页面抓取器 + 事务型 RPC |
| 部署 | Vercel / Next.js 平台能力（**正式部署平台尚未确定**） |

---

## 三、架构与分层（这是抗"屎山"的核心）

**强制数据访问链路**（写死在规则里，AI 不能乱穿层）：

```
页面/组件 → Server Action（写操作+Zod校验+权限校验）→ Repository 封装层 → Supabase → PostgreSQL RLS
```

关键纪律（来自 `CLAUDE.md` / `AGENTS.md`）：
- 页面/组件**禁止**直接调 `supabase.from()` 或任何云 SDK
- 云供应商（Supabase/Vercel）的能力必须集中在 `Repository` / `src/lib/` 封装里，业务层不绑定供应商专有类型
- 权限三重保障：路由保护 + Server Action 校验 + 数据库 RLS（前端隐藏按钮只是 UX，不是安全边界）
- **migration 只能新增、禁止修改已执行的**（避免改旧 migration 引发的连锁灾难）
- 双 AI 分工：**Claude 当主开发，Codex 当独立审查员**，每个任务完成后由 Codex 独立验收

> 大白话：这套规则相当于给 AI 画了"只能从这道门进、不能翻墙"的红线。bug 出现时，修改被强制关在小范围里，不容易扩散到别处。

---

## 四、业务数据模型

核心关系（双层模型，因为同一产品在不同国家 SKU 不同）：

```
Product（标准产品）
  └─ ProductVariant（各国仓库的 SKU）
        ├─ Inventory（某仓当前库存）
        └─ ShipmentItem → Shipment → TrackingEvent（在途物流轨迹）

Warehouse ── Inventory / Shipment / SyncLog
```

- 约 10 张核心表 + 外部物流轨迹表（百世/喜运达）+ 用户级偏好表（归档/关注）+ 仓库分配表
- 共 **42 个 migration**（数据库结构变更全部走 migration，append-only）
- 关键约束写得很死：`inventory(variant_id, warehouse_id)` 唯一、`quantity >= 0`、国家限定 TH/ID/MY/PH/VN/CN 等

---

## 五、功能模块清单

`src/features/` 下的业务域：

| 模块 | 职责 | 状态 |
|---|---|---|
| products | 标准产品 CRUD | ✅ 完成 |
| variants | ProductVariant SKU 映射 | ✅ 完成（匹配仍靠人工） |
| inventory | 海外库存页 / 低库存统计 | ✅ 完成（UX V2 已验收） |
| shipments | 手动创建/补录在途 + 批量入仓 | ✅ 完成 |
| in-transit | 在途物流（百世/喜运达外部轨迹） | 🟡 喜运达(P0)刚写完待验收；百世阻塞外部授权 |
| sync | BigSeller 海外库存同步（5 仓全跑通） | ✅ 完成（含并发锁、规则引擎、自动预审） |
| preferences | 用户级归档/关注（星标） | ✅ 完成 |
| warehouse-access | 仓库分配权限（Admin/Operator 隔离） | ✅ 完成 |
| dashboard | 首页看板（KPI/低库存/关注动态） | ✅ 基础完成，P7 将增强 |
| lib/providers | 云/物流商适配层（best 百世 / golucky 喜运达） | 🟡 喜运达新接入 |

---

## 六、测试与质量门（最强的安全网）

- **全量测试 3524 / 3524 通过，0 失败**（截至 2026-07-13，P0 完成后）
- 测试集中在风险最高的地方：**sync 模块 28 个测试文件**（含真 PostgreSQL 双事务并发锁测试）、shipments 15 个
- `npm run lint`：**0 errors**（约 25 个既有 warning，非阻塞）
- `npm run build`：Turbopack 构建通过
- 每个任务都有 **Codex 独立验收**记录（文档里大量 "Codex 独立验收通过"）
- ⚠️ 但：**没有 GitHub Actions 这类 CI 自动跑**——质量门目前是"手动运行"的（文档里的"自动化质量门"指手动跑测试脚本，不是 GitHub Actions 自动触发）。
- 不过新出的《实施总顺序方案》(v3) 补了一道**过程级强制门**：每个 Stage 必须 `Claude 实施 → Codex 独立验收 → 用户确认` 才能进下一 Stage，且每阶段都要过 `test / lint / build / git diff --check`，涉及 RPC/RLS 必须覆盖 Admin/Operator/未登录/停用/跨仓越权。这把"护栏通电"的责任交给了人和流程，比纯靠自觉强，但**仍依赖人记得跑、依赖你拍板放行**——全自动强制信号（CI）仍是缺口。

---

## 七、当前进度与下一步（已与 Codex 终审 v8 方案同步，2026-07-13）

权威实施方案已落到 `docs/design/dis-plans/`：四份功能方案全部 **v8 经 Codex 终审定稿**，由一份总纲（《实施总顺序方案》v3）统一编排。协作分工固定为 **巴蒂出方案 → Codex 评审 → Claude 落盘实现**，三层分离。

**严格串行关键路径（Stage 1 → 4）：**
```
P0 喜运达物流轨迹接入 → P1 预测式补货引擎 → P7 全球库存总览/作战室 → 首页决策看板
```

关键澄清（总纲 §0，避免误解）：
- **P0 → P1 是"用户确定的实施顺序"，不是计算依赖**。P0 只写外部轨迹表，不回写 `shipment.status` / `inventory` / `estimated_arrival`，不进入 P1/P7 的 V1 预测计算。先做 P0 只为减少后续并行变更冲突。
- **P1 → P7 → 首页 是真实技术依赖**：P1 建 `forecast_stockout` 与取数 RPC（`get_in_transit_detail` / `get_replenishment_suggestions`）；P7 依赖 P1 的 RPC 与共用预测函数；首页依赖 P1 取数 + P7 页面能力。首页不得穿插、不得并行快赢。

**Migration 预留（尚未在 Supabase 执行）：00038–00047**
```
00038–00040  P0 喜运达（A/B/C，顺序 A→B→C）
00041–00044  P1 补货引擎（A/B/C/D，D 依赖 A/B/C）
00045–00046  P7 总览（E 依赖 P1 C；F 依赖 P1 C+D）
00047       首页健康度 RPC
```
> 若实施时 00038–00047 已被占用，则整体顺延并同步记录；已执行 migration 禁止覆盖/重命名/修改。

**各 Stage 状态与验收门槛：**
| Stage | 方案 | 状态 | 专项验收条数 |
|---|---|---|---|
| Stage 1 P0 | 喜运达物流轨迹 API 接入 | 代码 2026-07-13 写完，走总纲门待验收 | — |
| Stage 2 P1 | 预测式补货引擎 | v8 定稿，待 P0 通过开工 | 74 条 |
| Stage 3 P7 | 全球库存总览/作战室（P7-A 基础总览 + P7-B 作战室增强已合并为单一产品） | v8 定稿，依赖 P1 | 61 条 |
| Stage 4 首页 | 决策看板重构（暗色主题已拆出本方案） | v8 定稿，依赖 P1+P7 | 59 条 |

**Stage 0 治理门（开工前必过）：** 检查 Git 状态；单独审查此前误修改的 `.claude/context-status.json` / `docs/current-state.md` / `docs/tasks/current-task.md`；确认 migration 当前最新实际编号；确认测试/lint/build 基线；不通过不进代码实施。

**每阶段强制质量门：** 对应专项测试 + `npm run test` + `lint` + `build` + `git diff --check`；不得删除旧测试凑数、不得改断言掩盖回归；涉及 RPC/RLS 必须覆盖 Admin/Operator/未登录/停用账号/跨仓越权。

**移出当前批次（未来路线）：** P8 国内库存接入、P7-C 国内补给判断——未单独立项与 Codex 评审前不实施，国内列保持 `data_unavailable` 占位（不用 0 模拟、不进可见总量与断货/补货计算）。

> 附：`inventory-ui-upgrade-plan.md` 仅作参考基线，**不单独实施**；四份功能方案以 v8 为准，字段/枚举/表结构以各方案正文为准（非推测）。

---

## 八、技术债务与已知限制（都已记录在档，非隐藏）

| 编号 | 债务 | 影响 |
|---|---|---|
| TECH-DEBT-01 | **国内库存缺失**（无数据源/模型/同步链路） | Dashboard 国内入口占位 |
| TECH-DEBT-02 | 国内生产周期缺失 | 无法算国内补给 |
| TECH-DEBT-03 | 运输周期只有仓级静态 30 天，无国家对级动态值 | 补货建议精度受限 |
| — | inventory 是当前值覆盖更新，**无历史快照** | 无库存趋势 |
| — | ProductVariant 匹配仍靠人工 | 未匹配 SKU 不进统计 |
| — | sync_log 仅仓库级，不记每条 SKU 变更 | 排错粒度粗 |
| — | **预览/生产环境尚未建立** | 还没真正上线跑 |
| — | **正式部署平台尚未确定** | 上线前需评估条款/兼容/成本 |
| — | 百世 API 账号权限未开通（P3-S1B 代码完成但阻塞） | 百世轨迹拉不下来 |

---

## 九、对你最初担心的直接判断

你担心"AI 全栈生成、自己不懂、将来 bug 修来修去变屎山"。基于实读代码，我的判断：

**✅ 架构本身是健康的，比大多数 AI 生成项目纪律性强得多**
- 分层清晰、边界写死、类型严格、权限三重、migration 不回改、双 AI 互相审查——这些都是"防扩散"的硬护栏。

**⚠️ 但有三个真实缺口，按严重程度排：**
1. **没有 CI 自动跑测试**（最该补）：GitHub Actions 这类全自动门还没配。新《实施总顺序方案》补了"Claude→Codex→用户"每阶段人工强制门，比纯自觉强，但**仍依赖人记得跑、依赖你拍板**——全自动强制信号（CI）仍是最大缺口。
2. **还没部署/没生产环境**：所有验证都在"构建+测试"层面，真实运行时的坑（权限、数据、并发）还没被生产流量逼出来。
3. **部分测试是"静态文本检查"**（查 migration 里有没有某行字），只能防误删，防不了逻辑写错。

**结论**：屎山风险不在"代码烂"，而在"没有自动化强制信号 + 未经历生产检验"。只要补上 CI、走完部署，配合你已有的架构纪律和双 AI 验收，单个 bug 被关在小范围修、坏了当场红，**扩散成屎山的概率很低**。

---

## 十、关键数字速查

- 源码规模：约 **29,500 行**（不含测试）
- 测试文件：**85 个**，全量 **3524 项通过**
- Migration：**42 个**（append-only）
- 海外仓：已跑通 **5 个**（PH/VN/TH/MY/ID）
- 质量门：lint 0 error / build pass / 双 AI 验收
- 当前阶段：四方案 v8 定稿（Codex 终审）+ 总顺序 v3 待 Codex 最终确认 → P0 喜运达待验收 → P1 补货引擎 → P7 总览 → 首页（严格串行 Stage 1→4，Migration 预留 00038–00047）
