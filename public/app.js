'use strict';
let DATA = null;
const state = { days: 30, vendor: '', src: 'human', proj: '', model: '', sort: 'lastTs', sortDir: -1, expanded: null };

// Access token (only required when the server is bound beyond localhost). Read
// once from ?token= and persisted for the tab; loopback servers ignore it.
const API_TOKEN = new URLSearchParams(location.search).get('token') || sessionStorage.getItem('cdnToken') || '';
if (API_TOKEN) sessionStorage.setItem('cdnToken', API_TOKEN);
function cfetch(url, init = {}) {
  const headers = Object.assign({}, init.headers, API_TOKEN ? { 'x-codenomics-token': API_TOKEN } : {});
  return fetch(url, Object.assign({}, init, { headers }));
}

const $ = s => document.querySelector(s);
const fmt = {
  usd: v => v >= 1000 ? '$' + (v/1000).toFixed(2) + 'k' : v >= 10 ? '$' + v.toFixed(0) : '$' + v.toFixed(2),
  usdP: v => v >= 10 ? '$' + v.toFixed(1) : v >= 1 ? '$' + v.toFixed(2) : '$' + v.toFixed(3),
  tok: v => v >= 1e9 ? (v/1e9).toFixed(2)+'B' : v >= 1e6 ? (v/1e6).toFixed(2)+'M' : v >= 1e3 ? (v/1e3).toFixed(1)+'k' : String(Math.round(v)),
  min: ms => { const m = ms/60000; return m >= 90 ? (m/60).toFixed(1)+'h' : m.toFixed(0)+'m'; },
  num: v => v.toLocaleString('en-US'),
  date: ts => { const d = new Date(ts); return d.toISOString().slice(5,10) + ' ' + d.toTimeString().slice(0,5); },
};

const FAMS = ['fable','opus','sonnet','haiku','gpt','gemini','other'];
const FAM_COLOR = { fable:'#d97706', opus:'#ea580c', sonnet:'#0891b2', haiku:'#16a34a', gpt:'#475569', gemini:'#7c3aed', other:'#94a3b8' };
const VENDOR_TAG = { 'claude-code':'claude', codex:'codex', gemini:'gemini' };

function famOf(model){
  if (!model) return 'other';
  if (model.includes('fable')) return 'fable';
  if (model.includes('opus')) return 'opus';
  if (model.includes('sonnet')) return 'sonnet';
  if (model.includes('haiku')) return 'haiku';
  if (model.includes('gpt') || model.includes('o3') || model.includes('o4')) return 'gpt';
  if (model.includes('gemini')) return 'gemini';
  return 'other';
}
function shortModel(m){ return m ? m.replace(/^claude-/,'').replace(/-\d{8}$/,'') : '—'; }
function badge(m){ return `<span class="badge m-${famOf(m)}">${shortModel(m)}</span>`; }
function isMachine(s){ return s.source === 'machine'; }
function projShort(p){
  if (!p) return '—';
  const parts = p.replace(/\/+$/,'').split('/').filter(Boolean);
  return parts.length > 2 ? parts.slice(-2).join('/') : p;
}
function esc(t){ const d = document.createElement('span'); d.textContent = t || ''; return d.innerHTML; }
function median(arr){ if (!arr.length) return 0; const a = [...arr].sort((x,y)=>x-y); const m = a.length>>1; return a.length%2 ? a[m] : (a[m-1]+a[m])/2; }

// flatten schema fields the tables sort on
function annotate(s){
  s.lastTs = s.endedAt || s.startedAt || 0;
  s.tokIn = 0; s.tokOut = 0; s.tokCacheRead = 0; s.tokCacheWrite = 0; s.calls = 0;
  for (const m of Object.values(s.models || {})) {
    s.tokIn += m.input; s.tokOut += m.output; s.tokCacheRead += m.cacheRead;
    s.tokCacheWrite += m.cacheWrite5m + m.cacheWrite1h; s.calls += m.calls;
  }
  s.ctxPerCall = s.calls ? s.tokCacheRead / s.calls : 0;
  s.userPrompts = s.counts.userPrompts; s.assistantTurns = s.counts.assistantTurns;
  s.toolCalls = s.counts.toolCalls; s.commits = s.counts.commits;
  s.costUsd = s.derived.costUsd; s.trueUsd = s.derived.trueUsd;
}

function filtered(){
  const cut = state.days ? Date.now() - state.days*86400000 : 0;
  return DATA.sessions.filter(s =>
    (s.lastTs || 0) >= cut
    && (!state.vendor || s.vendor === state.vendor)
    && (state.src === 'all' || (state.src === 'machine') === isMachine(s))
    && (!state.proj || s.project === state.proj)
    && (!state.model || famOf(s.primaryModel) === state.model)
  );
}

// ---- filter control: one path for every filter change ----
// Segmented controls, dropdowns, model table, legend, and the active-filter
// chips all read from `state` and route changes through setFilters, so they
// can never disagree. Model filtering is family-level to match the dropdown,
// chart, and badge colors.
const FILTER_DEFAULTS = { vendor: '', src: 'human', proj: '', model: '' };

function setFilters(patch){
  Object.assign(state, patch);
  syncControls();
  render();
}
// click a model anywhere (table row / legend) to focus on it; click again to clear
function toggleModel(fam){ setFilters({ model: state.model === fam ? '' : fam }); }

// mirror `state` back into the top controls so chip/table clicks move them too
function syncControls(){
  for (const [id, attr, val] of [['rangeSeg','d',String(state.days)], ['vendorSeg','v',state.vendor], ['srcSeg','s',state.src]]){
    document.querySelectorAll(`#${id} button`).forEach(b => b.classList.toggle('on', (b.dataset[attr] ?? '') === val));
  }
  const ms = $('#modelSel'); if (ms) ms.value = state.model;
  const ps = $('#projSel'); if (ps) ps.value = state.proj;
}

// active-filter chips: always show what's narrowing the view, one click to drop
function renderFilterBar(){
  const bar = $('#filterBar'); if (!bar) return;
  const chips = [];
  if (state.vendor) chips.push(['agent', VENDOR_TAG[state.vendor] || state.vendor, 'vendor']);
  if (state.src !== FILTER_DEFAULTS.src) chips.push(['source', state.src, 'src']);
  if (state.proj) chips.push(['project', projShort(state.proj), 'proj']);
  if (state.model) chips.push(['model', state.model, 'model']);
  if (!chips.length){ bar.hidden = true; bar.innerHTML = ''; return; }
  bar.hidden = false;
  bar.innerHTML = '<span class="fb-lbl">filtering</span>' +
    chips.map(([k, v, f]) => `<button class="chip" data-clear="${f}" title="remove filter">${k}: <b>${esc(v)}</b> <span class="x">✕</span></button>`).join('') +
    '<button class="chip-clear" data-clear="all">clear all</button>';
}

function render(){
  const rows = filtered();
  renderFilterBar();
  const attn = DATA.config.drivers.attentionUsdPerPrompt;

  // ---- KPIs ----
  const cost = rows.reduce((a,s)=>a+s.costUsd,0);
  const out = rows.reduce((a,s)=>a+s.tokOut,0);
  const prompts = rows.reduce((a,s)=>a+s.userPrompts,0);
  const commits = rows.reduce((a,s)=>a+(s.commits||0),0);
  const activeMs = rows.reduce((a,s)=>a+s.activeMs,0);
  const cacheRead = rows.reduce((a,s)=>a+s.tokCacheRead,0);
  const cacheWrite = rows.reduce((a,s)=>a+s.tokCacheWrite,0);
  const tokIn = rows.reduce((a,s)=>a+s.tokIn,0);
  const cacheRate = (cacheRead+cacheWrite+tokIn) ? cacheRead/(cacheRead+cacheWrite+tokIn) : 0;
  const trueTotal = rows.reduce((a,s)=>a+s.trueUsd,0);
  $('#kpis').innerHTML = [
    ['hero', commits ? fmt.usdP(trueTotal/commits) : '—', 'TRUE $ / COMMIT', `compute + ${fmt.usdP(attn)}/prompt attention`],
    ['v', fmt.usd(cost), 'API-equiv burn', `${fmt.usd(state.days?cost/state.days:0)}/day avg`],
    ['v', fmt.tok(out), 'output tokens', `${fmt.tok(cacheRead)} cache-read`],
    ['v', fmt.num(rows.length), 'sessions', `${fmt.num(prompts)} prompts`],
    ['v', commits ? fmt.usdP(cost/commits) : '—', '$ / commit', `${fmt.num(commits)} commits`],
    ['v', prompts ? fmt.usdP(cost/prompts) : '—', '$ / prompt', `${prompts&&commits?(prompts/commits).toFixed(1):'—'} prompts/commit`],
    ['v', fmt.min(activeMs), 'active time', `${activeMs?fmt.tok(out/(activeMs/60000)):'—'} out-tok/min`],
    ['v', (cacheRate*100).toFixed(1)+'<small>%</small>', 'cache hit', 'read share of input'],
  ].map(([cls,v,k,sub]) => `<div class="kpi${cls==='hero'?' hero':''}"><div class="v">${v}</div><div class="k">${k}</div><div class="sub">${sub}</div></div>`).join('');

  // ---- Budget strip ----
  $('#budgetStrip').innerHTML = (DATA.budgets||[]).map(b => {
    const pct = Math.min(100, b.ratio*100);
    return `<div class="budget ${b.state}" title="${b.limit.metric} per ${b.limit.period}, scope ${b.limit.scope}">
      <span class="bname">${esc(b.limit.id)}</span>
      <span class="bar"><i style="width:${pct.toFixed(0)}%"></i></span>
      <span>${b.limit.metric.startsWith('tokens')?fmt.tok(b.used):fmt.usd(b.used)} / ${b.limit.metric.startsWith('tokens')?fmt.tok(b.max):fmt.usd(b.max)}</span>
    </div>`;
  }).join('');

  // ---- Model economics (by model) ----
  const byModel = {};
  for (const s of rows){
    for (const [model,m] of Object.entries(s.models||{})){
      const g = byModel[model] || (byModel[model] = { model, fam:famOf(model), cost:0, out:0, calls:0, sessions:new Set(), prompts:0, commits:0, activeMs:0, costList:[], attnUsd:0 });
      g.cost += (s.modelCosts && s.modelCosts[model]) || 0;
      g.out += m.output; g.calls += m.calls;
      g.sessions.add(s.vendor + ':' + s.id);
    }
    const pm = s.primaryModel;
    if (pm && byModel[pm]){
      byModel[pm].prompts += s.userPrompts; byModel[pm].commits += s.commits||0; byModel[pm].activeMs += s.activeMs;
      byModel[pm].costList.push(s.costUsd);
      byModel[pm].attnUsd += s.derived.attentionUsd + s.derived.timeUsd;
    }
  }
  const fams = Object.values(byModel).sort((a,b)=>{
    const ta = a.commits ? (a.cost+a.attnUsd)/a.commits : Infinity;
    const tb = b.commits ? (b.cost+b.attnUsd)/b.commits : Infinity;
    return ta === tb ? b.cost - a.cost : ta - tb;
  });
  $('#modelTable').innerHTML = `<thead><tr>
    <th class="l">model</th><th>true $/commit</th><th>sessions</th><th>api calls</th><th>$ total</th><th>$ median/sess</th>
    <th>prompts</th><th>$ / prompt</th><th>commits</th><th>$ / commit</th><th>prompts/commit</th>
    <th>out tok</th><th>out-tok/prompt</th><th>out-tok/min</th></tr></thead><tbody>` +
    (fams.map(g => `<tr data-fam="${g.fam}" class="clickable${state.model===g.fam?' active':''}" title="filter to ${g.fam}">
      <td class="l"><span class="badge m-${g.fam}">${shortModel(g.model)}</span></td>
      <td class="hero">${g.commits ? fmt.usdP((g.cost+g.attnUsd)/g.commits) : '—'}</td>
      <td>${g.sessions.size}</td><td class="dim">${fmt.num(g.calls)}</td>
      <td class="money">${fmt.usd(g.cost)}</td><td class="dim">${fmt.usdP(median(g.costList))}</td>
      <td>${fmt.num(g.prompts)}</td><td class="money">${g.prompts?fmt.usdP(g.cost/g.prompts):'—'}</td>
      <td>${g.commits}</td><td class="money">${g.commits?fmt.usdP(g.cost/g.commits):'—'}</td>
      <td class="dim">${g.commits?(g.prompts/g.commits).toFixed(1):'—'}</td>
      <td>${fmt.tok(g.out)}</td><td class="dim">${g.prompts?fmt.tok(g.out/g.prompts):'—'}</td>
      <td class="dim">${g.activeMs?fmt.tok(g.out/(g.activeMs/60000)):'—'}</td>
    </tr>`).join('') || '<tr><td class="empty" colspan="14">no data in range</td></tr>') + '</tbody>';

  renderChart(rows);

  // ---- Sessions table ----
  const sorted = [...rows].sort((a,b)=>{
    const va = a[state.sort] ?? 0, vb = b[state.sort] ?? 0;
    return (va < vb ? -1 : va > vb ? 1 : 0) * state.sortDir;
  });
  const cols = [
    ['lastTs','when'],['primaryModel','model'],['recap','recap',1],['userPrompts','pr'],['assistantTurns','turns'],
    ['toolCalls','tools'],['commits','cmt'],['activeMs','active'],['tokOut','out tok'],['ctxPerCall','ctx/call'],['costUsd','$'],['trueUsd','true $'],
  ];
  let html = '<thead><tr>' + cols.map(([k,label,left]) =>
    `<th class="${left?'l ':''}${state.sort===k?'sorted':''}" data-k="${k}">${label}${state.sort===k?(state.sortDir<0?' ▾':' ▴'):''}</th>`).join('') + '</tr></thead><tbody>';
  for (const s of sorted.slice(0, 300)){
    const key = s.vendor + ':' + s.id;
    const recap = s.summary
      ? esc(s.summary)
      : s.meta.firstPrompt
        ? `<span class="fp">${esc(s.meta.firstPrompt.slice(0,160))}</span>`
        : `<span class="fp faint">${isMachine(s) ? 'automated · no prompt' : (DATA.summarizing ? 'recap pending…' : 'no opening prompt')}</span>`;
    html += `<tr data-id="${esc(key)}">
      <td class="dim">${fmt.date(s.lastTs)}${isMachine(s)?' <span class="src" title="automated (machine/SDK) session — no human attention charged">⚙ auto</span>':''}</td>
      <td class="l">${badge(s.primaryModel)} <span class="vendor-tag">${VENDOR_TAG[s.vendor]||s.vendor}</span></td>
      <td class="l recap">${recap}</td>
      <td>${s.userPrompts}</td><td class="dim">${s.assistantTurns}</td><td class="dim">${s.toolCalls}</td>
      <td>${s.commits===null?'<span class="faint" title="not detectable for this agent">—</span>':(s.commits||'<span class="faint">·</span>')}</td>
      <td class="dim">${fmt.min(s.activeMs)}</td><td>${fmt.tok(s.tokOut)}</td>
      <td style="${s.ctxPerCall>300000?'color:var(--red);font-weight:700':s.ctxPerCall>150000?'color:var(--orange)':'color:var(--faint)'}" title="avg context re-read per API call — the session-bloat tax">${fmt.tok(s.ctxPerCall)}</td>
      <td class="money">${fmt.usdP(s.costUsd)}</td>
      <td class="hero" title="${s.commits?'true $/commit: '+fmt.usdP(s.trueUsd/s.commits):'no commits'}">${fmt.usdP(s.trueUsd)}${s.commits?`<span class="src"> /${s.commits}cmt=${fmt.usdP(s.trueUsd/s.commits)}</span>`:''}</td></tr>`;
    if (state.expanded === key){
      const mdl = Object.entries(s.models||{}).map(([m,x]) =>
        `<div>${badge(m)} ${x.calls} calls · in ${fmt.tok(x.input)} · out ${fmt.tok(x.output)} · cache rd ${fmt.tok(x.cacheRead)} / wr ${fmt.tok(x.cacheWrite5m+x.cacheWrite1h)}${x.reasoning?` · reason ${fmt.tok(x.reasoning)}`:''} · <b>${fmt.usdP((s.modelCosts&&s.modelCosts[m])||0)}</b></div>`).join('');
      const tools = Object.entries(s.toolCounts||{}).sort((a,b)=>b[1]-a[1]).slice(0,10).map(([t,n])=>`${t}×${n}`).join(' · ');
      const unpriced = s.derived.unpricedModels.length ? `<br><b style="color:var(--red)">unpriced models</b> ${s.derived.unpricedModels.join(', ')} — add to config pricing` : '';
      html += `<tr class="detail"><td colspan="12"><div class="grid">
        <div><b>session</b> ${esc(s.id)}<br><b>agent</b> ${esc(s.vendor)} · <b>project</b> ${esc(projShort(s.project))} · <b>branch</b> ${esc(s.meta.gitBranch||'—')} · <b>v</b> ${esc(s.meta.cliVersion||'—')} · <b>src</b> ${esc(s.source)}${s.meta.slashCommand?' · <b>cmd</b> '+esc(s.meta.slashCommand):''}${unpriced}</div>
        <div>${mdl}</div>
        <div><b>tools</b> ${esc(tools)||'—'}<br><b>wall</b> ${fmt.min(s.wallMs)} · <b>active</b> ${fmt.min(s.activeMs)} · <b>sidechain calls</b> ${s.counts.sidechainCalls} · <b>true $ split</b> ${fmt.usdP(s.derived.costUsd)} compute + ${fmt.usdP(s.derived.attentionUsd)} attn${s.derived.timeUsd?` + ${fmt.usdP(s.derived.timeUsd)} time`:''}</div>
        <div><b>opening</b> <span class="fp">${esc((s.meta.firstPrompt||'').slice(0,300))}</span></div>
      </div></td></tr>`;
    }
  }
  html += '</tbody>';
  $('#sessTable').innerHTML = html;
  if (sorted.length > 300) $('#sessTable').insertAdjacentHTML('beforeend', `<caption style="caption-side:bottom;color:var(--faint);padding:8px">showing 300 of ${sorted.length}</caption>`);
}

function renderChart(rows){
  const byDay = {};
  for (const s of rows){
    if (!s.lastTs) continue;
    const day = new Date(s.lastTs).toISOString().slice(0,10);
    const d = byDay[day] || (byDay[day] = {});
    for (const model of Object.keys(s.models||{})){
      const f = famOf(model);
      d[f] = (d[f]||0) + ((s.modelCosts && s.modelCosts[model]) || 0);
    }
  }
  const days = Object.keys(byDay).sort();
  if (!days.length){ $('#chart').innerHTML = '<div class="empty">no data</div>'; $('#legend').innerHTML=''; return; }
  const W = 1100, H = 180, PAD = 34;
  const max = Math.max(...days.map(d => FAMS.reduce((a,f)=>a+(byDay[d][f]||0),0)), 1);
  const bw = Math.min(26, (W-PAD) / days.length - 2);
  let svg = `<svg viewBox="0 0 ${W} ${H+22}" width="100%" preserveAspectRatio="none" style="font-family:var(--mono)">`;
  for (const frac of [0.25,0.5,0.75,1]){
    const y = H - H*frac;
    svg += `<line x1="${PAD}" x2="${W}" y1="${y}" y2="${y}" stroke="#e7e9ee" stroke-width="1"/>
      <text x="${PAD-5}" y="${y+4}" fill="#94a3b8" font-size="9" text-anchor="end">$${(max*frac).toFixed(0)}</text>`;
  }
  days.forEach((d,i)=>{
    let y = H;
    const x = PAD + i * ((W-PAD)/days.length);
    for (const f of FAMS){
      const v = byDay[d][f]||0;
      if (!v) continue;
      const h = (v/max)*H;
      y -= h;
      svg += `<rect x="${x}" y="${y}" width="${bw}" height="${h}" fill="${FAM_COLOR[f]}" opacity=".9"><title>${d} ${f}: $${v.toFixed(2)}</title></rect>`;
    }
    if (days.length <= 40 || i % Math.ceil(days.length/30) === 0)
      svg += `<text x="${x+bw/2}" y="${H+14}" fill="#94a3b8" font-size="8.5" text-anchor="middle">${d.slice(5)}</text>`;
  });
  svg += '</svg>';
  $('#chart').innerHTML = svg;
  const present = new Set();
  for (const d of days) for (const f of Object.keys(byDay[d])) present.add(f);
  $('#legend').innerHTML = FAMS.filter(f=>present.has(f)).map(f=>`<span data-fam="${f}" class="clickable${state.model===f?' active':''}" title="filter to ${f}"><i style="background:${FAM_COLOR[f]}"></i>${f}</span>`).join('');
}

function populateFilters(){
  const projs = [...new Set(DATA.sessions.map(s=>s.project))].sort();
  $('#projSel').innerHTML = '<option value="">all</option>' + projs.map(p=>`<option value="${esc(p)}">${esc(projShort(p))}</option>`).join('');
  const fams = [...new Set(DATA.sessions.map(s=>famOf(s.primaryModel)))];
  $('#modelSel').innerHTML = '<option value="">all</option>' + fams.map(f=>`<option value="${f}">${f}</option>`).join('');
}

// ---- settings drawer ----
const METRICS = ['costUsd','trueUsd','tokensIn','tokensOut','tokensTotal'];
const PERIODS = ['day','week','month'];
let drawerLimits = [];

function renderLimits(){
  $('#limitsTable').innerHTML = '<thead><tr><th class="l">id</th><th class="l">metric</th><th class="l">period</th><th class="l">max</th><th class="l">scope</th><th></th></tr></thead><tbody>' +
    drawerLimits.map((l,i)=>`<tr>
      <td><input data-i="${i}" data-f="id" value="${esc(l.id)}" style="width:90px"></td>
      <td><select data-i="${i}" data-f="metric">${METRICS.map(m=>`<option ${m===l.metric?'selected':''}>${m}</option>`).join('')}</select></td>
      <td><select data-i="${i}" data-f="period">${PERIODS.map(p=>`<option ${p===l.period?'selected':''}>${p}</option>`).join('')}</select></td>
      <td><input data-i="${i}" data-f="max" type="number" min="0" value="${l.max}"></td>
      <td><input data-i="${i}" data-f="scope" value="${esc(l.scope)}" style="width:110px" title="global | project:<key> | vendor:<vendor>"></td>
      <td><button class="btn" data-del="${i}">✕</button></td>
    </tr>`).join('') + '</tbody>';
}

function openDrawer(){
  $('#drvAttn').value = DATA.config.drivers.attentionUsdPerPrompt;
  $('#drvHourly').value = DATA.config.drivers.engHourlyRateUsd;
  drawerLimits = JSON.parse(JSON.stringify(DATA.config.limits || []));
  renderLimits();
  $('#drawerMsg').textContent = '';
  $('#drawer').hidden = false;
}

async function saveDrawer(){
  const body = {
    drivers: {
      attentionUsdPerPrompt: Math.max(0, parseFloat($('#drvAttn').value) || 0),
      engHourlyRateUsd: Math.max(0, parseFloat($('#drvHourly').value) || 0),
    },
    limits: drawerLimits.map(l=>({ ...l, max: parseFloat(l.max) || 0 })),
  };
  const r = await cfetch('/api/config', { method:'PUT', headers:{'content-type':'application/json'}, body: JSON.stringify(body) });
  const out = await r.json();
  if (!out.ok){ $('#drawerMsg').textContent = (out.problems||['save failed']).join(' · '); return; }
  $('#drawerMsg').textContent = 'saved ✓';
  await load();
}

async function loadReports(){
  try {
    const r = await cfetch('/api/reports');
    const { reports } = await r.json();
    if (!reports.length) return;
    $('#reportsSection').style.display = '';
    $('#reportsList').innerHTML = reports.map(f=>`<a href="/reports/${encodeURIComponent(f)}" target="_blank">${esc(f)}</a>`).join('');
  } catch { /* no reports endpoint */ }
}

async function load(){
  const r = await cfetch('/api/data');
  DATA = await r.json();
  for (const s of DATA.sessions) annotate(s);
  $('#meta').textContent = `${DATA.sessions.length} sessions indexed · refreshed ${new Date(DATA.generatedAt).toTimeString().slice(0,8)}${DATA.summarizing?' · recaps generating…':''}`;
  // experimental-vendor warning: token math for these isn't validated on real logs
  const caps = DATA.capabilities || {};
  const expVendors = [...new Set(DATA.sessions.map(s=>s.vendor))].filter(v=>caps[v] && caps[v].experimental);
  const banner = $('#expBanner');
  if (banner) {
    if (expVendors.length) {
      banner.textContent = `⚠ ${expVendors.join(', ')} support is experimental — token figures are best-effort and not yet validated against real logs.`;
      banner.hidden = false;
    } else banner.hidden = true;
  }
  populateFilters();
  render();
  if (DATA.summarizing) setTimeout(load, 8000);
}

$('#rangeSeg').addEventListener('click', e=>{ if (e.target.dataset.d !== undefined) setFilters({ days: +e.target.dataset.d }); });
$('#vendorSeg').addEventListener('click', e=>{ if (e.target.dataset.v !== undefined) setFilters({ vendor: e.target.dataset.v }); });
$('#srcSeg').addEventListener('click', e=>{ if (e.target.dataset.s) setFilters({ src: e.target.dataset.s }); });
$('#projSel').addEventListener('change', e=>setFilters({ proj: e.target.value }));
$('#modelSel').addEventListener('change', e=>setFilters({ model: e.target.value }));

// click-to-filter parity: a model row or legend item behaves like the dropdown
$('#modelTable').addEventListener('click', e=>{ const r = e.target.closest('tr[data-fam]'); if (r) toggleModel(r.dataset.fam); });
$('#legend').addEventListener('click', e=>{ const s = e.target.closest('span[data-fam]'); if (s) toggleModel(s.dataset.fam); });
// active-filter chips: remove one, or clear all
$('#filterBar').addEventListener('click', e=>{
  const c = e.target.closest('[data-clear]'); if (!c) return;
  const f = c.dataset.clear;
  if (f === 'all') setFilters({ ...FILTER_DEFAULTS });
  else setFilters({ [f === 'vendor' ? 'vendor' : f === 'src' ? 'src' : f === 'proj' ? 'proj' : 'model']: f === 'src' ? FILTER_DEFAULTS.src : '' });
});

$('#sessTable').addEventListener('click', e=>{
  const th = e.target.closest('th');
  if (th && th.dataset.k){
    if (state.sort === th.dataset.k) state.sortDir *= -1;
    else { state.sort = th.dataset.k; state.sortDir = -1; }
    render(); return;
  }
  const tr = e.target.closest('tr[data-id]');
  if (tr){ state.expanded = state.expanded === tr.dataset.id ? null : tr.dataset.id; render(); }
});
$('#sumBtn').addEventListener('click', async ()=>{
  const b = $('#sumBtn'); b.disabled = true; b.textContent = '✦ GENERATING…';
  await cfetch('/api/summarize?limit=40', { method:'POST' });
  setTimeout(()=>{ load().then(()=>{ b.disabled=false; b.textContent='✦ GENERATE RECAPS'; }); }, 10000);
});
$('#settingsBtn').addEventListener('click', openDrawer);
$('#drawerClose').addEventListener('click', ()=>{ $('#drawer').hidden = true; });
$('#drawer').addEventListener('click', e=>{ if (e.target === $('#drawer')) $('#drawer').hidden = true; });
$('#drawerSave').addEventListener('click', saveDrawer);
$('#limitAdd').addEventListener('click', ()=>{
  drawerLimits.push({ id: 'limit-' + (drawerLimits.length+1), metric: 'costUsd', period: 'day', max: 50, scope: 'global' });
  renderLimits();
});
$('#limitsTable').addEventListener('input', e=>{
  const i = e.target.dataset.i, f = e.target.dataset.f;
  if (i !== undefined && f) drawerLimits[i][f] = e.target.value;
});
$('#limitsTable').addEventListener('click', e=>{
  const del = e.target.dataset.del;
  if (del !== undefined){ drawerLimits.splice(+del, 1); renderLimits(); }
});

load();
loadReports();
