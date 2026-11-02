// scripts/scrapeAllCommanderPages.ts
/**
 * Este archivo es el scrapper base que genera los JSON por commander.
 * Lee de todos los commanders desde data/all-commanders.json
 * Scrappea en EDHREC por cada commander su informacion, sacando la info necesaria para popular pinecone
 * guarda la informacion en data/commanders/<slug>.json
 */

import fs from 'fs/promises';
import path from 'path';
import axios from 'axios';

const commandersPath = path.resolve(__dirname, '../data/all-commanders.json');
const outputDir = path.resolve(__dirname, '../data/commanders');
const DELAY_MS = Number(process.env.SCRAPE_DELAY_MS || 1500);
const MAX_RETRIES = 3;
const FORCE_REFRESH = String(process.env.SCRAPE_FORCE_REFRESH || 'false').toLowerCase() === 'true';
const EDHREC_JSON_BASE = 'https://json.edhrec.com/pages';

const REQUEST_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (compatible; EDHRECScrapper/1.0)',
  Accept: 'application/json,text/plain,*/*',
  Referer: 'https://edhrec.com/',
};

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

type CommanderJsonCardView = {
  name?: string;
  synergy?: number;
  num_decks?: number;
};

type CommanderJsonResponse = {
  header?: string;
  container?: {
    json_dict?: {
      cardlists?: Array<{
        cardviews?: CommanderJsonCardView[];
      }>;
    };
  };
};

class NonRetryableFetchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NonRetryableFetchError';
  }
}

function parseCommanderNameFromHeader(header?: string): string | null {
  if (!header) return null;
  const cleaned = header.replace(/\s*\(Commander\)\s*$/i, '').trim();
  return cleaned || null;
}

function toPercentValue(value: number | undefined): number | null {
  if (typeof value !== 'number' || Number.isNaN(value)) return null;
  return Math.round(value * 100);
}

async function fetchCommanderJson(slug: string): Promise<CommanderJsonResponse> {
  const url = `${EDHREC_JSON_BASE}/commanders/${slug}.json`;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const response = await axios.get<CommanderJsonResponse>(url, {
        headers: REQUEST_HEADERS,
        timeout: 30_000,
      });
      return response.data;
    } catch (err: any) {
      const status = err?.response?.status;
      if (status === 403 || status === 404) {
        throw new NonRetryableFetchError(`No disponible en EDHREC JSON (${status}) para ${slug}`);
      }

      console.warn(`  ⚠️ Intento ${attempt}/${MAX_RETRIES} fallido para ${slug}: ${err.message}`);
      if (attempt < MAX_RETRIES) {
        await sleep(attempt * 5000);
      }
    }
  }

  throw new Error(`No se pudo obtener JSON para ${slug} luego de ${MAX_RETRIES} intentos`);
}

async function scrapeCommanderPage(slug: string) {
  console.log(`🌐 Cargando ${slug} desde JSON de EDHREC...`);
  const data = await fetchCommanderJson(slug);

  const commanderName = parseCommanderNameFromHeader(data.header);
  if (!commanderName) {
    console.error(`❌ No se pudo parsear el nombre del comandante para ${slug}`);
    return null;
  }

  const cardlists = data?.container?.json_dict?.cardlists || [];
  const byName = new Map<string, { name: string; percent: number | null; deckCount: number | null; synergy: number | null }>();

  for (const list of cardlists) {
    for (const card of list.cardviews || []) {
      if (!card.name) continue;
      const synergy = toPercentValue(card.synergy);
      if (synergy === null) continue;

      const deckCount = typeof card.num_decks === 'number' ? card.num_decks : null;
      const entry = {
        name: card.name,
        percent: null,
        deckCount,
        synergy,
      };

      const previous = byName.get(card.name);
      if (!previous || (entry.synergy ?? -9999) > (previous.synergy ?? -9999)) {
        byName.set(card.name, entry);
      }
    }
  }

  const cards = [
    { name: commanderName, percent: null, deckCount: null, synergy: null },
    ...[...byName.values()].sort((a, b) => (b.synergy ?? -9999) - (a.synergy ?? -9999)),
  ];

  if (cards.length <= 1) {
    return null;
  }

  return { slug, cards };
}

(async () => {
  const commandersRaw = await fs.readFile(commandersPath, 'utf-8');
  const commanders = JSON.parse(commandersRaw);

  await fs.mkdir(outputDir, { recursive: true });
  const failedSlugs: string[] = [];
  let successCount = 0;
  let skippedCount = 0;
  let failedCount = 0;

  for (const commander of commanders) {
    const slug = commander.sanitized;
    const outputFile = path.join(outputDir, `${slug}.json`);

    try {
      if (!FORCE_REFRESH) {
        // Omitir si ya existe
        try {
          await fs.access(outputFile);
          console.log(`⏭ Ya existe ${slug}.json, omitido.`);
          skippedCount++;
          continue;
        } catch {
          // No existe, continuar
        }
      }

      const data = await scrapeCommanderPage(slug);
      if (data) {
        await fs.writeFile(outputFile, JSON.stringify(data, null, 2));
        console.log(`✅ Guardado ${slug}.json con ${data.cards.length} cartas`);
        successCount++;
      } else {
        console.log(`ℹ️ ${slug} no tiene cartas útiles para sinergias. Omitido.`);
        skippedCount++;
      }

      await sleep(DELAY_MS);
    } catch (err) {
      console.error(`⚠️ Fallo al procesar ciclo de ${slug}: ${err}`);
      failedSlugs.push(slug);
      failedCount++;
      await sleep(250);
    }
  }

  if (failedSlugs.length > 0) {
    const failedPath = path.resolve(__dirname, '../data/failed-commanders.json');
    await fs.writeFile(failedPath, JSON.stringify(failedSlugs, null, 2));
    console.log(`⚠️ Se guardó listado de fallos en ${failedPath}`);
  }

  console.log(`📊 Resumen scrape:pages -> OK: ${successCount} | Omitidos: ${skippedCount} | Fallidos: ${failedCount}`);
  console.log('🏁 Scrapeo de comandantes finalizado.');
})();