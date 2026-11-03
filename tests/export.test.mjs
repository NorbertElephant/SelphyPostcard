// Test de bout en bout de Selphy Postcard avec Playwright (Chromium).
// Usage : cd tests && npm install && npx playwright install chromium && npm test
//
// Vérifie, avec une photo 4:3 (1600 × 1200) :
//  - export en mode Remplir puis Ajuster : JPEG exactement 1748 × 1181, 300 dpi ;
//  - contenu attendu (recadrage en Remplir, bandes de fond en Ajuster) ;
//  - bascule portrait : 1181 × 1748 ;
//  - Web Share Target : un POST vers share-target ouvre la photo dans l'appli.

import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { join, dirname, extname, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { encodePng } from '../tools/make-icons.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const OUT = join(HERE, 'output');

// ---- Petit serveur statique (équivalent de python -m http.server) ----
const TYPES = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.png': 'image/png', '.webmanifest': 'application/manifest+json',
};
const server = createServer(async (req, res) => {
  const path = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname));
  const file = join(ROOT, path.endsWith('/') || path.endsWith('\\') ? join(path, 'index.html') : path);
  try {
    const body = await readFile(file);
    res.writeHead(200, { 'Content-Type': TYPES[extname(file)] || 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404).end('not found');
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
// SELPHY_URL permet de tester une version déployée (ex. GitHub Pages) au lieu du serveur local.
const BASE = process.env.SELPHY_URL || `http://127.0.0.1:${server.address().port}/`;

// ---- Photo de test 4:3 : moitié gauche rouge, moitié droite bleue,
//      bande verte de 40 px en haut (rognée en Remplir, visible en Ajuster). ----
function makeTestPhoto(w = 1600, h = 1200) {
  const px = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const c = y < 40 ? [40, 180, 60] : x < w / 2 ? [210, 50, 50] : [50, 80, 210];
      px.set([...c, 255], i);
    }
  }
  return encodePng(w, h, px);
}

// ---- Lecture des dimensions et de la densité dans un JPEG ----
function jpegInfo(buf) {
  assert.equal(buf.readUInt16BE(0), 0xffd8, 'pas un JPEG');
  let dpi = null;
  let i = 2;
  while (i < buf.length) {
    const marker = buf.readUInt16BE(i);
    const len = buf.readUInt16BE(i + 2);
    if (marker === 0xffe0 && buf.toString('latin1', i + 4, i + 9) === 'JFIF\0') {
      dpi = { units: buf[i + 11], x: buf.readUInt16BE(i + 12), y: buf.readUInt16BE(i + 14) };
    }
    // SOF0..SOF15 (hors DHT/JPG/DAC) : hauteur puis largeur.
    if (marker >= 0xffc0 && marker <= 0xffcf && ![0xffc4, 0xffc8, 0xffcc].includes(marker)) {
      return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7), dpi };
    }
    i += 2 + len;
  }
  throw new Error('SOF introuvable');
}

let page;
let lastFileName = '';

/** Clique sur Télécharger et renvoie le JPEG téléchargé. */
async function download(label) {
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#downloadBtn')]);
  assert.match(dl.suggestedFilename(), /^selphy(_carte|_carre)?_\d{8}_\d{6}\.jpg$/, 'nom de fichier');
  lastFileName = dl.suggestedFilename();
  const buf = await readFile(await dl.path());
  await writeFile(join(OUT, `${label}.jpg`), buf);
  return buf;
}

/** Couleurs de quelques pixels du JPEG, décodé dans le navigateur. */
function samplePixels(buf, points) {
  return page.evaluate(async ({ b64, points }) => {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const bmp = await createImageBitmap(new Blob([bytes], { type: 'image/jpeg' }));
    const c = new OffscreenCanvas(bmp.width, bmp.height);
    const ctx = c.getContext('2d');
    ctx.drawImage(bmp, 0, 0);
    return points.map(([x, y]) => [...ctx.getImageData(x, y, 1, 1).data.slice(0, 3)]);
  }, { b64: buf.toString('base64'), points });
}

const near = (a, b, tol = 30) => a.every((v, i) => Math.abs(v - b[i]) <= tol);

function check(name, fn) {
  return fn().then(
    () => console.log(`  ✔ ${name}`),
    (e) => { console.log(`  ✘ ${name}\n    ${e.message}`); process.exitCode = 1; },
  );
}

// ---------------------------------------------------------------------------

await mkdir(OUT, { recursive: true });
const photoPath = join(OUT, 'photo-4x3.png');
await writeFile(photoPath, makeTestPhoto());

const browser = await chromium.launch();
const context = await browser.newContext({ acceptDownloads: true, viewport: { width: 412, height: 860 } });
page = await context.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

console.log(`Selphy Postcard — ${BASE}`);
await page.goto(BASE);
await page.setInputFiles('#fileInput', photoPath);
await page.waitForSelector('#controls:not([hidden])');

await check('Remplir : JPEG 1748 × 1181 à 300 dpi', async () => {
  const buf = await download('remplir');
  const info = jpegInfo(buf);
  assert.deepEqual([info.width, info.height], [1748, 1181]);
  assert.deepEqual(info.dpi, { units: 1, x: 300, y: 300 });
  // La bande verte du haut est rognée ; gauche rouge, droite bleue, bord à bord.
  const [top, left, right] = await samplePixels(buf, [[874, 3], [3, 590], [1744, 590]]);
  assert.ok(!near(top, [40, 180, 60]), `haut ne devrait pas être vert : ${top}`);
  assert.ok(near(left, [210, 50, 50]), `bord gauche rouge attendu : ${left}`);
  assert.ok(near(right, [50, 80, 210]), `bord droit bleu attendu : ${right}`);
});

await check('Remplir : le zoom ne descend pas sous la couverture minimale', async () => {
  await page.mouse.move(200, 300);
  const box = await page.locator('#preview').boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.wheel(0, 2000);   // dézoom fort
  assert.equal(await page.inputValue('#zoom'), '1');
  await page.mouse.wheel(0, -400);   // zoom avant
  assert.ok(parseFloat(await page.inputValue('#zoom')) > 1);
  const info = jpegInfo(await download('remplir-zoom'));
  assert.deepEqual([info.width, info.height], [1748, 1181]);
});

await check('Qualité : résolution affichée, alerte si trop zoomé', async () => {
  // 1600 px de photo sur 148 mm → 275 dpi au zoom 1 ; < 200 dpi au zoom 2.
  await page.locator('#zoom').fill('1');
  await page.waitForFunction(() => document.querySelector('#quality').textContent.startsWith('275'));
  await page.locator('#zoom').fill('2');
  await page.waitForSelector('#quality.warn');
  assert.match(await page.textContent('#quality'), /137 dpi/);
});

await check('Recentrer : double-clic sur l\'aperçu', async () => {
  await page.dblclick('#preview');
  assert.equal(await page.inputValue('#zoom'), '1');
  await page.waitForSelector('#quality:not(.warn)');
});

await check('Ajuster (fond flou) : JPEG 1748 × 1181', async () => {
  await page.click('[data-mode="fit"]');
  const info = jpegInfo(await download('ajuster-flou'));
  assert.deepEqual([info.width, info.height], [1748, 1181]);
});

await check('Ajuster (fond blanc) : photo entière + bandes blanches', async () => {
  await page.click('[data-bg="white"]');
  const buf = await download('ajuster-blanc');
  const info = jpegInfo(buf);
  assert.deepEqual([info.width, info.height], [1748, 1181]);
  // 4:3 sur 1181 px de haut → 1575 px de large, bandes d'environ 87 px de chaque côté.
  const [band, top] = await samplePixels(buf, [[20, 590], [874, 5]]);
  assert.ok(near(band, [255, 255, 255], 8), `bande blanche attendue : ${band}`);
  assert.ok(near(top, [40, 180, 60]), `bande verte visible attendue : ${top}`);
});

await check('Ajuster (fond noir) : bandes noires', async () => {
  await page.click('[data-bg="black"]');
  const [band] = await samplePixels(await download('ajuster-noir'), [[20, 590]]);
  assert.ok(near(band, [0, 0, 0], 8), `bande noire attendue : ${band}`);
});

await check('Portrait : JPEG 1181 × 1748', async () => {
  await page.click('[data-mode="fill"]');
  await page.click('#orientBtn');
  const info = jpegInfo(await download('portrait'));
  assert.deepEqual([info.width, info.height], [1181, 1748]);
});

await check('Rotation 90° : la photo devient 3:4, carte portrait', async () => {
  await page.click('#orientBtn');   // revient en paysage pour vérifier la bascule auto
  await page.click('#rotateBtn');
  await page.waitForFunction(() => document.querySelector('#orientBtn').textContent.includes('Portrait'));
  const buf = await download('rotation');
  assert.deepEqual(Object.values(jpegInfo(buf)).slice(0, 2), [1748, 1181]);   // hauteur, largeur
  // Rotation horaire : la moitié gauche (rouge) passe en haut, la droite (bleue) en bas.
  const [top, bottom] = await samplePixels(buf, [[590, 3], [590, 1744]]);
  assert.ok(near(top, [210, 50, 50]), `haut rouge attendu : ${top}`);
  assert.ok(near(bottom, [50, 80, 210]), `bas bleu attendu : ${bottom}`);
});

await check('Retirer la photo : retour à l\'écran d\'accueil', async () => {
  await page.click('#removeBtn');
  await page.waitForSelector('#controls', { state: 'hidden' });
  assert.ok(await page.isVisible('#pickBtn'));
  assert.ok(await page.isHidden('#preview'));
  assert.ok(await page.isHidden('#quality'));
  // On peut recharger une photo ensuite.
  await page.setInputFiles('#fileInput', photoPath);
  await page.waitForSelector('#controls:not([hidden])');
  await page.click('[data-mode="fill"]');
});

await page.screenshot({ path: join(OUT, 'screenshot.png') });

await check('Format carte (54 × 86 mm) : 1016 × 638, puis 638 × 1016', async () => {
  await page.selectOption('#formatSelect', 'card');
  let buf = await download('carte');
  assert.match(lastFileName, /^selphy_carte_/);
  assert.deepEqual(Object.values(jpegInfo(buf)).slice(0, 2), [638, 1016]);   // hauteur, largeur
  await page.click('#orientBtn');
  buf = await download('carte-portrait');
  assert.deepEqual(Object.values(jpegInfo(buf)).slice(0, 2), [1016, 638]);
});

await check('Étiquette carrée (50 × 50 mm) : 591 × 591, sans bouton d\'orientation', async () => {
  await page.selectOption('#formatSelect', 'square');
  assert.ok(await page.isHidden('#orientBtn'));
  const buf = await download('carre');
  assert.match(lastFileName, /^selphy_carre_/);
  const info = jpegInfo(buf);
  assert.deepEqual([info.width, info.height], [591, 591]);
  assert.deepEqual(info.dpi, { units: 1, x: 300, y: 300 });
});

await check('Le dernier format choisi est mémorisé', async () => {
  await page.reload();
  assert.equal(await page.inputValue('#formatSelect'), 'square');
  // Retour à la carte postale pour la suite des tests.
  await page.selectOption('#formatSelect', 'postcard');
});

await check('Téléphone à l\'horizontale : aperçu exploitable', async () => {
  const p2 = await context.newPage();
  await p2.setViewportSize({ width: 844, height: 390 });
  await p2.goto(BASE);
  await p2.setInputFiles('#fileInput', photoPath);
  await p2.waitForSelector('#controls:not([hidden])');
  await p2.waitForTimeout(200);
  const box = await p2.locator('#preview').boundingBox();
  await p2.screenshot({ path: join(OUT, 'screenshot-paysage.png') });
  assert.ok(box.height > 280 && box.width > 400, `aperçu trop petit : ${box.width}×${box.height}`);
  const btn = await p2.locator('#downloadBtn').boundingBox();
  assert.ok(btn.y + btn.height <= 390, 'Télécharger hors écran');
  await p2.close();
});

await check('Grande photo (37 Mpx) : réduite en mémoire, export intact', async () => {
  const bigPath = join(OUT, 'photo-big.png');
  await writeFile(bigPath, makeTestPhoto(7000, 5250));
  await page.setInputFiles('#fileInput', bigPath);
  await page.waitForFunction(() => /réduite à 5244 × 3933/.test(document.querySelector('#status').textContent));
  await page.waitForFunction(() => document.querySelector('#quality').textContent.startsWith('300'));
  const info = jpegInfo(await download('grande-photo'));
  assert.deepEqual([info.width, info.height], [1748, 1181]);
});

await check('Web Share Target : la photo partagée s\'ouvre', async () => {
  // Attendre que le service worker contrôle la page.
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.reload();
  assert.ok(await page.evaluate(() => !!navigator.serviceWorker.controller), 'SW non actif');
  // Simule Android : formulaire multipart POST vers share-target.
  await page.evaluate(() => {
    const f = document.createElement('form');
    f.method = 'post';
    f.action = 'share-target';
    f.enctype = 'multipart/form-data';
    f.innerHTML = '<input type="file" name="photo" id="shareInput">';
    document.body.appendChild(f);
  });
  await page.setInputFiles('#shareInput', photoPath);
  await Promise.all([
    page.waitForURL((u) => u.pathname === new URL(BASE).pathname),
    page.evaluate(() => document.querySelector('#shareInput').form.submit()),
  ]);
  await page.waitForSelector('#controls:not([hidden])');
  assert.match(await page.textContent('#status'), /1600 × 1200/);
  const info = jpegInfo(await download('partage'));
  assert.deepEqual([info.width, info.height], [1748, 1181]);
});

await check('Hors ligne : l\'appli se recharge depuis le cache', async () => {
  await context.setOffline(true);
  await page.reload();
  await page.waitForSelector('#pickBtn');
  await context.setOffline(false);
});

await check('Aucune erreur dans la console', async () => {
  assert.deepEqual(errors, []);
});

await browser.close();
server.close();
console.log(process.exitCode ? 'ÉCHEC' : 'Tous les tests passent.');
