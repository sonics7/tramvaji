/* Tramvaji – red vožnje (ZET Zagreb)
 * Vozni red: data/ (priprema GitHub svaku noć iz ZET-ovog GTFS-a)
 * Uživo: ZET GTFS-realtime preko vlastitog Workera (config.js -> rtUrl)
 * Odabiri se čuvaju samo na ovom uređaju (localStorage). */
'use strict';
(function () {
  const CFG = window.ZET_CONFIG || {};
  const KEY = 'tramvaji.v1';
  const RT_EVERY = 30e3, DRAW_EVERY = 10e3;
  const $ = s => document.querySelector(s);
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const pad = n => String(n).padStart(2, '0');
  const numSort = (a, b) => (parseInt(a, 10) || 9999) - (parseInt(b, 10) || 9999) || String(a).localeCompare(String(b));
  const norm = s => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd');

  // ---------------- Postavke (po uređaju) ----------------
  let S;
  try { S = JSON.parse(localStorage.getItem(KEY)); } catch (e) { S = null; }
  if (!S || !Array.isArray(S.groups) || !S.groups.length) {
    S = { cur: 0, groups: [{ name: 'Od kuće', items: [] }, { name: 'S posla', items: [] }] };
  }
  if (!(S.cur >= 0 && S.cur < S.groups.length)) S.cur = 0;
  const save = () => { try { localStorage.setItem(KEY, JSON.stringify(S)); } catch (e) {} };
  const group = () => S.groups[S.cur];

  // ---------------- Podaci ----------------
  let meta = null, stops = null, stopIdx = {}, services = null, lines = null;
  const stopFiles = {};      // ime -> Promise<{n,h,t}>
  let ver = '';

  async function getJson(p, fresh) {
    const r = await fetch('data/' + p + (fresh ? '?t=' + Date.now() : '?v=' + encodeURIComponent(ver)), { cache: fresh ? 'no-store' : 'default' });
    if (!r.ok) throw new Error('HTTP ' + r.status + ' ' + p);
    return r.json();
  }
  async function loadBase() {
    try { meta = await getJson('meta.json', true); } catch (e) { meta = meta || null; }
    const nv = meta ? meta.version + '|' + meta.built : 'x';
    if (nv !== ver) { ver = nv; stops = null; services = null; lines = null; for (const k in stopFiles) delete stopFiles[k]; }
    if (!stops) {
      stops = await getJson('stops.json');
      stopIdx = {}; stops.forEach((s, i) => { stopIdx[s.n] = i; });
    }
    if (!services) services = await getJson('services.json');
  }
  async function getLines() { if (!lines) lines = await getJson('lines.json'); return lines; }
  function stopFile(name) {
    if (!(name in stopIdx)) return Promise.resolve(null);
    if (!stopFiles[name]) stopFiles[name] = getJson('s/' + stopIdx[name] + '.json').catch(e => { delete stopFiles[name]; throw e; });
    return stopFiles[name];
  }

  function ymd(d) { return d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()); }
  function svcOn(i, date8, dow) {
    const x = services[i];
    if (!x) return false;
    if (x.rem.indexOf(date8) >= 0) return false;
    if (x.add.indexOf(date8) >= 0) return true;
    return !!x.days[dow] && (!x.from || date8 >= x.from) && (!x.to || date8 <= x.to);
  }

  // ---------------- Uživo (GTFS-realtime, protobuf bez paketa) ----------------
  let rt = { at: 0, trips: {} }, rtErr = '', rtBusy = null;
  function pbFields(b, dv, s, e) {
    const out = [], p = { i: s };
    const varint = () => {
      const st = p.i; let r = 0, mul = 1, c;
      do { c = b[p.i++]; r += (c & 127) * mul; mul *= 128; } while (c & 128 && p.i < e + 10);
      if (p.i - st >= 10) {   // negativan broj
        let big = 0n; for (let k = p.i - 1; k >= st; k--) big = (big << 7n) | BigInt(b[k] & 127);
        return Number(BigInt.asIntN(64, big));
      }
      return r;
    };
    while (p.i < e) {
      const key = varint(), f = Math.floor(key / 8), t = key & 7;
      if (t === 0) out.push({ f, v: varint() });
      else if (t === 2) { const l = varint(); out.push({ f, s: p.i, e: p.i + l }); p.i += l; }
      else if (t === 1) { out.push({ f, v: dv.getFloat64(p.i, true) }); p.i += 8; }
      else if (t === 5) { out.push({ f, v: dv.getFloat32(p.i, true) }); p.i += 4; }
      else throw new Error('protobuf tip ' + t);
    }
    return out;
  }
  const dec = new TextDecoder();
  const str = (b, x) => dec.decode(b.subarray(x.s, x.e));
  function parseRt(buf) {
    const b = new Uint8Array(buf), dv = new DataView(buf), trips = {};
    pbFields(b, dv, 0, b.length).filter(x => x.f === 2 && x.s != null).forEach(ent => {
      const tu = pbFields(b, dv, ent.s, ent.e).find(x => x.f === 3 && x.s != null);
      if (!tu) return;
      let id = '', canceled = false; const upd = [];
      pbFields(b, dv, tu.s, tu.e).forEach(x => {
        if (x.f === 1 && x.s != null) pbFields(b, dv, x.s, x.e).forEach(y => {
          if (y.f === 1 && y.s != null) id = str(b, y);
          if (y.f === 4 && y.v === 3) canceled = true;
        });
        if (x.f === 2 && x.s != null) {
          const u = { seq: null, delay: null, time: null, skip: false };
          pbFields(b, dv, x.s, x.e).forEach(y => {
            if (y.f === 1) u.seq = y.v;
            else if (y.f === 5 && y.v === 1) u.skip = true;
            else if ((y.f === 2 || y.f === 3) && y.s != null) pbFields(b, dv, y.s, y.e).forEach(z => {
              if (z.f === 1 && u.delay == null) u.delay = z.v;
              if (z.f === 2 && u.time == null) u.time = z.v;
            });
          });
          upd.push(u);
        }
      });
      if (id) trips[id] = { canceled, upd: upd.sort((a, c) => (a.seq || 0) - (c.seq || 0)) };
    });
    return trips;
  }
  function loadRt() {
    if (!CFG.rtUrl) return Promise.resolve();
    if (rtBusy) return rtBusy;
    const ctl = new AbortController(); const to = setTimeout(() => ctl.abort(), 12000);
    rtBusy = fetch(CFG.rtUrl, { cache: 'no-store', signal: ctl.signal })
      .then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.arrayBuffer(); })
      .then(buf => { rt = { at: Date.now(), trips: parseRt(buf) }; rtErr = ''; })
      .catch(e => { rtErr = e.name === 'AbortError' ? 'isteklo vrijeme' : e.message; })
      .finally(() => { clearTimeout(to); rtBusy = null; });
    return rtBusy;
  }

  // ---------------- Polasci ----------------
  function departures(file, item, now) {
    const live = Date.now() - rt.at < 3 * 60e3;
    const days = [-1, 0, 1].map(k => { const d = new Date(now); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() + k); return d; });
    const list = [];
    for (const t of file.t) {
      if (t[1] !== item.route || t[2] !== item.dir) continue;
      for (const d of days) {
        const sched = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, t[5]).getTime(); // točno i kod promjene ljetnog/zimskog vremena
        if (sched < now - 30 * 60e3 || sched > now + 14 * 3600e3) continue;
        if (!svcOn(t[4], ymd(d), d.getDay())) continue;
        let at = sched, isLive = false;
        const r = live && rt.trips[t[0]];
        if (r) {
          if (r.canceled) continue;
          const exact = r.upd.find(u => u.seq === t[6]);
          if (exact && exact.skip) continue;
          let best = null;
          r.upd.forEach(u => { if (u.seq != null && u.seq <= t[6] && u.delay != null) best = u; });
          if (exact && exact.time) at = exact.time * 1000;
          else if (best) at = sched + best.delay * 1000;
          else if (r.upd[0] && r.upd[0].delay != null && r.upd[0].delay > 0) at = sched + r.upd[0].delay * 1000;
          isLive = true;
        }
        if (at < now - 20e3) continue;
        list.push({ at, sched, live: isLive, head: file.h[t[3]] });
      }
    }
    list.sort((a, b) => a.at - b.at);
    return list.slice(0, 3);
  }

  // ---------------- Glavni prikaz ----------------
  function badge(route, bus, extra) { return '<span class="badge' + (bus ? ' bus' : '') + (extra ? ' ' + extra : '') + '">' + esc(route) + '</span>'; }
  function fmtMin(at, now, first) {
    const m = Math.floor((at - now) / 60e3);
    if (m < 1) return first ? '<span class="first now">sada</span>' : '<span class="rest">0</span>';
    if (m >= 60) { const d = new Date(at); const t = d.getHours() + ':' + pad(d.getMinutes()); return first ? '<span class="first" style="font-size:24px">' + t + '</span>' : '<span class="rest">' + t + '</span>'; }
    return first ? '<span class="first">' + m + '</span>' : '<span class="rest">' + m + '</span>';
  }
  function renderTabs() {
    $('#tabs').innerHTML = S.groups.map((g, i) => '<button class="tab' + (i === S.cur ? ' on' : '') + '" data-g="' + i + '">' + esc(g.name) + '</button>').join('');
  }
  let drawing = 0;
  async function draw() {
    const my = ++drawing;
    const g = group();
    if (!g.items.length) {
      $('#rows').innerHTML = '<div class="empty">U grupi „' + esc(g.name) + '” još nema linija.<br><button class="btn" data-act="add">＋ Dodaj liniju</button></div>';
      status();
      return;
    }
    try { await loadBase(); } catch (e) {
      $('#rows').innerHTML = '<div class="empty">Vozni red nije dostupan.<br><small>' + esc(e.message) + '</small></div>';
      return;
    }
    const now = Date.now();
    const files = await Promise.all(g.items.map(it => stopFile(it.stop).catch(() => null)));
    if (my !== drawing) return;
    $('#rows').innerHTML = g.items.map((it, i) => {
      const f = files[i];
      const next = f ? departures(f, it, now) : [];
      const head = next[0] ? next[0].head : (it.head || '');
      const live = next.some(x => x.live);
      let mins;
      if (!f) mins = '<span class="none">stanica nije u voznom redu</span>';
      else if (!next.length) mins = '<span class="none">nema polazaka</span>';
      else mins = next.map((x, k) => fmtMin(x.at, now, k === 0)).join('<span class="sep">·</span>');
      return '<div class="row">' + badge(it.route, it.bus) +
        '<div class="where"><span class="one"><span class="from">' + esc(it.stop) + ' →</span> <span class="to">' + esc(head) + '</span></span></div>' +
        '<div class="mins">' + mins + '</div><span class="dot' + (live ? ' live' : '') + '" title="' + (live ? 'uživo' : 'po voznom redu') + '"></span></div>';
    }).join('');
    status();
  }
  function status() {
    const parts = [];
    if (!CFG.rtUrl) parts.push('Prikaz po voznom redu (uživo nije postavljeno)');
    else if (rtErr) parts.push('Uživo nedostupno (' + rtErr + ') – prikaz po voznom redu');
    else if (rt.at) { const d = new Date(rt.at); parts.push('Uživo osvježeno u ' + d.getHours() + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds())); }
    if (meta) parts.push('vozni red ' + meta.version);
    $('#status').textContent = parts.join(' · ');
  }

  async function refresh() {
    if (document.hidden) return;
    draw();
    if (group().items.length) { await loadRt(); draw(); }
  }

  // ---------------- Obavijesti ZET-a (izvanredne + izmjene u prometu) ----------------
  const NEWS_EVERY = 5 * 60e3, SEEN = 'tramvaji.procitano';
  const newsUrl = CFG.newsUrl || (CFG.rtUrl ? CFG.rtUrl.replace(/\/rt\/?$/, '/vijesti') : '');
  let news = [], newsAt = 0;
  let seen = []; try { seen = JSON.parse(localStorage.getItem(SEEN)) || []; } catch (e) {}
  const saveSeen = () => { try { localStorage.setItem(SEEN, JSON.stringify(seen.slice(-200))); } catch (e) {} };
  function myLines() { const s = {}; S.groups.forEach(g => g.items.forEach(it => { s[String(it.route).toUpperCase()] = 1; })); return s; }
  // Važno za korisnika: izvanredna obavijest, izmjena na nekoj od njegovih linija, ili nedavna opća obavijest (bez broja linije)
  function classify() {
    const mine = myLines(), now = Date.now();
    news.forEach(n => {
      n.mineLines = (n.lines || []).filter(l => mine[l]);
      n.relevant = !!(n.urgent || n.mineLines.length || (!(n.lines || []).length && n.at && now - n.at < 4 * 864e5));
    });
    news.sort((a, b) => (b.urgent - a.urgent) || (b.relevant - a.relevant) || (b.at - a.at));
  }
  async function loadNews() {
    if (!newsUrl || Date.now() - newsAt < NEWS_EVERY - 5000) return;
    newsAt = Date.now();
    try {
      const r = await fetch(newsUrl, { cache: 'no-store' });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const j = await r.json();
      news = (j.items || []).filter(n => n && n.title);
    } catch (e) { newsAt = Date.now() - NEWS_EVERY + 60e3; }   // novi pokušaj za minutu
    renderBanner();
  }
  function renderBanner() {
    classify();
    const unread = news.filter(n => n.relevant && seen.indexOf(n.id) < 0);
    $('#newsBtn').classList.toggle('hidden', !news.length);
    $('#newsCount').classList.toggle('hidden', !unread.length);
    $('#newsCount').textContent = unread.length;
    const b = $('#banner');
    if (!unread.length || view) { b.classList.add('hidden'); document.querySelector('main').classList.remove('with-banner'); return; }
    const n = unread[0];
    b.classList.toggle('urgent', !!n.urgent);
    $('#bTitle').textContent = n.title;
    $('#bMore').textContent = (n.urgent ? 'Izvanredna obavijest' : n.mineLines.length ? 'Linij' + (n.mineLines.length > 1 ? 'e ' : 'a ') + n.mineLines.join(', ') : 'Izmjena u prometu') +
      (unread.length > 1 ? ' · još ' + (unread.length - 1) : '') + ' · dodirni za cijelu vijest';
    b.classList.remove('hidden');
    document.querySelector('main').classList.add('with-banner');
  }
  function markRead(list) { list.forEach(n => { if (seen.indexOf(n.id) < 0) seen.push(n.id); }); saveSeen(); }
  function fmtDate(at) { if (!at) return ''; const d = new Date(at); return d.getDate() + '. ' + (d.getMonth() + 1) + '. ' + d.getFullYear() + '.'; }
  function newsCard(n, open) {
    const chips = (n.lines || []).map(l => '<span class="chip' + ((lines || []).some(x => x.r === l && x.bus) || +l >= 100 ? ' bus' : '') + '">' + esc(l) + '</span>').join('');
    const meta = '<div class="meta">' + (n.urgent ? '<b style="color:#e4646a">Izvanredno</b>' : esc(fmtDate(n.at))) + chips + '</div>';
    const bodyTxt = n.urgent && n.text.indexOf(n.title) === 0 ? n.text.slice(n.title.length).trim() : n.text;
    const inner = '<div class="body">' + esc(bodyTxt) + '</div><a class="src" href="' + esc(n.link || 'https://www.zet.hr/') + '" target="_blank" rel="noopener">Otvori na zet.hr ›</a>';
    const cls = 'news' + (n.urgent ? ' urgent' : n.mineLines && n.mineLines.length ? ' mine' : '');
    if (open) return '<div class="' + cls + '"><h3>' + esc(n.title) + '</h3>' + meta + inner + '</div>';
    return '<details class="' + cls + '"><summary>' + esc(n.title) + '<small>' + esc(fmtDate(n.at)) + ((n.lines || []).length ? ' · linije ' + esc(n.lines.join(', ')) : '') + '</small></summary>' + inner + '</details>';
  }

  // ---------------- Uređivanje ----------------
  let view = null;
  function openSheet(v) { view = v; $('#sheet').classList.remove('hidden'); $('#banner').classList.add('hidden'); renderSheet(); }
  function closeSheet() { $('#sheet').classList.add('hidden'); view = null; save(); renderTabs(); renderBanner(); draw(); loadRt().then(draw); }
  function setTitle(t) { $('#sheetTitle').textContent = t; }
  const body = () => $('#sheetBody');

  function renderSheet() {
    if (!view) return;
    const g = group();
    if (view.v === 'news') {
      setTitle('Obavijesti ZET-a');
      classify();
      const rel = news.filter(n => n.relevant), other = news.filter(n => !n.relevant);
      body().innerHTML = (rel.length ? rel.map(n => newsCard(n, true)).join('') : '<p class="note">Trenutno nema izvanrednih obavijesti ni izmjena na tvojim linijama.</p>') +
        (other.length ? '<div class="label">Ostale izmjene u prometu</div>' + other.map(n => newsCard(n, false)).join('') : '') +
        '<p class="note">Izvor: zet.hr (izvanredna obavijest s naslovnice i „Izmjene u prometu”). Osvježava se svakih 5 minuta.</p>';
      return;
    }
    if (view.v === 'group') {
      setTitle('Uredi grupu');
      body().innerHTML =
        '<div class="label">Naziv grupe</div><input id="gname" class="field" value="' + esc(g.name) + '" maxlength="30">' +
        '<div class="label">Linije u grupi</div>' +
        (g.items.length ? '<div class="list">' + g.items.map((it, i) =>
          '<div class="item">' + badge(it.route, it.bus) + '<div class="txt">' + esc(it.stop) + ' → <b>' + esc(it.head || '') + '</b><small>' + (it.bus ? 'autobus' : 'tramvaj') + '</small></div>' +
          '<div class="ctl"><button data-up="' + i + '" aria-label="Gore">▲</button><button data-down="' + i + '" aria-label="Dolje">▼</button><button class="x" data-del="' + i + '" aria-label="Ukloni">✕</button></div></div>').join('') + '</div>'
          : '<p class="note">Još nema linija.</p>') +
        '<button class="btn wide" data-act="add">＋ Dodaj liniju</button>' +
        '<div class="label">Grupe</div>' +
        '<button class="btn ghost wide" data-act="newgroup">＋ Nova grupa</button>' +
        (S.cur > 0 ? '<button class="btn ghost wide" data-act="gleft">◀ Pomakni grupu ulijevo</button>' : '') +
        (S.groups.length > 1 ? '<button class="btn danger wide" data-act="delgroup">Obriši grupu „' + esc(g.name) + '”</button>' : '') +
        '<div class="label">Prijenos na drugi mobitel</div>' +
        '<p class="note">Postavke su spremljene samo na ovom mobitelu. Da ih preneseš (npr. supruzi kao početne), pošalji kod; ona ga zalijepi ispod i dalje uređuje svoje.</p>' +
        '<button class="btn ghost wide" data-act="export">Kopiraj / pošalji kod</button>' +
        '<input id="importCode" class="field" style="margin-top:10px" placeholder="Zalijepi kod ovdje">' +
        '<button class="btn ghost wide" data-act="import">Uvezi grupe iz koda</button>' +
        '<div class="label">Vozni red</div><p class="note">' + (meta ? 'Verzija ' + esc(meta.version) + ', pripremljeno ' + new Date(meta.built).toLocaleString('hr-HR') + '. ' + meta.stops + ' stanica, ' + meta.lines + ' linija.' : '') +
        ' Podaci: ZET (GTFS i GTFS-realtime).</p>';
      $('#gname').addEventListener('input', e => { g.name = e.target.value.trim() || 'Grupa'; save(); renderTabs(); });
      return;
    }
    if (view.v === 'lines') {
      setTitle('Dodaj liniju');
      const tab = view.tab || 'tram';
      const seg = '<div class="seg">' + [['tram', 'Tramvaji'], ['bus', 'Autobusi'], ['stop', 'Po stanici']].map(x => '<button data-tab="' + x[0] + '" class="' + (tab === x[0] ? 'on' : '') + '">' + x[1] + '</button>').join('') + '</div>';
      if (tab === 'stop') {
        body().innerHTML = seg + '<input id="q" class="field" placeholder="Upiši naziv stanice" value="' + esc(view.q || '') + '" autocomplete="off">' +
          '<button class="link" data-act="near">📍 Najbliže stanice</button><div id="res" class="list" style="margin-top:8px"></div>';
        const q = $('#q');
        q.addEventListener('input', () => { view.q = q.value; view.near = null; stopResults(); });
        stopResults();
        if (!view.q && !view.near) setTimeout(() => q.focus(), 50);
        return;
      }
      body().innerHTML = seg + '<input id="q" class="field" placeholder="Broj linije" inputmode="numeric" value="' + esc(view.q || '') + '" autocomplete="off"><div id="res" class="grid"></div>';
      const q = $('#q');
      const fill = () => {
        const want = tab === 'bus' ? 1 : 0, v = (q.value || '').trim();
        const ls = (lines || []).filter(l => l.bus === want && (!v || String(l.r).indexOf(v) === 0));
        $('#res').innerHTML = ls.length ? ls.map(l => '<button class="badge' + (l.bus ? ' bus' : '') + '" data-line="' + esc(l.r) + '">' + esc(l.r) + '</button>').join('') : '<p class="note">Nema takve linije.</p>';
      };
      q.addEventListener('input', () => { view.q = q.value; fill(); });
      if (!lines) { $('#res').innerHTML = '<p class="note">Učitavam…</p>'; loadBase().then(getLines).then(fill).catch(e => { $('#res').innerHTML = '<p class="note">' + esc(e.message) + '</p>'; }); }
      else fill();
      return;
    }
    if (view.v === 'dir') {
      const L = lines.find(l => l.r === view.line);
      setTitle((L.bus ? 'Autobus ' : 'Tramvaj ') + L.r);
      body().innerHTML = '<button class="back" data-act="toLines">‹ Linije</button><p class="note">Odaberi smjer vožnje:</p><div class="dirs">' +
        L.d.map((d, i) => '<button class="dirbtn" data-dir="' + i + '">→ ' + esc(d.h) + '<small>' + esc(stops[d.s[0]] ? stops[d.s[0]].n : '') + ' – ' + esc(stops[d.s[d.s.length - 1]] ? stops[d.s[d.s.length - 1]].n : '') + ' · ' + d.s.length + ' stanica</small></button>').join('') + '</div>';
      return;
    }
    if (view.v === 'stops') {
      const L = lines.find(l => l.r === view.line), D = L.d[view.di];
      setTitle(L.r + ' → ' + D.h);
      body().innerHTML = '<button class="back" data-act="toDir">‹ Smjer</button>' +
        '<input id="q" class="field" placeholder="Traži stanicu" value="' + esc(view.q2 || '') + '" autocomplete="off">' +
        '<button class="link" data-act="nearLine">📍 Označi najbližu</button>' +
        '<p class="note">Odaberi stanicu na kojoj ulaziš:</p><div id="res" class="list"></div>';
      const q = $('#q');
      const fill = () => {
        const v = norm(q.value);
        $('#res').innerHTML = D.s.map((si, k) => ({ si, k })).filter(x => !v || norm(stops[x.si].n).indexOf(v) >= 0).map(x => {
          const d = view.dist && view.dist[x.si];
          return '<button class="item pick" data-stop="' + x.si + '"><span class="txt">' + (x.k + 1) + '. ' + esc(stops[x.si].n) + '</span>' + (d != null ? '<span class="dist">' + fmtDist(d) + '</span>' : '') + '</button>';
        }).join('') || '<p class="note" style="padding:12px">Nema takve stanice.</p>';
      };
      q.addEventListener('input', () => { view.q2 = q.value; fill(); });
      fill();
      if (view.scrollTo != null) { const el = body().querySelector('[data-stop="' + view.scrollTo + '"]'); if (el) el.scrollIntoView({ block: 'center' }); view.scrollTo = null; }
      return;
    }
    if (view.v === 'stopLines') {
      const s = stops[view.si];
      setTitle(s.n);
      body().innerHTML = '<button class="back" data-act="toLines">‹ Stanice</button><p class="note">Linije koje polaze s ove stanice (dodirni za dodavanje):</p><div id="res" class="list"><p class="note" style="padding:12px">Učitavam…</p></div>';
      Promise.all([stopFile(s.n), getLines()]).then(([f]) => {
        const g2 = {};
        f.t.forEach(t => { const k = t[1] + '|' + t[2]; const x = g2[k] = g2[k] || { route: t[1], dir: t[2], heads: {}, n: 0 }; x.n++; const h = f.h[t[3]]; x.heads[h] = (x.heads[h] || 0) + 1; });
        const arr = Object.values(g2).sort((a, b) => numSort(a.route, b.route) || a.dir - b.dir);
        $('#res').innerHTML = arr.map(x => {
          const L = lines.find(l => l.r === x.route) || {};
          const head = Object.keys(x.heads).sort((a, b) => x.heads[b] - x.heads[a])[0];
          return '<button class="item pick" data-addr="' + esc(x.route) + '" data-adir="' + x.dir + '" data-ahead="' + esc(head) + '" data-abus="' + (L.bus ? 1 : 0) + '">' + badge(x.route, L.bus) + '<span class="txt">→ <b>' + esc(head) + '</b><small>' + (L.bus ? 'autobus' : 'tramvaj') + '</small></span></button>';
        }).join('');
      }).catch(e => { $('#res').innerHTML = '<p class="note" style="padding:12px">' + esc(e.message) + '</p>'; });
    }
  }

  function fmtDist(m) { return m < 1000 ? Math.round(m / 10) * 10 + ' m' : (m / 1000).toFixed(1).replace('.', ',') + ' km'; }
  function distM(a, b, c, d) {
    const R = 6371e3, r = Math.PI / 180, x = (d - b) * r * Math.cos((a + c) / 2 * r), y = (c - a) * r;
    return Math.sqrt(x * x + y * y) * R;
  }
  function locate() {
    return new Promise((res, rej) => {
      if (!navigator.geolocation) return rej(new Error('lokacija nije dostupna'));
      navigator.geolocation.getCurrentPosition(p => res(p.coords), e => rej(new Error(e.code === 1 ? 'pristup lokaciji nije dopušten' : 'lokacija nije dostupna')), { enableHighAccuracy: true, timeout: 12000, maximumAge: 60000 });
    });
  }
  function stopResults() {
    const res = $('#res'); if (!res) return;
    if (!stops) { res.innerHTML = '<p class="note" style="padding:12px">Učitavam…</p>'; loadBase().then(stopResults).catch(e => { res.innerHTML = '<p class="note" style="padding:12px">' + esc(e.message) + '</p>'; }); return; }
    let arr;
    if (view.near) arr = view.near;
    else {
      const v = norm(view.q);
      if (v.length < 2) { res.innerHTML = '<p class="note" style="padding:12px">Upiši barem 2 slova ili dodirni „Najbliže stanice”.</p>'; return; }
      arr = stops.map((s, i) => ({ i, s })).filter(x => norm(x.s.n).indexOf(v) >= 0).sort((a, b) => (norm(a.s.n).indexOf(v) === 0 ? 0 : 1) - (norm(b.s.n).indexOf(v) === 0 ? 0 : 1)).slice(0, 60);
    }
    res.innerHTML = arr.map(x => '<button class="item pick" data-si="' + x.i + '"><span class="txt">' + esc(x.s.n) +
      '<span class="chips">' + x.s.r.slice(0, 14).map(r => { const L = lines && lines.find(l => l.r === r); return '<span class="chip' + (L && L.bus ? ' bus' : '') + '">' + esc(r) + '</span>'; }).join('') + '</span></span>' +
      (x.d != null ? '<span class="dist">' + fmtDist(x.d) + '</span>' : '') + '</button>').join('') || '<p class="note" style="padding:12px">Nema takve stanice.</p>';
  }

  function addItem(route, dir, stop, head, bus) {
    const g = group();
    if (g.items.some(x => x.route === route && x.dir === dir && x.stop === stop)) { toast('Već je u grupi'); }
    else { g.items.push({ route, dir, stop, head, bus: bus ? 1 : 0 }); save(); toast('Dodano: ' + route + ' ' + stop + ' → ' + head); }
    openSheet({ v: 'group' });
  }
  function toast(t) {
    const el = document.createElement('div'); el.className = 'toast'; el.textContent = t;
    document.body.appendChild(el); setTimeout(() => el.remove(), 2200);
  }
  const b64e = s => btoa(unescape(encodeURIComponent(s)));
  const b64d = s => decodeURIComponent(escape(atob(s)));
  function exportCode() { return 'TRAM1:' + b64e(JSON.stringify(S.groups.map(g => ({ name: g.name, items: g.items })))); }
  function importCode(code) {
    const m = /TRAM1:([A-Za-z0-9+/=]+)/.exec(code || '');
    if (!m) throw new Error('Kod nije ispravan');
    const gs = JSON.parse(b64d(m[1]));
    if (!Array.isArray(gs)) throw new Error('Kod nije ispravan');
    let n = 0;
    gs.forEach(g => {
      if (!g || !Array.isArray(g.items)) return;
      const items = g.items.filter(x => x && x.route && x.stop).map(x => ({ route: String(x.route), dir: +x.dir || 0, stop: String(x.stop), head: String(x.head || ''), bus: x.bus ? 1 : 0 }));
      const ex = S.groups.find(x => x.name === g.name);
      if (ex) items.forEach(it => { if (!ex.items.some(y => y.route === it.route && y.dir === it.dir && y.stop === it.stop)) ex.items.push(it); });
      else S.groups.push({ name: String(g.name || 'Grupa').slice(0, 30), items });
      n++;
    });
    save();
    return n;
  }

  // ---------------- Događaji ----------------
  document.addEventListener('click', async e => {
    const t = e.target.closest('button'); if (!t) return;
    if (t.dataset.g != null) { S.cur = +t.dataset.g; save(); renderTabs(); refresh(); return; }
    if (t.id === 'editBtn') { openSheet({ v: 'group' }); return; }
    if (t.id === 'newsBtn') { openSheet({ v: 'news' }); return; }
    if (t.id === 'bClose') { e.stopPropagation(); markRead(news.filter(n => n.relevant)); renderBanner(); return; }
    if (t.hasAttribute('data-close')) { closeSheet(); return; }
    const g = group(), a = t.dataset.act;
    if (t.dataset.up != null) { const i = +t.dataset.up; if (i > 0) { g.items.splice(i - 1, 0, g.items.splice(i, 1)[0]); save(); renderSheet(); } return; }
    if (t.dataset.down != null) { const i = +t.dataset.down; if (i < g.items.length - 1) { g.items.splice(i + 1, 0, g.items.splice(i, 1)[0]); save(); renderSheet(); } return; }
    if (t.dataset.del != null) { g.items.splice(+t.dataset.del, 1); save(); renderSheet(); return; }
    if (t.dataset.tab) { view = { v: 'lines', tab: t.dataset.tab }; renderSheet(); return; }
    if (t.dataset.line) { view = { v: 'dir', line: t.dataset.line, tab: view.tab }; renderSheet(); return; }
    if (t.dataset.dir != null) { view = Object.assign({}, view, { v: 'stops', di: +t.dataset.dir, q2: '', dist: null }); renderSheet(); return; }
    if (t.dataset.stop != null) {
      const L = lines.find(l => l.r === view.line), D = L.d[view.di];
      addItem(L.r, D.d, stops[+t.dataset.stop].n, D.h, L.bus); return;
    }
    if (t.dataset.si != null) { view = { v: 'stopLines', si: +t.dataset.si, tab: 'stop', q: view.q, near: view.near }; renderSheet(); return; }
    if (t.dataset.addr != null) { addItem(t.dataset.addr, +t.dataset.adir, stops[view.si].n, t.dataset.ahead, t.dataset.abus === '1'); return; }
    switch (a) {
      case 'add':
        if (!view) openSheet({ v: 'lines', tab: 'tram' }); else { view = { v: 'lines', tab: 'tram' }; renderSheet(); }
        break;
      case 'toLines': view = { v: 'lines', tab: view.tab || 'tram', q: view.q, near: view.near }; renderSheet(); break;
      case 'toDir': view = { v: 'dir', line: view.line, tab: view.tab }; renderSheet(); break;
      case 'newgroup': {
        const name = (prompt('Naziv nove grupe (npr. Posao, Škola):') || '').trim();
        if (!name) break;
        S.groups.push({ name: name.slice(0, 30), items: [] }); S.cur = S.groups.length - 1; save(); renderTabs(); renderSheet(); break;
      }
      case 'gleft': if (S.cur > 0) { S.groups.splice(S.cur - 1, 0, S.groups.splice(S.cur, 1)[0]); S.cur--; save(); renderTabs(); } break;
      case 'delgroup':
        if (S.groups.length > 1 && confirm('Obrisati grupu „' + g.name + '”?')) { S.groups.splice(S.cur, 1); S.cur = 0; save(); renderTabs(); renderSheet(); }
        break;
      case 'export': {
        const code = exportCode();
        try {
          if (navigator.share) await navigator.share({ title: 'Tramvaji – postavke', text: code });
          else { await navigator.clipboard.writeText(code); toast('Kod je kopiran'); }
        } catch (err) {
          if (err && err.name === 'AbortError') break;
          try { await navigator.clipboard.writeText(code); toast('Kod je kopiran'); } catch (e2) { prompt('Kopiraj ovaj kod:', code); }
        }
        break;
      }
      case 'import':
        try { const n = importCode($('#importCode').value); toast('Uvezeno grupa: ' + n); renderTabs(); renderSheet(); } catch (err) { toast(err.message); }
        break;
      case 'near':
        try {
          await loadBase(); if (!lines) await getLines();
          toast('Tražim lokaciju…');
          const c = await locate();
          view.near = stops.map((s, i) => ({ i, s, d: s.lat == null ? 1e9 : distM(c.latitude, c.longitude, s.lat, s.lon) })).sort((x, y) => x.d - y.d).slice(0, 15);
          view.q = ''; renderSheet();
        } catch (err) { toast(err.message); }
        break;
      case 'nearLine':
        try {
          toast('Tražim lokaciju…');
          const c = await locate();
          const L = lines.find(l => l.r === view.line), D = L.d[view.di];
          view.dist = {}; let best = null;
          D.s.forEach(si => { const s = stops[si]; if (s.lat == null) return; const d = distM(c.latitude, c.longitude, s.lat, s.lon); view.dist[si] = d; if (!best || d < best.d) best = { si, d }; });
          view.q2 = ''; view.scrollTo = best && best.si; renderSheet();
        } catch (err) { toast(err.message); }
        break;
    }
  });
  $('#sheet').addEventListener('click', e => { if (e.target.id === 'sheet') closeSheet(); });
  const openNews = () => { markRead(news.filter(n => n.relevant)); openSheet({ v: 'news' }); };
  $('#banner').addEventListener('click', e => { if (!e.target.closest('#bClose')) openNews(); });
  $('#banner').addEventListener('keydown', e => { if (e.key === 'Enter') openNews(); });

  // ---------------- Pokretanje ----------------
  renderTabs();
  refresh();
  loadNews();
  setInterval(() => { if (!document.hidden) loadNews(); }, 60e3);
  setInterval(() => { if (!document.hidden && !view) draw(); }, DRAW_EVERY);
  setInterval(() => { if (!document.hidden && !view && group().items.length) loadRt().then(draw); }, RT_EVERY);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) { loadNews(); if (!view) refresh(); } });
  if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});

  // za testiranje
  window.__tram = { parseRt, departures, S, news: () => news };
})();
