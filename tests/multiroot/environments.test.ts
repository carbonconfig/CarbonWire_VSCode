/// <reference types="mocha" />
import * as assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import * as vscode from "vscode";
import type { TestApi } from "../../src/extension";
import type { CarbonWire } from "../../src/host/carbonwire";

async function eventually(check: () => boolean, what: string): Promise<void> {
	const deadline = Date.now() + 5000;
	while (!check()) {
		if (Date.now() > deadline) assert.fail(`Timed out waiting until ${what}`);
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
}

function folderUri(name: string, ...path: string[]): vscode.Uri {
	const folder = vscode.workspace.workspaceFolders!.find((f) => f.name === name)!;
	return vscode.Uri.joinPath(folder.uri, ...path);
}

async function move(from: vscode.Uri, to: vscode.Uri): Promise<void> {
	const edit = new vscode.WorkspaceEdit();
	edit.renameFile(from, to);
	assert.ok(await vscode.workspace.applyEdit(edit), `moved ${from.fsPath}`);
}

const environmentsSetting = () => vscode.workspace.getConfiguration("carbonwire").get<string>("environmentsFolder");

describe("Environments across workspace folders", () => {
	let app: CarbonWire;
	let server: Server;
	let base: string;

	before(async () => {
		app = (await vscode.extensions.getExtension<TestApi>("carbonconfig.carbonwire")!.activate()).app;
		server = createServer((req, res) => res.end(JSON.stringify({ url: req.url })));
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
		await app.collections();
	});

	after(() => server.close());

	it("lists one environment per name from every workspace folder, the first folder's file first", async () => {
		await eventually(() => app.environments().length === 2, "both environments are listed");
		assert.deepEqual(app.environments(), ["a/api-collections/environments/dev.yml", "b/api-collections/environments/prod.yml"]);
		assert.deepEqual(app.environmentFiles("dev"), ["a/api-collections/environments/dev.yml", "b/api-collections/environments/dev.yml"]);
		assert.equal(app.environmentsFolder(), "a/api-collections/environments");
		assert.equal(app.globalsPath(), "b/api-collections/environments/globals.yml");
		assert.ok(app.isGlobals("b/api-collections/environments/globals.yml"));
	});

	it("merges same-named environments: each variable takes the first value that isn't empty", async () => {
		await app.setActiveEnvironment("dev");
		const url = `${base}/echo?host={{host}}&token={{token}}&extra={{extra}}&g={{g}}`;
		const result = await app.send(undefined, "merged", { http: { method: "GET", url } }, new AbortController().signal);
		const echo = JSON.parse(new TextDecoder().decode(result.response.body)) as { url: string };
		assert.equal(echo.url, "/echo?host=a.test&token=t-b&extra=x&g=1");
	});

	it("keeps environments moved to another workspace folder, without changing the setting", async () => {
		await move(folderUri("a", "api-collections"), folderUri("c", "api-collections"));
		await eventually(() => app.environmentFiles("dev").join() === "b/api-collections/environments/dev.yml,c/api-collections/environments/dev.yml", "the moved environment is merged from c");
		assert.equal(app.activeEnvironment(), "dev");
		assert.equal(environmentsSetting(), "api-collections/environments");
	});

	it("follows the environments folder moved within the only workspace folder that has environments", async () => {
		await vscode.workspace.fs.delete(folderUri("b", "api-collections"), { recursive: true, useTrash: false });
		await eventually(() => app.environments().join() === "c/api-collections/environments/dev.yml", "only c's environments are left");
		await move(folderUri("c", "api-collections"), folderUri("c", "apis"));
		await eventually(() => environmentsSetting() === "apis/environments", "the setting follows the folder");
		await eventually(() => app.environments().join() === "c/apis/environments/dev.yml", "the environment is listed again");
		assert.equal(app.activeEnvironment(), "dev");
	});
});
