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
  // Oynatıcı kutusu: 16:9'a yakın büyük iframe/video/player alanları. Gerçek fare tıklaması yapılır.
  const count = await page.evaluate(() => {
    const els = [...document.querySelectorAll(
