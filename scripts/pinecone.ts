import { Pinecone } from '@pinecone-database/pinecone';
import 'dotenv/config';

export const pinecone = new Pinecone({
  apiKey: process.env.PINECONE_API_KEY!, // usa variables de entorno
});
