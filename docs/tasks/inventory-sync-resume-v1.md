# INVENTORY_SYNC_RESUME_V1 — 恢复 BigSeller 库存持续更新（本机实例）

日期：2026-11-07（Asia/Shanghai）。实例 **`run-20261026T211500Z-11a22b33`**（Web 3011 / PostgreSQL 59345）。
状态：**`INVENTORY_SYNC_RESUME_V1_LOCAL_PASS`**（2026-11-07 独立审查通过、阻断 0，[报告](../../.local/inventory-sync-resume-v1-independent-20261107/independent-review.md)）。
本文件是本包的合同与执行记录；运行操作见[库存自动同步运行交接](inventory-sync-v1-runbook.md)，业务口径仍以
[库存与自动同步 v1](inventory-sync-v1.md) 为准（本包未改变任何业务规则）。
独立审查报告等 `.local/` 证据为本机存档、**不入 Git**；本文件 §5、§6、§8 已完整记录验收结论与数据，
远程阅读不依赖 `.local` 文件。

## 1. 包边界与授权

- 目标：让当前库存重新获得**真实**更新，并恢复后续自动执行；处理 2026-10-30 遗留的 queued 手动任务。
- 用户在本包内**解除**了上一物流包“库存 worker 保持关闭”的限制，**仅限本包的恢复工作**；不新做调度/监控平台。
- 只在本机现役实例内操作；未改 BigSeller 商品/库存/成本/订单/权限，未写回飞书，未启动旧生产同步。
- 既有商品绑定、数量口径、历史与逐仓发布规则全部沿用；物流在途读取继续运行，文末登记其核对结果。

## 2. 停运原因：已确认事实、推测与未知

### 2.1 已确认事实

1. 库存 worker 日志 `.local/catalog/<run>/inventory-work/logs/worker-20261029.jsonl` 最后一行是
   **2026-10-29 16:20:38.618+08** 的 `worker_heartbeat`；全文件没有 `worker_shutdown_requested`、
   `worker_stopped`、`worker_loop_error`、traceback 或任何 stop 事件。DB 心跳 `last_seen_at` 停在
   **2026-10-29 16:20:58.624+08**；此后 9 天没有任何 worker 日志/心跳，直到 2026-11-07 15:50 恢复。
2. **停止方式没有可判定记录**：日志止于最后心跳，没有 `worker_shutdown_requested`、`worker_stopped` 或任何错误事件；
   marker（`inventory-worker.pid.json`，pid 37668）仍在、该 pid 已不存在。`stop-worker.mjs` 只在确认进程退出后才删除 marker，
   但 Windows 上 `process.kill(pid,'SIGTERM')` 不保证 Python 的 signal handler 与退出日志一定执行（Node 官方说明 SIGTERM 会无条件终止目标），
   因此**不能据此判定是正常停止、强制终止还是其他方式**。
3. **不是数据库/整机中断**：PostgreSQL 跨过停运点继续运行；2026-10-29 16:20 前后没有关机/重启事件
   （最近一次意外关机是 2026-10-30 14:40:49，最近一次正常重启是 2026-11-06 09:39:51）。
4. **没有人工停止痕迹**：10-29 16:00 至 10-30 09:46 之间审计/待处理动作/设置/marker/日志都没有停止、禁用或改配置记录；
   `enabled` 始终为 `true`，`next_run_at` 停在最后成功任务推进出的 2026-10-29 16:22。
5. **遗留任务与停运的关系**：`9706ccd1-5ddd-48d4-9d62-285b1a1230c5` 创建于 **2026-10-30 09:46:40.937+08**
   （同一操作窗口 21 秒内 6 次“立即同步”，第 1 次建任务、后 5 次幂等命中），创建时 worker 已不在，
   因此一直 `queued`、无租约、无子行、无 claim/失败/重试记录，直到本包恢复。
6. **同分钟的系统活动（仅相关，不是因果证明）**：16:20:47–16:21:09 Windows Update/Store 正在安装
   `9PLM9XGG6VKS-OpenAI.Codex`（失败 0x800700E9 / 0x80073D02），16:21:07 该包的 Windows 服务
   （`CodexSandboxService`，显示名 ChatGPT）启动类型被改为“已禁用”，16:32:39 以新版本重装。

### 2.2 推测（明确标注，不作为结论）

该 worker 是用 `scripts/inventory/start-worker.mjs` 从当时的 agent 会话拉起的常驻子进程；停运发生在
Codex/沙箱服务被升级替换的同一分钟，现场是“进程在无停止记录的情况下消失 + 数据库未中断”。一种可能的机制是
**进程随启动它的会话/沙箱服务一起被终止，之后无人拉起**；这只是相关线索，不是因果证据（根因未知）。

### 2.3 未知（无证据，不编造）

- 谁、用什么信号/机制终止了 python 进程：**无证据**。Security 4689（进程退出审计）不可读；
  Application 日志 10-29 全天没有 python 相关错误/WER 记录；没有该进程的 crash dump。
- 因此本包**不判定根因**，只登记事实（日志无停止记录、marker 残留、pid 已不存在、数据库未中断）与相关线索
  （与 Codex 包更新同刻重合）；代码侧不存在可据以修复的缺陷（见 §8）。

## 3. 恢复路径与影响面（先简述）

**恢复路径**（全部使用现有脚本与现有 RPC，不新建流程）：
`start-worker.mjs` 启动 frozen worker → 首轮 `register_inventory_worker` 心跳 → `claim_inventory_run`
领取最早的 queued 手动任务（即遗留任务）→ 真实导出 BigSeller 全仓单 SKU → 严格解析/身份与仓库发现校验 →
`register_inventory_export` 登记文件与行 → 逐仓 `publish_inventory_warehouse` → `finish_inventory_run` 结单 →
回到计划循环，按 `next_run_at` 执行后续自动任务。

**遗留任务走哪条路径**：它从未开始（`started_at/lease_token/file_id` 全空、无行、无批次），
不是 `outcome_unknown`，因此不需要恢复/重放逻辑，直接第一次真实导出即可；
`recovery.py` 的“结果未知只核对”分支不可达。

**错过的计划时点**：DB 在同一次 claim 事务内把 2026-10-29 16:22 至 2026-11-07 15:22 共 **216 个**遗漏时点
合并登记到该任务的 `covered_slots`，并把 `next_run_at` 一次推进到 **2026-11-07 16:22:02+08**；
只执行一次读取、不新建补跑任务 → 符合合同“错过的多个自动时间点最多合并一次、不密集补跑”。

**预计改动面**：运行状态恢复，**预计 0 行业务代码改动**、0 数据库增量、0 前端改动；
只新增本包文档与运行交接。实际结果一致（见 §8）。

**执行记录**：`node scripts/inventory/start-worker.mjs --run-id run-20261026T211500Z-11a22b33`
于 **2026-11-07 15:50:18** 启动 pid 43836；15:50:19 领取遗留任务；15:50:35 结单成功。

## 4. 遗留任务处理结果

| 项 | 结果 |
|---|---|
| 任务 | `9706ccd1-5ddd-48d4-9d62-285b1a1230c5`（manual，计划 2026-10-30 09:46，此前 queued 8 天） |
| 领取 | 2026-11-07 15:50:19.006+08（attempt 1 = 首次领取，非接管） |
| 导出 | 15:50:26.581 → 15:50:31.358+08；728 行、0 空行、解析全 ok、身份 verified、发现 8 仓 |
| 逐仓发布 | 15:50:34.076–15:50:35.047+08，7 个参与仓全部成功（见 §5.2） |
| 结单 | 15:50:35.298+08 `status=success`、`scopeAllSuccess=true`、`published=7/failed=0/blocked=0`、范围外 78 行 |
| 覆盖时点 | `covered_slots` = 216 个（10-29 16:22:02 → 11-07 15:22:02，每小时一格） |
| 数据变化 | `inventory_batch` 462 → 469（+7）；`inventory_batch_row` 42900 → 43550（+650）；未新增第二个 run |
| 范围“最后全部成功” | `inventory_scope_state.last_all_success_at` = **2026-11-07 15:50:31.358+08**（= 观测时间 `export_finished_at`，不是发布时间） |
| 下一次计划 | `settings.next_run_at` = **2026-11-07 16:22:02.528+08**（60 分钟、启用状态不变） |

## 5. 交付的业务结果核对

### 5.1 来源文件

- 文件：`…/inventory-work/exports/库存清单20261107075027794.xlsx`，104,712 字节。
- 注册指纹 `inventory_export_file.sha256` = `cfeac4c7dcf0137dbcb8ed10a27d37ea5249f617d167989503f2824e82074dd5`，
  与本机文件实算 SHA-256 一致；`row_count=728`、`blank_row_count=0`、sheet `单个SKU`、解析器 `bigseller-inventory-v1`。
- 用 openpyxl 直接读源文件复核：表头行为第 1 行，728 条数据行；按“仓库”列分组为
  56673=143、52074=114、54409=21、53252=112、54886=56、48787=78、56519=116、50455=88。
  其中 48787（昕兰PH自建仓，`excluded`）的 78 行不在参与范围，**650 行 = 728 − 78**，与逐仓发布行数逐仓相等。

### 5.2 逐仓发布结果（与源文件、页面一致）

| 仓库 | 源文件行 | 发布行 | 采用 | 待对应 |
|---|---|---|---|---|
| 56673 DEE-龙仔厝（ICE专属） | 143 | 143 | 101 | 42 |
| 52074 DEE泰国海外仓(曼谷仓） | 114 | 114 | 91 | 23 |
| 54409 PH-彩妆日均万单简简单单仓 | 21 | 21 | 2 | 19 |
| 53252 印尼-DEE仓库 | 112 | 112 | 92 | 20 |
| 54886 喜运达MY仓 | 56 | 56 | 33 | 23 |
| 56519 菲律宾-新创启辰自建仓 | 116 | 116 | 107 | 9 |
| 50455 越南青林湾仓库 | 88 | 88 | 86 | 2 |
| 合计 | 650 | 650 | 512 | 138 |

7 个批次均写同一文件指纹、同一观测时间 2026-11-07 15:50:31.358+08；页面「逐仓结果」逐仓显示“已发布正常”、
“采用 N / 共 M 行”，与上表一致。

### 5.3 真实变化（不是重放）

与停机前最后一次成功批次（2026-10-29 15:22，run `e0e85f1e`）按同仓同 SKU 对比：650 个 SKU 中 **243 个 on_hand 变化**，
7 仓合计 on_hand 2,855,978 → 2,694,063。代表商品与页面读数一致（以 56673 / 来源 SKU `6974674957332` / WM0094 为例）：

- 停机前：on_hand 129,289、可售 128,381；恢复后：on_hand **107,065**、订单锁定 **1,273**、整仓可用 **105,792**、活动预留 0、来源在途 111,440。
- 页面 `/dashboard/inventory?q=6974674957332` 7 个仓库可售分别为 105,792 / 15 / 0 / 0 / 33,012 / 135,383 / 23,211，
  与 DB 当前读模型逐项相等；详情「来源批次」显示批次 `7c836d1f-9772-46ae-b362-2738666bc87c`、原表行号 359、原始数量文本 `107065`。
- 说明页面读的是各仓最新成功批次（`inventory_warehouse_state.last_batch_id → inventory_batch_row`），
  不是 `catalog.inventory_current`（该表只在首见时 INSERT，不随发布前进，属既有行为，见 §9）。

### 5.4 页面核对（3011，1440×900，本次验收脚本 `verify-resume.mjs`，**31/31 通过、console 0**）

- 数据同步页：BigSeller「正常 / 最近成功 2026-11-07 15:50 / 下次同步 2026-11-07 16:22 / 待处理 216」；
  同步记录「后台在线、登录有效、最后全部成功 2026-11-07 15:50」；任务历史首行 = 本遗留任务
  「全部成功 · 手动触发 · 计划时间 2026-10-30 09:46 · 开始/完成 2026-11-07 15:50 · 发布 7 仓」。
- 商品库存页：搜索来源 SKU 命中 7 个仓库行，可售数与 DB 一致；详情实物库存/可售/锁定/在途/数据时间与批次一致；
  来源批次页签核对批次号与原表行号。

## 6. 自动计划恢复与下一次执行证据

### 6.1 第一次自动执行（2026-11-07 16:22，正常计划）

| 项 | 证据 |
|---|---|
| 触发 | worker 日志 `16:22:05.878 run_claimed triggerKind=schedule plannedFor=2026-11-07T16:22:02.528891+08 attempt=1`（不是手动、不是补跑） |
| 任务 | `4515670d-801e-412b-a980-89a1e51ba5bb`，`covered_slots` = 1（只覆盖本格，没有合并多格） |
| 导出 | 16:22:13.148 → 16:22:15.718+08（claim 后启动浏览器并等待导出，共约 10 秒），731 行（本次来源新增 3 行）、解析全 ok、身份 verified、发现 8 仓；文件指纹 `28270958d713…` |
| 逐仓发布 | 7 仓：144/115/21/113/56/116/88 行（= 731 − 78 范围外行），采用 512；16:22:18 结单 `success`、`scopeAllSuccess=true` |
| 数据推进 | `inventory_batch` 469 → 476（+7）；范围“最后全部成功” → **2026-11-07 16:22:15.718+08**；**下一次计划 2026-11-07 17:22:02+08**（60 分钟、启用不变） |
| 页面 | 数据同步「最近成功 2026-11-07 16:22 / 下次同步 2026-11-07 17:22 / 待处理 219」；任务历史首行「全部成功 · 自动计划 · 计划时间 2026-11-07 16:22 · 完成 2026-11-07 16:22 · 发布 7 仓」；逐仓结果 7/7「已发布正常」 |
| 商品数量 | 同一来源 SKU `6974674957332` 在 56673 仓：15:50 可售 105,792 → 16:22 可售 **105,719**（实物 106,885、锁定 1,166），页面与 DB 一致 |

### 6.2 “关闭业务页面后仍能更新”的核对

16:22 这次执行由常驻 worker 进程（Python，pid 43836）独立完成：检领、导出、解析、逐仓发布、结单的日志全部来自该进程，
不依赖浏览器页面。验收页面在 15:58 关闭后未再打开，直到 16:23 才重新打开核对（页面请求只发生在核对时刻）；
期间 3011 没有任何页面保持打开。采集/发布与页面展示分离，符合合同“页面只提交操作和显示结果，后台按计划执行”。

### 6.3 后续

- 下一次自动执行 **2026-11-07 17:22:02+08**（`settings.next_run_at` 与页面「下次同步」一致）；只要 worker 进程存活，每 60 分钟继续。
- 本包不要求多日稳定性验收；若进程在两次计划之间被终止，`next_run_at` 会停在原格，重启后首轮 claim 会按“最多合并一次”处理（见 [运行交接](inventory-sync-v1-runbook.md) §4/§7）。

## 7. 启动、停止、状态查看与登录失效恢复（可直接使用）

完整命令、判读与故障处理见[库存自动同步运行交接](inventory-sync-v1-runbook.md)。最短版本：

```powershell
# 启动（整实例）或只拉起库存 worker
node scripts/inventory/start-instance.mjs --run-id run-20261026T211500Z-11a22b33
node scripts/inventory/start-worker.mjs  --run-id run-20261026T211500Z-11a22b33

# 停止（只停库存 worker / 整实例；stop-instance 会连本实例 PostgreSQL 一起停止）
node scripts/inventory/stop-worker.mjs    --run-id run-20261026T211500Z-11a22b33
node scripts/inventory/stop-instance.mjs  --run-id run-20261026T211500Z-11a22b33

# 状态
node scripts/inventory/status.mjs --run-id run-20261026T211500Z-11a22b33

# 登录失效：先检查；再在弹出的 Chrome 里人工登录（含滑块，窗口最长等 30 分钟）；
# worker 约每 60 秒探测一次，账号验证通过后恢复计划，无需重启
python tools\inventory-sync\bigseller_session.py
python tools\inventory-sync\bigseller_session.py --login --wait-seconds 1800
```

- 库存 worker 未随机器/会话自动拉起：重启后需手动执行启动命令（属运行设施限制，本包不扩成监控平台）。
- 物流在途读取不受本包影响，本包核对期间仍正常运行：`node scripts/shipment/status.mjs --run-id …`，pid 40476、10 分钟计划、
  最近 2026-11-07 16:36:34 成功（39 票/93 条明细、无变化）。期间 16:26 出现过一次纯外部网络瞬时失败
  （`SOURCE_CLI_FAILED`：飞书 `tenant_access_token` TLS 握手超时，失败只写失败快照并保留上一份成功数据），
  16:36 下一计划自动恢复成功——属来源网络波动，与本包改动无关。
- 注意：在受限沙箱/低权限终端里，`status.mjs` 对已存在进程可能报 `alive=false`、对物流子步骤报 `no output`（EPERM 假阴性），
  以 DB 心跳/日志为准；在普通管理员终端执行即可看到真实结果。

## 8. 代码改动与验证结果

- **业务代码改动：无。** `git status` 仅 `.local/` 未跟踪（证据目录）；未改 `src/`、`db/`、`tools/`、`scripts/`。
- 数据库：无 schema 增量（`inventory_schema_state.version` 仍 6），未改 016–021 原文件；本次只有既有 run/batch 数据增长。
- frozen worker 源码：实例冻结副本与仓库 `tools/inventory-sync/*.py` **按 LF 归一化后 9 个文件逐一 SHA-256 相同**；
  `status.mjs` 的 `repoDrift=true` 只是仓库侧 CRLF 差异，不是代码漂移。
- Web：未改前端、**无需重建**（3011 仍是 `u1l5K9pzcRXylPrYmnvAc`，源码快照 `04e22de5…`）。
- 定向验证：`verify-resume.mjs` 页面+DB 交叉核对 **31/31**（见 §5.4），来源文件独立读表核对（§5.1），
  恢复前后批次级变化核对（§5.3）。
- 继承不重跑：商品绑定、数量口径、拆合票、并发恢复等验收结论直接继承既有 R16/R14 等报告；本包未改对应机制。
- 未执行：崩溃接管/结果未知演练（`recovery-drill.mjs` 会另起真实采集）、多日稳定性验收——均超出本包。

## 9. 已知限制与观察项（本次未改，登记给后续决策）

1. **库存 worker 无服务守护**：机器重启、会话结束或进程被外部杀死后不会自愈；必须人工拉起。这是本次停运持续 9 天的直接原因类别。
2. **`inventory_worker.state` 不会因心跳超时自动变 offline**：进程消失后该字段长期停在 `online`（本次陈旧 8 天）；
   页面与 `status.mjs` 用 `last_seen_at` 新鲜度判定，显示正确，但直接查库的人会被误导。
3. **页面「待处理」口径**：取最新一次读取中未对应的 distinct(仓, SKU)，**包含已排除仓**（本次 216 = 参与仓 138 + 弃用仓 48787 的 78）。
   只统计参与仓时以逐仓“另有 N 条待对应”相加；是否调整展示属产品决策。
4. **`catalog.inventory_current` 只在首见时 INSERT、不随发布前进**：它不是读模型（读模型是各仓最新成功批次），
   对账必须用 `warehouse_state.last_batch_id → inventory_batch_row`；该表是否废弃属独立决策。
5. **一次失败没有自动重试**：失败后等下一个 60 分钟计划点或人工「立即同步」；`retry/recovery` 触发类型未被使用（合同允许）。
6. **216 个覆盖时点会在任务详情里连成一段长文本**：仅显示冗长，不是错误。
7. **`inventory_schema_state.functions_sha256` 与实例清单记录不一致**：本次观察到 DB=`55922bc9…`、清单=`0c5511…`，
   当前 SQL 文件字节哈希又是另一个值；原因是文件在两次准备（10-26 / 10-28）之间以及 10-30 重新检出后换行/内容变化。
   `source_sha256`（结构）一致、schema 版本 6，实际运行与页面验证均通过，不影响本包结论。
8. **长驻进程不要挂在会随工具/会话退出的进程树里**：避免在会话/服务升级时被一并终止；本次停运现场与之相似，
   但没有 OS 级证据，不能据此确定退出原因（根因未知）。

## 10. 证据索引

| 内容 | 位置 |
|---|---|
| 停运/现状取证报告（只读，T0/T1 分开） | `.local/inventory-sync-resume-v1-20261107/state/state-report.md` + `raw-01…07` + `sql-queries.sql` |
| 恢复路径代码分析（只读） | `.local/inventory-sync-resume-v1-20261107/analysis/findings.md` + `observed-2026-11-07.md` |
| 恢复前后 DB 快照 | `.local/inventory-sync-resume-v1-20261107/lead/{baseline.json,after-run1.json,after-run2.json}` |
| 来源文件独立核对 | `.local/inventory-sync-resume-v1-20261107/lead/export-inspect.json`（`inspect-export.py`） |
| 页面/DB 定向验收 | `.local/inventory-sync-resume-v1-20261107/lead/verify/{run1,run2}-results.json`、截图与页面文本 |
| worker 日志 | `…/inventory-work/logs/worker-20261107.jsonl`（恢复运行）、`worker-20261029.jsonl`（停运现场） |
| 导出原文件 | `…/inventory-work/exports/库存清单20261107075027794.xlsx` |

## 11. 交付状态

**独立审查通过（`INVENTORY_SYNC_RESUME_V1_LOCAL_PASS`，阻断 0）**。本包只交付“库存重新真实更新 + 自动计划恢复 + 遗留任务闭环”，
不代表整个 ICEOS 或其它板块验收；正式部署、长期运行稳定性与监控不在本包范围。
代码与文档随 [PR #13](https://github.com/rallsix66/ICE-OS/pull/13) 合并到远程 `master`（合并提交 `b620eb4`）；
远程 Vercel Production 已随合并自动部署成功（ref `b620eb4`），本机实例 3011 未重建、未重启。
