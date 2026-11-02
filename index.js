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
process.on('unhandledRejection', (e) => console.error('unhandledRejection', e && e.message));
process.on('uncaughtException', (e) => console.error('uncaughtException', e && e.message));
function resetBrowser(e) {
  const m = String((e && e.message) || e);
  if (/Target closed|Protocol error|Session closed|Connection closed|disconnected/i.test(m)) {
    try { browser && browser.close().catch(() => {}); } catch (_) {}
    browser = null;
  }
}

let queue = Promise.resolve();
const enqueue = (fn) => (queue = queue.then(fn, fn));

const cache = new Map(); // url -> {t, data}
const TTL = 10 * 60 * 1000;

async function tryPlay(page) {
  // Oynatıcı kutusu: 16:9'a yakın büyük iframe/video/player alanları. Gerçek fare tıklaması yapılır.
  const count = await page.evaluate(() => {
    const els = [...document.querySelectorAll(
      'iframe, video, [class*=player], [id*=player], [class*=video], [id*=video], [class*=poster]')];
    window.__cands = els.filter((el) => {
      const r = el.getBoundingClientRect();
      const ar = r.width / (r.height || 1);
      return r.width >= 250 && r.height >= 120 && ar > 1.3 && ar < 2.3;
    }).slice(0, 5);
    return window.__cands.length;
  }).catch(() => 0);

  for (let i = 0; i < count; i++) {
    const box = await page.evaluate((i) => {
      const el = window.__cands[i];
      if (!el) return null;
      el.scrollIntoView({ block: 'center' });
      const r = el.getBoundingClientRect();
      return { x: r.x, y: r.y, w: r.width, h: r.height };
    }, i).catch(() => null);
    if (box) {
      try { await page.mouse.click(box.x + box.w / 2, box.y + box.h / 2, { delay: 40 }); } catch (_) {}
      await new Promise((r) => setTimeout(r, 800));
    }
  }
  // iframe içindeki oynat butonları
  const sel = ['.jw-icon-display', '.vjs-big-play-button', '.plyr__control--overlaid', '[class*=play]'];
  for (const frame of page.frames()) {
    if (frame === page.mainFrame()) continue;
    for (const q of sel) { try { await frame.click(q, { delay: 30 }); } catch (_) {} }
  }
}

async function resolve(pageUrl, waitMs = 20000) {
  const b = await getBrowser();
  const page = await b.newPage();
  const found = new Map();
  const origin = new URL(pageUrl).origin;
  let currentProvider = 'varsayilan';
  let onTarget = null;

  try {
    await page.setUserAgent(UA);
    await page.setViewport({ width: 1280, height: 720 });
    await page.setRequestInterception(true);

    page.on('response', (resp) => {
      try {
        const ct = (resp.headers()['content-type'] || '').toLowerCase();
        const u = resp.url();
        if (found.has(u)) return;
        if (ct.includes('mpegurl') || /\/(master|index|playlist)\.(txt|m3u8)(\?|$)/i.test(u)) {
          found.set(u, { provider: currentProvider, url: u, type: 'hls', referer: resp.frame() ? resp.frame().url() : pageUrl, origin });
        }
      } catch (_) {}
    });

    page.on('request', (req) => {
      const u = req.url();
      const type = req.resourceType();
      if (AD_HOSTS.some((h) => u.includes(h))) return req.abort();
      if (type === 'font') return req.abort();
      if (MEDIA_RE.test(u)) {
        if (!found.has(u)) {
          found.set(u, {
            provider: currentProvider,
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

    // Popup engelle: sadece bu sayfanın açtığı yeni sekmeleri kapat
    onTarget = async (t) => {
      try {
        if (t.type() === 'page' && t.opener() === page.target()) {
          const p = await t.page().catch(() => null);
          if (p) p.close().catch(() => {});
        }
      } catch (_) {}
    };
    b.on('targetcreated', onTarget);

    await page.evaluateOnNewDocument(() => {
      window.open = () => null;
      Object.defineProperty(navigator, 'webdriver', { get: () => false });
    });

    await page.goto(pageUrl, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});

    // Sağlayıcı sekmelerini bul (ör. Close | Rapidrame)
    await new Promise((r) => setTimeout(r, 2000));
    const tabs = await page.evaluate(() => {
      const norm = (t) => (t || '').trim();
      const leaf = [...document.querySelectorAll('a,button,li,span,div')]
        .find((e) => e.children.length === 0 && /^(rapidrame|close|closeload)$/i.test(norm(e.innerText)));
      if (!leaf) return [];
      let node = leaf;
      for (let i = 0; i < 3 && node.parentElement; i++) {
        const row = node.parentElement;
        const items = [...row.children].filter((c) => norm(c.innerText) && norm(c.innerText).length <= 20);
        if (items.length >= 2) {
          window.__tabs = items;
          return items.map((c) => norm(c.innerText));
        }
        node = row;
      }
      window.__tabs = [leaf];
      return [norm(leaf.innerText)];
    }).catch(() => []);

    const providers = tabs.length ? tabs : ['varsayilan'];
    for (let i = 0; i < providers.length; i++) {
      currentProvider = providers[i];
      if (tabs.length) {
        const box = await page.evaluate((i) => {
          const el = window.__tabs && window.__tabs[i];
          if (!el) return null;
          el.scrollIntoView({ block: 'center' });
          const r = el.getBoundingClientRect();
          return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
        }, i).catch(() => null);
        if (box) { try { await page.mouse.click(box.x, box.y, { delay: 40 }); } catch (_) {} }
        await new Promise((r) => setTimeout(r, 1200));
      }
      const start = Date.now();
      let clicks = 0;
      const has = () => [...found.values()].some((f) => f.provider === currentProvider);
      while (Date.now() - start < waitMs / providers.length + 6000 && !has()) {
        await tryPlay(page);
        clicks++;
        await new Promise((r) => setTimeout(r, 1500));
      }
      if (has()) await new Promise((r) => setTimeout(r, 1200));
    }

    const frames = page.frames().map((f) => f.url()).filter((u) => u.startsWith('http'));
    return { providers: [...new Set([...found.values()].map((f) => f.provider))], sources: [...found.values()], tabs, frames };
  } finally {
    if (onTarget) b.off('targetcreated', onTarget);
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
    resetBrowser(e);
    res.status(500).json({ error: String(e.message || e) });
  }
});


// ---- Teşhis: sayfada ne var? ----
async function openForDebug(url, waitMs = 8000) {
  const b = await getBrowser();
  const page = await b.newPage();
  await page.setUserAgent(UA);
  await page.setViewport({ width: 1100, height: 800 });
  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => false });
  });
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
  await new Promise((r) => setTimeout(r, waitMs));
  return page;
}

app.get('/debug', async (req, res) => {
  const url = req.query.url;
  if (!url) return res.status(400).json({ error: 'url gerekli' });
  try {
    const out = await enqueue(async () => {
      const page = await openForDebug(url);
      try {
        const info = await page.evaluate(() => ({
          title: document.title,
          url: location.href,
          htmlLength: document.documentElement.outerHTML.length,
          bodyText: (document.body && document.body.innerText || '').slice(0, 300),
          iframes: [...document.querySelectorAll('iframe')].map((f) => ({
            src: f.getAttribute('src'), dataSrc: f.getAttribute('data-src'), id: f.id, cls: f.className
          })),
          videos: document.querySelectorAll('video').length,
          buttons: [...document.querySelectorAll('button, a.btn, .alternative-links a, [data-lang], .tab, li[data-id]')]
            .slice(0, 25).map((e) => (e.innerText || '').trim().slice(0, 30) + ' | ' + e.className)
        }));
        return info;
      } finally {
        await page.close().catch(() => {});
      }
    });
    res.json(out);
  } catch (e) {
    resetBrowser(e);
    res.status(500).json({ error: String(e.message || e) });
  }
});

app.get('/shot', async (req, res) => {
  const url = req.query.url;
  if (!url) return res.status(400).send('url gerekli');
  try {
    const buf = await enqueue(async () => {
      const page = await openForDebug(url);
      try { return await page.screenshot({ type: 'jpeg', quality: 60 }); }
      finally { await page.close().catch(() => {}); }
    });
    res.set('Content-Type', 'image/jpeg').send(buf);
  } catch (e) {
    resetBrowser(e);
    res.status(500).send(String(e.message || e));
  }
});

require('./carnoots')(app, { getBrowser, enqueue, resolve });
require('./dizigom')(app, { getBrowser, enqueue, resolve });

app.listen(PORT, () => console.log('resolver port', PORT));
