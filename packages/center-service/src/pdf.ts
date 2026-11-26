import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { copyFile, lstat, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { CenterError } from "./errors.js";
import type { FixtureSource } from "./store.js";

function inside(root: string, candidate: string) {
  const rel = relative(root, candidate);
  return rel !== "" && !rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel);
}

async function sha256(path: string) {
  const hash = createHash("sha256");
  const bytes = await readFile(path);
  hash.update(bytes);
  return hash.digest("hex");
}

function canonicalDoi(value: string) {
  return value.trim().toLowerCase().replace(/^doi:\s*/u, "").replace(/^https?:\/\/(?:dx\.)?doi\.org\//u, "").replace(/[),.;]+$/u, "");
}

async function inspectPdf(path: string) {
  const bytes = await readFile(path);
  const task = getDocument({ data: new Uint8Array(bytes) });
  try {
    const document = await task.promise;
    const pageTexts: string[] = [];
    for (let pageIndex = 1; pageIndex <= document.numPages; pageIndex += 1) {
      const page = await document.getPage(pageIndex);
      const content = await page.getTextContent();
      pageTexts.push(content.items.map((item) => "str" in item ? item.str : "").join(" "));
    }
    const metadata = await document.getMetadata().catch(() => undefined);
    const info = metadata?.info as { Title?: unknown; Subject?: unknown; Custom?: unknown } | undefined;
    const metadataTitle = typeof info?.Title === "string" ? info.Title.trim() : "";
    const text = pageTexts.join("\n");
    const custom = info?.Custom && typeof info.Custom === "object" ? info.Custom as Record<string, unknown> : {};
    const articleDoiValues = Object.entries(custom)
      .filter(([key, value]) => typeof value === "string" && (key.toLowerCase() === "doi" || key.toLowerCase().includes("articledoi")))
      .map(([, value]) => value as string);
    const metadataIdentityText = [
      ...articleDoiValues,
      typeof info?.Subject === "string" ? info.Subject : "",
      ...Object.values(custom).filter((value): value is string => typeof value === "string"),
    ].join("\n");
    const doiCandidates = [...metadataIdentityText.matchAll(/10\.\d{4,9}\/[-._;()/:a-z0-9]+/giu), ...text.matchAll(/10\.\d{4,9}\/[-._;()/:a-z0-9]+/giu)]
      .map((match) => canonicalDoi(match[0]))
      .filter((value, index, all) => value !== "" && all.indexOf(value) === index);
    const result = { pageCount: document.numPages, text: text.toLowerCase(), doiCandidates, metadataTitle };
    await document.destroy();
    return result;
  } catch {
    throw new CenterError("validation_failed", "The PDF pages or text identity could not be verified.", 422);
  } finally {
    await task.destroy().catch(() => undefined);
  }
}

async function verifyFile(path: string, fixture: FixtureSource) {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink()) {
    throw new CenterError("validation_failed", "The full-text source is not a regular file.", 422);
  }
  const handle = await open(path, "r");
  try {
    const header = Buffer.alloc(5);
    await handle.read(header, 0, header.length, 0);
    if (header.toString("ascii") !== "%PDF-") {
      throw new CenterError("validation_failed", "The full-text source does not have a valid PDF header.", 422);
    }
  } finally {
    await handle.close();
  }
  const [actualSha, inspection] = await Promise.all([sha256(path), inspectPdf(path)]);
  const pages = inspection.pageCount;
  if (actualSha !== fixture.sha256 || info.size !== fixture.byteSize || pages !== fixture.pageCount) {
    throw new CenterError("validation_failed", "The PDF hash, size, or page count does not match the fixture manifest.", 422);
  }
  if (!inspection.text.includes(fixture.doi.toLowerCase())) {
    throw new CenterError("validation_failed", "The PDF identity could not be matched to the paper DOI.", 422);
  }
  return { sha256: actualSha, byteSize: info.size, pageCount: pages };
}

async function verifyUploadedFile(path: string, provided: { doi?: string; title?: string; trustSuppliedDoi?: boolean }) {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink()) throw new CenterError("validation_failed", "The uploaded PDF is not a regular file.", 422);
  const handle = await open(path, "r");
  try {
    const header = Buffer.alloc(5);
    await handle.read(header, 0, header.length, 0);
    if (header.toString("ascii") !== "%PDF-") throw new CenterError("validation_failed", "The uploaded file does not have a valid PDF header.", 422);
  } finally {
    await handle.close();
  }
  const [actualSha, inspection] = await Promise.all([sha256(path), inspectPdf(path)]);
  const requestedDoi = provided.doi ? canonicalDoi(provided.doi) : undefined;
  if (
    requestedDoi
    && !provided.trustSuppliedDoi
    && !inspection.doiCandidates.includes(requestedDoi)
    && !inspection.text.includes(requestedDoi)
  ) {
    throw new CenterError("validation_failed", "The supplied DOI is not present in the uploaded PDF.", 422);
  }
  const doi = requestedDoi ?? inspection.doiCandidates[0];
  if (!doi) throw new CenterError("validation_failed", "No DOI could be identified in the uploaded PDF.", 422);
  const title = (inspection.metadataTitle || provided.title?.trim() || "").replace(/[\u0000-\u001f\u007f]/gu, " ").replace(/\s+/gu, " ").trim();
  if (!title) throw new CenterError("validation_failed", "No title could be identified for the uploaded PDF.", 422);
  if (title.length > 500) throw new CenterError("validation_failed", "The uploaded PDF title is too long.", 422);
  return { sha256: actualSha, byteSize: info.size, pageCount: inspection.pageCount, doi, title };
}

export async function validateAndPromote(rootDir: string, fixture: FixtureSource) {
  const fixtureRoot = resolve(rootDir, "fixtures/source");
  const sourcePath = resolve(rootDir, fixture.sourceFile);
  if (!inside(fixtureRoot, sourcePath)) {
    throw new CenterError("validation_failed", "The fixture source resolves outside the allowed fixture directory.", 422);
  }
  await verifyFile(sourcePath, fixture);
  const stagingRoot = resolve(rootDir, "staging");
  await mkdir(stagingRoot, { recursive: true, mode: 0o750 });
  const stagingPath = resolve(stagingRoot, `ingest-${randomUUID()}.pdf`);
  if (!inside(stagingRoot, stagingPath)) throw new CenterError("validation_failed", "Invalid staging path.", 422);
  try {
    await copyFile(sourcePath, stagingPath, constants.COPYFILE_EXCL);
    const verified = await verifyFile(stagingPath, fixture);
    const objectPath = resolve(rootDir, "objects/sha256", verified.sha256.slice(0, 2), verified.sha256.slice(2, 4), `${verified.sha256}.pdf`);
    await mkdir(dirname(objectPath), { recursive: true, mode: 0o750 });
    try {
      await lstat(objectPath);
      await verifyFile(objectPath, fixture);
      await unlink(stagingPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") await rename(stagingPath, objectPath);
      else if (error instanceof CenterError) throw error;
      else throw error;
    }
    return { ...verified, verifiedAt: new Date().toISOString() };
  } finally {
    await unlink(stagingPath).catch(() => undefined);
  }
}

export async function validateUploadedAndPromote(rootDir: string, stagingPath: string, provided: { doi?: string; title?: string; trustSuppliedDoi?: boolean }) {
  const stagingRoot = resolve(rootDir, "staging");
  if (!inside(stagingRoot, resolve(stagingPath))) throw new CenterError("validation_failed", "The uploaded staging path is outside the test library.", 422);
  try {
    const verified = await verifyUploadedFile(stagingPath, provided);
    const objectPath = resolve(rootDir, "objects/sha256", verified.sha256.slice(0, 2), verified.sha256.slice(2, 4), `${verified.sha256}.pdf`);
    await mkdir(dirname(objectPath), { recursive: true, mode: 0o750 });
    try {
      const existing = await lstat(objectPath);
      if (!existing.isFile() || existing.isSymbolicLink() || await sha256(objectPath) !== verified.sha256) {
        throw new CenterError("conflict", "The existing shared PDF object conflicts with the uploaded hash.", 409);
      }
      await unlink(stagingPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") await rename(stagingPath, objectPath);
      else if (error instanceof CenterError) throw error;
      else throw error;
    }
    return { ...verified, verifiedAt: new Date().toISOString() };
  } finally {
    await unlink(stagingPath).catch(() => undefined);
  }
}
