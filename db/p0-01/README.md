# P0-01 实验数据库脚本

仅用于本地隔离环境的独立 PostgreSQL + RLS 最小读取闭环验证。不得用于生产，不得重放或修改 `supabase/migrations/00001–00052`。

应用顺序（由 `scripts/p0-01/apply-schema.mjs` 执行）：

1. `001_instance_and_roles.sql` — 实例标识、角色、owner 分离
2. `002_auth_schema_grants.sql` — 认证 schema 占位与 auth 运行角色权限
3. `003_business_schema.sql` — 业务表、RLS、策略
4. `004_rls_policies.sql` — 行级策略与金额隔离
5. `005_auth_runtime_grants.sql` — 认证运行角色对 Better Auth 表的 GRANT（在 migrate 之后）

Better Auth 表由 CLI/`getMigrations` 在 `p0_01_auth` schema 创建。
