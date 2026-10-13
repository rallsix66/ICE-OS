# ICE v4 反馈迭代验收（2026-10-13）

## 范围与参考

基于509dae97，在codex/ice-v4-planning继续用户授权的Demo实施。只参考用户ice_inventory_demo_v4.html的页面结构：库存概览、商品资料表、市场货票表、来源/权限设置；不执行或导入附件脚本/数据。浏览器file协议受限，参考通过只读源码分析，未尝试绕过。

## 完成内容

- 首页：国内实物12520、海外实物6336、海外可售6110、飞书剩余在途550（各商品基础销售单元），全六商品库存表及详情入口。数字由同一fixture推导，不合并三阶段为总库存。无有效快照/未确认归属显示未知，不用0冒充。
- ICE商品库：原摘要卡片只是详情入口，改为商品资料表；货号、69编码、中英文名、规格单位分类、映射数量、单位成本同屏。来源映射复核独立分区，现有日志UI不重做。
- 物流：五市场集中列表，全部/在途/7天内到货/待绑定/已到货分类与关键词求交；按预计到仓排序。商品、剩余量、飞书状态/备注、最新API节点及估值同屏，详情弹窗关闭保留筛选，教学场景默认折叠。
- 虚构货票由3票扩为7票；泰国3票含部分到货和完成历史，另覆盖PH/MY/VN/ID。相应估值断言更新为11020（含明确成本缺口），没有放宽断言。
- 数据同步：四源卡片、最近有效仓批次、模拟启停/频率/检查结果。检查不发布新快照、不改库存/成功采集时间，不输入凭据、无定时任务或外部网络调用。
- 权限设置：可配置演示角色的市场和金额；管理员可关闭自身映射操作，保留配置入口。负责人/运营不能确认映射或修改设置。配置实际影响所有演示记录与按钮；空市场不回退到全量。全部fixture公开，不是后端授权/RLS。

## 本地验证

- node node_modules/vitest/vitest.mjs run src/features/ice-demo --reporter=dot：107/107，3 files；新增26项反馈回归。
- npm run lint -- --max-warnings 0：exit0，0 errors / 0 warnings。
- npm run build：exit0，Next内置TypeScript通过，/demo/ice-v4静态生成；保留现有sync NFT trace warning。
- 默认非数据库/非live测试：4119/4120，104 files中103通过/1失败。唯一失败仍为opt6-production-apply.test.ts:43的既有00051换行逐字匹配契约；原测试、SQL和Migration未改。
- 默认测试命令：node node_modules/vitest/vitest.mjs run --exclude '**/concurrency.test.ts' --exclude '**/*.postgres.test.ts' --exclude '**/*.live.test.ts' --reporter=dot。
- 上轮直接全仓tsc的旧测试类型问题未在本轮修复/重跑；不据Next构建通过宣称全仓独立tsc全绿。

## 浏览器证据

使用最终构建的独立本机3104端口，进程覆盖loopback/占位Supabase变量、禁用同步写入。检测到用户已有3000开发服务，没有终止或改配置。

- 八个导航入口可访问，商品资料表6行，映射复核独立切换。
- 泰国筛选=3票，跨市场记录=0；在途筛选=2票。部分到货详情显示发60/到20/余40，来源库存720不被增加；Escape关闭后仍在泰国筛选。
- 飞书运输中与API已签收同时显示，仍有100在途、海外快照240；签收没有推进业务状态或库存。
- BigSeller演示频率保存为每天，模拟失败显示原数据保留，ID有效批次仍为BS-DEMO-ID-1010-01。
- 运营改为仅PH并允许金额，切换后只见PH一票、无TH市场按钮，金额可显示；来源配置按钮禁用。
- 清空运营市场后，首页和物流为空，不开放全部；重置恢复。
- 关闭管理员映射操作后，确认/重核按钮消失；权限设置入口仍可用。
- 390×844检查物流/权限页面，scrollWidth=clientWidth，无页面级横向溢出，表格/导航局部横滚。恢复默认视口。
- 最终浏览器reload后的新console error/warn为0。保留源码隔离测试，不声称做了完整网络抓包或真实三角色权限验证。

## 文件与保护边界

变更限定在src/features/ice-demo及README、docs/current-state.md、docs/tasks/current-task.md、docs/product-plan-v4.md、docs/README.md和本报告。新增settings-model.ts、settings-views.tsx、logistics-view.tsx、feedback.test.ts；原有商品、映射、快照模型按本次UI需要小幅扩展。

不修改现役Dashboard、Proxy、供应商SDK、依赖、数据库、Migration或生产配置。用户未提交的内网部署报告保留且不暂存，SHA256仍为9B42A3F9486BD0C377BE77C051FF947AAED6B17BC567925F1C09344171A6DB2C。

本轮只提交并推送独立分支，不合并master、不主动部署、不创建PR。临时3104验收服务交接时停止；原有3000开发服务不动。Demo路径仍为/demo/ice-v4。实际commit/push以最终Git交接为准。
已有3000预览经HTTP检查返回200，包含数据同步、权限设置和库存概览；浏览器最终已加载该新版页面。
