import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
const root = fs.mkdtempSync(path.join(os.tmpdir(), "lh-policy-"));
process.env.LH_DATA_DIR = root;
const { chatStore } = await import("../src/store/chats.ts");
const { jobStore } = await import("../src/store/jobs.ts");
const { createProberTools, createTeacherTools } = await import("../src/agent/tools.ts");
const { practiceTools } = await import("../src/agent/tools/practice.ts");
const { createJobRunner } = await import("../src/agent/subagents/runner.ts");
const { getHeadless } = await import("../src/agent/subagents/headless.ts");
const { desktopAPIAuthorized } = await import("../src/server/desktop-access.ts");
after(() => fs.rmSync(root, { recursive: true, force: true }));

test("every study role excludes host filesystem and executable demos even with stale enabled preferences", () => {
	const chatId = chatStore.createChat("security fixture").id;
	const context = { chatId, chatStore, jobStore, spawn: () => {}, deliver: () => {} };
	const enabled = { read: true, ls: true, find: true, grep: true, pdf: true, demo: true };
	for (const registry of [createProberTools(context, enabled), createTeacherTools(context, enabled), practiceTools({ ...context, jobs: context })]) {
		for (const name of Object.keys(enabled)) assert(!registry[name], name);
		assert(Object.values(registry).every((tool) => typeof tool?.execute === "function"));
	}
});

test("restored local PDF and demo jobs cannot start a model or read a source path", async () => {
	const chatId = chatStore.createChat("restored security fixture").id;
	const runner = createJobRunner({ chatStore, jobStore, deliver: async () => {}, engineFor: () => { throw new Error("The disabled job reached engine resolution"); } });
	for (const kind of ["pdf", "demo"] as const) {
		const job = jobStore.createJob({ kind, chatId, toolCallId: `old-${kind}`, input: kind === "pdf" ? { path: "/private-key.pdf", question: "read" } : { title: "old", brief: "execute" } });
		await runner.runJob(job.id);
		assert.equal(jobStore.getJob(job.id)?.status, "error");
		assert.match(jobStore.getJob(job.id)?.error ?? "", /security policy/);
	}
});

test("direct executable rendering is blocked before a browser can launch", async () => {
	await assert.rejects(getHeadless().runDemo("<script>throw new Error('executed')</script>"), /disabled/);
});

test("native SVG rendering cannot read local images, namespaced or entity-encoded references", async () => {
	const file = path.join(root, "private-image.png");
	for (const content of [
		`<image href="${file}"/>`,
		`<image xmlns:xlink="http://www.w3.org/1999/xlink" xlink:href="${file}"/>`,
		`<use href="&#47;private&#47;image.svg#drawing"/>`,
		`<style>@import url("${file}");</style>`,
		`<foreignObject><img src="${file}"/></foreignObject>`,
	]) {
		await assert.rejects(getHeadless().renderSvg(`<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10">${content}</svg>`), /external resources/);
	}
	const png = await getHeadless().renderSvg('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><defs><linearGradient id="g"><stop stop-color="red"/></linearGradient></defs><rect width="10" height="10" fill="url(#g)"/></svg>');
	assert.equal(png.subarray(1, 4).toString(), "PNG");
});

test("a bare web server and malformed desktop capabilities fail closed", () => {
	assert.equal(desktopAPIAuthorized(new Headers(), {}), false);
	assert.equal(desktopAPIAuthorized(new Headers(), { LH_DESKTOP_SERVER: "1" }), false);
	assert.equal(desktopAPIAuthorized(new Headers({ "x-learnharness-desktop": "short" }), { LH_DESKTOP_SERVER: "1", LH_DESKTOP_API_SECRET: "short" }), false);
});
