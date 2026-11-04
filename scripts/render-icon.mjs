// Renders images/icon.svg to icon.png (256x256, transparent corners) using the
// Chromium that Playwright installs for `npm run test:web`.
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright';

const svg = await readFile(new URL('../images/icon.svg', import.meta.url), 'utf8');
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 256, height: 256 } });
  await page.setContent(
    `<html><body style="margin:0;background:transparent">${svg}</body></html>`,
  );
  await page.locator('svg').screenshot({
    path: new URL('../icon.png', import.meta.url).pathname,
    omitBackground: true,
  });
} finally {
  await browser.close();
}
console.log('Wrote icon.png');
