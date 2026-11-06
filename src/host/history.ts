import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { HistoryEntry } from "../core/history";
import type { TransportResponse } from "../core/transport/types";

export type { HistoryEntry, HistoryResponse } from "../core/history";

/* Bodies past this are cut short in history; the full size is still recorded. */
const BODY_LIMIT = 1024 * 1024;
const INDEX_FILE = "history.json";
const BODIES_DIR = "bodies";

export type NewHistoryEntry = Omit<HistoryEntry, "id" | "response"> & { response?: TransportResponse };

interface IndexFile {
	nextId: number;
	entries: HistoryEntry[];
}

/**
 * History in the extension's storage for this workspace, so it never reaches the repository. One
 * small JSON index lists the entries; each body is its own file.
 */
export class HistoryStore {
	/** Newest first, once loaded. */
	private entries?: HistoryEntry[];
	private nextId = 1;
	private loading?: Promise<HistoryEntry[]>;
	/** Writes run one at a time, in order. */
	private queue: Promise<unknown> = Promise.resolve();

	constructor(
		private readonly dir: string,
		private readonly limit: () => number,
		private readonly changed: () => void,
	) {}

	list(): Promise<HistoryEntry[]> {
		if (this.entries) return Promise.resolve(this.entries);
		this.loading ??= (async () => {
			const saved = await readFile(join(this.dir, INDEX_FILE), "utf8")
				.then((text) => JSON.parse(text) as IndexFile)
				.catch(() => undefined);
			this.entries = (saved?.entries ?? []).sort((a, b) => b.id - a.id);
			this.nextId = Math.max(saved?.nextId ?? 1, (this.entries[0]?.id ?? 0) + 1);
			await this.prune();
			return this.entries;
		})().finally(() => (this.loading = undefined));
		return this.loading;
	}

	async get(id: number): Promise<{ entry: HistoryEntry; body: Uint8Array } | undefined> {
		const entry = (await this.list()).find((e) => e.id === id);
		if (!entry) return undefined;
		const body = await readFile(this.bodyPath(id)).catch(() => undefined);
		return { entry, body: body ? new Uint8Array(body) : new Uint8Array() };
	}

	/** The most recent send of a saved request. */
	async latestFor(source: string): Promise<HistoryEntry | undefined> {
		return (await this.list()).find((e) => e.source === source);
	}

	/** Keeps entries pointing at a request after it, or a folder above it, is renamed or moved. */
	async moveSource(from: string, to: string): Promise<void> {
		const moved = (await this.list()).filter((e) => e.source === from || e.source?.startsWith(`${from}/`));
		if (moved.length === 0) return;
		for (const entry of moved) entry.source = to + entry.source!.slice(from.length);
		await this.saveIndex();
		this.changed();
	}

	async add(next: NewHistoryEntry): Promise<void> {
		if (this.limit() <= 0) return;
		const entries = await this.list();
		const { response, ...rest } = next;
		const entry: HistoryEntry = {
			...rest,
			id: this.nextId++,
			response: response && {
				status: response.status,
				statusText: response.statusText,
				headers: response.headers,
				bodyBytes: response.bodyBytes,
				truncated: response.truncated || response.body.byteLength > BODY_LIMIT,
				httpVersion: response.httpVersion,
				timings: response.timings,
			},
		};
		if (response) {
			await this.enqueue(async () => {
				await mkdir(join(this.dir, BODIES_DIR), { recursive: true });
				await writeFile(this.bodyPath(entry.id), response.body.subarray(0, BODY_LIMIT));
			});
		}
		entries.unshift(entry);
		await this.prune();
		await this.saveIndex();
		this.changed();
	}

	async remove(ids: readonly number[]): Promise<void> {
		if (ids.length === 0) return;
		const removed = new Set(ids);
		this.entries = (await this.list()).filter((e) => !removed.has(e.id));
		await this.saveIndex();
		await this.enqueue(() => Promise.all(ids.map((id) => rm(this.bodyPath(id), { force: true }))));
		this.changed();
	}

	async clear(): Promise<void> {
		await this.remove((await this.list()).map((e) => e.id));
	}

	/** Drops the oldest entries past the limit, e.g. after the limit is lowered. */
	async prune(): Promise<void> {
		const entries = this.entries;
		const limit = Math.max(0, this.limit());
		if (entries && entries.length > limit) await this.remove(entries.slice(limit).map((e) => e.id));
	}

	/** Waits for pending writes, e.g. before the extension stops. */
	async close(): Promise<void> {
		await this.queue;
	}

	private bodyPath(id: number): string {
		return join(this.dir, BODIES_DIR, `${id}.bin`);
	}

	/** Writes to a temporary file first, so a crash mid-write can't leave a broken index. */
	private saveIndex(): Promise<void> {
		const data: IndexFile = { nextId: this.nextId, entries: this.entries ?? [] };
		const text = JSON.stringify(data);
		return this.enqueue(async () => {
			await mkdir(this.dir, { recursive: true });
			const temp = join(this.dir, `${INDEX_FILE}.tmp`);
			await writeFile(temp, text);
			await rename(temp, join(this.dir, INDEX_FILE));
		});
	}

	private enqueue<T>(task: () => Promise<T>): Promise<T> {
		const run = this.queue.then(task);
		this.queue = run.catch(() => undefined);
		return run;
	}
}
