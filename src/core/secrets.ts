import { stem } from "./storage/paths";

/**
 * The secret storage key for an environment variable. VS Code has one store per extension, so
 * the key includes the workspace.
 */
export function environmentSecretId(workspaceId: string, environmentPath: string, name: string): string {
	return `carbonwire/${workspaceId}/${encodeURIComponent(stem(environmentPath))}/${encodeURIComponent(name)}`;
}
