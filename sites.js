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

let registered = false;
function register(app) {
  if (registered) return;
  registered = true;
  // Uygulama bu adresten desenleri okur (TV'ye yeniden kurulum gerekmez)
  app.get('/sites', (req, res) => res.json(all()));
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
