import { createHash } from "node:crypto";
import * as vscode from "vscode";
import type { Environment } from "../core/model";
import { environmentSecretId } from "../core/secrets";

/** Identifies the open workspace in secret keys: its .code-workspace file, or its first folder. */
export function workspaceId(): string {
	const uri = vscode.workspace.workspaceFile ?? vscode.workspace.workspaceFolders?.[0]?.uri;
	return createHash("sha256").update(uri?.toString() ?? "").digest("hex").slice(0, 16);
}

/** Names of an environment's secret variables, whose values live in secret storage. */
export function secretNames(env: Environment): string[] {
	return (env.variables ?? []).flatMap((v) => ("secret" in v && v.secret && v.name ? [v.name] : []));
}

/**
 * Secret environment values in VS Code's secret storage. Reads are async, so values are loaded
 * before variables are resolved.
 */
export class Secrets implements vscode.Disposable {
	private readonly cache = new Map<string, string | null>();
	private readonly listener: vscode.Disposable;

	constructor(private readonly storage: vscode.SecretStorage) {
		// Also fires for changes from other VS Code windows.
		this.listener = storage.onDidChange((e) => {
			if (this.cache.has(e.key)) void storage.get(e.key).then((value) => this.cache.set(e.key, value ?? null));
		});
	}

	/** Loads the named secrets of an environment, so `get` can return them. */
	async load(environmentPath: string, names: readonly string[]): Promise<void> {
		await Promise.all(
			names.map(async (name) => {
				const key = this.key(environmentPath, name);
				if (!this.cache.has(key)) this.cache.set(key, (await this.storage.get(key)) ?? null);
			}),
		);
	}

	/** A loaded value; null when unset or not loaded yet. */
	get(environmentPath: string, name: string): string | null {
		return this.cache.get(this.key(environmentPath, name)) ?? null;
	}

	/** An empty value deletes the secret. */
	async set(environmentPath: string, name: string, value: string): Promise<void> {
		const key = this.key(environmentPath, name);
		this.cache.set(key, value || null);
		if (value) await this.storage.store(key, value);
		else await this.storage.delete(key);
	}

	dispose(): void {
		this.listener.dispose();
	}

	private key(environmentPath: string, name: string): string {
		return environmentSecretId(workspaceId(), environmentPath, name);
	}
}
