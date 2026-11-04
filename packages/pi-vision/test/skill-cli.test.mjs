import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const skill = fileURLToPath(new URL('../skills/vision-tools/', import.meta.url));

test('skill command examples invoke bundled Python scripts independently of PATH and cwd', () => {
  const docs = [join(skill, 'SKILL.md'), ...readdirSync(join(skill, 'references')).map(name => join(skill, 'references', name))];
  const launchers = new Set();
  for (const doc of docs) {
    const source = readFileSync(doc, 'utf8');
    for (const [, commands] of source.matchAll(/```bash\n([\s\S]*?)```/g)) {
      assert.equal(/^\s*(?:crop|detect|glance|ground|trace|vision-doctor)\s+\S/m.test(commands), false, `${doc}: bare launcher command`);
    }
    assert.equal(/python3 scripts\//.test(source), false, `${doc}: cwd-relative script path`);
    for (const [, relative] of source.matchAll(/python3 "<skill-dir>\/([^"]+)"/g)) {
      assert.ok(existsSync(join(skill, relative)), `${doc}: missing bundled script ${relative}`);
      if (relative.startsWith('bin/')) launchers.add(relative.slice(4));
    }
  }
  assert.deepEqual([...launchers].sort(), ['crop', 'detect', 'glance', 'ground', 'trace', 'vision-doctor'].sort());
});

test('automated OCR finds bundled glance without PATH, including non-executable paths with spaces', t => {
  const python = [['python3'], ['python'], ['py', '-3']].find(([command, ...args]) => {
    const result = spawnSync(command, [...args, '--version'], { encoding: 'utf8', timeout: 10_000 });
    return result.status === 0 && /^Python 3\./.test(result.stdout);
  });
  if (!python) return t.skip('Python 3 is not installed');
  const code = `
import importlib.util
from pathlib import Path
import subprocess
import sys
import tempfile
from unittest.mock import patch

source = Path(sys.argv[1])
spec = importlib.util.spec_from_file_location("long_screenshot_ocr", source)
module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = module
spec.loader.exec_module(module)
with tempfile.TemporaryDirectory(prefix="vision skill ") as directory:
    skill = Path(directory)
    script = skill / "scripts" / "long_screenshot_ocr.py"
    script.parent.mkdir()
    script.touch()
    glance = skill / "bin" / "glance"
    glance.parent.mkdir()
    glance.write_text('print("bundled glance reached")', encoding="utf-8")
    with patch.object(module, "__file__", str(script)), patch.object(module.shutil, "which", return_value=None):
        command = module.resolve_glance_command()
    assert command == [sys.executable, str(glance)], command
    result = subprocess.run(command, capture_output=True, text=True, check=True)
    assert result.stdout.strip() == "bundled glance reached", result.stdout
    with patch.object(module, "__file__", str(script)), patch.object(module.shutil, "which", return_value="/unrelated/glance"):
        assert module.resolve_glance_command() == command, "prefer the packaged script over unrelated PATH commands"
    glance.unlink()
    external = skill / "custom_glance.py"
    external.touch()
    with patch.object(module, "__file__", str(script)), patch.object(module.shutil, "which", return_value=str(external)):
        assert module.resolve_glance_command() == [sys.executable, str(external)], "retain the external fallback"
`;
  const result = spawnSync(python[0], [...python.slice(1), '-c', code, join(skill, 'scripts', 'long_screenshot_ocr.py')], {
    encoding: 'utf8', timeout: 20_000, env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
  });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
});
