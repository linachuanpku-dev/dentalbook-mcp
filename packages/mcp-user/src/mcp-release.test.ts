import assert from "node:assert/strict";
import test from "node:test";
import { mcpUpgradeStatus } from "./mcp-release.js";

test("mcpUpgradeStatus marks recommended and required only when outdated", () => {
  const manifest = {
    version: "0.2.0",
    sha256: "abc",
    upgradeRecommended: true,
    upgradeRequired: true,
    upgradeHint: "Please upgrade.",
  };
  assert.deepEqual(mcpUpgradeStatus("0.1.0", manifest), {
    latestMcpVersion: "0.2.0",
    upgradeRecommended: true,
    upgradeRequired: true,
    upgradeHint: "Please upgrade.",
  });
  assert.deepEqual(mcpUpgradeStatus("0.2.0", manifest), {
    latestMcpVersion: "0.2.0",
    upgradeRecommended: false,
    upgradeRequired: false,
    upgradeHint: undefined,
  });
});
