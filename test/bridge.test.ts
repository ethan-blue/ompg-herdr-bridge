import { afterEach, expect, test } from "bun:test";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import bridge from "../herdr-ompg-bridge";

interface Request {
	id: string;
	method: string;
	params: { seq: number; state?: string; tokens?: Record<string, string | null> };
}
interface Context {
	hasUI: boolean;
	isIdle(): boolean;
	model?: { id: string };
	sessionManager: { getSessionId(): string };
	getContextUsage(): { contextTokens: number; contextWindow: number } | undefined;
}
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0)) await cleanup();
});
async function until(predicate: () => boolean): Promise<void> {
	const deadline = Date.now() + 2000;
	while (!predicate()) {
		if (Date.now() >= deadline) throw new Error("bridge observation timed out");
		await Bun.sleep(5);
	}
}
function context(id = "old", used: number | undefined = 11): Context {
	return {
		hasUI: true,
		isIdle: () => true,
		model: { id },
		sessionManager: { getSessionId: () => id },
		getContextUsage: () => (used === undefined ? undefined : { contextTokens: used, contextWindow: 1000 }),
	};
}
async function fixture(
	respond?: (request: Request, socket: net.Socket) => void,
	thinking: () => string | Promise<string> = () => "medium",
) {
	const name = `ompg-bridge-${process.pid}-${crypto.randomUUID()}`;
	const endpoint = process.platform === "win32" ? `\\\\.\\pipe\\${name}` : path.join(os.tmpdir(), `${name}.sock`);
	const requests: Request[] = [];
	const sockets = new Set<net.Socket>();
	const server = net.createServer(socket => {
		sockets.add(socket);
		socket.on("error", () => {});
		socket.on("close", () => sockets.delete(socket));
		socket.setEncoding("utf8");
		let buffer = "";
		socket.on("data", chunk => {
			buffer += chunk;
			const newline = buffer.indexOf("\n");
			if (newline < 0) return;
			const request: Request = JSON.parse(buffer.slice(0, newline));
			requests.push(request);
			if (respond) respond(request, socket);
			else socket.write(`${JSON.stringify({ id: request.id, result: {} })}\n`);
		});
	});
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(endpoint, resolve);
	});
	const handlers = new Map<string, (event: unknown, ctx: Context) => unknown>();
	const warnings: string[] = [];
	const notices: string[] = [];
	let command: ((args: string, ctx: unknown) => Promise<void>) | undefined;
	bridge(
		{
			logger: { info: () => {}, warn: (message: string) => warnings.push(message) },
			on: (event: string, handler: (event: unknown, ctx: Context) => unknown) => handlers.set(event, handler),
			events: { on: () => {} },
			getThinkingLevel: thinking,
			registerCommand: (_name: string, spec: { handler: (args: string, ctx: unknown) => Promise<void> }) => {
				command = spec.handler;
			},
		} as unknown as ExtensionAPI,
		{
			HERDR_ENV: "1",
			HERDR_SOCKET_PATH: process.platform === "win32" ? name : endpoint,
			HERDR_PANE_ID: "test",
			HERDR_OMP_BRIDGE_HEARTBEAT_MS: "0",
			HERDR_OMP_IDLE_DEBOUNCE_MS: "0",
		},
	);
	const emit = (event: string, ctx = context()) => handlers.get(event)?.({}, ctx);
	cleanups.push(async () => {
		emit("session_shutdown");
		for (const socket of sockets) socket.destroy();
		await new Promise<void>(resolve => server.close(() => resolve()));
	});
	return {
		requests,
		warnings,
		emit,
		async status() {
			await command?.("status", { ui: { notify: (message: string) => notices.push(message) } });
			return notices.at(-1);
		},
	};
}

test("reports are serialized behind a complete matching JSON Lines acknowledgement", async () => {
	let first: net.Socket | undefined;
	let tail = "";
	const f = await fixture((request, socket) => {
		const response = `${JSON.stringify({ id: request.id, result: {} })}\n`;
		if (!first) {
			first = socket;
			socket.write(response.slice(0, 12));
			tail = response.slice(12);
		} else socket.write(response);
	});
	f.emit("session_start");
	await until(() => f.requests.length === 1);
	f.emit("agent_start");
	await Bun.sleep(30);
	expect(f.requests).toHaveLength(1);
	first?.write(tail);
	await until(() => f.requests.some(r => r.method === "pane.report_metadata"));
	expect(f.requests.map(r => r.params.seq)).toEqual([...f.requests.map(r => r.params.seq)].sort((a, b) => a - b));
});

for (const response of ["error", "wrong-id"] as const) {
	test(`${response} response is a delivery failure, not healthy data`, async () => {
		const f = await fixture((request, socket) =>
			socket.write(
				`${JSON.stringify(
					response === "error"
						? { id: request.id, error: { code: "not_found" } }
						: { id: "another-request", result: {} },
				)}\n`,
			),
		);
		f.emit("session_start");
		await until(() => f.warnings.length > 0);
		expect(await f.status()).toContain("healthy: false");
		expect(f.warnings[0]).toContain("not acknowledged");
	});
}

test("new and switched sessions refresh context and explicitly clear unavailable metadata", async () => {
	const f = await fixture();
	f.emit("session_start");
	await until(() => f.requests.some(r => r.params.tokens?.model === "old"));
	f.emit("session_switch", context("new", 222));
	await until(() => f.requests.some(r => r.params.tokens?.model === "new"));
	expect(f.requests.find(r => r.params.tokens?.model === "new")?.params.tokens?.context).toBe("222/1k (22%)");
	const missing = context("missing", undefined);
	missing.model = undefined;
	missing.getContextUsage = () => undefined;
	f.emit("session_start", missing);
	await until(() => f.requests.some(r => r.params.tokens?.model === null));
	expect(f.requests.at(-1)?.params.tokens).toEqual({ model: null, thinking: "medium", context: null });
});

test("old asynchronous metadata cannot overwrite a newer session", async () => {
	const deferred = Promise.withResolvers<string>();
	let calls = 0;
	const f = await fixture(undefined, () => (++calls === 1 ? deferred.promise : "high"));
	f.emit("session_start");
	await until(() => calls === 1);
	f.emit("session_switch", context("new", 222));
	await until(() => f.requests.some(r => r.params.tokens?.model === "new"));
	deferred.resolve("low");
	await Bun.sleep(30);
	expect(f.requests.filter(r => r.params.tokens).map(r => r.params.tokens?.model)).toEqual(["new"]);
});

test("shutdown cancels pending delivery and prevents old reporter resync", async () => {
	const f = await fixture(() => {});
	f.emit("session_start");
	await until(() => f.requests.length === 1);
	f.emit("agent_start");
	f.emit("session_shutdown");
	f.emit("agent_start");
	await Bun.sleep(40);
	expect(f.requests).toHaveLength(1);
	expect(f.warnings).toHaveLength(0);
});
