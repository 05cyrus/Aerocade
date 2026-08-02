/**
 * Headless visual smoke test: boots the sandbox in Chromium, drives the local
 * player through idle / run / jetpack / fire, and writes screenshots plus a
 * simulation state dump. Use it to eyeball renderer changes without a GPU.
 *
 *   npm run dev                                   # in one shell
 *   node packages/client/scripts/screenshot-sandbox.mjs /tmp/shots
 *
 * Requires the dev server (the debug hook is DEV-only) and a Chromium/Chrome
 * binary; override with CHROME_PATH. Note: headless containers rasterize with
 * SwiftShader (no GPU), so the reported FPS is a software-rendering floor, not
 * the number a real device sees.
 */
import { chromium } from 'playwright-core';

const OUT = process.argv[2] ?? '/tmp/shots';
const URL = process.env.AEROCADE_URL ?? 'http://localhost:5173';
const CHROME = process.env.CHROME_PATH ?? '/usr/bin/google-chrome';

const browser = await chromium.launch({
  executablePath: CHROME,
  headless: true,
  args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader'],
});
const page = await (await browser.newContext({ viewport: { width: 1280, height: 720 } })).newPage();

const errors = [];
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(`console: ${m.text()}`);
});

/** Read a snapshot of the local player's simulation state. */
const sim = () =>
  page.evaluate(() => {
    const d = window.__aeroDebug;
    if (!d) return null;
    const { world: w, localPlayer: i } = d;
    const slot = w.players.weaponSlot[i];
    return {
      tick: w.tick,
      x: +(w.players.posX[i] ?? 0).toFixed(2),
      y: +(w.players.posY[i] ?? 0).toFixed(2),
      velX: +(w.players.velX[i] ?? 0).toFixed(2),
      grounded: w.players.grounded[i],
      fuel: Math.round(w.players.fuel[i] ?? 0),
      weapon: w.players.weapons[i * 2 + slot],
      mag: w.players.ammoMag[i * 2 + slot],
      fps: Math.round(d.fps()),
    };
  });

/** Screenshot cropped tightly around the local player. */
const closeup = async (name, halfW = 80, halfH = 70) => {
  const pos = await page.evaluate(() => window.__aeroDebug?.screenPos() ?? null);
  if (!pos) throw new Error('no debug hook — is the dev server running?');
  const clip = {
    x: Math.max(0, Math.min(1280 - halfW * 2, pos.x - halfW)),
    y: Math.max(0, Math.min(720 - halfH * 2, pos.y - halfH)),
    width: halfW * 2,
    height: halfH * 2,
  };
  await page.screenshot({ path: `${OUT}/${name}`, clip });
};

await page.goto(URL, { waitUntil: 'networkidle' });
await page.waitForSelector('text=AEROCADE', { timeout: 20000 });
await page.screenshot({ path: `${OUT}/01-menu.png` });

await page.click('text=Training Sandbox');
await page.waitForSelector('canvas', { timeout: 20000 });
await page.waitForFunction(() => window.__aeroDebug !== undefined, { timeout: 20000 });
await page.waitForTimeout(1500); // land and settle

// Idle, aiming right. Drop the spawn shield first — its shimmer makes the
// soldier semi-transparent, which obscures the art in these reference shots.
await page.mouse.move(900, 380);
await page.evaluate(() => {
  const d = window.__aeroDebug;
  if (d) d.world.players.protect[d.localPlayer] = 0;
});
await page.waitForTimeout(400);
await page.screenshot({ path: `${OUT}/02-idle-full.png` });
await closeup('03-idle-closeup.png');
console.log('idle:    ', JSON.stringify(await sim()));

// Mid-stride run (sampled twice to catch different points of the cycle).
await page.keyboard.down('KeyD');
await page.waitForTimeout(400);
await closeup('04-run-a.png', 170, 130);
await page.waitForTimeout(120);
await closeup('05-run-b.png', 170, 130);
await page.keyboard.up('KeyD');
console.log('running: ', JSON.stringify(await sim()));

// Jetpack while aiming back over the shoulder — tests facing flip + plume.
await page.mouse.move(200, 120);
await page.keyboard.down('Space');
await page.waitForTimeout(500);
await closeup('06-jetpack-aim-left.png', 170, 130);
console.log('jetpack: ', JSON.stringify(await sim()));
await page.keyboard.up('Space');
await page.waitForTimeout(900);

// Swap to the Thumper and fire it.
await page.keyboard.press('KeyQ');
await page.waitForTimeout(500);
await page.mouse.move(1100, 420);
await page.waitForTimeout(200);
await closeup('07-thumper-held.png');
await page.mouse.down();
await page.waitForTimeout(100);
await page.mouse.up();
await page.waitForTimeout(180);
await page.screenshot({ path: `${OUT}/08-thumper-fired.png` });
console.log('fired:   ', JSON.stringify(await sim()));

console.log(errors.length === 0 ? 'NO PAGE ERRORS' : errors.join('\n'));
await browser.close();
