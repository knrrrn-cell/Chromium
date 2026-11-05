// Site adresleri tek yerde: sites.json. Dosya yoksa/bozuksa aşağıdaki varsayılanlar kullanılır.
// Bir site adres değiştirirse sadece sites.json'daki satırı düzelt.
const fs = require('fs');
const path = require('path');

const DEFAULTS = {
  carnoots: {
    base: 'https://carnoots.com',
    video: 'https://video.carnoots.com/{slug}/s{s}/e{e}/master.m3u8'
  },
  dizigom: {
    base: 'https://www.dizigom.news'
  },
  hdfilmdelisi: {
    base: 'https://hdfilmdelisi.one',
    film: 'https://ha.vixolity.com/vs/{imdb}',
    dizi: 'https://ha.vixolity.com/vs/{imdb}/s{s}/e{ee}'
  }
};

function readFile() {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(__dirname, 'sites.json'), 'utf8'));
    return j && typeof j === 'object' ? j : {};
  } catch (_) { return {}; }
}

function get(name) {
  const merged = { ...(DEFAULTS[name] || {}), ...(readFile()[name] || {}) };
  if (name === 'hdfilmdelisi' && process.env.HDFD_BASE) merged.base = process.env.HDFD_BASE;
  return merged;
}

function base(name) {
  return String(get(name).base || '').replace(/\/$/, '');
}

function all() {
  const out = {};
  const file = readFile();
  for (const k of new Set([...Object.keys(DEFAULTS), ...Object.keys(file)])) out[k] = get(k);
  return out;
}

// ---- İstek kaydı: hangi yapım ne kadar sürdü, neden yavaş kaldı? (/log) ----
const logs = [];
function logMiddleware(req, res, next) {
  const path = String(req.path || req.url || '');
  if (!/^\/find/.test(path)) return next();
  const t0 = Date.now();
  let body = null;
  const j = res.json.bind(res);
  res.json = (b) => { body = b; return j(b); };
  res.on('finish', () => {
    const b = body || {};
    const q = req.query || {};
    logs.unshift({
      t: new Date().toISOString().slice(11, 19) + 'Z',
      site: path.replace(/^\/find\/?/, '') || 'carnoots',
      names: String(q.names || '').slice(0, 60),
      type: q.type || '',
      s: q.s || '', e: q.e || '',
      ms: Date.now() - t0,
      status: res.statusCode,
      found: b.found, fast: b.fast, cached: b.cached,
      n: Array.isArray(b.sources) ? b.sources.length : 0,
      note: b.fastNote || b.error || ''
    });
    if (logs.length > 60) logs.pop();
  });
  next();
}

function logText() {
  if (!logs.length) return 'Henüz kayıt yok. (Sunucu yeniden başladıysa kayıtlar sıfırlanır.)';
  return logs.map((l) => {
    const sec = (l.ms / 1000).toFixed(1) + ' sn';
    const ep = l.type === 'movie' ? 'film' : (l.s || l.e ? `s${l.s}e${l.e}` : '');
    let sonuc = l.status !== 200 ? 'HATA ' + l.status : !l.found ? 'bulunamadı' : l.n ? `${l.n} kaynak` : 'sayfa bulundu ama LİNK YOK';
    let yol = !l.found ? 'arama sonucu' : l.cached ? 'önbellek' : l.fast ? 'HIZLI (Chromium yok)' : l.site === 'dizigom' ? 'CHROMIUM yoluna düştü' : 'tarayıcı';
    const yavas = l.ms > 8000 ? '  <== YAVAŞ' : '';
    return `${l.t}  ${l.site.padEnd(13)} ${(l.names + ' ' + ep).trim()}\n    -> ${sonuc} | ${yol} | ${sec}${yavas}${l.note ? '\n    neden: ' + l.note : ''}`;
  }).join('\n');
}

let registered = false;
function register(app) {
  if (registered) return;
  registered = true;
  // Uygulama bu adresten desenleri okur (TV'ye yeniden kurulum gerekmez)
  if (typeof app.use === 'function') app.use(logMiddleware);
  app.get('/sites', (req, res) => res.json(all()));
  app.get('/log', (req, res) => res.type('html').send(
    '<!doctype html><html lang="en" translate="no"><head><meta charset="utf-8"><meta name="google" content="notranslate">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1"></head><body style="background:#111;color:#ddd;margin:8px">' +
    '<pre translate="no" style="white-space:pre-wrap;word-break:break-all;font:12px monospace">' +
    logText().replace(/&/g, '&amp;').replace(/</g, '&lt;') + '</pre></body></html>'));
  try { require('./trace')(app); } catch (e) { console.error('trace yüklenemedi:', e.message); }
}

// Aynı anahtarla gelen eşzamanlı istekler tek bir işi paylaşır (ön yükleme + gerçek istek çift iş yapmasın)
const pending = new Map();
function once(key, fn) {
  if (pending.has(key)) return pending.get(key);
  const p = Promise.resolve().then(fn).finally(() => pending.delete(key));
  pending.set(key, p);
  return p;
}

module.exports = { get, base, all, register, once };
