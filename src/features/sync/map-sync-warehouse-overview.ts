import type { SyncWarehouseOverviewItem } from './types';

export function mapSyncWarehouseOverviewRows(
  data: unknown,
): SyncWarehouseOverviewItem[] {
  const parsed = (typeof data === 'string' ? JSON.parse(data) : data) as Array<
    Record<string, unknown>
  >;
  if (!Array.isArray(parsed)) {
    return [];
  }

  return parsed.map((item) => ({
    warehouseId: item.warehouse_id as string,
    warehouseName: item.warehouse_name as string,
    country: item.country as string,
    latestDryRun: item.latest_dry_run
      ? {
          status: (item.latest_dry_run as Record<string, unknown>).status as string,
          time: (item.latest_dry_run as Record<string, unknown>).time as string | null,
          runId: (item.latest_dry_run as Record<string, unknown>).run_id as string,
        }
      : null,
    latestRealWrite: item.latest_real_write
      ? {
          status: (item.latest_real_write as Record<string, unknown>).status as string,
          time: (item.latest_real_write as Record<string, unknown>).time as string | null,
          runId: (item.latest_real_write as Record<string, unknown>).run_id as string,
        }
      : null,
    lastSuccessTime: item.last_success_time as string | null,
    lastFailureReason: item.last_failure_reason as string | null,
  }));
}
