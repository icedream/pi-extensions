/**
 * Writes the hook farm from the command line.
 *
 * The extension does this itself at session start. This entry point exists for the shell suite in
 * `commit-paths.test.sh`, which exercises the hooks without a Pi session around them, and for anyone who
 * wants to see what a session would install.
 *
 *   node farm-cli.ts <farmDir> <applyPath> <home> <configPath> <modelsPath>
 */

import { writeFarm } from "./hooks.ts";

const [farmDir, applyPath, home, configPath, modelsPath] = process.argv.slice(2);
if (!farmDir || !applyPath || !home || !configPath || !modelsPath) {
	console.error("usage: node farm-cli.ts <farmDir> <applyPath> <home> <configPath> <modelsPath>");
	process.exit(2);
}

const written = writeFarm(farmDir, { applyPath, home, configPath, modelsPath });
console.log(`${written.length} hook(s) written to ${farmDir}`);
