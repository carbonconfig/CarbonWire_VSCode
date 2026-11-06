import { readdir } from "node:fs/promises";
import { join } from "node:path";

/* Never searched for collections. */
const SKIPPED = new Set(["node_modules", ".git"]);
const YAML = /\.ya?ml$/i;

/**
 * Every YAML file under `dir`, as absolute paths: a directory walk, faster than findFiles. Symbolic
 * links aren't followed, and unreadable folders are skipped.
 */
export async function findYaml(dir: string): Promise<string[]> {
	const found: string[] = [];
	const walk = async (current: string): Promise<void> => {
		const entries = await readdir(current, { withFileTypes: true }).catch(() => []);
		const folders: Promise<void>[] = [];
		for (const entry of entries) {
			if (entry.isDirectory()) {
				if (!SKIPPED.has(entry.name)) folders.push(walk(join(current, entry.name)));
			} else if (entry.isFile() && YAML.test(entry.name)) {
				found.push(join(current, entry.name));
			}
		}
		await Promise.all(folders);
	};
	await walk(dir);
	return found;
}
