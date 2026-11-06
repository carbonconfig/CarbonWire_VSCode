import * as vscode from "vscode";
import type { HistoryEntry } from "../core/history";
import type { Environment, Folder, HttpRequest, OpenCollection } from "../core/model";
import type { SendResult } from "../core/sender";
import { basename, dirname, stem } from "../core/storage/paths";
import { COLLECTION_FILE, FOLDER_FILE } from "../core/storage/tree";
import type { DraftState, RequestHost, RequestTabState, RequestView, SavedTab, SettingsHost, SettingsView } from "../ui/panel-protocol";
import { Rpc, type Api, type Handlers } from "../ui/rpc";
import type { JsonAction } from "../ui/types";
import type { CarbonWire } from "./carbonwire";
import { debounce } from "./debounce";
import { promptSaveRequest, requestLocations } from "./prompt";
import { secretNames } from "./secrets";
import { webviewHtml, webviewRoot } from "./webview-html";
import type { SnippetLanguage } from "../core/export/snippet";

export const REQUEST_VIEW = "carbonwire.request";
/** The cookie manager is a settings tab with this in place of a file. */
export const COOKIES_TAB = "carbonwire:cookies";
export const SETTINGS_VIEW = "carbonwire.settings";
/* Edits reach the extension as they happen; files are written once typing pauses. */
const WRITE_DELAY_MS = 400;

/** The tab title for a collection, folder or environment file. */
export function settingsTitle(path: string): string {
	if (path === COOKIES_TAB) return "Cookies";
	const name = basename(path);
	if (name === "globals.yml") return "Globals";
	if (name === COLLECTION_FILE || name === FOLDER_FILE) return `${basename(dirname(path)) || "Collection"} settings`;
	return `${stem(path)} environment`;
}

const isUnder = (path: string, dir: string) => path === dir || path.startsWith(`${dir}/`);

/** A file extension for a saved response body, from its content type. */
function extensionFor(contentType: string): string {
	const type = contentType.split(";")[0]!.trim().toLowerCase();
	const known: Record<string, string> = {
		"application/json": ".json",
		"application/xml": ".xml",
		"text/xml": ".xml",
		"text/html": ".html",
		"text/plain": ".txt",
		"text/csv": ".csv",
		"application/pdf": ".pdf",
		"application/zip": ".zip",
		"image/png": ".png",
		"image/jpeg": ".jpg",
		"image/gif": ".gif",
		"image/webp": ".webp",
		"image/svg+xml": ".svg",
	};
	if (known[type]) return known[type];
	if (type.endsWith("+json")) return ".json";
	if (type.endsWith("+xml")) return ".xml";
	return "";
}

/**
 * Request, collection, folder and environment tabs. VS Code unloads a hidden tab's page and asks for
 * its state again, so the latest edits and response are kept here.
 */
export class Panels implements vscode.Disposable {
	/** Problems the tabs reported, also written to the log; for tests. */
	readonly problems: string[] = [];
	/** Timings the tabs reported; for the performance tests. */
	readonly metrics: { name: string; value: number }[] = [];
	readonly requests = new Set<RequestTab>();
	readonly settings = new Set<SettingsTab>();
	private active?: RequestTab;
	private readonly activeChanged = new vscode.EventEmitter<string | undefined>();
	/** The focused request tab's file, or undefined for an unsaved request; for the sidebar. */
	readonly onActiveRequestChanged = this.activeChanged.event;
	private readonly subscriptions: vscode.Disposable[];

	constructor(
		readonly extensionUri: vscode.Uri,
		readonly app: CarbonWire,
		readonly log: vscode.LogOutputChannel,
	) {
		const environmentChanged = () => {
			const environment = app.activeEnvironmentEntry();
			for (const tab of this.requests) tab.view.notify("setEnvironment", environment);
		};
		this.subscriptions = [
			// Collections-changed also fires when an environment is renamed or recoloured.
			app.onCollectionsChanged(environmentChanged),
			app.onEnvironmentChanged(environmentChanged),
			app.onSettingsChanged((settings) => {
				for (const tab of this.requests) tab.view.notify("setWrap", settings.wrapResponseLines);
			}),
			app.onDocumentsChanged(() => {
				for (const tab of this.requests) tab.view.notify("refreshVariables");
			}),
			app.onFileRenamed(({ from, to }) => {
				for (const tab of [...this.requests, ...this.settings]) tab.renamed(from, to);
			}),
			app.onTrashed((path) => {
				for (const tab of [...this.requests, ...this.settings]) if (tab.file && isUnder(tab.file, path)) tab.close();
			}),
			vscode.window.registerWebviewPanelSerializer(REQUEST_VIEW, {
				deserializeWebviewPanel: (panel, state: SavedTab | undefined) => {
					if (state) this.requests.add(new RequestTab(this, panel, "file" in state ? { file: state.file } : { draft: state.draft }));
					else panel.dispose();
					return Promise.resolve();
				},
			}),
			vscode.window.registerWebviewPanelSerializer(SETTINGS_VIEW, {
				deserializeWebviewPanel: (panel, state: SavedTab | undefined) => {
					if (state && "file" in state) this.settings.add(new SettingsTab(this, panel, state.file));
					else panel.dispose();
					return Promise.resolve();
				},
			}),
		];
	}

	openRequest(path: string): void {
		const existing = [...this.requests].find((t) => t.file === path);
		if (existing) return existing.reveal();
		const panel = vscode.window.createWebviewPanel(REQUEST_VIEW, stem(path), vscode.ViewColumn.Active, panelOptions(this.extensionUri, this.app.settings.keepHiddenTabsLoaded));
		this.requests.add(new RequestTab(this, panel, { file: path }));
	}

	/** Opens an unsaved request in a new tab; `dir` is where Save suggests putting it. */
	openDraft(draft: Partial<DraftState> = {}): void {
		const state: DraftState = { name: "New request", request: { http: { method: "GET", url: "" } }, ...draft };
		const panel = vscode.window.createWebviewPanel(REQUEST_VIEW, state.name, vscode.ViewColumn.Active, panelOptions(this.extensionUri, this.app.settings.keepHiddenTabsLoaded));
		this.requests.add(new RequestTab(this, panel, { draft: state }));
	}

	/** Reopens a send from history, with its response, as an unsaved request. */
	openHistoryEntry(entry: HistoryEntry): void {
		this.openDraft({ name: entry.name, request: entry.request, dir: entry.source ? dirname(entry.source) : undefined, historyId: entry.id });
	}

	/** Opens a collection, folder or environment file in its editor. */
	openSettings(path: string): void {
		const existing = [...this.settings].find((t) => t.file === path);
		if (existing) return existing.reveal();
		const panel = vscode.window.createWebviewPanel(SETTINGS_VIEW, settingsTitle(path), vscode.ViewColumn.Active, panelOptions(this.extensionUri, this.app.settings.keepHiddenTabsLoaded));
		this.settings.add(new SettingsTab(this, panel, path));
	}

	openCookies(): void {
		this.openSettings(COOKIES_TAB);
	}

	/** The collection of the request tab focused last, e.g. where a pasted request goes by default. */
	focusedCollection(): string | undefined {
		const file = this.active?.file;
		return file === undefined ? undefined : this.app.collectionFor(file)?.root;
	}

	/** The focused request tab, for commands such as Send. */
	activeRequest(): RequestTab | undefined {
		return this.active?.panel.active ? this.active : [...this.requests].find((t) => t.panel.active);
	}

	setActive(tab: RequestTab): void {
		this.active = tab;
		this.activeChanged.fire(tab.file);
	}

	removed(tab: RequestTab | SettingsTab): void {
		if (tab instanceof RequestTab) this.requests.delete(tab);
		else this.settings.delete(tab);
		if (this.active === tab) this.active = undefined;
	}

	problem(source: string, message: string): void {
		this.problems.push(message);
		this.log.error(`${source}: ${message}`);
	}

	/** Writes pending edits, e.g. before the extension stops. */
	async flush(): Promise<void> {
		await Promise.all([...this.requests, ...this.settings].map((t) => t.flush()));
	}

	dispose(): void {
		for (const s of this.subscriptions) s.dispose();
		this.activeChanged.dispose();
	}
}

/** A retained hidden tab switches back instantly but costs memory; `keepHiddenTabsLoaded` decides. */
function panelOptions(extensionUri: vscode.Uri, keepLoaded = false): vscode.WebviewPanelOptions & vscode.WebviewOptions {
	return { enableScripts: true, localResourceRoots: [webviewRoot(extensionUri)], retainContextWhenHidden: keepLoaded };
}

function tabIcon(extensionUri: vscode.Uri, name: string): { light: vscode.Uri; dark: vscode.Uri } {
	return { light: vscode.Uri.joinPath(extensionUri, "media", `${name}-light.svg`), dark: vscode.Uri.joinPath(extensionUri, "media", `${name}-dark.svg`) };
}

/** Wires a panel's webview to an RPC endpoint, and reloads its page each time VS Code asks. */
function connect<Local extends Api, Remote extends Api>(
	panels: Panels,
	panel: vscode.WebviewPanel,
	entry: string,
	handlers: Handlers<Local>,
): Rpc<Local, Remote> {
	panel.webview.options = panelOptions(panels.extensionUri);
	const rpc = new Rpc<Local, Remote>((message) => void panel.webview.postMessage(message), handlers);
	panel.webview.onDidReceiveMessage((message) => void rpc.receive(message));
	panel.webview.html = webviewHtml(panel.webview, panels.extensionUri, entry, { inlineStyles: entry === "request" });
	return rpc;
}

export class RequestTab {
	file?: string;
	/** How many times the page has loaded and asked for its state; for tests. */
	loads = 0;
	private draft?: DraftState;
	readonly view: Rpc<RequestHost, RequestView>;
	/** Edits not yet written to the file. */
	private pending?: HttpRequest;
	private result?: SendResult;
	private restoredAt?: number;
	private failure?: { message: string; time: number };
	private historyLoaded = false;
	private abort?: AbortController;
	private readonly write = debounce(() => void this.flush(), WRITE_DELAY_MS);

	constructor(
		private readonly panels: Panels,
		readonly panel: vscode.WebviewPanel,
		init: { file: string } | { draft: DraftState },
	) {
		if ("file" in init) this.file = init.file;
		else this.draft = init.draft;
		panel.iconPath = tabIcon(panels.extensionUri, "request");
		this.updateTitle();
		this.view = connect<RequestHost, RequestView>(panels, panel, "request", this.host());
		panel.onDidChangeViewState(() => {
			if (panel.active) panels.setActive(this);
		});
		panel.onDidDispose(() => {
			this.abort?.abort();
			void this.flush();
			this.view.dispose();
			panels.removed(this);
		});
		if (panel.active) panels.setActive(this);
	}

	reveal(): void {
		this.panel.reveal();
	}

	close(): void {
		this.write.cancel();
		this.pending = undefined;
		this.panel.dispose();
	}

	send(): void {
		this.view.notify("send");
	}

	save(): void {
		this.view.notify("save");
	}

	find(): void {
		this.view.notify("find");
	}

	jsonAction(action: JsonAction, path: string): Promise<string | undefined> {
		return this.view.call("jsonAction", action, path);
	}

	async flush(): Promise<void> {
		this.write.cancel();
		const request = this.pending;
		if (!request || !this.file) return;
		this.pending = undefined;
		try {
			await this.panels.app.store.saveEdited(this.file, request);
		} catch (e) {
			void vscode.window.showErrorMessage(`Couldn't save ${stem(this.file)}: ${e instanceof Error ? e.message : String(e)}`);
		}
	}

	renamed(from: string, to: string): void {
		if (!this.file || !isUnder(this.file, from)) return;
		this.file = to + this.file.slice(from.length);
		this.updateTitle();
		this.view.notify("setFile", this.file, stem(this.file));
		if (this.panel.active) this.panels.setActive(this);
	}

	private updateTitle(): void {
		this.panel.title = this.file ? stem(this.file) : (this.draft?.name ?? "Request");
	}

	private host(): Handlers<RequestHost> {
		const { app } = this.panels;
		return {
			ready: async () => {
				await app.collections();
				this.loads++;
				// VS Code focuses a new tab before its page has loaded; focusing again lets the URL field take it.
				if (this.loads === 1 && this.panel.active) setTimeout(() => this.panel.reveal(undefined, false), 0);
				const base = { environment: app.activeEnvironmentEntry(), layout: app.requestLayout(), wrap: app.settings.wrapResponseLines, isMac: process.platform === "darwin", snippetLanguage: app.state.snippetLanguage };
				if (this.file) {
					const file = this.file;
					if (!app.collectionFor(file)) return { message: "This file is not inside a CarbonWire collection." };
					let request: HttpRequest;
					try {
						request = this.pending ?? (await app.store.loadRequest(file));
					} catch (e) {
						return { message: `Couldn't read ${file}: ${e instanceof Error ? e.message : String(e)}` };
					}
					await this.loadLatest(file);
					return { ...base, ...this.shown(), name: stem(file), request, draft: false, file } satisfies RequestTabState;
				}
				const draft = this.draft ?? { name: "New request", request: {} };
				if (!this.historyLoaded && draft.historyId !== undefined) {
					this.historyLoaded = true;
					const restored = await this.loadHistory(draft.historyId);
					if (restored) [this.result, this.restoredAt] = [restored.result, restored.time];
				}
				return { ...base, ...this.shown(), name: draft.name, request: draft.request, draft: true, dir: draft.dir, historyId: draft.historyId } satisfies RequestTabState;
			},
			edit: (request) => {
				if (this.file) {
					this.pending = request;
					this.write();
				} else if (this.draft) {
					this.draft.request = request;
				}
			},
			saveDraft: (name, request) => this.saveDraft(name, request),
			send: async (name, request) => {
				this.abort = new AbortController();
				try {
					const result = await app.send(this.file, name, request, this.abort.signal, (progress) => this.view.notify("progress", progress));
					[this.result, this.restoredAt, this.failure] = [result, undefined, undefined];
					if (this.draft) this.draft.historyId = undefined;
					return result;
				} catch (e) {
					if (!this.abort.signal.aborted) [this.result, this.restoredAt, this.failure] = [undefined, undefined, { message: e instanceof Error ? e.message : String(e), time: Date.now() }];
					throw e;
				} finally {
					this.abort = undefined;
				}
			},
			cancel: () => this.abort?.abort(),
			openEnvironment: (path) => this.panels.openSettings(path),
			setLayout: async (layout) => {
				await app.setRequestLayout(layout);
				for (const tab of this.panels.requests) if (tab !== this) tab.view.notify("setLayout", layout);
			},
			setWrap: (wrap) => app.setWrapResponseLines(wrap),
			variableNames: (request) => app.variableNames(this.file, request),
			rename: async (name) => {
				if (!this.file) {
					if (this.draft) this.draft.name = name;
					this.updateTitle();
					return name;
				}
				await this.flush();
				const target = await app.actions.renameRequest(this.file, name);
				return target ? stem(target) : undefined;
			},
			copyCurl: (request) => app.copyCurl(this.file, request),
			notify: (message) => void vscode.window.showInformationMessage(message),
			copy: async (text) => {
				await vscode.env.clipboard.writeText(text);
				vscode.window.setStatusBarMessage("Copied.", 2000);
			},
			snippet: (request, language) => app.snippet(this.file, request, language as SnippetLanguage),
			setSnippetLanguage: async (language) => {
				await app.state.setSnippetLanguage(language);
			},
			headerPresets: () => app.headerPresets(),
			saveHeaderPreset: async (headers) => {
				const presets = await app.headerPresets();
				const name = await vscode.window.showInputBox({ title: "Save the headers as a preset", prompt: "A preset with this name is replaced.", placeHolder: "Preset name", validateInput: (v) => (v.trim() ? undefined : "Enter a name.") });
				if (!name?.trim()) return;
				const { upsertPreset } = await import("../core/header-presets");
				const kept = headers.filter((h) => h.name && !h.disabled).map((h) => ({ name: h.name, value: h.value }));
				await app.setHeaderPresets(upsertPreset(presets, { name: name.trim(), headers: kept }));
			},
			removeHeaderPreset: async () => {
				const presets = await app.headerPresets();
				const pick = await vscode.window.showQuickPick(presets.map((p) => ({ label: p.name, description: p.headers.map((h) => h.name).join(", ") })), { title: "Remove a header preset" });
				if (pick) await app.setHeaderPresets(presets.filter((p) => p.name !== pick.label));
			},
			saveBody: async (body, contentType, name) => {
				const folder = vscode.workspace.workspaceFolders?.[0]?.uri;
				const fileName = `${name.replace(/[/\\:*?"<>|]/g, "-") || "response"}${extensionFor(contentType)}`;
				const uri = await vscode.window.showSaveDialog({ defaultUri: folder ? vscode.Uri.joinPath(folder, fileName) : undefined, title: "Save the response body" });
				if (!uri) return;
				await vscode.workspace.fs.writeFile(uri, body);
				vscode.window.setStatusBarMessage(`Saved ${uri.fsPath}.`, 3000);
			},
			askName: async (title, value) => (await vscode.window.showInputBox({ title, value, validateInput: (v) => (v.trim() ? undefined : "Enter a name.") }))?.trim() || undefined,
			problem: (message) => this.panels.problem("Request tab", message),
			metric: (name, value) => {
				this.panels.metrics.push({ name, value });
				if (name === "longtask") this.panels.log.trace(`Request tab: a task took ${value} ms`);
			},
		};
	}

	/** The response to show: the last send in this tab, or one restored from history. */
	private shown(): Pick<RequestTabState, "result" | "restoredAt" | "error"> {
		if (this.failure) return { error: this.failure.message, restoredAt: this.failure.time };
		return { result: this.result, restoredAt: this.restoredAt };
	}

	/** A saved request shows its most recent send from history, once per tab. */
	private async loadLatest(path: string): Promise<void> {
		if (this.historyLoaded) return;
		this.historyLoaded = true;
		const entry = await this.panels.app.history.latestFor(path).catch(() => undefined);
		if (!entry) return;
		if (entry.error) {
			this.failure = { message: entry.error, time: entry.time };
			return;
		}
		const restored = await this.loadHistory(entry.id);
		if (restored) [this.result, this.restoredAt] = [restored.result, restored.time];
	}

	/** Rebuilds a send result from history; `sent` shows the request as written. */
	private async loadHistory(id: number): Promise<{ result: SendResult; time: number } | undefined> {
		const found = await this.panels.app.history.get(id).catch(() => undefined);
		const response = found?.entry.response;
		if (!found || !response) return undefined;
		const http = found.entry.request.http ?? {};
		return {
			time: found.entry.time,
			result: {
				sent: { method: http.method ?? "GET", url: http.url ?? "", headers: [], bodyBytes: 0 },
				response: { ...response, url: "", body: found.body, redirects: [] },
				warnings: [],
			},
		};
	}

	/** Asks where to save an unsaved request, then turns this tab into that file's tab. */
	private async saveDraft(name: string, request: HttpRequest): Promise<string | undefined> {
		const { app } = this.panels;
		const locations = requestLocations(await app.collections());
		if (locations.length === 0) {
			void vscode.window.showInformationMessage("Create a collection first.");
			return undefined;
		}
		const choice = await promptSaveRequest(locations, { name, dir: this.draft?.dir });
		if (!choice) return undefined;
		// Drops any sidebar position carried over from the request it came from.
		const copy = structuredClone(request);
		delete copy.info?.seq;
		const path = await app.store.createRequest(choice.dir, choice.name, copy);
		app.index.created(path);
		this.file = path;
		this.draft = undefined;
		this.updateTitle();
		this.view.notify("setFile", path, stem(path));
		this.panels.setActive(this);
		return stem(path);
	}
}

export class SettingsTab {
	loads = 0;
	private pending?: object;
	private readonly write = debounce(() => void this.flush(), WRITE_DELAY_MS);
	private readonly view: Rpc<SettingsHost, SettingsView>;
	private cookiesListener?: vscode.Disposable;

	constructor(
		private readonly panels: Panels,
		readonly panel: vscode.WebviewPanel,
		public file: string,
	) {
		panel.iconPath = tabIcon(panels.extensionUri, "settings");
		panel.title = settingsTitle(file);
		this.view = connect<SettingsHost, SettingsView>(panels, panel, "settings", this.host());
		if (file === COOKIES_TAB) {
			this.cookiesListener = panels.app.network.onCookiesChanged(async () => this.view.notify("setCookies", (await panels.app.network.cookieJar()).all()));
		}
		panel.onDidDispose(() => {
			void this.flush();
			this.cookiesListener?.dispose();
			this.view.dispose();
			panels.removed(this);
		});
	}

	reveal(): void {
		this.panel.reveal();
	}

	close(): void {
		this.write.cancel();
		this.pending = undefined;
		this.panel.dispose();
	}

	async flush(): Promise<void> {
		this.write.cancel();
		const doc = this.pending;
		if (!doc) return;
		this.pending = undefined;
		try {
			await this.panels.app.store.saveEdited(this.file, doc);
		} catch (e) {
			void vscode.window.showErrorMessage(`Couldn't save ${basename(this.file)}: ${e instanceof Error ? e.message : String(e)}`);
		}
	}

	/** Reloads the page, because secrets are looked up by the environment's file name. */
	renamed(from: string, to: string): void {
		if (!isUnder(this.file, from)) return;
		void this.flush();
		this.file = to + this.file.slice(from.length);
		this.panel.title = settingsTitle(this.file);
		this.panel.webview.html = webviewHtml(this.panel.webview, this.panels.extensionUri, "settings");
	}

	private host(): Handlers<SettingsHost> {
		const { app } = this.panels;
		return {
			ready: async () => {
				this.loads++;
				const file = this.file;
				const name = basename(file);
				if (file === COOKIES_TAB) return { kind: "cookies", cookies: (await app.network.cookieJar()).all() };
				try {
					if (name === COLLECTION_FILE || name === FOLDER_FILE) {
						const doc = (this.pending as OpenCollection | Folder | undefined) ?? (await app.store.loadDocument<OpenCollection | Folder>(file));
						return { kind: name === COLLECTION_FILE ? "collection" : "folder", file, doc };
					}
					const environment = (this.pending as Environment | undefined) ?? (await app.store.loadEnvironment(file));
					const names = secretNames(environment);
					await app.secrets.load(file, names);
					const secrets: Record<string, string> = {};
					for (const variable of names) {
						const value = app.secrets.get(file, variable);
						if (value !== null) secrets[variable] = value;
					}
					return { kind: "environment", file, environment, secrets, globals: file === app.globalsPath() };
				} catch (e) {
					return { message: `Couldn't read ${file}: ${e instanceof Error ? e.message : String(e)}` };
				}
			},
			edit: (doc) => {
				this.pending = doc;
				this.write();
			},
			renameEnvironment: async (name) => {
				await this.flush();
				const target = await app.actions.renameEnvironment(this.file, name);
				return target ? stem(target) : undefined;
			},
			setSecret: (name, value) => app.secrets.set(this.file, name, value),
			problem: (message) => this.panels.problem("Settings tab", message),
			deleteCookies: async (domain, name, path) => {
				const jar = await app.network.cookieJar();
				jar.delete((c) => (domain === undefined || c.domain === domain) && (name === undefined || c.name === name) && (path === undefined || c.path === path));
			},
			addCookie: async (url, setCookie) => {
				let target: URL;
				try {
					target = new URL(/^https?:\/\//i.test(url) ? url : `https://${url}`);
				} catch {
					return "Enter the URL the cookie is for, such as https://api.example.com/.";
				}
				const jar = await app.network.cookieJar();
				return jar.set(target, setCookie) ? undefined : "That cookie can't be set for this URL. Check its Domain.";
			},
		};
	}
}
