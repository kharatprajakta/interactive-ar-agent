// Hello Crew admin panel (front end). Copyright (c) 2026 PacificAI. All rights reserved.
const $ = (id) => document.getElementById(id);
let current = null; // user shown in the dialog
let searchTimer = null;

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(path, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-Hello-Crew-Admin': '1' },
    body: body && JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && path !== '/api/login') {
    showLogin();
    throw new Error('signed out');
  }
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------
const fmtDate = (d) => (d ? new Date(d).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : '—');
const fmtDateTime = (d) => (d ? new Date(d).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—');
function ago(d) {
  if (!d) return 'never';
  const s = (Date.now() - new Date(d).getTime()) / 1000;
  if (s < 90) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  if (s < 86400 * 30) return `${Math.round(s / 86400)} d ago`;
  return fmtDate(d);
}
function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') node.className = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else if (v !== undefined && v !== null) node.setAttribute(k, v);
  }
  for (const c of children.flat()) node.append(c instanceof Node ? c : document.createTextNode(String(c ?? '')));
  return node;
}

// ---------------------------------------------------------------------------
// Sign in / out
// ---------------------------------------------------------------------------
function showLogin() {
  $('app').hidden = true;
  $('login').hidden = false;
  $('login-user').focus();
}

async function showApp(username) {
  $('login').hidden = true;
  $('app').hidden = false;
  $('who').textContent = username;
  await refresh();
}

$('login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('login-error').hidden = true;
  try {
    const { username } = await api('/api/login', { method: 'POST', body: { username: $('login-user').value, password: $('login-pass').value } });
    $('login-pass').value = '';
    showApp(username);
  } catch (err) {
    $('login-error').textContent = err.message;
    $('login-error').hidden = false;
  }
});

$('btn-logout').addEventListener('click', async () => {
  await api('/api/logout', { method: 'POST' }).catch(() => {});
  showLogin();
});

// ---------------------------------------------------------------------------
// Tabs
// ---------------------------------------------------------------------------
let tab = 'overview';
for (const b of document.querySelectorAll('[data-tab]')) {
  b.addEventListener('click', () => {
    tab = b.dataset.tab;
    for (const x of document.querySelectorAll('[data-tab]')) x.setAttribute('aria-selected', String(x === b));
    for (const s of document.querySelectorAll('.tab')) s.hidden = s.id !== `tab-${tab}`;
    refresh();
  });
}
$('btn-refresh').addEventListener('click', () => refresh());

async function refresh() {
  if (tab === 'overview') await loadOverview();
  else if (tab === 'users') await loadUsers();
  else if (tab === 'invites') await loadInvites();
  else await loadAudit();
}

// ---------------------------------------------------------------------------
// Invites
// ---------------------------------------------------------------------------
async function loadInvites() {
  const { mode, invites } = await api('/api/invites');
  for (const b of document.querySelectorAll('[data-mode]')) b.setAttribute('aria-checked', String(b.dataset.mode === mode));
  $('invites').replaceChildren(
    ...(invites.length
      ? invites.map((i) => {
          const status = i.disabled ? ['warn', 'Disabled'] : i.expired ? ['warn', 'Expired'] : i.max_uses && i.uses >= i.max_uses ? ['warn', 'Used up'] : ['ok', 'Active'];
          const copy = el('button', { class: 'ghost small', title: 'Copy code' }, 'Copy');
          copy.addEventListener('click', async () => {
            await navigator.clipboard.writeText(i.code).catch(() => {});
            copy.textContent = 'Copied ✓';
            setTimeout(() => (copy.textContent = 'Copy'), 1500);
          });
          const toggle = el('button', { class: 'ghost small' }, i.disabled ? 'Enable' : 'Disable');
          toggle.addEventListener('click', () => inviteAction(`/api/invites/${i.id}/${i.disabled ? 'enable' : 'disable'}`, 'POST'));
          const del = el('button', { class: 'ghost small danger-text' }, 'Delete');
          del.addEventListener('click', () =>
            inviteAction(`/api/invites/${i.id}`, 'DELETE', `Delete the code ${i.code}? People who already joined with it keep their accounts.`),
          );
          return el('tr', {},
            el('td', {}, el('code', { class: 'code' }, i.code), ' ', copy),
            el('td', {}, i.label || el('span', { class: 'muted' }, '—')),
            el('td', { class: 'num' }, `${i.uses}${i.max_uses ? ` / ${i.max_uses}` : ''}`),
            el('td', {}, i.expires_at ? fmtDate(i.expires_at) : el('span', { class: 'muted' }, 'Never')),
            el('td', {}, el('span', { class: `pill ${status[0]}` }, status[1])),
            el('td', { title: i.joined.join(', ') }, i.joined.length ? i.joined.slice(0, 3).join(', ') + (i.joined.length > 3 ? ` +${i.joined.length - 3}` : '') : el('span', { class: 'muted' }, '—')),
            el('td', { class: 'actions' }, toggle, del),
          );
        })
      : [el('tr', {}, el('td', { colspan: 7, class: 'muted' }, 'No invite codes yet. Create one above.'))]),
  );
}

async function inviteAction(path, method, confirmText) {
  if (confirmText && !confirm(confirmText)) return;
  try {
    await api(path, { method });
    await loadInvites();
  } catch (err) {
    alert(err.message);
  }
}

for (const b of document.querySelectorAll('[data-mode]')) {
  b.addEventListener('click', async () => {
    const mode = b.dataset.mode;
    if (mode === 'open' && !confirm('Open sign-up lets ANYONE with the link create an account and use this machine. Continue?')) return;
    await api('/api/settings/signup-mode', { method: 'POST', body: { mode } }).catch((err) => alert(err.message));
    await loadInvites();
  });
}

$('invite-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('inv-error').hidden = true;
  try {
    const { code } = await api('/api/invites', {
      method: 'POST',
      body: { label: $('inv-label').value, max_uses: $('inv-max').value || null, expires_days: $('inv-days').value || null, code: $('inv-code').value },
    });
    for (const id of ['inv-label', 'inv-max', 'inv-days', 'inv-code']) $(id).value = '';
    await loadInvites();
    await navigator.clipboard.writeText(code).catch(() => {});
    alert(`Created ${code} (copied to the clipboard). Share it together with the app link.`);
  } catch (err) {
    $('inv-error').textContent = err.message;
    $('inv-error').hidden = false;
  }
});

// ---------------------------------------------------------------------------
// Overview
// ---------------------------------------------------------------------------
function bars(container, series) {
  const max = Math.max(1, ...series.map((d) => d.n));
  container.replaceChildren(
    ...series.map((d) => {
      const fill = el('span', { class: 'bar-fill' });
      fill.style.height = `${Math.max(2, (d.n / max) * 100)}%`; // CSSOM, allowed by the CSP (unlike style="")
      return el('div', { class: 'bar', title: `${fmtDate(d.day)}: ${d.n}` },
        el('span', { class: 'bar-n' }, d.n || ''),
        fill,
        el('span', { class: 'bar-day' }, new Date(d.day).getDate()),
      );
    }),
  );
}

async function loadOverview() {
  const { totals: t, signups, activity, byPersona } = await api('/api/stats');
  const card = (label, value, sub) => el('div', { class: 'card' }, el('div', { class: 'card-v' }, value), el('div', { class: 'card-l' }, label), sub ? el('div', { class: 'card-s' }, sub) : '');
  $('cards').replaceChildren(
    card('Users', t.users, t.suspended ? `${t.suspended} suspended` : 'all active'),
    card('Active today', t.active_24h, `${t.active_7d} this week`),
    card('Messages', t.messages, `${t.messages_24h} in the last 24 h`),
    card('Signed-in sessions', t.sessions, 'not yet expired'),
  );
  bars($('chart-signups'), signups);
  bars($('chart-activity'), activity);
  $('personas').replaceChildren(
    ...(byPersona.length
      ? byPersona.map((p) => el('tr', {}, el('td', {}, p.name), el('td', { class: 'num' }, p.n), el('td', { class: 'num' }, p.users)))
      : [el('tr', {}, el('td', { colspan: 3, class: 'muted' }, 'No calls yet.'))]),
  );
}

// ---------------------------------------------------------------------------
// Users
// ---------------------------------------------------------------------------
$('search').addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(loadUsers, 250);
});

async function loadUsers() {
  const q = $('search').value.trim();
  const { users } = await api(`/api/users${q ? `?q=${encodeURIComponent(q)}` : ''}`);
  $('user-count').textContent = `${users.length} user${users.length === 1 ? '' : 's'}`;
  $('users').replaceChildren(
    ...(users.length
      ? users.map((u) =>
          el('tr', { class: 'clickable', tabindex: 0, onclick: () => openUser(u.id), onkeydown: (e) => e.key === 'Enter' && openUser(u.id) },
            el('td', { class: 'strong' }, u.name),
            el('td', {}, u.email),
            el('td', {}, fmtDate(u.created_at)),
            el('td', {}, ago(u.last_seen_at)),
            el('td', { class: 'num' }, u.messages),
            el('td', {}, u.language || '—'),
            el('td', {}, u.disabled ? el('span', { class: 'pill warn' }, 'Suspended') : el('span', { class: 'pill ok' }, u.sessions ? 'Signed in' : 'Active')),
          ),
        )
      : [el('tr', {}, el('td', { colspan: 7, class: 'muted' }, q ? 'No matches.' : 'No users yet.'))]),
  );
}

async function openUser(id) {
  const d = await api(`/api/users/${id}`);
  current = d.user;
  $('u-name').textContent = d.user.name;
  $('u-email').textContent = `${d.user.email} · #${d.user.id}`;
  const mem = d.memory || {};
  const section = (title, ...content) => el('section', {}, el('h3', {}, title), ...content);
  const kv = (k, v) => el('div', { class: 'kv' }, el('span', {}, k), el('span', {}, v));
  $('u-body').replaceChildren(
    section('Account',
      kv('Joined', fmtDateTime(d.user.created_at)),
      kv('Invite code', d.user.invite_code ? `${d.user.invite_code}${d.user.invite_label ? ` (${d.user.invite_label})` : ''}` : '—'),
      kv('Last active', `${ago(d.user.last_seen_at)} (${fmtDateTime(d.user.last_seen_at)})`),
      kv('Status', d.user.disabled ? 'Suspended' : 'Active'),
      kv('Signed-in devices', d.sessions.active),
    ),
    section('What the crew remembers',
      kv('Talks in', mem.language || '—'),
      kv('Reply style', mem.style || '—'),
      mem.facts?.length ? el('ul', { class: 'facts' }, ...mem.facts.map((f) => el('li', {}, f))) : el('p', { class: 'muted' }, 'No facts yet.'),
      mem.study ? kv('Studying with Kiki', `Class ${mem.study.class_num} ${mem.study.subject}${mem.study.chapter ? `, Ch ${mem.study.chapter}: ${mem.study.chapter_title}` : ''}`) : '',
    ),
    section('Calls by character',
      d.personas.length
        ? el('table', { class: 'table compact' },
            el('tbody', {}, ...d.personas.map((p) => el('tr', {}, el('td', {}, p.name), el('td', { class: 'num' }, `${p.messages} msgs`), el('td', { class: 'muted' }, ago(p.last_at))))))
        : el('p', { class: 'muted' }, 'No conversations yet.'),
    ),
  );
  $('u-suspend').textContent = d.user.disabled ? 'Unsuspend' : 'Suspend';
  if (!$('user').open) $('user').showModal();
}

async function act(path, method, confirmText) {
  if (confirmText && !confirm(confirmText)) return;
  try {
    await api(path, { method });
    if (method === 'DELETE') $('user').close();
    else await openUser(current.id);
    await loadUsers();
  } catch (err) {
    alert(err.message);
  }
}

$('u-revoke').addEventListener('click', () => act(`/api/users/${current.id}/revoke`, 'POST', `Sign ${current.name} out of every device?`));
$('u-suspend').addEventListener('click', () =>
  current.disabled
    ? act(`/api/users/${current.id}/unsuspend`, 'POST')
    : act(`/api/users/${current.id}/suspend`, 'POST', `Suspend ${current.name}? They'll be signed out and can't sign in until unsuspended.`),
);
$('u-delete').addEventListener('click', () => {
  const typed = prompt(`This permanently deletes ${current.name}'s account, conversations and memory.\nType their email to confirm:`);
  if (typed === null) return;
  if (typed.trim().toLowerCase() !== current.email.toLowerCase()) return alert("The email didn't match, so nothing was deleted.");
  act(`/api/users/${current.id}`, 'DELETE');
});

// ---------------------------------------------------------------------------
// Audit log
// ---------------------------------------------------------------------------
const ACTIONS = {
  login: 'Signed in',
  login_failed: 'Failed sign-in',
  suspend: 'Suspended user',
  unsuspend: 'Unsuspended user',
  sign_out_everywhere: 'Signed user out everywhere',
  delete_user: 'Deleted user',
  create_invite: 'Created invite code',
  disable_invite: 'Disabled invite code',
  enable_invite: 'Enabled invite code',
  delete_invite: 'Deleted invite code',
  signup_mode: 'Changed sign-up mode',
};

async function loadAudit() {
  const { entries } = await api('/api/audit');
  $('audit').replaceChildren(
    ...(entries.length
      ? entries.map((e) =>
          el('tr', { class: e.action === 'login_failed' ? 'warn-row' : '' },
            el('td', {}, fmtDateTime(e.at)), el('td', {}, e.admin), el('td', {}, ACTIONS[e.action] || e.action), el('td', {}, e.target || '—'), el('td', { class: 'muted' }, e.detail || ''),
          ),
        )
      : [el('tr', {}, el('td', { colspan: 5, class: 'muted' }, 'Nothing yet.'))]),
  );
}

// ---------------------------------------------------------------------------
api('/api/me')
  .then(({ username }) => showApp(username))
  .catch(() => showLogin());
