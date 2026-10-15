<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know
Read the relevant guide in `node_modules/next/dist/docs/` before writing Next.js code; this version may differ from training data.
<!-- END:nextjs-agent-rules -->

# ICEOS / ICE v4 项目指令

## 入口与状态

- 先读 `docs/current-state.md` 和 `docs/tasks/current-task.md`，真实代码优先于旧文档。
- 当前目标：`docs/architecture-v3.md`；历史模型：`docs/history-data-model-v1.md`；基础业务实体：`docs/database-design-v2.md`；来源规则：`docs/data-flow-v2.md`。
- 产品范围以 `docs/product-plan-v4.md` 的 V5 选择性吸收为准，不将整份 V5 附件直接替换现役方案或扩展本期页面。
- 已批准脱离 Supabase、保存历史、暂不开发复杂分析页面。P0-01 独立审查已通过；P0-02 保留功能脱离 Supabase 已在代码与门禁中实现，完整独立审查待完成；不要把设计写成全面生产迁移已完成。
- 本入口替代用户已撤销的旧规则；不固定开发者角色，也不要求特定实施触发词。按用户本次请求区分讨论、审查、实施与发布。

## 架构与数据边界

- 目标为标准 PostgreSQL + 自有服务端；推荐复用 Next.js、Repository、Zod、Feature Module，不推倒重写，不默认在 Supabase 上扩建新模型。
- 迁移需替换 Auth/SDK/PostgREST/RPC传输及后台 service-role 路径；只换连接地址或自托管整套 Supabase 不算脱离。
- 保留 UUID、人工 ICE 货号、Product → ProductVariant → Inventory；外部 SKU 按来源/账号/市场/仓库映射，69编码保存字符串。
- BigSeller 决定海外数量，聚水潭决定国内数量，飞书决定货票业务状态，API只增强轨迹。到货不加海外库存，发货不二次扣国内库存。
- 旧 inventory.quantity 仍为可售量，不冒充实物量；缺失/失败不转零，缺成本不是0，来源异步且证据不足不合计库存与在途。
- 本期估算货值不含运费、不做费用分摊；单位成本也须明确不含运费，含运费或未知口径成本未澄清前不得参与估值。详细口径见产品方案。
- 历史事实不可变，修订追加版本；保存业务与系统时间、当时映射/资料/成本版本。当前投影和日统计可重算，不成为新的事实源。
- 日统计带日历、截止时间、覆盖率、质量和计算版本；余额不跨日期相加，库存差不当销量，没有来源不补造历史。
- 新业务公共契约使用自有 DTO，不导出供应商 Session/Database Row；客户端不直连数据库、不持有数据库或高权限凭据。
- 权限由服务端认证、启用检查、动作/范围授权及 PostgreSQL RLS共同保障；金额另行保护查询、导出、缓存与日志。
- 数据库运行身份非表owner/非superuser/非BYPASSRLS；事务局部身份仅由验证后的服务端设置，连接池隔离必须验收。
- Demo保持虚构数据隔离，不接真实服务/密钥；演示角色切换不是生产权限验收。

## 高风险操作与兼容

- 不修改00001–00052历史Migration；目标平台使用审定的新基线及增量脚本，保留UUID和旧语义的兼容核对。
- 真实环境访问、账号/数据迁移、生产切换、删除旧数据/环境、合并和发布须有对应授权。迁移方向获批不等于允许立即切生产。
- 切换前停旧写入、备份并恢复演练、核对水位与权限；生产只保留一个写入方。新系统开放写入后的回退必须对账增量。
- 保留用户未提交修改；只暂存当前任务文件，不顺手清理无关报告、凭据、依赖或代码。

## 文档收尾（neat-freak）

- 本批功能交付前，须读取并执行 `C:\Users\Administrator\.agents\skills\neat-freak\SKILL.md`（或触发词「洁癖」/ `/neat`），对齐 `docs/current-state.md`、`docs/tasks/current-task.md`、验证报告与 AGENTS.md，区分**已实现 / 已验证 / 待确认 / 既有失败**。
- 不借此扩大代码修改、删除用户文件或写入未授权记忆；清场须用户确认后再执行。

## 验证

- 开发：`npm run dev`；Demo：`/demo/ice-v4`（虚构数据隔离，**不**依赖 Supabase 真实凭据）。
- 单元：`npm run test`；Windows等价命令：`node node_modules/vitest/vitest.mjs run --exclude '**/concurrency.test.ts' --exclude '**/*.postgres.test.ts' --exclude '**/*.live.test.ts'`。
- 代码改动按风险运行 `npm run lint -- --max-warnings 0`、`npm run build` 与 `git diff --check`；只改文档可做链接/一致性/diff检查，明确没有重跑功能测试。
- 数据库/权限/历史实现另验RLS、并发、幂等、乱序、部分失败、补数、修订、金额拒绝与恢复；live/真实同步测试需具体环境授权。
- 报告区分已实现、已验证、待确认；推送不等于合并、CI通过或生产上线。
