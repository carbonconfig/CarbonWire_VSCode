import { describe, expect, it } from "vitest";
import type { SortOrder } from "../../src/core/storage/order";
import type { CollectionNode, TreeNode } from "../../src/core/storage/tree";
import { CollectionIndex, type MetaEntry } from "../../src/host/collection-index";

interface Disk {
	text: string;
	mtime: number;
	ctime: number;
}

/** A workspace in memory, counting reads so caching can be checked. */
function setup(initial: Record<string, string>, options: { cache?: Record<string, MetaEntry>; sortOrder?: SortOrder } = {}) {
	const disk = new Map<string, Disk>(Object.entries(initial).map(([path, text], i) => [path, { text, mtime: 1000 + i, ctime: 500 + i }]));
	const reads: string[] = [];
	const changes: CollectionNode[][] = [];
	let saved: Record<string, MetaEntry> | undefined;
	const index = new CollectionIndex(
		{
			listYaml: async (dir) => [...disk.keys()].filter((p) => dir === undefined || p.startsWith(`${dir}/`)),
			stat: async (path) => {
				const file = disk.get(path);
				return file && { mtime: file.mtime, ctime: file.ctime, size: file.text.length };
			},
			read: async (path) => {
				reads.push(path);
				return disk.get(path)!.text;
			},
		},
		{
			rootName: () => "app",
			sortOrder: () => options.sortOrder ?? "manual",
			collectionOrder: () => [],
			environmentsFolder: () => "api-collections/environments",
			changed: (collections) => changes.push(collections),
			loadCache: () => options.cache,
			saveCache: async (cache) => {
				saved = cache;
			},
		},
	);
	const write = (path: string, text: string) => {
		const prev = disk.get(path);
		disk.set(path, { text, mtime: (prev?.mtime ?? 2000) + 10, ctime: prev?.ctime ?? 2000 });
	};
	/** Waits for background metadata reads and debounced rebuilds. */
	const settle = () => new Promise((resolve) => setTimeout(resolve, 200));
	return { index, disk, reads, changes, write, settle, saved: () => saved };
}

const names = (nodes: readonly TreeNode[]): string[] => nodes.map((n) => (n.kind === "folder" ? `${n.name}/` : `${n.name}${n.method ? ` ${n.method}` : ""}`));

const SHOP = {
	"api-collections/Shop/opencollection.yml": "opencollection: 1.0.0\ninfo:\n  name: Shop\n",
	"api-collections/Shop/Products/folder.yml": "info:\n  name: Products\n  seq: 1\n",
	"api-collections/Shop/Products/list.yml": "info:\n  name: list\nhttp:\n  method: GET\n",
	"api-collections/Shop/Products/create.yml": "info:\n  name: create\nhttp:\n  method: post\n",
	"api-collections/environments/dev.yml": "name: dev\ncolor: '#27AE60'\n",
	"deploy/chart.yaml": "kind: Deployment\n",
};

describe("CollectionIndex", () => {
	it("is empty until the first scan, then builds trees and reads methods in the background", async () => {
		const { index, settle } = setup(SHOP);
		expect(index.collections()).toEqual([]);
		await index.ready();
		const [shop] = index.collections();
		expect(shop).toMatchObject({ root: "api-collections/Shop", name: "Shop" });
		await settle();
		const products = index.collections()[0]!.children[0]!;
		expect(products.kind === "folder" && names(products.children)).toEqual(["create POST", "list GET"]);
		expect(index.environments()).toEqual(["api-collections/environments/dev.yml"]);
		expect(index.metaFor("api-collections/environments/dev.yml")?.color).toBe("#27AE60");
		expect(index.collectionFor("api-collections/Shop/Products/list.yml")?.root).toBe("api-collections/Shop");
		expect(index.collectionFor("deploy/chart.yaml")).toBeUndefined();
	});

	it("reuses cached metadata for files that haven't changed, and reads the rest", async () => {
		const first = setup(SHOP);
		await first.index.ready();
		await first.settle();
		await first.index.flush();
		const cache = first.saved()!;
		expect(Object.keys(cache)).toContain("api-collections/Shop/Products/list.yml");
		expect(Object.keys(cache)).not.toContain("deploy/chart.yaml");

		const second = setup(SHOP, { cache });
		second.write("api-collections/Shop/Products/list.yml", "info:\n  name: list\nhttp:\n  method: DELETE\n");
		await second.index.ready();
		await second.settle();
		expect(second.reads).toEqual(["api-collections/Shop/Products/list.yml"]);
		const products = second.index.collections()[0]!.children[0]!;
		expect(products.kind === "folder" && names(products.children)).toEqual(["create POST", "list DELETE"]);
	});

	it("follows files and folders that are created, changed, renamed and deleted", async () => {
		const { index, disk, write, settle } = setup(SHOP);
		await index.ready();
		await settle();

		write("api-collections/Shop/Products/delete.yml", "http:\n  method: DELETE\n");
		index.created("api-collections/Shop/Products/delete.yml");
		await settle();
		let products = index.collections()[0]!.children[0]!;
		expect(products.kind === "folder" && names(products.children)).toEqual(["create POST", "delete DELETE", "list GET"]);

		write("api-collections/Shop/Products/list.yml", "http:\n  method: PUT\n");
		expect(index.changed("api-collections/Shop/Products/list.yml")).toBe(true);
		expect(index.changed("deploy/chart.yaml")).toBe(false);
		await settle();
		products = index.collections()[0]!.children[0]!;
		expect(products.kind === "folder" && names(products.children)).toContain("list PUT");

		index.renamed("api-collections/Shop/Products", "api-collections/Shop/Items");
		expect(index.collections()[0]!.children.map((n) => n.path)).toEqual(["api-collections/Shop/Items"]);
		expect(index.metaFor("api-collections/Shop/Items/list.yml")?.method).toBe("PUT");

		index.deleted("api-collections/Shop/Items");
		await settle();
		expect(index.collections()[0]!.children).toEqual([]);

		// A folder moved in from outside VS Code is reported on its own; its files are listed.
		for (const name of ["a", "b"]) disk.set(`api-collections/Shop/Moved/${name}.yml`, { text: "http:\n  method: GET\n", mtime: 1, ctime: 1 });
		await index.folderCreated("api-collections/Shop/Moved");
		await settle();
		const moved = index.collections()[0]!.children[0]!;
		expect(moved.kind === "folder" && names(moved.children)).toEqual(["a GET", "b GET"]);

		disk.set("api-collections/Other/opencollection.yml", { text: "info: {}\n", mtime: 1, ctime: 1 });
		index.created("api-collections/Other/opencollection.yml");
		await settle();
		expect(index.collections().map((c) => c.name)).toEqual(["Other", "Shop"]);
	});

	it("shows a dragged item's new order before the file is read back", async () => {
		const { index, settle } = setup(SHOP);
		await index.ready();
		await settle();
		index.noteSeq("api-collections/Shop/Products/list.yml", 1);
		index.noteSeq("api-collections/Shop/Products/create.yml", 2);
		index.rebuild();
		const products = index.collections()[0]!.children[0]!;
		expect(products.kind === "folder" && names(products.children)).toEqual(["list GET", "create POST"]);
	});

	it("sorts by file times once they are known", async () => {
		const { index, write, settle } = setup(SHOP, { sortOrder: "modified-desc" });
		await index.ready();
		await settle();
		write("api-collections/Shop/Products/create.yml", "http:\n  method: POST\n");
		write("api-collections/Shop/Products/list.yml", "http:\n  method: GET\n");
		write("api-collections/Shop/Products/list.yml", "http:\n  method: GET\n");
		index.changed("api-collections/Shop/Products/create.yml");
		index.changed("api-collections/Shop/Products/list.yml");
		await settle();
		const products = index.collections()[0]!.children[0]!;
		expect(products.kind === "folder" && products.children.map((n) => n.name)).toEqual(["list", "create"]);
	});

	it("drops cached entries for files that no longer exist", async () => {
		const cache: Record<string, MetaEntry> = { "api-collections/Shop/gone.yml": [1, 1, { method: "GET" }, 1] };
		const { index, settle, saved } = setup(SHOP, { cache });
		await index.ready();
		await settle();
		expect(index.metaFor("api-collections/Shop/gone.yml")).toBeUndefined();
		await index.flush();
		expect(saved()).not.toHaveProperty(["api-collections/Shop/gone.yml"]);
	});
});
