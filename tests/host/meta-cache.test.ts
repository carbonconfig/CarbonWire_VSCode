import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { MetaEntry } from "../../src/host/collection-index";
import { MetaCacheFile } from "../../src/host/meta-cache";

const root = await mkdtemp(join(tmpdir(), "carbonwire-meta-"));
afterAll(() => rm(root, { recursive: true, force: true }));

function memento(values: Record<string, unknown> = {}) {
	return {
		values,
		keys: () => Object.keys(values),
		get: <T>(key: string, fallback?: T) => (key in values ? (values[key] as T) : fallback),
		update: async (key: string, value: unknown) => {
			if (value === undefined) delete values[key];
			else values[key] = value;
		},
	};
}

const entry: MetaEntry = [1, 2, { method: "GET", seq: 3 }, 4];

describe("MetaCacheFile", () => {
	it("moves the cache out of workspace state on first load", async () => {
		const state = memento({ metaCache: { "a.yml": entry } });
		const file = join(root, "moved", "meta-cache.json");
		const cache = new MetaCacheFile(file, state);
		expect(await cache.load()).toEqual({ "a.yml": entry });
		expect(state.values).toEqual({});
		await cache.save({ "b.yml": entry });
		expect(JSON.parse(await readFile(file, "utf8"))).toEqual({ "b.yml": entry });
	});

	it("loads what was saved just before, without waiting", async () => {
		const cache = new MetaCacheFile(join(root, "queued", "meta-cache.json"), memento());
		expect(await cache.load()).toBeUndefined();
		void cache.save({ "c.yml": entry });
		expect(await cache.load()).toEqual({ "c.yml": entry });
	});
});
