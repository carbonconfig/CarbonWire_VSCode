import * as vscode from "vscode";
import { joinPath, stem } from "../core/storage/paths";
import { COLLECTION_FILE } from "../core/storage/tree";
import type { CarbonWire } from "./carbonwire";
import { SIDEBAR_VIEW, type SidebarProvider } from "./sidebar";
import type { Importer } from "./importer";
import type { UiActions } from "./ui-actions";
import type { Panels } from "./panels";
import { CONSOLE_VIEW } from "./console-view";

/** The data-vscode-context of the sidebar row a menu was opened on; see `menuContext`. */
interface ItemContext {
	webviewSection?: string;
	/** A request, folder or environment file. */
	path?: string;
	/** A collection's root folder. */
	root?: string;
	/** A history entry. */
	id?: number;
}

/** Runs a command, showing its error instead of failing silently. */
function guarded<A extends unknown[]>(run: (...args: A) => unknown): (...args: A) => Promise<void> {
	return async (...args) => {
		try {
			await run(...args);
		} catch (e) {
			void vscode.window.showErrorMessage(e instanceof Error ? e.message : String(e));
		}
	};
}

export function registerCommands(app: CarbonWire, panels: Panels, ui: UiActions, sidebar: SidebarProvider, importer: Importer): vscode.Disposable[] {
	const { actions, store } = app;
	const command = (id: string, run: () => unknown) => vscode.commands.registerCommand(id, guarded(run));
	// Menu commands get the row's context; from anywhere else they get nothing, and do nothing.
	const onItem = (id: string, run: (item: ItemContext) => unknown) =>
		vscode.commands.registerCommand(id, guarded((item?: ItemContext) => (item ? run(item) : undefined)));
	const path = (item: ItemContext) => item.path ?? "";
	/** The collection or folder a "new" item goes into. */
	const dir = (item: ItemContext) => item.path ?? item.root ?? "";

	/* Exporting is rare, so its code loads on first use. */
	const exporter = async () => new (await import("./exporter")).Exporter(app);
	const historyEntry = async (item: ItemContext) => (item.id === undefined ? undefined : (await app.history.get(item.id))?.entry);

	return [
		command("carbonwire.openCollections", () => vscode.commands.executeCommand(`${SIDEBAR_VIEW}.focus`)),
		command("carbonwire.newCollection", () => ui.newCollection()),
		command("carbonwire.newEnvironment", () => ui.newEnvironment()),
		command("carbonwire.selectEnvironment", () => ui.pickEnvironment()),
		command("carbonwire.import", () => importer.run()),
		command("carbonwire.importEnvironment", () => importer.run({ environments: true })),
		// From the Explorer's context menu, with the file or folder right-clicked.
		vscode.commands.registerCommand("carbonwire.importFromExplorer", guarded((uri?: vscode.Uri) => uri && importer.fromUri(uri))),
		command("carbonwire.sortCollections", () => ui.pickSortOrder()),
		command("carbonwire.collapseAll", () => sidebar.collapseAll()),
		command("carbonwire.clearHistory", () => ui.clearHistory()),
		command("carbonwire.newRequest", () => ui.newRequest()),
		command("carbonwire.sendRequest", () => panels.activeRequest()?.send()),
		command("carbonwire.saveRequest", () => panels.activeRequest()?.save()),
		command("carbonwire.findInRequest", () => panels.activeRequest()?.find()),
		onItem("carbonwire.copyJsonValue", async (item) => {
			const text = item.path === undefined ? undefined : await panels.activeRequest()?.jsonAction("copyValue", item.path);
			if (text !== undefined) await vscode.env.clipboard.writeText(text);
		}),
		onItem("carbonwire.copyJsonPath", (item) => item.path !== undefined && vscode.env.clipboard.writeText(item.path)),
		onItem("carbonwire.expandJson", (item) => item.path !== undefined && panels.activeRequest()?.jsonAction("expandAll", item.path)),
		onItem("carbonwire.collapseJson", (item) => item.path !== undefined && panels.activeRequest()?.jsonAction("collapseAll", item.path)),
		command("carbonwire.openSettings", () => vscode.commands.executeCommand("workbench.action.openSettings", "@ext:carbonconfig.carbonwire")),
		command("carbonwire.openConsole", () => vscode.commands.executeCommand(`${CONSOLE_VIEW}.focus`)),
		command("carbonwire.clearConsole", () => app.clearConsole()),
		command("carbonwire.manageCookies", () => panels.openCookies()),
		command("carbonwire.clearOAuthTokens", () => {
			app.clearOAuthTokens();
			vscode.window.setStatusBarMessage("OAuth 2.0 tokens cleared. The next send fetches new ones.", 3000);
		}),
		command("carbonwire.editGlobals", async () => {
			const path = app.globalsPath();
			if (!store.exists(path)) await store.saveDocument(path, { name: "globals", variables: [] });
			panels.openSettings(path);
		}),
		command("carbonwire.setProxyPassword", async () => {
			const value = await vscode.window.showInputBox({ title: "Proxy password", prompt: "Kept in VS Code's secret storage. Leave empty to remove it.", password: true, ignoreFocusOut: true });
			if (value !== undefined) await app.network.setProxyPassword(value);
		}),
		command("carbonwire.setCertificatePassphrase", async () => {
			const hosts = app.settings.clientCertificates.map((c) => c.host?.trim()).filter((h): h is string => Boolean(h));
			if (hosts.length === 0) {
				const open = await vscode.window.showInformationMessage("Add a client certificate in the CarbonWire: Client Certificates setting first.", "Open settings");
				if (open) await vscode.commands.executeCommand("workbench.action.openSettings", "carbonwire.clientCertificates");
				return;
			}
			const host = hosts.length === 1 ? hosts[0] : await vscode.window.showQuickPick(hosts, { title: "The certificate for which host?" });
			if (!host) return;
			const value = await vscode.window.showInputBox({ title: `Passphrase for ${host}`, prompt: "Kept in VS Code's secret storage. Leave empty to remove it.", password: true, ignoreFocusOut: true });
			if (value !== undefined) await app.network.setCertificatePassphrase(host, value);
		}),
		onItem("carbonwire.exportCollection", async (item) => item.root !== undefined && (await exporter()).exportCollection(item.root)),
		onItem("carbonwire.exportEnvironment", async (item) => (await exporter()).exportEnvironment(path(item))),

		onItem("carbonwire.newRequestHere", (item) => ui.newRequest(dir(item))),
		onItem("carbonwire.newFolderHere", (item) => ui.newFolder(dir(item))),
		onItem("carbonwire.importIntoCollection", (item) => importer.run({ collectionRoot: item.root })),
		onItem("carbonwire.collectionSettings", (item) => panels.openSettings(joinPath(item.root ?? "", COLLECTION_FILE))),
		onItem("carbonwire.addCollectionEnvironments", (item) => actions.copyCollectionEnvironments(app.index.manualTree().find((c) => c.root === item.root)?.environments ?? [])),

		onItem("carbonwire.renameFolder", (item) => actions.renameFolder(path(item))),
		onItem("carbonwire.folderSettings", async (item) => panels.openSettings(await store.ensureFolderConfig(path(item)))),
		onItem("carbonwire.deleteFolder", (item) => actions.deleteFolder(path(item))),

		onItem("carbonwire.openRequest", (item) => panels.openRequest(path(item))),
		onItem("carbonwire.renameRequest", (item) => actions.renameRequest(path(item))),
		onItem("carbonwire.duplicateRequest", async (item) => panels.openRequest(await actions.duplicateRequest(path(item)))),
		onItem("carbonwire.copyRequestAsCurl", async (item) => app.copyCurl(path(item), await store.loadRequest(path(item)))),
		onItem("carbonwire.deleteRequest", (item) => actions.deleteRequest(path(item))),

		onItem("carbonwire.activateEnvironment", (item) => app.setActiveEnvironment(stem(path(item)))),
		onItem("carbonwire.deactivateEnvironment", () => app.setActiveEnvironment("")),
		onItem("carbonwire.editEnvironment", (item) => panels.openSettings(path(item))),
		onItem("carbonwire.renameEnvironment", (item) => actions.renameEnvironment(path(item))),
		onItem("carbonwire.duplicateEnvironment", (item) => actions.duplicateEnvironment(path(item))),
		onItem("carbonwire.deleteEnvironment", (item) => actions.deleteEnvironment(path(item))),

		onItem("carbonwire.openHistoryEntry", async (item) => {
			const entry = await historyEntry(item);
			if (entry) panels.openHistoryEntry(entry);
		}),
		onItem("carbonwire.openHistorySource", async (item) => {
			const source = (await historyEntry(item))?.source;
			if (source && store.exists(source)) panels.openRequest(source);
			else void vscode.window.showInformationMessage("The saved request has been moved or deleted.");
		}),
		onItem("carbonwire.copyHistoryAsCurl", async (item) => {
			const entry = await historyEntry(item);
			// The saved request's collection applies only while the file is still in place.
			const source = entry?.source && store.exists(entry.source) ? entry.source : undefined;
			if (entry) await app.copyCurl(source, entry.request);
		}),
		onItem("carbonwire.deleteHistoryEntry", (item) => item.id !== undefined && app.history.remove([item.id])),
	];
}
