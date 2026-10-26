"use strict";
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

function keyBytes(value = process.env.LH_CREDENTIAL_KEY) {
	if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) throw new Error("The protected credential store is unavailable.");
	return Buffer.from(value, "hex");
}

function privateFile(file) {
	const stat = fs.lstatSync(file);
	if (!stat.isFile() || (stat.mode & 0o077) !== 0 || (process.getuid && stat.uid !== process.getuid())) throw new Error("Unsafe credential file permissions.");
}

function atomicWrite(file, value) {
	fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
	try { privateFile(file); } catch (error) { if (error.code !== "ENOENT") throw error; }
	const temp = `${file}.${crypto.randomUUID()}.tmp`;
	let fd;
	try {
		fd = fs.openSync(temp, "wx", 0o600);
		fs.writeFileSync(fd, value);
		fs.fsyncSync(fd);
		fs.closeSync(fd); fd = undefined;
		fs.renameSync(temp, file);
		const dir = fs.openSync(path.dirname(file), "r");
		try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
	} finally {
		if (fd !== undefined) fs.closeSync(fd);
		try { fs.unlinkSync(temp); } catch (error) { if (error.code !== "ENOENT") throw error; }
	}
}

/** Keychain-backed master key. No plaintext fallback or renderer bridge. */
async function loadMasterKey(file, safeStorage) {
	if (!await safeStorage.isAsyncEncryptionAvailable()) throw new Error("macOS Keychain is unavailable. Unlock it and restart the application.");
	try {
		privateFile(file);
		const result = await safeStorage.decryptStringAsync(fs.readFileSync(file));
		keyBytes(result.result);
		if (result.shouldReEncrypt) atomicWrite(file, await safeStorage.encryptStringAsync(result.result));
		return result.result;
	} catch (error) {
		if (error.code !== "ENOENT") throw error;
		const key = crypto.randomBytes(32).toString("hex");
		atomicWrite(file, await safeStorage.encryptStringAsync(key));
		return key;
	}
}

function readRecord(file, initial, key = undefined) {
	try { privateFile(file); } catch (error) { if (error.code === "ENOENT") return structuredClone(initial); throw error; }
	const bytes = keyBytes(key);
	try {
		const record = JSON.parse(fs.readFileSync(file, "utf8"));
		if (record.version !== 1 || record.algorithm !== "aes-256-gcm" || typeof record.iv !== "string" || typeof record.tag !== "string" || typeof record.data !== "string") throw new Error();
		const iv = Buffer.from(record.iv, "base64"), tag = Buffer.from(record.tag, "base64");
		if (iv.length !== 12 || tag.length !== 16) throw new Error();
		const cipher = crypto.createDecipheriv("aes-256-gcm", bytes, iv);
		cipher.setAAD(Buffer.from(path.basename(file)));
		cipher.setAuthTag(tag);
		return JSON.parse(Buffer.concat([cipher.update(Buffer.from(record.data, "base64")), cipher.final()]).toString("utf8"));
	} catch {
		throw new Error("The credential store could not be decrypted. It has not been overwritten.");
	}
}

function writeRecord(file, record, key = undefined) {
	const bytes = keyBytes(key);
	// Never replace a corrupt or differently encrypted existing store.
	readRecord(file, null, key);
	const iv = crypto.randomBytes(12);
	const cipher = crypto.createCipheriv("aes-256-gcm", bytes, iv);
	cipher.setAAD(Buffer.from(path.basename(file)));
	const data = Buffer.concat([cipher.update(JSON.stringify(record), "utf8"), cipher.final()]);
	atomicWrite(file, `${JSON.stringify({ version: 1, algorithm: "aes-256-gcm", iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), data: data.toString("base64") })}\n`);
}

function vaultStore(file, initial, key, validate = (value) => value) {
	return {
		async read() { const value = readRecord(file, initial, key); return value === null ? null : validate(value); },
		async write(value) { writeRecord(file, validate(value), key); },
	};
}

module.exports = { loadMasterKey, readRecord, writeRecord, vaultStore };
