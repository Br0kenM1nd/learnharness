/** Provider keys encrypted with an installation key protected by macOS Keychain.
 * Only the Electron-owned server receives the key. Corrupt and legacy plaintext
 * stores fail closed and are never silently overwritten. */
import { AUTH_FILE } from "../../config.ts";
import type { AuthStore } from "../core/ports.ts";
import { readRecord, writeRecord } from "../../electron/credential-vault.cjs";

function readMap(): Record<string, string> {
	const raw = readRecord(AUTH_FILE, {});
	if (!raw || typeof raw !== "object" || Array.isArray(raw) || Object.values(raw).some((value) => typeof value !== "string")) throw new Error("Invalid credential store.");
	return raw as Record<string, string>;
}

export const authStore: AuthStore = {
	authVars: readMap,
	setAuthVar(name, value) {
		const map = readMap();
		map[name] = value;
		writeRecord(AUTH_FILE, map);
	},
	deleteAuthVar(name) {
		const map = readMap();
		if (!(name in map)) return;
		delete map[name];
		writeRecord(AUTH_FILE, map);
	},
};
