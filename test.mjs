// test.mjs — headless tests for FOLIO. `node test.mjs`, exit 0 = green.
import {
  mulberry32, SCHEMES, simulateFold, foldSequence, foldSequenceDuodecimo,
  targetFor, check, flipbook, readsInOrder, generateMisprint, encodeShare,
} from './fold.mjs';

let pass = 0, fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass++; }
  else { fail++; console.error(`FAIL: ${name}${detail ? ' — ' + JSON.stringify(detail) : ''}`); }
}
function deepEq(a, b) { return JSON.stringify(a) === JSON.stringify(b); }

// 1. mulberry32 determinism: same seed -> same sequence
{
  const a = mulberry32(42), b = mulberry32(42);
  const seqA = [a(), a(), a()], seqB = [b(), b(), b()];
  ok('mulberry32 deterministic for same seed', deepEq(seqA, seqB));
}

// 2. mulberry32 different seeds diverge
{
  const a = mulberry32(1)(), b = mulberry32(2)();
  ok('mulberry32 differs across seeds', a !== b);
}

// 3. mulberry32 stays in [0,1) over many draws
{
  const rng = mulberry32(7);
  let allBounded = true;
  for (let i = 0; i < 2000; i++) { const v = rng(); if (v < 0 || v >= 1) { allBounded = false; break; } }
  ok('mulberry32 output bounded [0,1) over 2000 draws', allBounded);
}

// 4. Every scheme's fold sequence resolves to leaves = rows*cols and pages = 2*leaves
for (const key of Object.keys(SCHEMES)) {
  const t = foldSequence(key);
  ok(`${key}: leaves === rows*cols`, t.leaves === SCHEMES[key].rows * SCHEMES[key].cols, t);
  ok(`${key}: pages === 2*leaves`, t.pages === 2 * t.leaves, t);
}

// 5. Every scheme: front+back cells form a bijection onto leaves 1..L (each leaf exactly once per side)
for (const key of Object.keys(SCHEMES)) {
  const t = foldSequence(key);
  for (const side of ['front', 'back']) {
    const leaves = t[side].map((c) => c.leaf).sort((a, b) => a - b);
    const expected = Array.from({ length: t.leaves }, (_, i) => i + 1);
    ok(`${key} ${side}: leaf indices form 1..L bijection`, deepEq(leaves, expected), leaves);
  }
}

// 6. Every scheme: page numbers on front+back together are exactly 1..pages, each once
for (const key of Object.keys(SCHEMES)) {
  const t = foldSequence(key);
  const allPages = [...t.front.map((c) => c.page), ...t.back.map((c) => c.page)].sort((a, b) => a - b);
  const expected = Array.from({ length: t.pages }, (_, i) => i + 1);
  ok(`${key}: all page numbers 1..pages appear exactly once`, deepEq(allPages, expected));
}

// 7. Canonical truth table — folio (hand-verified): fold ['V'] on a 1x2 grid.
// Right half (col1) flips onto left half (col0) and lands on top -> leaf1=col1(flip1), leaf2=col0(flip0).
{
  const t = foldSequence('folio');
  const cellAt = (side, c) => t[side].find((x) => x.c === c);
  ok('folio truth table: front col1 is page 1, upside down', cellAt('front', 1).page === 1 && cellAt('front', 1).upsideDown === true);
  ok('folio truth table: front col0 is page 3, upright', cellAt('front', 0).page === 3 && cellAt('front', 0).upsideDown === false);
  ok('folio truth table: back col1 is page 2, upside down', cellAt('back', 1).page === 2 && cellAt('back', 1).upsideDown === true);
  ok('folio truth table: back col0 is page 4, upright', cellAt('back', 0).page === 4 && cellAt('back', 0).upsideDown === false);
}

// 8. Fold mapping is involutive-consistent: leaf assignment is a bijection whose
// inverse (leaf -> cell) round-trips back to the same cell for every scheme.
for (const key of Object.keys(SCHEMES)) {
  const t = foldSequence(key);
  let roundTripOk = true;
  for (const cell of t.front) {
    const backToCell = t.front.find((x) => x.leaf === cell.leaf);
    if (backToCell.r !== cell.r || backToCell.c !== cell.c) roundTripOk = false;
  }
  ok(`${key}: leaf->cell inverse round-trips (involutive)`, roundTripOk);
}

// 9. The correct target layout, run through flipbook, always reads in perfect order (solver proves solvable)
for (const key of [...Object.keys(SCHEMES), 'duodecimo']) {
  const target = targetFor(key);
  const layout = {
    front: target.front.map((c) => ({ r: c.r, c: c.c, page: c.page, upsideDown: c.upsideDown })),
    back: target.back.map((c) => ({ r: c.r, c: c.c, page: c.page, upsideDown: c.upsideDown })),
  };
  const flip = flipbook(layout, key);
  ok(`${key}: correct layout reads in perfect order (level solvable)`, readsInOrder(flip));
  const errors = check(layout, target);
  ok(`${key}: correct layout has zero check() errors`, errors.length === 0, errors.slice(0, 3));
}

// 10. duodecimo composite: 12 leaves, 24 pages, quarto+octavo panels concatenated correctly
{
  const d = foldSequenceDuodecimo();
  ok('duodecimo: 12 leaves', d.leaves === 12, d.leaves);
  ok('duodecimo: 24 pages', d.pages === 24, d.pages);
  const allPages = [...d.front.map((c) => c.page), ...d.back.map((c) => c.page)].sort((a, b) => a - b);
  const expected = Array.from({ length: 24 }, (_, i) => i + 1);
  ok('duodecimo: pages 1..24 each exactly once', deepEq(allPages, expected));
}

// 11. Misprint generator: exactly numFaults*2 faulty cells over >=100 seeds, for every scheme, numFaults 1..3
// (skipped where the scheme has too few cells to fit that many disjoint swap-pairs)
{
  let allGood = true, checkedSeeds = 0;
  for (const key of [...Object.keys(SCHEMES), 'duodecimo']) {
    const totalCells = targetFor(key).front.length + targetFor(key).back.length;
    for (let numFaults = 1; numFaults <= 3; numFaults++) {
      if (numFaults * 2 > totalCells) continue;
      for (let seed = 0; seed < 100; seed++) {
        checkedSeeds++;
        const { layout, faults, target } = generateMisprint(key, seed * 7919 + numFaults, numFaults);
        const errors = check(layout, target);
        if (errors.length !== faults.length) { allGood = false; }
        if (faults.length !== numFaults * 2) { allGood = false; }
      }
    }
  }
  ok('misprint generator: exactly planted faults reported, over 100+ seeds x schemes x faultCounts', allGood, { checkedSeeds });
}

// 12. Misprint generator determinism: same seed -> identical faults and layout
{
  const a = generateMisprint('octavo', 12345, 2);
  const b = generateMisprint('octavo', 12345, 2);
  ok('generateMisprint deterministic for same seed', deepEq(a.faults, b.faults) && deepEq(a.layout, b.layout));
}

// 13. Misprint generator never plants a fault that quietly matches (all faulty cells actually mismatch target)
{
  let allMismatch = true;
  for (let seed = 0; seed < 50; seed++) {
    const { layout, faults, target } = generateMisprint('quarto', seed, 2);
    for (const f of faults) {
      const placed = layout[f.side].find((p) => p.r === f.r && p.c === f.c);
      const truth = target[f.side].find((p) => p.r === f.r && p.c === f.c);
      if (placed.page === truth.page) allMismatch = false;
    }
  }
  ok('every planted fault cell actually differs from target (no accidental match)', allMismatch);
}

// 14. check() flags a wrong-orientation cell distinctly from wrong-page
{
  const target = foldSequence('folio');
  const layout = {
    front: target.front.map((c) => ({ r: c.r, c: c.c, page: c.page, upsideDown: c.upsideDown })),
    back: target.back.map((c) => ({ r: c.r, c: c.c, page: c.page, upsideDown: c.upsideDown })),
  };
  layout.front[0].upsideDown = !layout.front[0].upsideDown;
  const errors = check(layout, target);
  ok('check() detects orientation-only error', errors.length === 1 && errors[0].type === 'wrong-orientation', errors);
}

// 15. check() flags missing placement distinctly
{
  const target = foldSequence('folio');
  const layout = { front: [], back: [] };
  const errors = check(layout, target);
  ok('check() flags every unplaced cell as missing', errors.length === target.front.length + target.back.length && errors.every((e) => e.type === 'missing'));
}

// 16. readsInOrder rejects an out-of-order flipbook
{
  const target = foldSequence('quarto');
  const layout = {
    front: target.front.map((c) => ({ r: c.r, c: c.c, page: c.page === 1 ? 3 : c.page === 3 ? 1 : c.page, upsideDown: c.upsideDown })),
    back: target.back.map((c) => ({ r: c.r, c: c.c, page: c.page, upsideDown: c.upsideDown })),
  };
  const flip = flipbook(layout, 'quarto');
  ok('readsInOrder rejects a swapped/out-of-order layout', readsInOrder(flip) === false);
}

// 17. simulateFold throws on an odd (non-halvable) dimension rather than silently miscomputing
{
  let threw = false;
  try { simulateFold(1, 3, ['V']); } catch (e) { threw = true; }
  ok('simulateFold throws on non-power-of-two fold axis instead of silently corrupting', threw);
}

// 18. encodeShare produces the documented format and round-trips scheme name + attempt count
{
  const s = encodeShare('octavo', 1, 'the sheet became a book in my hands');
  ok('encodeShare: contains scheme name', s.includes('octavo'));
  ok('encodeShare: singular "first try" phrasing at attempts=1', s.includes('first try'));
  const s2 = encodeShare('octavo', 3, 'tag');
  ok('encodeShare: plural "N tries" phrasing at attempts>1', s2.includes('3 tries'));
}

// 19. bounds over 365 "day-seeded" misprints for the daily-repair scheme (octavo) — no crashes, always exactly-faulted
{
  let allGood = true;
  for (let day = 0; day < 365; day++) {
    const { layout, faults, target } = generateMisprint('octavo', day, 2);
    const errors = check(layout, target);
    if (errors.length !== faults.length || faults.length !== 4) allGood = false;
  }
  ok('365 day-seeds of octavo misprint: always exactly 4 faulty cells, no crash', allGood);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
