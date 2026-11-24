const SKIP = new Set(['.git', 'node_modules', '__MACOSX', '.DS_Store', '.svn', '.hg']);
let limits = { maxUploadBytes: 200e6, maxFiles: 20000, maxFileBytes: 2e6, gitHosts: [] };
let repos = [];
let picked = null; // { kind: 'zip', file } or { kind: 'folder', entries, skipped, bytes, root }
let pollTimer;

const fmtBytes = (n) => n == null ? '—' : n >= 1e6 ? `${(n / 1e6).toFixed(1)} MB` : n >= 1e3 ? `${Math.round(n / 1e3)} kB` : `${n} B`;

// Tabs
document.querySelector('.tabs').addEventListener('click', (e) => {
  const tab = e.target.closest('[data-tab]');
  if (!tab) return;
  for (const t of document.querySelectorAll('.tab')) {
    const on = t === tab;
    t.classList.toggle('on', on);
    t.setAttribute('aria-selected', on);
    $(`tab-${t.dataset.tab}`).classList.toggle('hidden', !on);
  }
  hideBanner();
});

async function loadCandidates() {
  const select = $('local-path');
  try {
    const { root, candidates } = await (await api('/api/repos/candidates')).json();
    $('root-hint').textContent = `(inside ${root})`;
    select.innerHTML = '';
    for (const c of candidates) {
      const label = (c.depth === 0 ? `${c.name}  (review root)` : c.name + (c.git ? '' : '/')) + (c.saved ? '  · saved' : '');
      const opt = new Option(label, c.path);
      opt.disabled = c.saved;
      select.add(opt);
    }
    const first = candidates.find((c) => !c.saved && c.git && c.depth > 0) || candidates.find((c) => !c.saved);
    if (first) select.value = first.path;
  } catch {
    showBanner('Could not list folders.');
  }
}

async function refresh() {
  try {
    const data = await (await api('/api/repos')).json();
    limits = data.limits;
    repos = data.repos;
    $('upload-limits').textContent = `Up to ${fmtBytes(limits.maxUploadBytes)}, ${limits.maxFiles.toLocaleString()} files, ${fmtBytes(limits.maxFileBytes)} per file. node_modules and .git are skipped.`;
    $('git-hint').textContent = `Allowed hosts: ${limits.gitHosts.join(', ') || 'none'}. Private github.com repos use the GitHub token from Settings.`;
    render();
  } catch {
    // Keep the last view.
  }
  clearTimeout(pollTimer);
  if (repos.some((r) => r.status === 'cloning' || r.busy)) pollTimer = setTimeout(refresh, 2000);
}

function sourceCell(r) {
  if (r.source === 'local') return `<span class="badge muted">local</span><div class="faint small path">${escapeHtml(r.path)}</div>`;
  if (r.source === 'git') {
    return `<span class="badge muted">git</span><div class="faint small path">${escapeHtml(r.url)}${r.branch ? ` · ${escapeHtml(r.branch)}` : ''}</div>`;
  }
  const skipped = Object.values(r.skipped || {}).reduce((a, b) => a + b, 0);
  return `<span class="badge muted">upload</span><div class="faint small">${escapeHtml(fmtWhen(r.createdAt))}${skipped ? ` · ${skipped} skipped` : ''}</div>`;
}

function render() {
  $('repos-empty').classList.toggle('hidden', repos.length > 0);
  $('repo-count').textContent = repos.length ? `${repos.length} saved` : '';
  $('repos').innerHTML = repos.map((r) => {
    const state = r.status === 'cloning'
      ? '<span class="badge accent">cloning</span>'
      : r.status === 'error' ? '<span class="badge bad">error</span>' : '';
    const last = r.lastRun
      ? `<a class="plain-link" href="/run.html?id=${r.lastRun.id}">${badge(r.lastRun)}</a> <span class="faint small">${escapeHtml(fmtWhen(r.lastRun.createdAt))}</span>`
      : '<span class="faint">never</span>';
    const size = r.files != null ? `${fmtBytes(r.bytes)}<div class="faint small">${r.files.toLocaleString()} files</div>` : '<span class="faint">—</span>';
    const ready = r.status === 'ready';
    return `<tr data-id="${r.id}" class="static">
      <td><div class="repo">${escapeHtml(r.name)} ${state}</div>${r.error ? `<div class="bad small">${escapeHtml(r.error)}</div>` : ''}</td>
      <td>${sourceCell(r)}</td>
      <td class="num">${size}</td>
      <td>${last}</td>
      <td class="num">${fmtCost(r.spend?.costUsd ?? 0)}<div class="faint small">${r.spend?.runs ?? 0} runs</div></td>
      <td class="num row-actions">
        <button type="button" class="secondary small-btn" data-act="review" ${ready && !r.busy ? '' : 'disabled'}>${r.busy ? 'Reviewing…' : 'Review'}</button>
        ${r.source === 'git' ? `<button type="button" class="link" data-act="pull" ${ready && !r.busy ? '' : 'disabled'}>Pull</button>` : ''}
        <button type="button" class="link" data-act="remove" ${r.busy || r.status === 'cloning' ? 'disabled' : ''}>Remove</button>
      </td>
    </tr>`;
  }).join('');
}

// Row actions
const armed = new Map();
$('repos').addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-act]');
  if (!btn) return;
  const id = btn.closest('tr').dataset.id;
  hideBanner();
  if (btn.dataset.act === 'review') {
    btn.disabled = true;
    const res = await postJson('/api/review', { repoId: id });
    const data = await res.json();
    if (!res.ok) { showBanner(data.error || 'Could not start the review.'); btn.disabled = false; return; }
    location.href = `/run.html?id=${data.id}`;
  } else if (btn.dataset.act === 'pull') {
    const res = await postJson(`/api/repos/${id}/pull`);
    if (!res.ok) showBanner((await res.json()).error || 'Could not update the repository.');
    refresh();
  } else if (btn.dataset.act === 'remove') {
    const repo = repos.find((r) => r.id === id);
    if (!armed.has(id)) {
      btn.textContent = repo.source === 'local' ? 'Confirm (files stay)' : 'Confirm delete';
      btn.classList.add('armed');
      armed.set(id, setTimeout(() => { armed.delete(id); render(); }, 4000));
      return;
    }
    clearTimeout(armed.get(id));
    armed.delete(id);
    const res = await postJson(`/api/repos/${id}`, {}, 'DELETE');
    if (res.status !== 204) showBanner((await res.json().catch(() => ({}))).error || 'Could not remove the repository.');
    refresh();
    loadCandidates();
  }
});

// Local folder
$('tab-local').addEventListener('submit', async (e) => {
  e.preventDefault();
  hideBanner();
  const res = await postJson('/api/repos', { source: 'local', path: $('local-path').value, name: $('local-name').value });
  const data = await res.json();
  if (!res.ok) return showBanner(data.error || 'Could not add the folder.');
  $('local-name').value = '';
  showBanner(`Added ${data.name}.`, false);
  refresh();
  loadCandidates();
});

// Git
$('tab-git').addEventListener('submit', async (e) => {
  e.preventDefault();
  hideBanner();
  const res = await postJson('/api/repos', {
    source: 'git', url: $('git-url').value.trim(), branch: $('git-branch').value.trim() || undefined, name: $('git-name').value,
  });
  const data = await res.json();
  if (!res.ok) return showBanner(data.error || 'Could not start the clone.');
  for (const id of ['git-url', 'git-branch', 'git-name']) $(id).value = '';
  showBanner(`Cloning ${data.name}…`, false);
  refresh();
});

// Upload
$('pick-folder').addEventListener('click', () => $('folder-input').click());
$('pick-zip').addEventListener('click', () => $('zip-input').click());

$('zip-input').addEventListener('change', () => {
  const file = $('zip-input').files[0];
  if (!file) return;
  picked = { kind: 'zip', file };
  if (!$('upload-name').value) $('upload-name').value = file.name.replace(/\.zip$/i, '');
  const tooBig = file.size > limits.maxUploadBytes;
  $('pick-summary').textContent = `${file.name} · ${fmtBytes(file.size)}${tooBig ? ' · over the limit' : ''}`;
  $('upload-btn').disabled = tooBig;
  $('zip-input').value = '';
});

$('folder-input').addEventListener('change', () => {
  const files = [...$('folder-input').files];
  $('folder-input').value = '';
  if (!files.length) return;
  const entries = [];
  const skipped = { ignored: 0, large: 0 };
  let bytes = 0;
  for (const file of files) {
    const rel = file.webkitRelativePath || file.name;
    if (rel.split('/').some((s) => SKIP.has(s))) { skipped.ignored++; continue; }
    if (file.size > limits.maxFileBytes) { skipped.large++; continue; }
    entries.push({ path: rel, file });
    bytes += file.size;
  }
  const root = (files[0].webkitRelativePath || '').split('/')[0];
  picked = { kind: 'folder', entries, bytes, root };
  if (!$('upload-name').value && root) $('upload-name').value = root;
  const problems = [];
  if (entries.length > limits.maxFiles) problems.push(`more than ${limits.maxFiles.toLocaleString()} files`);
  if (bytes > limits.maxUploadBytes) problems.push(`over ${fmtBytes(limits.maxUploadBytes)}`);
  const skipNote = [skipped.ignored && `${skipped.ignored} in ignored folders`, skipped.large && `${skipped.large} too large`].filter(Boolean).join(', ');
  $('pick-summary').textContent = `${root || 'folder'}/ · ${entries.length.toLocaleString()} files · ${fmtBytes(bytes)}` +
    (skipNote ? ` · skipping ${skipNote}` : '') + (problems.length ? ` · ${problems.join(', ')}` : '');
  $('upload-btn').disabled = !entries.length || problems.length > 0;
});

$('tab-upload').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!picked) return;
  hideBanner();
  $('upload-btn').disabled = true;
  $('upload-progress').classList.remove('hidden');
  const fill = $('upload-fill');
  fill.style.width = '0';
  try {
    let body = picked.file;
    if (picked.kind === 'folder') {
      $('pick-summary').textContent = 'Packing files…';
      body = await buildZip(picked.entries, (done, total) => { fill.style.width = `${Math.round((done / total) * 30)}%`; });
    }
    const base = picked.kind === 'folder' ? 30 : 0;
    $('pick-summary').textContent = 'Uploading…';
    const data = await new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', `/api/repos/upload?name=${encodeURIComponent($('upload-name').value.trim())}`);
      xhr.setRequestHeader('Content-Type', 'application/zip');
      xhr.upload.onprogress = (ev) => {
        if (ev.lengthComputable) fill.style.width = `${base + Math.round((ev.loaded / ev.total) * (100 - base))}%`;
      };
      xhr.onload = () => {
        if (xhr.status === 401) return location.replace('/login.html');
        let json = {};
        try { json = JSON.parse(xhr.responseText); } catch { /* not JSON */ }
        if (xhr.status >= 200 && xhr.status < 300) resolve(json);
        else reject(new Error(json.error || `Upload failed (${xhr.status}).`));
      };
      xhr.onerror = () => reject(new Error('The upload failed. Check the connection and try again.'));
      xhr.send(body);
    });
    const skipped = Object.entries(data.skipped || {}).map(([why, n]) => `${n} ${why}`).join(', ');
    showBanner(`Uploaded ${data.name}: ${data.files.toLocaleString()} files${skipped ? ` (skipped ${skipped})` : ''}.`, false);
    picked = null;
    $('upload-name').value = '';
    $('pick-summary').textContent = 'Nothing selected.';
    refresh();
  } catch (err) {
    showBanner(err.message);
    $('pick-summary').textContent = 'Upload failed.';
    $('upload-btn').disabled = false;
  } finally {
    $('upload-progress').classList.add('hidden');
  }
});

function showBanner(text, isError = true) {
  $('banner').textContent = text;
  $('banner').className = 'banner' + (isError ? ' error' : '');
}
function hideBanner() {
  $('banner').classList.add('hidden');
}

loadCandidates();
refresh();
