import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, sep } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	attachRenderGate,
	createRenderGateController,
	type RenderGateState,
	resolveTuiPrototypes,
} from "../extensions/zentui/render-gate";

type DoRenderHost = {
	doRender: (...args: unknown[]) => unknown;
};

type TuiHost = {
	stopped: boolean;
	requestRender: ReturnType<typeof vi.fn>;
};

function makeState(): RenderGateState {
	return { tui: undefined, bootstrapped: false, timer: undefined };
}

function makePrototype(rendered: unknown[] = ["frame"]) {
	const calls: unknown[][] = [];
	const prototype = {
		doRender(...args: unknown[]) {
			calls.push(args);
			return rendered;
		},
	};
	return { prototype: prototype as unknown as object, calls };
}

function makeTui(): TuiHost {
	return { stopped: false, requestRender: vi.fn(() => true) };
}

const fixtures: string[] = [];
let originalArgv: PropertyDescriptor | undefined;

function writeHostFixture(withChunks = true, withMarker = true): string {
	const dir = mkdtempSync(join(tmpdir(), "zentui-gate-host-"));
	fixtures.push(dir);
	const bundleDir = join(dir, "dist", "bundle");
	mkdirSync(join(bundleDir, "chunks"), { recursive: true });
	writeFileSync(join(bundleDir, "cli.js"), "export default null;\n");
	const marker = withMarker ? "// TuiAltScreen=class\n" : "";
	writeFileSync(
		join(bundleDir, "chunks", "chunk-test.js"),
		`${marker}export class TuiAltScreen {
	stopped = false;
	doRender() {
		return ["alt"];
	}
	requestRender(force) {
		return force === true;
	}
}
export class TuiMainScreen {
	stopped = false;
	doRender() {
		return ["main"];
	}
	requestRender(force) {
		return force === true;
	}
}
`,
	);
	if (!withChunks) {
		rmSync(join(bundleDir, "chunks"), { recursive: true, force: true });
	}
	return join(bundleDir, "cli.js");
}

function mockEntrypoint(entry: string) {
	originalArgv ??= Object.getOwnPropertyDescriptor(process, "argv");
	Object.defineProperty(process, "argv", {
		value: [process.argv[0] ?? "node", entry],
		configurable: true,
	});
}

afterEach(() => {
	if (originalArgv) {
		Object.defineProperty(process, "argv", originalArgv);
		originalArgv = undefined;
	}
	for (const dir of fixtures.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

describe("render gate attach layer", () => {
	it("hijacks the first render, holds the TUI, then passes through forever", () => {
		const state = makeState();
		const holdForStartup = vi.fn();
		const { prototype, calls } = makePrototype();
		expect(attachRenderGate([prototype], state, holdForStartup)).toBe(true);
		const tui = makeTui();
		expect((prototype as unknown as DoRenderHost).doRender.call(tui)).toBeUndefined();
		expect(calls).toHaveLength(0);
		expect(state.bootstrapped).toBe(true);
		expect(holdForStartup).toHaveBeenCalledTimes(1);
		expect(holdForStartup).toHaveBeenCalledWith(tui);
		expect((prototype as unknown as DoRenderHost).doRender.call(tui)).toEqual(["frame"]);
		expect(calls).toHaveLength(1);
	});

	it("skips the startup hold when the receiver is not a TUI", () => {
		const state = makeState();
		const holdForStartup = vi.fn();
		const { prototype } = makePrototype();
		attachRenderGate([prototype], state, holdForStartup);
		expect((prototype as unknown as DoRenderHost).doRender.call({})).toBeUndefined();
		expect(state.bootstrapped).toBe(true);
		expect(holdForStartup).not.toHaveBeenCalled();
		expect((prototype as unknown as DoRenderHost).doRender.call({})).toEqual(["frame"]);
	});

	it("reuses an installed wrapper and reports it as available", () => {
		const state = makeState();
		const holdForStartup = vi.fn();
		const { prototype } = makePrototype();
		attachRenderGate([prototype], state, holdForStartup);
		const wrapper = (prototype as unknown as DoRenderHost).doRender;
		const secondState = makeState();
		expect(attachRenderGate([prototype], secondState, holdForStartup)).toBe(true);
		expect((prototype as unknown as DoRenderHost).doRender).toBe(wrapper);
	});

	it("returns false for unusable prototypes", () => {
		const state = makeState();
		const holdForStartup = vi.fn();
		expect(attachRenderGate([], state, holdForStartup)).toBe(false);
		expect(attachRenderGate([{}], state, holdForStartup)).toBe(false);
		const locked: Record<PropertyKey, unknown> = {};
		Object.defineProperty(locked, "doRender", {
			value: () => undefined,
			configurable: false,
		});
		expect(attachRenderGate([locked], state, holdForStartup)).toBe(false);
	});
});

describe("render gate controller", () => {
	it("holds only for replacement reasons", () => {
		const controller = createRenderGateController();
		const tui = makeTui();
		controller.bindTui(tui);
		controller.hold("quit");
		expect(tui.stopped).toBe(false);
		controller.hold("new");
		expect(tui.stopped).toBe(true);
	});

	it("releases the hold and repaints with force", () => {
		const controller = createRenderGateController();
		const tui = makeTui();
		controller.bindTui(tui);
		controller.hold("fork");
		controller.release();
		expect(tui.stopped).toBe(false);
		expect(tui.requestRender).toHaveBeenCalledWith(true);
	});

	it("ignores release when nothing is held", () => {
		const controller = createRenderGateController();
		const tui = makeTui();
		controller.bindTui(tui);
		controller.release();
		expect(tui.requestRender).not.toHaveBeenCalled();
	});

	it("does nothing without a bound TUI", () => {
		const controller = createRenderGateController();
		controller.bindTui({});
		controller.hold("new");
		controller.release();
	});

	it("follows the latest bound TUI instance", () => {
		const controller = createRenderGateController();
		const first = makeTui();
		controller.bindTui(first);
		const second = makeTui();
		controller.bindTui(second);
		controller.hold("resume");
		expect(second.stopped).toBe(true);
		expect(first.stopped).toBe(false);
	});

	it("releases a hold created by another controller on the same TUI", () => {
		const first = createRenderGateController();
		const tui = makeTui();
		first.bindTui(tui);
		first.hold("new");
		const second = createRenderGateController();
		second.bindTui(tui);
		second.release();
		expect(tui.stopped).toBe(false);
		expect(tui.requestRender).toHaveBeenCalledWith(true);
	});

	it("does not wake a TUI the host stopped on its own", () => {
		const controller = createRenderGateController();
		const tui = makeTui();
		controller.bindTui(tui);
		tui.stopped = true;
		controller.release();
		expect(tui.stopped).toBe(true);
		expect(tui.requestRender).not.toHaveBeenCalled();
	});

	it("clears the held-at marker through a proxy without a deleteProperty trap", () => {
		const controller = createRenderGateController();
		const renderer: TuiHost = { stopped: false, requestRender: vi.fn(() => true) };
		const proxy = new Proxy({} as object, {
			get: (_target, property) =>
				Reflect.get(renderer as unknown as Record<PropertyKey, unknown>, property),
			set: (_target, property, value) =>
				Reflect.set(renderer as unknown as Record<PropertyKey, unknown>, property, value),
		});
		controller.bindTui(proxy);
		controller.hold("new");
		controller.release();
		expect(renderer.stopped).toBe(false);
		expect(
			(renderer as unknown as Record<PropertyKey, unknown>)[
				Symbol.for("pi-zentui.render-gate.held-at")
			],
		).toBeUndefined();
	});

	it("releases automatically when the hold times out", async () => {
		const controller = createRenderGateController();
		const tui = makeTui();
		controller.bindTui(tui);
		controller.hold("new");
		await new Promise((resolve) => setTimeout(resolve, 2100));
		expect(tui.stopped).toBe(false);
		expect(tui.requestRender).toHaveBeenCalledWith(true);
	}, 10_000);
});

describe("render gate bootstrap integration", () => {
	function receiverFor(prototype: object): TuiHost & DoRenderHost {
		const receiver = Object.create(prototype) as TuiHost & DoRenderHost;
		receiver.stopped = false;
		receiver.requestRender = vi.fn(() => true);
		return receiver;
	}

	const renderVia = (prototype: object, receiver: object) =>
		(prototype as unknown as DoRenderHost).doRender.call(receiver);

	it("bootstraps from the first frame and releases through the controller", async () => {
		mockEntrypoint(writeHostFixture());
		const controller = createRenderGateController();
		controller.ensureInstalled();
		const [prototype] = await resolveTuiPrototypes();
		let hijacked: TuiHost | undefined;
		await vi.waitFor(() => {
			hijacked = receiverFor(prototype);
			expect(renderVia(prototype, hijacked)).toBeUndefined();
		});
		const later = receiverFor(prototype);
		expect(renderVia(prototype, later)).toEqual(["alt"]);
		expect(hijacked?.stopped).toBe(true);
		controller.release();
		expect(hijacked?.stopped).toBe(false);
		expect(hijacked?.requestRender).toHaveBeenCalledWith(true);
	});

	it("keeps doRender passthrough while held, like renderNow would", async () => {
		mockEntrypoint(writeHostFixture());
		const controller = createRenderGateController();
		controller.ensureInstalled();
		const [prototype] = await resolveTuiPrototypes();
		await vi.waitFor(() => {
			const receiver = receiverFor(prototype);
			expect(renderVia(prototype, receiver)).toBeUndefined();
		});
		const tui = receiverFor(prototype);
		controller.bindTui(tui);
		controller.hold("new");
		expect(tui.stopped).toBe(true);
		expect(renderVia(prototype, tui)).toEqual(["alt"]);
		controller.release();
		expect(tui.stopped).toBe(false);
	});

	it("suppresses the bootstrap swallow when release already ran", async () => {
		mockEntrypoint(writeHostFixture());
		const controller = createRenderGateController();
		controller.ensureInstalled();
		const [prototype] = await resolveTuiPrototypes();
		const gateStateOf = (host: object) =>
			((host as unknown as DoRenderHost).doRender as unknown as Record<PropertyKey, unknown>)[
				Symbol.for("pi-zentui.render-gate")
			];
		await vi.waitFor(() => {
			expect(gateStateOf(prototype)).toBeDefined();
		});
		controller.release();
		expect((gateStateOf(prototype) as RenderGateState).bootstrapped).toBe(true);
		const late = receiverFor(prototype);
		expect(renderVia(prototype, late)).toEqual(["alt"]);
		expect(late.stopped).toBe(false);
		expect(late.requestRender).not.toHaveBeenCalled();
	});

	it("keeps an existing binding when the startup hold fires", async () => {
		mockEntrypoint(writeHostFixture());
		const controller = createRenderGateController();
		let live: TuiHost = { stopped: false, requestRender: vi.fn(() => true) };
		const proxy = new Proxy({} as object, {
			get: (_target, property) => {
				const value = (live as unknown as Record<PropertyKey, unknown>)[property];
				return typeof value === "function"
					? (...args: unknown[]) => (value as (...fnArgs: unknown[]) => unknown)(...args)
					: value;
			},
			set: (_target, property, value) =>
				Reflect.set(live as unknown as Record<PropertyKey, unknown>, property, value),
		});
		controller.bindTui(proxy);
		controller.ensureInstalled();
		const [prototype] = await resolveTuiPrototypes();
		const first = receiverFor(prototype);
		live = first;
		await vi.waitFor(() => {
			expect(renderVia(prototype, first)).toBeUndefined();
		});
		expect(first.stopped).toBe(true);
		const replacement = makeTui();
		live = replacement;
		controller.hold("new");
		expect(replacement.stopped).toBe(true);
		controller.release();
		expect(replacement.stopped).toBe(false);
		expect(replacement.requestRender).toHaveBeenCalledWith(true);
	});
});

describe("render gate discovery", () => {
	it("locates the marked chunk and returns both TUI prototypes", async () => {
		mockEntrypoint(writeHostFixture());
		const prototypes = await resolveTuiPrototypes();
		expect(prototypes).toHaveLength(2);
		for (const prototype of prototypes) {
			const descriptor = Object.getOwnPropertyDescriptor(prototype, "doRender");
			expect(typeof descriptor?.value).toBe("function");
		}
	});

	it("degrades to an empty list without chunks or markers", async () => {
		mockEntrypoint(writeHostFixture(false));
		expect(await resolveTuiPrototypes()).toEqual([]);
		mockEntrypoint(writeHostFixture(true, false));
		expect(await resolveTuiPrototypes()).toEqual([]);
	});

	it("continues scanning when a marked chunk does not export the classes", async () => {
		const entry = writeHostFixture();
		const chunksDir = join(dirname(entry), "chunks");
		writeFileSync(
			join(chunksDir, "chunk-test.js"),
			"// TuiAltScreen=class\nexport const unrelated = 1;\n",
		);
		writeFileSync(
			join(chunksDir, "chunk-late.js"),
			`// TuiAltScreen=class
export class TuiAltScreen {
	stopped = false;
	doRender() {
		return ["late"];
	}
	requestRender(force) {
		return force === true;
	}
}
export class TuiMainScreen {
	stopped = false;
	doRender() {
		return ["late-main"];
	}
	requestRender(force) {
		return force === true;
	}
}
`,
		);
		mockEntrypoint(entry);
		const prototypes = await resolveTuiPrototypes();
		expect(prototypes).toHaveLength(2);
		for (const prototype of prototypes) {
			const descriptor = Object.getOwnPropertyDescriptor(prototype, "doRender");
			expect(typeof descriptor?.value).toBe("function");
			const receiver = Object.create(prototype) as DoRenderHost;
			expect(Array.isArray(receiver.doRender())).toBe(true);
		}
	});
});

const globalPiEntrypoint = (() => {
	try {
		const candidates = execSync("which -a pi", {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		})
			.trim()
			.split("\n")
			.map((line) => line.trim())
			.filter(Boolean);
		const bin = candidates.find((candidate) => !candidate.includes(`node_modules${sep}.bin`));
		if (!bin) return undefined;
		return realpathSync(bin);
	} catch {
		return undefined;
	}
})();

describe.skipIf(!globalPiEntrypoint)("render gate real host discovery", () => {
	it("discovers TUI prototypes from the globally installed pi", async () => {
		expect(globalPiEntrypoint).toBeDefined();
		mockEntrypoint(globalPiEntrypoint as string);
		const prototypes = await resolveTuiPrototypes();
		expect(prototypes.length).toBeGreaterThan(0);
		for (const prototype of prototypes) {
			const descriptor = Object.getOwnPropertyDescriptor(prototype, "doRender");
			expect(typeof descriptor?.value).toBe("function");
		}
	});
});
