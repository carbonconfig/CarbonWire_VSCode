/// <reference types="mocha" />
import * as assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import * as vscode from "vscode";
import type { TestApi } from "../../src/extension";
import type { CarbonWire } from "../../src/host/carbonwire";


const SHOP = "api-collections/Shop";

async function eventually(check: () => boolean | Promise<boolean>, what: string): Promise<void> {
	const deadline = Date.now() + 5000;
	while (!(await check())) {
		if (Date.now() > deadline) assert.fail(`Timed out waiting until ${what}`);
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
}

describe("Network, globals and the console", () => {
	let api: TestApi;
	let app: CarbonWire;
	let server: Server;
	let base: string;
	let root: string;

	before(async () => {
		api = await vscode.extensions.getExtension<TestApi>("carbonconfig.carbonwire")!.activate();
		app = api.app;
		root = vscode.workspace.workspaceFolders![0]!.uri.fsPath;
		server = createServer((req, res) => {
			if (req.url === "/login") return void res.writeHead(302, { "Set-Cookie": "sid=abc; Path=/; Max-Age=3600", Location: "/me" }).end();
			let body = "";
			req.on("data", (c: Buffer) => (body += c.toString()));
			req.on("end", () => {
				res.setHeader("content-type", "application/json");
				res.end(JSON.stringify({ method: req.method, url: req.url, cookie: req.headers.cookie, auth: req.headers.authorization, body }));
			});
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
		await app.collections();
	});

	after(() => server.close());

	it("keeps cookies across a redirect and sends them next time, and logs each send", async () => {
		const before = app.console.length;
		const request = { http: { method: "POST", url: `${base}/login`, body: { type: "json" as const, data: "{}" } }, settings: { followOriginalHttpMethod: true } };
		await app.send(undefined, "login", request as never, new AbortController().signal);
		const again = await app.send(undefined, "me", { http: { method: "GET", url: `${base}/me` } }, new AbortController().signal);
		const echo = JSON.parse(new TextDecoder().decode(again.response.body)) as { cookie?: string };
		assert.equal(echo.cookie, "sid=abc");
		assert.equal(app.console.length, before + 2);
		assert.equal(app.console.at(-1)?.requestHeaders.find(([n]) => n === "Cookie")?.[1], "sid=abc");
	});

	it("resolves globals as the outermost scope", async () => {
		await vscode.commands.executeCommand("carbonwire.editGlobals");
		await app.store.saveDocument(app.globalsPath(), { name: "globals", variables: [{ name: "host", value: base }] });
		assert.ok(!app.environments().includes(app.globalsPath()), "globals aren't listed as an environment");
		const result = await app.send(undefined, "globals", { http: { method: "GET", url: "{{host}}/g" } }, new AbortController().signal);
		assert.equal(result.response.status, 200);
	});

	it("keeps JWT auth in the sidecar, signs with it, and writes it as code", async () => {
		const path = `${SHOP}/jwt.yml`;
		const request = { info: { name: "jwt", type: "http" as const }, http: { method: "GET", url: `${base}/jwt`, auth: { type: "jwt", algorithm: "HS256", secret: "s", payload: '{"sub":"1"}' } } };
		await app.store.saveRequest(path, request as never);
		const yaml = await readFile(join(root, path), "utf8");
		assert.ok(!yaml.includes("auth:") && !yaml.includes("algorithm"), "the YAML holds no JWT settings");
		const sidecar = JSON.parse(await readFile(join(root, SHOP, ".carbonwire/collection.json"), "utf8")) as { items: Record<string, { auth: { type: string } }> };
		assert.equal(sidecar.items["jwt.yml"]?.auth.type, "jwt");
		const result = await app.send(path, "jwt", await app.store.loadRequest(path), new AbortController().signal);
		const echo = JSON.parse(new TextDecoder().decode(result.response.body)) as { auth?: string };
		assert.match(echo.auth ?? "", /^Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9\./);
		const code = await app.snippet(path, await app.store.loadRequest(path), "python");
		assert.match(code, /^# The request is signed when sending/);
	});

	it("opens the console, the cookie manager and globals without problems", async () => {
		await vscode.commands.executeCommand("carbonwire.openConsole");
		await vscode.commands.executeCommand("carbonwire.manageCookies");
		await eventually(() => [...api.panels.settings].some((t) => t.file === "carbonwire:cookies" && t.loads > 0), "the cookie manager has loaded");
		// A hidden tab's page loads only once it's shown.
		await vscode.commands.executeCommand("carbonwire.editGlobals");
		await eventually(() => [...api.panels.settings].some((t) => t.file === app.globalsPath() && t.loads > 0), "the globals tab has loaded");
		await new Promise((resolve) => setTimeout(resolve, 500));
		assert.deepEqual(api.panels.problems, []);
	});
});
