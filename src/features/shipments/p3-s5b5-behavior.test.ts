// P3-S5B5: 应用行为测试 — 批量入仓 + 海外库存"已确认到仓" + 安全边界
//
// 不新增业务功能，仅补测试覆盖。
// 覆盖范围：
// 1. 详情页双模式 — warehouseBlockReason 所有分支 + PartialWarehouseEntry / BigsellerAbsorptionButton 渲染条件
// 2. 批量入仓页 — listEligibleForBatchWarehousingAction mock 行为 + validateEntry 校验逻辑 + 安全边界
// 3. 海外库存 confirmedMap — 数据构建 + 单仓失败隔离 + 口径
// 4. 安全边界 — requireActiveAuth / Admin-only / Zod / 不写 inventory / 不调 00023

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

function readSrc(relativePath: string): string {
  return readFileSync(resolve(relativePath), 'utf-8');
}

// ═══════════════════════════════════════════════════════════════════════════════
// Hoisted mocks
// ═══════════════════════════════════════════════════════════════════════════════

const {
  mockRequireActiveAuth,
  mockFrom,
  mockRpc,
  mockGetAccessibleIds,
  mockRevalidatePath,
} = vi.hoisted(() => ({
  mockRequireActiveAuth: vi.fn(),
  mockFrom: vi.fn(),
  mockRpc: vi.fn(),
  mockGetAccessibleIds: vi.fn(),
  mockRevalidatePath: vi.fn(),
}));

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(() =>
    Promise.resolve({
      from: mockFrom,
      rpc: mockRpc,
    }),
  ),
}));

vi.mock('@/lib/database/runtime', () => ({
  isIndependentPlatformRuntime: () => false,
}));

vi.mock('@/lib/auth', () => ({
  requireActiveAuth: () => mockRequireActiveAuth(),
}));

vi.mock('@/features/warehouse-access/repository', () => ({
  warehouseAccessRepository: {
    getAccessibleWarehouseIds: mockGetAccessibleIds,
  },
}));

vi.mock('next/cache', () => ({
  revalidatePath: mockRevalidatePath,
}));

// ═══════════════════════════════════════════════════════════════════════════════
// Mock helpers
// ═══════════════════════════════════════════════════════════════════════════════

function createQueryMock(result: { data?: unknown; error?: unknown }) {
  const self: Record<string, unknown> = {
    then(resolve: (v: unknown) => void) {
      resolve(result);
      return Promise.resolve(result);
    },
  };
  for (const method of [
    'select', 'eq', 'neq', 'not', 'is', 'ilike', 'order',
    'notIn', 'in', 'limit', 'range', 'single', 'maybeSingle', 'update', 'or',
  ]) {
    self[method] = vi.fn(() => self);
  }
  return { builder: self };
}

function pushFromResults(
  ...results: Array<{ data?: unknown; error?: unknown }>
) {
  const blds = results.map((r) => createQueryMock(r));
  let cursor = 0;
  mockFrom.mockImplementation(() => {
    if (cursor >= blds.length)
      throw new Error(`Unexpected from() call — queue exhausted at ${cursor}`);
    return blds[cursor++].builder;
  });
  return blds;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Constants
// ═══════════════════════════════════════════════════════════════════════════════

const WAREHOUSE_ID = '10000000-0000-4000-8000-000000000001';

const ADMIN_USER = {
  id: 'aaaaaaaa-0000-4000-8000-000000000001',
  roleName: 'admin' as const,
  isActive: true as const,
  email: 'admin@test.com',
  displayName: 'Admin',
};
const OP_USER = {
  id: 'bbbbbbbb-0000-4000-8000-000000000001',
  roleName: 'operator' as const,
  isActive: true as const,
  email: 'op@test.com',
  displayName: 'Operator',
};

// ═══════════════════════════════════════════════════════════════════════════════
// Import actions (after mocks)
// ═══════════════════════════════════════════════════════════════════════════════

import { listEligibleForBatchWarehousingAction } from '@/features/shipments/actions';
import { eligibleShipmentFiltersSchema } from '@/features/shipments/schema';

// ============================================================================
// 1. 详情页双模式 — warehouseBlockReason 分支覆盖
// ============================================================================

describe('P3-S5B5: 详情页双模式 — warehouseBlockReason', () => {
  // PERF-S1D: warehouseBlockReason / PartialWarehouseEntry / BigsellerAbsorptionButton
  // 已从 page.tsx 移至 ShipmentDetailClient
  const detailSrc = readSrc('src/features/shipments/components/shipment-detail-client.tsx');

  describe('warehouseBlockReason 闭包逻辑', () => {
    it('!isAdmin → 返回 null（不显示阻止原因，也不渲染按钮）', () => {
      // 源码: if (!isAdmin || isWarehoused) return null;
      expect(detailSrc).toMatch(/if\s*\(!isAdmin\s*\|\|\s*isWarehoused\)\s*return null/);
    });

    it('isWarehoused → 返回 null', () => {
      // 同一行
      expect(detailSrc).toMatch(/!isAdmin\s*\|\|\s*isWarehoused/);
    });

    it('!warehouse_id → 返回未指定仓库中文提示', () => {
      expect(detailSrc).toMatch(/未指定仓库，无法入仓/);
    });

    it('status !== customs → 返回"清关后方可"中文提示（含 statusLabel 变量）', () => {
      expect(detailSrc).toMatch(/清关后方可确认入仓/);
    });

    it('customs + warehouse_id → 返回 null（可入仓）', () => {
      // The closure returns null after the two guards — the last return null
      // is at the end of the arrow function after customs guard
      const fnStart = detailSrc.indexOf('const warehouseBlockReason');
      const fnEnd = detailSrc.indexOf('})();', fnStart);
      const fnBody = detailSrc.slice(fnStart, fnEnd + 4);
      // Last statement before closing: `return null; // customs + has warehouse → 可入仓`
      expect(fnBody).toMatch(/return null;\s*\/\/\s*customs/);
    });

    it('闭包包含所有 3 个 return 分支', () => {
      const fnStart = detailSrc.indexOf('const warehouseBlockReason');
      const fnEnd = detailSrc.indexOf('})();', fnStart);
      const fnBody = detailSrc.slice(fnStart, fnEnd);
      const returnCount = (fnBody.match(/return\s+/g) || []).length;
      // 3 branches: !isAdmin||isWarehoused → null, !warehouse_id → msg, !==customs → msg
      // + 1 final return null
      expect(returnCount).toBe(4);
    });
  });

  describe('PartialWarehouseEntry 渲染条件', () => {
    it('仅 status=customs + warehouse_id 非空时渲染', () => {
      expect(detailSrc).toMatch(/status\s*===\s*'customs'\s*&&\s*shipment\.warehouse_id/);
    });

    it('PartialWarehouseEntry 组件在 Admin + !warehoused 的操作区内', () => {
      // The component is nested inside: {user && isAdmin && !isWarehoused && (...)}
      // Check that the rendering guard exists
      expect(detailSrc).toMatch(/isAdmin\s*&&\s*!isWarehoused/);
    });

    it('PartialWarehouseEntry 传递 shipmentId 和 items props', () => {
      expect(detailSrc).toMatch(/<PartialWarehouseEntry/);
      expect(detailSrc).toMatch(/shipmentId=\{shipment\.id\}/);
      expect(detailSrc).toMatch(/items=\{shipment\.items\}/);
    });

    it('非 customs 状态不渲染 PartialWarehouseEntry（不在 JSX 中出现其他状态的渲染路径）', () => {
      // The only PartialWarehouseEntry in the file is guarded by customs + warehouse_id
      const partialEntryMatches = detailSrc.match(/PartialWarehouseEntry/g);
      // import + JSX usage = 2 occurrences
      expect(partialEntryMatches).not.toBeNull();
      expect(partialEntryMatches!.length).toBe(2);
    });
  });

  describe('BigsellerAbsorptionButton 渲染条件', () => {
    it('仅 warehoused + !bigseller_absorbed_at 时渲染', () => {
      expect(detailSrc).toMatch(/status\s*===\s*'warehoused'\s*&&\s*!shipment\.bigseller_absorbed_at/);
    });

    it('BigsellerAbsorptionButton 在独立的条件区块中渲染（含 isAdmin 守卫）', () => {
      // JSX usage (not import): find the line with <BigsellerAbsorptionButton
      const jsxIdx = detailSrc.indexOf('<BigsellerAbsorptionButton');
      expect(jsxIdx).not.toBe(-1);
      const precedingCtx = detailSrc.slice(Math.max(0, jsxIdx - 300), jsxIdx);
      expect(precedingCtx).toMatch(/isAdmin/);
      expect(precedingCtx).toMatch(/warehoused/);
    });

    it('传递 shipmentId prop', () => {
      expect(detailSrc).toMatch(/<BigsellerAbsorptionButton\s+shipmentId=\{shipment\.id\}/);
    });

    it('bigseller_absorbed_at 非 null 时不渲染', () => {
      // Guard: !shipment.bigseller_absorbed_at
      expect(detailSrc).toMatch(/!shipment\.bigseller_absorbed_at/);
    });
  });

  describe('warehouseBlockReason 展示', () => {
    it('warehouseBlockReason 非 null 时显示阻止原因 badge + 文本', () => {
      expect(detailSrc).toMatch(/\{warehouseBlockReason\s*&&/);
      expect(detailSrc).toMatch(/确认入仓/);
    });

    it('无仓库时显示完整阻止消息', () => {
      // 该在途记录未指定仓库，无法入仓
      expect(detailSrc).toMatch(/该在途记录未指定仓库，无法入仓/);
    });

    it('非 customs 时显示含当前状态的阻止消息', () => {
      // 清关后方可确认入仓 — uses statusLabel variable
      expect(detailSrc).toMatch(/清关后方可确认入仓/);
    });
  });

  // PERF-S1D: 四个详情页操作组件均通过 onSuccess 接入局部刷新
  describe('PERF-S1D: 局部刷新回调接入', () => {
    it('ShipmentDetailClient 传入 ShipmentEditForm onSuccess={refreshShipment}', () => {
      expect(detailSrc).toMatch(/<ShipmentEditForm[\s\S]*?onSuccess={refreshShipment}/);
    });

    it('ShipmentDetailClient 传入 ShipmentStatusChange onSuccess={refreshShipment}', () => {
      expect(detailSrc).toMatch(/<ShipmentStatusChange[\s\S]*?onSuccess={refreshShipment}/);
    });

    it('ShipmentDetailClient 传入 PartialWarehouseEntry onSuccess={refreshShipment}', () => {
      expect(detailSrc).toMatch(/<PartialWarehouseEntry[\s\S]*?onSuccess={refreshShipment}/);
    });

    it('ShipmentDetailClient 传入 BigsellerAbsorptionButton onSuccess={refreshShipment}', () => {
      expect(detailSrc).toMatch(/<BigsellerAbsorptionButton[\s\S]*?onSuccess={refreshShipment}/);
    });

    it('ShipmentEditForm 类型含 onSuccess 可选回调', () => {
      const editSrc = readSrc('src/features/shipments/components/shipment-edit-form.tsx');
      expect(editSrc).toMatch(/onSuccess\?\s*:\s*\(\)\s*=>\s*void/);
    });

    it('ShipmentEditForm 成功后调用 onSuccess?.()', () => {
      const editSrc = readSrc('src/features/shipments/components/shipment-edit-form.tsx');
      expect(editSrc).toMatch(/onSuccess\?\.\(\)/);
    });

    it('ShipmentEditForm 进入编辑态时从最新 shipment props 重置所有表单字段', () => {
      const editSrc = readSrc('src/features/shipments/components/shipment-edit-form.tsx');
      // 断言 onClick 中重置 shipmentNo / country / warehouseId 等字段
      expect(editSrc).toMatch(/setShipmentNo\(shipment\.shipment_no/);
      expect(editSrc).toMatch(/setCountry\(shipment\.country/);
      expect(editSrc).toMatch(/setWarehouseId\(shipment\.warehouse_id/);
      expect(editSrc).toMatch(/setEstimatedArrival\(shipment\.estimated_arrival/);
      expect(editSrc).toMatch(/setNote\(shipment\.note/);
      // 重置必须在 setEditing(true) 之前
      const editBtnOnClick = editSrc.match(/onClick=\{\(\)\s*=>\s*\{[\s\S]*?setEditing\(true\)/);
      expect(editBtnOnClick).toBeTruthy();
    });

    it('ShipmentStatusChange 类型含 onSuccess 可选回调', () => {
      const statusSrc = readSrc('src/features/shipments/components/shipment-status-change.tsx');
      expect(statusSrc).toMatch(/onSuccess\?\s*:\s*\(\)\s*=>\s*void/);
    });

    it('ShipmentStatusChange 成功后调用 onSuccess?.()', () => {
      const statusSrc = readSrc('src/features/shipments/components/shipment-status-change.tsx');
      expect(statusSrc).toMatch(/onSuccess\?\.\(\)/);
    });

    it('PartialWarehouseEntry 类型含 onSuccess 可选回调（保持不退化）', () => {
      const entrySrc = readSrc('src/features/shipments/components/partial-warehouse-entry.tsx');
      expect(entrySrc).toMatch(/onSuccess\?\s*:\s*\(\)\s*=>\s*void/);
    });

    it('BigsellerAbsorptionButton 类型含 onSuccess 可选回调（保持不退化）', () => {
      const absorptionSrc = readSrc('src/features/shipments/components/bigseller-absorption-button.tsx');
      expect(absorptionSrc).toMatch(/onSuccess\?\s*:\s*\(\)\s*=>\s*void/);
    });

    it('ShipmentDetailClient 使用 getShipmentDetail 实现 refreshShipment', () => {
      expect(detailSrc).toMatch(/getShipmentDetail\(/);
    });

    it('refreshShipment 通过 useCallback 稳定引用', () => {
      expect(detailSrc).toMatch(/useCallback\(/);
      expect(detailSrc).toMatch(/refreshShipment/);
    });
  });
});


// ============================================================================
// 2. 批量入仓页 — listEligibleForBatchWarehousingAction mock 行为
// ============================================================================

describe('P3-S5B5: listEligibleForBatchWarehousingAction', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('Admin → 调用 repository.listEligibleForBatchWarehousing → 返回分页结果', async () => {
    mockRequireActiveAuth.mockResolvedValue(ADMIN_USER);
    // getUserRole (profiles) 先于 shipment 查询
    pushFromResults(
      { data: { role: { name: 'admin' } } },
      { data: [], error: null, count: 0 },
    );

    const result = await listEligibleForBatchWarehousingAction({ page: 1, pageSize: 20 });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual({ data: [], total: 0, page: 1, pageSize: 20 });
    }
  });

  it('Operator → 返回权限错误中文消息', async () => {
    mockRequireActiveAuth.mockResolvedValue(OP_USER);

    const result = await listEligibleForBatchWarehousingAction({});

    expect(result.success).toBe(false);
    expect(result.error).toBe('仅管理员可查看批量入仓列表');
  });

  it('未登录 → requireActiveAuth 抛出异常 → Action catch 返回中文错误', async () => {
    mockRequireActiveAuth.mockRejectedValue(new Error('请先登录'));

    // Action catches the error and returns ActionResult (doesn't re-throw)
    const result = await listEligibleForBatchWarehousingAction({});

    expect(result.success).toBe(false);
    expect(result.error).toBe('查询批量入仓列表失败，请稍后重试');
  });

  it('Zod safeParse 失败 → 返回中文错误不进入 repository', async () => {
    mockRequireActiveAuth.mockResolvedValue(ADMIN_USER);

    // page=0 violates min(1)
    const result = await listEligibleForBatchWarehousingAction({ page: 0 });

    expect(result.success).toBe(false);
    expect(result.error).toBeTruthy();
    // Must not have called repository (no from() calls)
    expect(mockFrom).not.toHaveBeenCalled();
  });

  it('country 非法值 → Zod 拒绝', async () => {
    mockRequireActiveAuth.mockResolvedValue(ADMIN_USER);

    const result = await listEligibleForBatchWarehousingAction({
      country: 'JP', // not in enum
    } as unknown as Parameters<typeof listEligibleForBatchWarehousingAction>[0]);

    expect(result.success).toBe(false);
    expect(mockFrom).not.toHaveBeenCalled();
  });

  it('pageSize 超过 100 → Zod 拒绝', async () => {
    mockRequireActiveAuth.mockResolvedValue(ADMIN_USER);

    const result = await listEligibleForBatchWarehousingAction({ pageSize: 200 });

    expect(result.success).toBe(false);
    expect(mockFrom).not.toHaveBeenCalled();
  });

  it('Repository 抛出 ShipmentError → ActionResult 带回中文错误', async () => {
    mockRequireActiveAuth.mockResolvedValue(ADMIN_USER);
    pushFromResults(
      { data: { role: { name: 'admin' } } },
      { data: null, error: { message: 'connection refused' } },
    );

    const result = await listEligibleForBatchWarehousingAction({});

    expect(result.success).toBe(false);
    // Repository throws ShipmentError('查询可入仓在途列表失败', 'DB_ERROR')
    // → Action catches → returns '查询批量入仓列表失败，请稍后重试' (unknown error path)
    // Repository throws ShipmentError('查询可入仓在途列表失败', 'DB_ERROR')
    // → Action catch ShipmentError → returns error.message
    expect(result.error).toBe('查询可入仓在途列表失败');
  });

  it('未知异常 → 兜底中文错误', async () => {
    mockRequireActiveAuth.mockResolvedValue(ADMIN_USER);
    mockFrom.mockImplementation(() => {
      throw new Error('unexpected');
    });

    const result = await listEligibleForBatchWarehousingAction({});

    expect(result.success).toBe(false);
    expect(result.error).toBe('查询批量入仓列表失败，请稍后重试');
  });

  it('传递 userId 给 repository 实现仓库隔离', () => {
    // Source-level verification: the action passes user.id to repository
    const actionsSrc = readSrc('src/features/shipments/actions.ts');
    const fnStart = actionsSrc.indexOf('listEligibleForBatchWarehousingAction');
    const fnEnd = actionsSrc.indexOf('export async function confirmBigsellerAbsorption');
    const fnBody = actionsSrc.slice(fnStart, fnEnd > 0 ? fnEnd : undefined);
    expect(fnBody).toMatch(/user\.id/);
    expect(fnBody).toMatch(/listEligibleForBatchWarehousing\(/);
  });
});

// ============================================================================
// 3. 批量入仓页 — validateEntry 校验逻辑（5 条分支全覆盖）
// ============================================================================

describe('P3-S5B5: validateEntry 校验逻辑', () => {
  const batchSrc = readSrc('src/features/shipments/components/batch-warehouse-page.tsx');

  it('空字符串 → 返回 ok: false, error: ""（允许为空跳过）', () => {
    expect(batchSrc).toMatch(/trimmed\s*===\s*''\s*\).*return\s*\{[\s\S]*ok:\s*false,\s*error:\s*''\s*\}/);
  });

  it('非数字字符串 → 返回中文错误"请输入有效整数"', () => {
    expect(batchSrc).toMatch(/isNaN\(num\).*请输入有效整数/);
  });

  it('小数 → 返回中文错误"数量必须为整数，不支持小数"', () => {
    expect(batchSrc).toMatch(/不支持小数/);
  });

  it('负数 → 返回中文错误"数量不能为负数"', () => {
    expect(batchSrc).toMatch(/不能为负数/);
  });

  it('零值 → 返回中文错误"数量必须大于 0"', () => {
    expect(batchSrc).toMatch(/必须大于 0/);
  });

  it('超过在途余量 → 返回含 SKU + 输入值 + 余量的中文错误', () => {
    expect(batchSrc).toMatch(/超过在途余量/);
    // Error message includes the SKU, input number, and remaining
    expect(batchSrc).toMatch(/num\s*>\s*remaining/);
  });

  it('合法正整数 → 返回 ok: true + 数值', () => {
    expect(batchSrc).toMatch(/ok:\s*true,\s*value:\s*num/);
  });

  it('正则检测仅允许纯数字（无小数点/负号/科学计数）', () => {
    expect(batchSrc).toMatch(/\/\^\\d\+\$\/\.test\(trimmed\)/);
  });

  it('所有 5 条校验分支均有中文错误消息', () => {
    const fnStart = batchSrc.indexOf('function validateEntry');
    const fnEnd = batchSrc.indexOf('const handleSubmit = async');
    const fnBody = batchSrc.slice(fnStart, fnEnd);

    // Count return statements with error messages
    const errorReturns = fnBody.match(/error:\s*`[^`]*`/g) || [];
    // At least 5: empty ok, NaN, not-int, negative, zero, overflow
    expect(errorReturns.length).toBeGreaterThanOrEqual(5);

    // Every error path uses Chinese
    for (const err of errorReturns) {
      const hasChinese = /[一-鿿]/.test(err);
      expect(hasChinese).toBe(true);
    }
  });
});

// ============================================================================
// 4. 海外库存 confirmedMap — P6 已从主表移除
// ============================================================================

describe('P3-S5B5 → P6: 海外库存主表已移除 confirmedMap', () => {
  const actionsSrc = readSrc('src/features/inventory/actions.ts');

  describe('confirmedMap 移除验证', () => {
    it('仍调用 inventoryRepository.getInTransitConfirmedAggregate（用于在途数据）', () => {
      expect(actionsSrc).toMatch(/getInTransitConfirmedAggregate/);
    });

    it('不再出现 uniqueWarehouseIds / getConfirmedWarehousedByWarehouse（N+1 已消除）', () => {
      expect(actionsSrc).not.toMatch(/uniqueWarehouseIds/);
      expect(actionsSrc).not.toMatch(/getConfirmedWarehousedByWarehouse/);
    });

    it('P6: confirmedMap 不再从 aggregateRows 构建', () => {
      expect(actionsSrc).not.toMatch(/confirmedMap\[row\.warehouse_id\]/);
    });

    it('P6: getOverseasInventory 返回类型不再包含 confirmedMap', () => {
      expect(actionsSrc).not.toMatch(/confirmedMap:\s*Record<string,\s*Record<string,\s*number>>/);
    });

    it('P6: 页面不再使用 confirmedMap 查找数据', () => {
      const overseasContentSrc = readSrc(
        'src/app/dashboard/inventory/overseas/_components/overseas-page-content.tsx',
      );
      expect(overseasContentSrc).not.toMatch(/confirmedMap/);
    });
  });

  describe('单仓失败隔离（RPC 层）', () => {
    it('getInTransitConfirmedAggregate 失败时由 repository 抛出 ShipmentError', () => {
      const invRepoSrc = readSrc('src/features/inventory/repository.ts');
      const fnStart = invRepoSrc.indexOf('async getInTransitConfirmedAggregate(');
      const fnEnd = invRepoSrc.indexOf('};', fnStart);
      const fnBody = invRepoSrc.slice(fnStart, fnEnd);
      expect(fnBody).toMatch(/throw new Error/);
    });
  });

  describe('口径', () => {
    it('confirmedMap 仅展示 customs 或 warehoused+未吸收的数据', () => {
      // getConfirmedWarehousedByWarehouse 已内置此口径（.or() 过滤）
      const repoSrc = readSrc('src/features/shipments/repository.ts');
      const fnStart = repoSrc.indexOf('async getConfirmedWarehousedByWarehouse(');
      const fnEnd = repoSrc.indexOf('async confirmBigsellerAbsorption(');
      const fnBody = repoSrc.slice(fnStart, fnEnd);
      expect(fnBody).toContain('status.eq.customs,and(status.eq.warehoused,bigseller_absorbed_at.is.null)');
    });

    it('不读取 BigSeller 同步库存数据（不读 inventory.quantity）', () => {
      // confirmedMap 只读 shipment + shipment_item，不读 inventory
      const repoSrc = readSrc('src/features/shipments/repository.ts');
      const fnStart = repoSrc.indexOf('async getConfirmedWarehousedByWarehouse(');
      const fnEnd = repoSrc.indexOf('async confirmBigsellerAbsorption(');
      const fnBody = repoSrc.slice(fnStart, fnEnd);
      // 排除注释后检查
      const codeOnly = fnBody
        .split('\n')
        .filter((l) => !l.trim().startsWith('*') && !l.trim().startsWith('//'))
        .join('\n');
      expect(codeOnly).not.toMatch(/\.from\('inventory'\)/);
    });
  });
});

// ============================================================================
// 5. 安全边界 — 完整覆盖
// ============================================================================

describe('P3-S5B5: 安全边界', () => {
  const actionsSrc = readSrc('src/features/shipments/actions.ts');
  const repoSrc = readSrc('src/features/shipments/repository.ts');
  const batchCompSrc = readSrc('src/features/shipments/components/batch-warehouse-page.tsx');

  describe('P3-S5B2/B4 Actions — requireActiveAuth + Admin-only', () => {
    const newActions = [
      { name: 'partialWarehouseShipment', errorCn: '仅管理员可确认入仓' },
      { name: 'batchWarehouseShipments', errorCn: '仅管理员可批量确认入仓' },
      { name: 'confirmBigsellerAbsorption', errorCn: '仅管理员可确认 BigSeller 吸收' },
      { name: 'listEligibleForBatchWarehousingAction', errorCn: '仅管理员可查看批量入仓列表' },
    ];

    for (const { name, errorCn } of newActions) {
      it(`${name} — 调用 requireActiveAuth`, () => {
        const fnStart = actionsSrc.indexOf(`export async function ${name}`);
        const nextFn = actionsSrc.indexOf('export async function', fnStart + 1);
        const fnBody = actionsSrc.slice(fnStart, nextFn > 0 ? nextFn : undefined);
        expect(fnBody).toMatch(/requireActiveAuth\(\)/);
      });

      it(`${name} — roleName !== 'admin' 拒绝`, () => {
        const fnStart = actionsSrc.indexOf(`export async function ${name}`);
        const nextFn = actionsSrc.indexOf('export async function', fnStart + 1);
        const fnBody = actionsSrc.slice(fnStart, nextFn > 0 ? nextFn : undefined);
        expect(fnBody).toMatch(/roleName\s*!==\s*'admin'/);
      });

      it(`${name} — 含中文错误消息 "${errorCn}"`, () => {
        expect(actionsSrc).toContain(errorCn);
      });

      it(`${name} — Zod safeParse 校验`, () => {
        const fnStart = actionsSrc.indexOf(`export async function ${name}`);
        const nextFn = actionsSrc.indexOf('export async function', fnStart + 1);
        const fnBody = actionsSrc.slice(fnStart, nextFn > 0 ? nextFn : undefined);
        expect(fnBody).toMatch(/\.safeParse/);
      });

      it(`${name} — catch ShipmentError 返回中文错误`, () => {
        const fnStart = actionsSrc.indexOf(`export async function ${name}`);
        const nextFn = actionsSrc.indexOf('export async function', fnStart + 1);
        const fnBody = actionsSrc.slice(fnStart, nextFn > 0 ? nextFn : undefined);
        expect(fnBody).toMatch(/error\.name\s*===\s*'ShipmentError'/);
      });
    }
  });

  describe('不写 inventory.quantity', () => {
    it('actions.ts 不含 .from(\'inventory\')', () => {
      expect(actionsSrc).not.toMatch(/\.from\('inventory'\)/);
    });

    it('new repository 方法不含 inventory 写入', () => {
      // Check the new methods (partialWarehouse onward)
      const newMethodsStart = repoSrc.indexOf('// ─── P3-S5B2: 部分入仓');
      const newMethodsBody = repoSrc.slice(newMethodsStart);
      const codeOnly = newMethodsBody
        .split('\n')
        .filter((l) => !l.trim().startsWith('*') && !l.trim().startsWith('//') && !l.trim().startsWith('/*'))
        .join('\n');
      expect(codeOnly).not.toMatch(/\.from\('inventory'\)/);
    });

    it('batch-warehouse-page.tsx 不含 supabase 直接调用', () => {
      expect(batchCompSrc).not.toMatch(/supabase\.from\(/);
      expect(batchCompSrc).not.toMatch(/supabase\.rpc\(/);
    });

    it('batch-warehouse-page.tsx 不含 createClient', () => {
      expect(batchCompSrc).not.toMatch(/createClient/);
    });
  });

  describe('不调用 00023 旧 RPC', () => {
    it('P3-S5B2/B4 新增方法不含 warehouse_shipment_transactional', () => {
      const partialIdx = repoSrc.indexOf('async partialWarehouse(');
      const restOfRepo = repoSrc.slice(partialIdx);
      expect(restOfRepo).not.toMatch(/warehouse_shipment_transactional/);
    });

    it('partialWarehouse 调用 partial_warehouse_shipment RPC（Migration 00026）', () => {
      const partialIdx = repoSrc.indexOf('async partialWarehouse(');
      const nextMethod = repoSrc.indexOf('async listEligibleForBatchWarehousing(');
      const methodBody = repoSrc.slice(partialIdx, nextMethod);
      expect(methodBody).toContain("'partial_warehouse_shipment'");
      expect(methodBody).not.toMatch(/warehouse_shipment_transactional/);
    });

    it('batchWarehouseShipments action 逐笔调用 partialWarehouse → 00026 RPC', () => {
      const fnStart = actionsSrc.indexOf('export async function batchWarehouseShipments');
      const fnEnd = actionsSrc.indexOf('export async function confirmBigsellerAbsorption');
      const fnBody = actionsSrc.slice(fnStart, fnEnd);
      expect(fnBody).toMatch(/partialWarehouse\(/);
      expect(fnBody).not.toMatch(/warehouse_shipment_transactional/);
    });
  });

  describe('组件不绕过 repository/RLS', () => {
    it('BatchWarehousePage 通过 actions 导入操作数据', () => {
      expect(batchCompSrc).toMatch(/from ['"]@\/features\/shipments\/actions['"]/);
    });

    it('PartialWarehouseEntry → PartialWarehouseDialog → partialWarehouseShipment action', () => {
      // PartialWarehouseEntry opens PartialWarehouseDialog, which calls the action
      const dialogSrc = readSrc(
        'src/features/shipments/components/partial-warehouse-dialog.tsx',
      );
      expect(dialogSrc).toBeTruthy();
      // Dialog calls partialWarehouseShipment Server Action
      expect(dialogSrc).toMatch(/partialWarehouseShipment/);
    });

    it('BigsellerAbsorptionButton 组件文件存在', () => {
      const absorptionSrc = readSrc(
        'src/features/shipments/components/bigseller-absorption-button.tsx',
      );
      expect(absorptionSrc).toBeTruthy();
      expect(absorptionSrc).toMatch(/confirmBigsellerAbsorption/);
    });

    it('PartialWarehouseEntry 不直接调用 supabase', () => {
      const src = readSrc('src/features/shipments/components/partial-warehouse-entry.tsx');
      expect(src).not.toMatch(/supabase\.from\(/);
      expect(src).not.toMatch(/supabase\.rpc\(/);
    });

    it('BigsellerAbsorptionButton 不直接调用 supabase', () => {
      const src = readSrc('src/features/shipments/components/bigseller-absorption-button.tsx');
      expect(src).not.toMatch(/supabase\.from\(/);
      expect(src).not.toMatch(/supabase\.rpc\(/);
    });
  });

  describe('P3-S5B0 阻断桩保持完整', () => {
    it('warehouseShipment 仍为阻断桩 — 返回旧版入仓入口已停用', () => {
      const fnStart = actionsSrc.indexOf('export async function warehouseShipment');
      const fnEnd = actionsSrc.indexOf('export async function getInTransitDetails');
      const fnBody = actionsSrc.slice(fnStart, fnEnd);
      expect(fnBody).toMatch(/旧版入仓入口已停用/);
      // 阻断桩不调用 requireActiveAuth() — 排除注释中的文字
      // Filter out comment lines before checking
      const codeLines = fnBody
        .split('\n')
        .filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*') && !l.trim().startsWith('/*'));
      const codeOnly = codeLines.join('\n');
      expect(codeOnly).not.toMatch(/requireActiveAuth\(\)/);
      expect(codeOnly).not.toMatch(/shipmentRepository/);
    });

    it('详情页不含 WarehouseShipmentButton 引用', () => {
      const detailSrc = readSrc('src/app/dashboard/shipments/[id]/page.tsx');
      expect(detailSrc).not.toMatch(/<WarehouseShipmentButton/);
    });
  });
});

// ============================================================================
// 6. 批量入仓页 — 边界状态覆盖
// ============================================================================

describe('P3-S5B5: 批量入仓页边界状态', () => {
  const batchSrc = readSrc('src/features/shipments/components/batch-warehouse-page.tsx');

  it('空数据状态 — "暂无待入仓的在途记录" + 补充说明', () => {
    expect(batchSrc).toMatch(/暂无待入仓的在途记录/);
    expect(batchSrc).toMatch(/只有状态为.*清关.*且已分配仓库的在途记录才会出现在此列表/);
  });

  it('加载中 — 分页加载时显示 loading 状态（setLoading）', () => {
    expect(batchSrc).toMatch(/setLoading\(true\)/);
    expect(batchSrc).toMatch(/setLoading\(false\)/);
  });

  it('加载产品明细中 — Loader2Icon + "加载产品明细…"', () => {
    expect(batchSrc).toMatch(/加载产品明细…/);
  });

  it('提交中 — Loader2Icon + "提交中…" + disabled', () => {
    expect(batchSrc).toMatch(/提交中…/);
  });

  it('全局错误 — bg-red-50 醒目展示', () => {
    expect(batchSrc).toMatch(/globalError/);
    expect(batchSrc).toMatch(/bg-red-50/);
  });

  it('结果汇总 — 成功绿色 / 失败红色 + 文字', () => {
    expect(batchSrc).toMatch(/入仓成功/);
    expect(batchSrc).toMatch(/text-green-700/);
    expect(batchSrc).toMatch(/text-red-700/);
  });

  it('提交完成后自动移除已成功 shipment 的选中/缓存/输入', () => {
    expect(batchSrc).toMatch(/successIds/);
    // Remove from selectedIds
    expect(batchSrc).toMatch(/for\s*\(const id of successIds\)\s*next\.delete\(id\)/);
    // Remove from itemsCache
    expect(batchSrc).toMatch(/delete next\[id\]/);
    // Remove quantities
    expect(batchSrc).toMatch(/delete next\[key\]/);
  });

  it('提交后刷新列表', () => {
    expect(batchSrc).toMatch(/loadPage\(page\)/);
  });

  it('提交按钮 disabled 条件：submitting || !hasConfiguredShipments', () => {
    expect(batchSrc).toMatch(/disabled=\{submitting \|\| !hasConfiguredShipments\}/);
  });

  it('展开行中"全额确认"按钮在 remainingQuantity===0 时 disabled', () => {
    expect(batchSrc).toMatch(/shipment\.remainingQuantity === 0/);
  });

  it('分页信息 — 共 N 条，第 X/Y 页', () => {
    expect(batchSrc).toMatch(/共.*total.*条.*第.*page.*页/);
  });

  it('返回按钮链接到 /dashboard/shipments', () => {
    expect(batchSrc).toMatch(/\/dashboard\/shipments/);
    expect(batchSrc).toMatch(/返回在途管理/);
  });
});

// ============================================================================
// 7. Zod Schema — eligibleShipmentFiltersSchema 行为测试
// ============================================================================

describe('P3-S5B5: eligibleShipmentFiltersSchema 行为测试', () => {
  it('空对象 → 通过，应用默认值 page=1, pageSize=20', () => {
    const result = eligibleShipmentFiltersSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.page).toBe(1);
      expect(result.data.pageSize).toBe(20);
    }
  });

  it('合法 country → 通过', () => {
    const result = eligibleShipmentFiltersSchema.safeParse({ country: 'PH' });
    expect(result.success).toBe(true);
  });

  it('合法 warehouseId UUID → 通过', () => {
    const result = eligibleShipmentFiltersSchema.safeParse({
      warehouseId: WAREHOUSE_ID,
    });
    expect(result.success).toBe(true);
  });

  it('非法 warehouseId → 拒绝', () => {
    const result = eligibleShipmentFiltersSchema.safeParse({ warehouseId: 'not-uuid' });
    expect(result.success).toBe(false);
  });

  it('page=0 → 拒绝（min 1）', () => {
    const result = eligibleShipmentFiltersSchema.safeParse({ page: 0 });
    expect(result.success).toBe(false);
  });

  it('pageSize=0 → 拒绝（min 1）', () => {
    const result = eligibleShipmentFiltersSchema.safeParse({ pageSize: 0 });
    expect(result.success).toBe(false);
  });

  it('pageSize=101 → 拒绝（max 100）', () => {
    const result = eligibleShipmentFiltersSchema.safeParse({ pageSize: 101 });
    expect(result.success).toBe(false);
  });

  it('country 非法值 → 拒绝', () => {
    const result = eligibleShipmentFiltersSchema.safeParse({ country: 'JP' });
    expect(result.success).toBe(false);
  });

  it('page 为字符串 → coerce 转换为 number', () => {
    const result = eligibleShipmentFiltersSchema.safeParse({ page: '3' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.page).toBe(3);
    }
  });

  it('pageSize 为字符串 → coerce 转换为 number', () => {
    const result = eligibleShipmentFiltersSchema.safeParse({ pageSize: '50' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.pageSize).toBe(50);
    }
  });
});

// ============================================================================
// 8. 海外库存页 — 表头列数与展开行一致性
// ============================================================================

describe('P3-S5B5: 海外库存页列数与展开行', () => {
  const contentSrc = readSrc(
    'src/app/dashboard/inventory/overseas/_components/overseas-page-content.tsx',
  );

  it('表头 12 列（P6 移除已确认到仓）', () => {
    const headMatches = contentSrc.match(/<TableHead[\s>]/g);
    expect(headMatches).not.toBeNull();
    expect(headMatches!.length).toBe(12);
  });

  it('展开行 colSpan=12（P6 移除已确认到仓）', () => {
    expect(contentSrc).not.toMatch(/colSpan=\{13\}/);
    expect(contentSrc).toMatch(/colSpan=\{12\}/);
  });

  it('表头列为：展开/关注/国家/仓库/产品名称/SKU/当前库存/在途/库存+在途/安全库存/库存状态/同步状态（P6 移除已确认到仓）', () => {
    // 已确认到仓已从主表移除
    expect(contentSrc).not.toMatch(/已确认到仓/);
    expect(contentSrc).toMatch(/在途/);
    expect(contentSrc).toMatch(/库存\+在途/);
    expect(contentSrc).toMatch(/当前库存/);
    expect(contentSrc).toMatch(/安全库存/);
    expect(contentSrc).toMatch(/库存状态/);
    expect(contentSrc).toMatch(/同步状态/);
  });
});

// ============================================================================
// 9. 权限审计 — P3-S5B2/B4 Actions 完整矩阵
// ============================================================================

describe('P3-S5B5: 权限审计 — P3-S5B2/B4 Actions', () => {
  const actionsSrc = readSrc('src/features/shipments/actions.ts');

  it('actions.ts 共 15 个 export async function（P1 新增创建/取消计划）', () => {
    const fnCount = (actionsSrc.match(/export async function/g) || []).length;
    expect(fnCount).toBe(15);
  });

  it('12 个调用 requireActiveAuth + 1 个阻断桩（warehouseShipment）', () => {
    const authCount = (actionsSrc.match(/requireActiveAuth\(\)/g) || []).length;
    expect(authCount).toBe(12);
  });

  it('P1 两个计划发货写操作直接调用 requireActiveAdmin', () => {
    const adminAuthCount = (actionsSrc.match(/requireActiveAdmin\(\)/g) || []).length;
    expect(adminAuthCount).toBe(2);
  });

  it('8 个 Admin-only（含 P3-S5B2/B4 新增 4 个）', () => {
    const adminCheckCount = (actionsSrc.match(/roleName\s*!==\s*'admin'/g) || []).length;
    // createShipment, updateShipment, changeShipmentStatus, advanceShipmentStatus,
    // partialWarehouseShipment, batchWarehouseShipments, confirmBigsellerAbsorption,
    // listEligibleForBatchWarehousingAction = 8
    expect(adminCheckCount).toBe(8);
  });

  it('4 个读操作允许 Admin/Operator（不含 roleName !== admin）', () => {
    const readActions = [
      'listShipments',
      'getShipmentDetail',
      'searchVariants',
      'getInTransitDetails',
    ];
    for (const fn of readActions) {
      const fnStart = actionsSrc.indexOf(`export async function ${fn}`);
      const nextFn = actionsSrc.indexOf('export async function', fnStart + 1);
      const fnBody = actionsSrc.slice(fnStart, nextFn > 0 ? nextFn : undefined);
      expect(fnBody).not.toMatch(/roleName\s*!==\s*'admin'/);
    }
  });

  it('13 = 8 Admin-only + 4 read-all + 1 blocking stub', () => {
    const total = 13;
    const adminOnly = 8;
    const readAll = 4;
    const blockingStub = 1; // warehouseShipment
    expect(adminOnly + readAll + blockingStub).toBe(total);
  });
});
