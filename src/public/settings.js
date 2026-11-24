const NUMBER_FIELDS = ['batch.maxFiles', 'batch.maxBytes', 'diff.maxHunkBytesPerCall', 'concurrency', 'maxParallelReviews', 'runsToKeep', 'timeoutSeconds'];
let view;

function render(data) {
  view = data;
  const { settings, locked, secrets, models } = data;

  const select = $('model-select');
  select.innerHTML = '';
  const known = models.some((m) => m.id === settings.model);
  for (const m of models) select.add(new Option(`${m.name} (${m.id})`, m.id));
  select.add(new Option('Custom…', ''));
  select.value = known ? settings.model : '';
  $('model-custom').value = known ? '' : settings.model;
  $('model-custom').classList.toggle('hidden', known);

  $('severityGate').value = settings.severityGate;
  $('include').value = settings.include.join('\n');
  $('exclude').value = settings.exclude.join('\n');
  $('batch.maxFiles').value = settings.batch.maxFiles;
  $('batch.maxBytes').value = settings.batch.maxBytes;
  $('diff.maxHunkBytesPerCall').value = settings.diff.maxHunkBytesPerCall;
  $('concurrency').value = settings.concurrency;
  $('timeoutSeconds').value = settings.timeoutSeconds;
  $('maxParallelReviews').value = settings.maxParallelReviews;
  $('runsToKeep').value = settings.runsToKeep;
  updateLoadHint();
  $('contextFileRequired').checked = settings.contextFileRequired;

  for (const [key, envName] of Object.entries(locked)) {
    const label = document.querySelector(`[data-key="${key}"]`);
    label.querySelectorAll('input, select').forEach((el) => { el.disabled = true; });
    const note = document.createElement('span');
    note.className = 'hint locked';
    note.textContent = `Set by ${envName}`;
    label.append(note);
  }

  $('secrets').innerHTML = '';
  for (const [key, s] of Object.entries(secrets)) {
    // A div, not a label: it also holds the separate "remove" checkbox label.
    const field = document.createElement('div');
    field.className = 'field';
    field.dataset.key = `secrets.${key}`;
    const label = document.createElement('label');
    label.htmlFor = `secret-${key}`;
    const status = s.fromEnv ? 'set by the environment' : s.set ? 'saved' : 'not set';
    label.append(`${s.label} `);
    const hint = document.createElement('span');
    hint.className = 'hint';
    hint.textContent = `(${status})`;
    label.append(hint);
    field.append(label);
    const input = document.createElement('input');
    input.type = 'password';
    input.id = `secret-${key}`;
    input.autocomplete = 'off';
    input.disabled = s.fromEnv;
    input.placeholder = s.set ? '•••••••• (unchanged)' : '';
    field.append(input);
    if (s.set && !s.fromEnv) {
      const clear = document.createElement('label');
      clear.className = 'checkbox';
      clear.innerHTML = `<input type="checkbox" id="clear-${key}" /> Remove the saved value`;
      field.append(clear);
    }
    $('secrets').append(field);
  }
}

function lines(id) {
  const list = $(id).value.split('\n').map((l) => l.trim()).filter(Boolean);
  return list.length ? list : null;
}

function collect() {
  const settings = {};
  const model = $('model-select').value || $('model-custom').value.trim();
  settings.model = model || null;
  settings.severityGate = $('severityGate').value;
  settings.include = lines('include');
  settings.exclude = lines('exclude');
  settings.contextFileRequired = $('contextFileRequired').checked;
  const nested = {};
  for (const id of NUMBER_FIELDS) {
    const raw = $(id).value.trim();
    const value = raw === '' ? null : Number(raw);
    const [group, key] = id.split('.');
    if (key) (nested[group] ??= {})[key] = value;
    else settings[id] = value;
  }
  // Empty number fields reset the whole group, since saved groups merge over defaults.
  for (const [group, values] of Object.entries(nested)) {
    settings[group] = Object.values(values).every((v) => v === null)
      ? null
      : Object.fromEntries(Object.entries(values).filter(([, v]) => v !== null));
  }
  for (const key of Object.keys(view.locked)) delete settings[key];

  const secrets = {};
  for (const [key, s] of Object.entries(view.secrets)) {
    if (s.fromEnv) continue;
    const value = $(`secret-${key}`).value;
    if (value) secrets[key] = value;
    else if ($(`clear-${key}`)?.checked) secrets[key] = null;
  }
  return { settings, secrets };
}

function showErrors(fields = {}) {
  document.querySelectorAll('.field-error').forEach((el) => el.remove());
  document.querySelectorAll('[aria-invalid]').forEach((el) => el.removeAttribute('aria-invalid'));
  for (const [key, message] of Object.entries(fields)) {
    const label = document.querySelector(`[data-key="${key}"]`) || document.querySelector(`[data-key="${key.split('.')[0]}"]`);
    if (!label) continue;
    const error = document.createElement('span');
    error.className = 'field-error';
    error.textContent = `${key.replace(/^secrets\./, '')} ${message}`;
    label.append(error);
    label.querySelector('input, select, textarea')?.setAttribute('aria-invalid', 'true');
  }
}

function showBanner(text) {
  $('banner').textContent = text;
  $('banner').className = 'banner error';
}

// The most model calls in flight at once: parallel reviews × batches per review.
function updateLoadHint() {
  const reviews = Number($('maxParallelReviews').value) || 1;
  const batches = Number($('concurrency').value) || 1;
  $('load-hint').textContent = `Up to ${reviews * batches} model call(s) at once (${reviews} review(s) × ${batches} batch(es) each).`;
}
$('maxParallelReviews').addEventListener('input', updateLoadHint);
$('concurrency').addEventListener('input', updateLoadHint);

$('model-select').addEventListener('change', () => {
  $('model-custom').classList.toggle('hidden', $('model-select').value !== '');
});

$('settings-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('banner').classList.add('hidden');
  $('saved').classList.add('hidden');
  showErrors();
  $('save').disabled = true;
  try {
    const res = await api('/api/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(collect()),
    });
    const data = await res.json();
    if (!res.ok) {
      showErrors(data.fields);
      showBanner(data.error || 'Could not save the settings.');
      return;
    }
    document.querySelectorAll('.locked').forEach((el) => el.remove());
    render(data);
    $('saved').classList.remove('hidden');
  } catch (err) {
    showBanner(err.message);
  } finally {
    $('save').disabled = false;
  }
});

api('/api/settings')
  .then((r) => r.json())
  .then(render)
  .catch(() => showBanner('Could not load the settings.'));
