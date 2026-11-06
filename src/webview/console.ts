import { mount } from "svelte";
import type { ConsoleHost, ConsoleView } from "../ui/console-protocol";
import ConsolePanel from "../ui/ConsolePanel.svelte";
import { Rpc } from "../ui/rpc";
import "../ui/styles.css";
import type { ConsoleEntry } from "../ui/types";
import { reportProblems } from "./problems";
import "./theme.css";
import { vscodeApi } from "./vscode-api";

const vscode = vscodeApi<undefined>();
const view: { panel?: { add(entry: ConsoleEntry): void; clear(): void } } = {};
const rpc = new Rpc<ConsoleView, ConsoleHost>((message) => vscode.postMessage(message), {
	add: (entry) => view.panel?.add(entry),
	clear: () => view.panel?.clear(),
});
window.addEventListener("message", (e: MessageEvent) => void rpc.receive(e.data));
reportProblems((message) => rpc.notify("problem", message));

const entries = await rpc.call("ready");
view.panel = mount(ConsolePanel, {
	target: document.body,
	props: { initial: entries, onClear: () => rpc.notify("clear"), onCopy: (text: string) => rpc.notify("copy", text) },
}) as { add(entry: ConsoleEntry): void; clear(): void };
