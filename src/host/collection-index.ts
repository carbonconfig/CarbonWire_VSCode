import { sortCollections, type FileTimes, type SortOrder } from "../core/storage/order";
import { basename, dirname } from "../core/storage/paths";
import { buildCollections, COLLECTION_FILE, compare, extractMeta, FOLDER_FILE, isYaml, type CollectionNode, type FileMeta, type TreeNode } from "../core/storage/tree";
import { debounce } from "./debounce";
import type { FileStat } from "./workspace-files";

const META_BATCH = 100;

/** Metadata with the file's modified time and size when it was read, plus its creation time. */
export type MetaEntry = [mtime: number, size: number, meta: FileMeta, ctime: number];

export interface IndexSource {
	/** Every YAML file in the workspace, or inside the folder `dir`. */
	listYaml(dir?: string): Promise<string[]>;
	stat(path: string): Promise<FileStat | undefined>;
	read(path: string): Promise<string>;
}

export interface IndexOptions {
	rootName(): string;
	sortOrder(): SortOrder;
	collectionOrder(): readonly string[];
	environmentsFolder(): string;
	changed(collections: CollectionNode[]): void;
	loadCache(): Record<string, MetaEntry> | undefined;
	saveCache(cache: Record<string, MetaEntry>): PromiseLike<void>;
}

/**
 * The collection trees, built from YAML paths, and each file's method, order and colour. That metadata
 * is cached, shown straight away, then checked against each file's time and size in the background.
 */
export class CollectionIndex {
	private readonly paths = new Set<string>();
	private scanning?: Promise<void>;
	private scanned = false;
	private manual?: CollectionNode[];
	private sorted?: CollectionNode[];
	private environmentFiles?: string[];
	private readonly meta = new Map<string, MetaEntry>();
	/** Cached entries not yet checked against the file on disk. */
	private readonly unverified = new Set<string>();
	private metaLoading?: Promise<void>;

	readonly refresh = debounce(() => this.rebuild(), 150);
	private readonly resort = debounce(() => {
		this.sorted = undefined;
		this.options.changed(this.collections());
	}, 150);
	private readonly saveCache = debounce(() => void this.flush(), 2000);

	constructor(private readonly source: IndexSource, private readonly options: IndexOptions) {}

	/** Lists the workspace's YAML files on first use; later changes come in through the file events below. */
	ready(): Promise<void> {
		this.scanning ??= (async () => {
			const cached = this.options.loadCache();
			for (const [path, entry] of Object.entries(cached ?? {})) {
				if (!Array.isArray(entry) || entry.length !== 4) continue;
				this.meta.set(path, entry);
				this.unverified.add(path);
			}
			for (const path of await this.source.listYaml()) this.paths.add(path);
			this.scanned = true;
			this.rebuild();
		})();
		return this.scanning;
	}

	/** Forgets every path, e.g. when workspace folders change, and lists them again. */
	reset(): Promise<void> {
		void this.flush();
		this.paths.clear();
		this.meta.clear();
		this.unverified.clear();
		this.scanned = false;
		this.scanning = undefined;
		return this.ready();
	}

	/** Collections in the sidebar's sort order; empty until the first scan finishes. */
	collections(): CollectionNode[] {
		this.sorted ??= sortCollections(this.manualTree(), this.options.sortOrder(), (path) => this.times(path), this.options.collectionOrder());
		return this.sorted;
	}

	/** Collections in their saved order, whatever the sidebar shows; dragging edits this order. */
	manualTree(): CollectionNode[] {
		if (!this.manual) {
			const meta = new Map([...this.meta].map(([path, entry]) => [path, entry[2]]));
			this.manual = buildCollections(this.paths, this.options.rootName(), meta);
			if (this.scanned) this.loadMeta();
		}
		return this.manual;
	}

	collectionFor(path: string): CollectionNode | undefined {
		let best: CollectionNode | undefined;
		for (const c of this.manualTree()) {
			if ((c.root === "" || path.startsWith(`${c.root}/`)) && (!best || c.root.length > best.root.length)) best = c;
		}
		return best;
	}

	/** YAML files directly inside the environments folder, by name. */
	environments(): string[] {
		if (!this.environmentFiles) {
			const folder = this.options.environmentsFolder();
			this.environmentFiles = [...this.paths].filter((p) => dirname(p) === folder).sort(compare);
		}
		return this.environmentFiles;
	}

	metaFor(path: string): FileMeta | undefined {
		return this.meta.get(path)?.[2];
	}

	times(path: string): FileTimes | undefined {
		const entry = this.meta.get(path);
		return entry && { mtime: entry[0], ctime: entry[3] };
	}

	has(path: string): boolean {
		return this.paths.has(path);
	}

	rebuild(): void {
		this.refresh.cancel();
		this.manual = undefined;
		this.sorted = undefined;
		this.environmentFiles = undefined;
		this.options.changed(this.collections());
	}

	/** Records a `seq` just written, so the tree needn't wait for the file to be read back. */
	noteSeq(path: string, seq: number): void {
		const entry = this.meta.get(path);
		this.meta.set(path, [entry?.[0] ?? 0, entry?.[1] ?? 0, { ...entry?.[2], seq }, entry?.[3] ?? 0]);
		this.saveCache();
	}

	created(path: string): void {
		if (!isYaml(path) || this.paths.has(path)) return;
		this.paths.add(path);
		this.environmentFiles = undefined;
		if (basename(path) === COLLECTION_FILE || this.isTracked(path)) void this.readMeta(path).then(() => this.refresh());
	}

	/** A folder appeared, e.g. moved in; only the folder itself is reported, so its files are listed. */
	async folderCreated(dir: string): Promise<void> {
		let added = false;
		for (const path of await this.source.listYaml(dir)) {
			if (this.paths.has(path)) continue;
			this.paths.add(path);
			added = true;
		}
		if (added) this.refresh();
	}

	deleted(path: string): void {
		let removed = false;
		for (const p of [...this.paths]) {
			if (p !== path && !p.startsWith(`${path}/`)) continue;
			this.paths.delete(p);
			this.meta.delete(p);
			removed = true;
		}
		if (!removed) return;
		this.refresh();
		this.saveCache();
	}

	/** Returns whether the file is part of a collection or an environment. */
	changed(path: string): boolean {
		if (!this.paths.has(path) || !this.isTracked(path)) return false;
		void this.readMeta(path).then((changed) => {
			if (changed) this.refresh();
			// Sorting by last update reorders on every save, without rebuilding the trees.
			else if (this.options.sortOrder().startsWith("modified")) this.resort();
		});
		return true;
	}

	/** A file or folder was renamed or moved; its metadata moves with it. */
	renamed(from: string, to: string): void {
		let moved = false;
		for (const p of [...this.paths]) {
			if (p !== from && !p.startsWith(`${from}/`)) continue;
			const next = to + p.slice(from.length);
			this.paths.delete(p);
			this.paths.add(next);
			const entry = this.meta.get(p);
			this.meta.delete(p);
			if (entry) this.meta.set(next, entry);
			moved = true;
		}
		if (!moved) return;
		this.rebuild();
		this.saveCache();
	}

	/** Writes the metadata cache now, e.g. when the extension stops. */
	async flush(): Promise<void> {
		this.saveCache.cancel();
		if (this.scanned) await this.options.saveCache(Object.fromEntries(this.meta));
	}

	private isTracked(path: string): boolean {
		return dirname(path) === this.options.environmentsFolder() || this.collectionFor(path) !== undefined;
	}

	/** Reads files without verified metadata in the background, in batches that keep the host responsive. */
	private loadMeta(): void {
		if (this.metaLoading) return;
		const pending: string[] = [];
		const add = (path: string) => {
			if (!this.meta.has(path) || this.unverified.has(path)) pending.push(path);
		};
		const walk = (nodes: readonly TreeNode[]) => {
			for (const n of nodes) {
				if (n.kind === "request") add(n.path);
				else {
					if (n.hasConfig) add(`${n.path}/${FOLDER_FILE}`);
					walk(n.children);
				}
			}
		};
		for (const c of this.manual ?? []) walk(c.children);
		for (const path of this.environments()) add(path);
		if (pending.length === 0) return;
		this.metaLoading = (async () => {
			let changed = false;
			for (let i = 0; i < pending.length; i += META_BATCH) {
				const results = await Promise.all(pending.slice(i, i + META_BATCH).map((p) => this.readMeta(p).catch(() => false)));
				changed ||= results.some(Boolean);
				await new Promise((resolve) => setImmediate(resolve));
			}
			// Entries cached for files that no longer exist.
			for (const path of this.unverified) if (!this.paths.has(path)) this.meta.delete(path);
			this.unverified.clear();
			if (changed || this.options.sortOrder() !== "manual") this.rebuild();
			await this.flush();
		})().finally(() => (this.metaLoading = undefined));
	}

	/** Returns whether the file's method, order or colour changed. */
	private async readMeta(path: string): Promise<boolean> {
		const stat = await this.source.stat(path);
		const prev = this.meta.get(path);
		this.unverified.delete(path);
		if (!stat) {
			// Gone before it could be read; recorded as empty so it isn't read again and again.
			this.meta.set(path, [0, 0, {}, 0]);
			return false;
		}
		if (prev && prev[0] === stat.mtime && prev[1] === stat.size) {
			prev[3] = stat.ctime;
			return false;
		}
		const next = extractMeta(await this.source.read(path));
		this.meta.set(path, [stat.mtime, stat.size, next, stat.ctime]);
		this.saveCache();
		return prev?.[2].method !== next.method || prev?.[2].seq !== next.seq || prev?.[2].color !== next.color;
	}
}
