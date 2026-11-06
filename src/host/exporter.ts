import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import * as vscode from "vscode";
import type { Collected, CollectedItem } from "../core/export/collection";
import type { Folder, OpenCollection } from "../core/model";
import { basename, joinPath, stem } from "../core/storage/paths";
import { SIDECAR_FILE, type Sidecar } from "../core/storage/sidecar";
import { COLLECTION_FILE, FOLDER_FILE, type TreeNode } from "../core/storage/tree";
import type { CarbonWire } from "./carbonwire";

type Format = "postman" | "postman-v3" | "opencollection" | "curl" | "har";

const FORMATS: (vscode.QuickPickItem & { id: Format })[] = [
	{ id: "postman", label: "Postman collection (v2.1 JSON)", detail: "Imports into Postman, Insomnia, Bruno and most API tools." },
	{ id: "postman-v3", label: "Postman v3 (YAML folder)", detail: "Postman's Git-native layout: postman/collections/<name>." },
	{ id: "opencollection", label: "OpenCollection (zip)", detail: "The collection's files as they are, for Bruno or another CarbonWire." },
	{ id: "curl", label: "cURL script", detail: "One cURL command per request, with variables left as {{name}}." },
	{ id: "har", label: "HAR", detail: "Each request, with its first saved example as the response." },
];

/** Exports collections and environments to files the user picks a place for. */
export class Exporter {
	constructor(private readonly app: CarbonWire) {}

	async exportCollection(root: string): Promise<void> {
		const format = await vscode.window.showQuickPick(FORMATS, { title: "Export the collection as" });
		if (!format) return;
		const collected = await this.collect(root);
		const base = collected.name.replace(/[/\\:*?"<>|]/g, "-").trim() || "Collection";
		const exports = await import("../core/export/collection");
		const version = (vscode.extensions.getExtension("carbonconfig.carbonwire")?.packageJSON as { version?: string } | undefined)?.version ?? "1";
		switch (format.id) {
			case "postman":
				return this.saveFile(`${base}.postman_collection.json`, { JSON: ["json"] }, `${JSON.stringify(exports.postmanCollection(collected), null, 2)}\n`);
			case "curl":
				return this.saveFile(`${base}.sh`, { "Shell script": ["sh"] }, exports.curlScript(collected));
			case "har":
				return this.saveFile(`${base}.har`, { HAR: ["har"] }, `${JSON.stringify(exports.har(collected, version), null, 2)}\n`);
			case "postman-v3": {
				const folder = await this.pickFolder("Choose the folder to write postman/collections into");
				if (!folder) return;
				const files = exports.postmanV3(collected);
				const target = join(folder, "postman", files[0]!.path.split("/").slice(0, 2).join("/"));
				const exists = await readdir(target).then(() => true, () => false);
				if (exists) throw new Error(`${target} already exists.`);
				const { stringify } = await import("yaml");
				for (const f of files) {
					const path = join(folder, "postman", ...f.path.split("/"));
					await mkdir(dirname(path), { recursive: true });
					await writeFile(path, stringify(f.value, { lineWidth: 0 }));
				}
				return this.done(target);
			}
			case "opencollection": {
				const { zip } = await import("../core/export/zip");
				const fsRoot = this.app.fsPath(root);
				const prefix = basename(root) || "collection";
				const entries = (await walk(fsRoot)).map(async (file) => ({ name: `${prefix}/${relative(fsRoot, file).split("\\").join("/")}`, data: await readFile(file) }));
				return this.saveFile(`${base}.zip`, { Zip: ["zip"] }, zip(await Promise.all(entries)));
			}
		}
	}

	async exportEnvironment(path: string): Promise<void> {
		const choice = await vscode.window.showQuickPick(
			[
				{ id: "json", label: "Postman environment (JSON)" },
				{ id: "v3", label: "Postman v3 environment (YAML)" },
			],
			{ title: "Export the environment as" },
		);
		if (!choice) return;
		const env = await this.app.store.loadEnvironment(path);
		const name = stem(path);
		const exports = await import("../core/export/collection");
		if (choice.id === "json") return this.saveFile(`${name}.postman_environment.json`, { JSON: ["json"] }, `${JSON.stringify(exports.postmanEnvironment(env, name), null, 2)}\n`);
		const { stringify } = await import("yaml");
		const file = exports.postmanV3Environment(env, name);
		return this.saveFile(`${name}.environment.yaml`, { YAML: ["yaml"] }, stringify(file.value, { lineWidth: 0 }));
	}

	/** The collection's documents, sidecar extras merged in, in the sidebar's manual order. */
	private async collect(root: string): Promise<Collected> {
		const { store, index } = this.app;
		const node = index.manualTree().find((c) => c.root === root);
		if (!node) throw new Error("That collection is no longer in the workspace.");
		const collection = await store.loadDocument<OpenCollection>(joinPath(root, COLLECTION_FILE));
		const sidecarPath = joinPath(root, SIDECAR_FILE);
		const sidecar = store.exists(sidecarPath) ? (JSON.parse(await this.app.files.read(sidecarPath)) as Sidecar) : undefined;
		const docsText = (await import("../core/export/collection")).docsText;
		const items = async (nodes: readonly TreeNode[]): Promise<CollectedItem[]> =>
			Promise.all(
				nodes.map(async (n): Promise<CollectedItem> => {
					if (n.kind === "folder") {
						const folder = n.hasConfig ? await store.loadDocument<Folder>(joinPath(n.path, FOLDER_FILE)) : ({} as Folder);
						return { kind: "folder", name: folder.info?.name ?? n.name, dir: n.path, defaults: folder.request ?? { auth: "inherit" }, docs: docsText(folder.docs), items: await items(n.children) };
					}
					const request = await store.loadRequest(n.path);
					return { kind: "request", name: request.info?.name ?? n.name, path: n.path, request: request };
				}),
			);
		return { name: collection.info?.name ?? node.name, root, defaults: collection.request ?? {}, docs: docsText(collection.docs), sidecar, items: await items(node.children) };
	}

	private async saveFile(name: string, filters: Record<string, string[]>, data: string | Uint8Array): Promise<void> {
		const folder = vscode.workspace.workspaceFolders?.[0]?.uri;
		const uri = await vscode.window.showSaveDialog({ defaultUri: folder ? vscode.Uri.joinPath(folder, name) : undefined, filters, title: "Export" });
		if (!uri) return;
		await vscode.workspace.fs.writeFile(uri, typeof data === "string" ? new TextEncoder().encode(data) : data);
		await this.done(uri.fsPath);
	}

	private async pickFolder(title: string): Promise<string | undefined> {
		const picked = await vscode.window.showOpenDialog({ canSelectFolders: true, canSelectFiles: false, canSelectMany: false, title, openLabel: "Export here" });
		return picked?.[0]?.fsPath;
	}

	private async done(path: string): Promise<void> {
		const reveal = await vscode.window.showInformationMessage(`Exported to ${path}.`, "Show in folder");
		if (reveal) await vscode.commands.executeCommand("revealFileInOS", vscode.Uri.file(path));
	}
}

async function walk(dir: string): Promise<string[]> {
	const out: string[] = [];
	for (const entry of (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
		const full = join(dir, entry.name);
		if (entry.isDirectory()) {
			if (entry.name !== ".git" && entry.name !== "node_modules") out.push(...(await walk(full)));
		} else if (entry.isFile()) {
			out.push(full);
		}
	}
	return out;
}
