import { parseArgs } from 'node:util';
import { loadConfig } from '../../core/config.js';
import { runIndex } from '../../core/engine.js';
import { evaluateBudgets } from '../../core/budgets.js';
import { allCollectors } from '../../collectors/registry.js';

export async function run(argv: string[]): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      vendor: { type: 'string' },
      'check-budgets': { type: 'boolean', default: false },
      help: { type: 'boolean', default: false },
    },
  });
  if (values.help) {
    console.log('usage: codenomics index [--vendor <claude-code|codex|gemini>] [--check-budgets]');
    return 0;
  }

  const { config, problems } = loadConfig();
  for (const p of problems) console.error(`config warning: ${p}`);

  const started = Date.now();
  const result = await runIndex(config, allCollectors(), values.vendor ? { vendor: values.vendor } : {});

  for (const [vendor, st] of Object.entries(result.perVendor)) {
    const drift = Object.keys(st.drift).length;
    console.log(
      `${vendor.padEnd(12)} ${String(st.sessions).padStart(5)} sessions  (${st.files} files: ${st.parsed} parsed, ${st.fromCache} cached${st.errors ? `, ${st.errors} quarantined` : ''}${drift ? `, drift: ${drift} kinds — run \`codenomics doctor\`` : ''})`,
    );
  }
  console.log(`indexed ${result.index.sessions.length} sessions in ${((Date.now() - started) / 1000).toFixed(1)}s`);

  if (values['check-budgets']) {
    const statuses = evaluateBudgets(result.index.sessions, config);
    if (!statuses.length) console.log('no limits configured (config: limits[])');
    let breached = false;
    for (const st of statuses) {
      const pct = (st.ratio * 100).toFixed(0);
      const mark = st.state === 'breached' ? '✗' : st.state === 'warning' ? '!' : '✓';
      console.log(`${mark} ${st.limit.id}: ${st.used} / ${st.max} ${st.limit.metric} (${pct}%) [${st.limit.period}, ${st.limit.scope}]`);
      if (st.state === 'breached') breached = true;
    }
    if (breached) return 2;
  }
  return 0;
}
