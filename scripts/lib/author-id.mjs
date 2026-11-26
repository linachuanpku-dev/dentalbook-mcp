/**
 * Offline Node copy of packages/center-service/src/author-id.ts.
 * Must stay in sync with author-id.ts — same mint/codebook behavior.
 *
 * Format: `{cc}.{university}.{hospital}.{discipline}.{local}`
 * Reserved: country `xx`, university `pending`, hospital `none`.
 * Never guess `cn` from a Chinese name.
 */

export const AUTHOR_ID_PATTERN = /^[a-z]{2}\.[a-z0-9-]{2,32}\.[a-z0-9-]{2,32}\.[a-z0-9-]{2,32}\.[a-z0-9-]{1,32}$/;

const COUNTRY_PATTERN = /^[a-z]{2}$/;
const CODE_PATTERN = /^[a-z0-9-]{2,32}$/;
const LOCAL_PATTERN = /^[a-z0-9-]{1,32}$/;

const PENDING_CODES = Object.freeze({
  countryCode: "xx",
  universityCode: "pending",
  hospitalCode: "none",
});

/** Hospital segment is set only for combined school+hospital orgs. Outpatient campuses stay `none`. */
const INSTITUTION_CODEBOOK = Object.freeze({
  "catalog-affiliation-pending": PENDING_CODES,
  "pku-stomatology": { countryCode: "cn", universityCode: "pku", hospitalCode: "pkuss" },
  "huaxi-stomatology": { countryCode: "cn", universityCode: "scu", hospitalCode: "hxkq" },
  "hku-dentistry": { countryCode: "hk", universityCode: "hku", hospitalCode: "none" },
  "bern-dentistry": { countryCode: "ch", universityCode: "bern", hospitalCode: "none" },
  "charite-dentistry": { countryCode: "de", universityCode: "charite", hospitalCode: "none" },
  "cluj-dentistry": { countryCode: "ro", universityCode: "cluj", hospitalCode: "none" },
  "coimbra-dentistry": { countryCode: "pt", universityCode: "coimbra", hospitalCode: "none" },
  "copenhagen-dentistry": { countryCode: "dk", universityCode: "copenhagen", hospitalCode: "none" },
  "gothenburg-dentistry": { countryCode: "se", universityCode: "gothenburg", hospitalCode: "none" },
  "harvard-dentistry": { countryCode: "us", universityCode: "harvard", hospitalCode: "none" },
  "kcl-dentistry": { countryCode: "gb", universityCode: "kcl", hospitalCode: "none" },
  "mexico-oms-association": { countryCode: "mx", universityCode: "mexico-oms", hospitalCode: "none" },
  "nus-dentistry": { countryCode: "sg", universityCode: "nus", hospitalCode: "none" },
  "ohsu-dentistry": { countryCode: "us", universityCode: "ohsu", hospitalCode: "none" },
  "qmul-dentistry": { countryCode: "gb", universityCode: "qmul", hospitalCode: "none" },
  "siena-dentistry": { countryCode: "it", universityCode: "siena", hospitalCode: "none" },
  "snu-dentistry": { countryCode: "kr", universityCode: "snu", hospitalCode: "none" },
  "sydney-dentistry": { countryCode: "au", universityCode: "sydney", hospitalCode: "none" },
  "tohoku-dentistry": { countryCode: "jp", universityCode: "tohoku", hospitalCode: "none" },
  "uaeh-dentistry": { countryCode: "mx", universityCode: "uaeh", hospitalCode: "none" },
  "ucm-dentistry": { countryCode: "es", universityCode: "ucm", hospitalCode: "none" },
  "uepg-dentistry": { countryCode: "br", universityCode: "uepg", hospitalCode: "none" },
  "umich-dentistry": { countryCode: "us", universityCode: "umich", hospitalCode: "none" },
  "uzh-dentistry": { countryCode: "ch", universityCode: "uzh", hospitalCode: "none" },
});

const DISCIPLINE_MAP = Object.freeze({
  "oral-surgery": "omfs",
  general: "general",
  endodontics: "endodontics",
  periodontology: "periodontology",
  prosthodontics: "prosthodontics",
  implantology: "implantology",
  orthodontics: "orthodontics",
  "pediatric-preventive": "pediatric-preventive",
  "oral-medicine": "oral-medicine",
  "dental-materials": "dental-materials",
  unclassified: "unclassified",
});

function slugLocal(value) {
  return value
    .toLowerCase()
    .replaceAll(":", "-")
    .replace(/[^a-z0-9-]+/gu, "-")
    .replace(/-{2,}/gu, "-")
    .replace(/^-+|-+$/gu, "");
}

function overlayCode(override, fallback, pattern, name) {
  if (override === undefined) return fallback;
  const trimmed = override.trim();
  if (!pattern.test(trimmed)) {
    throw new Error(`${name} must be a valid slug.`);
  }
  return trimmed;
}

export function isAuthorId(value) {
  return typeof value === "string" && AUTHOR_ID_PATTERN.test(value);
}

export function mapDiscipline(disciplineId) {
  const id = disciplineId?.trim() ?? "";
  return DISCIPLINE_MAP[id] ?? "general";
}

export function codesFromInstitution(institutionId) {
  const key = institutionId?.trim() ?? "";
  return INSTITUTION_CODEBOOK[key] ?? PENDING_CODES;
}

export function localFromV3Id(v3Id) {
  const trimmed = String(v3Id ?? "").trim();
  if (!trimmed) return "";
  const lower = trimmed.toLowerCase();
  const colon = lower.indexOf(":");
  const scheme = colon === -1 ? "" : lower.slice(0, colon);
  const rest = colon === -1 ? lower : lower.slice(colon + 1);

  if (scheme === "openalex") {
    const openalex = /^a(\d+)$/u.exec(rest);
    if (openalex) return `oa-${openalex[1]}`;
  }

  if (scheme === "orcid") {
    return rest.replaceAll("-", "");
  }

  if (scheme === "manual") {
    return slugLocal(`manual-${rest}`);
  }

  if (rest.startsWith("ss-anchor-")) {
    return slugLocal(rest.slice("ss-anchor-".length));
  }

  if (scheme) {
    return slugLocal(rest);
  }

  return slugLocal(lower);
}

export function mintAuthorId(input) {
  const v3Id = input?.v3Id?.trim() ?? "";
  if (!v3Id) {
    throw new Error("v3Id is required to mint an authorId.");
  }

  const local = localFromV3Id(v3Id);
  if (!LOCAL_PATTERN.test(local)) {
    throw new Error(`local segment is invalid for v3Id ${v3Id}.`);
  }

  const fromInstitution = codesFromInstitution(input.institutionId);
  const countryCode = overlayCode(input.countryCode, fromInstitution.countryCode, COUNTRY_PATTERN, "countryCode");
  const universityCode = overlayCode(input.universityCode, fromInstitution.universityCode, CODE_PATTERN, "universityCode");
  const hospitalCode = overlayCode(input.hospitalCode, fromInstitution.hospitalCode, CODE_PATTERN, "hospitalCode");
  const disciplineCode = overlayCode(
    input.disciplineCode,
    mapDiscipline(input.disciplineId),
    CODE_PATTERN,
    "disciplineCode",
  );

  const authorId = `${countryCode}.${universityCode}.${hospitalCode}.${disciplineCode}.${local}`;
  if (!AUTHOR_ID_PATTERN.test(authorId)) {
    throw new Error(`minted authorId is invalid: ${authorId}`);
  }

  return { authorId, countryCode, universityCode, hospitalCode, disciplineCode, local };
}

export function parseAuthorId(authorId) {
  if (!isAuthorId(authorId)) return undefined;
  const [countryCode, universityCode, hospitalCode, disciplineCode, local] = authorId.split(".");
  if (!countryCode || !universityCode || !hospitalCode || !disciplineCode || !local) return undefined;
  return { countryCode, universityCode, hospitalCode, disciplineCode, local };
}
