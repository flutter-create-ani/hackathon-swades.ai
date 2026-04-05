import path from "node:path";
import { fileURLToPath } from "node:url";

const thisDir = path.dirname(fileURLToPath(import.meta.url));
export const SERVER_PACKAGE_ROOT = path.join(thisDir, "..");

export function defaultRecordingsDir(): string {
  return path.join(SERVER_PACKAGE_ROOT, "recordings");
}
