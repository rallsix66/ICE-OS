> 历史归档（2026-10-13）：原位置 `docs/design/dis-plans/inventory-ui-upgrade-plan.md`。保留用于旧实现与验收追溯，不作为当前任务或执行授权；现役入口见 [归档索引](../README.md)。

# 库存看板系统 UI 升级方案（基于真实架构）

> 产出角色：巴蒂（方案助理） ｜ 审查：Codex（架构师） ｜ 实现：Claude（主开发）
> 依据：真实代码核对 + `AGENTS.md` 架构边界。事实优先级遵循「真实代码 > migration > docs」。

---

## 0. 架构约束（来自 AGENTS.md，方案不得违反）

- **Codex 默认不实现代码**，只产出可交给 Claude 的自包含指令；本方案同理，不写实现源码。
- **禁止未经确认引入新技术栈 / 新依赖**（AGENTS.md 第 169 行）。引入 framer-motion / react-bits / shadergradient 等须 Codex 明确批准。
- 必须保持：**Repository Pattern**、**Server Actions**、**Zod 校验**、**Feature Module**、**Supabase RLS**。
- 数据链路：读取 = Server Component → repository → Supabase RLS；写入 = Server Action → repository → Supabase RLS。页面/组件**禁止直接调用 `supabase.from()`**。
- 客户端组件（'use client'）只做交互层，数据由其父 Server Component 经 Repository 取好再 props 下发。

---

## 1. 现状核对（真实代码事实，非臆测）

| 项 | 真实情况 | 来源 |
|---|---|---|
| 技术栈 | Next.js 16 + React 19 + Tailwind 4 + shadcn(`base-nova`) + Supabase；RSC=true | `package.json` / `components.json` |
| 配色 | **灰底 + 语义色**：blue/cyan 用于入口卡，red/green/amber 用于状态，非纯灰阶 | `dashboard/page.tsx` |
| 首页结构 | 页头 → 三入口卡(海外/国内/在途) → 低库存汇总 → 关注产品动态 → 快捷操作 | `app/dashboard/page.tsx` |
| KPI 卡 | `app/dashboard/_components/stat-cards.tsx` **仅占位注释**，未实现 | `stat-cards.tsx` |
| 顶栏搜索 | 左侧为占位（注释"未来可放面包屑或搜索"），**⌘K 是明确缺口** | `dashboard-header.tsx` |
| 命令面板 | `components/ui/command.tsx` 已装（cmdk 已在依赖），**未被使用** | `components/ui` / `package.json` |
| 组件库 | 标准 shadcn：card / table / badge / skeleton / input / dialog / select / sheet / pagination 齐备 | `components/ui` |
| 取数模式 | Server Component 内 `Promise.all` 并行取 `getOverseasStats` / `getInTransitByVariant` / `getFollowedVariantsBasic` / `getLowStock`，各自独立 catch | `dashboard/page.tsx` |
| 登录页 | `app/auth/login/page.tsx`（未读，待核对），ShaderGradient 落地前提 | — |

**结论**：升级点应优先落在「已有组件 + 空壳位 + 明确缺口」上，零新依赖可达大部分目标。

---

## 2. 站点 → 优化点 映射（按用户点名的来源）

用户指定参考：21st.dev · motion(motion.dev) · react bits · made with GSAP · bento grids · shadergradient。下面把每个站点的具体玩法**落到你系统里真实的 UI 元素**：

| 用户点名的站点 | 该站点的具体玩法 | 落到你系统的真实元素 | 编号 |
|---|---|---|---|
| **shadergradient** | WebGL 动态网格渐变（蓝/青/靛低饱和） | `auth/login/page.tsx` 登录页背景（唯一重特效位） | A4 / B3 |
| **react bits** | `Aurora`/`Beams` 背景、`SpotlightCard` 鼠标聚光、`MagicBento` 光晕、`ShinyText` 标题 | 登录页背景(Aurora) · 首页入口卡(SpotlightCard) · KPI 卡(MagicBento) · 区块标题(ShinyText)。**光标特效已试 SplashCursor/BlobCursor/TargetCursor，均偏花哨，弃用** | A4 / B2 |
| **21st.dev** | 可排序/筛选/分页 data-table · ⌘K 命令面板 · 干净 Button/Card 变体 | `low-stock-summary-section`(表格升级) · `dashboard-header` 左侧 ⌘K(复用已装 cmdk) · 主 CTA 按钮变体 | A1 / 表格 |
| **bento grids** | 错落网格布局（大卡核心 + 小卡环绕） | `stat-cards.tsx` 空壳 → Bento 概览（总库存价值大卡 + SKU/缺货/在途/周转率小卡） | A2 |
| **made with GSAP** | 数字 ticker / count-up · 滚动进场 stagger | KPI 数字滚动(`AnimatedNumber`) · 卡片/区块进场 animation | A3 |
| **motion (motion.dev)** | `useMotionValue`+`animate` 数字 · `variants`+`staggerChildren` 进场 · 页面切换过渡 | 全站微交互底座（统一 A3/进场，替代手写 rAF 的可选升级） | B1 |

> 原则：**越靠近数据越克制，越靠近门面越可炫**。登录页可上 ShaderGradient/Aurora；数据表格只做 21st.dev 式排序/hover，不堆背景动画。

## 2.1 升级方案总览

| 编号 | 方案 | 分类 | 新依赖 | 落点 |
|---|---|---|---|---|
| A1 | ⌘K 全局命令面板 | A（复用现有） | 无（cmdk 已装） | `dashboard-header.tsx` 左侧占位 |
| A2 | 首页 KPI 卡（Bento 概览） | A（实现空壳） | 无 | `stat-cards.tsx` + `dashboard/page.tsx` |
| A3 | 轻量数字滚动 + 进场 | A（替代 CountUp） | 无（rAF） | 新建 client 组件 |
| A4 | 登录页纯 CSS 渐变 | A（替代 ShaderGradient） | 无（CSS） | `auth/login/page.tsx` |
| B1 | framer-motion 微交互 | B（需确认） | motion | 全站过渡 |
| B2 | react-bits（Aurora/Magic Bento/Spotlight） | B（需确认） | react-bits | 登录页/首页 |
| B3 | shadergradient 动态渐变 | B（需确认） | three.js | 登录页 |

**对应原型**：`inventory-ui-optimized.html` 中每个区块都标注了来源站点与 before/after。

---

## 2.2 侧边栏激活指示（新增，来自用户追问）

真实侧边栏 `sidebar-nav.tsx`：220px、分组可折叠、Phase 灰显、底部角色标签，**激活态为 `bg-gray-200` 灰底**——是最缺设计感的部分。可替换的激活指示效果（均 **A 类零依赖**，不改动分组/Phase/角色逻辑）：

- **滑动指示（motion.dev `layoutId`）**：激活项改用蓝色淡底药丸，切换路由时药丸平滑滑到新项——比静态灰底更有"位置感"。纯 CSS `transition: top` 即可模拟（无需引 motion）。
- **Line Sidebar（reactbits.dev）**：激活项左侧蓝色竖条从 0 展开（`scaleY`），极细线条、克制。
- **图标微交互（21st.dev）**：激活/悬停时图标变蓝或轻微缩放。
- **进场 stagger（Motion/GSAP）**：侧边栏项挂载时依次淡入。

**推荐**：滑动指示 或 Line Sidebar **二选一**（勿叠加）；分组折叠已有，补一个高度过渡即可。遵循用户"克制"偏好——侧边栏同样不做光标/聚光类花哨效果（登录页自定义光标 SplashCursor/BlobCursor/TargetCursor 已验证偏花哨，弃用）。

---

## 3. A 类方案（零新依赖，建议优先交付）

### A1 · ⌘K 全局命令面板
- **目标**：填补顶栏左侧搜索占位，提供全局跳转（库存/产品/SKU/发货单）。
- **实现要点**：
  - 在 `dashboard-header.tsx` 左侧渲染 `Command`（来自 `@/components/ui/command`），或新建 `CommandMenu` client 组件，监听 `⌘K`/`Ctrl+K` 打开 `CommandDialog`。
  - 命令项由**静态路由清单 + 现有导航结构**（`sidebar-nav.tsx` 的 `NAV_GROUPS`）生成，无需新增数据查询。
  - 跳转用 `next/navigation` 的 `router.push`，保持现有导航语义（Phase 未实现项灰显）。
- **禁止**：command 组件内直接查库；引入新搜索后端。
- **验收**：⌘K 打开弹层；可键盘检索并跳转已实现页面；未实现 Phase 项不可进入；空结果有提示；不破坏现有登出/用户信息。

### A2 · 首页 KPI 卡（实现 stat-cards.tsx 空壳）
- **目标**：在首页三入口卡上方新增一行 KPI 概览（海外库存总量 / SKU 数 / 低库存项 / 在途总量）。
- **实现要点**：
  - `dashboard/page.tsx` 已并行取到 `overseasStats` / `inTransitTotalQuantity` / `lowStockItems`，**直接复用**，不新增查询。
  - 新建 `stat-cards.tsx` 为 Server Component，接收上述 props，用 `@/components/ui/card` 渲染；骨架屏用 `@/components/ui/skeleton`（配合现有 `loading.tsx`）。
  - 数字滚动用 A3 的轻量 client 组件包裹（数字本身由 Server 传初值，避免 hydration 不一致）。
- **禁止**：在 KPI 卡内新增 Repository 调用；破坏现有 Promise.all 错误处理。
- **验收**：四张卡数据正确；与下方三入口卡不重复且语义互补；Admin/Operator 均可见；数据缺失时降级为"—"

### A3 · 轻量数字滚动（替代 React Bits CountUp）
- **目标**：KPI 数字进场滚动，纯前端、零依赖。
- **实现要点**：新建 `'use client'` 组件 `AnimatedNumber`，`requestAnimationFrame` + easeOutCubic，尊重 `prefers-reduced-motion`（关闭时直接显示终值）。
- **禁止**：引入 react-bits / framer-motion 仅为此功能。
- **验收**：数字从 0 滚动到终值（~1.1s）；reduced-motion 下静态；SSR 首屏不闪烁。

### A4 · 登录页纯 CSS 渐变背景（替代 ShaderGradient）
- **目标**：登录页门面做低饱和动态渐变，零依赖。
- **实现要点**：在 `auth/login/page.tsx` 容器上用 CSS `radial-gradient` 多层 + `@keyframes drift`（低 saturate，灰蓝/灰青/米白），玻璃拟态登录卡 `backdrop-filter: blur`。
- **禁止**：引入 shadergradient / three.js（属 B3，需确认）。
- **验收**：渐变流动但不干扰表单可读性；移动端不溢出；尊重 reduced-motion。

---

## 4. B 类方案（需 Codex 确认引入新依赖，不擅自实施）

> 以下任一项开工前，须经 Codex 明确批准（触发语或书面确认），并评估对包体积/构建/维护性的影响。

- **B1 framer-motion(motion)**：全站页面切换、列表 stagger、抽屉弹性。收益=统一微交互底座；风险=新增 ~50KB 依赖、需确认与 React 19 / RSC 兼容用法（client 边界）。
- **B2 react-bits**：`Aurora`(登录背景)、`Magic Bento`(首页卡片光效)、`SpotlightCard`(入口卡)。注意：**登录页自定义光标（SplashCursor/BlobCursor/TargetCursor）经原型验证均偏花哨，已弃用**，登录页仅保留 Aurora 渐变。部分组件依赖 three.js，体积大，仅适合门面。
- **B3 shadergradient**：WebGL 动态渐变，登录页最佳，但引入 three.js，GPU 占用高，需确认是否接受。

**建议**：B 类仅用于「门面」（登录页 + 首页概览），核心数据区（表格/表单/同步）保持 A 类克制方案。

---

## 5. 给 Claude 的实施指令（A 类，自包含）

**目标**：在不引入新依赖前提下，完成 A1–A4 四项 UI 升级，且严格保持现有架构边界。

**范围**：
1. `dashboard-header.tsx`：左侧占位改为 ⌘K 命令面板（复用 `@/components/ui/command`）。
2. `stat-cards.tsx`：实现首页 KPI 卡，数据来自 `dashboard/page.tsx` 已有 `overseasStats` / `inTransit*` / `lowStockItems`，用 `@/components/ui/card` + `skeleton`。
3. 新建 `AnimatedNumber` client 组件（rAF + reduced-motion），用于 KPI 数字。
4. `auth/login/page.tsx`：加纯 CSS 渐变背景 + 玻璃卡（需先读该文件核对现有结构）。

**禁止**：
- 新增 npm 依赖（framer-motion / react-bits / shadergradient 等）。
- 页面或客户端组件直接调用 `supabase`。
- 改动现有 Repository / RLS / Migration。
- 破坏 Promise.all 并行取数与独立错误处理。

**验收标准**：
- ⌘K 正常开合、可跳转、未实现 Phase 不可进入。
- KPI 卡数据正确、与三入口卡不冲突、数据缺失降级。
- 数字滚动在 reduced-motion 下静态。
- 登录页渐变可读、移动端不溢出。
- `npm run lint` + `npm run build` 通过；Admin 与 Operator 权限路径均验证。
- 空数据 / 加载 / 错误 / 无权限状态均不崩溃。

**需运行命令**：`npm run lint` ｜ `npm run build`（验收用，不自动修复）。

---

## 6. 风险与待 Codex 决策

1. **B 类依赖**：framer-motion / react-bits / shadergradient 是否引入、引入哪些 —— 待 Codex 拍板。
2. **首页信息架构**：是否将「三入口卡 + KPI + 两大区块」重排为 Bento 网格（视觉升级，不改变数据链路）——建议 Codex 确认是否调整布局密度。
3. **登录页现状**：方案 A4 依赖先读 `auth/login/page.tsx` 核对现有 DOM，Claude 实施前须核对。
4. **包体积**：若批准 B 类，需评估 three.js 对登录页首屏的影响（建议动态 import / 仅登录路由加载）。
