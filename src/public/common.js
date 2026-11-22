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

$('logout').addEventListener('click', async () => {
  await fetch('/api/auth/logout', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  location.replace('/login.html');
});
