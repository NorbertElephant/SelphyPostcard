/* Selphy Postcard — prépare une photo au format carte postale Canon SELPHY CP1500
 * (papier RP-108 : 100 × 148 mm). Sortie : JPEG 1748 × 1181 px (ou 1181 × 1748) à 300 dpi.
 *
 * Tout se passe dans le navigateur : aucune requête réseau.
 */
'use strict';

// ---------------------------------------------------------------------------
// Constantes
// ---------------------------------------------------------------------------

const OUT_LONG = 1748;          // 148 mm à 300 dpi
const OUT_SHORT = 1181;         // 100 mm à 300 dpi
const PAPER_LONG_MM = 148;
const PAPER_SHORT_MM = 100;
const SAFE_MM = 2;              // marge rognée en impression sans bordure
const MAX_ZOOM = 5;
const JPEG_QUALITY = 0.95;
const SHARE_CACHE = 'selphy-share';
const SHARE_KEY = './__shared-photo';

// ---------------------------------------------------------------------------
// État de l'appli
// ---------------------------------------------------------------------------

const state = {
  bitmap: null,       // ImageBitmap de la photo (orientation EXIF appliquée)
  landscape: true,    // orientation de la carte
  mode: 'fill',       // 'fill' (Remplir) | 'fit' (Ajuster)
  bg: 'blur',         // fond en mode Ajuster : 'blur' | 'white' | 'black'
  zoom: 1,            // 1 = couverture minimale
  cx: 0, cy: 0,       // centre de la zone visible, en pixels de la photo
  guide: true,        // affiche la zone de sécurité dans l'aperçu
};

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
  zoom: $('zoom'),
  zoomRow: $('zoomRow'),
  bgRow: $('bgRow'),
  guide: $('guide'),
  downloadBtn: $('downloadBtn'),
  shareBtn: $('shareBtn'),
  nextBtn: $('nextBtn'),
  installBtn: $('installBtn'),
  formatLabel: $('formatLabel'),
  status: $('status'),
};
const pctx = els.preview.getContext('2d');

// ---------------------------------------------------------------------------
// Géométrie
// ---------------------------------------------------------------------------

/** Dimensions de sortie selon l'orientation. */
function outputSize() {
  return state.landscape ? [OUT_LONG, OUT_SHORT] : [OUT_SHORT, OUT_LONG];
}

/** Ratio largeur / hauteur de la carte. */
function cardRatio() {
  const [w, h] = outputSize();
  return w / h;
}

/**
 * Taille (en pixels de la photo) de la zone visible en mode Remplir.
 * À zoom 1, c'est le plus grand rectangle au ratio de la carte contenu dans la photo.
 */
function viewSize(zoom = state.zoom) {
  const { width: iw, height: ih } = state.bitmap;
  const r = cardRatio();
  let vw, vh;
  if (iw / ih > r) { vh = ih; vw = ih * r; } else { vw = iw; vh = iw / r; }
  return [vw / zoom, vh / zoom];
}

/** Garde le zoom dans [1, MAX_ZOOM] et la zone visible à l'intérieur de la photo. */
function clampView() {
  state.zoom = Math.min(MAX_ZOOM, Math.max(1, state.zoom));
  const { width: iw, height: ih } = state.bitmap;
  const [vw, vh] = viewSize();
  state.cx = Math.min(iw - vw / 2, Math.max(vw / 2, state.cx));
  state.cy = Math.min(ih - vh / 2, Math.max(vh / 2, state.cy));
}

/** Recentre la photo et remet le zoom à la couverture minimale. */
function resetView() {
  state.zoom = 1;
  state.cx = state.bitmap.width / 2;
  state.cy = state.bitmap.height / 2;
  clampView();
}

// ---------------------------------------------------------------------------
// Rendu (commun à l'aperçu et à l'export)
// ---------------------------------------------------------------------------

/** Dessine la carte sur ctx, à la taille w × h (même ratio que la carte). */
function renderCard(ctx, w, h) {
  const bmp = state.bitmap;
  ctx.save();
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';

  if (state.mode === 'fill') {
    // Remplir : on découpe la zone visible de la photo et on l'étire sur toute la carte.
    const [vw, vh] = viewSize();
    ctx.drawImage(bmp, state.cx - vw / 2, state.cy - vh / 2, vw, vh, 0, 0, w, h);
  } else {
    // Ajuster : fond, puis photo entière centrée.
    drawBackground(ctx, w, h);
    const s = Math.min(w / bmp.width, h / bmp.height);
    const dw = bmp.width * s;
    const dh = bmp.height * s;
    ctx.drawImage(bmp, (w - dw) / 2, (h - dh) / 2, dw, dh);
  }
  ctx.restore();
}

/** Fond du mode Ajuster : couleur unie ou photo agrandie et floutée. */
function drawBackground(ctx, w, h) {
  if (state.bg !== 'blur') {
    ctx.fillStyle = state.bg === 'white' ? '#ffffff' : '#000000';
    ctx.fillRect(0, 0, w, h);
    return;
  }
  const bmp = state.bitmap;
  // Photo en mode « couverture », légèrement agrandie pour masquer les bords
  // transparents produits par le flou.
  const s = Math.max(w / bmp.width, h / bmp.height) * 1.15;
  const dw = bmp.width * s;
  const dh = bmp.height * s;
  const dx = (w - dw) / 2;
  const dy = (h - dh) / 2;
  const radius = Math.max(w, h) * 0.03;

  if ('filter' in ctx) {
    ctx.filter = `blur(${radius}px)`;
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

/** Pointillés indiquant la zone qui sera rognée à l'impression sans bordure. */
function drawSafeGuide(ctx, w, h) {
  const [longMm, shortMm] = [PAPER_LONG_MM, PAPER_SHORT_MM];
  const mx = w * SAFE_MM / (state.landscape ? longMm : shortMm);
  const my = h * SAFE_MM / (state.landscape ? shortMm : longMm);
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
  const r = cardRatio();
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
    renderCard(pctx, w, h);
    if (state.guide) drawSafeGuide(pctx, w, h);
  });
}

// ---------------------------------------------------------------------------
// Chargement d'une photo
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

async function loadFile(file) {
  if (!file) return;
  if (file.type && !file.type.startsWith('image/')) {
    setStatus('Ce fichier n\'est pas une image.');
    return;
  }
  setStatus('Chargement…');
  let bmp;
  try {
    bmp = await decodeImage(file);
  } catch (e) {
    console.error(e);
    setStatus('Impossible de lire cette image (format non pris en charge par le navigateur ?).');
    return;
  }
  if (state.bitmap) state.bitmap.close();
  state.bitmap = bmp;
  // Orientation automatique : paysage si la photo est plus large que haute.
  state.landscape = bmp.width >= bmp.height;
  resetView();

  els.empty.hidden = true;
  els.preview.hidden = false;
  els.controls.hidden = false;
  updateUi();
  layoutPreview();
  setStatus(`Photo ${bmp.width} × ${bmp.height} px`);
}

function setStatus(msg) {
  els.status.textContent = msg;
}

// ---------------------------------------------------------------------------
// Interface
// ---------------------------------------------------------------------------

/** Synchronise les contrôles avec l'état. */
function updateUi() {
  document.querySelectorAll('[data-mode]').forEach((b) => {
    b.setAttribute('aria-checked', String(b.dataset.mode === state.mode));
  });
  document.querySelectorAll('[data-bg]').forEach((b) => {
    b.setAttribute('aria-checked', String(b.dataset.bg === state.bg));
  });
  els.zoomRow.hidden = state.mode !== 'fill';
  els.bgRow.hidden = state.mode !== 'fit';
  els.zoom.value = String(state.zoom);
  els.orientBtn.textContent = state.landscape ? '↻ Paysage' : '↻ Portrait';
  els.formatLabel.textContent = state.landscape ? '148 × 100 mm' : '100 × 148 mm';
  els.preview.classList.toggle('static', state.mode !== 'fill');
}

els.pickBtn.addEventListener('click', () => els.fileInput.click());
els.nextBtn.addEventListener('click', () => els.fileInput.click());
els.fileInput.addEventListener('change', () => {
  loadFile(els.fileInput.files[0]);
  els.fileInput.value = '';   // permet de re-sélectionner le même fichier
});

document.querySelectorAll('[data-mode]').forEach((b) => b.addEventListener('click', () => {
  state.mode = b.dataset.mode;
  updateUi();
  draw();
}));

document.querySelectorAll('[data-bg]').forEach((b) => b.addEventListener('click', () => {
  state.bg = b.dataset.bg;
  updateUi();
  draw();
}));

els.orientBtn.addEventListener('click', () => {
  state.landscape = !state.landscape;
  resetView();
  updateUi();
  layoutPreview();
});

els.zoom.addEventListener('input', () => {
  // Le slider zoome autour du centre de l'aperçu.
  zoomAt(parseFloat(els.zoom.value), previewCss.w / 2, previewCss.h / 2);
});

els.guide.addEventListener('change', () => {
  state.guide = els.guide.checked;
  draw();
});

new ResizeObserver(() => layoutPreview()).observe(els.stage);

// ---------------------------------------------------------------------------
// Déplacement et zoom (souris, tactile, molette)
// ---------------------------------------------------------------------------

/**
 * Change le zoom en gardant fixe le point de la photo situé sous (px, py),
 * coordonnées CSS relatives à l'aperçu.
 */
function zoomAt(newZoom, px, py) {
  if (!state.bitmap) return;
  const [vw, vh] = viewSize();
  const fx = px / previewCss.w;
  const fy = py / previewCss.h;
  // Point de la photo sous le curseur.
  const ix = state.cx - vw / 2 + fx * vw;
  const iy = state.cy - vh / 2 + fy * vh;
  state.zoom = Math.min(MAX_ZOOM, Math.max(1, newZoom));
  const [nvw, nvh] = viewSize();
  state.cx = ix - (fx - 0.5) * nvw;
  state.cy = iy - (fy - 0.5) * nvh;
  clampView();
  els.zoom.value = String(state.zoom);
  draw();
}

/** Déplace la zone visible d'un delta exprimé en pixels CSS de l'aperçu. */
function panBy(dx, dy) {
  const [vw] = viewSize();
  const k = vw / previewCss.w;   // pixels photo par pixel CSS
  state.cx -= dx * k;
  state.cy -= dy * k;
  clampView();
  draw();
}

const pointers = new Map();   // pointerId -> {x, y}
let pinch = null;             // {dist, midX, midY} pendant un pinch

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
  if (state.mode !== 'fill') return;
  els.preview.setPointerCapture(e.pointerId);
  pointers.set(e.pointerId, localPoint(e));
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
    zoomAt(state.zoom * now.dist / pinch.dist, now.midX, now.midY);
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
  if (state.mode !== 'fill') return;
  e.preventDefault();
  const p = localPoint(e);
  zoomAt(state.zoom * Math.exp(-e.deltaY * 0.0015), p.x, p.y);
}, { passive: false });

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
  const file = [...e.dataTransfer.files].find((f) => f.type.startsWith('image/'));
  if (file) loadFile(file);
  else setStatus('Aucune image dans ce dépôt.');
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
  renderCard(ctx, w, h);   // sans le guide de sécurité
  const blob = await new Promise((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Échec de l\'encodage JPEG'))),
      'image/jpeg', JPEG_QUALITY);
  });
  return setJpegDpi(blob, 300);
}

/**
 * Le canvas écrit un en-tête JFIF sans résolution utile : on y inscrit 300 dpi
 * pour que les logiciels d'impression connaissent la taille physique (100 × 148 mm).
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

/** Nom de fichier : selphy_AAAAMMJJ_HHMMSS.jpg (heure locale). */
function fileName(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `selphy_${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_` +
    `${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}.jpg`;
}

els.downloadBtn.addEventListener('click', async () => {
  if (!state.bitmap) return;
  try {
    const blob = await exportJpeg();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = fileName();
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
    setStatus(`Enregistré : ${a.download}`);
  } catch (e) {
    console.error(e);
    setStatus('Erreur pendant l\'export.');
  }
});

// Partage de fichier via Web Share API, si le navigateur le permet.
const probeFile = new File([new Uint8Array(1)], 'probe.jpg', { type: 'image/jpeg' });
if (navigator.canShare && navigator.canShare({ files: [probeFile] })) {
  els.shareBtn.hidden = false;
}

els.shareBtn.addEventListener('click', async () => {
  if (!state.bitmap) return;
  try {
    const blob = await exportJpeg();
    const file = new File([blob], fileName(), { type: 'image/jpeg' });
    await navigator.share({ files: [file], title: 'Carte postale SELPHY' });
    setStatus('Partagé.');
  } catch (e) {
    if (e.name !== 'AbortError') {
      console.error(e);
      setStatus('Le partage a échoué.');
    }
  }
});

// ---------------------------------------------------------------------------
// PWA : service worker, installation, Web Share Target
// ---------------------------------------------------------------------------

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').catch((e) => console.warn('SW non enregistré', e));
}

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
 * « Partager → Selphy Postcard » depuis la galerie : le service worker reçoit le
 * fichier (POST share-target), le range dans le cache puis redirige vers ?shared=1.
 */
async function loadSharedPhoto() {
  const params = new URLSearchParams(location.search);
  if (!params.has('shared')) return;
  history.replaceState(null, '', location.pathname);   // URL propre
  try {
    const cache = await caches.open(SHARE_CACHE);
    const res = await cache.match(SHARE_KEY);
    if (!res) { setStatus('Aucune photo partagée reçue.'); return; }
    const blob = await res.blob();
    await cache.delete(SHARE_KEY);
    await loadFile(blob);
  } catch (e) {
    console.error(e);
    setStatus('Impossible de récupérer la photo partagée.');
  }
}

loadSharedPhoto();
