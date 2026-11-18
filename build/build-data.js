#!/usr/bin/env node
// ZET vozni red -> male JSON datoteke za web-aplikaciju.
// Pokreće se jednom dnevno (GitHub Actions): skine ZET-ov GTFS zip i za svaku
// stanicu zapiše polaske, plus popis linija (smjerovi i redoslijed stanica).
//
//   node build/build-data.js app/data            (skida sa zet.hr)
//   node build/build-data.js app/data gtfs.zip   (iz lokalne datoteke, za test)
//
// Bez vanjskih paketa (samo Node 18+).
'use strict';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const OUT = path.resolve(process.argv[2] || 'app/data');
const LOCAL_ZIP = process.argv[3];
const ZET_STATIC = process.env.ZET_STATIC_URL || 'https://zet.hr/gtfs-scheduled/latest';

// ---------- zip (bez paketa) ----------
function unzip(buf, names) {
  let i = buf.length - 22;
  while (i >= 0 && buf.readUInt32LE(i) !== 0x06054b50) i--;
  if (i < 0) throw new Error('neispravan zip');
  const count = buf.readUInt16LE(i + 10);
  let p = buf.readUInt32LE(i + 16);
  const out = {};
  for (let k = 0; k < count; k++) {
    const method = buf.readUInt16LE(p + 10), csize = buf.readUInt32LE(p + 20);
    const nlen = buf.readUInt16LE(p + 28), xlen = buf.readUInt16LE(p + 30), clen = buf.readUInt16LE(p + 32), loff = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nlen).replace(/^.*\//, '');
    p += 46 + nlen + xlen + clen;
    if (names.indexOf(name) < 0) continue;
    const start = loff + 30 + buf.readUInt16LE(loff + 26) + buf.readUInt16LE(loff + 28);
    const data = buf.slice(start, start + csize);
    out[name] = method === 0 ? data : zlib.inflateRawSync(data);
  }
  return out;
}

// ---------- CSV ----------
function csvLine(line) {
  if (line.indexOf('"') < 0) return line.replace(/\r$/, '').split(',');
  const out = []; let cur = '', q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) { if (c === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c; }
    else if (c === '"') q = true;
    else if (c === ',') { out.push(cur); cur = ''; }
    else cur += c;
  }
  out.push(cur.replace(/\r$/, ''));
  return out;
}
// Prolazi kroz CSV po dijelovima (stop_times je ~80 MB)
function csv(buf, each) {
  if (!buf) return;
  let pos = 0, head = null;
  while (pos < buf.length) {
    let end = Math.min(buf.length, pos + 8e6);
    if (end < buf.length) { const nl = buf.indexOf(10, end); end = nl < 0 ? buf.length : nl + 1; }
    const lines = buf.toString('utf8', pos, end).split('\n');
    for (const line of lines) {
      if (!line.trim()) continue;
      if (!head) { head = csvLine(line.replace(/^﻿/, '')).map(h => h.trim()); continue; }
      const v = csvLine(line), o = {};
      for (let k = 0; k < head.length; k++) o[head[k]] = v[k] === undefined ? '' : v[k].trim();
      each(o);
    }
    pos = end;
  }
}
const toSec = t => { const m = /^(\d+):(\d\d):(\d\d)$/.exec(t || ''); return m ? +m[1] * 3600 + +m[2] * 60 + +m[3] : null; };
const numSort = (a, b) => (parseInt(a, 10) || 9999) - (parseInt(b, 10) || 9999) || String(a).localeCompare(String(b));

async function getZip() {
  if (LOCAL_ZIP) return fs.readFileSync(LOCAL_ZIP);
  const urls = [ZET_STATIC];
  // Rezerva: ako zet.hr odbije GitHub, preko vlastitog Workera (/gtfs)
  try {
    const cfg = fs.readFileSync(path.join(OUT, '..', 'config.js'), 'utf8');
    const m = /rtUrl\s*:\s*['"]([^'"]+)['"]/.exec(cfg);
    if (m && /^https:/.test(m[1])) urls.push(m[1].replace(/\/rt\/?$/, '') + '/gtfs');
  } catch (e) {}
  let last;
  for (const u of urls) {
    for (let a = 0; a < 3; a++) {
      try {
        const r = await fetch(u, { headers: { 'User-Agent': 'Mozilla/5.0 (Tramvaji-red-voznje)' }, redirect: 'follow' });
        if (!r.ok) throw new Error('HTTP ' + r.status + ' ' + u);
        const b = Buffer.from(await r.arrayBuffer());
        console.log('Skinuto ' + (b.length / 1e6).toFixed(1) + ' MB s ' + u);
        return b;
      } catch (e) { last = e; console.error('Pokušaj ' + (a + 1) + ' ' + u + ': ' + e.message); await new Promise(r => setTimeout(r, 5000)); }
    }
  }
  throw last;
}

(async function main() {
  const t0 = Date.now();
  const f = unzip(await getZip(), ['stops.txt', 'routes.txt', 'trips.txt', 'stop_times.txt', 'calendar.txt', 'calendar_dates.txt', 'feed_info.txt']);
  for (const n of ['stops.txt', 'routes.txt', 'trips.txt', 'stop_times.txt']) if (!f[n]) throw new Error('u zipu nema ' + n);

  let version = '', feedFrom = '', feedTo = '';
  csv(f['feed_info.txt'], o => { version = o.feed_version || ''; feedFrom = o.feed_start_date || ''; feedTo = o.feed_end_date || ''; });

  // Linije: samo tramvaji (0) i autobusi (3)
  const routes = {};
  csv(f['routes.txt'], o => {
    const t = +o.route_type;
    if (t !== 0 && t !== 3 && !(t >= 900 && t < 1000) && !(t >= 700 && t < 800)) return;
    routes[o.route_id] = { s: o.route_short_name || o.route_id, bus: t === 3 || (t >= 700 && t < 800) ? 1 : 0, l: o.route_long_name || '' };
  });

  // Stanice (ime je ključ: više perona istog imena = jedna stanica)
  const stopName = {}, stopPos = {}, stopLL = {};
  csv(f['stops.txt'], o => {
    if (o.location_type && o.location_type !== '0') return;
    const n = (o.stop_name || '').trim();
    if (!n) return;
    stopName[o.stop_id] = n;
    const lat = parseFloat(o.stop_lat), lon = parseFloat(o.stop_lon);
    if (!isNaN(lat) && !isNaN(lon)) stopLL[o.stop_id] = [lat, lon];
  });

  // Usluge (dani vožnje)
  const svcIdx = {}, services = [];
  const svc = id => {
    if (!(id in svcIdx)) { svcIdx[id] = services.length; services.push({ days: [0, 0, 0, 0, 0, 0, 0], from: '', to: '', add: [], rem: [] }); }
    return services[svcIdx[id]];
  };
  csv(f['calendar.txt'], o => {
    const x = svc(o.service_id);
    x.days = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'].map(d => +o[d] || 0);
    x.from = o.start_date; x.to = o.end_date;
  });
  csv(f['calendar_dates.txt'], o => { (o.exception_type === '2' ? svc(o.service_id).rem : svc(o.service_id).add).push(o.date); });

  const trips = {};
  csv(f['trips.txt'], o => {
    if (!routes[o.route_id]) return;
    trips[o.trip_id] = { r: o.route_id, s: svc(o.service_id), si: svcIdx[o.service_id], h: (o.trip_headsign || '').trim(), d: +o.direction_id || 0, st: [] };
  });

  // stop_times
  let rows = 0;
  csv(f['stop_times.txt'], o => {
    const tr = trips[o.trip_id]; if (!tr) return;
    const n = stopName[o.stop_id]; if (!n) return;
    const sec = toSec(o.departure_time) ?? toSec(o.arrival_time); if (sec == null) return;
    tr.st.push([+o.stop_sequence, n, sec, o.stop_id]);
    rows++;
  });
  console.log('Učitano: ' + Object.keys(routes).length + ' linija, ' + Object.keys(trips).length + ' vožnji, ' + rows + ' zaustavljanja');

  // Više zasebnih stanica istog imena zaredom (npr. Zapruđe kod Mosta mladosti i Zapruđe prema Utrini):
  // svaka dobije ime po susjednoj stanici, npr. „Zapruđe (Most mladosti)” i „Zapruđe (Utrina)”.
  const votes = {};              // stop_id -> {oznaka: broj}
  for (const id in trips) {
    const st = trips[id].st;
    if (st.length < 2) continue;
    st.sort((a, b) => a[0] - b[0]);
    for (let i = 0; i < st.length;) {
      let j = i; while (j + 1 < st.length && st[j + 1][1] === st[i][1]) j++;
      if (j > i) {
        const run = st.slice(i, j + 1), L = run.length, used = {};
        run.forEach((x, k) => {
          if (x[3] === (run[k - 1] || [])[3]) return;          // isti stop_id dvaput – nije nova stanica
          let lab = k === 0 && i > 0 ? st[i - 1][1] : k === L - 1 && j + 1 < st.length ? st[j + 1][1] : null;
          if (!lab || used[lab]) lab = '#' + (k + 1);
          used[lab] = 1;
          const v = (votes[x[3]] = votes[x[3]] || {}); v[lab] = (v[lab] || 0) + 1;
        });
      }
      i = j + 1;
    }
  }
  let renamed = 0;
  for (const sid in votes) {
    const v = votes[sid], lab = Object.keys(v).sort((a, b) => v[b] - v[a])[0];
    stopName[sid] = stopName[sid] + (lab[0] === '#' ? ' (' + lab.slice(1) + ')' : ' (' + lab + ')');
    renamed++;
  }
  for (const id in trips) trips[id].st.forEach(x => { x[1] = stopName[x[3]]; });
  for (const sid in stopLL) { const n = stopName[sid]; if (n) (stopPos[n] = stopPos[n] || []).push(stopLL[sid]); }
  if (renamed) console.log('Zasebne stanice istog imena zaredom: ' + renamed + ' perona dobilo oznaku susjedne stanice');

  // Po stanici: polasci (bez zadnje stanice vožnje = samo dolazak)
  const perStop = {};            // ime -> [[trip, route_short, dir, head, svcIdx, sec, seq]]
  const patterns = {};           // route_id|dir -> {seqKey: {stops, n}}
  const heads = {};              // route_id|dir -> {head: n}
  for (const id in trips) {
    const tr = trips[id];
    if (!tr.st.length) continue;
    tr.st.sort((a, b) => a[0] - b[0]);
    // isti peron dvaput zaredom (dolazak i odlazak upisani posebno) -> ostaje samo odlazak
    tr.st = tr.st.filter((x, i) => !(tr.st[i + 1] && tr.st[i + 1][3] === x[3]));
    const rs = routes[tr.r].s, last = tr.st.length - 1;
    const head = tr.h || tr.st[last][1];
    tr.st.forEach((x, i) => {
      if (i === last) return;
      (perStop[x[1]] = perStop[x[1]] || []).push([id, rs, tr.d, head, tr.si, x[2], x[0]]);
    });
    const k = tr.r + '|' + tr.d;
    const names = tr.st.map(x => x[1]);
    const pk = names.join('\u0001');
    const p = (patterns[k] = patterns[k] || {});
    (p[pk] = p[pk] || { stops: names, n: 0 }).n++;
    const h = (heads[k] = heads[k] || {}); h[head] = (h[head] || 0) + 1;
  }

  // Indeks stanica
  const stopList = Object.keys(perStop).sort((a, b) => a.localeCompare(b, 'hr'));
  const stopId = {}; stopList.forEach((n, i) => { stopId[n] = i; });

  // Linije: redoslijed stanica po smjeru (najčešća varijanta + stanice iz ostalih varijanti)
  const lines = {};
  for (const k in patterns) {
    const [rid, d] = k.split('|');
    const vars = Object.values(patterns[k]).sort((a, b) => b.n - a.n);
    const seq = vars[0].stops.slice();
    // Dodaj stanice iz čestih varijanti (obilasci, produžeci); rijetke vožnje (npr. iz spremišta) preskoči
    for (const v of vars.slice(1)) {
      if (v.n < vars[0].n * 0.15) continue;
      v.stops.forEach((n, i) => {
        if (seq.indexOf(n) >= 0) return;
        let at = -1;
        for (let j = i - 1; j >= 0 && at < 0; j--) at = seq.indexOf(v.stops[j]);
        if (at >= 0) { seq.splice(at + 1, 0, n); return; }
        let nx = -1;
        for (let j = i + 1; j < v.stops.length && nx < 0; j++) nx = seq.indexOf(v.stops[j]);
        if (nx >= 0) seq.splice(nx, 0, n);
      });
    }
    const R = routes[rid];
    const L = (lines[R.s] = lines[R.s] || { r: R.s, bus: R.bus, l: R.l, d: {} });
    const hs = heads[k], head = Object.keys(hs).sort((a, b) => hs[b] - hs[a])[0];
    const prev = L.d[d];
    const total = vars.reduce((s, v) => s + v.n, 0);
    // ista oznaka može imati više route_id: zadrži onu s više vožnji
    if (!prev || prev.n < total) L.d[d] = { d: +d, h: head, s: seq.filter(n => n in stopId).map(n => stopId[n]), n: total };
  }
  const lineList = Object.values(lines)
    .map(L => ({ r: L.r, bus: L.bus, l: L.l, d: Object.values(L.d).sort((a, b) => a.d - b.d).map(x => ({ d: x.d, h: x.h, s: x.s })) }))
    .sort((a, b) => a.bus - b.bus || numSort(a.r, b.r));

  // Zapis
  fs.rmSync(path.join(OUT, 's'), { recursive: true, force: true });
  fs.mkdirSync(path.join(OUT, 's'), { recursive: true });
  const stopsOut = stopList.map(n => {
    const ps = stopPos[n] || [];
    const lat = ps.length ? ps.reduce((s, p) => s + p[0], 0) / ps.length : null;
    const lon = ps.length ? ps.reduce((s, p) => s + p[1], 0) / ps.length : null;
    const rs = {}; perStop[n].forEach(x => { rs[x[1]] = 1; });
    return { n, lat: lat && +lat.toFixed(5), lon: lon && +lon.toFixed(5), r: Object.keys(rs).sort(numSort) };
  });
  let bytes = 0;
  stopList.forEach((n, i) => {
    const list = perStop[n].sort((a, b) => a[5] - b[5]);
    const hl = [], hi = {};
    const t = list.map(x => {
      if (!(x[3] in hi)) { hi[x[3]] = hl.length; hl.push(x[3]); }
      return [x[0], x[1], x[2], hi[x[3]], x[4], x[5], x[6]];
    });
    const s = JSON.stringify({ n, h: hl, t });
    bytes += s.length;
    fs.writeFileSync(path.join(OUT, 's', i + '.json'), s);
  });
  fs.writeFileSync(path.join(OUT, 'stops.json'), JSON.stringify(stopsOut));
  fs.writeFileSync(path.join(OUT, 'lines.json'), JSON.stringify(lineList));
  fs.writeFileSync(path.join(OUT, 'services.json'), JSON.stringify(services));
  const built = new Date().toISOString();
  fs.writeFileSync(path.join(OUT, 'meta.json'), JSON.stringify({ version: version || built.slice(0, 10), built, from: feedFrom, to: feedTo, stops: stopList.length, lines: lineList.length }));
  console.log('Zapisano: ' + stopList.length + ' stanica (' + (bytes / 1e6).toFixed(1) + ' MB), ' + lineList.length + ' linija, verzija ' + version + ', ' + ((Date.now() - t0) / 1000).toFixed(1) + ' s');
})().catch(e => { console.error('GREŠKA:', e.stack || e.message); process.exit(1); });
