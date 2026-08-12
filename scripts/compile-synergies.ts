// scripts/compile-synergies.ts
/**
 * Lee JSONs de data/commanders y genera data/commander-synergies.json
 * Resolviendo IDs mediante la descarga inicial del Bulk Data para evitar Rate Limits (429).
 */

import fs from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';
import axios from 'axios';
import { gunzipSync } from 'zlib';

const COMMANDERS_DIR = path.join(__dirname, '..', 'data', 'commanders');
const OUTPUT_FILE = path.join(__dirname, '..', 'data', 'commander-synergies.json');
const SCRYFALL_BULK_INFO_URL = 'https://api.scryfall.com/bulk-data';

type CardEntry = {
  name: string;
  synergy: number | null;
  deckCount: number | null;
};

type InputData = {
  slug: string;
  cards: CardEntry[];
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

type ScryfallBulkInfoItem = {
  type: string;
  name?: string;
  download_uri?: string;
  jsonl_download_uri?: string;
};

type ScryfallOracleCard = {
  name?: string;
  id?: string;
};

// Mapa en memoria: Nombre de la carta (minúsculas) -> Scryfall ID
const scryfallIdMap = new Map<string, string>();

/**
 * Descarga el Bulk Data de "Oracle Cards" de Scryfall y mapea todos los IDs en memoria.
 * Soporta tanto el esquema antiguo con download_uri como el actual con jsonl_download_uri.
 */
async function loadScryfallIdMapInMemory() {
  console.log('🔍 Obteniendo URL del Bulk Data de Scryfall...');
  const infoRes = await axios.get<{ data: ScryfallBulkInfoItem[] }>(SCRYFALL_BULK_INFO_URL);
  const oracleBulk = infoRes.data.data.find(
    (item) => item.type === 'oracle_cards' || item.name?.toLowerCase() === 'oracle cards'
  );
  const downloadUrl = oracleBulk?.jsonl_download_uri ?? oracleBulk?.download_uri;

  if (!downloadUrl) {
    throw new Error('No se pudo encontrar el archivo "oracle_cards" en la metadata de Scryfall.');
  }

  console.log(`📥 Descargando catálogo completo de Scryfall (Oracle Cards)...`);
  const bulkRes = await axios.get<ArrayBuffer>(downloadUrl, { responseType: 'arraybuffer' });

  const rawText = downloadUrl.endsWith('.gz')
    ? gunzipSync(Buffer.from(bulkRes.data)).toString('utf-8')
    : Buffer.from(bulkRes.data).toString('utf-8');

  const bulkCards: ScryfallOracleCard[] = rawText
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));

  console.log(`⚙️ Mapeando ${bulkCards.length} cartas en memoria...`);
  for (const card of bulkCards) {
    if (card.name && card.id) {
      const lowerName = card.name.toLowerCase().trim();
      
      // Guardar el nombre tal y como viene en Scryfall (ej: "A // B")
      scryfallIdMap.set(lowerName, card.id);

      // NUEVO: Si es una carta de doble cara, guardar también solo la cara frontal (ej: "A")
      if (lowerName.includes(' // ')) {
        const frontalName = lowerName.split(' // ')[0].trim();
        scryfallIdMap.set(frontalName, card.id);
      }
    }
  }
  console.log('✅ Catálogo de IDs cargado perfectamente con soporte para cartas de doble cara.');
}

async function compileSynergies() {
  // 1. Cargar catálogo completo para no hacer llamadas individuales por red
  await loadScryfallIdMapInMemory();

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

      // Búsqueda instantánea en el mapa local (Cero latencia, cero error 429)
      const commanderId = scryfallIdMap.get(commander.toLowerCase());
      const partnerId = partner ? scryfallIdMap.get(partner.toLowerCase()) : null;

      if (!commanderId) {
        console.warn(`⚠️ No se encontró ID en Scryfall para el comandante: "${commander}" (Omitiendo)`);
        skipped++;
        continue;
      }

      if (partner && !partnerId) {
        console.warn(`⚠️ No se encontró ID en Scryfall para el partner: "${partner}" (Omitiendo)`);
        skipped++;
        continue;
      }

      const id = partnerId ? `${commanderId}__${partnerId}` : commanderId;

      output.push({
        id,
        commander,
        partner,
        cards: topCards,
      });

      processed++;
      if (processed % 500 === 0) {
        console.log(`…progreso: ${processed} procesados (${skipped} omitidos)`);
      }
    } catch (error: any) {
      console.warn(`⚠️ Error procesando "${file}":`, error.message || error);
      skipped++;
      continue;
    }
  }

  await fs.mkdir(path.dirname(OUTPUT_FILE), { recursive: true });
  await fs.writeFile(OUTPUT_FILE, JSON.stringify(output, null, 2), 'utf-8');

  console.log(`\n✅ Archivo de sinergias generado con éxito: ${OUTPUT_FILE}`);
  console.log(`   Total OK: ${processed} | Omitidos: ${skipped}`);
}

compileSynergies().catch((e) => {
  console.error('❌ compileSynergies failed:', e);
  process.exit(1);
});