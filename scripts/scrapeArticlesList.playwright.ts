// scripts/scrapeAllArticles.playwright.ts
import { chromium } from 'playwright';
import fs from 'fs/promises';
import path from 'path';

const BASE_URL = 'https://edhrec.com/articles';
const MAX_PAGES = 30; //TODO: ONLY 300 LAST ARTICLES! It exists 3600 
const outputPath = path.resolve(__dirname, '../data/articles.json');

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();

  const allArticles: any[] = [];

  for (let pageNum = 1; pageNum <= MAX_PAGES; pageNum++) {
    const url = `${BASE_URL}/page/${pageNum}`;
    console.log(`📄 Scrapeando página ${pageNum}...`);

    await page.goto(url, { waitUntil: 'networkidle' });

    const rawJson = await page.$eval('script#__NEXT_DATA__', el => el.textContent || '');
    const parsed = JSON.parse(rawJson);
    const posts = parsed?.props?.pageProps?.posts ?? [];

    if (!posts.length) {
      console.log(`🚫 Página ${pageNum} sin artículos. Fin del scraping.`);
      break;
    }

    for (const post of posts) {
      allArticles.push({
        title: post.title,
        slug: post.slug,
        url: `https://edhrec.com/articles/${post.slug}`,
        date: post.date,
        excerpt: post.excerpt,
        content: post.content,
        author: {
          name: post.author?.name,
          slug: post.author?.slug,
          avatarUrl: post.author?.avatarUrl,
        },
        tags: post.tags?.map((t: any) => t.name),
        featuredImageUrl: post.featuredImageUrl,
      });
    }
  }

  await browser.close();
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, JSON.stringify(allArticles, null, 2));
  console.log(`✅ Guardados ${allArticles.length} artículos en ${outputPath}`);
})();
