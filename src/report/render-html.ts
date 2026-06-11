import type { ReportBlock, ReportModel } from './build.js';

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

const CSS = `
:root{--bg:#0a0c0a;--panel:#121611;--panel2:#161b15;--line:#232a21;--line2:#2e372b;--txt:#cfd8c3;--dim:#7a856e;--faint:#4a5443;--amber:#ffb300;--red:#e26d5a;--orange:#ff8a4d;--green:#7dd87d}
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:ui-monospace,Menlo,Consolas,monospace;background:var(--bg);color:var(--txt);font-size:13px;line-height:1.5;padding:28px;max-width:1000px;margin:0 auto}
h1{font-size:20px;letter-spacing:.08em;margin-bottom:4px}
h1 b{color:var(--amber)}
.sub{color:var(--dim);font-size:11px;margin-bottom:22px}
h3{font-size:11px;letter-spacing:.18em;text-transform:uppercase;color:var(--amber);margin:24px 0 8px;border-bottom:1px solid var(--line2);padding-bottom:4px}
.kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px;margin:14px 0}
.kpi{background:var(--panel2);border:1px solid var(--line);border-radius:4px;padding:10px}
.kpi .v{font-size:20px;font-weight:700;color:var(--txt)}
.kpi:first-child .v{color:var(--amber);font-size:24px}
.kpi .k{font-size:9px;letter-spacing:.14em;text-transform:uppercase;color:var(--dim);margin-top:2px}
.kpi .d{font-size:10px;color:var(--faint);margin-top:2px}
table{width:100%;border-collapse:collapse;font-variant-numeric:tabular-nums;margin:6px 0}
th{font-size:9px;letter-spacing:.12em;text-transform:uppercase;color:var(--dim);text-align:left;padding:5px 8px;border-bottom:1px solid var(--line2)}
td{padding:5px 8px;border-bottom:1px solid var(--line);white-space:nowrap}
td:first-child{color:var(--dim)}
.callout{border:1px solid var(--line2);border-left:3px solid var(--orange);background:var(--panel);padding:10px 14px;margin:10px 0;border-radius:3px}
.callout.breach{border-left-color:var(--red)}
.callout ul{margin-left:16px}
.prose ul{margin-left:16px}
.prose li{margin-bottom:6px}
.chart{background:var(--panel);border:1px solid var(--line);border-radius:4px;padding:10px;margin:8px 0}
footer{margin-top:30px;color:var(--faint);font-size:10px;border-top:1px solid var(--line);padding-top:10px}
`;

function chartSvg(days: Array<{ day: string; usd: number }>): string {
  if (!days.length) return '<div style="color:var(--faint)">no data</div>';
  const W = 940;
  const H = 150;
  const PAD = 40;
  const max = Math.max(...days.map((d) => d.usd), 1e-9);
  const bw = Math.max(2, Math.min(40, (W - PAD) / days.length - 3));
  let svg = `<svg viewBox="0 0 ${W} ${H + 20}" width="100%">`;
  for (const frac of [0.5, 1]) {
    const y = H - H * frac;
    svg += `<line x1="${PAD}" x2="${W}" y1="${y}" y2="${y}" stroke="#232a21"/><text x="${PAD - 5}" y="${y + 4}" fill="#4a5443" font-size="9" text-anchor="end">$${(max * frac).toFixed(0)}</text>`;
  }
  days.forEach((d, i) => {
    const x = PAD + i * ((W - PAD) / days.length);
    const h = (d.usd / max) * H;
    svg += `<rect x="${x}" y="${H - h}" width="${bw}" height="${h}" fill="#ffb300" opacity=".85"><title>${d.day}: $${d.usd}</title></rect>`;
    if (days.length <= 35 || i % Math.ceil(days.length / 25) === 0) {
      svg += `<text x="${x + bw / 2}" y="${H + 13}" fill="#4a5443" font-size="8.5" text-anchor="middle">${d.day.slice(5)}</text>`;
    }
  });
  return svg + '</svg>';
}

function renderBlock(b: ReportBlock): string {
  switch (b.kind) {
    case 'kpis':
      return `<div class="kpis">${b.items
        .map((i) => `<div class="kpi"><div class="v">${esc(i.value)}</div><div class="k">${esc(i.label)}</div>${i.delta ? `<div class="d">${esc(i.delta)}</div>` : ''}</div>`)
        .join('')}</div>`;
    case 'table':
      return `<h3>${esc(b.title)}</h3><table><thead><tr>${b.columns.map((c) => `<th>${esc(c)}</th>`).join('')}</tr></thead><tbody>${
        b.rows.length
          ? b.rows.map((r) => `<tr>${r.map((c) => `<td>${esc(c)}</td>`).join('')}</tr>`).join('')
          : `<tr><td colspan="${b.columns.length}" style="color:var(--faint)">no data</td></tr>`
      }</tbody></table>`;
    case 'chart':
      return `<h3>${esc(b.title)}</h3><div class="chart">${chartSvg(b.days)}</div>`;
    case 'callouts':
      return `<div class="callout ${b.severity}"><strong>${esc(b.title)}</strong><ul>${b.lines.map((l) => `<li>${esc(l)}</li>`).join('')}</ul></div>`;
    case 'prose':
      return `<h3>${esc(b.title)}</h3><div class="prose"><ul>${b.lines.map((l) => `<li>${esc(l)}</li>`).join('')}</ul></div>`;
  }
}

export function renderHtml(model: ReportModel): string {
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(model.title)} — ${esc(model.fileStem)}</title><style>${CSS}</style></head>
<body>
<h1>CODE<b>NOMICS</b> — ${esc(model.title.replace('Codenomics ', ''))}</h1>
<div class="sub">${esc(model.periodLabel)} · generated ${new Date(model.generatedAt).toISOString().slice(0, 16).replace('T', ' ')}</div>
${model.blocks.map(renderBlock).join('\n')}
<footer>$ figures are API-equivalent compute cost; TRUE $ adds attention/time drivers from your config.
Generated locally by codenomics — your transcripts never left this machine.</footer>
</body></html>`;
}
