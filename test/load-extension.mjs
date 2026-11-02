import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve, extname } from 'node:path';
import { createRequire, isBuiltin } from 'node:module';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import ts from 'typescript';

const nativeRequire = createRequire(import.meta.url);

/** Test-only loader: transpiles local TS and requires explicit stubs for host APIs. */
export function loadExtension(file, stubs = {}, globals = {}) {
  const cache = new Map();
  function load(filename) {
    filename = resolve(filename instanceof URL ? fileURLToPath(filename) : filename);
    if (cache.has(filename)) return cache.get(filename).exports;
    const module = { exports: {} };
    cache.set(filename, module);
    const source = readFileSync(filename, 'utf8');
    const result = ts.transpileModule(source, {
      fileName: filename,
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
      reportDiagnostics: true,
    });
    const errors = (result.diagnostics ?? []).filter(d => d.category === ts.DiagnosticCategory.Error);
    if (errors.length) throw new Error(ts.formatDiagnosticsWithColorAndContext(errors, {
      getCanonicalFileName: p => p, getCurrentDirectory: () => process.cwd(), getNewLine: () => '\n',
    }));
    const require = spec => {
      if (Object.hasOwn(stubs, spec)) return stubs[spec];
      if (spec.startsWith('.')) {
        const candidate = resolve(dirname(filename), spec);
        const target = extname(candidate) ? candidate : [candidate + '.ts', candidate + '.js', resolve(candidate, 'index.ts')].find(existsSync);
        if (!target) throw new Error(`Cannot resolve ${spec} from ${filename}`);
        return load(target);
      }
      if (isBuiltin(spec) || spec === 'typebox') return nativeRequire(spec);
      throw new Error(`Missing explicit test stub for ${spec} in ${filename}`);
    };
    const context = vm.createContext({
      module, exports: module.exports, require, __filename: filename, __dirname: dirname(filename),
      process, Buffer, console, URL, URLSearchParams, AbortController, AbortSignal, TextEncoder, TextDecoder,
      setTimeout, clearTimeout, setInterval, clearInterval, queueMicrotask, structuredClone,
      ...globals,
    });
    new vm.Script(result.outputText, { filename }).runInContext(context);
    return module.exports;
  }
  return load(file);
}
