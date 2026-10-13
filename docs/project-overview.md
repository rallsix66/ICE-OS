# DIS 项目概览

> 旧版项目概览。ICE v4 产品目标见 [product-plan-v4.md](product-plan-v4.md)；真实现状见 [current-analysis.md](current-analysis.md)。下文国内库存和入仓加库存属于旧设计，不能作为当前实现依据：00026之后正常到仓只更新货票，不增加BigSeller库存。

> 文档导航：[文档树](README.md) · [当前状态](current-state.md) · [架构](architecture.md) · [路线图](mvp-roadmap.md)

## 项目目标

DIS 是面向供应链运营团队的国内外库存看板系统。系统将分散在中国和五个海外仓的库存、SKU 映射和在途物流集中展示，帮助团队快速回答：

- 哪些产品库存不足？
- 各国家仓库当前有多少库存？
- 已发出的货物到达哪个物流节点？
- 不同国家的仓库 SKU 对应哪个标准产品？
- 最近一次库存同步是否成功？

覆盖国家：中国、泰国、印尼、马来西亚、菲律宾、越南。

## 目标用户

| 用户 | 主要工作 |
|---|---|
| Admin | 维护标准产品、安全库存、SKU 映射、用户权限和同步配置 |
| Operator | 查看库存与在途状态，维护允许操作的库存和物流记录 |

系统强调桌面端、信息密度和运营效率，不追求复杂交互或移动端适配。

## 核心业务模型

不同国家可能对同一产品使用不同 SKU、名称和版本，因此系统采用双层模型：

```text
Product（标准产品）
  → ProductVariant（各国家仓库 SKU）
```

- Product 提供统一产品身份和安全库存
- ProductVariant 保留各国仓库原始 SKU 与名称
- Inventory 和 ShipmentItem 关联 ProductVariant
- 系统通过 ProductVariant 映射汇总到 Product

SKU 不能作为全局主键，Inventory 不能直接关联 Product。

## 核心业务流程

### 产品与 SKU 映射

1. Admin 创建标准 Product
2. 同步发现各国家仓库 SKU，并创建 ProductVariant
3. 未识别 SKU 进入待处理列表
4. Admin 将 ProductVariant 匹配到 Product

### 库存管理

1. 国内库存由人工维护，海外库存由同步写入
2. Inventory 通过 ProductVariant 关联标准 Product
3. 当 `quantity <= safety_stock` 时标记为低库存
4. 未匹配 SKU 不参与低库存统计

### 在途物流

```text
booking → loading → departed → arrived → customs → warehoused
```

Shipment 保存运输主单，ShipmentItem 保存产品和数量，TrackingEvent 保存状态轨迹。完成入仓后，对应 Inventory 增加。

### 数据同步

海外仓库存由页面抓取同步。同步失败时保留上次成功数据，并通过 SyncLog 记录结果和错误。新发现 SKU 自动进入待匹配流程。

## MVP 范围

| Phase | 范围 |
|---|---|
| Phase 0 | 项目、数据库、认证、Dashboard 骨架 |
| Phase 1 | Product CRUD 与 ProductVariant 映射 |
| Phase 2 | 库存页面、低库存统计与 Dashboard |
| Phase 3 | Shipment 与物流状态 |
| Phase 4 | 用户和角色管理 |
| Phase 5 | 海外库存同步 |

## 明确不做

- 不建设完整进销存或 WMS
- 不处理财务结算
- MVP 不做库存历史趋势
- MVP 不做自动 SKU 匹配
- MVP 不做 Shipment 自动状态推进
- 不做移动端适配

当前进度和已接受技术债务以 `current-state.md` 为准。
