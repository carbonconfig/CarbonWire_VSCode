/** Methods one side exposes to the other. Arguments and results must survive structured cloning. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- each method keeps its own parameter types
export type Api = Record<string, (...args: any[]) => unknown>;

/** An implementation of an API: each method may also return its result as a promise. */
export type Handlers<T extends Api> = { [K in keyof T]: (...args: Parameters<T[K]>) => ReturnType<T[K]> | Promise<ReturnType<T[K]>> };

export type RpcMessage =
	| { rpc: "call"; id: number; method: string; args: unknown[] }
	| { rpc: "result"; id: number; value: unknown }
	| { rpc: "error"; id: number; message: string };

/** A Uint8Array in transit; see `encode`. */
interface Bytes {
	$bytes: ArrayBuffer;
}

/**
 * postMessage recreates ArrayBuffers but not typed arrays, so byte arrays travel as tagged
 * ArrayBuffers. Objects without any are passed as they are.
 */
function encode(value: unknown): unknown {
	if (value instanceof Uint8Array) {
		const { buffer } = value;
		const whole = buffer instanceof ArrayBuffer && value.byteOffset === 0 && value.byteLength === buffer.byteLength;
		// A copy, not value.slice(): on a Node Buffer that is a view into Node's shared buffer pool.
		return { $bytes: whole ? buffer : new Uint8Array(value).buffer } satisfies Bytes;
	}
	if (Array.isArray(value)) return mapChanged(value, encode);
	if (value && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) return mapValuesChanged(value, encode);
	return value;
}

function decode(value: unknown): unknown {
	if (Array.isArray(value)) return mapChanged(value, decode);
	if (value && typeof value === "object") {
		if ("$bytes" in value && value.$bytes instanceof ArrayBuffer) return new Uint8Array(value.$bytes);
		return mapValuesChanged(value, decode);
	}
	return value;
}

/** The array with `f` applied, or the same array when `f` changed nothing. */
function mapChanged(values: unknown[], f: (value: unknown) => unknown): unknown[] {
	let out: unknown[] | undefined;
	for (let i = 0; i < values.length; i++) {
		const next = f(values[i]);
		if (next !== values[i]) (out ??= values.slice())[i] = next;
	}
	return out ?? values;
}

/** The object with `f` applied to its values, or the same object when `f` changed nothing. */
function mapValuesChanged(object: object, f: (value: unknown) => unknown): object {
	let out: Record<string, unknown> | undefined;
	for (const [key, value] of Object.entries(object)) {
		const next = f(value);
		if (next !== value) (out ??= { ...object })[key] = next;
	}
	return out ?? object;
}

function isRpcMessage(value: unknown): value is RpcMessage {
	return typeof value === "object" && value !== null && "rpc" in value && typeof (value as { id?: unknown }).id === "number";
}

/**
 * Calls between the extension and a webview over postMessage. `call` resolves with the other
 * side's result; `notify` wants no reply and sends id 0.
 */
export class Rpc<Local extends Api, Remote extends Api> {
	private nextId = 1;
	private readonly pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();

	constructor(
		private readonly post: (message: RpcMessage) => void,
		private readonly local: Handlers<Local>,
	) {}

	call<K extends keyof Remote & string>(method: K, ...args: Parameters<Remote[K]>): Promise<Awaited<ReturnType<Remote[K]>>> {
		const id = this.nextId++;
		return new Promise((resolve, reject) => {
			this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
			this.post({ rpc: "call", id, method, args: encode(args) as unknown[] });
		});
	}

	notify<K extends keyof Remote & string>(method: K, ...args: Parameters<Remote[K]>): void {
		this.post({ rpc: "call", id: 0, method, args: encode(args) as unknown[] });
	}

	/** Handles a message from the other side; anything that isn't an RPC message is ignored. */
	async receive(message: unknown): Promise<void> {
		if (!isRpcMessage(message)) return;
		if (message.rpc === "call") {
			const { id } = message;
			try {
				const handlers = this.local as Api;
				const method = Object.hasOwn(handlers, message.method) ? handlers[message.method] : undefined;
				if (!method) throw new Error(`Unknown method: ${message.method}`);
				const value = await method.apply(handlers, decode(message.args) as unknown[]);
				if (id) this.post({ rpc: "result", id, value: encode(value) });
			} catch (e) {
				if (id) this.post({ rpc: "error", id, message: e instanceof Error ? e.message : String(e) });
			}
			return;
		}
		const pending = this.pending.get(message.id);
		if (!pending) return;
		this.pending.delete(message.id);
		if (message.rpc === "result") pending.resolve(decode(message.value));
		else pending.reject(new Error(message.message));
	}

	/** Rejects calls still waiting, e.g. when the webview goes away. */
	dispose(): void {
		for (const { reject } of this.pending.values()) reject(new Error("The view was closed."));
		this.pending.clear();
	}
}
