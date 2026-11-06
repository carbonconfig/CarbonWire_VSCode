import { isAbsolute, join, relative, sep } from "node:path";

export interface WorkspaceRoot {
	name: string;
	fsPath: string;
}

/**
 * Maps disk paths to the "/"-separated paths CarbonWire shows. With several workspace folders,
 * paths start with the folder's name.
 */
export class PathMap {
	constructor(readonly roots: readonly WorkspaceRoot[]) {}

	get empty(): boolean {
		return this.roots.length === 0;
	}

	/** Shown for a collection that is the workspace folder itself. */
	rootName(): string {
		return this.roots[0]?.name ?? "Workspace";
	}

	toFsPath(path: string): string | undefined {
		const [first, ...rest] = this.roots;
		if (!first) return undefined;
		const parts = path.split("/").filter(Boolean);
		if (rest.length === 0) return join(first.fsPath, ...parts);
		const root = this.roots.find((r) => r.name === parts[0]);
		return root && join(root.fsPath, ...parts.slice(1));
	}

	/** Undefined for a file outside every workspace folder. */
	toPath(fsPath: string): string | undefined {
		for (const root of this.roots) {
			const rel = relative(root.fsPath, fsPath);
			if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) continue;
			const path = rel.split(sep).join("/");
			if (this.roots.length === 1) return path;
			return path ? `${root.name}/${path}` : root.name;
		}
		return undefined;
	}

	/** A folder setting, written relative to the first workspace folder, as a path. */
	fromSetting(folder: string): string {
		const clean = folder.replace(/\\/g, "/").split("/").filter((p) => p && p !== ".").join("/");
		if (this.roots.length <= 1) return clean;
		const first = this.roots[0]!.name;
		return clean ? `${first}/${clean}` : first;
	}
}
