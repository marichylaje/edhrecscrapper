// scripts/scrapeCommandersList.playwright.ts
/**
 * Este archivo produce el archivo inicial data/all-commanders.json
 * es el primero que ha de ser corrido para obtener toda la lista de commanders
 */
import fs from 'fs/promises';
import path from 'path';
import axios from 'axios';
import { Browser, chromium, Page } from 'playwright';

const DELAY_BETWEEN_PAGES_MS = 2500;
const DELAY_BETWEEN_CATEGORIES_MS = 4000;
const MAX_RETRIES = 3;
const MAX_PAGES_PER_CATEGORY = Number(process.env.SCRAPE_MAX_PAGES_PER_CATEGORY || 0);
const EDHREC_JSON_BASE = 'https://json.edhrec.com/pages';

const REQUEST_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (compatible; EDHRECScrapper/1.0)',
  Accept: 'application/json,text/plain,*/*',
  Referer: 'https://edhrec.com/',
};

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

type CategoryResponse = {
  related_info?: Array<{
    header?: string;
    items?: Array<{ textLeft?: string; url?: string }>;
  }>;
};

type CardView = {
  name?: string;
  num_decks?: number;
  url?: string;
  sanitized?: string;
  color_identity?: string[];
};

type CategoryPageResponse = {
  container?: {
    json_dict?: {
      cardlists?: Array<{
        cardviews?: CardView[];
      }>;
    };
  };
};

type CommanderListItem = {
  name: string;
  decks: number;
  url: string;
  sanitized: string;
  colors: string[];
};

async function getJsonWithRetries<T>(url: string): Promise<T> {
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const response = await axios.get<T>(url, {
        headers: REQUEST_HEADERS,
        timeout: 30_000,
      });
      return response.data;
    } catch (err: any) {
      console.warn(`  ⚠️ Intento ${attempt}/${MAX_RETRIES} fallido para ${url}: ${err.message}`);
      if (attempt < MAX_RETRIES) {
        await sleep(attempt * 5000);
      }
    }
  }

  throw new Error(`No se pudo obtener JSON de ${url} luego de ${MAX_RETRIES} intentos`);
}

async function getAllCategoryUrls(): Promise<{ name: string; url: string }[]> {
  console.log('🌐 Obteniendo categorías desde JSON de EDHREC...');
  const seedUrl = `${EDHREC_JSON_BASE}/commanders/mono-white.json?page=1`;
  const parsed = await getJsonWithRetries<CategoryResponse>(seedUrl);
  const related = parsed?.related_info;

  const allUrls: { name: string; url: string }[] = [];
  for (const group of related || []) {
    for (const item of group.items || []) {
      if (!item.url || !item.textLeft) continue;
      allUrls.push({
        name: item.textLeft,
        url: item.url,
      });
    }
  }

  if (allUrls.length === 0) {
    throw new Error('No se pudieron resolver categorías de commanders desde EDHREC JSON');
  }

  return allUrls;
}

function parseDeckCount(raw: string): number {
  const normalized = raw.trim().replace(',', '.').toUpperCase();
  const match = normalized.match(/^(\d+(?:\.\d+)?)\s*([KM]?)$/);
  if (!match) return 0;

  const base = Number(match[1]);
  if (Number.isNaN(base)) return 0;

  if (match[2] === 'K') return Math.round(base * 1_000);
  if (match[2] === 'M') return Math.round(base * 1_000_000);
  return Math.round(base);
}

async function extractCommandersFromPage(page: Page): Promise<CommanderListItem[]> {
  return page.evaluate(() => {
    const cards = [...document.querySelectorAll('a.piGH7G_container[href^="/commanders/"]')];
    const items: CommanderListItem[] = [];

    const parseDeckCountInPage = (raw: string): number => {
      const normalized = raw.trim().replace(',', '.').toUpperCase();
      const match = normalized.match(/^(\d+(?:\.\d+)?)\s*([KM]?)$/);
      if (!match) return 0;

      const base = Number(match[1]);
      if (Number.isNaN(base)) return 0;
      if (match[2] === 'K') return Math.round(base * 1_000);
      if (match[2] === 'M') return Math.round(base * 1_000_000);
      return Math.round(base);
    };

    for (const cardLink of cards) {
      const href = cardLink.getAttribute('href') || '';
      const slug = href.replace('/commanders/', '').trim();
      if (!slug) continue;

      const name = (cardLink.querySelector('.piGH7G_name')?.textContent || '').trim();
      if (!name) continue;

      const statsContainer = cardLink.closest('li, div');
      const statsText = (statsContainer?.textContent || '').replace(/\s+/g, ' ');
      const decksMatch = statsText.match(/([\d.,]+)\s*([KMkm]?)\s*Decks/i);
      const decksRaw = decksMatch ? `${decksMatch[1]}${decksMatch[2] || ''}` : '0';

      items.push({
        name,
        decks: parseDeckCountInPage(decksRaw),
        url: `https://edhrec.com${href}`,
        sanitized: slug,
        colors: [],
      });
    }

    return items;
  });
}

async function getMaxPageInCurrentView(page: Page): Promise<number> {
  return page.evaluate(() => {
    const links = [...document.querySelectorAll('a[href*="?page="]')];
    const numbers = links
      .map((a) => {
        const href = a.getAttribute('href') || '';
        const match = href.match(/[?&]page=(\d+)/i);
        return match ? Number(match[1]) : 0;
      })
      .filter((n) => Number.isInteger(n) && n > 0);

    if (numbers.length === 0) return 1;
    return Math.max(...numbers);
  });
}

async function scrapeCategory(browser: Browser, categoryUrl: string): Promise<CommanderListItem[]> {
  const results: CommanderListItem[] = [];
  let pageNum = 1;
  const categorySlug = categoryUrl.replace('/commanders/', '');
  const seenSlugs = new Set<string>();
  const page = await browser.newPage();

  try {
    let maxPageSeen = 1;

    while (true) {
      const url = `https://edhrec.com/commanders/${categorySlug}?page=${pageNum}`;
      console.log(`📄 Scrapeando ${url}`);

      let loaded = false;
      for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        try {
          await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 });
          await page.waitForSelector('a.piGH7G_container[href^="/commanders/"]', {
            state: 'attached',
            timeout: 20_000,
          });
          loaded = true;
          break;
        } catch (err: any) {
          console.warn(`  ⚠️ Intento ${attempt}/${MAX_RETRIES} fallido para ${url}: ${err.message}`);
          if (attempt < MAX_RETRIES) await sleep(attempt * 5000);
        }
      }

      if (!loaded) {
        console.error(`❌ No se pudo cargar ${url}`);
        break;
      }

      const maxInPage = await getMaxPageInCurrentView(page);
      if (maxInPage > maxPageSeen) maxPageSeen = maxInPage;

      const commanders = await extractCommandersFromPage(page);
      let addedThisPage = 0;
      for (const commander of commanders) {
        if (seenSlugs.has(commander.sanitized)) continue;
        seenSlugs.add(commander.sanitized);
        results.push(commander);
        addedThisPage++;
      }

      if (addedThisPage === 0) {
        console.log(`ℹ️ Sin nuevos commanders en ${categorySlug} (page=${pageNum}). Cortando paginación.`);
        break;
      }

      if (MAX_PAGES_PER_CATEGORY > 0 && pageNum >= MAX_PAGES_PER_CATEGORY) {
        console.log(`ℹ️ Límite alcanzado para categoría (${MAX_PAGES_PER_CATEGORY} páginas): ${categorySlug}`);
        break;
      }

      if (pageNum >= maxPageSeen) {
        break;
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
  try {
    const allUrls = await getAllCategoryUrls();
    const allCommanders: CommanderListItem[] = [];
    const browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });

    try {
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
    } finally {
      await browser.close();
    }

    const outputPath = path.resolve(__dirname, '../data/all-commanders.json');
    await fs.mkdir(path.dirname(outputPath), { recursive: true });
    const bySlug = new Map<string, any>();
    for (const commander of allCommanders) {
      const existing = bySlug.get(commander.sanitized);
      if (!existing || commander.decks > existing.decks) {
        bySlug.set(commander.sanitized, commander);
      }
    }
    const dedupedCommanders = [...bySlug.values()];
    await fs.writeFile(outputPath, JSON.stringify(dedupedCommanders, null, 2));

    console.log(`\n✅ Total de comandantes guardados: ${dedupedCommanders.length} en ${outputPath}`);
  } catch (error) {
    console.error('❌ scrape:all-commanders failed:', error);
    process.exit(1);
  }
})();