import * as vscode from "vscode";
import { CarbonWire } from "./host/carbonwire";
import { CONSOLE_VIEW, ConsoleProvider } from "./host/console-view";
import { registerCommands } from "./host/commands";
import { Importer } from "./host/importer";
import { Panels } from "./host/panels";
import { EnvironmentStatus, SIDEBAR_VIEW, SidebarProvider } from "./host/sidebar";
import { UiActions } from "./host/ui-actions";

let app: CarbonWire | undefined;
let panels: Panels | undefined;

export interface TestApi {
	app: CarbonWire;
	sidebar: SidebarProvider;
	panels: Panels;
	importer: Importer;
	/** When activate() started and ended, by the extension host's performance.now(). */
	activation: { started: number; ended: number };
}

/** Returns internals only to the extension's own integration tests. */
export function activate(context: vscode.ExtensionContext): TestApi | undefined {
	const started = performance.now();
	const log = vscode.window.createOutputChannel("CarbonWire", { log: true });
	app = new CarbonWire(context);
	panels = new Panels(context.extensionUri, app, log);
	const ui = new UiActions(app, panels);
	const sidebar = new SidebarProvider(context.extensionUri, app, panels, ui, log);
	const importer = new Importer(app, panels, sidebar);
	const consoleView = new ConsoleProvider(context.extensionUri, app, log);
	context.subscriptions.push(
		log,
		app,
		panels,
		sidebar,
		panels.onActiveRequestChanged((path) => sidebar.setActive(path)),
		new EnvironmentStatus(app),
		consoleView,
		vscode.window.registerWebviewViewProvider(SIDEBAR_VIEW, sidebar),
		vscode.window.registerWebviewViewProvider(CONSOLE_VIEW, consoleView),
		...registerCommands(app, panels, ui, sidebar, importer),
	);
	// The status bar needs the environments, which are listed with the first scan.
	void app.collections();
	const activation = { started, ended: performance.now() };
	return context.extensionMode === vscode.ExtensionMode.Test ? { app, sidebar, panels, importer, activation } : undefined;
}

export async function deactivate(): Promise<void> {
	await panels?.flush();
	await app?.close();
}
