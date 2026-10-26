"use strict";
// Next's request handlers live in this worker, so its IPC must reach Electron.
require("./server-title-guard.cjs");
process.once("disconnect", () => process.exit(0));
require("next/dist/server/lib/start-server");
