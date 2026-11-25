import { readFile, stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import * as vscode from "vscode";
import type { OAuth2Tokens } from "../core/auth/oauth2";
import type { Folder, HttpRequest, OpenCollection, SecretVariable, Variable } from "../core/model";
import { buildRequest } from "../core/request-builder";
import type { SendResult } from "../core/sender";
import { insertKey, type SortOrder } from "../core/storage/order";
import { basename, dirname, joinPath, movedPath, stem } from "../core/storage/paths";
import { CollectionStore } from "../core/storage/store";
import { Exclusions } from "../core/storage/exclude";
import { COLLECTION_FILE, compare, FOLDER_FILE, isYaml, type CollectionNode } from "../core/storage/tree";
import { TransportError, type SendProgress, type Transport } from "../core/transport/types";
import { describeScope, interpolate, withValue, isDynamicVariable, mergeVariables, resolveEnvironment, variableValue, type Scope, type SourceLayer, type VariableInfo } from "../core/variables";
import type { ActionVariableScope } from "@opencollection/types/common/actions";
import type { AfterResponse } from "../core/after-response";
import type { ConsoleEntry, EnvironmentEntry, RequestLayout } from "../ui/types";
import { CollectionIndex } from "./collection-index";
import { debounce } from "./debounce";
import { HistoryStore, type HistoryEntry } from "./history";
import { ItemActions } from "./item-actions";
import { MetaCacheFile } from "./meta-cache";
import { PathMap, type WorkspaceRoot } from "./paths";
import { secretNames, Secrets } from "./secrets";
import { affectsSetting, excludePatterns, readSettings, State, updateSetting, usesVSCodeProxy, type Settings } from "./settings";
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

/** Sets a variable's value, keeping its type or selected variant, or adds it at the end. */
function upsertVariable<T extends Variable | SecretVariable>(variables: readonly T[], name: string, value: string): (T | Variable)[] {
	const at = variables.findIndex((v) => v.name === name);
	if (at < 0) return [...variables, { name, value }];
	return variables.map((v, i) => (i === at ? withValue(v as Variable, value) : v));
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
	/** Variables responses set with the runtime scope; kept in memory until CarbonWire restarts. */
	readonly runtime = new Map<string, string>();
	/** Set by the tabs: an open editor of a file saves its edits before a response writes a variable there, and reloads after. */
	writeHooks?: { before(path: string): Promise<void>; after(path: string): void };
	/** The last sends, newest last, for the console. */
	readonly console: ConsoleEntry[] = [];
	private consoleId = 0;
	private paths = new PathMap(workspaceRoots());
	/** By workspace folder; cleared when the settings they come from change. */
	private readonly exclusions = new Map<string, Exclusions>();
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
		const storage = context.storageUri ?? context.globalStorageUri;
		const metaCache = new MetaCacheFile(vscode.Uri.joinPath(storage, "meta-cache.json").fsPath, context.workspaceState);
		this.index = new CollectionIndex(
			{ listYaml: (dir) => this.listYaml(dir), stat: (path) => this.files.stat(path), read: (path) => this.files.read(path) },
			{
				rootName: () => this.paths.rootName(),
				sortOrder: () => this.state.sortOrder,
				collectionOrder: () => this.state.collectionOrder,
				environmentsFolders: () => this.environmentsFolders(),
				changed: (collections) => this.collectionsChanged.fire(collections),
				loadCache: () => metaCache.load(),
				saveCache: (cache) => metaCache.save(cache),
			},
		);
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

	/** The environments folder in each workspace folder; same-named environments in them are merged. */
	environmentsFolders(): string[] {
		return this.paths.inEveryRoot(this.settings.environmentsFolder);
	}

	/** Where new environments go: the first environments folder that has any, else the first workspace folder's. */
	environmentsFolder(): string {
		const first = this.index.environments()[0];
		return first ? dirname(first) : this.environmentsFolders()[0]!;
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

	/** The globals file Edit globals opens: the first one that exists, else one beside the environments. */
	globalsPath(): string {
		return this.globalsFiles()[0] ?? joinPath(this.environmentsFolder(), GLOBALS_FILE);
	}

	isGlobals(path: string): boolean {
		return basename(path) === GLOBALS_FILE && this.environmentsFolders().includes(dirname(path));
	}

	/** One file per environment name, shared by every collection, in the order they were dragged to. */
	environments(): string[] {
		const rank = new Map(this.state.environmentOrder.map((name, i) => [name, i]));
		const first = new Map<string, string>();
		for (const path of this.environmentFiles()) if (!first.has(stem(path))) first.set(stem(path), path);
		return [...first.values()].sort((a, b) => (rank.get(stem(a)) ?? Infinity) - (rank.get(stem(b)) ?? Infinity) || compare(stem(a), stem(b)));
	}

	/** Every file of the environment, one per workspace folder that has it, the first folder's first. */
	environmentFiles(name?: string): string[] {
		return this.index.environments().filter((p) => basename(p) !== GLOBALS_FILE && (name === undefined || stem(p) === name));
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
			const tests = await this.afterResponse(path, request, result, scope);
			return tests ? { ...result, tests } : result;
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

	/** Every variable the request can use with the active environment, its value and where it's set, for highlighting and hovers. */
	async variables(path: string | undefined, request: HttpRequest): Promise<VariableInfo[]> {
		const layers = await this.variableLayers(path, request).catch(() => undefined);
		return layers ? describeScope(layers) : [];
	}

	/**
	 * Where Ctrl+Click on a variable goes: the file that sets it, or for one that isn't set, the active
	 * environment, else globals, where it's added. Undefined for request and dynamic variables.
	 */
	async variableTarget(path: string | undefined, request: HttpRequest, name: string): Promise<{ file: string; create: boolean } | undefined> {
		const info = (await this.variables(path, request)).find((v) => v.name === name);
		if (info) return info.file ? { file: info.file, create: false } : undefined;
		if (isDynamicVariable(name)) return undefined;
		const environment = this.activeEnvironment();
		const file = environment ? this.environmentFiles(environment)[0] : this.globalsPath();
		if (!file) return undefined;
		if (!environment && !this.store.exists(file)) await this.store.saveDocument(file, { name: "globals", variables: [] });
		return { file, create: true };
	}

	/** Follows a rename or move made in CarbonWire or elsewhere in VS Code. Both report it, so it's safe to call twice. */
	fileRenamed(from: string, to: string): void {
		const fromRoot = this.index.collectionFor(from)?.root;
		const movesEnvironments = this.index.environments().some((p) => movedPath(p, from, to) !== undefined);
		this.store.invalidateUnder(from);
		this.store.invalidateUnder(to);
		this.index.renamed(from, to);
		const toFsPath = this.paths.toFsPath(to);
		if (toFsPath !== undefined && this.excluded(toFsPath)) this.index.deleted(to);
		const toRoot = this.index.collectionFor(to)?.root;
		if (fromRoot !== undefined && toRoot !== undefined) void this.store.followSidecar({ root: fromRoot, path: from }, { root: toRoot, path: to }).catch(() => undefined);
		void this.history.moveSource(from, to).catch(() => undefined);
		this.followEnvironmentRename(from, to);
		if (movesEnvironments) this.followEnvironmentsFolder(from, to);
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
		const [variables, globals] = await Promise.all([this.loadVariables(name ? this.environmentFiles(name) : []), this.loadVariables(this.globalsFiles())]);
		return { root, context, scope: requestScope(context, request, variables, globals, this.runtime) };
	}

	/** A runtime variable set by hand, such as from the JSON tree's menu; request tabs show it straight away. */
	setRuntimeVariable(name: string, value: string): void {
		this.runtime.set(name, value);
		this.documentsChangedEmitter.fire();
	}

	/** Runs the request's checks and keeps the variables it takes from the response. */
	private async afterResponse(path: string | undefined, request: HttpRequest, result: SendResult, scope: Scope): Promise<AfterResponse | undefined> {
		const runtime = request.runtime;
		if (!runtime?.assertions?.length && !runtime?.actions?.length) return undefined;
		const { readResponse, runActions, runChecks } = await import("../core/after-response");
		const res = readResponse(result.response);
		const checks = runChecks(res, runtime.assertions, (text) => interpolate(text, scope));
		const variables = runActions(res, runtime.actions);
		let changed = false;
		for (const v of variables) {
			if (v.value === undefined) continue;
			try {
				await this.setVariable(path, v.scope, v.name, v.value);
				changed = true;
			} catch (e) {
				v.error = e instanceof Error ? e.message : String(e);
			}
		}
		if (changed) this.documentsChangedEmitter.fire();
		return { checks, variables };
	}

	/**
	 * Keeps a variable a response set: in memory for the runtime scope, else in the environment's,
	 * collection's or folder's file, or secret storage for a secret. The request scope is left to its tab.
	 */
	async setVariable(path: string | undefined, scope: ActionVariableScope, name: string, value: string): Promise<void> {
		if (scope === "runtime") {
			this.runtime.set(name, value);
			return;
		}
		if (scope === "request") return;
		if (scope === "environment") {
			const environment = this.activeEnvironment();
			const file = environment ? this.environmentFiles(environment)[0] : undefined;
			if (!file) throw new Error("No environment is active, so it wasn't kept.");
			return this.writeVariable(file, name, value);
		}
		const collection = path === undefined ? undefined : this.collectionFor(path);
		if (!collection || path === undefined) throw new Error("This request isn't saved in a collection.");
		if (scope === "collection") return this.writeVariable(joinPath(collection.root, COLLECTION_FILE), name, value);
		const dir = dirname(path);
		if (dir === collection.root) throw new Error("This request isn't in a folder.");
		return this.writeVariable(joinPath(dir, FOLDER_FILE), name, value);
	}

	private async writeVariable(file: string, name: string, value: string): Promise<void> {
		await this.writeHooks?.before(file);
		const exists = this.store.exists(file);
		if (basename(file) !== COLLECTION_FILE && basename(file) !== FOLDER_FILE) {
			const environment = await this.store.loadEnvironment(file);
			const existing = environment.variables?.find((v) => v.name === name);
			if (existing && "secret" in existing && existing.secret) await this.secrets.set(file, name, value);
			else await this.store.saveEdited(file, { ...environment, variables: upsertVariable(environment.variables ?? [], name, value) });
		} else {
			const doc = exists ? await this.store.loadDocument<OpenCollection | Folder>(file) : ({ info: { name: basename(dirname(file)), type: "folder" } } as Folder);
			const defaults = doc.request ?? {};
			await this.store.saveEdited(file, { ...doc, request: { ...defaults, variables: upsertVariable(defaults.variables ?? [], name, value) } });
			if (!exists) this.index.created(file);
		}
		this.writeHooks?.after(file);
	}

	/** The scopes {@link scopeFor} layers, with their names and files. */
	private async variableLayers(path: string | undefined, request: HttpRequest): Promise<SourceLayer[]> {
		await this.index.ready();
		const collection = path === undefined ? undefined : this.collectionFor(path);
		if (path !== undefined && !collection) return [];
		const root = collection?.root ?? "";
		const context = collection && path ? await this.store.loadContext(root, path) : undefined;
		const name = this.activeEnvironment();
		const [environment, globals] = await Promise.all([this.loadVariableFiles(name ? this.environmentFiles(name) : []), this.loadVariableFiles(this.globalsFiles())]);
		const dirs: string[] = [];
		if (path !== undefined) for (let dir = dirname(path); dir !== root && dir !== ""; dir = dirname(dir)) dirs.unshift(dir);
		return [
			{ source: "globals", ...globals },
			{ source: "collection", variables: context?.chain[0]?.variables, label: collection?.name, file: collection && joinPath(root, COLLECTION_FILE) },
			{ source: "environment", label: name, ...environment },
			...(context?.chain.slice(1) ?? []).map((defaults, i): SourceLayer => ({ source: "folder", variables: defaults?.variables, label: basename(dirs[i]!), file: joinPath(dirs[i]!, FOLDER_FILE) })),
			{ source: "request", variables: request.runtime?.variables },
			{ source: "runtime", variables: [...this.runtime].map(([name, value]) => ({ name, value })) },
		];
	}

	private globalsFiles(): string[] {
		return this.environmentsFolders().map((folder) => joinPath(folder, GLOBALS_FILE)).filter((path) => this.store.exists(path));
	}

	/** Same-named environment files, secrets included, merged into one. */
	private async loadVariables(paths: readonly string[]): Promise<Variable[]> {
		return (await this.loadVariableFiles(paths)).variables;
	}

	/** Merged as {@link loadVariables} does, plus which file each variable's value comes from and which are secret. */
	private async loadVariableFiles(paths: readonly string[]): Promise<{ variables: Variable[]; secrets: Set<string>; file: (name: string) => string | undefined }> {
		const loaded = await Promise.all(
			paths.map(async (path) => {
				const environment = await this.store.loadEnvironment(path);
				const secret = secretNames(environment);
				await this.secrets.load(path, secret);
				return { path, secret, variables: resolveEnvironment(environment, (variable) => this.secrets.get(path, variable)) };
			}),
		);
		// mergeVariables takes the first value that isn't empty, else the first.
		const from = (name: string) => loaded.find((l) => l.variables.some((v) => v.name === name && variableValue(v))) ?? loaded.find((l) => l.secret.includes(name) || l.variables.some((v) => v.name === name));
		const variables = mergeVariables(loaded.map((l) => l.variables));
		const secrets = new Set(variables.flatMap((v) => (from(v.name)?.secret.includes(v.name) ? [v.name] : [])));
		return { variables, secrets, file: (name) => (from(name) ?? loaded[0])?.path };
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
		const targets = dir ? [this.paths.toFsPath(dir)].filter((p) => p !== undefined) : this.paths.roots.map((r) => r.fsPath);
		const found = await Promise.all(
			targets.map(async (fsPath) => {
				const at = this.paths.locate(fsPath);
				if (!at || this.excluded(fsPath)) return [];
				const exclusions = this.exclusionsFor(at.root);
				return findYaml(fsPath, (path, name) => exclusions.skips(path, name), at.path);
			}),
		);
		return found.flat().flatMap((fsPath) => this.paths.toPath(fsPath) ?? []);
	}

	private exclusionsFor(root: WorkspaceRoot): Exclusions {
		let exclusions = this.exclusions.get(root.fsPath);
		if (!exclusions) {
			exclusions = new Exclusions(excludePatterns(vscode.Uri.file(root.fsPath)), [this.settings.collectionsFolder, this.settings.environmentsFolder]);
			this.exclusions.set(root.fsPath, exclusions);
		}
		return exclusions;
	}

	/** Outside the workspace, or in a folder never searched for collections. */
	private excluded(fsPath: string): boolean {
		const at = this.paths.locate(fsPath);
		return !at || (at.path !== "" && this.exclusionsFor(at.root).excludes(at.path));
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
				this.exclusions.clear();
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
		if (this.excluded(uri.fsPath)) return;
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
		const before = this.settings;
		if (e.affectsConfiguration("carbonwire")) this.settings = readSettings();
		// A collections or environments folder inside a hidden folder is searched, so it changes what's skipped.
		const hidden = (s: Settings) => [s.collectionsFolder, s.environmentsFolder].some((f) => /(^|[/\\])\./.test(f));
		const keptChanged = (affectsSetting(e, "collectionsFolder") || affectsSetting(e, "environmentsFolder")) && (hidden(before) || hidden(this.settings));
		if (affectsSetting(e, "exclude") || e.affectsConfiguration("files.exclude") || keptChanged) {
			this.exclusions.clear();
			void this.index.reset();
		}
		if (!e.affectsConfiguration("carbonwire")) return;
		if (affectsSetting(e, "environmentsFolder")) this.index.rebuild();
		if (affectsSetting(e, "historySize")) void this.history.prune();
		if (["proxyUrl", "proxy", "clientCertificates", "caCertificates"].some((k) => affectsSetting(e, k))) void this.network.reload();
		this.settingsChanged.fire(this.settings);
	}

	/** Keeps an environment selected, and in its place, when its file is renamed in place. */
	private followEnvironmentRename(from: string, to: string): void {
		if (!isYaml(from) || !this.environmentsFolders().includes(dirname(from)) || dirname(to) !== dirname(from)) return;
		const order = [...this.state.environmentOrder];
		const i = order.indexOf(stem(from));
		if (i >= 0) {
			order[i] = stem(to);
			void this.state.setEnvironmentOrder(order);
		}
		if (this.state.activeEnvironment === stem(from)) void this.setActiveEnvironment(stem(to));
	}

	/** Keeps the environments folder setting on the folder when it, or a folder above it, moves within its workspace folder. */
	private followEnvironmentsFolder(from: string, to: string): void {
		const folders = this.environmentsFolders();
		const i = folders.findIndex((folder) => movedPath(folder, from, to) !== undefined);
		if (i < 0) return;
		const moved = movedPath(folders[i]!, from, to)!;
		const prefix = this.paths.roots.length > 1 ? `${this.paths.roots[i]!.name}/` : "";
		// Moved to another workspace folder: the merge finds it there without a change.
		if (!moved.startsWith(prefix)) return;
		// The setting applies to every workspace folder, so it stays while another one still has environments there.
		if (this.index.environments().length > 0) return;
		void updateSetting("environmentsFolder", moved.slice(prefix.length), true);
	}
}
