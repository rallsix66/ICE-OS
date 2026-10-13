# ICE v4 方案与 Demo 验收记录

> 日期：2026-10-13（Asia/Shanghai）。基线：44d0b13cd2bc58a09bae46fc4594839d21996de1。此报告不是生产发布或真实权限验收。

## 交付结论

五份设计文档、ADR、AGENTS和导航/状态入口、六视图隔离Demo完成；新增81/81测试、lint和Next构建通过。默认测试保留一项改动前失败，直接tsc仍有历史测试类型诊断，不称全部质量门全绿。真实数据库/迁移/来源接入均未执行。

## 改动前与改动后测试

Windows默认测试等价命令（避免npm/cmd单引号差异）：

    node node_modules/vitest/vitest.mjs run --exclude '**/concurrency.test.ts' --exclude '**/*.postgres.test.ts' --exclude '**/*.live.test.ts' --reporter=dot

- 改动前：4012/4013，101 files中100通过/1失败，17.25秒，exit 1。
- 改动后：4093/4094，103 files中102通过/1失败，17.99秒，exit 1。
- 唯一失败相同：src/features/database/opt6-production-apply.test.ts:43，canonical migration body byte-for-byte契约，AssertionError: Target cannot be null or undefined。
- 只读诊断：测试只将Migration规范化为LF，没有处理packet。packet有465个CRLF，原串匹配0次，两侧规范化后匹配2次。本期不改旧测试、SQL、Migration或Git换行配置，也不把该失败改判PASS。
- 新增聚焦测试：node node_modules/vitest/vitest.mjs run src/features/ice-demo --reporter=dot，81/81（行为74+隔离7），2 files，最终744ms，exit 0。
- npm run lint -- --max-warnings 0：exit 0，0 errors / 0 warnings；未自动修复。
- npm run build：最终源码/CSS完成后重跑exit 0，Next内置TypeScript通过，28条页面生成完成，/demo/ice-v4为静态路由。
- 构建保留既有NFT trace warning：next.config.ts → sync/server-actions.ts → api/cron/dry-run；这几个文件没有改动。
- 额外直接tsc --noEmit --incremental false --pretty false：exit 1；均为未修改历史测试中的ES2017正则flag、result.data可空、NODE_ENV只读、Mock参数和类型断言等诊断，无Demo路径诊断。与Next构建结果分开记录；本次未独立重放旧提交的tsc。
- git diff --check通过；7份新主文档/README相对链接检查missing=0。

## 浏览器与正式构建验证

本机127.0.0.1:3104；验收进程使用loopback/占位Supabase变量，WEBSYNC写入关闭，不读取或输出真实密钥。先检查dev，再停止dev，以npm run start检查最终构建产物。

- 六视图可切换；首页国内已估值215320、在途5690、海外110994人民币均来自同一虚构模型，显示缺成本/未归集和跨阶段合计待核对。
- 69编码0690123400001保留字符串并命中ICE-1001；外部SKU PH-GLOW-NEW命中ICE-1002；不存在查询可清空恢复。无来源市场显示—，不显示伪零。
- 商品详情展示身份、中英文名称/规格/单位/分类、各市场SKU/Variant、快照历史、关联货票和日志；单位成本18.5不被显示为19。Escape可关闭，焦点回到原商品按钮。
- 物流实际点击：飞书到货=库存240/在途0；新完整快照及明确收货证据=340/0；库存先到=340/100但合计待核对、不显示440。来源在途不再相加，国内发货不由页面扣库存。
- PH-GLOW-NEW确认由v1变v2并新增本地会话日志；查看原快照仍为pending/v1、实物84/可售80，当前归集排除，历史未改写。
- 日志可按人员/日期/市场/业务标识组合筛选，跨市场得到空结果；种子和会话日志分开。
- 运营视角无货币数值、无确认/重核按钮；负责人有金额但无确认按钮。页面明确这些只是虚构数据视角，不是服务端权限。
- 390×844视口：首页/表格的scrollWidth=clientWidth，无页面级横向溢出；导航和表格区域横滚；详情内部纵向滚动、可关闭。验收后恢复默认视口。
- 最终正式构建预览再次验证物流场景成功；从本次reload起的新console warning/error为0。dev装配期间缺模块/样式错误属于此前历史，不混为最终状态。
- DOM脚本均来自本机Next资源；静态隔离测试禁止真实业务SDK/Actions/env/network/持久化。浏览器接口不支持完整Performance网络清单，本次未完整抓包，不声称审计了浏览器扩展或平台自身请求。

## 修改文件清单（27个）

入口与状态：AGENTS.md；README.md；docs/README.md；docs/current-state.md；docs/tasks/current-task.md；docs/project-overview.md；docs/architecture.md；docs/database-design.md。后三份只新增历史/新目标提示，不改旧实现事实。

设计与证据：

- docs/current-analysis.md
- docs/product-plan-v4.md
- docs/architecture-v2.md
- docs/database-design-v2.md
- docs/data-flow-v2.md
- docs/adr/ADR-ICE-001-identity-snapshot-boundary.md
- docs/reports/2026-10-13-ice-v4-validation.md

运行Demo与测试：

- src/app/demo/ice-v4/page.tsx
- src/features/ice-demo/types.ts
- src/features/ice-demo/fixtures.ts
- src/features/ice-demo/model.ts
- src/features/ice-demo/demo-app.tsx
- src/features/ice-demo/widgets.tsx
- src/features/ice-demo/inventory-views.tsx
- src/features/ice-demo/operations-views.tsx
- src/features/ice-demo/product-detail.tsx
- src/features/ice-demo/demo.module.css
- src/features/ice-demo/model.test.ts
- src/features/ice-demo/isolation.test.ts

## 架构与数据库变化

依照架构合同保留Next模块化单体、Product→Variant、人工货号、Repository/Action/Zod和Supabase/Auth/RLS。新增独立mock路由、供应商无关DTO/纯计算和局部CSS，不改现役认证/Proxy/Dashboard，不加依赖。

数据库仅设计：商品标识、版本映射、不可变批次快照、稳定运单及绑定修订、receipt_evidence、成本/估值、统一日志、三角色行/金额权限。新增SQL Migration=0，执行Migration=0，真实数据库写入=0。旧00001–00052和RPC保留，已识别的旧库存写路径须后续新Migration收口。

## Demo访问和Git

在仓库运行 npm run dev 后打开 [Demo](http://localhost:3000/demo/ice-v4)。如用本次端口：npm run dev -- --hostname 127.0.0.1 --port 3104，访问 [3104 Demo](http://127.0.0.1:3104/demo/ice-v4)。模拟操作只在浏览器会话内生效；刷新/重置恢复。验收临时服务在交接时停止，重新查看需启动上述命令。

分支codex/ice-v4-planning；提交标题feat: ICE inventory architecture v4 planning。最终commit和push结果以Git和聊天交接为准，不在文档里引用自身hash。没有创建PR、合并master或主动部署；推送分支不等于CI/Preview/Production通过。

## 保留与残余风险

- 用户既有未提交内网部署报告不暂存；开始及验收后SHA256均为9B42A3F9486BD0C377BE77C051FF947AAED6B17BC567925F1C09344171A6DB2C。
- 真实Admin/Operator/未来Manager及金额RLS未做本次运行验收；设计和Demo不提供这些证据。
- 未接真实BigSeller/聚水潭/飞书/喜运达，不验证生产库存/成本/账号；未运行数据库、并发或live测试。
- 公司货号对照、码制、源字段/授权、成本、收货证据、保留策略和正式三角色权限仍需下一任务审批。
- AGENTS按架构技能要求增量同步；现有角色协作约定保留，未读取/修改CLAUDE专属文件。
