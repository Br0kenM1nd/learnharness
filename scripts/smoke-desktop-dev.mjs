/** Real Next dev worker + private desktop IPC, using artificial credentials only. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import { createRequire } from "node:module";
import net from "node:net";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

const require = createRequire(import.meta.url);
const ROOT = path.resolve(import.meta.dirname, "..");
const { attachChatGPTChild } = require("../electron/chatgpt-ipc.cjs");
const { attachSubscriptionChild } = require("../electron/subscription-ipc.cjs");
const { desktopNetworkEnvironment } = require("../electron/network-proxy.cjs");
const legacy = process.argv.includes("--legacy-cli");
const fixture = fs.mkdtempSync(path.join(path.dirname(ROOT), ".learnharness-dev-smoke-"));
const capability = randomBytes(32).toString("hex");
const runtime = require("electron");
const socket = net.createServer();
socket.listen(0, "127.0.0.1"); await once(socket, "listening");
const port = socket.address().port;
await new Promise((resolve) => socket.close(resolve));
const url = `http://127.0.0.1:${port}`;
const model = { id: "gpt-6.1-sol", name: "Fixture model", api: "openai-responses", provider: "openai", baseUrl: "https://api.openai.com/v1", reasoning: false, input: ["text"], contextWindow: 8192, maxTokens: 1024, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
const status = { available: true, pending: false, allowBackgroundUse: true, activeId: "fixture-account", accounts: [{ id: "fixture-account", email: "fixture@example.invalid", registration: "oaiapp_fixture", connected: true, planEnabled: true }], error: null };
const stamp = { epoch: 1, authorityRevision: 1, revision: 1 };
let leases = 0, models = 0;
const write = (name, content) => { const target = path.join(fixture, name); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, content); };
write("package.json", JSON.stringify({ name: "learnharness-private-ipc-smoke", private: true, type: "module" }));
write("next.config.mjs", `import base from ${JSON.stringify(path.join(ROOT, "next.config.ts"))}; export default { ...base, turbopack: { root: ${JSON.stringify(path.dirname(ROOT))} } };`);
write("tsconfig.json", JSON.stringify({ compilerOptions: { target: "ES2022", module: "esnext", moduleResolution: "bundler", jsx: "react-jsx", skipLibCheck: true, baseUrl: ".", paths: { "@/*": [path.join(path.relative(fixture, ROOT), "*")] } } }));
fs.symlinkSync(path.join(ROOT, "node_modules"), path.join(fixture, "node_modules"), "dir");
for (const file of ["chatgpt-bridge.ts", "subscription-runtime.ts", "subscription-bridge.ts"]) write(`src/agent/${file}`, fs.readFileSync(path.join(ROOT, "src/agent", file), "utf8"));
write("src/core/contracts/subscriptions.ts", fs.readFileSync(path.join(ROOT, "src/core/contracts/subscriptions.ts"), "utf8"));
write("src/server/desktop-access.ts", fs.readFileSync(path.join(ROOT, "src/server/desktop-access.ts"), "utf8"));
write("proxy.ts", fs.readFileSync(path.join(ROOT, "proxy.ts"), "utf8"));
write("app/api/models/route.ts", `export { GET } from ${JSON.stringify(path.relative(path.join(fixture, "app/api/models"), path.join(ROOT, "app/api/models/route.ts")))};`);
write("app/api/settings/[section]/route.ts", `export { PUT } from ${JSON.stringify(path.relative(path.join(fixture, "app/api/settings/[section]"), path.join(ROOT, "app/api/settings/[section]/route.ts")))};`);
write("app/layout.jsx", "export default function Layout({children}) { return <html><body>{children}</body></html>; }");
write("app/page.jsx", "export default function Page() { return <p>Private desktop IPC fixture</p>; }");
write("app/api/catalog/route.ts", `
import { refreshChatGPTModels, chatGPTModels, chatGPTConnected, chatGPTScope, chatGPTLease } from "../../../src/agent/chatgpt-bridge";
import { refreshSubscriptionModels } from "../../../src/agent/subscription-bridge";
const supported = [${JSON.stringify(model)}];
export async function GET() {
 await Promise.all([refreshChatGPTModels(supported), refreshSubscriptionModels()]);
 return Response.json({ workerPid: process.pid, connected: chatGPTConnected(), models: chatGPTModels().map(model => ({id: model.id, name: model.name, provider: model.provider})) });
}
export async function POST() {
 const lease = await chatGPTLease(chatGPTScope(supported[0].id), false);
 return Response.json({ leased: lease.accountId === "fixture-account" && lease.accessToken === "artificial-private-token" });
}
`);

const args = legacy
	? [path.join(ROOT, "node_modules/next/dist/bin/next"), "dev", "--hostname", "127.0.0.1", "--port", String(port)]
	: [path.join(ROOT, "electron/dev-server.cjs")];
const child = spawn(runtime, args, {
	cwd: fixture, detached: true, stdio: ["ignore", "pipe", "pipe", "ipc"],
	env: { ...desktopNetworkEnvironment(process.env), ELECTRON_RUN_AS_NODE: "1", NODE_ENV: "development", NEXT_TELEMETRY_DISABLED: "1", LH_DESKTOP_SERVER: "1", LH_DESKTOP_API_SECRET: capability, LH_IGNORE_ENV_KEYS: "1", LH_CREDENTIAL_KEY: randomBytes(32).toString("hex"), LH_AUTH_FILE: path.join(fixture, "auth.json"), LH_DATA_DIR: path.join(fixture, "data"), PORT: String(port) },
});
let output = "";
const capture = (chunk) => { output = (output + chunk.toString()).slice(-10000); };
child.stdout.on("data", capture); child.stderr.on("data", capture);
const chatgpt = attachChatGPTChild(child, {
	status: async () => status, stamp: () => stamp,
	models: async () => { models++; return { ...stamp, status, accountId: status.activeId, models: [{ id: model.id, name: model.name }] }; },
	lease: async (background, scope) => {
		assert.equal(background, false); assert.equal(scope.selectedModelId, model.id); assert.equal(scope.expectedAccountId, status.activeId);
		leases++; return { ...stamp, accessToken: "artificial-private-token", accountId: status.activeId };
	},
});
const subscriptions = attachSubscriptionChild(child, { snapshot: async () => ({ statuses: [], models: {} }) });
async function request(route, options = {}, timeout = 12000) {
	return fetch(url + route, { ...options, headers: { "x-learnharness-desktop": capability }, signal: AbortSignal.timeout(timeout) });
}
try {
	const deadline = Date.now() + 45000;
	while (true) {
		assert.equal(child.exitCode, null, `dev server exited\n${output}`);
		try { if ((await request("/", {}, 2000)).ok) break; } catch { /* booting */ }
		assert(Date.now() < deadline, `dev server did not become ready\n${output}`);
		await delay(200);
	}
	assert.equal((await fetch(url + "/api/catalog")).status, 403);
	const started = Date.now();
	const response = await request("/api/catalog");
	assert.equal(response.status, 200);
	const { workerPid, ...catalog } = await response.json();
	assert.deepEqual(catalog, { connected: true, models: [{ id: model.id, name: model.name, provider: "chatgpt" }] });
	const lease = await request("/api/catalog", { method: "POST" });
	assert.equal(lease.status, 200); assert.deepEqual(await lease.json(), { leased: true });
	assert.equal(models, 1); assert.equal(leases, 1);
	const catalogAndLeaseMs = Date.now() - started;
	const appCatalog = await request("/api/models", {}, 30000);
	assert.equal(appCatalog.status, 200);
	const appModels = await appCatalog.json();
	assert(appModels.models.some((entry) => entry.id === model.id && entry.provider === "chatgpt"));
	assert.equal(appModels.providers.find((entry) => entry.id === "chatgpt").keyPresent, true);
	const pin = { provider: "chatgpt", id: model.id };
	const save = await request("/api/settings/models", { method: "PUT", body: JSON.stringify({ strong: { model: pin } }) }, 30000);
	assert.equal(save.status, 200); assert.deepEqual((await save.json()).settings.models.strong.model, pin);
	const updated = await request("/api/models");
	assert.deepEqual((await updated.json()).slots.strong.model, pin);
	fs.appendFileSync(path.join(fixture, "next.config.mjs"), "\n// restart verification\n");
	const restartDeadline = Date.now() + 30000;
	while (true) {
		try {
			const next = await request("/api/catalog", {}, 2000);
			const body = await next.json();
			if (body.workerPid !== workerPid && body.connected && body.models?.length === 1) break;
		} catch { /* restarting */ }
		assert(Date.now() < restartDeadline, "Next config restart lost the private model connection");
		await delay(200);
	}
	const afterRestart = await request("/api/catalog", { method: "POST" });
	assert.deepEqual(await afterRestart.json(), { leased: true });
	console.log(JSON.stringify({ mode: legacy ? "legacy-cli" : "private-dev-worker", catalogAndLeaseMs, models, leases, modelSelectionSaved: true, configRestartPassed: true, unauthenticatedStatus: 403, providerNetworkRequests: 0 }));
} catch (error) {
	console.error(`[smoke-desktop-dev] ${error.name}: ${error.message}; private model requests received by Electron: ${models}`);
	console.error(output);
	process.exitCode = 1;
} finally {
	chatgpt.dispose(); subscriptions.dispose();
	try { process.kill(-child.pid, "SIGTERM"); } catch { /* already exited */ }
	await Promise.race([once(child, "exit"), delay(2500)]);
	try { process.kill(-child.pid, "SIGKILL"); } catch { /* already exited */ }
	fs.rmSync(fixture, { recursive: true, force: true });
}
