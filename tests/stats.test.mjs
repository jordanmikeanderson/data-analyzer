// Checks js/stats.js against results from Python's SciPy (scipy.stats.linregress / t.ppf).
// Run (from the project folder): node --test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const Stats = createRequire(import.meta.url)('../js/stats.js');

const close = (a, b, rel = 1e-8, label = '') =>
  assert.ok(Math.abs(a - b) <= rel * Math.max(1, Math.abs(b)), `${label}: got ${a}, expected ${b}`);

test('small exact case (n = 4)', () => {
  const m = Stats.regress([1, 2, 3, 4], [2, 4.1, 5.9, 8.2]);
  close(m.slope, 2.04, 1e-10, 'slope');
  close(m.intercept, -0.05, 1e-10, 'intercept');
  close(m.r, 0.998992298, 1e-8, 'r');
  close(m.seSlope, 0.0648074, 1e-5, 'std error of slope');
  close(m.p, 0.0010077, 1e-4, 'p-value');
});

test('large numbers keep their precision (values around 2 billion)', () => {
  const xs = [], ys = [];
  for (let i = 0; i < 200; i++) { const x = 2e9 + i * 1e6; xs.push(x); ys.push(0.001 * x + ((i * 37) % 11) - 5); }
  const m = Stats.regress(xs, ys);
  assert.ok(Math.abs(m.slope - 0.001) < 1e-6, `slope ${m.slope}`);
  assert.ok(m.r > 0.999, `r ${m.r}`);
});

test('t distribution matches SciPy', () => {
  close(Stats.tCritical(0.95, 340), 1.9669657, 1e-6, 't 95% df=340');
  close(Stats.tCritical(0.95, 2), 4.3026527, 1e-6, 't 95% df=2');
  close(Stats.tCritical(0.90, 12), 1.7822875556, 1e-8, 't 90% df=12');
  close(Stats.tCritical(0.99, 3), 5.8409093097, 1e-8, 't 99% df=3');
  close(Stats.tTwoSidedP(2.0, 1000), 0.0457703464933, 1e-9, 'p for t=2, df=1000');
});

test('refuses impossible cases with a plain message', () => {
  assert.match(Stats.regress([1, 2], [3, 4]).error, /at least 3/);
  assert.match(Stats.regress([5, 5, 5], [1, 2, 3]).error, /same X/);
  assert.match(Stats.regress([1, 2, 3], [7, 7, 7]).error, /same Y/);
});
