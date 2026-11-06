import { readFile, stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import * as vscode from "vscode";
import type { OAuth2Tokens } from "../core/auth/oauth2";
import type { HttpRequest } from "../core/model";
import { buildRequest } from "../core/request-builder";
import type { SendResult } from "../core/sender";
import { insertKey, type SortOrder } from "../core/storage/order";
import { basename, dirname, joinPath, stem } from "../core/storage/paths";
import { CollectionStore } from "../core/storage/store";
import { compare, isYaml, type CollectionNode } from "../core/storage/tree";
import { TransportError, type SendProgress, type Transport } from "../core/transport/types";
import { resolveEnvironment } from "../core/variables";
import type { ConsoleEntry, EnvironmentEntry, RequestLayout } from "../ui/types";
import { CollectionIndex } from "./collection-index";
import { debounce } from "./debounce";
import { HistoryStore, type HistoryEntry } from "./history";
import { ItemActions } from "./item-actions";
import { PathMap, type WorkspaceRoot } from "./paths";
import { secretNames, Secrets } from "./secrets";
import { affectsSetting, readSettings, State, updateSetting, usesVSCodeProxy, type Settings } from "./settings";
import { findYaml } from "./find-yaml";
import { cookieFile, Network } from "./network";
import type { SnippetLanguage } from "../core/export/snippet";
import { DiskFiles } from "./workspace-files";


/** The globals file in the environments folder: the outermost variable scope, not an environment. */
export const GLOBALS_FILE = "globals.yml";
const CONSOLE_SIZE = 200;
const CONSOLE_PREVIEW = 64 * 1024;

export interface Renamed {
	from: string;
	to: string;
}

/* Network errors a proxy from the system settings would explain when connecting directly. */
const PROXY_HINT_CODES = new Set(["ENOTFOUND", "EAI_AGAIN", "ETIMEDOUT", "ECONNRESET", "ENETUNREACH", "EHOSTUNREACH"]);

function withProxyHint(error: unknown, settings: Settings): unknown {
	// Checked by name: the error comes from send.js, which has its own copy of the class.
	if (!(error instanceof Error) || error.name !== "TransportError") return error;
	const transportError = error as TransportError;
	if (transportError.code !== "network" || !PROXY_HINT_CODES.has(transportError.systemError?.code ?? "")) return error;
	if (usesVSCodeProxy(settings.proxy)) return error;
	const hint = " If you connect through a proxy, set CarbonWire: Proxy to use VS Code's proxy settings.";
	return new TransportError(transportError.code, error.message + hint, transportError.systemError);
}

function workspaceRoots(): WorkspaceRoot[] {
	return (vscode.workspace.workspaceFolders ?? []).filter((f) => f.uri.scheme === "file").map((f) => ({ name: f.name, fsPath: f.uri.fsPath }));
}

/** Everything outside the webviews: collection files, the index, environments, secrets, history and sending. */
export class CarbonWire implements vscode.Disposable {
	settings: Settings = readSettings();
	readonly state: State;
	readonly files: DiskFiles;
	readonly store: CollectionStore;
	readonly index: CollectionIndex;
	readonly history: HistoryStore;
	readonly secrets: Secrets;
	readonly actions: ItemActions;
	readonly network: Network;
	/** The last sends, newest last, for the console. */
	readonly console: ConsoleEntry[] = [];
	private consoleId = 0;
	private paths = new PathMap(workspaceRoots());
	private transport?: Transport;
	private oauth2?: OAuth2Tokens;
	private readonly disposables: vscode.Disposable[] = [];
	private readonly folderWatchers: vscode.Disposable[] = [];
	private readonly collectionsChanged = new vscode.EventEmitter<CollectionNode[]>();
	private readonly environmentChanged = new vscode.EventEmitter<string>();
	private readonly historyChanged = new vscode.EventEmitter<void>();
	private readonly documentsChangedEmitter = new vscode.EventEmitter<void>();
	private readonly settingsChanged = new vscode.EventEmitter<Settings>();
	private readonly fileRenamedEmitter = new vscode.EventEmitter<Renamed>();
	private readonly trashedEmitter = new vscode.EventEmitter<string>();
	private readonly consoleEmitter = new vscode.EventEmitter<ConsoleEntry | undefined>();
	/** A send was logged, or the console was cleared (undefined). */
	readonly onConsole = this.consoleEmitter.event;

	readonly onCollectionsChanged = this.collectionsChanged.event;
	readonly onEnvironmentChanged = this.environmentChanged.event;
	readonly onHistoryChanged = this.historyChanged.event;
	/** A collection, folder or environment file changed on disk. */
	readonly onDocumentsChanged = this.documentsChangedEmitter.event;
	readonly onSettingsChanged = this.settingsChanged.event;
	/** A file or folder moved; open tabs follow it. */
	readonly onFileRenamed = this.fileRenamedEmitter.event;
	/** A file or folder was deleted from CarbonWire; its open tabs close. */
	readonly onTrashed = this.trashedEmitter.event;

	private readonly documentsChanged = debounce(() => this.documentsChangedEmitter.fire(), 300);

	constructor(private readonly context: vscode.ExtensionContext) {
		this.state = new State(context);
		this.files = new DiskFiles(() => this.paths);
		this.store = new CollectionStore(this.files, (path) => this.index.collectionFor(path)?.root);
		this.index = new CollectionIndex(
			{ listYaml: (dir) => this.listYaml(dir), stat: (path) => this.files.stat(path), read: (path) => this.files.read(path) },
			{
				rootName: () => this.paths.rootName(),
				sortOrder: () => this.state.sortOrder,
				collectionOrder: () => this.state.collectionOrder,
				environmentsFolder: () => this.environmentsFolder(),
				changed: (collections) => this.collectionsChanged.fire(collections),
				loadCache: () => this.state.metaCache,
				saveCache: (cache) => this.state.setMetaCache(cache),
			},
		);
		const storage = context.storageUri ?? context.globalStorageUri;
		this.history = new HistoryStore(vscode.Uri.joinPath(storage, "history").fsPath, () => this.settings.historySize, () => this.historyChanged.fire());
		this.secrets = new Secrets(context.secrets);
		this.network = new Network(context.secrets, () => this.settings, (path) => this.files.fsPath(this.paths.fromSetting(path)), cookieFile(storage), (message) => void vscode.window.showWarningMessage(message));
		this.actions = new ItemActions(this);
		this.watch();
	}

	/** Waits for the metadata cache and history to be written. */
	async close(): Promise<void> {
		await Promise.all([this.index.flush(), this.history.close(), this.network.flush()]);
	}

	dispose(): void {
		this.documentsChanged.cancel();
		this.transport?.dispose();
		this.secrets.dispose();
		this.network.dispose();
		for (const d of this.disposables) d.dispose();
		for (const e of [this.consoleEmitter, this.collectionsChanged, this.environmentChanged, this.historyChanged, this.documentsChangedEmitter, this.settingsChanged, this.fileRenamedEmitter, this.trashedEmitter]) e.dispose();
	}

	hasWorkspace(): boolean {
		return !this.paths.empty;
	}

	/** Collections in the sidebar's sort order, once the workspace has been scanned. */
	async collections(): Promise<CollectionNode[]> {
		await this.index.ready();
		return this.index.collections();
	}

	collectionFor(path: string): CollectionNode | undefined {
		return this.index.collectionFor(path);
	}

	/** Absolute path on disk, e.g. for revealing a file. */
	fsPath(path: string): string {
		return this.files.fsPath(path);
	}

	collectionsFolder(): string {
		return this.paths.fromSetting(this.settings.collectionsFolder);
	}

	environmentsFolder(): string {
		return this.paths.fromSetting(this.settings.environmentsFolder);
	}

	sortOrder(): SortOrder {
		return this.state.sortOrder;
	}

	async setSortOrder(order: SortOrder): Promise<void> {
		if (this.state.sortOrder === order) return;
		await this.state.setSortOrder(order);
		this.index.rebuild();
	}

	/** Switches to manual order, with the collections in the order they are shown. */
	async useManualOrder(roots: string[]): Promise<void> {
		await Promise.all([this.state.setCollectionOrder(roots), this.state.setSortOrder("manual")]);
		this.index.rebuild();
	}

	async setCollectionOrder(roots: string[]): Promise<void> {
		await this.state.setCollectionOrder(roots);
		this.index.rebuild();
	}

	async moveEnvironment(path: string, anchor: string, position: "before" | "after"): Promise<void> {
		await this.state.setEnvironmentOrder(insertKey(this.environments().map(stem), stem(path), stem(anchor), position));
		this.index.rebuild();
	}

	globalsPath(): string {
		return joinPath(this.environmentsFolder(), GLOBALS_FILE);
	}

	/** Environment files, shared by every collection, in the order they were dragged to. */
	environments(): string[] {
		const rank = new Map(this.state.environmentOrder.map((name, i) => [name, i]));
		const globals = this.globalsPath();
		return [...this.index.environments()].filter((p) => p !== globals).sort((a, b) => (rank.get(stem(a)) ?? Infinity) - (rank.get(stem(b)) ?? Infinity) || compare(stem(a), stem(b)));
	}

	/** Environments with the colour from their file, once the background scan has read it. */
	environmentEntries(): EnvironmentEntry[] {
		return this.environments().map((path) => ({ path, name: stem(path), color: this.index.metaFor(path)?.color }));
	}

	activeEnvironmentEntry(): EnvironmentEntry | undefined {
		const name = this.activeEnvironment();
		return name ? this.environmentEntries().find((e) => e.name === name) : undefined;
	}

	/** Environments are identified by file name; returns "" when none is active or it no longer exists. */
	activeEnvironment(): string {
		const name = this.state.activeEnvironment;
		return name && this.environments().some((p) => stem(p) === name) ? name : "";
	}

	async setActiveEnvironment(name: string): Promise<void> {
		if (this.state.activeEnvironment === name) return;
		await this.state.setActiveEnvironment(name);
		this.environmentChanged.fire(name);
	}

	requestLayout(): RequestLayout {
		return this.state.requestLayout;
	}

	async setRequestLayout(layout: RequestLayout): Promise<void> {
		await this.state.setRequestLayout(layout);
	}

	async setWrapResponseLines(wrap: boolean): Promise<void> {
		await updateSetting("wrapLongLines", wrap);
	}

	/** Sends a saved request, or an unsaved one (no `path`, so only the environment applies), and records it in history. */
	async send(path: string | undefined, name: string, request: HttpRequest, signal: AbortSignal, onProgress?: (progress: SendProgress) => void): Promise<SendResult> {
		const time = Date.now();
		const environment = this.activeEnvironment() || undefined;
		const record = (outcome: Pick<HistoryEntry, "error"> & { response?: SendResult["response"] }) =>
			void this.history.add({ time, name, source: path, environment, request, ...outcome }).catch(() => undefined);
		let resolvedUrl = request.http?.url ?? "";
		try {
			const [{ requestScope, sendRequest }, transport, oauth2, cookies] = await Promise.all([import("../core/sender"), this.getTransport(), this.getOAuth2(), this.network.cookieHooks(), this.network.ready()]);
			const { root, context, scope } = await this.scopeFor(path, request, requestScope);
			const resolved = buildRequest(request, context.chain, scope);
			resolvedUrl = resolved.url;
			const result = await sendRequest(resolved, {
				transport,
				oauth2,
				readFile: (file) => this.readBodyFile(root, file),
				rejectUnauthorized: this.settings.rejectUnauthorized,
				maxBodyBytes: Math.round(this.settings.maxResponseMB * 1024 * 1024),
				signal,
				onProgress,
				cookies,
			});
			record({ response: result.response });
			this.log(time, name, path, request, result);
			return result;
		} catch (e) {
			const message = e instanceof Error ? e.message : String(e);
			if (!signal.aborted) {
				record({ error: message });
				this.log(time, name, path, { ...request, http: { ...request.http, url: resolvedUrl } }, undefined, message);
			}
			throw withProxyHint(e, this.settings);
		}
	}

	/** Copies the request as cURL, resolved as it would be sent, with absolute body file paths. */
	async copyCurl(path: string | undefined, request: HttpRequest): Promise<void> {
		try {
			const [{ requestScope, withOAuth2 }, { toCurl }, oauth2] = await Promise.all([import("../core/sender"), import("../core/export/curl"), this.getOAuth2()]);
			const { root, context, scope } = await this.scopeFor(path, request, requestScope);
			const resolved = await withOAuth2(buildRequest(request, context.chain, scope), oauth2, { rejectUnauthorized: this.settings.rejectUnauthorized });
			const absolute = (file: string) => (isAbsolute(file) ? file : this.files.fsPath(joinPath(root, file)));
			await vscode.env.clipboard.writeText(toCurl(resolved, { filePath: absolute, insecure: !this.settings.rejectUnauthorized }));
			vscode.window.setStatusBarMessage("Copied as cURL.", 3000);
		} catch (e) {
			void vscode.window.showErrorMessage(`Couldn't copy as cURL: ${e instanceof Error ? e.message : String(e)}`);
		}
	}

	/**
	 * The request as code, resolved as it would be sent. No OAuth 2.0 token is fetched, so the Code tab
	 * never starts a browser sign-in.
	 */
	async snippet(path: string | undefined, request: HttpRequest, language: SnippetLanguage): Promise<string> {
		const [{ requestScope }, { snippet }] = await Promise.all([import("../core/sender"), import("../core/export/snippet")]);
		const { root, context, scope } = await this.scopeFor(path, request, requestScope);
		const resolved = buildRequest(request, context.chain, scope);
		const absolute = (file: string) => (isAbsolute(file) ? file : this.files.fsPath(joinPath(root, file)));
		return snippet(language, resolved, { filePath: absolute, insecure: !this.settings.rejectUnauthorized || !resolved.settings.verifyTls });
	}

	/** Header presets from .carbonwire/header-presets.json at the first workspace folder. */
	async headerPresets(): Promise<import("../core/header-presets").HeaderPreset[]> {
		const { HEADER_PRESETS_FILE, parsePresets } = await import("../core/header-presets");
		const path = this.paths.fromSetting(HEADER_PRESETS_FILE);
		return this.files.exists(path) ? parsePresets(await this.files.read(path)) : [];
	}

	async setHeaderPresets(presets: import("../core/header-presets").HeaderPreset[]): Promise<void> {
		const { HEADER_PRESETS_FILE, serializePresets } = await import("../core/header-presets");
		await this.files.write(this.paths.fromSetting(HEADER_PRESETS_FILE), serializePresets(presets));
	}

	clearConsole(): void {
		this.console.length = 0;
		this.consoleEmitter.fire(undefined);
	}

	/** Forgets OAuth 2.0 tokens, so the next send fetches new ones (or signs in again). */
	clearOAuthTokens(): void {
		this.oauth2?.clear();
	}

	private log(time: number, name: string, source: string | undefined, request: HttpRequest, result: SendResult | undefined, error?: string): void {
		const response = result?.response;
		const type = response?.headers.find(([n]) => n.toLowerCase() === "content-type")?.[1] ?? "";
		const textual = response !== undefined && !/^(image|audio|video)\/|application\/(pdf|zip|octet-stream)/i.test(type);
		const entry: ConsoleEntry = {
			id: ++this.consoleId,
			time,
			name,
			source,
			method: result?.sent.method ?? (request.http?.method ?? "GET").toUpperCase(),
			url: result?.sent.url ?? request.http?.url ?? "",
			requestHeaders: result?.sent.headers ?? [],
			requestBody: result?.sent.bodyPreview,
			requestBytes: result?.sent.bodyBytes ?? 0,
			status: response?.status,
			statusText: response?.statusText,
			httpVersion: response?.httpVersion,
			responseHeaders: response?.headers,
			responseBody: textual ? new TextDecoder().decode(response.body.subarray(0, CONSOLE_PREVIEW)) : undefined,
			responseBytes: response?.bodyBytes,
			durationMs: response?.timings.total,
			redirects: response?.redirects,
			remoteAddress: response?.remoteAddress,
			proxy: response?.proxy,
			tls: response?.tls && { protocol: response.tls.protocol, cipher: response.tls.cipher },
			error,
		};
		this.console.push(entry);
		if (this.console.length > CONSOLE_SIZE) this.console.splice(0, this.console.length - CONSOLE_SIZE);
		this.consoleEmitter.fire(entry);
	}

	/** Names of every variable the request can use with the active environment, for highlighting. */
	async variableNames(path: string | undefined, request: HttpRequest): Promise<string[]> {
		const { requestScope } = await import("../core/sender");
		const scoped = await this.scopeFor(path, request, requestScope).catch(() => undefined);
		return scoped ? [...scoped.scope.keys()] : [];
	}

	/** Follows a rename or move made in CarbonWire or elsewhere in VS Code. Both report it, so it's safe to call twice. */
	fileRenamed(from: string, to: string): void {
		const fromRoot = this.index.collectionFor(from)?.root;
		this.store.invalidateUnder(from);
		this.store.invalidateUnder(to);
		this.index.renamed(from, to);
		const toRoot = this.index.collectionFor(to)?.root;
		if (fromRoot !== undefined && toRoot !== undefined) void this.store.followSidecar({ root: fromRoot, path: from }, { root: toRoot, path: to }).catch(() => undefined);
		void this.history.moveSource(from, to).catch(() => undefined);
		this.followEnvironmentRename(from, to);
		this.fileRenamedEmitter.fire({ from, to });
	}

	/** `trashed` is for deletes made in CarbonWire, which close the item's tabs. */
	fileDeleted(path: string, trashed = false): void {
		const root = this.index.collectionFor(path)?.root;
		if (trashed && root !== undefined) void this.store.forgetSidecar({ root, path }).catch(() => undefined);
		this.store.invalidateUnder(path);
		this.index.deleted(path);
		if (trashed) this.trashedEmitter.fire(path);
	}

	/** An unsaved request has no collection, so it gets no collection or folder defaults. */
	private async scopeFor(path: string | undefined, request: HttpRequest, requestScope: typeof import("../core/sender").requestScope) {
		await this.index.ready();
		const collection = path === undefined ? undefined : this.collectionFor(path);
		if (path !== undefined && !collection) throw new Error("This request is no longer inside a collection.");
		const root = collection?.root ?? "";
		const context = collection && path ? await this.store.loadContext(root, path) : { collectionRoot: "", collection: {}, chain: [] };
		const name = this.activeEnvironment();
		const environmentPath = name ? this.environments().find((p) => stem(p) === name) : undefined;
		const environment = environmentPath ? await this.store.loadEnvironment(environmentPath) : undefined;
		if (environment && environmentPath) await this.secrets.load(environmentPath, secretNames(environment));
		const variables = resolveEnvironment(environment, (variable) => (environmentPath ? this.secrets.get(environmentPath, variable) : null));
		const globalsPath = this.globalsPath();
		let globals: ReturnType<typeof resolveEnvironment> | undefined;
		if (this.store.exists(globalsPath)) {
			const doc = await this.store.loadEnvironment(globalsPath);
			await this.secrets.load(globalsPath, secretNames(doc));
			globals = resolveEnvironment(doc, (variable) => this.secrets.get(globalsPath, variable));
		}
		return { root, context, scope: requestScope(context, request, variables, globals) };
	}

	/** Relative body files are inside the collection; absolute ones are read from anywhere on disk. */
	private async readBodyFile(root: string, file: string): Promise<Uint8Array> {
		const fsPath = isAbsolute(file) ? file : this.files.fsPath(joinPath(root, file));
		try {
			return await readFile(fsPath);
		} catch {
			throw new Error(`Body file not found: ${file}`);
		}
	}

	/** Node's http stack loads on first send rather than at startup. */
	private async getTransport(): Promise<Transport> {
		if (!this.transport) {
			const { NodeTransport } = await import("../core/transport/node");
			const version = (this.context.extension.packageJSON as { version: string }).version;
			this.transport = new NodeTransport(`CarbonWire/${version}`, {
				viaHostProxy: () => usesVSCodeProxy(this.settings.proxy),
				proxy: (url) => this.network.proxyFor(url),
				clientCertificate: (url) => this.network.certificateFor(url),
				ca: () => this.network.certificateAuthorities(),
			});
		}
		return this.transport;
	}

	private async getOAuth2(): Promise<OAuth2Tokens> {
		if (!this.oauth2) {
			const { OAuth2Tokens } = await import("../core/auth/oauth2");
			this.oauth2 = new OAuth2Tokens(await this.getTransport(), {
				open: async (url) => {
					if (!(await vscode.env.openExternal(vscode.Uri.parse(url, true)))) throw new Error("The browser couldn't be opened for the sign-in.");
				},
				// Over Remote - SSH or in a container, this forwards the redirect's port to this machine.
				prepare: async (redirect) => void (await vscode.env.asExternalUri(vscode.Uri.parse(redirect))),
			});
		}
		return this.oauth2;
	}

	private async listYaml(dir?: string): Promise<string[]> {
		const roots = dir ? [this.paths.toFsPath(dir)].filter((p) => p !== undefined) : this.paths.roots.map((r) => r.fsPath);
		const found = (await Promise.all(roots.map(findYaml))).flat();
		return found.flatMap((fsPath) => this.paths.toPath(fsPath) ?? []);
	}

	private watch(): void {
		this.watchFolders();
		this.disposables.push(
			// Renames made in VS Code, e.g. in the Explorer; the watcher reports them as delete and create.
			vscode.workspace.onDidRenameFiles((e) => {
				for (const { oldUri, newUri } of e.files) {
					const from = this.paths.toPath(oldUri.fsPath);
					const to = this.paths.toPath(newUri.fsPath);
					if (from !== undefined && to !== undefined) this.fileRenamed(from, to);
				}
			}),
			vscode.workspace.onDidChangeWorkspaceFolders(() => {
				this.paths = new PathMap(workspaceRoots());
				this.watchFolders();
				void this.index.reset();
			}),
			vscode.workspace.onDidChangeConfiguration((e) => this.configurationChanged(e)),
			{ dispose: () => this.unwatchFolders() },
		);
	}

	/* One watcher per workspace folder, with a RelativePattern: a plain glob missed newly created files. */
	private watchFolders(): void {
		this.unwatchFolders();
		for (const folder of vscode.workspace.workspaceFolders ?? []) {
			if (folder.uri.scheme !== "file") continue;
			const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(folder, "**/*"));
			this.folderWatchers.push(
				watcher,
				watcher.onDidCreate((uri) => void this.uriCreated(uri)),
				watcher.onDidChange((uri) => this.uriChanged(uri)),
				watcher.onDidDelete((uri) => this.withPath(uri, (path) => this.fileDeleted(path))),
			);
		}
	}

	private unwatchFolders(): void {
		for (const d of this.folderWatchers.splice(0)) d.dispose();
	}

	private withPath(uri: vscode.Uri, run: (path: string) => void): void {
		if (uri.scheme !== "file") return;
		const path = this.paths.toPath(uri.fsPath);
		if (path !== undefined) run(path);
	}

	private async uriCreated(uri: vscode.Uri): Promise<void> {
		const path = uri.scheme === "file" ? this.paths.toPath(uri.fsPath) : undefined;
		if (path === undefined) return;
		this.store.invalidate(path);
		if (isYaml(path)) return this.index.created(path);
		// A folder that appears, e.g. moved in from a terminal, is reported without its files.
		if (basename(path).includes(".")) return;
		const s = await stat(uri.fsPath).catch(() => undefined);
		if (s?.isDirectory()) await this.index.folderCreated(path);
	}

	private uriChanged(uri: vscode.Uri): void {
		this.withPath(uri, (path) => {
			this.store.invalidate(path);
			if (isYaml(path) && this.index.changed(path)) this.documentsChanged();
		});
	}

	private configurationChanged(e: vscode.ConfigurationChangeEvent): void {
		if (!e.affectsConfiguration("carbonwire")) return;
		this.settings = readSettings();
		if (affectsSetting(e, "environmentsFolder")) this.index.rebuild();
		if (affectsSetting(e, "historySize")) void this.history.prune();
		if (["proxyUrl", "proxy", "clientCertificates", "caCertificates"].some((k) => affectsSetting(e, k))) void this.network.reload();
		this.settingsChanged.fire(this.settings);
	}

	/** Keeps an environment selected, and in its place, when its file is renamed in place. */
	private followEnvironmentRename(from: string, to: string): void {
		if (!isYaml(from) || dirname(from) !== this.environmentsFolder() || dirname(to) !== dirname(from)) return;
		const order = [...this.state.environmentOrder];
		const i = order.indexOf(stem(from));
		if (i >= 0) {
			order[i] = stem(to);
			void this.state.setEnvironmentOrder(order);
		}
		if (this.state.activeEnvironment === stem(from)) void this.setActiveEnvironment(stem(to));
	}
}
