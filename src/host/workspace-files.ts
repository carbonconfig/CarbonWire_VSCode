import { existsSync } from "node:fs";
import { mkdir, readFile, stat, utimes, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { WorkspaceFiles, WriteOptions } from "../core/storage/store";
import type { PathMap } from "./paths";

export interface FileStat {
	mtime: number;
	/** Creation time, used to sort by date created. */
	ctime: number;
	size: number;
}

/** Collection files read and written directly on disk; the extension runs where the workspace is. */
export class DiskFiles implements WorkspaceFiles {
	constructor(private readonly map: () => PathMap) {}

	exists(path: string): boolean {
		const fsPath = this.map().toFsPath(path);
		return fsPath !== undefined && existsSync(fsPath);
	}

	async read(path: string): Promise<string> {
		return readFile(this.fsPath(path), "utf8");
	}

	async readBinary(path: string): Promise<Uint8Array> {
		return readFile(this.fsPath(path));
	}

	async write(path: string, data: string, options: WriteOptions = {}): Promise<void> {
		const fsPath = this.fsPath(path);
		const before = options.orderOnly ? await stat(fsPath).catch(() => undefined) : undefined;
		await mkdir(dirname(fsPath), { recursive: true });
		await writeFile(fsPath, data);
		// Writing in place keeps the creation time; this keeps the modified time too, plus 1 ms.
		if (before) await utimes(fsPath, before.atime, (before.mtimeMs + 1) / 1000);
	}

	async stat(path: string): Promise<FileStat | undefined> {
		const fsPath = this.map().toFsPath(path);
		const s = fsPath === undefined ? undefined : await stat(fsPath).catch(() => undefined);
		return s?.isFile() ? { mtime: s.mtimeMs, ctime: s.birthtimeMs || s.ctimeMs, size: s.size } : undefined;
	}

	fsPath(path: string): string {
		const fsPath = this.map().toFsPath(path);
		if (fsPath === undefined) throw new Error(`Not in this workspace: ${path}`);
		return fsPath;
	}
}
