'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { CatalogSourceRecordDto, CatalogSourceViewDto } from '../source-view';
import { fetchCatalogSourceViewAction } from '../actions';
import type { CatalogItemDto } from '../types';
import styles from './catalog-evidence.module.css';

export type EvidenceValuationState =
  | { status: 'loaded'; sha256: string | null }
  | { status: 'not_imported' }
  | { status: 'read_failed'; message: string }
  | { status: 'historical' };

export type ItemEvidencePanelProps = {
  /** 当前查看的商品；历史版本时 item.revision 即该版本号。 */
  item: CatalogItemDto;
  historical: boolean;
  /** 兼容既有调用方；业务来源视图不再显示估值口径指纹。 */
  valuation?: EvidenceValuationState;
  onBack?: () => void;
  title?: string;
  /** 从库存明细进入时，标出当前查看仓库的来源记录，便于定位；不补填缺失仓库。 */
  focusWarehouse?: string;
  /** 兼容既有调用方；历史视图永远不自动读取当前来源。 */
  historicalAutoRead?: boolean;
};

type LoadState = 'loading' | 'ready' | 'error' | 'forbidden';
type LoadTarget = 'historical' | 'current';

function statusTone(confirmation: CatalogSourceRecordDto['confirmation']): string {
  if (confirmation === 'confirmed') return styles.badge;
  if (confirmation === 'pending') return `${styles.badge} ${styles.badgeWarn}`;
  return styles.badge;
}

function SourceRecordItem({ systemKey, record, index, currentWarehouse }: {
  systemKey: string;
  record: CatalogSourceRecordDto;
  index: number;
  currentWarehouse: boolean;
}) {
  return (
    <li
      className={styles.artifactItem}
      data-testid={`source-record-${systemKey}-${encodeURIComponent(record.sourceSku ?? String(index))}-${encodeURIComponent(record.sourceWarehouse ?? 'no-warehouse')}`}
      data-adopted={record.adoptedInBatch ? 'true' : 'false'}
      data-current-warehouse={currentWarehouse ? 'true' : 'false'}
    >
      <div className={styles.artifactHead}>
        <strong>{record.sourceName ?? '未提供名称'}</strong>
        <span>
          {currentWarehouse && <span className={styles.badge} data-testid="source-record-current-warehouse">当前仓</span>}
          {' '}
          <span className={statusTone(record.confirmation)}>{record.confirmationLabel}</span>
        </span>
      </div>
      <p className={styles.auditMeta}>
        来源编码 <strong>{record.sourceSku ?? '未提供'}</strong>
        {' · '}来源仓库 <strong>{record.sourceWarehouse ?? '未提供'}</strong>
      </p>
      {/* V6-02：早期筛查提示只作为未采用记录的核对背景，默认收起；已采用记录不再把
          “尚未建立对应”等旧筛查结论当作当前事实。DTO 仍保留 reviewNotes，后台记录不删除。 */}
      {!record.adoptedInBatch && record.reviewNotes.length > 0 && (
        <details className={styles.details} data-testid="source-review-notes">
          <summary>原核对提示（早期筛查，供参考）</summary>
          <ul className={styles.stack}>
            {record.reviewNotes.map((note) => <li key={note}>{note}</li>)}
          </ul>
        </details>
      )}
      {record.differences.length > 0 && (
        <ul className={styles.stack}>
          {record.differences.map((difference) => (
            <li key={`${difference.fieldLabel}-${difference.source}`}>
              {difference.fieldLabel}：当前采用 {difference.adopted}；来源 {difference.source}
            </li>
          ))}
        </ul>
      )}
      {record.sourcePriceRows.length > 0 && (
        <p className={styles.auditMeta} data-testid="source-price-provenance">
          该条来源价格：{record.sourcePriceRows.map((row) => `${row.label} ${row.value}`).join(' · ')}
          {' '}（口径未确认，不计入当前采用进货价或估值）
        </p>
      )}
    </li>
  );
}

/**
 * “数据来源”业务视图（V4-02 / V5-01 / V5-03）。
 *
 * 只展示人能直接理解的业务内容：来源系统、来源商品编码/名称、该条记录自己的仓库、
 * 本批是否采用、真实状态、已有核对提示与价格出处。原始 JSON、UUID、内部键名、SHA、
 * 技术下载入口不进入这里。
 *
 * 历史版本默认只显示该版本保存的事实；用户显式“查看当前资料来源”后，才读取并标注当前参照。
 */
export function ItemEvidencePanel(props: ItemEvidencePanelProps) {
  const key = `${props.item.itemId}:${props.item.revision}:${props.historical ? 'history' : 'current'}`;
  return <SourceView key={key} {...props} />;
}

function SourceView({ item, historical, onBack, title = '数据来源', focusWarehouse }: ItemEvidencePanelProps) {
  const [state, setState] = useState<LoadState>('loading');
  const [view, setView] = useState<CatalogSourceViewDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [currentReference, setCurrentReference] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const seqRef = useRef(0);
  const aliveRef = useRef(true);

  useEffect(() => () => { aliveRef.current = false; }, []);

  const load = useCallback(async (target: LoadTarget) => {
    const seq = ++seqRef.current;
    setState('loading');
    setError(null);
    try {
      const revision = target === 'historical' ? item.revision : 0;
      /* V6-01：来源读取不再经过共享结果缓存。每次打开/重试都重新走服务端鉴权，
         避免资料保存后、迟到响应或不同账户/金额权限之间复用旧结果。 */
      const result = await fetchCatalogSourceViewAction(item.itemId, revision);
      if (!aliveRef.current || seq !== seqRef.current) return;
      if (!result.success || !result.data) {
        setView(null);
        if (result.errorKind === 'forbidden') {
          setError('当前账号无权限查看来源记录；这不等于来源记录为 0。');
          setState('forbidden');
        } else {
          setError('来源记录读取失败，可重试；这不等于来源记录为 0。');
          setState('error');
        }
        return;
      }
      setView(result.data);
      setState('ready');
    } catch {
      if (!aliveRef.current || seq !== seqRef.current) return;
      setView(null);
      setError('来源记录读取失败（网络或传输异常），可重试。');
      setState('error');
    }
  }, [item.itemId, item.revision]);

  useEffect(() => {
    let cancelled = false;
    /* 异步边界后再发起读取：避免在 effect 内同步 setState 造成级联渲染。 */
    Promise.resolve().then(() => {
      if (!cancelled) void load(historical && !currentReference ? 'historical' : 'current');
    });
    return () => { cancelled = true; };
  }, [load, historical, currentReference, item.revision, attempt]);

  const showCurrentReference = () => { setCurrentReference(true); };
  const showHistoricalFacts = () => { setCurrentReference(false); };

  const historySubject = `历史版本 r${item.revision}（只读）`;
  const currentSubjectRevision = view && !view.historical ? view.item.revision : null;
  const subject = currentReference
    ? `当前资料${currentSubjectRevision !== null ? ` r${currentSubjectRevision}` : ''}（来源参照）`
    : historical
      ? historySubject
      : `当前资料 r${item.revision}`;
  const recordCount = view?.systems.reduce((sum, system) => sum + system.records.length, 0) ?? 0;
  const adoptedCount = view?.systems.reduce((sum, system) => sum + system.records.filter((record) => record.adoptedInBatch).length, 0) ?? 0;
  const hasOwnSourcePrices = Boolean(view?.systems.some((system) => system.records.some((record) => record.sourcePriceRows.length > 0)));
  const summaryState = state === 'loading' ? 'loading' : state === 'forbidden' ? 'forbidden' : state === 'error' ? 'error' : recordCount === 0 ? 'empty' : 'loaded';
  const showCurrentContent = !historical || currentReference;
  const priceValue = (value: string | null) => {
    if (view?.price.state === 'no_permission') return '无权限查看';
    if (view?.price.state === 'read_failed') return '读取失败，可重试';
    return value ?? '未记录';
  };

  return (
    <section
      className={styles.view}
      data-testid="catalog-evidence-view"
      data-evidence-state={state === 'ready' ? 'ready' : state}
      data-evidence-mode={currentReference ? 'current-reference' : historical ? 'historical' : 'current'}
      data-evidence-layout={onBack ? 'dialog' : 'page'}
      aria-label="数据来源"
    >
      <div className={styles.viewFixed}>
        <div className={styles.viewHead}>
          <div className={styles.viewHeading}>
            <h2 className={styles.viewTitle} data-testid="catalog-evidence-title">{title}</h2>
            <p className={styles.viewSubject} data-testid="catalog-evidence-subject">
              {item.iceCode ?? '待补货号'} · {item.nameCn} · {subject}
            </p>
          </div>
          {onBack && (
            <button type="button" className={styles.backButton} data-testid="catalog-evidence-back" onClick={onBack}>
              ← 返回商品资料
            </button>
          )}
        </div>

        {historical && !currentReference && (
          <p className={styles.noticeStrong} role="note" data-testid="catalog-evidence-historical-note">
            当前只显示资料版本 <strong>{item.revision}</strong> 保存的事实；历史版本没有保存的来源对应显示为未记录，不会自动读取当前来源。
          </p>
        )}
        {historical && currentReference && (
          <div className={styles.notice} role="note" data-testid="catalog-evidence-current-reference">
            <p>
              以下为<strong>当前资料</strong>的来源参照，不是资料版本 {item.revision} 的事实。
            </p>
            <button type="button" className={styles.actionButton} onClick={showHistoricalFacts}>
              返回该历史版本保存的事实
            </button>
          </div>
        )}
        {focusWarehouse && showCurrentContent && (
          <p className={styles.notice} role="note" data-testid="catalog-evidence-focus-warehouse">
            当前库存查看仓库：<strong>{focusWarehouse}</strong>；下方带“当前仓”标记的来源记录属于该仓。
          </p>
        )}
        {historical && !currentReference && state === 'ready' && (
          <div className={styles.actions}>
            <button type="button" className={styles.actionButton} data-testid="catalog-evidence-current-open" onClick={showCurrentReference}>
              查看当前资料来源（不是该历史版本）
            </button>
          </div>
        )}
        <p className={styles.auditMeta}>
          <span data-testid="evidence-audit-state" data-audit-state={summaryState}>
            {state === 'loading' ? '数据来源读取中…' : state === 'forbidden' ? '无权限查看' : state === 'error' ? '读取失败，可重试' : recordCount === 0 ? '未记录来源对应' : '数据来源已读取'}
          </span>
          {' · '}来源记录{' '}
          {/* V6-04：只有成功读取到空集合才显示 0；读取中/失败/无权限一律用“—”，不把未知写成 0。 */}
          <strong data-testid="evidence-candidate-count" className={styles.countBadge}>{state === 'ready' ? recordCount : '—'}</strong>
          {state === 'ready' ? ' 条' : ''}
          {state === 'ready' && recordCount > 0 ? `（本批已采用 ${adoptedCount} 条）` : ''}
        </p>
        {state === 'loading' && <p className={styles.status} role="status">正在读取数据来源…</p>}
        {state === 'forbidden' && (
          <div className={styles.error} role="alert" data-testid="catalog-evidence-forbidden">
            <p>{error}</p>
          </div>
        )}
        {state === 'error' && (
          <div className={styles.error} role="alert">
            <p>{error}</p>
            <button type="button" className={styles.actionButton} onClick={() => setAttempt((n) => n + 1)}>重试读取</button>
          </div>
        )}
      </div>

      <div className={styles.viewScroll}>
        {state === 'ready' && view && (
          <div className={styles.stack}>
            {view.sourceNote && (
              <p className={styles.notice} data-testid="catalog-source-note">{view.sourceNote}</p>
            )}
            {view.historicalFacts && !currentReference && (
              <section className={styles.section} aria-label="该历史版本保存的资料事实" data-testid="catalog-source-historical-facts">
                <div className={styles.sectionHead}>
                  <div>
                    <h3 className={styles.sectionTitle}>该版本保存的资料</h3>
                    <p className={styles.sectionNote}>历史来源只显示该版本确实保存的事实，不读取当前来源。</p>
                  </div>
                  <span className={`${styles.badge} ${styles.badgeWarn}`}>历史只读</span>
                </div>
                <div className={styles.body}>
                  <dl className={styles.facts}>
                    <div><dt>修改说明</dt><dd>{view.historicalFacts.reasonLabel}</dd></div>
                    <div><dt>记录时间</dt><dd>{view.historicalFacts.recordedAtDisplay}</dd></div>
                    <div><dt>操作者</dt><dd>{view.historicalFacts.actorLabel ?? '未记录可核实姓名'}</dd></div>
                    {view.historicalFacts.changedFields.map((change) => (
                      <div key={change.key}><dt>{change.label}</dt><dd>{change.before || '（空）'} → {change.after || '（空）'}</dd></div>
                    ))}
                  </dl>
                </div>
              </section>
            )}

            {showCurrentContent && view.systems.some((system) => system.records.length > 0) && (
              <section className={styles.section} aria-label="来源对应" data-testid="catalog-source-records">
                <div className={styles.sectionHead}>
                  <div>
                    <h3 className={styles.sectionTitle}>来源对应</h3>
                    <p className={styles.sectionNote}>
                      先列本批已采用的对应；未采用记录保留真实状态。库存是否计入见各来源系统说明。
                    </p>
                  </div>
                </div>
                <div className={styles.body}>
                  {view.systems.map((system) => {
                    const adopted = system.records.filter((record) => record.adoptedInBatch);
                    const unadopted = system.records.filter((record) => !record.adoptedInBatch);
                    if (system.records.length === 0) {
                      return (
                        <div key={system.key} className={styles.foldBody} data-testid={`source-system-${system.key}`}>
                          <h4 className={styles.sectionTitle}>{system.label}</h4>
                          <p className={styles.muted}>该来源暂无记录。</p>
                        </div>
                      );
                    }
                    return (
                      <div key={system.key} className={styles.foldBody} data-testid={`source-system-${system.key}`}>
                        <h4 className={styles.sectionTitle}>{system.label}</h4>
                        {system.records.length > 0 && (
                          <p className={styles.sectionNote} data-testid={`source-system-note-${system.key}`}>
                            {system.inventoryNote}
                          </p>
                        )}
                        {adopted.length > 0 && (
                          <div data-testid="source-adopted-group">
                            <p className={styles.sectionNote}>本批已采用 · {adopted.length} 条</p>
                            <ul className={styles.artifactList}>
                              {adopted.map((record, index) => (
                                <SourceRecordItem key={`adopted-${system.key}-${index}`} systemKey={system.key} record={record} index={index} currentWarehouse={Boolean(focusWarehouse && record.sourceWarehouse === focusWarehouse)} />
                              ))}
                            </ul>
                          </div>
                        )}
                        {unadopted.length > 0 && (
                          <div data-testid="source-unadopted-group">
                            <p className={styles.sectionNote}>未采用 · {unadopted.length} 条（未计入本批库存）</p>
                            <ul className={styles.artifactList}>
                              {unadopted.map((record, index) => (
                                <SourceRecordItem key={`unadopted-${system.key}-${index}`} systemKey={system.key} record={record} index={adopted.length + index} currentWarehouse={Boolean(focusWarehouse && record.sourceWarehouse === focusWarehouse)} />
                              ))}
                            </ul>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </section>
            )}

            {showCurrentContent && view.differences.length > 0 && (
              <section className={styles.section} aria-label="资料差异" data-testid="catalog-source-differences">
                <div className={styles.sectionHead}>
                  <div>
                    <h3 className={styles.sectionTitle}>已保存的资料字段差异</h3>
                    <p className={styles.sectionNote}>来自已有飞书字段参照；没有生成差异不等于已核对一致。</p>
                  </div>
                </div>
                <div className={styles.body}>
                  <dl className={styles.facts}>
                    {view.differences.map((difference, index) => (
                      <div key={`${difference.fieldLabel}-${index}`}>
                        <dt>{difference.fieldLabel}</dt>
                        <dd>当前采用 {difference.adopted}；来源 {difference.source}</dd>
                      </div>
                    ))}
                  </dl>
                </div>
              </section>
            )}

            {showCurrentContent && (
              <section className={styles.section} aria-label="价格来源" data-testid="catalog-source-price">
                <div className={styles.sectionHead}>
                  <div>
                    <h3 className={styles.sectionTitle}>价格</h3>
                    <p className={styles.sectionNote}>{view.price.note}</p>
                  </div>
                </div>
                <div className={styles.body} data-testid="evidence-amounts" data-price-state={view.price.state}>
                  <dl className={styles.facts}>
                    <div><dt>当前采用进货价</dt><dd>{priceValue(view.price.adoptedCost)}</dd></div>
                    <div><dt>当前采用运营价</dt><dd>{priceValue(view.price.adoptedOperatingPrice)}</dd></div>
                  </dl>
                  {!hasOwnSourcePrices && view.price.state === 'available' && (
                    <p className={styles.muted} data-testid="catalog-source-price-note">
                      逐条来源价格暂未展示；这里只显示当前采用价，不回填到来源记录。
                    </p>
                  )}
                  {view.price.state === 'read_failed' && (
                    <button type="button" className={styles.actionButton} onClick={() => setAttempt((n) => n + 1)}>重试读取</button>
                  )}
                </div>
              </section>
            )}

            {showCurrentContent && !view.sourceRecorded && (
              <p className={styles.muted} data-testid="catalog-candidates-empty">
                当前资料没有记录到来源对应；这不是读取失败，也不当作已确认。
              </p>
            )}
          </div>
        )}
      </div>
    </section>
  );
}
