import { randomBytes } from "node:crypto";
// Isolated fixture encryption key, never a production credential or fallback.
process.env.LH_CREDENTIAL_KEY ??= randomBytes(32).toString("hex");
