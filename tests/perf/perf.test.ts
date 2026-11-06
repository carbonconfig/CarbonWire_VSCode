/// <reference types="mocha" />
import * as assert from "node:assert/strict";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { Agent, createServer, request as httpRequest, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import * as vscode from "vscode";
import type { TestApi } from "../../src/extension";

/*
 * Times CarbonWire in VS Code on a workspace of 5,000 requests (see .vscode-test.mjs) and prints a
 * table. Assertions only catch large regressions, at five times a target.
 */

const REQUESTS = 5000;
/* Opt-in, since it needs several gigabytes free: CARBONWIRE_PERF_JSON_MB=50 npm run test:perf */
const BIG_BYTES = Number(process.env.CARBONWIRE_PERF_JSON_MB ?? 0) * 1024 * 1024;

interface Row {
	measure: string;
	result: string;
	budget: string;
}

async function eventually(check: () => boolean | Promise<boolean>, what: string, timeout = 60_000): Promise<void> {
	const deadline = Date.now() + timeout;
	while (!(await check())) {
		if (Date.now() > deadline) assert.fail(`Timed out waiting until ${what}`);
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}

const ms = (n: number) => (n >= 100 ? `${Math.round(n)} ms` : `${n.toFixed(1)} ms`);
const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]!;

describe("Performance", () => {
	let api: TestApi;
	let server: Server;
	let base: string;
	let root: string;
	let bigBytes = 0;
	const rows: Row[] = [];
	const record = (measure: string, value: number, budget: string, limit?: number) => {
		rows.push({ measure, result: ms(value), budget });
		if (limit !== undefined) assert.ok(value < limit * 5, `${measure} took ${ms(value)}, over five times its budget of ${budget}`);
	};

	before(async () => {
		root = vscode.workspace.workspaceFolders![0]!.uri.fsPath;
		const big = BIG_BYTES ? JSON.stringify(Array.from({ length: Math.ceil(BIG_BYTES / 52) }, (_, i) => ({ id: i, name: `item ${i}`, tags: ["a", "b"] }))) : "";
		bigBytes = Buffer.byteLength(big);
		server = createServer((req, res) => {
			res.setHeader("content-type", "application/json");
			res.end(req.url === "/big" ? big : '{"ok":true}');
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	});

	after(() => {
		server.close();
		const width = Math.max(...rows.map((r) => r.measure.length));
		console.log(`\nCarbonWire in VS Code ${vscode.version}, ${REQUESTS.toLocaleString()} requests\n`);
		for (const r of rows) console.log(`  ${r.measure.padEnd(width)}  ${r.result.padStart(9)}   budget ${r.budget}`);
		console.log("");
	});

	it("activates", async () => {
		const extension = vscode.extensions.getExtension<TestApi>("carbonconfig.carbonwire")!;
		const started = performance.now();
		api = await extension.activate();
		const total = performance.now() - started;
		record("Activation: activate() itself", api.activation.ended - api.activation.started, "< 10 ms", 10);
		record("Activation: VS Code loading the module, and the rest", total - (api.activation.ended - api.activation.started), "n/a");
	});

	it("indexes 5,000 requests, then reads their methods and order", async () => {
		const started = performance.now();
		await api.app.index.reset();
		const indexed = performance.now() - started;
		const requests = () => api.app.index.collections().flatMap((c) => c.children.flatMap((f) => (f.kind === "folder" ? f.children : [f])));
		assert.equal(requests().length, REQUESTS);
		assert.ok(!api.app.index.collections().some((c) => c.root.includes("node_modules")));
		record("Index 5,000 requests (find files, build trees)", indexed, "< 100 ms");
		// VS Code's file search, against a directory walk that skips node_modules and .git.
		let t = performance.now();
		const found = await vscode.workspace.findFiles("**/*.{yml,yaml}", "**/{node_modules,.git}/**");
		record(`  of which findFiles (${found.length} files)`, performance.now() - t, "n/a");
		t = performance.now();
		const walked: string[] = [];
		const walk = async (dir: string): Promise<void> => {
			const entries = await readdir(dir, { withFileTypes: true });
			await Promise.all(
				entries.map(async (e) => {
					if (e.isDirectory()) {
						if (e.name !== "node_modules" && e.name !== ".git") await walk(join(dir, e.name));
					} else if (/\.ya?ml$/i.test(e.name)) walked.push(join(dir, e.name));
				}),
			);
		};
		await walk(root);
		record(`  a Node directory walk instead (${walked.length} files)`, performance.now() - t, "n/a");
		await eventually(() => requests().every((r) => r.kind === "request" && r.method !== undefined), "every method has been read");
		record("Read methods and order from every file", performance.now() - started - indexed, "background");
		// Again, with the metadata cache saved: cached methods show straight away.
		await api.app.index.flush();
		const again = performance.now();
		await api.app.index.reset();
		assert.ok(requests().every((r) => r.kind === "request" && r.method !== undefined), "cached methods show straight away");
		record("Index again, with methods from the cache", performance.now() - again, "< 100 ms", 100);
	});

	it("paints the sidebar", async () => {
		const started = Date.now();
		await vscode.commands.executeCommand("carbonwire.openCollections");
		await eventually(() => api.sidebar.metrics.some((m) => m.name === "sidebarPainted"), "the sidebar has painted");
		const at = (name: string) => api.sidebar.metrics.find((m) => m.name === name)!.value - started;
		record("Sidebar first paint, from the command", at("sidebarPainted"), "< 150 ms");
		for (const step of ["resolved", "scriptStarted", "readyCalled", "stateReceived", "mounted"]) record(`  ${step}`, at(step), "n/a");
		record("  CarbonWire's part: script start to paint", at("sidebarPainted") - at("scriptStarted"), "< 100 ms");
	});

	it("opens request tabs", async () => {
		const times: number[] = [];
		for (let i = 0; i < 5; i++) {
			const before = api.panels.metrics.filter((m) => m.name === "requestPainted").length;
			const started = Date.now();
			api.panels.openRequest(`api-collections/Service ${i}/Area 0/Request 0.yml`);
			await eventually(() => api.panels.metrics.filter((m) => m.name === "requestPainted").length > before, "the tab has painted");
			times.push(api.panels.metrics.filter((m) => m.name === "requestPainted")[before]!.value - started);
		}
		record("Open the first request tab", times[0]!, "< 150 ms", 150);
		record("Open another request tab (median of 4)", median(times.slice(1)), "< 150 ms", 150);
	});

	it("adds little to each send", async () => {
		const agent = new Agent({ keepAlive: true });
		const raw = () =>
			new Promise<void>((resolve, reject) => {
				httpRequest(`${base}/small`, { agent }, (res) => {
					res.resume();
					res.on("end", resolve);
				})
					.on("error", reject)
					.end();
			});
		const request = { http: { method: "GET", url: `${base}/small` } };
		const signal = new AbortController().signal;
		for (let i = 0; i < 50; i++) {
			await raw();
			await api.app.send(undefined, "warm-up", request, signal);
		}
		const rawTimes: number[] = [];
		const sendTimes: number[] = [];
		for (let i = 0; i < 300; i++) {
			let t = performance.now();
			await raw();
			rawTimes.push(performance.now() - t);
			t = performance.now();
			await api.app.send(undefined, "overhead", request, signal);
			sendTimes.push(performance.now() - t);
		}
		agent.destroy();
		record("GET with Node's http module (median)", median(rawTimes), "n/a");
		record("Same GET through CarbonWire's send (median)", median(sendTimes), "< raw + 1 ms", median(rawTimes) + 1);

		// From the Send command in a tab to the response on screen.
		api.panels.openDraft({ name: "Round trip", request });
		await eventually(() => [...api.panels.requests].some((t) => t.panel.title === "Round trip" && t.loads > 0 && t.panel.active), "the tab is open");
		const roundTrips: number[] = [];
		for (let i = 0; i < 5; i++) {
			const before = api.panels.metrics.filter((m) => m.name === "responsePainted").length;
			const started = Date.now();
			await vscode.commands.executeCommand("carbonwire.sendRequest");
			await eventually(() => api.panels.metrics.filter((m) => m.name === "responsePainted").length > before, "the response has painted");
			roundTrips.push(api.panels.metrics.filter((m) => m.name === "responsePainted")[before]!.value - started);
		}
		record("Send in a tab to response on screen (median)", median(roundTrips), "n/a");
	});

	it("shows a large JSON response without blocking the tab", async function () {
		if (!BIG_BYTES) this.skip();
		// When run on its own with --grep, nothing has activated the extension yet.
		if (!(api as TestApi | undefined)) api = await vscode.extensions.getExtension<TestApi>("carbonconfig.carbonwire")!.activate();
		const dir = join(root, "api-collections", "Big");
		await mkdir(dir, { recursive: true });
		await writeFile(join(dir, "opencollection.yml"), "opencollection: 1.0.0\ninfo:\n  name: Big\n");
		await writeFile(join(dir, "huge.yml"), `info:\n  name: huge\nhttp:\n  method: GET\n  url: ${base}/big\n`);
		await eventually(() => api.app.collectionFor("api-collections/Big/huge.yml") !== undefined, "the request is indexed");
		const painted = api.panels.metrics.filter((m) => m.name === "requestPainted").length;
		api.panels.openRequest("api-collections/Big/huge.yml");
		await eventually(() => api.panels.metrics.filter((m) => m.name === "requestPainted").length > painted, "the tab has painted");
		const tab = [...api.panels.requests].find((t) => t.file === "api-collections/Big/huge.yml")!;
		await eventually(() => tab.panel.active, "the tab is focused");

		const firstMetric = api.panels.metrics.length;
		const before = api.panels.metrics.filter((m) => m.name === "responsePainted").length;
		const started = Date.now();
		await vscode.commands.executeCommand("carbonwire.sendRequest");
		await eventually(() => api.panels.metrics.filter((m) => m.name === "responsePainted").length > before, "the response has painted", 120_000);
		const shown = api.panels.metrics.filter((m) => m.name === "responsePainted")[before]!.value - started;
		// Pretty-printing runs in a worker after the response first shows.
		await new Promise((resolve) => setTimeout(resolve, 5000));
		const tasks = api.panels.metrics.slice(firstMetric).filter((m) => m.name === "longtask").map((m) => m.value);
		const [latest] = await api.app.history.list();
		assert.equal(latest?.response?.bodyBytes, bigBytes);
		record(`${(bigBytes / 1024 / 1024).toFixed(0)} MB JSON: Send to response on screen`, shown, "n/a");
		record(`Large JSON: longest task in the tab (${tasks.length} over 50 ms)`, tasks.length ? Math.max(...tasks) : 0, "< 50 ms");
	});
});
