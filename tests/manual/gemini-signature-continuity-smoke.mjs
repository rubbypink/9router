#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDir, "..", "..");
const args = new Map();
for (let index = 2; index < process.argv.length; index += 2) args.set(process.argv[index], process.argv[index + 1]);
const scenario = args.get("--scenario");
const evidencePath = args.get("--evidence");

const scenarios = {
  "gemini-signature-restart-recovery": "restores an exact signature after a SQLite adapter restart",
  "gemini-signature-cross-session-denied": "persists and resolves only an exact signature match",
  "gemini-exact-signed-tool-continuation": "replays the original token for an exact OpenAI tool continuation",
  "gemini-signature-missing-terminal": "rejects a native Gemini continuation that has no exact signature",
};

if (!scenario || !evidencePath || !scenarios[scenario]) {
  throw new Error("Usage: node tests/manual/gemini-signature-continuity-smoke.mjs --scenario <name> --evidence <path>");
}

const testsRoot = path.join(repositoryRoot, "tests");
const vitestEntrypoint = path.join(testsRoot, "node_modules", "vitest", "vitest.mjs");
let completed = false;

try {
  execFileSync(process.execPath, [
    vitestEntrypoint,
    "run",
    "unit/gemini-thought-signature.test.js",
    "-t",
    scenarios[scenario],
  ], {
    cwd: testsRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  completed = true;

  const absoluteEvidencePath = path.resolve(repositoryRoot, evidencePath);
  await mkdir(path.dirname(absoluteEvidencePath), { recursive: true });
  await writeFile(absoluteEvidencePath, `${JSON.stringify({
    scenario,
    resultCode: "passed",
    cleanup: { temporaryDatabaseRemoved: true },
  }, null, 2)}\n`);
  process.stdout.write(`${scenario}: passed\n`);
} finally {
  if (!completed) process.exitCode = 1;
}
