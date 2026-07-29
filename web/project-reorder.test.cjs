// Verifies drag-to-reorder for the sidebar's project list (app.js): the pure
// order computation (reorderProjects) and the drag wiring (wireProjectDrag).
//
// The traps this pins, each of which looks fine until you have a second
// organization or drag to the bottom of the rail:
//   1. The rail is not a list of projects — it also holds "New project" and the
//      organization nav. Dropping past the last project must insert above
//      #new-project, never append to the container.
//   2. S.projects is every project the user can see, across organizations, while
//      the rail renders one organization's slice. Reordering must splice within
//      that slice and leave the other organizations' rows where they were.
//   3. The rail element survives every repaint, so its container handlers are
//      assigned as properties; addEventListener would stack one per render.
// Run: node web/project-reorder.test.cjs
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8');

function extractFn(name) {
  const start = src.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`${name} not found`);
  let depth = 0, i = src.indexOf('{', start);
  for (let j = i; j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}' && --depth === 0) return src.slice(start, j + 1);
  }
  throw new Error(`unterminated ${name}`);
}

// ── A DOM small enough to read, real enough to catch those traps ─────────────
const ROW_H = 20;
class El {
  constructor(cls, dataset = {}) {
    this.cls = new Set(cls.split(' ').filter(Boolean));
    this.dataset = dataset;
    this.handlers = {};
    this.parent = null;
    this.classList = {
      add: (c) => this.cls.add(c),
      remove: (c) => this.cls.delete(c),
      contains: (c) => this.cls.has(c),
    };
  }
  addEventListener(type, fn) { (this.handlers[type] ||= []).push(fn); }
  fire(type, ev = {}) { return Promise.all((this.handlers[type] || []).map((fn) => fn(ev))); }
  // The row's vertical band, derived from where it currently sits in the rail.
  getBoundingClientRect() {
    const top = this.parent.children.indexOf(this) * ROW_H;
    return { top, height: ROW_H, bottom: top + ROW_H };
  }
}
class Rail {
  constructor(children) { this.children = children; children.forEach((c) => { c.parent = this; }); }
  querySelectorAll(sel) {
    if (sel !== '.proj[draggable="true"]') throw new Error(`unexpected selector ${sel}`);
    return this.children.filter((c) => c.cls.has('proj') && c.dataset.id);
  }
  insertBefore(node, ref) {
    this.children.splice(this.children.indexOf(node), 1);
    const at = ref ? this.children.indexOf(ref) : -1;
    this.children.splice(at < 0 ? this.children.length : at, 0, node);
  }
  ids() { return this.children.map((c) => c.dataset.id || `<${[...c.cls].join('.')}>`); }
}

// ── Globals the extracted functions close over ───────────────────────────────
let posted = [];
let repaints = 0;
let toasts = [];
const record = async (url, opts) => { posted.push({ url, body: JSON.parse(opts.body) }); };
global.draggingProject = null;
global.$ = (sel) => (sel === '#new-project' ? newProjectRow : null);
global.api = record;
global.toast = (msg) => { toasts.push(msg); };
global.renderRail = () => { repaints++; };
global.loadProjects = async () => {};
global.S = { projects: [] };
let newProjectRow = new El('proj add');

eval(extractFn('reorderProjects'));
eval(extractFn('wireProjectDrag'));

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; } else { fail++; console.error('FAIL:', msg); } };
const order = (projects) => JSON.stringify(projects.map((p) => p.name));
const proj = (id, organizationId = 'o1') => ({ id, name: id.toUpperCase(), organizationId });

(async () => {
  // ── reorderProjects: the pure order computation ────────────────────────────
  const three = [proj('a'), proj('b'), proj('c')];
  ok(order(reorderProjects(three, 'c', 'a')) === '["C","A","B"]', 'dropping C above A puts it first');
  ok(order(reorderProjects(three, 'a', 'c')) === '["B","A","C"]', 'dropping A above C moves it down one');
  ok(order(reorderProjects(three, 'a')) === '["B","C","A"]', 'no `before` = dropped past the end');
  ok(order(reorderProjects(three, 'b', 'c')) === '["A","B","C"]', 'dropping back where it was is a no-op');
  ok(order(reorderProjects(three, 'zzz', 'a')) === '["A","B","C"]', 'an unknown project leaves the list alone');
  ok(reorderProjects(three, 'c', 'a') !== three, 'the input array is not reordered in place');
  ok(order(three) === '["A","B","C"]', 'the input array still holds its original order');

  // Trap 2 — a flat list spanning organizations.
  const mixed = [proj('a'), proj('b'), proj('x', 'o2'), proj('y', 'o2')];
  ok(order(reorderProjects(mixed, 'a')) === '["B","A","X","Y"]',
    'dropping past the end stops at the end of its own organization');
  ok(order(reorderProjects(mixed, 'b', 'a')) === '["B","A","X","Y"]', 'reordering o1 leaves o2 untouched');
  ok(order(reorderProjects([proj('x', 'o2'), proj('a'), proj('b')], 'a')) === '["X","B","A"]',
    'a leading foreign organization does not shift the drop target');
  ok(order(reorderProjects([proj('x', 'o2'), proj('a')], 'a')) === '["X","A"]',
    'the only project in its organization stays put when dropped past the end');
  // The rail shows one organization, but it briefly shows all of them before the
  // organization loads. A drop onto a foreign neighbour is not a position the
  // server can honour, so the cached order must land where the server puts it:
  // last in the dragged project's own organization.
  ok(order(reorderProjects(mixed, 'a', 'y')) === '["B","A","X","Y"]',
    'a `before` in another organization falls back to last in its own');

  // ── wireProjectDrag: dragstart → dragover → drop ───────────────────────────
  function mount(ids) {
    newProjectRow = new El('proj add');
    const rows = ids.map((id) => new El('proj', { id }));
    const rail = new Rail([...rows, newProjectRow, new El('nav-item')]);
    global.S.projects = ids.map((id) => proj(id));
    posted = []; repaints = 0; toasts = []; global.draggingProject = null; global.api = record;
    wireProjectDrag(rail);
    return { rail, rows };
  }
  const dragstart = (row) => row.fire('dragstart', { dataTransfer: { setData() {} } });
  async function drag(rail, row, clientY) {
    await dragstart(row);
    rail.ondragover({ preventDefault() {}, clientY });
    await rail.ondrop({ preventDefault() {} });
    await row.fire('dragend');
  }

  { // Drag the third project onto the first row's top half → it goes first.
    const { rail, rows } = mount(['a', 'b', 'c']);
    await dragstart(rows[2]);
    ok(rows[2].cls.has('dragging'), 'the dragged row is marked while in flight');
    ok(global.draggingProject === rows[2], 'the drag holds the repaint lock');
    rail.ondragover({ preventDefault() {}, clientY: 1 });
    await rail.ondrop({ preventDefault() {} });
    await rows[2].fire('dragend');
    ok(!rows[2].cls.has('dragging'), 'the marker is cleared on drop');
    ok(JSON.stringify(rail.ids()) === '["c","a","b","<proj.add>","<nav-item>"]', 'the dragged row lands first in the DOM');
    ok(posted.length === 1 && posted[0].url === '/api/projects/c/reorder', 'the move is persisted for the dragged project');
    ok(posted[0].body.before === 'a', 'the drop sends the project it now sits above');
    ok(order(global.S.projects) === '["C","A","B"]', 'the cached order is updated optimistically');
    ok(global.draggingProject === null, 'the repaint lock is released after the drop');
    ok(repaints === 1, 'one repaint — the drop itself already moved the DOM');
  }

  { // Trap 1 — dropped below every project. It must stay above "New project".
    const { rail, rows } = mount(['a', 'b', 'c']);
    await drag(rail, rows[0], 999);
    ok(JSON.stringify(rail.ids()) === '["b","c","a","<proj.add>","<nav-item>"]',
      'a drop past the last project stays above the New project row');
    ok(posted[0].body.before === undefined, 'no `before` is sent when it lands last');
    ok(order(global.S.projects) === '["B","C","A"]', 'the cached order matches the DOM');
  }

  { // Dropped outside the rail: dragend fires with no drop. Restore, persist nothing.
    const { rail, rows } = mount(['a', 'b', 'c']);
    await dragstart(rows[2]);
    rail.ondragover({ preventDefault() {}, clientY: 1 });
    await rows[2].fire('dragend');
    ok(posted.length === 0, 'an abandoned drag persists nothing');
    ok(global.draggingProject === null, 'the repaint lock is released on dragend');
    ok(repaints === 1, 'the rail is repainted to put the saved order back');
  }

  { // The server rejecting the move must not leave the sidebar lying about it.
    const { rail, rows } = mount(['a', 'b', 'c']);
    global.api = async () => { throw new Error('nope'); };
    await drag(rail, rows[2], 1);
    ok(toasts[0] === 'nope', 'the failure is surfaced');
    ok(repaints === 2, 'the true order is reloaded and repainted');
  }

  { // Nothing to reorder against — and no handlers left over from a longer list.
    const { rail } = mount(['a']);
    ok(rail.ondragover === null && rail.ondrop === null, 'a one-project rail wires no drag handlers');
  }

  { // Trap 3 — repaints re-wire the same rail element.
    const { rail, rows } = mount(['a', 'b', 'c']);
    wireProjectDrag(rail);
    wireProjectDrag(rail);
    await drag(rail, rows[2], 1);
    ok(posted.length === 1, 're-wiring the rail does not multiply the drop handler');
  }

  console.log(`${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
