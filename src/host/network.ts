import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import * as vscode from "vscode";
import type { Cookie, CookieJar } from "../core/cookies";
import type { ClientCertificate } from "../core/transport/node";
import { bypasses, parseProxyUrl, proxyFromEnvironment, type ProxyTarget } from "../core/transport/proxy";
import type { CookieHooks } from "../core/transport/types";
import { debounce } from "./debounce";
import type { Settings } from "./settings";

/** A client certificate setting: a host pattern and PEM files or a PKCS #12 file. */
export interface CertificateSetting {
	host: string;
	certificate?: string;
	key?: string;
	pfx?: string;
}

interface LoadedCertificate extends ClientCertificate {
	host: string;
	port?: string;
}

const PROXY_SECRET = "carbonwire/proxy-password";
const certificateSecret = (host: string) => `carbonwire/certificate/${host}`;

/** Whether a pattern such as api.example.com, *.example.com or host:8443 covers `url`. */
export function hostMatches(pattern: string, url: URL): boolean {
	const at = pattern.lastIndexOf(":");
	const [name, port] = at > 0 && /^\d+$/.test(pattern.slice(at + 1)) ? [pattern.slice(0, at), pattern.slice(at + 1)] : [pattern, undefined];
	const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
	if (port && port !== (url.port || (url.protocol === "https:" ? "443" : "80"))) return false;
	const p = name.trim().toLowerCase();
	return p.startsWith("*.") ? host.endsWith(p.slice(1)) : host === p;
}

/**
 * Proxy, client certificates, extra CAs and the cookie jar. Certificate files are read once into
 * memory; passphrases and the proxy password stay in secret storage.
 */
export class Network implements vscode.Disposable {
	private certificates: LoadedCertificate[] = [];
	private ca?: { id: string; certs: string[] };
	private proxyPassword?: string;
	private loaded?: Promise<void>;
	/** Changes with each reload, so connections made with old certificates aren't reused. */
	private generation = 0;
	private jar?: CookieJar;
	private jarLoading?: Promise<CookieJar>;
	private readonly saveJar = debounce(() => void this.writeJar(), 1000);
	private readonly cookiesChangedEmitter = new vscode.EventEmitter<void>();
	private readonly cookiesChanged = debounce(() => this.cookiesChangedEmitter.fire(), 200);
	/** The jar changed: a response set cookies, or they were edited in the cookie manager. */
	readonly onCookiesChanged = this.cookiesChangedEmitter.event;
	/** Problems reading certificates, shown once per change. */
	readonly problems: string[] = [];

	constructor(
		private readonly secrets: vscode.SecretStorage,
		private readonly settings: () => Settings,
		/** Turns a path from settings into an absolute one, relative to the first workspace folder. */
		private readonly resolvePath: (path: string) => string,
		private readonly cookieFile: string,
		private readonly log: (message: string) => void,
	) {}

	/** Re-reads certificate files and secrets, e.g. after the settings change. */
	reload(): Promise<void> {
		this.loaded = this.load();
		return this.loaded;
	}

	ready(): Promise<void> {
		return (this.loaded ??= this.load());
	}

	proxyFor(url: URL): ProxyTarget | undefined {
		const s = this.settings();
		if (s.proxy !== "custom") return s.proxy === "environment" ? proxyFromEnvironment(url) : undefined;
		if (bypasses(s.proxyBypass, url)) return undefined;
		try {
			return parseProxyUrl(s.proxyUrl, this.proxyPassword);
		} catch {
			return undefined;
		}
	}

	certificateFor(url: URL): ClientCertificate | undefined {
		return this.certificates.find((c) => hostMatches(c.port ? `${c.host}:${c.port}` : c.host, url));
	}

	certificateAuthorities(): { id: string; certs: string[] } | undefined {
		return this.ca;
	}

	async setProxyPassword(value: string): Promise<void> {
		if (value) await this.secrets.store(PROXY_SECRET, value);
		else await this.secrets.delete(PROXY_SECRET);
		await this.reload();
	}

	async setCertificatePassphrase(host: string, value: string): Promise<void> {
		if (value) await this.secrets.store(certificateSecret(host), value);
		else await this.secrets.delete(certificateSecret(host));
		await this.reload();
	}

	/** The jar, read from this workspace's storage on first use. */
	cookieJar(): Promise<CookieJar> {
		if (this.jar) return Promise.resolve(this.jar);
		return (this.jarLoading ??= this.readJar());
	}

	/** Cookie hooks for a send; reading the jar happens before the first send. */
	async cookieHooks(): Promise<CookieHooks> {
		const jar = await this.cookieJar();
		return { header: (url) => jar.header(url), store: (url, setCookies) => void jar.store(url, setCookies) };
	}

	async flush(): Promise<void> {
		this.saveJar.cancel();
		await this.writeJar();
	}

	dispose(): void {
		this.saveJar.cancel();
		this.cookiesChanged.cancel();
		this.cookiesChangedEmitter.dispose();
	}

	private async load(): Promise<void> {
		this.problems.length = 0;
		this.generation++;
		const s = this.settings();
		this.proxyPassword = (await this.secrets.get(PROXY_SECRET)) ?? undefined;
		const read = async (path: string | undefined, what: string): Promise<Buffer | undefined> => {
			if (!path?.trim()) return undefined;
			const full = isAbsolute(path) ? path : this.resolvePath(path);
			try {
				return await readFile(full);
			} catch (e) {
				this.problems.push(`The ${what} ${path} can't be read: ${e instanceof Error ? e.message : String(e)}`);
				return undefined;
			}
		};
		const loaded: LoadedCertificate[] = [];
		for (const [i, c] of s.clientCertificates.entries()) {
			if (!c.host?.trim()) continue;
			const passphrase = (await this.secrets.get(certificateSecret(c.host.trim()))) ?? undefined;
			const [cert, key, pfx] = await Promise.all([read(c.certificate, "certificate"), read(c.key, "key"), read(c.pfx, "PKCS #12 file")]);
			if (!pfx && !(cert && key)) {
				if (c.pfx || c.certificate || c.key) continue;
				this.problems.push(`The client certificate for ${c.host} needs a certificate and key, or a PKCS #12 (.pfx, .p12) file.`);
				continue;
			}
			loaded.push({ id: `${this.generation}:${i}:${c.host}`, host: c.host.trim(), cert, key, pfx, passphrase });
		}
		this.certificates = loaded;
		const cas = (await Promise.all(s.caCertificates.map((path) => read(path, "certificate authority")))).flatMap((b) => (b ? [b.toString()] : []));
		this.ca = cas.length > 0 ? { id: `${this.generation}`, certs: cas } : undefined;
		for (const p of this.problems) this.log(p);
	}

	private async readJar(): Promise<CookieJar> {
		let cookies: Cookie[] = [];
		try {
			const parsed: unknown = JSON.parse(await readFile(this.cookieFile, "utf8"));
			if (Array.isArray(parsed)) cookies = parsed as Cookie[];
		} catch {
			// No cookies yet.
		}
		const { CookieJar } = await import("../core/cookies");
		this.jar = new CookieJar(cookies, () => {
			this.saveJar();
			this.cookiesChanged();
		});
		return this.jar;
	}

	private async writeJar(): Promise<void> {
		if (!this.jar) return;
		const tmp = `${this.cookieFile}.tmp`;
		await mkdir(dirname(this.cookieFile), { recursive: true });
		await writeFile(tmp, JSON.stringify(this.jar.all()));
		await rename(tmp, this.cookieFile);
	}
}

export function cookieFile(storage: vscode.Uri): string {
	return join(storage.fsPath, "cookies.json");
}
