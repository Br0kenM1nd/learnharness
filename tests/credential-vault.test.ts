import assert from "node:assert/strict";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
const { loadMasterKey, readRecord, writeRecord, vaultStore } = createRequire(import.meta.url)("../electron/credential-vault.cjs");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "lh-vault-"));
const key = "a".repeat(64);
after(() => fs.rmSync(root, { recursive: true, force: true }));

test("provider and OAuth secrets round-trip without appearing in files", async () => {
	const file = path.join(root, "auth.json");
	const secret = "dummy-api-key-not-a-real-secret";
	writeRecord(file, { OPENAI_API_KEY: secret }, key);
	assert.equal(readRecord(file, {}, key).OPENAI_API_KEY, secret);
	assert(!fs.readFileSync(file, "utf8").includes(secret));
	assert.equal(fs.statSync(file).mode & 0o777, 0o600);
	const store = vaultStore(path.join(root, "oauth.json"), null, key);
	await store.write({ accessToken: secret, refreshToken: "dummy-refresh" });
	assert.equal((await store.read()).accessToken, secret);
	assert(!fs.readFileSync(path.join(root, "oauth.json"), "utf8").includes("dummy-refresh"));
});

test("wrong keys and modified ciphertext fail closed without replacing the file", () => {
	const file = path.join(root, "tampered.json");
	writeRecord(file, { value: "dummy" }, key);
	const original = fs.readFileSync(file, "utf8");
	assert.throws(() => readRecord(file, {}, "b".repeat(64)), /could not be decrypted/);
	assert.throws(() => writeRecord(file, {}, "b".repeat(64)), /could not be decrypted/);
	assert.equal(fs.readFileSync(file, "utf8"), original);
	const record = JSON.parse(original);
	record.tag = Buffer.alloc(16).toString("base64");
	fs.writeFileSync(file, JSON.stringify(record));
	assert.throws(() => readRecord(file, {}, key), /could not be decrypted/);
});

test("symlinks, loose permissions and cross-store substitution are rejected", () => {
	const file = path.join(root, "one.json"), other = path.join(root, "two.json");
	writeRecord(file, { value: "dummy" }, key);
	fs.copyFileSync(file, other);
	fs.chmodSync(other, 0o600);
	assert.throws(() => readRecord(other, {}, key), /could not be decrypted/);
	const link = path.join(root, "link.json");
	fs.symlinkSync(file, link);
	assert.throws(() => readRecord(link, {}, key), /Unsafe/);
	assert.throws(() => writeRecord(link, {}, key), /Unsafe/);
	fs.chmodSync(file, 0o644);
	assert.throws(() => readRecord(file, {}, key), /Unsafe/);
});

test("plaintext records cannot be silently adopted or overwritten", () => {
	const file = path.join(root, "legacy.json");
	fs.writeFileSync(file, '{"OPENAI_API_KEY":"dummy"}', { mode: 0o600 });
	assert.throws(() => readRecord(file, {}, key), /could not be decrypted/);
	assert.throws(() => writeRecord(file, {}, key), /could not be decrypted/);
	assert(fs.readFileSync(file, "utf8").includes("dummy"));
});

test("Keychain unavailability never creates an unprotected master key", async () => {
	const file = path.join(root, "unavailable.enc");
	await assert.rejects(loadMasterKey(file, { isAsyncEncryptionAvailable: async () => false }), /Keychain/);
	assert(!fs.existsSync(file));
});

test("master key is reused through the OS encryption provider, not stored in plaintext", async () => {
	const file = path.join(root, "key.enc");
	const protectedValues = new Map<string, string>();
	const provider = {
		isAsyncEncryptionAvailable: async () => true,
		encryptStringAsync: async (value: string) => { const id = `encrypted-${protectedValues.size}`; protectedValues.set(id, value); return Buffer.from(id); },
		decryptStringAsync: async (value: Buffer) => ({ result: protectedValues.get(value.toString()), shouldReEncrypt: false }),
	};
	const first = await loadMasterKey(file, provider);
	assert.equal(await loadMasterKey(file, provider), first);
	assert(!fs.readFileSync(file, "utf8").includes(first));
});
