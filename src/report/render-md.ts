import type { ReportBlock, ReportModel } from './build.js';

function mdTable(columns: string[], rows: string[][]): string {
  const head = `| ${columns.join(' | ')} |`;
  const sep = `| ${columns.map(() => '---').join(' | ')} |`;
  const body = rows.map((r) => `| ${r.map((c) => c.replaceAll('|', '\\|')).join(' | ')} |`);
  return [head, sep, ...body].join('\n');
}

function sparkline(values: number[]): string {
  const ticks = '▁▂▃▄▅▆▇█';
  const max = Math.max(...values, 1e-9);
  return values.map((v) => ticks[Math.min(7, Math.floor((v / max) * 8))]).join('');
}

function renderBlock(b: ReportBlock): string {
  switch (b.kind) {
    case 'kpis':
      return mdTable(
        ['metric', 'value', 'trend'],
        b.items.map((i) => [i.label, `**${i.value}**`, i.delta ?? '']),
      );
    case 'table':
      return `### ${b.title}\n\n${b.rows.length ? mdTable(b.columns, b.rows) : '_no data_'}`;
    case 'chart': {
      if (!b.days.length) return `### ${b.title}\n\n_no data_`;
      const spark = sparkline(b.days.map((d) => d.usd));
      const peak = b.days.reduce((m, d) => (d.usd > m.usd ? d : m));
      return `### ${b.title}\n\n\`${spark}\`  ${b.days[0]!.day} → ${b.days[b.days.length - 1]!.day} · peak ${peak.day} ($${peak.usd})`;
    }
    case 'callouts': {
      const mark = b.severity === 'breach' ? '🟥' : b.severity === 'warn' ? '🟧' : 'ℹ️';
      return `### ${mark} ${b.title}\n\n${b.lines.map((l) => `- ${l}`).join('\n')}`;
    }
    case 'prose':
      return `### ${b.title}\n\n${b.lines.map((l) => `- ${l}`).join('\n')}`;
  }
}

export function renderMarkdown(model: ReportModel): string {
  return [
    `# ${model.title}`,
    '',
    `**${model.periodLabel}** · generated ${new Date(model.generatedAt).toISOString().slice(0, 16).replace('T', ' ')}`,
    '',
    ...model.blocks.map(renderBlock),
    '',
    '---',
    '_$ figures are API-equivalent compute cost; TRUE $ adds attention/time drivers from your config. Generated locally by [codenomics](https://codenomics.ai) — your transcripts never left this machine._',
  ].join('\n\n');
}
