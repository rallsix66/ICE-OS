# ICE v4 目标架构（v2）

> 2026-10-13 后续变更：平台目标已由 [architecture-v3.md](architecture-v3.md) 和 [ADR-ICE-002](adr/ADR-ICE-002-independent-postgres-history.md) 取代，正式方向是脱离 Supabase并增加[历史能力](history-data-model-v1.md)。本文保留首版设计背景，不再作为“继续用 Supabase 开发”的授权；运行代码尚未迁移。

> 2026-10-13 · `approved`：方案验证范围与隔离边界；`proposal`：未来真实数据模型/平台迁移，需独立实施审批。现役实现依据 [current-analysis.md](current-analysis.md)，完成状态只看 [current-state.md](current-state.md)。

## 架构选择

继续使用单仓库、单 PostgreSQL、模块化 Next.js 单体。保留 Repository、Server Action、Zod、Feature Module、认证和 RLS；不引入微服务、消息总线、新前端框架或双写库存系统。通过已有封装逐模块降低供应商耦合，不把“未来可迁移”变成今天重写全部数据层。

此次交付的唯一新运行能力是 `/demo/ice-v4` 和 `src/features/ice-demo/`：静态虚构数据、纯计算和客户端交互。没有业务服务/SDK/数据库导入，没有真实登录/Server Actions，也不修改 Proxy matcher 或 Dashboard 布局。

## 目标依赖与所有权

```text
页面 / 交互
  ├─ 读取：Server Component → 查询服务 / Repository → 数据适配器 → PostgreSQL RLS
  └─ 写入：Server Action → ActiveAuth + 授权 + Zod → 领域服务 → Repository → RLS

外部来源 → source adapter → 校验/幂等/完整性 → 领域写入事务 → 快照/货票/日志
                                           ↓
                               授权读模型 → 经营总览

本期 Demo → ice-demo fixtures + 纯函数（止于此，不接以上真实链路）
```

- 商品域：`products` / `variants` 演进，拥有公司货号、资料、标识、映射版本。Variant 保留国家/规格语义；外部 SKU 只是映射键，不是全局商品主键。
- 库存域：拥有批次、不可变观测快照和最新有效投影；数量权威来自来源，不接受物流域手工增减。现役 inventory 兼容字段保留原“可售数量”含义，不能原地换语义。
- 货票域：拥有飞书业务状态、数量与到货事实；物流域拥有外部运单绑定与轨迹，只能提供证据，不替商品域认领身份、不替库存域记账。
- 对账规则：位于应用/领域服务，关联业务收货与库存证据，输出未确认缺口；不能从库存 delta 猜因果。
- 估值域：以已授权的库存/在途读模型和版本成本计算，拥有估值口径/覆盖率；不成为库存写入源。
- 操作日志：领域事务同写成功记录，记录来源/请求/对象/版本；失败同步留失败记录，读模型不偷偷写状态。全库日志并非所有用户可读。
- 认证/访问策略：`src/lib/auth.ts` 和访问服务统一输出供应商无关 ActiveUser + 权限集合；现有 admin/operator 行为在新增角色前保持兼容。

## 契约和目录约束

在现有 `src/features/<domain>/` 内按需增加类型、纯规则、Repository方法和适配器；先有第二种真实实现再抽接口，不建立空泛的通用 Repository 工厂。

新公共业务契约只用自有 DTO 和可序列化字段，不导出 Supabase Session、PostgREST响应或生成 Database Row。遗留 Database 派生类型按模块迁移，旧页面在兼容期保持可运行。第三方 payload 仅在 `src/lib/providers` / 同步适配器内部解析；错误在边界转换为可预期中文分类，不能吞掉权限/数据库失败。

`operation_log`、`inventory_snapshot`、`product_mapping` 等是目标领域名称；设计实体与当前表的扩展/保留关系见 [database-design-v2.md](database-design-v2.md)。不要另建一组平行 Shipment/轨迹真相。

## 认证、RLS和金额

正式链路执行：路由有效会话 → Action校验启用用户/角色/输入/目标 → Repository范围投影 → RLS。来自表单的user_id、市场、账号不能作为授权依据。

未来负责人、运营均按显式市场/仓库授权；空范围返回空，不默认全部。国内 CN 不能误用现有 overseas-only helper。管理员写入也需校验存在、冲突、幂等和版本。

金额单独表/受限查询投影；RLS无法单独保证同一行中的金额字段不泄露。禁止通过通用日志 payload、排序/汇总接口、CSV、客户端隐藏数字绕过权限。新表同时评审 GRANT、RLS、SELECT/UPDATE WITH CHECK、RPC EXECUTE；优先 INVOKER，特权任务采用最小范围且可审计。参照 [Supabase RLS 官方说明](https://supabase.com/docs/guides/database/postgres/row-level-security)。

Demo 只含可公开的虚构资料。角色切换不持有真实令牌，不能声称已验证真实 RLS；不能将真实成本或生产快照加进 fixtures。

## 外部源、失败与恢复

快照按来源账号/仓库批次校验，在同一事务发布明细+成功批次+最新指针+日志。唯一导入键防重放；旧批次保留但不倒退最新指针。失败/部分分页不能发布，保留旧成功值并显示陈旧时间，不能归零或更新成功时间。

飞书按稳定记录ID/修订号幂等；映射、撤销、部分到货和人工更正必须保留版本，不凭更新时间覆盖已确认绑定。喜运达按 provider/account/waybill 去重，未绑定数据限制到管理/授权审查入口。原始凭证、cookie、token、联系人敏感信息不写公开日志。

所有源的过期阈值是待确认配置，Demo 固定时钟示例不等于生产 SLA。详见 [data-flow-v2.md](data-flow-v2.md)。

## 从 Supabase 到 PostgreSQL + 自有后端

这是退出设计，不是本次部署任务。没有选择新后端语言/框架，也不立即删除 Supabase。

1. **准备**：盘点 Auth/session、`auth.uid()`、PostgREST/RPC、Storage实际使用、cron/Python运行位置、生成类型和 service-role 路径；修复旧累加写入入口，完成DTO契约测试。保持现有运行栈。
2. **并行验证**：在隔离环境建立 PostgreSQL，迁移schema+UUID+业务数据，逐项替换供应商函数/角色。自有后端验证会话后以非superuser、非BYPASSRLS连接，事务内设置可信身份上下文；连接池每事务清理上下文，不能信任客户端传入user_id。复用/等价实现RLS，不能改为只有前端权限。
3. **认证迁移**：保留用户UUID与角色/启用状态/仓库授权，单独选择身份提供方与会话切换策略；密码迁移可行性待核实，必要时重新登录。旧token撤销、禁用用户、金额拒绝和权限变化时效均必须验收。
4. **切换**：先只读影子比对，不让两套系统同时成为库存写入者；冻结写入/暂停同步后备份schema、数据、对象引用、身份映射、配置、代码和最后批次水位，再导入增量、核对计数/内容摘要/RLS行为后单点切流。
5. **回退**：若写入尚未开放，路由回旧版本；已开放后必须先停止新写入并对账增量再恢复，不能只回滚代码而把新数据丢掉。未经恢复演练不删除旧环境。保留观察窗口和明确负责人。

真实迁移前：必须获得备份/维护窗口/回退和成本授权，确认所有数据源账号和scope，Staging证明双角色兼容+三角色新权限、幂等/乱序/部分失败、源对账和金额不泄露。本期任何测试不连接该未来环境。

## 分阶段兼容和停止条件

先批准资料和来源契约，再以新 Migration 增量扩展。旧 inventory/shipments/variants 和00001–00052不可编辑或删除；旧写入入口的关闭也必须新Migration、显式权限测试和回滚设计。未来 inventory.current 投影可由快照生成，但旧“可售量”字段须兼容到调用方迁完。

每批检查已完成模块非回归、全量默认单元测试、lint/build、独立数据库合同及真实Admin/Operator/Manager验收。设计与Demo通过不自动授予真实写入/部署权。

本期允许：上述文档、规则入口、隔离Demo、纯函数测试和独立Git分支。禁止：生产数据/迁移、外部账号授权、旧业务重构、master合并、主动生产部署、付费服务。Git推送可能触发平台既有Preview行为，但不能描述为我们已确认生产上线。

## 决策与规则入口

- [ADR-ICE-001](adr/ADR-ICE-001-identity-snapshot-boundary.md)：身份、来源权威、隔离与迁移边界。
- [AGENTS.md](../AGENTS.md)：项目级规则增量保留角色协作约定，不复制整套设计。依照 [Codex 官方 AGENTS.md 规范](https://learn.chatgpt.com/docs/agent-configuration/agents-md) 使用仓库入口和短链接；不修改 Claude 专属规则。
- 唯一动态状态：[current-state.md](current-state.md)；唯一单次任务：[tasks/current-task.md](tasks/current-task.md)。旧 architecture/database-design 文档描述现役历史基础，新版本文档描述目标，两者不混写。
