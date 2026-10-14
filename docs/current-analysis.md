# 现有系统分析：ICE v4 改造基线

> 2026-10-13 方向更新：已批准脱离Supabase与历史底座，目标见 [architecture-v3.md](architecture-v3.md) 和 [历史模型](history-data-model-v1.md)。本轮在改名后的ICEOS目录核对 `0749343`：登录/认证封装、Repository、Python同步与`auth.users`/`auth.uid()`耦合仍在；没有执行替换。下文“保留Supabase”描述首版改造基线，不再代表后续平台目标。

> 核实日期：2026-10-13。代码基线：`44d0b13cd2bc58a09bae46fc4594839d21996de1`。
> 范围：本地代码、52 个 SQL Migration、配置与测试；未连接生产、Staging、BigSeller、飞书或聚水潭。历史发布记录不是本次运行态验证。

## 结论

保留现有 Next.js 模块化单体、Repository / Server Action / Zod、Supabase Auth / PostgreSQL / RLS，以及 `Product → ProductVariant → Inventory`。本次不是重建 WMS，而是在这些边界之外先验证 ICE 商品身份、跨来源快照、货物流转和货值呈现。

当前系统已实现海外库存、商品匹配、货票、部分到仓、外部轨迹、补货、作战室和仓库权限。缺口主要是公司商品资料的完整身份、版本化多源映射、永久库存快照、飞书/聚水潭接入、成本口径与金额权限、统一操作日志。**缺口不等于本期要全部实现。**

## 前端和后端

- 前端：`src/app/` 是 Next.js 16.2.9 App Router；React 19.2.4、TypeScript strict、Tailwind 4、Base UI/shadcn。`src/components/ui/` 可复用，业务页面容器通常会调用真实 Actions，不能直接搬进无数据 Demo。
- 后端：同一 Next.js 应用中的 Server Components、Server Actions、Route Handlers；没有独立业务 API 服务。`src/features/*/repository.ts` 负责数据库查询/RPC，`src/lib/` 封装认证、Supabase、Python bridge、物流适配器。
- 路由保护：`src/proxy.ts:11` 仅匹配 `/dashboard/:path*` 和 `/auth/login`。Dashboard layout 会调用真实认证；root layout 只组合 CSS、children 和 Toaster。独立 `/demo/ice-v4` 可以完全不调用业务服务。
- 现有模块不止旧架构文档列出的六个：还有 `warehouse-access`、`sync`、`in-transit`、`preferences`、`product-overview`、`replenishment` 等。
- `.github/workflows/ci.yml` 包含质量门和 PostgreSQL 并发/迁移合同门；仅 push 到 master、PR 或手工触发。推送方案分支不能宣称 CI 已通过。

## 商品模型和映射

- `00001_initial_schema.sql:59-124`：Product、ProductVariant、Inventory 使用 UUID 技术主键；`product.code` 唯一，`product_variant(sku,country)` 唯一，`inventory(variant_id,warehouse_id)` 唯一。
- `src/features/products/schema.ts` 接受人工输入 code，没有必要另建自动货号。现有 code 是否全部就是 ICE 公司货号，仍需真实资料对照；迁移不能自动改号。
- `src/features/products/types.ts` 已有国内/海外 SKU 分组摘要，但它是呈现能力，不等于国内库存已经接入。
- 当前匹配围绕 Variant 到 Product，不能完整表达不同来源账号、映射有效版本、重核/停用状态；`product_identifier` 与 `product_mapping` 应增量补足，不替代 Variant。
- `products/types.ts`、`in-transit/types.ts` 等公共类型仍从生成的 `Database` 派生。隔离层已有基础，但业务契约仍有供应商/表结构耦合；未来逐模块引入 DTO，不本期批量重写。

## 库存和 BigSeller

- `tools/bigseller-scraper/bigseller_scraper.py:1138-1144` 采集 current、locked、available、transit 四种数量。
- `tools/bigseller-scraper/sync/plan_generator.py:72,93-150` 将 **available_quantity** 写为当前 `inventory.quantity`。不能直接把该字段称为实物库存或用于全部库存货值。
- `00014_dynamic_alert_fields.sql:434-495` 的同步逻辑覆盖当前库存；磁盘 input/plan artifact 与仓级 SyncLog 支持追踪，但不存在永久数据库库存快照模型。`src/features/sync/gc-orchestrator.ts:13` 有 7 天保留基准，artifact 不能代替快照账本。
- 抓取器 `int_or_zero()`（约1271行）可把无法解析的数量转为零。新快照导入必须区分原始零、缺失和解析失败，并验证分页/仓库/批次完整性；不能复制此降级作为新事实标准。
- 国内仓有概念和部分类型，但未发现聚水潭采集/对账闭环。聚水潭是未来国内快照源，发货不能在 DIS 再手工扣减一次。
- `src/features/inventory/actions.ts:98-123`、`repository.ts:354-368` 仍保留手动库存修改能力。新来源上线前必须审计并收口写入面，本期不调用、不移除。

## 物流、货票和在途

- Shipment / ShipmentItem / TrackingEvent 已有事务创建、状态流转、仓库隔离和部分到仓。`00026_partial_warehouse_shipment.sql:7-21` 明确：确认到仓只改到仓量和业务状态，**不写库存**。
- `src/features/shipments/actions.ts:381-394` 已阻断旧入仓 Action。但旧 `warehouse_shipment_transactional` 在 `00023:94-100` 仍含库存加法，`:139` 有 authenticated EXECUTE；本地后续 Migration 未发现退役。只有正常 UI 不累加，不能声称数据库已不存在其他写入路径；远端实际 ACL 未检查。
- `src/lib/providers/golucky/`、`src/features/in-transit/golucky-import.ts` / `golucky-sync.ts`、相关 Actions/Repository 已有喜运达轨迹与绑定基础；`best` 适配器包含只读 client/dry-run，不视为全流程完成。
- `00038_golucky_schema.sql:103-105` 的唯一键是 `(provider, waybill_no)`，不是目标 `(provider, account, waybill_no)`。多账号接入前必须迁移，缺账号/多候选时不自动绑定。
- 当前使用 `shipment_external_ref`、`shipment_external_item`、`tracking_event_external`；不是新建一套同义物流表。v2 文档中的 `logistics_tracking` 是目标领域实体，需有现表演进映射。
- 未发现飞书物流表授权导入或聚水潭接入实现。现有人工状态不能在文档里写成已经由飞书同步；API 也不能被假定包含商品明细。

## Supabase、权限和日志

- Supabase 依赖：Auth 会话/cookie、生成的数据库类型、Repository 查询、PostgREST RPC、`auth.uid()`/`authenticated`、RLS、少量受控 service-role 后台链路。当前不是换连接字符串即可迁移。
- 当前角色为 admin/operator，`user_warehouses` 提供仓库范围；`warehouse-access/repository.ts:23-53` 中 Admin accessible list 限 active overseas，分配也限制海外仓。国内市场授权须另行设计，不扩大旧规则。
- 目标“负责人”角色和金额权限尚未实现。RLS 控行，不自动隐藏成本列；未来金额表、DTO、RPC、导出和日志都需单独授权。
- SyncLog、SyncRun、手工/外部轨迹和部分状态历史可复用，但不是统一 operation_log。需定义谁、何时、对象、前后变化、市场、货号/编码、request/batch ID，并屏蔽密钥和受限金额。

## 保留、调整、废弃

保留：双层商品模型、52 个历史 Migration、现役仓库权限与认证、事务/幂等/并发测试、同步失败保留机制、物流 Provider、现有运营页面。

调整（后续任务）：补齐商品资料与多编码；增加映射版本；永久库存快照和 source scope；可售/实物分开；物流账号作用域；成本与金额授权；统一日志；逐模块去除公共 Database 类型耦合。

拟退役、**本期不删除**：旧库存累加 RPC/Repository 路径、快照模式下的手动改库存入口、将未知数量转零的快照导入方式、把业务类型直接当供应商响应的公共契约。没有证据支持删除整模块或改写旧 Migration。

## 风险和停止门

1. **阻塞真实数据上线，不阻塞隔离 Demo**：旧累加入口仍存在；可售量冒充实物量；飞书与库存不同步造成重计/漏计。必须以新 Migration、双序事件测试和源证据对账收口。
2. **阻塞接入/迁移**：公司货号资料对照、69编码规则、聚水潭字段、飞书主键/版本和账号、成本来源未确认。Demo 仅用明确标注的虚构资料。
3. **阻塞金额上线**：三角色/市场/金额权限未实现；只隐藏按钮或浏览器金额无安全意义。
4. **阻塞平台迁移**：认证迁移、数据库身份传递、RLS 等价验证、备份和回退尚未演练。本次保留 Supabase，不迁移。
5. 文档漂移：旧 `project-overview.md` 仍称入仓增加 Inventory，`architecture.md` 模块/权限范围陈旧，`deployment.md` 仍称未建 Staging，与后续代码和历史发布记录冲突。新入口明确历史/目标，不据旧文档倒退代码。

## 验证状态

以上是代码/Migration 静态核实（`implemented`），不是远端运行态 `verified`。本次测试、构建和浏览器证据统一记录在 [ICE v4 验收报告](reports/2026-10-13-ice-v4-validation.md)；不复制历史 4012/4013 为新结果。既有未提交的内网部署报告保留，不纳入本次提交。

下一步合同：[产品方案](product-plan-v4.md) → [目标架构](architecture-v2.md) → [数据库设计](database-design-v2.md) → [数据流](data-flow-v2.md)。
