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

/* Workspace folders a, b and c: environments in a and b are merged, and c starts empty to move them into. */
function multiRootRun() {
	const workspace = ".vscode-test/workspace-multiroot";
	rmSync(workspace, { recursive: true, force: true });
	const write = (path, text) => {
		mkdirSync(join(workspace, path, ".."), { recursive: true });
		writeFileSync(join(workspace, path), text);
	};
	const environment = (name, variables) => `name: ${name}\nvariables:\n${Object.entries(variables).map(([n, v]) => `  - name: ${n}\n    value: "${v}"\n`).join("")}`;
	write("a/api-collections/Shop/opencollection.yml", "opencollection: 1.0.0\ninfo:\n  name: Shop\n");
	write("a/api-collections/environments/dev.yml", environment("dev", { host: "a.test", token: "" }));
	write("b/api-collections/environments/dev.yml", environment("dev", { host: "b.test", token: "t-b", extra: "x" }));
	write("b/api-collections/environments/prod.yml", environment("prod", { host: "prod.test" }));
	write("b/api-collections/environments/globals.yml", environment("globals", { g: "1" }));
	mkdirSync(join(workspace, "c"), { recursive: true });
	write("carbonwire.code-workspace", JSON.stringify({ folders: [{ path: "a" }, { path: "b" }, { path: "c" }] }));
	return {
		label: "multiroot",
		version: "stable",
		files: "dist/test/multiroot/*.test.js",
		workspaceFolder: `${workspace}/carbonwire.code-workspace`,
		mocha: { ui: "bdd", timeout: 20000 },
		launchArgs: ["--disable-extensions"],
	};
}

// The oldest supported version (engines.vscode) and the current release; `multiroot` and `perf` use their own workspaces.
export default defineConfig([run("minimum", "1.105.0"), run("stable", "stable"), multiRootRun(), perfRun()]);
