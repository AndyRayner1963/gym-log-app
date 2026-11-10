// Renders the app icons (plain dark tile, bold lime "S") to docs/icons/.
// Run: node tests/app/make-icons.js   (from the repository root)
const path = require('path');
const fs = require('fs');
const { chromium } = require('playwright');

const OUT = path.join(__dirname, '..', '..', 'docs', 'icons');
const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <rect width="512" height="512" fill="#0F1113"/>
  <rect x="96" y="404" width="320" height="22" rx="11" fill="#C6F24E" opacity="0.35"/>
  <text x="256" y="372" text-anchor="middle" font-family="Helvetica, Arial, sans-serif" font-weight="900" font-size="380" fill="#C6F24E">S</text>
</svg>`;

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch();
  for (const size of [180, 192, 512]) {
    const page = await browser.newPage({ viewport: { width: size, height: size }, deviceScaleFactor: 1 });
    await page.setContent(`<html><body style="margin:0">${svg.replace('<svg ', `<svg width="${size}" height="${size}" `)}</body></html>`);
    await page.screenshot({ path: path.join(OUT, `icon-${size}.png`), omitBackground: false });
    await page.close();
  }
  await browser.close();
  console.log('icons written to', OUT);
})();
