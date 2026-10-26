# LearnHarness Fork security work

Target for the first version: **macOS desktop**, selected by the owner. Browser
hosting, Windows/Linux distribution, and publishing signed installers are outside
this version's scope.

Upstream base: `3dc88472eea41eed0d5e5f29c2f16f8d063c415b` (0.3.8).
Fork: https://github.com/Br0kenM1nd/learnharness
Branch: `security/harden-local-access`.

## Completed plan

- [x] Create the fork, clone it, and retain the original repository as `upstream`.
- [x] Reproduce file/key access with artificial fixtures.
- [x] Remove host filesystem tools and local PDF jobs from every study role,
      including explicit tool overrides and previously enabled preferences.
- [x] Refuse restored PDF/demo jobs before resolving an engine. Retired workers
      remain separately testable with fake engines; production uses the restricted
      worker policy, which is not configurable through settings or HTTP.
- [x] Encrypt API keys and OAuth credentials with AES-256-GCM; protect the random
      installation master key through Electron's asynchronous macOS Keychain
      provider. Fail closed on unavailable encryption, symlinks, invalid permissions,
      corrupt records, and authentication failures. Never overwrite a bad store.
- [x] Protect pages and APIs with a per-launch capability, including first window
      navigation. Authorize only the owned main frame at the exact app origin.
      Bare web servers and external development servers are unsupported.
- [x] Have Electron own the development server too, bound to `127.0.0.1`.
- [x] Disable executing and displaying generated HTML/JavaScript demos, including
      old saved artifacts; remove the unsandboxed Chrome launch flag.
- [x] Restrict native SVG rendering to self-contained figures and fragment
      references. Reproduction confirmed that resvg reads absolute image paths;
      image elements, external references, XML external declarations, executable
      content, and unsafe CSS references now fail before native rendering.
      Native rendering has input-byte and output-pixel limits and no HTML fallback.
- [x] Update vulnerable packages and remove unused `ansi-to-react`, which brought
      vulnerable `linkify-it`. The final npm audit reports zero known vulnerabilities.
- [x] Give the fork its own application ID/data directory, disable automatic
      updates and inherited release publishing, and ignore ambient provider API
      keys in the desktop server. Credentials are entered explicitly in the app.
- [x] Prepare a reviewable branch with deterministic security and regression checks.

## Run on macOS

For development, use Node 24 or 26 and an Apple Silicon Mac (the inherited package
configuration builds arm64). From the repository root:

```sh
npm ci --ignore-scripts
node node_modules/electron/install.js
npm run desktop:dev
```

Dependency lifecycle scripts are skipped. The separate Electron install command
fetches the official runtime and verifies the package's checksums. No AI key is
required to open the app. Use ChatGPT → Connect to authorize plan usage, or enter
a separate limited provider key in application settings. Never commit or send
credentials or callback codes in chat.

### Required VPS proxy route

`electron/network-config.json` pins the owner-confirmed local HTTP proxy endpoint
`http://127.0.0.1:7890`. Its upstream VPS is managed by the existing proxy client,
not by LearnHarness. Keep that client running. This configuration is shipped with
the Electron shell, so it also applies when launching from Finder without shell
environment variables.

The main process explicitly configures Node's global HTTP/HTTPS/fetch proxy
dispatcher before OAuth, token refresh, or model discovery. The embedded server
receives the same HTTP(S) proxy and `NODE_USE_ENV_PROXY=1` before startup, covering
model inference and other outbound Node requests. Inherited proxy URLs and
`NO_PROXY` exclusions cannot bypass this configured route. Only `localhost`,
`127.0.0.1`, and IPv6 loopback bypass the proxy, keeping private app traffic local.
There is no direct-network retry when the proxy fails. Change the JSON endpoint
and fully restart Electron if the existing VPS proxy endpoint changes. Do not
commit proxy passwords to the configuration.

The system browser handles the interactive OpenAI sign-in page separately and
uses its own networking configuration. LearnHarness controls the subsequent
native code exchange, token refresh, account catalog, and model requests.

Sign-in distinguishes an unsupported network location, account eligibility, HTTP
401/403, and a rejected authorization code. Only a rejected refresh grant is
treated as an expired saved session. Provider response bodies and OAuth codes are
not displayed or logged. The connection notices now describe encrypted desktop
storage and the Keychain-protected encryption key.

macOS may request access to Keychain. The app refuses to store credentials if the
OS encryption provider is unavailable. No signing certificate is needed for source
work; consistent Developer ID signing and notarization require a separate release
setup. The local `desktop:dist` command explicitly disables publishing and
notarization and produces a development build.

The app uses `~/Library/Application Support/LearnHarness Fork` (development adds
`-dev`), leaving upstream data separate. Existing upstream plaintext credential
files are not imported. Re-enter credentials; use explicit note imports to bring
in learning material. Local PDF paths and executable demos are unavailable.

`npm run dev` and `npm start` launch the macOS development app; they no longer
expose an unauthenticated browser application. Use `npm run build` for the Next
server build. Do not set `LH_DEV_URL`; external servers are deliberately refused.

## Initial hardening verification

Executed on 26 October 2026 with artificial credentials and temporary files:

- Complete suite on Electron's bundled Node 24.22.0: **2351 passed, 0 failed,
  0 skipped**. No real AI API key or provider sign-in was used.
- `npm run typecheck`: passed.
- `npm run lint`: passed.
- Production Next build on the bundled Node: passed.
- `scripts/build-server.mjs`: passed; standalone payload prepared without local
  credentials or learning data.
- `scripts/smoke-server.mjs --electron`: passed on the actual standalone payload.
  Authorized home/API requests returned 200; home, chat and API requests without
  the private capability returned 403. The temporary server and data were removed.
- Provider runtime smoke: native lazy adapters initialized offline, **zero network
  attempts**; runtime imports remained confined to the standalone payload.
- `npm audit --package-lock-only --ignore-scripts`: exit 0; **0 vulnerabilities**
  across all severity categories in the current advisory database.

The Keychain integration is covered with a fake OS encryption provider; a real
Keychain permission prompt and a complete live learning session require manual
acceptance. Installer signing/notarization, distribution, and updates were not
performed. The dependency audit is a known-advisory check, not a guarantee that
all dependencies or future changes are safe.

Models, optional research and dictation still use external services. Learning
history and graph records remain local plaintext data. This is a personal desktop
application, not an OS sandbox for running arbitrary code or a multi-user server.

## OAuth/VPS follow-up verification

Also executed on 26 October 2026:

- Reproduced the original transport failure with a synthetic authorization code:
  direct embedded Node received HTTP 403 `unsupported_country_region_territory`;
  the existing configured proxy returned HTTP 400 `invalid_grant`, as expected
  for the deliberately invalid code. No user callback code or credentials were
  used in these probes.
- Complete suite after the fix on bundled Node 24.22.0: **2361 passed, 0 failed,
  0 skipped**, including actual local proxy traffic, a spawned server process,
  private loopback bypass, unavailable-proxy refusal, sign-in error classification,
  and the existing PKCE/nonce/token validation checks.
- `npm run typecheck`, `npm run lint`, and `git diff --check`: passed.
- An isolated native Electron process, with inherited shell proxy settings removed
  and `NO_PROXY=*`, used the pinned JSON configuration successfully. Its separately
  spawned Node process used the same endpoint. Both got the expected HTTP 400
  `invalid_grant` from OpenAI for artificial codes. Neither touched the user's
  Keychain or OAuth store.

The app must be fully quit and restarted for main-process networking changes.
A fresh interactive ChatGPT sign-in is still required to verify the user's real
account. The old callback code must not be replayed. This follow-up did not build
or publish an installer.
