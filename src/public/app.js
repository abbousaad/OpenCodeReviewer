let runs = [];
let pollTimer;

async function loadRepos() {
  const select = $('repo-select');
  try {
    const { repos } = await (await api('/api/repos')).json();
    const ready = repos.filter((r) => r.status === 'ready');
    select.innerHTML = '';
    for (const r of ready) select.add(new Option(`${r.name}  · ${r.source}`, r.id));
    const none = !ready.length;
    if (none) select.add(new Option('No repositories yet. Add one first.', ''));
    select.disabled = none;
    $('start-btn').disabled = none;
    $('root-hint').innerHTML = none
      ? '<a class="hint-link" href="/repos.html">Add a repository</a> to start reviewing.'
      : `${ready.length} repositor${ready.length === 1 ? 'y' : 'ies'} saved.`;
  } catch {
    showBanner('Could not load the repositories.');
  }
}

api('/api/config')
  .then((r) => r.json())
  .then((c) => {
    if (c.model) $('model').placeholder = c.model;
    if (c.severityGate) $('severityGate').value = c.severityGate;
  })
  .catch(() => {});

$('review-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  hideBanner();
  const body = {
    repoId: $('repo-select').value,
    severityGate: $('severityGate').value,
    model: $('model').value.trim() || undefined,
  };
  $('start-btn').disabled = true;
  try {
    const res = await postJson('/api/review', body);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Could not start the review.');
    await refresh();
  } catch (err) {
    showBanner(err.message);
  } finally {
    $('start-btn').disabled = !$('repo-select').value;
  }
});

async function refresh() {
  try {
    const [list, stats] = await Promise.all([
      api('/api/review').then((r) => r.json()),
      api('/api/stats').then((r) => r.json()),
    ]);
    runs = list;
    renderRuns();
    renderStats(stats);
  } catch {
    // Keep the last view; the next poll retries.
  }
  clearTimeout(pollTimer);
  pollTimer = setTimeout(refresh, runs.some((r) => ACTIVE.includes(r.status)) ? 2000 : 15000);
}

function renderStats(s) {
  const all = s.allTime;
  const month = s.thisMonth;
  $('stat-total').textContent = fmtCost(all.costUsd);
  $('stat-total-note').textContent = `${all.runs} run${all.runs === 1 ? '' : 's'}${all.partial ? ' · some costs unavailable' : ''}`;
  $('stat-month-name').textContent = new Date(month.month + '-01T00:00:00Z')
    .toLocaleDateString(undefined, { month: 'long', timeZone: 'UTC' });
  $('stat-month').textContent = fmtCost(month.costUsd);
  $('stat-month-note').textContent = `${month.runs} run${month.runs === 1 ? '' : 's'}`;
  $('stat-tokens').textContent = fmtTokens(all.totalTokens);
  $('stat-tokens-note').textContent = `${fmtTokens(all.inputTokens)} in · ${fmtTokens(all.outputTokens)} out`;
  $('stat-queue').textContent = `${s.running} / ${s.limits.maxParallelReviews}`;
  $('stat-queue-note').textContent = `running · ${s.queued} queued`;
}

function renderRuns() {
  $('runs-empty').classList.toggle('hidden', runs.length > 0);
  $('runs-count').textContent = runs.length ? `${runs.length} saved` : '';
  $('runs').innerHTML = runs.map((r) => {
    const active = ACTIVE.includes(r.status);
    const pct = r.progress?.total ? Math.round((r.progress.done / r.progress.total) * 100) : 0;
    const findings = r.status === 'running' || r.status === 'cancelling'
      ? `<span class="faint">${r.progress?.done ?? 0}/${r.progress?.total || '?'} batches</span>`
      : severityChips(r.counts, { compact: true });
    const action = active
      ? `<button type="button" class="link" data-cancel="${r.id}">Cancel</button>`
      : '';
    return `<tr data-id="${r.id}" tabindex="0">
      <td>${badge(r)}</td>
      <td>
        <div class="repo">${escapeHtml(r.repoName)}</div>
        <div class="faint small">${escapeHtml(r.model)} · gate ${escapeHtml(r.severityGate)}</div>
        ${r.status === 'running' ? `<div class="mini-bar"><div data-pct="${pct}"></div></div>` : ''}
      </td>
      <td class="chips">${findings}</td>
      <td class="num">${fmtCost(r.usage?.costUsd)}</td>
      <td class="num">${fmtDuration(r.startedAt, r.finishedAt)}</td>
      <td class="faint">${fmtWhen(r.createdAt)}</td>
      <td class="num">${action}</td>
    </tr>`;
  }).join('');
  // Widths are set through the CSSOM: the CSP blocks inline style attributes.
  document.querySelectorAll('.mini-bar > div').forEach((el) => { el.style.width = el.dataset.pct + '%'; });
}

$('runs').addEventListener('click', async (e) => {
  const cancel = e.target.closest('[data-cancel]');
  if (cancel) {
    e.stopPropagation();
    cancel.disabled = true;
    const res = await postJson(`/api/review/${cancel.dataset.cancel}/cancel`);
    if (!res.ok) showBanner((await res.json()).error || 'Could not cancel the run.');
    return refresh();
  }
  const row = e.target.closest('tr[data-id]');
  if (row) location.href = `/run.html?id=${row.dataset.id}`;
});
$('runs').addEventListener('keydown', (e) => {
  const row = e.target.closest('tr[data-id]');
  if (row && e.key === 'Enter') location.href = `/run.html?id=${row.dataset.id}`;
});

function showBanner(text) {
  $('banner').textContent = text;
  $('banner').className = 'banner error';
}
function hideBanner() {
  $('banner').classList.add('hidden');
}

loadRepos();
refresh();
