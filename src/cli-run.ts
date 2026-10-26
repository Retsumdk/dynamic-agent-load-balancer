#!/usr/bin/env node
/** Bin shim: dalb <command>. Compiled to dist/cli-run.js by `prepare`. */
import { runCli } from "./cli.js";

runCli(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    process.stderr.write(`dalb: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exitCode = 4;
  });
