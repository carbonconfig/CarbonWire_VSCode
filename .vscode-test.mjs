import { cpSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { defineConfig } from "@vscode/test-cli";

/* Tests change the workspace, so each run starts from its own fresh copy of the fixture. */
function run(label, version) {
	const workspace = `.vscode-test/workspace-${label}`;
	rmSync(workspace, { recursive: true, force: true });
	cpSync("tests/integration/fixture", workspace, { recursive: true });
	return {
		label,
		version,
		files: "dist/test/integration/*.test.js",
		workspaceFolder: workspace,
		mocha: { ui: "bdd", timeout: 20000 },
		launchArgs: ["--disable-extensions"],
	};
}

/**
 * A workspace of 5,000 requests for `npm run test:perf`, plus unrelated YAML and a node_modules
 * folder that indexing must skip.
 */
function perfRun() {
	const workspace = ".vscode-test/workspace-perf";
	const config = {
		label: "perf",
		version: "stable",
		files: "dist/test/perf/*.test.js",
		workspaceFolder: workspace,
		mocha: { ui: "bdd", timeout: 120000 },
		launchArgs: ["--disable-extensions"],
	};
	// Writing 7,000 files takes a moment, so only when this run was asked for.
	if (!process.argv.includes("perf")) return config;
	rmSync(workspace, { recursive: true, force: true });
	const write = (path, text) => {
		mkdirSync(join(workspace, path, ".."), { recursive: true });
		writeFileSync(join(workspace, path), text);
	};
	const methods = ["GET", "POST", "PUT", "PATCH", "DELETE"];
	for (let c = 0; c < 50; c++) {
		const root = `api-collections/Service ${c}`;
		write(`${root}/opencollection.yml`, `opencollection: 1.0.0\ninfo:\n  name: Service ${c}\n`);
		for (let f = 0; f < 5; f++) {
			write(`${root}/Area ${f}/folder.yml`, `info:\n  name: Area ${f}\n  type: folder\n  seq: ${f + 1}\nrequest:\n  auth: inherit\n`);
			for (let r = 0; r < 20; r++) {
				const method = methods[(c + f + r) % methods.length];
				write(`${root}/Area ${f}/Request ${r}.yml`, `info:\n  name: Request ${r}\n  type: http\n  seq: ${r + 1}\nhttp:\n  method: ${method}\n  url: "{{base}}/items/${r}"\n  auth: inherit\n`);
			}
		}
	}
	for (let i = 0; i < 1000; i++) write(`deploy/chart-${i % 20}/values-${i}.yaml`, `replicas: ${i}\n`);
	for (let i = 0; i < 1000; i++) write(`node_modules/pkg-${i % 50}/config-${i}.yml`, `x: ${i}\n`);
	write(".vscode/settings.json", JSON.stringify({ "carbonwire.responseSizeLimit": 60 }));
	return config;
}

// The oldest supported version (engines.vscode) and the current release; `perf` runs on its own.
export default defineConfig([run("minimum", "1.105.0"), run("stable", "stable"), perfRun()]);
