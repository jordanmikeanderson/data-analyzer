// Checks the display helpers (js/helpers.js) and the keyboard/placement logic of the
// Windows 95 drop-down lists (js/win95-select.js).
// Run (from the project folder): node --test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const Helpers = require('../js/helpers.js');
const Win95Select = require('../js/win95-select.js');

test('years print without a thousands comma, other numbers keep it', () => {
  const { fmt, isYear } = Helpers;
  assert.equal(fmt(1976), '1,976');
  assert.equal(fmt(1976, true), '1976');
  assert.equal(fmt(1976.526, true), '1976.53');
  assert.equal(fmt(588000), '588,000');
  assert.equal(fmt(0.123456), '0.1235');
  assert.equal(fmt(NaN), '—');
  assert.ok(isYear(1800) && isYear(2026) && isYear(2100));
  assert.ok(!isYear(1799) && !isYear(2101) && !isYear(1976.5) && !isYear(NaN));
  assert.ok(Helpers.yearColumn('APX_BLT_YR', 1000, 1000));
  assert.ok(!Helpers.yearColumn('TOT_BD_FT2', 1000, 140), 'square feet that happen to be 1800-2100 are not years');
  assert.ok(!Helpers.yearColumn('EMPTY', 0, 0));
});

test('only sensible columns are offered for groups and colors', () => {
  const profiles = {
    UNIT_ID: { type: 'identifier', uniqueCount: 1000 },
    ACRES: { type: 'numeric', uniqueCount: 820 },
    BLT_DECADE: { type: 'numeric', uniqueCount: 16 },
    APX_BLT_YR: { type: 'numeric', uniqueCount: 121 },
    CITY: { type: 'category', uniqueCount: 49 },
    COUNTY: { type: 'category', uniqueCount: 3 },
    NOTES: { type: 'text', uniqueCount: 950 },
    CODE: { type: 'text', uniqueCount: 8 },
    ONE: { type: 'numeric', uniqueCount: 1 },
    EMPTY: { type: 'sparse', uniqueCount: 4 },
    WIDE: { type: 'numeric', uniqueCount: 5000, capped: true },
  };
  const cols = Object.keys(profiles);
  assert.deepEqual(Helpers.groupColumns(cols, profiles), ['BLT_DECADE', 'CITY', 'COUNTY', 'CODE']);
  // Colors may also use number columns (drawn as a shaded scale), but never IDs or long free text.
  assert.deepEqual(Helpers.colorColumns(cols, profiles), ['ACRES', 'BLT_DECADE', 'APX_BLT_YR', 'CITY', 'COUNTY', 'CODE', 'ONE', 'WIDE']);
  assert.deepEqual(Helpers.groupColumns(['MISSING'], profiles), []);
});

test('custom sample size: whole numbers above 0', () => {
  const { customSampleSize } = Helpers;
  assert.deepEqual(customSampleSize('2500'), { n: 2500, error: '' });
  assert.deepEqual(customSampleSize('2,500'), { n: 2500, error: '' });
  assert.deepEqual(customSampleSize('2.9'), { n: 2, error: '' }, 'decimals round down, as before');
  assert.deepEqual(customSampleSize(''), { n: 0, error: '' }, 'blank: no message yet');
  for (const bad of ['0', '-5', '0.5', 'abc', '-']) assert.equal(customSampleSize(bad).error, 'Type a whole number above 0.', bad);
});

test('drop-down keys: Up/Down skip grayed rows and stop at the ends', () => {
  const { step, page } = Win95Select;
  const items = [{ text: 'a' }, { text: 'b', disabled: true }, { text: 'c' }, { text: 'd' }];
  assert.equal(step(items, 0, 1), 2);
  assert.equal(step(items, 2, -1), 0);
  assert.equal(step(items, 3, 1), 3, 'last row stays');
  assert.equal(step(items, 0, -1), 0, 'first row stays');
  assert.equal(step(items, -1, 1), 0, 'Home');
  assert.equal(step(items, items.length, -1), 3, 'End');
  assert.equal(step([], -1, 1), -1);
  assert.equal(page(items, 0, 1, 2), 3);
  assert.equal(page(items, 3, -1, 9), 0);
});

test('drop-down keys: typing a letter jumps to the next match and wraps', () => {
  const { letterJump } = Win95Select;
  const items = ['ACRES', 'APX_BLT_YR', 'BLT_DECADE', 'CITY', 'COUNTY'].map((text) => ({ text }));
  assert.equal(letterJump(items, -1, 'a'), 0);
  assert.equal(letterJump(items, 0, 'A'), 1);
  assert.equal(letterJump(items, 1, 'a'), 0, 'wraps around');
  assert.equal(letterJump(items, 2, 'c'), 3);
  assert.equal(letterJump(items, 3, 'c'), 4);
  assert.equal(letterJump(items, 0, 'z'), -1);
  assert.equal(letterJump([{ text: 'x', disabled: true }, { text: 'xy' }], -1, 'x'), 1, 'skips grayed rows');
});

test('drop-down list placement stays inside the window', () => {
  const { place } = Win95Select;
  const view = { width: 760, height: 560 };
  const field = (top, left = 20, width = 200) => ({ top, bottom: top + 24, left, width });
  // Room below: opens under the box.
  let p = place(field(100), { width: 200, height: 162 }, view, 50);
  assert.deepEqual([p.top, p.height, p.up], [124, 162, false]);
  // Near the bottom: opens above.
  p = place(field(500), { width: 200, height: 162 }, view, 50);
  assert.deepEqual([p.top, p.height, p.up], [338, 162, true]);
  // Too tall either way: shrinks to the bigger side and scrolls.
  p = place(field(300), { width: 200, height: 1000 }, view, 50);
  assert.ok(p.up && p.top === 0 && p.height === 300);
  // Wider than the box and near the right edge: slides left; never wider than the window.
  p = place(field(100, 700, 50), { width: 180, height: 50 }, view, 50);
  assert.deepEqual([p.left, p.width], [580, 180]);
  p = place(field(100, 0, 50), { width: 2000, height: 50 }, { width: 390, height: 700 }, 50);
  assert.deepEqual([p.left, p.width], [0, 390]);
  // Tiny window: still on screen.
  p = place(field(40), { width: 100, height: 300 }, { width: 300, height: 90 }, 50);
  assert.ok(p.top >= 0 && p.top + p.height <= 90);
});
