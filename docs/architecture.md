# DIS 架构说明

> 历史基础说明：ICE v4 新目标见 [architecture-v3.md](architecture-v3.md)（脱离 Supabase + 历史底座），首版为 [architecture-v2.md](architecture-v2.md)，当前代码差异见 [current-analysis.md](current-analysis.md)。本页旧模块清单与Operator范围不是完整现状；真实仓库授权以代码/RLS为准。新设计尚未替换现役后端。

> 文档导航：[文档树](README.md) · [项目概览](project-overview.md) · [当前状态](current-state.md) · [数据库设计](database-design.md)

## 架构目标

DIS 采用单体 Next.js 应用，当前优先使用 Supabase 与 Vercel/Next.js 生态能力快速开发。目标是在不增加当前交付负担的前提下，通过轻量封装保留未来迁移到阿里云、腾讯云或其他平台的能力。

## 技术栈

- Next.js 16 App Router
- React 19、TypeScript strict
- Supabase Auth、PostgreSQL、RLS
- Tailwind CSS 4、shadcn/ui
- Zod
- Vercel / Next.js 平台能力（当前开发使用；正式部署平台待定）

## 数据访问链路

```text
Page / Component
  → Server Action
  → Repository / Service Wrapper
  → Supabase（当前实现）
  → PostgreSQL RLS
```

- 页面负责数据展示和组合
- Client Component 仅负责必要交互
- Server Action 负责写操作、Zod 校验、身份和权限校验
- Repository / Service Wrapper 集中封装当前 Supabase 查询和云服务调用
- RLS 是数据库最终权限边界

页面、组件和业务逻辑禁止直接调用云平台 SDK 或绑定供应商专有 API。

## 云供应商隔离

当前允许使用 Supabase 与 Vercel/Next.js 能力快速交付，但数据库、认证、对象存储、同步任务和部署平台能力必须经过项目封装层使用。

```text
业务层
  → Repository / Auth Service / Storage Service / Sync Service
  → Supabase / Vercel（当前开发实现）
```

强制规则：

- 页面和组件只能依赖业务接口、Server Actions 或供应商无关类型
- Supabase、Vercel 等 SDK 与专有类型应集中在 Repository、`src/lib/` 或基础设施封装中
- 禁止将 Supabase 表结构、Auth Session、Storage URL 或部署平台 API 直接暴露为业务模块公共契约
- 简单功能优先复用现有封装，不为假设中的迁移提前建设复杂抽象
- 当同类能力出现多个实现、供应商逻辑开始穿透业务层，或准备迁移时，再抽取正式 Provider Adapter
- 替换云供应商时，业务页面和核心业务规则不应需要重写

当前模块 Repository 直接调用 Supabase 属于允许的快速开发方式；供应商耦合必须停留在 Repository 和基础设施封装内部。

## 目录职责

```text
src/
├── app/                 路由、布局、页面和 Route Handlers
├── features/            按业务域组织的类型、校验、Repository、Action 和组件
├── components/ui/       shadcn/ui 基础组件
├── lib/providers/       需要正式适配层时使用，不要求提前创建
├── lib/                 Auth、云 SDK 封装、共享服务和全局工具
└── types/               数据库类型与跨模块共享类型
```

业务模块通常按需包含：

```text
src/features/<module>/
├── types.ts
├── schema.ts
├── repository.ts
├── actions.ts
├── columns.tsx
└── components/
```

当前业务模块：products、variants、inventory、shipments、users、dashboard。

## 认证与权限

权限分为三层：

1. Proxy：刷新 Session，保护受限路由
2. Server Action：校验登录状态、启用状态、角色和输入
3. Supabase RLS：数据库最终权限兜底

角色：

| 角色 | 权限 |
|---|---|
| Admin | 读写所有业务数据和管理操作 |
| Operator | 读取全部业务数据，写入允许的 Inventory 和 Shipment 数据 |

前端隐藏按钮仅用于 UX，不能替代服务端权限。

## 核心模块依赖

```text
Product → ProductVariant
                 ├── Inventory
                 └── ShipmentItem → Shipment → TrackingEvent

Warehouse ───────┼── Inventory
                 ├── Shipment
                 └── SyncLog
```

ProductVariant 是库存、物流与标准产品之间的必要映射层。

## 数据变更与缓存

- 数据库结构变更必须新增 Migration
- 禁止修改已执行 Migration
- 写操作完成后使用 `revalidatePath` 刷新相关页面
- V1 不引入额外全局状态库或缓存基础设施

## 当前限制

- `middleware.ts` 已于 2026-07-08 迁移为 `proxy.ts`（NEXTJS16-PROXY-MIGRATION）
- `database.ts` 当前由 Migration DDL 解析生成
- 当前部分页面仍为占位实现

实时架构状态和已知风险以 `current-state.md` 为准。
