/**
 * the preset patch stays in step with the plugin schema.
 *
 * privacy-guard: allow — a fixture set: it writes home paths, boundary paths and secret literals
 * into throwaway repositories to prove what the guards refuse.
 */


// ── Preset patch ↔ schema drift guard ─────────────────────────────────────────
// The preset row is the only place the Loader takes this plugin's config from. When the
// schema renames a field and the patch is not updated (this happened on 2026-10-16:
// `digestTailLimits` survived the v4 rename to `documentBudgets`), every session on the — vocabulary-guard: allow
// preset fails to resume with `invalid config: unknown config field ...`. Validate the
// shipped row through the same Standard Schema the Loader uses, so `npm test` catches it.
{
  const patchPath = [
    join(dirname(pluginPath), '..', 'cordis.patch.yml'), // argv[2] = plugin/index.js
    join(dirname(pluginPath), 'cordis.patch.yml'),       // argv[2] = .../plugin
    join(pluginPath, 'cordis.patch.yml'),                // argv[2] = package root
    join(pluginPath, '..', 'cordis.patch.yml'),
  ].find((candidate) => existsSync(candidate));
  assert.ok(patchPath, 'cordis.patch.yml found next to the plugin package');
  const patchLines = readFileSync(patchPath, 'utf8').split(/\r?\n/);
  const rowIndex = patchLines.findIndex((line) => /^\s*-\s+id:\s*project-forge\s*$/.test(line));
  assert.ok(rowIndex >= 0, 'preset patch declares the project-forge plugin row');

  let nameLine = -1;
  let configLine = -1;
  for (let i = rowIndex + 1; i < patchLines.length; i++) {
    if (/^\s*(#|$)/.test(patchLines[i])) continue;
    if (/^\s*-\s+id:/.test(patchLines[i])) break; // next row
    if (/^\s*name:/.test(patchLines[i])) nameLine = i;
    if (/^\s*config:\s*$/.test(patchLines[i])) { configLine = i; break; }
  }
  assert.ok(nameLine >= 0 && configLine >= 0, 'patch row has a name and a config block');
  const pkg = JSON.parse(readFileSync(join(dirname(patchPath), 'package.json'), 'utf8'));
  assert.equal(
    patchLines[nameLine].replace(/^\s*name:\s*/, '').replace(/^['"]|['"]$/g, ''),
    pkg.name,
    'patch row loads this package',
  );

  // Direct children of `config:` are scalars; any nested mapping (e.g. documentBudgets)
  // is collected as an object of its own scalar children.
  const configIndent = patchLines[configLine].match(/^\s*/)[0].length;
  const parseScalar = (text) => {
    const value = text.trim().replace(/\s+#.*$/, '');
    if (value === 'true' || value === 'false') return value === 'true';
    if (/^-?\d+$/.test(value)) return Number(value);
    if (/^\[.*\]$/.test(value)) return value.slice(1, -1).split(',').map((item) => item.trim()).filter(Boolean);
    return value.replace(/^['"]|['"]$/g, '');
  };
  const rowConfig = {};
  let childIndent = -1;
  let currentKey = null;
  for (let i = configLine + 1; i < patchLines.length; i++) {
    const line = patchLines[i];
    if (/^\s*(#|$)/.test(line)) continue;
    const indent = line.match(/^\s*/)[0].length;
    if (indent <= configIndent) break;
    const entry = /^\s*([A-Za-z_][\w]*):\s*(.*)$/.exec(line);
    if (!entry) continue;
    const key = entry[1];
    const rawValue = entry[2] ?? '';
    if (childIndent < 0) childIndent = indent;
    if (indent > childIndent) {
      if (currentKey !== null && rowConfig[currentKey] !== null && typeof rowConfig[currentKey] === 'object') {
        rowConfig[currentKey][key] = parseScalar(rawValue);
      }
      continue;
    }
    currentKey = key;
    rowConfig[key] = rawValue.trim() === '' ? {} : parseScalar(rawValue);
  }

  const checked = standard.validate(rowConfig);
  assert.ok(
    !('issues' in checked),
    `preset patch config satisfies the plugin schema: ${JSON.stringify(checked.issues ?? [])}`,
  );
}


