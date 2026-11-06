import type { HistoryEntry } from "../core/history";
import type { CollectionNode } from "../core/storage/tree";
import type { EnvironmentEntry } from "./types";

export interface SidebarState {
	/** False when no folder is open, so there is nowhere to keep collections. */
	hasWorkspace: boolean;
	collections: CollectionNode[];
	environments: EnvironmentEntry[];
	activeEnvironment: string;
	/** The request in the focused tab, highlighted in the tree. */
	activePath?: string;
	/** A collection to show as soon as the sidebar loads, e.g. one just imported. */
	reveal?: string;
}

/** What the sidebar keeps while VS Code unloads it, e.g. while another view is shown. */
export interface SavedSidebar {
	expanded: string[];
	mode: "collections" | "history";
}

export type MovePosition = "before" | "after" | "end";

/** Methods the extension exposes to the sidebar webview. */
export type SidebarHost = {
	/** Called once the webview has loaded; returns what to show. */
	ready(): SidebarState;
	open(path: string): void;
	newCollection(): void;
	newEnvironment(): void;
	openFolder(): void;
	selectEnvironment(name: string): void;
	editEnvironment(path: string): void;
	/** Opens the globals file, creating it when there's none. */
	editGlobals(): void;
	move(path: string, dir: string, anchor: string | undefined, position: MovePosition): void;
	moveCollection(root: string, anchor: string, position: "before" | "after"): void;
	moveEnvironment(path: string, anchor: string, position: "before" | "after"): void;
	/** Newest first. History loads only once its tab is first shown. */
	history(): HistoryEntry[];
	openHistory(id: number): void;
	clearHistory(): void;
	/** An error or blocked resource in the webview, for the log. */
	problem(message: string): void;
	/** A page timing; see `reportMetrics`. */
	metric(name: string, value: number): void;
};

/** Methods the sidebar webview exposes to the extension. */
export type SidebarView = {
	update(state: SidebarState): void;
	setActive(path: string | undefined): void;
	environmentChanged(name: string): void;
	/** Sent after history changes, once the History tab has been shown. */
	setHistory(entries: HistoryEntry[]): void;
	collapseAll(): void;
	/** Clears the filter and expands a collection, e.g. one just imported. */
	reveal(root: string): void;
};
