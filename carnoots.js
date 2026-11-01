// Carnoots (çizgi film sitesi) bulucu.
// Kullanım: /find?names=Gravity Falls|Esrarengiz Kasaba&year=2012&s=1&e=1
const BASE = 'https://carnoots.com';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const norm = (t) => String(t || '').toLowerCase()
  .replace(/ı/g, 'i').replace(/ğ/g, 'g').replace(/ü/g, 'u').replace(/ş/g, 's').replace(/ö/g, 'o').replace(/ç/g, 'c')
  .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  .replace(/[^a-z0-9]+/g, ' ').trim();
const slugify = (t) => norm(t).replace(/ /g, '-');

// 1) Hızlı yol: adı slug'a çevirip sayfa var mı diye bak
async function slugExists(slug) {
  if (!slug) return null;
  try {
    const r = await fetch(`${BASE}/cartoon/${slug}`, { headers: { 'user-agent': UA }, redirect: 'follow' });
    if (!r.ok) return null;
    const html = await r.text();
    if (!html.includes(`/watch/${slug}/`)) return null;
    const m = html.match(/<title>([^<]*)<\/title>/i);
    const title = m ? m[1].replace(/\s*\|\s*Carnoots.*/i, '').replace(/\s*İzle.*/i, '').trim() : slug;
    return { slug, title, year: null, via: 'slug' };
  } catch (_) { return null; }
}

// 2) Arama sayfası (sunucudaki Chromium ile)
async function searchSite(getBrowser, q) {
  const b = await getBrowser();
  const page = await b.newPage();
  try {
    await page.setUserAgent(UA);
    await page.goto(`${BASE}/search?q=${encodeURIComponent(q)}&tur=cizgi-film`, { waitUntil: 'domcontentloaded', timeout: 25000 });
    await new Promise((r) => setTimeout(r, 1500));
    return await page.evaluate(() => {
      const out = new Map();
      document.querySelectorAll('a[href*="/cartoon/"]').forEach((a) => {
        const m = (a.getAttribute('href') || '').match(/\/cartoon\/([a-z0-9-]+)\/?$/i);
        if (!m) return;
        const title = (a.innerText || '').trim();
        const card = a.closest('li,article,section,div');
        const y = card && (card.innerText || '').match(/\b(19|20)\d{2}\b/);
        const prev = out.get(m[1]);
        if (!prev || title.length > (prev.title || '').length) {
          out.set(m[1], { slug: m[1], title, year: y ? Number(y[0]) : null });
        }
      });
      return [...out.values()];
    });
  } finally {
    await page.close().catch(() => {});
  }
}

function pickBest(cands, names, year) {
  const wanted = names.map((n) => ({ n: norm(n), s: slugify(n) }));
  let best = null;
  for (const c of cands) {
    const t = norm(c.title);
    let score = 0;
    for (const w of wanted) {
      if (!w.n) continue;
      if (t === w.n || c.slug === w.s) score = Math.max(score, 3);
      else if (w.n.length >= 4 && t && (t.includes(w.n) || w.n.includes(t))) score = Math.max(score, 2);
    }
    if (year && c.year) score += Math.abs(c.year - year) <= 1 ? 1 : -2;
    if (!best || score > best.score) best = { ...c, score };
  }
  return best && best.score >= 2 ? best : null;
}

async function findCartoon(getBrowser, names, year) {
  for (const n of names) {
    const hit = await slugExists(slugify(n));
    if (hit) return hit;
  }
  for (const n of names) {
    const cands = await searchSite(getBrowser, n);
    const best = pickBest(cands, names, year);
    if (best) return { ...best, via: 'search' };
  }
  return null;
}

module.exports = function register(app, { getBrowser, enqueue, resolve }) {
  const cache = new Map();
  const TTL = 10 * 60 * 1000;

  app.get('/find', async (req, res) => {
    const names = String(req.query.names || req.query.q || '').split('|').map((s) => s.trim()).filter(Boolean);
    if (!names.length) return res.status(400).json({ error: 'names gerekli, örn: names=Gravity Falls|Esrarengiz Kasaba' });
    const year = Number(req.query.year) || null;
    const s = Number(req.query.s) || 1;
    const e = Number(req.query.e) || 1;

    const key = `${names.join('|')}#${s}#${e}`;
    const hit = cache.get(key);
    if (hit && Date.now() - hit.t < TTL) return res.json({ cached: true, ...hit.data });

    try {
      const data = await enqueue(async () => {
        const match = await findCartoon(getBrowser, names, year);
        if (!match) return { site: 'carnoots', found: false, tried: names };
        const watchUrl = `${BASE}/watch/${match.slug}/${s}/${e}`;
        const r = await resolve(watchUrl, 20000);
        // master varsa ses/alt playlistlerini ayrı kaynak gösterme
        let sources = r.sources;
        if (sources.some((x) => /master/i.test(x.url))) sources = sources.filter((x) => !x.url.includes('/audio_'));
        return { site: 'carnoots', found: true, match, watchUrl, sources };
      });
      if (data.found && data.sources.length) cache.set(key, { t: Date.now(), data });
      res.json(data);
    } catch (err) {
      res.status(500).json({ error: String(err.message || err) });
    }
  });
};
