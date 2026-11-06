import type { Cookie } from "../core/cookies";
import type { HeaderPreset } from "../core/header-presets";
import type { Environment, Folder, HttpRequest, HttpRequestHeader, OpenCollection } from "../core/model";
import type { SendResult } from "../core/sender";
import type { SendProgress } from "../core/transport/types";
import type { EnvironmentEntry, JsonAction, RequestLayout } from "./types";

/** An unsaved request. */
export interface DraftState {
	name: string;
	request: HttpRequest;
	/** Where Save suggests putting it. */
	dir?: string;
	/** The history entry it was opened from, whose response is shown. */
	historyId?: number;
}

/** What a tab keeps in VS Code's webview state, to restore it after a restart. */
export type SavedTab = { file: string } | { draft: DraftState };

/** Everything a request tab shows when it loads. */
export interface RequestTabState {
	name: string;
	request: HttpRequest;
	/** True for a request that isn't saved to a collection yet. */
	draft: boolean;
	file?: string;
	/** For an unsaved request: where Save suggests putting it, and the history entry it came from. */
	dir?: string;
	historyId?: number;
	result?: SendResult;
	/** When `result` was reopened from history, the time it was received. */
	restoredAt?: number;
	/** The last send's failure, when that is what history holds. */
	error?: string;
	environment?: EnvironmentEntry;
	layout: RequestLayout;
	wrap: boolean;
	isMac: boolean;
	snippetLanguage: string;
}

/** Methods the extension exposes to a request tab. */
export type RequestHost = {
	/** Returns what to show, or a message when the file can't be shown. */
	ready(): RequestTabState | { message: string };
	/** The request as edited; the extension saves it, or for an unsaved request keeps it. */
	edit(request: HttpRequest): void;
	/** Asks where to save an unsaved request; returns its name, or undefined if cancelled. */
	saveDraft(name: string, request: HttpRequest): string | undefined;
	/** Progress arrives through the tab's `progress` method. */
	send(name: string, request: HttpRequest): SendResult;
	cancel(): void;
	openEnvironment(path: string): void;
	setLayout(layout: RequestLayout): void;
	setWrap(wrap: boolean): void;
	variableNames(request: HttpRequest): string[];
	/** Returns the name actually used, or undefined if renaming failed. */
	rename(name: string): string | undefined;
	copyCurl(request: HttpRequest): void;
	notify(message: string): void;
	copy(text: string): void;
	problem(message: string): void;
	/** A page timing; see `reportMetrics`. */
	metric(name: string, value: number): void;
	snippet(request: HttpRequest, language: string): string;
	setSnippetLanguage(language: string): void;
	headerPresets(): HeaderPreset[];
	saveHeaderPreset(headers: HttpRequestHeader[]): void;
	removeHeaderPreset(): void;
	saveBody(body: Uint8Array, contentType: string, name: string): void;
	askName(title: string, value: string): string | undefined;
};

/** Methods a request tab exposes to the extension. */
export type RequestView = {
	setEnvironment(environment: EnvironmentEntry | undefined): void;
	setLayout(layout: RequestLayout): void;
	setWrap(wrap: boolean): void;
	/** After a rename, or after an unsaved request is saved. */
	setFile(file: string, name: string): void;
	refreshVariables(): void;
	progress(progress: SendProgress): void;
	send(): void;
	save(): void;
	find(): void;
	focusUrl(): void;
	/** For a JSON tree row's context menu; "copyValue" returns the text. */
	jsonAction(action: JsonAction, path: string): string | undefined;
	/** What the response panel shows; for tests. */
	shownResponse(): { status: number; bodyBytes: number; body: string } | undefined;
};

export type SettingsTabState =
	| { kind: "collection" | "folder"; file: string; doc: OpenCollection | Folder }
	| { kind: "environment"; file: string; environment: Environment; secrets: Record<string, string>; globals?: boolean }
	| { kind: "cookies"; cookies: Cookie[] };

/** Methods the extension exposes to a collection, folder or environment tab. */
export type SettingsHost = {
	ready(): SettingsTabState | { message: string };
	edit(doc: object): void;
	/** Returns the name actually used, or undefined if renaming failed. */
	renameEnvironment(name: string): string | undefined;
	/** An empty value deletes the secret. */
	setSecret(name: string, value: string): void;
	problem(message: string): void;
	/** The cookie manager: deletes cookies by domain, and by name and path when given. */
	deleteCookies(domain: string | undefined, name?: string, path?: string): void;
	/** Adds a cookie as if `url` had set it with this Set-Cookie value; returns an error to show. */
	addCookie(url: string, setCookie: string): string | undefined;
};

/** The cookie manager refreshes when the jar changes; other settings tabs reload after a rename. */
export type SettingsView = {
	setCookies(cookies: Cookie[]): void;
};
