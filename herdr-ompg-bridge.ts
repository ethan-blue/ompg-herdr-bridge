// herdr-ompg-bridge: community agent-state bridge between herdr and omp/ompg.
// Reports working/blocked/idle state, session identity (with resume_argv),
// and rich metadata (model, thinking level, context usage) over the herdr
// socket API. Self-heals after herdr restarts instead of silently dropping.
//
// Protocol: https://herdr.dev/docs/socket-api/ (JSON Lines, one request per
// connection, seq for out-of-order rejection). Env contract set by herdr:
// HERDR_ENV=1, HERDR_SOCKET_PATH, HERDR_PANE_ID. OMP marks its shells with
// OMPCODE=1; a nested omp must not steal its parent pane's report authority.
//
// This file replaces herdr's bundled "herdr-omp-agent-state.ts" integration.
// Uninstall the bundled one first (`herdr integration uninstall omp`, plus
// remove any copy in a non-default config dir such as ~/.ompg) so a single
// source reports state for the pane.
//
// Env knobs (all optional):
//   HERDR_OMP_BRIDGE_FORCE=1        activate even without a UI (testing)
//   HERDR_OMP_IDLE_DEBOUNCE_MS      idle debounce, default 250
//   HERDR_OMP_BRIDGE_METADATA=0     disable pane.report_metadata
//   HERDR_OMP_BRIDGE_HEARTBEAT_MS  periodic full re-report, default 30000 (0 = off);
//                                   herdr's agent state decays without re-assertion
//   HERDR_OMP_BRIDGE_DISPLAY_NAME   display_agent shown in herdr UI, default "ompg"
//                                    (set 0 to keep the authoritative "omp" label visible)
//   HERDR_OMP_BRIDGE_LOG=1          verbose logging for debugging

import type { ExtensionAPI, ExtensionUIContext } from "@oh-my-pi/pi-coding-agent";
import net from "node:net";

const SOURCE = "herdr:omp";
const AGENT = "omp";
const SEND_TIMEOUT_MS = 500;
const SEND_RETRY_TIMEOUT_MS = 1500;
const RESYNC_BACKOFF_MS = [1000, 2000, 5000, 10000] as const;
// herdr treats agent state as stale without periodic re-assertion; a
// mid-task agent that never transitions would otherwise decay to "unknown".
const DEFAULT_HEARTBEAT_MS = 30_000;

type AgentState = "idle" | "working" | "blocked";

interface BridgeContext {
	hasUI?: boolean;
	isIdle?(): boolean;
	cwd?: string;
	model?: { id?: string; provider?: string } | undefined;
	agent?: { kind?: string };
	sessionManager?: {
		getSessionId?(): string | undefined;
		getSessionFile?(): string | undefined;
	};
	getContextUsage?():
		| {
				contextTokens?: number;
				usedTokens?: number;
				contextWindow?: number;
				tokens?: number;
				windowTokens?: number;
				usedFraction?: number;
		  }
		| undefined;
	ui?: Pick<ExtensionUIContext, "notify">;
}

function envInt(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
	const raw = env[name];
	if (!raw) return fallback;
	const n = Number.parseInt(raw, 10);
	return Number.isFinite(n) && n >= 0 ? n : fallback;
}

export default function herdrOmpgBridge(pi: ExtensionAPI, env: NodeJS.ProcessEnv = process.env): void {
	const log = pi.logger;
	const socketPath = env.HERDR_SOCKET_PATH;
	const paneId = env.HERDR_PANE_ID;
	const force = env.HERDR_OMP_BRIDGE_FORCE === "1";
	const metadataEnabled = env.HERDR_OMP_BRIDGE_METADATA !== "0";
	const verbose = env.HERDR_OMP_BRIDGE_LOG === "1";
	const idleDebounceMs = envInt(env, "HERDR_OMP_IDLE_DEBOUNCE_MS", 250);
	const heartbeatMs = envInt(env, "HERDR_OMP_BRIDGE_HEARTBEAT_MS", DEFAULT_HEARTBEAT_MS);
	// display_agent is a display-only override (metadata); the authoritative
	// agent label stays "omp" so herdr keeps its built-in omp semantics.
	const configuredDisplayName = env.HERDR_OMP_BRIDGE_DISPLAY_NAME ?? "ompg";
	const displayName = configuredDisplayName === "0" ? "" : configuredDisplayName;
	const endpoint = process.platform === "win32" && socketPath ? `\\\\.\\pipe\\${socketPath}` : socketPath;
	const enabled = env.HERDR_ENV === "1" && !!socketPath && !!paneId && env.OMPCODE !== "1";

	if (!enabled) {
		log.info("herdr-ompg-bridge: inactive (HERDR_ENV/HERDR_SOCKET_PATH/HERDR_PANE_ID not set)");
		return;
	}

	// ------------------------------------------------------------------
	// Delivery: serial queue, one request per connection, JSON Lines.
	// ------------------------------------------------------------------
	let reportSeq = Date.now() * 1000;
	let requestSeq = 0;
	let stopped = false;
	let metadataRevision = 0;
	const inFlight = new Set<net.Socket>();

	function nextSeq(): number {
		return ++reportSeq;
	}

	function send(method: string, params: Record<string, unknown>, timeoutMs: number): Promise<boolean> {
		if (stopped || runtimeOff) return Promise.resolve(false);
		const request = {
			id: `herdr:omp:bridge:${Date.now()}:${++requestSeq}`,
			method,
			params,
		};
		const { promise, resolve } = Promise.withResolvers<boolean>();
		{
			let settled = false;
			let socket: net.Socket | undefined;
			let timer: NodeJS.Timeout | undefined;
			let buffer = "";
			const finish = (ok: boolean) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				if (socket) inFlight.delete(socket);
				try {
					socket?.destroy();
				} catch {
					/* already closed */
				}
				resolve(ok);
			};
			timer = setTimeout(() => finish(false), timeoutMs);
			try {
				socket = net.createConnection(endpoint, () => {
					socket?.write(JSON.stringify(request) + "\n");
				});
				inFlight.add(socket);
				socket.setEncoding("utf8");
				socket.on("data", chunk => {
					buffer += chunk;
					const newline = buffer.indexOf("\n");
					if (newline < 0) return;
					try {
						const response: unknown = JSON.parse(buffer.slice(0, newline));
						finish(
							typeof response === "object" &&
								response !== null &&
								"id" in response &&
								response.id === request.id &&
								"result" in response &&
								!("error" in response),
						);
					} catch {
						finish(false);
					}
				});
				socket.on("error", () => finish(false));
				socket.on("close", () => finish(false));
			} catch {
				finish(false);
			}
		}
		return promise;
	}

	// Serial delivery with per-request retry; tracks health for resync.
	let sendQueue: Promise<void> = Promise.resolve();
	let healthy = true;
	let failureNotified = false;
	let lastError = "";

	function enqueue(method: string, params: Record<string, unknown>): Promise<boolean> {
		const run = sendQueue.then(async () => {
			if (stopped || runtimeOff) return false;
			const ok =
				(await send(method, params, SEND_TIMEOUT_MS)) || (await send(method, params, SEND_RETRY_TIMEOUT_MS));
			if (stopped || runtimeOff) return false;
			healthy = ok;
			if (!ok) {
				lastError = `${method} failed (request not acknowledged)`;
				if (!failureNotified) {
					failureNotified = true;
					log.warn(`herdr-ompg-bridge: ${lastError}; will retry in background`);
				}
				scheduleResync();
			} else if (failureNotified) {
				failureNotified = false;
				lastError = "";
				log.info("herdr-ompg-bridge: delivery recovered");
			}
			return ok;
		});
		// Keep the chain alive even when a step rejects (it never does; send resolves).
		sendQueue = run.then(
			() => {},
			() => {},
		);
		return run;
	}

	// ------------------------------------------------------------------
	// Self-healing resync: while unhealthy, periodically re-deliver the
	// full report set (session + state + metadata) so a herdr restart
	// never leaves the pane stuck on a stale state.
	// ------------------------------------------------------------------
	let resyncTimer: NodeJS.Timeout | undefined;
	let resyncAttempt = 0;
	let heartbeatTimer: NodeJS.Timeout | undefined;

	function scheduleResync(): void {
		if (stopped || runtimeOff || resyncTimer) return;
		const delay = RESYNC_BACKOFF_MS[Math.min(resyncAttempt, RESYNC_BACKOFF_MS.length - 1)];
		resyncTimer = setTimeout(() => {
			resyncTimer = undefined;
			if (healthy) {
				resyncAttempt = 0;
				return;
			}
			resyncAttempt++;
			if (verbose) log.info(`herdr-ompg-bridge: resync attempt #${resyncAttempt}`);
			void fullResync().then(ok => {
				if (ok) resyncAttempt = 0;
				scheduleResync();
			});
		}, delay);
	}

	async function fullResync(): Promise<boolean> {
		const sessionOk = await reportSession(currentSessionSource);
		const stateOk = await publishState(true);
		const metaOk = metadataEnabled ? await reportMetadata() : true;
		const ok = sessionOk && stateOk && metaOk;
		healthy = ok;
		return ok;
	}

	// ------------------------------------------------------------------
	// State machine: blocked > retry-hold/working > idle, debounced idle.
	// ------------------------------------------------------------------
	let runtimeOff = false;
	let blockedCount = 0;
	let blockedMessage = "";
	let retryPending = 0;
	let agentActive = false;
	let idleTimer: NodeJS.Timeout | undefined;
	let lastDelivered: { state: AgentState; message: string } | undefined;
	let desired: { state: AgentState; message: string } = { state: "idle", message: "" };

	function recomputeDesired(): void {
		if (blockedCount > 0) {
			desired = { state: "blocked", message: blockedMessage };
		} else if (retryPending > 0 || agentActive) {
			desired = { state: "working", message: "" };
		} else {
			desired = { state: "idle", message: "" };
		}
	}

	function clearIdleTimer(): void {
		if (idleTimer) {
			clearTimeout(idleTimer);
			idleTimer = undefined;
		}
	}

	function scheduleIdle(): void {
		clearIdleTimer();
		idleTimer = setTimeout(() => {
			idleTimer = undefined;
			recomputeDesired();
			void publishState();
		}, idleDebounceMs);
	}

	async function publishState(force = false): Promise<boolean> {
		if (runtimeOff) return true;
		const { state, message } = desired;
		if (!force && lastDelivered && lastDelivered.state === state && lastDelivered.message === message && healthy) {
			return true;
		}
		const params: Record<string, unknown> = {
			pane_id: paneId,
			source: SOURCE,
			agent: AGENT,
			state,
			seq: nextSeq(),
		};
		if (message) params.message = message;
		const sessionRef = sessionReference();
		if (sessionRef) Object.assign(params, sessionRef, resumeArgv(sessionRef));
		const ok = await enqueue("pane.report_agent", params);
		if (ok) lastDelivered = { state, message };
		return ok;
	}

	function transition(): void {
		recomputeDesired();
		if (desired.state !== "idle") clearIdleTimer();
		void publishState();
	}

	// ------------------------------------------------------------------
	// Session identity + metadata.
	// ------------------------------------------------------------------
	let currentSessionSource = "startup";

	function sessionReference(): { agent_session_id?: string; agent_session_path?: string } {
		const ref: { agent_session_id?: string; agent_session_path?: string } = {};
		const sm = activeSessionManager;
		try {
			const file = sm?.getSessionFile?.();
			if (file) ref.agent_session_path = file;
			const id = sm?.getSessionId?.();
			if (id) ref.agent_session_id = id;
		} catch {
			/* session not ready yet */
		}
		return ref;
	}

	function resumeArgv(ref: { agent_session_path?: string; agent_session_id?: string }): { resume_argv?: string[] } {
		const target = ref.agent_session_path ?? ref.agent_session_id;
		if (!target) return {};
		return { resume_argv: ["ompg", `--resume=${target}`] };
	}

	async function reportSession(source: string): Promise<boolean> {
		if (runtimeOff) return true;
		const ref = sessionReference();
		// The official integration skips the report entirely without an
		// identity; registering a session with no path/id carries no value.
		if (!ref.agent_session_path && !ref.agent_session_id) return true;
		const params: Record<string, unknown> = {
			pane_id: paneId,
			source: SOURCE,
			agent: AGENT,
			seq: nextSeq(),
			session_start_source: source,
		};
		Object.assign(params, ref, resumeArgv(ref));
		return enqueue("pane.report_agent_session", params);
	}

	function formatTokens(n: number): string {
		if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`;
		if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
		return String(n);
	}

	async function reportMetadata(): Promise<boolean> {
		if (runtimeOff || !metadataEnabled) return true;
		const revision = ++metadataRevision;
		const context = activeCtx;
		const model = activeModel;
		const tokens: Record<string, string | null> = { model: null, thinking: null, context: null };
		try {
			if (model?.id) tokens.model = model.id;
		} catch {
			/* model unavailable */
		}
		try {
			const level = await pi.getThinkingLevel?.();
			if (level) tokens.thinking = String(level);
		} catch {
			/* thinking level unavailable */
		}
		try {
			const usage = context?.getContextUsage?.();
			const used = usage?.contextTokens ?? usage?.usedTokens ?? usage?.tokens;
			const window = usage?.contextWindow ?? usage?.windowTokens;
			if (typeof used === "number" && typeof window === "number" && window > 0) {
				tokens.context = `${formatTokens(used)}/${formatTokens(window)} (${Math.round((used / window) * 100)}%)`;
			}
		} catch {
			/* usage unavailable */
		}
		if (stopped || runtimeOff || revision !== metadataRevision) return true;
		if (Object.keys(tokens).length === 0 && !displayName) return true;
		const params: Record<string, unknown> = {
			pane_id: paneId,
			source: SOURCE,
			seq: nextSeq(),
			agent: AGENT,
		};
		if (displayName) params.display_agent = displayName;
		if (Object.keys(tokens).length > 0) params.tokens = tokens;
		return enqueue("pane.report_metadata", params);
	}

	// ------------------------------------------------------------------
	// Activation: only the pane's root interactive session reports.
	// ------------------------------------------------------------------
	let activeSessionManager: BridgeContext["sessionManager"] | undefined;
	let activeModel: BridgeContext["model"] | undefined;
	let activeCtx: BridgeContext | undefined;
	let activated = false;

	function activate(ctx: BridgeContext): void {
		if (stopped || activated || runtimeOff) return;
		if (!force && ctx.hasUI !== true) return;
		if (ctx.agent?.kind && ctx.agent.kind !== "main") return;
		activated = true;
		activeCtx = ctx;
		activeSessionManager = ctx.sessionManager;
		activeModel = ctx.model;
		log.info(`herdr-ompg-bridge: active on pane ${paneId}`);
		// Resend state after a hot reload of this extension (isIdle reflects
		// a live agent between turns; a fresh session is idle anyway).
		if (ctx.isIdle?.() === false) agentActive = true;
		recomputeDesired();
		void reportSession(currentSessionSource)
			.then(() => publishState(true))
			.then(() => reportMetadata());
		// Heartbeat: herdr's agent state decays without periodic re-assertion,
		// and a herdr restart mid-task would otherwise never be noticed (no
		// transitions → no sends → no failures detected).
		if (heartbeatMs > 0) {
			heartbeatTimer = setInterval(() => {
				if (runtimeOff) return;
				if (!healthy) {
					scheduleResync();
					return;
				}
				void fullResync();
			}, heartbeatMs);
		}
	}

	// ------------------------------------------------------------------
	// Event wiring.
	// ------------------------------------------------------------------
	pi.on("session_start", (_event, ctx) => {
		metadataRevision++;
		currentSessionSource = "startup";
		const ctxB = ctx as unknown as BridgeContext;
		if (!activated) {
			activate(ctxB);
			return;
		}
		// Already active (e.g. /new inside the same process): re-register,
		// matching the official integration's unconditional reportSession.
		activeCtx = ctxB;
		activeSessionManager = ctxB.sessionManager;
		activeModel = ctxB.model;
		blockedCount = 0;
		blockedMessage = "";
		retryPending = 0;
		agentActive = ctxB.isIdle?.() === false;
		clearIdleTimer();
		transition();
		void reportSession(currentSessionSource).then(() => reportMetadata());
	});

	pi.on("session_switch", (event, ctx) => {
		metadataRevision++;
		const ctxB = ctx as unknown as BridgeContext;
		activate(ctxB);
		if (!activated) return;
		currentSessionSource = (event as { reason?: string })?.reason ?? "switch";
		activeCtx = ctxB;
		activeSessionManager = ctxB.sessionManager;
		activeModel = ctxB.model;
		blockedCount = 0;
		blockedMessage = "";
		retryPending = 0;
		agentActive = ctxB.isIdle?.() === false;
		transition();
		void reportSession(currentSessionSource).then(() => reportMetadata());
	});

	pi.on("agent_start", (_event, ctx) => {
		if (!activated) activate(ctx as unknown as BridgeContext);
		if (!activated) return;
		// Re-register the session every turn like the official integration:
		// herdr's agent tracking decays without periodic re-assertion.
		activeCtx = ctx as unknown as BridgeContext;
		activeSessionManager = activeCtx.sessionManager ?? activeSessionManager;
		void reportSession(currentSessionSource);
		agentActive = true;
		clearIdleTimer();
		transition();
	});

	pi.on("agent_end", (event, ctx) => {
		if (!activated) return;
		const willContinue = (event as { willContinue?: boolean })?.willContinue === true;
		if (willContinue) return;
		activeCtx = ctx as unknown as BridgeContext;
		agentActive = false;
		activeModel = (ctx as unknown as BridgeContext).model ?? activeModel;
		// An auto-retry scheduled by OMP keeps the agent working; the
		// auto_retry_start event below maintains that, no guessing needed.
		void reportMetadata();
		scheduleIdle();
	});

	pi.on("auto_retry_start", () => {
		if (!activated) return;
		retryPending++;
		transition();
	});

	pi.on("auto_retry_end", () => {
		if (!activated) return;
		retryPending = Math.max(0, retryPending - 1);
		if (retryPending === 0 && !agentActive) scheduleIdle();
		else transition();
	});

	// Cross-extension channel: other omp extensions can signal blocked state
	// (same contract as the official integration).
	try {
		pi.events?.on?.("herdr:blocked", (data: { active?: boolean; label?: string }) => {
			if (!activated) return;
			if (data?.active === false) {
				blockedCount = Math.max(0, blockedCount - 1);
				if (blockedCount === 0) blockedMessage = "";
			} else {
				blockedCount++;
				if (data?.label) blockedMessage = data.label;
			}
			transition();
		});
	} catch {
		/* event bus unavailable */
	}

	pi.on("tool_approval_requested", event => {
		if (!activated) return;
		blockedCount++;
		const e = event as { reason?: string; label?: string; toolName?: string };
		const label = e?.reason ?? e?.label ?? (e?.toolName ? `${e.toolName} approval` : "Tool approval");
		if (blockedCount === 1 || !blockedMessage) blockedMessage = label;
		transition();
	});

	pi.on("tool_approval_resolved", () => {
		if (!activated) return;
		blockedCount = Math.max(0, blockedCount - 1);
		if (blockedCount === 0) blockedMessage = "";
		transition();
	});

	pi.on("tool_execution_start", event => {
		if (!activated) return;
		const e = event as { toolName?: string; args?: { questions?: { question?: string }[]; question?: string } };
		if (e?.toolName !== "ask") return;
		blockedCount++;
		const question =
			e.args?.questions?.find(q => typeof q?.question === "string")?.question ?? e.args?.question ?? "";
		if (blockedCount === 1 || !blockedMessage) blockedMessage = question || "waiting for user input";
		transition();
	});

	pi.on("tool_execution_end", event => {
		if (!activated) return;
		if ((event as { toolName?: string })?.toolName !== "ask") return;
		blockedCount = Math.max(0, blockedCount - 1);
		if (blockedCount === 0) blockedMessage = "";
		transition();
	});

	pi.on("session_shutdown", () => {
		stopped = true;
		runtimeOff = true;
		activated = false;
		metadataRevision++;
		for (const socket of inFlight) socket.destroy();
		clearIdleTimer();
		if (resyncTimer) {
			clearTimeout(resyncTimer);
			resyncTimer = undefined;
		}
		if (heartbeatTimer) {
			clearInterval(heartbeatTimer);
			heartbeatTimer = undefined;
		}
		blockedCount = 0;
		retryPending = 0;
		agentActive = false;
		desired = { state: "idle", message: "" };
		// The official integration sends nothing on shutdown; a report against
		// a pane being closed only produces a server-side error log line.
	});

	// ------------------------------------------------------------------
	// /herdr command: status | test | on | off
	// ------------------------------------------------------------------
	try {
		pi.registerCommand("herdr", {
			description: "herdr bridge: status/test/on/off",
			handler: async (args, ctx) => {
				if (stopped) return;
				const ui = (ctx as unknown as BridgeContext).ui;
				const notify = (msg: string) => {
					if (ui?.notify) ui.notify(msg, "info");
					else log.info(msg);
				};
				const sub = (args ?? "").trim().split(/\s+/)[0] ?? "";
				if (sub === "off") {
					runtimeOff = true;
					notify("herdr bridge: disabled for this session");
					return;
				}
				if (sub === "on") {
					runtimeOff = false;
					transition();
					notify("herdr bridge: enabled");
					return;
				}
				if (sub === "test") {
					blockedCount++;
					blockedMessage = "herdr bridge test";
					transition();
					notify("herdr bridge: test blocked state sent; reverting in 3s");
					setTimeout(() => {
						blockedCount = Math.max(0, blockedCount - 1);
						if (blockedCount === 0) blockedMessage = "";
						transition();
					}, 3000);
					return;
				}
				const lines = [
					`enabled env: ${enabled} (force=${force})`,
					`activated: ${activated}${runtimeOff ? " (runtime off)" : ""}`,
					`pane: ${paneId}  endpoint: ${endpoint}`,
					`healthy: ${healthy}  seq: ${reportSeq}`,
					`state: ${desired.state}${desired.message ? ` (${desired.message})` : ""}`,
					`delivered: ${lastDelivered ? `${lastDelivered.state}${lastDelivered.message ? ` (${lastDelivered.message})` : ""}` : "never"}`,
					`last error: ${lastError || "none"}`,
					`metadata: ${metadataEnabled ? "on" : "off"}  display: ${displayName || "(default)"}  heartbeat: ${heartbeatMs || "off"}ms`,
				];
				notify(lines.join("\n"));
			},
		});
	} catch (error) {
		log.warn(`herdr-ompg-bridge: /herdr command unavailable: ${String(error)}`);
	}
}
