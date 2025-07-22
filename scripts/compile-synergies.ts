import fs from 'fs/promises';
import path from 'path';

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

type OutputData = {
  commander: string;
  partner: string | null;
  cards: {
    name: string;
    synergy: number;
    deckCount: number;
  }[];
};

async function compileSynergies() {
  const files = await fs.readdir(COMMANDERS_DIR);
  const output: OutputData[] = [];

  for (const file of files) {
    if (!file.endsWith('.json')) continue;

    try {
      const filePath = path.join(COMMANDERS_DIR, file);
      const content = await fs.readFile(filePath, 'utf-8');
      const json: InputData = JSON.parse(content);

      const commanderCard = json.cards[0];
      if (!commanderCard?.name) continue;

      const [commander, partner] = commanderCard.name.split(' // ');

      const topCards = json.cards
        .slice(1) // skip the commander itself
        .filter((c) => c.synergy !== null && typeof c.synergy === 'number')
        .sort((a, b) => (b.synergy! - a.synergy!))
        .slice(0, 120)
        .map((c) => ({
          name: c.name,
          synergy: c.synergy!,
          deckCount: c.deckCount ?? 0,
        }));

      output.push({
        commander: commander.trim(),
        partner: partner?.trim() || null,
        cards: topCards,
      });
    } catch (error) {
      console.warn(`⚠️ Error leyendo/parsing "${file}":`, error);
      continue;
    }
  }

  await fs.writeFile(OUTPUT_FILE, JSON.stringify(output, null, 2), 'utf-8');
  console.log(`✅ Archivo generado con éxito: ${OUTPUT_FILE}`);
}

compileSynergies();
