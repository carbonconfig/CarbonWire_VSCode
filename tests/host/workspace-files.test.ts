import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { CollectionStore } from "../../src/core/storage/store";
import { PathMap } from "../../src/host/paths";
import { DiskFiles } from "../../src/host/workspace-files";

const root = await mkdtemp(join(tmpdir(), "carbonwire-files-"));
afterAll(() => rm(root, { recursive: true, force: true }));
const map = new PathMap([{ name: "app", fsPath: root }]);
const files = new DiskFiles(() => map);

describe("DiskFiles", () => {
	it("writes into new folders and reads back text and bytes", async () => {
		await files.write("api/Users/get.yml", "info:\n  name: get\n");
		expect(files.exists("api/Users/get.yml")).toBe(true);
		expect(files.exists("api/Users")).toBe(true);
		expect(files.exists("api/missing.yml")).toBe(false);
		expect(await files.read("api/Users/get.yml")).toBe("info:\n  name: get\n");
		expect(new TextDecoder().decode(await files.readBinary("api/Users/get.yml"))).toBe("info:\n  name: get\n");
	});

	it("keeps the modified time, plus 1 ms, for order-only writes", async () => {
		await files.write("order.yml", "a: 1\n");
		const before = (await files.stat("order.yml"))!;
		await new Promise((resolve) => setTimeout(resolve, 20));
		await files.write("order.yml", "a: 2\n", { orderOnly: true });
		const after = (await files.stat("order.yml"))!;
		expect(after.mtime - before.mtime).toBeCloseTo(1, 0);
		expect(after.ctime).toBe(before.ctime);

		await files.write("order.yml", "a: 3\n");
		expect((await files.stat("order.yml"))!.mtime).toBeGreaterThan(after.mtime + 5);
	});

	it("reports no stat for folders or missing files", async () => {
		expect(await files.stat("api")).toBeUndefined();
		expect(await files.stat("missing.yml")).toBeUndefined();
	});

	it("backs a collection store", async () => {
		const store = new CollectionStore(files);
		const dir = await store.createCollection("api-collections", "Shop");
		const request = await store.createRequest(dir, "List products");
		expect(request).toBe("api-collections/Shop/List products.yml");
		expect((await stat(join(root, "api-collections", "Shop", "opencollection.yml"))).isFile()).toBe(true);
		expect((await store.loadRequest(request)).info?.name).toBe("List products");
	});
});
