import assert from "node:assert/strict";
import test from "node:test";
import {
  AUTHOR_ID_PATTERN,
  codesFromInstitution,
  isAuthorId,
  localFromV3Id,
  mapDiscipline,
  mintAuthorId,
  parseAuthorId,
} from "./author-id.js";

test("Yu PKU OMFS mints cn.demo.hosp.omfs.001", () => {
  const minted = mintAuthorId({
    v3Id: "demo:anchor-001",
    institutionId: "pku-stomatology",
    disciplineId: "oral-surgery",
  });
  assert.equal(minted.authorId, "cn.demo.hosp.omfs.001");
  assert.deepEqual(minted, {
    authorId: "cn.demo.hosp.omfs.001",
    countryCode: "cn",
    universityCode: "pku",
    hospitalCode: "pkuss",
    disciplineCode: "omfs",
    local: "414",
  });
  assert.equal(AUTHOR_ID_PATTERN.test(minted.authorId), true);
});

test("pending OpenAlex mints xx.pending.none.general.oa-5000031924", () => {
  const minted = mintAuthorId({
    v3Id: "openalex:A5000031924",
    institutionId: "catalog-affiliation-pending",
    disciplineId: "general",
  });
  assert.equal(minted.authorId, "xx.pending.none.general.oa-5000031924");
  assert.equal(minted.local, "oa-5000031924");
});

test("localFromV3Id strips ORCID hyphens and downcases trailing X", () => {
  assert.equal(localFromV3Id("demo:anchor-001"), "414");
  assert.equal(localFromV3Id("huaxi:official-101"), "official-101");
  assert.equal(localFromV3Id("openalex:A5000031924"), "oa-5000031924");
  assert.equal(localFromV3Id("orcid:0000-0001-5067-7317"), "0000000150677317");
  assert.equal(localFromV3Id("orcid:0000-0002-1825-009X"), "000000021825009x");
  assert.equal(localFromV3Id("manual:erick-reyes-mx"), "manual-erick-reyes-mx");
  assert.equal(localFromV3Id("Other:Name.Value"), "name-value");
});

test("unknown institution maps to reserved pending codes", () => {
  assert.deepEqual(codesFromInstitution("not-a-real-institution"), {
    countryCode: "xx",
    universityCode: "pending",
    hospitalCode: "none",
  });
  const minted = mintAuthorId({
    v3Id: "openalex:A5000031924",
    institutionId: "unknown-org",
    disciplineId: "oral-surgery",
  });
  assert.equal(minted.authorId, "xx.pending.none.omfs.oa-5000031924");
});

test("mapDiscipline keeps known slugs and falls back to general", () => {
  assert.equal(mapDiscipline("oral-surgery"), "omfs");
  assert.equal(mapDiscipline("general"), "general");
  assert.equal(mapDiscipline("endodontics"), "endodontics");
  assert.equal(mapDiscipline("periodontology"), "periodontology");
  assert.equal(mapDiscipline("prosthodontics"), "prosthodontics");
  assert.equal(mapDiscipline("implantology"), "implantology");
  assert.equal(mapDiscipline("orthodontics"), "orthodontics");
  assert.equal(mapDiscipline("pediatric-preventive"), "pediatric-preventive");
  assert.equal(mapDiscipline("oral-medicine"), "oral-medicine");
  assert.equal(mapDiscipline("dental-materials"), "dental-materials");
  assert.equal(mapDiscipline("unclassified"), "unclassified");
  assert.equal(mapDiscipline("missing"), "general");
  assert.equal(mapDiscipline(""), "general");
  assert.equal(mapDiscipline(undefined), "general");
});

test("mintAuthorId throws when v3Id is missing", () => {
  assert.throws(
    () => mintAuthorId({ v3Id: "", institutionId: "pku-stomatology", disciplineId: "oral-surgery" }),
    /v3Id is required/,
  );
  assert.throws(
    () => mintAuthorId({ v3Id: "   ", institutionId: "pku-stomatology" }),
    /v3Id is required/,
  );
  assert.throws(
    () => mintAuthorId({ v3Id: undefined as unknown as string }),
    /v3Id is required/,
  );
});

test("mintAuthorId throws on invalid overrides and overlong local", () => {
  assert.throws(
    () => mintAuthorId({
      v3Id: "demo:anchor-001",
      institutionId: "pku-stomatology",
      countryCode: "CN",
    }),
    /countryCode must be a valid slug/,
  );
  assert.throws(
    () => mintAuthorId({
      v3Id: "demo:anchor-001",
      universityCode: "x",
    }),
    /universityCode must be a valid slug/,
  );
  assert.throws(
    () => mintAuthorId({ v3Id: `manual:${"a".repeat(40)}` }),
    /local segment is invalid/,
  );
});

test("optional code overrides replace the institution codebook", () => {
  const minted = mintAuthorId({
    v3Id: "openalex:A5000031924",
    institutionId: "catalog-affiliation-pending",
    disciplineId: "general",
    countryCode: "cn",
    universityCode: "pku",
    hospitalCode: "pkuss",
    disciplineCode: "omfs",
  });
  assert.equal(minted.authorId, "cn.pku.pkuss.omfs.oa-5000031924");
});

test("isAuthorId and parseAuthorId round-trip valid ids", () => {
  assert.equal(isAuthorId("cn.demo.hosp.omfs.001"), true);
  assert.equal(isAuthorId("xx.pending.none.general.oa-5000031924"), true);
  assert.equal(isAuthorId("author:ada-test"), false);
  assert.equal(isAuthorId("CN.pku.pkuss.omfs.414"), false);
  assert.equal(parseAuthorId("author:ada-test"), undefined);
  assert.deepEqual(parseAuthorId("cn.demo.hosp.omfs.001"), {
    countryCode: "cn",
    universityCode: "pku",
    hospitalCode: "pkuss",
    disciplineCode: "omfs",
    local: "414",
  });
});

test("school-only institutions keep hospital none", () => {
  assert.deepEqual(codesFromInstitution("hku-dentistry"), {
    countryCode: "hk",
    universityCode: "hku",
    hospitalCode: "none",
  });
  assert.deepEqual(codesFromInstitution("huaxi-stomatology"), {
    countryCode: "cn",
    universityCode: "scu",
    hospitalCode: "hxkq",
  });
});
