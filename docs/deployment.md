# DIS 环境与发布

> **2026-11-08 已退出 Vercel 与 Supabase；2026-11-09 独立复审通过（`PLATFORM_RETIREMENT_V1_LOCAL_PASS`，阻断 0）。** 本文以下环境矩阵、Vercel/Supabase 部署步骤属于历史记录，
> 不再代表当前运行方式。现役仅本机实例 `run-20261026T211500Z-11a22b33`（Web 3011 / PostgreSQL 59345），
> 认证为 Better Auth + 本地 PostgreSQL；新版正式部署尚未完成。退役与归档见
> [platform-retirement-20261108.md](tasks/platform-retirement-20261108.md)，复审报告见
> [independent-review.md](../.local/platform-retirement-independent-20261109/independent-review.md)。

> 文档导航：[文档树](README.md) · [当前状态](current-state.md) · [架构](architecture.md) · [数据库设计](database-design.md)

## 环境

| 环境 | 用途 | 应使用的数据 |
|---|---|---|
| 本地开发 | 日常开发与构建验证 | 本地或开发 Supabase |
| Preview / Staging | PR 验收 | 独立 Staging Supabase |
| Production | 团队正式使用 | Production Supabase |

当前 Staging 尚未建立，具体状态以 `current-state.md` 为准。

## 部署决策

DIS 是公司内部使用的小型库存看板，正式部署必须优先满足：

- 平台免费套餐允许公司内部或商业用途
- 未经明确批准，不产生固定月费或自动超额费用
- 保留现有 Supabase PostgreSQL、Auth 和 RLS
- 部署后用户通过固定网址访问，不依赖本地 PowerShell 或开发服务器

当前阶段：

- 使用 Vercel/Next.js 与 Supabase 快速开发和验证
- 正式部署平台尚未确定，暂不指定 Vercel、Cloudflare、阿里云或腾讯云
- 上线前再评估免费额度、公司内部使用条款、稳定性、兼容性和迁移成本
- 未经项目负责人明确确认，不开通付费套餐或自动超额计费

## 云平台可替换性

- 当前允许使用 Supabase 与 Vercel/Next.js 生态快速开发
- Supabase 与 Vercel 都不是业务层永久依赖，正式部署平台待定
- 数据库、认证、对象存储、同步任务和部署平台 API 必须通过项目封装层使用
- 页面、组件和业务模块禁止直接调用云平台 SDK
- 环境变量名称、供应商 SDK 类型和专有响应结构不得成为业务公共契约
- 部署与基础设施配置应集中维护，保留迁移到阿里云、腾讯云或其他平台的空间
- 不为未来迁移提前建设复杂抽象；当迁移真实发生时，在现有封装边界后替换实现
- 引入新云服务前，必须说明替换边界、数据迁移方式和退出方案

## 环境变量

客户端可见：

- `NEXT_PUBLIC_SUPABASE_URL`
- `NEXT_PUBLIC_SUPABASE_ANON_KEY`

仅服务端：

- `SUPABASE_SERVICE_ROLE_KEY`
- 数据库连接和第三方秘密密钥

规则：

- `.env.local` 不提交 Git
- `.env.example` 只保存变量名
- 秘密密钥禁止使用 `NEXT_PUBLIC_` 前缀
- 禁止在日志、错误响应或客户端代码中暴露秘密

### 完整环境变量清单

| 变量 | 层级 | 必需 | 说明 |
|---|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | 客户端 | ✅ 必需 | Supabase 项目 API URL（如 `https://xxx.supabase.co`） |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | 客户端 | ✅ 必需 | Supabase 匿名 key（前端安全使用） |
| `SUPABASE_SERVICE_ROLE_KEY` | 服务端 | ✅ 必需 | Supabase 服务端 key（绕过 RLS，仅限 repository/adapter 层） |
| `WEBSYNC_REAL_WRITE_ENABLED` | 服务端 | ✅ 必需 | Web 真实写入功能门：`true` 启用，`false` 仅允许 Dry Run。该开关不是自动同步开关，仅控制 Web 端真实写入入口。当前保持 `true`（用于手动真实写入验证） |
| `CRON_API_KEY` | 服务端 | 可选 | Vercel Cron 路由鉴权 API key（由用户自行生成安全随机字符串）。仅启用 P5-SY10E 定时自动 Dry Run 时需要 |
| `CRON_SYSTEM_USER_ID` | 服务端 | 可选 | 定时任务触发时使用的系统用户 UUID（Supabase `auth.users` 中的 Admin 用户）。仅启用 P5-SY10E 定时自动 Dry Run 时需要 |

### 环境变量同步说明

- `.env.local` 中的密钥更新后，**必须重启本地 dev server**（`npm run dev`）才能加载新值。
- 若部署到 Vercel，必须在 **Vercel Project Settings → Environment Variables** 中同步上述所有变量，然后 **redeploy** 才能生效。
- `WEBSYNC_REAL_WRITE_ENABLED`：该开关不是自动同步开关，仅控制 Web 端真实写入入口。当前 `true` 仅允许人工触发真实写入，不代表自动同步开启。
- **自动同步启用前置条件**：连续 5 天手动同步成功，且无未处理 BLOCK/失败仓库后，才允许进入自动同步启用评估。当前 3/5 天通过，自动同步仍未启用。
- `CRON_API_KEY` / `CRON_SYSTEM_USER_ID` 当前不启用，可后续启用定时任务前再配置。
- 秘密密钥（`SUPABASE_SERVICE_ROLE_KEY`、`CRON_API_KEY`）禁止出现在客户端 bundle 中。
- `.env.example` 仅保存变量名和默认值（如 `false`），不包含真实密钥值。

## 开发验证

功能完成前至少验证：

```bash
npm run build
```

涉及数据库变更时，还必须验证：

- Migration 可在目标开发环境执行
- 新表和新字段约束正确
- RLS 对 Admin 与 Operator 行为正确
- 现有数据兼容

## 发布流程

推荐流程：

```text
feature/fix branch
  → PR / review
  → Preview 验证
  → 合并主分支
  → 待确定的 Production 平台
```

- 生产部署平台尚未确定；当前仅进行本地开发和必要的 Vercel/Next.js 验证
- 禁止直接在生产环境修改代码或数据库
- 新依赖、Migration 和 RLS 变化必须经过审查
- 环境必须使用各自独立的 Supabase 配置

## 数据库发布

- 数据库结构变更必须提交新 Migration
- 禁止修改已执行 Migration
- 禁止在生产库手动执行临时结构修改
- 发布前确认 Migration 顺序和依赖
- RLS 变化必须在非生产环境验证

## 回滚

应用问题：

1. Revert 对应代码变更
2. 重新部署
3. 验证登录、Dashboard 和受影响业务流程

数据库问题：

1. 编写新的修复或回滚 Migration
2. 不修改已执行 Migration
3. 评估数据兼容性和不可逆影响
4. 在非生产环境验证后再发布

## 发布检查

- TypeScript 和 `npm run build` 通过
- 权限链和 RLS 验证通过
- Migration 已验证
- 环境变量已配置
- 未暴露秘密或内部错误堆栈
- 关键业务流程无回归
