# 现役 Dashboard 路由白名单（2026-10-22）

| 路径 | 说明 |
|------|------|
| `/dashboard` | 302 → `/dashboard/catalog` |
| `/dashboard/catalog` | 商品库列表（126 主资料、样表库存投影） |
| `/dashboard/catalog/[uuid]` | 商品库详情 |
| `/dashboard/catalog/intake` | 持续新品 |
| `/dashboard/catalog/sources` | 来源核实 |
| `/dashboard/catalog/admin` | 管理与审计（admin） |
| `/auth/*` | 登录与认证 |
| `/demo/ice-v4` | 虚构演示（隔离） |

导航侧栏仅列出上表商品库相关四项（admin 见管理与审计）。
