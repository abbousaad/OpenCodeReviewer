const $ = (id) => document.getElementById(id);

// A lapsed session or a pending password change sends the user to the sign-in page.
async function api(url, options) {
  const res = await fetch(url, options);
  if (res.status === 401 || res.status === 403) {
    const data = await res.clone().json().catch(() => ({}));
    if (res.status === 401 || data.mustChangePassword) location.replace('/login.html');
  }
  return res;
}

/** State-changing calls must send JSON, even with an empty body. */
function postJson(url, body = {}, method = 'POST') {
  return api(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
}

$('logout').addEventListener('click', async () => {
  await postJson('/api/auth/logout');
  location.replace('/login.html');
});

const SEVERITIES = ['critical', 'major', 'minor', 'info'];
const ACTIVE = ['queued', 'running', 'cancelling'];

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function fmtCost(usd) {
  if (usd == null) return '—';
  if (usd === 0) return '$0.00';
  if (usd < 0.01) return '$' + usd.toPrecision(2).replace(/0+$/, '');
  return usd.toLocaleString(undefined, { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function fmtTokens(n) {
  if (n == null) return '—';
  if (n >= 1e6) return (n / 1e6).toFixed(n >= 1e7 ? 0 : 1) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(n >= 1e4 ? 0 : 1) + 'k';
  return String(n);
}

function fmtDuration(start, end) {
  if (!start) return '—';
  const s = Math.max(0, Math.round(((end ? new Date(end) : new Date()) - new Date(start)) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
}

function fmtWhen(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  const diff = (Date.now() - d) / 1000;
  if (diff < 60) return 'just now';
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) + ' ' +
    d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

/** The label and badge style for a run, including the gate result once finished. */
function runState(run) {
  if (run.status === 'queued') return { label: run.position ? `queued #${run.position}` : 'queued', cls: 'muted' };
  if (run.status === 'running') return { label: 'running', cls: 'accent' };
  if (run.status === 'cancelling') return { label: 'cancelling', cls: 'muted' };
  if (run.status === 'cancelled') return { label: 'cancelled', cls: 'muted' };
  if (run.status === 'interrupted') return { label: 'interrupted', cls: 'warn' };
  if (run.status === 'error') return { label: 'failed', cls: 'bad' };
  // A finding at the gate fails the run even when other batches failed.
  if (run.gateFailed) return { label: 'gate failed', cls: 'bad' };
  if (run.reportStatus === 'incomplete') return { label: 'incomplete', cls: 'warn' };
  return { label: 'passed', cls: 'ok' };
}

function badge(run) {
  const { label, cls } = runState(run);
  return `<span class="badge ${cls}">${escapeHtml(label)}</span>`;
}

function severityChips(counts, { compact = false } = {}) {
  if (!counts) return '<span class="faint">—</span>';
  return SEVERITIES
    .filter((s) => !compact || counts[s])
    .map((s) => `<span class="chip ${s}" title="${s}">${counts[s] || 0}${compact ? '' : ' ' + s}</span>`)
    .join('') || '<span class="faint">0</span>';
}
