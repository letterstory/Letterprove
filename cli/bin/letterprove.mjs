#!/usr/bin/env node
// Thin entry point: hand argv to run() and translate its exit code to the
// process. All logic lives in ../lib so it stays testable without spawning a
// process.
import { run } from "../lib/cli.mjs";

run(process.argv.slice(2))
	.then((code) => process.exit(code))
	.catch((err) => {
		// A non-CliError escaped run() — a real bug, so show the stack.
		console.error(err);
		process.exit(1);
	});
