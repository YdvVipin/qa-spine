// Three views, hash-routed, no build step. Nodes are built with the DOM API rather than
// innerHTML because everything rendered here is model output or requirement text.

const TYPES = ['requirement', 'finding', 'answer', 'test_case', 'test_run', 'defect', 'verdict'];
const RELATION_COLOUR = {
  derived_from: '#7aa2f7',
  tests: '#7dcfff',
  covers: '#9ece6a',
  verifies: '#bb9af7',
  contradicts: '#f7768e',
  supersedes: '#e0af68',
};

const view = document.getElementById('view');
const crumbs = document.getElementById('crumbs');

function h(tag, props = {}, ...kids) {
  const node = Object.assign(document.createElement(tag), props);
  for (const kid of kids.flat()) {
    if (kid != null) node.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  }
  return node;
}
const get = (path) => fetch(path).then((r) => r.json());
const ago = (iso) => new Date(iso).toLocaleString();

/** One line that tells you what an artifact is without opening it. */
function summarise(a) {
  const c = a.content ?? {};
  return c.text ?? c.quote ?? c.name ?? c.reason ?? c.verdict ?? c.note ?? JSON.stringify(c);
}

// ---------------------------------------------------------------- list view

async function listView(type) {
  const { artifacts } = await get('/api/artifacts' + (type ? `?type=${type}` : ''));
  crumbs.replaceChildren(`${artifacts.length} artifact${artifacts.length === 1 ? '' : 's'}`);

  const filters = h(
    'div',
    { className: 'filters' },
    ['', ...TYPES, 'review'].map((t) =>
      h('button', {
        textContent: t || 'all',
        ariaPressed: String((type ?? '') === t),
        onclick: () => (location.hash = t ? `#/?type=${t}` : '#/'),
      }),
    ),
  );

  if (!artifacts.length) {
    return view.replaceChildren(
      filters,
      h('p', { className: 'empty' }, 'Nothing in the trace store yet.'),
    );
  }

  const rows = artifacts.map((a) =>
    h(
      'tr',
      {},
      h('td', {}, h('a', { className: 'type', href: `#/a/${a.id}`, textContent: a.type })),
      h('td', {}, summarise(a).slice(0, 90)),
      h('td', { className: 'producer-' + a.provenance.producer }, a.provenance.producer),
      h('td', {}, a.provenance.model ?? '—'),
      h('td', {}, a.content?.confidence ?? '—'),
      h('td', {}, a.sourceRef ?? '—'),
      h('td', {}, ago(a.createdAt)),
    ),
  );

  view.replaceChildren(
    filters,
    h(
      'table',
      {},
      h(
        'thead',
        {},
        h(
          'tr',
          {},
          ['type', 'summary', 'producer', 'model', 'confidence', 'source', 'created'].map((c) =>
            h('th', {}, c),
          ),
        ),
      ),
      h('tbody', {}, rows),
    ),
  );
}

// -------------------------------------------------------------- detail view

function provenancePanel(a) {
  const p = a.provenance;
  return h(
    'section',
    { className: 'panel' },
    h('h2', {}, 'provenance'),
    h(
      'dl',
      {},
      h('dt', {}, 'producer'),
      h('dd', { className: 'producer-' + p.producer }, p.producer),
      h('dt', {}, 'model'),
      h('dd', {}, p.model ?? '—'),
      h('dt', {}, 'prompt version'),
      h('dd', {}, p.promptVersion ?? '—'),
      h('dt', {}, 'input digest'),
      h('dd', {}, p.inputDigest ?? '—'),
      h('dt', {}, 'approved by'),
      h('dd', {}, p.approvedBy ? `${p.approvedBy} @ ${p.approvedAt ?? '?'}` : 'not approved'),
      h('dt', {}, 'created'),
      h('dd', {}, ago(a.createdAt)),
      h('dt', {}, 'id'),
      h('dd', {}, a.id),
    ),
  );
}

/** Renders the requirement with the finding's quote highlighted, so a mis-quote is obvious. */
function sourcePanel(finding, requirement) {
  const text = String(requirement.content.text ?? '');
  const quote = String(finding.content.quote ?? '');
  const at = quote ? text.indexOf(quote) : -1;
  const body =
    at === -1
      ? [text, quote ? h('p', { className: 'flag verdict-bad' }, '⚠ quote not found in source') : null]
      : [text.slice(0, at), h('mark', {}, quote), text.slice(at + quote.length)];

  return h(
    'section',
    { className: 'panel' },
    h('h2', {}, `source · ${requirement.sourceRef ?? requirement.id}`),
    h('pre', {}, body),
  );
}

function reviewBox(artifact, existing) {
  const note = h('textarea', { placeholder: 'why? (optional)' });
  const status = h('span', { className: 'said' });

  const submit = async (verdict) => {
    const res = await fetch('/api/review', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ artifactId: artifact.id, verdict, note: note.value }),
    });
    status.textContent = res.ok ? `recorded: ${verdict}` : 'failed';
    status.className = 'said verdict-' + verdict;
    note.value = '';
  };

  const prior = existing.map((r) =>
    h(
      'div',
      { className: 'said' },
      h('span', { className: 'verdict-' + r.content.verdict }, r.content.verdict),
      ` — ${r.content.note || 'no note'} (${ago(r.createdAt)})`,
    ),
  );

  return h(
    'section',
    { className: 'panel' },
    h('h2', {}, 'is this output any good?'),
    ...prior,
    h(
      'div',
      { className: 'review' },
      note,
      h('button', { className: 'good', textContent: '👍 good', onclick: () => submit('good') }),
      h('button', { className: 'bad', textContent: '👎 bad', onclick: () => submit('bad') }),
      status,
    ),
  );
}

async function detailView(id) {
  const chain = await get('/api/chain/' + encodeURIComponent(id));
  if (chain.error) return view.replaceChildren(h('p', { className: 'empty' }, chain.error));

  const a = chain.root;
  const byId = new Map(chain.nodes.map((n) => [n.id, n]));
  crumbs.replaceChildren(
    h('a', { href: '#/', textContent: 'all' }),
    ' / ',
    a.type,
    ' / ',
    h('a', { href: `#/c/${a.id}`, textContent: 'view chain →' }),
  );

  const reviews = chain.nodes.filter(
    (n) =>
      n.type === 'review' &&
      chain.edges.some((e) => e.fromArtifactId === n.id && e.toArtifactId === a.id),
  );
  const requirement = chain.edges
    .filter((e) => e.fromArtifactId === a.id)
    .map((e) => byId.get(e.toArtifactId))
    .find((n) => n?.type === 'requirement');

  const content = h(
    'section',
    { className: 'panel' },
    h('h2', {}, `${a.type}${a.sourceRef ? ' · ' + a.sourceRef : ''}`),
    h('pre', {}, JSON.stringify(a.content, null, 2)),
  );

  view.replaceChildren(
    h(
      'div',
      { className: 'cols' },
      a.type === 'finding' && requirement ? sourcePanel(a, requirement) : null,
      content,
      provenancePanel(a),
    ),
    a.provenance.producer === 'ai' ? reviewBox(a, reviews) : '',
  );
}

// --------------------------------------------------------------- chain view

async function chainView(id) {
  const chain = await get('/api/chain/' + encodeURIComponent(id));
  if (chain.error) return view.replaceChildren(h('p', { className: 'empty' }, chain.error));

  crumbs.replaceChildren(
    h('a', { href: '#/', textContent: 'all' }),
    ' / chain of ',
    h('a', { href: `#/a/${chain.root.id}`, textContent: chain.root.id }),
  );

  // Reviews are metadata about the spine, not part of it.
  const nodes = chain.nodes.filter((n) => n.type !== 'review');
  const ids = new Set(nodes.map((n) => n.id));
  const edges = chain.edges.filter((e) => ids.has(e.fromArtifactId) && ids.has(e.toArtifactId));

  // ponytail: columns come from the fixed lifecycle order, which is what this schema
  // models. Swap for longest-path layering if artifacts ever skip stages.
  const lanes = TYPES.map((type) => ({ type, items: nodes.filter((n) => n.type === type) })).filter(
    (l) => l.items.length,
  );

  const cards = new Map();
  const lanesEl = h(
    'div',
    { className: 'lanes' },
    lanes.map((lane) =>
      h(
        'div',
        { className: 'lane' },
        h('h3', {}, lane.type.replace('_', ' ')),
        lane.items.map((n) => {
          const unresolved =
            n.type === 'finding' &&
            !edges.some((e) => e.toArtifactId === n.id && e.relation === 'supersedes');
          const card = h(
            'a',
            {
              className:
                'node' + (n.id === chain.root.id ? ' root' : '') + (unresolved ? ' unresolved' : ''),
              href: `#/a/${n.id}`,
            },
            h('span', { className: 'id' }, n.sourceRef ?? n.id),
            h('span', { className: 'summary' }, summarise(n).slice(0, 60)),
            unresolved ? h('span', { className: 'flag' }, '● unresolved') : null,
          );
          cards.set(n.id, card);
          return card;
        }),
      ),
    ),
  );

  const wires = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  wires.id = 'wires';
  const graph = h('div', { id: 'graph' }, wires, lanesEl);

  view.replaceChildren(
    graph,
    h(
      'div',
      { className: 'legend' },
      Object.entries(RELATION_COLOUR).map(([rel, colour]) =>
        h('span', {}, h('i', { style: `background:${colour}` }), rel),
      ),
      h('span', { className: 'verdict-bad' }, '● finding nothing has resolved'),
    ),
  );

  const draw = () => {
    const origin = graph.getBoundingClientRect();
    wires.replaceChildren();
    wires.setAttribute('width', graph.scrollWidth);
    wires.setAttribute('height', graph.scrollHeight);
    for (const e of edges) {
      const from = cards.get(e.fromArtifactId)?.getBoundingClientRect();
      const to = cards.get(e.toArtifactId)?.getBoundingClientRect();
      if (!from || !to) continue;
      // Edges point from newer to older, so they run right-to-left: a verdict is
      // `derived_from` a run, exactly as a commit points at its parent.
      const x1 = from.left - origin.left + graph.scrollLeft;
      const y1 = from.top - origin.top + from.height / 2;
      const x2 = to.right - origin.left + graph.scrollLeft;
      const y2 = to.top - origin.top + to.height / 2;
      const mid = (x1 + x2) / 2;
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute('d', `M${x1},${y1} C${mid},${y1} ${mid},${y2} ${x2},${y2}`);
      path.setAttribute('fill', 'none');
      path.setAttribute('stroke', RELATION_COLOUR[e.relation] ?? '#565f89');
      path.setAttribute('stroke-width', '1.5');
      path.append(
        Object.assign(document.createElementNS('http://www.w3.org/2000/svg', 'title'), {
          textContent: `${e.fromArtifactId} ${e.relation} ${e.toArtifactId}`,
        }),
      );
      wires.append(path);
    }
  };
  requestAnimationFrame(() => {
    draw();
    // The artifact you asked about is usually the newest, so it sits in the rightmost lane.
    cards.get(chain.root.id)?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  });
  addEventListener('resize', draw);
}

// ------------------------------------------------------------------ routing

function route() {
  const [, path, id] = location.hash.match(/^#\/(a|c)\/(.+)$/) ?? [];
  if (path === 'a') return detailView(decodeURIComponent(id));
  if (path === 'c') return chainView(decodeURIComponent(id));
  return listView(new URLSearchParams(location.hash.split('?')[1] ?? '').get('type'));
}

// Cross-fade view swaps with the native View Transitions API. route() is async for the
// detail and chain views, so the old view holds until the fetch resolves and then fades.
const still = matchMedia('(prefers-reduced-motion: reduce)');
addEventListener('hashchange', () =>
  document.startViewTransition && !still.matches ? document.startViewTransition(route) : route(),
);
route();
