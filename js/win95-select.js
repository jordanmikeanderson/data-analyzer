/*
 * Data Analyzer: Windows 95 drop-down lists, drawn instead of the browser's own <select> list
 * (which opens a Mac- or phone-style list).
 *
 *   Win95Select.enhance(select)        a drop-down list box. The real <select> stays in the page,
 *                                      hidden, and is still the source of truth: code keeps reading
 *                                      select.value, setting it, replacing its options and listening
 *                                      for 'change'. The Win95 box redraws itself when any of that happens.
 *   Win95Select.combo(input, values)   an editable combo box: a text box with a ▼ button that lists
 *                                      suggestions (values() returns an array of strings).
 *
 * Mouse: press the box to open the list, click a row (or press, drag and let go on it).
 * Phones: tap the box, tap a row. Scrolling the list doesn't pick anything.
 * Keyboard: Up / Down change the value, Alt+Down or F4 opens and closes, Enter picks,
 * Escape closes, Home / End / Page Up / Page Down, typing a letter jumps to the next row starting with it.
 * The open list is drawn into <body> with fixed positioning, so no scrolling panel clips it,
 * and it always stays inside the window (it opens upward when there's more room above).
 */
'use strict';

const Win95Select = (() => {
  const MAX_ROWS = 10;

  // ---------------------------------------------------------------- pure helpers (tested in Node)
  // The next row that isn't grayed out, going delta (+1 or -1) from row `from` (-1 = before the first row,
  // items.length = after the last). Stays put at the ends.
  function step(items, from, delta) {
    const n = items.length;
    let i = from;
    for (let k = 0; k <= n; k++) {
      i += delta;
      if (i < 0 || i >= n) return from >= 0 && from < n ? from : -1;
      if (!items[i].disabled) return i;
    }
    return from;
  }
  // Like step, but jumps up to `count` rows (Page Up / Page Down).
  function page(items, from, delta, count) {
    let i = from;
    for (let k = 0; k < count; k++) {
      const next = step(items, i, delta);
      if (next === i || next < 0) break;
      i = next;
    }
    return i;
  }
  // Typing a letter: the next row (after `from`, wrapping around) whose text starts with it.
  function letterJump(items, from, ch) {
    const c = String(ch).toLowerCase();
    const n = items.length;
    for (let j = 1; j <= n; j++) {
      const i = ((from < 0 ? -1 : from) + j + n) % n;
      if (!items[i].disabled && String(items[i].text).trim().toLowerCase().startsWith(c)) return i;
    }
    return -1;
  }
  // Where the open list goes. field = the box's rectangle; want = the list's full width and height;
  // view = the window size; minH = smallest useful height. Under the box, or above it when there's
  // more room there; always inside the window.
  function place(field, want, view, minH) {
    const below = view.height - field.bottom, above = field.top;
    const up = want.height > below && above > below;
    const room = Math.max(0, up ? above : below);
    const height = Math.max(0, Math.min(want.height, Math.max(room, Math.min(want.height, minH)), view.height));
    let top = up ? field.top - height : field.bottom;
    top = Math.max(0, Math.min(top, view.height - height));
    const width = Math.min(Math.max(field.width, want.width), view.width);
    const left = Math.max(0, Math.min(field.left, view.width - width));
    return { left: Math.round(left), top: Math.round(top), width: Math.round(width), height: Math.round(height), up };
  }

  if (typeof document === 'undefined') return { MAX_ROWS, step, page, letterJump, place };

  // ---------------------------------------------------------------- the open list (one at a time)
  let uid = 0;
  let pop = null; // { owner, el, items, active }

  function rowHeight() { return pop && pop.el.firstElementChild ? pop.el.firstElementChild.offsetHeight || 16 : 16; }

  function setActive(i, scroll = true) {
    if (!pop) return;
    const rows = pop.el.children;
    if (rows[pop.active]) rows[pop.active].classList.remove('on');
    pop.active = i;
    const row = rows[i];
    if (row) {
      row.classList.add('on');
      pop.owner.el.setAttribute('aria-activedescendant', row.id);
      if (scroll) {
        const list = pop.el;
        if (row.offsetTop < list.scrollTop) list.scrollTop = row.offsetTop;
        else if (row.offsetTop + row.offsetHeight > list.scrollTop + list.clientHeight) list.scrollTop = row.offsetTop + row.offsetHeight - list.clientHeight;
      }
    } else pop.owner.el.removeAttribute('aria-activedescendant');
  }

  function position() {
    if (!pop) return;
    const el = pop.el;
    const r = pop.owner.anchor.getBoundingClientRect();
    const rh = rowHeight();
    const rows = Math.max(1, Math.min(MAX_ROWS, pop.items.length));
    el.style.maxHeight = 'none';
    el.style.height = 'auto';
    el.style.width = 'max-content';
    el.style.minWidth = Math.round(r.width) + 'px';
    const fullH = rows * rh + 2;
    const scrollbar = pop.items.length > rows ? 19 : 0;
    const want = { width: el.offsetWidth + scrollbar, height: fullH };
    const view = { width: document.documentElement.clientWidth, height: document.documentElement.clientHeight };
    const p = place({ left: r.left, top: r.top, bottom: r.bottom, width: r.width }, want, view, Math.min(fullH, 3 * rh + 2));
    Object.assign(el.style, { left: p.left + 'px', top: p.top + 'px', width: p.width + 'px', minWidth: '0', height: p.height + 'px', visibility: 'visible' });
  }

  function closeList() {
    if (!pop) return;
    const { owner, el } = pop;
    pop = null;
    el.remove();
    document.removeEventListener('pointerdown', onOutside, true);
    window.removeEventListener('scroll', onScroll, true);
    window.removeEventListener('resize', closeList);
    window.removeEventListener('blur', closeList);
    owner.el.setAttribute('aria-expanded', 'false');
    owner.el.removeAttribute('aria-activedescendant');
    owner.box.classList.remove('open');
  }
  function onOutside(e) {
    if (!pop) return;
    if (pop.el.contains(e.target) || pop.owner.box.contains(e.target)) return;
    closeList();
  }
  function onScroll(e) { if (pop && !pop.el.contains(e.target)) closeList(); }

  function pickRow(i) {
    if (!pop) return;
    const { owner, items } = pop;
    if (!items[i] || items[i].disabled) return;
    closeList();
    owner.choose(i);
  }

  // owner: { el (gets focus + aria), box (gets .open), anchor (list lines up with it), choose(i) }
  function openList(owner, items, active) {
    closeList();
    const el = document.createElement('div');
    el.className = 'w95sel-list';
    el.id = `w95sel-list-${++uid}`;
    el.setAttribute('role', 'listbox');
    if (owner.el.getAttribute('aria-label')) el.setAttribute('aria-label', owner.el.getAttribute('aria-label'));
    el.style.visibility = 'hidden';
    items.forEach((it, i) => {
      const row = document.createElement('div');
      row.className = 'w95sel-item' + (it.disabled ? ' off' : '');
      row.id = `${el.id}-${i}`;
      row.setAttribute('role', 'option');
      row.setAttribute('aria-selected', String(i === active));
      if (it.disabled) row.setAttribute('aria-disabled', 'true');
      row.textContent = it.text || ' ';
      row.title = it.text.length > 30 ? it.text : '';
      el.appendChild(row);
    });
    if (!items.length) { const row = document.createElement('div'); row.className = 'w95sel-item off'; row.textContent = ' '; el.appendChild(row); }
    // Keep the keyboard focus on the box while the list is used.
    el.addEventListener('mousedown', (e) => e.preventDefault());
    el.addEventListener('contextmenu', (e) => e.preventDefault());
    el.addEventListener('pointermove', (e) => {
      if (e.pointerType === 'touch') return;
      const row = e.target.closest('.w95sel-item');
      const i = row ? [...el.children].indexOf(row) : -1;
      if (i >= 0 && pop && i !== pop.active && !(items[i] || {}).disabled) setActive(i, false);
    });
    // Mouse: let go over a row picks it (also after pressing on the box and dragging down).
    el.addEventListener('pointerup', (e) => {
      if (e.pointerType === 'touch' || e.button > 0) return;
      const row = e.target.closest('.w95sel-item');
      if (row) pickRow([...el.children].indexOf(row));
    });
    // Touch (and anything else): a tap is a click. A scroll is not.
    el.addEventListener('click', (e) => {
      const row = e.target.closest('.w95sel-item');
      if (row) pickRow([...el.children].indexOf(row));
    });
    document.body.appendChild(el);
    pop = { owner, el, items, active: -1 };
    owner.el.setAttribute('aria-expanded', 'true');
    owner.el.setAttribute('aria-controls', el.id);
    owner.box.classList.add('open');
    position();
    setActive(active);
    document.addEventListener('pointerdown', onOutside, true);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', closeList);
    window.addEventListener('blur', closeList);
  }
  const isOpenFor = (owner) => !!pop && pop.owner === owner;

  // Keys while a list is open (shared by both kinds of box). Returns true when the key was used.
  function listKey(e) {
    if (!pop) return false;
    const { items, active } = pop;
    const k = e.key;
    const rows = Math.max(1, Math.min(MAX_ROWS, items.length));
    if (k === 'ArrowDown' && !e.altKey) { setActive(step(items, active, 1)); return true; }
    if (k === 'ArrowUp' && !e.altKey) { setActive(step(items, active < 0 ? items.length : active, -1)); return true; }
    if (k === 'PageDown') { setActive(page(items, active, 1, rows - 1)); return true; }
    if (k === 'PageUp') { setActive(page(items, active < 0 ? items.length : active, -1, rows - 1)); return true; }
    if (k === 'Home') { setActive(step(items, -1, 1)); return true; }
    if (k === 'End') { setActive(step(items, items.length, -1)); return true; }
    if (k === 'Enter') { if (active >= 0) pickRow(active); else closeList(); return true; }
    if (k === 'Escape' || k === 'F4' || ((k === 'ArrowDown' || k === 'ArrowUp') && e.altKey)) { closeList(); return true; }
    return false;
  }

  // Wait for the end of a gesture before treating "the focus left the box" as "close the list".
  function closeOnBlur(owner) {
    setTimeout(() => { if (isOpenFor(owner) && !owner.el.contains(document.activeElement) && document.activeElement !== owner.el) closeList(); }, 0);
  }

  // ---------------------------------------------------------------- drop-down list box over a <select>
  // The label's own words (without the box's text), for screen readers.
  function labelText(label) {
    const copy = label.cloneNode(true);
    copy.querySelectorAll('select, .w95sel, input, .w95combo').forEach((n) => n.remove());
    return copy.textContent.replace(/\s+/g, ' ').trim();
  }

  function enhance(select) {
    if (select.w95) return select.w95;
    const box = document.createElement('div');
    box.className = 'w95sel' + (select.classList.contains('fit') ? ' fit' : '');
    box.tabIndex = 0;
    box.setAttribute('role', 'combobox');
    box.setAttribute('aria-haspopup', 'listbox');
    box.setAttribute('aria-expanded', 'false');
    if (select.id) box.id = `${select.id}-w95`;
    const label = select.closest('label');
    const name = select.getAttribute('aria-label') || (label ? labelText(label) : '');
    if (name) box.setAttribute('aria-label', name);
    box.innerHTML = '<span class="w95sel-field"><span class="w95sel-value"></span><span class="w95sel-sizer" aria-hidden="true"></span></span><span class="w95sel-btn" aria-hidden="true"></span>';
    const valueEl = box.querySelector('.w95sel-value');
    const sizer = box.querySelector('.w95sel-sizer');
    select.after(box);
    select.hidden = true;
    select.tabIndex = -1;
    select.setAttribute('aria-hidden', 'true');

    const items = () => [...select.options].map((o) => ({ text: o.text, disabled: o.disabled }));
    const disabled = () => select.disabled;

    // Draw the box from the <select>.
    let lastSizer = '';
    function sync() {
      const o = select.options[select.selectedIndex];
      valueEl.textContent = o ? o.text : '';
      box.title = o && o.text.length > 24 ? o.text : (select.title || '');
      const off = disabled();
      box.classList.toggle('disabled', off);
      box.tabIndex = off ? -1 : 0;
      if (off) box.setAttribute('aria-disabled', 'true'); else box.removeAttribute('aria-disabled');
      if (box.classList.contains('fit')) {
        const key = [...select.options].map((x) => x.text).join('\n');
        if (key !== lastSizer) {
          lastSizer = key;
          sizer.replaceChildren(...[...select.options].map((x) => { const s = document.createElement('span'); s.textContent = x.text; return s; }));
        }
      }
      if (off && isOpenFor(owner)) closeList();
    }
    // Code that sets select.value or selectedIndex directly fires no event, so watch those too.
    for (const prop of ['value', 'selectedIndex']) {
      const d = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, prop);
      Object.defineProperty(select, prop, {
        configurable: true,
        get() { return d.get.call(this); },
        set(v) { d.set.call(this, v); sync(); },
      });
    }
    new MutationObserver(() => { if (isOpenFor(owner)) closeList(); sync(); })
      .observe(select, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['disabled', 'label'] });
    select.addEventListener('change', sync);

    const owner = {
      el: box, box, anchor: box,
      choose(i) {
        box.focus({ preventScroll: true });
        if (i === select.selectedIndex) return;
        select.selectedIndex = i;
        select.dispatchEvent(new Event('input', { bubbles: true }));
        select.dispatchEvent(new Event('change', { bubbles: true }));
      },
    };
    const toggle = () => {
      if (disabled()) return;
      if (isOpenFor(owner)) closeList(); else openList(owner, items(), select.selectedIndex);
    };

    // Mouse opens on press (like Windows); touch opens on the tap, so scrolling past the box doesn't.
    let lastPointer = 'mouse';
    box.addEventListener('pointerdown', (e) => {
      lastPointer = e.pointerType || 'mouse';
      if (lastPointer === 'touch' || e.button > 0 || disabled()) return;
      box.focus({ preventScroll: true });
      toggle();
    });
    box.addEventListener('mousedown', (e) => e.preventDefault()); // no text selection, focus handled above
    box.addEventListener('click', () => {
      if (lastPointer !== 'touch' || disabled()) return;
      box.focus({ preventScroll: true });
      toggle();
    });
    box.addEventListener('blur', () => closeOnBlur(owner));
    box.addEventListener('keydown', (e) => {
      if (disabled()) return;
      const use = () => { e.preventDefault(); e.stopPropagation(); };
      const k = e.key;
      if (isOpenFor(owner)) {
        if (k === 'Tab') { // Windows keeps the highlighted row when you tab away
          const a = pop.active;
          closeList();
          if (a >= 0) owner.choose(a);
          return;
        }
        if (k === ' ') { use(); if (pop.active >= 0) pickRow(pop.active); return; }
        if (listKey(e)) { use(); return; }
        if (k.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
          use();
          const i = letterJump(pop.items, pop.active, k);
          if (i >= 0) setActive(i);
        }
        return;
      }
      const list = items();
      const at = select.selectedIndex;
      const rows = Math.max(1, Math.min(MAX_ROWS, list.length));
      const go = (i) => { if (i >= 0 && i !== at) owner.choose(i); };
      if ((k === 'ArrowDown' || k === 'ArrowUp') && e.altKey) { use(); toggle(); }
      else if (k === 'F4' || k === ' ') { use(); toggle(); }
      else if (k === 'ArrowDown') { use(); go(step(list, at, 1)); }
      else if (k === 'ArrowUp') { use(); go(step(list, at < 0 ? list.length : at, -1)); }
      else if (k === 'PageDown') { use(); go(page(list, at, 1, rows - 1)); }
      else if (k === 'PageUp') { use(); go(page(list, at < 0 ? list.length : at, -1, rows - 1)); }
      else if (k === 'Home') { use(); go(step(list, -1, 1)); }
      else if (k === 'End') { use(); go(step(list, list.length, -1)); }
      else if (k.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) { use(); go(letterJump(list, at, k)); }
    });
    // Clicking the label's words puts the focus on the box (the hidden <select> can't take it).
    // preventDefault also stops the browser passing the click on to the hidden <select>.
    if (label) label.addEventListener('click', (e) => { e.preventDefault(); if (!box.contains(e.target) && !disabled()) box.focus(); });

    sync();
    select.w95 = { box, sync, open: () => { if (!isOpenFor(owner)) toggle(); }, close: closeList };
    return select.w95;
  }

  // ---------------------------------------------------------------- editable combo box (text + suggestions)
  function combo(input, values) {
    if (input.w95) return input.w95;
    const box = document.createElement('span');
    box.className = 'w95combo';
    input.before(box);
    box.appendChild(input);
    const btn = document.createElement('span');
    btn.className = 'w95sel-btn';
    btn.setAttribute('aria-hidden', 'true');
    box.appendChild(btn);
    input.setAttribute('role', 'combobox');
    input.setAttribute('aria-autocomplete', 'none');
    input.setAttribute('aria-expanded', 'false');
    input.removeAttribute('list');

    const list = () => (values() || []).map((v) => ({ text: String(v), disabled: false }));
    const indexOfText = (arr) => { const t = input.value.trim().toLowerCase(); return t ? arr.findIndex((it) => it.text.toLowerCase() === t) : -1; };
    const owner = {
      el: input, box, anchor: box,
      choose(i) {
        const it = list()[i];
        if (!it) return;
        input.value = it.text;
        input.focus({ preventScroll: true });
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
      },
    };
    const toggle = () => {
      if (input.disabled) return;
      if (isOpenFor(owner)) closeList(); else { const arr = list(); openList(owner, arr, indexOfText(arr)); }
    };
    const sync = () => box.classList.toggle('disabled', input.disabled);
    new MutationObserver(() => { if (input.disabled && isOpenFor(owner)) closeList(); sync(); })
      .observe(input, { attributes: true, attributeFilter: ['disabled'] });

    let lastPointer = 'mouse';
    btn.addEventListener('pointerdown', (e) => {
      lastPointer = e.pointerType || 'mouse';
      if (lastPointer === 'touch' || e.button > 0 || input.disabled) return;
      e.preventDefault();
      input.focus({ preventScroll: true });
      toggle();
    });
    btn.addEventListener('mousedown', (e) => e.preventDefault());
    btn.addEventListener('click', () => {
      if (lastPointer !== 'touch' || input.disabled) return;
      toggle();
    });
    input.addEventListener('blur', () => closeOnBlur(owner));
    // While the list is open, typing highlights the first row that starts with the text.
    input.addEventListener('input', () => {
      if (!isOpenFor(owner)) return;
      const t = input.value.trim().toLowerCase();
      const i = t ? pop.items.findIndex((it) => it.text.toLowerCase().startsWith(t)) : -1;
      setActive(i);
    });
    input.addEventListener('keydown', (e) => {
      if (input.disabled) return;
      const use = () => { e.preventDefault(); e.stopPropagation(); };
      const k = e.key;
      if (isOpenFor(owner)) {
        if (k === 'Tab') { closeList(); return; }
        if (listKey(e)) use();
        return;
      }
      if (((k === 'ArrowDown' || k === 'ArrowUp') && e.altKey) || k === 'F4') { use(); toggle(); return; }
      // Up / Down step through the suggestions, like a Windows combo box.
      if (k === 'ArrowDown' || k === 'ArrowUp') {
        const arr = list();
        if (!arr.length) return;
        use();
        const at = indexOfText(arr);
        const i = k === 'ArrowDown' ? step(arr, at, 1) : step(arr, at < 0 ? arr.length : at, -1);
        if (i >= 0 && i !== at) owner.choose(i);
      }
    });
    sync();
    input.w95 = { box, sync, open: () => { if (!isOpenFor(owner)) toggle(); }, close: closeList };
    return input.w95;
  }

  function enhanceAll(root = document) {
    root.querySelectorAll('select').forEach((s) => enhance(s));
  }

  return { MAX_ROWS, step, page, letterJump, place, enhance, combo, enhanceAll, close: closeList };
})();

if (typeof module !== 'undefined') module.exports = Win95Select;
