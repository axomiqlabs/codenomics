import fs from 'node:fs';
import { loadConfig } from '../../core/config.js';
import { readDiagnostics } from '../../core/engine.js';
import { dataDir } from '../../core/config.js';
import { indexPath } from '../../core/store.js';
import { allCollectors } from '../../collectors/registry.js';

export async function run(_argv: string[]): Promise<number> {
  const loaded = loadConfig();
  let problems = 0;

  console.log('# config');
  console.log(`user config:    ${loaded.userPath}${fs.existsSync(loaded.userPath) ? '' : '  (missing — run codenomics init)'}`);
  console.log(`project config: ${loaded.projectPath ?? '(none)'}`);
  console.log(`data dir:       ${dataDir()}`);
  for (const p of loaded.problems) {
    console.log(`  ✗ ${p}`);
    problems++;
  }
  if (!loaded.problems.length) console.log('  ✓ config valid');

  console.log('\n# collectors');
  for (const c of allCollectors()) {
    const vcfg = loaded.config.collectors[c.vendor];
    const enabled = vcfg?.enabled !== false;
    const roots = vcfg?.root ? [vcfg.root] : c.defaultRoots();
    const existing = roots.filter((r) => fs.existsSync(r));
    const state = !enabled ? 'disabled' : existing.length ? `roots: ${existing.join(', ')}` : `no logs found (looked in ${roots.join(', ')})`;
    console.log(`${c.vendor.padEnd(12)} ${state}`);
    const caps = c.capabilities;
    console.log(
      `             capabilities: commits=${caps.commits} activeTime=${caps.activeTime} cacheSplit=${caps.cacheWriteSplit} source=${caps.sourceDetection} promptText=${caps.promptText}`,
    );
  }

  console.log('\n# last index run');
  const diag = readDiagnostics();
  if (!diag) {
    console.log(`none yet (no ${indexPath()}) — run codenomics index`);
  } else {
    console.log(`at ${new Date(diag.at).toISOString()}`);
    for (const [vendor, st] of Object.entries(diag.perVendor)) {
      console.log(`${vendor.padEnd(12)} ${st.files} files, ${st.sessions} sessions, ${st.errors} quarantined`);
      const driftEntries = Object.entries(st.drift).sort((a, b) => b[1] - a[1]);
      for (const [kind, count] of driftEntries.slice(0, 10)) {
        console.log(`  drift: ${kind} ×${count}`);
      }
      if (driftEntries.length > 10) console.log(`  …and ${driftEntries.length - 10} more kinds`);
    }
    if (diag.quarantine.length) {
      console.log('\n# quarantined files (parse failed; retried when the file changes)');
      for (const q of diag.quarantine.slice(0, 20)) {
        console.log(`  ${q.vendor}: ${q.path}\n    ${q.error}`);
        problems++;
      }
    }
  }

  console.log(problems ? `\n${problems} problem(s) found` : '\nall clear');
  return problems ? 1 : 0;
}
