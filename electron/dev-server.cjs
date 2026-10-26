"use strict";
const { fork } = require("node:child_process");
const path = require("node:path");

const privatePacket = (packet) => packet && ["lh:chatgpt", "lh:subscriptions"].includes(packet.channel);
const send = (endpoint, packet) => {
	if (!endpoint?.connected) return;
	try { endpoint.send(packet, () => {}); } catch { /* process exited */ }
};

/** Supervise the actual Next request worker and relay only our inherited private
 * IPC channels. The stock Next CLI drops these packets between its two processes. */
function startDevServer({ parent = process, launch = fork, restartExitCode = require("next/dist/server/lib/utils").RESTART_EXIT_CODE } = {}) {
	const port = Number(parent.env.PORT);
	if (parent.env.LH_DESKTOP_SERVER !== "1" || (parent.env.LH_DESKTOP_API_SECRET?.length ?? 0) < 64 || !parent.connected || typeof parent.send !== "function" || !Number.isInteger(port) || port < 1 || port > 65535) {
		throw new Error("The development server requires an owned desktop IPC connection and a valid loopback port.");
	}
	let worker;
	let stopping = false;
	let shutdownTimer;
	function boot() {
		const current = launch(path.join(__dirname, "dev-worker.cjs"), [], {
			cwd: parent.cwd(), execPath: parent.execPath, execArgv: [],
			stdio: ["ignore", "inherit", "inherit", "ipc"],
			env: { ...parent.env, NEXT_PRIVATE_WORKER: "1", __NEXT_DEV_SERVER: "1", TURBOPACK: parent.env.TURBOPACK ?? "1", ...(parent.platform === "darwin" ? { WATCHPACK_WATCHER_LIMIT: "20" } : {}) },
		});
		worker = current;
		let initialized = false;
		current.on("message", (packet) => {
			if (current !== worker || stopping) return;
			if (packet?.nextWorkerReady === true && !initialized) {
				initialized = true;
				send(current, { nextWorkerOptions: { dir: parent.cwd(), port, hostname: "127.0.0.1", isDev: true, allowRetry: false } });
			} else if (privatePacket(packet)) send(parent, packet);
		});
		current.once("error", () => { stopping = true; parent.exit(1); });
		current.once("exit", (code) => {
			if (current !== worker) return;
			clearTimeout(shutdownTimer);
			worker = undefined;
			if (stopping) parent.exit(0);
			else if (code === restartExitCode) boot();
			else parent.exit(code ?? 1);
		});
	}
	function stop() {
		if (stopping) return;
		stopping = true;
		if (!worker) { parent.exit(0); return; }
		worker.kill("SIGTERM");
		shutdownTimer = setTimeout(() => { worker?.kill("SIGKILL"); parent.exit(0); }, 2000);
		shutdownTimer.unref();
	}
	parent.on("message", (packet) => { if (!stopping && privatePacket(packet)) send(worker, packet); });
	parent.once("disconnect", stop);
	parent.once("SIGTERM", stop);
	parent.once("SIGINT", stop);
	boot();
}

if (require.main === module) startDevServer();
module.exports = { startDevServer };
