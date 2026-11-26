/** Derived author-name folds. Not a separately maintained synonym catalog. */

export function foldAuthorToken(value: string): string {
  return value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[.\u00b7\u2022]/gu, "")
    .replace(/[-_\s:]+/gu, "")
    .trim();
}

function keepFold(original: string, fold: string): boolean {
  if (!fold) return false;
  if (/\p{Script=Han}/u.test(original)) return fold.length >= 2;
  if (original.includes(":")) return fold.length >= 2;
  const tokens = original.trim().split(/[\s.\-_]+/u).filter(Boolean);
  if (tokens.length <= 1) return false;
  return fold.length >= 2;
}

export function authorFoldKeys(raw: string): string[] {
  const trimmed = raw.trim();
  if (!trimmed) return [];
  const keys = new Set<string>();
  if (trimmed.includes(":")) {
    keys.add(trimmed.toLowerCase());
    const compact = foldAuthorToken(trimmed);
    if (compact) keys.add(compact);
    return [...keys];
  }
  const compact = foldAuthorToken(trimmed);
  if (keepFold(trimmed, compact)) keys.add(compact);
  const tokens = trimmed.split(/[\s.\-_]+/u).filter(Boolean);
  if (tokens.length >= 2 && !/\p{Script=Han}/u.test(trimmed)) {
    const familyFirst = [tokens[tokens.length - 1], ...tokens.slice(0, -1)].join(" ");
    const familyFold = foldAuthorToken(familyFirst);
    if (keepFold(familyFirst, familyFold)) keys.add(familyFold);
    const reversed = [...tokens].reverse().join(" ");
    const reversedFold = foldAuthorToken(reversed);
    if (keepFold(reversed, reversedFold)) keys.add(reversedFold);
  }
  return [...keys];
}

export function keywordTokens(raw: string): string[] {
  const trimmed = raw.trim();
  if (!trimmed) return [];
  if (/[/,]/u.test(trimmed)) {
    return trimmed.split(/[/,]+/u).map((part) => part.trim()).filter(Boolean);
  }
  return trimmed.split(/\s+/u).filter(Boolean);
}

export function parseKeywordMatch(raw: string): string {
  const tokens = keywordTokens(raw);
  if (tokens.length === 0) return "";
  const escape = (token: string) => `"${token.replaceAll("\"", "\"\"")}"`;
  return tokens.map(escape).join(/[/,]/u.test(raw) ? " OR " : " AND ");
}
