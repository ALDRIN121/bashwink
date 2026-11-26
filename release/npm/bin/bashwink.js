#!/usr/bin/env node
/**
 * Bashwink standalone CLI entrypoint.
 *
 * Requires Node.js 22+ and zero third-party runtime packages.
 */
const [majorRaw, minorRaw] = process.versions.node.split(".");
const major = Number((majorRaw || "").trim());
const minor = Number((minorRaw || "").trim());
if (!Number.isFinite(major) || !Number.isFinite(minor) || major < 22 || (major === 22 && minor < 13)) {
  process.stderr.write(
    `bashwink: Node.js 22.13.0 or newer is required (found ${process.versions.node}).\n` +
      "  Install or switch to Node.js >=22.13.0 (https://nodejs.org/) and run `bashwink` again.\n",
  );
  process.exit(1);
}

import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const stagedEntry = path.resolve(here, "../lib/packages/bw-cli/src/standalone/bin.js");
if (!existsSync(stagedEntry)) {
  process.stderr.write(
    "bashwink: standalone runtime bundle was not found at " +
      stagedEntry +
      ".\n" +
      "  Build and install the standalone package first with `npm run install:local` (or `npm run build:standalone`),\n" +
      "  or run directly from source with `node --experimental-strip-types packages/bw-cli/src/standalone/bin.ts`.\n",
  );
  process.exit(1);
}

await import(pathToFileURL(stagedEntry).href);
