import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const { startDevServer } = require("../electron/dev-server.cjs");

function fixture() {
	const exits: number[] = [], launches: { file: string; args: string[]; options: any; worker: ReturnType<typeof worker> }[] = [];
	function worker() {
		const sent: any[] = [], killed: string[] = [];
		return Object.assign(new EventEmitter(), { connected: true, sent, killed, send: (packet: unknown, callback: () => void) => { sent.push(packet); callback(); }, kill: (signal: string) => { killed.push(signal); } });
	}
	const packets: unknown[] = [];
	const parent = Object.assign(new EventEmitter(), {
		env: { PORT: "54321", LH_DESKTOP_SERVER: "1", LH_DESKTOP_API_SECRET: "d".repeat(64), HTTPS_PROXY: "http://127.0.0.1:7890/", NODE_USE_ENV_PROXY: "1" },
		connected: true, execPath: "/fixture/Electron", platform: "darwin", cwd: () => "/fixture/project",
		send: (packet: unknown, callback: () => void) => { packets.push(packet); callback(); }, exit: (code: number) => exits.push(code),
	});
	const launch = (file: string, args: string[], options: any) => { const child = worker(); launches.push({ file, args, options, worker: child }); return child; };
	return { parent, launch, launches, exits, packets, start: () => startDevServer({ parent, launch, restartExitCode: 77 }) };
}

test("owned development worker gets the private IPC, fixed loopback origin and unchanged required proxy configuration", () => {
	const f = fixture(); f.start();
	const { file, options, worker } = f.launches[0]!;
	assert(file.endsWith("/electron/dev-worker.cjs"));
	assert.deepEqual(options.stdio, ["ignore", "inherit", "inherit", "ipc"]);
	assert.deepEqual(options.execArgv, [], "no inherited test/debug loaders or Node options");
	assert.equal(options.env.HTTPS_PROXY, f.parent.env.HTTPS_PROXY);
	assert.equal(options.env.NODE_USE_ENV_PROXY, "1");
	assert.equal(options.env.LH_DESKTOP_API_SECRET, f.parent.env.LH_DESKTOP_API_SECRET);
	assert.equal(options.env.NEXT_PRIVATE_WORKER, "1");
	worker.emit("message", { nextWorkerReady: true }); worker.emit("message", { nextWorkerReady: true });
	assert.deepEqual(worker.sent, [{ nextWorkerOptions: { dir: "/fixture/project", port: 54321, hostname: "127.0.0.1", isDev: true, allowRetry: false } }]);
});

test("only subscription IPC crosses the relay; Next lifecycle packets and unrelated traffic never reach the other process", () => {
	const f = fixture(); f.start(); const { worker } = f.launches[0]!;
	for (const channel of ["lh:chatgpt", "lh:subscriptions"]) {
		const request = { channel, id: `fixture:${channel}`, op: "models" };
		const response = { channel, id: request.id, ok: true, value: { accessToken: "artificial-private-token" } };
		worker.emit("message", request); f.parent.emit("message", response);
		assert.deepEqual(f.packets.at(-1), request); assert.deepEqual(worker.sent.at(-1), response);
	}
	const count = worker.sent.length;
	for (const packet of [{ nextServerReady: true }, { nextWorkerOptions: { hostname: "0.0.0.0" } }, { channel: "other", data: "ignored" }, null]) {
		worker.emit("message", packet); f.parent.emit("message", packet);
	}
	assert.equal(worker.sent.length, count); assert.equal(f.packets.length, 2);
});

test("Next config/memory restart replaces the worker and fences old packets while preserving the parent connection", () => {
	const f = fixture(); f.start(); const old = f.launches[0]!.worker;
	old.emit("exit", 77); assert.equal(f.launches.length, 2); assert.deepEqual(f.exits, []);
	old.emit("message", { channel: "lh:chatgpt", id: "old" }); assert.deepEqual(f.packets, []);
	const current = f.launches[1]!.worker;
	f.parent.emit("message", { channel: "lh:chatgpt", kind: "state" }); assert.equal(current.sent.length, 1); assert.equal(old.sent.length, 0);
	current.emit("exit", 1); assert.deepEqual(f.exits, [1]);
});

test("parent disconnect stops its owned worker and a normal exit never restarts it", () => {
	const f = fixture(); f.start(); const { worker } = f.launches[0]!;
	f.parent.emit("disconnect"); assert.deepEqual(worker.killed, ["SIGTERM"]);
	worker.emit("exit", 0); assert.deepEqual(f.exits, [0]); assert.equal(f.launches.length, 1);
});

test("missing desktop authority, parent IPC or valid port fails before a child can start", () => {
	for (const override of [{ LH_DESKTOP_SERVER: "" }, { LH_DESKTOP_API_SECRET: "short" }, { PORT: "0" }, { PORT: "70000" }, { PORT: "not-a-port" }]) {
		const f = fixture(); Object.assign(f.parent.env, override);
		assert.throws(f.start, /owned desktop IPC/); assert.deepEqual(f.launches, []);
	}
	const f = fixture(); f.parent.connected = false; assert.throws(f.start, /owned desktop IPC/); assert.deepEqual(f.launches, []);
});
