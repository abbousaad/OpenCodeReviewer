
// Prefill form defaults from server config.
api('/api/config')
  .then((r) => r.json())
  .then((c) => {
    if (c.repoRoot && !$('repoRoot').value) $('repoRoot').value = c.repoRoot;
    if (c.model) $('model').placeholder = c.model;
    if (c.severityGate) $('severityGate').value = c.severityGate;
  })
  .catch(() => {});

$('review-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  resetUI();
  const body = {
    repoRoot: $('repoRoot').value.trim(),
    severityGate: $('severityGate').value,
    model: $('model').value.trim() || undefined,
  };
  $('start-btn').disabled = true;

  try {
    const res = await api('/api/review', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'failed to start review');
    $('progress-panel').classList.remove('hidden');
    subscribe(data.id);
  } catch (err) {
    showBanner(err.message, true);
    $('start-btn').disabled = false;
  }
});

function subscribe(id) {
  const src = new EventSource(`/api/review/${id}/stream`);
  src.onmessage = (msg) => {
    const ev = JSON.parse(msg.data);
    handleEvent(id, ev);
    if (ev.type === 'complete' || ev.type === 'error') src.close();
  };
  src.onerror = () => {
    src.close();
    showBanner('Lost the review progress connection.', true);
    $('start-btn').disabled = false;
  };
}

function handleEvent(id, ev) {
  switch (ev.type) {
    case 'plan':
      $('progress-text').textContent = `${ev.files} file(s) in ${ev.batches} batch(es)…`;
      addLog(`plan: ${ev.files} files → ${ev.batches} batches`);
      break;
    case 'warning':
      showBanner('⚠️ ' + ev.message, false);
      break;
    case 'context':
      addLog(`context file: ${ev.path}`);
      break;
    case 'batch-start':
      $('progress-text').textContent = `Reviewing ${ev.label} (batch ${ev.index + 1} of ${ev.total})`;
      break;
    case 'batch-done': {
      const pct = Math.round((ev.completed / ev.total) * 100);
      $('progress-fill').style.width = pct + '%';
      addLog(`[${ev.completed}/${ev.total} done] ${ev.label} — ${ev.error ? 'error' : ev.findingCount + ' finding(s)'}`);
      break;
    }
    case 'complete':
      $('progress-text').textContent = ev.report.errors.length ? 'Review incomplete.' : 'Done.';
      renderResults(id, ev.report);
      break;
    case 'error':
      showBanner('Review failed: ' + ev.error, true);
      $('start-btn').disabled = false;
      break;
  }
}

function renderResults(id, report) {
  $('start-btn').disabled = false;
  $('results-panel').classList.remove('hidden');
  $('download').href = `/api/review/${id}/report.md`;

  const gate = $('gate');
  gate.className = 'gate ' + (report.gateFailed || report.errors.length ? 'fail' : 'pass');
  if (report.errors.length) {
    gate.textContent = '⚠️ Review incomplete';
  } else if (report.gateFailed) {
    gate.textContent = `❌ Gate '${report.severityGate}' failed (max severity: ${report.maxSeverity})`;
  } else {
    gate.textContent = `✅ Gate '${report.severityGate}' passed`;
  }
  if (report.errors.length) {
    showBanner(`${report.errors.length} batch(es) failed. See the downloaded report for details.`, true);
  }

  const { totalTokens, inputTokens, outputTokens, costUsd, partial } = report.usage ?? {};
  const tokens = totalTokens == null
    ? 'Token usage unavailable'
    : `${totalTokens.toLocaleString()} tokens (${inputTokens.toLocaleString()} input, ${outputTokens.toLocaleString()} output)`;
  const cost = costUsd == null ? 'unavailable' : costUsd.toLocaleString(undefined, {
    style: 'currency', currency: 'USD', maximumFractionDigits: 8,
  });
  $('usage').textContent = `${tokens} · Estimated cost (USD) ${cost}${partial ? ' · Some usage or pricing data was unavailable.' : ''}`;

  $('counts').innerHTML = report.errors.length && !report.totalFindings
    ? ''
    : ['critical', 'major', 'minor', 'info']
      .map((s) => `<span class="chip ${s}">${report.counts[s] || 0} ${s}</span>`)
      .join('');

  const container = $('findings');
  if (!report.findings.length) {
    container.innerHTML = report.errors.length ? '' : '<p>No issues found. ✅</p>';
    return;
  }
  container.innerHTML = report.findings
    .map((f) => {
      const loc = f.line ? `${escapeHtml(f.file)}:${f.line}` : escapeHtml(f.file);
      return `<div class="finding ${f.severity}">
        <div><span class="sev">${f.severity}</span><span class="loc">${loc} · ${escapeHtml(f.category)}</span></div>
        <div class="msg">${escapeHtml(f.message)}</div>
        ${f.suggestion ? `<div class="sug">💡 ${escapeHtml(f.suggestion)}</div>` : ''}
      </div>`;
    })
    .join('');
}

function resetUI() {
  $('banner').classList.add('hidden');
  $('results-panel').classList.add('hidden');
  $('log').innerHTML = '';
  $('progress-fill').style.width = '0';
  $('findings').innerHTML = '';
}
function showBanner(text, isError) {
  const b = $('banner');
  b.textContent = text;
  b.className = 'banner' + (isError ? ' error' : '');
  b.classList.remove('hidden');
}
function addLog(text) {
  const li = document.createElement('li');
  li.textContent = text;
  $('log').appendChild(li);
  $('log').scrollTop = $('log').scrollHeight;
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
