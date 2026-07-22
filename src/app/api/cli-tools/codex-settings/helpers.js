import os from "os";
import path from "path";

export const resolveCodexDir = (env = process.env, homedir = os.homedir) => {
  if (env.CODEX_HOME) return env.CODEX_HOME;
  return path.join(env.HOME || homedir(), ".codex");
};

export const redactConfigSecrets = (config) => config?.replace(
  /^(\s*experimental_bearer_token\s*=\s*)(?:"(?:\\.|[^"\\])*"|'[^']*')/gm,
  '$1"[REDACTED]"',
);
