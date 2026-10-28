/**
 * Tiny on-the-fly TypeScript loader for the local build scripts.
 *
 * The snapshot/simulation builders must reuse the EXACT pure functions and
 * hashing helpers implemented in `src/features/catalog/product-source/*`
 * (single source of truth). Node cannot import `.ts` directly, and the project
 * must not gain new dependencies, so this loader transpiles the required TS
 * modules with the already-declared `typescript` devDependency into a temp
 * directory and imports them as ESM. No type checking is done here (vitest/tsc
 * cover that).
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ts = require('typescript');

const STATIC_RELATIVE_IMPORT = /(from\s*)(['"])(\.[^'"]+)\2/g;
const DYNAMIC_RELATIVE_IMPORT = /(import\s*\(\s*)(['"])(\.[^'"]+)\2(\s*\))/g;

function replaceSpecifier(code, specifier, replacement) {
  return code
    .split(`'${specifier}'`)
    .join(`'${replacement}'`)
    .split(`"${specifier}"`)
    .join(`"${replacement}"`);
}

export function createTsLoader({ tempDir }) {
  const outRoot = path.join(tempDir, 'ts-out');
  /** @type {Map<string, string>} */
  const outputs = new Map();

  async function resolveSpecifier(fromFile, specifier) {
    const base = path.resolve(path.dirname(fromFile), specifier);
    const candidates = [];
    if (path.extname(base)) candidates.push(base);
    candidates.push(`${base}.ts`, `${base}.tsx`, path.join(base, 'index.ts'));
    for (const candidate of candidates) {
      try {
        const stat = await fs.stat(candidate);
        if (stat.isFile()) return candidate;
      } catch {
        // keep trying
      }
    }
    return null;
  }

  function outPathFor(fileAbs) {
    const relative = path.relative(process.cwd(), fileAbs).replace(/\\/g, '/');
    return path.join(outRoot, relative.replace(/\.(ts|tsx)$/, '.mjs'));
  }

  async function transpileFile(fileAbs) {
    if (outputs.has(fileAbs)) return outputs.get(fileAbs);
    const outFile = outPathFor(fileAbs);
    outputs.set(fileAbs, outFile);

    const source = await fs.readFile(fileAbs, 'utf8');
    const transpiled = ts.transpileModule(source, {
      fileName: fileAbs,
      compilerOptions: {
        module: ts.ModuleKind.ESNext,
        target: ts.ScriptTarget.ES2022,
        isolatedModules: true,
        esModuleInterop: true,
      },
    });
    let code = transpiled.outputText;

    const specifiers = new Set();
    for (const match of code.matchAll(STATIC_RELATIVE_IMPORT)) specifiers.add(match[3]);
    for (const match of code.matchAll(DYNAMIC_RELATIVE_IMPORT)) specifiers.add(match[3]);

    for (const specifier of specifiers) {
      const target = await resolveSpecifier(fileAbs, specifier);
      if (!target) throw new Error(`TS_LOADER_UNRESOLVED_IMPORT:${fileAbs}:${specifier}`);
      const targetOutFile = await transpileFile(target);
      let relative = path.relative(path.dirname(outFile), targetOutFile).split(path.sep).join('/');
      if (!relative.startsWith('.')) relative = `./${relative}`;
      code = replaceSpecifier(code, specifier, relative);
    }

    await fs.mkdir(path.dirname(outFile), { recursive: true });
    await fs.writeFile(outFile, code, 'utf8');
    return outFile;
  }

  return {
    async load(entryPath) {
      const outFile = await transpileFile(path.resolve(entryPath));
      return import(pathToFileURL(outFile).href);
    },
  };
}
