import * as vscode from "vscode";
import type { CollectionNode, TreeNode } from "../core/storage/tree";
import { colorForName, ENV_COLORS } from "../ui/env-colors";

/** Asks for a name; resolves to it trimmed, or undefined if cancelled or left empty. */
export async function promptText(title: string, value: string, placeholder = "", action?: string): Promise<string | undefined> {
	const name = await vscode.window.showInputBox({
		title,
		value,
		placeHolder: placeholder,
		prompt: action ? `Press Enter to ${action.toLowerCase()}.` : undefined,
		validateInput: (text) => (text.trim() ? undefined : "Enter a name."),
	});
	return name?.trim() || undefined;
}

export async function confirmAction(message: string, detail: string, action: string): Promise<boolean> {
	return (await vscode.window.showWarningMessage(message, { modal: true, detail }, action)) === action;
}

const COLOR_NAMES: Record<string, string> = {
	"#2F80ED": "Blue",
	"#27AE60": "Green",
	"#F2994A": "Orange",
	"#9B51E0": "Purple",
	"#EB5757": "Red",
};

export interface EnvironmentChoice {
	name: string;
	color: string;
}

/** Asks for an environment's name, then its colour; with `suggest`, a colour matching the name comes first. */
export async function promptEnvironment(options: { title: string; action: string; name: string; color: string; suggest: boolean }): Promise<EnvironmentChoice | undefined> {
	const name = await promptText(options.title, options.name, "Environment name", options.action);
	if (!name) return undefined;
	const current = options.color.toUpperCase();
	const suggested = options.suggest ? colorForName(name)?.toUpperCase() : undefined;
	const items: { label: string; description?: string; color: string }[] = ENV_COLORS.map((color) => ({
		label: COLOR_NAMES[color] ?? color,
		description: color === suggested ? "Suggested" : color === current ? "Current" : undefined,
		color,
	}));
	if (!items.some((i) => i.color === current)) items.unshift({ label: "Custom", description: "Current", color: options.color });
	items.sort((a, b) => Number(b.description === "Suggested") - Number(a.description === "Suggested"));
	const picked = await vscode.window.showQuickPick(items, { title: `${options.title}: colour`, placeHolder: "Choose a colour" });
	return picked && { name, color: picked.color };
}

export interface RequestLocation {
	dir: string;
	label: string;
}

/** Every collection and folder a request can be saved in, as "Collection / Folder / Subfolder". */
export function requestLocations(collections: readonly CollectionNode[]): RequestLocation[] {
	const out: RequestLocation[] = [];
	const walk = (nodes: readonly TreeNode[], prefix: string) => {
		for (const n of nodes) {
			if (n.kind !== "folder") continue;
			const label = `${prefix} / ${n.name}`;
			out.push({ dir: n.path, label });
			walk(n.children, label);
		}
	};
	for (const c of collections) {
		out.push({ dir: c.root, label: c.name });
		walk(c.children, c.name);
	}
	return out;
}

/** Asks for the collection or folder to save a request in, then its name. */
export async function promptSaveRequest(locations: readonly RequestLocation[], initial: { name: string; dir?: string }): Promise<{ name: string; dir: string } | undefined> {
	const items = locations.map((l) => ({ label: l.label, dir: l.dir, description: l.dir === initial.dir ? "Suggested" : undefined }));
	items.sort((a, b) => Number(b.description !== undefined) - Number(a.description !== undefined));
	const picked = await vscode.window.showQuickPick(items, { title: "Save request: location", placeHolder: "Choose a collection or folder" });
	if (!picked) return undefined;
	const name = await promptText("Save request: name", initial.name, "Get user", "Save");
	return name ? { name, dir: picked.dir } : undefined;
}
