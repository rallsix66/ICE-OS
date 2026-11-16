/** 「操作记录」只读 DTO（服务端 042 只读函数 → 页面）。 */

export type OperationCategory = 'catalog' | 'inventory' | 'shipment';

export type OperationCategoryFilter = OperationCategory | 'all';

/** 一条已保存的人工业务处理记录（字段都由历史行直接读出，不做当前值反推）。 */
export interface OperationRecordDto {
  id: string;
  at: string;
  category: OperationCategory;
  /** 动作代码；中文文案由 model.ts 统一映射。 */
  action: string;
  actorId: string | null;
  /** 记录账号显示名；解析不到时页面显示「未记录账号」。 */
  actorName: string | null;
  objectKind: string;
  objectTitle: string;
  objectRef: string | null;
  itemId: string | null;
  ticketId: string | null;
  batchId: string | null;
  iceCode: string | null;
  externalSku: string | null;
  ticketNo: string | null;
  market: string | null;
  /** 各动作的已保存依据（批次结果、对应版本、前后值、票面信息等）。 */
  detail: Record<string, unknown>;
}

export interface OperationActorDto {
  actorId: string | null;
  name: string;
  count: number;
}

export interface OperationRecordsPageDto {
  total: number;
  offset: number;
  limit: number;
  rows: OperationRecordDto[];
  actors: OperationActorDto[];
  categoryCounts: Partial<Record<OperationCategory, number>>;
  readAt: string;
}
