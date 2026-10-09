// Rebuild the final delivery in a fresh temporary directory, never in production.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');

test('offline final493 generators reproduce all shipped installation bytes, without any rejected draft or simulation inputs', () => {
  const manifest = JSON.parse(fs.readFileSync('data/wordbook-review/fixed-pool-v2.install-manifest.json', 'utf8'));
  const generators = ['scripts/build-wordbook-choice-preference-tags.cjs', 'scripts/build-wordbook-approved-pool-install.cjs'];
  const files = [...generators, ...Object.keys(manifest.files)];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tps-wordbook-delivery-'));
  try {
    for (const file of files) {
      const destination = path.join(dir, file);
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.copyFileSync(file, destination);
    }
    for (const file of generators) execFileSync(process.execPath, [file], { cwd: dir, stdio: 'pipe' });
    for (const file of [...Object.keys(manifest.files), 'data/wordbook-review/fixed-pool-v2.install-manifest.json']) {
      assert.deepEqual(fs.readFileSync(path.join(dir, file)), fs.readFileSync(file), file);
    }
    // Only the active manifest is added. Deleted approval/CSV/preflight archives
    // must not silently return as generated outputs.
    function list(directory, relative = '') {
      return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
        const name = path.join(relative, entry.name), full = path.join(directory, entry.name);
        return entry.isDirectory() ? list(full, name) : [name];
      });
    }
    assert.deepEqual(list(dir).sort(), [...files, 'data/wordbook-review/fixed-pool-v2.install-manifest.json'].sort());
  } finally {
    // Only our uniquely named temporary fixture, never a checkout/output root.
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
