#!/usr/bin/env node
import { runBox } from "./run-box.mjs";

const tests = process.argv.slice(2);
if (!tests.length || tests.some(name => !/^test_[A-Za-z0-9_.-]+\.py$/.test(name))) {
  console.error("usage: run-box-tests.mjs test_*.py [test_*.py ...]");
  process.exit(2);
}
try {
  await runBox({ entry: "pytest", args: ["-q", ...tests] });
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
