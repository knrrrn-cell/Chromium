// Dizigom bulucu (dizi + film).
// Kullanım: /find/dizigom?names=Örümcek-Adam: Eve Dönüş Yok|Spider-Man: Homecoming&year=2017&type=movie
//           /find/dizigom?names=Daha 17&year=2026&type=tv&s=1&e=23
const sites = require('./sites');
const baseOf = () => sites.base('dizigom');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const norm = (t) => String(t || '').toLowerCase()
  .replace(/ı/g, 'i').replace(/ğ/g, 'g').replace(/ü/g, 'u').replace(/ş/g, 's').replace(/ö/g, 'o').replace(/ç/g, 'c')
  .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  .replace(/[^a-z0-9]+/g, ' ').trim();
const slugify = (t) => norm(t).replace(/ /g, '-');

async function searchSite(getBrowser, q) {
  const b = await getBrowser();
  const page = await b.newPage();
  try {
    await page.setUserAgent(UA);
    await page.goto(`${baseOf()}/ara?q=${encodeURIComponent(q)}`, { waitUntil: 'domcontentloaded', timeout: 25000 });
    await new Promise((r) => setTimeout(r, 1500));
    const host = new URL(baseOf()).hostname.replace(/^www\./, '');
    return await page.evaluate((host) => {
      const out = new Map();
      const re = new RegExp(host.replace(/\./g, '\\.') + '(?::\\d+)?\\/(film|diziler)\\/([^\\/?#]+)\\/?$', 'i');
      document.querySelectorAll('a[href]').forEach((a) => {
        const m = (a.href || '').match(re);
        if (!m) return;
        const text = (a.innerText || '').replace(/\s+/g, ' ').trim();
        const ys = text.match(/\b(19|20)\d{2}\b/g);
        const key = m[1] + '/' + m[2];
        const prev = out.get(key);
        if (!prev || text.length > prev.text.length) {
          out.set(key, { kind: m[1].toLowerCase() === 'film' ? 'movie' : 'tv', slug: m[2], text, year: ys ? Number(ys[ys.length - 1]) : null });
        }
      });
      return [...out.values()];
    }, host);
  } finally {
    await page.close().catch(() => {});
  }
}

// Hızlı yol: arama sayfası sunucu tarafında üretildiği için tarayıcı açmadan düz istekle okunabilir
function parseResults(html) {
  const host = new URL(baseOf()).hostname.replace(/^www\./, '');
  const re = new RegExp(host.replace(/\./g, '\\.') + '(?::\\d+)?\\/(film|diziler)\\/([^\\/?#]+)\\/?$', 'i');
  const out = new Map();
  const aRe = /<a\b[^>]*\bhref=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = aRe.exec(html))) {
    let href = m[1];
    if (href.startsWith('/')) href = baseOf() + href;
    const mm = href.match(re);
    if (!mm) continue;
    const text = m[2].replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
    const ys = text.match(/\b(19|20)\d{2}\b/g);
    const key = mm[1].toLowerCase() + '/' + mm[2];
    const prev = out.get(key);
    if (!prev || text.length > prev.text.length) {
      out.set(key, { kind: mm[1].toLowerCase() === 'film' ? 'movie' : 'tv', slug: mm[2], text, year: ys ? Number(ys[ys.length - 1]) : null });
    }
  }
  return [...out.values()];
}

async function searchHttp(q) {
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), 10000);
  try {
    const r = await fetch(`${baseOf()}/ara?q=${encodeURIComponent(q)}`, {
      headers: { 'user-agent': UA, 'accept-language': 'tr-TR,tr;q=0.9' }, signal: ctrl.signal
    });
    if (!r.ok) return null;
    const list = parseResults(await r.text());
    return list.length ? list : null;
  } catch (_) { return null; } finally { clearTimeout(to); }
}

// ---- Hızlı yol: Chromium olmadan, düz isteklerle (bölüm sayfası -> s.php -> token.php -> stream.php) ----
async function httpGet(url, headers = {}, ms = 12000, max = 300000) {
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), ms);
  try {
    const r = await fetch(url, { headers: { 'user-agent': UA, 'accept-language': 'tr-TR,tr;q=0.9', ...headers }, redirect: 'follow', signal: ctrl.signal });
    const buf = Buffer.from(await r.arrayBuffer()).subarray(0, max);
    return { status: r.status, text: buf.toString('utf8') };
  } catch (_) { return { status: 0, text: '' }; } finally { clearTimeout(to); }
}

// Sadece durum kodu (gövdeyi okumadan): TV gibi başlıksız istek
async function httpStatus(url, headers = {}) {
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), 12000);
  try {
    const r = await fetch(url, { headers: { 'user-agent': UA, ...headers }, redirect: 'follow', signal: ctrl.signal });
    try { await r.body.cancel(); } catch (_) {}
    return r.status;
  } catch (_) { return 0; } finally { clearTimeout(to); }
}

// Linki hiç Referer/Origin göndermeden (TV gibi) master -> alt liste -> parça olarak dene
async function playableWithoutHeaders(link) {
  const m = await httpGet(link, {}, 12000, 100000);
  if (m.status !== 200 || !/^\s*#EXTM3U/.test(m.text)) return `master reddedildi (${m.status})`;
  const variant = m.text.split(/\r?\n/).find((l) => l && !l.startsWith('#'));
  if (!variant) return '';
  const vurl = new URL(variant.replace(/&amp;/g, '&'), link).href;
  const v = await httpGet(vurl, {}, 12000, 100000);
  if (v.status !== 200 || !/^\s*#EXTM3U/.test(v.text)) return `alt liste reddedildi (${v.status})`;
  const seg = v.text.split(/\r?\n/).find((l) => l && !l.startsWith('#'));
  if (!seg) return '';
  const st = await httpStatus(new URL(seg, vurl).href, { Range: 'bytes=0-1023' });
  return st === 200 || st === 206 ? '' : `video parçası reddedildi (${st})`;
}

async function fastLink(watchUrl) {
  const siteOrigin = new URL(watchUrl).origin;
  const page = await httpGet(watchUrl);
  if (page.status !== 200) return { fail: `bölüm sayfası açılmadı (${page.status})` };
  const idm = page.text.match(/data-pv=["']([A-Za-z0-9_-]{16,40})["']/);
  if (!idm) return { fail: 'sayfada oynatıcı kimliği (data-pv) yok' };
  const core = page.text.match(/<script[^>]+src=["'](https?:\/\/[^"']+\/(?:assets\/js\/core|e\/c)\.js[^"']*)["']/i);
  if (!core) return { fail: 'oynatıcı betiği (core.js) bulunamadı' };
  const pOrigin = new URL(core[1]).origin;
  const sUrl = `${pOrigin}/assets/js/s.php?s=${encodeURIComponent(idm[1])}`;
  const sp = await httpGet(sUrl, { Referer: watchUrl, Origin: siteOrigin });
  if (sp.status !== 200) return { fail: `oynatıcı sayfası açılmadı (${sp.status})` };
  const vm = sp.text.match(/api\/(?:stream|token|thumb)\.php\?v=([0-9a-f]{16,64})/i);
  if (!vm) return { fail: 'oynatıcı sayfasında video no yok' };
  const V = vm[1];
  const tk = await httpGet(`${pOrigin}/api/token.php?v=${V}`, { Referer: sUrl, Origin: pOrigin }, 12000, 20000);
  let tok = null;
  try { const j = JSON.parse(tk.text); if (j && j.ok && j.token) tok = j.token; } catch (_) {}
  if (!tok) return { fail: `token alınamadı (${tk.status})` };
  const link = `${pOrigin}/api/stream.php?v=${V}&token=${tok}`;
  const why = await playableWithoutHeaders(link);
  if (why) return { fail: 'başlıksız oynatma olmadı: ' + why };
  return { source: { provider: 'varsayilan', url: link, type: 'hls', referer: sUrl, origin: pOrigin } };
}

function pickBest(cands, names, year, kind) {
  const wanted = names.map((n) => ({ n: norm(n), s: slugify(n) })).filter((w) => w.n);
  let best = null;
  for (const c of cands) {
    if (kind && c.kind !== kind) continue;
    const t = norm(c.text);
    let score = 0;
    for (const w of wanted) {
      const re = new RegExp('^' + w.s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(-(hd\\d*|izle(-hd\\d*)?|\\d{4}))?$');
      if (re.test(c.slug)) score = Math.max(score, 3);
      else if (w.n.length >= 4 && t.includes(w.n)) score = Math.max(score, 1);
    }
    if (year && c.year) score += Math.abs(c.year - year) <= 1 ? 1 : -2;
    if (!best || score > best.score) best = { ...c, score };
  }
  return best && best.score >= 3 ? best : null;
}

module.exports = function register(app, { getBrowser, enqueue, resolve }) {
  sites.register(app);
  const cache = new Map();
  const TTL = (Number(process.env.CACHE_MIN) || 120) * 60 * 1000;

  app.get('/find/dizigom', async (req, res) => {
    const names = String(req.query.names || '').split('|').map((s) => s.trim()).filter(Boolean);
    if (!names.length) return res.status(400).json({ error: 'names gerekli' });
    const kind = req.query.type === 'movie' ? 'movie' : 'tv';
    const year = Number(req.query.year) || null;
    const s = Number(req.query.s) || 1;
    const e = Number(req.query.e) || 1;

    const key = `${kind}#${names.join('|')}#${s}#${e}`;
    const hit = cache.get(key);
    if (hit && Date.now() - hit.t < TTL) return res.json({ cached: true, ...hit.data });

    try {
      const data = await sites.once('dizigom#' + key, async () => {
        // 1) Aramayı tarayıcısız dene (hızlı)
        let match = null, httpOk = false;
        for (const n of names) {
          const cands = await searchHttp(n);
          if (cands) { httpOk = true; match = pickBest(cands, names, year, kind); if (match) break; }
        }
        // 2) Düz istek hiç sonuç vermediyse eski yöntem: Chromium ile ara
        if (!match && !httpOk) {
          match = await enqueue(async () => {
            for (const n of names) {
              const cands = await searchSite(getBrowser, n);
              const m = pickBest(cands, names, year, kind);
              if (m) return m;
            }
            return null;
          });
        }
        if (!match) return { site: 'dizigom', found: false, tried: names };
        const watchUrl = kind === 'movie'
          ? `${baseOf()}/film/${match.slug}`
          : `${baseOf()}/${match.slug}-${s}-sezon-${e}-bolum/`;
        // Hızlı yol (Chromium'suz). Olmazsa eski yönteme dön.
        let fastNote = '';
        try {
          const f = await fastLink(watchUrl);
          if (f.source) return { site: 'dizigom', found: true, fast: true, match: { slug: match.slug, year: match.year }, watchUrl, sources: [f.source] };
          fastNote = f.fail || '';
        } catch (err) { fastNote = 'hızlı yol hatası: ' + String((err && err.message) || err); }
        const r = await enqueue(() => resolve(watchUrl, 25000));
        // master varsa ara playlistleri (p=stream_...) ayrı kaynak gösterme
        let sources = r.sources;
        if (sources.some((x) => !/[?&]p=/.test(x.url))) sources = sources.filter((x) => !/[?&]p=/.test(x.url));
        return { site: 'dizigom', found: true, fastNote, match: { slug: match.slug, year: match.year }, watchUrl, sources };
      });
      if (data.found && data.sources.length) cache.set(key, { t: Date.now(), data });
      res.json(data);
    } catch (err) {
      res.status(500).json({ error: String(err.message || err) });
    }
  });
};
