/**
 * Self-hosted webfonts for the INVITE pages (both design packs): the base set
 * plus every face the typography options (0048) can ask for — true 700s and
 * italics for both families, so a bold/italic pick renders a real face, never
 * faux synthesis. Declarations are cheap (browsers fetch a WOFF2 only when
 * rendered text matches it); an un-customised invite downloads the same faces
 * it always has.
 */
import "./fonts-base";
import "@fontsource/cormorant-garamond/latin-700.css";
import "@fontsource/cormorant-garamond/latin-700-italic.css";
import "@fontsource/cormorant-garamond/latin-ext-700.css";
import "@fontsource/cormorant-garamond/latin-ext-700-italic.css";
import "@fontsource/lato/latin-300-italic.css";
import "@fontsource/lato/latin-400-italic.css";
import "@fontsource/lato/latin-700.css";
import "@fontsource/lato/latin-700-italic.css";
import "@fontsource/lato/latin-ext-300-italic.css";
import "@fontsource/lato/latin-ext-400-italic.css";
import "@fontsource/lato/latin-ext-700.css";
import "@fontsource/lato/latin-ext-700-italic.css";
