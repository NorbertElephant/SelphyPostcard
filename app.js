/* Selphy Postcard — prépare des photos aux formats de la Canon SELPHY CP1500
 * (carte postale 100 × 148 mm, carte 54 × 86 mm, étiquette carrée 50 × 50 mm).
 * Sortie : JPEG à 300 dpi, au ratio exact du papier, pour une impression sans bordure.
 *
 * Tout se passe dans le navigateur : aucune requête réseau.
 */
'use strict';

// ---------------------------------------------------------------------------
// Constantes
// ---------------------------------------------------------------------------

/*
 * Formats de papier de la SELPHY CP1500 (fiche technique Canon), impression sans bordure.
 * mm et px : [grand côté, petit côté] ; px = mm / 25,4 × 300 dpi.
 * safeMm : marge estimée rognée (ou découpée) sur chaque bord.
 */
const FORMATS = {
  postcard: { name: 'Carte postale', mm: [148, 100], px: [1748, 1181], safeMm: 2, file: 'selphy' },
  card:     { name: 'Carte',         mm: [86, 54],   px: [1016, 638],  safeMm: 2, file: 'selphy_carte' },
  square:   { name: 'Étiquette carrée', mm: [50, 50], px: [591, 591],  safeMm: 1.5, file: 'selphy_carre' },
};
const DEFAULT_FORMAT = 'postcard';
const FORMAT_STORAGE_KEY = 'selphy-format';   // dernier format choisi (confort, facultatif)
const MAX_ZOOM = 5;             // Remplir / Polaroïd : 1 = couverture minimale
const FIT_MIN_ZOOM = 0.3;       // Ajuster : 1 = photo entière, la plus grande possible
const FIT_MAX_ZOOM = 3;
const JPEG_QUALITY = 0.95;
const DPI = 300;
const WARN_DPI = 200;           // en dessous, l'impression risque d'être floue
// Au-delà de 3× la plus grande sortie, les pixels en plus n'améliorent pas
// l'impression (même à zoom 3) mais coûtent beaucoup de mémoire : on réduit la photo.
const MAX_DECODE = FORMATS.postcard.px[0] * 3;
const PREVIEW_MAX = 2048;       // copie allégée utilisée pour l'aperçu et le flou
// Retouche « Éclaircir pour l'impression » (les tirages sortent plus sombres qu'à l'écran).
const PRINT_BOOST = { brightness: 10, contrast: 5, saturation: 5 };
const FONTS = {
  sans: '600 {size}px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
  serif: 'italic 500 {size}px Georgia, "Times New Roman", serif',
  script: '400 {size}px "Segoe Script", "Bradley Hand", "Brush Script MT", "Dancing Script", cursive',
};
const SHARE_CACHE = 'selphy-share';
const SHARE_PREFIX = './__shared-photo-';    // + numéro ; mêmes valeurs dans sw.js
// ctx.filter (retouches, flou) n'existe pas partout : repli calculé pixel par pixel.
const HAS_FILTER = typeof CanvasRenderingContext2D !== 'undefined' &&
  'filter' in CanvasRenderingContext2D.prototype;

// ---------------------------------------------------------------------------
// État de l'appli
// ---------------------------------------------------------------------------

const state = {
  bitmap: null,       // ImageBitmap de travail (orientation EXIF appliquée, ≤ MAX_DECODE)
  small: null,        // copie ≤ PREVIEW_MAX (peut être le même objet que bitmap)
  serial: 0,          // change à chaque nouvelle image (sert de clé au pré-export)
  format: loadFormat(),   // clé de FORMATS
  landscape: true,    // orientation de la carte (sans effet pour le carré)
  mode: 'fill',       // 'fill' (Remplir) | 'fit' (Ajuster) | 'polaroid'
  bg: 'blur',         // fond en mode Ajuster : 'blur' | 'white' | 'black'
  zoom: 1,            // Remplir / Polaroïd
  cx: 0, cy: 0,       // centre de la zone visible, en pixels de state.bitmap
  fitZoom: 1,         // Ajuster : échelle relative à « photo entière »
  fitX: 0, fitY: 0,   // Ajuster : décalage du centre de la photo, en fraction de la carte
  guide: true,        // affiche la zone de sécurité dans l'aperçu
  adjust: { brightness: 0, contrast: 0, saturation: 0 },   // en %, pour toutes les photos
  font: 'sans',       // police de la légende
  caption: '',        // légende de la photo courante
};

/*
 * Série de photos : seuls les fichiers sont gardés (pas les images décodées) ;
 * chaque entrée retient son cadrage, sa rotation et sa légende.
 */
const queue = {
  items: [],          // { file, rotation (quarts de tour), view, caption, date, exported }
  index: -1,
};

/** Dernier format utilisé (le stockage local peut être indisponible : navigation privée…). */
function loadFormat() {
  try {
    const f = localStorage.getItem(FORMAT_STORAGE_KEY);
    if (f && FORMATS[f]) return f;
  } catch (e) { /* stockage indisponible : format par défaut */ }
  return DEFAULT_FORMAT;
}

function saveFormat() {
  try { localStorage.setItem(FORMAT_STORAGE_KEY, state.format); } catch (e) { /* sans importance */ }
}

// ---------------------------------------------------------------------------
// Éléments du DOM
// ---------------------------------------------------------------------------

const $ = (id) => document.getElementById(id);
const els = {
  stage: $('stage'),
  empty: $('empty'),
  preview: $('preview'),
  dropOverlay: $('dropOverlay'),
  controls: $('controls'),
  fileInput: $('fileInput'),
  pickBtn: $('pickBtn'),
  orientBtn: $('orientBtn'),
  rotateBtn: $('rotateBtn'),
  recenterBtn: $('recenterBtn'),
  zoom: $('zoom'),
  bgRow: $('bgRow'),
  brightness: $('brightness'),
  contrast: $('contrast'),
  saturation: $('saturation'),
  printBoostBtn: $('printBoostBtn'),
  adjustResetBtn: $('adjustResetBtn'),
  adjustHint: $('adjustHint'),
  captionText: $('captionText'),
  dateBtn: $('dateBtn'),
  textHint: $('textHint'),
  guide: $('guide'),
  safeLabel: $('safeLabel'),
  navRow: $('navRow'),
  prevBtn: $('prevBtn'),
  nextNavBtn: $('nextNavBtn'),
  counter: $('counter'),
  downloadBtn: $('downloadBtn'),
  shareBtn: $('shareBtn'),
  nextBtn: $('nextBtn'),
  addBtn: $('addBtn'),
  removeBtn: $('removeBtn'),
  installBtn: $('installBtn'),
  updateBanner: $('updateBanner'),
  reloadBtn: $('reloadBtn'),
  formatSelect: $('formatSelect'),
  quality: $('quality'),
  status: $('status'),
};
const pctx = els.preview.getContext('2d');

// ---------------------------------------------------------------------------
// Géométrie
// ---------------------------------------------------------------------------

/** Dimensions de sortie (px) selon le format et l'orientation. */
function outputSize() {
  const [long, short] = FORMATS[state.format].px;
  return state.landscape ? [long, short] : [short, long];
}

/** Dimensions du papier (mm) selon le format et l'orientation. */
function paperMm() {
  const [long, short] = FORMATS[state.format].mm;
  return state.landscape ? [long, short] : [short, long];
}

const isSquare = () => FORMATS[state.format].px[0] === FORMATS[state.format].px[1];
const isFit = () => state.mode === 'fit';

/**
 * Rectangle occupé par la photo dans une carte w × h : toute la carte en mode
 * Remplir ; en Polaroïd, cadre blanc avec une bande plus large en bas (légende).
 */
function photoRect(w, h) {
  if (state.mode !== 'polaroid') return { x: 0, y: 0, w, h };
  const m = Math.min(w, h) * 0.055;
  return { x: m, y: m, w: w - 2 * m, h: h - 4.2 * m };
}

/** Ratio largeur / hauteur de la zone photo (indépendant de la résolution). */
function targetRatio() {
  const [w, h] = outputSize();
  const r = photoRect(w, h);
  return r.w / r.h;
}

/**
 * Taille (en pixels de la photo) de la zone visible en Remplir / Polaroïd.
 * À zoom 1, c'est le plus grand rectangle au ratio de la zone photo contenu dans la photo.
 */
function viewSize(zoom = state.zoom) {
  const { width: iw, height: ih } = state.bitmap;
  const r = targetRatio();
  let vw, vh;
  if (iw / ih > r) { vh = ih; vw = ih * r; } else { vw = iw; vh = iw / r; }
  return [vw / zoom, vh / zoom];
}

/** Échelle (px de carte par px de photo) de la photo en mode Ajuster. */
function fitScale(w, h) {
  return Math.min(w / state.bitmap.width, h / state.bitmap.height) * state.fitZoom;
}

/** Garde le cadrage dans les limites du mode courant. */
function clampView() {
  state.zoom = Math.min(MAX_ZOOM, Math.max(1, state.zoom));
  const { width: iw, height: ih } = state.bitmap;
  const [vw, vh] = viewSize();
  state.cx = Math.min(iw - vw / 2, Math.max(vw / 2, state.cx));
  state.cy = Math.min(ih - vh / 2, Math.max(vh / 2, state.cy));
  // Ajuster : le centre de la photo reste sur la carte.
  state.fitZoom = Math.min(FIT_MAX_ZOOM, Math.max(FIT_MIN_ZOOM, state.fitZoom));
  state.fitX = Math.min(0.5, Math.max(-0.5, state.fitX));
  state.fitY = Math.min(0.5, Math.max(-0.5, state.fitY));
}

/** Recentre la photo et remet les zooms à leur valeur de départ. */
function resetView() {
  state.zoom = 1;
  state.cx = state.bitmap.width / 2;
  state.cy = state.bitmap.height / 2;
  state.fitZoom = 1;
  state.fitX = state.fitY = 0;
  clampView();
}

/** Résolution réelle à l'impression : pixels de la photo par pouce de papier. */
function effectiveDpi() {
  const [w, h] = outputSize();
  if (isFit()) return DPI / fitScale(w, h);
  return DPI * viewSize()[0] / photoRect(w, h).w;
}

// ---------------------------------------------------------------------------
// Rendu (commun à l'aperçu et à l'export)
// ---------------------------------------------------------------------------

/**
 * Choisit l'image source : la copie allégée suffit à l'aperçu tant qu'elle a au
 * moins autant de pixels que la zone dessinée (span px de la photo → dest px
 * à l'écran). L'export (hiRes) lit toujours la photo de travail.
 */
function sourceFor(span, dest, hiRes) {
  if (hiRes) return state.bitmap;
  const k = state.small.width / state.bitmap.width;
  return span * k >= dest ? state.small : state.bitmap;
}

/** Filtre CSS des retouches, ou '' si aucune. */
function adjustFilter() {
  const { brightness: b, contrast: c, saturation: s } = state.adjust;
  if (!b && !c && !s) return '';
  return `brightness(${1 + b / 100}) contrast(${1 + c / 100}) saturate(${1 + s / 100})`;
}

/** Dessine la carte sur ctx, à la taille w × h (même ratio que la carte). */
function renderCard(ctx, w, h, hiRes) {
  const bmp = state.bitmap;
  const filter = HAS_FILTER ? adjustFilter() : '';
  ctx.save();
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';

  let adjusted;   // zone à retoucher pixel par pixel si ctx.filter manque
  if (isFit()) {
    // Ajuster : fond, puis photo entière (déplaçable, zoomable).
    drawBackground(ctx, w, h, filter);
    const s = fitScale(w, h);
    const dw = bmp.width * s;
    const dh = bmp.height * s;
    const dx = w * (0.5 + state.fitX) - dw / 2;
    const dy = h * (0.5 + state.fitY) - dh / 2;
    if (filter) ctx.filter = filter;
    ctx.drawImage(sourceFor(bmp.width, dw, hiRes), dx, dy, dw, dh);
    ctx.filter = 'none';
    adjusted = { x: 0, y: 0, w, h };
  } else {
    // Remplir / Polaroïd : on découpe la zone visible et on l'étire sur la zone photo.
    const r = photoRect(w, h);
    if (state.mode === 'polaroid') {
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, w, h);
    }
    const [vw, vh] = viewSize();
    const src = sourceFor(vw, r.w, hiRes);
    const k = src.width / bmp.width;
    if (filter) ctx.filter = filter;
    ctx.drawImage(src, (state.cx - vw / 2) * k, (state.cy - vh / 2) * k, vw * k, vh * k, r.x, r.y, r.w, r.h);
    ctx.filter = 'none';
    adjusted = r;
  }
  if (!HAS_FILTER && adjustFilter()) applyAdjustPixels(ctx, adjusted);
  drawCaption(ctx, w, h);
  ctx.restore();
}

/** Fond du mode Ajuster : couleur unie ou photo agrandie et floutée. */
function drawBackground(ctx, w, h, filter) {
  if (state.bg !== 'blur') {
    ctx.fillStyle = state.bg === 'white' ? '#ffffff' : '#000000';
    ctx.fillRect(0, 0, w, h);
    return;
  }
  // Le flou efface les détails : la copie allégée suffit, et c'est bien plus rapide.
  const bmp = state.small;
  // Photo en mode « couverture », légèrement agrandie pour masquer les bords
  // transparents produits par le flou.
  const s = Math.max(w / bmp.width, h / bmp.height) * 1.15;
  const dw = bmp.width * s;
  const dh = bmp.height * s;
  const dx = (w - dw) / 2;
  const dy = (h - dh) / 2;
  const radius = Math.max(w, h) * 0.03;

  if (HAS_FILTER) {
    ctx.filter = `${filter} blur(${radius}px)`;
    ctx.drawImage(bmp, dx, dy, dw, dh);
    ctx.filter = 'none';
  } else {
    // Repli (navigateurs sans ctx.filter) : réduction puis agrandissement = flou doux.
    const small = document.createElement('canvas');
    small.width = 48;
    small.height = Math.max(1, Math.round(48 * h / w));
    const sctx = small.getContext('2d');
    sctx.drawImage(bmp, dx * 48 / w, dy * small.height / h, dw * 48 / w, dh * small.height / h);
    ctx.drawImage(small, 0, 0, w, h);
  }
  // Léger voile pour faire ressortir la photo nette.
  ctx.fillStyle = 'rgba(0, 0, 0, 0.12)';
  ctx.fillRect(0, 0, w, h);
}

/**
 * Repli des retouches sans ctx.filter : mêmes formules que les filtres CSS
 * brightness → contrast → saturate, appliquées aux pixels de la zone photo.
 */
function applyAdjustPixels(ctx, r) {
  const x = Math.max(0, Math.floor(r.x));
  const y = Math.max(0, Math.floor(r.y));
  const w = Math.ceil(r.w);
  const h = Math.ceil(r.h);
  const img = ctx.getImageData(x, y, w, h);
  const d = img.data;
  const b = 1 + state.adjust.brightness / 100;
  const c = 1 + state.adjust.contrast / 100;
  const s = 1 + state.adjust.saturation / 100;
  const off = 255 * 0.5 * (1 - c);
  for (let i = 0; i < d.length; i += 4) {
    let R = d[i] * b * c + off;
    let G = d[i + 1] * b * c + off;
    let B = d[i + 2] * b * c + off;
    // saturate() : matrice de la spécification Filter Effects.
    const r2 = (0.213 + 0.787 * s) * R + (0.715 - 0.715 * s) * G + (0.072 - 0.072 * s) * B;
    const g2 = (0.213 - 0.213 * s) * R + (0.715 + 0.285 * s) * G + (0.072 - 0.072 * s) * B;
    const b2 = (0.213 - 0.213 * s) * R + (0.715 - 0.715 * s) * G + (0.072 + 0.928 * s) * B;
    d[i] = r2; d[i + 1] = g2; d[i + 2] = b2;   // Uint8ClampedArray : bornage automatique
  }
  ctx.putImageData(img, x, y);
}

/**
 * Légende : dans la bande du bas en Polaroïd (texte sombre), sinon en bas de la
 * photo, en blanc ombré (ou sombre sur fond blanc), toujours dans la zone de sécurité.
 */
function drawCaption(ctx, w, h) {
  const text = state.caption.trim();
  if (!text) return;
  const [mmW] = paperMm();
  const safe = w * FORMATS[state.format].safeMm / mmW;   // marge de sécurité en px
  const maxWidth = w - 2 * safe - w * 0.04;
  let size, y, dark;
  if (state.mode === 'polaroid') {
    const r = photoRect(w, h);
    const band = h - (r.y + r.h);
    size = band * 0.42;
    y = r.y + r.h + band * 0.5;
    dark = true;
  } else {
    size = Math.min(w, h) * 0.065;
    y = h - safe - size * 0.9;
    dark = isFit() && state.bg === 'white';
  }
  ctx.save();
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = FONTS[state.font].replace('{size}', size.toFixed(1));
  // Réduit la police si la légende est trop longue pour la carte.
  const tw = ctx.measureText(text).width;
  if (tw > maxWidth) {
    size *= maxWidth / tw;
    ctx.font = FONTS[state.font].replace('{size}', size.toFixed(1));
  }
  if (dark) {
    ctx.fillStyle = '#2a2a2a';
  } else {
    ctx.fillStyle = '#ffffff';
    ctx.shadowColor = 'rgba(0, 0, 0, 0.6)';
    ctx.shadowBlur = size * 0.25;
    ctx.shadowOffsetY = size * 0.04;
  }
  ctx.fillText(text, w / 2, y);
  ctx.restore();
}

/** Pointillés indiquant la zone qui sera rognée à l'impression sans bordure. */
function drawSafeGuide(ctx, w, h) {
  const [mmW, mmH] = paperMm();
  const safe = FORMATS[state.format].safeMm;
  const mx = w * safe / mmW;
  const my = h * safe / mmH;
  const lw = Math.max(1, w / 400);
  ctx.save();
  // Bandes rognées légèrement assombries.
  ctx.fillStyle = 'rgba(0, 0, 0, 0.25)';
  ctx.fillRect(0, 0, w, my);
  ctx.fillRect(0, h - my, w, my);
  ctx.fillRect(0, my, mx, h - 2 * my);
  ctx.fillRect(w - mx, my, mx, h - 2 * my);
  // Contour en pointillés blanc + noir pour rester visible sur tout fond.
  ctx.lineWidth = lw;
  ctx.setLineDash([lw * 6, lw * 4]);
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.9)';
  ctx.strokeRect(mx, my, w - 2 * mx, h - 2 * my);
  ctx.lineDashOffset = lw * 5;
  ctx.strokeStyle = 'rgba(0, 0, 0, 0.6)';
  ctx.strokeRect(mx, my, w - 2 * mx, h - 2 * my);
  ctx.restore();
}

// ---------------------------------------------------------------------------
// Aperçu
// ---------------------------------------------------------------------------

let previewCss = { w: 0, h: 0 };   // taille CSS de l'aperçu
let frameRequested = false;

/** Calcule la taille de l'aperçu pour tenir dans la zone, au ratio exact de la carte. */
function layoutPreview() {
  if (!state.bitmap) return;
  const style = getComputedStyle(els.stage);
  const availW = els.stage.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
  const availH = els.stage.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom);
  const [ow, oh] = outputSize();
  const r = ow / oh;
  let w = availW;
  let h = w / r;
  if (h > availH) { h = availH; w = h * r; }
  w = Math.max(1, Math.floor(w));
  h = Math.max(1, Math.floor(h));
  previewCss = { w, h };

  const dpr = window.devicePixelRatio || 1;
  els.preview.style.width = `${w}px`;
  els.preview.style.height = `${h}px`;
  els.preview.width = Math.round(w * dpr);
  els.preview.height = Math.round(h * dpr);
  draw();
}

/** Redessine l'aperçu au prochain frame (limite le travail pendant un drag). */
function draw() {
  if (frameRequested) return;
  frameRequested = true;
  requestAnimationFrame(() => {
    frameRequested = false;
    if (!state.bitmap) return;
    const { width: w, height: h } = els.preview;
    pctx.clearRect(0, 0, w, h);
    renderCard(pctx, w, h, false);
    if (state.guide) drawSafeGuide(pctx, w, h);
    updateQuality();
    schedulePrerender();
  });
}

/** Affiche la résolution d'impression, en orange si elle est trop basse. */
function updateQuality() {
  const dpi = Math.round(effectiveDpi());
  const low = dpi < WARN_DPI;
  els.quality.hidden = false;
  els.quality.classList.toggle('warn', low);
  els.quality.textContent = dpi >= DPI ? `${DPI} dpi ✓` : low ? `⚠ ${dpi} dpi : risque de flou` : `${dpi} dpi`;
  els.quality.title = 'Résolution réelle de la photo à l\'impression (300 dpi = qualité maximale de la SELPHY)';
}

// ---------------------------------------------------------------------------
// Décodage d'une photo
// ---------------------------------------------------------------------------

/** Décode le fichier en appliquant l'orientation EXIF. */
async function decodeImage(blob) {
  try {
    return await createImageBitmap(blob, { imageOrientation: 'from-image' });
  } catch (e) {
    // Anciens navigateurs qui ne connaissent pas l'option : ils appliquent l'EXIF par défaut.
    return await createImageBitmap(blob);
  }
}

/** Réduit bmp pour que son grand côté ne dépasse pas max (bmp est libéré si réduit). */
async function shrink(bmp, max, closeOriginal) {
  const long = Math.max(bmp.width, bmp.height);
  if (long <= max) return bmp;
  const k = max / long;
  const out = await createImageBitmap(bmp, {
    resizeWidth: Math.round(bmp.width * k),
    resizeHeight: Math.round(bmp.height * k),
    resizeQuality: 'high',
  });
  if (closeOriginal) bmp.close();
  return out;
}

/** Pivote bmp de quarters × 90° dans le sens horaire (bmp est libéré). */
async function rotateBitmap(bmp, quarters) {
  const q = ((quarters % 4) + 4) % 4;
  if (!q) return bmp;
  const swap = q % 2 === 1;
  const canvas = document.createElement('canvas');
  canvas.width = swap ? bmp.height : bmp.width;
  canvas.height = swap ? bmp.width : bmp.height;
  const ctx = canvas.getContext('2d');
  ctx.translate(canvas.width / 2, canvas.height / 2);
  ctx.rotate(q * Math.PI / 2);
  ctx.drawImage(bmp, -bmp.width / 2, -bmp.height / 2);
  const out = await createImageBitmap(canvas);
  canvas.width = canvas.height = 0;   // libère la mémoire du canvas tout de suite
  bmp.close();
  return out;
}

/** Libère les images décodées de la photo courante. */
function releaseBitmaps() {
  if (state.small && state.small !== state.bitmap) state.small.close();
  if (state.bitmap) state.bitmap.close();
  state.bitmap = state.small = null;
}

/** Installe une nouvelle image de travail (et sa copie allégée). */
async function setBitmap(bmp) {
  const small = await shrink(bmp, PREVIEW_MAX, false);
  releaseBitmaps();
  state.bitmap = bmp;
  state.small = small;
  state.serial++;
}

/**
 * Date de prise de vue (EXIF DateTimeOriginal) d'un JPEG, ou null.
 * Lecture minimale : seuls les 128 premiers Ko sont lus.
 */
async function readExifDate(file) {
  try {
    const v = new DataView(await file.slice(0, 131072).arrayBuffer());
    if (v.getUint16(0) !== 0xFFD8) return null;
    let p = 2;
    while (p + 4 < v.byteLength) {
      const marker = v.getUint16(p);
      const len = v.getUint16(p + 2);
      if (marker === 0xFFE1 && v.getUint32(p + 4) === 0x45786966) {   // « Exif »
        const t = p + 10;                                             // début TIFF
        const le = v.getUint16(t) === 0x4949;
        const u16 = (o) => v.getUint16(t + o, le);
        const u32 = (o) => v.getUint32(t + o, le);
        // Cherche une étiquette dans un IFD ; renvoie l'offset de sa valeur.
        const find = (ifd, tag) => {
          const n = u16(ifd);
          for (let i = 0; i < n; i++) {
            const e = ifd + 2 + i * 12;
            if (u16(e) === tag) return u32(e + 8);
          }
          return null;
        };
        const ifd0 = u32(4);
        const exif = find(ifd0, 0x8769);
        const at = (exif !== null && find(exif, 0x9003)) || find(ifd0, 0x0132);
        if (at === null) return null;
        let s = '';
        for (let i = 0; i < 19; i++) s += String.fromCharCode(v.getUint8(t + at + i));
        const m = s.match(/^(\d{4}):(\d{2}):(\d{2})/);
        return m ? new Date(+m[1], +m[2] - 1, +m[3]) : null;
      }
      if ((marker & 0xFF00) !== 0xFF00 || marker === 0xFFDA) return null;
      p += 2 + len;
    }
  } catch (e) { /* EXIF absent ou illisible */ }
  return null;
}

// ---------------------------------------------------------------------------
// Série de photos
// ---------------------------------------------------------------------------

/** Ajoute des fichiers à la série et affiche le premier ajouté. */
async function addFiles(fileList) {
  const files = [...fileList].filter((f) => !f.type || f.type.startsWith('image/'));
  if (!files.length) {
    setStatus('Aucune image dans la sélection.');
    return;
  }
  const first = queue.items.length;
  for (const file of files) {
    queue.items.push({ file, rotation: 0, view: null, caption: '', date: undefined, exported: false });
  }
  await showItem(first);
}

/** Mémorise le cadrage et la légende de la photo affichée. */
function saveCurrent() {
  const item = queue.items[queue.index];
  if (!item || !state.bitmap) return;
  const { landscape, zoom, cx, cy, fitZoom, fitX, fitY } = state;
  item.view = { landscape, zoom, cx, cy, fitZoom, fitX, fitY };
  item.caption = state.caption;
}

let loadToken = 0;   // ignore un chargement devenu obsolète (navigation rapide)

/** Décode et affiche la photo n° i de la série. */
async function showItem(i) {
  if (i < 0 || i >= queue.items.length) return;
  saveCurrent();
  const token = ++loadToken;
  const item = queue.items[i];
  queue.index = i;
  updateNav();
  setStatus('Chargement…');

  let bmp;
  try {
    bmp = await decodeImage(item.file);
  } catch (e) {
    if (token !== loadToken) return;
    console.error(e);
    setStatus(`Impossible de lire « ${item.file.name || 'cette image'} » (format non pris en charge par le navigateur ?).`);
    return;
  }
  const [ow, oh] = [bmp.width, bmp.height];
  try {
    bmp = await shrink(bmp, MAX_DECODE, true);
    bmp = await rotateBitmap(bmp, item.rotation);
    if (token !== loadToken) { bmp.close(); return; }
    await setBitmap(bmp);
  } catch (e) {
    console.error(e);
    setStatus('Photo trop lourde pour la mémoire de l\'appareil.');
    return;
  }

  // Cadrage : celui mémorisé pour cette photo, sinon automatique.
  if (item.view) {
    Object.assign(state, item.view);
    clampView();
  } else {
    state.landscape = bmp.width >= bmp.height;   // orientation automatique
    resetView();
  }
  state.caption = item.caption;
  els.captionText.value = item.caption;
  if (item.date === undefined) item.date = await readExifDate(item.file);

  showEditor(true);
  updateUi();
  layoutPreview();
  const reduced = Math.max(ow, oh) > MAX_DECODE;
  setStatus(reduced
    ? `Photo ${ow} × ${oh} px (réduite à ${bmp.width} × ${bmp.height}, sans perte à l'impression)`
    : `Photo ${ow} × ${oh} px`);
}

/**
 * Retire la photo affichée de la série (ou tout, s'il n'en reste qu'une).
 * Libère la mémoire ; le fichier d'origine n'est jamais modifié (l'appli ne fait que le lire).
 */
function removeCurrent() {
  if (queue.index < 0) return;
  queue.items.splice(queue.index, 1);
  if (queue.items.length) {
    const next = Math.min(queue.index, queue.items.length - 1);
    queue.index = -1;   // rien à mémoriser : la photo vient d'être retirée
    showItem(next);
    return;
  }
  queue.index = -1;
  loadToken++;
  clearTimeout(prerenderTimer);
  exportCache = null;
  releaseBitmaps();
  state.serial++;
  showEditor(false);
  setStatus('');
}

/** Bascule entre l'écran d'accueil et l'éditeur. */
function showEditor(on) {
  document.body.classList.toggle('has-photo', on);
  els.empty.hidden = on;
  els.preview.hidden = !on;
  els.controls.hidden = !on;
  els.quality.hidden = !on;
}

/** Compteur « 3 / 10 » et boutons ◀ ▶. */
function updateNav() {
  const n = queue.items.length;
  els.navRow.hidden = n < 2;
  els.prevBtn.disabled = queue.index <= 0;
  els.nextNavBtn.disabled = queue.index >= n - 1;
  const done = queue.items.filter((it) => it.exported).length;
  const cur = queue.items[queue.index];
  els.counter.textContent = `${queue.index + 1} / ${n}` + (cur && cur.exported ? ' ✓' : '') +
    (n > 1 ? ` · ${done} exportée${done > 1 ? 's' : ''}` : '');
}

function openPicker() {
  els.fileInput.click();
}

function goNext() {
  if (queue.index < queue.items.length - 1) showItem(queue.index + 1);
  else openPicker();   // fin de série : en choisir d'autres
}

function setStatus(msg) {
  els.status.textContent = msg;
}

// ---------------------------------------------------------------------------
// Interface
// ---------------------------------------------------------------------------

/** Synchronise les contrôles avec l'état. */
function updateUi() {
  const check = (sel, key, value) => document.querySelectorAll(sel).forEach((b) => {
    b.setAttribute('aria-checked', String(b.dataset[key] === value));
  });
  check('[data-mode]', 'mode', state.mode);
  check('[data-bg]', 'bg', state.bg);
  check('[data-font]', 'font', state.font);
  els.bgRow.hidden = !isFit();
  // Le même curseur règle le zoom du mode courant.
  els.zoom.min = String(isFit() ? FIT_MIN_ZOOM : 1);
  els.zoom.max = String(isFit() ? FIT_MAX_ZOOM : MAX_ZOOM);
  els.zoom.value = String(isFit() ? state.fitZoom : state.zoom);
  els.orientBtn.textContent = state.landscape ? '▭ Paysage' : '▯ Portrait';
  els.orientBtn.hidden = isSquare();   // un carré n'a pas d'orientation
  els.formatSelect.value = state.format;
  els.safeLabel.textContent = `~${String(FORMATS[state.format].safeMm).replace('.', ',')} mm`;
  for (const k of ['brightness', 'contrast', 'saturation']) {
    els[k].value = String(state.adjust[k]);
    $(`${k}Val`).textContent = (state.adjust[k] > 0 ? '+' : '') + state.adjust[k];
  }
  els.adjustHint.textContent = adjustFilter() ? '• actives' : '';
  els.textHint.textContent = state.caption.trim() ? '• 1 légende' : '';
  updateNav();
}

els.formatSelect.value = state.format;
els.formatSelect.addEventListener('change', () => {
  state.format = els.formatSelect.value;
  saveFormat();
  if (!state.bitmap) return;
  resetView();
  updateUi();
  layoutPreview();
});

els.pickBtn.addEventListener('click', openPicker);
els.addBtn.addEventListener('click', openPicker);
els.nextBtn.addEventListener('click', goNext);
els.nextNavBtn.addEventListener('click', () => showItem(queue.index + 1));
els.prevBtn.addEventListener('click', () => showItem(queue.index - 1));
els.removeBtn.addEventListener('click', removeCurrent);
els.fileInput.addEventListener('change', () => {
  addFiles(els.fileInput.files);
  els.fileInput.value = '';   // permet de re-sélectionner les mêmes fichiers
});

document.querySelectorAll('[data-mode]').forEach((b) => b.addEventListener('click', () => {
  const was = state.mode;
  state.mode = b.dataset.mode;
  // Remplir ↔ Polaroïd n'ont pas la même zone photo : le cadrage est refait.
  if ((was === 'polaroid') !== (state.mode === 'polaroid') && state.bitmap) {
    state.zoom = 1;
    clampView();
  }
  updateUi();
  draw();
}));

document.querySelectorAll('[data-bg]').forEach((b) => b.addEventListener('click', () => {
  state.bg = b.dataset.bg;
  updateUi();
  draw();
}));

document.querySelectorAll('[data-font]').forEach((b) => b.addEventListener('click', () => {
  state.font = b.dataset.font;
  updateUi();
  draw();
}));

els.orientBtn.addEventListener('click', () => {
  state.landscape = !state.landscape;
  resetView();
  updateUi();
  layoutPreview();
});

els.rotateBtn.addEventListener('click', async () => {
  const item = queue.items[queue.index];
  if (!state.bitmap || !item) return;
  els.rotateBtn.disabled = true;
  try {
    // On garde l'image courante (rotateBitmap libère son entrée) : copie d'abord.
    const copy = await createImageBitmap(state.bitmap);
    await setBitmap(await rotateBitmap(copy, 1));
    item.rotation = (item.rotation + 1) % 4;
    state.landscape = state.bitmap.width >= state.bitmap.height;
    resetView();
    updateUi();
    layoutPreview();
  } catch (e) {
    console.error(e);
    setStatus('Impossible de pivoter la photo.');
  } finally {
    els.rotateBtn.disabled = false;
  }
});

els.zoom.addEventListener('input', () => {
  // Le curseur zoome autour du centre de l'aperçu.
  zoomAt(parseFloat(els.zoom.value), previewCss.w / 2, previewCss.h / 2);
});

function recenter() {
  if (!state.bitmap) return;
  resetView();
  updateUi();
  draw();
}
els.recenterBtn.addEventListener('click', recenter);

els.guide.addEventListener('change', () => {
  state.guide = els.guide.checked;
  draw();
});

// Retouches
for (const k of ['brightness', 'contrast', 'saturation']) {
  els[k].addEventListener('input', () => {
    state.adjust[k] = parseInt(els[k].value, 10);
    updateUi();
    draw();
  });
}
els.printBoostBtn.addEventListener('click', () => {
  state.adjust = { ...PRINT_BOOST };
  updateUi();
  draw();
});
els.adjustResetBtn.addEventListener('click', () => {
  state.adjust = { brightness: 0, contrast: 0, saturation: 0 };
  updateUi();
  draw();
});

// Légende
els.captionText.addEventListener('input', () => {
  state.caption = els.captionText.value;
  els.textHint.textContent = state.caption.trim() ? '• 1 légende' : '';
  draw();
});
els.dateBtn.addEventListener('click', () => {
  const item = queue.items[queue.index];
  if (!item) return;
  // Date EXIF de prise de vue, sinon date du fichier.
  const d = item.date || (item.file.lastModified ? new Date(item.file.lastModified) : new Date());
  const txt = d.toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' });
  const cur = els.captionText.value.trim();
  els.captionText.value = cur ? `${cur} · ${txt}` : txt;
  els.captionText.dispatchEvent(new Event('input'));
  if (!item.date) setStatus('Pas de date de prise de vue dans la photo : date du fichier utilisée.');
});

new ResizeObserver(() => layoutPreview()).observe(els.stage);

// ---------------------------------------------------------------------------
// Déplacement et zoom (souris, tactile, molette, clavier)
// ---------------------------------------------------------------------------

/** Zoom courant (celui du mode affiché). */
const currentZoom = () => (isFit() ? state.fitZoom : state.zoom);

/**
 * Change le zoom en gardant fixe le point situé sous (px, py),
 * coordonnées CSS relatives à l'aperçu.
 */
function zoomAt(newZoom, px, py) {
  if (!state.bitmap) return;
  if (isFit()) {
    const old = state.fitZoom;
    state.fitZoom = Math.min(FIT_MAX_ZOOM, Math.max(FIT_MIN_ZOOM, newZoom));
    const k = state.fitZoom / old;
    const fx = px / previewCss.w;
    const fy = py / previewCss.h;
    state.fitX = fx - (fx - (0.5 + state.fitX)) * k - 0.5;
    state.fitY = fy - (fy - (0.5 + state.fitY)) * k - 0.5;
  } else {
    const r = photoRect(previewCss.w, previewCss.h);
    const [vw, vh] = viewSize();
    const fx = (px - r.x) / r.w;
    const fy = (py - r.y) / r.h;
    // Point de la photo sous le curseur.
    const ix = state.cx - vw / 2 + fx * vw;
    const iy = state.cy - vh / 2 + fy * vh;
    state.zoom = Math.min(MAX_ZOOM, Math.max(1, newZoom));
    const [nvw, nvh] = viewSize();
    state.cx = ix - (fx - 0.5) * nvw;
    state.cy = iy - (fy - 0.5) * nvh;
  }
  clampView();
  els.zoom.value = String(currentZoom());
  draw();
}

/** Déplace la photo d'un delta exprimé en pixels CSS de l'aperçu. */
function panBy(dx, dy) {
  if (!state.bitmap) return;
  if (isFit()) {
    state.fitX += dx / previewCss.w;
    state.fitY += dy / previewCss.h;
  } else {
    const [vw] = viewSize();
    const k = vw / photoRect(previewCss.w, previewCss.h).w;   // pixels photo par pixel CSS
    state.cx -= dx * k;
    state.cy -= dy * k;
  }
  clampView();
  draw();
}

const pointers = new Map();   // pointerId -> {x, y}
let pinch = null;             // {dist, midX, midY} pendant un pinch
let lastTap = { t: 0, x: 0, y: 0 };   // pour détecter le double-tap

function localPoint(e) {
  const r = els.preview.getBoundingClientRect();
  return { x: e.clientX - r.left, y: e.clientY - r.top };
}

function pinchInfo() {
  const [a, b] = [...pointers.values()];
  return {
    dist: Math.hypot(a.x - b.x, a.y - b.y) || 1,
    midX: (a.x + b.x) / 2,
    midY: (a.y + b.y) / 2,
  };
}

els.preview.addEventListener('pointerdown', (e) => {
  const p = localPoint(e);

  // Double-tap / double-clic (même endroit, < 300 ms) : recentrer.
  // Fait main car le dblclick n'est pas fiable au doigt avec touch-action: none.
  if (pointers.size === 0) {
    const now = performance.now();
    if (now - lastTap.t < 300 && Math.hypot(p.x - lastTap.x, p.y - lastTap.y) < 30) {
      lastTap.t = 0;
      recenter();
      return;
    }
    lastTap = { t: now, x: p.x, y: p.y };
  }

  els.preview.setPointerCapture(e.pointerId);
  pointers.set(e.pointerId, p);
  if (pointers.size === 2) pinch = pinchInfo();
  els.preview.classList.add('dragging');
});

els.preview.addEventListener('pointermove', (e) => {
  if (!pointers.has(e.pointerId)) return;
  const prev = pointers.get(e.pointerId);
  const p = localPoint(e);
  pointers.set(e.pointerId, p);

  if (pointers.size === 1) {
    panBy(p.x - prev.x, p.y - prev.y);
  } else if (pointers.size === 2 && pinch) {
    // Pinch : zoom autour du milieu des deux doigts + déplacement du milieu.
    const now = pinchInfo();
    zoomAt(currentZoom() * now.dist / pinch.dist, now.midX, now.midY);
    panBy(now.midX - pinch.midX, now.midY - pinch.midY);
    pinch = now;
  }
});

function endPointer(e) {
  pointers.delete(e.pointerId);
  pinch = pointers.size === 2 ? pinchInfo() : null;
  if (pointers.size === 0) els.preview.classList.remove('dragging');
}
els.preview.addEventListener('pointerup', endPointer);
els.preview.addEventListener('pointercancel', endPointer);

els.preview.addEventListener('wheel', (e) => {
  e.preventDefault();
  const p = localPoint(e);
  zoomAt(currentZoom() * Math.exp(-e.deltaY * 0.0015), p.x, p.y);
}, { passive: false });

/*
 * Clavier (desktop) : flèches = déplacer (Maj = plus vite), + / − = zoom,
 * 0 = recentrer, Page préc. / Page suiv. = photo précédente / suivante.
 * Ignoré pendant la saisie d'une légende ou le réglage d'un curseur.
 */
document.addEventListener('keydown', (e) => {
  if (!state.bitmap || e.ctrlKey || e.metaKey || e.altKey) return;
  const t = e.target;
  if (t.matches && t.matches('input, select, textarea')) return;
  const step = e.shiftKey ? 50 : 10;
  const c = [previewCss.w / 2, previewCss.h / 2];
  const actions = {
    ArrowLeft: () => panBy(step, 0),    // la photo suit la flèche… inversée : on « regarde » à gauche
    ArrowRight: () => panBy(-step, 0),
    ArrowUp: () => panBy(0, step),
    ArrowDown: () => panBy(0, -step),
    '+': () => zoomAt(currentZoom() * 1.1, ...c),
    '=': () => zoomAt(currentZoom() * 1.1, ...c),
    '-': () => zoomAt(currentZoom() / 1.1, ...c),
    '0': recenter,
    PageUp: () => showItem(queue.index - 1),
    PageDown: () => showItem(queue.index + 1),
  };
  const fn = actions[e.key];
  if (!fn) return;
  e.preventDefault();
  fn();
});

// ---------------------------------------------------------------------------
// Glisser-déposer (desktop)
// ---------------------------------------------------------------------------

let dragDepth = 0;
window.addEventListener('dragenter', (e) => {
  if (![...e.dataTransfer.types].includes('Files')) return;
  dragDepth++;
  els.dropOverlay.hidden = false;
});
window.addEventListener('dragleave', () => {
  dragDepth = Math.max(0, dragDepth - 1);
  if (dragDepth === 0) els.dropOverlay.hidden = true;
});
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => {
  e.preventDefault();
  dragDepth = 0;
  els.dropOverlay.hidden = true;
  addFiles(e.dataTransfer.files);
});

// ---------------------------------------------------------------------------
// Export JPEG
// ---------------------------------------------------------------------------

/** Rend la carte en pleine résolution et renvoie un Blob JPEG à 300 dpi. */
async function exportJpeg() {
  const [w, h] = outputSize();
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  renderCard(ctx, w, h, true);   // sans le guide de sécurité
  const blob = await new Promise((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Échec de l\'encodage JPEG'))),
      'image/jpeg', JPEG_QUALITY);
  });
  return setJpegDpi(blob, DPI);
}

/**
 * Le canvas écrit un en-tête JFIF sans résolution utile : on y inscrit 300 dpi
 * pour que les logiciels d'impression connaissent la taille physique du papier.
 */
async function setJpegDpi(blob, dpi) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const isJfif = bytes[0] === 0xFF && bytes[1] === 0xD8 && bytes[2] === 0xFF && bytes[3] === 0xE0 &&
    String.fromCharCode(...bytes.subarray(6, 11)) === 'JFIF\0';
  if (isJfif) {
    bytes[13] = 1;                 // unités : points par pouce
    bytes[14] = dpi >> 8; bytes[15] = dpi & 0xFF;   // densité X
    bytes[16] = dpi >> 8; bytes[17] = dpi & 0xFF;   // densité Y
  }
  return new Blob([bytes], { type: 'image/jpeg' });
}

/*
 * Pré-export : le JPEG est calculé en arrière-plan dès que le cadrage ne bouge
 * plus. « Partager » est alors instantané, ce qui compte : Chrome n'autorise
 * navigator.share() que quelques secondes après le toucher de l'utilisateur.
 */
let exportCache = null;   // { key, promise }
let prerenderTimer = 0;

function exportKey() {
  const { serial, format, mode, bg, landscape, zoom, cx, cy, fitZoom, fitX, fitY, font, caption, adjust } = state;
  return JSON.stringify([serial, format, mode, bg, landscape, zoom, cx, cy, fitZoom, fitX, fitY, font, caption, adjust]);
}

/** JPEG du cadrage actuel (réutilise le pré-export s'il est à jour). */
function getExport() {
  const key = exportKey();
  if (!exportCache || exportCache.key !== key) {
    const entry = { key, promise: exportJpeg() };
    entry.promise.catch(() => { if (exportCache === entry) exportCache = null; });
    exportCache = entry;
  }
  return exportCache.promise;
}

function schedulePrerender() {
  clearTimeout(prerenderTimer);
  prerenderTimer = setTimeout(() => { if (state.bitmap) getExport().catch(() => {}); }, 600);
}

/**
 * Nom de fichier (heure locale) : selphy_AAAAMMJJ_HHMMSS.jpg pour la carte postale,
 * selphy_carte_… ou selphy_carre_… pour les autres formats (faciles à trier sur la clé).
 * Un suffixe évite que deux exports dans la même seconde portent le même nom.
 */
let lastName = '';
let sameSecond = 0;
function fileName(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  const base = `${FORMATS[state.format].file}_${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_` +
    `${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  sameSecond = base === lastName ? sameSecond + 1 : 0;
  lastName = base;
  return sameSecond ? `${base}_${sameSecond + 1}.jpg` : `${base}.jpg`;
}

function markExported() {
  const item = queue.items[queue.index];
  if (item) item.exported = true;
  updateNav();
}

els.downloadBtn.addEventListener('click', async () => {
  if (!state.bitmap) return;
  try {
    const blob = await getExport();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = fileName();
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
    markExported();
    setStatus(`Enregistré : ${a.download} (dossier Téléchargements, album « Download » de la galerie)`);
  } catch (e) {
    console.error(e);
    setStatus('Erreur pendant l\'export.');
  }
});

// Partage de fichier via Web Share API, si le navigateur le permet. Sur Android,
// la feuille de partage propose aussi « Importer dans Photos » (galerie).
const probeFile = new File([new Uint8Array(1)], 'probe.jpg', { type: 'image/jpeg' });
if (navigator.canShare && navigator.canShare({ files: [probeFile] })) {
  els.shareBtn.hidden = false;
}

// Les navigateurs intégrés aux applis (WebView Android « ; wv) », Facebook,
// Instagram…) ne savent ni partager ni télécharger correctement : on le signale.
if (/; wv\)|FBAN|FBAV|Instagram|Line\/|MicroMessenger|Snapchat/.test(navigator.userAgent)) {
  $('browserHint').hidden = false;
}

els.shareBtn.addEventListener('click', async () => {
  if (!state.bitmap) return;
  try {
    const blob = await getExport();
    const file = new File([blob], fileName(), { type: 'image/jpeg' });
    await navigator.share({ files: [file], title: `${FORMATS[state.format].name} SELPHY` });
    markExported();
    setStatus('Partagé.');
  } catch (e) {
    if (e.name !== 'AbortError') {
      console.error(e);
      setStatus('Le partage a échoué.');
    }
  }
});

// ---------------------------------------------------------------------------
// PWA : service worker, mises à jour, installation, Web Share Target
// ---------------------------------------------------------------------------

if ('serviceWorker' in navigator) {
  // Une page déjà contrôlée qui change de contrôleur = nouvelle version installée.
  const hadController = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (hadController) els.updateBanner.hidden = false;
  });
  navigator.serviceWorker.register('./sw.js').then((reg) => {
    // Vérifie s'il existe une nouvelle version à chaque retour sur l'appli.
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') reg.update().catch(() => {});
    });
  }).catch((e) => console.warn('SW non enregistré', e));
}
els.reloadBtn.addEventListener('click', () => location.reload());

// Bouton « Installer » (Chrome desktop / Android) quand l'appli est installable.
let installEvent = null;
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  installEvent = e;
  els.installBtn.hidden = false;
});
els.installBtn.addEventListener('click', async () => {
  if (!installEvent) return;
  installEvent.prompt();
  await installEvent.userChoice;
  installEvent = null;
  els.installBtn.hidden = true;
});
window.addEventListener('appinstalled', () => { els.installBtn.hidden = true; });

/**
 * « Partager → Selphy Postcard » depuis la galerie : le service worker reçoit les
 * fichiers (POST share-target), les range dans le cache puis redirige vers ?shared=1.
 */
async function loadSharedPhotos() {
  const params = new URLSearchParams(location.search);
  if (!params.has('shared')) return;
  history.replaceState(null, '', location.pathname);   // URL propre
  try {
    const cache = await caches.open(SHARE_CACHE);
    const keys = (await cache.keys())
      .filter((req) => new URL(req.url).pathname.includes('__shared-photo-'))
      .sort((a, b) => parseInt(a.url.split('-').pop(), 10) - parseInt(b.url.split('-').pop(), 10));
    const files = [];
    for (const req of keys) {
      const res = await cache.match(req);
      const blob = await res.blob();
      files.push(new File([blob], decodeURIComponent(res.headers.get('X-Filename') || 'photo'),
        { type: blob.type, lastModified: Number(res.headers.get('X-Last-Modified')) || Date.now() }));
      await cache.delete(req);
    }
    if (!files.length) { setStatus('Aucune photo partagée reçue.'); return; }
    await addFiles(files);
  } catch (e) {
    console.error(e);
    setStatus('Impossible de récupérer les photos partagées.');
  }
}

updateUi();
loadSharedPhotos();
