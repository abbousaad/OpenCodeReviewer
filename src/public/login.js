const $ = (id) => document.getElementById(id);

async function post(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Request failed.');
  return data;
}

function showChange(currentPassword = '') {
  $('login-panel').classList.add('hidden');
  $('change-panel').classList.remove('hidden');
  $('current-password').value = currentPassword;
  (currentPassword ? $('new-password') : $('current-password')).focus();
}

function showBanner(text) {
  const b = $('banner');
  b.textContent = text;
  b.className = 'banner error';
}

fetch('/api/auth/session')
  .then((r) => r.json())
  .then((s) => {
    if (!s.authenticated) return;
    if (s.mustChangePassword) showChange();
    else location.replace('/');
  })
  .catch(() => {});

$('login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('banner').classList.add('hidden');
  const password = $('password').value;
  try {
    const state = await post('/api/auth/login', { username: $('username').value.trim(), password });
    if (state.mustChangePassword) showChange(password);
    else location.replace('/');
  } catch (err) {
    showBanner(err.message);
  }
});

$('change-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('banner').classList.add('hidden');
  if ($('new-password').value !== $('confirm-password').value) {
    showBanner('The new passwords do not match.');
    return;
  }
  try {
    await post('/api/auth/password', {
      currentPassword: $('current-password').value,
      newPassword: $('new-password').value,
    });
    location.replace('/');
  } catch (err) {
    showBanner(err.message);
  }
});
