import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, relative, resolve, sep } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const ROOT = process.cwd();
const DEMO_ROOT = resolve(ROOT, 'src/features/ice-demo');
const ROUTE_ROOT = resolve(ROOT, 'src/app/demo/ice-v4');
const ROUTE_FILE = resolve(ROUTE_ROOT, 'page.tsx');

function filesUnder(directory: string): string[] {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name);
    return entry.isDirectory() ? filesUnder(path) : [path];
  });
}

function inside(path: string, directory: string): boolean {
  const fromDirectory = relative(directory, path);
  return fromDirectory === ''
    || (!fromDirectory.startsWith(`..${sep}`) && fromDirectory !== '..' && !fromDirectory.includes(':'));
}

function runtimeFiles(): string[] {
  return [...filesUnder(DEMO_ROOT), ...filesUnder(ROUTE_ROOT)]
    .filter((path) => /\.(?:ts|tsx|css)$/.test(path) && !/\.test\.tsx?$/.test(path));
}

function syntaxTree(path: string): ts.SourceFile {
  return ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true,
    path.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
}

function visit(tree: ts.Node, callback: (node: ts.Node) => void): void {
  callback(tree);
  ts.forEachChild(tree, (node) => visit(node, callback));
}

describe('ICE v4 Demo is isolated from the live application', () => {
  it('exists outside dashboard and has production demo files, not only tests', () => {
    expect(existsSync(ROUTE_FILE)).toBe(true);
    expect(runtimeFiles().some((path) => inside(path, DEMO_ROOT) && path.endsWith('.tsx'))).toBe(true);
    expect(relative(ROOT, ROUTE_FILE).split(sep)).not.toContain('dashboard');
  });

  it('imports only its own code, presentational primitives, and approved browser libraries', () => {
    const violations: string[] = [];
    const presentationLibraries = new Set(['react', 'lucide-react']);
    for (const path of runtimeFiles().filter((entry) => !entry.endsWith('.css'))) {
      visit(syntaxTree(path), (node) => {
        if (!ts.isImportDeclaration(node) && !ts.isExportDeclaration(node)) return;
        if (!node.moduleSpecifier || !ts.isStringLiteral(node.moduleSpecifier)) return;
        const dependency = node.moduleSpecifier.text;
        if (presentationLibraries.has(dependency)) return;
        if (dependency === 'next' && ts.isImportDeclaration(node) && node.importClause?.isTypeOnly) return;
        const target = dependency.startsWith('@/')
          ? resolve(ROOT, 'src', dependency.slice(2))
          : dependency.startsWith('.') ? resolve(dirname(path), dependency) : null;
        if (target && (inside(target, DEMO_ROOT) || inside(target, ROUTE_ROOT))) {
          const resolved = ['', '.ts', '.tsx', '.css', '/index.ts', '/index.tsx']
            .some((extension) => existsSync(`${target}${extension}`));
          if (!resolved) violations.push(`${relative(ROOT, path)} cannot resolve ${dependency}`);
          return;
        }
        if (target && (inside(target, resolve(ROOT, 'src/components/ui'))
          || target === resolve(ROOT, 'src/lib/utils'))) return;
        // 已批准的共享视觉层：Demo 与真实商品库共用同一套视觉 token/类名（纯 CSS，不含数据、
        // 权限或业务逻辑）。本包 F17 按产品方向更新该条判定；隔离的其余安全断言（无 process/
        // fetch/Server Action/网络/认证布局等）全部保留，不因此放宽。
        if (target && inside(target, resolve(ROOT, 'src/ui/shared')) && dependency.endsWith('.module.css')) return;
        violations.push(`${relative(ROOT, path)} imports ${dependency}`);
      });
    }
    expect(violations).toEqual([]);
  });

  it('has no Server Actions, environment access, dynamic dependencies, or network calls', () => {
    const violations: string[] = [];
    const forbiddenIdentifiers = new Set([
      'process', 'fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource', 'sendBeacon',
      'createClient', 'createServiceClient', 'requireActiveAuth', 'requireActiveAdmin',
    ]);
    for (const path of runtimeFiles().filter((entry) => !entry.endsWith('.css'))) {
      visit(syntaxTree(path), (node) => {
        const location = relative(ROOT, path);
        if (ts.isIdentifier(node) && forbiddenIdentifiers.has(node.text)) {
          violations.push(`${location}: ${node.text}`);
        }
        if (ts.isExpressionStatement(node) && ts.isStringLiteral(node.expression)
          && node.expression.text === 'use server') {
          violations.push(`${location}: use server`);
        }
        if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword
          || (ts.isIdentifier(node.expression) && node.expression.text === 'require'))) {
          violations.push(`${location}: dynamic dependency`);
        }
        if (ts.isMetaProperty(node)) violations.push(`${location}: import.meta`);
        if (ts.isImportEqualsDeclaration(node)) violations.push(`${location}: import equals`);
      });
    }
    expect(violations).toEqual([]);
  });

  it('does not create a business API route or persist demo changes in browser storage', () => {
    expect(filesUnder(ROUTE_ROOT).filter((path) => /(?:^|[\\/])route\.[cm]?[jt]sx?$/.test(path))).toEqual([]);
    const offenders = runtimeFiles().filter((path) => {
      if (path.endsWith('.css')) return false;
      let foundStorage = false;
      visit(syntaxTree(path), (node) => {
        if (ts.isIdentifier(node) && ['localStorage', 'sessionStorage', 'indexedDB'].includes(node.text)) {
          foundStorage = true;
        }
      });
      return foundStorage;
    });
    expect(offenders).toEqual([]);
  });

  it('has no remote asset or stylesheet dependencies hidden in the demo', () => {
    const offenders = runtimeFiles().filter((path) => /(?:https?:)?\/\//.test(
      readFileSync(path, 'utf8').split('\n').filter((line) => !/^\s*\/\//.test(line)).join('\n'),
    ));
    expect(offenders).toEqual([]);
  });

  it('keeps the proxy matcher limited to the existing authenticated routes', () => {
    const proxy = syntaxTree(resolve(ROOT, 'src/proxy.ts'));
    const matchers: string[] = [];
    visit(proxy, (node) => {
      if (!ts.isPropertyAssignment(node) || node.name.getText(proxy) !== 'matcher'
        || !ts.isArrayLiteralExpression(node.initializer)) return;
      for (const element of node.initializer.elements) {
        if (ts.isStringLiteral(element)) matchers.push(element.text);
      }
    });
    expect(matchers).toEqual(['/dashboard/:path*', '/auth/login']);
    expect(matchers.some((matcher) => matcher.includes('demo'))).toBe(false);
  });

  it('does not add a real-auth layout above the isolated route', () => {
    const possibleLayouts = [
      resolve(ROOT, 'src/app/layout.tsx'),
      resolve(ROOT, 'src/app/demo/layout.tsx'),
      resolve(ROUTE_ROOT, 'layout.tsx'),
    ].filter(existsSync);
    const violations: string[] = [];
    for (const path of possibleLayouts) {
      const source = readFileSync(path, 'utf8');
      if (/supabase|@\/lib\/auth|@\/features\/(?!ice-demo)|requireActive|createServiceClient|process\.env/.test(source)) {
        violations.push(relative(ROOT, path));
      }
    }
    expect(violations).toEqual([]);
  });
});
