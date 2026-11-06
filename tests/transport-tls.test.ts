import { readFileSync } from "node:fs";
import * as https from "node:https";
import { createRequire, syncBuiltinESMExports } from "node:module";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NodeTransport } from "../src/core/transport/node";
import type { TransportRequest } from "../src/core/transport/types";

let server: https.Server;
let base: string;

const request = (url: string, rejectUnauthorized: boolean): TransportRequest => ({
	method: "GET",
	url,
	headers: [],
	timeoutMs: 5000,
	followRedirects: false,
	maxRedirects: 0,
	forwardAuthorizationHeader: false,
	rejectUnauthorized,
	maxBodyBytes: 1_000_000,
});

beforeAll(async () => {
	const certs = join(import.meta.dirname, "certs");
	server = https.createServer({ key: readFileSync(join(certs, "localhost.key")), cert: readFileSync(join(certs, "localhost.crt")) }, (_req, res) => res.end("secure"));
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	base = `https://localhost:${(server.address() as AddressInfo).port}`;
});

afterAll(() => server.close());

describe("NodeTransport over HTTPS", () => {
	it("verifies certificates unless told not to, and reuses the connection", async () => {
		const transport = new NodeTransport();
		await expect(transport.send(request(`${base}/a`, true))).rejects.toMatchObject({ systemError: { code: "DEPTH_ZERO_SELF_SIGNED_CERT" } });
		const first = await transport.send(request(`${base}/a`, false));
		expect(new TextDecoder().decode(first.body)).toBe("secure");
		expect(first.timings).toMatchObject({ reusedConnection: false });
		expect(first.timings.tls).toBeGreaterThan(0);
		const second = await transport.send(request(`${base}/b`, false));
		expect(second.timings).toMatchObject({ reusedConnection: true, tls: 0 });
		transport.dispose();
	});

	it("goes through http.request, where VS Code applies its proxy, only when asked", async () => {
		const calls: string[] = [];
		// Patches the module the way VS Code does, so the transport's import sees it too.
		const module = createRequire(import.meta.url)("node:https") as { request: typeof https.request };
		const original = module.request;
		module.request = ((...args: Parameters<typeof https.request>) => {
			calls.push("https.request");
			return original(...args);
		}) as typeof https.request;
		syncBuiltinESMExports();
		try {
			let viaProxy = false;
			const transport = new NodeTransport("test", { viaHostProxy: () => viaProxy });
			await transport.send(request(`${base}/direct`, false));
			expect(calls).toEqual([]);
			viaProxy = true;
			await transport.send(request(`${base}/proxied`, false));
			expect(calls).toEqual(["https.request"]);
			transport.dispose();
		} finally {
			module.request = original;
			syncBuiltinESMExports();
		}
	});
});
