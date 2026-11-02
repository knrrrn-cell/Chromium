// HDFilmDelisi bulucu (film + dizi). Sitede arama adresi yok, adresler addan kurulur:
//   film : /film/{slug}            dizi bölümü: /dizi/{slug}/sezon-{s}/bolum-{e}
// Kullanım: /find/hdfilmdelisi?names=Backrooms&year=2026&type=movie
//           /find/hdfilmdelisi?names=Breaking Bad&type=tv&s=1&e=1
const BASE = (process.env.HDFD_BASE || 'https://hdfilmdelisi.one').replace(/\/$/, '');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const norm = (t) => String(t || '').toLowerCase()
  .replace(/ı/g, 'i').replace(/ğ/g, 'g').replace(/ü/g, 'u').replace(/ş/g, 's').replace(/ö/g, 'o').replace(/ç/g, 'c')
  .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  .replace(/[^a-z0-9]+/g, ' ').trim();
const slugify = (t) => norm(t).replace(/ /g, '-');

// Sayfanın HTML'ini al: önce düz istek, engellenirse Chromium ile
async function getPage(getBrowser, url) {
  try {
    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), 12000);
    const r = await fetch(url, { headers: { 'user-agent': UA, 'accept-language': 'tr-TR,tr;q=0.9' }, redirect: 'follow', signal: ctrl.signal });
    clearTimeout(to);
    if (r.status === 404) return { status: 404, html: '' };
    if (r.ok) return { status: r.status, html: await r.text() };
  } catch (_) {}
  try {
    const b = await getBrowser();
    const page = await b.newPage();
    try {
      await page.setUserAgent(UA);
      const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 25000 });
      return { status: resp ? resp.status() : 0, html: await page.content() };
    } finally { await page.close().catch(() => {}); }
  } catch (_) { return { status: 0, html: '' }; }
}

function pageTitle(html) {
  const m = html.match(/<title>([^<]*)<\/title>/i);
  return m ? m[1].replace(/&amp;/g, '&').replace(/&#x27;|&#39;/g, "'").trim() : '';
}

// Aday adres uygun mu? (ad başlıkta geçmeli, filmde yıl tutmalı)
function acceptable(title, names, year, kind) {
  const t = norm(title);
  if (!t || /404|bulunamad/.test(t)) return false;
  const nameOk = names.some((n) => { const w = norm(n); return w.length >= 3 && t.includes(w); });
  if (!nameOk) return false;
  if (kind === 'movie' && year) {
    const ym = title.match(/\((\d{4})\)/);
    if (ym && Math.abs(Number(ym[1]) - year) > 1) return false;
  }
  return true;
}

function slugCandidates(names) {
  const out = [];
  for (const n of names) {
    const s = slugify(n);
    if (s && !out.includes(s)) out.push(s);
  }
  return out;
}

async function findSlug(getBrowser, names, year, kind) {
  for (const slug of slugCandidates(names)) {
    const url = kind === 'movie' ? `${BASE}/film/${slug}` : `${BASE}/dizi/${slug}`;
    const p = await getPage(getBrowser, url);
    if (p.status === 404 || !p.html) continue;
    if (acceptable(pageTitle(p.html), names, year, kind)) return { slug, title: pageTitle(p.html) };
  }
  return null;
}

// Parçaları (altyazı, küçük resim, ayrı ses/görüntü) ele, asıl master'ı bırak
function cleanSources(list) {
  let s = list.filter((x) => !/(\/img\/|\/vtt\/|thumbnail|\/sub_[^/]*$)/i.test(x.url));
  const vs = s.filter((x) => /\/vs\//i.test(x.url));
  if (vs.length) return vs;
  if (s.some((x) => !/main_\d+p\//i.test(x.url))) s = s.filter((x) => !/main_\d+p\//i.test(x.url));
  return s;
}

module.exports = function register(app, { getBrowser, enqueue, resolve }) {
  const cache = new Map();
  const TTL = 10 * 60 * 1000;

  app.get('/find/hdfilmdelisi', async (req, res) => {
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
      const data = await enqueue(async () => {
        const match = await findSlug(getBrowser, names, year, kind);
        if (!match) return { site: 'hdfilmdelisi', found: false, tried: names, candidates: slugCandidates(names) };
        const watchUrl = kind === 'movie'
          ? `${BASE}/film/${match.slug}`
          : `${BASE}/dizi/${match.slug}/sezon-${s}/bolum-${e}`;
        const r = await resolve(watchUrl, 25000);
        return { site: 'hdfilmdelisi', found: true, match, watchUrl, sources: cleanSources(r.sources) };
      });
      if (data.found && data.sources.length) cache.set(key, { t: Date.now(), data });
      res.json(data);
    } catch (err) {
      res.status(500).json({ error: String(err.message || err) });
    }
  });
};
