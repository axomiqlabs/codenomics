import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { loadConfig } from '../../core/config.js';
import { readIndex, reportsDir } from '../../core/store.js';
import { buildReport, type Period } from '../../report/build.js';
import { renderMarkdown } from '../../report/render-md.js';
import { renderHtml } from '../../report/render-html.js';
import { postToSlack } from '../../report/slack.js';

const USAGE = [
  'usage: npx codenomics report <weekly|monthly> [options]',
  '       npx codenomics report schedule [--period weekly|monthly] [--slack] [--install-cron]',
  '',
  'weekly covers the last complete ISO week (Mon–Sun); monthly the last complete',
  'calendar month. --at selects the period containing that date instead.',
  '',
  'Options (weekly|monthly):',
  '  --at <YYYY-MM-DD>      generate the report for the period containing this date (default: last complete period)',
  '  --format <md|html|both> output format (default: both)',
  '  --out <dir>            directory to write report files (default: codenomics data/reports/)',
  '  --slack                post the digest to the configured Slack webhook (config: report.slackWebhookUrl)',
  '  --stdout               print markdown to stdout instead of writing files',
  '',
  'Options (schedule):',
  '  --period <weekly|monthly>  period for the scheduled report (default: weekly)',
  '  --slack                    include --slack in the scheduled command',
  '  --install-cron             write the cron entry directly via `crontab` (default: print it)',
].join('\n');

export async function run(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      at: { type: 'string' },
      format: { type: 'string', default: 'both' },
      out: { type: 'string' },
      slack: { type: 'boolean', default: false },
      stdout: { type: 'boolean', default: false },
      period: { type: 'string', default: 'weekly' },
      'install-cron': { type: 'boolean', default: false },
      help: { type: 'boolean', default: false },
    },
  });
  const sub = positionals[0];
  if (values.help || !sub) {
    console.log(USAGE);
    return values.help ? 0 : 1;
  }

  if (sub === 'schedule') return schedule(values.period as Period, values.slack, values['install-cron']);

  if (sub !== 'weekly' && sub !== 'monthly') {
    console.error(`unknown period: ${sub}\n${USAGE}`);
    return 1;
  }

  const { config } = loadConfig();
  const index = readIndex();
  if (!index.sessions.length) {
    console.error('index is empty — run `npx codenomics index` first');
    return 1;
  }

  let at: Date | undefined;
  if (values.at) {
    at = new Date(values.at);
    if (Number.isNaN(at.getTime())) {
      console.error(`invalid --at date: ${values.at}`);
      return 1;
    }
  }

  const model = buildReport(index.sessions, config, sub, at);
  const outDir = values.out ?? reportsDir();
  fs.mkdirSync(outDir, { recursive: true });

  const wantMd = values.format === 'md' || values.format === 'both';
  const wantHtml = values.format === 'html' || values.format === 'both';
  if (values.stdout) {
    console.log(renderMarkdown(model));
  } else {
    if (wantMd) {
      const p = path.join(outDir, `${model.fileStem}.md`);
      fs.writeFileSync(p, renderMarkdown(model) + '\n');
      console.log(p);
    }
    if (wantHtml) {
      const p = path.join(outDir, `${model.fileStem}.html`);
      fs.writeFileSync(p, renderHtml(model));
      console.log(p);
    }
  }

  if (values.slack) {
    const url = config.report.slackWebhookUrl;
    if (!url) {
      console.error('no Slack webhook configured: npx codenomics config set report.slackWebhookUrl <url>');
      return 1;
    }
    await postToSlack(url, model);
    console.log('posted digest to Slack');
  }
  return 0;
}

function schedule(period: Period, slack: boolean, install: boolean): number {
  const bin = process.argv[1] ?? 'codenomics';
  const cmd = `node ${bin} index >/dev/null 2>&1 && node ${bin} report ${period}${slack ? ' --slack' : ''}`;
  const cron = period === 'weekly' ? `5 8 * * 1 ${cmd}` : `10 8 1 * * ${cmd}`;
  if (!install) {
    console.log('add to crontab (crontab -e):');
    console.log(`  ${cron}`);
    console.log('\nor install it now with: npx codenomics report schedule --period ' + period + (slack ? ' --slack' : '') + ' --install-cron');
    return 0;
  }
  const current = spawnSync('crontab', ['-l'], { encoding: 'utf8' });
  const existing = current.status === 0 ? current.stdout : '';
  if (existing.includes(cmd)) {
    console.log('already installed');
    return 0;
  }
  const next = existing.trimEnd() + (existing.trim() ? '\n' : '') + cron + '\n';
  const result = spawnSync('crontab', ['-'], { input: next, encoding: 'utf8' });
  if (result.status !== 0) {
    console.error(`crontab install failed: ${result.stderr || 'unknown error'}`);
    return 1;
  }
  console.log(`installed: ${cron}`);
  return 0;
}
