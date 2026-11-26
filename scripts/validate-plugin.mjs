import { homedir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const codexHome = process.env.CODEX_HOME || join(homedir(), ".codex");
const validator = join(codexHome, "skills/.system/plugin-creator/scripts/validate_plugin.py");
const result = spawnSync("python3", [validator, "."], { stdio: "inherit" });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
