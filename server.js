// server.js
// Development/testing proxy using Puppeteer. NOT production-ready.

const express = require('express');
const puppeteer = require('puppeteer');
const rateLimit = require('express-rate-limit');
const sanitizeHtml = require('sanitize-html');
const NodeCache = require('node-cache');

const app = express();
const cache = new NodeCache({ stdTTL: 20, checkperiod: 30 }); // short TTL for testing

const PORT = process.env.PORT || 3000;
const DOMAIN = process.env.DOMAIN || 'florrcider.page.gd'; // set this in Codespace env if needed
const UPSTREAM_HOST = 'https://florr.io';

// basic rate limiting to avoid accidental abuse
const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false
});
app.use(limiter);

// Launch a single browser instance and reuse it
let browserPromise = puppeteer.launch({
  headless: true,
  args: ['--no-sandbox', '--disable-setuid-sandbox']
});

async function fetchRenderedHtml(pathAndQuery) {
  const cacheKey = pathAndQuery;
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  const browser = await browserPromise;
  const page = await browser.newPage();

  // set realistic UA and headers
  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36');
  await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' });

  const targetUrl = UPSTREAM_HOST + pathAndQuery;
  try {
    await page.goto(targetUrl, { waitUntil: 'networkidle2', timeout: 60000 });
  } catch (err) {
    // try a longer wait or return the error page
    try {
      await page.waitForTimeout(3000);
    } catch (e) {}
  }

  // get final HTML
  let html = await page.content();

  // sanitize: remove script tags and inline event handlers
  html = sanitizeHtml(html, {
    allowedTags: sanitizeHtml.defaults.allowedTags.filter(t => t !== 'script'),
    allowedAttributes: {
      a: ['href', 'name', 'target', 'rel'],
      img: ['src', 'alt', 'title', 'loading'],
      '*': ['class', 'id', 'style', 'title']
    },
    transformTags: {
      'a': (tagName, attribs) => {
        // keep links but avoid target=_top surprises
        return { tagName: 'a', attribs: { href: attribs.href || '#' } };
      }
    }
  });

  // rewrite absolute upstream links to route through this proxy
  const proxiedBase = `https://${DOMAIN}/proxy`;
  html = html.replace(/https:\/\/florr\.io\//g, proxiedBase + '/');

  // rewrite absolute links that start with / to /proxy/
  html = html.replace(/href="\/(?!proxy\/)/g, 'href="/proxy/');

  // cache and return
  cache.set(cacheKey, html);
  await page.close();
  return html;
}

app.get('/proxy/*', async (req, res) => {
  const path = req.originalUrl.replace(/^\/proxy/, '') || '/';
  try {
    const html = await fetchRenderedHtml(path + (req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : ''));
    // set headers to allow framing from your domain for testing
    res.set('Content-Security-Policy', `frame-ancestors 'self' https://${DOMAIN}`);
    res.set('X-Frame-Options', 'ALLOWALL');
    res.set('Referrer-Policy', 'no-referrer');
    res.set('X-Content-Type-Options', 'nosniff');
    res.send(html);
  } catch (err) {
    console.error('Proxy error', err);
    res.status(502).send('Upstream fetch failed');
  }
});

// root route to show a small test page
app.get('/', (req, res) => {
  res.send(`<html><body>
    <h3>Proxy running</h3>
    <p>Use <code>/proxy/</code> to fetch proxied pages from ${UPSTREAM_HOST}.</p>
    </body></html>`);
});

app.listen(PORT, () => {
  console.log(`Proxy server listening on port ${PORT}`);
});
