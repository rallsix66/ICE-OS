# Legacy business restore notes (2026-10-22)

本目录为**代码封存**，不包含数据库删除、Migration 回滚或 `.local` 证据清理。

## 布局

- `manifest.json`：封存时每个文件的相对路径（相对 `src/`）与 SHA-256（**262** 份源码，含 sync 等全量登记）。
- `EXTERNAL-POINTER.json`：外置副本路径与逐文件 SHA-256（与 manifest 一致）。
- **外置完整副本**：`D:/try one/ICEOS-legacy-archive/20261022/`（与 manifest 哈希一致；仓库内 `src/` 副本已移除以减少现役干扰）。

## 依赖关系（摘要）

封存模块曾依赖：

- PostgreSQL public  schema（product / variant / inventory / shipment / sync 等，见历史 Migration 00001–00052）
- `@/lib/auth`、`@/lib/database/*` 鉴权与 RLS 运行身份
- `@/features/warehouse-access` 与 `@/features/preferences`（侧栏与海外页）

现役商品库（`src/features/catalog`）**不**依赖本目录。

## 恢复步骤（仅在有明确授权时）

1. 将所需子树从外置目录 `D:/try one/ICEOS-legacy-archive/20261022/src/`（或经授权恢复的备份）复制回 `src/`（勿覆盖现役 catalog 与 `src/ui/ice-v4` 外壳）。
2. 恢复对应 `src/app/dashboard/*` 与 `src/app/api/*` 路由文件。
3. 从 `manifest.json` 核对文件哈希；运行 `npm run lint`、`npm run build` 与包级验收脚本。
4. 在 `docs/` 与 AGENTS.md 登记重新开放的范围，**不得**默认恢复生产写入或 cron。

## 现役白名单

见 `active-routes-whitelist.md` 与 `legacy-route-disposition.md`。
