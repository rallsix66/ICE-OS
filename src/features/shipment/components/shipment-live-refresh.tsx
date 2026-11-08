'use client';

import { useEffect, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { pollShipmentLiveStamp } from '../server/actions';

/** 只读探测间隔：后台每 10 分钟读取一次，页面 20 秒探测一次「是否已有新结果」。 */
const POLL_MS = 20_000;
/** 刷新未完成时的安全窗口，避免同一轮结果反复刷新。 */
const REFRESH_GUARD_MS = 15_000;

/**
 * 已打开页面的自动更新（第七轮）：
 * - 定时只读探测系统已保存的「最近成功快照 / 自动读取时间」；
 * - 发现后台已保存新结果时调用 router.refresh()，用同一条 URL 重新取服务端渲染的
 *   读取时间、货票列表、市场汇总与当前详情；URL 不变，因此市场筛选、筛选条件、
 *   打开的采购单都保留；关联编辑器是客户端局部状态，刷新不会清掉尚未保存的选择；
 * - **不触发**飞书读取、不写任何数据；探测失败只忽略本轮，不影响阅读。
 */
export function ShipmentLiveRefresh({ stamp }: { stamp: string }) {
  const router = useRouter();
  const stampRef = useRef(stamp);
  const refreshingRef = useRef(false);
  const guardRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // 服务端渲染完成后，用最新 props 更新「已看到的结果」；同时在途页新数据已到位。
  useEffect(() => {
    stampRef.current = stamp;
    refreshingRef.current = false;
    if (guardRef.current) {
      clearTimeout(guardRef.current);
      guardRef.current = null;
    }
  }, [stamp]);

  useEffect(() => {
    let cancelled = false;
    let inFlight = false;
    const tick = async () => {
      if (cancelled || inFlight || refreshingRef.current) return;
      inFlight = true;
      try {
        const next = await pollShipmentLiveStamp();
        if (cancelled || refreshingRef.current) return;
        if (next !== stampRef.current) {
          // 不预先改写 stampRef：服务端渲染成功后由 props 更新；若刷新失败，下一轮还会重试。
          refreshingRef.current = true;
          router.refresh();
          if (guardRef.current) clearTimeout(guardRef.current);
          guardRef.current = setTimeout(() => {
            guardRef.current = null;
            refreshingRef.current = false;
          }, REFRESH_GUARD_MS);
        }
      } catch {
        // 只读探测失败不打断阅读；后台读取结果仍在，下一轮再试。
      } finally {
        inFlight = false;
      }
    };
    const timer = setInterval(() => { void tick(); }, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
      if (guardRef.current) {
        clearTimeout(guardRef.current);
        guardRef.current = null;
      }
    };
  }, [router]);

  return null;
}
