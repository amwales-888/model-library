'use strict';
// The library window. It talks to the main process only through window.library (see preload.js).

const $ = (id) => document.getElementById(id);
const PAGE_SIZE = 200;
const GAP = 12;

const SORT_DEFAULTS = { name: 'asc', path: 'asc', rating: 'desc', modified: 'desc', added: 'desc', size: 'desc' };   // matches the database side
const sel = new Selection();   // which thumbnails are selected (positions in the sorted list), see selection.js
let menuTarget = null;        // the thumbnail a right-click menu was opened on
let folderTarget = null;      // the folder a right-click menu was opened on
const state = { filters: { size: 'any', age: 'any', basis: 'modified', stars: 'any' }, ageSince: null, ageBefore: null, scanning: false, rescanningAll: false, sort: 'name', direction: 'asc', search: '', dir: null, recursive: true, includeMissing: false, total: 0, cell: 160 };

/* ---------- small helpers ---------- */
const fmtNumber = (n) => Number(n).toLocaleString();
function fmtBytes(b) {
  if (b < 1024) return b + ' B';
  if (b < 1048576) return (b / 1024).toFixed(1) + ' KB';
  if (b < 1073741824) return (b / 1048576).toFixed(1) + ' MB';
  return (b / 1073741824).toFixed(2) + ' GB';
}
const fmtDate = (ms) => (ms ? new Date(ms).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) + ' ' + new Date(ms).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }) : '');
const fmtDuration = (ms) => (ms < 1000 ? ms + ' ms' : (ms / 1000).toFixed(1) + ' s');
const plural = (n, one, many) => fmtNumber(n) + ' ' + (n === 1 ? one : many);

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function showMessage(text, kind) {
  const box = $('message');
  $('message-text').textContent = text;
  box.className = 'message' + (kind ? ' ' + kind : '');
  box.hidden = !text;
}
$('message-close').addEventListener('click', () => { $('message').hidden = true; });

/* ---------- folder tree ---------- */
const expanded = new Set();
let knownRoots = new Set();

async function refreshTree() {
  const roots = await window.library.tree();
  for (const r of roots) if (!knownRoots.has(r.path)) { knownRoots.add(r.path); expanded.add(r.path); }   // new roots start open
  const tree = $('tree');
  tree.replaceChildren();
  $('roots-empty').hidden = roots.length > 0;
  $('main').classList.toggle('empty', roots.length === 0);   // nothing in the library yet: show the welcome screen instead of the tree and grid
  $('welcome').hidden = roots.length > 0;
  $('rescan-all').disabled = roots.length === 0 || state.scanning || state.rescanningAll;
  if (!roots.length) return;
  const total = roots.reduce((n, r) => n + r.count, 0);
  tree.appendChild(treeRow({ name: 'All files', path: null, count: total, children: [] }, 1, false));
  for (const r of roots) addNode(tree, r, 1, true);
}

function addNode(container, node, level, isRoot) {
  container.appendChild(treeRow(node, level, isRoot));
  if (node.children.length && expanded.has(node.path)) for (const c of node.children) addNode(container, c, level + 1, false);
}

function treeRow(node, level, isRoot) {
  const row = el('div', 'node' + (state.dir === node.path ? ' selected' : ''));
  row.setAttribute('role', 'treeitem');
  row.setAttribute('aria-level', String(level));
  row.setAttribute('aria-selected', String(state.dir === node.path));
  row.style.paddingLeft = (level - 1) * 14 + 4 + 'px';
  const hasKids = node.children.length > 0;
  if (hasKids) row.setAttribute('aria-expanded', String(expanded.has(node.path)));

  const twisty = el('button', 'twisty', hasKids ? (expanded.has(node.path) ? '▾' : '▸') : '');
  twisty.type = 'button';
  twisty.disabled = !hasKids;
  twisty.tabIndex = -1;
  twisty.setAttribute('aria-label', 'Expand or collapse');
  twisty.addEventListener('click', () => { if (expanded.has(node.path)) expanded.delete(node.path); else expanded.add(node.path); refreshTree(); });
  row.appendChild(twisty);

  const label = el('button', 'label', node.name);
  label.type = 'button';
  label.title = node.path || 'Every folder in the library';
  label.addEventListener('click', () => selectFolder(node.path));
  row.appendChild(label);
  row.appendChild(el('span', 'count', fmtNumber(node.count)));
  if (node.path) {
    row.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      folderTarget = { path: node.path, isRoot };
      window.library.showFolderMenu({ isRoot, busy: state.scanning || state.rescanningAll });
    });
  }

  if (isRoot) {
    const rescan = el('button', 'rescan', 'rescan');
    rescan.type = 'button';
    rescan.disabled = state.scanning;
    rescan.title = 'Rescan this folder';
    rescan.addEventListener('click', () => runScan(node.path));
    row.appendChild(rescan);
  }
  return row;
}

function selectFolder(dir) {
  state.dir = dir;
  updateCrumb();
  refreshTree();
  reloadGrid();
}

function updateCrumb() {
  $('crumb').textContent = state.dir || 'All files';
  $('crumb').title = state.dir || '';
}

/* ---------- scanning ---------- */
function setScanning(on, root) {
  state.scanning = on;
  $('progress-box').hidden = !on;
  $('add').disabled = on;
  $('rescan-all').disabled = on || state.rescanningAll;
  for (const button of $('tree').querySelectorAll('.rescan')) button.disabled = on;
  if ($('folders-dialog').open) renderFolderDialog();
  if (on) {
    $('progress-text').textContent = 'Scanning ' + root + '…';
    $('progress-file').textContent = '';
    $('cancel').disabled = false;
  }
}

function showProgress(p) {
  $('progress-text').textContent =
    fmtNumber(p.found) + ' found · ' + fmtNumber(p.hashed) + ' hashed · ' + fmtNumber(p.reused) + ' unchanged' +
    (p.errors ? ' · ' + fmtNumber(p.errors) + ' could not be read' : '');
  $('progress-file').textContent = p.current || '';
}

function summaryText(s) {
  const parts = [plural(s.found, 'file', 'files') + ' found'];
  if (s.added) parts.push(s.added + ' new');
  if (s.moved) parts.push(s.moved + ' moved');
  if (s.missing) parts.push(s.missing + ' missing');
  if (s.duplicateGroups) parts.push(plural(s.duplicateGroups, 'duplicate group', 'duplicate groups'));
  if (s.archives) parts.push(plural(s.archives, 'archive', 'archives') + ' searched' + (s.nestedArchives ? ' (' + plural(s.nestedArchives, 'archive inside an archive', 'archives inside archives') + ' skipped)' : ''));
  return (s.cancelled ? 'Scan cancelled. ' : 'Scan finished in ' + fmtDuration(s.durationMs) + ': ') + parts.join(', ') + '.';
}

// Scans one folder, showing progress. Resolves to the scan's result ({ summary } or { error }).
async function scanOne(root) {
  setScanning(true, root);
  const stopListening = window.library.onProgress(showProgress);
  try {
    return await window.library.scan(root);
  } finally {
    stopListening();
    setScanning(false);
  }
}

function describeScan(s) {
  let text = summaryText(s);
  let kind = '';
  if (s.errors) {
    text += ' ' + plural(s.errors, 'item', 'items') + ' could not be read' + (s.problems[0] ? ' (first: ' + s.problems[0].path + ': ' + s.problems[0].message + ')' : '') + '.';
    kind = 'warn';
  }
  if (s.missingSkipped) text += ' Files were not marked missing because some folders could not be read.';
  return { text, kind };
}

async function refreshAfterScan() {
  await Promise.all([refreshTree(), refreshStats(), reloadGrid()]);
}

async function runScan(root) {
  if (state.scanning || state.rescanningAll) return;
  showMessage('');
  try {
    const result = await scanOne(root);
    if (result.error) showMessage(result.error, 'error');
    else { const { text, kind } = describeScan(result.summary); showMessage(text, kind); }
  } finally {
    await refreshAfterScan();
  }
}

// Rescans every folder in the library, one after another, to pick up files and folders added while the app was open.
async function rescanAll() {
  if (state.scanning || state.rescanningAll) return;
  const roots = await window.library.roots();
  if (!roots.length) { showMessage('There are no folders to rescan. Choose “Add folder…” first.', 'warn'); return; }
  state.rescanningAll = true;
  window.library.logRescan('start', { folders: roots.length });
  $('rescan-all').disabled = true;
  showMessage('');
  const total = { found: 0, added: 0, moved: 0, missing: 0, errors: 0, archives: 0, nested: 0, folders: 0, firstProblem: null, error: null, cancelled: false, missingSkipped: false };
  try {
    for (const root of roots) {
      const result = await scanOne(root.path);
      if (result.error) { total.error = root.path + ': ' + result.error; break; }
      const s = result.summary;
      total.folders++;
      total.found += s.found; total.added += s.added; total.moved += s.moved; total.missing += s.missing; total.errors += s.errors; total.archives += s.archives || 0; total.nested += s.nestedArchives || 0;
      total.missingSkipped = total.missingSkipped || !!s.missingSkipped;
      if (!total.firstProblem && s.problems[0]) total.firstProblem = s.problems[0];
      if (s.cancelled) { total.cancelled = true; break; }
    }
  } finally {
    state.rescanningAll = false;
    window.library.logRescan('end', { ok: !total.error && !total.cancelled && !total.errors, folders: total.folders, cancelled: total.cancelled, error: total.error || (total.errors ? plural(total.errors, 'item', 'items') + ' could not be read' : undefined) });
    $('rescan-all').disabled = false;
    const parts = [plural(total.found, 'file', 'files') + ' found'];
    if (total.added) parts.push(total.added + ' new');
    if (total.moved) parts.push(total.moved + ' moved');
    if (total.missing) parts.push(total.missing + ' missing');
    if (total.archives) parts.push(plural(total.archives, 'archive', 'archives') + ' searched' + (total.nested ? ' (' + plural(total.nested, 'archive inside an archive', 'archives inside archives') + ' skipped)' : ''));
    let text = (total.cancelled ? 'Rescan cancelled after ' : 'Rescanned ') + plural(total.folders, 'folder', 'folders') + ': ' + parts.join(', ') + '.';
    let kind = '';
    if (total.errors) {
      text += ' ' + plural(total.errors, 'item', 'items') + ' could not be read' + (total.firstProblem ? ' (first: ' + total.firstProblem.path + ': ' + total.firstProblem.message + ')' : '') + '.';
      kind = 'warn';
    }
    if (total.missingSkipped) text += ' Files were not marked missing because some folders could not be read.';
    if (total.error) { text += ' Stopped: ' + total.error; kind = 'error'; }
    showMessage(text, kind);
    await refreshAfterScan();
  }
}
$('rescan-all').addEventListener('click', rescanAll);
$('welcome-add').addEventListener('click', () => $('add').click());

/* ---------- stats ---------- */
async function refreshStats() {
  const s = await window.library.stats();
  $('stats').textContent =
    plural(s.files, 'file', 'files') + ' · ' + plural(s.uniqueModels, 'unique model', 'unique models') +
    (s.duplicateGroups ? ' · ' + plural(s.duplicateGroups, 'duplicate group', 'duplicate groups') : '') +
    (s.missing ? ' · ' + fmtNumber(s.missing) + ' missing' : '');
}

/* ---------- thumbnails ---------- */
function showThumbStatus(s) {
  const total = s.counts.ok + s.counts.failed + s.counts.pending;
  const box = $('thumbs-box');
  box.hidden = total === 0;
  box.classList.toggle('blocked', !!s.blocked);
  if (total === 0) return;

  const finished = s.counts.ok + s.counts.failed;
  $('thumbs-fill').style.width = (total ? (100 * finished) / total : 0) + '%';

  let text;
  if (s.blocked) text = 'Thumbnails are paused: ' + s.blocked;
  else if (s.running && s.paused) text = 'Paused. ' + fmtNumber(finished) + ' of ' + fmtNumber(total) + ' done.';
  else if (s.running) text = 'Making thumbnails: ' + fmtNumber(finished) + ' of ' + fmtNumber(total) + ' done.';
  else if (s.counts.pending) text = fmtNumber(s.counts.pending) + ' waiting. ' + fmtNumber(s.counts.ok) + ' done.';
  else text = 'All ' + fmtNumber(s.counts.ok) + ' thumbnails are up to date.';
  if (s.counts.failed) text += ' ' + fmtNumber(s.counts.failed) + ' could not be made.';
  if (s.stale) text += ' ' + fmtNumber(s.stale) + ' changed since the last scan; rescan to update them.';
  $('thumbs-text').textContent = text;
  $('thumbs-file').textContent = s.running && s.current ? s.current : '';

  const pause = $('thumbs-pause');
  pause.hidden = !s.running && !s.blocked;
  pause.textContent = s.paused ? 'Resume' : 'Pause';
  $('thumbs-retry').hidden = !(s.counts.failed > 0 && !s.running);
}

/* ---------- thumbnail grid (virtualised: only the cells on screen exist) ---------- */
const scroller = $('scroller');
const cellsEl = $('cells');
const spacer = $('spacer');

let pages = new Map();      // page number -> array of rows, or null while loading
let gridToken = 0;          // changes whenever the query changes, so late answers are ignored
let layout = { cols: 1, cellW: 160, cellH: 200, rowH: 212 };
const cellEls = new Map();  // row index -> element, reused between renders so images do not flicker

function computeLayout() {
  const width = Math.max(200, scroller.clientWidth - 32);
  const cellW = state.cell;
  const cols = Math.max(1, Math.floor((width + GAP) / (cellW + GAP)));
  const cellH = cellW + 52 + (state.sort === 'modified' || state.sort === 'added' ? 17 : 0);   // picture + name + details (+ date)
  layout = { cols, cellW, cellH, rowH: cellH + GAP };
  cellsEl.style.gridTemplateColumns = 'repeat(' + cols + ', ' + cellW + 'px)';
  cellsEl.style.gridAutoRows = cellH + 'px';
  cellsEl.style.gap = GAP + 'px';
  spacer.style.height = Math.ceil(state.total / cols) * layout.rowH + GAP + 'px';
}

const KB = 1024, MB = 1024 * 1024;
const SIZE_RANGES = {   // [min, max) in bytes
  any: [null, null], lt100k: [null, 100 * KB], '100k-1m': [100 * KB, MB], '1m-10m': [MB, 10 * MB], '10m-50m': [10 * MB, 50 * MB], gt50m: [50 * MB, null],
};
const AGE_DAYS = { day: 1, week: 7, month: 30, quarter: 90, year: 365 };

function queryParams() {
  const [sizeMin, sizeMax] = SIZE_RANGES[state.filters.size] || [null, null];
  return {
    search: state.search, dir: state.dir, recursive: state.recursive, includeMissing: state.includeMissing,
    sort: state.sort, direction: state.direction,
    sizeMin, sizeMax, since: state.ageSince, before: state.ageBefore, ageBasis: state.filters.basis, rating: state.filters.stars,
  };
}

const filtersActive = () => state.filters.size !== 'any' || state.filters.age !== 'any' || state.filters.stars !== 'any';

function rowAt(i) {
  const page = pages.get(Math.floor(i / PAGE_SIZE));
  return page ? page[i % PAGE_SIZE] || null : null;
}

function requestPage(n) {
  if (pages.has(n) || n * PAGE_SIZE >= state.total) return;
  pages.set(n, null);
  const token = gridToken;
  window.library.list({ ...queryParams(), limit: PAGE_SIZE, offset: n * PAGE_SIZE }).then(({ rows }) => {
    if (token !== gridToken) return;
    pages.set(n, rows);
    renderGrid();
  });
}

function fillCell(button, row) {
  button.replaceChildren();
  const pic = el('div', 'pic');
  const check = el('span', 'check', '✓');   // click it to select or deselect this one item
  check.setAttribute('aria-hidden', 'true');
  check.title = 'Select';
  if (row.thumbStatus === 'ok') {
    const img = el('img');
    img.alt = '';
    img.src = 'thumb://local/' + row.sha256 + '.png?v=' + (row.thumbCreatedAt || 0);
    pic.appendChild(img);
  } else if (row.thumbStatus === 'failed') {
    pic.className = 'pic empty failed';
    pic.textContent = 'failed';
    pic.title = row.thumbError || 'The thumbnail could not be made.';
  } else {
    pic.className = 'pic empty';
    pic.textContent = '…';
  }
  if (row.rating !== null && row.rating !== undefined) {
    const stars = el('span', 'stars');
    stars.setAttribute('role', 'img');
    stars.setAttribute('aria-label', row.rating + ' of 5 stars');
    stars.append('★'.repeat(row.rating));
    if (row.rating < 5) stars.appendChild(el('span', 'off', '★'.repeat(5 - row.rating)));
    pic.appendChild(stars);
  }
  if (row.archiveName) {
    const badge = el('span', 'zipbadge', ((/\.(zip|7z|rar)(?:\.\d+)?$/i.exec(row.archiveName) || [])[1] || 'archive').toUpperCase());
    badge.setAttribute('aria-hidden', 'true');
    pic.appendChild(badge);
  }
  pic.appendChild(check);
  button.appendChild(pic);
  button.appendChild(el('div', 'name', row.name));
  // When ordering by a date, that date is shown so the order can be checked at a glance.
  const when = state.sort === 'modified' ? fmtDate(row.modifiedMs) : state.sort === 'added' ? fmtDate(row.addedAt) : '';
  button.appendChild(el('div', 'sub', (row.missing ? 'missing · ' : '') + (row.customView ? 'custom view · ' : '') + row.format.toUpperCase() + ' · ' + fmtBytes(row.size) + (row.archiveName ? ' · in ' + row.archiveName : '')));
  if (when) button.appendChild(el('div', 'sub', (state.sort === 'added' ? 'added ' : 'modified ') + when));
  button.title = row.path + (row.thumbStatus === 'failed' && row.thumbError ? '\n' + row.thumbError : '');
}

function makeCell(row) {
  const button = el('button', 'cell' + (row.missing ? ' is-missing' : ''));
  button.type = 'button';
  button.__row = row;
  fillCell(button, row);
  return button;   // clicks are handled for all cells together (see the selection section)
}

function renderGrid() {
  const { cols, rowH } = layout;
  const top = scroller.scrollTop;
  const firstRow = Math.max(0, Math.floor(top / rowH) - 2);
  const lastRow = Math.ceil((top + scroller.clientHeight) / rowH) + 2;
  const first = firstRow * cols;
  const last = Math.min(state.total, (lastRow + 1) * cols);

  const wantedPages = new Set();
  for (let i = first; i < last; i += 1) wantedPages.add(Math.floor(i / PAGE_SIZE));
  for (const n of wantedPages) requestPage(n);

  const nodes = [];
  const keep = new Set();
  for (let i = first; i < last; i += 1) {
    const row = rowAt(i);
    let node = cellEls.get(i);
    if (!row) {
      node = el('div', 'cell placeholder');
    } else if (!node || node.__row !== row) {
      node = makeCell(row);
    }
    node.__index = i;
    cellEls.set(i, node);
    keep.add(i);
    nodes.push(node);
  }
  for (const i of [...cellEls.keys()]) if (!keep.has(i)) cellEls.delete(i);
  cellsEl.style.transform = 'translateY(' + firstRow * rowH + 'px)';
  cellsEl.replaceChildren(...nodes);
  paintSelection();
}

async function reloadGrid(keepScroll = false) {
  const token = ++gridToken;
  const { total } = await window.library.list({ ...queryParams(), limit: 1, offset: 0 });
  if (token !== gridToken) return;
  pages = new Map();
  cellEls.clear();
  state.total = total;
  if (keepScroll) sel.clampTo(total); else sel.clear();   // a different list means different positions
  const keep = keepScroll ? scroller.scrollTop : 0;
  computeLayout();
  scroller.scrollTop = keep;
  const empty = $('rows-empty');
  empty.hidden = total > 0;
  if (total === 0) {
    empty.textContent = state.search || filtersActive() ? 'No files match the search and filters.' : 'No files here. Add a folder to scan it.';
  }
  $('rows-count').textContent = total ? plural(total, 'file', 'files') + (filtersActive() ? ' match' : '') : '';
  renderGrid();
  updateSelBar();
}

async function openFile(row) {
  const result = await window.library.openViewer(row.path);
  if (!result.ok) showMessage(result.error, 'error');
}

let raf = 0;
const scheduleRender = () => { if (!raf) raf = requestAnimationFrame(() => { raf = 0; renderGrid(); }); };
scroller.addEventListener('scroll', scheduleRender, { passive: true });
new ResizeObserver(() => { computeLayout(); scheduleRender(); }).observe(scroller);

/* ---------- selection: click, shift-click, ctrl-click, double-click, right-click ---------- */
function paintSelection() {
  cellsEl.classList.toggle('selecting', sel.count > 0);
  for (const [i, node] of cellEls) {
    const on = !!node.__row && sel.has(i);
    node.classList.toggle('selected', on);
    if (node.__row) node.setAttribute('aria-pressed', String(on));
  }
}
function updateSelBar() {
  const n = sel.count;
  $('selbar').hidden = n === 0;
  $('sel-count').textContent = n.toLocaleString() + ' selected';
  $('sel-all').disabled = state.total === 0 || n === state.total;
}
function selectionChanged() { paintSelection(); updateSelBar(); }

const cellOf = (e) => { const c = e.target.closest('.cell'); return c && c.__row ? c : null; };

cellsEl.addEventListener('mousedown', (e) => { if (e.shiftKey) e.preventDefault(); });   // no text highlighting while shift-clicking
cellsEl.addEventListener('click', (e) => {
  const cell = cellOf(e);
  if (!cell) return;
  const i = cell.__index;
  const onIcon = !!e.target.closest('.check');
  if (e.detail > 1 && !onIcon) return;                       // the second click of a double-click: the double-click opens the file
  if (e.shiftKey) sel.extendTo(i, e.ctrlKey || e.metaKey);   // everything from the last click to this one
  else if (e.ctrlKey || e.metaKey || onIcon) sel.toggle(i);  // add or remove just this one
  else if (sel.count === 1 && sel.has(i)) { sel.clear(); sel.anchor = i; }   // clicking the only selected item deselects it
  else sel.only(i);
  selectionChanged();
});
cellsEl.addEventListener('dblclick', (e) => {
  const cell = cellOf(e);
  if (!cell || e.target.closest('.check')) return;
  if (!sel.has(cell.__index)) { sel.only(cell.__index); selectionChanged(); }
  openFile(cell.__row);
});
cellsEl.addEventListener('keydown', (e) => {
  const cell = cellOf(e);
  if (!cell) return;
  if (e.key === 'Enter') { e.preventDefault(); openFile(cell.__row); }
  else if (e.key === ' ') { e.preventDefault(); if (e.shiftKey) sel.extendTo(cell.__index); else sel.toggle(cell.__index); selectionChanged(); }
});
cellsEl.addEventListener('keyup', (e) => { if (e.key === ' ') e.preventDefault(); });   // otherwise the button would also "click"
cellsEl.addEventListener('contextmenu', (e) => {
  const cell = cellOf(e);
  if (!cell) return;
  e.preventDefault();
  if (!sel.has(cell.__index)) { sel.only(cell.__index); selectionChanged(); }   // right-clicking something outside the selection selects it
  menuTarget = { index: cell.__index, row: cell.__row };
  // The main process looks at the whole selection: are the files all in one folder, do any have a hand-made view?
  window.library.selectionInfo(selectionPayload()).then((info) => {
    window.library.showItemMenu({ count: info.count, canReveal: info.sameFolder, canRevert: info.anyCustomView });
  });
});
$('sel-all').addEventListener('click', () => { sel.all(state.total); selectionChanged(); });
$('sel-clear').addEventListener('click', () => { sel.clear(); selectionChanged(); });
document.addEventListener('keydown', (e) => {
  const typing = /^(INPUT|SELECT|TEXTAREA)$/.test(document.activeElement && document.activeElement.tagName);
  if ($('folders-dialog').open || typing) return;
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') { e.preventDefault(); sel.all(state.total); selectionChanged(); }
  else if (e.key === 'Escape' && sel.count) { sel.clear(); selectionChanged(); }
  else if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && !e.ctrlKey && !e.metaKey && !e.altKey && state.total > 0) {
    e.preventDefault();
    const step = e.key === 'ArrowLeft' ? -1 : 1;
    const from = sel.anchor === null ? (step > 0 ? -1 : state.total) : sel.anchor;   // nothing selected yet: start at the first or last model
    const i = Math.min(state.total - 1, Math.max(0, from + step));
    sel.only(i); selectionChanged(); scrollToIndex(i);
  }
  else if (/^[0-5]$/.test(e.key) && !e.ctrlKey && !e.metaKey && !e.altKey && sel.count) {
    e.preventDefault();
    handleMenuAction({ action: 'rate', stars: e.key === '0' ? null : Number(e.key) });   // 0 means unrated
  }
});
// Scrolls the grid just enough to bring one model into view.
function scrollToIndex(i) {
  const top = Math.floor(i / layout.cols) * layout.rowH;
  if (top < scroller.scrollTop) scroller.scrollTop = top;
  else if (top + layout.cellH > scroller.scrollTop + scroller.clientHeight) scroller.scrollTop = top + layout.cellH - scroller.clientHeight;
}

// The selection as the main process wants it: the query that produced the list, and which positions are selected.
const selectionPayload = () => ({ query: queryParams(), blocks: sel.blocks() });

// The rows behind the selection, fetched from the database in blocks (most of them are not on screen).
async function selectedRows() {
  const rows = [];
  for (const { start, end } of sel.blocks()) {
    for (let offset = start; offset <= end; offset += 1000) {
      const { rows: chunk } = await window.library.list({ ...queryParams(), limit: Math.min(1000, end - offset + 1), offset });
      rows.push(...chunk);
    }
  }
  return rows;
}
const uniqueShas = (rows) => [...new Set(rows.map((r) => r.sha256))];

// Download: the main process asks for a folder, then copies (or extracts) the selected files into it.
let downloading = false;
async function downloadSelection() {
  if (downloading) { showMessage('A download is already running.', 'warn'); return; }
  downloading = true;
  showMessage('');
  try {
    const result = await window.library.download(selectionPayload());
    $('download-box').hidden = true;
    if (!result.ok) { showMessage(result.error, 'error'); return; }
    if (result.cancelled && !result.destination) return;               // the folder picker was closed
    const parts = [plural(result.copied, 'file', 'files') + ' copied to ' + result.destination];
    if (result.cancelled) parts[0] = 'Download cancelled after ' + plural(result.copied, 'file', 'files') + ' were copied to ' + result.destination;
    if (result.failedCount) parts.push(result.failedCount + ' could not be copied (first: ' + result.failed[0].path + ': ' + result.failed[0].message + ')');
    if (result.changed) parts.push(plural(result.changed, 'file', 'files') + ' changed since the last scan, so ' + (result.changed === 1 ? 'its copy differs' : 'their copies differ') + ' from what the library recorded');
    showMessage(parts.join('. ') + '.', result.failedCount || result.changed || result.cancelled ? 'warn' : '');
  } finally {
    downloading = false;
    $('download-box').hidden = true;
  }
}
window.library.onDownloadProgress(({ done, total, current }) => {
  $('download-box').hidden = false;
  $('download-fill').style.width = (total ? (100 * done) / total : 0) + '%';
  $('download-text').textContent = 'Copying ' + fmtNumber(Math.min(done + (current ? 1 : 0), total)) + ' of ' + fmtNumber(total) + '…';
  $('download-file').textContent = current || '';
});
$('download-cancel').addEventListener('click', () => { $('download-cancel').disabled = true; window.library.cancelDownload(); setTimeout(() => { $('download-cancel').disabled = false; }, 1500); });

// What was chosen in a right-click menu (the menu itself is shown by the main process).
async function handleMenuAction({ action, stars }) {
  const row = menuTarget && menuTarget.row;
  const failed = (r) => { if (r && r.ok === false) { showMessage(r.error || 'That did not work.', 'error'); return true; } return false; };
  switch (action) {
    case 'open': if (row) await openFile(row); break;
    case 'reveal': failed(await window.library.reveal(selectionPayload())); break;
    case 'download': await downloadSelection(); break;
    case 'copyPaths': {
      const rows = await selectedRows();
      await window.library.copyText(rows.map((r) => r.path).join('\n'));
      showMessage('Copied ' + plural(rows.length, 'path', 'paths') + '.');
      break;
    }
    case 'copyHashes': {
      const shas = uniqueShas(await selectedRows());
      await window.library.copyText(shas.join('\n'));
      showMessage('Copied ' + plural(shas.length, 'SHA-256 hash', 'SHA-256 hashes') + '.');
      break;
    }
    case 'rate': {
      const shas = uniqueShas(await selectedRows());
      const r = await window.library.rateMany(shas, stars);
      if (!failed(r)) showMessage((stars === null ? 'Cleared the rating of ' : 'Rated ') + plural(r.changed, 'model', 'models') + (stars === null ? '.' : ' ' + stars + (stars === 1 ? ' star.' : ' stars.')));
      break;
    }
    case 'copies':
      if (row) { $('search').value = row.sha256; state.search = row.sha256; reloadGrid(); showMessage('Showing every copy of this model. Clear the search box to see all files again.'); }
      break;
    case 'regenerate': {
      const r = await window.library.regenerateThumbs(uniqueShas(await selectedRows()));
      if (!failed(r)) showMessage('Drawing ' + plural(r.count, 'thumbnail', 'thumbnails') + ' again.');
      break;
    }
    case 'revert': {
      const r = await window.library.revertViews(uniqueShas(await selectedRows()));
      if (!failed(r)) showMessage('Going back to the automatic view for ' + plural(r.count, 'model', 'models') + '.');
      break;
    }
    case 'rescanFolder': if (folderTarget && !state.scanning) runScan(folderTarget.path); break;
    case 'revealFolder': if (folderTarget) failed(await window.library.revealFolder(folderTarget.path)); break;
    case 'copyFolderPath': if (folderTarget) { await window.library.copyText(folderTarget.path); showMessage('Copied the folder path.'); } break;
    case 'removeFolder':
      if (folderTarget && !state.scanning) { removing = folderTarget.path; $('folder-message').hidden = true; renderFolderDialog(); dialog.showModal(); }
      break;
    default: break;
  }
}
window.library.onMenuAction((choice) => { handleMenuAction(choice).catch((error) => showMessage(error.message, 'error')); });

/* ---------- preferences: manage folders ---------- */
const dialog = $('folders-dialog');
let removing = null;   // path of the folder whose removal is waiting for confirmation
let addedInDialog = new Set();   // folders added while the dialog has been open; they are scanned when it closes

function setMenu(open) {
  $('prefs-menu').hidden = !open;
  $('prefs').setAttribute('aria-expanded', String(open));
}
$('prefs').addEventListener('click', (e) => { e.stopPropagation(); setMenu($('prefs-menu').hidden); });
document.addEventListener('click', (e) => { if (!$('prefs-menu').hidden && !$('prefs-menu').contains(e.target)) setMenu(false); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') setMenu(false); });

async function renderFolderDialog() {
  const roots = await window.library.roots();
  const list = $('folder-list');
  list.replaceChildren();
  $('folder-empty').hidden = roots.length > 0;
  for (const root of roots) {
    const item = el('li');
    const top = el('div', 'folder-top');
    top.appendChild(el('span', 'path', root.path));
    top.appendChild(el('span', 'meta', root.lastScannedAt
      ? plural(root.files, 'file', 'files') + ' · scanned ' + new Date(root.lastScannedAt).toLocaleString()
      : 'not scanned yet'));
    const remove = el('button', 'secondary small', 'Remove…');
    remove.type = 'button';
    remove.disabled = state.scanning;
    remove.addEventListener('click', () => { removing = root.path; $('folder-message').hidden = true; renderFolderDialog(); });
    top.appendChild(remove);
    item.appendChild(top);

    if (removing === root.path) {
      const box = el('div', 'folder-confirm');
      box.appendChild(el('div', '', 'Remove this folder from the library? ' + plural(root.files, 'file', 'files') + ' will no longer be listed. The files on disk are not touched.'));
      const label = el('label', 'check');
      const purge = el('input');
      purge.type = 'checkbox';
      label.append(purge, document.createTextNode(' Also delete the thumbnails and saved views and ratings of files that are not found anywhere else'));
      box.appendChild(label);
      const row = el('div', 'row');
      const confirm = el('button', 'danger small', 'Remove folder');
      confirm.type = 'button';
      confirm.addEventListener('click', () => removeFolder(root.path, purge.checked));
      const cancel = el('button', 'secondary small', 'Cancel');
      cancel.type = 'button';
      cancel.addEventListener('click', () => { removing = null; renderFolderDialog(); });
      row.append(confirm, cancel);
      box.appendChild(row);
      item.appendChild(box);
    }
    list.appendChild(item);
  }
  $('folders-add').disabled = state.scanning;
}

async function removeFolder(root, purge) {
  const result = await window.library.removeRoot(root, purge);
  removing = null;
  const message = $('folder-message');
  if (!result.ok) {
    message.textContent = result.error;
    message.hidden = false;
  } else {
    message.hidden = true;
    if (state.dir && (state.dir === root || state.dir.startsWith(root + '/') || state.dir.startsWith(root + '\\'))) {
      state.dir = null;
      updateCrumb();
    }
    addedInDialog.delete(root);
    knownRoots.delete(root);
    expanded.delete(root);
    showMessage('Removed ' + root + ' (' + plural(result.removedFiles, 'file', 'files') + ' no longer listed' +
      (result.purgedModels ? ', ' + plural(result.purgedModels, 'thumbnail', 'thumbnails') + ' deleted' : '') + ').');
    await Promise.all([refreshTree(), refreshStats(), reloadGrid()]);
    showThumbStatus(await window.library.thumbStatus());
  }
  renderFolderDialog();
}

// "Search inside archives" lives in the Preferences menu and is remembered in the database.
function showZipSetting(on) {
  $('toggle-zips').setAttribute('aria-checked', String(on));
  $('zips-check').textContent = on ? '✓' : '';
}
$('toggle-zips').addEventListener('click', async () => {
  const now = $('toggle-zips').getAttribute('aria-checked') !== 'true';
  const saved = await window.library.setScanZips(now);
  showZipSetting(saved.scanZips);
  setMenu(false);
  showMessage(saved.scanZips
    ? 'Archives (.zip, .7z, .rar) will be searched from the next scan. Press Rescan All to look inside them now.'
    : 'Archives will no longer be searched. Press Rescan All to apply this: models found only inside archives will then be marked missing.');
});
window.library.getSettings().then((s) => showZipSetting(s.scanZips));

$('open-log').addEventListener('click', async () => {
  setMenu(false);
  const { path } = await window.library.openLog();
  showMessage(path ? 'Log file: ' + path : 'There is no log file in this session.');
});
$('manage-folders').addEventListener('click', () => {
  setMenu(false);
  removing = null;
  addedInDialog = new Set();
  $('folder-message').hidden = true;
  renderFolderDialog();
  dialog.showModal();
});
$('folders-close').addEventListener('click', () => dialog.close());
// Adding a folder only lists it; the scan starts when the dialog is closed, and only if a new folder was added.
$('folders-add').addEventListener('click', async () => {
  const before = new Set((await window.library.roots()).map((r) => r.path));
  const picked = await window.library.addFolder();
  if (!picked) return;
  if (!before.has(picked.root)) addedInDialog.add(picked.root);
  $('folder-message').hidden = true;
  await renderFolderDialog();
  refreshTree();
});
dialog.addEventListener('close', async () => {   // the Close button, Esc, or anything else that closes it
  const toScan = [...addedInDialog];
  addedInDialog = new Set();
  for (const root of toScan) await runScan(root);
});

/* ---------- wiring ---------- */
$('add').addEventListener('click', async () => {
  const picked = await window.library.addFolder();
  if (!picked) return;
  await refreshTree();
  await runScan(picked.root);
});
$('cancel').addEventListener('click', () => { $('cancel').disabled = true; window.library.cancelScan(); });

let searchTimer = null;
$('search').addEventListener('input', (event) => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => { state.search = event.target.value; reloadGrid(); }, 150);
});
// Ordering: the list is sorted by the database, so it stays correct however many files there are.
const SORT_LABELS = { asc: { name: 'A → Z', path: 'A → Z', rating: 'Lowest first', modified: 'Oldest first', added: 'Oldest first', size: 'Smallest first' }, desc: { name: 'Z → A', path: 'Z → A', rating: 'Highest first', modified: 'Newest first', added: 'Newest first', size: 'Largest first' } };
function showSortControls() {
  $('sort').value = state.sort;
  $('sort-dir').textContent = SORT_LABELS[state.direction][state.sort];
}
function applySort() {
  showSortControls();
  try { localStorage.setItem('sort', JSON.stringify({ sort: state.sort, direction: state.direction })); } catch { /* remembering is optional */ }
  computeLayout();
  reloadGrid();
}
$('sort').addEventListener('change', (e) => { state.sort = e.target.value; state.direction = SORT_DEFAULTS[state.sort]; applySort(); });
$('sort-dir').addEventListener('click', () => { state.direction = state.direction === 'asc' ? 'desc' : 'asc'; applySort(); });

$('recursive').addEventListener('change', (e) => { state.recursive = e.target.checked; refreshTree(); reloadGrid(); });
$('missing').addEventListener('change', (e) => { state.includeMissing = e.target.checked; reloadGrid(); });
$('zoom').addEventListener('input', (e) => {
  state.cell = Number(e.target.value);
  const anchor = Math.floor(scroller.scrollTop / layout.rowH) * layout.cols;   // keep the same files in view
  computeLayout();
  scroller.scrollTop = Math.floor(anchor / layout.cols) * layout.rowH;
  cellEls.clear();
  scheduleRender();
});

/* ---------- filters ---------- */
function applyFilters() {
  const f = state.filters;
  const now = Date.now();
  state.ageSince = AGE_DAYS[f.age] ? now - AGE_DAYS[f.age] * 86400000 : null;
  state.ageBefore = f.age === 'older' ? now - 365 * 86400000 : null;
  $('f-clear').hidden = !filtersActive();
  document.querySelector('.filter-bar').classList.toggle('active', filtersActive());
  reloadGrid();
}
for (const [id, key] of [['f-size', 'size'], ['f-age', 'age'], ['f-basis', 'basis'], ['f-stars', 'stars']]) {
  $(id).addEventListener('change', (e) => { state.filters[key] = e.target.value; applyFilters(); });
}
$('f-clear').addEventListener('click', () => {
  state.filters.size = 'any'; state.filters.age = 'any'; state.filters.stars = 'any';
  for (const [id, key] of [['f-size', 'size'], ['f-age', 'age'], ['f-stars', 'stars']]) $(id).value = state.filters[key];
  applyFilters();
});

// A rating changed in the viewer: update the stars on screen, and the order or filter if it depends on ratings.
function ratingsApplied(shas, stars) {
  const set = new Set(shas);
  for (const page of pages.values()) if (page) for (const row of page) if (set.has(row.sha256)) row.rating = stars;
  for (const node of cellEls.values()) if (node.__row && set.has(node.__row.sha256)) fillCell(node, node.__row);
  paintSelection();
  if (state.sort === 'rating' || state.filters.stars !== 'any') { sel.clear(); reloadGrid(true); }   // the order changed, so positions did too
}
window.library.onRatingChanged(({ sha256, stars }) => ratingsApplied([sha256], stars));
window.library.onRatingsChanged(({ shas, stars }) => ratingsApplied(shas, stars));
window.library.onThumbsUpdatedMany(({ shas, custom }) => applyThumbResults(shas.map((sha256) => ({ sha256, custom }))));

$('thumbs-pause').addEventListener('click', async () => {
  const s = await window.library.thumbStatus();
  if (s.paused || s.blocked) await window.library.resumeThumbs(); else await window.library.pauseThumbs();
});
$('thumbs-retry').addEventListener('click', () => window.library.retryFailedThumbs());

// Finished thumbnails (from the queue, or replaced in the viewer) replace their pictures without reloading the grid.
function applyThumbResults(list) {
  if (!list.length) return;
  const bySha = new Map(list.map((job) => [job.sha256, job]));
  for (const page of pages.values()) {
    if (!page) continue;
    for (const row of page) {
      const job = bySha.get(row.sha256);
      if (!job) continue;
      if (job.status !== undefined) row.thumbStatus = job.status;
      if (job.error !== undefined) row.thumbError = job.error;
      if (job.createdAt !== undefined) row.thumbCreatedAt = job.createdAt;
      if (job.custom !== undefined) row.customView = job.custom;
    }
  }
  for (const node of cellEls.values()) if (node.__row && bySha.has(node.__row.sha256)) fillCell(node, node.__row);
}

// Progress arrives in small batches.
window.library.onThumbProgress(({ status, finished }) => {
  showThumbStatus(status);
  applyThumbResults(finished);
});
window.library.onThumbUpdated(({ sha256, createdAt, custom, keepImage }) => {
  // keepImage: the old picture stays until the automatic one has been drawn
  applyThumbResults([{ sha256, status: 'ok', error: null, createdAt: keepImage ? undefined : createdAt, custom }]);
});

(async function init() {
  try {
    const saved = JSON.parse(localStorage.getItem('sort') || 'null');
    if (saved && SORT_DEFAULTS[saved.sort] && (saved.direction === 'asc' || saved.direction === 'desc')) { state.sort = saved.sort; state.direction = saved.direction; }
  } catch { /* use the default order */ }
  showSortControls();
  $('recursive').checked = state.recursive;
  updateCrumb();
  await Promise.all([refreshTree(), refreshStats(), reloadGrid()]);
  showThumbStatus(await window.library.thumbStatus());
})();
