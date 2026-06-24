// scripts/compile-synergies.ts
/**
 * Lee JSONs de data/commanders y genera data/commander-synergies.json
 * resolviendo Scryfall IDs para commander/partner y produciendo un archivo final estructurado.
 */

import fs from 'fs/promises';
import path from 'path';
import axios from 'axios';

const COMMANDERS_DIR = path.join(__dirname, '..', 'data', 'commanders');
const OUTPUT_FILE = path.join(__dirname, '..', 'data', 'commander-synergies.json');

type CardEntry = {
  name: string;
  synergy: number | null;
  deckCount: number | null;
};

type InputData = {
  slug: string;
  cards: CardEntry[];
};

type ScryfallNamedResp = {
  id: string;
  name: string;
};

type OutputRow = {
  id: string;
  commander: string;
  partner: string | null;
  cards: {
    name: string;
    synergy: number;
    deckCount: number;
  }[];
};

const idCache = new Map<string, string>();
const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms));

async function fetchScryfallIdByName(name: string): Promise<string> {
  const key = name.trim();
  if (idCache.has(key)) return idCache.get(key)!;

  const url = `https://api.scryfall.com/cards/named?exact=${encodeURIComponent(key)}`;
  let lastError: any = null;

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      // Respetar estrictamente la política de Scryfall (recomedado > 100ms)
      await sleep(150);

      const res = await axios.get<ScryfallNamedResp>(url, {
        timeout: 15000,
        validateStatus: () => true, // Evita que axios lance excepciones en códigos 4xx/5xx
      });

      // Manejo inteligente de Rate Limiting (HTTP 429)
      if (res.status === 429) {
        console.warn(`🛑 [Rate Limit] Scryfall nos bloqueó. Esperando 65 segundos antes del intento ${attempt}/3...`);
        await sleep(65000); // Dormir el script el tiempo solicitado por Scryfall
        continue;
      }

      if (res.status >= 200 && res.status < 300 && res.data?.id) {
        const id = res.data.id;
        idCache.set(key, id);
        return id;
      }

      lastError = new Error(
        `HTTP ${res.status} ${res.statusText} - ${JSON.stringify(res.data)?.slice(0, 200)}`
      );
    } catch (e: any) {
      lastError = e;
    }

    // Esperar un backoff exponencial si es un error común de red
    await sleep(attempt * 1000);
  }

  throw new Error(
    `Failed to resolve Scryfall ID for "${name}": ${lastError?.message ?? lastError}`
  );
}

async function compileSynergies() {
  const files = await fs.readdir(COMMANDERS_DIR);
  const output: OutputRow[] = [];

  let processed = 0;
  let skipped = 0;

  for (const file of files) {
    if (!file.endsWith('.json')) continue;

    try {
      const filePath = path.join(COMMANDERS_DIR, file);
      const content = await fs.readFile(filePath, 'utf-8');
      const json: InputData = JSON.parse(content);

      const commanderCard = json.cards?.[0];
      if (!commanderCard?.name) {
        skipped++;
        continue;
      }

      // Detectar partner si viene "A // B" en la 1ª carta
      const [rawCommander, rawPartner] = commanderCard.name.split(' // ');
      const commander = rawCommander?.trim();
      const partner = rawPartner ? rawPartner.trim() : null;

      // Top 120 por synergy
      const topCards = json.cards
        .slice(1)
        .filter((c) => typeof c.synergy === 'number')
        .sort((a, b) => (b.synergy! - a.synergy!))
        .slice(0, 120)
        .map((c) => ({
          name: c.name,
          synergy: c.synergy as number,
          deckCount: c.deckCount ?? 0,
        }));

      // Resolver IDs con Scryfall
      const commanderId = await fetchScryfallIdByName(commander);
      const partnerId = partner ? await fetchScryfallIdByName(partner) : null;

      const id = partnerId ? `${commanderId}__${partnerId}` : commanderId;

      output.push({
        id,
        commander,
        partner,
        cards: topCards,
      });

      processed++;
      if (processed % 50 === 0) {
        console.log(`…progreso: ${processed} procesados (${skipped} omitidos)`);
      }
    } catch (error: any) {
      console.warn(`⚠️ Error procesando "${file}":`, error.message || error);
      skipped++;
      // Si el error persistente fue un 429 general, pausamos el bucle general de archivos
      if (error.message?.includes('429')) {
        console.log('⏳ Pausando el procesamiento por 60 segundos debido a un bloqueo masivo...');
        await sleep(60000);
      }
      continue;
    }
  }

  await fs.mkdir(path.dirname(OUTPUT_FILE), { recursive: true });
  await fs.writeFile(OUTPUT_FILE, JSON.stringify(output, null, 2), 'utf-8');

  console.log(`\n✅ Archivo generado con éxito: ${OUTPUT_FILE}`);
  console.log(`   Total OK: ${processed} | Omitidos: ${skipped}`);
}

compileSynergies().catch((e) => {
  console.error('❌ compileSynergies failed:', e);
  process.exit(1);
});