// Génère les icônes PNG de l'appli (aucune dépendance : Node seul).
// Usage : node tools/make-icons.mjs
//
// Dessin : une carte postale blanche (ratio 148:100) avec soleil et montagnes,
// sur fond bleu nuit. Les variantes « maskable » ont un fond plein bord à bord
// et gardent le motif dans la zone de sécurité (cercle de 80 %).

import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'icons');
const SS = 4; // sur-échantillonnage pour l'anticrénelage

const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const COLORS = {
  bg: hex('#1e3a5f'),
  card: hex('#ffffff'),
  sky: hex('#9fd3f5'),
  sun: hex('#ffc94a'),
  mountainBack: hex('#5a9e6f'),
  mountainFront: hex('#2f7a4c'),
};

// Distance signée à un rectangle arrondi centré (cx, cy), demi-tailles (hw, hh), rayon r.
function roundRect(x, y, cx, cy, hw, hh, r) {
  const qx = Math.abs(x - cx) - hw + r;
  const qy = Math.abs(y - cy) - hh + r;
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
}

// Point (x, y) sous la crête d'une montagne triangulaire (sommet px, py, pente k) ?
const underPeak = (x, y, px, py, k) => y >= py + k * Math.abs(x - px);

/** Couleur [r, g, b, a] du point (x, y) en coordonnées normalisées 0..1. */
function shade(x, y, maskable) {
  // Fond : plein pour maskable, carré arrondi sinon.
  if (!maskable && roundRect(x, y, 0.5, 0.5, 0.5, 0.5, 0.22) > 0) return [0, 0, 0, 0];
  const cw = maskable ? 0.31 : 0.36;          // demi-largeur de la carte
  const ch = cw / 1.48;                       // demi-hauteur (ratio carte postale)
  if (roundRect(x, y, 0.5, 0.5, cw, ch, 0.03) > 0) return [...COLORS.bg, 255];

  // Image imprimée sur la carte, avec une petite marge blanche.
  const m = cw * 0.1;
  if (roundRect(x, y, 0.5, 0.5, cw - m, ch - m, 0.01) > 0) return [...COLORS.card, 255];
  const left = 0.5 - cw + m;
  const top = 0.5 - ch + m;
  const iw = 2 * (cw - m);
  const ih = 2 * (ch - m);
  const u = (x - left) / iw;   // 0..1 dans l'image
  const v = (y - top) / ih;

  if (underPeak(u, v, 0.32, 0.42, 1.1)) return [...COLORS.mountainFront, 255];
  if (underPeak(u, v, 0.7, 0.3, 0.9)) return [...COLORS.mountainBack, 255];
  if (Math.hypot((u - 0.78) * iw, (v - 0.28) * ih) < 0.12 * ih) return [...COLORS.sun, 255];
  return [...COLORS.sky, 255];
}

function render(size, maskable) {
  const px = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const acc = [0, 0, 0, 0];
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const c = shade((x + (sx + 0.5) / SS) / size, (y + (sy + 0.5) / SS) / size, maskable);
          // Accumulation prémultipliée pour des bords transparents propres.
          acc[0] += c[0] * c[3]; acc[1] += c[1] * c[3]; acc[2] += c[2] * c[3]; acc[3] += c[3];
        }
      }
      const i = (y * size + x) * 4;
      const a = acc[3] / (SS * SS);
      px[i] = acc[3] ? Math.round(acc[0] / acc[3]) : 0;
      px[i + 1] = acc[3] ? Math.round(acc[1] / acc[3]) : 0;
      px[i + 2] = acc[3] ? Math.round(acc[2] / acc[3]) : 0;
      px[i + 3] = Math.round(a);
    }
  }
  return encodePng(size, size, px);
}

// ---- Encodeur PNG minimal (RGBA 8 bits, filtre 0) ----

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
export function encodePng(w, h, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8 bits, RGBA
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// Exécuté directement (pas importé) : écrit les 4 icônes.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  mkdirSync(OUT_DIR, { recursive: true });
  for (const size of [192, 512]) {
    writeFileSync(join(OUT_DIR, `icon-${size}.png`), render(size, false));
    writeFileSync(join(OUT_DIR, `icon-maskable-${size}.png`), render(size, true));
  }
  console.log(`Icônes écrites dans ${OUT_DIR}`);
}
