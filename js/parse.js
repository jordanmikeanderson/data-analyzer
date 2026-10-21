/*
 * Data Analyzer: reading numbers and dates the way spreadsheets write them,
 * and writing CSV cells safely. No browser APIs, so it can be tested in Node.
 */
'use strict';

const Parse = (() => {
  const MISSING = new Set(['', 'na', 'n/a', 'null', 'nan', 'none', '#n/a', '-', '--', 'undefined', 'missing', '.']);
  const PLAIN = /^-?\d+(\.\d+)?$/;
  const THOUSANDS = /^-?\d{1,3}(,\d{3})+(\.\d+)?$/;
  const MONTH = /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\b/i;

  // How the open file writes numbers and dates. Set by detectFileStyle() when a file is opened.
  const style = { decimalComma: false, dayFirst: false };

  function isMissing(v) {
    if (v === null || v === undefined || v === '') return true;
    if (typeof v === 'string') {
      const c = v.charCodeAt(0);
      if (c >= 48 && c <= 57) return false;   // starts with a digit: never a blank marker
      if (v.length > 12) return false;        // longer than any blank marker (plus spaces)
    }
    return MISSING.has(String(v).trim().toLowerCase());
  }

  /*
   * Reads numbers as people and spreadsheets write them:
   *   1234   1,234.50   $1,234.50   (500)   -500   500-   12%   −5 (unicode minus)
   *   Excel "Accounting" cells:  " $ 1,250.00 "   " $ (500.00)"   " $ -   " (= 0)
   *   Decimal-comma files (when detected):  1.234,50   800,5
   * Commas must sit in real thousands positions, so "1,23" is not a number.
   * A percent sign is dropped: "12%" reads as 12.
   */
  function toNumber(v) {
    if (typeof v === 'number') return Number.isFinite(v) ? v : NaN;
    if (v === null || v === undefined) return NaN;
    let s = String(v);
    const c0 = s.charCodeAt(0) | 32;                 // a word ("Salt Lake", "single_family") is never a number
    if (c0 >= 97 && c0 <= 122) return NaN;
    if (!style.decimalComma) {                       // fast paths for ordinary numbers
      if (PLAIN.test(s)) return +s;
      if (THOUSANDS.test(s)) return +s.replace(/,/g, '');
    }
    s = s.trim().replace(/−/g, '-');
    if (MISSING.has(s.toLowerCase())) return NaN;
    const hadCurrency = /[$€£¥]/.test(s);
    s = s.replace(/[$€£¥\s  ]/g, '');
    if (hadCurrency && /^-+$/.test(s)) return 0; // Accounting format shows zero as "$ -"
    let neg = false;
    if (s.length > 2 && s[0] === '(' && s[s.length - 1] === ')') { neg = true; s = s.slice(1, -1); }
    if (s.endsWith('%')) s = s.slice(0, -1);
    if (s.length > 1 && s.endsWith('-') && /^\d/.test(s)) { neg = !neg; s = s.slice(0, -1); }
    if (style.decimalComma) {
      if (!/^[-+]?(\d{1,3}(\.\d{3})+|\d+)?(,\d+)?$/.test(s) || !/\d/.test(s)) return NaN;
      s = s.replace(/\./g, '').replace(',', '.');
    } else if (s.includes(',')) {
      if (!/^[-+]?\d{1,3}(,\d{3})+(\.\d*)?$/.test(s)) return NaN;
      s = s.replace(/,/g, '');
    }
    if (!/^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i.test(s)) return NaN;
    const n = Number(s);
    return Number.isFinite(n) ? (neg ? -n : n) : NaN;
  }

  function validDate(y, mo, d) {
    if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
    const dt = new Date(y, mo - 1, d);
    return dt.getMonth() === mo - 1 ? dt : null;
  }

  // Dates: YYYY-MM-DD (time allowed), M/D/YYYY (or D/M/YYYY when detected), D.M.YYYY,
  // or text with a month name like "Jan 5, 2026". "Unit 5" is not a date.
  function parseDate(v) {
    if (isMissing(v)) return null;
    const s = String(v).trim();
    let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T\s].*)?$/);
    if (m) return validDate(+m[1], +m[2], +m[3]);
    m = s.match(/^(\d{1,2})([/.])(\d{1,2})\2(\d{2}|\d{4})$/);
    if (m) {
      let y = +m[4];
      if (m[4].length === 2) y += y < 50 ? 2000 : 1900;
      const dayFirst = style.dayFirst || m[2] === '.';
      return dayFirst ? validDate(y, +m[3], +m[1]) : validDate(y, +m[1], +m[3]);
    }
    if (MONTH.test(s) && /\d/.test(s) && s.length < 40) {
      const d = new Date(s);
      return Number.isNaN(d.getTime()) ? null : d;
    }
    return null;
  }

  // Looks at the cells of a parsed file (array of rows) and sets `style`.
  // Decimal comma ("1.234,5") is only possible when commas don't separate the columns.
  // Day-first dates: some date has a first part above 12 and none has a middle part above 12.
  function detectFileStyle(parsed, delim) {
    let commaDec = 0, dotDec = 0, firstBig = 0, secondBig = 0, seen = 0;
    for (let i = 1; i < parsed.length && seen < 20000; i++) {
      for (const cell of parsed[i]) {
        const v = String(cell).trim();
        if (!v) continue;
        seen++;
        if (/^[-+(]?[$€£]?(\d{1,3}(\.\d{3})+,\d+|\d{1,3}(\.\d{3}){2,}|\d+,\d+)\)?$/.test(v) && !/^\d{1,3}(,\d{3})+$/.test(v)) commaDec++;
        else if (/^[-+(]?[$€£]?\d+\.\d+\)?$/.test(v)) dotDec++;
        const m = v.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/);
        if (m) { if (+m[1] > 12) firstBig++; if (+m[2] > 12) secondBig++; }
      }
    }
    style.decimalComma = delim !== ',' && commaDec > dotDec;
    style.dayFirst = firstBig > 0 && secondBig === 0;
    return { ...style };
  }

  // One CSV cell. Text starting with = + - @ (or a tab/return) could run as a formula
  // when the file is opened in Excel, so it gets a leading apostrophe. Numbers like -5 don't.
  function csvCell(v) {
    if (v === null || v === undefined) return '';
    let s = String(v);
    if (/^[=+\-@\t\r]/.test(s) && !Number.isFinite(toNumber(s))) s = "'" + s;
    return /[",\r\n]/.test(s) || /^\s|\s$/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }

  // Decode file bytes: honor a BOM, else UTF-8, else Windows-1252 (Excel's "CSV (Comma delimited)" on Windows).
  function decodeBytes(buf) {
    const b = new Uint8Array(buf);
    if (b[0] === 0xFF && b[1] === 0xFE) return { text: new TextDecoder('utf-16le').decode(b), encoding: 'UTF-16' };
    if (b[0] === 0xFE && b[1] === 0xFF) return { text: new TextDecoder('utf-16be').decode(b), encoding: 'UTF-16' };
    try { return { text: new TextDecoder('utf-8', { fatal: true }).decode(b), encoding: 'UTF-8' }; }
    catch (e) { return { text: new TextDecoder('windows-1252').decode(b), encoding: 'Windows-1252' }; }
  }

  return { MISSING, style, isMissing, toNumber, parseDate, detectFileStyle, csvCell, decodeBytes };
})();

if (typeof module !== 'undefined') module.exports = Parse;
