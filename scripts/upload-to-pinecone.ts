// scripts/upload-to-pinecone.ts
import 'dotenv/config';
import fs from 'fs/promises';
import path from 'path';
import type { Index } from '@pinecone-database/pinecone';
import { pinecone } from './pinecone';

const INDEX_NAME = process.env.PINECONE_INDEX_NAME!;
const INDEX_HOST = process.env.PINECONE_INDEX_HOST!;
const INDEX_NAMESPACE = process.env.PINECONE_NAMESPACE || '__default__';
const FULL_REFRESH = String(process.env.PINECONE_FULL_REFRESH || 'false').toLowerCase() === 'true';
const MAX_BATCH_RETRIES = Number(process.env.PINECONE_MAX_BATCH_RETRIES || 3);
const MIN_PRUNE_RATIO = Number(process.env.PINECONE_MIN_PRUNE_RATIO || 0.8);
const FILE_PATH = path.resolve(__dirname, '../data/commander-synergies.json');

// 🔄 Divide array en chunks
function chunk<T>(array: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < array.length; i += size) {
    chunks.push(array.slice(i, i + size));
  }
  return chunks;
}

// ⏳ Delay helper
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// Tipos de entrada esperada en commander-synergies.json
type Entry = {
  id: string; // <-- ya viene con <commanderId>[__<partnerId>]
  commander: string;
  partner: string | null;
  cards: { name: string; synergy: number; deckCount: number }[];
};

async function uploadToPinecone() {
  const client = pinecone.index(INDEX_NAME, INDEX_HOST).namespace(INDEX_NAMESPACE);

  const raw = await fs.readFile(FILE_PATH, 'utf-8');
  const commanders = JSON.parse(raw) as Entry[];

  if (!Array.isArray(commanders) || commanders.length === 0) {
    throw new Error('commander-synergies.json está vacío o tiene formato inválido');
  }

  console.log(`📄 Loaded ${commanders.length} commanders`);
  console.log(`📍 Namespace: ${INDEX_NAMESPACE}`);

  if (FULL_REFRESH) {
    console.log('🧹 Full refresh habilitado: los registros obsoletos se podarán DESPUÉS de subir los nuevos.');
  }

  // Preparamos records: id + chunk_text + metadata
  const records = commanders.map((entry) => {
    const synergySummary = entry.cards
      .slice(0, 20)
      .map((c) => `${c.name} (${c.synergy})`)
      .join(', ');

    return {
      _id: entry.id, // usamos el id ya generado
      chunk_text: `${entry.commander}${entry.partner ? ' & ' + entry.partner : ''}: ${synergySummary}`,
      commander: entry.commander,
      partner: entry.partner,
      cards: entry.cards,
    };
  });

  // 📦 Dividir en lotes de 96
  const batches = chunk(records, 96);
  console.log(`🔄 Processing ${records.length} records in ${batches.length} batches of 96`);

  let processedCount = 0;
  let failedBatches = 0;
  let failedRecords = 0;

  for (let batchIndex = 0; batchIndex < batches.length; batchIndex++) {
    const batch = batches[batchIndex];
    const displayBatchNumber = batchIndex + 1;
    console.log(`\n🔄 Processing batch ${displayBatchNumber}/${batches.length} with ${batch.length} items`);

    let attempt = 0;
    let uploaded = false;

    while (attempt < MAX_BATCH_RETRIES && !uploaded) {
      attempt++;

      try {
        const inputs = batch.map((r) => r.chunk_text);
        console.log(`📊 Generating embeddings for ${inputs.length} texts... (attempt ${attempt}/${MAX_BATCH_RETRIES})`);

        const embeddingResponse = await pinecone.inference.embed('multilingual-e5-large', inputs, {
          input_type: 'passage',
          truncate: 'END',
        });

        const embeddings = embeddingResponse.data
          ? embeddingResponse.data.map((item: any) => item.values)
          : (embeddingResponse as any).embeddings?.map((e: any) => e.values);

        if (!embeddings || embeddings.length !== batch.length) {
          throw new Error('Embeddings invalid: mismatch o falta de resultados');
        }

        console.log(`✨ Generated ${embeddings.length} embeddings`);

        const vectors = batch.map((r, i) => ({
          id: r._id,
          values: embeddings[i],
          metadata: {
            commander: r.commander,
            partner: r.partner ?? '',
            cards: JSON.stringify(r.cards),
          },
        }));

        const invalidVectors = vectors.filter(
          (v) => !v.values || !Array.isArray(v.values) || v.values.length === 0 || !v.id
        );
        if (invalidVectors.length > 0) {
          throw new Error(`Invalid embedding vectors detected: ${invalidVectors.length}`);
        }

        await client.upsert(vectors);
        processedCount += vectors.length;
        uploaded = true;

        console.log(`✅ Uploaded batch ${displayBatchNumber}/${batches.length} (${vectors.length} vectors)`);
        console.log(
          `📊 Progress: ${processedCount}/${records.length} (${((processedCount / records.length) * 100).toFixed(1)}%)`
        );
      } catch (error: any) {
        const message = error?.message ?? String(error);
        console.error(`❌ Error in batch ${displayBatchNumber} (attempt ${attempt}/${MAX_BATCH_RETRIES}):`, message);

        const isRateLimit = message.includes('RESOURCE_EXHAUSTED') || error?.status === 429;
        if (isRateLimit && attempt < MAX_BATCH_RETRIES) {
          console.log('⏳ Rate limit hit, waiting 60 seconds before retry...');
          await delay(60000);
          continue;
        }

        if (attempt >= MAX_BATCH_RETRIES) {
          break;
        }

        console.log('⏳ Waiting 5 seconds before retry...');
        await delay(5000);
      }
    }

    if (!uploaded) {
      failedBatches++;
      failedRecords += batch.length;
      console.error(`⚠️ Batch ${displayBatchNumber} failed after ${MAX_BATCH_RETRIES} attempts`);
    }

    if (displayBatchNumber < batches.length) {
      await delay(3000);
    }
  }

  console.log(`\n📦 Upload summary: processed=${processedCount}, failed=${failedRecords}`);

  if (failedBatches > 0) {
    throw new Error(`Upload incompleto: ${failedBatches} batch(es) fallaron y ${failedRecords} registros no se subieron`);
  }

  console.log(`🎉 Upload complete! Processed ${processedCount}/${records.length} records`);

  if (FULL_REFRESH) {
    await pruneStaleVectors(client, new Set(records.map((r) => r._id)));
  }
}

// Elimina del namespace los IDs que ya no están en el dataset nuevo.
// Solo se ejecuta tras un upload 100% exitoso y con una salvaguarda: si el dataset nuevo es mucho
// más chico que lo que hay en el índice (scrape parcial), NO se poda nada para no perder datos.
async function pruneStaleVectors(client: Index, freshIds: Set<string>) {
  console.log('🧹 Buscando vectores obsoletos en Pinecone...');

  const existingIds: string[] = [];
  let paginationToken: string | undefined;
  do {
    const page = await client.listPaginated({ paginationToken });
    for (const v of page.vectors || []) {
      if (v.id) existingIds.push(v.id);
    }
    paginationToken = page.pagination?.next;
  } while (paginationToken);

  const staleIds = existingIds.filter((id) => !freshIds.has(id));
  console.log(`📊 En índice: ${existingIds.length} | nuevos: ${freshIds.size} | obsoletos: ${staleIds.length}`);

  if (staleIds.length === 0) return;

  if (freshIds.size < existingIds.length * MIN_PRUNE_RATIO) {
    console.warn(
      `⚠️ Poda omitida: el dataset nuevo (${freshIds.size}) es menor al ${MIN_PRUNE_RATIO * 100}% del índice ` +
        `(${existingIds.length}). Probable scrape parcial; se conservan los registros existentes.`
    );
    return;
  }

  for (const ids of chunk(staleIds, 500)) {
    await client.deleteMany(ids);
  }
  console.log(`✅ Eliminados ${staleIds.length} vectores obsoletos`);
}

uploadToPinecone().catch((error) => {
  console.error('❌ uploadToPinecone failed:', error);
  process.exit(1);
});
