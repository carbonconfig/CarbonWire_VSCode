import { mount } from "svelte";
import type { HttpRequest } from "../core/model";
import type { SendResult } from "../core/sender";
import type { SendProgress } from "../core/transport/types";
import { setUiHost } from "../ui/host";
import { runJsonAction } from "../ui/json-actions";
import type { RequestHost, RequestView, SavedTab } from "../ui/panel-protocol";
import type { RequestController } from "../ui/request-controller";
import RequestEditor from "../ui/RequestEditor.svelte";
import { Rpc } from "../ui/rpc";
import "../ui/styles.css";
import type { EnvironmentEntry, RequestLayout } from "../ui/types";
import { loadPdfJs } from "./pdf";
import { reportMetrics, reportProblems } from "./problems";
import "./theme.css";
import { vscodeApi } from "./vscode-api";

/** Functions exported by RequestEditor.svelte. */
interface EditorApi {
	setEnvironment(environment: EnvironmentEntry | undefined): void;
	setLayout(layout: RequestLayout): void;
	setWrap(wrap: boolean): void;
	setName(name: string): void;
	focusUrl(): void;
	restore(result: SendResult | undefined, time: number, error?: string): void;
	snapshot(): HttpRequest;
	save(): Promise<void>;
	send(): Promise<void>;
	find(): void;
	refreshVariables(): Promise<void>;
	shownResponse(): { status: number; bodyBytes: number; body: string } | undefined;
}

const vscode = vscodeApi<SavedTab>();
/* Messages can arrive while the tab loads, before the editor is mounted. */
const view: { editor?: EditorApi; onProgress?: (progress: SendProgress) => void } = {};
/** Commands such as Send that arrive before the editor is mounted run once it is. */
const waiting: ((editor: EditorApi) => void)[] = [];
const whenMounted = (run: (editor: EditorApi) => void) => (view.editor ? run(view.editor) : void waiting.push(run));
let saved = vscode.getState();

const rpc = new Rpc<RequestView, RequestHost>((message) => vscode.postMessage(message), {
	setEnvironment: (environment) => view.editor?.setEnvironment(environment),
	setLayout: (layout) => view.editor?.setLayout(layout),
	setWrap: (wrap) => view.editor?.setWrap(wrap),
	setFile: (file, name) => {
		saved = { file };
		vscode.setState(saved);
		view.editor?.setName(name);
	},
	refreshVariables: () => void view.editor?.refreshVariables(),
	progress: (progress) => view.onProgress?.(progress),
	send: () => whenMounted((editor) => void editor.send()),
	save: () => whenMounted((editor) => void editor.save()),
	find: () => whenMounted((editor) => editor.find()),
	focusUrl: () => whenMounted((editor) => editor.focusUrl()),
	jsonAction: (action, path) => runJsonAction(action, path),
	shownResponse: () => view.editor?.shownResponse(),
});
window.addEventListener("message", (e: MessageEvent) => void rpc.receive(e.data));
reportProblems((message) => rpc.notify("problem", message));
const metrics = reportMetrics((name, value) => rpc.notify("metric", name, value));

const state = await rpc.call("ready");
setUiHost({ copy: (text) => rpc.notify("copy", text), isMac: "isMac" in state && state.isMac, loadPdfJs });

if ("message" in state) {
	const p = document.createElement("p");
	p.className = "carbonwire-muted carbonwire-tab-message";
	p.textContent = state.message;
	document.body.append(p);
} else {
	/** Keeps an unsaved request in the tab's state, so it survives hiding the tab and restarts. */
	const keepDraft = (request: HttpRequest, name?: string) => {
		if (!saved || !("draft" in saved)) return;
		saved = { draft: { ...saved.draft, request, ...(name === undefined ? {} : { name }) } };
		vscode.setState(saved);
	};
	saved = state.file ? { file: state.file } : { draft: { name: state.name, request: state.request, dir: state.dir, historyId: state.historyId } };
	vscode.setState(saved);

	const controller: RequestController = {
		save: (request) => {
			keepDraft(request);
			rpc.notify("edit", request);
			return Promise.resolve();
		},
		saveDraft: (name, request) => rpc.call("saveDraft", name, request),
		send: async (name, request, signal, onProgress) => {
			view.onProgress = onProgress;
			signal.addEventListener("abort", () => rpc.notify("cancel"), { once: true });
			const result = await rpc.call("send", name, request);
			// After the editor has rendered the response, which happens once this resolves.
			metrics.painted("responsePainted");
			// The tab now shows this response, not the one from history it was opened with.
			if (saved && "draft" in saved && saved.draft.historyId !== undefined) {
				saved = { draft: { ...saved.draft, historyId: undefined } };
				vscode.setState(saved);
			}
			return result;
		},
		openEnvironment: (path) => rpc.notify("openEnvironment", path),
		setLayout: (layout) => rpc.notify("setLayout", layout),
		setWrap: (wrap) => rpc.notify("setWrap", wrap),
		variableNames: (request) => rpc.call("variableNames", request),
		rename: async (name) => {
			const used = await rpc.call("rename", name);
			if (used !== undefined) keepDraft(view.editor?.snapshot() ?? state.request, used);
			return used;
		},
		copyCurl: (request) => rpc.call("copyCurl", request),
		notify: (message) => rpc.notify("notify", message),
		snippet: (request, language) => rpc.call("snippet", request, language),
		setSnippetLanguage: (language) => rpc.notify("setSnippetLanguage", language),
		headerPresets: () => rpc.call("headerPresets"),
		saveHeaderPreset: (headers) => rpc.call("saveHeaderPreset", headers),
		removeHeaderPreset: () => rpc.call("removeHeaderPreset"),
		saveBody: (body, contentType, name) => rpc.call("saveBody", body, contentType, name),
		askName: (title, value) => rpc.call("askName", title, value),
	};

	view.editor = mount(RequestEditor, {
		target: document.body,
		props: {
			initial: state.request,
			initialName: state.name,
			initialDraft: state.draft,
			initialResult: state.result,
			restoredAt: state.restoredAt,
			initialEnvironment: state.environment,
			initialLayout: state.layout,
			initialWrap: state.wrap,
			initialSnippetLanguage: state.snippetLanguage,
			controller,
		},
	}) as EditorApi;
	if (state.error !== undefined && state.restoredAt !== undefined) view.editor.restore(undefined, state.restoredAt, state.error);
	// VS Code may move focus into the page after the editor mounts; the URL field takes it then.
	view.editor.focusUrl();
	const editor = view.editor;
	window.addEventListener("focus", () => document.activeElement === document.body && editor.focusUrl(), { once: true });
	for (const run of waiting.splice(0)) run(view.editor);
	metrics.painted("requestPainted");
}
