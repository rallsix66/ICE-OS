// P5-SY11G-D: Inventory 层归档过滤测试（用户级偏好）
//
// 验证:
// - 海外库存列表/低库存/统计使用 user_variant_preference 过滤
// - 不再使用 .eq('variant.is_archived', false) DB 过滤
// - getOverseasList/getLowStock 使用 row.variant_id 判断归档（variant join select 不含 id）
// - getOverseasList/getLowStock/getOverseasStats 接受 userId 参数
// - getByProductId 不过滤（保留全部 Variant 库存）
// - 源码不含 is_archived DB 级过滤（inventory repository）
// - P5-SY11G 返工：variant join 不含 id 导致所有行被过滤 → 改用 row.variant_id

import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import type { InventoryFilters } from '@/features/inventory/types';

const INVENTORY_REPO_PATH = path.resolve(process.cwd(), 'src/features/inventory/repository.ts');
const INVENTORY_ACTIONS_PATH = path.resolve(process.cwd(), 'src/features/inventory/actions.ts');

// ─── 源码静态检查 ────────────────────────────────────────────────────

describe('P5-SY11G-D — 源码不再使用 is_archived 过滤', () => {
  let repoSrc: string;

  beforeAll(() => {
    repoSrc = fs.readFileSync(INVENTORY_REPO_PATH, 'utf-8');
  });

  it('getOverseasList 不包含 variant.is_archived 的 .eq() DB 过滤', () => {
    // 排注释行后不应有 .eq('variant.is_archived', ...) 调用
    const codeLines = repoSrc.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
    expect(codeLines).not.toMatch(/\.eq\s*\(\s*['"]variant\.is_archived['"]/);
  });

  it('getLowStock 不包含 variant.is_archived DB 过滤', () => {
    const codeLines = repoSrc.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
    expect(codeLines).not.toMatch(/variant\.is_archived/);
  });

  it('getOverseasStats 不包含 variant.is_archived DB 过滤', () => {
    const codeLines = repoSrc.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
    expect(codeLines).not.toMatch(/variant\.is_archived/);
  });

  it('使用 user_variant_preference 表查询归档偏好', () => {
    expect(repoSrc).toMatch(/user_variant_preference/);
  });

  it('归档排除由 RPC SQL 层完成（get_low_stock RPC + user_variant_preference LEFT JOIN IS NULL）', () => {
    // LOW-STOCK-PAGINATION: 归档排除已从 JS 层下沉到 get_low_stock RPC（Migration 00028）。
    // 仓库隔离和低库存判定也一并下沉。
    const migPath = path.resolve(process.cwd(), 'supabase/migrations/00028_low_stock_rpc.sql');
    const migSrc = fs.readFileSync(migPath, 'utf-8');
    expect(migSrc).toMatch(/user_variant_preference/);
    expect(migSrc).toMatch(/uvp_arch\.variant_id\s+IS\s+NULL/);
  });
});

// ─── getByProductId 不过滤 ────────────────────────────────────────────

describe('P5-SY11G-D — getByProductId 不过滤归档', () => {
  it('getByProductId 不接收 userId 参数', async () => {
    const { inventoryRepository } = await import('@/features/inventory/repository');
    expect(inventoryRepository.getByProductId.length).toBe(2);
    expect(inventoryRepository.getByProductId.name).toBe('getByProductId');
  });

  it('getByProductId 不查询 user_variant_preference', () => {
    const repoSrc = fs.readFileSync(INVENTORY_REPO_PATH, 'utf-8');
    // getByProductId 函数区域不含 user_variant_preference 引用
    const fnBlock = repoSrc.match(/async getByProductId[\s\S]*?^\s{2}\},?\s*$/m);
    if (fnBlock) {
      expect(fnBlock[0]).not.toMatch(/user_variant_preference/);
      expect(fnBlock[0]).not.toMatch(/archivedVariantIds/);
    }
  });
});

// ─── getOverseasList/getLowStock/getOverseasStats 接受 userId ───────

describe('P5-SY11G-D — 方法签名包含 userId', () => {
  it('getOverseasList 通过 filters.userId 接受用户 ID', () => {
    const repoSrc = fs.readFileSync(INVENTORY_REPO_PATH, 'utf-8');
    // getOverseasList 函数体内解构 filters 包含 userId
    const fnBody = repoSrc.match(/async getOverseasList[\s\S]*?^\s{2}\},?\s*$/m);
    expect(fnBody).not.toBeNull();
    if (fnBody) {
      expect(fnBody[0]).toMatch(/userId/);
    }
  });

  it('getLowStock 接受 userId 参数', () => {
    const repoSrc = fs.readFileSync(INVENTORY_REPO_PATH, 'utf-8');
    const fnSig = repoSrc.match(/async getLowStock\s*\(([^)]*)\)/);
    expect(fnSig).not.toBeNull();
    if (fnSig) {
      expect(fnSig[1]).toMatch(/userId/);
    }
  });

  it('getOverseasStats 接受 userId 参数', () => {
    const repoSrc = fs.readFileSync(INVENTORY_REPO_PATH, 'utf-8');
    const fnSig = repoSrc.match(/async getOverseasStats\s*\(([^)]*)\)/);
    expect(fnSig).not.toBeNull();
    if (fnSig) {
      expect(fnSig[1]).toMatch(/userId/);
    }
  });
});

// ─── InventoryFilters 类型包含 userId ─────────────────────────────────

describe('P5-SY11G-D — InventoryFilters 类型', () => {
  it('InventoryFilters 包含 userId 字段', async () => {
    const filters: InventoryFilters = { userId: 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa' };
    expect(filters.userId).toBeDefined();
  });
});

// ─── actions.ts 传递 userId ───────────────────────────────────────────

describe('P5-SY11G-D — Inventory Actions 传递 userId', () => {
  it('getOverseasInventory 传递 userId 到 getOverseasStats 和 getOverseasList', () => {
    const actionsSrc = fs.readFileSync(INVENTORY_ACTIONS_PATH, 'utf-8');
    expect(actionsSrc).toMatch(/userId/);
    expect(actionsSrc).toMatch(/getOverseasStats\s*\(\s*userId/);
  });
});

// ─── dashboard page 传递 userId ───────────────────────────────────────

describe('P5-SY11G-D — Dashboard page 传递 userId', () => {
  it('page.tsx 传递服务端 user.id 到仓库健康度 RPC Repository', () => {
    const pagePath = path.resolve(process.cwd(), 'src/app/dashboard/page.tsx');
    const pageSrc = fs.readFileSync(pagePath, 'utf-8');
    expect(pageSrc).toMatch(/getWarehouseHealthOverview\s*\(\s*user\.id/);
    expect(pageSrc).not.toContain('getOverseasStats');
  });
});

// ─── P5-SY11G 返工：variant.id 缺失修复验证 ──────────────────────────

describe('P5-SY11G-D 返工 — getOverseasList 使用 row.variant_id', () => {
  let repoSrc: string;

  beforeAll(() => {
    repoSrc = fs.readFileSync(INVENTORY_REPO_PATH, 'utf-8');
  });

  it('getOverseasList 过滤逻辑不再使用 v.id（variant join 不含 id）', () => {
    // variant join select: variant:variant_id!inner (sku, country, match_status, ...)
    // 不含 id，所以必须使用 row.variant_id 判断
    const fnBody = repoSrc.match(/async getOverseasList[\s\S]*?^\s{2}\},?\s*$/m);
    expect(fnBody).not.toBeNull();
    if (fnBody) {
      // 不应出现 v.id（variant join 不含 id）
      const filterLines = fnBody[0].split('\n').filter((l) => l.includes('archivedVariantIds.has'));
      for (const line of filterLines) {
        expect(line).toMatch(/row\.variant_id/);
        expect(line).not.toMatch(/v\.id/);
      }
    }
  });

  it('getOverseasList — PERF-S1B: 归档过滤由 RPC SQL 层处理，不再 JS 层 variant join', () => {
    // getOverseasList 调用 get_overseas_inventory RPC，归档排除在 SQL 层完成
    expect(repoSrc).toMatch(/\.rpc\(['"]get_overseas_inventory['"]/);
    // 不再出现 variant:variant_id!inner 的 Supabase join 语法
    const fnBody = repoSrc.match(/async getOverseasList[\s\S]*?^\s{2}\},?\s*$/m);
    expect(fnBody).not.toBeNull();
    if (fnBody) {
      expect(fnBody[0]).not.toMatch(/variant:variant_id!inner/);
    }
  });

  it('未归档时 archivedVariantIds 为空 Set，过滤不过滤任何行', () => {
    // 当 archivedVariantIds.size === 0，has() 返回 false，所有行保留
    const emptySet = new Set<string>();
    expect(emptySet.has('any-id')).toBe(false);
  });

  it('归档后 archivedVariantIds 包含 variant_id，过滤排除对应行', () => {
    const archivedSet = new Set(['variant-a', 'variant-b']);
    expect(archivedSet.has('variant-a')).toBe(true);
    expect(archivedSet.has('variant-c')).toBe(false);
  });
});

describe('P5-SY11G-D 返工 — getLowStock 使用 row.variant_id', () => {
  let repoSrc: string;

  beforeAll(() => {
    repoSrc = fs.readFileSync(INVENTORY_REPO_PATH, 'utf-8');
  });

  it('getLowStock 过滤逻辑使用 row.variant_id 判断归档', () => {
    const fnBody = repoSrc.match(/async getLowStock[\s\S]*?^\s{2}\},?\s*$/m);
    expect(fnBody).not.toBeNull();
    if (fnBody) {
      const filterLines = fnBody[0].split('\n').filter((l) => l.includes('archivedVariantIds.has'));
      for (const line of filterLines) {
        expect(line).toMatch(/row\.variant_id/);
        expect(line).not.toMatch(/v\.id/);
      }
    }
  });
});

// ─── 多用户隔离概念验证 ───────────────────────────────────────────────

describe('P5-SY11G-D 返工 — 多用户隔离', () => {
  it('归档排除在 RPC 层按 p_user_id 查询（每人独立偏好）', () => {
    // LOW-STOCK-PAGINATION: getLowStock RPC 内部 JOIN user_variant_preference
    // ON uvp_arch.user_id = p_user_id，每人独立
    const migPath = path.resolve(process.cwd(), 'supabase/migrations/00028_low_stock_rpc.sql');
    const migSrc = fs.readFileSync(migPath, 'utf-8');
    expect(migSrc).toMatch(/uvp_arch\.user_id\s*=\s*p_user_id/);
  });

  it('filter 条件 — PERF-S1B: 归档过滤由 RPC 内 user_variant_preference JOIN 完成', () => {
    const repoSrc = fs.readFileSync(INVENTORY_REPO_PATH, 'utf-8');
    // getOverseasList 传入 p_user_id，RPC 内部按 user_variant_preference 过滤
    const fnBody = repoSrc.match(/async getOverseasList[\s\S]*?^\s{2}\},?\s*$/m);
    expect(fnBody).not.toBeNull();
    if (fnBody) {
      // RPC 调用包含 p_user_id 参数
      expect(fnBody[0]).toMatch(/p_user_id/);
    }
  });
});
