/**
 * Self-hosted webfonts (C-L33): the faces the login page uses. Fontsource
 * ships the WOFF2 files + `@font-face` CSS (`unicode-range` subsets,
 * `font-display: swap`); Vite emits them as hashed same-origin assets, so no
 * organiser request ever reaches fonts.googleapis.com / fonts.gstatic.com.
 * Latin + latin-ext, mirroring what the replaced Google stylesheet served.
 */
import "@fontsource/cormorant-garamond/latin-300.css";
import "@fontsource/cormorant-garamond/latin-400.css";
import "@fontsource/cormorant-garamond/latin-600.css";
import "@fontsource/cormorant-garamond/latin-ext-300.css";
import "@fontsource/cormorant-garamond/latin-ext-400.css";
import "@fontsource/cormorant-garamond/latin-ext-600.css";
import "@fontsource/lato/latin-300.css";
import "@fontsource/lato/latin-400.css";
import "@fontsource/lato/latin-ext-300.css";
import "@fontsource/lato/latin-ext-400.css";
