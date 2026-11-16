# ICEOS / ICE 库存经营工作台

以人工 ICE 货号为身份，连接国内、海外和在途库存的经营管理系统。当前运行的是**本机隔离实例**
（标准 PostgreSQL + 自有 Next.js 服务端），不是云端部署，也不是虚构数据 Demo。

## 当前运行现场（2026-11-16）

| 项 | 值 |
|---|---|
| 实例 | `run-20261026T211500Z-11a22b33` |
| Web | http://127.0.0.1:3011 （登录页 `/auth/login`，账号 `admin@catalog.test`，密码见实例 `login.local-preview.txt`，不入 Git） |
| PostgreSQL | `127.0.0.1:59345`，库 `iceos_catalog_run_20261026T211500Z_11a22b33` |
| 后台任务 | 本轮只启动 PostgreSQL 与 Web；库存同步 worker、物流在途读取、飞书商品来源读取**未启动**（最新批次停在 2026-11-12 16:22） |
| 当前 BUILD | `S1prE-Z5-Gb9BRJNwaKIT`，源码快照 `f19186de20ab2a3f`（2026-11-16：商品库存「历史快照」页签按仓+已发布批次查看当时 SKU/商品归属/实物/锁定/仓库可用/单位；左栏批次 50 条/页分页，超过最近 200 条的历史也能选；明确批次按编号独立读取并核对所属仓，不存在/仓库不匹配只给提示、不显示其他批次数量；批次列表翻页/明细分页沿用当前实际查看的批次，只有点批次或切仓才换详情；未绑定 SKU 可查，真实 0 显示 0、缺失「未提供」、本批未见明确提示；切批次保留来源 SKU 搜索，返回库存保留原筛选。执行方自验：分页状态 10/10、B1 11/11、单测 15/15，临时实例 210 批 17/17 + 应用角色读取、既有使用链 26/26 沿用；**独立差异复核 PASS、阻断 0**） |
| Vercel / Supabase | 已退役（2026-11-08，独立复审通过）；仓库无两平台运行依赖 |

## 启动、状态、停止

在仓库根执行（每个脚本都会校验实例与进程归属，不会启动第二份）：

```powershell
node scripts/inventory/start-instance.mjs --run-id run-20261026T211500Z-11a22b33

node scripts/inventory/status.mjs --run-id run-20261026T211500Z-11a22b33

node scripts/inventory/stop-instance.mjs --run-id run-20261026T211500Z-11a22b33
```

只恢复某一个后台任务、登录失效、失败排查见运行交接文档：
[库存自动同步](docs/tasks/inventory-sync-v1-runbook.md)、
[物流在途读取](docs/tasks/shipment-in-transit-v1-runbook.md)。

**新建实例**（会创建新数据库和配置，不是日常启动；本机 Windows 链已验证，Mac 上未验证）：

```powershell
node scripts/catalog/prepare-local-preview.mjs --run-id <新 run-YYYYMMDDTHHMMSSZ-8hex>
node scripts/inventory/prepare-instance.mjs --run-id <同一个 run-id>
node scripts/catalog/build-preview-workspace.mjs --run-id <同一个 run-id>
node scripts/catalog/promote-preview-build.mjs --run-id <同一个 run-id>
node scripts/inventory/start-instance.mjs --run-id <同一个 run-id>
```

## 依赖

- Node 24（见 `.nvmrc`），`npm ci` 安装锁定依赖。
- 飞书读取依赖本机已授权的 `lark-cli`（npm 全局包 `@larksuite/cli`，授权配置在用户目录 `~/.lark-cli`）；可用
  `SHIPMENT_LARK_CLI_RUNNER` 指定 `run.js` 路径（页面刷新入口需写进实例 `env.catalog.json`）。

## 验证命令

```powershell
npm run test      # 单元测试（排除 concurrency / postgres / live）
npm run lint -- --max-warnings 0
npm run build
git diff --check
```

## 文档入口

- [飞书商品资料真实持续更新 v1](docs/tasks/feishu-product-source-real-v1.md)：真实读取、采用结果、定时读取入口；
  日常入口在「数据同步」页「飞书商品资料」区块，来源待核对已接入商品库「待处理」。
- [飞书商品资料人工核对与持续采用流程 v1](docs/tasks/feishu-product-source-review-flow-20261110.md)：跨批待办去重、
  字段级暂不处理、同号多行人工选择、缺货号待确认与测试码纠正、LS101501 重量口径。
- [待处理页原因/差异/入口精简](docs/tasks/catalog-pending-simplify-20261110.md)：每条直接显示具体原因、
  逐行差异与具体动作按钮，来源详情按需展开，入口定位到对应事项。
- [当前状态](docs/current-state.md)、[本次任务](docs/tasks/current-task.md)、[全部文档入口](docs/README.md)。
- [架构 v3](docs/architecture-v3.md)、[历史模型](docs/history-data-model-v1.md)。
- [商品身份标准](docs/product-identity-standard-v1.md)（唯一正文）、[数据库设计 v2](docs/database-design-v2.md)。
- [旧 DIS 方案与交付历史](docs/archive/dis/README.md)：追溯用，不作为当前实施授权。

## Demo（虚构数据，不是现役系统）

`/demo/ice-v4` 仍保留为虚构数据演示：不连接来源、不发布快照、不运行后台任务，操作只在浏览器本次会话内生效。
不要把 Demo 可访问解释为真实权限/接入验收，也不要把生产资料填进演示数据。
