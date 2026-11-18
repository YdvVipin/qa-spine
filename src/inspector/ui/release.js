// The Release page: what a release manager opens from a link (?release=<id>&changed=…).
// renderRelease() is a pure function of the /api/release view, so tests can read its text;
// mount() is the browser glue. Every value is escaped: story text and names are typed by people.

const esc = (v) =>
  String(v ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

const day = (iso) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
};
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const story = (row) => `<strong>${esc(row.story)}</strong>${row.title ? ` <span class="title">${esc(row.title)}</span>` : ''}`;

function list(heading, rows, line, empty) {
  return `<section class="list">
  <h2>${esc(heading)} (${rows.length})</h2>
  ${rows.length ? `<ul>${rows.map((r) => `<li>${line(r)}</li>`).join('')}</ul>` : `<p class="empty">${esc(empty)}</p>`}
</section>`;
}

function banner(decided) {
  if (!decided) return '';
  const changed = decided.changedSince
    ? `${plural(decided.changedSince, 'result has', 'results have')} changed since; the decision stays as recorded, and a new one is a new record.`
    : 'Nothing has changed since.';
  const bugs = decided.defects.length ? ` Bugs: ${decided.defects.map(esc).join(', ')}.` : '';
  return `<p class="decided tone-${esc(decided.tone)}" role="status">Decided on ${esc(day(decided.when))}${decided.by ? ` by ${esc(decided.by)}` : ''}: ${esc(
    decided.headline,
  )}. “${esc(decided.reason)}”${bugs} ${esc(changed)}</p>`;
}

function decide(view) {
  const a = view.actions;
  const cantShip =
    view.decision === 'UNKNOWN'
      ? '<p class="explain">This release cannot be shipped until every story has evidence: see the list above. You can hold it.</p>'
      : '';
  return `<section class="decide" aria-label="Decide">
  <h2>Decide</h2>
  ${cantShip}
  <label>Your name <input name="name" autocomplete="name" required></label>
  <label>Reason <span class="hint">(optional for Hold; 20 characters or more for Ship anyway)</span>
    <textarea name="reason" rows="2"></textarea></label>
  ${a.shipAnyway ? '<label>Jira bug for each failure <input name="defects" placeholder="ABC-123, ABC-124"></label>' : ''}
  <div class="buttons">
    ${a.ship ? '<button type="button" data-action="ship" class="go">Ship</button>' : ''}
    ${a.hold ? '<button type="button" data-action="hold">Hold</button>' : ''}
    ${a.shipAnyway ? '<button type="button" data-action="ship_anyway" class="risk">Ship anyway</button>' : ''}
  </div>
  <div class="confirm" hidden>
    <p class="preview"></p>
    <button type="button" data-confirm class="go">Record this decision</button>
    <button type="button" data-cancel>Cancel</button>
  </div>
  <p class="error" role="alert"></p>
  <p class="claimed">Your name is recorded as you type it; this page has no sign-in.</p>
</section>`;
}

export function renderRelease(view) {
  const failed = list(
    'Failed',
    view.failed,
    (r) =>
      `${story(r)} — ${esc(r.what)}${r.bug ? ` · bug ${esc(r.bug)}` : ''}${r.by ? ` · found by ${esc(r.by)}` : ''}${r.when ? ` · ${esc(day(r.when))}` : ''}`,
    'Nothing failed.',
  );
  const missing = list('No evidence', view.missing, (r) => `${story(r)} — ${esc(r.what)}`, 'Every story has a result.');
  const passed = list(
    'Passed',
    view.passed,
    (r) => `${story(r)} — ${esc(r.test)} · ${r.by === 'test report' ? 'from a test report' : `vouched for by ${esc(r.by)}`} · ${esc(day(r.when))}`,
    'No test has passed yet.',
  );
  const shown = view.decided ? view.decided : view;
  return `<article class="release tone-${esc(shown.tone)}">
  <p class="release-id">Release ${esc(view.release)}</p>
  <h1 class="headline">${esc(view.decided ? view.decided.headline : view.summary)}</h1>
  ${view.decided ? `<p class="today">The evidence today: ${esc(view.summary)}</p>` : ''}
  ${banner(view.decided)}
  ${failed}
  ${missing}
  ${passed}
  ${decide(view)}
  <p class="evidence"><a href="/#/">Evidence</a> — every record behind this page, for anyone who wants the detail.</p>
</article>`;
}

const ACTION_WORDS = { ship: 'Ready to ship, shipped', hold: 'Not ready, held', ship_anyway: 'Shipped anyway' };

/** Exactly what Record will write, in the words the page uses. */
export function previewText(action, form, view) {
  const who = form.name?.trim() || '(type your name)';
  const reason = form.reason?.trim();
  if (action === 'hold') return `${ACTION_WORDS.hold} by ${who}${reason ? `: “${reason}”` : '.'}`;
  if (action === 'ship') return `${ACTION_WORDS.ship} by ${who}${reason ? `: “${reason}”` : ', because every test on every story passed.'}`;
  const over = view.failed.map((f) => `${f.what} (${f.story})`).join('; ');
  const bugs = (form.defects ?? []).join(', ') || '(no bug given)';
  return `${ACTION_WORDS.ship_anyway}, decided by ${who}: “${reason || ''}”. Bugs: ${bugs}. Shipped over: ${over}.`;
}

/** Browser glue: load the view, render it, and record a decision through /api/release/decide. */
export async function mount(root, params) {
  const load = async () => {
    const r = await fetch(`/api/release?${params}`);
    const body = await r.json();
    if (!r.ok) {
      root.innerHTML = `<article class="release"><p class="error" role="alert">${esc(body.error)}</p><p><a href="/#/">Evidence</a></p></article>`;
      return null;
    }
    return body;
  };
  const show = (view, note) => {
    root.innerHTML = renderRelease(view);
    if (note) root.querySelector('.error').textContent = note;
    const field = (n) => root.querySelector(`[name="${n}"]`);
    const confirm = root.querySelector('.confirm');
    const form = () => ({
      name: field('name')?.value ?? '',
      reason: field('reason')?.value ?? '',
      defects: (field('defects')?.value ?? '').split(',').map((d) => d.trim()).filter(Boolean),
    });
    let action = null;
    for (const b of root.querySelectorAll('[data-action]')) {
      b.addEventListener('click', () => {
        action = b.dataset.action;
        confirm.querySelector('.preview').textContent = `This will be recorded: ${previewText(action, form(), view)}`;
        confirm.hidden = false;
      });
    }
    root.querySelector('[data-cancel]').addEventListener('click', () => (confirm.hidden = true));
    root.querySelector('[data-confirm]').addEventListener('click', async () => {
      const r = await fetch('/api/release/decide', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ release: view.release, ...view.scope, action, ...form() }),
      });
      const body = await r.json();
      if (!r.ok) {
        root.querySelector('.error').textContent = body.error;
        return;
      }
      show(body, 'Recorded.');
    });
  };
  const view = await load();
  if (view) show(view);
}
