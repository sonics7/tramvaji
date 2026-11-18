// Cloudflare Worker: prosljeđuje ZET-ove podatke mobitelima (ZET ne dopušta izravan dohvat iz preglednika).
//   /rt    -> ZET GTFS-realtime (kašnjenja uživo), međuspremnik 15 s
//   /vijesti -> izvanredna obavijest s naslovnice zet.hr + RSS „Izmjene u prometu” (JSON), međuspremnik 5 min
//   /gtfs  -> ZET vozni red (zip), rezerva za GitHub ako zet.hr odbije njegove poslužitelje
// Zalijepi cijelu datoteku u Cloudflare -> Workers -> Edit code -> Deploy.

const RT_URL = 'https://zet.hr/gtfs-rt-protobuf';
const GTFS_URL = 'https://zet.hr/gtfs-scheduled/latest';
const HOME_URL = 'https://www.zet.hr/';
const RSS_URL = 'https://www.zet.hr/rss_promet.aspx';
const UA = { 'User-Agent': 'Mozilla/5.0 (Tramvaji-red-voznje)' };

// ---------- Obavijesti ----------
const ENT = { nbsp: ' ', amp: '&', quot: '"', apos: "'", lt: '<', gt: '>', bdquo: '„', ldquo: '“', rdquo: '”', lsquo: '‘', rsquo: '’', ndash: '–', mdash: '—', hellip: '…', deg: '°', euro: '€', scaron: 'š', Scaron: 'Š', ccaron: 'č', Ccaron: 'Č', zcaron: 'ž', Zcaron: 'Ž', cacute: 'ć', Cacute: 'Ć' };
const unEnt = s => String(s || '').replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (m, e) => {
  if (e[0] === '#') { const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10); return isFinite(n) ? String.fromCodePoint(n) : m; }
  return ENT[e] != null ? ENT[e] : m;
});
// HTML -> čisti tekst s odlomcima i natuknicama
export function toText(h) {
  return unEnt(String(h || '')
    .replace(/<!\[CDATA\[|\]\]>/g, '')
    .replace(/<li[^>]*>/gi, '\n• ')
    .replace(/<br\s*\/?>|<\/(p|div|li|ul|ol|h\d)>/gi, '\n')
    .replace(/<[^>]+>/g, ''))
    .split('\n').map(l => l.replace(/[ \t\u00a0]+/g, ' ').trim()).join('\n')
    .replace(/\n{3,}/g, '\n\n').trim();
}
// Brojevi linija koje obavijest spominje
export function linesIn(title, html) {
  const out = new Set();
  const add = x => { if (+x.replace(/\D/g, '') > 0 && +x.replace(/\D/g, '') < 400) out.add(x.toUpperCase()); };
  if (/linij/i.test(title)) (title.match(/\b\d{1,3}[A-Za-z]?\b/g) || []).forEach(add);
  const t = String(html || '');
  for (const m of t.matchAll(/<strong>\s*(\d{1,3}[A-Z]?)\s*<\/strong>/g)) add(m[1]);
  for (const m of toText(t).matchAll(/linij[a-z]*\s+(\d{1,3}[A-Z]?)((?:\s*(?:,|i)\s*\d{1,3}[A-Z]?)*)/gi)) {
    add(m[1]); (m[2].match(/\d{1,3}[A-Z]?/g) || []).forEach(add);
  }
  return [...out].sort((a, b) => parseInt(a, 10) - parseInt(b, 10));
}
function hash(s) { let h = 5381; for (let i = 0; i < s.length; i++) h = (h * 33 + s.charCodeAt(i)) >>> 0; return h.toString(36); }
export function parseHome(html) {
  const out = [];
  const re = /class="warning-text"[^>]*>([\s\S]*?)<\/div>\s*<\/div>\s*<\/div><!--\s*end row/gi;
  let m;
  while ((m = re.exec(html))) {
    const text = toText(m[1]);
    if (text.length > 5) out.push({ id: 'h' + hash(text), urgent: true, title: text.split('\n')[0].slice(0, 140), text, lines: linesIn('linija', m[1]), at: 0, link: HOME_URL });
  }
  return out;
}
export function parseRss(xml) {
  return String(xml || '').split(/<item>/i).slice(1).map(it => {
    const g = k => ((new RegExp('<' + k + '>([\\s\\S]*?)</' + k + '>', 'i')).exec(it) || [])[1] || '';
    const cd = s => s.replace(/^\s*<!\[CDATA\[/, '').replace(/\]\]>\s*$/, '');
    const title = toText(cd(g('title'))), html = cd(g('description'));
    const link = toText(g('link')).replace(/^http:/, 'https:');
    const at = Date.parse(g('pubDate'));
    const id = (/id=(\d+)/.exec(link) || [])[1];
    return { id: 'r' + (id || hash(title)), urgent: false, title, text: toText(html), lines: linesIn(title, html), at: isFinite(at) ? at : 0, link };
  }).filter(i => i.title).sort((a, b) => b.at - a.at);
}
async function vijesti() {
  const get = u => fetch(u, { headers: UA }).then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.text(); });
  const [home, rss] = await Promise.allSettled([get(HOME_URL), get(RSS_URL)]);
  if (home.status === 'rejected' && rss.status === 'rejected') throw new Error('zet.hr nedostupan');
  const items = [];
  if (home.status === 'fulfilled') items.push(...parseHome(home.value));
  if (rss.status === 'fulfilled') items.push(...parseRss(rss.value));
  return { at: Date.now(), items };
}
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Max-Age': '86400'
};

export default {
  async fetch(request, env, ctx) {
    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });
    const url = new URL(request.url);

    if (url.pathname === '/rt') {
      const cache = caches.default;
      const key = new Request('https://cache.local/zet-rt');
      let res = await cache.match(key);
      if (!res) {
        let up;
        try {
          up = await fetch(RT_URL, { headers: UA, cf: { cacheTtl: 0 } });
        } catch (e) {
          return new Response('ZET nedostupan: ' + e.message, { status: 502, headers: CORS });
        }
        if (!up.ok) return new Response('ZET HTTP ' + up.status, { status: 502, headers: CORS });
        const buf = await up.arrayBuffer();
        res = new Response(buf, { headers: { 'Content-Type': 'application/x-protobuf', 'Cache-Control': 'public, max-age=15' } });
        ctx.waitUntil(cache.put(key, res.clone()));
      }
      const out = new Response(res.body, res);
      for (const k in CORS) out.headers.set(k, CORS[k]);
      out.headers.set('Cache-Control', 'no-store');
      return out;
    }

    if (url.pathname === '/vijesti') {
      const cache = caches.default;
      const key = new Request('https://cache.local/zet-vijesti');
      let res = await cache.match(key);
      if (!res) {
        try {
          res = new Response(JSON.stringify(await vijesti()), { headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'public, max-age=300' } });
          ctx.waitUntil(cache.put(key, res.clone()));
        } catch (e) {
          return new Response(JSON.stringify({ error: e.message }), { status: 502, headers: { 'Content-Type': 'application/json', ...CORS } });
        }
      }
      const out = new Response(res.body, res);
      for (const k in CORS) out.headers.set(k, CORS[k]);
      out.headers.set('Cache-Control', 'no-store');
      return out;
    }

    if (url.pathname === '/gtfs') {
      const up = await fetch(GTFS_URL, { headers: UA });
      return new Response(up.body, { status: up.status, headers: { 'Content-Type': 'application/zip' } });
    }

    return new Response('Tramvaji – ZET posrednik radi. Koristi /rt i /vijesti', { headers: { 'Content-Type': 'text/plain; charset=utf-8', ...CORS } });
  }
};
