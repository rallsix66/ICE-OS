# 旧入口处置表（2026-10-22）

| 旧路径 | 处置 | 现役行为 |
|--------|------|----------|
| `/dashboard/products` | 重定向 | → `/dashboard/catalog`（`search` → `q`） |
| `/dashboard/products/[id]` | 封存说明 | 不猜测 UUID 映射 |
| `/dashboard/products/overview` | 封存说明 | 全球库存作战室 |
| `/dashboard/inventory/domestic` | 封存说明 | |
| `/dashboard/inventory/overseas` | 封存说明 | |
| `/dashboard/inventory/in-transit` | 封存说明 | |
| `/dashboard/shipments/**` | 封存/重定向 | 子路径合并至列表封存页 |
| `/dashboard/sync` | 封存说明 | |
| `/dashboard/variants/**` | 封存/重定向 | |
| `/dashboard/replenishment` | 封存说明 | |
| `/dashboard/users` | 封存说明 | 鉴权逻辑保留在 `src/lib/auth` |
| `/dashboard/users/warehouses` | 封存说明 | |
| `GET/POST /api/products` | HTTP 410 JSON | `sealed` |
| `GET/POST /api/inventory` | HTTP 410 JSON | |
| `GET/POST /api/shipments` | HTTP 410 JSON | |
| `GET/POST /api/users` | HTTP 410 JSON | |
| `/api/cron/golucky` | HTTP 410 JSON | |
| `/api/cron/dry-run` | HTTP 410 JSON | |
| `/api/p0-02/dashboard` | HTTP 410 JSON | session 路由保留 |
| `/api/p0-02/inventory` | HTTP 410 JSON | |

配置源：`src/ui/ice-v4/navigation-config.ts`（`LEGACY_ROUTE_DISPOSITION`）。
