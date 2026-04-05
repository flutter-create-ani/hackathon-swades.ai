/**
 * Runs before @my-better-t-app/env/web so `next build` / `next start` see variables
 * from the monorepo root `.env`, not only `apps/web/.env*`.
 */
import { config as loadEnv } from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";

const webDir = path.dirname(fileURLToPath(import.meta.url));
const monorepoRoot = path.join(webDir, "..", "..");

for (const file of [
  path.join(monorepoRoot, ".env"),
  path.join(monorepoRoot, ".env.local"),
  path.join(webDir, ".env"),
  path.join(webDir, ".env.local"),
]) {
  loadEnv({ path: file, override: true });
}
