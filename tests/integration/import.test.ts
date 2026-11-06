/// <reference types="mocha" />
import * as assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import * as vscode from "vscode";
import { importText } from "../../src/core/import/detect";
import type { TestApi } from "../../src/extension";

const POSTMAN = JSON.stringify({
	info: { name: "Pets", schema: "https://schema.getpostman.com/json/collection/v2.1.0/collection.json" },
	item: [
		{ name: "List pets", request: { method: "GET", url: "{{base}}/pets" } },
		{ name: "Owners", item: [{ name: "Get owner", request: { method: "GET", url: "{{base}}/owners/1" } }] },
	],
});

const POSTMAN_ENVIRONMENT = JSON.stringify({
	name: "Pets dev",
	_postman_variable_scope: "environment",
	values: [
		{ key: "base", value: "http://localhost:4000", enabled: true },
		{ key: "apiKey", value: "s3cret", type: "secret", enabled: true },
	],
});

async function eventually(check: () => boolean, what: string): Promise<void> {
	const deadline = Date.now() + 10_000;
	while (!check()) {
		if (Date.now() > deadline) assert.fail(`Timed out waiting until ${what}`);
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
}

describe("Import", () => {
	let api: TestApi;
	let root: string;

	before(async () => {
		api = await vscode.extensions.getExtension<TestApi>("carbonconfig.carbonwire")!.activate();
		root = vscode.workspace.workspaceFolders![0]!.uri.fsPath;
		await api.app.collections();
	});

	it("writes a Postman collection as a new collection, shown straight away", async () => {
		const summary = await api.importer.write(importText(POSTMAN, "pets.postman_collection.json"), { kind: "new", dir: api.app.collectionsFolder() });
		assert.equal(summary.requests, 2);
		const pets = api.app.index.collections().find((c) => c.name === "Pets");
		assert.ok(pets, "the collection is in the sidebar without waiting for the file watcher");
		assert.deepEqual(
			pets.children.map((n) => n.name),
			["Owners", "List pets"],
		);
	});

	it("adds environments to the shared list, with secret values in secret storage", async () => {
		const summary = await api.importer.write(importText(POSTMAN_ENVIRONMENT, "dev.postman_environment.json"), { kind: "environments" });
		assert.deepEqual(summary.environments, ["Pets dev"]);
		const path = api.app.store.environmentPath(api.app.environmentsFolder(), "Pets dev");
		assert.ok(api.app.environments().includes(path));
		await api.app.secrets.load(path, ["apiKey"]);
		assert.equal(api.app.secrets.get(path, "apiKey"), "s3cret");
		const env = await api.app.store.loadEnvironment(path);
		assert.ok(!JSON.stringify(env).includes("s3cret"), "the secret isn't written to the workspace");
	});

	it("copies an OpenCollection folder from the Explorer, moving its environments to the shared list", async () => {
		const source = join(root, "..", "workspace-import-source", "Billing");
		await mkdir(join(source, "invoices"), { recursive: true });
		await mkdir(join(source, "environments"), { recursive: true });
		await writeFile(join(source, "opencollection.yml"), "opencollection: 1.0.0\ninfo:\n  name: Billing\n");
		await writeFile(join(source, "invoices", "list.yml"), "info:\n  name: list\nhttp:\n  method: GET\n  url: https://billing.test/invoices\n");
		await writeFile(join(source, "environments", "billing-prod.yml"), "name: billing-prod\nvariables: []\n");
		await vscode.commands.executeCommand("carbonwire.importFromExplorer", vscode.Uri.file(source));
		await eventually(() => api.app.index.collections().some((c) => c.name === "Billing" && c.children.length === 1), "the copied collection is in the sidebar");
		assert.ok(api.app.environments().some((p) => p.endsWith("billing-prod.yml")));
	});
});
