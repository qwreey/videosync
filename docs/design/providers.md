# Provider descriptors (D7)

Research behind this: `research/design-provider-descriptors.md` (schema, precedents, pitfalls).

## What a descriptor is

A JSON file describing one provider: how a URL names a video, what the canonical watch URL is,
which paths are media (closing F20), which `<video>` is the player, and which capabilities to
distrust. **Data only.** Bundled code evaluates it; a descriptor can select and tune, never run
anything, which keeps MV3's remote-code ban intact and lets a server hand them out.

Schema 1 is the one in the research report §3.2 with these decisions:

- **No regular expressions.** Path and query matching use a segment-template language that is
  linear by construction (`/player/{series:int}/{episode:int}`, `{id}`, `{kind:embed|shorts}`, a
  trailing `**`). A crafted `mediaUrl` from a room member cannot hang anyone's tab.
- `pathFallback: false` means only the identity rules name media. The built-in Laftel descriptor
  uses it, which closes F20 there.
- `keyPrefix` and published key bodies are **frozen**: they are on the wire, and two members with
  different descriptor versions must still compute the same key.
- `examples` are self-tests; a descriptor whose examples fail is rejected, in CI for built-ins and
  in the client for everything else.
- `continues` (for D8): an optional template pair saying which next key continues a previous one
  (Laftel: same series). Informational until D8 consumes it.
- `requires` lists fields a descriptor depends on; a client that does not implement one rejects the
  descriptor rather than silently ignoring a restriction. A client rejects `schema` > known.

## Where descriptors come from

| tier | source | trust |
|---|---|---|
| **built-in** | `providers/*.json` in this repo, compiled into the bundles; also generates the extension's `matches` and the userscript's `@match` | full |
| **server** | `videosyncd -providers DIR` (a mounted volume), served at `GET /api/providers` (index with `sha256`) and `GET /api/providers/<id>.json` | inert until the user adopts it; may only **restrict** capabilities; makes a host followable only if the user has also granted that host |
| **user** | written or imported in the extension's options page (userscript: a menu command), saved in extension storage | same as server |

Precedence per host: user > adopted server (replacing a built-in only after an explicit "replace
built-in" confirmation that shows the difference) > built-in > the generic path rule. Two
descriptors with overlapping hosts: the more specific host wins; a tie applies neither and says so.

## Adoption and updates

- Adoption pins the file's `sha256`; `version` is for display.
- When the client connects to a server, it fetches the index (small, whole — never per host). A
  server descriptor the user has not decided on is offered once, in the extension's own page, never
  in the in-page panel (a page can overlay that).
- A pinned descriptor whose hash changed on the server is **not** applied silently: the next time
  the user presses play on that provider, the panel says "the server has an update for <name>" and
  the extension page shows the difference. A change that widens `hosts`, `identity`,
  `canonicalHost` or `pathFallback` always asks, even with auto-update on.
- "Automatically adopt from this server" is an opt-in per server, limited to changes that widen
  nothing.
- New hosts need a runtime permission: the extension declares `optional_host_permissions` and the
  `scripting` permission, and registers its bundled content script for granted hosts
  (`registerContentScripts`). The built-in set keeps needing none, as measured (§11). The userscript
  cannot add hosts to itself; the menu command tells the user which `@match` to add.

## Server side (stdlib)

`-providers DIR` reads `*.json`, validates each with the Go port of the template grammar
(`DisallowUnknownFields`, size and count limits, examples run), logs and skips invalid files, and
reloads on SIGHUP or when a file's mtime changes. CORS matches `/api/rooms`. Listing is gated like
room creation when `-auth-scope` asks for it.

The template grammar has one test-vector file shared by the TS and Go suites so the two
implementations cannot drift.

## Safety

- Hosts are ASCII, lowercase, exact or a leading `*.`, at least two labels; matched on the parsed
  `hostname`, never on the URL string.
- `watch` templates must produce an `https` URL on a declared host, and re-normalise to the same key.
- Limits: 16 KiB per descriptor, 32 identity rules, 16 segments, 256-character selectors, no
  `:has(`.
- `dump()` reports which descriptor (id, version, hash, tier) was in force.

## As built (2026-09-17)

Where the build had to decide something this document left open, or deviated from the research
report's §3, it is recorded here.

**Where the code is.** Grammar `client/core/src/providers/template.ts`, validator and evaluator
`descriptor.ts`, precedence `registry.ts`, stored state and diffs `adoption.ts`, user actions
`manage.ts` (pure transitions shared by the options page and the userscript menu). Go port
`server/internal/provider`. Shared vectors `providers/testdata/templates.json` (grammar, hosts,
encoding) and `descriptors.json` (65 whole descriptors accepted or rejected alike). The old code
rules are frozen in `client/core/test/legacy-mediakey.ts` and the built-ins are checked against
them URL by URL.

**Schema decisions.**

- **`pageHosts`** is a field the research schema did not have: the hosts whose pages the shims run
  on, default `hosts`, each covered by `hosts`. Without it, generating `matches` from `hosts`
  would have widened the install prompt to `*.youtube.com`, `youtube-nocookie.com` and `youtu.be`.
  The YouTube built-in lists `www.` and `m.youtube.com`, exactly the old manifest. The userscript
  loses its `youtu.be` `@match` — a redirect never renders a page, so nothing ran there.
- **`pathFallback` and each rule's `watch` are required**, so a descriptor always says whether
  unmatched paths are media and where a matched one is opened.
- **Numbers out of range are rejected, not clamped.** A clamp would silently apply something the
  author did not write; rejecting it matches the unknown-field rule.
- **`requires`** accepts only what is implemented: `hosts`, `pageHosts`, `canonicalHost`,
  `identity(.hosts|.query)`, `pathFallback`, `video(.*)`, `capabilities(.playbackRateNudge|
  .directSeek)`, `seek(.landingToleranceS|.timeoutMs)`, `continues`. `ads` and `navigation` are
  accepted as fields (informational) but a descriptor that *requires* them is refused.
- **Capabilities** are only `playbackRateNudge` and `directSeek` — the two the engine consults.
  The mask is restrict-only by construction (ANDed with the adapter's own), for built-ins too.
  `seek.typicalInBufferMs` and `navigation.*` are informational.
- **Identity rules may carry `hosts`** (the research's YouTube example uses it), a subset of the
  descriptor's; that is what keeps `youtu.be/?v=x` naming nothing, as before.
- **`continues`** is a list of `{from, to}` path templates matched against key *bodies*; captures
  with the same name must be equal; a key does not continue itself. Examples of the form
  `{from, to, continues}` test it. `Provider.continues(prev, next)` is the API D8 will call.
- **`examples`**: `{url, key, watch?}` asserts what *this descriptor alone* gives — `key: null`
  means it names no media or does not claim the host. A non-null key must also yield a watch URL
  that re-normalises to it. At least one example must name media. The descriptor-level lint the
  research asked for is enforced: a rule whose path is only `/**` with no `query` is refused.
- **`watch` host** must be covered by `hosts` (not only `canonicalHost`); placeholders may appear
  anywhere after the authority except in a query parameter's name.

**Grammar decisions.**

- Empty path segments are dropped before matching (`/a//b/` is `/a/b`), which is how the YouTube
  code rule read paths. For Laftel this means `/player//1/2` now keys as `/player/1/2`; the old
  path rule kept the double slash. No real page has one.
- Path captures are percent-decoded once (the research's rule); the old YouTube code did not
  decode `youtu.be/<id>` or `/embed/<id>`. Real ids contain no `%`, so no real key changed.
- `{name}` is `[A-Za-z0-9._~-]{1,128}`, `{name:int}` `[0-9]{1,20}`, `{name:any}` 1–256 code
  points; a segment that does not decode to valid UTF-8 matches nothing. Every length in the
  grammar and the validator is counted in code points, because Go counts runes.
- Query values are read as `URLSearchParams.get` does (first value, form-decoded); the Go port
  reimplements that and `encodeURIComponent` by hand. URL *parsing* is not shared: the server
  uses `net/url`, which differs from WHATWG at the edges (dot segments, IDN), so the vectors pin
  the grammar on already-parsed parts, and the built-ins' examples are plain URLs.
- A hostname is lowercased and one trailing dot is dropped before matching, so `laftel.net.` is
  Laftel (an example says so). Before, it fell to the unknown-host branch with its own key.

**Precedence.** One adopted descriptor per id (adopting another server's copy replaces it). An
adopted copy with a built-in's id applies only when `replaceBuiltin` was confirmed; otherwise the
built-in stays and `dump().providerNotes` says why. A tie between different ids for a host applies
neither; the panel says so once at start and `dump().providerConflict` lists them.

*Integration (review fixes):* replacing a built-in is not only taking its id. A server descriptor
with another id that claims a built-in's host at least as specifically (so it wins or ties there),
or mints a built-in's `keyPrefix`, needs the same `replaceBuiltin` confirmation — in `adopt` and
again in `buildRegistry` (`displacedBuiltins`); a user descriptor that does so is allowed (the user
is the top tier) but `saveUser` reports it and both surfaces say so before saving. A tie on a host
a built-in describes keys by that built-in when it is in force, and names no media when it was
replaced; the generic path rule applies to ties only on hosts no built-in describes, because on a
built-in's host it is F20 again. `continuesMedia()` asks the one descriptor in force that owns the
key's prefix, and nothing when two do.

**Built-ins in the bundles.** `client/core/scripts/providers.mjs` validates `providers/*.json`
(examples run) and writes `src/providers/builtin.gen.ts` with each file's exact text and sha256,
so no JSON import is needed and a built-in's hash is comparable with a server's. The file is
committed; `providers.test.ts` fails when it is stale, and both shim builds regenerate it first.
The same module produces the match patterns (`https://<pageHost>/*`, in file-name order);
`client/extension/manifest.mjs` and `client/userscript/meta.mjs` put them into the manifests
and the `@match` lines, and `manifest.json`'s own list and `meta.txt`'s `@match` lines are gone.
Bundle sizes after this: extension `content.js` 128 kB, `sw.js` 39 kB (it now builds a registry
to decide what to register), `options.js` 54 kB; userscript 145 kB.

**Video hints.** `include`/`exclude` use `closest`, so a selector may name the `<video>` or a
player around it. An `include` that matches nothing is ignored and `dump().staleInclude` is true.
`minIntrinsicArea` drops only elements whose size is known — the feature before its metadata has
none. A selector the browser cannot parse matches nothing. `pierceShadow` walks open shadow roots
(depth 8) on each check; the MutationObserver does not see inside them, the 1 Hz poll does.

**The update notice.** Said as a system line in the panel's chat log, once per provider per page,
on the adapter's `play` event for the page's provider — which also fires for a play the room
applied, not only for the member's own press. Only *pinned descriptors whose server copy changed*
are mentioned; new offers are never mentioned in the page, and are listed (tagged "새 설명") on
the options page. Nothing opens the options page by itself.

**Auto-adopt** runs where the index is fetched on join (the extension's content script, the
userscript), writes the new pin, and takes effect on the next page load: swapping a descriptor
under a running session could change the page's key mid-room.

**Server.** A file's name need not match its id (`youtube.json` is `yt`); the id is the URL. Two
files with one id: the first by file name is served and the other logged. At most 256 files. The
poll compares name, size and mtime (`-providers-poll`, default 5 s; a rewrite that keeps both
needs `SIGHUP`). `SIGHUP` is only caught when `-providers` is given, and is registered before the
listener starts. `GET /api/providers/<id>.json` sends `ETag: "<sha256>"` and answers
`If-None-Match`. **Not done: gating the listing behind `-auth-scope`** — that flag belongs to the
auth track (D6), which is not merged; the route is registered next to `/api/rooms` so it can take
the same gate.

**Extension.** The worker's `providers.fetch` only fetches `/api/providers` and
`/api/providers/<id>.json` of the given server (it can reach addresses a page cannot, so it
fetches nothing else a caller names). The content script learns the granted hosts from the worker
(`providers.granted`), since it has no `permissions` API. Added sites get the bundled
`content.js` through `scripting.registerContentScripts` with the manifest's pages in
`excludeMatches`, plus a double-injection guard in `content.ts`; the registration is redone on
worker start and whenever stored descriptors or permissions change. Host permissions are asked
for only from the "사이트 권한 허용" button, because the prompt needs a user gesture. **Firefox
MV2** gets `optional_permissions` and uses `scripting.registerContentScripts` where Firefox exposes
it to MV2, else `contentScripts.register`, which only lasts while the background page does —
neither path has been run in a browser.

**Userscript.** `prompt`/`confirm` from `GM_registerMenuCommand` stand in for the options page.
Followability for non-built-in descriptors comes from the script's own `@match`/`@include` lines
(`GM_info.script`), and after a change the menu prints the exact `@match` lines still missing.

**Not built:** the optional `welcome.providers` hash list (research §3.5 rule 3, a protocol
change), a server-side media allowlist (open question 1), and a live check of other Laftel player
routes (research §5 step 2) — the lead's probes.
