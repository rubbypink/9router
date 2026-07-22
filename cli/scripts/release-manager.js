const { activateRelease, rollbackRelease } = require("./release-activation.js");
const { installRelease, validateReleaseDirectory } = require("./release-install.js");

module.exports = {
  activateRelease,
  installRelease,
  rollbackRelease,
  validateReleaseDirectory,
};
