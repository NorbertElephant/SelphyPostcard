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
let swExtra = '';   // ajouté à sw.js pour simuler la publication d'une nouvelle version
const server = createServer(async (req, res) => {
  const path = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname));
  const file = join(ROOT, path.endsWith('/') || path.endsWith('\\') ? join(path, 'index.html') : path);
  try {
    let body = await readFile(file);
    if (file.endsWith('sw.js') && swExtra) body = Buffer.concat([body, Buffer.from(swExtra)]);
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

/** Ajoute à un JPEG un bloc EXIF minimal portant la date de prise de vue. */
function withExifDate(jpeg, date /* 'AAAA:MM:JJ HH:MM:SS' */) {
  const t = Buffer.alloc(64);                    // en-tête TIFF little-endian
  t.write('II', 0, 'latin1'); t.writeUInt16LE(42, 2); t.writeUInt32LE(8, 4);
  // IFD0 : une entrée, pointeur vers l'IFD Exif (offset 26).
  t.writeUInt16LE(1, 8); t.writeUInt16LE(0x8769, 10); t.writeUInt16LE(4, 12);
  t.writeUInt32LE(1, 14); t.writeUInt32LE(26, 18); t.writeUInt32LE(0, 22);
  // IFD Exif : DateTimeOriginal (ASCII, 20 octets à l'offset 44).
  t.writeUInt16LE(1, 26); t.writeUInt16LE(0x9003, 28); t.writeUInt16LE(2, 30);
  t.writeUInt32LE(20, 32); t.writeUInt32LE(44, 36); t.writeUInt32LE(0, 40);
  t.write(`${date}\0`, 44, 'latin1');
  const payload = Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), t]);
  const seg = Buffer.alloc(4);
  seg.writeUInt16BE(0xffe1, 0); seg.writeUInt16BE(payload.length + 2, 2);
  return Buffer.concat([jpeg.subarray(0, 2), seg, payload, jpeg.subarray(2)]);
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
  // _2, _3… si plusieurs exports tombent dans la même seconde.
  assert.match(dl.suggestedFilename(), /^selphy(_carte|_carre)?_\d{8}_\d{6}(_\d+)?\.jpg$/,
    `nom de fichier : ${dl.suggestedFilename()}`);
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

// ---- Série de photos ----
const portraitPath = join(OUT, 'photo-3x4.png');
await writeFile(portraitPath, makeTestPhoto(1200, 1600));

await check('Série : plusieurs photos, cadrage mémorisé par photo', async () => {
  await page.setInputFiles('#fileInput', [photoPath, portraitPath]);
  await page.waitForSelector('#navRow:not([hidden])');
  assert.match(await page.textContent('#counter'), /^1 \/ 2/);
  await page.locator('#zoom').fill('2');
  await download('serie-1');
  assert.match(await page.textContent('#counter'), /1 \/ 2 ✓ · 1 exportée/);
  await page.click('#nextNavBtn');
  await page.waitForFunction(() => document.querySelector('#counter').textContent.startsWith('2 / 2'));
  await page.waitForFunction(() => document.querySelector('#orientBtn').textContent.includes('Portrait'));
  assert.equal(await page.inputValue('#zoom'), '1');
  await page.click('#prevBtn');
  await page.waitForFunction(() => document.querySelector('#orientBtn').textContent.includes('Paysage'));
  assert.equal(await page.inputValue('#zoom'), '2');   // cadrage de la 1re photo retrouvé
});

await check('Série : « Photo suivante » en fin de série ouvre le sélecteur', async () => {
  await page.click('#nextNavBtn');
  await page.waitForFunction(() => document.querySelector('#counter').textContent.startsWith('2 / 2'));
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.click('#nextBtn')]);
  assert.ok(chooser.isMultiple(), 'sélection multiple attendue');
  await chooser.setFiles(photoPath);
  await page.waitForFunction(() => document.querySelector('#counter').textContent.startsWith('3 / 3'));
  // Retirer au milieu d'une série affiche la photo suivante.
  await page.click('#prevBtn');
  await page.waitForFunction(() => document.querySelector('#counter').textContent.startsWith('2 / 3'));
  await page.click('#removeBtn');
  await page.waitForFunction(() => document.querySelector('#counter').textContent.startsWith('2 / 2'));
  await page.click('#removeBtn');
  await page.click('#removeBtn');
  await page.waitForSelector('#controls', { state: 'hidden' });
});

// ---- Modes Polaroïd et Ajuster libre, légende, retouches ----
await page.setInputFiles('#fileInput', photoPath);
await page.waitForSelector('#controls:not([hidden])');

await check('Polaroïd : cadre blanc, photo à l\'intérieur, 1748 × 1181', async () => {
  await page.click('[data-mode="polaroid"]');
  const buf = await download('polaroid');
  const info = jpegInfo(buf);
  assert.deepEqual([info.width, info.height], [1748, 1181]);
  const [corner, band, inside] = await samplePixels(buf, [[10, 10], [874, 1140], [300, 500]]);
  assert.ok(near(corner, [255, 255, 255], 8), `coin blanc attendu : ${corner}`);
  assert.ok(near(band, [255, 255, 255], 8), `bande du bas blanche attendue : ${band}`);
  assert.ok(near(inside, [210, 50, 50]), `photo attendue dedans : ${inside}`);
});

await check('Légende : texte dessiné dans la bande du Polaroïd', async () => {
  await page.click('#textPanel summary');
  await page.fill('#captionText', 'Bretagne 2026');
  const buf = await download('polaroid-legende');
  const line = Array.from({ length: 300 }, (_, i) => [600 + i, 1112]);
  const px = await samplePixels(buf, line);
  const dark = px.filter((c) => c[0] < 128).length;
  assert.ok(dark > 10, `texte sombre attendu dans la bande (${dark} pixels sombres)`);
});

await check('Légende : date de prise de vue lue dans l\'EXIF', async () => {
  const exifPath = join(OUT, 'photo-exif.jpg');
  await writeFile(exifPath, withExifDate(await readFile(join(OUT, 'remplir.jpg')), '2024:08:15 10:30:00'));
  await page.setInputFiles('#fileInput', exifPath);
  await page.waitForFunction(() => document.querySelector('#counter').textContent.startsWith('2 / 2') &&
    !document.querySelector('#status').textContent.startsWith('Chargement'));
  assert.equal(await page.inputValue('#captionText'), '');   // légende propre à chaque photo
  await page.click('#dateBtn');
  assert.equal(await page.inputValue('#captionText'), '15 août 2024');
  await page.fill('#captionText', '');
  await page.click('#removeBtn');
  await page.waitForFunction(() => document.querySelector('#counter').textContent.startsWith('1 / 1'));
  await page.fill('#captionText', '');
});

await check('Ajuster libre : photo réduite et déplaçable dans la carte', async () => {
  await page.click('[data-mode="fit"]');
  await page.click('[data-bg="white"]');
  assert.equal(await page.getAttribute('#zoom', 'min'), '0.3');
  await page.locator('#zoom').fill('0.5');
  let buf = await download('ajuster-reduit');
  // Photo 4:3 à 50 % : environ 787 × 590 px au centre, fond blanc autour.
  let [left, center] = await samplePixels(buf, [[400, 590], [874, 590]]);
  assert.ok(near(left, [255, 255, 255], 8), `fond blanc attendu à gauche : ${left}`);
  assert.ok(!near(center, [255, 255, 255], 8), `photo attendue au centre : ${center}`);
  // Glisser la photo vers la gauche.
  const box = await page.locator('#preview').boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 - box.width * 0.2, box.y + box.height / 2, { steps: 5 });
  await page.mouse.up();
  buf = await download('ajuster-deplace');
  [left] = await samplePixels(buf, [[400, 590]]);
  assert.ok(!near(left, [255, 255, 255], 8), `la photo devrait couvrir la gauche : ${left}`);
  await page.click('#recenterBtn');
  assert.equal(await page.inputValue('#zoom'), '1');
});

await check('Retouches : lumière +50 éclaircit la photo, Réinitialiser l\'annule', async () => {
  await page.click('[data-mode="fill"]');
  await page.click('#adjustPanel summary');
  await page.locator('#brightness').fill('50');
  let [px] = await samplePixels(await download('lumiere'), [[3, 590]]);
  assert.ok(near(px, [255, 75, 75]), `rouge éclairci attendu : ${px}`);
  await page.click('#printBoostBtn');
  assert.equal(await page.inputValue('#brightness'), '10');
  assert.match(await page.textContent('#adjustHint'), /actives/);
  await page.click('#adjustResetBtn');
  [px] = await samplePixels(await download('lumiere-reset'), [[3, 590]]);
  assert.ok(near(px, [210, 50, 50]), `rouge d'origine attendu : ${px}`);
});

await check('Clavier : +, flèches, 0', async () => {
  await page.focus('#preview');
  await page.keyboard.press('+');
  await page.keyboard.press('+');
  const z = parseFloat(await page.inputValue('#zoom'));
  assert.ok(Math.abs(z - 1.21) < 0.01, `zoom 1,21 attendu : ${z}`);
  await page.keyboard.press('Shift+ArrowLeft');
  await page.keyboard.press('0');
  assert.equal(await page.inputValue('#zoom'), '1');
  // Les touches sont ignorées pendant la saisie de la légende.
  await page.focus('#captionText');
  await page.keyboard.press('+');
  assert.equal(await page.inputValue('#zoom'), '1');
  await page.fill('#captionText', '');
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

await check('Web Share Target : plusieurs photos partagées d\'un coup', async () => {
  await page.evaluate(() => {
    const f = document.createElement('form');
    f.method = 'post';
    f.action = 'share-target';
    f.enctype = 'multipart/form-data';
    f.innerHTML = '<input type="file" name="photo" id="shareInput2" multiple>';
    document.body.appendChild(f);
  });
  await page.setInputFiles('#shareInput2', [photoPath, portraitPath]);
  await Promise.all([
    page.waitForURL((u) => u.pathname === new URL(BASE).pathname),
    page.evaluate(() => document.querySelector('#shareInput2').form.submit()),
  ]);
  await page.waitForSelector('#navRow:not([hidden])');
  assert.match(await page.textContent('#counter'), /^1 \/ 2/);
});

if (!process.env.SELPHY_URL) {
  await check('Mise à jour : bannière « Nouvelle version disponible »', async () => {
    assert.ok(await page.isHidden('#updateBanner'));
    swExtra = '\n// nouvelle version simulée\n';
    await page.evaluate(async () => (await navigator.serviceWorker.getRegistration()).update());
    await page.waitForSelector('#updateBanner:not([hidden])');
    swExtra = '';
  });
}

await check('Navigateur intégré (WebView) : avertissement affiché', async () => {
  const ctx2 = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/130.0 Mobile Safari/537.36',
  });
  const p3 = await ctx2.newPage();
  await p3.goto(BASE);
  assert.ok(await p3.isVisible('#browserHint'));
  await ctx2.close();
  assert.ok(await page.isHidden('#browserHint'), 'pas d\'avertissement dans Chrome');
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
