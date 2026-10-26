"use strict";
const http = require("node:http");
const config = require("./network-config.json");

/** One required outbound route for OAuth and the model server. Never log it:
 * a future deployment may put proxy credentials in this URL. */
function desktopNetworkEnvironment(env = process.env, settings = config) {
	let proxy;
	try {
		proxy = new URL(settings.proxyUrl);
		if (!["http:", "https:"].includes(proxy.protocol) || proxy.pathname !== "/" || proxy.search || proxy.hash) throw new Error();
	} catch {
		throw new Error("A valid HTTP(S) proxy is required in electron/network-config.json. Direct connections are disabled.");
	}
	const proxyUrl = proxy.href;
	// Ignore inherited exclusions: a wildcard or an OpenAI entry could silently
	// bypass the required VPS route. Only our local IPC/HTTP endpoints bypass it.
	const bypass = "localhost,127.0.0.1,::1,[::1]";
	return { ...env, HTTP_PROXY: proxyUrl, HTTPS_PROXY: proxyUrl, ALL_PROXY: proxyUrl,
		http_proxy: proxyUrl, https_proxy: proxyUrl, all_proxy: proxyUrl,
		NO_PROXY: bypass, no_proxy: bypass, NODE_USE_ENV_PROXY: "1" };
}

function configureDesktopNetwork(settings = config) {
	// Electron's embedded Node has already started; setting only the environment
	// flag here would leave its global fetch using the direct dispatcher.
	return http.setGlobalProxyFromEnv(desktopNetworkEnvironment(process.env, settings));
}

module.exports = { desktopNetworkEnvironment, configureDesktopNetwork };
