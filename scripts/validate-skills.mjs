import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const codexHome = process.env.CODEX_HOME || join(homedir(), ".codex");
const validator = join(codexHome, "skills/.system/skill-creator/scripts/quick_validate.py");
const skillsRoot = resolve("skills");
const entries = (await readdir(skillsRoot, { withFileTypes: true })).filter((entry) => entry.isDirectory());

for (const entry of entries) {
  const result = spawnSync("python3", [validator, join(skillsRoot, entry.name)], { stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exitCode = 1;
}

if (!process.exitCode) console.log(`Validated ${entries.length} Dentalbook skills.`);
