import { describe, expect, it } from 'vitest';
import {
  ISSUES_RETURN_HREF,
  appendReturnContext,
  isIssuesReturnHref,
  issuesReturnHref,
  safeInternalReturnHref,
} from './context';

describe('站内返回点安全校验（V3-05）', () => {
  it('接受站内 /dashboard/ 相对路径（含查询参数）', () => {
    expect(safeInternalReturnHref('/dashboard/catalog')).toBe('/dashboard/catalog');
    expect(safeInternalReturnHref(ISSUES_RETURN_HREF)).toBe(ISSUES_RETURN_HREF);
    expect(safeInternalReturnHref('/dashboard/catalog/issues?kind=brush_pending')).toBe('/dashboard/catalog/issues?kind=brush_pending');
    expect(decodeURIComponent(safeInternalReturnHref('/dashboard/catalog?q=WM0043&warehouse=越南青林湾仓库&page=2') ?? ''))
      .toBe('/dashboard/catalog?q=WM0043&warehouse=越南青林湾仓库&page=2');
    expect(safeInternalReturnHref('/dashboard/catalog/sources?scope=abc&item=def')).toBe('/dashboard/catalog/sources?scope=abc&item=def');
  });

  it('拒绝外部 URL、协议相对地址、反斜杠与控制字符', () => {
    expect(safeInternalReturnHref('https://evil.example/dashboard/catalog')).toBeUndefined();
    expect(safeInternalReturnHref('//evil.example/dashboard')).toBeUndefined();
    expect(safeInternalReturnHref('/\\evil.example')).toBeUndefined();
    expect(safeInternalReturnHref('\\\\evil.example\\dashboard')).toBeUndefined();
    expect(safeInternalReturnHref('javascript:alert(1)')).toBeUndefined();
    expect(safeInternalReturnHref('/dashboard/catalog\\..\\etc')).toBeUndefined();
    expect(safeInternalReturnHref('/dashboard/\u0000catalog')).toBeUndefined();
    expect(safeInternalReturnHref('issues')).toBeUndefined();
    expect(safeInternalReturnHref('/dashboard')).toBeUndefined();
    expect(safeInternalReturnHref('/other/dashboard/catalog')).toBeUndefined();
    expect(safeInternalReturnHref('')).toBeUndefined();
    expect(safeInternalReturnHref(undefined)).toBeUndefined();
    expect(safeInternalReturnHref(null)).toBeUndefined();
    expect(safeInternalReturnHref(['/dashboard/catalog', '/dashboard/catalog/sources'])).toBe('/dashboard/catalog');
  });

  it('拒绝路径穿越与超长值', () => {
    expect(safeInternalReturnHref('/dashboard/catalog/../admin')).toBeUndefined();
    expect(safeInternalReturnHref('/dashboard/catalog/%2e%2e/admin')).toBeUndefined();
    expect(safeInternalReturnHref('/dashboard/catalog/%2f%2e%2e%2fadmin')).toBeUndefined();
    expect(safeInternalReturnHref(`/dashboard/catalog?q=${'x'.repeat(600)}`)).toBeUndefined();
  });

  it('拒绝旧详情 pathname 与嵌套 from，避免返回循环', () => {
    expect(safeInternalReturnHref('/dashboard/catalog/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')).toBeUndefined();
    expect(safeInternalReturnHref('/dashboard/catalog?from=%2Fdashboard%2Fcatalog%2Fissues')).toBeUndefined();
  });

  it('识别“来自待处理索引”的返回点（含查询参数）', () => {
    expect(isIssuesReturnHref(ISSUES_RETURN_HREF)).toBe(true);
    expect(isIssuesReturnHref('/dashboard/catalog/issues?kind=brush_pending')).toBe(true);
    expect(isIssuesReturnHref('/dashboard/catalog')).toBe(false);
    expect(isIssuesReturnHref('/dashboard/catalog/sources?item=x')).toBe(false);
    expect(isIssuesReturnHref(undefined)).toBe(false);
    expect(isIssuesReturnHref('https://evil.example')).toBe(false);
  });
});

describe('from 参数构造（不嵌套、不自循环）', () => {
  it('给既有查询串追加编码后的 from', () => {
    const target = '/dashboard/catalog/issues?kind=brush_pending';
    expect(appendReturnContext(target, ISSUES_RETURN_HREF))
      .toBe(`${target}&from=${encodeURIComponent(ISSUES_RETURN_HREF)}`);
    expect(appendReturnContext('/dashboard/catalog?detail=abc', ISSUES_RETURN_HREF))
      .toBe(`/dashboard/catalog?detail=abc&from=${encodeURIComponent(ISSUES_RETURN_HREF)}`);
  });

  it('不安全的 from 不会进入链接', () => {
    expect(appendReturnContext('/dashboard/catalog', 'https://evil.example')).toBe('/dashboard/catalog');
    expect(appendReturnContext('/dashboard/catalog', '//evil.example')).toBe('/dashboard/catalog');
    expect(appendReturnContext('/dashboard/catalog', undefined)).toBe('/dashboard/catalog');
  });

  it('已有 from 的返回点不再嵌套（避免 URL 无限增长与返回环）', () => {
    const nested = `/dashboard/catalog/issues?from=${encodeURIComponent('/dashboard/catalog')}`;
    expect(appendReturnContext('/dashboard/catalog?detail=abc', nested)).toBe('/dashboard/catalog?detail=abc');
    // 二次追加也只保留一层
    const once = appendReturnContext('/dashboard/catalog?detail=abc', ISSUES_RETURN_HREF);
    const twice = appendReturnContext(once, once);
    expect(twice.match(/from=/g)).toHaveLength(1);
  });

  it('返回点与目标完全相同时不追加（自引用）', () => {
    const href = '/dashboard/catalog/issues';
    expect(appendReturnContext(href, href)).toBe(href);
  });

  it('返回点常量是站内路径', () => {
    expect(issuesReturnHref()).toBe('/dashboard/catalog/issues');
    expect(safeInternalReturnHref(issuesReturnHref())).toBe('/dashboard/catalog/issues');
  });
});
