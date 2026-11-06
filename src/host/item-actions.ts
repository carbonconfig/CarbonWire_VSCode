import * as vscode from "vscode";
import type { Environment, Folder, HttpRequest } from "../core/model";
import { insertKey, seqUpdates, siblingLists, type InsertPosition } from "../core/storage/order";
import { basename, dirname, joinPath, safeFileName, stem } from "../core/storage/paths";
import { FOLDER_FILE, type TreeNode } from "../core/storage/tree";
import { colorForName, defaultEnvColor } from "../ui/env-colors";
import type { CarbonWire } from "./carbonwire";
import { confirmAction, promptEnvironment, promptText } from "./prompt";
import { secretNames } from "./secrets";

/** Rename, duplicate, delete and move for requests, folders and environments. */
export class ItemActions {
	constructor(private readonly app: CarbonWire) {}

	/** Prompts for a name unless one is given; resolves to the new path, or undefined. */
	async renameRequest(path: string, newName?: string): Promise<string | undefined> {
		const current = stem(path);
		const name = newName ?? (await promptText("Rename request", current, "", "Rename"));
		if (!name || name === current) return undefined;
		const target = joinPath(dirname(path), `${safeFileName(name)}.yml`);
		if (!(await this.move(path, target))) return undefined;
		const { store } = this.app;
		const request = await store.loadRequest(target);
		await store.saveRequest(target, { ...request, info: { ...request.info, name } });
		return target;
	}

	async duplicateRequest(path: string): Promise<string> {
		const { store } = this.app;
		const request: HttpRequest = await store.loadRequest(path);
		return store.createRequest(dirname(path), `${request.info?.name ?? stem(path)} copy`, request, request.info?.seq);
	}

	async deleteRequest(path: string): Promise<void> {
		await this.trash(path);
	}

	async renameFolder(dir: string): Promise<void> {
		const current = basename(dir);
		const name = await promptText("Rename folder", current, "", "Rename");
		if (!name || name === current) return;
		const target = joinPath(dirname(dir), safeFileName(name));
		if (!(await this.move(dir, target))) return;
		const { store } = this.app;
		const config = joinPath(target, FOLDER_FILE);
		if (store.exists(config)) {
			const folder = await store.loadDocument<Folder>(config);
			await store.saveDocument(config, { ...folder, info: { ...folder.info, name } });
		}
	}

	async deleteFolder(dir: string): Promise<void> {
		if (!this.app.store.exists(dir)) return;
		const ok = await confirmAction(`Delete "${basename(dir)}"?`, "The folder and every request in it move to the trash.", "Delete");
		if (ok) await this.trash(dir);
	}

	/** Without a name, asks for a new name and colour. Secret values are keyed by name, so they move first. */
	async renameEnvironment(path: string, newName?: string): Promise<string | undefined> {
		const { store, secrets } = this.app;
		const current = stem(path);
		let name = newName;
		let color: string | undefined;
		if (name === undefined) {
			const env = await store.loadDocument<Environment>(path);
			// A colour the user chose stays; one that came from the old name follows the new name.
			const suggest = !env.color || env.color.toLowerCase() === colorForName(current)?.toLowerCase();
			const choice = await promptEnvironment({ title: "Edit environment", action: "Save", name: current, color: env.color ?? defaultEnvColor(0), suggest });
			if (!choice) return undefined;
			({ name, color } = choice);
		}

		let target = path;
		if (name && name !== current) {
			target = joinPath(dirname(path), `${safeFileName(name)}.yml`);
			if (store.exists(target)) {
				void vscode.window.showWarningMessage(`An environment named "${stem(target)}" already exists.`);
				return undefined;
			}
			const env = await store.loadDocument<Environment>(path);
			const names = secretNames(env);
			await secrets.load(path, names);
			for (const variable of names) {
				const value = secrets.get(path, variable);
				if (value === null) continue;
				await secrets.set(target, variable, value);
				await secrets.set(path, variable, "");
			}
			if (!(await this.move(path, target))) return undefined;
			await store.saveDocument(target, { ...env, name: stem(target) });
		}
		if (color) {
			const env = await store.loadDocument<Environment>(target);
			if (env.color !== color) await store.saveDocument(target, { ...env, color });
		}
		return target;
	}

	/** Copies a collection's own environments, such as a Bruno collection's, to the shared environments. */
	async copyCollectionEnvironments(paths: readonly string[]): Promise<void> {
		const { store, files } = this.app;
		const names: string[] = [];
		for (const path of paths) {
			if (!store.exists(path)) continue;
			const target = store.uniqueFile(this.app.environmentsFolder(), basename(path));
			await store.writeRaw(target, await files.read(path));
			names.push(stem(target));
		}
		void vscode.window.showInformationMessage(`Added environment${names.length === 1 ? "" : "s"} ${names.map((n) => `"${n}"`).join(", ")}.`);
	}

	async duplicateEnvironment(path: string): Promise<void> {
		const { store, secrets } = this.app;
		const env = await store.loadEnvironment(path);
		const copy = await store.createEnvironmentIn(dirname(path), `${env.name} copy`, env);
		const names = secretNames(env);
		await secrets.load(path, names);
		for (const variable of names) {
			const value = secrets.get(path, variable);
			if (value !== null) await secrets.set(copy, variable, value);
		}
	}

	async deleteEnvironment(path: string): Promise<void> {
		if (!this.app.store.exists(path)) return;
		if (this.app.activeEnvironment() === stem(path)) await this.app.setActiveEnvironment("");
		await this.trash(path);
	}

	/**
	 * Moves a request or folder into `dir`, before or after `anchor` or at the end, saving the order as
	 * `seq`. When sorted another way, the shown order becomes the manual order first.
	 */
	async moveTreeItem(path: string, dir: string, anchor: string | undefined, position: InsertPosition): Promise<void> {
		const { app } = this;
		const { store } = app;
		const sorted = app.sortOrder() !== "manual";
		const shown = sorted ? await app.collections() : app.index.manualTree();
		const lists = siblingLists(shown);
		const nodes = new Map([...lists.values()].flat().map((n) => [n.path, n]));
		const node = nodes.get(path);
		const siblings = lists.get(dir);
		if (!node || !siblings) return;

		const orders = new Map<string, string[]>();
		if (sorted) for (const [d, list] of lists) orders.set(d, list.map((n) => n.path).filter((p) => p !== path));
		orders.set(dir, insertKey(siblings.map((n) => n.path), path, anchor, position));

		let target = path;
		if (dirname(path) !== dir) {
			target = node.kind === "folder" ? store.uniqueFolder(dir, basename(path)) : store.uniqueFile(dir, basename(path));
			if (!(await this.move(path, target))) return;
		}
		await this.writeOrders(orders, nodes, (p) => (p === path ? target : p.startsWith(`${path}/`) ? target + p.slice(path.length) : p));
		if (sorted) await app.useManualOrder(shown.map((c) => c.root));
		else app.index.rebuild();
	}

	/** Reorders collections, keeping what is shown inside them when leaving another sort order. */
	async moveCollection(root: string, anchor: string, position: "before" | "after"): Promise<void> {
		const { app } = this;
		const shown = await app.collections();
		const roots = insertKey(shown.map((c) => c.root), root, anchor, position);
		if (app.sortOrder() === "manual") return app.setCollectionOrder(roots);
		const lists = siblingLists(shown);
		const orders = new Map([...lists].map(([dir, list]) => [dir, list.map((n) => n.path)]));
		await this.writeOrders(orders, new Map([...lists.values()].flat().map((n) => [n.path, n])));
		await app.useManualOrder(roots);
	}

	/** Writes `seq` wherever it differs, so each folder's items read in the given order. */
	private async writeOrders(orders: Map<string, string[]>, nodes: Map<string, TreeNode>, pathNow = (p: string) => p): Promise<void> {
		for (const order of orders.values()) {
			for (const u of seqUpdates(order.map((p) => ({ path: p, seq: nodes.get(p)?.seq })))) {
				const file = await this.app.store.setSeq(pathNow(u.path), nodes.get(u.path)?.kind ?? "request", u.seq);
				this.app.index.noteSeq(file, u.seq);
			}
		}
	}

	/** Renames through VS Code, so open editors follow the file. */
	private async move(from: string, to: string): Promise<boolean> {
		const { app } = this;
		if (!app.store.exists(from)) return false;
		if (app.store.exists(to)) {
			void vscode.window.showWarningMessage(`"${basename(to)}" already exists here.`);
			return false;
		}
		const edit = new vscode.WorkspaceEdit();
		edit.renameFile(vscode.Uri.file(app.fsPath(from)), vscode.Uri.file(app.fsPath(to)), { overwrite: false });
		if (!(await vscode.workspace.applyEdit(edit))) {
			void vscode.window.showErrorMessage(`Couldn't move "${basename(from)}".`);
			return false;
		}
		app.fileRenamed(from, to);
		return true;
	}

	private async trash(path: string): Promise<void> {
		try {
			await vscode.workspace.fs.delete(vscode.Uri.file(this.app.fsPath(path)), { recursive: true, useTrash: true });
			this.app.fileDeleted(path, true);
		} catch (e) {
			void vscode.window.showErrorMessage(`Couldn't delete "${basename(path)}": ${e instanceof Error ? e.message : String(e)}`);
		}
	}
}
