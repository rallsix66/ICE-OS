# 物流在途板块 — 运行交接（本机实例）

更新：2026-11-07（Asia/Shanghai）。适用验收基线 **`SHIPMENT_IN_TRANSIT_V1_R16_LOCAL_PASS`**，收尾状态 **`SHIPMENT_IN_TRANSIT_V1_LOCAL_FINAL`**。
功能范围见 [最终功能说明](shipment-in-transit-v1-final.md)；逐轮实现与验收见 [任务合同](shipment-in-transit-v1.md)。

> 本交接只记录本机现有实现与命令，**不新增功能、不改运行方式**。当前库存同步 worker 必须保持关闭，因此**不要用整实例启动命令**（`scripts/inventory/start-instance.mjs` 会顺带启动库存 worker）；请按 §4 的分项顺序启动。

## 1. 实例标识与位置

| 项 | 值 |
|---|---|
| 实例 run id | `run-20261026T211500Z-11a22b33` |
| 实例根 | `D:\try one\ICEOS\.local\catalog\run-20261026T211500Z-11a22b33` |
| 实例配置目录 | `…\instance`（`run-20261026T211500Z-11a22b33\instance`） |
| Web / 页面 | http://127.0.0.1:3011；入口 `/dashboard/in-transit`、`/dashboard/catalog`、`/dashboard/inventory`、`/dashboard/sync` |
| 数据库 | PostgreSQL `127.0.0.1:59345`，库 `iceos_catalog_run_20261026T211500Z_11a22b33`（PG 17，数据目录 `…\instance\pgdata`） |
| 当前 BUILD | `u1l5K9pzcRXylPrYmnvAc`，源码快照 `04e22de5906c3c36…`（`…\instance\preview-build-ready.json`） |
| 运行身份 | Web：本机 Node；库存 worker：`inv-worker-59345`（**保持关闭**）；在途读取：`shipment-auto-reader-59345`（受限 `ice_p0_02_sync_runner`） |
| 登录 | 账号 `admin@catalog.test`；密码文件 `…\instance\login.local-preview.txt`（不写入仓库） |

配置与状态文件（均在 `…\instance\`，不入 Git）：

| 文件 | 用途 |
|---|---|
| `env.inventory.json` / `env.catalog.json` | 实例连接串、端口、工作目录、schema 版本与哈希（含密码，勿外传） |
| `catalog-instance.json` | 数据库 dataDir / pgBinDir / host / port |
| `shipment-auto-reader.json` | 读取进程配置（runId、workerId、sync 连接串、CLI 路径、日志/临时目录、轮询秒数） |
| `shipment-auto-reader.pid.json` | 读取进程 marker（pid、进程创建时间、脚本/config 路径，用于归属校验） |
| `preview-build-ready.json` | 当前 BUILD、源码快照、产物校验信息 |
| `postgres.log`、`next-preview.log`、`shipment-auto-reader\logs\reader-YYYY-MM-DD.jsonl`、`reader.stdout.log` | 数据库 / Web / 读取进程日志 |

## 2. 页面入口与查看

- 日常地址：http://127.0.0.1:3011/dashboard/in-transit （导航「物流在途」）。
- 读取状态统一在 `/dashboard/sync`：飞书 · 物流在途来源卡显示最近成功、下次计划、待处理。物流在途页不再显示成功读取横栏，读取失败时只在页内保留一句提示和「查看同步」入口。
- 「待复核」按钮显示拆合票待办数。
- 商品库详情 → 「关联货票」、概览「在途库存」卡片可看商品级在途并打开原票。

## 3. 依赖

- **Node.js 24**、仓库依赖已安装（`node_modules`）；Windows 本机 PowerShell 命令均以仓库根为工作目录。
- **PostgreSQL 17 客户端/服务端**：使用实例自带二进制 `…\.local\p0-02\run-20261014-r2\pg\pgsql\bin\`（`pg_dump`/`pg_restore`/`psql` 版本 17.11）。
- **飞书 CLI（lark-cli）**：读取来源依赖本机已授权的飞书 CLI（bot 身份，凭据在系统凭据库，不进入 ICEOS）。默认查找 `%APPDATA%\npm\node_modules\@larksuite\cli\scripts\run.js`；可用环境变量 `SHIPMENT_LARK_CLI_RUNNER` 覆盖为其他 `run.js` 路径。CLI 缺失/未授权/超时会在读取时失败并保留旧数据（见 §6）。
- **飞书来源**：wiki 文档「物流情况表」`EZXAwpgA8iCms2kF2l1cnzQDnhd`，sheet `b42d8b`；来源行径由配置固定，不做写回。

## 4. 启动顺序（PostgreSQL → Web → 物流在途读取进程）

在仓库根 `D:\try one\ICEOS` 执行。每步脚本都会先校验实例与进程归属，不会启动第二个副本。

```powershell
# 1) 数据库
node scripts/catalog/start-catalog-postgres.mjs --run-id run-20261026T211500Z-11a22b33

# 2) Web（3011；使用已 promote 的 BUILD；如需 dev 模式设 INVENTORY_PREVIEW_NEXT_MODE=dev）
node scripts/inventory/start-web.mjs --run-id run-20261026T211500Z-11a22b33

# 3) 物流在途读取进程（10 分钟计划，读数据库计划；启动后自动上报心跳）
node scripts/shipment/start-worker.mjs --run-id run-20261026T211500Z-11a22b33
```

**不要**用 `node scripts/inventory/start-instance.mjs --run-id …` 作为当前恢复方式：它会依次启动数据库、Web、**库存 worker**、在途读取进程；库存 worker 目前必须保持关闭。若不慎启动，用 `node scripts/inventory/stop-worker.mjs --run-id run-20261026T211500Z-11a22b33` 停掉并核对状态。

若源码有改动需要更新 3011（本轮收尾无功能改动，未重建）：先 `node scripts/catalog/build-preview-workspace.mjs --run-id …`，再 `node scripts/catalog/promote-preview-build.mjs --run-id …`，最后按上面顺序启动。

## 5. 停止、状态与日志

```powershell
# 只停在途读取进程（不影响 Web / 数据库 / 库存 worker）
node scripts/shipment/stop-worker.mjs --run-id run-20261026T211500Z-11a22b33

# 在途读取专用状态（进程归属 + 数据库计划/心跳 + 来源计数）
node scripts/shipment/status.mjs --run-id run-20261026T211500Z-11a22b33

# 实例总状态（含在途读取摘要与库存 worker 状态；退出码供参考）
node scripts/inventory/status.mjs --run-id run-20261026T211500Z-11a22b33

# 停 Web / 数据库（需要整实例停机时）
node scripts/catalog/stop-local-preview.mjs --run-id run-20261026T211500Z-11a22b33
node scripts/catalog/stop-catalog-postgres.mjs --run-id run-20261026T211500Z-11a22b33
```

状态判读（`shipment/status.mjs`）：

- `readerProcess.owned=true` 且 `readerState.worker_online=true` → 读取进程在运行且确属本实例。
- `readerState.enabled` / `interval_minutes` / `next_run_at` → 计划是否开启、间隔与下次读取时间。
- `readerState.last_result`：`success`（有变化）/`unchanged`（同内容）/`failed`（失败，保留上次成功数据）。
- `readerProcess=null` 或 `alive=false` → 进程未运行；`owned=false` 且带 `code` → PID 被其他进程复用或归属不匹配，不要强杀。

日志位置：

- 读取进程事件：`…\instance\shipment-auto-reader\logs\reader-YYYY-MM-DD.jsonl`（`start`、`cycle-start`、`cycle-finish`、`cycle-error`、`skip-busy`、`signal`、`stop` 等，含错误码与消息）。
- 读取进程 stdout/stderr：`…\instance\shipment-auto-reader\logs\reader.stdout.log`。
- Web：`…\instance\next-preview.log`；数据库：`…\instance\postgres.log`。
- 页面侧失败原因：`/dashboard/sync` 的飞书来源卡失败一句 + 展开的技术详情。

## 6. 读取失败 / 授权失效的定位与恢复

1. **看失败原因**：`node scripts/shipment/status.mjs --run-id …` 的 `readerState.last_result/last_error_code/last_error_message`；或读取日志中的 `cycle-finish`/`cycle-error`；或 `/dashboard/sync` 飞书卡。
2. **按错误码分类**：
   - `SOURCE_CLI_MISSING` / `SOURCE_CLI_FAILED` / `SOURCE_CLI_TIMEOUT` / `SOURCE_CLI_BAD_JSON`：本机 `lark-cli` 缺失、未授权、超时或输出异常。确认 `%APPDATA%\npm\node_modules\@larksuite\cli\scripts\run.js` 存在且本机飞书授权有效；授权失效时在终端重新完成 lark-cli 登录后等下一次计划（或重启读取进程）。
   - `SOURCE_DOC_UNRESOLVED` / `SOURCE_SHEET_MISSING` / `SOURCE_GRID_INVALID` / `SOURCE_REVISION_MISSING` / `SOURCE_EMPTY`：来源文档、工作表、revision 或网格结构变化，检查飞书文档是否被移动/改表头/改工作表。
   - `SHIPMENT_READER_FAILED`：读取链路的其他异常，看日志 `cycle-error` 的 message。
3. **恢复行为**：一次失败只写失败快照，**不写业务数据**；页面继续显示上一份成功数据与来源时间；计划保持启用，到点自动重试（无需人工“补数”）。失败期间不要删除旧快照/历史。
4. **进程级恢复**：进程崩溃或被杀后 `status` 显示未运行，用 `node scripts/shipment/start-worker.mjs --run-id …` 重启；若 marker 残留但 PID 已退出，脚本会清理 marker 并可正常启动。
5. **手动重试**：在 3011 页面点「刷新来源」（与定时读取共用租约，不会并发）；`worker.mjs --run-once` 仅用于受控验证，日常不使用。

## 7. 数据库初始化 vs 日常重启

- **初始化/迁移数据库**（首次准备实例或补齐 001–035 增量；幂等）：
  ```powershell
  node scripts/inventory/prepare-instance.mjs --run-id run-20261026T211500Z-11a22b33
  ```
  该命令准备实例、应用 schema 增量（含 026–035）、种子与 marker；仅应在实例未准备或需要补齐增量时执行，**不是日常重启命令**（日常重启按 §4 三步）。
- **日常重启**：按 §4 顺序执行 PostgreSQL → Web → 读取进程，再用 §5 的状态命令确认（不要运行 `prepare-instance`，也不要运行 `start-instance`）。

## 8. 备份与恢复（本机）

本轮收尾已对现役实例做一次本地数据库备份（时间、文件与校验见 `.local/shipment-v1-closeout-20261107/backup/BACKUP.md`）：

```powershell
# 备份（自定义格式；连接串从 env.inventory.json 的 ownerDbUrl 读取，命令中使用当前实例）
& '<pg bin>\pg_dump.exe' --format=custom --no-owner --no-privileges `
  --dbname "<ownerDbUrl>" --file ".local\shipment-v1-closeout-20261107\backup\<file>.dump"
Get-FileHash ".local\shipment-v1-closeout-20261107\backup\<file>.dump" -Algorithm SHA256

# 检查可读（列出归档目录）
& '<pg bin>\pg_restore.exe' --list ".local\shipment-v1-closeout-20261107\backup\<file>.dump" | Select-String 'shipment'

# 恢复到临时库验证（不改现役数据）
& '<pg bin>\createdb.exe' --host 127.0.0.1 --port 59345 --username postgres <临时库名>
& '<pg bin>\pg_restore.exe' --no-owner --no-privileges --host 127.0.0.1 --port 59345 --username postgres --dbname <临时库名> ".local\shipment-v1-closeout-20261107\backup\<file>.dump"
# 核对票/明细/绑定计数后删除临时库
& '<pg bin>\dropdb.exe' --host 127.0.0.1 --port 59345 --username postgres <临时库名>
```

- `<pg bin>` = `D:\try one\ICEOS\.local\p0-02\run-20261014-r2\pg\pgsql\bin`。
- **现役数据库不做恢复覆盖**；恢复演练只在临时库进行，验证完即删除。恢复整实例前先停 Web 与读取进程，恢复后按 §4 启动并核对 `status`。
- 备份文件、实例配置、原表与证据留在 `.local/`，**不进入 Git**，不随构建产物发布。

## 9. 明确不做 / 注意事项

- **库存同步 worker 保持关闭**：不要通过本板块启停或恢复库存自动同步；那是另外的工作。
- 喜运达轨迹按用户决定暂缓，不在本板块。
- 本机实例的读取进程无服务守护，机器重启/进程崩溃后需要按 §4 第 3 步手动拉起（状态可查）。
- 读取进程与手动刷新共用租约；如显示 `skip-busy` 属正常（另一次读取正在进行）。
- 本交接只适用于本机当前实例；远端推送、正式部署、长期运行稳定性验收均未完成。
