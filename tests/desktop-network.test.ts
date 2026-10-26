import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import http from "node:http";
import net, { type Socket } from "node:net";
import { createRequire } from "node:module";
import { test } from "node:test";
import { promisify } from "node:util";

const require = createRequire(import.meta.url);
const { configureDesktopNetwork, desktopNetworkEnvironment } = require("../electron/network-proxy.cjs");
const run = promisify(execFile);

async function listen(server: http.Server) {
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const { port } = server.address() as net.AddressInfo;
	return { port, url: `http://127.0.0.1:${port}` };
}

async function networkFixture() {
	const sockets = new Set<Socket>();
	const target = http.createServer((req, res) => {
		res.setHeader("Content-Type", "application/json");
		res.end(JSON.stringify({ path: req.url, authorization: req.headers.authorization ?? null }));
	});
	const direct = await listen(target);
	const routes: string[] = [];
	const proxy = http.createServer((req, res) => {
		routes.push(req.url!);
		res.setHeader("Content-Type", "application/json");
		res.end(JSON.stringify({ path: new URL(req.url!).pathname, authorization: req.headers.authorization ?? null }));
	});
	proxy.on("connect", (req, socket, head) => {
		routes.push(req.url!);
		if (req.url!.endsWith(":443")) { socket.end("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n"); return; }
		const upstream = net.connect(direct.port, "127.0.0.1", () => {
			socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
			if (head.length) upstream.write(head);
			socket.pipe(upstream).pipe(socket);
		});
		sockets.add(upstream);
		upstream.on("error", () => socket.destroy());
		socket.on("error", () => upstream.destroy());
	});
	for (const server of [proxy, target]) server.on("connection", (socket) => sockets.add(socket));
	const endpoint = await listen(proxy);
	return { direct, endpoint, routes, close() {
		for (const socket of sockets) socket.destroy();
		proxy.close(); target.close();
	} };
}

test("desktop OAuth/model fetch uses the configured proxy, overrides inherited bypasses, and keeps private loopback traffic local", async () => {
	const f = await networkFixture();
	const restore = configureDesktopNetwork({ proxyUrl: f.endpoint.url });
	try {
		const response = await fetch("http://openai-route.example.invalid/oauth", { headers: { authorization: "Bearer artificial-test-token" }, signal: AbortSignal.timeout(3000) });
		assert.deepEqual(await response.json(), { path: "/oauth", authorization: "Bearer artificial-test-token" });
		assert.equal(f.routes.length, 1);
		assert.match(f.routes[0]!, /openai-route\.example\.invalid/);
		const local = await fetch(`${f.direct.url}/private`, { headers: { authorization: "Bearer artificial-desktop-capability" } });
		assert.equal((await local.json()).authorization, "Bearer artificial-desktop-capability");
		assert.equal(f.routes.length, 1, "the desktop capability must never reach the outbound proxy");
		await assert.rejects(fetch("https://auth.example.invalid/token", { signal: AbortSignal.timeout(3000) }));
		assert(f.routes.includes("auth.example.invalid:443"), "HTTPS must use a proxy CONNECT tunnel too");
	} finally { restore(); f.close(); }
});

test("the embedded server inherits the same required route even when the launching shell has conflicting proxies and NO_PROXY=*", async () => {
	const f = await networkFixture();
	try {
		const env = desktopNetworkEnvironment({ ...process.env, ELECTRON_RUN_AS_NODE: "1", HTTP_PROXY: "http://127.0.0.1:1", https_proxy: "http://127.0.0.1:1", NO_PROXY: "*", no_proxy: "*" }, { proxyUrl: f.endpoint.url });
		const script = `Promise.all([fetch('http://model-route.example.invalid/responses').then(r => r.json()), fetch(${JSON.stringify(`${f.direct.url}/health`)}).then(r => r.json())]).then(values => console.log(JSON.stringify(values))).catch(() => process.exit(1));`;
		const { stdout } = await run(process.execPath, ["-e", script], { env, timeout: 5000 });
		assert.deepEqual(JSON.parse(stdout), [{ path: "/responses", authorization: null }, { path: "/health", authorization: null }]);
		assert.equal(f.routes.length, 1);
		assert.match(f.routes[0]!, /model-route\.example\.invalid/);
	} finally { f.close(); }
});

test("an unavailable or invalid configured proxy fails without using ambient proxy settings or a direct route", async () => {
	const server = http.createServer();
	const endpoint = await listen(server);
	await new Promise<void>((resolve) => server.close(() => resolve()));
	const restore = configureDesktopNetwork({ proxyUrl: endpoint.url });
	try { await assert.rejects(fetch("https://auth.example.invalid/token", { signal: AbortSignal.timeout(3000) }), (error: any) => error.cause?.code === "ECONNREFUSED"); }
	finally { restore(); }
	for (const proxyUrl of ["", "socks5://127.0.0.1:7891", "http://127.0.0.1/proxy", "http://127.0.0.1/#secret"]) {
		assert.throws(() => desktopNetworkEnvironment({}, { proxyUrl }), /Direct connections are disabled/);
	}
});
