import { readdir } from "node:fs/promises";
import { join } from "node:path";

/* Never searched for collections. */
const SKIPPED = new Set(["node_modules", ".git"]);
const YAML = /\.ya?ml$/i;

/** Whether a folder or file is left out, by its "/"-separated path relative to the workspace folder and its name. */
export type Skip = (path: string, name: string) => boolean;

/**
 * Every YAML file under `dir`, as absolute paths: a directory walk, faster than findFiles. Symbolic
 * links aren't followed, and unreadable folders are skipped. `base` is `dir`'s path for `skip`.
 */
export async function findYaml(dir: string, skip: Skip = () => false, base = ""): Promise<string[]> {
	const found: string[] = [];
	const walk = async (current: string, path: string): Promise<void> => {
		const entries = await readdir(current, { withFileTypes: true }).catch(() => []);
		const folders: Promise<void>[] = [];
		for (const entry of entries) {
			const child = path ? `${path}/${entry.name}` : entry.name;
			if (entry.isDirectory()) {
				if (!SKIPPED.has(entry.name) && !skip(child, entry.name)) folders.push(walk(join(current, entry.name), child));
			} else if (entry.isFile() && YAML.test(entry.name) && !skip(child, entry.name)) {
				found.push(join(current, entry.name));
			}
		}
		await Promise.all(folders);
	};
	await walk(dir, base);
	return found;
}
