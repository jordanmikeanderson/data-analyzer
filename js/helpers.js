/*
 * Data Analyzer: small display helpers with no browser APIs, so they can be tested in Node.
 * Number formatting, which columns make sensible groups, and the custom sample size check.
 */
'use strict';

const Helpers = (() => {
  const { toNumber } = typeof Parse !== 'undefined' ? Parse : require('./parse.js');

  // Number columns with this many different values or fewer still make sensible groups (like a decade).
  const MAX_NUMBER_GROUPS = 20;

  // Numbers for tables and messages: thousands commas and sensible decimals.
  // plain = no thousands comma, for year columns (1976, not 1,976).
  function fmt(v, plain = false) {
    if (v === null || v === undefined || !Number.isFinite(v)) return '—';
    const a = Math.abs(v);
    if (a !== 0 && (a < 1e-6 || a >= 1e15)) return v.toExponential(3);
    if (a !== 0 && a < 1) return v.toLocaleString('en-US', { maximumSignificantDigits: 4, useGrouping: !plain });
    const digits = a >= 100000 ? 0 : a >= 1000 ? 2 : a >= 10 ? 3 : 4;
    return v.toLocaleString('en-US', { maximumFractionDigits: digits, useGrouping: !plain });
  }

  // A whole number that reads as a year. A column is year-like when every number in it is one.
  const isYear = (n) => Number.isInteger(n) && n >= 1800 && n <= 2100;
  // numbers = how many cells in the column are numbers, years = how many of those are years.
  const yearColumn = (col, numbers, years) => numbers > 0 && years === numbers;

  // Columns worth splitting the rows by: categories, plus any other column with only a few
  // different values (like BLT_DECADE). Not ID-like, mostly blank, or many-valued columns
  // (ACRES has 820 different values, which would make 820 "groups").
  function groupColumns(columns, profiles, maxGroups = MAX_NUMBER_GROUPS) {
    return columns.filter((c) => {
      const p = profiles[c];
      if (!p || p.type === 'identifier' || p.type === 'sparse') return false;
      if (p.type === 'category') return true;
      return !p.capped && p.uniqueCount >= 2 && p.uniqueCount <= maxGroups;
    });
  }

  // Columns that can color the dots: the group columns, plus number columns (drawn as a shaded scale).
  function colorColumns(columns, profiles) {
    const groups = new Set(groupColumns(columns, profiles));
    return columns.filter((c) => groups.has(c) || (profiles[c] && profiles[c].type === 'numeric'));
  }

  // The "Custom size" box on the Random sample panel. Decimals round down (2.5 keeps 2 rows).
  function customSampleSize(text) {
    const s = String(text ?? '').trim();
    if (!s) return { n: 0, error: '' };
    const n = Math.floor(toNumber(s));
    if (!Number.isFinite(n) || n < 1) return { n: 0, error: 'Type a whole number above 0.' };
    return { n, error: '' };
  }

  return { MAX_NUMBER_GROUPS, fmt, isYear, yearColumn, groupColumns, colorColumns, customSampleSize };
})();

if (typeof module !== 'undefined') module.exports = Helpers;
