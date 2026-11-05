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
// Cada worker espera este delay entre peticiones; la tasa total ≈ CONCURRENCY / (DELAY + latencia)
const DELAY_MS = Number(process.env.SCRAPE_DELAY_MS || 400);
const CONCURRENCY = Math.max(1, Number(process.env.SCRAPE_CONCURRENCY || 5));
const MAX_RETRIES = 4;
// 0 = sin límite. Al agotarse, el script corta limpiamente y sale con código 0.
const TIME_BUDGET_MS = Number(process.env.SCRAPE_TIME_BUDGET_MINUTES || 0) * 60_000;
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
  potential_decks?: number;
  lift?: number;
};

type CommanderJsonResponse = {
  header?: string;
  // Presente cuando el slug existe pero con otro orden (ej. "tymna-...-thrasios-..." -> "/commanders/thrasios-...-tymna-...")
  redirect?: string;
  container?: {
    json_dict?: {
      cardlists?: Array<{
        tag?: string;
        cardviews?: CommanderJsonCardView[];
      }>;
    };
  };
};

// Categorías de EDHREC con información funcional/tipo → código corto (ahorra bytes en metadata).
// Las listas "topcards", "highliftcards" y "newcards" no aportan categoría.
const CATEGORY_BY_TAG: Record<string, string> = {
  manaartifacts: 'ma',
  utilityartifacts: 'ua',
  utilitylands: 'ul',
  lands: 'la',
  creatures: 'cr',
  instants: 'in',
  sorceries: 'so',
  enchantments: 'en',
  planeswalkers: 'pw',
  battles: 'ba',
};

// EDHREC sirve estos JSON desde un bucket: 403/404 significa "esta página no existe"
// (típico en combinaciones de partners que nadie juega), no un fallo transitorio.
class NotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NotFoundError';
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

async function fetchJsonOnce(slug: string): Promise<CommanderJsonResponse> {
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
        throw new NotFoundError(`No existe en EDHREC JSON (${status}) para ${slug}`);
      }

      console.warn(`  ⚠️ Intento ${attempt}/${MAX_RETRIES} fallido para ${slug}: ${err.message}`);
      if (attempt < MAX_RETRIES) {
        const retryAfterSec = Number(err?.response?.headers?.['retry-after']);
        const backoff = Number.isFinite(retryAfterSec) && retryAfterSec > 0
          ? retryAfterSec * 1000
          : attempt * 3000;
        await sleep(backoff);
      }
    }
  }

  throw new Error(`No se pudo obtener JSON para ${slug} luego de ${MAX_RETRIES} intentos`);
}

// Sigue los redirects de EDHREC hacia el slug canónico (orden de las parejas).
async function fetchCommanderJson(slug: string): Promise<CommanderJsonResponse> {
  let currentSlug = slug;
  const visited = new Set<string>([slug]);

  for (let hop = 0; hop < 3; hop++) {
    const data = await fetchJsonOnce(currentSlug);
    if (!data.redirect) return data;

    const target = data.redirect.replace(/^\/?commanders\//, '').replace(/^\/+|\/+$/g, '');
    if (!target || visited.has(target)) {
      throw new NotFoundError(`Redirect inválido o circular para ${slug}`);
    }

    visited.add(target);
    currentSlug = target;
  }

  throw new NotFoundError(`Demasiados redirects para ${slug}`);
}

async function scrapeCommanderPage(slug: string) {
  const data = await fetchCommanderJson(slug);

  const commanderName = parseCommanderNameFromHeader(data.header);
  if (!commanderName) {
    console.warn(`⚠️ Respuesta sin cabecera de comandante para ${slug}; se omite.`);
    return null;
  }

  const cardlists = data?.container?.json_dict?.cardlists || [];
  type Entry = {
    name: string;
    percent: number | null;
    deckCount: number | null;
    synergy: number | null;
    lift: number | null;
    category: string | null;
  };
  const byName = new Map<string, Entry>();

  for (const list of cardlists) {
    const category = list.tag ? CATEGORY_BY_TAG[list.tag] ?? null : null;
    for (const card of list.cardviews || []) {
      if (!card.name) continue;
      const synergy = toPercentValue(card.synergy);
      if (synergy === null) continue;

      const deckCount = typeof card.num_decks === 'number' ? card.num_decks : null;
      const potential = typeof card.potential_decks === 'number' ? card.potential_decks : 0;
      const entry: Entry = {
        name: card.name,
        // % de mazos del comandante que incluyen la carta
        percent: deckCount !== null && potential > 0 ? Math.round((deckCount / potential) * 100) : null,
        deckCount,
        synergy,
        lift: typeof card.lift === 'number' ? Math.round(card.lift * 100) / 100 : null,
        category,
      };

      const previous = byName.get(card.name);
      if (!previous) {
        byName.set(card.name, entry);
        continue;
      }
      // Conserva el mejor synergy pero no pierde la categoría si solo una lista la trae
      const best = (entry.synergy ?? -9999) > (previous.synergy ?? -9999) ? entry : previous;
      best.category = best.category ?? entry.category ?? previous.category;
      byName.set(card.name, best);
    }
  }

  const cards = [
    { name: commanderName, percent: null, deckCount: null, synergy: null, lift: null, category: null },
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

  const startedAt = Date.now();
  const failedSlugs: string[] = [];
  let okCount = 0;
  let alreadyCount = 0;
  let notFoundCount = 0;
  let emptyCount = 0;
  let notStartedCount = 0;
  let processed = 0;
  let cursor = 0;
  let budgetExhausted = false;

  const total = commanders.length;
  console.log(
    `🚀 scrape:pages -> ${total} commanders | concurrencia=${CONCURRENCY} | delay=${DELAY_MS}ms | ` +
      `presupuesto=${TIME_BUDGET_MS ? `${TIME_BUDGET_MS / 60_000} min` : 'sin límite'}`
  );

  const processOne = async (slug: string) => {
    const outputFile = path.join(outputDir, `${slug}.json`);

    if (!FORCE_REFRESH) {
      try {
        await fs.access(outputFile);
        alreadyCount++;
        return;
      } catch {
        // No existe, continuar
      }
    }

    try {
      const data = await scrapeCommanderPage(slug);
      if (data) {
        await fs.writeFile(outputFile, JSON.stringify(data, null, 2));
        okCount++;
      } else {
        emptyCount++;
      }
    } catch (err: any) {
      if (err instanceof NotFoundError) {
        // Sin delay ni reintentos: es una página inexistente, no un error.
        notFoundCount++;
        return;
      }
      console.error(`⚠️ Fallo al procesar ${slug}: ${err?.message || err}`);
      failedSlugs.push(slug);
    }

    await sleep(DELAY_MS);
  };

  const worker = async () => {
    while (true) {
      if (TIME_BUDGET_MS > 0 && Date.now() - startedAt >= TIME_BUDGET_MS) {
        budgetExhausted = true;
        return;
      }

      const index = cursor++;
      if (index >= total) return;

      await processOne(commanders[index].sanitized);

      processed++;
      if (processed % 250 === 0) {
        const minutes = ((Date.now() - startedAt) / 60_000).toFixed(1);
        console.log(
          `…progreso: ${processed}/${total} (${minutes} min) | OK: ${okCount} | ya existían: ${alreadyCount} | ` +
            `inexistentes: ${notFoundCount} | vacíos: ${emptyCount} | fallidos: ${failedSlugs.length}`
        );
      }
    }
  };

  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));

  if (budgetExhausted) {
    notStartedCount = Math.max(0, total - cursor);
    console.warn(
      `⏱️ Presupuesto de tiempo agotado: se cortó con ${notStartedCount} commanders sin procesar. ` +
        'Se continúa con lo scrapeado hasta ahora.'
    );
  }

  const failedPath = path.resolve(__dirname, '../data/failed-commanders.json');
  if (failedSlugs.length > 0) {
    await fs.writeFile(failedPath, JSON.stringify(failedSlugs, null, 2));
    console.log(`⚠️ Listado de fallos transitorios guardado en ${failedPath}`);
  }

  const minutes = ((Date.now() - startedAt) / 60_000).toFixed(1);
  console.log(
    `📊 Resumen scrape:pages (${minutes} min) -> OK: ${okCount} | ya existían: ${alreadyCount} | ` +
      `inexistentes en EDHREC: ${notFoundCount} | sin cartas útiles: ${emptyCount} | ` +
      `fallidos: ${failedSlugs.length} | sin procesar: ${notStartedCount}`
  );

  // Fallar solo si no se pudo scrapear nada útil (señal de que EDHREC cambió o bloquea).
  if (okCount + alreadyCount === 0) {
    console.error('❌ No se obtuvo ningún commander. Abortando para no subir datos vacíos.');
    process.exit(1);
  }

  console.log('🏁 Scrapeo de comandantes finalizado.');
})();