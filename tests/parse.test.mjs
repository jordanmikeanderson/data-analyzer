// Checks how js/parse.js reads numbers, dates and writes CSV cells.
// Run (from the project folder): node --test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const Parse = createRequire(import.meta.url)('../js/parse.js');
const { toNumber, parseDate, csvCell, detectFileStyle, isMissing, style } = Parse;
const reset = () => { style.decimalComma = false; style.dayFirst = false; };

test('ordinary and accounting numbers', () => {
  reset();
  const cases = {
    '1234': 1234, '-5': -5, '1,234.50': 1234.5, '$1,234.50': 1234.5, '(500)': -500, '500-': -500,
    '12%': 12, '−5': -5, ' 1 000 ': 1000, '1.5e3': 1500, '+7': 7,
    ' $ 1,250.00 ': 1250, ' $ (500.00)': -500, '$(1,234.50)': -1234.5, ' $ -   ': 0, '€1000': 1000,
  };
  for (const [text, want] of Object.entries(cases)) assert.equal(toNumber(text), want, JSON.stringify(text));
});

test('things that are not numbers', () => {
  reset();
  for (const text of ['', 'NA', 'n/a', '-', 'abc', '1,23', '12,34,567', '0x10', '1.2.3', 'Unit 5']) {
    assert.ok(Number.isNaN(toNumber(text)), JSON.stringify(text));
  }
  assert.ok(isMissing('  N/A ') && isMissing('') && !isMissing('0'));
});

test('decimal-comma files are detected and read', () => {
  reset();
  const parsed = [['Datum', 'Umsatz'], ['31.01.2026', '12.500,50'], ['28.02.2026', '800,5'], ['31.03.2026', '3,14']];
  assert.equal(detectFileStyle(parsed, ';').decimalComma, true);
  assert.equal(toNumber('12.500,50'), 12500.5);
  assert.equal(toNumber('800,5'), 800.5);
  assert.equal(toNumber('3,14'), 3.14);
  assert.equal(toNumber('1.234.567'), 1234567);
  assert.equal(detectFileStyle(parsed, ',').decimalComma, false, 'never with comma-separated columns');
  reset();
});

test('dates', () => {
  reset();
  const ymd = (d) => d && `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
  assert.equal(ymd(parseDate('2026-01-31')), '2026-1-31');
  assert.equal(ymd(parseDate('1/31/2026')), '2026-1-31');
  assert.equal(ymd(parseDate('31.01.2026')), '2026-1-31');
  assert.equal(ymd(parseDate('Jan 5, 2026')), '2026-1-5');
  assert.equal(parseDate('2026-02-30'), null);
  for (const notDate of ['Unit 5', 'Apt 12', 'Suite 100', '12345', 'hello']) assert.equal(parseDate(notDate), null, notDate);
  detectFileStyle([['date'], ['13/01/2026'], ['01/02/2026']], ',');
  assert.equal(style.dayFirst, true);
  assert.equal(ymd(parseDate('01/02/2026')), '2026-2-1');
  reset();
});

test('CSV cells are quoted and formula-safe', () => {
  reset();
  assert.equal(csvCell('plain'), 'plain');
  assert.equal(csvCell('a,b'), '"a,b"');
  assert.equal(csvCell('say "hi"'), '"say ""hi"""');
  assert.equal(csvCell('=SUM(A1:A9)'), "'=SUM(A1:A9)");
  assert.equal(csvCell('@cmd'), "'@cmd");
  assert.equal(csvCell('+1+1'), "'+1+1");
  assert.equal(csvCell('-5'), '-5', 'real numbers stay numbers');
  assert.equal(csvCell(null), '');
});
