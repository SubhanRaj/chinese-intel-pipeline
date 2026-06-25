/**
 * scrape-test.mjs — Local Puppeteer scrape test for all 7 sources.
 *
 * Also doubles as a curl/fetch reference: the SOURCES list below reflects the
 * same URLs used by the Worker's fetch engine (buildSources + dedicated scrapers).
 * Run with: node scrape-test.mjs
 *
 * Strategies per source:
 *   networkidle2 → if body < 200 chars: wait 5s → if still < 200: scroll + wait 3s
 * Sub-links: follows up to 3 same-domain article-like links for depth check.
 */

import puppeteer from 'puppeteer';

// ── date (CST = UTC+8) ────────────────────────────────────────────────────────
const now      = new Date(Date.now() + 8 * 60 * 60 * 1000);
const yyyy     = now.getUTCFullYear().toString();
const mm       = String(now.getUTCMonth() + 1).padStart(2, '0');
const dd       = String(now.getUTCDate()).padStart(2, '0');
const yyyymmdd = `${yyyy}${mm}${dd}`;
console.log(`\nDate: ${yyyy}-${mm}-${dd} (CST)\n`);

// ── Sources ───────────────────────────────────────────────────────────────────
// These match the Worker's buildSources() exactly (scraper-worker/src/index.ts).
// Old URLs and why they were replaced are noted inline.
const SOURCES = [
  {
    name: 'Yunnan Daily',
    // OLD: yndaily.yunnan.cn/html/… → WAF 403 (also article ID 6618 is edition-specific)
    url: `https://www.yndaily.com`,
    note: 'Main portal; article links still redirect to WAF-blocked yndaily.yunnan.cn',
  },
  {
    name: 'Sichuan Daily',
    // OLD: 4g.scdaily.cn/wap/… → JS SPA, 123 chars even with Puppeteer
    url: `https://www.scdaily.cn`,
    note: 'Main portal; static HTML, 106 text blocks via fetch',
  },
  {
    name: 'Guangxi Daily',
    // Dedicated API scraper in Worker; epaper API unchanged
    url: `https://ssw.gxrb.com.cn/json/interface/epaper/api.php?#p=001`,
    note: 'Epaper API — dedicated scraper extracts article links from area-map tags',
  },
  {
    name: 'Hunan Daily',
    // OLD: h5cgi.voc.com.cn/hnrbdzb/#/ → headless detection, 7 chars always
    url: `https://hnrb.hunantoday.cn`,
    note: 'Static HTML portal with /article/yyyymm/… links — dedicated scraper',
  },
  {
    name: 'Fujian Daily',
    // OLD: pad/ mobile URL → PC URL has same content, cleaner structure
    url: `https://fjrb.fjdaily.com/pc/col/${yyyy}${mm}/${dd}/node_01.html`,
    note: 'PC epaper, static HTML — sections node_01 through node_08',
  },
  {
    name: 'Nanfang Daily',
    // OLD: epaper.nfnews.com/m/ipaper/…#/ → JS SPA shell only
    url: `https://epaper.southcn.com/nfdaily/html/${yyyy}${mm}/${dd}/node_A01.html`,
    note: 'Static epaper — sections A01–A06 each have article headlines in <p> tags',
    extraSections: [
      `https://epaper.southcn.com/nfdaily/html/${yyyy}${mm}/${dd}/node_A02.html`,
      `https://epaper.southcn.com/nfdaily/html/${yyyy}${mm}/${dd}/node_A03.html`,
      `https://epaper.southcn.com/nfdaily/html/${yyyy}${mm}/${dd}/node_A06.html`,
    ],
  },
  {
    name: 'Hainan Daily',
    // Dedicated two-level static HTML scraper in Worker; URL unchanged
    url: `https://news.hndaily.cn/h5/html5/${yyyy}-${mm}/${dd}/node_58471.htm`,
    note: 'Static HTML — l:[content_*.htm] two-level scraper in Worker',
  },
];

// ── Epaper reference URLs (not in Worker pipeline, for manual inspection) ─────
const EPAPER_REFERENCE = [
  { name: 'Guangxi-gxrb-epaper',  url: `https://gxrb.gxrb.com.cn/?name=gxrb&date=${yyyy}-${mm}-${dd}&code=001` },
  { name: 'Guangxi-szbk',         url: `https://szbk.gxnews.com.cn` },
  { name: 'Hainan-hndaily-main',  url: `https://www.hndaily.com.cn` },
  { name: 'Hainan-hndaily-news',  url: `https://hndaily.cn/#/news/100` },
  { name: 'Yunnan-paper',         url: `http://paper.yunnan.cn/` },
];

// ── helpers ───────────────────────────────────────────────────────────────────
async function wait(ms) { return new Promise(r => setTimeout(r, ms)); }

async function getText(page) {
  return page.evaluate(() => (document.body?.innerText ?? '').trim()).catch(() => '');
}

async function setupPage(browser) {
  const page = await browser.newPage();
  await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36');
  await page.setExtraHTTPHeaders({ 'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8' });
  await page.setViewport({ width: 1280, height: 800 });
  await page.setRequestInterception(true);
  page.on('request', req => {
    const t = req.resourceType();
    // block images + fonts; allow scripts + styles (needed for SPAs)
    if (t === 'image' || t === 'font') req.abort();
    else req.continue();
  });
  return page;
}

async function scrapeSource(browser, source) {
  const result = {
    name: source.name, url: source.url, note: source.note ?? '',
    httpStatus: '?', bodyLen: 0, title: '',
    subLinks: [], articles: [], extraSections: [], warnings: [],
  };

  const page = await setupPage(browser);

  try {
    const res = await page.goto(source.url, { waitUntil: 'networkidle2', timeout: 30_000 }).catch(() => null);
    result.httpStatus = res ? `HTTP ${res.status()}` : 'timeout/no-response';
    result.title = await page.evaluate(() => document.title).catch(() => '');

    let body = await getText(page);

    if (body.length < 200) {
      result.warnings.push(`tiny after networkidle2 (${body.length} chars) — waiting 5s for JS`);
      await wait(5000);
      body = await getText(page);
    }
    if (body.length < 200) {
      result.warnings.push(`still tiny (${body.length} chars) — scrolling`);
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight)).catch(() => {});
      await wait(3000);
      body = await getText(page);
    }
    result.bodyLen = body.length;

    // Same-domain article sub-links
    result.subLinks = await page.evaluate((base) => {
      const seen = new Set(), links = [];
      for (const a of document.querySelectorAll('a[href]')) {
        const href = a.href;
        if (!href || href === base || /^javascript|^#/.test(href)) continue;
        try {
          const u = new URL(href), b = new URL(base);
          if (u.hostname !== b.hostname) continue;
          if (seen.has(href)) continue;
          if (/node|article|content|page|\d{4,}|\.html|\.htm/.test(u.pathname + u.hash)) {
            seen.add(href);
            links.push({ href, text: (a.innerText || '').trim().slice(0, 60) });
          }
        } catch { /* ignore */ }
      }
      return links.slice(0, 8);
    }, source.url).catch(() => []);

    if (result.bodyLen > 100) {
      result.articles.push({ title: result.title, textLen: result.bodyLen, url: source.url, note: 'index' });
    }

    // Fetch first 3 sub-links for depth check
    for (const { href, text } of result.subLinks.slice(0, 3)) {
      const sub = await setupPage(browser);
      try {
        await sub.goto(href, { waitUntil: 'networkidle2', timeout: 20_000 });
        let subBody = await getText(sub);
        if (subBody.length < 200) { await wait(3000); subBody = await getText(sub); }
        const subTitle = await sub.evaluate(() => document.title).catch(() => '');
        result.articles.push({
          title: subTitle || text || href,
          textLen: subBody.length,
          url: href,
          preview: subBody.slice(0, 150).replace(/\n+/g, ' '),
        });
      } catch (e) {
        result.articles.push({ url: href, error: e.message.slice(0, 80) });
      } finally {
        await sub.close().catch(() => {});
      }
    }

    // Extra section pages (Nanfang A02/A03/A06 etc.)
    for (const sectionUrl of (source.extraSections ?? [])) {
      const sub = await setupPage(browser);
      try {
        await sub.goto(sectionUrl, { waitUntil: 'networkidle2', timeout: 15_000 });
        let subBody = await getText(sub);
        if (subBody.length < 100) { await wait(3000); subBody = await getText(sub); }
        result.extraSections.push({
          url: sectionUrl, textLen: subBody.length,
          preview: subBody.slice(0, 150).replace(/\n+/g, ' '),
        });
      } catch (e) {
        result.extraSections.push({ url: sectionUrl, error: e.message.slice(0, 60) });
      } finally {
        await sub.close().catch(() => {});
      }
    }

  } catch (err) {
    result.httpStatus = `ERROR: ${err.message.slice(0, 100)}`;
  } finally {
    await page.close().catch(() => {});
  }

  return result;
}

// ── main ──────────────────────────────────────────────────────────────────────
const browser = await puppeteer.launch({
  headless: true,
  args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-blink-features=AutomationControlled'],
});

const results = [];
for (const source of SOURCES) {
  process.stdout.write(`Scraping ${source.name}... `);
  const t0 = Date.now();
  const r = await scrapeSource(browser, source);
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`${r.httpStatus} — ${r.bodyLen} chars — ${elapsed}s`);
  results.push({ ...r, elapsed });
}

await browser.close();

// ── report ────────────────────────────────────────────────────────────────────
console.log('\n' + '═'.repeat(72));
console.log('SCRAPE REPORT  —  ' + `${yyyy}-${mm}-${dd}`);
console.log('═'.repeat(72));

for (const r of results) {
  const ok = r.bodyLen > 300 || r.articles.some(a => (a.textLen ?? 0) > 300);
  const icon = !r.httpStatus.startsWith('HTTP 2') ? '❌' : ok ? '✅' : '⚠️ ';
  console.log(`\n${icon}  ${r.name}  (${r.elapsed}s)`);
  console.log(`    URL:    ${r.url}`);
  if (r.note) console.log(`    Note:   ${r.note}`);
  console.log(`    Status: ${r.httpStatus}  |  Body: ${r.bodyLen} chars`);
  console.log(`    Title:  "${r.title}"`);
  r.warnings.forEach(w => console.log(`    ⚠️  ${w}`));
  if (r.subLinks.length) {
    console.log(`    Sub-links (${r.subLinks.length}):`);
    r.subLinks.forEach(l => console.log(`      → [${l.text || '—'}]  ${l.href}`));
  }
  if (r.articles.length) {
    console.log(`    Articles (${r.articles.length}):`);
    r.articles.forEach(a => {
      if (a.error) { console.log(`      ✗ ${a.url}\n        ${a.error}`); return; }
      console.log(`      ✓ "${a.title.slice(0, 60)}" — ${a.textLen} chars${a.note ? ' ['+a.note+']' : ''}`);
      if (a.preview) console.log(`        "${a.preview}"`);
    });
  }
  if (r.extraSections.length) {
    console.log(`    Extra sections:`);
    r.extraSections.forEach(s => {
      if (s.error) { console.log(`      ✗ ${s.url}  ${s.error}`); return; }
      console.log(`      § ${s.url}  (${s.textLen} chars)`);
      if (s.preview) console.log(`        "${s.preview}"`);
    });
  }
}

console.log('\n' + '═'.repeat(72));
const good = results.filter(r => r.bodyLen > 300 || r.articles.some(a => (a.textLen ?? 0) > 300));
const meh  = results.filter(r => !good.includes(r) && r.httpStatus.startsWith('HTTP 2'));
const bad  = results.filter(r => !r.httpStatus.startsWith('HTTP 2'));
console.log(`\n✅  Scrapeable  (${good.length}): ${good.map(r => r.name).join(', ') || 'none'}`);
console.log(`⚠️   Partial/SPA (${meh.length}): ${meh.map(r => r.name).join(', ') || 'none'}`);
console.log(`❌  Blocked/err  (${bad.length}): ${bad.map(r => r.name).join(', ') || 'none'}`);

console.log('\n── Epaper reference URLs (not in pipeline, for manual inspection) ──');
EPAPER_REFERENCE.forEach(e => console.log(`  ${e.name}: ${e.url}`));
