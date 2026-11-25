import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type * as vscode from "vscode";
import type { MetaEntry } from "./collection-index";

const LEGACY_KEY = "metaCache";

/**
 * The collection index's metadata cache, in a file in the extension's storage folder: with thousands
 * of requests it's too big for workspace state. Reads and writes run in turn, so a load sees the last save.
 */
export class MetaCacheFile {
	private queue: Promise<unknown> = Promise.resolve();

	constructor(private readonly file: string, private readonly workspaceState: vscode.Memento) {}

	load(): Promise<Record<string, MetaEntry> | undefined> {
		return this.enqueue(async () => {
			// Kept in workspace state up to 1.2.0; moved here on first load.
			const legacy = this.workspaceState.get<Record<string, MetaEntry>>(LEGACY_KEY);
			if (legacy !== undefined) await this.workspaceState.update(LEGACY_KEY, undefined);
			try {
				const parsed: unknown = JSON.parse(await readFile(this.file, "utf8"));
				if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, MetaEntry>;
			} catch {
				// Missing or unreadable: every file is read again.
			}
			return legacy;
		});
	}

	save(cache: Record<string, MetaEntry>): Promise<void> {
		const text = JSON.stringify(cache);
		return this.enqueue(async () => {
			const tmp = `${this.file}.tmp`;
			await mkdir(dirname(this.file), { recursive: true });
			await writeFile(tmp, text);
			await rename(tmp, this.file);
		}).catch(() => undefined);
	}

	private enqueue<T>(run: () => Promise<T>): Promise<T> {
		const next = this.queue.then(run, run);
		this.queue = next.catch(() => undefined);
		return next;
	}
}
