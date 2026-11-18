# 权限设置 v1：角色与账号管理 + 海外库存成员使用（2026-11-17）

适用实例：**`run-20261026T211500Z-11a22b33`**（Web `3011` / PostgreSQL `59345`）。
交付状态：**2026-11-18 10:52 本机现役实例最终独立复核 PASS，阻断 0；本地 Git 收尾已完成**。首轮发现与补修保留在 §8–§11，验收结果见 §12，本地 Git 收尾见 §13。
运行构建：**BUILD `y_naEIGp34k9I4LE66Eul`**（§9/§10 的 `OsuD3WcqYIAZFXEFqws7p` 已被本轮替代），预览进程与实例 `next-workspace` 一致。

- 上一包（已复核 PASS）：[live-data-resume-20261117.md](live-data-resume-20261117.md)（§10 复核登记与两处表述澄清）
- 库存与后台运行交接：[inventory-sync-v1-runbook.md](inventory-sync-v1-runbook.md)
- 本包测试账号（含密码，**不入 Git**）：`.local/catalog/permissions-v1-20261117/test-accounts.md`

## 1. 目标与边界

管理员能配置角色、创建账号并分配数据范围；成员登录后只能查询获准的海外库存；金额与功能由角色决定，具体市场/仓库由账号决定。

- 本包只配置两项能力：**库存查看**（仓库明细、商品汇总、历史快照及必要详情）、**库存金额查看**（估算货值）。
- 管理员保留现有全站管理能力；管理员账号只读展示，不能在本页被改角色/范围/停用。
- 不做：多角色叠加、硬删除账号、国内库存下放给成员、Mac 迁移与开机自启（正式部署另议）。

## 2. 实现

### 2.1 数据库 `db/catalog/043_permissions_v1.sql`（新增迁移，后附应用脚本 `scripts/catalog/apply-043.mjs`）

| 内容 | 说明 |
|---|---|
| 新表 `catalog.access_role` | 角色名（唯一、忽略大小写）、说明、`can_view_inventory`、`can_view_amount`（金额必须同时有库存查看）、`preset_key`（`lead`/`ops`）；预置「负责人」（含金额）、「运营」（不含金额），已存在不覆盖 |
| 新表 `catalog.account_access` | 一个账号一个角色（`profile_id` 主键 → `public.profiles`） |
| 新表 `catalog.account_access_warehouse` | 账号的仓库范围（只认 `status='confirmed'` 的现役海外仓，弃用仓 `48787` 不出现） |
| RLS | 三张表启用并强制 RLS，只有「管理员」与「属主」两条策略；不授予任何运行角色直接的 SELECT/INSERT |
| 成员读取 | `catalog.require_inventory_read()`：管理员，或启用中且被授予库存查看的成员；否则 `CATALOG_FORBIDDEN` |
| 范围收窄 | `catalog.inventory_scope_payload()` 对成员取「账号 scope ∩ 被授予仓库」，列表/明细/汇总/逐仓状态/历史快照全部走这一个入口 |
| 只读函数守卫 | `read_inventory_warehouse_states` / `_warehouse_rows` / `_product_summary` / `_item` / `_snapshot_batches` / `_snapshot_rows` 的入口由 `require_admin()` 换成 `require_inventory_read()`；显式仓库参数追加「必须在我被授予的范围内」，越范围按 `INVENTORY_WAREHOUSE_UNKNOWN` 拒绝；`read_inventory_item(allWarehouses)` 只对管理员成立 |
| 函数改写方式 | 用 `pg_get_functiondef` 取现行定义做**精确文本替换**后重装，替换次数必须等于预期，否则整段报错（不会半安装）；幂等，重复安装跳过 |
| 成员读路径 RLS | 只读函数以属主身份执行，而 `catalog.catalog_item` / `catalog_item_code` 原来只有 `is_admin()` 策略 → 给「成员读路径真正引用到、且缺属主策略」的表补一条仅属主的 SELECT 策略（表集合按函数文本递归算出） |
| 管理端 RPC | `read_access_roles`、`save_access_role`、`access_account_rows`、`read_access_account`（含 `authUserId` 供服务端重置密码）、`read_access_warehouse_options`、`create_access_account`、`update_access_account`、`set_access_account_active`、`read_my_inventory_access`；全部 `SECURITY DEFINER` + `require_admin`（成员自己的摘要除外）+ `inventory_audit` 留痕 |
| 金额 | 数据库不裁剪：读模型本来只返回数量，估算货值由服务端按「采用进货价 × 数量」计算，无金额权限时服务端**不读成本、不下发该列** |

### 2.2 应用层

- `src/features/access/`：`types.ts`、`server/reads.ts`（管理端读取 + 成员权限摘要）、`server/actions.ts`（建角色 / 建号 / 改号 / 启停 / 重置密码，中文错误映射）、`server/auth-accounts.ts`（沿用 Better Auth：独立开通实例 `signUpEmail` + 同一套哈希改密，建号失败补偿删除认证账号）、`components/`（角色列表+权限配置、账号表格+编辑弹窗、拒绝态）。
- `src/app/dashboard/permissions/page.tsx`（角色管理）、`…/permissions/accounts/page.tsx`（账号管理）：左侧角色列表、右侧权限配置；账号页支持姓名/登录账号搜索、角色与状态筛选、新增、编辑、启用停用、重置密码；市场分组勾选仓库（支持整市场全选）。
- 导航：`workspace-shell.tsx` 增加「权限设置」（仅管理员），导航项带 `requires: admin|inventory`；成员只看到「商品库存」。`navigation-config.ts` 新增 `ICE_V4_ADMIN_NAV_HREFS` 并补导航合同测试。
- 成员进库存：`features/inventory/server/reads.ts` 新增 `requireInventoryReader()`（管理员或已授予库存查看的成员）；`/dashboard/inventory` 按身份分流——管理员沿用原来的总览/待处理/绑定/国内快照，成员只读自己范围内的海外库存（来源固定「仅海外」、无待处理/绑定入口、金额按角色）。
- 成员登录后访问 `/dashboard` 会直接进入 `/dashboard/inventory`（不再看到管理员总览的失败面板）。
- 范围为空时页面明确显示「暂无授权库存：请联系管理员分配市场与仓库」。

## 3. 真实验收（现役 3011，BUILD `f2jDFmsWWpyDxaOzmrljp`）

证据目录 `.local/catalog/permissions-v1-20261117/`（截图 + JSON）；脚本 `e2e/verify-permissions.mjs`、`e2e/verify-supplement.mjs`。

### 3.1 主流程 **22/22 PASS**（console 0 / pageerror 0）

| 步骤 | 结果 |
|---|---|
| 管理员导航含「权限设置」 | 通过（成员导航只有「商品库存」） |
| 角色列表预置「负责人」「运营」 | 通过 |
| 管理员新增/维护普通角色（验收专员） | 通过，左侧列表出现 |
| 管理员创建账号（验收成员V1 · 验收专员 · 越南 · 1 个仓 · 启用） | 通过，列表显示角色/范围/状态 |
| 成员登录 → 只看到授权仓真实库存行（VN 50 行） | 通过 |
| 成员页面无金额列 | 通过（无「估算货值」） |
| 成员无待处理入口、无国内冻结快照 | 通过 |
| 成员商品汇总（同样不含金额） | 通过 |
| 成员历史快照（批次列表 50 + 明细 50） | 通过 |
| 管理员给角色打开金额后保存 | 通过 |
| 管理员把账号范围扩到第二个仓 | 通过，列表范围刷新 |
| 改范围后成员两个仓都能查（VN 50 行 / 龙仔厝 50 行） | 通过 |
| 改金额权限后成员立即看到估算货值列 | 通过 |
| 成员直接带未授权仓库参数越权访问 | 被拒：`所选仓库不在当前账号的仓库清单里`，不返回该仓数据 |
| 成员直接访问 `/dashboard/sync` | 被拒：`没有访问权限`，不显示同步数据 |
| 清空范围后成员页面 | 显示「暂无授权库存：请联系管理员分配市场与仓库」 |
| 管理员停用账号 → 列表状态停用 | 通过 |
| 停用后成员不能继续使用 | 「账号已停用」页 |
| 管理员重新启用 → 状态启用 | 通过 |
| 交付账号状态（启用 · 含金额 · 2 个仓） | 通过 |
| 管理员原有库存页（全部仓、金额列、待处理 143、来源范围可选） | 通过 |

### 3.2 补充验证 **4/4 PASS**（`e2e/verify-supplement.mjs`）

| 检查 | 结果 |
|---|---|
| 管理员重置成员密码 | 通过（页面回执「已重置密码，请把新密码线下告知本人。」） |
| 成员用重置后的新密码登录并看到授权库存 | 通过 |
| 管理端把密码改回交付用密码 | 通过（交付凭据见本机 `test-accounts.md`） |
| 管理员原有库存维护（打开行详情，绑定/来源维护区在） | 通过（`inventory-binding-section` 可见，URL 带 item/row） |

> 本轮曾发现并修复一个真实缺陷：Better Auth 的 `internalAdapter.updatePassword(userId, password)` 期望**已哈希**的密码，最初传入明文导致「重置后登录失败」；现改为先 `ctx.password.hash()` 再写，补充验证已闭环。

### 3.3 成员授权范围一致性 **9/9 PASS**（`e2e/verify-member-scope.mjs`，与数据库基准逐项核对）

| 检查 | 结果 |
|---|---|
| 成员列表「共 N 条」= 被授予仓库「最后完整成功批次」行数之和 | **233 = 89（越南）+ 144（龙仔厝）** |
| 成员列表响应不含金额符号（无金额权限） | 通过（无 `¥`） |
| 单仓下钻合计与行范围：越南 89、龙仔厝 144，且只出现本仓 | 通过 |
| 成员商品详情：只出现被授予仓库，不出现其它 5 个仓 | 通过 |
| 成员商品详情不含金额 | 通过 |
| 成员商品汇总：不出现未授权仓库、不含金额 | 通过 |
| 历史快照：越南仓 189 批 / 最新批 89 行，与数据库一致 | 通过 |
| 历史快照：龙仔厝仓 189 批 / 最新批 144 行，与数据库一致 | 通过 |

### 3.4 代码与数据库检查

- `apply-043`：克隆库 `--commit` **39/39 PASS**；现役库 `--rollback` 与 `--commit` 均 **39/39 PASS**（含未授权成员被拒、管理员口径不变、成员只看 1 个仓、越范围被拒、停用后失去读取、改角色金额立即生效、建号/改号/停用/审计、探针回滚后业务行数不变）。
- `tsc --noEmit`：仅既有 BEST 5 条基线错误；改动文件 `eslint` 0；导航合同单测 **8/8**；受影响单测 `src/ui` + `src/features/inventory` **42/42**。
- **现役同步未中断**：本包期间库存计划任务 17:22、18:22 均 `success`（下一次 19:22）；物流在途读取按 10 分钟继续（18:56 / 19:06 / 19:16）；飞书商品来源读取 18:55 照常（下次 19:55）。三次 Web 重启（构建提升）只重启 Next，未触碰三个后台进程。
- 数据库结构：新增 3 张表 + 9 个函数（6 个只读函数守卫改写、`inventory_scope_payload` 范围收窄、成员读路径属主 SELECT 策略）；**未改 001–042 的业务表语义**。
- 写入留痕：`catalog.inventory_audit` 记录 `access_role_created/updated`、`access_account_created/updated/enabled/disabled`（含前后值）。

## 4. 交付入口与测试账号

| 项 | 值 |
|---|---|
| 角色管理 | http://127.0.0.1:3011/dashboard/permissions |
| 账号管理 | http://127.0.0.1:3011/dashboard/permissions/accounts |
| 成员库存 | http://127.0.0.1:3011/dashboard/inventory |
| 管理员 | `admin@catalog.test`（密码见 `…\instance\login.local-preview.txt`） |
| 成员 | `member.v1@catalog.test` · 姓名「验收成员V1」· 角色「验收专员」（含金额）· 范围 越南青林湾仓库 + DEE-龙仔厝（ICE专属）· 启用 |

**账号凭据只在本机**：`.local/catalog/permissions-v1-20261117/test-accounts.md`（`.local` 不入 Git，本文件不含密码明文）。

## 5. 实际改动文件

- 新增：`db/catalog/043_permissions_v1.sql`、`scripts/catalog/apply-043.mjs`、`src/features/access/**`、`src/app/dashboard/permissions/**`。
- 首轮补修新增：`db/catalog/044_permissions_v1_fixes.sql`、`scripts/catalog/apply-044.mjs`、`src/features/access/server/actions.test.ts`；修改 `scripts/inventory/prepare-instance.mjs`、`scripts/catalog/prepare-local-preview.mjs`（按依赖接入 043/044，后者增加 `requiresFunctions` 判定）。
- 修改：`src/app/dashboard/inventory/page.tsx`（成员分流/来源固定海外/成员金额取数/快照仓库失效提示）、`src/features/inventory/server/reads.ts`（`requireInventoryReader`、`getMemberItemAmounts`）、`src/features/inventory/components/inventory-view.tsx`（`warehouses`/`scopeEmpty`/`allowDomestic` 入参、快照选仓状态、成员空范围文案）、`src/features/inventory/components/inventory-snapshot-view.tsx`（失效仓书签提示）、`src/features/inventory/components/inventory-filter-bar.tsx`（`allowDomestic`）、`src/features/access/server/actions.ts`（密码重置限制与留痕）、`src/app/dashboard/layout.tsx`（权限→外壳）、`src/app/dashboard/page.tsx`（成员重定向到库存）、`src/ui/ice-v4/workspace-shell.tsx`（按权限渲染导航 + 面包屑）、`src/ui/ice-v4/navigation-config.ts`（管理员导航常量）、`src/ui/ice-v4/navigation-config.test.ts`（导航合同）。
- 文档：本文件、`docs/current-state.md`、`docs/tasks/current-task.md`、`AGENTS.md`、`docs/tasks/inventory-sync-v1-runbook.md`（权限设置与成员使用交接）。
- 保留未改：既有 Mac 部署准备改动（`scripts/catalog/start-catalog-postgres.mjs` 等 6 个文件）与工作区其它无关改动，均保持原样；未提交/推送/部署。

## 6. 尚存范围与已知边界

1. **单角色**：一个账号只分配一个角色，不支持多角色叠加；不做硬删除（停用即失效）。
2. **管理员账号只读**：不能在权限设置里改管理员角色、范围或停用（防止把自己锁死）；密码重置也在服务端拒绝管理员目标。
3. **金额口径**：估算货值 = 采用进货价 × 数量，沿用既有商品库「采用进货价」；无金额权限时数据库函数拒绝、页面不下发。
4. **成员可见范围仅海外库存**：国内聚水潭冻结快照、数据同步、物流在途、操作记录、商品库仍是管理员功能；成员直接访问会看到「没有访问权限」。
5. **认证账号开通**：建号时先建 Better Auth 认证账号、再写业务行；业务写失败会补偿删除认证账号。极端情况下（进程在两步之间被杀）可能留下一个没有 profiles/映射的认证账号，它无法登录后看到任何业务数据。
6. **审计只记管理端操作**：成员本身是只读，不产生业务写入；角色/账号变更与密码重置全部留痕（密码重置不含密码/哈希）。
7. **未做**：多日稳定性、并发建号冲突、权限矩阵穷举、Mac 迁移/开机自启（正式部署交付）。

## 7. 运行交接（最短路径）

```powershell
# Web（现役 3011；本次已用新 BUILD 重启，三个后台未受影响）
$env:CATALOG_PREVIEW_PORT="3011"; node scripts/catalog/start-local-preview.mjs --run-id run-20261026T211500Z-11a22b33
# 构建 / 升级（先建后提升，再起 Web）
node scripts/catalog/build-preview-workspace.mjs --run-id run-20261026T211500Z-11a22b33
node scripts/catalog/promote-preview-build.mjs --run-id run-20261026T211500Z-11a22b33
# 权限迁移（默认 rollback 只验证；现役提交需显式允许；顺序 043 → 044）
node scripts/catalog/apply-043.mjs --rollback --run-id run-20261026T211500Z-11a22b33
node scripts/catalog/apply-043.mjs --commit --allow-live-commit --run-id run-20261026T211500Z-11a22b33
node scripts/catalog/apply-044.mjs --rollback --run-id run-20261026T211500Z-11a22b33
node scripts/catalog/apply-044.mjs --commit --allow-live-commit --run-id run-20261026T211500Z-11a22b33
```

- 三个后台（库存 60 分钟、物流 10 分钟、飞书商品资料 60 分钟）在本包期间保持运行，重启 Web 不影响它们。
- 成员登录后只看到「商品库存」；管理员看到全部入口 + 「权限设置」。
- 忘记成员密码：账号管理 → 编辑 → 重置密码；停用：列表「停用」。

## 8. 复核状态

**2026-11-18 首轮独立复核未通过。** 复核对象为上列 3011 实例，运行工作区的 BUILD_ID 与 ready 记录一致。下列时间均为北京时间。**本节保留首轮复核原文；对应补修与验证见 §9。**

1. **先恢复海外库存发布。** 数据库仍启用每小时同步，设置中有 7 个仓。最近成功任务 `1021a42a-4961-42dd-8b75-951edd8bbbcc` 于 11-17 18:22 发布 7 仓、655 行，源观测时间 18:22:21。从 11-17 19:22 到 11-18 08:22，数据库连续 14 条计划任务均为 `failed / SCOPE_EMPTY`，两个日期的 worker 原始日志同样记录了 14 次 `run_claim_scope_empty`。043 将所有非管理员调用共有范围函数时的结果与成员授权取交集，后台任务没有成员账号。领取任务也调用了这个函数，拿到空清单后提前结束。恢复后台从同步配置读取参与仓，只在成员读取时应用成员授权。验收看同一次正常任务的真实导出、7 仓新批次和页面最新时间，保留这 14 条失败历史。[范围变更](../../db/catalog/043_permissions_v1.sql#L438) · [后台领取](../../db/catalog/016_inventory_sync_functions.sql#L2413) · [后台失败处理](../../tools/inventory-sync/worker.py#L363)
2. **让金额授权对实际货值生效。** 11-18 08:59 用管理与成员账号分别打开越南青林湾仓。WM0043「CHIC PEAK 唇泥 P01- 1.8g」，来源 SKU `757577407120`，双方可售均为 2,295。管理员货值为 **¥6,747.30**，含金额权限的成员为 **—**。同一仓第一页，管理员 50 行有金额，成员 0 行有金额。成员使用了要求管理员身份的全商品成本查询，错误被当成缺价。用服务端授权仓内的商品和数量计算所需货值。验收以修复后同仓同一批次对照为准，数量更新后按新数核算。撤掉金额权限时，成员收到的数据也应去掉成本和货值。[库存页](../../src/app/dashboard/inventory/page.tsx#L112) · [成本函数](../../db/catalog/013_baseline_amounts_batch.sql#L7)
3. **成员详情及历史书签遵守所选范围。** 源码复核发现，从商品汇总打开商品详情时，数量与历史按仓过滤，但绑定查询读同商品全账号的仓库和来源 SKU，并将绑定明细传给浏览器。WM0035 在交付成员授权外另有 5 个仓的绑定（只读库计数）。省去成员详情用不到的绑定维护资料，必要数据只取授权范围。快照页另有一个选仓错误：显式指定的仓失效且成员仍有其他仓时，现有代码会默认改选第一个授权仓。应提示重选，只有打开未指定仓库的首页才自动选仓。验收从商品汇总打开跨仓商品的详情，再打开已收回仓的旧快照书签。[详情取数](../../db/catalog/016_inventory_sync_functions.sql#L1941) · [详情传给客户端](../../src/app/dashboard/inventory/page.tsx#L392) · [快照选仓](../../src/app/dashboard/inventory/page.tsx#L233)
4. **权限随标准实例准备生效。** 库存实例准备会重装库存函数和历史快照函数，两条准备路径都只安装到 042。新实例缺权限功能，已有权限的库重跑准备会被旧版管理员守卫覆盖。把 043 和本次修正按依赖接入两条现有路径。在隔离实例按标准入口准备并再次准备，确认授权保留、成员列表和历史快照仍能打开。[库存准备](../../scripts/inventory/prepare-instance.mjs#L186) · [预览准备](../../scripts/catalog/prepare-local-preview.mjs#L38)
5. **成员密码重置遵守管理员账号只读约定并留痕。** 页面禁用了管理员行的编辑，服务端重置动作只取目标认证 ID，忽略同时返回的系统管理员标志。该动作成功后也没有写入账号操作记录。复用已有标志约束重置目标，成功重置时记操作者、目标、时间，记录中只保留操作信息。普通成员使用新密码登录的原证据可沿用。[重置动作](../../src/features/access/server/actions.ts#L197)

**可沿用的成果。** 主审在 3011 打开角色管理、账号管理、成员库存，并点开管理员行详情确认绑定区可用。只读审计中有交付成员的建号记录。执行方关于两仓 233 = 89 + 144、单仓下钻、批次计数、普通成员改密后登录以及停用后的访问结果，沿用其对应证据。物流读取在 11-18 08:52、飞书商品来源读取在 08:56 均留下 `unchanged` 记录。

**9/9 的证据边界。** 数据库角色审计记录了 11-17 19:14:49「验收专员」已打开金额权限。19:19 的脚本使用交付成员，却只检查页面文字有没有 `¥`。这次缺符号与有权成员读不到成本一致，无法据此认定关闭金额权限时响应已裁剪。其详情检查打开的是仓库明细首行，商品汇总业务路径走不同的详情查询。下一轮集中复核本节的实际结果即可。

## 9. 首轮补修（2026-11-18）

状态：**执行方自验完成，交独立复核**。运行 BUILD **`OsuD3WcqYIAZFXEFqws7p`**，3011 login 200，`BUILD_ID` 与 ready 记录一致。执行方不宣布 PASS；复核建议与证据索引见本机 `.local/catalog/permissions-v1-20261117/review-request-round1.md`。

### 9.1 恢复现役海外库存更新（最高优先级）

- **根因**：043 把 `inventory_scope_payload()` 的所有非管理员调用都当成成员读取，后台领取任务没有登录成员身份，拿到空仓清单后以 `SCOPE_EMPTY` 结束。
- **修正**：新增 `db/catalog/044_permissions_v1_fixes.sql`，收窄条件改为 `catalog.access_profile_id() IS NOT NULL AND NOT catalog.is_admin()`；后台继续按同步配置的参与仓领取，成员读取仍按个人授权。
- **现役应用**：`scripts/catalog/apply-044.mjs` rollback **16/16**、commit **16/16**；真领取探针（sync 角色、无登录身份）拿到 **7 个仓 + runId**。`043` 的新装版本同步改成同一条件，避免新建实例再次出现。
- **真实导出**：用现有「立即同步」入口（管理员 UI，`data-testid=sync-manual-button`）触发，run **`e32fc114-8d97-4728-aa5e-da78b586908c`**：09:23:20 开始 → 导出观测 **09:23:39** → 09:23:42 `success`，**7 仓 / 655 行**（89 + 115 + 113 + 21 + 56 + 117 + 144），7 个 `last_observation_at` 全部更新；同步页「最近成功」**2026-11-18 09:23**，库存页 1,542 行。
- **自动周期也已恢复**：10:22 计划任务 **`4ac13453-021d-4513-a662-d748a77aa3d3`** 于 10:22:03 被后台领取、10:22:17 完成导出、**10:22:20 `success`**，7 仓 / 655 行；7 个 `last_observation_at` 均为 10:22:17，下次计划 11:22。同步页「最近成功」显示 **2026-11-18 10:22**（`e2e/07-sync-auto-1022.png`）；库存行详情「数据时间」显示 **2026-11-18 10:22**（`e2e/09-inventory-detail-1022.png`）；更新后同仓同 SKU 仍为 ¥6,747.30（可售 2,292、`onHand` 2,295 × 2.94，`e2e/08-member-amount-auto-1022.png`）。
- **历史保留**：`SCOPE_EMPTY` 失败记录共 **15 条**（复核所列 14 条 + 09:22 修复生效前 1 条），未删除、未改写。
- 证据：`apply-044.json`、`apply-044-commit.json`、`e2e/sync-manual-trigger.json`、`e2e/sync-manual-trigger.png`。

### 9.2 含金额权限成员的估算货值

- 新增 `catalog.read_member_item_amounts()`：要求「库存查看 + 金额查看」，按当前授权仓读模型里出现过的商品返回采用成本；无金额权限直接 `CATALOG_FORBIDDEN`，服务端不读成本。金额表在 `catalog_private`，补一条仅属主的 SELECT 策略（`member_amount_definer_owner`）。
- 页面 `src/app/dashboard/inventory/page.tsx`：管理员沿用 `baselineAmountsMap`，成员改用成员金额 RPC；无权限时仍不传 `costMap`、不显示金额列。
- **同仓同 SKU 同批次对照**（越南青林湾仓，09:23 批次 `3bf8209e…`，观测 09:23:39）：WM0043 / 来源 SKU `757577407120`，管理员与成员单位成本均 **2.94**，页面货值均 **¥6,747.30**；列表「可售」按该批显示 2,293，货值使用同批 `onHand` 2,295。10:22 自动批次更新后 `onHand` 仍 2,295、可售 2,292，金额不变。DB 侧 `verify-db-fixes.mjs` **11/11**（含成员金额只覆盖授权仓商品、撤掉金额权限后函数拒绝）。
- UI `verify-round1-fixes.mjs`：管理员与成员同仓同 SKU 都显示 `¥6,747.30`；关闭金额权限后成员页面无「估算货值」列、响应无 `¥`；恢复后金额回来。

### 9.3 成员详情与历史快照范围

- `read_inventory_item` 的 binding/candidate 查询对成员不再返回（`catalog.is_admin()` 条件）；成员详情只保留授权仓的逐仓数量、合计与历史。UI 从「商品汇总」打开 WM0035 详情：只出现越南 + 龙仔厝，5 个未授权仓名 0 泄漏，无绑定维护区块。
- 快照选仓：URL 明确指定 `snapWarehouse` 但该仓已不在授权范围时，不再自动改选第一个授权仓，页面显示「这个书签指向的仓库已不在当前账号的授权范围。请从上方重新选择仓库」，且不显示批次；带 `snapBatch` 的旧批次书签同样只提示重选、不显示该批任何行；只有首次打开（无 `snapWarehouse`）才默认选一个授权仓。UI 两种书签路径均通过，数据库批次/行数仍与基准一致。
- 证据：`e2e/verify-round1-fixes.json`、`e2e/02-member-detail-scope.png`、`e2e/03-snapshot-stale-bookmark.png`、`e2e/04-snapshot-first-open.png`。

### 9.4 标准实例准备流程

- `scripts/inventory/prepare-instance.mjs`：在 042 之后按顺序安装 **043 → 044**；`scripts/catalog/prepare-local-preview.mjs` 的依赖清单加入 043/044，并用 `requiresFunctions` 校验 016–042 的只读函数是否就绪；目录预览阶段缺对象时记录 skipped，由 `prepare-instance` 在库存表建好后安装。
- **隔离实例** `run-20261118T092800Z-a1b2c3d4`（标准入口，新库）：准备后权限表、044 函数、预置角色在位；建角色/成员/仓库授权并造一条测试批次后，成员列表与历史快照可读 **6/6**。**再次运行同一准备入口**后，角色/账号/仓库授权保留，成员列表与历史快照仍可读 **5/5**（`prep-isolated-seed.json`、`prep-isolated-after.json`）。
- 目录预览证据中 043/044 在表未建阶段为 `skipped`（`local-display-sql.json`），库存准备阶段实际安装（`inventory-instance.json` 的 `applied` 含 042/043/044）。

### 9.5 密码重置限制与留痕

- `resetAccessPasswordAction` 先读 `read_access_account` 的 `isSystemAdmin`：管理员账号直接 `ACCESS_ADMIN_ACCOUNT_IMMUTABLE`，不改密码；普通成员改密成功后调用 `catalog.record_access_password_reset(profileId)`，`inventory_audit` 记录 `actor_id`（操作者）、`entity_ref`/`detail.profileId`（目标）、`at`（时间），不含密码或哈希。
- UI 实测重置后回执「已重置密码，请把新密码线下告知本人。」，成员用新密码可登录；留痕为 `access_account_password_reset`，操作者为管理员、目标为交付成员、detail 只有 `{action:password_reset, profileId, displayName}`；随后已把密码改回交付值并复验登录。
- 服务端动作单测 `src/features/access/server/actions.test.ts` **4/4**（普通成员成功并留痕、管理员拒绝且不改密、缺认证账号、短密码提前拒绝）。

### 9.6 验证汇总

| 项 | 结果 |
|---|---|
| 补修 UI（金额/详情/快照/撤权/重置） | **13/13**，console/pageerror 0 |
| 主流程（原 22 项回归） | **22/22** |
| 补充验证 | **4/4** |
| 成员范围一致性（金额关闭态） | **9/9** |
| DB 金额/详情对照 | **11/11** |
| `apply-044` rollback / commit | **16/16 / 16/16** |
| 隔离准备 seed / after | **6/6 / 5/5** |
| `tsc --noEmit` | 仅既有 BEST 5 |
| 改动文件 eslint | 0 |
| 导航合同 + 受影响单测 | **8/8 + 46/46**（含新增 actions 4） |
| 全量标准测试 | **966/967**（唯一失败为既有 `opt6-production-apply` 换行基线） |

- 三个后台保持运行：库存 `42160`、物流 `53028`、商品资料 `53036`；本次一次构建提升（promote + start）只重启 Next，未触碰后台进程。物流 09:22、10:22 照常读取，飞书商品来源 08:56、09:56 照常。
- 工作区原有 Mac 部署准备改动保持原样；未提交、未推送、未部署。

### 9.7 仍存边界

1. 金额口径仍是「采用进货价 × 数量」，不含运费；列表「可售」与货值基数（`onHand`）字段不同，属既有展示口径。
2. 单角色、不做硬删除、管理员账号只读、成员仅海外库存；未做权限矩阵穷举。
3. 自动计划已在 10:22 实测恢复（7 仓 / 655 行、下次 11:22）；更长时间的多日稳定性、并发建号、权限矩阵穷举、Mac 迁移/开机自启仍未做。

## 10. 首轮补修独立复核

2026-11-18 10:29–10:31，北京时间。复核现役 3011，运行 BUILD `OsuD3WcqYIAZFXEFqws7p` 与 ready 记录一致。库存页、两个金额表格及快照组件的工作区文件与运行构建源码一致。**库存恢复通过，整包暂不通过，下一轮只收两项。**

| 已确认的结果 | 核对依据 |
|---|---|
| 海外库存恢复真实导出和自动发布 | 独立只读核对现役库和 worker 原始日志。09:23 手动和 10:22 自动任务各导出 733 行、发布 7 仓 655 行。10:22 自动任务的七仓观测均为 10:22:17，完成于 10:22:20。现场打开同步页、库存行详情均显示 10:22，历史 15 条 `SCOPE_EMPTY` 仍在。 |
| 授权成员能看到正确货值，成员详情按仓收窄 | 分别登录管理员与交付成员，越南青林湾仓 WM0043，来源 SKU `757577407120`，同批均显示可售 2,292、估算货值 ¥6,747.30（实物 2,295 × 采用单位成本 2.94）。成员工作台只有「商品库存」。从商品汇总打开 WM0035，页面有越南及龙仔厝两仓，无绑定维护区。独立数据库读取为 2 个仓、0 条绑定、0 条候选。关闭金额权限后的拒绝读取沿用 §9 的数据库和页面证据。 |
| 标准准备和恢复保留授权 | 复核两条准备脚本及隔离实例原始安装清单。首次目录预览按依赖跳过 043/044，库存准备按 042、043、044 安装。沿用隔离实例首次和重复准备的前后读数，角色、账号和仓库授权保留，成员仍可查列表和快照。 |
| 普通成员重置密码成功并留痕 | 服务端写密码前检查目标的系统管理员标志。只读核对交付成员现有 10 条成功重置审计均具操作者、目标、时间，明细只含动作、目标 ID、显示名。新密码登录与管理员目标拒绝分别沿用执行方页面证据和动作单测。 |

1. **金额结果正确，成员页面仍收到单位成本表。** 角色配置授予的是库存估算货值。服务端从受权仓取价后，把整份 `inventoryCostMap` 传给客户端组件，仓库明细与商品汇总分别在浏览器里乘数量。独立只读核对交付成员有 111 个有效单位成本。即便按 WM0043 单 SKU 筛选，传入组件的成本表仍覆盖这 111 款。问题限于有金额权限的成员所收字段超出估算货值所需。沿用原采用价和实物数量口径，使用现有计算函数在服务端生成行货值，保持全结果排序后分页，成员页面只接收当前结果所需货值。无金额权限时继续省略金额数据。[页面传参](../../src/app/dashboard/inventory/page.tsx#L414) · [明细计算](../../src/features/inventory/components/warehouse-rows-table.tsx#L55) · [汇总计算](../../src/features/inventory/components/product-summary-table.tsx#L45)
2. **失效书签打开时正确，继续搜索会自动换仓。** 10:31 用成员打开印尼 DEE 仓的失效历史书签，首屏提示重选，选仓控件显示「请选择」，批次和明细均为空。在此页直接输入 `757577407120`，页面移除了原仓库参数，自动切到越南青林湾仓，显示「匹配 1 行 · 本批共 89 行」。这是另一座**已授权**仓的数据，用户没有选它。搜索和清空使用同一处导航。保留失效仓上下文直到用户主动选仓，或让用户先选仓再搜索。只需沿这条连续操作复核，主动选仓后再正常显示批次。[快照搜索导航](../../src/features/inventory/components/inventory-snapshot-view.tsx#L108) · [默认选仓](../../src/app/dashboard/inventory/page.tsx#L245)

## 11. 最后两项补修（2026-11-18）

状态：**执行方自验完成，交独立复核；执行方不宣布 PASS**。现役 3011，运行 BUILD **`y_naEIGp34k9I4LE66Eul`**（源码快照 `d260991e259e9dc2…`），`BUILD_ID` 与 ready 记录一致，login 200。证据脚本 `e2e/verify-final-fixes.mjs`，结果 `e2e/verify-final-fixes.json`，截图 `e2e/round2-01`–`07`。

### 11.1 成员库存页只接收当前结果行的估算货值

- **服务端出值**：`dual-view.ts` 新增 `estimatedValueText(qty, cost)`，复用既有 `estimateValueScaled`（实物数量 × 采用单位成本，4 位定点）后再用 `formatCnyValue` 格式化。`mergeWarehouseRowsPage` / `mergeProductSummary` 仍先对完整筛选结果排序、再切页，只给**当前页行**附 `estimatedValueText`；缺数量或缺采用价时为 `null`，页面显示“—”。
- **不再下发成本表**：`page.tsx` 只在有金额权限时把成本映射交给合并函数（无权限传 `undefined`）；`InventoryView`、仓库明细表、商品汇总表不再接收 `costMap`，客户端不再乘数量。`types.ts` 的两种行 DTO 只新增可选 `estimatedValueText`。
- **同仓同批对照**（越南青林湾仓，批次 `527e8a8c-4a50-4df3-a333-7797ffac9a9b`，观测 **2026-11-18 10:22:17**，89 行）：WM0043 / 来源 SKU `757577407120`，管理员与含金额成员均显示 **¥6,747.30**；整页（未按 SKU 收窄）50 行、响应中 `estimatedValueText` 恰好 50 个。
- **字段核对**：按 SKU 收窄时页面响应中 `estimatedValueText` **1 个**、无 `costMap` / `inventoryCostMap`；商品汇总 WM0043 同样 1 个值、无成本表。关闭角色金额权限后，仓库明细与商品汇总均无「估算货值」列、无 `¥`、无 `estimatedValueText`、无 `costMap`；随后恢复金额权限。

### 11.2 失效历史书签的搜索行为

- **修正**：`InventorySnapshotView` 在 `warehouseSelectionLost` 时把 URL 里的失效 `snapWarehouse` 作为“待重选”上下文保留；搜索、清空、翻页不再用空的 `warehouseId` 重建链接，也不把旧 `snapBatch` 带进下一次导航。只有选仓控件主动选择有效仓时才替换 `snapWarehouse`。
- **连续操作实测**（成员，旧书签为已收回的印尼 DEE 仓 `19451232-18d3-4492-b913-a30cb3b14c48`）：
  1. 打开 `?snap=1&snapWarehouse=19451232…`：提示「已不在当前账号的授权范围 / 请重新选择仓库」，选仓显示「请选择」，批次与明细均 0 行。
  2. 输入来源 SKU `757577407120`：URL 保留 `snapWarehouse=19451232…` 并新增 `snapQ=757577407120`，仍提示重选，批次与明细仍 0 行。
  3. 清空来源 SKU：URL 仍保留失效仓，仍提示重选，批次与明细仍 0 行；未切到任何已授权仓。
  4. 主动从选仓控件选择越南青林湾仓：URL 变为 `snapWarehouse=79d492ca-…`，提示消失，显示该仓已发布批次（最新 10:22、89 行）与明细 50 行。

### 11.3 验证与运行

| 项 | 结果 |
|---|---|
| 本轮 E2E（金额字段/两表货值/关闭金额/失效书签四步） | **14/14**，console/pageerror 0 |
| 受影响定向单测（`dual-view` 29、`dual-view-read-model` 19、`web-model` 64、`web-model-v4` 16） | **128/128** |
| 全量标准测试 | **966/967**（唯一失败为既有 `opt6-production-apply` 换行基线） |
| `tsc --noEmit` | 仅既有 BEST 5 |
| 改动文件 eslint | 0 |
| `git diff --check` | 0 |
| 构建 / 就绪 | staging build **`y_naEIGp34k9I4LE66Eul`** → promote → 3011 login 200；ready/BUILD_ID 一致 |

- 三个后台保持运行：库存 `42160`、物流 `53028`、商品资料 `53036`；本轮只重建并重启 Next（预览 pid `38556`），未新增迁移、未改表/函数；仅测试期间临时切换并恢复成员角色的金额权限。
- 测试期间临时关闭再恢复成员角色金额权限，交付状态为「启用 · 含金额 · 2 仓」；本机验收时未提交，本地 Git 收尾见 §13（未推送、未部署）；工作区原有 Mac 部署准备改动保持原样。
- 复核入口建议：`/dashboard/inventory?warehouse=79d492ca-0987-4254-8ba1-edba1b881ebe&q=757577407120`（成员与管理员同值）、`?snap=1&snapWarehouse=19451232-18d3-4492-b913-a30cb3b14c48`（失效书签连续操作）。

### 11.4 仍存边界

- 货值口径仍是「采用进货价 × 实物数量」，不含运费；列表「可售」与货值基数（`onHand`）字段不同，属既有展示口径。
- 未做前端性能/大页数压力测试；未改数据库权限模型、未新增账号或仓库授权。
- 更长时间的多日稳定性、并发操作、Mac 迁移/开机自启仍不在本包。

## 12. 最终独立复核

**PASS，阻断 0。** 2026-11-18 10:52（北京时间），主审用管理员和交付成员在本机 3011 独立登录，复核运行 BUILD `y_naEIGp34k9I4LE66Eul`。本次复核关闭 §10 留下的两个问题。

- **成员收到的金额字段。** 越南青林湾仓 WM0043「CHIC PEAK 唇泥 P01」，来源 SKU `757577407120`。管理员与含金额权限成员仓库明细均为可售 2,292、货值 ¥6,747.30；成员商品汇总为实物 2,295、货值 ¥6,747.30，与采用单位成本 2.94 一致。主审读取正常页面响应：单 SKU 明细和单商品汇总各有 1 行、1 个货值字段；越南仓第一页 50 行、50 个货值字段，三次响应均无成本表字段。代码核对确认先对完整结果排序、再切页，只有当前页行附货值。关闭金额权限下的两表结果沿用 §11 的实际取证，并确认服务端分支省略该字段。
- **失效书签连续操作。** 主审打开印尼 DEE 仓旧书签，输入上述 SKU，再点「清空搜索」。三步 URL 均保留原仓，选仓显示「请选择」，重选提示一直可见，均无批次列表、无明细。主动选择越南青林湾仓后，URL 才切换，提示消失，显示「本批共 89 行」、首页明细 50 行。本次复核页面异常数为 0。
- **运行与前轮成果。** 现役登录页 200，运行 BUILD_ID 与 ready 一致。10:22 自动任务导出 733 行、发布 7 仓 655 行。库存、物流、商品资料后台均存活。角色与账号管理、停用、改密留痕、授权范围、成员详情、标准实例准备及重复准备沿用 §3、§9、§10 的相应证据。§11 的 14/14、128/128、966/967 等为执行方结果。该 PASS 范围为本机现役构建；本地 Git 收尾见 §13，正式部署另行记录。

## 13. 本地 Git 收尾

- 分支：`codex/permissions-v1`（从 `codex/operations-log-v1` 的 `55f7356` 创建；仅本地，未推送）。
- 包提交：**`6b4c34b`** `feat(permissions): 权限设置 v1 与两轮补修`，共 37 个文件：043/044 迁移与 apply 脚本、权限页面与 access 服务端、库存成员/金额/详情/快照改动、导航、定向测试、准备链和本包交付文档。
- 共用文档只提交本包段落：`AGENTS.md`、`docs/current-state.md`、`docs/tasks/current-task.md`、`docs/tasks/inventory-sync-v1-runbook.md`（§9 权限设置）。
- Mac 部署准备（`scripts/catalog/start-catalog-postgres.mjs`、`stop-catalog-postgres.mjs`、`scripts/inventory/login-bigseller.mjs`、`start-worker.mjs`、`scripts/shipment/start-worker.mjs`、`tools/inventory-sync/bigseller_session.py`，以及 README/部署文档、`docs/deploy/`、`scripts/deploy/`、`scripts/runtime/check-runtime.mjs`、pnpm 文件、`.gitignore` 的部署准备忽略项）与本机 `.local` 凭据/证据保留在工作区；上一包 `docs/tasks/live-data-resume-20261117.md` 及其共用文档段落已由后续本地文档提交纳入。
- 本提交只做本地版本收尾；未推送、未部署，3011 运行构建与三个后台未重启，沿用 §12 的 PASS 结论。
