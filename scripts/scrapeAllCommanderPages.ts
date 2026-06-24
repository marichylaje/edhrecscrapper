// scripts/scrapeAllCommanderPages.ts
/**
 * Este archivo es el scrapper base que genera los JSON por commander.
 * Lee de todos los commanders desde data/all-commanders.json
 * Scrappea en EDHREC por cada commander su informacion, sacando la info necesaria para popular pinecone
 * guarda la informacion en data/commanders/<slug>.json
 */

import fs from 'fs/promises';
import path from 'path';
import { chromium, Browser } from 'playwright';

const commandersPath = path.resolve(__dirname, '../data/all-commanders.json');
const outputDir = path.resolve(__dirname, '../data/commanders');
const DELAY_MS = 2500;
const MAX_RETRIES = 3;

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

async function scrapeCommanderPage(browser: Browser, slug: string) {
  const url = `https://edhrec.com/commanders/${slug}`;
  const page = await browser.newPage();

  try {
    console.log(`🌐 Cargando ${url}`);
    
    let success = false;
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
        // Esperamos a que un contenedor de cartas esté presente en el DOM
        await page.waitForSelector('.Card_container__Ng56K', { state: 'attached', timeout: 15_000 });
        success = true;
        break;
      } catch (err: any) {
        console.warn(`  ⚠️ Intento ${attempt}/${MAX_RETRIES} fallido para ${slug}: ${err.message}`);
        if (attempt < MAX_RETRIES) await sleep(attempt * 5000);
      }
    }

    if (!success) {
      console.error(`❌ No se pudo cargar correctamente la página para ${slug}`);
      return null;
    }

    const cards = await page.$$eval('.Card_container__Ng56K', (cardDivs) =>
      cardDivs.map((cardDiv) => {
        const name = cardDiv.querySelector('.Card_name__Mpa7S')?.textContent?.trim() || '';
        const labelText = cardDiv.querySelector('.CardLabel_label__iAM7T')?.textContent || '';
        const match = labelText.match(/(\d+)% of ([\d,]+) decks\s*\+(\d+)%/);
        const percent = match ? parseInt(match[1], 10) : null;
        const deckCount = match ? parseInt(match[2].replace(/,/g, ''), 10) : null;
        const synergy = match ? parseInt(match[3], 10) : null;

        return { name, percent, deckCount, synergy };
      })
    );

    return { slug, cards };
  } catch (err: any) {
    console.warn(`❌ Error inesperado procesando ${url}: ${err.message}`);
    return null;
  } finally {
    // Cerramos la pestaña individual de forma segura
    await page.close();
  }
}

(async () => {
  const commandersRaw = await fs.readFile(commandersPath, 'utf-8');
  const commanders = JSON.parse(commandersRaw);

  await fs.mkdir(outputDir, { recursive: true });

  // Instanciamos el navegador una sola vez fuera del bucle
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  try {
    for (const commander of commanders) {
      const slug = commander.sanitized;
      const outputFile = path.join(outputDir, `${slug}.json`);

      try {
        // Omitir si ya existe
        try {
          await fs.access(outputFile);
          console.log(`⏭ Ya existe ${slug}.json, omitido.`);
          continue;
        } catch {
          // No existe, continuar
        }

        const data = await scrapeCommanderPage(browser, slug);
        if (data) {
          await fs.writeFile(outputFile, JSON.stringify(data, null, 2));
          console.log(`✅ Guardado ${slug}.json con ${data.cards.length} cartas`);
        }
        
        await sleep(DELAY_MS);
      } catch (err) {
        console.error(`⚠️ Fallo al procesar ciclo de ${slug}: ${err}`);
      }
    }
  } finally {
    // Esto asegura que al terminar el script se maten todos los procesos zombis de Chromium
    await browser.close();
  }

  console.log('🏁 Scrapeo de comandantes finalizado.');
})();