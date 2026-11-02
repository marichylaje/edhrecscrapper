// scripts/scrapeCommandersList.playwright.ts
/**
 * Este archivo produce el archivo inicial data/all-commanders.json
 * es el primero que ha de ser corrido para obtener toda la lista de commanders.
 *
 * Fuente maestra: Scryfall (is:commander legal:commander)
 * Objetivo: mantener contrato compatible con scripts posteriores.
 */
import fs from 'fs/promises';
import path from 'path';
import axios from 'axios';

const MAX_RETRIES = 3;
const SCRYFALL_SEARCH_URL = 'https://api.scryfall.com/cards/search';
const SCRYFALL_QUERY = 'is:commander legal:commander';
const MAX_SCRYFALL_PAGES = Number(process.env.SCRAPE_MAX_PAGES_PER_CATEGORY || 0);
const DELAY_BETWEEN_REQUESTS_MS = 150;

const REQUEST_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (compatible; EDHRECScrapper/1.0)',
  Accept: 'application/json,text/plain,*/*',
};

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

type ScryfallCard = {
  name?: string;
  color_identity?: string[];
  keywords?: string[];
  oracle_text?: string;
  type_line?: string;
};

type ScryfallSearchResponse = {
  data?: ScryfallCard[];
  has_more?: boolean;
  next_page?: string;
};

type CommanderListItem = {
  name: string;
  decks: number;
  url: string;
  sanitized: string;
  colors: string[];
  isPartnerPair?: boolean;
};

type CommanderSource = {
  name: string;
  sanitized: string;
  colors: string[];
  keywords: string[];
  oracleText: string;
  typeLine: string;
};

async function getJsonWithRetries<T>(url: string, params?: Record<string, string>): Promise<T> {
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const response = await axios.get<T>(url, {
        headers: REQUEST_HEADERS,
        params,
        timeout: 30_000,
      });
      return response.data;
    } catch (err: any) {
      console.warn(`  ⚠️ Intento ${attempt}/${MAX_RETRIES} fallido para ${url}: ${err.message}`);
      if (attempt < MAX_RETRIES) {
        await sleep(attempt * 5000);
      }
    }
  }

  throw new Error(`No se pudo obtener JSON de ${url} luego de ${MAX_RETRIES} intentos`);
}

function toEdhrecSlug(name: string): string {
  const base = name.split(' // ')[0].trim();
  return base
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-');
}

function toNameKey(name: string): string {
  return name
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function unionColors(colorsA: string[], colorsB: string[]): string[] {
  const colorOrder = ['W', 'U', 'B', 'R', 'G', 'C'];
  const merged = new Set<string>([
    ...colorsA.map((c) => c.toUpperCase()),
    ...colorsB.map((c) => c.toUpperCase()),
  ]);
  return colorOrder.filter((c) => merged.has(c));
}

function mapScryfallCardToCommander(card: ScryfallCard): CommanderSource | null {
  if (!card.name) return null;

  const sanitized = toEdhrecSlug(card.name);
  if (!sanitized) return null;

  return {
    name: card.name,
    sanitized,
    colors: card.color_identity || [],
    keywords: card.keywords || [],
    oracleText: card.oracle_text || '',
    typeLine: card.type_line || '',
  };
}

function buildSingleCommanderEntry(card: CommanderSource): CommanderListItem {
  return {
    name: card.name,
    decks: 0,
    sanitized: card.sanitized,
    url: `https://edhrec.com/commanders/${card.sanitized}`,
    colors: card.colors,
  };
}

function buildPairCommanderEntry(
  a: CommanderSource,
  b: CommanderSource,
  keepOrder = false
): CommanderListItem | null {
  if (a.sanitized === b.sanitized) return null;

  const [left, right] = keepOrder
    ? [a, b]
    : [a, b].sort((x, y) => x.sanitized.localeCompare(y.sanitized));
  const pairSlug = `${left.sanitized}-${right.sanitized}`;

  return {
    name: `${left.name} / ${right.name}`,
    decks: 0,
    sanitized: pairSlug,
    url: `https://edhrec.com/commanders/${pairSlug}`,
    colors: unionColors(left.colors, right.colors),
    isPartnerPair: true,
  };
}

function getPartnerWithTargetName(oracleText: string): string | null {
  const match = oracleText.match(/Partner with\s+([^.\n]+?)(?:\.|\n|$)/i);
  if (!match?.[1]) return null;
  return match[1].trim();
}

function hasKeyword(card: CommanderSource, keyword: string): boolean {
  return card.keywords.some((k) => k.toLowerCase() === keyword.toLowerCase());
}

function hasOracleText(card: CommanderSource, snippet: string): boolean {
  return card.oracleText.toLowerCase().includes(snippet.toLowerCase());
}

function generateCombinations(cards: CommanderSource[]): CommanderListItem[] {
  const pairs = new Map<string, CommanderListItem>();
  const byName = new Map<string, CommanderSource>();

  for (const card of cards) {
    byName.set(toNameKey(card.name), card);
  }

  const isFriendsForever = (card: CommanderSource) =>
    hasKeyword(card, 'Friends forever') || hasOracleText(card, 'friends forever');
  const isPartnerWith = (card: CommanderSource) => hasOracleText(card, 'partner with ');
  const isGenericPartner = (card: CommanderSource) =>
    hasKeyword(card, 'Partner') && !isPartnerWith(card) && !isFriendsForever(card);
  const isChooseBackgroundCommander = (card: CommanderSource) =>
    hasOracleText(card, 'choose a background');
  const isBackground = (card: CommanderSource) =>
    /enchantment/i.test(card.typeLine) && /background/i.test(card.typeLine);
  const isDoctor = (card: CommanderSource) => /time lord doctor/i.test(card.typeLine);
  const isDoctorsCompanion = (card: CommanderSource) => hasOracleText(card, "doctor's companion");

  const addPair = (a: CommanderSource, b: CommanderSource, keepOrder = false) => {
    const pair = buildPairCommanderEntry(a, b, keepOrder);
    if (!pair) return;
    if (!pairs.has(pair.sanitized)) {
      pairs.set(pair.sanitized, pair);
    }
  };

  // 1) Partner with <Nombre> (parejas exclusivas)
  for (const card of cards) {
    const targetName = getPartnerWithTargetName(card.oracleText);
    if (!targetName) continue;
    const target = byName.get(toNameKey(targetName));
    if (!target) continue;
    addPair(card, target);
  }

  // 2) Partner genérico
  const genericPartners = cards.filter(isGenericPartner);
  for (let i = 0; i < genericPartners.length; i++) {
    for (let j = i + 1; j < genericPartners.length; j++) {
      addPair(genericPartners[i], genericPartners[j]);
    }
  }

  // 3) Friends forever
  const friendsForever = cards.filter(isFriendsForever);
  for (let i = 0; i < friendsForever.length; i++) {
    for (let j = i + 1; j < friendsForever.length; j++) {
      addPair(friendsForever[i], friendsForever[j]);
    }
  }

  // 4) Choose a Background + Background (EDHREC usa el orden commander -> background)
  const chooseBackgroundCommanders = cards.filter(isChooseBackgroundCommander);
  const backgrounds = cards.filter(isBackground);
  for (const commander of chooseBackgroundCommanders) {
    for (const background of backgrounds) {
      addPair(commander, background, true);
    }
  }

  // 5) Doctor + Doctor's companion
  const doctors = cards.filter(isDoctor);
  const companions = cards.filter(isDoctorsCompanion);
  for (const doctor of doctors) {
    for (const companion of companions) {
      addPair(doctor, companion);
    }
  }

  return [...pairs.values()];
}

async function fetchAllCommandersFromScryfall(): Promise<CommanderListItem[]> {
  console.log('🌐 Obteniendo comandantes legales desde Scryfall...');

  const sourceCards: CommanderSource[] = [];
  const seenSlugs = new Set<string>();
  let pageCount = 0;
  let nextUrl: string | null = SCRYFALL_SEARCH_URL;

  while (nextUrl) {
    pageCount++;

    if (MAX_SCRYFALL_PAGES > 0 && pageCount > MAX_SCRYFALL_PAGES) {
      console.log(`ℹ️ Límite de prueba alcanzado: ${MAX_SCRYFALL_PAGES} página(s) de Scryfall.`);
      break;
    }

    const isFirstPage = pageCount === 1;
    const params = isFirstPage
      ? {
          q: SCRYFALL_QUERY,
        }
      : undefined;

    console.log(`📄 Descargando página Scryfall ${pageCount}${isFirstPage ? '' : ' (next_page)'}`);
    const parsed: ScryfallSearchResponse = await getJsonWithRetries<ScryfallSearchResponse>(
      nextUrl,
      params
    );

    const cards = parsed?.data || [];
    for (const card of cards) {
      const mapped = mapScryfallCardToCommander(card);
      if (!mapped) continue;
      if (seenSlugs.has(mapped.sanitized)) continue;

      seenSlugs.add(mapped.sanitized);
      sourceCards.push(mapped);
    }

    nextUrl = parsed?.has_more ? parsed.next_page || null : null;

    if (nextUrl) {
      await sleep(DELAY_BETWEEN_REQUESTS_MS);
    }
  }

  if (sourceCards.length === 0) {
    throw new Error('Scryfall no devolvió comandantes válidos');
  }

  const singles = sourceCards.map(buildSingleCommanderEntry);
  const partnerPairs = generateCombinations(sourceCards);

  console.log(`ℹ️ Commanders individuales: ${singles.length}`);
  console.log(`ℹ️ Combinaciones partner generadas: ${partnerPairs.length}`);

  const output = [...singles, ...partnerPairs];
  return output;
}

(async () => {
  try {
    const allCommanders = await fetchAllCommandersFromScryfall();

    const outputPath = path.resolve(__dirname, '../data/all-commanders.json');
    await fs.mkdir(path.dirname(outputPath), { recursive: true });
    const bySlug = new Map<string, CommanderListItem>();
    for (const commander of allCommanders) {
      const existing = bySlug.get(commander.sanitized);
      if (!existing || commander.decks > existing.decks) {
        bySlug.set(commander.sanitized, commander);
      }
    }
    const dedupedCommanders = [...bySlug.values()];
    await fs.writeFile(outputPath, JSON.stringify(dedupedCommanders, null, 2));

    console.log(`\n✅ Total de comandantes guardados: ${dedupedCommanders.length} en ${outputPath}`);
  } catch (error) {
    console.error('❌ scrape:all-commanders failed:', error);
    process.exit(1);
  }
})();