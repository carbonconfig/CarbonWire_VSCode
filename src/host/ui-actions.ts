import * as vscode from "vscode";
import type { SortOrder } from "../core/storage/order";
import { joinPath, stem } from "../core/storage/paths";
import { COLLECTION_FILE, FOLDER_FILE } from "../core/storage/tree";
import { defaultEnvColor } from "../ui/env-colors";
import type { CarbonWire } from "./carbonwire";
import { confirmAction, promptEnvironment, promptText } from "./prompt";
import type { Panels } from "./panels";

const SORT_OPTIONS: readonly (readonly [SortOrder, string])[] = [
	["manual", "Manual (drag to reorder)"],
	["name-asc", "Name (A to Z)"],
	["name-desc", "Name (Z to A)"],
	["modified-desc", "Last updated (newest first)"],
	["modified-asc", "Last updated (oldest first)"],
	["created-desc", "Created (newest first)"],
	["created-asc", "Created (oldest first)"],
];

/** Actions that ask the user something first, shared by the sidebar, its menus and the command palette. */
export class UiActions {
	constructor(
		private readonly app: CarbonWire,
		private readonly panels: Panels,
	) {}

	async newCollection(): Promise<void> {
		if (!this.requireWorkspace()) return;
		const name = await promptText("New collection", "", "My API", "Create");
		if (!name) return;
		const root = await this.app.store.createCollection(this.app.collectionsFolder(), name);
		this.app.index.created(joinPath(root, COLLECTION_FILE));
		vscode.window.setStatusBarMessage(`Created collection "${name}" in ${root}`, 4000);
	}

	async newFolder(dir: string): Promise<void> {
		const name = await promptText("New folder", "", "Users", "Create");
		if (!name) return;
		const folder = await this.app.store.createFolder(dir, name);
		this.app.index.created(joinPath(folder, FOLDER_FILE));
	}

	/** Opens an unsaved request; from a collection or folder, Save suggests that location. */
	newRequest(dir?: string): void {
		this.panels.openDraft({ dir });
	}

	async newEnvironment(): Promise<void> {
		if (!this.requireWorkspace()) return;
		const { app } = this;
		const choice = await promptEnvironment({ title: "New environment", action: "Create", name: "", color: defaultEnvColor(app.environments().length), suggest: true });
		if (!choice) return;
		const path = await app.store.createEnvironmentIn(app.environmentsFolder(), choice.name, { name: choice.name, color: choice.color, variables: [] });
		app.index.created(path);
		await app.setActiveEnvironment(stem(path));
		this.panels.openSettings(path);
	}

	async pickEnvironment(): Promise<void> {
		const { app } = this;
		await app.collections();
		const active = app.activeEnvironment();
		const items = [
			{ label: "No environment", name: "", description: active === "" ? "Active" : undefined },
			...app.environmentEntries().map((e) => ({ label: e.name, name: e.name, description: e.name === active ? "Active" : undefined })),
		];
		const picked = await vscode.window.showQuickPick(items, { title: "Active environment", placeHolder: "Variables from the active environment apply to every collection" });
		if (picked) await app.setActiveEnvironment(picked.name);
	}

	async pickSortOrder(): Promise<void> {
		const current = this.app.sortOrder();
		const items = SORT_OPTIONS.map(([order, label]) => ({ label, order, description: order === current ? "Current" : undefined }));
		const picked = await vscode.window.showQuickPick(items, { title: "Sort collections" });
		if (picked) await this.app.setSortOrder(picked.order);
	}

	async clearHistory(): Promise<void> {
		const ok = await confirmAction("Clear history?", "Every request and response in history on this device is removed.", "Clear");
		if (ok) await this.app.history.clear();
	}

	async openHistory(id: number): Promise<void> {
		const found = await this.app.history.get(id);
		if (found) this.panels.openHistoryEntry(found.entry);
	}

	private requireWorkspace(): boolean {
		if (this.app.hasWorkspace()) return true;
		void vscode.window.showInformationMessage("Open a folder first. CarbonWire keeps collections as files in it.");
		return false;
	}
}
