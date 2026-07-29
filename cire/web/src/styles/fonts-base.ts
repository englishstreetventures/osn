/**
 * Self-hosted webfonts (C-L33): the faces every NON-invite page uses — the
 * legal pages and the 404 document. Fontsource ships the WOFF2 files + the
 * `@font-face` CSS (per-script `unicode-range` subsets, `font-display: swap`),
 * and Vite emits them as hashed same-origin `/_astro/*` assets — so no guest
 * request ever reaches fonts.googleapis.com / fonts.gstatic.com.
 *
 * Latin + latin-ext only: the scripts the replaced Google stylesheet actually
 * served for this site's content. The face set mirrors the old `css2?family=`
 * URL (Cormorant Garamond 300/400/600 + italic 300/400, Lato 300/400); the
 * invite packs layer the typography-option faces on top in `fonts-invite.ts`.
 */
import "@fontsource/cormorant-garamond/latin-300.css";
import "@fontsource/cormorant-garamond/latin-300-italic.css";
import "@fontsource/cormorant-garamond/latin-400.css";
import "@fontsource/cormorant-garamond/latin-400-italic.css";
import "@fontsource/cormorant-garamond/latin-600.css";
import "@fontsource/cormorant-garamond/latin-ext-300.css";
import "@fontsource/cormorant-garamond/latin-ext-300-italic.css";
import "@fontsource/cormorant-garamond/latin-ext-400.css";
import "@fontsource/cormorant-garamond/latin-ext-400-italic.css";
import "@fontsource/cormorant-garamond/latin-ext-600.css";
import "@fontsource/lato/latin-300.css";
import "@fontsource/lato/latin-400.css";
import "@fontsource/lato/latin-ext-300.css";
import "@fontsource/lato/latin-ext-400.css";
