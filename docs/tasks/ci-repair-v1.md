# CI 修复 v1（跨平台基线 + 现役数据库检查）

- 日期：2026-11-17（初版 + 独立审查补修）
- 分支：`codex/ci-repair-v1`（初版）、`codex/ci-repair-v1-followup`（补修）
- PR：初版 **[#17](https://github.com/rallsix66/ICE-OS/pull/17)**、文档收尾 **[#18](https://github.com/rallsix66/ICE-OS/pull/18)**、补修 **[#19](https://github.com/rallsix66/ICE-OS/pull/19)**
- 初版实现提交：`af231c3`；初版文档：`238477c`；收尾文档：`979a365`
- 补修实现提交：`c1d26ea`（`fix(ci): 收紧数据库空库与只读断言`）
- 状态：初版与文档收尾已合并；补修 PR #19 实现提交已通过四组 CI，最终 head 与 master 合并/CI 见交付回执。
- 初版 PR final head（`238477c`）CI：<https://github.com/rallsix66/ICE-OS/actions/runs/44040075051>
- 初版合并提交：**`a36959579db44125608faa3fe5e3779a011d88f5`**；master CI：<https://github.com/rallsix66/ICE-OS/actions/runs/44040384827>
- 文档收尾 PR #18 最终 master：**`b0337986173419f78c3c3af887f72268fe6f3009`**；CI：<https://github.com/rallsix66/ICE-OS/actions/runs/44041324456>
- 补修实现提交 CI：<https://github.com/rallsix66/ICE-OS/actions/runs/44044902291>
- 必需检查：`Tests`、`Lint`、`Build`、`Database checks`（`strict=false`、`enforce_admins=true`）

## 1. 原失败根因

1. `scripts/p0-01/opt6-baseline.mjs`、`scripts/p0-02/opt6-baseline.mjs` 的批准指纹同时比较原始 SHA、LF 规范化 SHA、CRLF/LF 数量。批准记录捕获自 Windows CRLF 工作区；Linux 检出为 LF 后，原始 SHA 与换行计数必然不同，`tests/p0-01/opt6-baseline.test.ts` 的两条断言失败。
2. `src/features/database/opt6-production-apply.test.ts` 只 `.replace(/\r\n/g, '\n')` migration，没有规范化 packet；Windows 上 packet 为 CRLF、migration 为 LF，`embeds the canonical migration body byte-for-byte` 失败。
3. 默认 CI 仍调用已归档的 `test:concurrency`（脚本固定 `exit 1`）和面向旧 Supabase 迁移的 `test:database-contract`，没有验证现役 P0-02 + catalog 结构。
4. 全仓 lint 有 19 条既有未使用变量/导入 warning，`--max-warnings 0` 失败。

## 2. 修复内容

### 2.1 跨平台指纹

- 批准指纹**只比较 `normalizedLfSha256`**；原始 `sha256`、`crlfCount`、`loneLfCount` 保留在 mismatch 诊断与基线文件中，只作检出格式诊断，不作为通过条件。
- 两份 `opt6-approved-baseline.json` 更新了测试文件的新规范化 SHA 与诊断字段（原因：测试增加 LF/CRLF 等价断言）；历史 SQL 未修改，未用改 SQL 的方式凑指纹。
- `knownFailure` 保留历史事实，并注明 2026-11-17 已由规范化比较修复；旧 runner 的检测器保留以兼容历史调用。
- 新增 LF/CRLF 等价验证：把批准文件统一写成 CRLF 副本后规范化指纹仍通过；仅修改 migration 内容的篡改仍被拒绝。
- `opt6-production-apply.test.ts` 对 packet 与 migration 同时规范化；保留嵌入式正文、历史重查、结构校验、篡改/额外异常拒绝断言；新增断言证明未规范化的 CRLF packet 不匹配、规范化后才匹配。

### 2.2 现役数据库检查

新增：

- 命令：`npm run ci:database` → `scripts/ci/database.mjs`。
- 目标：GitHub Actions `postgres:17-alpine` 临时库；要求空库（public 无对象、无用户/ICE schema）；`CI=true` 或显式 `CI_DATABASE_RESET=1` 才允许执行；非空目标明确失败，不清空业务库，不执行 public 清空/重建。
- 安装顺序：P0-02 基础角色/身份/扩展/`010_public_schema`/参考数据/最小权限 → catalog 001–042 的现役依赖顺序（001/002/003/004/007/008/009–013/015/036/037/016/018–021/016_functions/022–035/038–042），共 **45 个 SQL 文件**。
- 合成数据：仅 CI 临时库内插入 admin/operator 身份、一个 synthetic baseline release、一个 catalog item；不依赖 `.local`、现役备份、外部凭据。
- 应用角色：`SET ROLE ice_p0_02_app_runner` + `request.jwt.claim.sub`，不使用管理连接做业务断言。
- 验证项：应用角色读取 item；`catalog.assign_initial_code` 保存 `CI-0001` 并回读 revision 2；`catalog.read_operation_records` 返回该记录；operator 身份被拒绝（42501）；`BEGIN READ ONLY` 下业务写入被拒绝（25006）；042 函数存在；输出表/函数/执行数量。
- 实测输出：45 个 SQL 文件、82 张 catalog/catalog_private 表、232 个函数；`appRead=1`、`rpcSaved.iceCode=CI-0001`/`revision=2`、`operationsTotal=1`、`unauthorizedIdentity=42501`、`readOnlyWrite=25006`。

### 2.3 工作流拆分

`.github/workflows/ci.yml` 拆成四个独立 job：

| Job 名称 | 内容 |
| --- | --- |
| `Tests` | `npm run test`（默认单元测试） |
| `Lint` | `npm run lint -- --max-warnings 0` |
| `Build` | `npm run build` |
| `Database checks` | PostgreSQL 17 service + `npm run ci:database` |

保留 `pull_request`、`push: master`、`workflow_dispatch` 与同分支/PR 自动取消；单元测试失败不再阻断 lint/build/database 的独立结果。

### 2.4 旧入口

- `test:concurrency`：保留原命令与归档说明，固定 `exit 1`，明确历史用途；**退出默认 CI**。
- `test:database-contract`：保留旧 Supabase 迁移测试入口，明确历史用途；**退出默认 CI**。
- 不删除旧脚本或历史测试，避免丢失历史证据。

### 2.5 Lint

清理 19 条既有 warning：删除未使用变量/导入，保留有副作用的调用（如 browser 填写、状态读取），不关闭规则、不降低 `--max-warnings 0`。

## 3. 验证结果

### 3.1 本地定向/全量

| 检查 | 结果 |
| --- | --- |
| `npm test` | 60 passed files / 1 skipped；**948 passed / 16 skipped / 0 failed** |
| `npm run lint -- --max-warnings 0` | 0 error / 0 warning |
| `npm run build` | 成功（Next.js 16.2.9，含 `/dashboard/operations` 等路由） |
| `npm run ci:database`（本机临时库） | 成功；45 SQL / 82 表 / 232 函数；应用读取、RPC 保存、操作记录读取、未授权拒绝、只读写入拒绝全部通过 |
| 非空 ICE schema | 已安装库二次运行明确 `CI_DATABASE_NOT_EMPTY`，未重装；本轮补修前的 public 路径见 §4.1 |

### 3.2 PR CI

初版实现提交 `af231c3` 的 PR 运行：<https://github.com/rallsix66/ICE-OS/actions/runs/44038848207>，四个 job 全部实际执行并通过：

| Job | 结果 | 链接 |
| --- | --- | --- |
| Tests | SUCCESS | <https://github.com/rallsix66/ICE-OS/actions/runs/44038848207/job/133888225773> |
| Lint | SUCCESS | <https://github.com/rallsix66/ICE-OS/actions/runs/44038848207/job/133888225962> |
| Build | SUCCESS | <https://github.com/rallsix66/ICE-OS/actions/runs/44038848207/job/133888225646> |
| Database checks | SUCCESS | <https://github.com/rallsix66/ICE-OS/actions/runs/44038848207/job/133888225500> |

PR #17 最终 head `238477c`（含文档提交）的 CI：<https://github.com/rallsix66/ICE-OS/actions/runs/44040075051>，四个 job 全部实际执行并通过：

| Job | 结果 | 链接 |
| --- | --- | --- |
| Tests | SUCCESS | <https://github.com/rallsix66/ICE-OS/actions/runs/44040075051/job/133892224461> |
| Lint | SUCCESS | <https://github.com/rallsix66/ICE-OS/actions/runs/44040075051/job/133892224806> |
| Build | SUCCESS | <https://github.com/rallsix66/ICE-OS/actions/runs/44040075051/job/133892224740> |
| Database checks | SUCCESS | <https://github.com/rallsix66/ICE-OS/actions/runs/44040075051/job/133892224742> |

### 3.3 master CI

合并提交 `a369595` 的 push 运行：<https://github.com/rallsix66/ICE-OS/actions/runs/44040384827>。四个 job 全部实际执行并通过：

| Job | 结果 |
| --- | --- |
| Tests | SUCCESS |
| Lint | SUCCESS |
| Build | SUCCESS |
| Database checks | SUCCESS |

文档收尾 PR #18 合并后的最终 master `b033798` 运行：<https://github.com/rallsix66/ICE-OS/actions/runs/44041324456>。四个 job 全部实际执行并通过：

| Job | 结果 |
| --- | --- |
| Tests | SUCCESS |
| Lint | SUCCESS |
| Build | SUCCESS |
| Database checks | SUCCESS |

不以 PR head 的绿灯冒充 master 结果；上述运行分别对应合并提交本身。

### 3.4 必需检查

`master` 已配置 required status checks，并回读确认：

- 上下文：`Tests`、`Lint`、`Build`、`Database checks`
- `strict=false`（不要求分支始终最新）
- `enforce_admins=true`（管理员也不能绕过）
- 未增加必需审查人数、签名或部署审批；未改变其他仓库设置。

## 4. 补修（独立审查 B1/B2）

独立审查报告：`.local/catalog/ci-repair-v1-review-20261117/independent-review.md`（本机证据，不入库）。其结论为：初版 CI 真实运行、合并和必需检查已确认；但 B1 空库检查遗漏 public 并随后清空、B2 只读断言接受权限拒绝，最终验收暂不 PASS，需最小补修；D1 文档索引遗漏；操作记录 v1 的 PASS 不变。以下为执行方修复与定向自验，**不自行宣布独立复核 PASS**。

### 4.1 B1：取消 public 清空，补全空库检查

原实现只检查 `catalog.catalog_item`、`p0_02_meta.platform_instance` 和四个 ICE schema，然后执行 `DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public`。只有 public 业务表、尚无 ICE schema 的非空库会通过检查并被清空。

修复（`scripts/ci/database.mjs`）：

- 删除 public 的 `DROP/CREATE`，正常空库直接在默认 public schema 上安装；
- 安装前检查 public 中已有 relation、routine、type，以及其他非系统 schema（同时保留四个 ICE schema 的显式拒绝）；
- 任一条件命中时，在任何安装写入之前抛出 `CI_DATABASE_NOT_EMPTY:<database>`；
- 不新增重置/备份框架，不改变非空目标的处理方式。

定向验证（本机隔离 PostgreSQL 17，端口 55437；不使用现役 59345）：

| 场景 | 命令/操作 | 实际结果 |
| --- | --- | --- |
| 正常空库 | `CI=true ... npm run ci:database` | 成功；45 SQL / 82 表 / 232 函数；`appRead=1`、RPC `CI-0001`/revision 2、`operationsTotal=1`、`unauthorizedIdentity=42501`、`readOnlyWrite=25006` |
| 非空 public | 先 `CREATE TABLE public.keep_me(id integer PRIMARY KEY, note text NOT NULL); INSERT ... (1,'must survive')`，再运行同一命令 | 脚本 exit 1，输出 `CI_DATABASE_NOT_EMPTY:ci_followup_public_nonempty`；事后 `keep_me` 仍 1 行、note 仍 `must survive`，`catalog`/`p0_02_meta` schema 数量均为 0，证明未开始安装 |

### 4.2 B2：只读断言只接受 25006

原实现同时接受 `25006` 和 `42501`。`ice_p0_02_app_runner` 本来没有 `catalog.audit_event` 的 INSERT 权限，因此撤掉 `READ ONLY` 后普通权限拒绝也可能让该项通过。

修复：只读事务写入拒绝项只接受 `25006`；未授权身份检查仍只接受 `42501`；应用角色和权限未调整。

定向验证：

- 临时副本：仅把 `BEGIN READ ONLY` 改为 `BEGIN`，在空库运行，脚本 exit 1，输出 `CI_DATABASE_READ_ONLY_WRITE: expected 25006, got 42501: permission denied for table audit_event`；证明权限拒绝不能冒充只读拒绝。临时副本已删除，未进入提交。
- 恢复正式实现：在另一空库完整运行成功，`readOnlyWrite=25006`。

### 4.3 D1：文档证据补齐

- 补记 PR #17 final head `238477c` 与 run 44040075051；
- 补记文档收尾 PR #18、最终 master `b033798` 与 run 44041324456；
- 补记本轮补修 PR、实现提交、定向验证与 CI。

### 4.4 补修 PR 与 CI

- PR：[#19](https://github.com/rallsix66/ICE-OS/pull/19)
- 实现提交：`c1d26eab4e642796975e449b2915974e316e5cfd`（`fix(ci): 收紧数据库空库与只读断言`）
- 实现提交 CI：<https://github.com/rallsix66/ICE-OS/actions/runs/44044902291>；四组实际执行并通过：

| Job | 结果 | 链接 |
| --- | --- | --- |
| Tests | SUCCESS | <https://github.com/rallsix66/ICE-OS/actions/runs/44044902291/job/133908076455> |
| Lint | SUCCESS | <https://github.com/rallsix66/ICE-OS/actions/runs/44044902291/job/133908076789> |
| Build | SUCCESS | <https://github.com/rallsix66/ICE-OS/actions/runs/44044902291/job/133908076947> |
| Database checks | SUCCESS | <https://github.com/rallsix66/ICE-OS/actions/runs/44044902291/job/133908077038> |

本机 `npx eslint scripts/ci/database.mjs --max-warnings 0` 与 `git diff --check` 通过。补修 PR 最终 head 的 CI、合并 SHA 与合并后 master 运行在交付回执列明。

## 5. 范围与边界

- 本包只改 CI、跨平台基线、数据库 CI 入口、lint 清理与文档；未改业务逻辑、数据库结构、现役实例或无关部署准备。
- 不重新验收操作记录页面；其既有“独立复核 PASS、阻断 0”结论保持不变。
- 数据库检查只连接 GitHub Actions 临时库或显式授权的本地临时库；不连接现役 3011/59345，不读写现役业务数据，不启动 worker，不重建/重启实例。
- `CI=true` 是 GitHub Actions 的临时库授权；本地运行需显式 `CI_DATABASE_RESET=1`。目标必须为空（public 无对象、无用户/ICE schema）；脚本不提供数据库重置或备份。
- 未做 200% 缩放、长期稳定性、生产部署与真实外部服务凭据验证。

## 6. 证据索引

- 工作流：`.github/workflows/ci.yml`
- 数据库入口：`scripts/ci/database.mjs`、`package.json` 的 `ci:database`
- 跨平台基线：`scripts/p0-01/opt6-baseline.mjs`、`scripts/p0-02/opt6-baseline.mjs`、两份 `opt6-approved-baseline.json`
- 测试：`tests/p0-01/opt6-baseline.test.ts`、`src/features/database/opt6-production-apply.test.ts`
- PR：初版 <https://github.com/rallsix66/ICE-OS/pull/17>、文档收尾 <https://github.com/rallsix66/ICE-OS/pull/18>、补修 <https://github.com/rallsix66/ICE-OS/pull/19>
- 初版合并提交：`a36959579db44125608faa3fe5e3779a011d88f5`；最终 master（文档收尾）：`b0337986173419f78c3c3af887f72268fe6f3009`
- 初版 PR final head CI：<https://github.com/rallsix66/ICE-OS/actions/runs/44040075051>
- 初版 master CI：<https://github.com/rallsix66/ICE-OS/actions/runs/44040384827>
- 文档收尾 master CI：<https://github.com/rallsix66/ICE-OS/actions/runs/44041324456>
- 补修实现提交：`c1d26eab4e642796975e449b2915974e316e5cfd`；CI：<https://github.com/rallsix66/ICE-OS/actions/runs/44044902291>
- 独立审查报告：`.local/catalog/ci-repair-v1-review-20261117/independent-review.md`（本机证据，不入库；结论不是执行方 PASS）
- 本机补修验证日志：`.local/catalog/ci-repair-v1-followup-20261117/`（空库、非空 public、B2 负向/正向运行日志，不入库）
- 必需检查回读：`["Tests","Lint","Build","Database checks"]`，`strict=false`，`enforce_admins=true`，未增加审查人数/签名/部署审批。
