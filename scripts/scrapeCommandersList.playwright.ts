// scripts/scrapeCommandersList.playwright.ts
/**
 * Este archivo produce el archivo inicial data/all-commanders.json
 * es el primero que ha de ser corrido para obtener toda la lista de commanders
 */
import { chromium, Browser } from 'playwright';
import fs from 'fs/promises';
import path from 'path';

const DELAY_BETWEEN_PAGES_MS = 2500;
const DELAY_BETWEEN_CATEGORIES_MS = 4000;
const MAX_RETRIES = 3;

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

async function getAllCategoryUrls(browser: Browser): Promise<{ name: string, url: string }[]> {
  const page = await browser.newPage();
  try {
    console.log('🌐 Cargando https://edhrec.com/commanders/');
    
    let rawJson: string | null = null;
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        await page.goto('https://edhrec.com/commanders/', { waitUntil: 'domcontentloaded', timeout: 30_000 });
        await page.waitForSelector('script#__NEXT_DATA__', { state: 'attached', timeout: 15_000 });
        rawJson = await page.$eval('script#__NEXT_DATA__', el => el.textContent || '');
        break;
      } catch (err: any) {
        console.warn(`  ⚠️ Intento ${attempt}/${MAX_RETRIES} fallido para la página principal: ${err.message}`);
        if (attempt < MAX_RETRIES) await sleep(attempt * 5000);
      }
    }

    if (!rawJson) throw new Error('No se pudo obtener __NEXT_DATA__ de la página principal');

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
    return allUrls;
  } finally {
    await page.close();
  }
}

async function scrapeCategory(browser: Browser, categoryUrl: string): Promise<any[]> {
  const page = await browser.newPage();
  const results: any[] = [];
  let pageNum = 1;

  try {
    while (true) {
      const url = `${categoryUrl}?page=${pageNum}`;
      console.log(`📄 Scrapeando ${url}`);
      
      let rawJson: string | null = null;
      for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        try {
          await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
          await page.waitForSelector('script#__NEXT_DATA__', { state: 'attached', timeout: 15_000 });
          rawJson = await page.$eval('script#__NEXT_DATA__', el => el.textContent || '');
          break;
        } catch (err: any) {
          console.warn(`  ⚠️ Intento ${attempt}/${MAX_RETRIES} fallido para ${url}: ${err.message}`);
          if (attempt < MAX_RETRIES) await sleep(attempt * 5000);
        }
      }

      if (!rawJson) {
        console.error(`❌ Saltando página debido a múltiples fallos consecutivos: ${url}`);
        break;
      }

      const parsed = JSON.parse(rawJson); 
      const cardviews = parsed?.props?.pageProps?.data?.container?.json_dict?.cardlists?.[0]?.cardviews;

      if (!Array.isArray(cardviews) || cardviews.length === 0 || pageNum === 4) {
        break;
      }

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
      await sleep(DELAY_BETWEEN_PAGES_MS);
    }
  } finally {
    await page.close();
  }

  return results;
}

(async () => {
  // Configuración ideal para entornos CI/CD (GitHub Actions)
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  try {
    const allUrls = await getAllCategoryUrls(browser);
    const allCommanders: any[] = [];

    for (const { name, url } of allUrls) {
      console.log(`\n🔎 Procesando categoría: ${name}`);
      try {
        const commanders = await scrapeCategory(browser, url);
        allCommanders.push(...commanders);
      } catch (error) {
        console.error(`❌ Error crítico al procesar ${name}:`, error);
      }
      await sleep(DELAY_BETWEEN_CATEGORIES_MS);
    }

    const outputPath = path.resolve(__dirname, '../data/all-commanders.json');
    await fs.mkdir(path.dirname(outputPath), { recursive: true });
    await fs.writeFile(outputPath, JSON.stringify(allCommanders, null, 2));

    console.log(`\n✅ Total de comandantes guardados: ${allCommanders.length} en ${outputPath}`);
  } finally {
    // Esto garantiza que el navegador se cierre SÍ O SÍ y el pipeline no se tilde
    await browser.close();
  }
})();