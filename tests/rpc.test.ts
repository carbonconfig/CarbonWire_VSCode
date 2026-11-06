import { describe, expect, it } from "vitest";
import { Rpc, type RpcMessage } from "../src/ui/rpc";

type HostApi = {
	add(a: number, b: number): number;
	bytes(input: { data: Uint8Array }): { data: Uint8Array; length: number };
	fail(): void;
	hello(name: string): void;
};
type ViewApi = {
	echo(text: string): string;
};

/** Copies a message as VS Code's postMessage does: ArrayBuffers survive, typed arrays become plain objects. */
function copyLikeVsCode(message: unknown): unknown {
	const buffers: ArrayBuffer[] = [];
	const json = JSON.stringify(message, (_key, value: unknown) => (value instanceof ArrayBuffer ? { $buffer: buffers.push(value.slice(0)) - 1 } : value));
	return JSON.parse(json, (_key, value: unknown) => (value && typeof value === "object" && "$buffer" in value ? buffers[value.$buffer as number] : value));
}

/** Two sides wired together, with messages copied and delivered asynchronously. */
function pair() {
	const greeted: string[] = [];
	const sent: RpcMessage[] = [];
	const sides: { view?: Rpc<ViewApi, HostApi> } = {};
	const host: Rpc<HostApi, ViewApi> = new Rpc<HostApi, ViewApi>(
		(m) => {
			sent.push(m);
			queueMicrotask(() => void sides.view?.receive(copyLikeVsCode(m)));
		},
		{
			add: (a, b) => a + b,
			bytes: (input) => ({ data: input.data.subarray(1), length: input.data.length }),
			fail: () => {
				throw new Error("nope");
			},
			hello: async (name) => {
				greeted.push(name);
			},
		},
	);
	const view = new Rpc<ViewApi, HostApi>((m) => queueMicrotask(() => void host.receive(copyLikeVsCode(m))), { echo: (text) => text.toUpperCase() });
	sides.view = view;
	return { host, view, greeted, sent };
}

describe("Rpc", () => {
	it("returns results and errors from the other side, in both directions", async () => {
		const { host, view } = pair();
		expect(await view.call("add", 2, 3)).toBe(5);
		expect(await host.call("echo", "hi")).toBe("HI");
		await expect(view.call("fail")).rejects.toThrow("nope");
	});

	it("sends byte arrays both ways, including parts of a larger buffer", async () => {
		const { view } = pair();
		const result = await view.call("bytes", { data: new Uint8Array([9, 1, 2, 3]).subarray(1) });
		expect(result.data).toBeInstanceOf(Uint8Array);
		expect([...result.data]).toEqual([2, 3]);
		expect(result.length).toBe(3);
	});

	it("sends only a Node Buffer's own bytes, not the shared pool around it", async () => {
		const { view } = pair();
		const pooled = Buffer.from("hello");
		expect(pooled.buffer.byteLength).toBeGreaterThan(pooled.byteLength);
		const result = await view.call("bytes", { data: pooled });
		expect(Buffer.from(result.data).toString()).toBe("ello");
	});

	it("rejects calls to methods the other side doesn't have", async () => {
		const { view } = pair();
		await expect((view as unknown as Rpc<ViewApi, Record<string, () => void>>).call("toString")).rejects.toThrow("Unknown method: toString");
	});

	it("sends nothing back for notifications", async () => {
		const { view, greeted, sent } = pair();
		view.notify("hello", "you");
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(greeted).toEqual(["you"]);
		expect(sent).toEqual([]);
	});

	it("ignores other messages, and rejects pending calls when disposed", async () => {
		const { host } = pair();
		await host.receive({ type: "something else" });
		await host.receive(null);
		const lost = new Rpc<HostApi, ViewApi>(() => {}, { add: () => 0, bytes: (input) => ({ data: input.data, length: 0 }), fail: () => {}, hello: () => {} });
		const call = lost.call("echo", "x");
		lost.dispose();
		await expect(call).rejects.toThrow("closed");
	});
});
