// game.js — DOM, input, rendering for FOLIO. Imports the pure core; no game rules live here.
import {
  SCHEMES, targetFor, check, flipbook, readsInOrder, generateMisprint, encodeShare,
} from './fold.mjs';

const STORAGE_KEY = 'folio_v1';

const LEVELS = [
  { id: 1, scheme: 'folio', mode: 'place', title: 'The Broadside', blurb: 'One fold. Four pages. Watch where page one lands.' },
  { id: 2, scheme: 'folio', mode: 'repair', numFaults: 1, seed: 101, title: 'A Torn Proof', blurb: 'Two pages were printed in the wrong spot. Find them before the press runs again.' },
  { id: 3, scheme: 'quarto', mode: 'place', title: 'The Quarto Bench', blurb: 'Two folds now. Front and back both carry four faces.' },
  { id: 4, scheme: 'quarto', mode: 'repair', numFaults: 1, seed: 202, title: "The Journeyman's Mistake", blurb: 'A distracted apprentice swapped two pages. Catch it.' },
  { id: 5, scheme: 'octavo', mode: 'place', title: 'The Octavo Forme', blurb: 'Eight leaves from one sheet. This is where the trade gets real.' },
  { id: 6, scheme: 'octavo', mode: 'repair', numFaults: 2, seed: 303, title: 'The Rushed Run', blurb: 'Two swaps this time. The book will read wrong twice over if you miss them.' },
  { id: 7, scheme: 'duodecimo', mode: 'place', title: 'The Mixed Sheet', blurb: 'A half-sheet and a full sheet, gathered as one. Twelve leaves, two panels.' },
  { id: 8, scheme: 'duodecimo', mode: 'repair', numFaults: 2, seed: 404, title: 'The Bindery Complaint', blurb: 'A customer returned this signature. Something reads out of order.' },
  { id: 9, scheme: 'hexadecimo', mode: 'place', title: "The Master's Sheet", blurb: 'Sixteen leaves. Four folds. The whole shop is watching.' },
  { id: 10, scheme: 'hexadecimo', mode: 'repair', numFaults: 3, seed: 505, title: "The Master's Proof", blurb: 'Three faults hidden in sixteen leaves. This is the trade at its finest.' },
];

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return JSON.parse(raw);
  } catch (e) { /* ignore corrupt storage */ }
  return { unlocked: 1, completed: {}, current: 1 };
}

function saveState(state) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch (e) { /* storage unavailable */ }
}

let state = loadState();

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

const screens = {
  title: $('#screen-title'),
  how: $('#screen-how'),
  levels: $('#screen-levels'),
  play: $('#screen-play'),
};

function showScreen(name) {
  for (const key of Object.keys(screens)) {
    screens[key].classList.toggle('active', key === name);
  }
}

// ---- Level select ----
function renderLevelList() {
  const list = $('#level-list');
  list.innerHTML = '';
  LEVELS.forEach((lvl) => {
    const locked = lvl.id > state.unlocked;
    const done = !!state.completed[lvl.id];
    const btn = document.createElement('button');
    btn.className = 'level-row' + (locked ? ' locked' : '') + (done ? ' done' : '');
    btn.disabled = locked;
    const schemeName = SCHEMES[lvl.scheme] ? SCHEMES[lvl.scheme].name : 'Duodecimo';
    btn.innerHTML = `
      <span class="level-num">${lvl.id}</span>
      <span class="level-info">
        <span class="level-title">${lvl.title}</span>
        <span class="level-sub">${schemeName} · ${lvl.mode === 'repair' ? 'repair job' : 'imposition'}</span>
      </span>
      <span class="level-mark">${done ? '✓' : locked ? '🔒' : '→'}</span>
    `;
    btn.addEventListener('click', () => { if (!locked) startLevel(lvl.id); });
    list.appendChild(btn);
  });
}

// ---- Play state ----
let session = null; // built fresh per level attempt

function emptyLayoutFor(target) {
  return {
    front: target.front.map((c) => ({ r: c.r, c: c.c, page: null, upsideDown: false })),
    back: target.back.map((c) => ({ r: c.r, c: c.c, page: null, upsideDown: false })),
  };
}

function startLevel(id) {
  const lvl = LEVELS.find((l) => l.id === id);
  const target = targetFor(lvl.scheme);
  if (lvl.mode === 'place') {
    session = {
      lvl, target, mode: 'place',
      layout: emptyLayoutFor(target),
      side: 'front', armed: null, attempts: 0, folded: false, lastErrors: [],
    };
  } else {
    const gen = generateMisprint(lvl.scheme, lvl.seed, lvl.numFaults);
    session = {
      lvl, target, mode: 'repair',
      layout: gen.layout, faults: gen.faults,
      side: 'front', flagged: [], attempts: 0, resolved: false,
    };
  }
  showScreen('play');
  renderPlay();
}

function pageTallyRemaining() {
  const placedPages = new Set([...session.layout.front, ...session.layout.back].filter((c) => c.page != null).map((c) => c.page));
  const remaining = [];
  for (let p = 1; p <= session.target.pages; p++) if (!placedPages.has(p)) remaining.push(p);
  return remaining;
}

function renderPlay() {
  const { lvl, target, mode } = session;
  $('#play-title').textContent = lvl.title;
  $('#play-blurb').textContent = lvl.blurb;
  $('#play-attempts').textContent = mode === 'place' ? `Attempts: ${session.attempts}` : (session.resolved ? 'Solved' : 'Tap the faulty pages');

  $$('.side-tab').forEach((t) => t.classList.toggle('active', t.dataset.side === session.side));
  $('#hint').textContent = mode === 'place'
    ? 'Tap a page number below, then tap a cell to place it. Tap a placed page to flip it.'
    : 'Tap a page you think is wrong. Flag every fault, then submit.';

  const grid = $('#sheet-grid');
  grid.innerHTML = '';
  grid.style.setProperty('--cols', target.cols);
  grid.style.setProperty('--rows', target.rows);

  const cells = target[session.side];
  const layoutCells = session.layout[session.side];
  cells.forEach((tc) => {
    const placed = layoutCells.find((p) => p.r === tc.r && p.c === tc.c);
    const cellBtn = document.createElement('button');
    cellBtn.className = 'sheet-cell';
    cellBtn.style.gridColumn = tc.c + 1;
    cellBtn.style.gridRow = tc.r + 1;
    if (placed && placed.upsideDown) cellBtn.classList.add('upside-down');
    if (target.panels && target.panels[0] && tc.c === target.panels[0].cols - 1) cellBtn.classList.add('panel-edge');

    if (mode === 'place') {
      cellBtn.textContent = placed && placed.page != null ? placed.page : '·';
      if (!placed || placed.page == null) cellBtn.classList.add('empty');
      cellBtn.addEventListener('click', () => onPlaceCellTap(tc.r, tc.c));
    } else {
      cellBtn.textContent = placed.page;
      const isFlagged = session.flagged.some((f) => f.side === session.side && f.r === tc.r && f.c === tc.c);
      if (isFlagged) cellBtn.classList.add('flagged');
      cellBtn.addEventListener('click', () => onRepairCellTap(tc.r, tc.c));
    }
    grid.appendChild(cellBtn);
  });

  const tray = $('#page-tray');
  const foldBtn = $('#fold-btn');
  const submitBtn = $('#submit-btn');
  if (mode === 'place') {
    tray.hidden = false;
    submitBtn.hidden = true;
    foldBtn.hidden = false;
    tray.innerHTML = '';
    pageTallyRemaining().forEach((p) => {
      const chip = document.createElement('button');
      chip.className = 'chip' + (session.armed === p ? ' armed' : '');
      chip.textContent = p;
      chip.addEventListener('click', () => { session.armed = session.armed === p ? null : p; renderPlay(); });
      tray.appendChild(chip);
    });
    const remaining = pageTallyRemaining().length;
    foldBtn.disabled = remaining > 0;
    foldBtn.textContent = remaining > 0 ? `Place ${remaining} more page${remaining === 1 ? '' : 's'}` : 'Fold the sheet';
  } else {
    tray.hidden = true;
    foldBtn.hidden = true;
    submitBtn.hidden = false;
    submitBtn.textContent = session.resolved ? 'Solved — next job' : `Submit (${session.flagged.length} flagged)`;
  }
}

function onPlaceCellTap(r, c) {
  const cells = session.layout[session.side];
  const cell = cells.find((p) => p.r === r && p.c === c);
  if (cell.page != null && session.armed == null) {
    // tap a filled cell with nothing armed: toggle its orientation
    cell.upsideDown = !cell.upsideDown;
  } else if (cell.page != null && session.armed != null) {
    // swap: return this page to tray, place armed page here
    const armed = session.armed;
    cell.page = armed; cell.upsideDown = false; session.armed = null;
  } else if (session.armed != null) {
    cell.page = session.armed; cell.upsideDown = false; session.armed = null;
  }
  renderPlay();
}

function onRepairCellTap(r, c) {
  if (session.resolved) return;
  const idx = session.flagged.findIndex((f) => f.side === session.side && f.r === r && f.c === c);
  if (idx >= 0) session.flagged.splice(idx, 1);
  else session.flagged.push({ side: session.side, r, c });
  renderPlay();
}

function setEqual(a, b) {
  if (a.length !== b.length) return false;
  const key = (x) => `${x.side}:${x.r}:${x.c}`;
  const sa = new Set(a.map(key));
  return b.every((x) => sa.has(key(x)));
}

function doFold() {
  session.attempts++;
  const errors = check(session.layout, session.target);
  session.lastErrors = errors;
  const flip = flipbook(session.layout, session.lvl.scheme);
  const solved = readsInOrder(flip);
  playFoldAnimation(() => showResult(solved, errors));
}

function doSubmitRepair() {
  session.attempts++;
  const solved = setEqual(session.flagged, session.faults);
  if (solved) session.resolved = true;
  showResult(solved, solved ? [] : [{ type: 'repair-mismatch' }]);
}

function playFoldAnimation(done) {
  const sheet = $('#sheet-grid');
  sheet.classList.add('folding');
  window.setTimeout(() => { sheet.classList.remove('folding'); done(); }, 420);
}

function showResult(solved, errors) {
  const overlay = $('#result-overlay');
  overlay.hidden = false;
  overlay.classList.toggle('solved', solved);
  const { lvl } = session;
  if (solved) {
    if (!state.completed[lvl.id] || state.completed[lvl.id].attempts > session.attempts) {
      state.completed[lvl.id] = { attempts: session.attempts };
    }
    state.unlocked = Math.max(state.unlocked, Math.min(lvl.id + 1, LEVELS.length));
    saveState(state);
    const taglines = {
      folio: 'the sheet became a book in my hands',
      quarto: 'four folds of nothing turned into a book',
      octavo: 'sixteen pages, one honest sheet',
      duodecimo: 'a half-sheet and a full sheet, gathered as one',
      hexadecimo: 'the master sheet, folded true',
    };
    $('#result-title').textContent = lvl.mode === 'repair' ? 'The fault is found' : 'It reads true';
    $('#result-body').textContent = `Solved in ${session.attempts} attempt${session.attempts === 1 ? '' : 's'}.`;
    $('#result-share').value = encodeShare(lvl.scheme, session.attempts, taglines[lvl.scheme] || 'the sheet became a book in my hands');
    $('#result-share-wrap').hidden = false;
    $('#result-next').hidden = lvl.id >= LEVELS.length;
  } else {
    $('#result-title').textContent = 'Not yet';
    $('#result-body').textContent = lvl.mode === 'repair'
      ? "That's not quite the fault. Look at how the sheet folds again."
      : `${errors.length} page${errors.length === 1 ? '' : 's'} won't read true. Look at the fold, not the page.`;
    $('#result-share-wrap').hidden = true;
    $('#result-next').hidden = true;
  }
}

function closeResult() {
  $('#result-overlay').hidden = true;
}

function nextLevel() {
  closeResult();
  const nextId = session.lvl.id + 1;
  if (nextId <= LEVELS.length) startLevel(nextId);
  else goLevels();
}

function goLevels() {
  closeResult();
  renderLevelList();
  showScreen('levels');
}

function wireStaticUI() {
  $('#btn-play').addEventListener('click', () => { renderLevelList(); showScreen('levels'); });
  $('#btn-how').addEventListener('click', () => showScreen('how'));
  $('#btn-how-back').addEventListener('click', () => showScreen('title'));
  $('#btn-levels-back').addEventListener('click', () => showScreen('title'));
  $('#btn-play-back').addEventListener('click', goLevels);
  $$('.side-tab').forEach((t) => t.addEventListener('click', () => { session.side = t.dataset.side; renderPlay(); }));
  $('#fold-btn').addEventListener('click', doFold);
  $('#submit-btn').addEventListener('click', () => { if (!session.resolved) doSubmitRepair(); else nextLevel(); });
  $('#result-retry').addEventListener('click', closeResult);
  $('#result-next').addEventListener('click', nextLevel);
  $('#result-close').addEventListener('click', () => { closeResult(); goLevels(); });
  $('#result-copy').addEventListener('click', () => {
    const field = $('#result-share');
    field.select();
    try { document.execCommand('copy'); } catch (e) { /* clipboard unavailable */ }
    const btn = $('#result-copy');
    const original = btn.textContent;
    btn.textContent = 'Copied';
    window.setTimeout(() => { btn.textContent = original; }, 1200);
  });
}

wireStaticUI();
showScreen('title');

// ---- Dev hook: ?dev=1 exposes window.__g for scripted, human-free driving ----
if (new URLSearchParams(location.search).get('dev') === '1') {
  window.__g = {
    LEVELS,
    getState: () => JSON.parse(JSON.stringify(state)),
    getSession: () => session,
    resetState: () => { state = { unlocked: 1, completed: {}, current: 1 }; saveState(state); },
    goto: (name) => showScreen(name),
    startLevel,
    setSide: (side) => { session.side = side; renderPlay(); },
    placePage: (side, r, c, page, upsideDown = false) => {
      const cell = session.layout[side].find((p) => p.r === r && p.c === c);
      cell.page = page; cell.upsideDown = upsideDown;
      renderPlay();
    },
    flagCell: (side, r, c) => onRepairCellTap(r, c),
    fold: doFold,
    submitRepair: doSubmitRepair,
    fillCorrectly: () => {
      if (session.mode !== 'place') return;
      for (const side of ['front', 'back']) {
        session.layout[side].forEach((cell, i) => {
          const truth = session.target[side].find((t) => t.r === cell.r && t.c === cell.c);
          cell.page = truth.page; cell.upsideDown = truth.upsideDown;
        });
      }
      renderPlay();
    },
    flagCorrectFaults: () => { if (session.faults) session.flagged = session.faults.map((f) => ({ ...f })); renderPlay(); },
  };
}
