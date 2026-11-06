/// <reference types="mocha" />
import * as assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import * as vscode from "vscode";
import type { TestApi } from "../../src/extension";
import type { RequestTab } from "../../src/host/panels";

const ROOT = "api-collections/Tabs";
const ECHO = `${ROOT}/echo.yml`;
const BODY = JSON.stringify({ items: Array.from({ length: 200 }, (_, i) => ({ id: i, name: `item ${i}` })) });
/* Small bodies come back in a slice of Node's shared buffer pool, which must not leak into the tab. */
const SMALL = JSON.stringify({ ok: true, note: "small" });

async function eventually(check: () => boolean | Promise<boolean>, what: string): Promise<void> {
	const deadline = Date.now() + 10_000;
	while (!(await check())) {
		if (Date.now() > deadline) assert.fail(`Timed out waiting until ${what}`);
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
}

describe("Request and settings tabs", () => {
	let api: TestApi;
	let server: Server;
	let url: string;
	const tabFor = (file: string): RequestTab | undefined => [...api.panels.requests].find((t) => t.file === file);
	const shown = (tab: RequestTab) => tab.view.call("shownResponse");

	before(async () => {
		api = await vscode.extensions.getExtension<TestApi>("carbonconfig.carbonwire")!.activate();
		server = createServer((req, res) => {
			res.setHeader("content-type", "application/json");
			res.end(req.url === "/small" ? SMALL : BODY);
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/items`;
		const root = join(vscode.workspace.workspaceFolders![0]!.uri.fsPath, ROOT);
		await mkdir(root, { recursive: true });
		await writeFile(join(root, "opencollection.yml"), "opencollection: 1.0.0\ninfo:\n  name: Tabs\n");
		await writeFile(join(root, "echo.yml"), `info:\n  name: echo\nhttp:\n  method: GET\n  url: ${url}\n`);
		await eventually(() => api.app.collectionFor(ECHO) !== undefined, "the collection is indexed");
	});

	after(async () => {
		await vscode.commands.executeCommand("workbench.action.closeAllEditors");
		server.close();
	});

	it("opens a saved request, sends it with the Send command, and shows the whole response", async () => {
		api.panels.openRequest(ECHO);
		await eventually(() => (tabFor(ECHO)?.loads ?? 0) > 0, "the tab has loaded");
		const tab = tabFor(ECHO)!;
		await eventually(() => tab.panel.active, "the tab is focused");
		await vscode.commands.executeCommand("carbonwire.sendRequest");
		await eventually(async () => (await shown(tab))?.status === 200, "the response is shown");
		assert.equal((await shown(tab))?.body, BODY);
		assert.deepEqual(api.panels.problems, []);
	});

	it("shows the response again when a hidden tab comes back", async () => {
		const tab = tabFor(ECHO)!;
		api.panels.openDraft({ name: "Other" });
		const other = [...api.panels.requests].find((t) => t.panel.title === "Other")!;
		const times: number[] = [];
		for (let i = 0; i < 5; i++) {
			await eventually(() => !tab.panel.visible, "the first tab is hidden");
			const loads = tab.loads;
			const started = Date.now();
			tab.reveal();
			await eventually(async () => tab.loads > loads && (await shown(tab))?.status === 200, "the first tab shows its response again");
			times.push(Date.now() - started);
			other.reveal();
		}
		console.log(`Switching back to a hidden tab: ${times.join(", ")} ms`);
	});

	it("sends an unsaved request and keeps it in history", async () => {
		api.panels.openDraft({ name: "Draft", request: { http: { method: "GET", url: url.replace("/items", "/small") } } });
		await eventually(() => [...api.panels.requests].some((t) => !t.file && t.panel.title === "Draft" && t.loads > 0), "the draft has loaded");
		const draft = [...api.panels.requests].find((t) => t.panel.title === "Draft")!;
		await eventually(() => draft.panel.active, "the draft is focused");
		await vscode.commands.executeCommand("carbonwire.sendRequest");
		await eventually(async () => (await shown(draft))?.status === 200, "the draft's response is shown");
		assert.equal((await shown(draft))?.body, SMALL);
		const [latest] = await api.app.history.list();
		assert.equal(latest?.name, "Draft");
		assert.equal(latest?.source, undefined);
	});

	it("opens collection settings and environments without problems", async () => {
		api.panels.openSettings(`${ROOT}/opencollection.yml`);
		await eventually(() => [...api.panels.settings].some((t) => t.file === `${ROOT}/opencollection.yml` && t.loads > 0), "collection settings have loaded");
		const environment = api.app.environments()[0];
		if (environment) {
			api.panels.openSettings(environment);
			await eventually(() => [...api.panels.settings].some((t) => t.file === environment && t.loads > 0), "the environment has loaded");
		}
		await new Promise((resolve) => setTimeout(resolve, 300));
		assert.deepEqual(api.panels.problems, []);
	});

	it("follows a rename, and closes when the request is deleted in CarbonWire", async () => {
		const tab = tabFor(ECHO)!;
		const renamed = await api.app.actions.renameRequest(ECHO, "echo all");
		assert.equal(tab.file, renamed);
		assert.equal(tab.panel.title, "echo all");
		await api.app.actions.deleteRequest(renamed!);
		await eventually(() => !api.panels.requests.has(tab), "the tab has closed");
	});
});
