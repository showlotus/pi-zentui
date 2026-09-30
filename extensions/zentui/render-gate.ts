import { readdirSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

const ZENTUI_RENDER_GATE = Symbol.for("pi-zentui.render-gate");
const ZENTUI_HELD_AT = Symbol.for("pi-zentui.render-gate.held-at");
const HOLD_TIMEOUT_MS = 2000;
const STARTUP_TIMEOUT_MS = 3000;
const HOLD_REASONS = new Set(["new", "fork", "resume"]);

type TuiLike = {
	stopped: boolean;
	requestRender: (force?: boolean) => void;
};

export type RenderGateState = {
	tui: TuiLike | undefined;
	bootstrapped: boolean;
	timer: ReturnType<typeof setTimeout> | undefined;
};

type PatchPrototype = Record<PropertyKey, unknown>;

const debugLog = (message: string) => {
	if (process.env.ZENTUI_DEBUG === "1") {
		console.error(`[zentui] Render gate: ${message}`);
	}
};

const isTuiLike = (candidate: unknown): candidate is TuiLike =>
	typeof candidate === "object" &&
	candidate !== null &&
	typeof (candidate as TuiLike).stopped === "boolean" &&
	typeof (candidate as TuiLike).requestRender === "function";

const readHeldAt = (tui: TuiLike): number | undefined => {
	const value = (tui as PatchPrototype)[ZENTUI_HELD_AT];
	return typeof value === "number" ? value : undefined;
};

function readGateState(host: object): RenderGateState | undefined {
	const value = (host as PatchPrototype)[ZENTUI_RENDER_GATE];
	return value &&
		typeof value === "object" &&
		typeof (value as RenderGateState).bootstrapped === "boolean"
		? (value as RenderGateState)
		: undefined;
}

export async function resolveTuiPrototypes(): Promise<object[]> {
	try {
		const entrypoint = process.argv[1];
		if (!entrypoint) return [];
		const chunksDir = join(dirname(realpathSync(entrypoint)), "chunks");
		for (const entry of readdirSync(chunksDir)) {
			if (!entry.endsWith(".js")) continue;
			const filePath = join(chunksDir, entry);
			try {
				if (!readFileSync(filePath, "utf8").includes("TuiAltScreen=class")) continue;
			} catch {
				continue;
			}
			const module = (await import(pathToFileURL(filePath).href)) as {
				TuiAltScreen?: { prototype?: object };
				TuiMainScreen?: { prototype?: object };
			};
			const prototypes = [module.TuiAltScreen?.prototype, module.TuiMainScreen?.prototype].filter(
				(prototype): prototype is object => {
					const descriptor = prototype && Object.getOwnPropertyDescriptor(prototype, "doRender");
					return typeof descriptor?.value === "function";
				},
			);
			if (prototypes.length > 0) return prototypes;
		}
		return [];
	} catch {
		return [];
	}
}

export function attachRenderGate(
	prototypes: object[],
	state: RenderGateState,
	holdForStartup: (tui: TuiLike) => void,
): boolean {
	let installed = false;
	for (const prototype of prototypes) {
		const descriptor = Object.getOwnPropertyDescriptor(prototype, "doRender");
		if (typeof descriptor?.value !== "function" || descriptor.configurable === false) continue;
		if (readGateState(descriptor.value as object)) {
			debugLog("prototype reused");
			installed = true;
			continue;
		}
		const predecessor = descriptor.value;
		const wrapper = function zentuiRenderGate(this: unknown, ...args: unknown[]) {
			if (!state.bootstrapped) {
				state.bootstrapped = true;
				debugLog("bootstrap: captured first render");
				if (isTuiLike(this)) holdForStartup(this);
				return undefined;
			}
			return Reflect.apply(predecessor, this, args);
		};
		try {
			Object.defineProperty(prototype, "doRender", { ...descriptor, value: wrapper });
			Object.defineProperty(wrapper, ZENTUI_RENDER_GATE, {
				value: state,
				configurable: true,
				enumerable: false,
			});
			installed = true;
		} catch {
			// Locked prototypes are skipped; remaining candidates still install.
		}
	}
	return installed;
}

export type RenderGateController = {
	ensureInstalled: () => void;
	bindTui: (candidate: unknown) => void;
	hold: (reason: string) => void;
	release: () => void;
};

export function createRenderGateController(): RenderGateController {
	const state: RenderGateState = {
		tui: undefined,
		bootstrapped: false,
		timer: undefined,
	};
	let installStarted = false;

	const bindTui = (candidate: unknown) => {
		if (isTuiLike(candidate)) state.tui = candidate;
	};

	const armTimeout = (timeoutMs: number) => {
		if (state.timer) clearTimeout(state.timer);
		const timer = setTimeout(() => {
			state.timer = undefined;
			if (state.tui?.stopped) debugLog("hold timeout");
			release();
		}, timeoutMs);
		timer.unref();
		state.timer = timer;
	};

	const holdFor = (reason: string, timeoutMs: number) => {
		const current = state.tui;
		if (!current) return;
		current.stopped = true;
		(current as PatchPrototype)[ZENTUI_HELD_AT] = performance.now();
		armTimeout(timeoutMs);
		debugLog(`hold: reason=${reason}`);
	};

	const hold = (reason: string) => {
		if (!HOLD_REASONS.has(reason)) return;
		holdFor(reason, HOLD_TIMEOUT_MS);
	};

	const release = () => {
		state.bootstrapped = true;
		const current = state.tui;
		if (!current?.stopped) return;
		const heldAt = readHeldAt(current);
		if (heldAt === undefined) return;
		current.stopped = false;
		(current as PatchPrototype)[ZENTUI_HELD_AT] = undefined;
		if (state.timer) {
			clearTimeout(state.timer);
			state.timer = undefined;
		}
		debugLog(`release: heldForMs=${Math.round(performance.now() - heldAt)}`);
		try {
			current.requestRender(true);
		} catch {
			// Repaint is best effort; the session-start refresh also repaints.
		}
	};

	const ensureInstalled = () => {
		if (installStarted) return;
		installStarted = true;
		void (async () => {
			const attached = attachRenderGate(await resolveTuiPrototypes(), state, (tui) => {
				if (!state.tui) bindTui(tui);
				holdFor("startup", STARTUP_TIMEOUT_MS);
			});
			debugLog(attached ? "installed" : "unavailable");
		})();
	};

	return { ensureInstalled, bindTui, hold, release };
}
