# ICEOS / ICE 库存经营工作台

以人工 ICE 货号为身份，连接国内、海外和在途库存的经营管理系统。当前运行的是**本机隔离实例**
（标准 PostgreSQL + 自有 Next.js 服务端），不是云端部署，也不是虚构数据 Demo。

## 当前运行现场（2026-11-11）

| 项 | 值 |
|---|---|
| 实例 | `run-20261026T211500Z-11a22b33` |
| Web | http://127.0.0.1:3011 （登录页 `/auth/login`，账号 `admin@catalog.test`，密码见实例 `login.local-preview.txt`，不入 Git） |
| PostgreSQL | `127.0.0.1:59345`，库 `iceos_catalog_run_20261026T211500Z_11a22b33` |
| 后台任务 | 库存同步 worker（60 分钟计划）、物流在途读取（10 分钟计划）、飞书商品来源只读读取（60 分钟计划），均在运行 |
| 当前 BUILD | `9RzzfQJdK9-030EksOfPl`，源码快照 `aef3e7f705463f7e`（2026-11-12 第四轮：飞书工厂资料全部修好后，上一批仍有工厂待办时待处理只显示一条「飞书工厂资料已修好，等待确认更新」+「查看更新」，确认采用后消失；没读到快照显示「暂时无法确认」而不是已修好。物流沿用规则预告改按当前所选商品计算，已关联同一商品的其他明细计 0 条、换选商品刷新，零条写「其他明细无需改动」；保存回执只写本条规则另外影响条数，不混入同次其它规则。现役只读 8/8、克隆库 22/22、040 回读 17/17，PASS 由独立复核给出） |
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
