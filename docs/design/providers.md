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
