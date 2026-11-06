import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PathMap } from "../../src/host/paths";

const app = { name: "app", fsPath: join("/work", "app") };
const api = { name: "api", fsPath: join("/work", "api") };

describe("PathMap", () => {
	it("uses paths relative to the only workspace folder", () => {
		const map = new PathMap([app]);
		expect(map.toPath(join(app.fsPath, "api-collections", "Users", "get.yml"))).toBe("api-collections/Users/get.yml");
		expect(map.toPath(app.fsPath)).toBe("");
		expect(map.toFsPath("api-collections/Users/get.yml")).toBe(join(app.fsPath, "api-collections", "Users", "get.yml"));
		expect(map.fromSetting("./api-collections/")).toBe("api-collections");
		expect(map.rootName()).toBe("app");
	});

	it("starts paths with the folder name when there are several folders", () => {
		const map = new PathMap([app, api]);
		expect(map.toPath(join(api.fsPath, "Users", "get.yml"))).toBe("api/Users/get.yml");
		expect(map.toPath(api.fsPath)).toBe("api");
		expect(map.toFsPath("api/Users/get.yml")).toBe(join(api.fsPath, "Users", "get.yml"));
		expect(map.toFsPath("other/x.yml")).toBeUndefined();
		expect(map.fromSetting("api-collections")).toBe("app/api-collections");
		expect(map.fromSetting("")).toBe("app");
	});

	it("ignores files outside the workspace, including look-alike folder names", () => {
		const map = new PathMap([app]);
		expect(map.toPath(join("/work", "other", "x.yml"))).toBeUndefined();
		expect(map.toPath(join("/work", "app-2", "x.yml"))).toBeUndefined();
		expect(map.toPath(join(app.fsPath, "..data", "x.yml"))).toBe("..data/x.yml");
	});

	it("has nothing to map without a workspace folder", () => {
		const map = new PathMap([]);
		expect(map.empty).toBe(true);
		expect(map.toFsPath("x.yml")).toBeUndefined();
		expect(map.toPath("/x.yml")).toBeUndefined();
	});
});
