import { mount } from "svelte";
import type { HistoryEntry } from "../core/history";
import { Rpc } from "../ui/rpc";
import Sidebar from "../ui/Sidebar.svelte";
import type { MovePosition, SavedSidebar, SidebarHost, SidebarState, SidebarView } from "../ui/sidebar-protocol";
import "../ui/styles.css";
import "./theme.css";
import { reportMetrics, reportProblems } from "./problems";
import { vscodeApi } from "./vscode-api";

/** Functions exported by Sidebar.svelte. */
interface SidebarApi {
	update(state: SidebarState): void;
	setActive(path: string | undefined): void;
	environmentChanged(name: string): void;
	setHistory(entries: readonly HistoryEntry[]): void;
	collapseAll(): void;
	reveal(root: string): void;
}

const vscode = vscodeApi<SavedSidebar>();
/* Messages can arrive while the first state loads, before the sidebar is mounted. */
const view: { sidebar?: SidebarApi } = {};

const rpc = new Rpc<SidebarView, SidebarHost>((message) => vscode.postMessage(message), {
	update: (state) => view.sidebar?.update(state),
	setActive: (path) => view.sidebar?.setActive(path),
	environmentChanged: (name) => view.sidebar?.environmentChanged(name),
	setHistory: (entries) => view.sidebar?.setHistory(entries),
	collapseAll: () => view.sidebar?.collapseAll(),
	reveal: (root) => view.sidebar?.reveal(root),
});
window.addEventListener("message", (e: MessageEvent) => void rpc.receive(e.data));
reportProblems((message) => rpc.notify("problem", message));
const metrics = reportMetrics((name, value) => rpc.notify("metric", name, value));
rpc.notify("metric", "scriptStarted", Date.now());

const loadHistory = () => void rpc.call("history").then((entries) => view.sidebar?.setHistory(entries));

const initial = await rpc.call("ready");
rpc.notify("metric", "stateReceived", Date.now());
view.sidebar = mount(Sidebar, {
	target: document.body,
	props: {
		initial,
		saved: vscode.getState(),
		onSave: (state: SavedSidebar) => vscode.setState(state),
		onOpen: (path: string) => rpc.notify("open", path),
		onNewCollection: () => rpc.notify("newCollection"),
		onNewEnvironment: () => rpc.notify("newEnvironment"),
		onOpenFolder: () => rpc.notify("openFolder"),
		onSelectEnvironment: (name: string) => rpc.notify("selectEnvironment", name),
		onEditEnvironment: (path: string) => rpc.notify("editEnvironment", path),
		onEditGlobals: () => rpc.notify("editGlobals"),
		onMove: (path: string, dir: string, anchor: string | undefined, position: MovePosition) => rpc.notify("move", path, dir, anchor, position),
		onMoveCollection: (root: string, anchor: string, position: "before" | "after") => rpc.notify("moveCollection", root, anchor, position),
		onMoveEnvironment: (path: string, anchor: string, position: "before" | "after") => rpc.notify("moveEnvironment", path, anchor, position),
		onShowHistory: loadHistory,
		onOpenHistory: (entry: HistoryEntry) => rpc.notify("openHistory", entry.id),
		onClearHistory: () => rpc.notify("clearHistory"),
	},
}) as SidebarApi;
rpc.notify("metric", "mounted", Date.now());
metrics.painted("sidebarPainted");
