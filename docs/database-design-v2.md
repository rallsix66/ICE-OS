# ICE v4 数据库模型设计（v2）

> 2026-10-13 · **设计草案，未创建或执行任何 Migration，未连接真实数据库。**
> 本期仅验证文档与虚构 Demo；以下目标字段、约束、角色和表不代表已经上线。
> 对齐 [产品方案](product-plan-v4.md)、[目标架构](architecture-v2.md)、[数据流](data-flow-v2.md) 与 [现状审计](current-analysis.md)。

## 1. 现役基线与不可破坏项

- 保留 `product`、`product_variant`、`inventory`、`shipment` 等既有 UUID；不重新生成公司货号，不改写已有 `product.code`。真实 code 与 ICE 人工货号的对应关系须先审计。
- 保持 **Product → ProductVariant → Inventory**。外部 SKU 是来源标识，不是全局商品主键；新映射和快照不能绕过 Variant 将当前库存直接归到 Product。
- 现役 `product.code` 唯一、`product_variant(sku,country)` 唯一、`inventory(variant_id,warehouse_id)` 唯一；迁移期原约束和调用方保持兼容。
- 现役 `inventory.quantity` 表示 BigSeller 可用/可售数量，不得原地更名为实物总库存，也不得据此估算全部实物货值。
- 00001–00052 为历史 Migration，本期不改、不重放；真实结构/权限变更必须另建前向 Migration、独立任务和回退包。
- 旧 `warehouse_shipment_transactional` 仍有库存累加与可调用授权；手动 `updateInventoryQuantity` 入口也存在。未来快照上线前须新 Migration 撤销旧函数 EXECUTE/退役路径、收口直接 UPDATE，并验证替代调用方；本期不执行。

## 2. 通用字段、键与关系

新增实体默认 `id uuid PRIMARY KEY`、`created_at timestamptz NOT NULL`；可变实体增加 `updated_at timestamptz NOT NULL`、`row_version bigint NOT NULL DEFAULT 1 CHECK > 0`。时间保存 UTC，业务日期展示使用明确时区。
来源编码/69编码/运单号用 `text`，保留前导零及原始大小写；禁止数字化编码。数量默认 `bigint` 非负整件；若真实来源支持分数单位，须先批准单位换算合同，不静默四舍五入。
金额用 `numeric(20,6)`，汇率用 `numeric(20,10)`，不用浮点数；国家用受控两位码，币种用受控三位码。NULL 表示未知/未提供，与明确 0 不等价。
历史、映射版本、快照和日志外键默认 `ON DELETE RESTRICT`；业务停用不删除审计链。现有 CASCADE 不在本期批改，增量切换前另行评估。

```text
Product ──< ProductVariant ──< Inventory（兼容的最新可售投影）
   └──< ProductIdentifier          ↑
SourceAccount + Warehouse ──< ProductMapping（版本）
              └──< SnapshotBatch ──< InventorySnapshot ──> 映射版本/Variant
Shipment ──< ShipmentItem ──> Variant；Shipment ──< LogisticsBinding ──< LogisticsTracking
ShipmentItem + 来源收货凭据 + Snapshot ──< ReceiptEvidence（对账，不写库存）
Product ──< ProductCost ──< Valuation；领域事务 ──< OperationLog
```

索引原则：唯一约束建立的索引不重复创建；所有常用 FK/范围过滤有对应前导列索引；历史按业务对象+时间索引。初期不预设分区、搜索引擎或全字段 JSON GIN，按规模与 EXPLAIN 再决定。

## 3. 商品主体与编码

### `product`：扩展现表，不替换身份

- 保留：`id uuid`、`code text NOT NULL UNIQUE`、`name text NOT NULL`、`unit text NOT NULL`、`category text NULL`、`safety_stock integer`、`is_active boolean` 与既有时间字段。
- 拟增：`trade_name_zh text NULL`、`trade_name_en text NULL`、`specification text NULL`、`image_ref text NULL`、`row_version bigint`。图片只存受控对象引用，不存临时签名 URL 或凭证。
- 约束：code/name/unit 非空白；code 不自动替换、不按外部 SKU 生成。公司货号改变需显式冲突检查、版本记录和人工批准；引用仍使用 UUID。
- 索引：既有 code 唯一索引；名称检索复用已审核索引，按真实查询增加必要索引。写入者：启用 Admin 经 Action → 领域服务 → Repository。

### `product_variant`：保留业务 Variant 层

- 保留 `id uuid`、`product_id uuid NULL FK product`、`sku text NOT NULL`、`country text NOT NULL`、`name text NOT NULL`、`match_status text`、同步/创建/更新时间。
- `product_id=NULL` 允许现役未匹配 Variant；国家/规格版本仍属 Variant，不能仅靠映射文本代替该层。现役三态保留为兼容投影，目标五态以 mapping 版本为准。
- 迁移期 `(sku,country)` 保留；新来源相同 SKU 不等于同一 Variant。冲突先隔离，禁止创建伪造 SKU 来绕唯一约束。待旧消费者全部改用 mapping 后，才单独迁移旧 SKU 唯一性/可空性；保留原值和 UUID。
- 索引：`product_id`、`country`；写入者：商品身份服务。来源采集只能提出未匹配候选，不能自动确认 Product。

### `product_identifier`：公司商品的辅助编码

- 字段：`product_id uuid NOT NULL FK product`、`identifier_type text NOT NULL`（`barcode_69`/批准的其他类型）、`value_raw text NOT NULL`、`value_normalized text NOT NULL`、`package_spec text NULL`、`status text NOT NULL`（active/disabled）、`valid_from timestamptz NOT NULL`、`valid_to timestamptz NULL`。
- 约束：`valid_to > valid_from`；同商品/类型/规范值只能一条当前有效记录，使用 `valid_to IS NULL` 部分唯一索引。不同商品出现相同编码进入冲突核对，不能未经码制确认就设全局唯一或自动合并。
- 索引：`(identifier_type,value_normalized)`、`(product_id,valid_from DESC)`；写入者：Admin 商品服务，同事务追加日志。停用/替换关闭旧有效期并新增记录。

## 4. 来源账号与版本化映射

### `source_account`：来源身份命名空间

- 字段：`source_system text NOT NULL`（bigseller/jushuitan/feishu/golucky/批准的来源）、`external_account_key text NOT NULL`、`display_name text NOT NULL`、`is_active boolean NOT NULL`、`configuration_ref text NULL`。
- 约束：`UNIQUE(source_system,external_account_key)`，账号键稳定非空；configuration_ref 指向受控配置，不含 token、cookie、密码。未知账号不能伪造默认账号来匹配。
- 索引：唯一键及 `source_system` 查询；写入者：Admin 来源配置服务。新来源授权/凭证存储是后续任务，不在业务表塞入密钥。

### `product_mapping`：一个来源键的多个审计版本

- 字段：`source_account_id uuid NOT NULL FK source_account`、`warehouse_id uuid NOT NULL FK warehouse`、`market text NOT NULL`、`external_sku_raw text NOT NULL`、`external_sku_normalized text NOT NULL`、`source_record_key text NULL`。
- 字段：`version bigint NOT NULL CHECK > 0`、`variant_id uuid NULL FK product_variant`、`product_id_at_confirmation uuid NULL FK product`、`state text NOT NULL`、`valid_from timestamptz NOT NULL`、`valid_to timestamptz NULL`、`confirmed_by uuid NULL`、`confirmed_at timestamptz NULL`、`reason text NULL`、`supersedes_id uuid NULL FK product_mapping`。
- 来源业务键 K = **source_system + account + warehouse + market + SKU**；约束实现为 `(source_account_id,warehouse_id,market,external_sku_normalized)`，source_system 由 source_account 固定导出。SKU规范化规则按来源批准，不全局大写、去前导零或跨账号复用。
- 五态：`unmatched`（未匹配）→ `pending`（待确认）→ `confirmed`（已确认）；漂移进入 `recheck`（重新核对），停用为 `disabled`。重核/停用恢复必须再确认，不能默认继承旧授权。
- 约束：`UNIQUE(K,version)`；`UNIQUE(K) WHERE valid_to IS NULL`；有效区间为 `[valid_from,valid_to)`、结束晚于开始，同 K 不得重叠。跨行区间由批准的排他约束或受控串行事务+触发器落实，不能用普通 CHECK 冒充。
- confirmed 必须有 Variant、当时 Product、确认人/时间；事务校验 Variant 当时指向该 Product、市场与仓库相符、目标启用。其余状态不进入自动商品归集；候选 Variant 不代表已确认。
- 每次变化锁定来源账号映射域/当前版本、校验 expected version，关闭旧区间并插入新版本+日志；只允许关闭旧有效期，不改旧绑定内容。首版本并发依赖唯一约束拒绝双写。
- 索引：`(variant_id,valid_from DESC)`、`(state,market)`、`(source_account_id,warehouse_id,external_sku_normalized)`；写入者：Admin 确认/重核服务，运营只能提交候选。
- `product_id_at_confirmation` 是不可变归属证据，不是当前 Inventory 的 Product 外键捷径。历史按此版本解释，当前归集仍走 Product → Variant → 确认映射。

## 5. 库存批次、不可变快照与最新投影

### `inventory_snapshot_batch`：一次来源账号/仓库采集

- 字段：`source_account_id uuid NOT NULL FK source_account`、`warehouse_id uuid NOT NULL FK warehouse`、`source_batch_key text NOT NULL`、`observed_at timestamptz NOT NULL`、`collected_at timestamptz NOT NULL`、`finished_at timestamptz NULL`、`published_at timestamptz NULL`。
- 字段：`status text NOT NULL`（collecting/failed/partial/validated/published）、`coverage text NOT NULL`（full/incremental）、`expected_rows bigint NULL`、`received_rows bigint NOT NULL CHECK >= 0`、`expected_pages integer NULL`、`received_pages integer NOT NULL CHECK >= 0`、`content_hash text NULL`、`source_sequence bigint NULL`、`error_code text NULL`、`raw_object_ref text NULL`。
- 约束：`UNIQUE(source_account_id,warehouse_id,source_batch_key)`；重复键+同hash为幂等，异hash为冲突，不覆盖已发布批次。published 要求完成时间/hash/发布时间和完整性证据，发布后批次内容也冻结；时间先后、数量非负在数据库校验。
- full 必须证明分页完成、仓库/来源一致、无重复业务键、字段解析有效；来源没有总行数时使用批准的分页终止/覆盖证据，不能仅凭“抓取没报错”发布。
- 未批准增量协议前只允许 full 发布；incremental 必须先定义基线、删除/归零语义和补全规则，否则只保留证据。源中的缺行不默认当零。
- 索引：`(source_account_id,warehouse_id,observed_at DESC)`、`(status,collected_at)`；写入者：限定来源账号的同步 worker，普通用户只读授权范围。

### `inventory_snapshot`：来源观测行，发布后不可变

- 字段：`batch_id uuid NOT NULL FK inventory_snapshot_batch`、`source_row_key text NOT NULL`、`external_sku_raw text NOT NULL`、`external_sku_normalized text NOT NULL`、`source_product_name text NULL`。
- 字段：`physical_quantity bigint NULL`、`available_quantity bigint NULL`、`locked_quantity bigint NULL`、`source_in_transit_quantity bigint NULL`、`unit text NOT NULL`、`parse_status text NOT NULL`（valid/missing/invalid）、`raw_payload jsonb NOT NULL`（已按白名单脱敏）。
- 字段：`mapping_id uuid NULL FK product_mapping`、`mapping_version bigint NULL`、`variant_id uuid NULL FK product_variant`、`attribution_state text NOT NULL`（confirmed/unmatched/pending/recheck/disabled）、`row_hash text NOT NULL`。
- 约束：`UNIQUE(batch_id,source_row_key)` 及 `UNIQUE(batch_id,external_sku_normalized)`；数值若非NULL必须非负；不假设 `physical=available+locked`，除非该来源字段合同明确如此。
- mapping_id/version 成对为空或指向同一真实版本；confirmed 必须另有匹配的 variant_id，并在发布事务中校验映射已确认且适用采集时点。其他归属状态不填业务 variant_id，可保留候选mapping版本证据；历史版关闭不使历史 snapshot 失效。
- 新/未匹配 SKU 原始行完整保留，variant/mapping 可空；它是**尚未进入业务 Inventory 的观测证据**，不绕过 Variant。原始编码完全缺失的行进入拒收批次证据，不能造 SKU 发布。
- 产品归属按保存的 mapping 版本读取；后续补匹配通过新解释版本/读模型区分“当时归属”和“当前核对”，不 UPDATE 历史 snapshot、原始数量或 hash。
- 显式重解释目标记录 `inventory_attribution_revision`：`snapshot_id uuid NOT NULL FK`、`revision bigint NOT NULL CHECK > 0`、`mapping_id uuid NOT NULL FK`、`mapping_version bigint NOT NULL`、`approved_by uuid NOT NULL`、`approved_at timestamptz NOT NULL`、`reason text NOT NULL`、`supersedes_id uuid NULL FK`，`UNIQUE(snapshot_id,revision)`；仅Admin核对服务追加并审计，不替换采集时归属或数量。
- physical 不可得则 NULL；来源只给 available 时仍能显示可售但不能估物理货值。必要字段 invalid/missing 会阻止相关批次发布；禁止沿用 `int_or_zero()` 将解析失败当 0。
- 索引：`(variant_id,batch_id)`、`mapping_id`、`(external_sku_normalized,batch_id)`；发布后撤销 UPDATE/DELETE，只读；纠错另发新批次并关联旧证据，不覆盖。

### 发布事务与 `inventory_current` 目标投影

- 最新指针键为 `(source_account_id,warehouse_id)`，字段 `batch_id uuid NOT NULL FK`、`observed_at timestamptz`、`source_sequence bigint NULL`、`row_version bigint`；这是目标投影，不是第二份手工维护库存。
- 当前商品归集同时要求：来源键当前有效mapping仍为confirmed，且其ID/版本与snapshot冻结版本一致。转recheck/disabled立即排除当前归集、使相关读模型缓存失效，原始数量仍在异常区而非归零；历史按采集时版本继续可查。
- 重绑或重新确认生成新版本后，须等待新完整快照，或经上述显式审核的attribution revision才恢复当前归集；后者也须与当前confirmed mapping精确一致。读取必须实时检查资格，不能仅信任旧批次曾成功发布或旧缓存的confirmed状态。
- worker 先暂存并验证，再锁该来源/仓库的指针；同事务提交有效明细、published批次、最新指针、兼容 inventory 投影和日志。部分写入/日志失败全部回滚；失败结果在独立受控事务保留。
- observed_at/可靠 source_sequence 不得倒退；旧批次可留作历史但不替换最新指针。同时间无可靠序号且内容冲突进入核对，不以“最后到达”覆盖。未获业务发生时间的源必须先明确水位规则。
- 失败、部分抓取、超时、解析错误保留最近成功值及原时间；新鲜度由读取时计算，不靠刷新 last_sync_at 伪装成功。完整零行批次须经明确空仓覆盖证据，禁止把异常空响应发布为清仓。
- 可售兼容投影保留既有 quantity 含义；正式接入前定义缺行处理、停用和陈旧记录，不全表 DELETE/重建。原始 source_in_transit 仅供对照，不加入飞书在途。
- 只有可验证映射/数量/完整性才进入商品经营汇总；未知、未匹配、陈旧、待对账数量分桶展示。历史保留年限、raw存储访问及清理策略待确认，现有7天 artifact GC不能承担此责任。

## 6. 货票、商品与物流轨迹

### `shipment` / `shipment_item`：扩展现表

- Shipment 保留 UUID、货票号、warehouse/country、预计到货、创建人和状态；新增 `source_account_id uuid NULL`、`source_record_key text NULL`、`source_revision text NULL`、`business_status text`、`business_status_at timestamptz NULL`、`source_updated_at timestamptz NULL`、`manual_note text NULL`。
- 源导入 `UNIQUE(source_account_id,source_record_key) WHERE source_record_key IS NOT NULL`，两字段同时有值；旧人工货票保留来源标签，不假装来自飞书。状态字典与旧 status 的适配必须先批准，API签收不改业务状态。
- ShipmentItem 保留 `id/shipment_id/variant_id/quantity/warehoused_quantity`；新增 `source_item_key text NULL`、`mapping_id uuid NULL`、`source_revision text NULL`、`unit text`，约束 `0 <= warehoused_quantity <= quantity`、`UNIQUE(shipment_id,source_item_key)`（源明细非NULL时）。
- 飞书未匹配商品明细在导入暂存证据保留，不创建假 Variant/假商品强行写入现役非空 variant_id；管理员确认后原子形成正式明细。部分到货按明细累计量、修订号和凭据幂等处理。
- 索引：Shipment `(warehouse_id,business_status,business_status_at)` 与源唯一键；Item `(shipment_id)`、`variant_id`、`mapping_id`。写入者：飞书同步/授权业务维护服务，冲突用 expected revision 拒绝覆盖。
- 完成/撤销/修正只影响货票未到货数量，不加海外库存、不再扣国内库存；国内减少由聚水潭快照、海外变化由 BigSeller 快照体现。

### `logistics_binding` / `logistics_binding_revision` / `logistics_tracking`

- 不另建平行物流真相：binding 演进自 `shipment_external_ref`，保留其稳定UUID作为运单实体身份；tracking 演进自 `tracking_event_external`，`shipment_external_item` 保留已证明需要的来源明细证据。重绑只产生binding revision，不换运单实体ID。
- Binding 字段：`provider text NOT NULL`、`source_account_id uuid NOT NULL FK source_account`、`waybill_no_raw text NOT NULL`、`waybill_no_normalized text NOT NULL`、`current_revision_id uuid NULL FK logistics_binding_revision`。`UNIQUE(provider,source_account_id,waybill_no_normalized)`对全部状态成立，不因待绑定/重绑产生第二个同身份运单。
- BindingRevision 字段：`binding_id uuid NOT NULL FK logistics_binding`、`version bigint NOT NULL CHECK > 0`、`shipment_id uuid NULL FK shipment`、`binding_status text NOT NULL`（unbound/pending/confirmed/disabled）、`valid_from timestamptz NOT NULL`、`valid_to timestamptz NULL`、`actor_kind text NOT NULL`（user/system）、`changed_by uuid NULL`（user时必填）、`reason text NOT NULL`、`supersedes_id uuid NULL FK logistics_binding_revision`。
- 约束：`UNIQUE(binding_id,version)`、`UNIQUE(binding_id) WHERE valid_to IS NULL`、`valid_to > valid_from`；confirmed必须有shipment。更改锁稳定实体、校验预期版本、关闭旧修订并追加新修订+日志，再原子更新指针；旧shipment_id字段仅作当前修订兼容投影。
- 一个Shipment允许关联多个稳定运单实体（**1票:N运单**），一稳定运单当前只确认到一票。若一运单多票确实存在，先批准显式关联/分摊表，不偷偷放宽唯一性或猜分配。修订保留历史关联，不移动/复制原轨迹。
- 缺账号、同号多候选、市场/仓库冲突均 fail closed，保留待绑定来源记录但不写 confirmed binding。不能用空字符串默认账号或只看运单号自动绑定。
- Tracking 字段：`binding_id uuid NOT NULL FK logistics_binding`（稳定运单ID，不是修订ID）、`binding_revision_at_ingest_id uuid NULL FK logistics_binding_revision`、`source_event_key text NOT NULL`、`source_version text NOT NULL`、`event_code text NOT NULL`、`event_time timestamptz NULL`、`location text NULL`、`description text NULL`、`collected_at timestamptz NOT NULL`、`raw_payload jsonb`（脱敏）、`supersedes_id uuid NULL FK logistics_tracking`。
- `UNIQUE(binding_id,source_event_key,source_version)`始终作用于稳定运单ID，重绑后重放同一轨迹不再插入；版本须正规化为非NULL稳定值。无源事件ID时使用批准字段集合hash并记录算法版本，碰撞/修订进入核对。索引 `(binding_id,event_time DESC)` 与revision的shipment FK；轨迹追加不改飞书状态、不假设包含商品。
- 写入者：限定 provider/account 的轨迹 worker；绑定确认走授权服务。未绑定数据仅Admin/明确获准的来源审查范围可见，不全员暴露。

### `receipt_evidence`：业务到货与库存观测的对账证据

- 字段：`shipment_item_id uuid NOT NULL FK`、`source_account_id uuid NOT NULL`、`source_receipt_key text NOT NULL`、`source_version text NOT NULL`、`snapshot_batch_id uuid NULL FK`、`snapshot_id uuid NULL FK`、`confirmed_quantity bigint NOT NULL CHECK > 0`、`effective_at timestamptz NOT NULL`。
- 字段：`evidence_status text`（pending/confirmed/rejected/revoked）、`revision bigint NOT NULL CHECK > 0`、`valid_to timestamptz NULL`、`confirmed_by uuid NULL`、`confirmed_at timestamptz NULL`、`reason text NULL`、`supersedes_id uuid NULL FK receipt_evidence`；`UNIQUE(source_account_id,source_receipt_key,source_version,shipment_item_id,revision)`，同凭据+明细仅一个valid_to为空的当前版本。
- 改判关闭旧版本有效期并追加本地revision，已确认版本必须有确认人/时间；源修订后旧版本不能继续占用收货量。若同源凭据在多明细间分摊，累计确认量不能超过凭据总量，不能靠每行不超票数代替总额约束。
- snapshot若关联须属于所指batch、正确仓库/Variant；确认量不能超货票/凭据可用量，锁相关明细和凭据进行累计校验。凭据修订/撤销追加版本，保留历史并重算读模型。
- 确认依据为明确来源收货凭据或带证据的人工对账，绝不由库存前后delta自动推断；仅“较新快照”或“API签收”不足以确认某票已吸收。
- 索引 `(shipment_item_id,effective_at DESC)`、snapshot_id、源凭据键；写入者：授权对账服务。证据不足时在途与快照分开展示，**整体数量/货值合计为待核对**，不能强行去重或相加。

## 7. 成本、币种与经营估值

### `product_cost` / `valuation`：金额独立受控

- Cost 字段：`product_id uuid NOT NULL FK`、`version bigint NOT NULL`、`unit_cost numeric(20,6) NOT NULL CHECK >= 0`、`currency text NOT NULL`、`unit text NOT NULL`、`basis text NOT NULL`（待批准标准成本口径）、`valid_from timestamptz NOT NULL`、`valid_to timestamptz NULL`、`source_ref text NOT NULL`、`approved_by uuid NOT NULL`、`approved_at timestamptz NOT NULL`。
- 同 Product/单位/币种/口径版本唯一、有效区间不重叠；未知成本不创建0记录，真实零成本须显式确认。若成本随国家规格不同，再在独立任务增加Variant维度，不隐式复用。
- Valuation 字段：`as_of timestamptz NOT NULL`、`snapshot_id uuid NULL FK`、`shipment_item_id uuid NULL FK`（恰好一个）、`cost_id uuid NULL FK`、`valued_quantity bigint NULL`、`report_currency text NOT NULL`、`fx_rate numeric(20,10) NULL CHECK > 0`、`fx_version text NULL`、`fx_effective_at timestamptz NULL`、`amount numeric(20,6) NULL`、`status text`（valued/missing_cost/missing_quantity/missing_mapping/missing_fx/reconciliation_pending）。
- valued 要求明确物理/在途量、确认映射、有效成本与币种换算证据；同币种使用1并记同币种口径。其他状态 amount=NULL。汇总只输出已估值小计+覆盖率+缺口数量，不称完整资产总额。
- 索引 Cost `(product_id,valid_from DESC)`；Valuation `(as_of,status)` 及来源FK。写入者：Admin成本审批/估值服务；无金额权限不可读原表、金额汇总、金额排序或导出。Demo人民币数字不是正式成本授权。

## 8. 三角色、市场/仓库与金额隔离

- 保留 profiles/role/user_warehouses；未来增加 `manager` 负责人，角色限定 admin/manager/operator。启用状态与会话有效性共同校验，不信任客户端role/market/user_id或可编辑metadata。
- 目标 `user_market_access(user_id uuid, market text, PRIMARY KEY(user_id,market))`；`user_warehouses` 保留仓授权。负责人/运营可见范围为已授权市场与已授权仓的交集，空范围拒绝；国内CN必须独立分配，不扩大overseas-only helper。
- 目标 `user_capability(user_id uuid, capability text, market text, PRIMARY KEY(user_id,capability,market))`；capability初期仅批准的操作与 `view_amount`，不建立任意复杂权限引擎。Admin维护权限、映射、资料；Manager只读所辖经营；Operator维护所辖日常业务/候选，不确认商品身份。
- 金额能力按市场显式授予，默认拒绝；负责人也不因角色名自动获得所有市场金额。产品级跨市场成本原表不开放给市场读者，由限定市场的估值投影使用。
- 金额投影使用经过完整身份/启用/市场/金额检查的受限后端查询；若必须特权数据库函数，放非公开schema并收紧EXECUTE，不能为绕过成本权限将普通公开RPC一律改成SECURITY DEFINER。
- 新公开表同时配置最小 GRANT 与 RLS；SELECT/写入范围一致，UPDATE具备USING/WITH CHECK，RPC显式EXECUTE。普通查询优先 SECURITY INVOKER，后台特权路径另审计，禁止前端service_role。
- **RLS控制行，不自动控制列。**成本/估值放独立受限表，金额查询服务返回专用DTO；无金额权限时字段不下发，并检查CSV、日志diff/raw、错误、缓存、排序/汇总的间接泄露。
- 历史日志/快照按其仓库和市场授权，不因当前换绑泄露其他市场历史；聚合先做范围过滤。对已撤销授权即时拒绝，无权限不回全量后前端过滤。
- 索引：授权表 `(user_id,market)`、`(user_id,warehouse_id)`；写入者：启用Admin权限服务，同事务审计。对匿名、停用、三角色、跨仓/跨市场、无金额用户分别验证允许与拒绝。

## 9. `operation_log`：统一成功与失败审计

- 字段：`actor_user_id uuid NULL`、`actor_kind text NOT NULL`（user/system）、`occurred_at timestamptz NOT NULL`、`action text NOT NULL`、`entity_type text NOT NULL`、`entity_id uuid NULL`、`request_id uuid NOT NULL`、`batch_id uuid NULL`、`outcome text NOT NULL`（success/failed）、`error_code text NULL`。
- 检索字段：`market text NULL`、`warehouse_id uuid NULL`、`product_id uuid NULL`、`product_code_at_event text NULL`、`barcode_at_event text NULL`、`shipment_id uuid NULL`、`shipment_no_at_event text NULL`、`source_account_id uuid NULL`；保存当时文字便于身份改名后追溯。
- 内容字段：`before_version bigint NULL`、`after_version bigint NULL`、`change_summary jsonb NOT NULL`（允许字段白名单）、`evidence_ref text NULL`、`idempotency_key text NOT NULL UNIQUE`；不记录token/cookie/密码/连接字符串，不把受限金额放通用JSON。
- 覆盖商品修改、映射确认/重核/停用、业务状态变化、同步成败、快照发布/纠错、权限变更；成功日志与业务事务同提交。失败日志不伪装成功，事务回滚后单独记录结果；日志写失败必须可观测。
- 日志只追加，客户端无UPDATE/DELETE；纠正新增关联记录。金额变更值使用同金额权限保护的独立证据，通用日志仅显示动作摘要。市场用户只能看已授权对象，权限配置日志Admin-only。
- 索引 `(occurred_at DESC,id)`、`(actor_user_id,occurred_at DESC)`、`(market,occurred_at DESC)`、`(product_code_at_event,occurred_at DESC)`、barcode/shipment检索索引按查询建立；未定保留策略前不自动清理。

## 10. 增量实施、验证与退出供应商

1. **身份门**：对照ICE资料、条码规则、历史UUID/code/Variant归属，列冲突清单；不自动重编号。确认来源账号/仓库/市场命名空间后才允许真实映射写入。
2. **结构门**：批准新Migration，保留旧列/表；新增映射、批次/快照、日志和索引，先影子采集/只读核对。迁移不能回写虚构Demo资料或替换生产业务数据。
3. **写入门**：备份并暂停有关同步，退役旧累加RPC及手动库存改写授权，验证所有直接表/RPC路径；单点启用快照发布，禁止两套写入者并存。异常立即停止发布、保留证据。
4. **权限与读切换门**：Staging验证Admin/Operator现役兼容及Manager新权限、金额拒绝、并发确认、重复/乱序/部分批次、零与未知、部分到货及两种事件先后；对照旧可售投影和新物理字段，逐页切读。
5. **回退门**：代码、schema、业务数据、授权、配置和最后成功水位组成同一备份单元。写开放前可退读路径；开放后先停写、核对增量再补偿/恢复，不能只回代码、删除新表或丢弃已发布历史。
6. **平台退出门**：Supabase继续保留。未来自有后端逐步替代Auth/SDK/RPC访问，PostgreSQL保留业务UUID和等价RLS；会话验证后以非superuser/非BYPASSRLS连接、事务内注入可信用户上下文，连接池必须隔离并清理上下文。
7. **认证等价门**：单独批准身份提供方、登录迁移、旧token撤销/重新登录策略；验证禁用、授权撤销、匿名/跨市场/金额行为。不得让客户端设置数据库身份，不用service-role通吃来绕RLS；不假设密码能直接迁移。

生产写入、数据库回放、授权变更、供应商迁移均需新任务批准；本期没有这些执行证据。未决成本来源、来源完整性/删除语义、映射碰撞规则、收货证据、保留期和金额授权，只能在Demo中明确模拟，不能默认为已批准业务规则。

参考：[Supabase RLS](https://supabase.com/docs/guides/database/postgres/row-level-security)、[PostgreSQL约束](https://www.postgresql.org/docs/current/ddl-constraints.html)。以上为设计约束，正式DDL须针对实际PostgreSQL版本重放验证。
