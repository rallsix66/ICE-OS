import { useState } from 'react';
import { Database, RefreshCw, Settings2, ShieldCheck } from 'lucide-react';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { MARKETS } from './fixtures';
import { latestSnapshots } from './model';
import { ROLE_LABELS } from './settings-model';
import type { DemoAccess, DemoData, DemoPermissions, DemoRole, DemoSourceConfig, DemoSourceId, DemoView } from './types';
import { dateTime, marketName, Pill, SectionHeading, TextLink } from './widgets';
import styles from './demo.module.css';

const SOURCES: { id: DemoSourceId; name: string; purpose: string; description: string }[] = [
  { id: 'bigseller', name: 'BigSeller', purpose: '海外库存', description: '按仓采集完整快照，实物、可售与来源在途分开保存。' },
  { id: 'jushuitan', name: '聚水潭', purpose: '国内库存', description: '国内数量取来源快照，飞书发货不再额外扣减。' },
  { id: 'feishu', name: '飞书物流情况表', purpose: '货票与业务状态', description: '读取商品、数量、状态和人工备注，不直接改海外库存。' },
  { id: 'golucky', name: '喜运达', purpose: '物流轨迹', description: '按已知运单提供轨迹，账号不明或候选冲突时保留待绑定。' },
];

const CADENCES = { manual: '手动读取', hourly: '每小时（仅配置示意）', daily: '每天（仅配置示意）' } as const;

export function DataSyncView({ data, configs, role, onSave, onNavigate }: {
  data: DemoData; configs: DemoSourceConfig[]; role: DemoRole;
  onSave: (config: DemoSourceConfig) => void; onNavigate: (view: DemoView) => void;
}) {
  const [editing, setEditing] = useState<DemoSourceConfig | null>(null);
  const editable = role === 'admin';
  const rows = latestSnapshots(data);
  const batches = [...new Map(rows.map((row) => [`${row.source}:${row.market}:${row.batchId}`, row])).values()];
  return <>
    <div className={styles.infoBox}><ShieldCheck size={18} /><span><strong>本地演示设置</strong> · 不输入密钥、不连接来源、不启动定时任务。模拟检查不会更新库存、批次或最近成功采集时间。</span></div>
    <div className={styles.sourceGrid}>
      {SOURCES.map((source) => {
        const config = configs.find((entry) => entry.id === source.id)!;
        return <section className={styles.sourceCard} key={source.id}>
          <div className={styles.sourceCardTop}><Database size={20} /><Pill tone={config.enabled ? 'blue' : 'neutral'}>{config.enabled ? '演示读取已启用' : '演示读取已停用'}</Pill></div>
          <h2>{source.name}</h2><strong>{source.purpose}</strong><p>{source.description}</p>
          <dl className={styles.detailList}><div><dt>读取方式</dt><dd>{CADENCES[config.cadence]}</dd></div><div><dt>最近模拟检查</dt><dd>{config.lastCheck === 'none' ? '尚未检查' : config.lastCheck === 'passed' ? '模拟通过 · 未发布数据' : '模拟失败 · 原数据保留'}</dd></div></dl>
          <div className={styles.buttonRow}>
            <button type="button" className={styles.smallButton} disabled={!editable} onClick={() => setEditing({ ...config })} aria-label={`配置${source.name}`}><Settings2 size={14} />配置</button>
            <button type="button" className={styles.smallButton} disabled={!editable || !config.enabled} onClick={() => onSave({ ...config, lastCheck: 'passed' })} aria-label={`模拟检查${source.name}`}><RefreshCw size={14} />模拟检查</button>
            <button type="button" className={styles.smallButton} disabled={!editable || !config.enabled} onClick={() => onSave({ ...config, lastCheck: 'failed' })} aria-label={`模拟失败${source.name}`}>模拟失败</button>
          </div>
        </section>;
      })}
    </div>
    {!editable && <p className={styles.roleNotice}>当前演示角色可查看来源健康；配置与模拟检查由管理员操作。</p>}
    <section className={styles.panel}>
      <SectionHeading title="最近有效库存来源" action={<TextLink onClick={() => onNavigate('snapshots')}>查看快照</TextLink>} />
      <div className={styles.tableScroll}><table className={styles.table}><thead><tr><th>来源 / 仓库</th><th>市场</th><th>最近成功采集</th><th>有效批次</th><th>状态</th></tr></thead><tbody>
        {batches.map((row) => <tr key={`${row.source}:${row.market}:${row.batchId}`}><td>{row.source}<small className={styles.cellSub}>{row.warehouse}</small></td><td>{marketName(row.market)}</td><td>{dateTime(row.capturedAt)}</td><td className={styles.codeCell}>{row.batchId}</td><td><Pill tone={row.freshness === 'stale' ? 'amber' : 'green'}>{row.freshness === 'stale' ? '旧值保留 · 待恢复' : '完整快照'}</Pill></td></tr>)}
      </tbody></table>{batches.length === 0 && <p className={styles.empty}>当前市场范围暂无有效库存快照。</p>}</div>
      <p className={styles.tableFootnote}>来源设置和业务事实分开：开启或检查通过，都不代表已经读取新数据。失败不会清零旧库存。</p>
    </section>
    <div className={styles.buttonRow}><TextLink onClick={() => onNavigate('logistics')}>查看货票与待绑定运单</TextLink><TextLink onClick={() => onNavigate('snapshots')}>核对原始库存批次</TextLink></div>
    <Dialog open={editing !== null} onOpenChange={(open) => { if (!open) setEditing(null); }}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-xl">
        <DialogHeader><DialogTitle>来源读取设置 · {SOURCES.find((source) => source.id === editing?.id)?.name}</DialogTitle><DialogDescription>仅保存本次浏览器会话的演示配置；不创建后台任务、不录入真实凭证。</DialogDescription></DialogHeader>
        {editing && <div className={styles.settingsForm}>
          <label className={styles.checkLabel}><input type="checkbox" checked={editing.enabled} onChange={(event) => setEditing({ ...editing, enabled: event.target.checked })} />启用演示读取</label>
          <label className={styles.fieldLabel}>读取频率<select aria-label="来源读取频率" value={editing.cadence} onChange={(event) => setEditing({ ...editing, cadence: event.target.value as DemoSourceConfig['cadence'] })}>{Object.entries(CADENCES).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
          <p>真实来源授权与任务调度在后续接入阶段处理。此处不会尝试登录 BigSeller、飞书或其他账号。</p>
          <button type="button" className={styles.smallPrimary} onClick={() => { onSave(editing); setEditing(null); }}>保存演示来源配置</button>
        </div>}
      </DialogContent>
    </Dialog>
  </>;
}

export function PermissionSettingsView({ permissions, role, onSave }: {
  permissions: DemoPermissions; role: DemoRole; onSave: (target: DemoRole, access: DemoAccess) => void;
}) {
  const [target, setTarget] = useState<DemoRole>('operator');
  const [draft, setDraft] = useState<DemoAccess>(() => ({ ...permissions.operator, markets: [...permissions.operator.markets] }));
  const [saved, setSaved] = useState(false);
  const members: DemoRole[] = role === 'admin' ? ['admin', 'manager', 'operator'] : [role];
  function chooseTarget(value: DemoRole) {
    setTarget(value); setDraft({ ...permissions[value], markets: [...permissions[value].markets] }); setSaved(false);
  }
  return <>
    <div className={styles.infoBox}><ShieldCheck size={18} /><span><strong>权限仅作交互演示</strong> · 市场、金额和操作配置会影响上方“演示视角”的页面展示，但所有fixture仍在浏览器中，不构成真实授权或RLS。</span></div>
    <section className={styles.panel}>
      <SectionHeading title="演示成员权限" action={<Pill tone="blue">同一套数据，不同查看范围</Pill>} />
      <div className={styles.tableScroll}><table className={styles.table}><thead><tr><th>成员 / 角色</th><th>可见市场</th><th>金额</th><th>商品映射操作</th><th>来源 / 权限配置</th></tr></thead><tbody>
        {members.map((member) => <tr key={member}><td>{ROLE_LABELS[member]}<small className={styles.cellSub}>虚构演示成员</small></td><td>{permissions[member].markets.map(marketName).join('、') || '未分配市场'}</td><td>{permissions[member].viewAmounts ? '可见' : '隐藏'}</td><td>{member === 'admin' && permissions[member].manageMappings ? '可确认 / 重核' : '只读'}</td><td>{member === 'admin' ? '可配置' : '只读'}</td></tr>)}
      </tbody></table></div>
    </section>
    {role !== 'admin' ? <div className={styles.roleNotice}>仅管理员可修改权限。可在上方切换管理员演示视角；当前仅显示自己的配置。</div> : <section className={styles.panel}>
      <SectionHeading title="调整演示成员" action={<select aria-label="待配置演示成员" className={styles.settingsSelect} value={target} onChange={(event) => chooseTarget(event.target.value as DemoRole)}>{members.map((member) => <option key={member} value={member}>{ROLE_LABELS[member]}</option>)}</select>} />
      <div className={styles.settingsForm}>
        <fieldset><legend>可见市场</legend><div className={styles.checkboxGrid}>{MARKETS.map((market) => <label key={market.id} className={styles.checkLabel}><input type="checkbox" checked={draft.markets.includes(market.id)} disabled={target === 'admin'} onChange={(event) => { setDraft({ ...draft, markets: event.target.checked ? [...draft.markets, market.id] : draft.markets.filter((entry) => entry !== market.id) }); setSaved(false); }} />{market.name}</label>)}</div></fieldset>
        <fieldset><legend>金额与操作</legend><div className={styles.checkboxGrid}>
          <label className={styles.checkLabel}><input type="checkbox" checked={draft.viewAmounts} onChange={(event) => { setDraft({ ...draft, viewAmounts: event.target.checked }); setSaved(false); }} />查看估算货值与单位成本</label>
          <label className={styles.checkLabel}><input type="checkbox" checked={draft.manageMappings} disabled={target !== 'admin'} onChange={(event) => { setDraft({ ...draft, manageMappings: event.target.checked }); setSaved(false); }} />确认 / 重新核对商品映射</label>
        </div></fieldset>
        <p>负责人和运营保持映射只读；管理员可以关闭自身的映射操作，但保留权限配置入口。未分配市场时显示空范围，不自动开放全部数据。</p>
        <div className={styles.buttonRow}><button type="button" className={styles.smallPrimary} onClick={() => { onSave(target, draft); setSaved(true); }}>保存演示权限</button><button type="button" className={styles.smallButton} onClick={() => chooseTarget(target)}>撤销未保存修改</button>{saved && <span role="status" className={styles.positiveText}>已保存，切换对应演示视角可验证</span>}</div>
      </div>
    </section>}
  </>;
}
