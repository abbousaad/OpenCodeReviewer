const runId = new URLSearchParams(location.search).get('id');
let run;
let source;
const activeFilters = new Set(SEVERITIES);

async function load() {
  if (!runId) return fail('No run selected.');
  const res = await api(`/api/review/${encodeURIComponent(runId)}`);
  if (res.status === 404) return fail('This run does not exist or was deleted.');
  if (!res.ok) return fail('Could not load this run.');
  run = await res.json();
  render();
  if (ACTIVE.includes(run.status) && !source) subscribe();
}

function fail(message) {
  $('repo-name').textContent = 'Run not found';
  showBanner(message);
}

function render() {
  document.title = `${run.repoName} — OpenCodeReviewer`;
  $('repo-name').textContent = run.repoName;
  $('status-badge').innerHTML = badge(run);
  const parts = [
    escapeHtml(run.repoRoot),
    escapeHtml(run.model),
    `gate ${escapeHtml(run.severityGate)}`,
    `started ${escapeHtml(fmtWhen(run.startedAt || run.createdAt))}`,
    `took ${fmtDuration(run.startedAt, run.finishedAt)}`,
  ];
  if (run.files != null) parts.push(`${run.files} files · ${run.progress.total} batches`);
  $('meta').innerHTML = parts.join('<span class="sep">·</span>');

  const active = ACTIVE.includes(run.status);
  $('cancel').classList.toggle('hidden', !['queued', 'running'].includes(run.status));
  $('delete').classList.toggle('hidden', active);
  for (const kind of ['md', 'json']) {
    $(`dl-${kind}`).classList.toggle('hidden', !run.report);
    $(`dl-${kind}`).href = `/api/review/${run.id}/report.${kind}`;
  }

  renderProgress();
  renderWarnings();
  if (run.error) showBanner(run.error);
  if (run.report) renderReport(run.report);
  renderLog();
}

function renderProgress() {
  const show = ACTIVE.includes(run.status);
  $('progress-panel').classList.toggle('hidden', !show);
  if (!show) return;
  const { done, total, current } = run.progress;
  $('progress-fill').style.width = total ? `${Math.round((done / total) * 100)}%` : '0';
  $('progress-count').textContent = total ? `${done} / ${total} batches` : '';
  $('progress-text').textContent = run.status === 'queued'
    ? `Waiting in the queue${run.position ? ` (position ${run.position})` : ''}.`
    : run.status === 'cancelling'
      ? 'Cancelling. Waiting for the batches in flight to stop…'
      : current ? `Reviewing ${current}` : 'Planning batches…';
}

function renderWarnings() {
  const messages = [...new Set((run.log || []).filter((e) => e.type === 'warning').map((e) => e.message))];
  if (run.report?.contextWarning && !messages.includes(run.report.contextWarning)) messages.push(run.report.contextWarning);
  $('warnings-panel').classList.toggle('hidden', !messages.length);
  $('warnings').innerHTML = messages.map((m) => `<li>${escapeHtml(m)}</li>`).join('');
}

function renderReport(report) {
  $('summary').classList.remove('hidden');
  const cancelled = run.status === 'cancelled';
  const incomplete = report.status === 'incomplete' || cancelled;
  const gate = $('s-gate');
  gate.className = 'stat-value ' + (report.gateFailed ? 'bad' : incomplete ? 'warn' : 'ok');
  gate.textContent = report.gateFailed ? 'Failed' : incomplete ? 'Unverified' : 'Passed';
  $('s-gate-note').textContent = report.gateFailed
    ? `max severity ${report.maxSeverity} ≥ ${report.severityGate}`
    : cancelled
      ? `cancelled · ${report.meta.skippedBatches ?? 0} batch(es) skipped`
      : incomplete ? `${report.errors.length} batch(es) failed` : `nothing at ${report.severityGate} or above`;

  $('s-findings').textContent = report.totalFindings;
  $('s-findings-note').innerHTML = severityChips(report.counts, { compact: true });

  const u = report.usage || {};
  $('s-cost').textContent = fmtCost(u.costUsd);
  const perFile = u.costUsd != null && run.files ? ` · ${fmtCost(u.costUsd / run.files)} per file` : '';
  $('s-cost-note').textContent = (u.partial ? 'estimate, partly unavailable' : 'estimate') + perFile;
  $('s-tokens').textContent = fmtTokens(u.totalTokens);
  $('s-tokens-note').textContent = u.totalTokens == null
    ? 'unavailable'
    : `${fmtTokens(u.inputTokens)} in · ${fmtTokens(u.outputTokens)} out`;

  $('findings-panel').classList.remove('hidden');
  $('filters').innerHTML = SEVERITIES.map((s) =>
    `<button type="button" class="filter ${s}${activeFilters.has(s) ? ' on' : ''}" data-sev="${s}" aria-pressed="${activeFilters.has(s)}">
      ${s} <span>${report.counts[s] || 0}</span></button>`).join('');
  renderFindings();

  $('errors-panel').classList.toggle('hidden', !report.errors.length);
  $('errors').innerHTML = report.errors
    .map((e) => `<li><span class="mono-strong">${escapeHtml(e.label)}</span> <span class="faint">${escapeHtml(e.error)}</span></li>`)
    .join('');

  $('summaries-count').textContent = `(${report.summaries.length})`;
  $('summaries').innerHTML = report.summaries
    .map((s) => `<div class="summary"><div class="faint small">${escapeHtml(s.label)}</div><p>${escapeHtml(s.summary)}</p></div>`)
    .join('') || '<p class="faint">No summaries.</p>';
}

function renderFindings() {
  const report = run.report;
  const q = $('search').value.trim().toLowerCase();
  const shown = report.findings.filter((f) => activeFilters.has(f.severity) && (!q ||
    [f.file, f.category, f.message, f.suggestion].some((v) => String(v ?? '').toLowerCase().includes(q))));
  $('findings-shown').textContent = shown.length === report.findings.length
    ? `${shown.length}`
    : `${shown.length} of ${report.findings.length}`;

  if (!report.findings.length) {
    $('findings').innerHTML = `<p class="empty">${report.errors.length || run.status === 'cancelled'
      ? 'No findings in the batches that were reviewed.' : 'No issues found.'}</p>`;
    return;
  }
  if (!shown.length) {
    $('findings').innerHTML = '<p class="empty">No findings match the filters.</p>';
    return;
  }
  const byFile = new Map();
  for (const f of shown) {
    const key = f.file || '(no file)';
    if (!byFile.has(key)) byFile.set(key, []);
    byFile.get(key).push(f);
  }
  $('findings').innerHTML = [...byFile].map(([file, list]) => `
    <details class="file" open>
      <summary><span class="file-name">${escapeHtml(file)}</span>
        <span class="file-chips">${severityChips(countBySeverity(list), { compact: true })}</span></summary>
      ${list.map((f) => `
        <div class="finding ${f.severity}">
          <div class="finding-head">
            <span class="sev">${f.severity}</span>
            ${f.line ? `<span class="loc">line ${escapeHtml(f.line)}</span>` : ''}
            ${f.category ? `<span class="cat">${escapeHtml(f.category)}</span>` : ''}
          </div>
          <div class="msg">${escapeHtml(f.message)}</div>
          ${f.suggestion ? `<div class="sug"><span class="faint">fix ›</span> ${escapeHtml(f.suggestion)}</div>` : ''}
        </div>`).join('')}
    </details>`).join('');
}

function countBySeverity(list) {
  const counts = {};
  for (const f of list) counts[f.severity] = (counts[f.severity] || 0) + 1;
  return counts;
}

function renderLog() {
  $('details-panel').classList.toggle('hidden', !(run.log || []).length);
  $('log').innerHTML = (run.log || []).map((e) => `<li><span class="faint">${new Date(e.at).toLocaleTimeString()}</span> ${escapeHtml(describe(e))}</li>`).join('');
}

function describe(e) {
  switch (e.type) {
    case 'status': return e.status === 'queued' ? `queued${e.position ? ` (#${e.position})` : ''}` : e.status;
    case 'plan': return `plan: ${e.files} files → ${e.batches} batches`;
    case 'warning': return `warning: ${e.message}`;
    case 'context': return `context file: ${e.path}`;
    case 'batch-start': return `start ${e.label}`;
    case 'batch-done': return `[${e.completed}/${e.total}] ${e.label} — ${e.error ? 'error: ' + e.error : e.findingCount + ' finding(s)'}`;
    case 'complete': return 'completed';
    case 'cancelled': return 'cancelled';
    case 'error': return `failed: ${e.error}`;
    default: return e.type;
  }
}

function subscribe() {
  source = new EventSource(`/api/review/${run.id}/stream`);
  source.onmessage = (msg) => {
    const ev = JSON.parse(msg.data);
    if (['complete', 'cancelled', 'error'].includes(ev.type)) {
      source.close();
      source = null;
      return load();
    }
    if (ev.type === 'status') {
      run.status = ev.status;
      run.position = ev.position ?? null;
      if (ev.status === 'running' && !run.startedAt) run.startedAt = new Date(ev.at).toISOString();
    }
    if (ev.type === 'plan') { run.progress.total = ev.batches; run.files = ev.files; }
    if (ev.type === 'batch-start') run.progress.current = ev.label;
    if (ev.type === 'batch-done') run.progress.done = ev.completed;
    if (!run.log.some((e) => e.at === ev.at && e.type === ev.type)) run.log.push(ev);
    render();
  };
  source.onerror = () => {
    source.close();
    source = null;
    setTimeout(load, 3000);
  };
}

$('filters').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-sev]');
  if (!btn) return;
  const s = btn.dataset.sev;
  if (activeFilters.has(s)) activeFilters.delete(s); else activeFilters.add(s);
  btn.classList.toggle('on', activeFilters.has(s));
  btn.setAttribute('aria-pressed', activeFilters.has(s));
  renderFindings();
});
$('search').addEventListener('input', renderFindings);

$('cancel').addEventListener('click', async () => {
  $('cancel').disabled = true;
  const res = await postJson(`/api/review/${run.id}/cancel`);
  if (!res.ok) showBanner((await res.json()).error || 'Could not cancel the run.');
  $('cancel').disabled = false;
  load();
});

// Two clicks to delete, without a browser dialog.
let deleteArmed;
$('delete').addEventListener('click', async () => {
  if (!deleteArmed) {
    $('delete').textContent = 'Confirm delete';
    deleteArmed = setTimeout(() => { deleteArmed = null; $('delete').textContent = 'Delete'; }, 4000);
    return;
  }
  clearTimeout(deleteArmed);
  const res = await postJson(`/api/review/${run.id}`, {}, 'DELETE');
  if (res.status === 204) return location.replace('/');
  showBanner((await res.json().catch(() => ({}))).error || 'Could not delete the run.');
});

function showBanner(text) {
  $('banner').textContent = text;
  $('banner').className = 'banner error';
}

// Keep the elapsed time fresh while a run is active.
setInterval(() => { if (run && ACTIVE.includes(run.status)) render(); }, 1000);
load();
