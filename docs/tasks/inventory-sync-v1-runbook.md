# 库存自动同步 — 运行交接（本机实例）

更新：2026-11-07（Asia/Shanghai）。适用实例 **`run-20261026T211500Z-11a22b33`**，本次恢复结果见
[INVENTORY_SYNC_RESUME_V1 任务包](inventory-sync-resume-v1.md)；业务合同见 [库存与自动同步 v1](inventory-sync-v1.md)。

> 与物流在途板块的交接 [shipment-in-transit-v1-runbook.md](shipment-in-transit-v1-runbook.md) 配套：
> **库存同步 worker 自 2026-11-07 起恢复正常运行**，不再是“必须保持关闭”。
> 物流在途读取进程与库存 worker 互不接管，可分别启停。

## 1. 实例标识与位置

| 项 | 值 |
|---|---|
| 实例 run id | `run-20261026T211500Z-11a22b33` |
| 实例根 | `D:\try one\ICEOS\.local\catalog\run-20261026T211500Z-11a22b33` |
| 配置目录 | `…\instance` |
| 页面 | http://127.0.0.1:3011 —— `/dashboard/sync`（数据同步）、`/dashboard/inventory`（商品库存） |
| 数据库 | PostgreSQL `127.0.0.1:59345`，库 `iceos_catalog_run_20261026T211500Z_11a22b33`（PG 17，数据目录 `…\instance\pgdata`） |
| 登录 | 账号 `admin@catalog.test`；密码文件 `…\instance\login.local-preview.txt`（不入 Git） |
| 来源账号 | BigSeller `laiguoyong@KNZX019402`（`catalog.inventory_source_account.account_label`，状态 `active`） |
| 参与仓库 | **7 个**（scope 版本 1）：56673 DEE-龙仔厝、52074 DEE泰国曼谷仓、54409 PH-彩妆仓、53252 印尼-DEE、54886 喜运达MY、56519 菲律宾-新创启辰、50455 越南青林湾；第 8 个 48787 昕兰PH自建仓为 `excluded`，不发布 |
| 计划 | `catalog.inventory_sync_settings`：`enabled=true`、`interval_minutes=60`、`plan_anchor_at` 每点 `:22`、`next_run_at` 随每次领取推进 |

进程与文件：

| 进程 / 文件 | 说明 |
|---|---|
| 库存 worker | Python 常驻进程 `inv-worker-59345`；配置 `…\instance\inventory-worker.json`；marker `…\instance\inventory-worker.pid.json` |
| 冻结构建 | worker 实际运行 `…\instance\inventory-worker-src\worker.py`（prepare 时冻结，哈希 `1db4017a…`，与仓库 `tools/inventory-sync/*.py` 归一化换行后一致） |
| 日志 | `…\inventory-work\logs\worker-YYYYMMDD.jsonl`（事件：`worker_started` / `worker_heartbeat` / `run_claimed` / `export_registered` / `run_finished` / `worker_idle` / `worker_shutdown_requested` / `worker_stopped`）；stdout `worker.stdout.log` |
| 导出文件 | `…\inventory-work\exports\库存清单YYYYMMDDhhmmssSSS.xlsx`（每次真实导出）；文件指纹登记在 `catalog.inventory_export_file` |
| 浏览器会话 | Chrome 持久化 profile `tools\bigseller-scraper\runtime\profile`；会话状态 `…\.local\inventory-sync-20261025\session\session-status.json`；锁 `browser.lock` |
| 物流读取（并列，不受本交接控制） | `scripts/shipment/worker.mjs`，10 分钟；配置 `…\instance\shipment-auto-reader.json` |

## 2. 依赖

- **Node.js 24**、仓库依赖已安装（`node_modules`）。
- **Python 3.13 + playwright + 本机 Chrome**（`C:\Program Files\Google\Chrome\Application\chrome.exe`）。BigSeller 导出走 Playwright 持久化 profile。
- **PostgreSQL 17 客户端**：`.local\p0-02\run-20261014-r2\pg\pgsql\bin`（`pg_dump`/`pg_restore`/`psql`）。
- **BigSeller 登录会话**：cookie 在持久化 profile 内（登录成功时把 bigseller 域 cookie 续期 90 天）。**过期后必须由人在弹出的 Chrome 窗口里手动登录**（含滑块），程序不保存密码、不绕过验证。
- 本机需开机联网；关闭业务页面不影响后台按计划执行。

## 3. 启动（PostgreSQL → Web → 库存 worker → 物流读取）

在仓库根 `D:\try one\ICEOS` 执行。每个脚本都会校验实例与进程归属，不会启动第二个副本。

**整实例一条命令**（推荐，顺序与分项一致）：

```powershell
node scripts/inventory/start-instance.mjs --run-id run-20261026T211500Z-11a22b33
```

**分项执行**（任一步失败时可单独重试）：

```powershell
# 1) 数据库
node scripts/catalog/start-catalog-postgres.mjs --run-id run-20261026T211500Z-11a22b33
# 2) Web（3011，使用已 promote 的 BUILD）
node scripts/inventory/start-web.mjs --run-id run-20261026T211500Z-11a22b33
# 3) 库存同步 worker（启动即注册心跳并领取到期/遗留任务）
node scripts/inventory/start-worker.mjs --run-id run-20261026T211500Z-11a22b33
# 4) 物流在途读取进程（与本包无关，保持原来的 10 分钟计划）
node scripts/shipment/start-worker.mjs --run-id run-20261026T211500Z-11a22b33
```

- `start-worker.mjs` 只在 marker 指向的进程已不存在时启动；进程活着且归属校验通过时直接提示已在运行。
- `start-instance.mjs` 会依次检查并启动四步，已在运行的组件不会启动第二份；如果只想把停掉的库存 worker 拉起来（DB/Web/物流读取都正常），直接用上面的第 3 步，避免多余步骤。
- worker 启动后会先 `register_inventory_worker` 心跳，再 `claim_inventory_run`：**先领取队列里最早的 queued/manual 任务**，没有到期自动计划时打印 `worker_idle: no_due_run` 并等待。
- **不要把 worker 挂在会随工具/会话退出的进程树里**：本次 10-29 停运的现场是“无优雅停止日志 + pid 直接消失 + 数据库未中断”，**推测**是常驻进程随启动它的会话/沙箱服务一起被终止（无 OS 级证据，见任务包 §2.2/§2.3）。日常应在独立终端窗口启动；如需长期托管，用 Windows 服务/计划任务另行接入（见 §9，属后续工作）。

## 4. 停止

```powershell
# 只停库存 worker（保留 Web/数据库/物流读取）
node scripts/inventory/stop-worker.mjs --run-id run-20261026T211500Z-11a22b33
# 只停物流读取
node scripts/shipment/stop-worker.mjs --run-id run-20261026T211500Z-11a22b33
# 停 Web / 数据库
node scripts/catalog/stop-local-preview.mjs --run-id run-20261026T211500Z-11a22b33
node scripts/catalog/stop-catalog-postgres.mjs --run-id run-20261026T211500Z-11a22b33
# 整实例（两个 worker + Web + 数据库；会停止本实例 PostgreSQL）
node scripts/inventory/stop-instance.mjs --run-id run-20261026T211500Z-11a22b33
```

停止行为：`stop-worker.mjs` 发 SIGTERM 并等待进程退出（最多 20 秒）；确认退出后才删除 marker，未退出则保留 marker 并报错。
Windows 上 `process.kill(pid,'SIGTERM')` 不保证 Python 的 signal handler 与退出日志一定执行（Node 官方说明 SIGTERM 会无条件终止目标），
因此**缺少停止日志不能单独判定终止方式**；marker 残留只能作为调查线索，不足以确定最初是谁或什么机制终止了进程。
正在执行的任务不会被打断成“成功”：进程在导出/发布中途被杀，任务会停在对应阶段，接管者按租约过期后重新领取并走既有恢复逻辑（见 §7）。

## 5. 状态查看与判读

```powershell
# 实例总状态（含库存 worker、物流读取、数据库与页面）
node scripts/inventory/status.mjs --run-id run-20261026T211500Z-11a22b33

# 物流读取专用状态
node scripts/shipment/status.mjs --run-id run-20261026T211500Z-11a22b33
```

判读要点：

- `workerProcess`: `alive=true` 且 `owned=true` 才是本实例的 worker 在运行；`pid` 与 `inventory-worker.pid.json` 一致。
- `database.heartbeat[]`: `state=online` 且 `last_seen_at` 足够新鲜才算在线（页面按 30 秒、`status.mjs` 按 45 秒判定）。**注意**：`inventory_worker.state` 没有超时自动下线，进程消失后会永远停在 `online`（本次陈旧 8 天），判断在线请以 `last_seen_at` 为准。
- `database.settings.next_run_at`: 下一次自动计划；`active_runs`: 当前排队/执行中的任务数（正常空闲为 `0`）。
- `database.lastRuns[]`: 最近任务状态（`success` / `partial` / `failed` / `needs_login` / `outcome_unknown`）。
- 页面 `/dashboard/sync`：BigSeller 卡「状态 / 最近成功 / 下次同步 / 待处理」；展开「同步记录与来源详情」可看后台在线、登录有效、7 个参与仓的逐仓结果与任务历史。
  - 「待处理」= 最新一次读取中未对应的 distinct(仓, SKU) 数，**含已排除仓**（例如 48787 的 78 行）；只看参与仓时按逐仓结果里的「另有 N 条待对应」相加。
  - 程序未运行时卡片显示「库存自动同步未运行 / 暂无执行计划」，最近成功保留真实历史时间。

数据库直查（只读，owner 连接串在 `…\instance\env.inventory.json` 的 `ownerDbUrl`）：

```sql
SELECT status, trigger_kind, planned_for, started_at, finished_at, export_finished_at, error_code,
       array_length(covered_slots,1) AS covered_slots
FROM catalog.inventory_sync_run ORDER BY created_at DESC LIMIT 5;
SELECT external_name, last_success_at, last_batch_id FROM catalog.inventory_warehouse_state
JOIN catalog.inventory_warehouse ON id=warehouse_id ORDER BY external_name;
-- 当前库存读模型：各仓 last_batch_id 对应的 inventory_batch_row（status='adopted'）；
-- 不要用 catalog.inventory_current 对账（该表只在首见时 INSERT，不随发布前进）。
```

## 6. 登录失效的定位与恢复

1. **看现象**：`/dashboard/sync` BigSeller 状态「需要重新登录」；最近一次任务 `needs_login`；`status.mjs` 的 `lastRuns[0].error_code` 为 `LOGIN_REQUIRED` / `LOGIN_EXPIRED` / `SESSION_EXPIRED` / `ACCOUNT_NEEDS_LOGIN`。
2. **先确认会话**（无头检查，不弹窗）：
   ```powershell
   python tools\inventory-sync\bigseller_session.py
   ```
   返回 `{"loggedIn": true, ...}` 即有效；`loggedIn=false` 需要人工登录。
3. **人工登录并续期**（会弹出 Chrome 窗口，需本人在窗口内完成登录含滑块验证；命令最多等待 30 分钟）：
   ```powershell
   python tools\inventory-sync\bigseller_session.py --login --wait-seconds 1800
   ```
   当前 CLI 的 `--login` 分支要求显式传入 `--wait-seconds`（只传 `--login` 会在打开窗口前报错）。登录成功后会把 bigseller cookie 续期 90 天并写 `session-status.json`（`status=logged_in`、账号名）。
4. **恢复自动同步**：账号状态仍为 `needs_login` 时，worker **约每 60 秒探测一次**会话；探测到登录有效、且账号标识非空并与固定账号一致（`refresh_inventory_account_status` 返回 verified）后把账号改回 `active`，随后按计划继续，**不需要重启 worker**；下一次计划时间可在页面「下次同步」查看。若想立即验证一次真实读取，可在页面点「立即同步」（会创建一个 manual 任务，不改变自动计划）。
5. **登录失败排查**：Chrome 被占用（`browser.lock` 指向活进程）时先确认没有正在进行的导出；profile 损坏时不要删除，先确认是否有其他实例在用同一 profile。`lark-cli` 只与物流在途读取有关，与库存同步无关。

## 7. 失败与中断的定位

| 现象 | 处理 |
|---|---|
| `run_claimed` 后无 `export_registered`，任务停在 `downloading` | 看 worker 日志与 `worker.stdout.log`；进程被杀会在租约（120s）过期后由下一次 claim 接管并按 `read_inventory_run_work` 跳过已发布仓 |
| 任务 `failed`，`error_code=LOGIN_*` | 按 §6 人工登录 |
| 任务 `failed`，错误指向导出、下载、解析或整份文件校验（如 `EXPORT_TIMEOUT`、`DOWNLOAD_FAILED`、`HEADER_INVALID`、`FILE_CORRUPT`、`INVENTORY_FILE_BLOCKED`） | 查看该任务的 `error_code`、`error_detail` 与 worker 日志，按实际原因处理；保留已有成功批次，问题解决后等待下一计划或手动重新同步。 |
| 任务 `partial`，某仓失败 | 该仓保留上一成功批次并单独标失败，其余仓照常发布；范围「最后全部成功时间」不前进 |
| 任务 `outcome_unknown`（后台发布结果未确认） | 由**本实例后台 worker 的恢复路径**核对（`tools/inventory-sync/worker.py` 的 `_recover_outcome_unknown`）：任务保留原租约但不释放，租约过期后下一次 `claim_inventory_run` 重新领取（attempt+1），按已登记/已发布批次核对——全部参与仓已发布则结为 `success`，有缺口则结为 `partial`，**不会重复发布**。处理：按 §3 保持或拉起本实例 worker，在 worker 日志查看 `outcome_unknown_recovery_check`，随后是 `run_finished`（`recovered=true`，全部已发布）或 `outcome_unknown_reconciled`（有缺口），以任务最终状态为准。**不是**页面的「原请求核对」——该入口只处理页面操作结果未知（服务端 `catalog.inventory_pending_action`）。 |
| 页面「后台在线」但长时间无新批次 | 先看 `last_seen_at` 是否新鲜（`state` 字段不可靠），再按 §5 核对；进程不在就用 §3 第 3 步拉起 |
| `scripts/inventory/status.mjs` 里物流读取显示 `ok:false / no output` | 该子步骤用管道收集输出，在受限沙箱里会失败；直接跑 `scripts/shipment/status.mjs` 看真实结果 |

失败只写失败快照/状态，不覆盖已发布批次；计划保持启用，到点重试。

## 8. 数据库初始化、备份与恢复

- **初始化/迁移（幂等，仅首次或补增量时）**：
  ```powershell
  node scripts/inventory/prepare-instance.mjs --run-id run-20261026T211500Z-11a22b33
  ```
  日常重启**不要**运行它（按 §3 三步）。
- **备份**：现役库最近一次本地备份见 `.local/shipment-v1-closeout-20261107/backup/BACKUP.md`（自定义格式 dump + SHA-256 + `pg_restore --list` 与临时库恢复验证）。备份、实例配置、原表与证据都在 `.local/`，不入 Git。
- **恢复**：恢复整实例前先按 §4 停 Web 与两个 worker；恢复到临时库验证后再决定是否覆盖；现役库不做无备份覆盖。

## 9. 明确不做 / 已知限制

- **不做**：调度/监控平台、告警、自动扩容、多实例部署、长期多日稳定性验收。本交接只覆盖本机当前实例。
- **worker 无服务守护**：机器重启、进程崩溃或启动会话结束时不会自动拉起，需要按 §3 手动启动（或用计划任务/服务方式自行托管，属后续工作）。
- `inventory_worker.state` 不会因心跳超时自动改为 offline（陈旧值见 §5）。
- 商品单位资料缺失：页面显示「单位待确认」，箱数换算只在有 `cartonQuantity` 时可用。
- 页面「待处理」包含排除仓行的口径见 §5。
- 来源变化（BigSeller 改表头、改导出格式、账号权限变化）会让整批失败并保留旧数据，需要人工确认后再重试。
