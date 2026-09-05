// QA_URL=http://localhost:5180/app/ node test/qa-advanced-toggle-browser.mjs
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir } from 'node:fs/promises';

const { chromium } = createRequire(import.meta.url)('playwright');
const browser = await chromium.launch({ headless: true });
const evidence = process.env.QA_EVIDENCE || 'RESEARCH/ux-qa-20260906';
await mkdir(evidence, { recursive: true });

try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  await page.goto(process.env.QA_URL || 'http://localhost:5180/app/', { waitUntil: 'domcontentloaded' });
  assert.equal(await page.locator('.advanced-toggle').count(), 0, 'Advanced toggle is removed');
  for (const title of ['Rig', 'Pose', 'Video capture', 'Prompt Blocks']) {
    const section = page.locator('.inspector-sidebar .foldout').filter({ has: page.locator('.foldout-title', { hasText: new RegExp(`^${title}$`) }) });
    assert.equal(await section.isVisible(), true, `${title} stays visible`);
  }
  assert.equal(await page.locator('.tl-track').filter({ has: page.locator('.tl-track-label', { hasText: /^Prompts/ }) }).isVisible(), true, 'Prompts stays visible');
  assert.equal(await page.locator('.tl-track').filter({ has: page.locator('.tl-track-label', { hasText: /^2D Root/ }) }).isVisible(), true, '2D Root stays visible');
  assert.equal(await page.locator('.tl-ruler').isVisible(), true, 'timeline stays visible');
  await page.screenshot({ path: `${evidence}/advanced-always-on-1440.png`, fullPage: true });
  console.log('PASS Advanced toggle absent and expert Studio controls visible on first load');
} finally {
  await browser.close();
}
