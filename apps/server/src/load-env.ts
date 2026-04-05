import { config as loadEnv } from "dotenv";
import { existsSync } from "node:fs";
import path from "node:path";

const cwd = process.cwd();
const envFiles = [
  path.join(cwd, ".env"),
  path.join(cwd, ".env.local"),
  path.join(cwd, "..", "..", ".env"),
  path.join(cwd, "..", "..", ".env.local"),
];
for (const file of envFiles) {
  if (existsSync(file)) {
    loadEnv({ path: file, override: true });
  }
}
