import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { resolve, relative, dirname, sep, extname, isAbsolute } from 'node:path';
import { isBuiltin } from 'node:module';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const json = path => JSON.parse(readFileSync(path, 'utf8'));
const manifest = json(resolve(root, 'package.json'));
const inventory = json(resolve(root, 'inventory.json'));
for (const [path, preview] of [
  ['package.json', 'demo.gif'],
  ...inventory.extensions.map(({ directory }) => [`packages/${directory}/package.json`, `packages/${directory}/screenshot.png`]),
]) {
  const pkg = json(resolve(root, path));
  assert.ok(pkg.files.includes('CHANGELOG.md'), `${pkg.name}: CHANGELOG.md must ship in the tarball`);
  assert.ok(existsSync(resolve(root, dirname(path), 'CHANGELOG.md')), `${pkg.name}: missing CHANGELOG.md`);
  for (const keyword of ['pi-package', 'pi-extension']) {
    assert.ok(pkg.keywords?.includes(keyword), `${pkg.name}: missing gallery keyword ${keyword}`);
  }
  assert.equal(pkg.keywords.includes('pi-skill'), Boolean(pkg.pi.skills?.length), `${pkg.name}: skill classification must match bundled skills`);
  assert.equal(pkg.pi.image, `https://raw.githubusercontent.com/saifymatteo/pi-extensions/main/${preview}`, `${pkg.name}: gallery preview URL must match its asset`);
  assert.ok(existsSync(resolve(root, preview)), `${pkg.name}: missing gallery preview asset`);
}
const hostPackages = new Set(['@earendil-works/pi-ai', '@earendil-works/pi-agent-core', '@earendil-works/pi-coding-agent', '@earendil-works/pi-tui', 'typebox']);
const files = directory => readdirSync(directory, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? files(resolve(directory, entry.name)) : [resolve(directory, entry.name)]);
const inside = (path, directory) => { const rel = relative(directory, path); return rel === '' || (!rel.startsWith('..' + sep) && rel !== '..' && !isAbsolute(rel)); };
const actual = readdirSync(resolve(root, 'packages'), { withFileTypes: true }).filter(e => e.isDirectory()).map(e => e.name).sort();
assert.deepEqual(actual, inventory.extensions.map(e => e.directory).sort(), 'Package inventory drift');
assert.equal(manifest.name, '@saifymatteo/pi-extensions');
assert.equal(manifest.private, undefined, 'Root must stay publishable');
assert.equal(manifest.license, 'AGPL-3.0-only');
assert.deepEqual(manifest.publishConfig, { access: 'public' });
assert.ok(manifest.files.includes('packages'), 'Root tarball must bundle the packages');
// The collection adds one entry of its own: the /pi-extensions hub, loaded last.
assert.deepEqual([...manifest.pi.extensions].sort(), [...inventory.extensions.map(e => `./collection/${e.directory}.ts`), './collection/pi-extensions.ts'].sort());
assert.equal(manifest.pi.extensions.at(-1), './collection/pi-extensions.ts', 'The hub loads after every package');
assert.equal(manifest.pi.extensions[0], './collection/pi-load-pi-dotenv.ts', 'Load environment before configured services');
for (const { directory } of inventory.extensions) {
  assert.equal(readFileSync(resolve(root, 'collection', `${directory}.ts`), 'utf8'), `import extension from "../packages/${directory}/src/index.ts";\nimport { gate } from "./gate.ts";\n\nexport default gate("${directory}", extension);\n`, `collection/${directory}.ts: wrapper drift`);
}
assert.deepEqual(json(resolve(root, 'schemas/pi-extensions.schema.json')).properties.disabled.items.enum, inventory.extensions.map(e => e.directory), 'Collection schema drift');
{
  // /pi-extensions lists every package by gate name.
  const hub = readFileSync(resolve(root, 'collection/pi-extensions.ts'), 'utf8');
  const listed = [...hub.slice(hub.indexOf('const PACKAGES'), hub.indexOf('];', hub.indexOf('const PACKAGES'))).matchAll(/"(pi-[a-z0-9-]+)"/g)].map(m => m[1]);
  assert.deepEqual(listed, inventory.extensions.map(e => e.directory), 'collection/pi-extensions.ts PACKAGES drift from inventory.json');
}
// Shared /<command> settings dialog: every package's copy must match pi-x-ide's.
const dialogSource = readFileSync(resolve(root, 'packages/pi-x-ide/src/settings-dialog.ts'), 'utf8');
for (const directory of actual) {
  const copy = resolve(root, 'packages', directory, 'src/settings-dialog.ts');
  if (existsSync(copy)) assert.equal(readFileSync(copy, 'utf8'), dialogSource, `${directory}: src/settings-dialog.ts drifted from pi-x-ide`);
}
assert.equal(readFileSync(resolve(root, 'packages/pi-decisions/schemas/service-models.schema.json'), 'utf8'), readFileSync(resolve(root, 'packages/pi-tts/schemas/service-models.schema.json'), 'utf8'), 'service-models schema copies drift');
for (const skillPath of manifest.pi.skills ?? []) {
  assert.ok(existsSync(resolve(root, skillPath)), `root: skill path not found: ${skillPath}`);
}
let count = 0;
for (const { directory } of inventory.extensions) {
  const packageRoot = resolve(root, 'packages', directory);
  const pkg = json(resolve(packageRoot, 'package.json'));
  assert.equal(pkg.name, `@saifymatteo/${directory}`);
  assert.equal(pkg.private, undefined, `${directory}: packages must stay publishable`);
  assert.equal(pkg.license, 'AGPL-3.0-only');
  assert.deepEqual(pkg.publishConfig, { access: 'public' });
  assert.deepEqual(pkg.pi.extensions, ['./src/index.ts']);
  assert.ok(pkg.files.includes('src') && pkg.files.includes('README.md') && pkg.files.includes('NOTICE.md'));
  for (const name of ['README.md', 'NOTICE.md', 'LICENSE', 'src/index.ts']) assert.ok(existsSync(resolve(packageRoot, name)), `${directory}: missing ${name}`);
  assert.ok(pkg.files.includes('LICENSE'), `${directory}: LICENSE must ship in the tarball`);
  for (const skillPath of pkg.pi.skills ?? []) {
    assert.ok(pkg.files.some(entry => skillPath.startsWith(`./${entry}`) || skillPath === `./${entry}`), `${directory}: skill path must ship in the tarball`);
    const skillRoot = resolve(packageRoot, skillPath);
    assert.ok(files(skillRoot).some(path => path.split(/[\\/]/).at(-1) === 'SKILL.md'), `${directory}: skill ${skillPath} missing SKILL.md`);
  }
  for (const path of files(packageRoot).filter(p => p.endsWith('.ts'))) {
    const source = readFileSync(path, 'utf8');
    assert.ok(!source.includes('[Showing lines '), `${path}: incomplete source read`);
    const parsed = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
    assert.equal(parsed.parseDiagnostics.length, 0, `${path}: invalid TypeScript syntax`);
    const imports = [];
    function visit(node) {
      if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) imports.push(node.moduleSpecifier.text);
      if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === 'require')) && node.arguments[0] && ts.isStringLiteral(node.arguments[0])) imports.push(node.arguments[0].text);
      ts.forEachChild(node, visit);
    }
    visit(parsed);
    for (const spec of imports) {
      if (spec.startsWith('.')) {
        const target = resolve(dirname(path), spec);
        assert.ok(inside(target, packageRoot), `${directory}: import escapes package: ${spec}`);
        assert.ok([target, target + '.ts', target + '.js', target.replace(/\.js$/, '.ts'), resolve(target, 'index.ts')].some(existsSync), `${path}: unresolved ${spec}`);
      } else if (!isBuiltin(spec)) {
        const dep = spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0];
        assert.ok(pkg.peerDependencies?.[dep] || pkg.dependencies?.[dep] || ((/[\\/]tests?[\\/]/.test(path) || path.endsWith("vitest.config.ts")) && pkg.devDependencies?.[dep]), `${directory}: undeclared dependency ${dep}`);
        if (hostPackages.has(dep)) {
          assert.equal(pkg.peerDependencies?.[dep], '*', `${directory}: host API must be a peer`);
          assert.ok(!pkg.dependencies?.[dep], `${directory}: do not bundle the host`);
        }
      }
    }
    count++;
  }
  for (const path of files(packageRoot)) {
    const name = path.split(/[\\/]/).at(-1);
    assert.ok(!['auth.json', 'coding-agent.json', '.env'].includes(name), `${directory}: personal file included`);
    if (extname(path) === '.json' && name !== 'package.json' && !name.endsWith('.schema.json')) assert.ok(name.endsWith('.example.json') || name.endsWith('.example'), `${directory}: config must be an explicit example: ${name}`);
  }
}
console.log(`Checked ${actual.length} standalone packages and ${count} TypeScript files: inventory, entrypoints, syntax, contained imports, dependencies, publication fields, changelogs, and example-only configs.`);
console.log('This is NOT semantic typechecking or a live-host/UI compatibility test.');
