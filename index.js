const express = require('express');
const cors = require('cors');
const puppeteer = require('puppeteer-core');
const chromium = require('@sparticuz/chromium');

const app = express();
app.use(cors());

const PORT = process.env.PORT || 3000;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const MEDIA_RE = /\.(m3u8|mp4|mpd)(\?|$)/i;
const AD_HOSTS = ['doubleclick', 'googlesyndication', 'adservice', 'popads', 'popcash', 'propellerads',
  'adsterra', 'exoclick', 'juicyads', 'clickadu', 'histats', 'yandex.ru/metrika', 'onclickads',
  'hilltopads', 'adnxs', 'taboola', 'outbrain', 'bet', 'casino'];

let browser;
async function getBrowser() {
  if (browser && browser.connected) return browser;
  browser = await puppeteer.launch({
    args: [...chromium.args, '--mute-audio'],
    executablePath: await chromium.executablePath(),
    headless: 'shell'
  });
  return browser;
}

// Tek seferde 1 iş (Render ücretsiz planda RAM az)
let queue = Promise.resolve();
const enqueue = (fn) => (queue = queue.then(fn, fn));

const cache = new Map(); // url -> {t, data}
const TTL = 10 * 60 * 1000;

async function tryPlay(page) {
  const sel = ['.jw-icon-display', '.vjs-big-play-button', '.plyr__control--overlaid', 'video', '#player', '.play', '[class*=play]'];
  for (const frame of page.frames()) {
    for (const s of sel) {
      try { await frame.click(s, { delay: 30 }); } catch (_) {}
    }
  }
  try { await page.mouse.click(400, 300); } catch (_) {}
}

async function resolve(pageUrl, waitMs = 20000) {
  const b = await getBrowser();
  const page = await b.newPage();
  const found = new Map();
  const origin = new URL(pageUrl).origin;

  try {
    await page.setUserAgent(UA);
    await page.setViewport({ width: 1280, height: 720 });
    await page.setRequestInterception(true);

    page.on('request', (req) => {
      const u = req.url();
      const type = req.resourceType();
      if (AD_HOSTS.some((h) => u.includes(h))) return req.abort();
      if (['image', 'font', 'stylesheet'].includes(type) && !MEDIA_RE.test(u)) return req.abort();
      if (MEDIA_RE.test(u)) {
        if (!found.has(u)) {
          found.set(u, {
            url: u,
            type: /\.m3u8/i.test(u) ? 'hls' : /\.mpd/i.test(u) ? 'dash' : 'mp4',
            referer: req.frame() ? req.frame().url() : pageUrl,
            origin
          });
        }
        return req.continue();
      }
      req.continue();
    });

    // Popup / yeni sekme engelle
    b.on('targetcreated', async (t) => {
      if (t.type() === 'page') {
        const p = await t.page().catch(() => null);
        if (p && p !== page) p.close().catch(() => {});
      }
    });

    await page.evaluateOnNewDocument(() => {
      window.open = () => null;
      Object.defineProperty(navigator, 'webdriver', { get: () => false });
    });

    await page.goto(pageUrl, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});

    const start = Date.now();
    let clicks = 0;
    while (Date.now() - start < waitMs && found.size === 0) {
      await new Promise((r) => setTimeout(r, 1500));
      if (clicks < 4) { await tryPlay(page); clicks++; }
    }
    // Biraz daha bekle ki birden fazla kalite yakalansın
    if (found.size) await new Promise((r) => setTimeout(r, 1500));

    const frames = page.frames().map((f) => f.url()).filter((u) => u.startsWith('http'));
    return { sources: [...found.values()], frames };
  } finally {
    await page.close().catch(() => {});
  }
}

app.get('/', (_, res) => res.send('MultiMedia resolver çalışıyor'));

app.get('/resolve', async (req, res) => {
  const url = req.query.url;
  if (!url || !/^https?:\/\//i.test(url)) return res.status(400).json({ error: 'url gerekli (http/https)' });

  const hit = cache.get(url);
  if (hit && Date.now() - hit.t < TTL) return res.json({ cached: true, ...hit.data });

  try {
    const data = await enqueue(() => resolve(url));
    if (data.sources.length) cache.set(url, { t: Date.now(), data });
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

app.listen(PORT, () => console.log('resolver port', PORT));
