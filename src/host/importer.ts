import { readdir, readFile, stat } from "node:fs/promises";
import { basename as fsBasename, join, relative, sep } from "node:path";
import * as vscode from "vscode";
import { countItems, type ImportedEnvironment, type ImportResult } from "../core/import/model";
import type { EnvironmentResolution, ImportTarget, WriteSummary } from "../core/import/writer";
import { basename, joinPath, stem } from "../core/storage/paths";
import { COLLECTION_FILE } from "../core/storage/tree";
import type { SidebarProvider } from "./sidebar";
import type { CarbonWire } from "./carbonwire";
import type { Panels } from "./panels";
import { promptText } from "./prompt";

const FILE_TYPES = ["json", "yaml", "yml", "har", "http", "rest", "bru", "txt"];
const FOLDER_FILES = /\.(bru|json|ya?ml|md)$/i;
const SKIPPED_DIRS = new Set(["node_modules", ".git"]);
/* A folder import reads every matching file into memory, so very large folders are refused. */
const MAX_FOLDER_FILES = 20_000;

export interface ImportOptions {
	/** Preselects this collection as the destination. */
	collectionRoot?: string;
	/** Imports environments only; files with requests are refused. */
	environments?: boolean;
}

interface FolderFile {
	path: string;
	text: string;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/**
 * Imports from Postman, Insomnia, Bruno, HTTPie, Hoppscotch, HAR, .http files and cURL through VS Code's
 * pickers: choose a source, review what was found, settle environment name clashes, then write.
 */
export class Importer {
	constructor(
		private readonly app: CarbonWire,
		private readonly panels: Panels,
		private readonly sidebar: SidebarProvider,
	) {}

	/** Asks for the source: a file, a folder, the clipboard or the open editor. */
	async run(options: ImportOptions = {}): Promise<void> {
		if (!this.app.hasWorkspace()) {
			void vscode.window.showInformationMessage("Open a folder first. CarbonWire keeps collections as files in it.");
			return;
		}
		const editor = vscode.window.activeTextEditor?.document;
		type Source = vscode.QuickPickItem & { run: () => Promise<void> };
		const sources: Source[] = [
			{ label: "$(file) File…", detail: options.environments ? "Postman, Insomnia, Hoppscotch, HTTPie, Bruno or http-client.env.json environments" : "Postman, Insomnia, Hoppscotch or HTTPie exports, HAR, .http and .bru files, and environments", run: () => this.pickFile(options) },
		];
		if (!options.environments) sources.push({ label: "$(folder) Folder…", detail: "A Bruno collection folder, or an OpenCollection folder, which is copied as it is", run: () => this.pickFolder() });
		sources.push({ label: "$(clippy) Clipboard", detail: options.environments ? "The contents of an environment file" : "A cURL command, or the contents of any supported file", run: () => this.fromClipboard(options) });
		if (editor && editor.getText().trim()) {
			sources.push({ label: `$(go-to-file) ${fsBasename(editor.fileName)}`, detail: "The file open in the editor", run: () => this.fromText(editor.getText(), fsBasename(editor.fileName), options) });
		}
		const picked = await vscode.window.showQuickPick(sources, { title: options.environments ? "Import environment" : "Import into CarbonWire", placeHolder: "Import from" });
		await picked?.run();
	}

	/** Imports a file or folder chosen in the Explorer. */
	async fromUri(uri: vscode.Uri, options: ImportOptions = {}): Promise<void> {
		if ((await stat(uri.fsPath)).isDirectory()) return this.fromFolder(uri.fsPath);
		await this.fromText(await readFile(uri.fsPath, "utf8"), fsBasename(uri.fsPath), options);
	}

	/** Writes a parsed import; used by the interactive flow and by tests. Returns what was written. */
	async write(result: ImportResult, target: ImportTarget, resolutions: ReadonlyMap<string, EnvironmentResolution> = new Map()): Promise<WriteSummary> {
		const { app } = this;
		const { writeImport } = await import("./import-formats");
		const secrets: Promise<void>[] = [];
		const summary = await writeImport(app.store, result, target, {
			environmentsDir: app.environmentsFolder(),
			resolutions,
			setSecret: (path, name, value) => void secrets.push(app.secrets.set(path, name, value)),
		});
		await Promise.all(secrets);
		// Shows the result straight away rather than when the file watcher reports it.
		for (const root of summary.roots) await app.index.folderCreated(root);
		for (const name of summary.environments) app.index.created(app.store.environmentPath(app.environmentsFolder(), name));
		app.index.rebuild();
		return summary;
	}

	private async pickFile(options: ImportOptions): Promise<void> {
		const [uri] =
			(await vscode.window.showOpenDialog({
				title: options.environments ? "Import environment" : "Import into CarbonWire",
				canSelectMany: false,
				filters: { "Collections and environments": FILE_TYPES, "All files": ["*"] },
			})) ?? [];
		if (uri) await this.fromUri(uri, options);
	}

	private async pickFolder(): Promise<void> {
		const [uri] = (await vscode.window.showOpenDialog({ title: "Import a Bruno or OpenCollection folder", canSelectFolders: true, canSelectFiles: false })) ?? [];
		if (uri) await this.fromFolder(uri.fsPath);
	}

	private async fromClipboard(options: ImportOptions): Promise<void> {
		const text = await vscode.env.clipboard.readText();
		if (!text.trim()) {
			void vscode.window.showInformationMessage("The clipboard is empty. Copy a cURL command or the contents of an export first.");
			return;
		}
		await this.fromText(text, "", options);
	}

	private async fromText(text: string, fileName: string, options: ImportOptions): Promise<void> {
		const { importText } = await import("./import-formats");
		await this.parsed(() => importText(text, fileName), fileName || "the clipboard", options);
	}

	/** Paths keep the chosen folder's name first, as the Bruno importer expects. */
	private async fromFolder(dir: string): Promise<void> {
		const files: FolderFile[] = [];
		const parent = join(dir, "..");
		const walk = async (current: string): Promise<void> => {
			for (const entry of await readdir(current, { withFileTypes: true })) {
				const full = join(current, entry.name);
				if (entry.isDirectory()) {
					if (!SKIPPED_DIRS.has(entry.name)) await walk(full);
				} else if (FOLDER_FILES.test(entry.name)) {
					if (files.length >= MAX_FOLDER_FILES) throw new Error(`This folder has more than ${MAX_FOLDER_FILES.toLocaleString()} files to read. Choose the collection's own folder.`);
					files.push({ path: relative(parent, full).split(sep).join("/"), text: await readFile(full, "utf8") });
				}
			}
		};
		try {
			await walk(dir);
		} catch (e) {
			void vscode.window.showErrorMessage(e instanceof Error ? e.message : String(e));
			return;
		}
		const openCollection = files.find((f) => basename(f.path) === COLLECTION_FILE);
		if (openCollection) return this.copyOpenCollection(files, openCollection.path);
		const { importBrunoFolder } = await import("./import-formats");
		await this.parsed(() => importBrunoFolder(files), fsBasename(dir), {});
	}

	private async parsed(parse: () => ImportResult, source: string, options: ImportOptions): Promise<void> {
		let result: ImportResult;
		try {
			result = parse();
		} catch (e) {
			void vscode.window.showErrorMessage(`Couldn't import ${source}: ${e instanceof Error ? e.message : String(e)}`);
			return;
		}
		if (options.environments && result.collections.length > 0) {
			void vscode.window.showErrorMessage("This file contains requests. Use Import into CarbonWire instead of Import environment.");
			return;
		}
		const target = await this.chooseTarget(result, options);
		if (!target) return;
		const resolutions = await this.resolveConflicts([...result.environments, ...result.collections.flatMap((c) => c.environments)]);
		if (!resolutions) return;
		try {
			const summary = await this.write(result, target, resolutions);
			this.report(result, summary, source);
		} catch (e) {
			void vscode.window.showErrorMessage(`Couldn't import ${source}: ${e instanceof Error ? e.message : String(e)}`);
		}
	}

	/** What was found, and where it goes: a new collection, or into an existing one. */
	private async chooseTarget(result: ImportResult, options: ImportOptions): Promise<ImportTarget | undefined> {
		// Environments are shared by every collection, so they need no destination.
		if (result.collections.length === 0) return { kind: "environments" };
		const { app } = this;
		const found = [
			...result.collections.map((c) => {
				const { requests, folders } = countItems(c.items);
				const parts = [plural(requests, "request"), ...(folders ? [plural(folders, "folder")] : []), ...(c.environments.length ? [plural(c.environments.length, "environment")] : [])];
				return `${c.name} (${parts.join(", ")})`;
			}),
			...result.environments.map((e) => `environment "${e.name}"`),
		];
		const single = result.collections.length === 1 ? countItems(result.collections[0]!.items) : undefined;
		const singleRequest = single?.requests === 1 && single.folders === 0;
		const collections = await app.collections();
		// Whole collections default to a new collection; single requests to the one in use.
		const suggested = options.collectionRoot ?? (singleRequest ? (this.panels.focusedCollection() ?? collections[0]?.root) : undefined);
		type Item = vscode.QuickPickItem & { target: ImportTarget };
		const items: Item[] = [
			{ label: "$(new-folder) New collection", description: app.collectionsFolder() || "workspace folder", target: { kind: "new", dir: app.collectionsFolder() } },
			...collections.map((c): Item => ({ label: `$(folder) Add to ${c.name}`, description: c.root || undefined, target: { kind: "existing", root: c.root } })),
		];
		const quickPick = vscode.window.createQuickPick<Item>();
		quickPick.title = `Import ${result.format}: ${found.join(", ")}`;
		quickPick.placeholder = "Import into";
		quickPick.items = items;
		const preselected = items.find((i) => i.target.kind === "existing" && i.target.root === suggested);
		if (preselected) quickPick.activeItems = [preselected];
		const picked = await new Promise<Item | undefined>((resolve) => {
			quickPick.onDidAccept(() => resolve(quickPick.selectedItems[0]));
			quickPick.onDidHide(() => resolve(undefined));
			quickPick.show();
		});
		quickPick.dispose();
		return picked?.target;
	}

	/** For each environment whose name is taken: import it under a new name, or merge it. */
	private async resolveConflicts(environments: readonly ImportedEnvironment[]): Promise<Map<string, EnvironmentResolution> | undefined> {
		const { store } = this.app;
		const dir = this.app.environmentsFolder();
		const resolutions = new Map<string, EnvironmentResolution>();
		for (const env of environments) {
			if (!store.exists(store.environmentPath(dir, env.name))) continue;
			let suggestion = `${env.name} 2`;
			for (let i = 3; store.exists(store.environmentPath(dir, suggestion)); i++) suggestion = `${env.name} ${i}`;
			const choice = await vscode.window.showQuickPick(
				[
					{ label: "Import with a new name", action: "rename" as const },
					{ label: "Merge, using imported values", action: "imported" as const },
					{ label: "Merge, keeping existing values", action: "existing" as const },
				],
				{ title: `An environment named "${env.name}" already exists`, placeHolder: "Import it under a new name, or merge its variables into the existing one" },
			);
			if (!choice) return undefined;
			if (choice.action === "rename") {
				const name = await promptText(`New name for "${env.name}"`, suggestion, "", "Import");
				if (!name) return undefined;
				resolutions.set(env.name, { action: "rename", name });
			} else {
				resolutions.set(env.name, { action: "merge", prefer: choice.action });
			}
		}
		return resolutions;
	}

	/** A summary notification, with the import's notes a click away when there are any. Doesn't wait for a click. */
	private report(result: ImportResult, summary: WriteSummary, source: string): void {
		const parts: string[] = [];
		if (summary.requests) parts.push(plural(summary.requests, "request"));
		if (summary.environments.length) parts.push(`environment${summary.environments.length === 1 ? "" : "s"} ${summary.environments.map((n) => `"${n}"`).join(", ")}`);
		const message = parts.length ? `Imported ${parts.join(" and ")}.` : "Nothing was imported.";
		const actions = [...(result.warnings.length ? [`Show ${plural(result.warnings.length, "note")}`] : []), ...(summary.roots.length ? ["Show in CarbonWire"] : [])];
		void vscode.window.showInformationMessage(message, ...actions).then(async (action) => {
			if (action === "Show in CarbonWire") await this.sidebar.reveal(summary.roots[0]!);
			else if (action) {
				const content = [`# Import notes`, "", `Imported ${result.format} from ${source}. These parts didn't carry over as they were:`, "", ...result.warnings.map((w) => `- ${w}`), ""].join("\n");
				const document = await vscode.workspace.openTextDocument({ language: "markdown", content });
				await vscode.window.showTextDocument(document, { preview: true });
			}
		});
	}

	/** Copies an OpenCollection folder as it is, moving its environments to the shared environments. */
	private async copyOpenCollection(files: FolderFile[], rootFile: string): Promise<void> {
		const { app } = this;
		const { store } = app;
		const sourceRoot = rootFile.slice(0, -COLLECTION_FILE.length).replace(/\/$/, "");
		const destination = store.uniqueFolder(app.collectionsFolder(), basename(sourceRoot) || "Collection");
		let copied = 0;
		const environments: string[] = [];
		for (const f of files) {
			if (sourceRoot && !f.path.startsWith(`${sourceRoot}/`)) continue;
			const rel = sourceRoot ? f.path.slice(sourceRoot.length + 1) : f.path;
			if (/^environments\/[^/]+\.ya?ml$/i.test(rel)) {
				const target = store.uniqueFile(app.environmentsFolder(), basename(rel));
				await store.writeRaw(target, f.text);
				app.index.created(target);
				environments.push(stem(target));
				continue;
			}
			await store.writeRaw(joinPath(destination, rel), f.text);
			copied++;
		}
		await app.index.folderCreated(destination);
		app.index.rebuild();
		const envs = environments.length ? ` and environment${environments.length === 1 ? "" : "s"} ${environments.map((n) => `"${n}"`).join(", ")}` : "";
		void vscode.window.showInformationMessage(`Copied ${plural(copied, "file")} into ${destination}${envs}.`, "Show in CarbonWire").then((action) => action && this.sidebar.reveal(destination));
	}
}
