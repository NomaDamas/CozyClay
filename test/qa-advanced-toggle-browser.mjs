// QA_URL=http://localhost:5190/app/ NODE_PATH=<playwright modules> node test/qa-advanced-toggle-browser.mjs
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir } from 'node:fs/promises';
const { chromium } = createRequire(import.meta.url)('playwright');
const browser = await chromium.launch({ headless: true });
const evidence = process.env.QA_EVIDENCE || 'RESEARCH/ux-qa-20260905';
await mkdir(evidence, { recursive: true });
try {
 const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
 const page = await context.newPage();
 await page.goto(process.env.QA_URL || 'http://localhost:5190/app/', { waitUntil: 'domcontentloaded' });
 const toggle = page.locator('.advanced-toggle');
 await toggle.waitFor();
 const sections = ['Rig', 'Pose', 'Video capture', 'Prompt Blocks'].map(title => page.locator('.inspector-sidebar .foldout').filter({ has: page.locator('.foldout-title', { hasText: new RegExp(`^${title}$`) }) }));
 const lanes = ['Prompts', '2D Root', 'Shots'].map(title => page.locator('.tl-track').filter({ has: page.locator('.tl-track-label', { hasText: new RegExp(`^${title}`) }) }));
 const expert = [...sections, ...lanes, page.getByRole('button', { name: 'Root path mode', exact: true }), page.getByRole('button', { name: '+ Add shot', exact: true })];
 async function verify(on) {
  assert.equal(await toggle.getAttribute('aria-pressed'), String(on));
  for (const locator of sections) assert.equal(await locator.isVisible(), on, 'expert inspector section visibility');
  for (const locator of lanes) assert.equal(await locator.isVisible(), true, 'all Animation lanes remain visible');
  assert.equal(await page.getByRole('button', { name: 'Root path mode', exact: true }).isVisible(), on);
  assert.equal(await page.getByRole('button', { name: '+ Add shot', exact: true }).isVisible(), true);
  assert.equal(await page.locator('.tl-ruler').isVisible(), true);
 }
 await verify(false);
 await page.waitForTimeout(1500);
 await page.screenshot({ path: `${evidence}/advanced-off-1440.png` });
 await toggle.click();
 await page.waitForTimeout(200);
 await verify(true);
 await page.screenshot({ path: `${evidence}/advanced-on-1440.png` });
 await page.reload({ waitUntil: 'domcontentloaded' });
 await toggle.waitFor();
 await verify(true);
 await toggle.click();
 await page.waitForTimeout(200);
 await verify(false);
 await page.reload({ waitUntil: 'domcontentloaded' });
 await toggle.waitFor();
 await verify(false);
 console.log('PASS fresh default OFF, expert visibility ON/OFF, ruler retained, preference persists both ways');
} finally { await browser.close(); }
