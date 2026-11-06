import type { CollectionNode, FolderNode, RequestNode } from "../core/storage/tree";

export type MenuTarget =
	| { kind: "collection"; collection: CollectionNode }
	| { kind: "folder"; collection: CollectionNode; folder: FolderNode }
	| { kind: "request"; collection: CollectionNode; request: RequestNode }
	| { kind: "environment"; path: string };

/**
 * The data-vscode-context for a row: VS Code shows the `webview/context` items whose `when`
 * matches it, and passes it to the chosen command.
 */
export function menuContext(target: MenuTarget, extra: Record<string, unknown> = {}): string {
	const item =
		target.kind === "collection"
			? { webviewSection: "collection", root: target.collection.root, hasEnvironments: target.collection.environments.length > 0 }
			: target.kind === "folder"
				? { webviewSection: "folder", path: target.folder.path }
				: target.kind === "request"
					? { webviewSection: "request", path: target.request.path }
					: { webviewSection: "environment", path: target.path };
	return JSON.stringify({ ...item, ...extra, preventDefaultContextMenuItems: true });
}

/** Short labels keep the method column narrow in the sidebar. */
export function methodLabel(method: string): string {
	const short: Record<string, string> = { DELETE: "DEL", OPTIONS: "OPT" };
	return short[method] ?? method;
}
