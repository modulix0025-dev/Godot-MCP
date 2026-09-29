// SPDX-License-Identifier: Apache-2.0
//
// Capture the UI Direction Review screenshots: every screen (dark + light, EN), the Studio workspace in
// Arabic RTL, every non-normal state of every screen, and the Ctrl+K palette. Serves the built dist/ with
// `vite preview` and drives Chromium with Playwright.
//
//   npm run build -w @modulex/ui && node app/ui/scripts/capture-prototype.mjs <outDir>
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const here = dirname(fileURLToPath(import.meta.url));
const uiDir = resolve(here, '..');
const out = resolve(process.argv[2] ?? resolve(uiDir, '../../../docs/modulex/ui/screens'));
mkdirSync(out, { recursive: true });

const PORT = 4174;
const server = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort'], {
  cwd: uiDir,
  stdio: 'ignore',
});
const base = `http://127.0.0.1:${PORT}/`;
for (let i = 0; i < 60; i++) {
  try {
    if ((await fetch(base)).ok) break;
  } catch {
    /* not up yet */
  }
  await new Promise((r) => setTimeout(r, 250));
}

const SCREENS = ['projects', 'studio', 'activity', 'assets', 'test', 'builds', 'workers', 'approvals', 'settings'];
const STATES = ['empty', 'loading', 'error', 'blocked'];
const launch = process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {};
const browser = await chromium.launch(launch);
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });

async function shot(name, hash, after) {
  await page.goto(`${base}${hash}`);
  await page.waitForLoadState('networkidle');
  await page.evaluate(() => document.fonts.ready);
  // The review toolbar is prototype chrome; keep it out of the review images. Then let the 120-180 ms
  // state transitions settle so no control is captured mid-animation.
  await page.addStyleTag({ content: '.proto-bar{display:none !important}' });
  await page.waitForTimeout(400);
  if (after) await after();
  await page.screenshot({ path: resolve(out, `${name}.png`) });
  console.log(`captured ${name}`);
}

const h = (screen, state = 'normal', theme = 'dark', lang = 'en') =>
  `#/prototype/${screen}?state=${state}&theme=${theme}&lang=${lang}`;
for (const s of SCREENS) {
  await shot(`${s}-dark`, h(s));
  await shot(`${s}-light`, h(s, 'normal', 'light'));
}
await shot('studio-rtl-ar-dark', h('studio', 'normal', 'dark', 'ar'));
await shot('studio-rtl-ar-light', h('studio', 'normal', 'light', 'ar'));
await shot('projects-rtl-ar-dark', h('projects', 'normal', 'dark', 'ar'));
for (const s of SCREENS) for (const st of STATES) await shot(`state-${s}-${st}`, h(s, st));
await shot('palette-dark', h('studio'), async () => {
  await page.keyboard.press('Control+k');
  await page.keyboard.type('bu');
  await page.waitForTimeout(200);
});

await browser.close();
server.kill();
