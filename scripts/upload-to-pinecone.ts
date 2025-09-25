// scripts/upload-to-pinecone.ts
import fs from 'fs/promises';
import path from 'path';
import { pinecone } from './pinecone';
import 'dotenv/config';

const INDEX_NAME = process.env.PINECONE_INDEX_NAME!;
const INDEX_HOST = process.env.PINECONE_INDEX_HOST!;
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
  const client = pinecone.index(INDEX_NAME, INDEX_HOST).namespace('__default__');

  const raw = await fs.readFile(FILE_PATH, 'utf-8');
  const commanders = JSON.parse(raw) as Entry[];

  console.log(`📄 Loaded ${commanders.length} commanders`);

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
  let batchIndex = 0;

  for (const batch of batches) {
    batchIndex++;
    console.log(`\n🔄 Processing batch ${batchIndex}/${batches.length} with ${batch.length} items`);

    try {
      const inputs = batch.map((r) => r.chunk_text);
      console.log(`📊 Generating embeddings for ${inputs.length} texts...`);

      const embeddingResponse = await pinecone.inference.embed('multilingual-e5-large', inputs, {
        input_type: 'passage',
        truncate: 'END',
      });

      const embeddings = embeddingResponse.data
        ? embeddingResponse.data.map((item: any) => item.values)
        : (embeddingResponse as any).embeddings?.map((e: any) => e.values);

      if (!embeddings || embeddings.length !== batch.length) {
        console.error('❌ Embeddings mismatch or missing');
        throw new Error('Embeddings invalid');
      }

      console.log(`✨ Generated ${embeddings.length} embeddings`);

      const vectors = batch.map((r, i) => ({
        id: r._id, // <-- ID final en Pinecone
        values: embeddings[i],
        metadata: {
          commander: r.commander,
          partner: r.partner ?? '',
          cards: JSON.stringify(r.cards), // se guarda como string
        },
      }));

      // Validación
      const invalidVectors = vectors.filter(
        (v) => !v.values || !Array.isArray(v.values) || v.values.length === 0 || !v.id
      );
      if (invalidVectors.length > 0) {
        console.error('❌ Invalid vectors found:', invalidVectors.length);
        console.error('First invalid vector:', invalidVectors[0]);
        throw new Error('Invalid embedding vectors detected');
      }

      // 📤 Subida
      await client.upsert(vectors);
      processedCount += vectors.length;

      console.log(`✅ Uploaded batch ${batchIndex}/${batches.length} (${vectors.length} vectors)`);
      console.log(
        `📊 Progress: ${processedCount}/${records.length} (${((processedCount / records.length) * 100).toFixed(1)}%)`
      );

      if (batchIndex < batches.length) {
        console.log('⏳ Waiting 3 seconds before next batch...');
        await delay(3000);
      }
    } catch (error: any) {
      console.error(`❌ Error in batch ${batchIndex}:`, error?.message ?? error);

      if (error?.message?.includes('RESOURCE_EXHAUSTED') || error?.status === 429) {
        console.log('⏳ Rate limit hit, waiting 60 seconds before retry...');
        await delay(60000);
        batchIndex--; // retry same batch
        continue;
      }

      console.log('⚠️ Skipping batch and continuing...');
    }
  }

  console.log(`\n🎉 Upload complete! Processed ${processedCount}/${records.length} records`);
}

uploadToPinecone().catch(console.error);
