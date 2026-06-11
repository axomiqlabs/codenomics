// Slack delivery: compact digest of a ReportModel via incoming webhook.

import type { ReportModel } from './build.js';

export function buildDigest(model: ReportModel): string {
  const lines: string[] = [`*${model.title}* — ${model.periodLabel}`];
  for (const b of model.blocks) {
    if (b.kind === 'kpis') {
      lines.push(b.items.slice(0, 5).map((i) => `${i.label}: *${i.value}*${i.delta ? ` (${i.delta})` : ''}`).join(' · '));
    } else if (b.kind === 'callouts') {
      const mark = b.severity === 'breach' ? ':red_square:' : ':orange_square:';
      for (const l of b.lines) lines.push(`${mark} ${l}`);
    } else if (b.kind === 'prose') {
      for (const l of b.lines.slice(0, 3)) lines.push(`• ${l}`);
    }
  }
  return lines.join('\n');
}

export async function postToSlack(webhookUrl: string, model: ReportModel): Promise<void> {
  const res = await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: buildDigest(model) }),
  });
  if (!res.ok) {
    throw new Error(`slack webhook failed: ${res.status} ${await res.text()}`);
  }
}
