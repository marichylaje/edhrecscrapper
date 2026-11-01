const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch({ headless: true });
  const p = await b.newPage();
  const pages = [1,2,3,4,5,6,7];
  const out = [];
  for (const n of pages) {
    await p.goto(`https://edhrec.com/commanders/mono-white?page=${n}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await p.waitForTimeout(2500);
    const data = await p.evaluate(() => {
      const names = [...document.querySelectorAll('a.piGH7G_container[href^="/commanders/"] .piGH7G_name')]
        .map(x => (x.textContent || '').trim())
        .filter(Boolean);
      const uniq = [...new Set(names)];
      return { count: uniq.length, first: uniq.slice(0,10), last: uniq.slice(-5) };
    });
    out.push({ page:n, ...data });
  }
  console.log(JSON.stringify(out, null, 2));
  await b.close();
})();
