/*
 * Data Analyzer: clean a CSV, then measure how two columns relate.
 * Plain JavaScript + D3 (charts only). Everything runs in the browser.
 */
'use strict';

(() => {
  // ---------------------------------------------------------------- helpers
  const $ = (id) => document.getElementById(id);
  const ROW = Symbol('excelRow');           // Excel row number of each data row (header = row 1)
  const MAX_POINTS = 5000;                   // most dots drawn on the chart (the math uses all rows)
  const MAX_RANK_COLUMNS = 80;
  const SAMPLE_NAME = 'utah-housing-sample.csv';
  const MISSING = new Set(['', 'na', 'n/a', 'null', 'nan', 'none', '#n/a', '-', '--', 'undefined', 'missing', '.']);
  const ID_NAME = /(^|[_\s.-])(id|uuid|guid|objectid|fid|key)([_\s.-]|$)/i;
  const DATE_NAME = /(date|time|created|updated|posted|period|day)/i;
  const Y_HINT = /(value|price|amount|total|revenue|sales|cost|income|spend|salary|balance|profit|expense|score|mass|weight)/i;
  const TYPE_LABEL = { numeric: 'number', category: 'category', date: 'date', text: 'text', identifier: 'ID', sparse: 'mostly blank' };

  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const isMissing = (v) => v === null || v === undefined || MISSING.has(String(v).trim().toLowerCase());

  // Reads "1,234", "$1,234.50", "(500)", "12%", "1 000", "123-" as numbers.
  function toNumber(v) {
    if (typeof v === 'number') return Number.isFinite(v) ? v : NaN;
    if (isMissing(v)) return NaN;
    let s = String(v).trim();
    let neg = false;
    if (s.length > 2 && s[0] === '(' && s[s.length - 1] === ')') { neg = true; s = s.slice(1, -1); }
    s = s.replace(/[$€£¥,%\s]/g, '');
    if (s.length > 1 && s.endsWith('-') && /^\d/.test(s)) { neg = !neg; s = s.slice(0, -1); }
    if (!/^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i.test(s)) return NaN;
    const n = Number(s);
    return Number.isFinite(n) ? (neg ? -n : n) : NaN;
  }

  // Dates: YYYY-MM-DD (optionally with a time), M/D/YYYY, or text like "Jan 5 2026".
  function parseDate(v) {
    if (isMissing(v)) return null;
    const s = String(v).trim();
    let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T\s].*)?$/);
    if (m) return validDate(+m[1], +m[2], +m[3]);
    m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/);
    if (m) { let y = +m[3]; if (m[3].length === 2) y += y < 50 ? 2000 : 1900; return validDate(y, +m[1], +m[2]); }
    if (/[A-Za-z]{3,}/.test(s) && /\d/.test(s) && s.length < 40) {
      const d = new Date(s);
      return Number.isNaN(d.getTime()) ? null : d;
    }
    return null;
  }
  function validDate(y, mo, d) {
    if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
    const dt = new Date(y, mo - 1, d);
    return dt.getMonth() === mo - 1 ? dt : null;
  }

  function fmt(v) {
    if (v === null || v === undefined || !Number.isFinite(v)) return '—';
    const a = Math.abs(v);
    if (a !== 0 && (a < 1e-4 || a >= 1e15)) return v.toExponential(3);
    const digits = a >= 100000 ? 0 : a >= 1000 ? 2 : a >= 10 ? 3 : 4;
    return v.toLocaleString('en-US', { maximumFractionDigits: digits });
  }
  const fmtInt = (v) => (Number.isFinite(v) ? Math.round(v).toLocaleString('en-US') : '—');
  const fmtP = (p) => (!Number.isFinite(p) ? '—' : p < 0.0001 ? '< 0.0001' : p.toFixed(4));
  const pct = (x, d = 1) => (Number.isFinite(x) ? (x * 100).toFixed(d) + '%' : '—');
  const plural = (n, word, many) => `${fmtInt(n)} ${n === 1 ? word : (many || word + 's')}`;
  const nextFrame = () => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));
  function debounce(fn, ms) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }

  function mulberry32(seed) {
    let a = seed >>> 0;
    return () => {
      a = (a + 0x6D2B79F5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  // Random k rows (same seed = same rows), kept in file order.
  function seededSample(rows, k, seed) {
    const n = rows.length;
    if (k >= n) return rows;
    const rnd = mulberry32(Math.imul(seed, 2654435761));
    const idx = new Uint32Array(n);
    for (let i = 0; i < n; i++) idx[i] = i;
    for (let i = 0; i < k; i++) {
      const j = i + Math.floor(rnd() * (n - i));
      const t = idx[i]; idx[i] = idx[j]; idx[j] = t;
    }
    return Array.from(idx.subarray(0, k)).sort((a, b) => a - b).map((i) => rows[i]);
  }

  function csvCell(v) {
    if (v === null || v === undefined) return '';
    const s = String(v);
    return /[",\r\n]/.test(s) || /^\s|\s$/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }
  const toCsv = (header, lines) => [header, ...lines].map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
  function safeBase(name) { return (name || 'data').replace(/\.(csv|tsv|txt)$/i, '').replace(/[^a-z0-9_-]+/gi, '_').replace(/^_+|_+$/g, '').slice(0, 60) || 'data'; }
  function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }
  // BOM so Excel opens accented characters correctly.
  const downloadText = (text, filename, type) => downloadBlob(new Blob(['﻿', text], { type: `${type};charset=utf-8` }), filename);

  async function copyText(text, okMsg) {
    try {
      await navigator.clipboard.writeText(text);
      setStatus(okMsg);
    } catch (e) {
      const ta = document.createElement('textarea');
      ta.value = text; ta.setAttribute('readonly', ''); ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select();
      let ok = false;
      try { ok = document.execCommand('copy'); } catch (e2) { ok = false; }
      ta.remove();
      if (ok) setStatus(okMsg); else msgBox('Your browser blocked copying. Use the download buttons instead.');
    }
  }

  // ---------------------------------------------------------------- state
  const state = {
    fileName: '',
    raw: { columns: [], rows: [] },
    profiles: {},
    clean: null,
    out: { rows: [], columns: [], log: [], warnings: [], flagCol: '' },
    outVersion: 0,
    analyze: { x: '', y: '', color: '', group: '' },
    model: null,
    rankCache: { key: '', rows: [] },
    tab: 'analyze',
    analyzeDirty: true,
  };

  function defaultClean() {
    return {
      keep: new Set(state.raw.columns),
      required: new Set(),
      filters: [],
      ranges: [],
      outlier: { col: '', mode: 'none', iqr: 1.5, pct: 1 },
      sample: { mode: 'all', custom: '', seed: 1 },
    };
  }

  // ---------------------------------------------------------------- status + message box
  function setStatus(text, bad = false) {
    const el = $('statusMain');
    el.textContent = text;
    el.classList.toggle('bad', bad);
  }
  let msgReturnFocus = null;
  function msgBox(text, kind = 'error') {
    $('msgText').textContent = text;
    $('msgIcon').textContent = kind === 'error' ? '!' : 'i';
    $('msgIcon').className = 'icon' + (kind === 'error' ? '' : ' info');
    msgReturnFocus = document.activeElement;
    $('msgOverlay').hidden = false;
    $('msgOk').focus();
  }
  function closeMsg() { $('msgOverlay').hidden = true; if (msgReturnFocus && msgReturnFocus.focus) msgReturnFocus.focus(); }

  // ---------------------------------------------------------------- loading
  function detectDelimiter(text) {
    const lines = text.slice(0, 20000).split(/\r?\n/).filter((l) => l.trim()).slice(0, 5);
    const count = (line, ch) => { let n = 0, q = false; for (const c of line) { if (c === '"') q = !q; else if (c === ch && !q) n++; } return n; };
    let best = ',', bestScore = 0;
    for (const ch of [',', ';', '\t', '|']) {
      const counts = lines.map((l) => count(l, ch));
      const score = Math.min(...counts);
      if (score > bestScore) { best = ch; bestScore = score; }
    }
    return best;
  }

  async function openFile(file) {
    if (!file) return;
    if (!/\.(csv|tsv|txt)$/i.test(file.name) && file.type && !/text|csv|excel/i.test(file.type)) {
      msgBox(`"${file.name}" doesn't look like a CSV file. In Excel, use File → Save As → CSV, then open that file here.`);
      return;
    }
    const mb = file.size / 1048576;
    if (mb > 400) { msgBox(`This file is ${mb.toFixed(0)} MB, which is more than a browser tab can comfortably hold. Try splitting it or exporting fewer columns.`); return; }
    setBusy(true, `Reading ${file.name} (${mb.toFixed(1)} MB)…`);
    try {
      const text = await file.text();
      if (!(await loadText(text, file.name))) setStatus(state.fileName ? `Still showing ${state.fileName}.` : 'Ready');
    } catch (e) {
      console.error(e);
      msgBox('Could not read that file. ' + (e && e.message ? e.message : ''));
      setStatus('Could not read the file.', true);
    } finally { setBusy(false); }
  }

  function getSampleCsv() {
    if (window.DATA_ANALYZER_SAMPLE) return Promise.resolve(window.DATA_ANALYZER_SAMPLE);
    return new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = 'samples/utah-housing-sample.js?v=1.0.0';
      s.onload = () => (window.DATA_ANALYZER_SAMPLE ? resolve(window.DATA_ANALYZER_SAMPLE) : reject(new Error('empty sample')));
      s.onerror = () => reject(new Error('sample file missing'));
      document.head.appendChild(s);
    });
  }
  async function loadSample() {
    setBusy(true, 'Loading sample data…');
    try { if (!(await loadText(await getSampleCsv(), SAMPLE_NAME))) setStatus('Ready'); }
    catch (e) { console.error(e); msgBox('The sample data could not be loaded.'); }
    finally { setBusy(false); }
  }

  function setBusy(on, text) {
    document.body.classList.toggle('busy', on);
    ['openBtn', 'sampleBtn'].forEach((id) => { $(id).disabled = on; });
    if (text) setStatus(text);
  }

  async function loadText(text, name) {
    await nextFrame();
    text = String(text).replace(/^﻿/, '');
    if (!text.trim()) { msgBox(`"${name}" is empty.`); return false; }
    if (text.slice(0, 2000).includes('\u0000')) { msgBox(`"${name}" looks like a binary file (for example an .xlsx workbook), not a CSV. In Excel, use File → Save As → CSV.`); return false; }
    const big = text.length > 5e6;
    const delim = detectDelimiter(text);
    if (big) { setStatus('Splitting the file into rows…'); await nextFrame(); }
    const parsed = d3.dsvFormat(delim).parseRows(text);
    text = null;
    if (parsed.length < 2) { msgBox(`"${name}" has column headers but no data rows.`); return false; }

    // Unique, non-blank column names.
    let width = parsed[0].length;
    for (let i = 1; i < parsed.length; i++) if (parsed[i].length > width) width = parsed[i].length;
    const used = new Set();
    const columns = [];
    for (let j = 0; j < width; j++) {
      const base = String(parsed[0][j] ?? '').trim() || `Column ${j + 1}`;
      let nameJ = base, k = 2;
      while (used.has(nameJ.toLowerCase())) nameJ = `${base} (${k++})`;
      used.add(nameJ.toLowerCase());
      columns.push(nameJ);
    }

    const rows = [];
    let ragged = 0;
    for (let i = 1; i < parsed.length; i++) {
      const r = parsed[i];
      let blank = true;
      for (const v of r) if (v && v.trim() !== '') { blank = false; break; }
      if (blank) continue;
      if (r.length !== parsed[0].length) ragged++;
      const o = {};
      for (let j = 0; j < width; j++) o[columns[j]] = r[j] ?? '';
      o[ROW] = i + 1;
      rows.push(o);
    }
    if (!rows.length) { msgBox(`"${name}" has column headers but no data rows.`); return false; }
    if (big) { setStatus(`Checking ${plural(columns.length, 'column')}…`); await nextFrame(); }

    state.fileName = name;
    state.raw = { columns, rows };
    state.profiles = profileColumns(rows, columns);
    state.clean = defaultClean();
    state.analyze = { x: '', y: '', color: '', group: '' };
    state.rankCache = { key: '', rows: [] };
    state.analyzeDirty = true;
    document.body.classList.add('has-data');
    $('colSearch').value = '';
    syncCleanInputs();
    populateCleanSelectors();
    renderCleanControls();
    runClean(false);
    autoPickXY();
    $('fileLabel').textContent = name;
    $('fileLabel').title = name;

    const huge = rows.length > 50000;
    let msg = `Opened ${name}: ${plural(rows.length, 'row')}, ${plural(columns.length, 'column')}.`;
    if (delim !== ',') msg += ` Separated by ${delim === '\t' ? 'tabs' : `"${delim}"`}.`;
    if (ragged) msg += ` ${plural(ragged, 'row')} had a different number of cells than the header.`;
    if (huge) msg += ' Big file: a random sample on the Clean tab will make things faster.';
    setStatus(msg);
    showTab(huge ? 'clean' : 'analyze');
    return true;
  }

  // Figure out what kind of data each column holds.
  function profileColumns(rows, columns) {
    const out = {};
    for (const col of columns) {
      let missing = 0, nonMissing = 0, numeric = 0, dateChecked = 0, dateHits = 0, totalLen = 0, capped = false;
      const uniq = new Set();
      for (const r of rows) {
        const v = r[col];
        if (isMissing(v)) { missing++; continue; }
        nonMissing++;
        const s = String(v).trim();
        totalLen += s.length;
        if (!capped) { uniq.add(s); if (uniq.size > 5000) capped = true; }
        if (Number.isFinite(toNumber(s))) numeric++;
        if (dateChecked < 500) { dateChecked++; if (parseDate(s)) dateHits++; }
      }
      const missingRate = rows.length ? missing / rows.length : 0;
      const numericRatio = nonMissing ? numeric / nonMissing : 0;
      const dateRatio = dateChecked ? dateHits / dateChecked : 0;
      const avgLen = nonMissing ? totalLen / nonMissing : 0;
      const uniqueRatio = nonMissing ? uniq.size / nonMissing : 0;
      const idName = ID_NAME.test(col) || /[a-z](Id|ID)$/.test(col);
      let type;
      if (nonMissing === 0 || missingRate >= 0.75) type = 'sparse';
      else if (idName) type = 'identifier';
      else if (numericRatio >= 0.8) type = 'numeric';
      else if (dateRatio >= 0.8 || (DATE_NAME.test(col) && dateRatio >= 0.55)) type = 'date';
      else if (!capped && uniq.size <= Math.max(20, Math.min(100, nonMissing * 0.25))) type = 'category';
      else if (uniqueRatio > 0.94 && nonMissing > 30 && avgLen < 60) type = 'identifier';
      else type = 'text';
      out[col] = { type, missing, nonMissing, missingRate, uniqueCount: uniq.size, capped, avgLen };
    }
    return out;
  }
  const typeOf = (col) => (state.profiles[col] ? state.profiles[col].type : 'text');

  // ---------------------------------------------------------------- clean: settings
  function suggestedColumns() {
    const P = state.profiles;
    const ok = state.raw.columns.filter((c) => {
      const p = P[c];
      if (!p || p.type === 'identifier' || p.type === 'sparse' || p.missingRate > 0.45) return false;
      if (p.type === 'text' && (p.avgLen > 80 || p.uniqueCount > 250)) return false;
      return true;
    });
    const pick = (t, n) => ok.filter((c) => P[c].type === t).slice(0, n);
    const chosen = new Set([...pick('numeric', 40), ...pick('date', 6), ...pick('category', 15), ...pick('text', 3)]);
    return state.raw.columns.filter((c) => chosen.has(c));
  }
  function suggestedRequired() {
    return state.raw.columns.filter((c) => {
      const p = state.profiles[c];
      return state.clean.keep.has(c) && p && (p.type === 'numeric' || p.type === 'date') && p.missingRate < 0.35 && !/count|flag|code|zip|postal/i.test(c);
    }).slice(0, 5);
  }

  const FILTER_OPS = {
    numeric: [['eq', 'equals'], ['ne', 'does not equal'], ['gt', 'greater than'], ['gte', 'at least'], ['lt', 'less than'], ['lte', 'at most'], ['between', 'between'], ['blank', 'is blank'], ['not_blank', 'is not blank']],
    date: [['d_before', 'before'], ['d_after', 'after'], ['d_between', 'between dates'], ['d_year', 'year is'], ['d_month', 'month is (1-12)'], ['blank', 'is blank'], ['not_blank', 'is not blank']],
    text: [['t_eq', 'equals'], ['t_ne', 'does not equal'], ['contains', 'contains'], ['not_contains', 'does not contain'], ['starts', 'starts with'], ['ends', 'ends with'], ['blank', 'is blank'], ['not_blank', 'is not blank']],
  };
  const opsFor = (col) => { const t = typeOf(col); return t === 'numeric' ? FILTER_OPS.numeric : t === 'date' ? FILTER_OPS.date : FILTER_OPS.text; };
  const opLabel = (op) => { for (const list of Object.values(FILTER_OPS)) for (const [v, l] of list) if (v === op) return l; return op; };
  const NO_VALUE_OPS = new Set(['blank', 'not_blank']);
  const TWO_VALUE_OPS = new Set(['between', 'd_between']);

  function describeFilter(f) {
    if (NO_VALUE_OPS.has(f.op)) return `${f.col} ${opLabel(f.op)}`;
    if (TWO_VALUE_OPS.has(f.op)) return `${f.col} ${opLabel(f.op)} ${f.v1} and ${f.v2}`;
    return `${f.col} ${opLabel(f.op)} "${f.v1}"`;
  }
  function describeRange(r) {
    const lo = Number.isFinite(r.min) ? fmt(r.min) : 'no minimum';
    const hi = Number.isFinite(r.max) ? fmt(r.max) : 'no maximum';
    return `${r.col}: keep ${r.mode === 'inside' ? 'inside' : 'outside'} ${lo} to ${hi}`;
  }

  function buildFilter(f) {
    const op = f.op;
    if (op === 'blank') return (r) => isMissing(r[f.col]);
    if (op === 'not_blank') return (r) => !isMissing(r[f.col]);
    if (['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'between'].includes(op)) {
      const a = toNumber(f.v1), b = toNumber(f.v2), lo = Math.min(a, b), hi = Math.max(a, b);
      return (r) => {
        const n = toNumber(r[f.col]);
        if (!Number.isFinite(n)) return op === 'ne';
        switch (op) {
          case 'eq': return n === a;
          case 'ne': return n !== a;
          case 'gt': return n > a;
          case 'gte': return n >= a;
          case 'lt': return n < a;
          case 'lte': return n <= a;
          default: return n >= lo && n <= hi;
        }
      };
    }
    if (op.startsWith('d_')) {
      const d1 = parseDate(f.v1), d2 = parseDate(f.v2), num = toNumber(f.v1);
      return (r) => {
        const d = parseDate(r[f.col]);
        if (!d) return false;
        switch (op) {
          case 'd_before': return d < d1;
          case 'd_after': return d > d1;
          case 'd_between': { const lo = d1 < d2 ? d1 : d2, hi = d1 < d2 ? d2 : d1; return d >= lo && d <= hi; }
          case 'd_year': return d.getFullYear() === num;
          default: return d.getMonth() + 1 === num;
        }
      };
    }
    const val = String(f.v1).trim().toLowerCase();
    return (r) => {
      const s = isMissing(r[f.col]) ? '' : String(r[f.col]).trim().toLowerCase();
      switch (op) {
        case 't_eq': return s === val;
        case 't_ne': return s !== val;
        case 'contains': return s.includes(val);
        case 'not_contains': return !s.includes(val);
        case 'starts': return s.startsWith(val);
        default: return s.endsWith(val);
      }
    };
  }

  function quantile(sorted, q) {
    const pos = (sorted.length - 1) * q, base = Math.floor(pos), rest = pos - base;
    return sorted[base + 1] !== undefined ? sorted[base] + rest * (sorted[base + 1] - sorted[base]) : sorted[base];
  }
  function outlierBounds(rows, o) {
    const nums = [];
    for (const r of rows) { const n = toNumber(r[o.col]); if (Number.isFinite(n)) nums.push(n); }
    if (nums.length < 4) return null;
    nums.sort((a, b) => a - b);
    if (o.mode.endsWith('iqr')) {
      const q1 = quantile(nums, 0.25), q3 = quantile(nums, 0.75), m = o.iqr > 0 ? o.iqr : 1.5;
      return { lower: q1 - m * (q3 - q1), upper: q3 + m * (q3 - q1), how: `IQR × ${m}` };
    }
    const cut = Math.min(Math.max(o.pct > 0 ? o.pct : 1, 0.1), 49) / 100;
    return { lower: quantile(nums, cut), upper: quantile(nums, 1 - cut), how: `top/bottom ${+(cut * 100).toFixed(2)}%` };
  }

  function sampleSize() {
    const s = state.clean.sample;
    if (s.mode === 'all') return 0;
    const n = s.mode === 'custom' ? Math.floor(toNumber(s.custom)) : Number(s.mode);
    return Number.isFinite(n) && n > 0 ? n : 0;
  }

  // ---------------------------------------------------------------- clean: pipeline
  function runClean(refresh = true) {
    const C = state.clean;
    const log = [], warnings = [];
    let rows = state.raw.rows;
    const step = (name, before, after, detail) => {
      const removed = before - after, share = before ? removed / before : 0;
      log.push({ name, before, after, removed, share, detail });
      if (share >= 0.5) warnings.push({ strong: true, text: `${name} removed ${pct(share)} of the remaining rows. Double-check it before you export.` });
      else if (share >= 0.25) warnings.push({ strong: false, text: `${name} removed ${pct(share)} of the remaining rows.` });
    };

    if (C.filters.length) {
      const tests = C.filters.map(buildFilter);
      const before = rows.length;
      rows = rows.filter((r) => tests.every((t) => t(r)));
      step('Row filters', before, rows.length, C.filters.map(describeFilter).join('; '));
    }
    const req = state.raw.columns.filter((c) => C.required.has(c) && C.keep.has(c));
    if (req.length) {
      const before = rows.length;
      rows = rows.filter((r) => req.every((c) => !isMissing(r[c])));
      step('Required columns', before, rows.length, `No blanks allowed in: ${req.join(', ')}`);
    }
    for (const rr of C.ranges) {
      const before = rows.length;
      rows = rows.filter((r) => {
        const n = toNumber(r[rr.col]);
        if (!Number.isFinite(n)) return false;
        const inside = n >= rr.min && n <= rr.max;
        return rr.mode === 'inside' ? inside : !inside;
      });
      step('Allowed range', before, rows.length, describeRange(rr) + ' (blank or non-number values removed)');
    }

    let columns = state.raw.columns.filter((c) => C.keep.has(c));
    let flagCol = '';
    const o = C.outlier;
    if (o.col && o.mode !== 'none') {
      const b = outlierBounds(rows, o);
      if (!b) warnings.push({ strong: false, text: `Not enough numbers in ${o.col} to find unusual values.` });
      else if (o.mode.startsWith('flag')) {
        flagCol = `${o.col}_unusual`;
        let k = 2;
        while (state.raw.columns.includes(flagCol)) flagCol = `${o.col}_unusual_${k++}`;
        let count = 0;
        rows = rows.map((r) => {
          const copy = { ...r };
          const n = toNumber(r[o.col]);
          if (!Number.isFinite(n)) copy[flagCol] = '';
          else if (n < b.lower || n > b.upper) { copy[flagCol] = 'TRUE'; count++; }
          else copy[flagCol] = 'FALSE';
          return copy;
        });
        columns = [...columns, flagCol];
        state.profiles[flagCol] = { type: 'category', missing: 0, missingRate: 0, uniqueCount: 3, avgLen: 5 };
        step('Flag unusual values', rows.length, rows.length, `${plural(count, 'row')} flagged TRUE in new column ${flagCol} (${o.col} outside ${fmt(b.lower)} to ${fmt(b.upper)}, ${b.how})`);
      } else {
        const before = rows.length;
        rows = rows.filter((r) => { const n = toNumber(r[o.col]); return !Number.isFinite(n) || (n >= b.lower && n <= b.upper); });
        step('Remove unusual values', before, rows.length, `${o.col} outside ${fmt(b.lower)} to ${fmt(b.upper)} (${b.how})`);
      }
    }

    const size = sampleSize();
    if (size && rows.length > size) {
      const before = rows.length;
      rows = seededSample(rows, size, C.sample.seed);
      step('Random sample', before, rows.length, `Kept a random ${fmtInt(size)} rows (sample #${C.sample.seed})`);
    } else if (C.sample.mode === 'custom' && !size) {
      warnings.push({ strong: false, text: 'Type a custom sample size, or pick "All rows".' });
    }

    if (!columns.length) warnings.push({ strong: true, text: 'No columns are selected. Pick at least one in "Columns to keep".' });
    if (!rows.length) warnings.push({ strong: true, text: 'No rows are left. Remove or loosen a filter or rule.' });
    else if (rows.length < 3) warnings.push({ strong: true, text: 'Fewer than 3 rows are left, which is too few to analyze.' });
    if (rows.length > 50000 && !size) warnings.push({ strong: false, text: `${fmtInt(rows.length)} rows is a lot for a browser. A random sample of 10,000 or fewer will feel much faster.` });

    state.out = { rows, columns, log, warnings, flagCol };
    state.outVersion++;
    renderCleanOutput();
    updateStatusRows();
    if (refresh) refreshAnalyze();
  }
  const scheduleClean = debounce(() => runClean(true), 120);

  // ---------------------------------------------------------------- clean: rendering
  function populateCleanSelectors() {
    const cols = state.raw.columns;
    const numeric = cols.filter((c) => typeOf(c) === 'numeric');
    const opts = (list, none) => (none ? `<option value="">${none}</option>` : '') + list.map((c) => `<option value="${esc(c)}">${esc(c)}</option>`).join('');
    $('fCol').innerHTML = opts(cols);
    $('fCol').value = cols.find((c) => typeOf(c) === 'category') || cols[0] || '';
    $('rCol').innerHTML = numeric.length ? opts(numeric) : '<option value="">(no number columns)</option>';
    $('oCol').innerHTML = opts(numeric, '(none)');
    updateFilterOps();
  }
  function updateFilterOps() {
    const col = $('fCol').value;
    $('fOp').innerHTML = opsFor(col).map(([v, l]) => `<option value="${v}">${esc(l)}</option>`).join('');
    updateFilterInputs();
    // Suggest common values for this column.
    const counts = new Map();
    for (const r of state.raw.rows) {
      const v = r[col];
      if (isMissing(v)) continue;
      const s = String(v).trim();
      counts.set(s, (counts.get(s) || 0) + 1);
      if (counts.size > 3000) break;
    }
    const top = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 60);
    $('fValues').innerHTML = top.map(([v]) => `<option value="${esc(v)}"></option>`).join('');
  }
  function updateFilterInputs() {
    const op = $('fOp').value;
    $('fVal').disabled = NO_VALUE_OPS.has(op);
    $('fVal2').disabled = !TWO_VALUE_OPS.has(op);
    $('fVal').placeholder = op.startsWith('d_') && op !== 'd_year' && op !== 'd_month' ? 'YYYY-MM-DD' : op === 'd_year' ? 'e.g. 2026' : op === 'd_month' ? '1-12' : '';
    $('fVal2').placeholder = TWO_VALUE_OPS.has(op) ? (op === 'd_between' ? 'YYYY-MM-DD' : 'second value') : 'for "between"';
  }

  function syncCleanInputs() {
    const C = state.clean;
    $('oCol').value = C.outlier.col;
    $('oMode').value = C.outlier.mode;
    $('oIqr').value = C.outlier.iqr;
    $('oPct').value = C.outlier.pct;
    $('sMode').value = C.sample.mode;
    $('sCustom').value = C.sample.custom;
    updateOutlierInputs();
    $('sCustom').disabled = C.sample.mode !== 'custom';
  }
  function updateOutlierInputs() {
    const mode = $('oMode').value;
    $('oIqr').disabled = !mode.endsWith('iqr');
    $('oPct').disabled = !mode.endsWith('pct');
  }

  function renderCleanControls() { renderColList(); renderReqList(); renderRules(); }

  function renderColList() {
    const q = $('colSearch').value.trim().toLowerCase();
    const cols = state.raw.columns.filter((c) => c.toLowerCase().includes(q));
    $('colList').innerHTML = cols.length ? cols.map((c) => {
      const t = typeOf(c);
      return `<label title="${esc(c)}"><input type="checkbox" data-col="${esc(c)}"${state.clean.keep.has(c) ? ' checked' : ''}><span class="name">${esc(c)}</span><span class="tag${t === 'identifier' || t === 'sparse' ? ' warn' : ''}">${TYPE_LABEL[t]}</span></label>`;
    }).join('') : '<div class="empty">No columns match.</div>';
  }
  function renderReqList() {
    const cols = state.raw.columns.filter((c) => state.clean.keep.has(c));
    $('reqList').innerHTML = cols.length ? cols.map((c) => {
      const p = state.profiles[c];
      const note = p && p.missing ? `${fmtInt(p.missing)} blank` : 'no blanks';
      return `<label title="${esc(c)}"><input type="checkbox" data-req="${esc(c)}"${state.clean.required.has(c) ? ' checked' : ''}><span class="name">${esc(c)}</span><span class="tag">${note}</span></label>`;
    }).join('') : '<div class="empty">Keep at least one column first.</div>';
  }
  function renderRules() {
    const C = state.clean;
    $('fList').innerHTML = C.filters.map((f, i) => `<div class="rule"><span>${esc(describeFilter(f))}</span><button type="button" data-del-filter="${i}" aria-label="Remove filter">✕</button></div>`).join('');
    $('rList').innerHTML = C.ranges.map((r, i) => `<div class="rule"><span>${esc(describeRange(r))}</span><button type="button" data-del-range="${i}" aria-label="Remove range">✕</button></div>`).join('');
  }

  function renderCleanOutput() {
    const { rows, columns, log, warnings } = state.out;
    const total = state.raw.rows.length;
    let blanks = 0;
    for (const r of rows) for (const c of columns) if (isMissing(r[c])) blanks++;
    $('cOrigRows').textContent = fmtInt(total);
    $('cRows').textContent = fmtInt(rows.length);
    $('cCols').textContent = `${fmtInt(columns.length)} of ${fmtInt(state.raw.columns.length)}`;
    $('cMissing').textContent = fmtInt(blanks);
    $('cRemoved').textContent = fmtInt(total - rows.length);

    const w = $('cWarn');
    if (warnings.length) {
      w.hidden = false;
      w.className = 'notice' + (warnings.some((x) => x.strong) ? ' strong' : '');
      w.innerHTML = '<b>Check before you export:</b><ul>' + warnings.map((x) => `<li>${esc(x.text)}</li>`).join('') + '</ul>';
    } else w.hidden = true;
    $('dlClean').disabled = !rows.length || !columns.length;

    // Preview: first 25 rows.
    if (!columns.length || !rows.length) $('cPreview').innerHTML = `<div class="table-note">${columns.length ? 'No rows left.' : 'No columns selected.'}</div>`;
    else {
      const showCols = columns.slice(0, 40);
      const head = '<tr><th class="num">Row</th>' + showCols.map((c) => `<th title="${esc(c)}">${esc(c)}</th>`).join('') + '</tr>';
      const body = rows.slice(0, 25).map((r) => `<tr><td class="num">${r[ROW]}</td>` + showCols.map((c) => `<td class="cut${typeOf(c) === 'numeric' ? ' num' : ''}" title="${esc(r[c])}">${esc(r[c])}</td>`).join('') + '</tr>').join('');
      const notes = [];
      if (rows.length > 25) notes.push(`first 25 of ${fmtInt(rows.length)} rows`);
      if (columns.length > 40) notes.push(`first 40 of ${fmtInt(columns.length)} columns`);
      $('cPreview').innerHTML = `<table><thead>${head}</thead><tbody>${body}</tbody></table>` + (notes.length ? `<div class="table-note">Showing ${notes.join(', ')}. "Row" is the row number in Excel.</div>` : '');
    }

    $('cLog').innerHTML = log.length
      ? `<table><thead><tr><th>Step</th><th class="num">Before</th><th class="num">After</th><th class="num">Removed</th><th>Details</th></tr></thead><tbody>${log.map((s) => `<tr><td>${esc(s.name)}</td><td class="num">${fmtInt(s.before)}</td><td class="num">${fmtInt(s.after)}</td><td class="num">${fmtInt(s.removed)} (${pct(s.share)})</td><td class="wrap">${esc(s.detail)}</td></tr>`).join('')}</tbody></table>`
      : '<div class="table-note">No rows changed yet. Use the settings on the left.</div>';

    const qCols = columns.slice(0, 200);
    const blankBy = Object.fromEntries(qCols.map((c) => [c, 0]));
    for (const r of rows) for (const c of qCols) if (isMissing(r[c])) blankBy[c]++;
    $('cQuality').innerHTML = qCols.length
      ? `<table><thead><tr><th>Column</th><th>Type</th><th class="num">Blank now</th><th class="num">Different values in file</th></tr></thead><tbody>${qCols.map((c) => {
        const p = state.profiles[c] || {};
        return `<tr><td class="cut" title="${esc(c)}">${esc(c)}</td><td>${TYPE_LABEL[p.type] || 'text'}</td><td class="num">${fmtInt(blankBy[c])}</td><td class="num">${p.capped ? '5,000+' : fmtInt(p.uniqueCount)}</td></tr>`;
      }).join('')}</tbody></table>`
      : '<div class="table-note">No columns selected.</div>';
  }

  function cleaningLogText() {
    const C = state.clean, o = state.out;
    const lines = [
      'Data Analyzer cleaning log',
      `File: ${state.fileName}`,
      `Created: ${new Date().toLocaleString('en-US')}`,
      '',
      `Rows in file: ${fmtInt(state.raw.rows.length)}`,
      `Rows after cleaning: ${fmtInt(o.rows.length)}`,
      `Columns kept (${o.columns.length} of ${state.raw.columns.length}): ${o.columns.join(', ') || '(none)'}`,
      '',
      'Steps, in the order they ran:',
    ];
    if (!o.log.length) lines.push('- No rows were changed.');
    for (const s of o.log) lines.push(`- ${s.name}: ${fmtInt(s.before)} -> ${fmtInt(s.after)} rows (removed ${fmtInt(s.removed)}, ${pct(s.share)}). ${s.detail}`);
    if (o.warnings.length) { lines.push('', 'Warnings:'); o.warnings.forEach((w) => lines.push(`- ${w.text}`)); }
    lines.push('', 'Settings:',
      `- Required columns: ${[...C.required].filter((c) => C.keep.has(c)).join(', ') || '(none)'}`,
      `- Filters: ${C.filters.map(describeFilter).join('; ') || '(none)'}`,
      `- Allowed ranges: ${C.ranges.map(describeRange).join('; ') || '(none)'}`,
      `- Unusual values: ${C.outlier.col && C.outlier.mode !== 'none' ? `${C.outlier.mode} on ${C.outlier.col}` : '(none)'}`,
      `- Random sample: ${sampleSize() ? `${fmtInt(sampleSize())} rows, sample #${C.sample.seed}` : 'all rows'}`);
    return lines.join('\r\n') + '\r\n';
  }

  function downloadCleaned() {
    const { rows, columns, warnings } = state.out;
    if (!rows.length || !columns.length) return;
    if (warnings.some((w) => w.strong) && !confirm('Some cleaning steps removed a large share of rows. Download anyway?')) return;
    downloadText(toCsv(columns, rows.map((r) => columns.map((c) => r[c]))), `${safeBase(state.fileName)}_cleaned.csv`, 'text/csv');
    setStatus(`Downloaded ${plural(rows.length, 'row')} and ${plural(columns.length, 'column')}.`);
  }

  // ---------------------------------------------------------------- analyze
  function numericOutColumns() { return state.out.columns.filter((c) => typeOf(c) === 'numeric'); }

  function populateAnalyzeSelectors() {
    const A = state.analyze;
    const numeric = numericOutColumns();
    const others = state.out.columns.filter((c) => typeOf(c) !== 'identifier' && typeOf(c) !== 'sparse');
    if (!numeric.includes(A.y)) A.y = numeric[0] || '';
    if (!numeric.includes(A.x) || (A.x === A.y && numeric.length > 1)) A.x = numeric.find((c) => c !== A.y) || numeric[0] || '';
    if (A.color && !others.includes(A.color)) A.color = '';
    if (A.group && !others.includes(A.group)) A.group = '';
    const opts = (list, none) => (none ? `<option value="">${none}</option>` : '') + list.map((c) => `<option value="${esc(c)}">${esc(c)}</option>`).join('');
    $('ySel').innerHTML = numeric.length ? opts(numeric) : '<option value="">(no number columns)</option>';
    $('xSel').innerHTML = numeric.length ? opts(numeric) : '<option value="">(no number columns)</option>';
    $('colorSel').innerHTML = opts(others, '(none)');
    $('groupSel').innerHTML = opts(others, '(none)');
    $('ySel').value = A.y; $('xSel').value = A.x; $('colorSel').value = A.color; $('groupSel').value = A.group;
  }

  // Pick a sensible starting Y (a value/price-like column) and the X most related to it.
  function autoPickXY() {
    const numeric = numericOutColumns();
    const A = state.analyze;
    if (!numeric.length) return;
    A.y = numeric.find((c) => Y_HINT.test(c)) || numeric[numeric.length - 1];
    const ranked = rankAgainst(A.y);
    A.x = ranked.length ? ranked[0].col : (numeric.find((c) => c !== A.y) || A.y);
  }

  function rankAgainst(y) {
    const key = `${state.outVersion}|${y}`;
    if (state.rankCache.key === key) return state.rankCache.rows;
    const rows = state.out.rows;
    const yv = rows.map((r) => toNumber(r[y]));
    const result = [];
    for (const col of numericOutColumns().slice(0, MAX_RANK_COLUMNS)) {
      if (col === y) continue;
      const xs = [], ys = [];
      for (let i = 0; i < rows.length; i++) {
        const xv = toNumber(rows[i][col]);
        if (Number.isFinite(xv) && Number.isFinite(yv[i])) { xs.push(xv); ys.push(yv[i]); }
      }
      const m = Stats.correlate(xs, ys);
      if (!m.error) result.push({ col, ...m });
    }
    result.sort((a, b) => Math.abs(b.r) - Math.abs(a.r));
    state.rankCache = { key, rows: result };
    return result;
  }

  function refreshAnalyze() {
    state.analyzeDirty = true;
    if (state.tab === 'analyze') runAnalysis();
  }

  function runAnalysis() {
    state.analyzeDirty = false;
    if (!state.raw.rows.length) return;
    populateAnalyzeSelectors();
    const A = state.analyze;
    const rows = state.out.rows;
    const note = $('anNote');
    note.classList.remove('bad');

    const cleaned = state.out.log.length || state.out.columns.length !== state.raw.columns.length;
    let noteText = cleaned
      ? `Using the cleaned data: ${plural(rows.length, 'row')} of ${fmtInt(state.raw.rows.length)}.`
      : `Using all ${plural(rows.length, 'row')}.`;

    let model = null, pairs = [], excluded = 0;
    if (!A.x || !A.y) {
      noteText = 'Data Analyzer needs at least one column of numbers. Check the Columns to keep on the Clean tab.';
      note.classList.add('bad');
    } else {
      for (const r of rows) {
        const x = toNumber(r[A.x]), y = toNumber(r[A.y]);
        if (Number.isFinite(x) && Number.isFinite(y)) pairs.push({ x, y, row: r });
      }
      excluded = rows.length - pairs.length;
      if (excluded) noteText += ` ${plural(excluded, 'row')} skipped because X or Y is blank or not a number.`;
      if (A.x === A.y) { model = { n: pairs.length, error: 'X and Y are the same column. Pick two different columns.' }; }
      else model = Stats.regress(pairs.map((p) => p.x), pairs.map((p) => p.y));
      if (model && !model.error) {
        for (const p of pairs) {
          p.pred = model.predict(p.x);
          p.resid = p.y - p.pred;
          p.z = model.stdResidual(p.x, p.y);
        }
      } else if (model && model.error) { note.classList.add('bad'); }
    }
    note.textContent = noteText;

    const flagged = model && !model.error ? pairs.filter((p) => Math.abs(p.z) >= 2).sort((a, b) => Math.abs(b.z) - Math.abs(a.z)) : [];
    state.model = { x: A.x, y: A.y, pairs, model, excluded, flagged };
    renderVerdict();
    renderStats();
    drawChart();
    renderInvestigate();
    renderRanking();
    renderGroups();
    ['copyBtn', 'pngBtn', 'dlAll'].forEach((id) => { $(id).disabled = !(model && !model.error); });
    $('dlFlagged').disabled = !flagged.length;
    $('swapBtn').disabled = !A.x || !A.y || A.x === A.y;
  }

  function verdictParts() {
    const M = state.model, m = M.model;
    const ar = Math.abs(m.r);
    const strength = ar < 0.1 ? 'Almost no' : ar < 0.3 ? 'A weak' : ar < 0.5 ? 'A moderate' : ar < 0.7 ? 'A fairly strong' : 'A strong';
    const dir = ar < 0.1 ? '' : m.r > 0 ? ' positive' : ' negative';
    const sig = m.p < 0.05;
    return {
      headline: `${strength}${dir} relationship.`,
      chance: sig ? `Unlikely to be chance (p ${m.p < 0.0001 ? '< 0.0001' : '= ' + m.p.toFixed(4)}).` : `Could easily be chance (p = ${m.p.toFixed(4)}).`,
      slope: `When ${M.x} goes up by 1, ${M.y} goes ${m.slope >= 0 ? 'up' : 'down'} by about ${fmt(Math.abs(m.slope))} on average.`,
      r2: `${M.x} accounts for about ${pct(m.r2, 0)} of the ups and downs in ${M.y}.`,
    };
  }

  function renderVerdict() {
    const M = state.model, box = $('verdict');
    if (!M || !M.model) { box.innerHTML = '<p>Pick an X and a Y column.</p>'; return; }
    const m = M.model;
    if (m.error) { box.innerHTML = `<p>${esc(m.error)}</p>`; return; }
    const v = verdictParts();
    const items = [
      `When <b>${esc(M.x)}</b> goes up by 1, <b>${esc(M.y)}</b> goes ${m.slope >= 0 ? 'up' : 'down'} by about <b>${esc(fmt(Math.abs(m.slope)))}</b> on average.`,
      `<b>${esc(M.x)}</b> accounts for about <b>${pct(m.r2, 0)}</b> of the ups and downs in <b>${esc(M.y)}</b>.`,
      `Based on ${plural(m.n, 'row')}.`,
    ];
    if (M.flagged.length) items.push(`${plural(M.flagged.length, 'row')} ${M.flagged.length === 1 ? "doesn't" : "don't"} fit the pattern well. See <i>Rows to investigate</i>.`);
    if (m.n < 30) items.push('Small sample, so treat this as a rough guide.');
    box.innerHTML = `<p class="headline"><b>${esc(v.headline)}</b> ${esc(v.chance)}</p><ul>${items.map((i) => `<li>${i}</li>`).join('')}</ul><p class="fine">A pattern isn't proof that one causes the other.</p>`;
  }

  function equationText(m, x, y) {
    return `${y} = ${fmt(m.slope)} × ${x} ${m.intercept < 0 ? '−' : '+'} ${fmt(Math.abs(m.intercept))}`;
  }

  function renderStats() {
    const M = state.model, box = $('statsBox');
    if (!M || !M.model || M.model.error) { box.innerHTML = '<div class="hint">No results yet.</div>'; return; }
    const m = M.model;
    const row = (label, help, value) => `<tr><td><abbr title="${esc(help)}">${label}</abbr></td><td class="num">${value}</td></tr>`;
    box.innerHTML = `<div class="equation">${esc(equationText(m, M.x, M.y))}</div><table class="kv"><tbody>
      ${row('Rows used', 'Rows with a number in both X and Y', fmtInt(m.n))}
      ${row('Slope', 'Average change in Y when X goes up by 1', fmt(m.slope))}
      ${row('Std. error of slope', 'How precisely the slope is pinned down', fmt(m.seSlope))}
      ${row('t-stat', 'Slope divided by its standard error', fmt(m.t))}
      ${row('p-value', 'Chance of a slope this far from zero if there were no real relationship', fmtP(m.p))}
      ${row('Intercept', 'Where the line crosses X = 0', fmt(m.intercept))}
      ${row('R²', 'Share of the variation in Y explained by the line', fmt(m.r2))}
      ${row('Correlation (r)', 'Strength and direction, from -1 to +1', fmt(m.r))}
      ${row('Std. error of estimate', 'Typical distance between a dot and the line, in Y units', fmt(m.s))}
    </tbody></table>`;
  }

  function renderInvestigate() {
    const M = state.model, note = $('invNote'), box = $('invTable');
    if (!M || !M.model || M.model.error) { note.textContent = 'Results appear once there is a trend line.'; box.innerHTML = ''; return; }
    const { flagged } = M;
    const strong = flagged.filter((p) => Math.abs(p.z) >= 3).length;
    note.textContent = flagged.length
      ? `${plural(flagged.length, 'row')} ${flagged.length === 1 ? 'sits' : 'sit'} more than 2 standard errors from the line${strong ? `, ${fmtInt(strong)} of them more than 3` : ''}. These are the rows to look at first. Hover a row to find it on the chart.`
      : 'No rows sit more than 2 standard errors from the line.';
    if (!flagged.length) { box.innerHTML = ''; return; }
    const show = flagged.slice(0, 100);
    box.innerHTML = `<table><thead><tr><th class="num">Row</th><th class="num">${esc(M.x)}</th><th class="num">${esc(M.y)}</th><th class="num">Expected</th><th class="num">Difference</th><th class="num">Std. resid.</th></tr></thead><tbody>${show.map((p) => `<tr class="click" data-row="${p.row[ROW]}" title="Highlight on the chart"><td class="num">${p.row[ROW]}</td><td class="num">${fmt(p.x)}</td><td class="num">${fmt(p.y)}</td><td class="num">${fmt(p.pred)}</td><td class="num">${fmt(p.resid)}</td><td class="num">${p.z.toFixed(2)}</td></tr>`).join('')}</tbody></table>${flagged.length > 100 ? `<div class="table-note">Showing the 100 most unusual. Download to see all ${fmtInt(flagged.length)}.</div>` : ''}`;
  }

  function renderRanking() {
    const A = state.analyze, box = $('rankTable');
    if (!A.y) { box.innerHTML = ''; return; }
    const list = rankAgainst(A.y);
    if (!list.length) { box.innerHTML = '<div class="table-note">No other number columns to compare.</div>'; return; }
    box.innerHTML = `<table><thead><tr><th>Column vs ${esc(A.y)}</th><th class="num">r</th><th class="num">R²</th><th class="num">p-value</th><th class="num">Rows</th></tr></thead><tbody>${list.slice(0, 40).map((r) => `<tr class="click${r.col === A.x ? ' current' : ''}" data-x="${esc(r.col)}" title="Plot ${esc(r.col)} as X"><td class="cut">${esc(r.col)}</td><td class="num">${r.r.toFixed(3)}</td><td class="num">${r.r2.toFixed(3)}</td><td class="num">${fmtP(r.p)}</td><td class="num">${fmtInt(r.n)}</td></tr>`).join('')}</tbody></table>`;
  }

  function renderGroups() {
    const A = state.analyze, box = $('groupTable'), note = $('groupNote');
    if (!A.group) { note.hidden = false; box.innerHTML = ''; return; }
    note.hidden = true;
    const groups = new Map();
    for (const r of state.out.rows) {
      const g = isMissing(r[A.group]) ? '(blank)' : String(r[A.group]).trim();
      let s = groups.get(g);
      if (!s) { s = { rows: 0, xs: [], ys: [] }; groups.set(g, s); }
      s.rows++;
      const x = toNumber(r[A.x]), y = toNumber(r[A.y]);
      if (Number.isFinite(x) && Number.isFinite(y)) { s.xs.push(x); s.ys.push(y); }
    }
    const mean = (a) => (a.length ? a.reduce((t, v) => t + v, 0) / a.length : NaN);
    const list = [...groups.entries()].sort((a, b) => b[1].rows - a[1].rows);
    const shown = list.slice(0, 50);
    const body = shown.map(([g, s]) => {
      const m = s.xs.length >= 3 ? Stats.correlate(s.xs, s.ys) : { error: true };
      return `<tr><td class="cut" title="${esc(g)}">${esc(g)}</td><td class="num">${fmtInt(s.rows)}</td><td class="num">${fmt(mean(s.ys))}</td><td class="num">${fmt(mean(s.xs))}</td><td class="num">${m.error ? '—' : m.r.toFixed(3)}</td></tr>`;
    }).join('');
    const allX = [], allY = [];
    for (const [, s] of list) { allX.push(...s.xs); allY.push(...s.ys); }
    const total = `<tr class="total"><td>All rows</td><td class="num">${fmtInt(state.out.rows.length)}</td><td class="num">${fmt(mean(allY))}</td><td class="num">${fmt(mean(allX))}</td><td class="num">${state.model.model && !state.model.model.error ? state.model.model.r.toFixed(3) : '—'}</td></tr>`;
    box.innerHTML = `<table><thead><tr><th>${esc(A.group)}</th><th class="num">Rows</th><th class="num">Avg ${esc(A.y)}</th><th class="num">Avg ${esc(A.x)}</th><th class="num">r</th></tr></thead><tbody>${body}${total}</tbody></table>${list.length > 50 ? `<div class="table-note">Showing the 50 largest of ${fmtInt(list.length)} groups.</div>` : ''}`;
  }

  // ---------------------------------------------------------------- chart
  const PALETTE = ['#1f5fbf', '#e07b00', '#2a9d3a', '#c0392b', '#7d4cc2', '#8c564b', '#d6339c', '#008080', '#9a9a00', '#00a2c7', '#5c5c5c'];

  function buildColor(pairs, col) {
    if (!col) return null;
    if (typeOf(col) === 'numeric') {
      const nums = pairs.map((p) => toNumber(p.row[col])).filter(Number.isFinite);
      const uniq = new Set(nums);
      if (uniq.size > 12) {
        const ext = d3.extent(nums);
        const scale = d3.scaleSequential(d3.interpolateViridis).domain(ext[0] === ext[1] ? [ext[0] - 1, ext[1] + 1] : ext);
        return { kind: 'continuous', col, domain: ext, colorOf: (p) => { const n = toNumber(p.row[col]); return Number.isFinite(n) ? scale(n) : '#b0b0b0'; }, scale };
      }
    }
    const counts = new Map();
    for (const p of pairs) {
      const v = isMissing(p.row[col]) ? '(blank)' : String(p.row[col]).trim();
      counts.set(v, (counts.get(v) || 0) + 1);
    }
    let cats = [...counts.entries()].sort((a, b) => b[1] - a[1]).map((e) => e[0]);
    const nonBlank = cats.filter((c) => c !== '(blank)');
    const top = nonBlank.slice(0, nonBlank.length > PALETTE.length ? PALETTE.length - 1 : PALETTE.length);
    const map = new Map(top.map((c, i) => [c, PALETTE[i]]));
    const hasOther = nonBlank.length > top.length;
    const items = top.map((c) => ({ label: c, color: map.get(c) }));
    if (hasOther) items.push({ label: `Other (${nonBlank.length - top.length})`, color: '#d0d0d0' });
    if (counts.has('(blank)')) items.push({ label: '(blank)', color: '#ffffff', stroke: '#808080' });
    return {
      kind: 'category', col, items,
      colorOf: (p) => { const v = isMissing(p.row[col]) ? '(blank)' : String(p.row[col]).trim(); return v === '(blank)' ? '#ffffff' : map.get(v) || '#d0d0d0'; },
    };
  }

  function axisFormat(domain) {
    const a = Math.max(Math.abs(domain[0]), Math.abs(domain[1]));
    if (a >= 10000) { const f = d3.format('~s'); return (v) => f(v).replace('G', 'B'); }
    const f = d3.format('~g');
    return (v) => f(v);
  }
  const clip = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

  function drawChart() {
    const svg = d3.select('#chart');
    svg.selectAll('*').remove();
    hideTip();
    const box = $('chartBox');
    const W = Math.max(260, Math.floor(box.clientWidth - 4));
    const M = state.model;
    const A = state.analyze;
    const opt = { line: $('optLine').checked, band: Number($('optBand').value), labels: $('optLabels').checked, view: $('optView').value };
    if (!M || !M.pairs.length) {
      svg.attr('width', W).attr('height', 240).attr('viewBox', `0 0 ${W} 240`);
      svg.append('rect').attr('width', W).attr('height', 240).attr('fill', '#fff');
      svg.append('text').attr('x', W / 2).attr('y', 120).attr('text-anchor', 'middle').attr('fill', '#555').text('No points to plot.');
      return;
    }
    const { pairs, model } = M;
    const ok = model && !model.error;
    const resid = opt.view === 'resid' && ok;
    const yOf = (p) => (resid ? p.resid : p.y);
    const color = buildColor(pairs, A.color);

    // Legend layout (drawn inside the SVG so "Save chart" includes it).
    const legend = { height: 0, items: [] };
    if (color) {
      if (color.kind === 'continuous') legend.height = 44;
      else {
        let lx = 0, ly = 0;
        const rowH = 18, maxW = W - 24;
        for (const it of color.items) {
          const label = clip(it.label, 28);
          const w = 22 + label.length * 6.6;
          if (lx + w > maxW && lx > 0) { lx = 0; ly += rowH; }
          legend.items.push({ ...it, label, x: lx, y: ly });
          lx += w + 10;
        }
        legend.height = ly + rowH + 26;
      }
    }

    const plotH = Math.round(Math.min(520, Math.max(250, W * 0.58)));
    const H = plotH + legend.height;
    svg.attr('width', W).attr('height', H).attr('viewBox', `0 0 ${W} ${H}`)
      .attr('aria-label', `${resid ? 'Leftovers' : 'Scatter plot'} of ${M.y} against ${M.x}`);
    svg.append('rect').attr('width', W).attr('height', H).attr('fill', '#fff');

    const xExt = d3.extent(pairs, (p) => p.x);
    let yExt = d3.extent(pairs, yOf);
    if (resid) { const a = Math.max(Math.abs(yExt[0]), Math.abs(yExt[1]), 2.2 * model.s); yExt = [-a, a]; }
    const pad = (e) => { const d = e[1] - e[0]; const p = d ? d * 0.05 : Math.abs(e[0]) * 0.1 || 1; return [e[0] - p, e[1] + p]; };
    const xScale = d3.scaleLinear().domain(pad(xExt)).nice();
    const yScale = d3.scaleLinear().domain(pad(yExt)).nice();
    const xf = axisFormat(xScale.domain()), yf = axisFormat(yScale.domain());
    const yTicks = yScale.ticks(plotH > 330 ? 7 : 5);
    const maxLabel = Math.max(...yTicks.map((t) => yf(t).length));
    const mg = { top: 30, right: 16, bottom: 46, left: Math.min(90, 30 + maxLabel * 7) };
    const w = W - mg.left - mg.right, h = plotH - mg.top - mg.bottom;
    xScale.range([0, w]);
    yScale.range([h, 0]);

    const g = svg.append('g').attr('transform', `translate(${mg.left},${mg.top})`);
    const clipId = 'plotClip';
    svg.append('defs').append('clipPath').attr('id', clipId).append('rect').attr('width', w).attr('height', h);

    // Grid + axes
    g.append('g').selectAll('line').data(yTicks).join('line')
      .attr('x1', 0).attr('x2', w).attr('y1', (d) => yScale(d)).attr('y2', (d) => yScale(d)).attr('stroke', '#e6e6e6');
    g.append('g').attr('transform', `translate(0,${h})`).call(d3.axisBottom(xScale).ticks(Math.max(3, Math.floor(w / 90))).tickFormat(xf).tickSizeOuter(0));
    g.append('g').call(d3.axisLeft(yScale).tickValues(yTicks).tickFormat(yf).tickSizeOuter(0));
    g.selectAll('.tick text').attr('font-size', 11).attr('fill', '#222');
    g.selectAll('.domain, .tick line').attr('stroke', '#808080');

    svg.append('text').attr('x', mg.left + w / 2).attr('y', plotH - 8).attr('text-anchor', 'middle').attr('font-size', 12).attr('font-weight', 'bold').text(clip(M.x, 60));
    svg.append('text').attr('transform', `translate(13,${mg.top + h / 2}) rotate(-90)`).attr('text-anchor', 'middle').attr('font-size', 12).attr('font-weight', 'bold')
      .text(clip(resid ? `Leftover ${M.y}` : M.y, Math.max(12, Math.floor(h / 7))));

    const plot = g.append('g').attr('clip-path', `url(#${clipId})`);

    // Confidence band + trend line (scatter view)
    if (ok && !resid && opt.line) {
      if (opt.band > 0 && model.df > 0) {
        const tc = Stats.tCritical(opt.band, model.df);
        const [d0, d1] = xScale.domain();
        const pts = d3.range(0, 81).map((i) => { const x = d0 + (d1 - d0) * i / 80; const yh = model.predict(x), hw = model.bandHalfWidth(x, tc); return { x, lo: yh - hw, hi: yh + hw }; });
        plot.append('path').datum(pts).attr('fill', '#000080').attr('fill-opacity', 0.13)
          .attr('d', d3.area().x((d) => xScale(d.x)).y0((d) => yScale(d.lo)).y1((d) => yScale(d.hi)));
      }
      const [d0, d1] = xScale.domain();
      plot.append('line').attr('x1', xScale(d0)).attr('y1', yScale(model.predict(d0))).attr('x2', xScale(d1)).attr('y2', yScale(model.predict(d1)))
        .attr('stroke', '#000080').attr('stroke-width', 2);
    }
    if (resid) {
      plot.append('line').attr('x1', 0).attr('x2', w).attr('y1', yScale(0)).attr('y2', yScale(0)).attr('stroke', '#000080').attr('stroke-width', 2);
      for (const k of [-2, 2]) plot.append('line').attr('x1', 0).attr('x2', w).attr('y1', yScale(k * model.s)).attr('y2', yScale(k * model.s)).attr('stroke', '#a00000').attr('stroke-dasharray', '5 4');
    }

    // Points (at most MAX_POINTS; unusual rows are always drawn)
    let shown = pairs;
    if (pairs.length > MAX_POINTS) {
      const must = new Set(M.flagged.slice(0, 500));
      const rest = pairs.filter((p) => !must.has(p));
      shown = [...must, ...seededSample(rest, Math.max(0, MAX_POINTS - must.size), 7)];
    }
    const r = shown.length > 2000 ? 2.6 : shown.length > 500 ? 3.4 : 4.2;
    plot.append('g').selectAll('circle').data(shown).join('circle')
      .attr('cx', (p) => xScale(p.x)).attr('cy', (p) => yScale(yOf(p))).attr('r', r)
      .attr('fill', (p) => (color ? color.colorOf(p) : '#008080'))
      .attr('fill-opacity', shown.length > 2000 ? 0.65 : 0.85)
      .attr('stroke', (p) => (color && color.colorOf(p) === '#ffffff' ? '#808080' : '#fff')).attr('stroke-width', 0.6)
      .on('mouseenter', (ev, p) => showTip(ev, p))
      .on('mousemove', (ev) => moveTip(ev))
      .on('mouseleave', hideTip);

    // Label the most unusual rows
    if (ok && opt.labels && M.flagged.length) {
      const top = M.flagged.slice(0, 5);
      const lab = plot.append('g');
      lab.selectAll('circle').data(top).join('circle').attr('cx', (p) => xScale(p.x)).attr('cy', (p) => yScale(yOf(p))).attr('r', r + 3.5)
        .attr('fill', 'none').attr('stroke', '#a00000').attr('stroke-width', 1.5);
      const boxes = [];
      for (const p of top) {
        const text = `row ${p.row[ROW]}`;
        const tw = text.length * 6.6, px = xScale(p.x), py = yScale(yOf(p));
        const tries = [[px + r + 5, py - r - 3, 'start'], [px - r - 5, py - r - 3, 'end'], [px + r + 5, py + r + 13, 'start'], [px - r - 5, py + r + 13, 'end']];
        for (const [tx, ty, anchor] of tries) {
          const x0 = anchor === 'start' ? tx : tx - tw, b = { x0, x1: x0 + tw, y0: ty - 11, y1: ty + 2 };
          if (b.x0 < 0 || b.x1 > w || b.y0 < 0 || b.y1 > h) continue;
          if (boxes.some((o) => b.x0 < o.x1 && b.x1 > o.x0 && b.y0 < o.y1 && b.y1 > o.y0)) continue;
          boxes.push(b);
          lab.append('text').attr('x', tx).attr('y', ty).attr('text-anchor', anchor)
            .attr('font-size', 11).attr('font-weight', 'bold').attr('fill', '#a00000').attr('paint-order', 'stroke').attr('stroke', '#fff').attr('stroke-width', 3)
            .text(text);
          break;
        }
      }
    }
    plot.append('circle').attr('id', 'hl').attr('r', r + 5).attr('fill', 'none').attr('stroke', '#000').attr('stroke-width', 2).attr('visibility', 'hidden');
    chartScales = { xScale, yScale, yOf, mg };

    // Caption
    let caption = '';
    if (resid) caption = 'Leftovers: actual minus expected. Dashed lines = ±2 std. errors.';
    else if (ok && opt.line) caption = equationText(model, M.x, M.y);
    if (pairs.length > shown.length) caption += `${caption ? '   ·   ' : ''}Showing ${fmtInt(shown.length)} of ${fmtInt(pairs.length)} dots (math uses all)`;
    svg.append('text').attr('x', mg.left).attr('y', 18).attr('font-size', 12).attr('font-weight', 'bold').attr('fill', '#000080').text(clip(caption, Math.floor(W / 6.5)));

    // Legend
    if (color) {
      const lg = svg.append('g').attr('transform', `translate(12,${plotH + 4})`);
      lg.append('text').attr('y', 10).attr('font-size', 11).attr('font-weight', 'bold').text(`Color: ${clip(color.col, 50)}`);
      if (color.kind === 'continuous') {
        const gid = 'legendGrad';
        const grad = svg.select('defs').append('linearGradient').attr('id', gid);
        d3.range(0, 11).forEach((i) => grad.append('stop').attr('offset', `${i * 10}%`).attr('stop-color', color.scale(color.domain[0] + (color.domain[1] - color.domain[0]) * i / 10)));
        lg.append('rect').attr('y', 16).attr('width', 200).attr('height', 12).attr('fill', `url(#${gid})`).attr('stroke', '#808080');
        lg.append('text').attr('y', 40).attr('font-size', 11).text(fmt(color.domain[0]));
        lg.append('text').attr('x', 200).attr('y', 40).attr('text-anchor', 'end').attr('font-size', 11).text(fmt(color.domain[1]));
      } else {
        const items = lg.append('g').attr('transform', 'translate(0,20)').selectAll('g').data(legend.items).join('g').attr('transform', (d) => `translate(${d.x},${d.y})`);
        items.append('circle').attr('cx', 6).attr('cy', 6).attr('r', 5).attr('fill', (d) => d.color).attr('stroke', (d) => d.stroke || '#fff');
        items.append('text').attr('x', 16).attr('y', 10).attr('font-size', 11).text((d) => d.label);
      }
    }
  }
  let chartScales = null;

  function highlightRow(rowNum) {
    const hl = d3.select('#hl');
    if (!chartScales || !state.model) return;
    const p = rowNum ? state.model.pairs.find((q) => q.row[ROW] === rowNum) : null;
    if (!p) { hl.attr('visibility', 'hidden'); return; }
    hl.attr('cx', chartScales.xScale(p.x)).attr('cy', chartScales.yScale(chartScales.yOf(p))).attr('visibility', 'visible');
  }

  function showTip(ev, p) {
    const M = state.model, tip = $('tip');
    const lines = [[`Row ${p.row[ROW]}`, true], [`${M.y}: ${fmt(p.y)}`], [`${M.x}: ${fmt(p.x)}`]];
    if (state.analyze.color) lines.push([`${state.analyze.color}: ${isMissing(p.row[state.analyze.color]) ? '(blank)' : p.row[state.analyze.color]}`]);
    if (Number.isFinite(p.pred)) { lines.push([`Expected ${M.y}: ${fmt(p.pred)}`]); lines.push([`Std. residual: ${p.z.toFixed(2)}`]); }
    tip.replaceChildren(...lines.map(([t, bold]) => { const d = document.createElement('div'); d.textContent = t; if (bold) d.style.fontWeight = 'bold'; return d; }));
    tip.hidden = false;
    moveTip(ev);
  }
  function moveTip(ev) {
    const tip = $('tip'), box = $('chartBox');
    const b = box.getBoundingClientRect();
    let x = ev.clientX - b.left + 14, y = ev.clientY - b.top + 12;
    if (x + tip.offsetWidth > b.width - 4) x = ev.clientX - b.left - tip.offsetWidth - 10;
    if (y + tip.offsetHeight > b.height - 4) y = ev.clientY - b.top - tip.offsetHeight - 10;
    tip.style.left = Math.max(2, x) + 'px';
    tip.style.top = Math.max(2, y) + 'px';
  }
  function hideTip() { $('tip').hidden = true; }

  async function saveChartPng() {
    const svgEl = $('chart');
    const w = +svgEl.getAttribute('width'), h = +svgEl.getAttribute('height');
    const clone = svgEl.cloneNode(true);
    clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
    clone.setAttribute('font-family', 'Tahoma, Verdana, Arial, sans-serif');
    const hl = clone.querySelector('#hl');
    if (hl) hl.remove();
    const data = new XMLSerializer().serializeToString(clone);
    const img = new Image();
    img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(data);
    try {
      await img.decode();
      const canvas = document.createElement('canvas');
      canvas.width = w * 2; canvas.height = h * 2;
      const ctx = canvas.getContext('2d');
      ctx.scale(2, 2);
      ctx.drawImage(img, 0, 0, w, h);
      canvas.toBlob((blob) => {
        if (!blob) { msgBox('The chart could not be saved in this browser.'); return; }
        downloadBlob(blob, `${safeBase(state.model.y)}_vs_${safeBase(state.model.x)}.png`);
        setStatus('Chart saved as a PNG picture.');
      }, 'image/png');
    } catch (e) { console.error(e); msgBox('The chart could not be saved in this browser.'); }
  }

  function resultsText() {
    const M = state.model, m = M.model, v = verdictParts();
    const lines = [
      `Data Analyzer results (${state.fileName})`,
      `Y: ${M.y}`, `X: ${M.x}`,
      `Rows used: ${fmtInt(m.n)}${M.excluded ? ` (${fmtInt(M.excluded)} skipped: blank or not a number)` : ''}`,
      '',
      `${v.headline} ${v.chance}`, v.slope, v.r2,
      '',
      `Equation: ${equationText(m, M.x, M.y)}`,
      `Slope: ${m.slope}`, `Std. error of slope: ${m.seSlope}`, `t-stat: ${m.t}`, `p-value: ${m.p}`,
      `Intercept: ${m.intercept}`, `R squared: ${m.r2}`, `Correlation (r): ${m.r}`, `Std. error of estimate: ${m.s}`,
      `Rows more than 2 std. errors from the line: ${fmtInt(M.flagged.length)}`,
    ];
    if (state.out.log.length) { lines.push('', 'Cleaning applied:'); state.out.log.forEach((s) => lines.push(`- ${s.name}: ${s.detail}`)); }
    return lines.join('\n');
  }

  function downloadPredictions(onlyFlagged) {
    const M = state.model;
    if (!M || !M.model || M.model.error) return;
    const cols = state.out.columns;
    const list = onlyFlagged ? M.flagged : M.pairs;
    const header = ['excel_row', ...cols, `expected_${M.y}`, 'difference', 'std_residual'];
    const lines = list.map((p) => [p.row[ROW], ...cols.map((c) => p.row[c]), +p.pred.toPrecision(10), +p.resid.toPrecision(10), p.z.toFixed(3)]);
    const name = `${safeBase(M.y)}_vs_${safeBase(M.x)}_${onlyFlagged ? 'rows_to_investigate' : 'predictions'}.csv`;
    downloadText(toCsv(header, lines), name, 'text/csv');
    setStatus(`Downloaded ${plural(list.length, 'row')}.`);
  }

  function updateStatusRows() {
    const el = $('statusRows');
    el.hidden = !state.raw.rows.length;
    el.textContent = `${fmtInt(state.out.rows.length)} of ${fmtInt(state.raw.rows.length)} rows · ${fmtInt(state.out.columns.length)} columns`;
  }

  // ---------------------------------------------------------------- tabs
  function showTab(name) {
    state.tab = name;
    document.querySelectorAll('[role="tab"]').forEach((t) => {
      const on = t.dataset.tab === name;
      t.setAttribute('aria-selected', on);
      t.tabIndex = on ? 0 : -1;
    });
    ['clean', 'analyze', 'about'].forEach((n) => { $(`panel-${n}`).hidden = n !== name; });
    if (name === 'analyze' && state.raw.rows.length) {
      if (state.analyzeDirty) runAnalysis(); else drawChart();
    }
  }

  // ---------------------------------------------------------------- events
  function wire() {
    $('openBtn').addEventListener('click', () => $('fileInput').click());
    $('fileInput').addEventListener('change', (e) => { openFile(e.target.files[0]); e.target.value = ''; });
    $('sampleBtn').addEventListener('click', loadSample);
    document.addEventListener('click', (e) => {
      const b = e.target.closest('[data-action]');
      if (!b) return;
      const a = b.dataset.action;
      if (a === 'open') $('fileInput').click();
      else if (a === 'sample') loadSample();
      else showTab(a);
    });
    $('msgOk').addEventListener('click', closeMsg);
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('msgOverlay').hidden) closeMsg(); });

    // Tabs (click + arrow keys)
    const tabs = [...document.querySelectorAll('[role="tab"]')];
    tabs.forEach((t, i) => {
      t.addEventListener('click', () => showTab(t.dataset.tab));
      t.addEventListener('keydown', (e) => {
        if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
        const next = tabs[(i + (e.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length];
        next.focus(); showTab(next.dataset.tab);
      });
    });

    // Drag and drop
    let dragDepth = 0;
    const hasFiles = (e) => e.dataTransfer && [...e.dataTransfer.types].includes('Files');
    window.addEventListener('dragenter', (e) => { if (!hasFiles(e)) return; e.preventDefault(); dragDepth++; $('dropOverlay').hidden = false; });
    window.addEventListener('dragover', (e) => { if (hasFiles(e)) e.preventDefault(); });
    window.addEventListener('dragleave', () => { dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) $('dropOverlay').hidden = true; });
    window.addEventListener('drop', (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault(); dragDepth = 0; $('dropOverlay').hidden = true;
      openFile(e.dataTransfer.files[0]);
    });

    // ---- Clean
    const C = () => state.clean;
    $('colSearch').addEventListener('input', renderColList);
    $('colList').addEventListener('change', (e) => {
      const col = e.target.dataset.col;
      if (col === undefined) return;
      if (e.target.checked) C().keep.add(col); else C().keep.delete(col);
      renderReqList(); scheduleClean();
    });
    const setKeep = (list) => { C().keep = new Set(list); renderCleanControls(); scheduleClean(); };
    $('colAll').addEventListener('click', () => setKeep(state.raw.columns));
    $('colNone').addEventListener('click', () => setKeep([]));
    $('colSmart').addEventListener('click', () => setKeep(suggestedColumns()));
    $('colNumeric').addEventListener('click', () => setKeep(state.raw.columns.filter((c) => typeOf(c) === 'numeric')));
    $('reqList').addEventListener('change', (e) => {
      const col = e.target.dataset.req;
      if (col === undefined) return;
      if (e.target.checked) C().required.add(col); else C().required.delete(col);
      scheduleClean();
    });
    $('reqSuggest').addEventListener('click', () => { C().required = new Set(suggestedRequired()); renderReqList(); scheduleClean(); });
    $('reqClear').addEventListener('click', () => { C().required = new Set(); renderReqList(); scheduleClean(); });

    $('fCol').addEventListener('change', updateFilterOps);
    $('fOp').addEventListener('change', updateFilterInputs);
    $('fAdd').addEventListener('click', () => {
      const f = { col: $('fCol').value, op: $('fOp').value, v1: $('fVal').value.trim(), v2: $('fVal2').value.trim() };
      if (!f.col) return;
      const isNum = ['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'between'].includes(f.op);
      if (!NO_VALUE_OPS.has(f.op) && !f.v1) { msgBox('Type a value for the filter.', 'info'); $('fVal').focus(); return; }
      if (TWO_VALUE_OPS.has(f.op) && !f.v2) { msgBox('"Between" needs a second value in the "And" box.', 'info'); $('fVal2').focus(); return; }
      if (isNum && (!Number.isFinite(toNumber(f.v1)) || (f.op === 'between' && !Number.isFinite(toNumber(f.v2))))) { msgBox('This rule needs a number, like 250000.', 'info'); return; }
      if (['d_before', 'd_after', 'd_between'].includes(f.op) && (!parseDate(f.v1) || (f.op === 'd_between' && !parseDate(f.v2)))) { msgBox('Type dates as YYYY-MM-DD, for example 2026-01-31.', 'info'); return; }
      if (f.op === 'd_year' && !/^\d{4}$/.test(f.v1)) { msgBox('Type a 4-digit year, like 2026.', 'info'); return; }
      if (f.op === 'd_month' && !(toNumber(f.v1) >= 1 && toNumber(f.v1) <= 12)) { msgBox('Type a month number from 1 to 12.', 'info'); return; }
      C().filters.push(f);
      $('fVal').value = ''; $('fVal2').value = '';
      renderRules(); runClean();
    });
    $('fList').addEventListener('click', (e) => { const i = e.target.dataset.delFilter; if (i === undefined) return; C().filters.splice(+i, 1); renderRules(); runClean(); });

    $('rAdd').addEventListener('click', () => {
      const col = $('rCol').value;
      if (!col) return;
      const minRaw = $('rMin').value.trim(), maxRaw = $('rMax').value.trim();
      if (!minRaw && !maxRaw) { msgBox('Type a minimum, a maximum, or both.', 'info'); return; }
      const min = minRaw ? toNumber(minRaw) : -Infinity, max = maxRaw ? toNumber(maxRaw) : Infinity;
      if (Number.isNaN(min) || Number.isNaN(max)) { msgBox('Minimum and maximum must be numbers.', 'info'); return; }
      if (min > max) { msgBox('The minimum is bigger than the maximum.', 'info'); return; }
      C().ranges.push({ col, mode: $('rMode').value, min, max });
      $('rMin').value = ''; $('rMax').value = '';
      renderRules(); runClean();
    });
    $('rList').addEventListener('click', (e) => { const i = e.target.dataset.delRange; if (i === undefined) return; C().ranges.splice(+i, 1); renderRules(); runClean(); });

    const readOutlier = () => {
      const o = C().outlier;
      o.col = $('oCol').value; o.mode = $('oMode').value;
      o.iqr = toNumber($('oIqr').value) || 1.5; o.pct = toNumber($('oPct').value) || 1;
      updateOutlierInputs();
      if (o.mode !== 'none' && !o.col) setStatus('Pick a number column for unusual values.');
      scheduleClean();
    };
    ['oCol', 'oMode'].forEach((id) => $(id).addEventListener('change', readOutlier));
    ['oIqr', 'oPct'].forEach((id) => $(id).addEventListener('input', readOutlier));

    $('sMode').addEventListener('change', () => {
      C().sample.mode = $('sMode').value;
      $('sCustom').disabled = C().sample.mode !== 'custom';
      if (!$('sCustom').disabled) $('sCustom').focus();
      scheduleClean();
    });
    $('sCustom').addEventListener('input', () => { C().sample.custom = $('sCustom').value; scheduleClean(); });
    $('sReshuffle').addEventListener('click', () => {
      C().sample.seed++;
      if (C().sample.mode === 'all') setStatus('Pick how many rows to keep first.');
      runClean();
    });

    $('presetReduce').addEventListener('click', () => {
      C().sample.mode = '1000';
      syncCleanInputs(); runClean();
      setStatus(state.raw.rows.length > 1000 ? 'Kept a random 1,000 rows.' : 'The file already has 1,000 rows or fewer.');
    });
    $('presetClean').addEventListener('click', () => {
      C().keep = new Set(suggestedColumns());
      C().required = new Set(suggestedRequired());
      if (state.raw.rows.length > 5000) C().sample.mode = '5000';
      syncCleanInputs(); renderCleanControls(); runClean();
      setStatus('Applied "Clean for analysis". Check the columns and steps it chose.');
    });
    $('presetReset').addEventListener('click', () => {
      state.clean = defaultClean();
      $('colSearch').value = '';
      syncCleanInputs(); renderCleanControls(); runClean();
      setStatus('Back to the original file.');
    });

    $('dlClean').addEventListener('click', downloadCleaned);
    $('dlLog').addEventListener('click', () => downloadText(cleaningLogText(), `${safeBase(state.fileName)}_cleaning_log.txt`, 'text/plain'));
    $('copyRecipe').addEventListener('click', () => copyText(cleaningLogText(), 'Cleaning log copied.'));

    // ---- Analyze
    const onPick = (key, id) => $(id).addEventListener('change', () => { state.analyze[key] = $(id).value; runAnalysis(); });
    onPick('y', 'ySel'); onPick('x', 'xSel'); onPick('color', 'colorSel'); onPick('group', 'groupSel');
    ['optLine', 'optBand', 'optLabels', 'optView'].forEach((id) => $(id).addEventListener('change', drawChart));
    $('swapBtn').addEventListener('click', () => { const A = state.analyze; [A.x, A.y] = [A.y, A.x]; runAnalysis(); });
    $('copyBtn').addEventListener('click', () => copyText(resultsText(), 'Results copied.'));
    $('pngBtn').addEventListener('click', saveChartPng);
    $('dlFlagged').addEventListener('click', () => downloadPredictions(true));
    $('dlAll').addEventListener('click', () => downloadPredictions(false));
    $('rankTable').addEventListener('click', (e) => {
      const tr = e.target.closest('tr[data-x]');
      if (!tr) return;
      state.analyze.x = tr.dataset.x;
      runAnalysis();
    });
    $('invTable').addEventListener('mouseover', (e) => { const tr = e.target.closest('tr[data-row]'); highlightRow(tr ? +tr.dataset.row : 0); });
    $('invTable').addEventListener('mouseleave', () => highlightRow(0));
    $('invTable').addEventListener('click', (e) => { const tr = e.target.closest('tr[data-row]'); if (tr) { highlightRow(+tr.dataset.row); $('chartBox').scrollIntoView({ block: 'nearest', behavior: 'smooth' }); } });

    // Redraw the chart when its width changes (window resize, phone rotation).
    let lastW = 0;
    const redraw = debounce(() => { if (state.tab === 'analyze' && state.raw.rows.length) drawChart(); }, 150);
    new ResizeObserver((entries) => {
      const w = Math.round(entries[0].contentRect.width);
      if (w !== lastW) { lastW = w; redraw(); }
    }).observe($('chartBox'));
  }

  wire();
  // ?sample in the address opens the sample right away (handy for demos and links).
  if (/[?&]sample\b/.test(location.search)) loadSample();
})();
