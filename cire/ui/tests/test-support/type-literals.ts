/**
 * Each `font-size` written as a literal whose own line, or the comment just
 * above it, does not say no type token matches: a literal left in must say
 * why it is not a token.
 */
export function unmarkedTypeSizes(css: string): string[] {
  const lines = css.split("\n");
  return lines.flatMap((line, i) => {
    const size = /^\s*font-size:\s*([^;]*);/.exec(line)?.[1];
    if (!size || size.startsWith("var(") || size === "inherit") return [];
    const above = lines.slice(Math.max(0, i - 3), i).join(" ");
    return /No type token/.test(above) ? [] : [line.trim()];
  });
}
