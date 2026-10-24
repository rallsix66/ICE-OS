import { describe, expect, it } from 'vitest';
import { safeCatalogReturnHref } from './safe-return';

describe('safeCatalogReturnHref（V4-06 规范化后校验）', () => {
  it.each([
    ['/dashboard/catalog', '/dashboard/catalog'],
    ['/dashboard/catalog?q=WM0072&warehouse=DEE&page=2', '/dashboard/catalog?q=WM0072&warehouse=DEE&page=2'],
    ['/dashboard/catalog/issues?page=2', '/dashboard/catalog/issues?page=2'],
    ['/dashboard/catalog/admin?tab=records', '/dashboard/catalog/admin?tab=records'],
    ['/dashboard/catalog?detail=aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa&revision=2&evidence=1&q=WM', '/dashboard/catalog?q=WM'],
  ])('accepts internal catalog path %s', (input, expected) => {
    expect(safeCatalogReturnHref(input)).toBe(expected);
  });

  it.each([
    ['external absolute', 'https://evil.example/dashboard/catalog'],
    ['protocol relative', '//evil.example/dashboard/catalog'],
    ['outside prefix', '/auth/login'],
    ['path traversal', '/dashboard/catalog/../../auth/login'],
    ['encoded traversal', '/dashboard/catalog/%2e%2e/%2e%2e/auth/login'],
    ['encoded slash', '/dashboard/catalog%2f..%2fauth/login'],
    ['backslash', '/dashboard/catalog\\..\\auth'],
    ['bare old detail path', '/dashboard/catalog/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'],
    ['old detail with query', '/dashboard/catalog/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa?from=/dashboard/catalog'],
    ['unknown child', '/dashboard/catalog/not-a-real-page'],
    ['nested from', '/dashboard/catalog?from=%2Fdashboard%2Fcatalog'],
    ['control chars', '/dashboard/catalog\u0000'],
  ])('rejects %s', (_label, input) => {
    expect(safeCatalogReturnHref(input)).toBe('');
  });

  it('rejects overlong and empty input', () => {
    expect(safeCatalogReturnHref('')).toBe('');
    expect(safeCatalogReturnHref(`/dashboard/catalog?q=${'x'.repeat(1100)}`)).toBe('');
  });
});
