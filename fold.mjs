// fold.mjs — pure core for FOLIO. No DOM, no Date.now(), no unseeded Math.random().
// Models real printer's imposition: a flat sheet folded f times becomes a signature
// of L leaves (2L pages). This module derives, by literal fold simulation, which
// page + orientation belongs at every flat-sheet grid position so that folding
// (and trimming every crease but the last) produces a correctly ordered booklet.

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function rng() {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle(arr, rng) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// Fold factor sequences: each 'V' fold doubles column count (built from scratch),
// each 'H' fold doubles row count. rows*cols === leaves for every scheme.
export const SCHEMES = {
  folio:  { name: 'Folio',  leaves: 2,  rows: 1, cols: 2, folds: ['V'] },
  quarto: { name: 'Quarto', leaves: 4,  rows: 2, cols: 2, folds: ['V', 'H'] },
  octavo: { name: 'Octavo', leaves: 8,  rows: 2, cols: 4, folds: ['V', 'H', 'V'] },
  hexadecimo: { name: 'Hexadecimo', leaves: 16, rows: 4, cols: 4, folds: ['V', 'H', 'V', 'H'] },
};

// Duodecimo has no clean power-of-two fold; real 12mo signatures were historically
// gathered by combining a half-sheet and a full sheet. We model it the same honest
// way: one quarto panel (4 leaves) beside one octavo panel (8 leaves), 12 leaves total.
export const DUODECIMO_PARTS = ['quarto', 'octavo'];

// Simulates physically folding a rows x cols flat grid according to `folds`.
// Returns the final single stack (length rows*cols) top(outermost)->bottom(innermost),
// each entry {r, c, flips} where flips = number of 180-degree turns that original
// grid cell experienced while folding (odd = ends up upside-down).
export function simulateFold(rows, cols, folds) {
  let packet = [];
  for (let i = 0; i < rows; i++) {
    packet.push([]);
    for (let j = 0; j < cols; j++) packet[i].push([{ r: i, c: j, flips: 0 }]);
  }
  let curRows = rows, curCols = cols;
  for (const axis of folds) {
    if (axis === 'V') {
      const newCols = curCols / 2;
      if (!Number.isInteger(newCols)) throw new Error('odd column fold');
      const next = [];
      for (let i = 0; i < curRows; i++) {
        next.push([]);
        for (let j = 0; j < newCols; j++) {
          const left = packet[i][j];
          const right = packet[i][curCols - 1 - j]
            .map((e) => ({ ...e, flips: e.flips + 1 }))
            .slice()
            .reverse();
          next[i].push([...right, ...left]);
        }
      }
      packet = next; curCols = newCols;
    } else if (axis === 'H') {
      const newRows = curRows / 2;
      if (!Number.isInteger(newRows)) throw new Error('odd row fold');
      const next = [];
      for (let i = 0; i < newRows; i++) {
        next.push([]);
        for (let j = 0; j < curCols; j++) {
          const top = packet[i][j];
          const bottom = packet[curRows - 1 - i][j]
            .map((e) => ({ ...e, flips: e.flips + 1 }))
            .slice()
            .reverse();
          next[i].push([...bottom, ...top]);
        }
      }
      packet = next; curRows = newRows;
    } else {
      throw new Error('unknown fold axis: ' + axis);
    }
  }
  if (curRows !== 1 || curCols !== 1) throw new Error('fold sequence did not resolve to one packet');
  return packet[0][0];
}

// The canonical imposition for one scheme: where every page+orientation belongs
// on the flat front and back of the sheet, derived purely from fold geometry.
export function foldSequence(schemeKey) {
  const s = SCHEMES[schemeKey];
  if (!s) throw new Error('unknown scheme: ' + schemeKey);
  const stack = simulateFold(s.rows, s.cols, s.folds);
  const leafOf = Array.from({ length: s.rows }, () => Array(s.cols).fill(0));
  const flipOf = Array.from({ length: s.rows }, () => Array(s.cols).fill(0));
  stack.forEach((entry, idx) => {
    leafOf[entry.r][entry.c] = idx + 1;
    flipOf[entry.r][entry.c] = entry.flips % 2;
  });
  const front = [], back = [];
  for (let r = 0; r < s.rows; r++) {
    for (let c = 0; c < s.cols; c++) {
      const leaf = leafOf[r][c];
      const upsideDown = !!flipOf[r][c];
      front.push({ r, c, leaf, page: 2 * leaf - 1, upsideDown });
      back.push({ r, c, leaf, page: 2 * leaf, upsideDown });
    }
  }
  return { scheme: schemeKey, name: s.name, rows: s.rows, cols: s.cols, leaves: s.leaves, pages: s.leaves * 2, front, back };
}

// Composite duodecimo signature: quarto panel + octavo panel side by side,
// leaves and pages renumbered to run 1..12 / 1..24 continuously across both.
export function foldSequenceDuodecimo() {
  const q = foldSequence('quarto');
  const o = foldSequence('octavo');
  const leafOffset = q.leaves;
  const pageOffset = q.pages;
  const colOffset = q.cols;
  const rows = Math.max(q.rows, o.rows);
  const relabel = (cells, panel, cOff, leafOff, pageOff) =>
    cells.map((e) => ({ ...e, c: e.c + cOff, leaf: e.leaf + leafOff, page: e.page + pageOff, panel }));
  const front = [
    ...relabel(q.front, 'A', 0, 0, 0),
    ...relabel(o.front, 'B', colOffset, leafOffset, pageOffset),
  ];
  const back = [
    ...relabel(q.back, 'A', 0, 0, 0),
    ...relabel(o.back, 'B', colOffset, leafOffset, pageOffset),
  ];
  return {
    scheme: 'duodecimo', name: 'Duodecimo', rows, cols: q.cols + o.cols,
    leaves: q.leaves + o.leaves, pages: q.pages + o.pages, front, back,
    panels: [
      { key: 'A', scheme: 'quarto', cols: q.cols, rows: q.rows, colOffset: 0 },
      { key: 'B', scheme: 'octavo', cols: o.cols, rows: o.rows, colOffset },
    ],
  };
}

export function targetFor(schemeKey) {
  return schemeKey === 'duodecimo' ? foldSequenceDuodecimo() : foldSequence(schemeKey);
}

// Compares a player's placement (layout) against the correct imposition (target).
// layout: { front: [{r,c,page,upsideDown}], back: [...] } — need not cover every cell.
export function check(layout, target) {
  const errors = [];
  for (const side of ['front', 'back']) {
    const placedCells = (layout && layout[side]) || [];
    for (const cell of target[side]) {
      const placed = placedCells.find((p) => p.r === cell.r && p.c === cell.c);
      if (!placed || placed.page == null) {
        errors.push({ side, r: cell.r, c: cell.c, type: 'missing' });
      } else if (placed.page !== cell.page) {
        errors.push({ side, r: cell.r, c: cell.c, type: 'wrong-page', expected: cell.page, got: placed.page });
      } else if (!!placed.upsideDown !== !!cell.upsideDown) {
        errors.push({ side, r: cell.r, c: cell.c, type: 'wrong-orientation', expected: cell.upsideDown });
      }
    }
  }
  return errors;
}

// Reads a layout in physical folded reading order: leaf 1 front, leaf 1 back,
// leaf 2 front, leaf 2 back, ... Leaf geometry is fixed by the scheme; only the
// page/orientation actually printed at each cell comes from `layout`.
//
// A cell's upsideDown flag on the flat sheet is not what the reader sees: folding
// itself rotates every cell by `flips` (see simulateFold), and the target's own
// upsideDown value already equals that required rotation (flips % 2) — printed
// upside-down on the flat sheet so the fold turns it right-side-up in the book.
// So the orientation actually seen after folding is only wrong when the placed
// flat-sheet orientation diverges from what the target requires at that cell.
export function flipbook(layout, schemeKey) {
  const target = targetFor(schemeKey);
  const result = [];
  for (let leaf = 1; leaf <= target.leaves; leaf++) {
    const frontCell = target.front.find((f) => f.leaf === leaf);
    const backCell = target.back.find((f) => f.leaf === leaf);
    const frontPlaced = (layout.front || []).find((p) => p.r === frontCell.r && p.c === frontCell.c);
    const backPlaced = (layout.back || []).find((p) => p.r === backCell.r && p.c === backCell.c);
    result.push({
      leaf,
      frontPage: frontPlaced && frontPlaced.page != null ? frontPlaced.page : null,
      frontUpsideDown: frontPlaced ? (!!frontPlaced.upsideDown !== !!frontCell.upsideDown) : true,
      backPage: backPlaced && backPlaced.page != null ? backPlaced.page : null,
      backUpsideDown: backPlaced ? (!!backPlaced.upsideDown !== !!backCell.upsideDown) : true,
    });
  }
  return result;
}

// True iff the flipbook reading order is exactly 1,2,3,...,pages, all upright.
export function readsInOrder(flip) {
  let expected = 1;
  for (const leaf of flip) {
    if (leaf.frontPage !== expected || leaf.frontUpsideDown) return false;
    expected++;
    if (leaf.backPage !== expected || leaf.backUpsideDown) return false;
    expected++;
  }
  return true;
}

function layoutFromTarget(target) {
  return {
    front: target.front.map((c) => ({ r: c.r, c: c.c, page: c.page, upsideDown: c.upsideDown })),
    back: target.back.map((c) => ({ r: c.r, c: c.c, page: c.page, upsideDown: c.upsideDown })),
  };
}

// Deterministically generates a misprinted (already-placed) layout with exactly
// `numFaults` swap-pairs planted — guaranteeing exactly 2*numFaults faulty cells,
// no accidental extra or missing faults (all pages are distinct, so any swap of
// two different pages necessarily miscompares both cells against the target).
export function generateMisprint(schemeKey, seed, numFaults = 1) {
  const rng = mulberry32(seed);
  const target = targetFor(schemeKey);
  const layout = layoutFromTarget(target);
  const pool = [];
  for (const side of ['front', 'back']) layout[side].forEach((_, i) => pool.push({ side, i }));
  shuffle(pool, rng);

  const faults = [];
  let planted = 0, idx = 0;
  while (planted < numFaults && idx + 1 < pool.length) {
    const a = pool[idx], b = pool[idx + 1]; idx += 2;
    const cellA = layout[a.side][a.i], cellB = layout[b.side][b.i];
    if (cellA.page === cellB.page) continue;
    const tmp = cellA.page; cellA.page = cellB.page; cellB.page = tmp;
    faults.push({ side: a.side, r: cellA.r, c: cellA.c }, { side: b.side, r: cellB.r, c: cellB.c });
    planted++;
  }
  return { layout, faults, target, scheme: schemeKey };
}

export function encodeShare(schemeKey, attempts, tagline) {
  const emoji = '📖';
  return `${emoji} FOLIO · ${SCHEMES[schemeKey] ? SCHEMES[schemeKey].name.toLowerCase() : schemeKey}, ${attempts === 1 ? 'first try' : attempts + ' tries'} · ${tagline} · http://folio.defimagic.io`;
}
