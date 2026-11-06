import * as vscode from "vscode";
import { stem } from "../core/storage/paths";
import { Rpc, type Handlers } from "../ui/rpc";
import type { SidebarHost, SidebarState, SidebarView } from "../ui/sidebar-protocol";
import type { CarbonWire } from "./carbonwire";
import type { UiActions } from "./ui-actions";
import { webviewHtml, webviewRoot } from "./webview-html";
import type { Panels } from "./panels";

export const SIDEBAR_VIEW = "carbonwire.sidebar";

/**
 * The activity bar view: collections, history and environments. VS Code unloads it while hidden, so
 * each load asks for the current state.
 */
export class SidebarProvider implements vscode.WebviewViewProvider, vscode.Disposable {
	private rpc?: Rpc<SidebarHost, SidebarView>;
	private historyShown = false;
	private pendingReveal?: string;
	/** How many times the webview has loaded and asked for its state; for tests. */
	loads = 0;
	/** Problems the webview reported, also written to the log; for tests. */
	readonly problems: string[] = [];
	/** Timings the webview reported; for the performance tests. */
	readonly metrics: { name: string; value: number }[] = [];
	private readonly subscriptions: vscode.Disposable[];

	constructor(
		private readonly extensionUri: vscode.Uri,
		private readonly app: CarbonWire,
		private readonly panels: Panels,
		private readonly ui: UiActions,
		private readonly log: vscode.LogOutputChannel,
	) {
		this.subscriptions = [
			app.onCollectionsChanged(() => this.rpc?.notify("update", this.currentState())),
			app.onEnvironmentChanged((name) => this.rpc?.notify("environmentChanged", name)),
			app.onHistoryChanged(() => void this.sendHistory()),
		];
	}

	resolveWebviewView(view: vscode.WebviewView): void {
		this.metrics.push({ name: "resolved", value: Date.now() });
		view.webview.options = { enableScripts: true, localResourceRoots: [webviewRoot(this.extensionUri)] };
		const rpc = new Rpc<SidebarHost, SidebarView>((message) => void view.webview.postMessage(message), this.host());
		this.rpc = rpc;
		this.historyShown = false;
		const received = view.webview.onDidReceiveMessage((message) => void rpc.receive(message));
		view.onDidDispose(() => {
			received.dispose();
			rpc.dispose();
			if (this.rpc === rpc) this.rpc = undefined;
		});
		view.webview.html = webviewHtml(view.webview, this.extensionUri, "sidebar");
	}

	collapseAll(): void {
		this.rpc?.notify("collapseAll");
	}

	/** Shows the sidebar with a collection expanded and the filter cleared. */
	async reveal(root: string): Promise<void> {
		// A sidebar that isn't loaded yet shows it as soon as it loads.
		this.pendingReveal = root;
		await vscode.commands.executeCommand(`${SIDEBAR_VIEW}.focus`);
		if (this.rpc) {
			this.rpc.notify("reveal", root);
			this.pendingReveal = undefined;
		}
	}

	setActive(path: string | undefined): void {
		this.rpc?.notify("setActive", path);
	}

	dispose(): void {
		for (const s of this.subscriptions) s.dispose();
		this.rpc?.dispose();
	}

	private currentState(): SidebarState {
		const { app } = this;
		return {
			hasWorkspace: app.hasWorkspace(),
			collections: app.index.collections(),
			environments: app.environmentEntries(),
			activeEnvironment: app.activeEnvironment(),
		};
	}

	private async sendHistory(): Promise<void> {
		if (this.historyShown) this.rpc?.notify("setHistory", [...(await this.app.history.list())]);
	}

	private host(): Handlers<SidebarHost> {
		const { app, ui, panels } = this;
		return {
			ready: async () => {
				this.metrics.push({ name: "readyCalled", value: Date.now() });
				await app.collections();
				this.loads++;
				const reveal = this.pendingReveal;
				this.pendingReveal = undefined;
				return { ...this.currentState(), reveal };
			},
			open: (path) => panels.openRequest(path),
			newCollection: () => void ui.newCollection(),
			newEnvironment: () => void ui.newEnvironment(),
			openFolder: () => void vscode.commands.executeCommand("workbench.action.files.openFolder"),
			selectEnvironment: (name) => void app.setActiveEnvironment(name),
			editEnvironment: (path) => panels.openSettings(path),
			editGlobals: () => void vscode.commands.executeCommand("carbonwire.editGlobals"),
			move: (path, dir, anchor, position) => void app.actions.moveTreeItem(path, dir, anchor, position),
			moveCollection: (root, anchor, position) => void app.actions.moveCollection(root, anchor, position),
			moveEnvironment: (path, anchor, position) => void app.moveEnvironment(path, anchor, position),
			history: async () => {
				this.historyShown = true;
				try {
					return [...(await app.history.list())];
				} catch (e) {
					void vscode.window.showErrorMessage(`Couldn't load history: ${e instanceof Error ? e.message : String(e)}`);
					return [];
				}
			},
			openHistory: (id) => void ui.openHistory(id),
			clearHistory: () => void ui.clearHistory(),
			problem: (message) => {
				this.problems.push(message);
				this.log.error(`Sidebar: ${message}`);
			},
			metric: (name, value) => {
				this.metrics.push({ name, value });
				if (name === "longtask") this.log.trace(`Sidebar: a task took ${value} ms`);
			},
		};
	}
}

/** The active environment in the status bar; selecting it switches environments. */
export class EnvironmentStatus implements vscode.Disposable {
	private readonly item = vscode.window.createStatusBarItem("carbonwire.environment", vscode.StatusBarAlignment.Left, 10);
	private readonly subscriptions: vscode.Disposable[];

	constructor(private readonly app: CarbonWire) {
		this.item.name = "CarbonWire Environment";
		this.item.command = "carbonwire.selectEnvironment";
		this.subscriptions = [app.onEnvironmentChanged(() => this.update()), app.onCollectionsChanged(() => this.update())];
		this.update();
	}

	dispose(): void {
		for (const s of this.subscriptions) s.dispose();
		this.item.dispose();
	}

	private update(): void {
		const { app } = this;
		const environments = app.environments();
		// Shown once the workspace has something CarbonWire uses.
		if (!app.hasWorkspace() || (environments.length === 0 && app.index.collections().length === 0)) {
			this.item.hide();
			return;
		}
		const name = app.activeEnvironment();
		const path = environments.find((p) => stem(p) === name);
		this.item.text = `$(globe) ${name || "No environment"}`;
		this.item.tooltip = path ? `CarbonWire environment: ${name}\n${path}\n\nSelect to switch environments.` : "No CarbonWire environment is active. Select to choose one.";
		this.item.show();
	}
}
