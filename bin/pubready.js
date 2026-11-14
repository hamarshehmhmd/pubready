#!/usr/bin/env node
import { main } from "../src/cli.js";

main().then((code) => { process.exitCode = code; }, (err) => {
  process.stderr.write(`pubready: ${err && err.stack ? err.stack : err}\n`);
  process.exitCode = 2;
});
