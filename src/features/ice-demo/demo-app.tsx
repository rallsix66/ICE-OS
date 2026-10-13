'use client';

import { useMemo, useState } from 'react';
import { LayoutDashboard, Boxes, Package, Ship, Layers, History, RotateCcw, ChevronRight, Sparkles, RefreshCw, Users } from 'lucide-react';
import { createDemoData } from './fixtures';
import { canManageMappings, canViewAmounts, changeMapping, getScenarioData } from './model';
import { createDemoPermissions, createSourceConfigs, saveDemoAccess, scopeDemoData, updateSourceConfig } from './settings-model';
import type { DemoAccess, DemoFilters, DemoRole, DemoSourceConfig, DemoView, Market, ScenarioId } from './types';
import { OverviewView, InventoryView, ProductsView } from './inventory-views';
import { SnapshotsView, LogsView } from './operations-views';
import { MarketLogisticsView } from './logistics-view';
import { DataSyncView, PermissionSettingsView } from './settings-views';
import { EmptyState } from './widgets';
import { ProductDetail } from './product-detail';
import styles from './demo.module.css';

const NAV = [
  { id: 'overview', label: '经营总览', icon: LayoutDashboard, caption: '资源与经营信号' },
  { id: 'inventory', label: '商品库存', icon: Boxes, caption: '国内与海外库存' },
  { id: 'products', label: 'ICE 商品库', icon: Package, caption: '商品身份与映射' },
  { id: 'logistics', label: '物流详情', icon: Ship, caption: '货票与独立轨迹' },
  { id: 'snapshots', label: '库存快照', icon: Layers, caption: '来源与批次证据' },
  { id: 'sync', label: '数据同步', icon: RefreshCw, caption: '来源健康与读取设置' },
  { id: 'logs', label: '操作日志', icon: History, caption: '每一次变化有据可查' },
  { id: 'permissions', label: '权限设置', icon: Users, caption: '市场、金额与操作配置' },
] as const;

const EMPTY_FILTERS: DemoFilters = { query: '', market: 'all', exception: 'all' };

export function IceDemoApp() {
  const [baseData, setBaseData] = useState(createDemoData);
  const [view, setView] = useState<DemoView>('overview');
  const [scenario, setScenario] = useState<ScenarioId>('shipping');
  const [role, setRole] = useState<DemoRole>('admin');
  const [filters, setFilters] = useState<DemoFilters>(EMPTY_FILTERS);
  const [selectedProduct, setSelectedProduct] = useState<string | null>(null);
  const [notice, setNotice] = useState('');
  const [permissions, setPermissions] = useState(createDemoPermissions);
  const [sourceConfigs, setSourceConfigs] = useState(createSourceConfigs);
  const access = permissions[role];
  const data = useMemo(() => scopeDemoData(getScenarioData(baseData, scenario), role, access), [baseData, scenario, role, access]);
  const active = NAV.find((item) => item.id === view)!;
  const showAmounts = canViewAmounts(role, access);
  const mappingAllowed = canManageMappings(role, access);

  function browseInventory(market: Market | 'all' = 'all', exception: DemoFilters['exception'] = 'all') {
    setFilters({ query: '', market, exception });
    setView('inventory');
  }

  function updateMapping(id: string, action: 'confirm' | 'review') {
    const result = changeMapping(baseData, id, action, role, access);
    if (result.error) { setNotice(result.error); return; }
    setBaseData(result.data);
    setNotice('本地映射已更新，并已追加演示日志。旧版本暂停当前归集，历史不改写；此演示不发布映射新快照。');
  }

  function resetDemo() {
    setBaseData(createDemoData()); setScenario('shipping'); setFilters(EMPTY_FILTERS); setSelectedProduct(null); setView('overview'); setRole('admin');
    setPermissions(createDemoPermissions()); setSourceConfigs(createSourceConfigs());
    setNotice('已恢复全部虚构初始数据；没有连接或修改业务系统。');
  }

  function savePermissions(target: DemoRole, next: DemoAccess) {
    const result = saveDemoAccess(permissions, target, next, role);
    if (result.error) { setNotice(result.error); return; }
    setPermissions(result.permissions);
    setNotice('演示权限已保存。切换对应视角后，市场范围、金额和映射按钮立即生效；没有修改真实权限。');
  }

  function saveSource(next: DemoSourceConfig) {
    const result = updateSourceConfig(sourceConfigs, next, role);
    if (result.error) { setNotice(result.error); return; }
    setSourceConfigs(result.configs);
    setNotice('已更新本地来源演示。库存、业务状态、快照和成功采集时间均未改变，也没有创建定时任务。');
  }

  return <div className={styles.app}>
    <aside className={styles.sidebar}>
      <div className={styles.brand}><span className={styles.brandMark}>i</span><span>ICE<small>INVENTORY & OPERATIONS</small></span></div>
      <div className={styles.workspaceLabel}><span className={styles.workspaceDot} />经营工作台 <span>v4</span></div>
      <nav aria-label="演示导航" className={styles.navigation}>{NAV.map((item) => <button type="button" key={item.id} className={view === item.id ? styles.navActive : ''} aria-current={view === item.id ? 'page' : undefined} onClick={() => { setView(item.id); setNotice(''); }}><item.icon size={19} strokeWidth={1.6} /><span>{item.label}</span>{view === item.id && <span className={styles.navDot} />}</button>)}</nav>
      <div className={styles.sidebarBottom}><div className={styles.sandboxIcon}><Sparkles size={17} /></div><strong>方案验证工作区</strong><p>所有商品、数量与账号均为虚构。刷新或重置后恢复。</p><span>不接入 · 不保存 · 不发布</span></div>
    </aside>
    <div className={styles.workspace}>
      <header className={styles.topbar}><div className={styles.breadcrumb}>工作台<ChevronRight size={13} /><strong>{active.label}</strong></div><div className={styles.topbarRight}><span className={styles.demoTag}><span />虚构数据 DEMO</span><label className={styles.roleControl}><span>演示视角</span><select aria-label="切换演示角色" value={role} onChange={(event) => { setRole(event.target.value as DemoRole); setFilters(EMPTY_FILTERS); setNotice('仅切换虚构数据的展示视角；不是登录、授权或真实权限验收。'); }}><option value="admin">管理员</option><option value="manager">负责人 · 只读</option><option value="operator">运营{permissions.operator.viewAmounts ? ' · 含金额' : ' · 无金额'}</option></select></label><button type="button" className={styles.iconButton} aria-label="重置全部演示数据" title="重置全部演示数据" onClick={resetDemo}><RotateCcw size={16} /></button><div className={styles.avatar} aria-hidden>ICE</div></div></header>
      <main className={styles.main}>
        <div className={styles.pageHeading}><div><p className={styles.eyebrow}>ICE / BUSINESS WORKSPACE</p><h1>{active.label}<span>{view === 'overview' ? '让每一份库存，都有清晰的去向。' : active.caption}</span></h1></div><div className={styles.asOf}>演示时钟<time dateTime="2026-10-13T16:00:00+08:00">2026.10.13 · 16:00 CST</time></div></div>
        {notice && <div className={styles.notice} role="status">{notice}<button type="button" aria-label="关闭提示" onClick={() => setNotice('')}>×</button></div>}
        {role !== 'admin' && view !== 'overview' && <div className={styles.roleNotice}>{showAmounts ? '当前演示视角显示获准市场与金额，映射操作只读。' : '当前演示视角只显示获准市场，金额隐藏、映射操作只读。'} 这不是服务端权限控制；全部数据仍为可公开的虚构样本。</div>}
        {view === 'overview' && (data.products.length === 0 ? <EmptyState text="当前演示成员未分配市场，暂无可见库存" /> : <OverviewView data={data} showAmounts={showAmounts} onBrowse={browseInventory} onNavigate={setView} onOpenProduct={setSelectedProduct} />)}
        {view === 'inventory' && <InventoryView data={data} showAmounts={showAmounts} filters={filters} onFilters={setFilters} onReset={() => setFilters(EMPTY_FILTERS)} onOpenProduct={setSelectedProduct} />}
        {view === 'products' && <ProductsView data={data} role={role} mappingAllowed={mappingAllowed} showAmounts={showAmounts} filters={filters} onFilters={setFilters} onReset={() => setFilters(EMPTY_FILTERS)} onOpenProduct={setSelectedProduct} onMapping={updateMapping} />}
        {view === 'logistics' && <MarketLogisticsView key={role} data={data} markets={access.markets} scenario={scenario} onScenario={setScenario} showAmounts={showAmounts} onOpenProduct={setSelectedProduct} />}
        {view === 'snapshots' && <SnapshotsView data={data} onOpenProduct={setSelectedProduct} />}
        {view === 'logs' && <LogsView data={data} />}
        {view === 'sync' && <DataSyncView data={data} configs={sourceConfigs} role={role} onSave={saveSource} onNavigate={setView} />}
        {view === 'permissions' && <PermissionSettingsView key={role} permissions={permissions} role={role} onSave={savePermissions} />}
        <footer className={styles.footer}><span>ICE v4 · 独立方案演示</span><span>虚构数据 / 无外部业务请求 / 无业务写入 / 金额为人民币估算</span></footer>
      </main>
    </div>
    {selectedProduct && <ProductDetail data={data} productId={selectedProduct} role={role} showAmounts={showAmounts} mappingAllowed={mappingAllowed} onClose={() => setSelectedProduct(null)} onMapping={updateMapping} />}
  </div>;
}
