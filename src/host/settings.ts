import * as vscode from "vscode";
import type { SortOrder } from "../core/storage/order";
import type { RequestLayout } from "../ui/types";
import type { MetaEntry } from "./collection-index";
import type { CertificateSetting } from "./network";

const SECTION = "carbonwire";

/** User settings, shown in VS Code's Settings editor; see `contributes.configuration`. */
export interface Settings {
	/** Where new collections are created, relative to the first workspace folder. */
	collectionsFolder: string;
	/** Environments are shared by every collection and live in this folder. */
	environmentsFolder: string;
	maxResponseMB: number;
	/** Most recent sends kept in history; 0 turns history off. */
	historySize: number;
	wrapResponseLines: boolean;
	rejectUnauthorized: boolean;
	proxy: ProxyMode;
	/** For the "custom" proxy: http://, https:// or socks5:// URL; the password is in secret storage. */
	proxyUrl: string;
	/** Hosts that skip the custom proxy, NO_PROXY style. */
	proxyBypass: string;
	clientCertificates: CertificateSetting[];
	/** PEM files of certificate authorities to trust besides the system's. */
	caCertificates: string[];
	/** Hidden tabs keep their page loaded, trading memory for instant switching. */
	keepHiddenTabsLoaded: boolean;
}

/**
 * "auto" uses VS Code's proxy support when a proxy is configured; "environment" reads HTTP_PROXY,
 * HTTPS_PROXY and NO_PROXY; "custom" uses `proxyUrl`.
 */
export type ProxyMode = "auto" | "vscode" | "environment" | "custom" | "direct";

export const DEFAULT_SETTINGS: Settings = {
	collectionsFolder: "api-collections",
	environmentsFolder: "api-collections/environments",
	maxResponseMB: 20,
	historySize: 100,
	wrapResponseLines: true,
	rejectUnauthorized: true,
	proxy: "auto",
	proxyUrl: "",
	proxyBypass: "localhost, 127.0.0.1, ::1",
	clientCertificates: [],
	caCertificates: [],
	keepHiddenTabsLoaded: false,
};

export function readSettings(): Settings {
	const config = vscode.workspace.getConfiguration(SECTION);
	const positive = (value: number, fallback: number) => (Number.isFinite(value) && value > 0 ? value : fallback);
	return {
		collectionsFolder: config.get<string>("collectionsFolder", DEFAULT_SETTINGS.collectionsFolder).trim(),
		environmentsFolder: config.get<string>("environmentsFolder", "").trim() || DEFAULT_SETTINGS.environmentsFolder,
		maxResponseMB: positive(config.get<number>("responseSizeLimit", DEFAULT_SETTINGS.maxResponseMB), DEFAULT_SETTINGS.maxResponseMB),
		historySize: Math.max(0, Math.floor(config.get<number>("historySize", DEFAULT_SETTINGS.historySize))),
		wrapResponseLines: config.get<boolean>("wrapLongLines", DEFAULT_SETTINGS.wrapResponseLines),
		rejectUnauthorized: config.get<boolean>("verifyTlsCertificates", DEFAULT_SETTINGS.rejectUnauthorized),
		proxy: config.get<ProxyMode>("proxy", DEFAULT_SETTINGS.proxy),
		proxyUrl: config.get<string>("proxyUrl", "").trim(),
		proxyBypass: config.get<string>("proxyBypass", DEFAULT_SETTINGS.proxyBypass),
		clientCertificates: config.get<CertificateSetting[]>("clientCertificates", []).filter((c) => c && typeof c === "object"),
		caCertificates: config.get<string[]>("caCertificates", []).filter((c) => typeof c === "string" && c.trim() !== ""),
		keepHiddenTabsLoaded: config.get<boolean>("keepHiddenTabsLoaded", DEFAULT_SETTINGS.keepHiddenTabsLoaded),
	};
}

/**
 * Whether requests go through VS Code's proxy support, which patches Node's `http` and stops
 * connections being reused.
 */
export function usesVSCodeProxy(mode: ProxyMode): boolean {
	if (mode !== "auto") return mode === "vscode";
	const http = vscode.workspace.getConfiguration("http");
	if (http.get<string>("proxySupport") === "off") return false;
	return Boolean(http.get<string>("proxy")) || ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy"].some((name) => process.env[name]);
}

export function affectsSetting(event: vscode.ConfigurationChangeEvent, key: string): boolean {
	return event.affectsConfiguration(`${SECTION}.${key}`);
}

/** Changes a setting where the user keeps it: in the workspace if it's set there, otherwise for the user. */
export async function updateSetting(key: string, value: unknown): Promise<void> {
	const config = vscode.workspace.getConfiguration(SECTION);
	const inspect = config.inspect(key);
	const target = inspect?.workspaceValue !== undefined ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global;
	await config.update(key, value, target);
}

/** View state that isn't a setting: kept per workspace, except the request layout, which is kept per user. */
export class State {
	constructor(private readonly context: vscode.ExtensionContext) {}

	get activeEnvironment(): string {
		return this.context.workspaceState.get("activeEnvironment", "");
	}

	setActiveEnvironment(name: string): Thenable<void> {
		return this.context.workspaceState.update("activeEnvironment", name);
	}

	get sortOrder(): SortOrder {
		return this.context.workspaceState.get<SortOrder>("sortOrder", "manual");
	}

	setSortOrder(order: SortOrder): Thenable<void> {
		return this.context.workspaceState.update("sortOrder", order);
	}

	/** Collection roots in the order they were dragged to; others follow by name. */
	get collectionOrder(): string[] {
		return this.context.workspaceState.get<string[]>("collectionOrder", []);
	}

	setCollectionOrder(roots: string[]): Thenable<void> {
		return this.context.workspaceState.update("collectionOrder", roots);
	}

	/** Environment names in the order they were dragged to; others follow by name. */
	get environmentOrder(): string[] {
		return this.context.workspaceState.get<string[]>("environmentOrder", []);
	}

	setEnvironmentOrder(names: string[]): Thenable<void> {
		return this.context.workspaceState.update("environmentOrder", names);
	}

	/** The language last picked in a request's Code tab. */
	get snippetLanguage(): string {
		return this.context.globalState.get("snippetLanguage", "curl");
	}

	setSnippetLanguage(id: string): Thenable<void> {
		return this.context.globalState.update("snippetLanguage", id);
	}

	get requestLayout(): RequestLayout {
		return this.context.globalState.get<RequestLayout>("requestLayout", { orientation: "vertical", ratio: 0.5 });
	}

	setRequestLayout(layout: RequestLayout): Thenable<void> {
		return this.context.globalState.update("requestLayout", layout);
	}

	get metaCache(): Record<string, MetaEntry> | undefined {
		return this.context.workspaceState.get("metaCache");
	}

	setMetaCache(cache: Record<string, MetaEntry>): Thenable<void> {
		return this.context.workspaceState.update("metaCache", cache);
	}
}
