#!/usr/bin/env node

import process from "node:process";
import { runRuntimeCli } from "../src/runtime-cli.mjs";

runRuntimeCli().catch((error) => {
  process.stderr.write(`zion: ${error?.message || String(error)}\n`);
  process.exitCode = 1;
});
