import fs from 'node:fs/promises';
import path from 'node:path';
import { experimental_evaluate } from 'ai';

const root = process.cwd();
const outputPath = path.join(root, 'artifacts', 'jev-seo-audit.json');
const siteOrigin = 'https://cozyclay.org';

function stripHtml(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<svg[\s\S]*?<\/svg>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

function matchOne(html, pattern) {
  return html.match(pattern)?.[1]?.trim() ?? '';
}

async function collectPages(dir, relative = '') {
  const entries = await fs.readdir(path.join(dir, relative), { withFileTypes: true });
  const pages = [];
  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name.startsWith('.')) continue;
    const childRelative = path.join(relative, entry.name);
    if (entry.isDirectory()) {
      pages.push(...await collectPages(dir, childRelative));
    } else if (entry.name === 'index.html') {
      pages.push(childRelative);
    }
  }
  return pages;
}

function pageState(relative, html) {
  const route = relative === 'index.html'
    ? '/'
    : `/${relative.replace(/\/index\.html$/, '').replaceAll('\\', '/')}/`;
  const title = matchOne(html, /<title[^>]*>([\s\S]*?)<\/title>/i);
  const description = matchOne(html, /<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)["']/i)
    || matchOne(html, /<meta[^>]+content=["']([^"']*)["'][^>]+name=["']description["']/i);
  const headings = [...html.matchAll(/<h[1-3][^>]*>([\s\S]*?)<\/h[1-3]>/gi)]
    .map((match) => stripHtml(match[1]))
    .filter(Boolean)
    .slice(0, 30);
  const text = stripHtml(html).slice(0, 14000);
  return { route, url: `${siteOrigin}${route}`, title, description, headings, text };
}

if (!process.env.AI_GATEWAY_API_KEY) {
  console.error('Missing AI_GATEWAY_API_KEY. Create a Vercel AI Gateway key, then run:');
  console.error('AI_GATEWAY_API_KEY=... npm run seo:jev');
  process.exit(2);
}

const relativePages = (await collectPages(root))
  .filter((relative) => !relative.startsWith('artifacts/') && !relative.startsWith('public/'))
  .sort();
const pages = [];
for (const relative of relativePages) {
  const html = await fs.readFile(path.join(root, relative), 'utf8');
  pages.push(pageState(relative, html));
}

const maxPages = Number.parseInt(process.env.JEV_MAX_PAGES ?? '0', 10);
const delayMs = Number.parseInt(process.env.JEV_DELAY_MS ?? '30000', 10);
const maxRetries = Number.parseInt(process.env.JEV_MAX_RETRIES ?? '0', 10);
const resume = process.env.JEV_RESUME === '1';
let results = [];
if (resume) {
  try {
    const previous = JSON.parse(await fs.readFile(outputPath, 'utf8'));
    results = Array.isArray(previous.pages) ? previous.pages : [];
  } catch {
    // No previous result file to resume from.
  }
}
const completedRoutes = new Set(results.map((item) => item.page?.route));
const remainingPages = pages.filter((page) => !completedRoutes.has(page.route));
const pagesToAudit = maxPages > 0 ? remainingPages.slice(0, maxPages) : remainingPages;
for (const [index, page] of pagesToAudit.entries()) {
  // Jev's free tier is rate-limited. Keep requests sequential and spaced out
  // so a free-tier audit does not burst the gateway or spend retries.
  if (index > 0 && delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
  const result = await experimental_evaluate({
    model: 'typesafe-ai/jev',
    state: page,
    maxRetries,
    questions: {
      pageValue: {
        type: 'score',
        instructions: 'How valuable is this page as a distinct search landing page for a real person looking for AI video previs, camera blocking, greybox-to-video workflows, or CozyClay?',
        criteria: [
          'No distinct search value; mostly duplicate or utility shell',
          'Some supporting value but weak standalone intent',
          'Clear standalone search intent and useful answer',
          'Strong high-intent landing page with specific useful content',
        ],
      },
      shouldIndex: {
        type: 'boolean',
        instructions: 'Should this URL be indexable as a standalone public SEO page rather than noindex or app-only navigation?',
      },
      answersIntent: {
        type: 'score',
        instructions: 'How directly does the visible content answer the likely search intent suggested by this URL, title, headings, and description?',
        criteria: [
          'Does not answer the likely intent',
          'Partly answers it but is thin or generic',
          'Answers it clearly with useful specifics',
          'Answers it deeply enough to be a reference page',
        ],
      },
      aiCitationReady: {
        type: 'boolean',
        instructions: 'Could an AI search answer cite this page for a specific factual question without inventing missing context?',
      },
      humanReview: {
        type: 'boolean',
        instructions: 'Does this page need human review before we change its copy or indexing decision?',
      },
    },
  });
  results.push({
    page,
    answers: result.answers,
    providerMetadata: result.providerMetadata,
    usage: result.usage,
  });
}

await fs.mkdir(path.dirname(outputPath), { recursive: true });
await fs.writeFile(outputPath, JSON.stringify({
  generatedAt: new Date().toISOString(),
  model: 'typesafe-ai/jev',
  siteOrigin,
  pages: results,
  audit: {
    requestedPages: pages.length,
    evaluatedPages: results.length,
    maxPages: maxPages || null,
    delayMs,
    maxRetries,
  },
}, null, 2) + '\n');

console.log(`Jev SEO audit written: ${path.relative(root, outputPath)}`);
for (const item of results) {
  const a = item.answers;
  console.log(`${item.page.route} | page=${a.pageValue?.score ?? '-'} | index=${a.shouldIndex?.probability ?? '-'} | intent=${a.answersIntent?.score ?? '-'} | review=${a.humanReview?.probability ?? '-'}`);
}
