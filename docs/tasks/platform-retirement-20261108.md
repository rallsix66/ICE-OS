# 退出 Vercel 与 Supabase（2026-11-08）

日期：2026-11-08（Asia/Shanghai）。现役实例 **`run-20261026T211500Z-11a22b33`**（Web 3011 / PostgreSQL 59345）。

状态：**`PLATFORM_RETIREMENT_V1_LOCAL_PASS`**（2026-11-09 独立复审通过，阻断 **0**；仅限本机本包/当前实例）。
独立复审报告：[`.local/platform-retirement-independent-20261109/independent-review.md`](../../.local/platform-retirement-independent-20261109/independent-review.md)。
PASS 由独立复审给出，执行方不自行宣布。本结论不代表正式部署、旧云项目恢复演练或整个 ICEOS 验收。

> **证据分层**：平台“当前状态”引用 2026-11-09 独立复审回读；本文件 §1.2 的删除顺序、`DELETE` 响应码、旧域名 404 等是执行方当次操作记录，独立复审未重放。§3 区分执行方自验与独立复审，不把一边的结果写成另一边的。

本包按用户确认“以后不再使用 Vercel 与 Supabase”，完成外部项目退役、现役代码依赖清理和运行交接。
历史 SQL、迁移、报告与备份保留；历史文件中的平台名称仅作历史记录，不代表仍有运行依赖。

## 1. 外部退役结果

### 1.1 平台当前状态（独立复审回读，2026-11-09）

- **Vercel**：指定团队 `rallsix66s-projects` 的项目列表成功返回 `projects=[]`；原项目
  `prj_zziqelP0J1CMRIHnZhJVSNRBMqPK` 按 ID 查询返回 **HTTP 404 / `not_found`**。结合删除前已核对的同一项目身份，
  确认原项目已退出，不再具备自动部署载体。
- **Supabase**：项目列表成功返回 `projects=[]`，旧 Production/Staging 两项目均不再列出。逐 ref 工具查询返回
  **权限错误（`You do not have permission to perform this action`），不是 HTTP 404**；因此不能把权限错误写成 404。
  当前退役结论依据“项目清单为空 + 已知原项目清单 + 执行方退役记录”，不声称独立取得了逐 ref 的 404。
- **GitHub webhook**：独立复审的 CLI 请求受沙箱网络限制，未读回，不冒称独立核实；执行方记录为 **0**。
- 证据摘要：[external-state.json](../../.local/platform-retirement-independent-20261109/external-state.json)。

### 1.2 历史处置（执行方当次操作记录，非独立重放）

#### Vercel

- 目标：`overseas-inventory`，project ID `prj_zziqelP0J1CMRIHnZhJVSNRBMqPK`，team `rallsix66s-projects`。
- 先解除 Git 自动发布关联：`DELETE /v9/projects/{id}/link` 成功，项目 `link` 字段消失；
  GitHub 仓库当时无 Vercel webhook（执行方记录 0），后续推送不再触发该项目的自动发布。
- 随后删除项目：`DELETE /v9/projects/{id}` 返回 **204**；当次直接查询项目返回 403/不存在，
  `overseas-inventory.vercel.app` 返回 **404**，项目列表不再包含该 project。
- 历史部署记录随项目删除，不能作为可回滚的运行环境；本机 3011 不受影响。

#### Supabase

两个项目原状态均为 `INACTIVE`：

| 项目 | ref | 名称 | 处置前状态 |
|---|---|---|---|
| DIS Project | `hzlhqyditalumhnxbaim` | 旧 Production | INACTIVE |
| DIS Staging | `hyarhvsjhkjpallbyifn` | 旧 Staging | INACTIVE |

- 离线归档：先用 Management API 恢复两个项目到 `ACTIVE_HEALTHY`，重置数据库密码后用
  `pg_dump --format=custom` 做完整逻辑备份（含 schema、表数据、auth/storage 元数据），
  再用 `pg_restore --list` 验证归档可读。
- Storage：两个项目的 Storage bucket 列表均为空（Management API 与 Storage API 双重核对），无对象需要下载；
  独立复审在归档中确认 `storage.buckets` 与 `storage.objects` 均为 **0**。
- 删除项目：两个项目均通过 `DELETE /v1/projects/{ref}` 删除（执行方记录各 **200**），随后当次直接查询均返回
  **404**，`GET /v1/projects` 不再返回这两个项目。
- 归档位置（本机，不入 Git）：
  `.local/platform-retirement-20261108/archive/`
  - `dis-project-hzlhqyditalumhnxbaim.dump`（733,471 bytes）
  - `dis-staging-hyarhvsjhkjpallbyifn.dump`（690,782 bytes）
  - `dis-*/...` 对应 SHA-256 见同目录 `SHA256SUMS.txt`
  - `storage-buckets.json`、`project-*.json` 为处置前只读快照

归档校验：

| 文件 | SHA-256 |
|---|---|
| DIS Project dump | `0EEB8C3528824B7533A020B10C3A074E82C65D14048109DFE3F1EAF8CF0F0463` |
| DIS Staging dump | `2A21FF68ADA1C5ED77268FFD39DA6598B3EDAFF16192257375AD2D24326E4F77` |

### 1.3 归档可读性与旧备份

- `SHA256SUMS.txt` 所列 5 个文件大小与 SHA-256 全部匹配。
- 两份 custom dump 均由 PostgreSQL 17 工具独立列举目录并完整离线解码，各包含 **59 个表数据段**，
  覆盖 public、auth、storage 与迁移记录。
- **旧 2026-07-18 本机备份仍保留**，未被本次退役删除。Management API 的 backups 列表为空，只表示没有可下载的
  旧托管备份，**不代表本机旧备份不存在**。
- 本次最终归档为 2026-11-08 两份 dump；归档已验证可读，但**未做恢复演练**：未连接数据库恢复、未执行输出 SQL、
  未保存或展示行值。不能把“逻辑归档可读”外推成“恢复演练已验收”或“完整云项目配置已保留”。

## 2. 代码依赖清理

- 认证统一为 Better Auth + 本地 PostgreSQL：
  - 新增 `src/lib/auth-client.ts`（浏览器端 sign-in/sign-out，仅调用 `/api/auth/*`）；
  - 新增 `src/lib/auth-middleware.ts`（`/api/p0-02/session` 会话探针），`src/proxy.ts` 改用它；
  - `src/lib/auth.ts` 删除 Supabase 回退与 `unwrapJoin`，只走 P0-02 session + 本地 profiles 查询；
  - 删除 `src/lib/supabase/`（client/server/middleware/helpers）、`src/app/auth/callback/route.ts`
    与 `SupabaseTokenCache`。
- `PostgresTokenCache` 是**保留的既有实现**，现役没有实例化消费者；**喜运达业务尚未启用**，本轮没有为满足文字描述
  新接喜运达。不要把它写成“本轮生产已接线”。
- 依赖：移除 `@supabase/ssr`、`@supabase/supabase-js`、`supabase` CLI；`package-lock.json` 同步更新。
- 配置：删除 `vercel.json`；`.env.example` 移除 Supabase/Vercel Cron 变量；CI 移除 Supabase 占位环境变量；
  删除仅用于旧 Supabase 烟雾测试的 `scripts/smoke-test-00025.ts`，并清理准备脚本中的旧 URL 过滤项。
- 保留：历史 `supabase/migrations/`、SQL、报告、备份与文档中的平台名称，不做全文清词；
  `tools/bigseller-scraper/sync/` 下的旧 Supabase REST 路径为历史 CLI 归档，不在现役 Web/worker 运行链中。

## 3. 构建与验证

### 3.1 执行方自验

- 不提供 `NEXT_PUBLIC_SUPABASE_*` / `SUPABASE_*` 环境变量时 `npm run build` 通过（BUILD 见 §4）。
- **全仓标准测试 803/804**，唯一失败为既有 Windows 换行环境下的 `opt6-production-apply` 基线；该失败不是本包引入，
  本包也没有修复它。
- 3011 真实页面：登录 → 经营总览 → 商品库存 → 物流在途 → 退出 → 未登录访问 `/dashboard` 重定向登录页，
  全部通过、console/pageerror 0（`.local/platform-retirement-20261108/smoke-result.json`）。
- 两个后台进程心跳与计划保持：库存同步 60 分钟、物流读取 10 分钟；`status.mjs` 均在线。
- `git diff --check` 退出 0。

### 3.2 独立复审（2026-11-09，不冒充执行方重跑）

- **认证/导航定向测试 37/37、退出 0**：`src/lib/auth.test.ts` 19、`src/proxy.test.ts` 13、
  `src/app/auth/login/login-feedback.test.ts` 5。
- **lint**：0 error / **16 个既有 warning**；`npm run lint -- --max-warnings 0` 因 warning 预算不满足而**不能称通过**，
  本轮没有清零，既有 CI 基线也没有被本包修复。复审未独立重跑 lint。
- `git diff --check` 退出 0。
- 没有重跑全仓套件，也没有再次构建；全仓 803/804 为执行方自验。
- 外部现状、代码/构建、真实浏览器验收见 §4。

## 4. 独立复审结论与证据（2026-11-09）

裁定：**`PLATFORM_RETIREMENT_V1_LOCAL_PASS`，阻断 0**。报告：
[`independent-review.md`](../../.local/platform-retirement-independent-20261109/independent-review.md)。

- **外部现状**：见 §1.1；Vercel 项目列表空、原项目 404；Supabase 项目列表空，逐 ref 查询为权限错误而非 404。
- **归档**：5 个归档文件 SHA-256 全部匹配；两份 dump 各 59 个表数据段完整离线解码；Storage 两项目均为 0；
  未做恢复演练。
- **代码与构建**：package/lock 无 Supabase/Vercel 包依赖；现役 `src` 无旧 SDK import / 云 API 调用；
  准备链源码采集成功、新认证文件在集合内、无旧文件悬空引用。BUILD **`8Dlf3nPVpGALDoWquDP4A`**，
  源码哈希 `731576f1…`，工作树/活动工作区/manifest/ready 一致，702 个源码文件、423 个编译产物无漂移。
- **运行现场**：3011 launcher 2420 / listener 46020，`/auth/login` 200；APP/AUTH/SYNC 只读连接均为
  `127.0.0.1:59345` 同一实例；实例无 Supabase/Vercel 环境变量，仓库 `.env.local` 与活动工作区也无两平台变量。
  09:20 快照：库存 pid 43836 心跳约 8 秒、下次 09:22；物流 pid 40476 心跳约 17 秒、下次 09:25:44。
- **真实浏览器**：独立会话 **11/11 通过，console/pageerror 0，浏览器两平台请求 0**。覆盖未登录首页重定向、
  匿名 session 401、表单登录、首页数据表、登录后 session 204、已登录访问登录页返回首页、导航读取库存/在途数据表、
  实际退出、退出后 session 401 和受保护页面重定向。未写库存或在途业务数据。
- 复审只写 `.local/platform-retirement-independent-20261109/` 证据，未改产品代码、远程设置、未提交/推送/合并、
  未部署、未重启服务。

## 5. 构建与运行现场

- BUILD：**`8Dlf3nPVpGALDoWquDP4A`**，源码快照 `731576f1cc52e8e6…`；本机 3011（pid 2420、login 200）、PostgreSQL 59345。
- 本机 3011、PostgreSQL 59345 与两个后台同步计划保持运行；本包不重建数据库、不清理 `.local`。
- 正式部署状态：Vercel 已退出，**新版正式部署尚未完成**；本包不把本地验证写成生产部署。
- 本包不改数据库结构、不改商品身份/绑定/同步机制；现役数据库与两个后台计划沿用。

## 6. 证据与限制

- 执行方证据：`.local/platform-retirement-20261108/`（归档、`SHA256SUMS.txt`、日志、回读结果），不入 Git。
- 独立复审证据：`.local/platform-retirement-independent-20261109/`，不入 Git。
- 未做：Supabase 旧 2026-07-18 本机备份的恢复演练（本机备份保留）；归档恢复演练；Storage 无对象可归档；
  多日稳定性、完整权限矩阵、失败注入等既有边界不在本包范围。
- 外部平台删除不可逆；归档 dump 仅保证本机可读取，未迁入新版、未上传第三方存储。

## 7. 临时访问凭据处置（2026-11-09）

仅处置本包专用凭据，不扩大到其他项目或连接器；未重跑业务验收。

| 凭据 | 处置尝试 | 结果 |
|---|---|---|
| Vercel 访问令牌（本包临时） | `DELETE /v3/user/tokens/current?reason=logout` | 返回 **403 `forbidden / Not authorized`**；随后 `GET /v9/projects`、`GET /v2/user` 同样 403。该令牌已不具备任何可用管理访问能力（无法区分已过期、已撤销或权限范围变化），无法再由本机完成正式撤销调用。 |
| Supabase 访问令牌（本包临时，`sbp_…`） | 尝试 `DELETE /v1/access-tokens/current`、`/v1/personal-access-tokens/current` 等 | 均 **404**；Management API 未提供 PAT 自助撤销端点。令牌仍能认证，但 `GET /v1/projects` 返回 `[]`，可达项目为 **0**，原项目已删除，实际权限面仅剩空的账号项目列表。**需用户在 Supabase Dashboard 的 Access Tokens 页面手动撤销**（本机未持久化该令牌）。 |
| 临时数据库密码（归档用） | 所属项目已删除 | 随两个 Supabase 项目删除而失效，未写入仓库或 `.local` 配置。 |
| `retire_archive` 临时 secret key | 所属项目已删除 | 随项目删除而失效，未写入仓库。 |

本机未发现上述令牌的持久化副本：环境变量不存在，Vercel/Supabase CLI 凭据目录没有本包令牌，`.local` 证据脚本也只在
运行时从环境变量读取。未新增、未保留可复用的平台凭据。

## 8. Git 交付

本包在独立复审通过后按既有授权提交、推送、创建 PR 并合并到远程 `master`；PR 链接、合并提交与远程回读结果在合并后
回填到本节及 `current-task.md` / `current-state.md`。正式部署仍为“未完成”。
