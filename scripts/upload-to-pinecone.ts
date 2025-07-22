// scripts/upload-to-pinecone.ts
import fs from 'fs/promises';
import path from 'path';
import { pinecone } from './pinecone';
import 'dotenv/config';

const INDEX_NAME = process.env.PINECONE_INDEX_NAME!;
const INDEX_HOST = process.env.PINECONE_INDEX_HOST!;
const FILE_PATH = path.join(__dirname, 'commander-synergies.json');

async function uploadToPinecone() {
  const client = pinecone.index(INDEX_NAME, INDEX_HOST).namespace('__default__');

  const raw = await fs.readFile(FILE_PATH, 'utf-8');
  const commanders = JSON.parse(raw) as {
    commander: string;
    partner: string | null;
    cards: { name: string; synergy: number; deckCount: number }[];
  }[];

  const records = commanders.map((entry, idx) => {
    const synergySummary = entry.cards
      .slice(0, 20)
      .map((c) => `${c.name} (${c.synergy})`)
      .join(', ');

    return {
      _id: `commander-${idx}`,
      chunk_text: `${entry.commander}${entry.partner ? ' & ' + entry.partner : ''}: ${synergySummary}`,
      commander: entry.commander,
      ...(entry.partner ? { partner: entry.partner } : {}),
    };
  });

  // Función para dividir en batches
  const chunk = <T>(arr: T[], size: number) =>
    Array.from({ length: Math.ceil(arr.length / size) }, (_, i) =>
      arr.slice(i * size, i * size + size)
    );

    let batchIndex = 0;
    for (const batch of chunk(records, 96)) {
    batchIndex++;
    console.log(`🔄 Processing batch ${batchIndex} with ${batch.length} items`);

    const inputs = batch.map((r) => r.chunk_text);

    console.log(`📊 Generating embeddings for ${inputs.length} texts...`);
    
    try {
        const embeddingResponse = await pinecone.inference.embed(
            'multilingual-e5-large',
            inputs,
            { 
                input_type: 'passage', 
                truncate: 'END' 
            }
        );

        console.log('🔍 Embedding response structure:', JSON.stringify(embeddingResponse, null, 2).slice(0, 500));
        
        // Extract embeddings based on the actual response structure
        const embeddings = embeddingResponse.data ? 
            embeddingResponse.data.map((item: any) => item.values) : 
            (embeddingResponse as unknown as number[][]);

        console.log(`✨ Generated ${embeddings.length} embeddings, first embedding length: ${embeddings[0]?.length}`);
        
        // Additional debugging to check embedding structure
        console.log('🔍 First embedding sample:', embeddings[0]?.slice(0, 5));

        const vectors = batch.map((r, i) => ({
            id: r._id,
            values: embeddings[i],
            metadata: {
            commander: r.commander,
            ...(r.partner ? { partner: r.partner } : {}),
            },
        }));

        // Enhanced validation with more detailed logging
        const invalidVectors = vectors.filter(v => !v.values || !Array.isArray(v.values) || v.values.length === 0);
        if (invalidVectors.length > 0) {
            console.error('❌ Invalid vectors found:', invalidVectors.length);
            console.error('First invalid vector:', invalidVectors[0]);
            console.error('Embedding response type:', typeof embeddingResponse);
            console.error('Embeddings type:', typeof embeddings);
            console.error('First embedding type:', typeof embeddings[0]);
            throw new Error('Invalid embedding vectors detected');
        }

        await client.upsert(vectors);
        console.log(`✅ Upserted batch ${batchIndex} of ${vectors.length}`);

        // Add delay to avoid rate limiting (wait 1 minute between batches)
        if (batchIndex < chunk(records, 96).length) {
            console.log('⏳ Waiting 60 seconds to avoid rate limit...');
            await new Promise(resolve => setTimeout(resolve, 5000));
        }

    } catch (error: any) {
        if (error.message?.includes('RESOURCE_EXHAUSTED')) {
            console.log('⏳ Rate limit hit, waiting 60 seconds...');
            await new Promise(resolve => setTimeout(resolve, 60000));
            // Retry the same batch
            batchIndex--;
            continue;
        }
        throw error;
    }
    }


  console.log('🎉 Upload complete');
}

uploadToPinecone().catch(console.error);
