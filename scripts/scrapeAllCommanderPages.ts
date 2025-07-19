// scripts/scrapeAllCommanderPages.ts
import fs from 'fs/promises';
import path from 'path';
import { chromium } from 'playwright';

const commandersPath = path.resolve(__dirname, '../data/all-commanders.json');
const outputDir = path.resolve(__dirname, '../data/commanders');

async function scrapeCommanderPage(slug: string) {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  const url = `https://edhrec.com/commanders/${slug}`;

  try {
    console.log(`🌐 Cargando ${url}`);
    await page.goto(url, { waitUntil: 'networkidle' });

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

    await browser.close();
    return { slug, cards };
  } catch (err: any) {
    console.warn(`❌ Error en ${url}: ${err.message}`);
    await browser.close();
    return null;
  }
}

(async () => {
  const commandersRaw = await fs.readFile(commandersPath, 'utf-8');
  const commanders = JSON.parse(commandersRaw);

  await fs.mkdir(outputDir, { recursive: true });

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

      const data = await scrapeCommanderPage(slug);
      if (data) {
        await fs.writeFile(outputFile, JSON.stringify(data, null, 2));
        console.log(`✅ Guardado ${slug}.json con ${data.cards.length} cartas`);
      }
    } catch (err) {
      console.error(`⚠️ Fallo al procesar ${slug}: ${err}`);
    }
  }

  console.log('🏁 Scrapeo de comandantes finalizado.');
})();
//TODO: SEARCH FOR TAGS en cards para agregar info a los commanders, es buena info para agruparlos por algo tal vez