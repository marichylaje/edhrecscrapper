// scripts/scrapeAllCommanders.playwright.ts
import { chromium } from 'playwright';
import fs from 'fs/promises';
import path from 'path';

async function getAllCategoryUrls(): Promise<{ name: string, url: string }[]> {
  const browser = await chromium.launch();
  const page = await browser.newPage();

  console.log('🌐 Cargando https://edhrec.com/commanders/');
  await page.goto('https://edhrec.com/commanders/', { waitUntil: 'networkidle' });

  const rawJson = await page.$eval('script#__NEXT_DATA__', el => el.textContent || '');
  const parsed = JSON.parse(rawJson);

  const related = parsed?.props?.pageProps?.data?.related_info;

  const allUrls: { name: string, url: string }[] = [];
  for (const group of related || []) {
    for (const item of group.items || []) {
      allUrls.push({
        name: item.textLeft,
        url: `https://edhrec.com${item.url}`
      });
    }
  }

  await browser.close();
  return allUrls;
}

async function scrapeCategory(categoryUrl: string): Promise<any[]> {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  const results: any[] = [];
  let pageNum = 1;

  while (true) {
    const url = `${categoryUrl}?page=${pageNum}`;
    console.log(`📄 Scrapeando ${url}`);
    await page.goto(url, { waitUntil: 'networkidle' });

    const rawJson = await page.$eval('script#__NEXT_DATA__', el => el.textContent || '');
    const parsed = JSON.parse(rawJson);
    const cardviews = parsed?.props?.pageProps?.data?.container?.json_dict?.cardlists?.[0]?.cardviews;

    if (!Array.isArray(cardviews) || cardviews.length === 0 || pageNum === 4) break;

    for (const card of cardviews) {
      results.push({
        name: card.name,
        decks: card.num_decks,
        url: `https://edhrec.com${card.url}`,
        sanitized: card.sanitized,
        colors: card.color_identity || [],
      });
    }

    pageNum++;
  }

  await browser.close();
  return results;
}

(async () => {
  const allUrls = await getAllCategoryUrls();
  const allCommanders: any[] = [];

for (const { name, url } of allUrls) {
  console.log(`\n🔎 Procesando categoría: ${name}`);
  try {
    const commanders = await scrapeCategory(url);
    allCommanders.push(...commanders);
  } catch (error) {
    console.error(`❌ Error al procesar ${name}:`, error);
  }
}

  const outputPath = path.resolve(__dirname, '../data/all-commanders.json');
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, JSON.stringify(allCommanders, null, 2));

  console.log(`\n✅ Total de comandantes guardados: ${allCommanders.length} en ${outputPath}`);
})();
