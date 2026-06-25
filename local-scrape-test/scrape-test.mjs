import puppeteer from 'puppeteer';

// ── date ─────────────────────────────────────────────────────────────────────
const now = new Date(Date.now() + 8 * 60 * 60 * 1000);
const yyyy = now.getUTCFullYear().toString();
const mm   = String(now.getUTCMonth() + 1).padStart(2, '0');
const dd   = String(now.getUTCDate()).padStart(2, '0');
const yyyymmdd = `${yyyy}${mm}${dd}`;
console.log(`\nDate: ${yyyy}-${mm}-${dd} (CST)\n`);

const SOURCES = [
  { name: 'Yunnan Daily',  url: `https://yndaily.yunnan.cn/html/${yyyy}/${yyyymmdd}/${yyyymmdd}_001/${yyyymmdd}_001_6618.html#0` },
  { name: 'Sichuan Daily', url: `https://4g.scdaily.cn/wap/scrb/${yyyymmdd}/index.html` },
  { name: 'Guangxi Daily', url: `https://ssw.gxrb.com.cn/json/interface/epaper/api.php?#p=001` },
  { name: 'Hunan Daily',   url: `https://h5cgi.voc.com.cn/hnrbdzb/#/` },
  { name: 'Fujian Daily',  url: `https://fjrb.fjdaily.com/pad/col/${yyyy}${mm}/${dd}/node_01.html` },
  { name: 'Nanfang Daily', url: `https://epaper.nfnews.com/m/ipaper/nfrb/html/${yyyy}${mm}/${dd}/node_A05.html#/` },
  { name: 'Hainan Daily',  url: `https://news.hndaily.cn/h5/html5/${yyyy}-${mm}/${dd}/node_58471.htm` },
];

// ── helpers ───────────────────────────────────────────────────────────────────
async function waitAndGetText(page, ms = 3000) {
  await new Promise(r => setTimeout(r, ms));
  return page.evaluate(() => (document.body?.innerText ?? '').trim()).catch(() => '');
}

async function scrapeSource(browser, name, startUrl) {
  const result = {
    name, url: startUrl,
    httpStatus: '?', bodyLen: 0, title: '',
    subLinks: [], articles: [], notes: [],
  };

  const page = await browser.newPage();

  // Realistic browser fingerprint
  await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36');
  await page.setExtraHTTPHeaders({ 'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8' });
  await page.setViewport({ width: 1280, height: 800 });

  await page.setRequestInterception(true);
  page.on('request', req => {
    const t = req.resourceType();
    if (t === 'image' || t === 'font') req.abort();
    else req.continue();                          // allow stylesheets + scripts (needed for SPAs)
  });

  try {
    // Strategy A: networkidle2 (best for static pages)
    const res = await page.goto(startUrl, { waitUntil: 'networkidle2', timeout: 30_000 })
      .catch(() => null);
    result.httpStatus = res ? `HTTP ${res.status()}` : 'timeout/error';

    result.title = await page.evaluate(() => document.title).catch(() => '');

    let bodyText = await page.evaluate(() => (document.body?.innerText ?? '').trim()).catch(() => '');

    // Strategy B: if body is tiny, it's a SPA — wait 5s for JS to hydrate
    if (bodyText.length < 200) {
      result.notes.push('tiny body after networkidle2 — waiting 5s for JS');
      bodyText = await waitAndGetText(page, 5000);
    }

    // Strategy C: still tiny — try scrolling to trigger lazy load
    if (bodyText.length < 200) {
      result.notes.push('still tiny — scrolling to trigger lazy load');
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight)).catch(() => {});
      bodyText = await waitAndGetText(page, 3000);
    }

    result.bodyLen = bodyText.length;

    // Collect same-domain sub-links
    result.subLinks = await page.evaluate((base) => {
      const seen = new Set();
      const links = [];
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
    }, startUrl).catch(() => []);

    if (result.bodyLen > 100) {
      result.articles.push({ title: result.title, textLen: result.bodyLen, url: startUrl, note: 'index page' });
    }

    // Fetch first 3 sub-links for depth check
    for (const { href, text } of result.subLinks.slice(0, 3)) {
      const sub = await browser.newPage();
      await sub.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36');
      await sub.setRequestInterception(true);
      sub.on('request', req => {
        const t = req.resourceType();
        if (t === 'image' || t === 'font') req.abort();
        else req.continue();
      });
      try {
        await sub.goto(href, { waitUntil: 'networkidle2', timeout: 20_000 });
        let subText = await sub.evaluate(() => (document.body?.innerText ?? '').trim()).catch(() => '');
        if (subText.length < 200) {
          await new Promise(r => setTimeout(r, 3000));
          subText = await sub.evaluate(() => (document.body?.innerText ?? '').trim()).catch(() => '');
        }
        const subTitle = await sub.evaluate(() => document.title).catch(() => '');
        result.articles.push({
          title: subTitle || text || href,
          textLen: subText.length,
          url: href,
          preview: subText.slice(0, 120).replace(/\n/g, ' '),
        });
      } catch (e) {
        result.articles.push({ url: href, error: e.message.slice(0, 80) });
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
for (const { name, url } of SOURCES) {
  process.stdout.write(`Scraping ${name}... `);
  const t0 = Date.now();
  const r = await scrapeSource(browser, name, url);
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`${r.httpStatus} — ${r.bodyLen} chars — ${elapsed}s`);
  results.push({ ...r, elapsed });
}

await browser.close();

// ── report ─────────────────────────────────────────────────────────────────
console.log('\n' + '═'.repeat(72));
console.log('DETAILED SCRAPE REPORT');
console.log('═'.repeat(72));

for (const r of results) {
  const scrapeable = r.articles.some(a => a.textLen > 300) || r.bodyLen > 300;
  const icon = r.httpStatus.startsWith('HTTP 2') ? (scrapeable ? '✅' : '⚠️') : '❌';
  console.log(`\n${icon}  ${r.name}  (${r.elapsed}s)`);
  console.log(`    URL:    ${r.url}`);
  console.log(`    Status: ${r.httpStatus}  |  Body: ${r.bodyLen} chars`);
  console.log(`    Title:  "${r.title}"`);
  if (r.notes.length) r.notes.forEach(n => console.log(`    NOTE:   ${n}`));
  if (r.subLinks.length) {
    console.log(`    Sub-links (${r.subLinks.length} found, showing up to 8):`);
    r.subLinks.forEach(l => console.log(`      → [${l.text || '—'}] ${l.href}`));
  }
  if (r.articles.length) {
    console.log(`    Articles fetched (${r.articles.length}):`);
    r.articles.forEach(a => {
      if (a.error) {
        console.log(`      ✗ ${a.url}`);
        console.log(`        Error: ${a.error}`);
      } else {
        console.log(`      ✓ "${a.title}" — ${a.textLen} chars${a.note ? ' ['+a.note+']' : ''}`);
        if (a.preview) console.log(`        Preview: "${a.preview}"`);
      }
    });
  }
}

console.log('\n' + '═'.repeat(72));
const good = results.filter(r => r.articles.some(a => a.textLen > 300) || r.bodyLen > 300);
const meh  = results.filter(r => !good.includes(r) && r.httpStatus.startsWith('HTTP 2'));
const bad  = results.filter(r => !r.httpStatus.startsWith('HTTP 2'));
console.log(`\n✅ Scrapeable (${good.length}): ${good.map(r=>r.name).join(', ') || 'none'}`);
console.log(`⚠️  Partial/SPA (${meh.length}): ${meh.map(r=>r.name).join(', ') || 'none'}`);
console.log(`❌ Blocked/404 (${bad.length}): ${bad.map(r=>r.name).join(', ') || 'none'}`);
