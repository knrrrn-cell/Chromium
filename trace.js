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
  const out = new Set();
  (text.match(/https?:\/\/[^"'\s<>\\)]+/g) || []).forEach((u) => { if (/(api|stream|m3u8|token|\.php|\.mp4|playlist|embed|player)/i.test(u)) out.add(u); });
  const rel = /["'](\/[^"'\s]*(?:api|stream|token|player)[^"'\s]*)["']/gi;
  let m;
  while ((m = rel.exec(text))) { const u = abs(m[1], base); if (u) out.add(u); }
  return [...out].slice(0, 25);
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
      for (let i = 0; i < targets.length; i++) {
        const u = targets[i];
        line(''); line(`== 2.${i + 1}) OYNATICI SAYFASI ==`); line('istenen: ' + u + '   (Referer: ' + url + ')');
        const r = await get(u, { Referer: url, Origin: origin });
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
          line('link kurma / ağ çağrısı içeren parçalar:');
          context(r.text, /(fetch\(|XMLHttpRequest|stream\.php|s\.php|token|createElement\(["']iframe|\.src\s*=|data-player|\/api\/|atob\()/i, 16, 150).forEach((c) => line('  • ' + c));
        }
        if (!picks.length) line('(indirilecek oynatıcı betiği bulunamadı)');
      }

      if (follow) {
        const tries = apis.filter((a) => okHost(a.u) && /(api|stream|token|\.php)/i.test(a.u)).slice(0, 4);
        line(''); line('== 3) OYNATICININ API ADRESLERİ (follow=1) ==');
        for (const a of tries) {
          const r = await get(a.u, { Referer: a.ref, Origin: new URL(a.ref).origin }, 12000, 60000);
          line(''); line('istenen: ' + a.u); line(`durum: ${r.status}  tür: ${r.type}  boyut: ${r.len}`);
          line(r.text.slice(0, 700).replace(/\s+/g, ' '));
        }
        if (!tries.length) line('(denenecek API adresi bulunamadı)');
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
