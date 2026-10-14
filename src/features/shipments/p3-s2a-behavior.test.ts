// P3-S2A: 内部手动在途只读页面 — 行为测试
//
// 覆盖：
// - shipmentFiltersSchema / shipmentDetailParamsSchema Zod 校验（纯函数）
// - listShipments / getShipmentDetail Server Action（拦截 repo）
// - shipmentRepository.list() / getById() 真实调用（mock createClient + warehouseAccessRepository）

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  shipmentFiltersSchema,
  shipmentDetailParamsSchema,
} from '@/features/shipments/schema';

// ─── valid UUIDs ──────────────────────────────────────────────────────────

const SHIPMENT_ID = '00000000-0000-4000-8000-000000000010';
const WAREHOUSE_A = '00000000-0000-4000-8000-000000000020';
const USER_ID = '00000000-0000-4000-8000-000000000030';

// ─── Mock builders ────────────────────────────────────────────────────────

function createQueryMock(result: {
  data?: unknown;
  error?: unknown;
  count?: number;
}) {
  const self: Record<string, unknown> = {
    then(resolve: (v: unknown) => void) {
      resolve(result);
      return Promise.resolve(result);
    },
  };
  for (const method of [
    'select', 'eq', 'ilike', 'order', 'notIn', 'in', 'limit',
    'single', 'maybeSingle', 'neq', 'range', 'update',
  ]) {
    self[method] = vi.fn(() => self);
  }
  return { builder: self };
}

/** Push mock results onto the from() queue in order.
 *  Each call to mockFrom() returns the next builder. */
function pushResults(
  ...results: Array<{ data?: unknown; error?: unknown; count?: number }>
) {
  const blds = results.map((r) => createQueryMock(r));
  let cursor = 0;
  mockFrom.mockImplementation(() => {
    if (cursor >= blds.length)
      throw new Error(`Unexpected from() call — queue exhausted at index ${cursor}`);
    return blds[cursor++].builder;
  });
  return {
    getBuilder: (index: number) => blds[index],
    getBuilders: () => blds,
  };
}

// ─── Hoisted mocks ────────────────────────────────────────────────────────

const {
  mockRequireActiveAuth,
  mockFrom,
  mockRpc,
  mockGetAccessibleIds,
  mockCanAccess,
  _mockRepoList,
  _mockRepoGetById,
  _mockRepoUpdate,
  _mockRepoChangeStatus,
} = vi.hoisted(() => ({
  mockRequireActiveAuth: vi.fn(),
  mockFrom: vi.fn(),
  mockRpc: vi.fn(),
  mockGetAccessibleIds: vi.fn(),
  mockCanAccess: vi.fn(),
  _mockRepoList: vi.fn(),
  _mockRepoGetById: vi.fn(),
  _mockRepoUpdate: vi.fn(),
  _mockRepoChangeStatus: vi.fn(),
}));

vi.mock('@/lib/database/runtime', () => ({
  isIndependentPlatformRuntime: () => false,
}));

vi.mock('@/lib/auth', () => ({
  requireActiveAuth: () => mockRequireActiveAuth(),
}));

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(() => Promise.resolve({ from: mockFrom, rpc: mockRpc })),
}));

vi.mock('next/cache', () => ({
  revalidatePath: vi.fn(),
}));

vi.mock('@/features/warehouse-access/repository', () => ({
  warehouseAccessRepository: {
    getAccessibleWarehouseIds: (...args: unknown[]) =>
      mockGetAccessibleIds(...args),
    canAccessWarehouse: (...args: unknown[]) => mockCanAccess(...args),
  },
}));

// Partial mock: when _mockRepoList / _mockRepoGetById have an implementation
// set (via mockResolvedValue / mockRejectedValue), the call is intercepted.
// Otherwise, calls pass through to the real repository (which uses the mocked
// createClient above).  Sections 3–4 set up intercepts; sections 5–6 rely on
// mockReset() → getMockImplementation() === undefined → passthrough.
vi.mock('@/features/shipments/repository', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@/features/shipments/repository')>();
  return {
    ...actual,
    shipmentRepository: {
      ...actual.shipmentRepository,
      list: (...args: Parameters<typeof actual.shipmentRepository.list>) => {
        const impl = _mockRepoList.getMockImplementation();
        return impl
          ? _mockRepoList(...args)
          : actual.shipmentRepository.list(...args);
      },
      getById: (...args: Parameters<typeof actual.shipmentRepository.getById>) => {
        const impl = _mockRepoGetById.getMockImplementation();
        return impl
          ? _mockRepoGetById(...args)
          : actual.shipmentRepository.getById(...args);
      },
      update: (...args: Parameters<typeof actual.shipmentRepository.update>) => {
        const impl = _mockRepoUpdate.getMockImplementation();
        return impl
          ? _mockRepoUpdate(...args)
          : actual.shipmentRepository.update(...args);
      },
      changeStatus: (...args: Parameters<typeof actual.shipmentRepository.changeStatus>) => {
        const impl = _mockRepoChangeStatus.getMockImplementation();
        return impl
          ? _mockRepoChangeStatus(...args)
          : actual.shipmentRepository.changeStatus(...args);
      },
    },
  };
});

// ─── Helper: admin / operator user objects ────────────────────────────────

const ADMIN_USER = {
  id: USER_ID,
  roleName: 'admin' as const,
  isActive: true as const,
  email: 'admin@test.com',
  displayName: 'Admin',
};

// ─── 1. shipmentFiltersSchema (Zod) ──────────────────────────────────────

describe('P3-S2A — shipmentFiltersSchema (Zod)', () => {
  it('空对象通过（全部默认值）', () => {
    const r = shipmentFiltersSchema.safeParse({});
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.page).toBe(1);
      expect(r.data.pageSize).toBe(20);
    }
  });

  it.each(['TH', 'ID', 'MY', 'PH', 'VN', 'CN'])(
    '合法 country=%s 通过',
    (c) => {
      const r = shipmentFiltersSchema.safeParse({ country: c });
      expect(r.success).toBe(true);
    },
  );

  it('非法 country 拒绝', () => {
    const r = shipmentFiltersSchema.safeParse({ country: 'XX' });
    expect(r.success).toBe(false);
  });

  it.each(['booking', 'loading', 'departed', 'arrived', 'customs'])(
    '合法 status=%s 通过',
    (s) => {
      const r = shipmentFiltersSchema.safeParse({ status: s });
      expect(r.success).toBe(true);
    },
  );

  it('非法 status 拒绝', () => {
    const r = shipmentFiltersSchema.safeParse({ status: 'invalid' });
    expect(r.success).toBe(false);
  });

  it('warehoused status 不在筛选白名单中，拒绝', () => {
    const r = shipmentFiltersSchema.safeParse({ status: 'warehoused' });
    expect(r.success).toBe(false);
  });

  it('page / pageSize 字符串自动 coerce 为 number', () => {
    const r = shipmentFiltersSchema.safeParse({ page: '3', pageSize: '50' });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.page).toBe(3);
      expect(r.data.pageSize).toBe(50);
    }
  });

  it('page 负数 coerce 后拒绝', () => {
    const r = shipmentFiltersSchema.safeParse({ page: '-1' });
    expect(r.success).toBe(false);
  });

  it('pageSize 超 max(100) 拒绝', () => {
    const r = shipmentFiltersSchema.safeParse({ pageSize: '200' });
    expect(r.success).toBe(false);
  });
});

// ─── 2. shipmentDetailParamsSchema (Zod) ─────────────────────────────────

describe('P3-S2A — shipmentDetailParamsSchema (Zod)', () => {
  it('合法 UUID 通过', () => {
    const r = shipmentDetailParamsSchema.safeParse({ id: SHIPMENT_ID });
    expect(r.success).toBe(true);
  });

  it('非法 UUID 拒绝', () => {
    const r = shipmentDetailParamsSchema.safeParse({ id: 'not-a-uuid' });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.issues[0]?.message).toContain('无效');
    }
  });

  it('空字符串拒绝', () => {
    const r = shipmentDetailParamsSchema.safeParse({ id: '' });
    expect(r.success).toBe(false);
  });

  it('缺少 id 拒绝', () => {
    const r = shipmentDetailParamsSchema.safeParse({});
    expect(r.success).toBe(false);
  });
});

// ─── 3. listShipments Server Action (repo intercepted) ───────────────────

describe('P3-S2A — listShipments Server Action', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _mockRepoList.mockReset();
    _mockRepoGetById.mockReset();
  });

  it('未登录用户返回失败', async () => {
    mockRequireActiveAuth.mockRejectedValue(new Error('未登录'));
    const { listShipments } = await import('@/features/shipments/actions');
    const r = await listShipments({});
    expect(r.success).toBe(false);
    expect(r.error).toContain('失败');
  });

  it('无效 country 参数返回 Zod 校验失败', async () => {
    mockRequireActiveAuth.mockResolvedValue(ADMIN_USER);
    const { listShipments } = await import('@/features/shipments/actions');
    const r = await listShipments({ country: 'XX' as never });
    expect(r.success).toBe(false);
    expect(r.error).toBeTruthy();
  });

  it('Admin 正常请求返回分页数据', async () => {
    mockRequireActiveAuth.mockResolvedValue(ADMIN_USER);
    _mockRepoList.mockResolvedValue({
      data: [],
      total: 0,
      page: 1,
      pageSize: 20,
    });
    const { listShipments } = await import('@/features/shipments/actions');
    const r = await listShipments({});
    expect(r.success).toBe(true);
    expect(r.data).toEqual({ data: [], total: 0, page: 1, pageSize: 20 });
    expect(_mockRepoList).toHaveBeenCalledWith(
      expect.objectContaining({ page: 1, pageSize: 20 }),
      USER_ID,
    );
  });

  it('DB error 传播为中文 ActionResult', async () => {
    mockRequireActiveAuth.mockResolvedValue(ADMIN_USER);
    const { ShipmentError } = await import(
      '@/features/shipments/repository'
    );
    _mockRepoList.mockRejectedValue(
      new ShipmentError('查询在途列表失败', 'DB_ERROR'),
    );
    const { listShipments } = await import('@/features/shipments/actions');
    const r = await listShipments({});
    expect(r.success).toBe(false);
    expect(r.error).toContain('查询在途列表失败');
  });

  it('未知异常返回通用中文错误', async () => {
    mockRequireActiveAuth.mockResolvedValue(ADMIN_USER);
    _mockRepoList.mockRejectedValue(new Error('network error'));
    const { listShipments } = await import('@/features/shipments/actions');
    const r = await listShipments({});
    expect(r.success).toBe(false);
    expect(r.error).toContain('失败');
  });

  it('page=0 / pageSize=200 被 Zod min/max 拒绝', async () => {
    mockRequireActiveAuth.mockResolvedValue(ADMIN_USER);
    const { listShipments } = await import('@/features/shipments/actions');
    const r = await listShipments({ page: 0, pageSize: 200 });
    expect(r.success).toBe(false);
  });
});

// ─── 4. getShipmentDetail Server Action (repo intercepted) ───────────────

describe('P3-S2A — getShipmentDetail Server Action', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _mockRepoList.mockReset();
    _mockRepoGetById.mockReset();
  });

  it('未登录用户返回失败', async () => {
    mockRequireActiveAuth.mockRejectedValue(new Error('未登录'));
    const { getShipmentDetail } = await import(
      '@/features/shipments/actions'
    );
    const r = await getShipmentDetail(SHIPMENT_ID);
    expect(r.success).toBe(false);
    expect(r.error).toContain('失败');
  });

  it('无效 UUID 返回 Zod 校验失败', async () => {
    mockRequireActiveAuth.mockResolvedValue(ADMIN_USER);
    const { getShipmentDetail } = await import(
      '@/features/shipments/actions'
    );
    const r = await getShipmentDetail('not-a-uuid');
    expect(r.success).toBe(false);
    expect(r.error).toContain('无效');
  });

  it('记录不存在返回 not-found 中文错误', async () => {
    mockRequireActiveAuth.mockResolvedValue(ADMIN_USER);
    _mockRepoGetById.mockResolvedValue(null);
    const { getShipmentDetail } = await import(
      '@/features/shipments/actions'
    );
    const r = await getShipmentDetail(SHIPMENT_ID);
    expect(r.success).toBe(false);
    expect(r.error).toContain('不存在或无权访问');
  });

  it('Admin 正常请求返回详情', async () => {
    mockRequireActiveAuth.mockResolvedValue(ADMIN_USER);
    const detail = {
      id: SHIPMENT_ID,
      items: [],
      events: [],
      creatorName: null,
      warehouseName: null,
    };
    _mockRepoGetById.mockResolvedValue(detail);
    const { getShipmentDetail } = await import(
      '@/features/shipments/actions'
    );
    const r = await getShipmentDetail(SHIPMENT_ID);
    expect(r.success).toBe(true);
    expect(r.data).toBe(detail);
    expect(_mockRepoGetById).toHaveBeenCalledWith(SHIPMENT_ID, USER_ID);
  });

  it('DB error 传播为中文 ActionResult', async () => {
    mockRequireActiveAuth.mockResolvedValue(ADMIN_USER);
    const { ShipmentError } = await import(
      '@/features/shipments/repository'
    );
    _mockRepoGetById.mockRejectedValue(
      new ShipmentError('查询在途详情失败', 'DB_ERROR'),
    );
    const { getShipmentDetail } = await import(
      '@/features/shipments/actions'
    );
    const r = await getShipmentDetail(SHIPMENT_ID);
    expect(r.success).toBe(false);
    expect(r.error).toContain('查询在途详情失败');
  });

  it('未知异常返回通用中文错误', async () => {
    mockRequireActiveAuth.mockResolvedValue(ADMIN_USER);
    _mockRepoGetById.mockRejectedValue(new Error('boom'));
    const { getShipmentDetail } = await import(
      '@/features/shipments/actions'
    );
    const r = await getShipmentDetail(SHIPMENT_ID);
    expect(r.success).toBe(false);
    expect(r.error).toContain('失败');
  });
});

// ─── 5. shipmentRepository.list() — 真实调用，mock createClient ──────────

describe('P3-S2A — shipmentRepository.list() 仓库隔离（真实 repo）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset repo mocks → getMockImplementation() === undefined → passthrough
    _mockRepoList.mockReset();
    _mockRepoGetById.mockReset();
    mockGetAccessibleIds.mockReset();
  });

  const MOCK_ROW = {
    id: SHIPMENT_ID,
    vessel_name: 'TEST VESSEL',
    voyage_number: 'V001',
    country: 'TH',
    warehouse_id: WAREHOUSE_A,
    status: 'booking',
    estimated_arrival: '2026-07-15T00:00:00Z',
    created_by: USER_ID,
    created_at: '2026-06-01T00:00:00Z',
    warehouse: { name: 'Warehouse A' },
    items: [{ quantity: 100, warehoused_quantity: 30 }],
  };

  it('Operator 有已分配仓库 → 返回该仓库在途数据', async () => {
    // from() order: 1) profiles (getUserRole), 2) shipment query
    mockGetAccessibleIds.mockResolvedValue(new Set([WAREHOUSE_A]));
    pushResults(
      { data: { role: { name: 'operator' } } },
      { data: [MOCK_ROW], count: 1 },
    );

    const { shipmentRepository } = await import(
      '@/features/shipments/repository'
    );
    const result = await shipmentRepository.list({}, USER_ID);

    expect(result.total).toBe(1);
    expect(result.data).toHaveLength(1);
    expect(result.data[0].warehouseName).toBe('Warehouse A');
  });

  it('Operator 无分配仓库 → 直接返回空列表（提前返回不 await shipment）', async () => {
    mockGetAccessibleIds.mockResolvedValue(new Set<string>());
    pushResults({ data: { role: { name: 'operator' } } });

    const { shipmentRepository } = await import(
      '@/features/shipments/repository'
    );
    const result = await shipmentRepository.list({}, USER_ID);

    expect(result.data).toEqual([]);
    expect(result.total).toBe(0);
  });

  it('Admin → 无仓库过滤，返回所有数据', async () => {
    pushResults(
      { data: { role: { name: 'admin' } } },
      { data: [MOCK_ROW], count: 1 },
    );

    const { shipmentRepository } = await import(
      '@/features/shipments/repository'
    );
    const result = await shipmentRepository.list({}, USER_ID);

    expect(result.total).toBe(1);
    expect(result.data).toHaveLength(1);
  });

  it('list 查询 DB error → ShipmentError', async () => {
    pushResults(
      { data: { role: { name: 'admin' } } },
      { data: null, error: { message: 'connection refused' } },
    );

    const { shipmentRepository, ShipmentError } = await import(
      '@/features/shipments/repository'
    );

    // Single call with combined assertions — pushResults only has one round
    try {
      await shipmentRepository.list({}, USER_ID);
      expect.fail('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(ShipmentError);
      expect((e as Error).message).toBe('查询在途列表失败');
    }
  });

  it('getUserRole DB error → ShipmentError（不静默降级为 unknown）', async () => {
    pushResults({
      data: null,
      error: { code: 'CONNECTION_REFUSED', message: 'db down' },
    });

    const { shipmentRepository, ShipmentError } = await import(
      '@/features/shipments/repository'
    );

    try {
      await shipmentRepository.list({}, USER_ID);
      expect.fail('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(ShipmentError);
      expect((e as Error).message).toBe('查询用户角色失败');
    }
  });

  it('getUserRole profile not found (PGRST116) → unknown（安全回退）', async () => {
    mockGetAccessibleIds.mockResolvedValue(new Set([WAREHOUSE_A]));
    pushResults(
      {
        data: null,
        error: { code: 'PGRST116', message: 'No rows' },
      },
      { data: [MOCK_ROW], count: 1 },
    );

    const { shipmentRepository } = await import(
      '@/features/shipments/repository'
    );
    const result = await shipmentRepository.list({}, USER_ID);
    // role=unknown → no warehouse filter, data returned
    expect(result.data).toHaveLength(1);
  });
});

// ─── 6. shipmentRepository.getById() — 真实调用，mock createClient ───────
//
// from() call order inside getById(userId):
//   1) from('shipment')     — main query (awaited immediately)
//   2) from('profiles')     — getUserRole (if userId)
//   3) from('shipment_item') — Promise.all
//   4) from('tracking_event')— Promise.all
//   5) from('profiles')     — Promise.all (creator)
//   6) from('warehouse')    — if warehouse_id
// Steps 3–5 fire their from() calls synchronously (left-to-right in the array
// literal) before Promise.all itself resolves.
//
// WITHOUT userId, getUserRole is skipped but steps 1 + 3–6 still apply.

describe('P3-S2A — shipmentRepository.getById() 错误处理（真实 repo）', () => {
  const MOCK_SHIPMENT = {
    id: SHIPMENT_ID,
    vessel_name: 'TEST',
    voyage_number: null,
    origin_port: null,
    destination_port: null,
    country: 'TH',
    warehouse_id: WAREHOUSE_A,
    status: 'booking',
    estimated_arrival: null,
    note: null,
    created_by: USER_ID,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
  };

  beforeEach(() => {
    vi.clearAllMocks();
    _mockRepoList.mockReset();
    _mockRepoGetById.mockReset();
    mockGetAccessibleIds.mockReset();
    mockCanAccess.mockReset();
  });

  // ── main-query errors (no userId — steps 3-6 never reached) ──────────

  it('主查询 (shipment) not-found PGRST116 → null', async () => {
    pushResults(
      { data: null, error: { code: 'PGRST116', message: 'No rows' } },
    );

    const { shipmentRepository } = await import(
      '@/features/shipments/repository'
    );
    const result = await shipmentRepository.getById(SHIPMENT_ID);
    expect(result).toBeNull();
  });

  it('主查询 (shipment) DB error (非 PGRST116) → ShipmentError', async () => {
    pushResults(
      {
        data: null,
        error: { code: 'CONNECTION_REFUSED', message: 'db down' },
      },
    );

    const { shipmentRepository, ShipmentError } = await import(
      '@/features/shipments/repository'
    );

    try {
      await shipmentRepository.getById(SHIPMENT_ID);
      expect.fail('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(ShipmentError);
      expect((e as Error).message).toBe('查询在途详情失败');
    }
  });

  // ── sub-query errors (with userId) ────────────────────────────────────

  it('shipment_item 子查询 error → ShipmentError', async () => {
    // Promise.all evaluates ALL array elements synchronously:
    // from(shipment_item), from(tracking_event), from(profiles) ALL fire
    // before any of them resolve. So we need 5 results even though
    // items error causes Promise.all to reject.
    pushResults(
      { data: MOCK_SHIPMENT }, // 1) shipment OK
      { data: { role: { name: 'admin' } } }, // 2) getUserRole admin
      { data: null, error: { message: 'connection lost' } }, // 3) items ERROR
      { data: [] }, // 4) events (from() called but error path)
      { data: { display_name: 'X' } }, // 5) creator profile (from() called)
    );

    const { shipmentRepository, ShipmentError } = await import(
      '@/features/shipments/repository'
    );

    try {
      await shipmentRepository.getById(SHIPMENT_ID, USER_ID);
      expect.fail('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(ShipmentError);
      expect((e as Error).message).toBe('查询在途详情失败');
    }
  });

  it('tracking_event 子查询 error → ShipmentError', async () => {
    pushResults(
      { data: MOCK_SHIPMENT }, // 1) shipment OK
      { data: { role: { name: 'admin' } } }, // 2) getUserRole admin
      { data: [] }, // 3) items OK
      { data: null, error: { message: 'connection lost' } }, // 4) events ERROR
      { data: { display_name: 'X' } }, // 5) creator (from() called)
    );

    const { shipmentRepository, ShipmentError } = await import(
      '@/features/shipments/repository'
    );

    try {
      await shipmentRepository.getById(SHIPMENT_ID, USER_ID);
      expect.fail('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(ShipmentError);
      expect((e as Error).message).toBe('查询在途详情失败');
    }
  });

  it('warehouse 子查询 error → ShipmentError', async () => {
    // 1) shipment OK, 2) getUserRole admin, 3) items OK, 4) events OK,
    // 5) profiles creator OK, 6) warehouse ERROR
    pushResults(
      { data: MOCK_SHIPMENT },
      { data: { role: { name: 'admin' } } },
      { data: [] },
      { data: [] },
      { data: { display_name: 'Creator' } },
      { data: null, error: { message: 'connection lost' } },
    );

    const { shipmentRepository, ShipmentError } = await import(
      '@/features/shipments/repository'
    );

    try {
      await shipmentRepository.getById(SHIPMENT_ID, USER_ID);
      expect.fail('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(ShipmentError);
      expect((e as Error).message).toBe('查询在途详情失败');
    }
  });

  it('profiles (creator) 子查询 error → 容忍，creatorName=null', async () => {
    pushResults(
      { data: MOCK_SHIPMENT },
      { data: { role: { name: 'admin' } } },
      { data: [] },
      { data: [] },
      { data: null, error: { code: 'PGRST116', message: 'No rows' } },
      { data: { name: 'Warehouse A' } },
    );

    const { shipmentRepository } = await import(
      '@/features/shipments/repository'
    );
    const result = await shipmentRepository.getById(SHIPMENT_ID, USER_ID);

    expect(result).not.toBeNull();
    expect(result!.creatorName).toBeNull();
    expect(result!.warehouseName).toBe('Warehouse A');
  });

  // ── operator warehouse access ─────────────────────────────────────────

  it('Operator 无权访问该 warehouse → null', async () => {
    mockCanAccess.mockResolvedValue(false);
    pushResults(
      { data: MOCK_SHIPMENT },
      { data: { role: { name: 'operator' } } },
      // returns null before Promise.all
    );

    const { shipmentRepository } = await import(
      '@/features/shipments/repository'
    );
    const result = await shipmentRepository.getById(SHIPMENT_ID, USER_ID);

    expect(result).toBeNull();
  });

  it('Operator + shipment.warehouse_id=null → 直接返回 null（不查 canAccess）', async () => {
    const noWh = { ...MOCK_SHIPMENT, warehouse_id: null };
    pushResults(
      { data: noWh }, // 1) shipment OK (null warehouse_id)
      { data: { role: { name: 'operator' } } }, // 2) getUserRole → operator
      // null warehouse_id → return null, no Promise.all
    );

    const { shipmentRepository } = await import(
      '@/features/shipments/repository'
    );
    const result = await shipmentRepository.getById(SHIPMENT_ID, USER_ID);

    expect(result).toBeNull();
  });

  // ── happy path ────────────────────────────────────────────────────────

  it('Admin → 无 warehouse 访问检查，完整返回详情', async () => {
    pushResults(
      { data: MOCK_SHIPMENT },
      { data: { role: { name: 'admin' } } },
      { data: [] },
      { data: [] },
      { data: { display_name: 'Creator' } },
      { data: { name: 'Warehouse A' } },
    );

    const { shipmentRepository } = await import(
      '@/features/shipments/repository'
    );
    const result = await shipmentRepository.getById(SHIPMENT_ID, USER_ID);

    expect(result).not.toBeNull();
    expect(result!.warehouseName).toBe('Warehouse A');
    expect(result!.creatorName).toBe('Creator');
  });

  // ── getUserRole error inside getById ──────────────────────────────────

  it('getUserRole (inside getById) DB error → ShipmentError', async () => {
    pushResults(
      { data: MOCK_SHIPMENT },
      {
        data: null,
        error: { code: 'CONNECTION_REFUSED', message: 'db down' },
      },
    );

    const { shipmentRepository, ShipmentError } = await import(
      '@/features/shipments/repository'
    );

    try {
      await shipmentRepository.getById(SHIPMENT_ID, USER_ID);
      expect.fail('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(ShipmentError);
      expect((e as Error).message).toBe('查询用户角色失败');
    }
  });

  // ── null warehouse ────────────────────────────────────────────────────

  it('shipment without warehouse_id → 不查询 warehouse，warehouseName=null', async () => {
    const noWh = { ...MOCK_SHIPMENT, warehouse_id: null };
    // 1) shipment, 2) getUserRole admin, 3) items, 4) events, 5) creator
    // NO step 6 (no warehouse_id)
    pushResults(
      { data: noWh },
      { data: { role: { name: 'admin' } } },
      { data: [] },
      { data: [] },
      { data: { display_name: 'Creator' } },
    );

    const { shipmentRepository } = await import(
      '@/features/shipments/repository'
    );
    const result = await shipmentRepository.getById(SHIPMENT_ID, USER_ID);

    expect(result).not.toBeNull();
    expect(result!.warehouseName).toBeNull();
  });
});

// ─── 7. P3-S2B: updateShipmentSchema / changeStatusSchema (Zod) ──────────

describe('P3-S2B — updateShipmentSchema (Zod)', () => {
  const validUpdate = {
    id: SHIPMENT_ID,
    shipmentNo: 'SN-UPDATE-001',
    country: 'TH' as const,
  };

  it('最小有效数据通过', async () => {
    const { updateShipmentSchema } = await import('@/features/shipments/schema');
    const r = updateShipmentSchema.safeParse(validUpdate);
    expect(r.success).toBe(true);
  });

  it('缺少 id 拒绝', async () => {
    const { updateShipmentSchema } = await import('@/features/shipments/schema');
    const r = updateShipmentSchema.safeParse({ shipmentNo: 'SN-01', country: 'TH' });
    expect(r.success).toBe(false);
  });

  it('非法 id UUID 拒绝', async () => {
    const { updateShipmentSchema } = await import('@/features/shipments/schema');
    const r = updateShipmentSchema.safeParse({ ...validUpdate, id: 'bad-uuid' });
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues[0]?.message).toContain('无效');
  });

  it('缺少 shipmentNo 拒绝', async () => {
    const { updateShipmentSchema } = await import('@/features/shipments/schema');
    const r = updateShipmentSchema.safeParse({ id: SHIPMENT_ID, country: 'TH' });
    expect(r.success).toBe(false);
  });

  it('空 shipmentNo 拒绝', async () => {
    const { updateShipmentSchema } = await import('@/features/shipments/schema');
    const r = updateShipmentSchema.safeParse({ ...validUpdate, shipmentNo: '' });
    expect(r.success).toBe(false);
  });

  it('shipmentNo 含非法字符拒绝', async () => {
    const { updateShipmentSchema } = await import('@/features/shipments/schema');
    const r = updateShipmentSchema.safeParse({ ...validUpdate, shipmentNo: 'SN 001' });
    expect(r.success).toBe(false);
  });

  it('完整字段通过', async () => {
    const { updateShipmentSchema } = await import('@/features/shipments/schema');
    const r = updateShipmentSchema.safeParse({
      id: SHIPMENT_ID,
      shipmentNo: 'SN-FULL',
      vesselName: 'VESSEL',
      voyageNumber: 'V123',
      originPort: 'SHANGHAI',
      destinationPort: 'BANGKOK',
      country: 'TH',
      warehouseId: WAREHOUSE_A,
      estimatedArrival: '2026-12-31',
      note: 'test note',
    });
    expect(r.success).toBe(true);
  });

  it('非法 country 拒绝', async () => {
    const { updateShipmentSchema } = await import('@/features/shipments/schema');
    const r = updateShipmentSchema.safeParse({ ...validUpdate, country: 'XX' });
    expect(r.success).toBe(false);
  });
});

describe('P3-S2B — changeStatusSchema (Zod)', () => {
  it('合法状态通过', async () => {
    const { changeStatusSchema } = await import('@/features/shipments/schema');
    for (const s of ['booking', 'loading', 'departed', 'arrived', 'customs']) {
      const r = changeStatusSchema.safeParse({ shipmentId: SHIPMENT_ID, status: s });
      expect(r.success).toBe(true);
    }
  });

  it('warehoused 被 schema 拒绝', async () => {
    const { changeStatusSchema } = await import('@/features/shipments/schema');
    const r = changeStatusSchema.safeParse({ shipmentId: SHIPMENT_ID, status: 'warehoused' });
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues[0]?.message).toContain('无效的物流状态');
  });

  it('非法 status 拒绝', async () => {
    const { changeStatusSchema } = await import('@/features/shipments/schema');
    const r = changeStatusSchema.safeParse({ shipmentId: SHIPMENT_ID, status: 'invalid' });
    expect(r.success).toBe(false);
  });

  it('缺少 shipmentId 拒绝', async () => {
    const { changeStatusSchema } = await import('@/features/shipments/schema');
    const r = changeStatusSchema.safeParse({ status: 'booking' });
    expect(r.success).toBe(false);
  });

  it('非法 shipmentId UUID 拒绝', async () => {
    const { changeStatusSchema } = await import('@/features/shipments/schema');
    const r = changeStatusSchema.safeParse({ shipmentId: 'bad', status: 'loading' });
    expect(r.success).toBe(false);
  });

  it('带 description 通过', async () => {
    const { changeStatusSchema } = await import('@/features/shipments/schema');
    const r = changeStatusSchema.safeParse({
      shipmentId: SHIPMENT_ID,
      status: 'departed',
      description: '已从上海港出发',
    });
    expect(r.success).toBe(true);
  });

  it('description 超长拒绝', async () => {
    const { changeStatusSchema } = await import('@/features/shipments/schema');
    const r = changeStatusSchema.safeParse({
      shipmentId: SHIPMENT_ID,
      status: 'loading',
      description: 'x'.repeat(501),
    });
    expect(r.success).toBe(false);
  });
});

// ─── 8. P3-S2B: updateShipment / changeShipmentStatus Server Actions ────

describe('P3-S2B — updateShipment Server Action (repo intercepted)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _mockRepoList.mockReset();
    _mockRepoGetById.mockReset();
    _mockRepoUpdate.mockReset();
    _mockRepoChangeStatus.mockReset();
  });

  const VALID_UPDATE = {
    id: SHIPMENT_ID,
    shipmentNo: 'SN-EDIT-001',
    country: 'TH' as const,
  };

  it('未登录用户返回失败', async () => {
    mockRequireActiveAuth.mockRejectedValue(new Error('未登录'));
    const { updateShipment } = await import('@/features/shipments/actions');
    const r = await updateShipment(VALID_UPDATE);
    expect(r.success).toBe(false);
    expect(r.error).toContain('失败');
  });

  it('Zod 校验失败返回中文错误', async () => {
    mockRequireActiveAuth.mockResolvedValue(ADMIN_USER);
    const { updateShipment } = await import('@/features/shipments/actions');
    const r = await updateShipment({ ...VALID_UPDATE, country: 'XX' as never });
    expect(r.success).toBe(false);
    expect(r.error).toBeTruthy();
  });

  it('目标不存在（NOT_FOUND）返回错误', async () => {
    mockRequireActiveAuth.mockResolvedValue(ADMIN_USER);
    const { ShipmentError } = await import('@/features/shipments/repository');
    _mockRepoUpdate.mockRejectedValue(
      new ShipmentError('在途记录不存在或无权访问', 'NOT_FOUND'),
    );
    const { updateShipment } = await import('@/features/shipments/actions');
    const r = await updateShipment(VALID_UPDATE);
    expect(r.success).toBe(false);
    expect(r.error).toContain('不存在或无权访问');
  });

  it('DB_ERROR 传播为中文错误', async () => {
    mockRequireActiveAuth.mockResolvedValue(ADMIN_USER);
    const { ShipmentError } = await import('@/features/shipments/repository');
    _mockRepoUpdate.mockRejectedValue(
      new ShipmentError('更新在途记录失败', 'DB_ERROR'),
    );
    const { updateShipment } = await import('@/features/shipments/actions');
    const r = await updateShipment(VALID_UPDATE);
    expect(r.success).toBe(false);
    expect(r.error).toContain('更新在途记录失败');
  });

  it('Admin 正常更新成功', async () => {
    mockRequireActiveAuth.mockResolvedValue(ADMIN_USER);
    _mockRepoUpdate.mockResolvedValue(true);
    const { updateShipment } = await import('@/features/shipments/actions');
    const r = await updateShipment(VALID_UPDATE);
    expect(r.success).toBe(true);
    expect(_mockRepoUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ id: SHIPMENT_ID, shipmentNo: 'SN-EDIT-001' }),
      USER_ID,
    );
  });
});

describe('P3-S2B — changeShipmentStatus Server Action (repo intercepted)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _mockRepoList.mockReset();
    _mockRepoGetById.mockReset();
    _mockRepoUpdate.mockReset();
    _mockRepoChangeStatus.mockReset();
  });

  it('未登录用户返回失败', async () => {
    mockRequireActiveAuth.mockRejectedValue(new Error('未登录'));
    const { changeShipmentStatus } = await import('@/features/shipments/actions');
    const r = await changeShipmentStatus(SHIPMENT_ID, 'loading');
    expect(r.success).toBe(false);
    expect(r.error).toContain('失败');
  });

  it('warehoused 被 Schema 拒绝（不调用 repository）', async () => {
    mockRequireActiveAuth.mockResolvedValue(ADMIN_USER);
    const { changeShipmentStatus } = await import('@/features/shipments/actions');
    const r = await changeShipmentStatus(SHIPMENT_ID, 'warehoused' as never);
    expect(r.success).toBe(false);
    expect(r.error).toContain('无效的物流状态');
    expect(_mockRepoChangeStatus).not.toHaveBeenCalled();
  });

  it('非法 status 被 Zod 拒绝', async () => {
    mockRequireActiveAuth.mockResolvedValue(ADMIN_USER);
    const { changeShipmentStatus } = await import('@/features/shipments/actions');
    const r = await changeShipmentStatus(SHIPMENT_ID, 'invalid' as never);
    expect(r.success).toBe(false);
    expect(_mockRepoChangeStatus).not.toHaveBeenCalled();
  });

  it('RPC 失败（目标不存在/无权限）返回错误', async () => {
    mockRequireActiveAuth.mockResolvedValue(ADMIN_USER);
    const { ShipmentError } = await import('@/features/shipments/repository');
    _mockRepoChangeStatus.mockRejectedValue(
      new ShipmentError('在途记录不存在或无权访问', 'DB_ERROR'),
    );
    const { changeShipmentStatus } = await import('@/features/shipments/actions');
    const r = await changeShipmentStatus(SHIPMENT_ID, 'loading');
    expect(r.success).toBe(false);
    expect(r.error).toContain('不存在或无权访问');
  });

  it('tracking_event 插入失败（RPC 异常）返回错误', async () => {
    mockRequireActiveAuth.mockResolvedValue(ADMIN_USER);
    const { ShipmentError } = await import('@/features/shipments/repository');
    _mockRepoChangeStatus.mockRejectedValue(
      new ShipmentError('状态变更失败', 'DB_ERROR'),
    );
    const { changeShipmentStatus } = await import('@/features/shipments/actions');
    const r = await changeShipmentStatus(SHIPMENT_ID, 'departed');
    expect(r.success).toBe(false);
    expect(r.error).toBe('状态变更失败');
  });

  it('Admin 正常变更状态成功', async () => {
    mockRequireActiveAuth.mockResolvedValue(ADMIN_USER);
    _mockRepoChangeStatus.mockResolvedValue(true);
    const { changeShipmentStatus } = await import('@/features/shipments/actions');
    const r = await changeShipmentStatus(SHIPMENT_ID, 'arrived', '已到港');
    expect(r.success).toBe(true);
    expect(_mockRepoChangeStatus).toHaveBeenCalledWith(
      SHIPMENT_ID,
      'arrived',
      USER_ID,
      '已到港',
    );
  });

  it('未知异常返回通用中文错误', async () => {
    mockRequireActiveAuth.mockResolvedValue(ADMIN_USER);
    _mockRepoChangeStatus.mockRejectedValue(new Error('network down'));
    const { changeShipmentStatus } = await import('@/features/shipments/actions');
    const r = await changeShipmentStatus(SHIPMENT_ID, 'customs');
    expect(r.success).toBe(false);
    expect(r.error).toContain('失败');
  });
});

// ─── 9. P3-S2B: Repository update() / changeStatus() 行为测试 ───────────
//
// Extends mock client with rpc support (added to createClient mock above).

describe('P3-S2B — shipmentRepository.update() 行确认（真实 repo）', () => {
  const VALID_UPDATE_DATA = {
    id: SHIPMENT_ID,
    shipmentNo: 'SN-REPO-UPDATE',
    country: 'TH' as const,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    _mockRepoList.mockReset();
    _mockRepoGetById.mockReset();
    _mockRepoUpdate.mockReset();
    _mockRepoChangeStatus.mockReset();
    mockGetAccessibleIds.mockReset();
    mockCanAccess.mockReset();
  });

  it('update → PGRST116（0 行匹配）→ NOT_FOUND', async () => {
    // pushResults order for update(admin):
    // 1) getUserRole → profiles
    // 2) shipment.update().eq().select().single()
    pushResults(
      { data: { role: { name: 'admin' } } }, // getUserRole
      { data: null, error: { code: 'PGRST116', message: 'No rows' } }, // update PGRST116
    );

    const { shipmentRepository, ShipmentError } = await import(
      '@/features/shipments/repository'
    );

    try {
      await shipmentRepository.update(VALID_UPDATE_DATA, USER_ID);
      expect.fail('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(ShipmentError);
      expect((e as Error).message).toBe('在途记录不存在或无权访问');
    }
  });

  it('update → DB error (非 PGRST116) → DB_ERROR', async () => {
    pushResults(
      { data: { role: { name: 'admin' } } },
      { data: null, error: { code: 'CONNECTION_REFUSED', message: 'db down' } },
    );

    const { shipmentRepository, ShipmentError } = await import(
      '@/features/shipments/repository'
    );

    try {
      await shipmentRepository.update(VALID_UPDATE_DATA, USER_ID);
      expect.fail('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(ShipmentError);
      expect((e as Error).message).toBe('更新在途记录失败');
    }
  });
});

describe('P3-S2B — shipmentRepository.changeStatus() RPC 调用（真实 repo）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _mockRepoList.mockReset();
    _mockRepoGetById.mockReset();
    _mockRepoUpdate.mockReset();
    _mockRepoChangeStatus.mockReset();
    mockGetAccessibleIds.mockReset();
    mockCanAccess.mockReset();
    mockRpc.mockReset();
    // P3-S4A: changeStatus() now fetches current status via from('shipment').select('status')
    // before calling the RPC — mockFrom must return status data, not throw
  });

  it('changeStatus RPC 成功', async () => {
    // P3-S4A: first from() call fetches current status (booking → loading is valid)
    pushResults({ data: { status: 'booking' }, error: null });
    mockRpc.mockResolvedValue({ data: true, error: null });

    const { shipmentRepository } = await import('@/features/shipments/repository');
    const result = await shipmentRepository.changeStatus(
      SHIPMENT_ID,
      'loading',
      USER_ID,
      '装柜中',
    );

    expect(result).toBe(true);
    expect(mockRpc).toHaveBeenCalledWith('change_shipment_status_transactional', {
      p_shipment_id: SHIPMENT_ID,
      p_status: 'loading',
      p_description: '装柜中',
    });
  });

  it('changeStatus RPC 错误 → DB_ERROR', async () => {
    // P3-S4A: first from() call fetches current status (departed → arrived is valid)
    pushResults({ data: { status: 'departed' }, error: null });
    mockRpc.mockResolvedValue({
      data: null,
      error: { message: '在途记录不存在或无权访问', code: 'P0001' },
    });

    const { shipmentRepository, ShipmentError } = await import(
      '@/features/shipments/repository'
    );

    try {
      await shipmentRepository.changeStatus(SHIPMENT_ID, 'arrived', USER_ID);
      expect.fail('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(ShipmentError);
      expect((e as Error).message).toBe('在途记录不存在或无权访问');
    }
  });

  it('changeStatus 空 description 使用默认标签（装柜）', async () => {
    // P3-S4A: first from() call fetches current status (booking → loading is valid)
    pushResults({ data: { status: 'booking' }, error: null });
    mockRpc.mockResolvedValue({ data: true, error: null });

    const { shipmentRepository } = await import('@/features/shipments/repository');
    await shipmentRepository.changeStatus(SHIPMENT_ID, 'loading', USER_ID);

    expect(mockRpc).toHaveBeenCalledWith('change_shipment_status_transactional', {
      p_shipment_id: SHIPMENT_ID,
      p_status: 'loading',
      p_description: '装柜',
    });
  });

  it('P3-S4A: 倒退状态被仓库层拒绝', async () => {
    // current status = departed, trying to go back to loading
    pushResults({ data: { status: 'departed' }, error: null });
    // RPC should NOT be called — repository rejects before reaching it

    const { shipmentRepository, ShipmentError } = await import(
      '@/features/shipments/repository'
    );

    try {
      await shipmentRepository.changeStatus(SHIPMENT_ID, 'loading', USER_ID);
      expect.fail('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(ShipmentError);
      expect((e as Error).message).toMatch(/仅允许按顺序推进/);
    }
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it('P3-S4A: 跳步被仓库层拒绝', async () => {
    // current status = booking, trying to skip to departed
    pushResults({ data: { status: 'booking' }, error: null });
    // RPC should NOT be called

    const { shipmentRepository, ShipmentError } = await import(
      '@/features/shipments/repository'
    );

    try {
      await shipmentRepository.changeStatus(SHIPMENT_ID, 'departed', USER_ID);
      expect.fail('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(ShipmentError);
      expect((e as Error).message).toMatch(/仅允许按顺序推进/);
    }
    expect(mockRpc).not.toHaveBeenCalled();
  });
});

// ─── 10. P3-S4A REWORK: advanceStatus 统一走 RPC ─────────────────────────

describe('P3-S4A REWORK — advanceStatus 委托 changeStatus → RPC', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _mockRepoList.mockReset();
    _mockRepoGetById.mockReset();
    _mockRepoUpdate.mockReset();
    _mockRepoChangeStatus.mockReset();
    mockGetAccessibleIds.mockReset();
    mockCanAccess.mockReset();
    mockRpc.mockReset();
  });

  it('advanceStatus 成功路径调用 RPC', async () => {
    // changeStatus (called by advanceStatus) fetches current status first
    pushResults({ data: { status: 'booking' }, error: null });
    mockRpc.mockResolvedValue({ data: true, error: null });

    const { shipmentRepository } = await import('@/features/shipments/repository');
    const result = await shipmentRepository.advanceStatus(
      SHIPMENT_ID,
      'loading',
      USER_ID,
      '装柜中',
    );

    expect(result).toBe(true);
    expect(mockRpc).toHaveBeenCalledWith('change_shipment_status_transactional', {
      p_shipment_id: SHIPMENT_ID,
      p_status: 'loading',
      p_description: '装柜中',
    });
  });

  it('advanceStatus RPC 错误 → 抛出 ShipmentError 中文失败', async () => {
    pushResults({ data: { status: 'departed' }, error: null });
    mockRpc.mockResolvedValue({
      data: null,
      error: { message: '在途记录不存在或无权访问', code: 'P0001' },
    });

    const { shipmentRepository, ShipmentError } = await import(
      '@/features/shipments/repository'
    );

    try {
      await shipmentRepository.advanceStatus(SHIPMENT_ID, 'arrived', USER_ID);
      expect.fail('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(ShipmentError);
      expect((e as Error).message).toBe('在途记录不存在或无权访问');
    }
  });

  it('advanceStatus warehoused 拒绝（不调用 RPC，不读 status）', async () => {
    const { shipmentRepository, ShipmentError } = await import(
      '@/features/shipments/repository'
    );

    try {
      await shipmentRepository.advanceStatus(SHIPMENT_ID, 'warehoused', USER_ID);
      expect.fail('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(ShipmentError);
      expect((e as Error).message).toMatch(/不支持手动推进到入仓/);
    }
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it('advanceStatus 倒退被拒绝（不调用 RPC）', async () => {
    pushResults({ data: { status: 'departed' }, error: null });

    const { shipmentRepository, ShipmentError } = await import(
      '@/features/shipments/repository'
    );

    try {
      await shipmentRepository.advanceStatus(SHIPMENT_ID, 'loading', USER_ID);
      expect.fail('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(ShipmentError);
      expect((e as Error).message).toMatch(/仅允许按顺序推进/);
    }
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it('advanceStatus 跳步被拒绝（不调用 RPC）', async () => {
    pushResults({ data: { status: 'booking' }, error: null });

    const { shipmentRepository, ShipmentError } = await import(
      '@/features/shipments/repository'
    );

    try {
      await shipmentRepository.advanceStatus(SHIPMENT_ID, 'departed', USER_ID);
      expect.fail('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(ShipmentError);
      expect((e as Error).message).toMatch(/仅允许按顺序推进/);
    }
    expect(mockRpc).not.toHaveBeenCalled();
  });
});
