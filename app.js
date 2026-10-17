(() => {
  'use strict';

  const CFG = window.DIARY_CONFIG || {};
  const SCOPE = 'https://www.googleapis.com/auth/spreadsheets';
  const API = 'https://sheets.googleapis.com/v4/spreadsheets/';
  const DEMO = new URLSearchParams(location.search).has('demo');
  const PAGE = 60;
  const FLAGS = { b: 'bold', i: 'italic', u: 'underline', s: 'strikethrough' };

  const $ = s => document.querySelector(s);
  const store = {
    get(k, d = null) { try { const v = localStorage.getItem('dagbok.' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem('dagbok.' + k, JSON.stringify(v)); return true; } catch { return false; } },
    del(k) { try { localStorage.removeItem('dagbok.' + k); } catch { /* ignoreras */ } }
  };

  class AuthError extends Error {
    constructor() { super('Inloggningen har gått ut'); this.auth = true; }
  }

  const state = {
    entries: [],      // alla anteckningar, nyast först
    view: [],         // efter sök/årsfilter
    terms: [],
    year: null,
    rendered: 0,
    lastMonth: null,
    sheetTitle: '',
    sheetId: 0,
    token: null,
    ready: false,
    navigated: false,
    listScroll: 0,
    editing: null,
    current: 'loading'
  };

  const ICON = {
    pin: '<svg viewBox="0 0 24 24"><path d="M12 21s-7-6.2-7-11.5a7 7 0 0 1 14 0C19 14.8 12 21 12 21z"/><circle cx="12" cy="9.5" r="2.5"/></svg>'
  };

  // ---------- Hjälpfunktioner ----------
  const pad = n => String(n).padStart(2, '0');
  const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const escRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const cap = s => s.charAt(0).toUpperCase() + s.slice(1);
  const localDate = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const todayStr = () => localDate(new Date());
  const nowStamp = () => { const d = new Date(); return `${localDate(d)} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`; };
  const toDate = s => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d || 1); };
  const fmtLong = new Intl.DateTimeFormat('sv-SE', { weekday: 'long', day: 'numeric', month: 'long' });
  const fmtFull = new Intl.DateTimeFormat('sv-SE', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  const fmtMonth = new Intl.DateTimeFormat('sv-SE', { month: 'long', year: 'numeric' });
  const fmtShort = new Intl.DateTimeFormat('sv-SE', { day: 'numeric', month: 'short' });
  const fmtWd = new Intl.DateTimeFormat('sv-SE', { weekday: 'short' });

  // Vädret avgör färg och ikon på kort och läsvy.
  function weatherKind(w) {
    w = (w || '').toLowerCase();
    if (!w) return 'none';
    if (/åsk/.test(w)) return 'storm';
    if (/snö/.test(w)) return 'snow';
    if (/regn|skur|dugg/.test(w)) return 'rain';
    if (/dimm/.test(w)) return 'fog';
    if (/halvklar|växlande|mest sol|lite moln|sol och moln/.test(w)) return 'partly';
    if (/moln|mulet|grå/.test(w)) return 'cloud';
    if (/blås|vind|storm/.test(w)) return 'wind';
    if (/sol|klart|varm/.test(w)) return 'sun';
    return 'other';
  }
  const KIND_ICON = { sun: '☀️', partly: '⛅', cloud: '☁️', rain: '🌧️', snow: '❄️', storm: '⛈️', fog: '🌫️', wind: '💨', other: '🌡️', none: '📖' };
  const weatherIcon = w => (w ? KIND_ICON[weatherKind(w)] : '');

  const WMO = [
    [[0], 'Sol'], [[1], 'Mest sol'], [[2], 'Halvklart'], [[3], 'Mulet'],
    [[45, 48], 'Dimma'], [[51, 53, 55, 56, 57], 'Duggregn'],
    [[61, 63, 65, 66, 67], 'Regn'], [[71, 73, 75, 77], 'Snö'],
    [[80, 81, 82], 'Regnskurar'], [[85, 86], 'Snöbyar'], [[95, 96, 99], 'Åska']
  ];
  const wmoText = code => (WMO.find(([codes]) => codes.includes(code)) || [, ''])[1];

  let toastTimer;
  function toast(msg, ms = 3200) {
    const t = $('#toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('show'), ms);
  }

  // ---------- Rich text ----------
  // Formatering lagras kompakt som [[startIndex, 'biu'], ...] där bokstäverna är fet/kursiv/understruken/genomstruken.
  function normRuns(text, runs, base) {
    base = base || {};
    const src = runs && runs.length ? runs.slice() : [{ startIndex: 0 }];
    if ((src[0].startIndex || 0) > 0) src.unshift({ startIndex: 0 });
    const out = [];
    for (const r of src) {
      const s = r.startIndex || 0;
      if (s >= text.length) continue;
      let flags = '';
      for (const [k, name] of Object.entries(FLAGS)) {
        const v = r.format && name in r.format ? r.format[name] : base[name];
        if (v) flags += k;
      }
      const last = out[out.length - 1];
      if (last && last[1] === flags) continue;
      out.push([s, flags]);
    }
    return out.length === 1 && !out[0][1] ? [] : out;
  }

  function runsToHtml(text, runs) {
    if (!text) return '';
    if (!runs || !runs.length) return esc(text);
    let html = '';
    runs.forEach(([s, f], i) => {
      const e = i + 1 < runs.length ? runs[i + 1][0] : text.length;
      let seg = esc(text.slice(s, e));
      if (f.includes('b')) seg = `<b>${seg}</b>`;
      if (f.includes('i')) seg = `<i>${seg}</i>`;
      if (f.includes('u')) seg = `<u>${seg}</u>`;
      if (f.includes('s')) seg = `<s>${seg}</s>`;
      html += seg;
    });
    return html;
  }

  function editorToRich(root) {
    let text = '';
    const runs = [];
    const push = (str, f) => {
      if (!str) return;
      const flags = Object.keys(FLAGS).filter(k => f[k]).join('');
      const last = runs[runs.length - 1];
      if (!last || last[1] !== flags) runs.push([text.length, flags]);
      text += str;
    };
    const walk = (node, f) => {
      if (node.nodeType === 3) { push(node.nodeValue.replace(/ /g, ' '), f); return; }
      if (node.nodeType !== 1) return;
      const tag = node.tagName;
      if (tag === 'BR') { push('\n', f); return; }
      if (/^(DIV|P|LI|H\d|BLOCKQUOTE)$/.test(tag) && text && !text.endsWith('\n')) push('\n', f);
      const st = node.style || {};
      const deco = (st.textDecorationLine || st.textDecoration || '');
      const n = { ...f };
      if (tag === 'B' || tag === 'STRONG' || st.fontWeight === 'bold' || +st.fontWeight >= 600) n.b = true;
      if (st.fontWeight === 'normal' || st.fontWeight === '400') n.b = false;
      if (tag === 'I' || tag === 'EM' || st.fontStyle === 'italic') n.i = true;
      if (tag === 'U' || deco.includes('underline')) n.u = true;
      if (tag === 'S' || tag === 'STRIKE' || tag === 'DEL' || deco.includes('line-through')) n.s = true;
      node.childNodes.forEach(c => walk(c, n));
    };
    root.childNodes.forEach(c => walk(c, {}));
    text = text.replace(/\s+$/, '');
    const kept = runs.filter(r => r[0] < text.length);
    return { text, runs: kept.length === 1 && !kept[0][1] ? [] : kept };
  }

  function apiRuns(text, runs) {
    if (!text) return [];
    const list = runs.length ? runs : [[0, '']];
    return list.map(([s, f]) => ({
      startIndex: s,
      format: Object.fromEntries(Object.entries(FLAGS).map(([k, name]) => [name, f.includes(k)]))
    }));
  }

  function highlightIn(root, terms) {
    if (!terms.length) return;
    const re = new RegExp(terms.map(escRe).join('|'), 'gi');
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);
    for (const n of nodes) {
      const t = n.nodeValue;
      re.lastIndex = 0;
      if (!re.test(t)) continue;
      re.lastIndex = 0;
      const frag = document.createDocumentFragment();
      let last = 0, m;
      while ((m = re.exec(t))) {
        frag.append(t.slice(last, m.index));
        const mk = document.createElement('mark');
        mk.textContent = m[0];
        frag.append(mk);
        last = m.index + m[0].length;
      }
      frag.append(t.slice(last));
      n.replaceWith(frag);
    }
  }

  // ---------- Google-inloggning ----------
  let tokenClient = null;
  let authWaiter = null;

  function tokenValid() {
    const t = store.get('token');
    return !!(state.token && t && t.exp > Date.now() + 60e3);
  }

  function initGis() {
    return new Promise((resolve, reject) => {
      const started = Date.now();
      (function wait() {
        if (window.google && google.accounts && google.accounts.oauth2) {
          tokenClient = google.accounts.oauth2.initTokenClient({
            client_id: CFG.clientId,
            scope: SCOPE,
            callback: r => {
              const w = authWaiter; authWaiter = null;
              if (!w) return;
              if (r.error) return w.reject(new Error(r.error_description || r.error));
              if (!google.accounts.oauth2.hasGrantedAllScopes(r, SCOPE)) {
                return w.reject(new Error('Du behöver tillåta att sidan ser och redigerar dina kalkylark.'));
              }
              state.token = r.access_token;
              store.set('token', { value: r.access_token, exp: Date.now() + (r.expires_in || 3600) * 1000 });
              w.resolve();
            },
            error_callback: err => {
              const w = authWaiter; authWaiter = null;
              if (w) w.reject(new Error(err && err.type === 'popup_closed' ? 'Inloggningen avbröts.' : 'Inloggningen misslyckades. Tillåt popup-fönster och försök igen.'));
            }
          });
          resolve();
        } else if (Date.now() - started > 15000) {
          reject(new Error('Kunde inte ladda Googles inloggning. Kontrollera internetanslutningen.'));
        } else {
          setTimeout(wait, 60);
        }
      })();
    });
  }

  // Måste anropas direkt från ett klick, annars blockeras inloggningsfönstret.
  function signIn() {
    return new Promise((resolve, reject) => {
      if (!tokenClient) return reject(new Error('Googles inloggning har inte laddats än.'));
      authWaiter = { resolve, reject };
      tokenClient.requestAccessToken({ prompt: '' });
    });
  }

  function signOut() {
    if (state.token && window.google) google.accounts.oauth2.revoke(state.token, () => {});
    state.token = null;
    store.del('token');
    store.del('cache');
    state.entries = [];
    state.ready = false;
  }

  // ---------- Google Sheets ----------
  const sheetKey = () => CFG.spreadsheetId || store.get('sheet');
  const qTitle = () => `'${state.sheetTitle.replace(/'/g, "''")}'`;
  const enc = encodeURIComponent;
  const safe = s => (/^[=+\-@]/.test(s) ? "'" + s : s);

  async function api(path, opts = {}) {
    if (!state.token) throw new AuthError();
    const res = await fetch(API + path, {
      ...opts,
      headers: { Authorization: 'Bearer ' + state.token, 'Content-Type': 'application/json' }
    });
    if (res.status === 401) { state.token = null; store.del('token'); throw new AuthError(); }
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      const msg = (j.error && j.error.message) || 'HTTP ' + res.status;
      const err = new Error(res.status === 403 ? 'Kontot har inte åtkomst till kalkylarket.' : res.status === 404 ? 'Hittade inte kalkylarket. Kontrollera länken.' : msg);
      err.status = res.status;
      throw err;
    }
    return res.json();
  }

  function cellDate(c) {
    const ev = c && c.effectiveValue;
    if (ev && typeof ev.numberValue === 'number') {
      const d = new Date(Date.UTC(1899, 11, 30) + Math.floor(ev.numberValue) * 864e5);
      return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
    }
    const m = ((c && c.formattedValue) || '').match(/(\d{4})-(\d{1,2})-(\d{1,2})/);
    return m ? `${m[1]}-${pad(m[2])}-${pad(m[3])}` : '';
  }

  async function loadSheet() {
    const id = sheetKey();
    const meta = await api(`${id}?fields=${enc('properties.title,sheets.properties(sheetId,title)')}`);
    const p = meta.sheets[0].properties;
    state.sheetTitle = p.title;
    state.sheetId = p.sheetId;
    const fields = 'sheets.data.rowData.values(formattedValue,effectiveValue,textFormatRuns,userEnteredFormat.textFormat)';
    const data = await api(`${id}?ranges=${enc(qTitle() + '!A1:E')}&includeGridData=true&fields=${enc(fields)}`);
    const rows = (data.sheets[0].data[0] || {}).rowData || [];
    const entries = [];
    rows.forEach((r, i) => {
      const v = r.values || [];
      const date = cellDate(v[1]);
      const d = v[3] || {};
      const text = d.formattedValue || '';
      if (!date && (i === 0 || !text)) return; // rubrikrad eller tom rad
      entries.push(makeEntry({
        row: i + 1,
        created: (v[0] && v[0].formattedValue) || '',
        date,
        weather: ((v[2] && v[2].formattedValue) || '').trim(),
        text,
        runs: normRuns(text, d.textFormatRuns, d.userEnteredFormat && d.userEnteredFormat.textFormat),
        place: ((v[4] && v[4].formattedValue) || '').trim()
      }));
    });
    return entries;
  }

  async function persist(e, d) {
    if (DEMO) {
      const row = e ? e.row : Math.max(1, ...state.entries.map(x => x.row)) + 1;
      return { row, created: e ? e.created : nowStamp() };
    }
    const id = sheetKey();
    const T = qTitle();
    let row, created;
    if (e) {
      // Kontrollera att raden fortfarande är samma anteckning innan vi skriver över den.
      const chk = await api(`${id}/values/${enc(`${T}!A${e.row}:A${e.row}`)}`);
      const a = (chk.values && chk.values[0] && chk.values[0][0]) || '';
      if (a !== e.created) throw new Error('Kalkylarket har ändrats sedan det hämtades. Tryck "Hämta senaste" och försök igen.');
      row = e.row;
      created = e.created;
      await api(`${id}/values:batchUpdate`, {
        method: 'POST',
        body: JSON.stringify({
          valueInputOption: 'USER_ENTERED',
          data: [
            { range: `${T}!B${row}:C${row}`, values: [[d.date, safe(d.weather)]] },
            { range: `${T}!E${row}`, values: [[safe(d.place)]] }
          ]
        })
      });
    } else {
      const r = await api(`${id}/values/${enc(T + '!A:E')}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`, {
        method: 'POST',
        body: JSON.stringify({ values: [[nowStamp(), d.date, safe(d.weather), safe(d.text), safe(d.place)]] })
      });
      row = +r.updates.updatedRange.match(/!A(\d+)/)[1];
    }
    // Texten skrivs separat så att formateringen (fet, kursiv …) följer med.
    await api(`${id}:batchUpdate`, {
      method: 'POST',
      body: JSON.stringify({
        requests: [{
          updateCells: {
            range: { sheetId: state.sheetId, startRowIndex: row - 1, endRowIndex: row, startColumnIndex: 3, endColumnIndex: 4 },
            rows: [{ values: [{ userEnteredValue: { stringValue: d.text }, textFormatRuns: apiRuns(d.text, d.runs) }] }],
            fields: 'userEnteredValue,textFormatRuns'
          }
        }]
      })
    });
    if (!e) {
      const back = await api(`${id}/values/${enc(`${T}!A${row}`)}`);
      created = (back.values && back.values[0] && back.values[0][0]) || '';
    }
    return { row, created };
  }

  // ---------- Data ----------
  function makeEntry(x) {
    const longDate = x.date ? fmtFull.format(toDate(x.date)) : '';
    x.hay = [x.text, x.place, x.weather, x.date, longDate].join(' ').toLowerCase();
    return x;
  }

  function sortEntries() {
    state.entries.sort((a, b) => (a.date === b.date ? b.row - a.row : a.date < b.date ? 1 : -1));
  }

  function saveCache() {
    const slim = state.entries.map(({ row, created, date, weather, text, runs, place }) => ({ row, created, date, weather, text, runs, place }));
    store.set('cache', { sheet: sheetKey(), title: state.sheetTitle, sheetId: state.sheetId, entries: slim });
  }

  function loadCache() {
    const c = store.get('cache');
    if (!c || c.sheet !== sheetKey() || !Array.isArray(c.entries)) return false;
    state.sheetTitle = c.title;
    state.sheetId = c.sheetId;
    state.entries = c.entries.map(makeEntry);
    sortEntries();
    return true;
  }

  async function refresh(silent) {
    try {
      state.entries = await loadSheet();
      sortEntries();
      saveCache();
      $('#syncBanner').hidden = true;
      if (!state.ready) { state.ready = true; }
      applyFilters();
      route();
      if (!silent) toast('Dagboken är uppdaterad');
    } catch (err) {
      if (err.auth) {
        if (state.ready) { $('#syncBanner').hidden = false; route(); }
        else showView('login');
      } else if (err.status === 403 || err.status === 404) {
        showSetup(err.message);
      } else if (state.ready) {
        toast('Kunde inte hämta: ' + err.message, 5000);
      } else {
        showLogin(err.message);
      }
    }
  }

  // ---------- Vyer ----------
  function showView(name) {
    if (state.current === 'list' && name !== 'list') state.listScroll = window.scrollY;
    state.current = name;
    document.querySelectorAll('.view').forEach(v => { v.hidden = v.id !== 'view-' + name; });
    const inApp = ['list', 'entry', 'edit'].includes(name);
    $('#fab').hidden = name !== 'list';
    $('#searchBtn').hidden = name !== 'list';
    $('#backBtn').hidden = !(name === 'entry' || name === 'edit');
    $('#brand').textContent = name === 'edit' ? '' : (CFG.title || 'Dagboken');
    $('#sheetActions').hidden = DEMO || !inApp;
  }

  function showLogin(error) {
    const h = new Date().getHours();
    $('#greeting').textContent = h < 10 ? 'God morgon' : h < 18 ? 'Hej!' : 'God kväll';
    $('#loginError').hidden = !error;
    $('#loginError').textContent = error || '';
    showView('login');
  }

  function showSetup(error) {
    $('#setupError').hidden = !error;
    $('#setupError').textContent = error || '';
    $('#sheetInput').value = '';
    showView('setup');
  }

  function route() {
    if (!state.ready) return;
    const [name, arg] = location.hash.replace(/^#\/?/, '').split('/');
    if (name === 'e') showEntry(+arg);
    else if (name === 'new') showEdit(null);
    else if (name === 'edit') showEdit(+arg);
    else showList();
  }

  function goBack() {
    if (state.navigated) history.back();
    else location.replace('#/');
  }

  // ---------- Lista ----------
  function applyFilters() {
    const q = $('#searchInput').value.trim().toLowerCase();
    state.terms = q ? q.split(/\s+/) : [];
    state.view = state.entries.filter(e =>
      (!state.year || e.date.startsWith(state.year)) && state.terms.every(t => e.hay.includes(t)));
    state.rendered = 0;
    state.lastMonth = null;
    $('#list').innerHTML = '';
    const info = $('#resultsInfo');
    info.hidden = !state.terms.length;
    info.textContent = state.view.length === 1 ? '1 anteckning hittades' : `${state.view.length} anteckningar hittades`;
    state.monthStats = {};
    for (const e of state.view) {
      const k = e.date.slice(0, 7);
      const m = state.monthStats[k] || (state.monthStats[k] = { n: 0, places: [] });
      m.n++;
      if (e.place && !m.places.some(p => p.toLowerCase() === e.place.toLowerCase())) m.places.push(e.place);
    }
    renderHero();
    renderChips();
    renderOnThisDay();
    renderMore();
  }

  function renderHero() {
    const hero = $('#hero');
    hero.hidden = !!state.terms.length;
    const now = new Date();
    const h = now.getHours();
    const period = h < 5 ? 'night' : h < 10 ? 'morning' : h < 17 ? 'day' : h < 21 ? 'evening' : 'night';
    hero.dataset.period = period;
    $('#heroDate').textContent = cap(fmtFull.format(now).replace(/ \d{4}$/, ''));
    $('#heroGreet').textContent = { morning: 'God morgon!', day: 'Hej på dig!', evening: 'God kväll!', night: 'God natt!' }[period];

    const dated = state.entries.filter(e => e.date);
    const places = new Set(dated.map(e => e.place.toLowerCase()).filter(Boolean));
    const days = new Set(dated.map(e => e.date));
    // Antal dagar i rad som har en anteckning, räknat bakåt från idag eller igår.
    let streak = 0;
    const d = new Date();
    if (!days.has(localDate(d))) d.setDate(d.getDate() - 1);
    while (days.has(localDate(d))) { streak++; d.setDate(d.getDate() - 1); }
    const first = dated.length ? dated[dated.length - 1].date : '';
    const stats = [
      [days.size.toLocaleString('sv-SE'), days.size === 1 ? 'dag' : 'dagar'],
      [places.size.toLocaleString('sv-SE'), places.size === 1 ? 'ort' : 'orter']
    ];
    if (streak >= 2) stats.push([streak, 'i rad 🔥']);
    else if (first) stats.push([first.slice(0, 4), 'sedan']);
    $('#heroStats').innerHTML = stats.map(([n, l]) => `<div class="stat"><b>${esc(n)}</b><span>${esc(l)}</span></div>`).join('');

    const today = state.entries.find(e => e.date === todayStr());
    const cta = $('#heroCta');
    cta.href = today ? '#/e/' + today.row : '#/new';
    cta.classList.toggle('done', !!today);
    cta.innerHTML = today
      ? '<span>✓</span> Dagens anteckning är skriven'
      : '<span>✍️</span> Skriv dagens anteckning';
  }

  function renderChips() {
    const years = [...new Set(state.entries.map(e => e.date.slice(0, 4)).filter(Boolean))];
    const box = $('#yearChips');
    box.hidden = years.length < 2;
    box.innerHTML = '';
    [null, ...years].forEach(y => {
      const b = document.createElement('button');
      b.className = 'chip';
      b.textContent = y || 'Alla';
      b.setAttribute('aria-pressed', String(state.year === y));
      b.onclick = () => { state.year = y; applyFilters(); window.scrollTo(0, 0); };
      box.append(b);
    });
  }

  function renderOnThisDay() {
    const box = $('#onThisDay');
    box.innerHTML = '';
    if (state.terms.length || state.year) return;
    const t = todayStr();
    const hits = state.entries.filter(e => e.date && e.date.slice(5) === t.slice(5) && e.date < t);
    if (!hits.length) return;
    const h = document.createElement('p');
    h.className = 'section-label';
    h.textContent = '🕰️ Den här dagen tidigare år';
    box.append(h);
    hits.forEach(e => {
      const n = +t.slice(0, 4) - +e.date.slice(0, 4);
      box.append(cardEl(e, `För ${n} år sedan · ${e.date.slice(0, 4)}`));
    });
  }

  function snippet(text) {
    const flat = text.replace(/\s+/g, ' ').trim();
    if (!state.terms.length) return flat.slice(0, 400);
    const low = flat.toLowerCase();
    let i = Math.min(...state.terms.map(t => { const k = low.indexOf(t); return k < 0 ? Infinity : k; }));
    if (!isFinite(i) || i < 40) return flat.slice(0, 400);
    let s = flat.lastIndexOf(' ', i - 20);
    s = s < 0 ? 0 : s + 1;
    return '…' + flat.slice(s, s + 400);
  }

  function cardEl(e, label) {
    const a = document.createElement('a');
    a.className = 'card' + (label ? ' memory' : '');
    a.href = '#/e/' + e.row;
    a.dataset.kind = weatherKind(e.weather);
    const d = e.date ? toDate(e.date) : null;
    a.innerHTML =
      `<div class="card-date">${d
        ? `<span class="wd">${esc(fmtWd.format(d).replace('.', ''))}</span><span class="day">${d.getDate()}</span>`
        : '<span class="day">–</span>'}<span class="card-wx" aria-hidden="true">${KIND_ICON[a.dataset.kind]}</span></div>` +
      `<div class="card-body">` +
      (label ? `<div class="card-label">${esc(label)}</div>` : '') +
      `<div class="card-meta">` +
      (e.place ? `<span class="place">${ICON.pin}${esc(e.place)}</span>` : '') +
      (e.weather ? `<span class="wx">${esc(e.weather)}</span>` : '') +
      `</div><p class="snippet"></p></div>`;
    const p = a.querySelector('.snippet');
    p.textContent = snippet(e.text);
    highlightIn(p, state.terms);
    highlightIn(a.querySelector('.card-meta'), state.terms);
    return a;
  }

  function renderMore() {
    const list = $('#list');
    if (!state.view.length && state.rendered === 0) {
      list.innerHTML = state.entries.length
        ? '<div class="empty"><p class="empty-title">Inga träffar</p><p>Prova ett annat ord, eller välj “Alla” år.</p></div>'
        : '<div class="empty"><p class="empty-title">Dagboken är tom</p><p>Tryck på “Ny” för att skriva den första anteckningen.</p></div>';
      return;
    }
    const frag = document.createDocumentFragment();
    const end = Math.min(state.rendered + PAGE, state.view.length);
    const searching = state.terms.length > 0;
    for (let i = state.rendered; i < end; i++) {
      const e = state.view[i];
      const newer = state.view[i - 1];
      const mk = e.date.slice(0, 7);
      // Byte av ort mellan två anteckningar visas som en liten resemarkör.
      if (!searching && newer && e.place && newer.place && e.place.toLowerCase() !== newer.place.toLowerCase()) {
        const t = document.createElement('div');
        t.className = 'trip';
        t.innerHTML = `<span class="trip-line" aria-hidden="true"></span><span class="trip-label">🚐 ${esc(e.place)} <span aria-label="till">→</span> <b>${esc(newer.place)}</b></span>`;
        frag.append(t);
      }
      if (mk !== state.lastMonth) {
        state.lastMonth = mk;
        const h = document.createElement('h3');
        h.className = 'month';
        h.textContent = mk ? cap(fmtMonth.format(toDate(mk + '-01'))) : 'Utan datum';
        frag.append(h);
        const st = state.monthStats[mk];
        if (st) {
          const p = document.createElement('p');
          p.className = 'month-sub';
          const pl = st.places.length > 3 ? st.places.slice(0, 3).join(', ') + ` +${st.places.length - 3}` : st.places.join(', ');
          p.textContent = `${st.n} ${st.n === 1 ? 'dag' : 'dagar'}${pl ? ' · ' + pl : ''}`;
          frag.append(p);
        }
      }
      frag.append(cardEl(e));
    }
    state.rendered = end;
    list.append(frag);
  }

  function showList() {
    const wasList = state.current === 'list';
    showView('list');
    if (!wasList) requestAnimationFrame(() => window.scrollTo(0, state.listScroll));
  }

  // ---------- Läsvy ----------
  function neighbours(e) {
    const list = state.view.includes(e) ? state.view : state.entries;
    const i = list.indexOf(e);
    return { older: list[i + 1], newer: list[i - 1] };
  }

  function showEntry(row) {
    const e = state.entries.find(x => x.row === row);
    if (!e) { location.replace('#/'); return; }
    const sameEntry = state.current === 'entry' && state.shown === e;
    state.shown = e;
    $('#entryArticle').dataset.kind = weatherKind(e.weather);
    $('#eWx').textContent = KIND_ICON[weatherKind(e.weather)];
    $('#eYear').textContent = e.date ? e.date.slice(0, 4) : '';
    $('#eDate').textContent = e.date ? cap(fmtLong.format(toDate(e.date))) : 'Utan datum';
    $('#eMeta').innerHTML =
      (e.place ? `<span class="pill">${ICON.pin}${esc(e.place)}</span>` : '') +
      (e.weather ? `<span class="pill">${weatherIcon(e.weather)} ${esc(e.weather)}</span>` : '');
    const body = $('#eText');
    body.innerHTML = runsToHtml(e.text, e.runs) || '<span class="muted">Ingen text.</span>';
    highlightIn(body, state.terms);
    const { older, newer } = neighbours(e);
    const ob = $('#olderBtn'), nb = $('#newerBtn');
    ob.disabled = !older;
    nb.disabled = !newer;
    ob.title = older && older.date ? fmtShort.format(toDate(older.date)) : '';
    nb.title = newer && newer.date ? fmtShort.format(toDate(newer.date)) : '';
    showView('entry');
    if (!sameEntry) window.scrollTo(0, 0);
    const mark = body.querySelector('mark');
    if (mark) mark.scrollIntoView({ block: 'center' });
  }

  function step(dir) {
    if (state.current !== 'entry' || !state.shown) return;
    const n = neighbours(state.shown)[dir];
    if (n) location.replace('#/e/' + n.row);
  }

  // ---------- Skrivvy ----------
  const draftKey = () => 'draft.' + (state.editing ? state.editing.row : 'new');
  let draftTimer;

  function readForm() {
    return { date: $('#fDate').value, place: $('#fPlace').value, weather: $('#fWeather').value, html: $('#fText').innerHTML };
  }

  function saveDraft() {
    clearTimeout(draftTimer);
    draftTimer = setTimeout(() => { state.dirty = true; store.set(draftKey(), readForm()); }, 400);
  }

  function showEdit(row) {
    const e = row ? state.entries.find(x => x.row === row) : null;
    if (row && !e) { location.replace('#/'); return; }
    if (state.current === 'edit' && state.editing === e) return;
    state.editing = e;
    state.dirty = false;
    const draft = store.get(draftKey());
    const src = draft || (e
      ? { date: e.date, place: e.place, weather: e.weather, html: runsToHtml(e.text, e.runs) }
      : { date: todayStr(), place: '', weather: '', html: '' });
    $('#editTitle').textContent = e ? 'Redigera' : 'Ny anteckning';
    $('#fDate').value = src.date || todayStr();
    $('#fPlace').value = src.place || '';
    $('#fWeather').value = src.weather || '';
    $('#fText').innerHTML = src.html || '';
    $('#saveBtn').textContent = 'Spara';
    showView('edit');
    window.scrollTo(0, 0);
    if (draft) { state.dirty = true; toast('Ett osparat utkast återställdes'); }
    if (!e && !draft) locate(false);
  }

  // Den lokala orten (by, småort, stadsdel) går före kommun och stad.
  // OpenStreetMap är mest finkornigt; BigDataCloud används om det inte svarar.
  async function placeName(lat, lon) {
    try {
      const r = await fetch(`https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=16&accept-language=sv&lat=${lat}&lon=${lon}`);
      const a = (await r.json()).address || {};
      const p = a.village || a.hamlet || a.suburb || a.neighbourhood || a.town || a.city_district || a.city || a.municipality;
      if (p) return p.split(' / ')[0];
    } catch { /* prova nästa */ }
    const r = await fetch(`https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=${lat}&longitude=${lon}&localityLanguage=sv`);
    const j = await r.json();
    return j.locality || j.city || j.principalSubdivision || '';
  }

  async function locate(force) {
    if (!navigator.geolocation) { if (force) toast('Telefonen kan inte dela plats här'); return; }
    const btn = $('#locBtn');
    btn.classList.add('busy');
    try {
      const c = await new Promise((res, rej) => navigator.geolocation.getCurrentPosition(
        p => res(p.coords), rej, { enableHighAccuracy: true, timeout: 20000, maximumAge: 2 * 60e3 }));
      const lat = c.latitude.toFixed(4), lon = c.longitude.toFixed(4);
      // Dagens väder och högsta temperatur för anteckningens datum, inte vädret just nu.
      // Open-Meteo har dagsdata från ca 3 månader bakåt till 2 veckor framåt.
      const day = $('#fDate').value || todayStr();
      const diff = (toDate(day) - toDate(todayStr())) / 864e5;
      const range = diff >= -90 && diff <= 14 ? `&start_date=${day}&end_date=${day}` : '&forecast_days=1';
      const [wx, pl] = await Promise.allSettled([
        fetch(`https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&daily=weather_code,temperature_2m_max&timezone=auto${range}`).then(r => r.json()),
        placeName(lat, lon)
      ]);
      const daily = wx.status === 'fulfilled' && wx.value.daily;
      if (daily && daily.time && daily.time.length) {
        const max = daily.temperature_2m_max[0];
        const txt = [wmoText(daily.weather_code[0]), max == null ? '' : Math.round(max) + '°'].filter(Boolean).join(', ');
        if (txt && (force || !$('#fWeather').value)) $('#fWeather').value = txt;
      }
      if (pl.status === 'fulfilled') {
        const p = pl.value;
        if (p && (force || !$('#fPlace').value)) $('#fPlace').value = p;
      }
      if (force && wx.status === 'rejected' && pl.status === 'rejected') toast('Kunde inte hämta plats och väder');
      saveDraft();
    } catch (err) {
      if (force) toast(err && err.code === 1 ? 'Platsåtkomst är avstängd för sidan' : 'Kunde inte hitta platsen');
    } finally {
      btn.classList.remove('busy');
    }
  }

  async function onSave(ev) {
    ev.preventDefault();
    const rich = editorToRich($('#fText'));
    const data = {
      date: $('#fDate').value,
      place: $('#fPlace').value.trim(),
      weather: $('#fWeather').value.trim(),
      ...rich
    };
    if (!data.date) { toast('Välj ett datum'); return; }
    if (!data.text.trim()) { toast('Skriv något först'); return; }
    const btn = $('#saveBtn');
    btn.classList.add('busy');
    btn.textContent = 'Sparar…';
    try {
      if (!DEMO && !tokenValid()) await signIn();
      const e = state.editing;
      const res = await persist(e, data);
      clearTimeout(draftTimer);
      store.del(draftKey());
      const entry = makeEntry({ row: res.row, created: res.created, date: data.date, weather: data.weather, text: data.text, runs: data.runs, place: data.place });
      if (e) state.entries[state.entries.indexOf(e)] = entry;
      else state.entries.push(entry);
      sortEntries();
      if (!DEMO) saveCache();
      state.dirty = false;
      state.editing = null;
      applyFilters();
      toast('Sparat ✓');
      if (e && state.navigated) history.back();
      else location.replace('#/e/' + entry.row);
    } catch (err) {
      btn.textContent = err.auth ? 'Logga in och spara' : 'Försök igen';
      toast(err.auth ? 'Inloggningen gick ut. Tryck igen för att spara – texten finns kvar.' : 'Kunde inte spara: ' + err.message, 6000);
    } finally {
      btn.classList.remove('busy');
    }
  }

  function onCancel() {
    if (state.dirty && !confirm('Vill du slänga ändringarna?')) return;
    clearTimeout(draftTimer);
    store.del(draftKey());
    state.dirty = false;
    state.editing = null;
    goBack();
  }

  // ---------- Inställningar ----------
  function setScale(v) {
    v = Math.min(2.4, Math.max(0.85, Math.round(v * 100) / 100));
    document.documentElement.style.setProperty('--scale', v);
    $('#sizeRange').value = v;
    store.set('scale', v);
    measureTopbar();
  }

  function setTheme(t) {
    if (t === 'auto') delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = t;
    store.set('theme', t);
    document.querySelectorAll('#themeSeg button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.theme === t)));
    requestAnimationFrame(() => {
      document.querySelector('meta[name="theme-color"]').content = getComputedStyle(document.documentElement).getPropertyValue('--bg').trim();
    });
  }

  function openSheet() {
    $('#sizeRange').value = getComputedStyle(document.documentElement).getPropertyValue('--scale').trim() || 1;
    $('#settingsSheet').hidden = false;
  }
  const closeSheet = () => { $('#settingsSheet').hidden = true; };

  function measureTopbar() {
    document.documentElement.style.setProperty('--topbar-h', $('#topbar').offsetHeight + 'px');
  }

  // ---------- Koppla knappar ----------
  function bind() {
    window.addEventListener('hashchange', () => { state.navigated = true; route(); });
    window.addEventListener('scroll', () => $('#topbar').classList.toggle('scrolled', window.scrollY > 4), { passive: true });
    new ResizeObserver(measureTopbar).observe($('#topbar'));

    new IntersectionObserver(es => {
      if (es[0].isIntersecting && state.current === 'list' && state.rendered < state.view.length) renderMore();
    }, { rootMargin: '1500px' }).observe($('#sentinel'));

    $('#backBtn').onclick = () => (state.current === 'edit' ? onCancel() : goBack());
    $('#fab').onclick = () => { location.hash = '#/new'; };

    // Sök
    $('#searchBtn').onclick = () => {
      const bar = $('#searchbar');
      bar.hidden = !bar.hidden;
      if (!bar.hidden) { window.scrollTo(0, 0); $('#searchInput').focus(); }
      else if ($('#searchInput').value) { $('#searchInput').value = ''; applyFilters(); }
    };
    let searchTimer;
    $('#searchInput').addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(applyFilters, 180); });
    $('#searchInput').addEventListener('keydown', e => { if (e.key === 'Enter') e.target.blur(); });
    $('#searchClear').onclick = () => { $('#searchInput').value = ''; applyFilters(); $('#searchInput').focus(); };

    // Läsvy
    $('#olderBtn').onclick = () => step('older');
    $('#newerBtn').onclick = () => step('newer');
    $('#editBtn').onclick = () => { if (state.shown) location.hash = '#/edit/' + state.shown.row; };
    const art = $('#entryArticle');
    let sx = null, sy = 0, st = 0;
    art.addEventListener('touchstart', e => {
      if (e.touches.length !== 1) { sx = null; return; }
      sx = e.touches[0].clientX; sy = e.touches[0].clientY; st = Date.now();
    }, { passive: true });
    art.addEventListener('touchend', e => {
      if (sx == null) return;
      const t = e.changedTouches[0];
      const dx = t.clientX - sx, dy = t.clientY - sy;
      sx = null;
      // Ignorera svep när sidan är inzoomad, så att man kan flytta runt i texten.
      if (window.visualViewport && window.visualViewport.scale > 1.05) return;
      if (Math.abs(dx) > 80 && Math.abs(dx) > Math.abs(dy) * 2 && Date.now() - st < 700 && !String(getSelection())) {
        step(dx < 0 ? 'newer' : 'older');
      }
    }, { passive: true });
    document.addEventListener('keydown', e => {
      if (state.current !== 'entry' || e.target.closest('input, [contenteditable]')) return;
      if (e.key === 'ArrowLeft') step('older');
      if (e.key === 'ArrowRight') step('newer');
    });

    // Skrivvy
    const ed = $('#fText');
    $('#editForm').addEventListener('submit', onSave);
    $('#editForm').addEventListener('input', saveDraft);
    $('#cancelBtn').onclick = onCancel;
    $('#locBtn').onclick = () => locate(true);
    ed.addEventListener('focus', () => { try { document.execCommand('styleWithCSS', false, false); } catch { /* äldre webbläsare */ } });
    ed.addEventListener('paste', e => {
      // Klistra in som ren text så att det inte följer med konstig formatering.
      e.preventDefault();
      const t = (e.clipboardData || window.clipboardData).getData('text/plain');
      document.execCommand('insertText', false, t);
    });
    document.querySelectorAll('.toolbar button').forEach(b => {
      b.addEventListener('mousedown', e => e.preventDefault());
      b.addEventListener('click', () => {
        ed.focus();
        document.execCommand(b.dataset.cmd);
        updateToolbar();
        saveDraft();
      });
    });
    const updateToolbar = () => {
      if (document.activeElement !== ed) return;
      document.querySelectorAll('.toolbar button').forEach(b => {
        let on = false;
        try { on = document.queryCommandState(b.dataset.cmd); } catch { /* ignoreras */ }
        b.setAttribute('aria-pressed', String(on));
      });
    };
    document.addEventListener('selectionchange', updateToolbar);

    // Inställningar
    $('#settingsBtn').onclick = openSheet;
    $('#sheetClose').onclick = closeSheet;
    $('#settingsSheet').addEventListener('click', e => { if (e.target.id === 'settingsSheet') closeSheet(); });
    document.addEventListener('keydown', e => { if (e.key === 'Escape') closeSheet(); });
    $('#sizeRange').addEventListener('input', e => setScale(+e.target.value));
    $('#sizeDown').onclick = () => setScale(+$('#sizeRange').value - 0.15);
    $('#sizeUp').onclick = () => setScale(+$('#sizeRange').value + 0.15);
    document.querySelectorAll('#themeSeg button').forEach(b => { b.onclick = () => setTheme(b.dataset.theme); });
    $('#refreshBtn').onclick = async () => {
      closeSheet();
      try { if (!tokenValid()) await signIn(); await refresh(false); }
      catch (err) { toast(err.message); }
    };
    $('#changeSheetBtn').onclick = () => {
      closeSheet();
      if (CFG.spreadsheetId) { toast('Kalkylarket är inställt i config.js'); return; }
      store.del('sheet'); store.del('cache');
      state.ready = false;
      showSetup();
    };
    $('#logoutBtn').onclick = () => {
      if (!confirm('Logga ut från dagboken på den här enheten?')) return;
      closeSheet();
      signOut();
      showLogin();
    };

    // Inloggning och koppling
    const doLogin = async btn => {
      btn.classList.add('busy');
      try {
        await signIn();
        $('#syncBanner').hidden = true;
        if (!sheetKey()) showSetup();
        else await refresh(true);
      }
      catch (err) { if (state.ready) toast(err.message); else showLogin(err.message); }
      finally { btn.classList.remove('busy'); }
    };
    $('#loginBtn').onclick = () => doLogin($('#loginBtn'));
    $('#bannerLogin').onclick = () => doLogin($('#bannerLogin'));
    $('#sheetSave').onclick = async () => {
      const v = $('#sheetInput').value.trim();
      const m = v.match(/\/d\/([a-zA-Z0-9_-]{20,})/) || v.match(/^([a-zA-Z0-9_-]{20,})$/);
      if (!m) { showSetup('Det där ser inte ut som en länk till ett Google Sheet.'); return; }
      store.set('sheet', m[1]);
      try {
        if (!tokenValid()) await signIn();
        showView('loading');
        await refresh(true);
      } catch (err) { showSetup(err.message); }
    };
  }

  // ---------- Demo ----------
  function demoEntries() {
    const y = new Date().getFullYear();
    const md = todayStr().slice(5);
    const raw = [
      [`${y}-${md}`, 'Halvklart, 14°', 'Hemma', 'Lugn morgon med kaffe på balkongen. **Äntligen** hemma igen efter resan, det känns skönt att sova i den egna sängen.\n\nPå eftermiddagen tog vi en lång promenad runt sjön. Löven har börjat gulna.'],
      [`${y - 1}-${md}`, 'Sol', 'Lissabon', 'Vi åkte spårvagn 28 genom gamla stan och åt pastéis de nata på ett litet kafé. *Så goda!*\n\nKvällen avslutades med fado på en liten restaurang.'],
      [`${y - 1}-09-24`, 'Sol', 'Peñíscola', 'Körde söderut i fyra timmar. Vi står på en ställplats strax norr om stan, med gångavstånd till stranden. Kvällspromenad längs vattnet.'],
      [`${y - 1}-09-23`, 'Mest sol', 'Palamós', 'Marknadsdag! Vi köpte en stor sarong att ha som solskydd vid markisen. Lunch med empanadas och sallad. Läste en stund i skuggan på eftermiddagen.'],
      [`${y - 1}-09-22`, 'Sol', 'Palamós', 'Svalare idag och lägre luftfuktighet – **underbart**. Elsparkarna ner till hamnen på förmiddagen och strandpromenad på eftermiddagen.\n\nEn svart katt kom och la sig i mitt knä när jag läste.'],
      [`${y - 1}-08-15`, 'Regn', 'Göteborg', 'Regnig dag, så det blev museum och fika. Vi planerade höstens resa vid köksbordet med kartor utspridda överallt.'],
      [`${y - 2}-12-24`, 'Snö, -3°', 'Dalarna', 'Julafton! Snön föll stilla hela förmiddagen. Skinka, Kalle Anka och alldeles för mycket godis.'],
      [`${y - 2}-06-21`, 'Sol, 22°', 'Öland', 'Midsommar med sill, jordgubbar och dans kring stången. Ljust hela natten.']
    ];
    return raw.map(([date, weather, place, md2], i) => {
      // Enkel markdown (**fet**, *kursiv*) till text + formatering, bara för demon.
      let text = '';
      const runs = [];
      md2.split(/(\*\*[^*]+\*\*|\*[^*]+\*)/).forEach(part => {
        if (!part) return;
        const b = part.startsWith('**'), it = !b && part.startsWith('*');
        const flags = b ? 'b' : it ? 'i' : '';
        const str = b ? part.slice(2, -2) : it ? part.slice(1, -1) : part;
        runs.push([text.length, flags]);
        text += str;
      });
      return makeEntry({ row: i + 2, created: `${date} 20:00:00`, date, weather, text, runs: runs.length === 1 && !runs[0][1] ? [] : runs, place });
    });
  }

  // ---------- Start ----------
  async function start() {
    bind();
    setTheme(store.get('theme', 'auto'));
    if (DEMO) {
      state.entries = demoEntries();
      sortEntries();
      state.ready = true;
      CFG.title = (CFG.title || 'Dagboken') + ' (demo)';
      applyFilters();
      route();
      return;
    }
    if (!CFG.clientId || /DIN-CLIENT-ID/.test(CFG.clientId)) {
      showLogin('Sidan är inte färdigkonfigurerad: Client ID saknas i config.js. Se README.');
      $('#loginBtn').hidden = true;
      return;
    }
    const tok = store.get('token');
    if (tok && tok.exp > Date.now() + 60e3) state.token = tok.value;

    const hasSheet = !!sheetKey();
    if (hasSheet && loadCache()) {
      state.ready = true;
      applyFilters();
      route();
      if (!state.token) $('#syncBanner').hidden = false;
    }
    try { await initGis(); }
    catch (err) { if (!state.ready) { showLogin(err.message); return; } }

    if (!hasSheet) { state.token ? showSetup() : showLogin(); return; }
    if (state.token) refresh(true);
    else if (!state.ready) showLogin();
  }

  start();
})();
