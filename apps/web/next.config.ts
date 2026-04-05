import path from "node:path";
import { fileURLToPath } from "node:url";
import "./env-bootstrap";
import "@my-better-t-app/env/web";
import type { NextConfig } from "next";

const monorepoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "../..");

const nextConfig: NextConfig = {
  typedRoutes: true,
  reactCompiler: true,
  turbopack: {
    root: monorepoRoot,
  },
};

export default nextConfig;
