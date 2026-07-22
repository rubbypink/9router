#!/usr/bin/env node

const path = require("node:path");

const { ARCHIVE_NAME, ReleaseError } = require("./release-contract.js");
const { activateRelease, installRelease, rollbackRelease } = require("./release-manager.js");

function parseArguments(argv) {
  const [command, ...rest] = argv;
  const options = {};
  for (let index = 0; index < rest.length; index += 2) {
    const flag = rest[index];
    const value = rest[index + 1];
    if (!value || !["--archive", "--data-dir", "--release-root"].includes(flag)) {
      throw new ReleaseError("invalid_arguments", "Expected --archive, --data-dir, or --release-root with a value");
    }
    options[flag.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = value;
  }
  return { command, options };
}

function run(argv = process.argv.slice(2)) {
  const { command, options } = parseArguments(argv);
  const releaseRoot = options.releaseRoot || process.env.NINEROUTER_RELEASE_ROOT;
  const common = { dataDir: options.dataDir, releaseRoot };
  if (command === "install") {
    return installRelease({
      ...common,
      archivePath: options.archive || path.resolve(__dirname, "..", "..", ARCHIVE_NAME),
    });
  }
  if (command === "activate") return activateRelease(common);
  if (command === "rollback") return rollbackRelease(common);
  throw new ReleaseError("invalid_command", "Use install, activate, or rollback");
}

if (require.main === module) {
  try {
    console.log(JSON.stringify(run(), null, 2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

module.exports = { run };
