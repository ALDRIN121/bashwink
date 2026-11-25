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

await import("../lib/packages/bw-cli/src/standalone/bin.js");
