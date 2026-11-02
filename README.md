# EDHREC Scrapper

Pipeline en TypeScript para:

1. Extraer comandantes de EDHREC.
2. Scrappear la página de cada comandante y sus cartas/sinergias.
3. Normalizar datos con IDs de Scryfall.
4. Subir los resultados a Pinecone con embeddings para búsqueda semántica.

---

## ¿Qué hace este proyecto?

Este repositorio construye una base de conocimiento de comandantes de **Magic: The Gathering (Commander/EDH)** a partir de EDHREC, con foco en recomendaciones por sinergia.

El flujo principal genera:

- Un listado global de comandantes (`data/all-commanders.json`).
- Un JSON por comandante con cartas recomendadas (`data/commanders/*.json`).
- Un dataset consolidado y limpio (`data/commander-synergies.json`).
- Registros vectorizados en Pinecone (vía `multilingual-e5-large`).

También incluye un scraper separado para artículos de EDHREC (`data/articles.json`).

---

## Stack técnico

- **Node.js + TypeScript**
- **Playwright** (scraper de artículos y utilidades de scraping)
- **Axios** (descarga de catálogo masivo de Scryfall)
- **Pinecone SDK** (embeddings + upsert de vectores)
- **GitHub Actions** (ejecución programada semanal)

---

## Estructura del proyecto

```text
scripts/
  scrapeCommandersList.playwright.ts   # obtiene lista global de commanders
  scrapeAllCommanderPages.ts           # scrappea cada commander y guarda JSON individual
  compile-synergies.ts                 # consolida y enriquece con IDs de Scryfall
  upload-to-pinecone.ts                # genera embeddings y sube a Pinecone
  scrapeArticlesList.playwright.ts     # scraper adicional de artículos
  pinecone.ts                          # cliente Pinecone

data/
  all-commanders.json
  commanders/
    <slug>.json
  commander-synergies.json
  articles.json

.github/workflows/scrape.yml           # pipeline automático semanal
```

---

## Flujo de datos (end-to-end)

### 1) `scrape:all-commanders`

Archivo: `scripts/scrapeCommandersList.playwright.ts`

- Consume la API de Scryfall con paginación nativa (`has_more` / `next_page`):
  - `https://api.scryfall.com/cards/search?q=is%3Acommander+legal%3Acommander`
- Genera `sanitized` compatible con URLs de EDHREC (`https://edhrec.com/commanders/<slug>`).
- Genera combinaciones de parejas válidas (Partner, Partner with, Friends forever, Choose a Background, Doctor's companion).
- Construye la lista maestra y guarda:
  - `name`
  - `decks`
  - `url`
  - `sanitized` (slug)
  - `colors`
  - `isPartnerPair` (solo en combinaciones)
- Salida: `data/all-commanders.json`.

### 2) `scrape:pages`

Archivo: `scripts/scrapeAllCommanderPages.ts`

- Lee `data/all-commanders.json`.
- Consume `https://json.edhrec.com/pages/commanders/<slug>.json`.
- Extrae cartas desde `container.json_dict.cardlists`.
- Conserva por carta la mejor sinergia disponible y normaliza la sinergia a porcentaje entero.
- Guarda un archivo por comandante en `data/commanders/<slug>.json`.
- Si el archivo ya existe, lo omite.

### 3) `compile:synergies`

Archivo: `scripts/compile-synergies.ts`

- Descarga el bulk de **Scryfall Oracle Cards** (JSONL/JSONL.GZ).
- Construye un mapa en memoria `nombre carta -> id scryfall`.
- Soporta cartas de doble cara (`A // B`) y también mapea la cara frontal.
- Para cada comandante:
  - toma top 120 cartas por sinergia
  - resuelve ID del comandante (y partner si aplica)
  - genera `id` final (`commanderId` o `commanderId__partnerId`)
- Salida: `data/commander-synergies.json`.

### 4) `upload:pinecone`

Archivo: `scripts/upload-to-pinecone.ts`

- Lee `data/commander-synergies.json`.
- Crea `chunk_text` por comandante (resumen con top cartas).
- Genera embeddings con `multilingual-e5-large`.
- Sube lotes de 96 vectores a Pinecone (namespace `__default__`).
- Incluye control básico de errores y retry para rate-limit (429).

---

## Variables de entorno

Crear archivo `.env` en la raíz:

```env
PINECONE_API_KEY=tu_api_key
PINECONE_INDEX_NAME=tu_index
PINECONE_INDEX_HOST=tu_host
PINECONE_NAMESPACE=__default__
PINECONE_FULL_REFRESH=true
```

> Recomendación: no subir credenciales reales al repositorio y rotarlas si se exponen accidentalmente.

---

## Instalación

```bash
npm install
npx playwright install --with-deps
```

---

## Comandos disponibles

Definidos en `package.json`:

```bash
npm run scrape:all-commanders
npm run scrape:pages
npm run compile:synergies
npm run upload:pinecone
npm run sync:pinecone
```

Ejecución recomendada:

```bash
npm run scrape:all-commanders
npm run scrape:pages
npm run compile:synergies
npm run upload:pinecone
```

Scraper de artículos (no está en `scripts` de npm, se ejecuta directo):

```bash
npx ts-node scripts/scrapeArticlesList.playwright.ts
```

---

## Automatización (GitHub Actions)

Workflow: `.github/workflows/scrape.yml`

- Se ejecuta:
  - manualmente (`workflow_dispatch`)
  - cada lunes 03:00 UTC (`cron`)
- Pasos:
  1. checkout
  2. setup Node 20
  3. `npm ci`
  4. instalación de navegadores Playwright
  5. scraping completo
  6. compilación de sinergias
  7. subida a Pinecone usando secrets
  8. limpieza de algunos archivos generados

Entradas manuales (`workflow_dispatch`):

- `force_refresh` (`true` por defecto): elimina `data/commanders` antes de scrappear para refrescar sinergias aunque ya existan JSON previos.
- `max_pages_per_category` (`0` por defecto): limita páginas de Scryfall en `scrape:all-commanders` (útil para pruebas rápidas).
- `pinecone_full_refresh` (`true` por defecto): limpia el namespace antes del upload para evitar datos obsoletos.
- `pinecone_namespace` (`__default__` por defecto): namespace objetivo en Pinecone.

Variables de entorno de scraping soportadas por scripts:

- `SCRAPE_FORCE_REFRESH=true|false`
- `SCRAPE_MAX_PAGES_PER_CATEGORY=<n>` (`0` = sin límite)
- `PINECONE_FULL_REFRESH=true|false`
- `PINECONE_NAMESPACE=<namespace>`
- `PINECONE_MAX_BATCH_RETRIES=<n>` (default `3`)

Secrets esperados en GitHub:

- `PINECONE_API_KEY`
- `PINECONE_INDEX_NAME`
- `PINECONE_INDEX_HOST`

---

## Formatos de salida clave

### `data/all-commanders.json`

Array de comandantes con metadata base:

- `name`
- `decks`
- `url`
- `sanitized`
- `colors`
- `isPartnerPair` (opcional, `true` en pares de commander/background/doctor-partner)

### `data/commanders/<slug>.json`

```json
{
  "slug": "nombre-del-commander",
  "cards": [
    { "name": "Carta X", "percent": 42, "deckCount": 1234, "synergy": 27 }
  ]
}
```

### `data/commander-synergies.json`

```json
{
  "id": "scryfall-commander-id__scryfall-partner-id-opcional",
  "commander": "Commander Name",
  "partner": null,
  "cards": [
    { "name": "Carta X", "synergy": 61, "deckCount": 1377 }
  ]
}
```

---

## Notas operativas

- El scraping depende de estructura HTML/CSS de EDHREC; cambios de clases pueden romper selectores.
- Los scrapers principales de commanders usan endpoint JSON (`json.edhrec.com`) para no depender de `__NEXT_DATA__` ni clases de frontend.
- `scrape:all-commanders` usa Scryfall como fuente maestra para evitar límites de paginación de EDHREC y mejorar cobertura de comandantes.
- El paso de compilación reduce llamadas individuales gracias al bulk de Scryfall.
- La subida a Pinecone serializa `cards` en metadata como string JSON.
- Hay delays/retries para evitar bloqueos y reducir errores intermitentes de red/rate-limit.
- `upload-to-pinecone` ahora falla explícitamente si hay lotes no subidos; así se evita que un run “verde” deje el índice incompleto.
- Para evitar datos stale en Pinecone, usa `PINECONE_FULL_REFRESH=true` (limpia namespace antes de cargar).

### Si el cron deja de correr

GitHub puede deshabilitar workflows programados por inactividad del repositorio (`disabled_inactivity`).

Pasos para restaurarlo:

1. Ir a **Actions** en GitHub.
2. Abrir el workflow **EDHREC Sync to Pinecone**.
3. Hacer clic en **Enable workflow**.
4. Ejecutar un `workflow_dispatch` manual inicial para verificar estado.

---

## Resumen rápido

Este proyecto implementa un **ETL de datos de Commander**:

- **Extract**: EDHREC (comandantes + cartas/sinergias).
- **Transform**: normalización y enriquecimiento con IDs de Scryfall.
- **Load**: Pinecone con embeddings para consultas semánticas.

Si tu objetivo es construir recomendaciones, búsqueda o RAG sobre sinergias de decks Commander, esta base ya deja ese pipeline listo.
