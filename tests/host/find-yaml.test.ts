import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { findYaml } from "../../src/host/find-yaml";

const root = await mkdtemp(join(tmpdir(), "carbonwire-find-"));
afterAll(() => rm(root, { recursive: true, force: true }));

describe("findYaml", () => {
	it("finds YAML files at any depth, skipping node_modules, .git and symbolic links", async () => {
		const files = ["a.yml", "api/b.yaml", "api/deep/er/C.YML", "api/notes.md", "node_modules/pkg/x.yml", ".git/y.yml"];
		for (const f of files) {
			await mkdir(join(root, f, ".."), { recursive: true });
			await writeFile(join(root, f), "x: 1\n");
		}
		// A link back to the root would loop forever if it were followed.
		await symlink(root, join(root, "api", "loop"));
		const found = (await findYaml(root)).map((p) => relative(root, p).split("\\\\").join("/")).sort();
		expect(found).toEqual(["a.yml", "api/b.yaml", "api/deep/er/C.YML"]);
	});

	it("returns nothing for a folder that doesn't exist", async () => {
		expect(await findYaml(join(root, "missing"))).toEqual([]);
	});
});
