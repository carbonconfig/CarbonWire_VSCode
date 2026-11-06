import * as vscode from "vscode";
import type { ConsoleHost, ConsoleView } from "../ui/console-protocol";
import { Rpc } from "../ui/rpc";
import type { CarbonWire } from "./carbonwire";
import { webviewHtml, webviewRoot } from "./webview-html";

export const CONSOLE_VIEW = "carbonwire.console";

/** The Console view in the panel: the last sends, kept in memory only. */
export class ConsoleProvider implements vscode.WebviewViewProvider, vscode.Disposable {
	private rpc?: Rpc<ConsoleHost, ConsoleView>;
	private readonly subscription: vscode.Disposable;

	constructor(
		private readonly extensionUri: vscode.Uri,
		private readonly app: CarbonWire,
		private readonly log: vscode.LogOutputChannel,
	) {
		this.subscription = app.onConsole((entry) => (entry ? this.rpc?.notify("add", entry) : this.rpc?.notify("clear")));
	}

	resolveWebviewView(view: vscode.WebviewView): void {
		view.webview.options = { enableScripts: true, localResourceRoots: [webviewRoot(this.extensionUri)] };
		const rpc = new Rpc<ConsoleHost, ConsoleView>((message) => void view.webview.postMessage(message), {
			ready: () => this.app.console,
			clear: () => this.app.clearConsole(),
			copy: async (text) => {
				await vscode.env.clipboard.writeText(text);
				vscode.window.setStatusBarMessage("Copied.", 2000);
			},
			problem: (message) => this.log.error(`Console: ${message}`),
		});
		this.rpc = rpc;
		const received = view.webview.onDidReceiveMessage((message) => void rpc.receive(message));
		view.onDidDispose(() => {
			received.dispose();
			rpc.dispose();
			if (this.rpc === rpc) this.rpc = undefined;
		});
		view.webview.html = webviewHtml(view.webview, this.extensionUri, "console");
	}

	dispose(): void {
		this.subscription.dispose();
		this.rpc?.dispose();
	}
}
