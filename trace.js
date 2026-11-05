// İnceleme adresi: bir sayfa tarayıcısız nasıl açılıyor, oynatıcı linki nereden alıyor?
// Kullanım: /trace?url=BÖLÜM-SAYFASI            (sayfa + oynatıcı sayfaları)
//           /trace?url=BÖLÜM-SAYFASI&follow=1   (ek olarak oynatıcının API adreslerini de dener)
//           /trace?url=...&follow=1&scripts=1   (ek olarak oynatıcı betiklerinin içine de bakar)
// Sadece sites.json'daki sitelere izin verir. Çıktı kopyalanabilir düz metindir.
const sites = require('./sites');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const PRIVATE = /^(localhost|127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|0\.|\[?::1)/i;
const allowPrivate = () => process.env.TRACE_ALLOW_PRIVATE === '1';

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const abs = (u, base) => { try { return new URL(String(u).replace(/&amp;/g, '&'), base).href; } catch (_) { return null; } };
const okHost = (u) => { try { const h = new URL(u).hostname; return allowPrivate() || !PRIVATE.test(h); } catch (_) { return false; } };

async function get(url, headers, ms = 12000, max = 250000) {
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), ms);
  try {
    const r = await fetch(url, { headers: { 'user-agent': UA, 'accept-language': 'tr-TR,tr;q=0.9', ...headers }, redirect: 'follow', signal: ctrl.signal });
    const buf = Buffer.from(await r.arrayBuffer()).subarray(0, max);
    return { status: r.status, type: r.headers.get('content-type') || '', url: r.url, text: buf.toString('utf8'), len: buf.length };
  } catch (e) {
    return { status: 0, error: String((e && e.message) || e), url, type: '', text: '', len: 0 };
  } finally { clearTimeout(to); }
}

function iframesOf(html, base) {
  const out = [];
  const re = /<iframe\b[^>]*>/gi;
  let m;
  while ((m = re.exec(html))) {
    const src = (m[0].match(/\bsrc=["']([^"']*)["']/i) || [])[1];
    const ds = (m[0].match(/\bdata-src=["']([^"']*)["']/i) || [])[1];
    const u = abs(src || ds || '', base);
    if (u && !out.includes(u)) out.push(u);
  }
  return out;
}

function scriptSrcs(html, base) {
  const out = [];
  const re = /<script\b[^>]*\bsrc=["']([^"']+)["']/gi;
  let m;
  while ((m = re.exec(html))) { const u = abs(m[1], base); if (u && !out.includes(u)) out.push(u); }
  return out;
}

// Anahtar kelimelerin çevresindeki kısa metin parçaları
function context(text, re, max, radius = 110) {
  const out = [];
  let last = -1e9, m;
  const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
  while ((m = g.exec(text)) && out.length < max) {
    if (m.index - last < radius) continue;
    last = m.index;
    out.push(text.slice(Math.max(0, m.index - radius), m.index + radius).replace(/\s+/g, ' ').trim());
  }
  return out;
}

function urlsOf(text, base) {
  text = String(text).replace(/&amp;/g, '&');
  const out = new Set();
  (text.match(/https?:\/\/[^"'\s<>\\)]+/g) || []).forEach((u) => { if (/(api|stream|m3u8|token|\.php|\.mp4|playlist|embed|player)/i.test(u)) out.add(u); });
  const rel = /["'](\/[^"'\s]*(?:api|stream|token|player)[^"'\s]*)["']/gi;
  let m;
  while ((m = rel.exec(text))) { const u = abs(m[1], base); if (u) out.add(u); }
  return [...out].slice(0, 25);
}


// "absolute inset-0 h-full w-full" kutusunun hemen önündeki özellik: oynatıcı kimliği
function mountId(html) {
  const i = html.indexOf('absolute inset-0 h-full w-full');
  if (i < 0) return null;
  const before = html.slice(Math.max(0, i - 400), i);
  const all = [...before.matchAll(/([A-Za-z][\w-]*)=["']([A-Za-z0-9_-]{16,40})["']/g)];
  const m = all[all.length - 1];
  return m ? { attr: m[1], id: m[2] } : null;
}

module.exports = function register(app) {
  app.get('/trace', async (req, res) => {
    const out = [];
    const line = (s = '') => out.push(s);
    const send = () => res.type('html').send(
      '<!doctype html><html lang="en" translate="no"><head><meta charset="utf-8"><meta name="google" content="notranslate">' +
      '<meta name="viewport" content="width=device-width,initial-scale=1"></head><body style="background:#111;color:#ddd;margin:8px">' +
      '<pre translate="no" style="white-space:pre-wrap;word-break:break-all;font:12px monospace">' + esc(out.join('\n')) + '</pre></body></html>');

    try {
      const url = String(req.query.url || '');
      const follow = req.query.follow === '1';
      let host = '';
      try { host = new URL(url).hostname; } catch (_) {}
      const allowed = Object.values(sites.all()).some((c) => {
        try { const h = new URL(c.base).hostname; return host === h || host.endsWith('.' + h); } catch (_) { return false; }
      });
      if (!host || !allowed) { line('HATA: url gerekli ve sites.json içindeki sitelerden biri olmalı.'); return send(); }

      const origin = new URL(url).origin;
      line('== 1) SAYFA =='); line('istenen: ' + url);
      const page = await get(url, {});
      line(`durum: ${page.status}  tür: ${page.type}  boyut: ${page.len}  son adres: ${page.url}`);
      if (page.error) line('hata: ' + page.error);
      const ifr = iframesOf(page.text, page.url || url);
      const mid = mountId(page.text);
      line(''); line('oynatıcı kimliği: ' + (mid ? `${mid.attr}="${mid.id}"` : '(bulunamadı)'));
      const coreUrl = scriptSrcs(page.text, page.url || url).find((u) => /(player|core|embed)/i.test(u) && !/googletagmanager|wargamings/i.test(u));
      if (mid && coreUrl) {
        const built = new URL(coreUrl).origin + '/assets/js/s.php?s=' + encodeURIComponent(mid.id);
        line('kurulan oynatıcı adresi (core.js mantığına göre): ' + built);
        if (!ifr.includes(built)) ifr.push(built);
      }
      line(''); line('iframe adresleri (' + ifr.length + '):'); ifr.forEach((u) => line('  ' + u));
      const sc = scriptSrcs(page.text, page.url || url).slice(0, 15);
      line(''); line('harici script adresleri (ilk 15):'); sc.forEach((u) => line('  ' + u));
      line(''); line('data-player etiketleri (oynatıcı kutusu):');
      const dp = page.text.match(/<[a-z]+\b[^>]*\bdata-player\b[^>]*>/gi) || [];
      dp.slice(0, 4).forEach((t) => line('  ' + t.replace(/\s+/g, ' ').slice(0, 700)));
      if (!dp.length) line('  (yok)');
      line(''); line('data-* özellikleri içeren, oynatıcıyla ilgili etiketler:');
      (page.text.match(/<[a-z]+\b[^>]*\bdata-(?:embed|src|video|player-[a-z]+|stream|id|s|key)=[^>]*>/gi) || [])
        .filter((t) => !/\.(webp|jpg|png)/i.test(t)).slice(0, 8).forEach((t) => line('  ' + t.replace(/\s+/g, ' ').slice(0, 400)));
      line(''); line('sayfada geçen oynatıcı/API adresleri:');
      urlsOf(page.text, page.url || url).filter((u) => !/\.(webp|jpg|png|css)|googletagmanager|schema\.org/i.test(u) && !u.startsWith(origin)).slice(0, 15).forEach((u) => line('  ' + u));
      line(''); line('sayfada ipucu içeren parçalar:');
      context(page.text, /(m3u8|stream\.php|s\.php|pilavyerplay|data-embed|createElement\(["']iframe|\.src\s*=|player-?(?:url|src)|alternative)/i, 14).forEach((c) => line('  • ' + c));

      // Sayfada s.php?s=... gibi bir oynatıcı adresi geçiyorsa onu da dene
      const direct = (page.text.match(/https?:\/\/[^"'\s<>\\]*(?:s\.php|embed)[^"'\s<>\\]*/gi) || []).filter((u) => !u.startsWith(origin));
      direct.forEach((u) => { const a = abs(u, url); if (a && !ifr.includes(a)) ifr.push(a); });

      const targets = ifr.filter(okHost).slice(0, 3);
      const apis = [];
      const pages = [];
      for (let i = 0; i < targets.length; i++) {
        const u = targets[i];
        line(''); line(`== 2.${i + 1}) OYNATICI SAYFASI ==`); line('istenen: ' + u + '   (Referer: ' + url + ')');
        const r = await get(u, { Referer: url, Origin: origin });
        pages.push({ u, text: r.text });
        line(`durum: ${r.status}  tür: ${r.type}  boyut: ${r.len}`);
        if (r.error) line('hata: ' + r.error);
        line(''); line('ilk 1200 karakter:'); line(r.text.slice(0, 1200).replace(/\s+/g, ' '));
        line(''); line('adres benzeri parçalar:'); urlsOf(r.text, r.url || u).forEach((x) => { line('  ' + x); apis.push({ u: x, ref: u }); });
        line(''); line('istek/ağ çağrısı içeren parçalar:');
        context(r.text, /(fetch\(|XMLHttpRequest|\$\.ajax|\$\.get|\.open\(|atob\(|eval\(function)/i, 10).forEach((c) => line('  • ' + c));
      }

      if (req.query.scripts === '1') {
        const picks = scriptSrcs(page.text, page.url || url)
          .filter((u) => /(player|core|embed|stream|play)/i.test(u) && !/googletagmanager|wargamings/i.test(u) && okHost(u)).slice(0, 2);
        for (let i = 0; i < picks.length; i++) {
          const r = await get(picks[i], { Referer: url, Origin: origin }, 12000, 400000);
          line(''); line(`== SCRIPT ${i + 1}) ${picks[i]} ==`); line(`durum: ${r.status}  tür: ${r.type}  boyut: ${r.len}`);
          line('ilk 300 karakter: ' + r.text.slice(0, 300).replace(/\s+/g, ' '));
          if (r.len <= 8000) { line('betiğin tamamı:'); line(r.text.replace(/\s+/g, ' ').slice(0, 7000)); }
          line('link kurma / ağ çağrısı içeren parçalar:');
          context(r.text, /(fetch\(|XMLHttpRequest|stream\.php|s\.php|token|createElement\(["']iframe|\.src\s*=|data-player|\/api\/|atob\()/i, 16, 150).forEach((c) => line('  • ' + c));
        }
        if (!picks.length) line('(indirilecek oynatıcı betiği bulunamadı)');
        for (const pg of pages) {
          const ps = scriptSrcs(pg.text, pg.u).filter((u) => /player/i.test(u) && okHost(u)).slice(0, 2);
          for (let i = 0; i < ps.length; i++) {
            const r = await get(ps[i], { Referer: pg.u, Origin: new URL(pg.u).origin }, 12000, 600000);
            line(''); line(`== OYNATICI BETİĞİ) ${ps[i]} ==`); line(`durum: ${r.status}  tür: ${r.type}  boyut: ${r.len}`);
            line('token / stream / ağ çağrısı içeren parçalar:');
            context(r.text, /(token\.php|stream\.php|sub\.php|beat\.php|fetch\(|XMLHttpRequest|headers\s*:|X-[A-Za-z-]+|Authorization|sendBeacon)/i, 22, 200).forEach((c) => line('  • ' + c));
          }
        }
      }

      if (follow) {
        const sameHost = (a, b) => { try { return new URL(a).hostname === new URL(b).hostname; } catch (_) { return false; } };
        const prio = (u) => (/token\.php/.test(u) ? 0 : /stream\.php/.test(u) ? 1 : /sub\.php/.test(u) ? 2 : 3);
        const seen = new Set();
        const tries = apis
          .filter((a) => okHost(a.u) && sameHost(a.u, a.ref) && /\/api\/[a-z]+\.php/i.test(a.u))
          .filter((a) => (seen.has(a.u) ? false : seen.add(a.u)))
          .sort((x, y) => prio(x.u) - prio(y.u)).slice(0, 6);
        line(''); line('== 3) OYNATICININ API ADRESLERİ (follow=1) ==');
        for (const a of tries) {
          const r = await get(a.u, { Referer: a.ref, Origin: new URL(a.ref).origin }, 12000, 60000);
          line(''); line('istenen: ' + a.u); line(`durum: ${r.status}  tür: ${r.type}  boyut: ${r.len}`);
          line(r.text.slice(0, 500).replace(/\s+/g, ' '));
        }
        if (!tries.length) line('(denenecek API adresi bulunamadı)');

        // Zincir: oynatıcının kendi adımları (token al -> stream iste)
        const pg = pages.find((p) => /s\.php/.test(p.u)) || pages[0];
        const vm = pg && pg.text.match(/api\/(?:stream|token|thumb)\.php\?v=([0-9a-f]{16,64})/i);
        if (pg && vm) {
          const V = vm[1];
          const pOrigin = new URL(pg.u).origin;
          const H = { Referer: pg.u, Origin: pOrigin };
          line(''); line('== 4) ZİNCİR DENEMESİ (oynatıcının kendi adımları) =='); line('video no (v): ' + V);
          const t1 = await get(`${pOrigin}/api/token.php?v=${V}`, H, 12000, 20000);
          line(`token.php -> durum: ${t1.status}  tür: ${t1.type}`); line(t1.text.slice(0, 500).replace(/\s+/g, ' '));
          let tok = null;
          try { const j = JSON.parse(t1.text); tok = j.token || j.t || null; } catch (_) {}
          if (!tok) { const m = t1.text.match(/eyJ[\w-]+\.[0-9a-f]{32,}/); if (m) tok = m[0]; }
          const th = pg.text.replace(/&amp;/g, '&').match(/token=(eyJ[\w-]+\.[0-9a-f]{32,})/);
          const useTok = tok || (th && th[1]) || '';
          line('stream.php için token: ' + (tok ? "token.php'den geldi" : th ? "sayfadaki thumb token'ı kullanıldı" : 'yok'));
          if (useTok) {
            const s1 = await get(`${pOrigin}/api/stream.php?v=${V}&token=${useTok}`, H, 12000, 20000);
            line(`stream.php -> durum: ${s1.status}  tür: ${s1.type}  boyut: ${s1.len}`); line(s1.text.slice(0, 500).replace(/\s+/g, ' '));
          }
        }
      } else {
        line(''); line('Not: oynatıcının API adreslerini de denemek için adresin sonuna &follow=1 ekle.');
      }
      send();
    } catch (e) {
      line('BEKLENMEYEN HATA: ' + String((e && e.message) || e));
      send();
    }
  });
};
