# Selphy Postcard

Petite PWA qui prépare n'importe quelle photo au format **carte postale** de la
**Canon SELPHY CP1500** (papier RP-108, 100 × 148 mm), pour une impression
**sans bordure blanche**.

L'appli produit un JPEG de **1748 × 1181 px** (paysage) ou **1181 × 1748 px**
(portrait), soit exactement 148 × 100 mm à 300 dpi. L'impression se fait ensuite
hors de l'appli (clé USB / carte SD, ou partage vers l'appli SELPHY).

- 100 % côté client : aucune requête réseau, aucune dépendance, aucun build.
- Fonctionne hors ligne une fois installée.
- Android (Chrome) en priorité, fonctionne aussi sur desktop.

## Fonctionnalités

| | |
|---|---|
| **Import** | bouton « Choisir une photo », glisser-déposer (desktop), ou **Partager → Selphy Postcard** depuis la galerie Android (Web Share Target). |
| **Orientation** | choisie automatiquement selon la photo (orientation EXIF respectée) ; bouton ▭ / ▯ pour basculer paysage / portrait, bouton ⟳ pour pivoter de 90° une photo mal orientée. |
| **Remplir** | la photo couvre toute la carte. Déplacez au doigt / à la souris, zoomez par pincement, molette ou curseur. Le zoom ne descend jamais sous la couverture minimale : pas de bord blanc possible. **Double-tap** ou bouton « Recentrer » pour revenir au cadrage initial. |
| **Qualité** | badge en haut à droite : résolution réelle à l'impression (300 dpi = maximum de la SELPHY). Il passe en orange sous 200 dpi (photo trop petite ou trop zoomée : risque de flou). |
| **Ajuster** | photo entière visible ; le fond est la même photo agrandie et floutée, ou blanc, ou noir. |
| **Zone de sécurité** | guide en pointillés : ~2 mm sur chaque bord sont rognés en impression sans bordure. Évitez d'y placer du texte ou des visages. Le guide n'apparaît pas dans l'export. |
| **Export** | JPEG qualité 0,95, 300 dpi, nommé `selphy_AAAAMMJJ_HHMMSS.jpg`. Boutons **Télécharger** et **Partager** (si le navigateur sait partager des fichiers). |
| **Photo suivante** | rouvre le sélecteur pour enchaîner les photos (mode et fond sont conservés). |
| **Retirer la photo** | ferme la photo et revient à l'accueil. La photo d'origine n'est jamais modifiée ni supprimée : l'appli ne fait que la lire, et chaque export est un nouveau fichier. |
| **Écran horizontal** | sur téléphone tourné, tablette ou desktop, les contrôles passent dans une colonne à droite de l'aperçu. |

### Performances

- Les photos de plus de 5244 px (3 × la sortie) sont réduites au chargement :
  au-delà, les pixels n'apportent rien à l'impression mais saturent la mémoire
  des téléphones. Le pic de mémoire au décodage reste celui de la photo d'origine.
- L'aperçu utilise une copie allégée (2048 px) tant qu'elle est assez nette pour
  le zoom en cours ; l'export utilise toujours la photo complète.
- Le JPEG est pré-calculé en arrière-plan dès que le cadrage ne bouge plus :
  « Partager » répond immédiatement (Chrome n'autorise le partage que quelques
  secondes après le toucher).

## Fichiers

```
index.html             page unique (CSP stricte)
style.css              styles mobile-first
app.js                 toute la logique (rendu, recadrage, export, PWA)
sw.js                  service worker : cache hors ligne + réception des partages
manifest.webmanifest   manifeste PWA (icônes, share_target)
icons/                 icônes PNG 192/512, normales et maskable
tools/make-icons.mjs   régénère les icônes (node tools/make-icons.mjs)
tests/                 test de bout en bout Playwright (facultatif)
```

## Tester en local

Un service worker exige `http://localhost` ou HTTPS : ouvrir `index.html`
directement (file://) ne suffit pas.

```bash
python -m http.server 8000
```

Puis ouvrir <http://localhost:8000>.

Pour tester depuis un téléphone sur le même réseau Wi-Fi, il faut du HTTPS
(le service worker et le partage ne fonctionnent pas en HTTP sur une IP locale).
Le plus simple : déployer sur GitHub Pages (ci-dessous), ou utiliser le
débogage USB de Chrome avec la redirection de port
(`chrome://inspect` → *Port forwarding* 8000 → `localhost:8000`).

### Tests automatisés (Playwright)

```bash
cd tests
npm install
npx playwright install chromium
npm test
```

Le test charge une photo 4:3 (1600 × 1200) et vérifie : export en mode
Remplir puis Ajuster (flou, blanc, noir) en **exactement 1748 × 1181 px à 300 dpi**,
le contenu des pixels (recadrage / bandes de fond), le zoom minimal, l'indicateur
de résolution, le double-clic « Recentrer », la bascule portrait (1181 × 1748),
la rotation 90°, le bouton « Retirer », la mise en page d'un téléphone à
l'horizontale, la réduction d'une photo de 37 Mpx, le Web Share Target, le
fonctionnement hors ligne et l'absence d'erreur console. Les JPEG produits sont gardés dans `tests/output/`.

Pour tester la version en ligne plutôt que les fichiers locaux :

```bash
SELPHY_URL=https://<utilisateur>.github.io/<dépôt>/ npm test
```

## Déployer sur GitHub Pages

1. Pousser ce dépôt sur GitHub (les fichiers de l'appli à la racine).
2. *Settings → Pages* → *Source : Deploy from a branch* → branche `main`, dossier `/ (root)`.
3. L'appli est servie sur `https://<utilisateur>.github.io/<dépôt>/`.

Tous les chemins sont relatifs : l'appli fonctionne dans ce sous-dossier sans
modification. Le dossier `tests/` est publié aussi mais n'est jamais chargé par
l'appli (on peut l'ignorer).

**Mise à jour :** le service worker sert les fichiers depuis son cache. Après
chaque modification, incrémentez `VERSION` dans `sw.js` (`'v1'` → `'v2'`…),
sinon les appareils déjà installés garderont l'ancienne version. La nouvelle
version s'applique au lancement suivant de l'appli.

## Installer sur Android

1. Ouvrir l'URL GitHub Pages dans **Chrome**.
2. Menu ⋮ → **Ajouter à l'écran d'accueil** → **Installer** (ou le bouton
   « Installer » en haut de l'appli, s'il apparaît).
3. L'appli apparaît dans le tiroir d'applications et dans la feuille de
   **Partager** : depuis Google Photos / la galerie, *Partager → Selphy Postcard*
   ouvre directement la photo dans l'appli.

Sur desktop (Chrome / Edge) : icône d'installation dans la barre d'adresse.

> Les photos HEIC (iPhone, certains Android) ne sont pas toujours lisibles par
> le navigateur. Le cas échéant, exportez-les en JPEG depuis la galerie.

## Imprimer sur la SELPHY CP1500

Le JPEG a déjà le ratio exact du papier : l'imprimante n'a ni à le recadrer ni à
ajouter de marge blanche.

### Par clé USB ou carte SD

1. Copier les fichiers `selphy_*.jpg` sur une clé USB ou une carte SD.
2. L'insérer dans la SELPHY, choisir la photo.
3. Dans les paramètres d'impression, régler **Bordures : Sans** (impression
   sans bordure). Laisser le recadrage / la mise en page par défaut
   (1 photo par feuille), sans date.
4. Imprimer. Les ~2 mm de chaque bord sont rognés — c'est le rôle du guide
   « Zone de sécurité ».

### Par l'appli SELPHY Photo Layout (Wi-Fi)

1. Dans Selphy Postcard, toucher **Partager** et choisir **SELPHY Photo Layout**
   (ou **Télécharger**, puis ouvrir la photo depuis SELPHY Photo Layout).
2. Dans SELPHY Photo Layout, choisir le format **Carte postale** et l'impression
   **sans bordure**, vérifier que la photo n'est pas recadrée différemment, puis imprimer.

## Confidentialité

Les photos ne quittent jamais l'appareil : pas de serveur, pas d'analytics, et la
politique de sécurité du contenu (`connect-src 'none'`) interdit toute requête
réseau depuis la page. Une photo reçue par « Partager » transite seulement par
le cache local du navigateur et en est effacée dès son ouverture.
# SelphyPostcard
