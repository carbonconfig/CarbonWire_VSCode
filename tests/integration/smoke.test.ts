/// <reference types="mocha" />
import * as assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import * as vscode from "vscode";
import { findNode } from "../../src/core/storage/order";
import { MASK } from "../../src/core/variables";
import type { TestApi } from "../../src/extension";
import type { CarbonWire } from "../../src/host/carbonwire";

const LIST = "api-collections/Shop/Products/list.yml";
const ENVIRONMENT = "api-collections/environments/local.yml";

/** Retries until the check passes, for results that arrive through file events. */
async function eventually(check: () => boolean | Promise<boolean>, what: string): Promise<void> {
	const deadline = Date.now() + 5000;
	while (!(await check())) {
		if (Date.now() > deadline) assert.fail(`Timed out waiting until ${what}`);
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
}

describe("CarbonWire in VS Code", () => {
	let app: CarbonWire;
	let api: TestApi;
	let server: Server;
	let root: string;
	const hasRequest = (path: string) => findNode(app.index.collections(), path) !== undefined;

	before(async () => {
		const extension = vscode.extensions.getExtension<TestApi>("carbonconfig.carbonwire");
		assert.ok(extension, "the extension is installed");
		api = await extension.activate();
		app = api.app;
		root = vscode.workspace.workspaceFolders![0]!.uri.fsPath;

		server = createServer((req, res) => {
			res.setHeader("content-type", "application/json");
			res.end(JSON.stringify({ url: req.url, auth: req.headers.authorization, collection: req.headers["x-collection"] }));
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const { port } = server.address() as AddressInfo;
		await writeFile(
			join(root, ENVIRONMENT),
			`name: local\ncolor: "#27AE60"\nvariables:\n  - name: baseUrl\n    value: http://127.0.0.1:${port}\n  - name: token\n    secret: true\n`,
		);
	});

	after(() => server.close());

	it("finds the collections in the workspace", async () => {
		const shop = (await app.collections()).find((c) => c.name === "Shop");
		assert.ok(shop, "the Shop collection is found");
		assert.ok(hasRequest(LIST));
	});

	it("shows the sidebar with no errors or blocked content", async () => {
		// An environment with a colour exercises Svelte's style directives under the content security policy.
		await eventually(() => app.environmentEntries().some((e) => e.color === "#27AE60"), "the environment and its colour are read");
		await vscode.commands.executeCommand("carbonwire.openCollections");
		await eventually(() => api.sidebar.loads > 0, "the sidebar webview has loaded");
		// Problems would arrive just after the first render.
		await new Promise((resolve) => setTimeout(resolve, 500));
		assert.deepEqual(api.sidebar.problems, []);
	});

	it("sends with the environment, its secrets and the collection's headers and auth, and keeps it in history", async () => {
		await eventually(() => app.environments().includes(ENVIRONMENT), "the new environment is listed");
		await app.setActiveEnvironment("local");
		await app.secrets.set(ENVIRONMENT, "token", "s3cret");

		const request = await app.store.loadRequest(LIST);
		const result = await app.send(LIST, "list", request, new AbortController().signal);
		assert.equal(result.response.status, 200);
		const echo = JSON.parse(new TextDecoder().decode(result.response.body)) as unknown;
		assert.deepEqual(echo, { url: "/products?limit=5", auth: "Bearer s3cret", collection: "shop" });
		await eventually(async () => (await app.history.latestFor(LIST))?.response?.status === 200, "the send is in history");
	});

	it("tells each variable's value and where it's set, with secrets masked, for hovers", async () => {
		const request = await app.store.loadRequest(LIST);
		const variables = new Map((await app.variables(LIST, request)).map((v) => [v.name, v]));
		assert.equal(variables.get("baseUrl")?.source, "environment");
		assert.equal(variables.get("baseUrl")?.file, ENVIRONMENT);
		assert.match(variables.get("baseUrl")?.value ?? "", /^http:\/\/127\.0\.0\.1:\d+$/);
		assert.deepEqual({ ...variables.get("token") }, { name: "token", value: MASK, source: "environment", label: "local", file: ENVIRONMENT, secret: true });
		assert.deepEqual(await app.variableTarget(LIST, request, "token"), { file: ENVIRONMENT, create: false });
		// One that isn't set is added to the active environment; dynamic ones go nowhere.
		assert.deepEqual(await app.variableTarget(LIST, request, "missing"), { file: ENVIRONMENT, create: true });
		assert.equal(await app.variableTarget(LIST, request, "$randomInt"), undefined);
	});

	it("reuses connections, which VS Code's patched http module would stop", async () => {
		const request = await app.store.loadRequest(LIST);
		await app.send(LIST, "list", request, new AbortController().signal);
		const again = await app.send(LIST, "list", request, new AbortController().signal);
		assert.equal(again.response.timings.reusedConnection, true);
	});

	it("picks up request files written outside CarbonWire", async () => {
		await writeFile(join(root, "api-collections/Shop/Products/create.yml"), "info:\n  name: create\nhttp:\n  method: POST\n  url: '{{baseUrl}}/products'\n");
		await eventually(() => hasRequest("api-collections/Shop/Products/create.yml"), "the new request is in the tree");
		await eventually(() => app.index.metaFor("api-collections/Shop/Products/create.yml")?.method === "POST", "its method is read");
	});

	it("renames a request, and its history follows", async () => {
		const target = await app.actions.renameRequest(LIST, "list all");
		assert.equal(target, "api-collections/Shop/Products/list all.yml");
		assert.equal((await app.store.loadRequest(target)).info?.name, "list all");
		assert.equal((await app.history.latestFor(target))?.name, "list");
		await eventually(() => hasRequest(target) && !hasRequest(LIST), "the tree shows the new name");
	});

	it("skips hidden folders, and folders in carbonwire.exclude", async () => {
		const collection = async (dir: string, name: string) => {
			await mkdir(join(root, dir), { recursive: true });
			await writeFile(join(root, dir, "opencollection.yml"), `opencollection: 1.0.0\ninfo:\n  name: ${name}\n`);
		};
		const listed = (name: string) => app.index.collections().some((c) => c.name === name);
		await collection(".hidden/Hidden", "Hidden");
		await collection("tests/fixtures/Fixture", "Fixture");
		await eventually(() => listed("Fixture"), "the fixture collection is listed");
		assert.equal(listed("Hidden"), false, "a collection in a hidden folder isn't listed");

		const config = vscode.workspace.getConfiguration("carbonwire");
		await config.update("exclude", ["**/tests/fixtures"], vscode.ConfigurationTarget.Workspace);
		try {
			await eventually(() => !listed("Fixture"), "the excluded collection is gone");
			await collection("tests/fixtures/Later", "Later");
			await new Promise((resolve) => setTimeout(resolve, 500));
			assert.equal(listed("Later"), false, "a collection created in an excluded folder isn't listed");
		} finally {
			await config.update("exclude", undefined, vscode.ConfigurationTarget.Workspace);
		}
		await eventually(() => listed("Fixture") && listed("Later"), "both are listed once the setting is cleared");
	});

	it("notices a folder deleted outside VS Code", async () => {
		await rm(join(root, "api-collections/Shop/Products"), { recursive: true });
		await eventually(() => app.index.collections().find((c) => c.name === "Shop")?.children.length === 0, "the folder is gone from the tree");
	});
});
