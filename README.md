# DIS / ICE 库存经营工作台

以人工商品货号为身份，连接国内、海外和在途库存的经营管理系统。现有 DIS 业务系统继续保留；ICE v4 目前是设计与**虚构数据 Demo**，不是已接通的生产新系统。

## ICE v4 Demo

使用仓库锁定的依赖（Node 24，见 `.nvmrc`）：

```bash
npm ci
npm run dev
```

访问 [http://localhost:3000/demo/ice-v4](http://localhost:3000/demo/ice-v4)。包含经营总览、商品库存、ICE商品库、市场物流、库存快照、数据同步、操作日志、权限设置八个入口。首页增加库存数量与商品概览，商品资料使用表格，物流可按市场/状态/关键词集中查看并打开单票详情。

所有数据均为虚构，模拟操作只在浏览器本次会话内生效，刷新或重置即可恢复。同步设置只改变模拟启停/频率/检查结果，不连接来源、不发布快照、不运行后台任务；权限配置会影响演示角色的市场、金额和映射按钮，但不构成真实安全边界。Demo不需要真实Supabase/第三方账号，不要把生产资料填进演示数据。

现役 `/dashboard` 仍需要原有认证和环境配置；不要把 Demo 可访问解释为已完成真实权限/接入改造。

## 方案与证据

- [现状分析](docs/current-analysis.md)：真实代码与复用边界。
- [产品方案 v4](docs/product-plan-v4.md)、[架构 v2](docs/architecture-v2.md)、[数据库设计 v2](docs/database-design-v2.md)、[数据流 v2](docs/data-flow-v2.md)。
- [当前状态](docs/current-state.md)、[本次任务](docs/tasks/current-task.md)、[验证记录](docs/reports/2026-10-13-ice-v4-validation.md)。
- 全部资料入口：[docs/README.md](docs/README.md)。新数据库文档是设计，没有新增/执行Migration。

## 验证命令

```bash
node node_modules/vitest/vitest.mjs run src/features/ice-demo
npm run test
npm run lint -- --max-warnings 0
npm run build
git diff --check
```

Windows若npm通过cmd执行单引号参数，默认测试等价命令：

```powershell
node node_modules/vitest/vitest.mjs run --exclude '**/concurrency.test.ts' --exclude '**/*.postgres.test.ts' --exclude '**/*.live.test.ts'
```

数据库/并发/live验证是独立环境任务，不为了演示连接生产。测试不全绿时保留证据，不修改历史Migration绕过失败。提交/推送方案分支不代表生产已部署。
