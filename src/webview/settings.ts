import { mount } from "svelte";
import type { Environment } from "../core/model";
import type { Cookie } from "../core/cookies";
import CookieManager from "../ui/CookieManager.svelte";
import DefaultsEditor from "../ui/DefaultsEditor.svelte";
import EnvironmentEditor from "../ui/EnvironmentEditor.svelte";
import type { SavedTab, SettingsHost, SettingsView, VariableFocus } from "../ui/panel-protocol";
import { Rpc } from "../ui/rpc";
import "../ui/styles.css";
import { reportProblems } from "./problems";
import "./theme.css";
import { vscodeApi } from "./vscode-api";
import { noticeIfStalled } from "./stalled";

const vscode = vscodeApi<SavedTab>();
type Focusable = { focusVariable(focus: VariableFocus): void };
const view: { cookies?: { setCookies(cookies: Cookie[]): void }; variables?: Focusable } = {};
const rpc = new Rpc<SettingsView, SettingsHost>((message) => vscode.postMessage(message), {
	setCookies: (cookies) => view.cookies?.setCookies(cookies),
	focusVariable: (focus) => view.variables?.focusVariable(focus),
});
window.addEventListener("message", (e: MessageEvent) => void rpc.receive(e.data));
reportProblems((message) => rpc.notify("problem", message));

const stalled = noticeIfStalled();
const state = await rpc.call("ready");
stalled();
const save = (doc: object) => {
	rpc.notify("edit", doc);
	return Promise.resolve();
};

if ("message" in state) {
	const p = document.createElement("p");
	p.className = "carbonwire-muted carbonwire-tab-message";
	p.textContent = state.message;
	document.body.append(p);
} else if (state.kind === "environment") {
	vscode.setState({ file: state.file });
	// Secret values were loaded with the tab, so the editor can read them straight away.
	const secrets = new Map(Object.entries(state.secrets));
	const editor = mount(EnvironmentEditor, {
		target: document.body,
		props: {
			initial: state.environment,
			globals: state.globals === true,
			onRename: state.globals ? undefined : (name: string) => rpc.call("renameEnvironment", name),
			getSecret: (name: string) => secrets.get(name) ?? null,
			setSecret: (name: string, value: string) => {
				if (value) secrets.set(name, value);
				else secrets.delete(name);
				rpc.notify("setSecret", name, value);
			},
			onSave: (env: Environment) => save(env),
		},
	}) as Focusable;
	view.variables = editor;
	if (state.focus) editor.focusVariable(state.focus);
} else if (state.kind === "cookies") {
	vscode.setState({ file: "carbonwire:cookies" });
	view.cookies = mount(CookieManager, {
		target: document.body,
		props: {
			initial: state.cookies,
			onDelete: (domain: string | undefined, name?: string, path?: string) => rpc.notify("deleteCookies", domain, name, path),
			onAdd: (url: string, setCookie: string) => rpc.call("addCookie", url, setCookie),
		},
	}) as { setCookies(cookies: Cookie[]): void };
} else {
	vscode.setState({ file: state.file });
	const editor = mount(DefaultsEditor, { target: document.body, props: { initial: state.doc, kind: state.kind, onSave: save } }) as Focusable;
	view.variables = editor;
	if (state.focus) editor.focusVariable(state.focus);
}
