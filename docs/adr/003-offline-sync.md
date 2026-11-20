# ADR-003 — Offline sync with PowerSync

> Condensed English version of ADR-003. The full record, in Spanish, is in the private repository.

**Status:** accepted on 2026-11-05, based on tests and measurements on the Android emulator (the initial sync spike). To be revisited when iOS is tested on real devices and when the production deployment is chosen in the second phase.

## Context

The app must work fully offline: every read and write goes to a local database and the network never blocks the UI. The product design picks PowerSync on top of Supabase: SQLite on the device, an upload queue, logical replication from Postgres and last-write-wins with the server's `updated_at`. The database conventions left several questions open for this spike: which clock sets `updated_at`, how to handle unique violations (`23505`), `profiles` (UPDATE only), the absence of client DELETE, which error codes the connector sees, and the no-account mode.

The spike decides with data how the app syncs. The sync package and the domain repositories are product code; the spike's test screen is a development tool. That code is not part of this public repository (which holds only the annotation engine); this record documents its design.

## Decisions

### 1. Development environment: everything local in Docker

| | Local in Docker (chosen) | Supabase Cloud + PowerSync Cloud free tiers |
|---|---|---|
| Memory (WSL2 with 3 GB) | Supabase ~640 MiB + PowerSync 150 MiB + bucket storage 45 MiB = **~830 MiB** idle | 0 locally |
| Accounts and secrets | None: random local passwords | Two accounts; replication role password in a dashboard; secrets in CI |
| CI | Yes: a dedicated `sync` job | Shared state and secrets |
| Pause on inactivity | No | Both after 7 days unused |
| Similarity to production | Same service and same sync config; auth and storage differ | Same as production |

- PowerSync service 1.27.2 (pinned by digest; 1.28 was 0–2 days old) plus a separate Postgres 17.11 as bucket storage, kept apart from the source database as in production. Limits: 512 MiB and a 384 MB heap for the service, 256 MiB for storage.
- **Auth:** the Supabase CLI already signs user tokens with **ES256** and publishes a JWKS; the service validates them with an explicit JWKS URI and `audience: authenticated`. No key generation and no HS256 shared secret. Production (PowerSync Cloud or self-hosted) is decided in the second phase; the same sync config serves both.

### 2. Postgres: role and publication

- `powersync_role` with `REPLICATION BYPASSRLS`, created **without LOGIN or password** (`IF NOT EXISTS`, since roles are cluster-wide). The password is never in a migration.
- Explicit `SELECT` on the 12 tables and `CREATE PUBLICATION powersync FOR TABLE …` with an explicit list. Not `FOR ALL TABLES`: PowerSync reads every published change, and the `auth` tables would leak in.
- **Tolerant of a pre-existing publication** (PowerSync's Supabase guide creates it by hand, sometimes `FOR ALL TABLES`). `private.ensure_powersync_publication()` converges it to the migration's list: `ALTER PUBLICATION … SET TABLE` if it exists; drop and recreate if it is `FOR ALL TABLES` (which does not accept `SET TABLE`; the replication slot refers to it by name); create it otherwise. A pgTAP test covers all three starting points. Later migrations use `ALTER PUBLICATION powersync ADD TABLE`.
Tests check the role attributes (SELECT only, no access to `auth.users` or `private`, reads despite RLS) and that the publication contains exactly the `public` tables, with only allowed column types.

### 3. Generated local schema

A generator reads the `Row` and `Relationships` types of the generated database types with the TypeScript compiler API and writes the local PowerSync schema and the Sync Streams config. A snapshot test fails when they are stale, so the chain is: migration → regenerate DB types (checked in CI) → regenerate the local schema.

| Postgres | SQLite (PowerSync) | Domain |
|---|---|---|
| `uuid`, `text`, `date` | text | string |
| `timestamptz` | ISO text, millisecond precision | string |
| `boolean` | integer 0/1 | boolean |
| `smallint`, `integer`, `bigint` | integer | number |
| `text[]`, `jsonb` | text (JSON) | array / object |

TypeScript cannot tell an integer from a real, so a database test only allows the types above; a new type fails until the generator maps it. Zod validates every boundary: repository inputs, rows read from SQLite and values being uploaded (PostgREST rejects `'["a"]'` as text for a `text[]`; the codec converts it to real JSON). Sync Streams options: `edition: 3`, `timestamp_max_precision: milliseconds` and `fixed_booleans_in_json` (a `true` inside `jsonb` is not turned into 1).

### 4. Sync Streams

```yaml
config:
  edition: 3
streams:
  user_data:
    auto_subscribe: true
    queries:
      - SELECT * FROM profiles WHERE id = auth.user_id()
      - SELECT * FROM files WHERE owner_id = auth.user_id()
      # … one per table with owner_id; deleted_at is not filtered
```

Each user receives everything they own, soft deletes included, plus their profile. Integration tests prove that user B receives nothing from A and that a second device of A receives deletes and the profile. If annotations get too heavy, they can later be requested per score with subscription parameters.

### 5. Upload connector

- **PUT** → `upsert` of the full row by `id` (null columns sent as `null`). **PATCH** → `update` of only the changed columns (`ignoreEmptyUpdates` avoids empty PATCHes). `updated_at` is never uploaded.
- **`profiles`** → `update` of `display_name`, `locale` and `instruments` only; anything else is dropped and logged.
- **`events`** → a PATCH touching any date column (`all_day`, `starts_at`, `ends_at`, `time_zone`, `start_date`, `end_date`) is completed with the others from the local row, so two crossed edits never mix the timed and all-day date forms.
- **DELETE** is never sent: it is logged and completed. Since the server did not change, **the row comes back by itself** on the next sync (verified with the Node SDK).
- A PATCH whose row does not exist on the server is logged (`not-found`) instead of silently lost.

**Failure classification** (`classifyUploadFailure`, a pure function with tests for every class):

| Case | Decision |
|---|---|
| No response (status 0), 5xx, 408, 429, 401 and PGRST301-303 (token), `42501` with 401 (request went out as `anon`), classes `08`, `40`, `53`, `55`, `57`, `58`, PGRST000-003 | Retry |
| `PGRST204`, `PGRST205`, `PGRST202`, `42703`, `42P01`, `42883` (stale schema) and unknown codes | Retry (our bug; discarding would lose data) |
| `23505` | Resolve per table |
| `23514`, `UA001`, `42501` with 403, `23503`, `23502`, other `22xxx` and `23xxx` | Discard and log |

HTTP status alone never discards. Without a Supabase session the connector sends nothing; the queue waits and counts towards the stalled warning. Discards go to a local `sync_errors` table (table, id, operation, code, reason, message, details and data) and leave the queue, which keeps moving. For a `23503` the missing parent is recorded: **with RLS on the parent table, Postgres omits the key values** from the message, so the parent is inferred from the constraint name and the generated foreign keys.

**Product requirement: the user must know when sync is not happening.** Non-network retries use exponential backoff (5 s → 5 min). After **5 consecutive failures of the same operation or 10 minutes**, the state becomes "stalled" with the code and table, it is logged **once** in `sync_errors` (`kind = stalled`), and retries continue in case the server is fixed. Being offline does not count as stalled. PowerSync's docs discourage a client-side reject queue because nobody reviews it; `sync_errors` is the spike's answer, and in the second phase those records must reach an error service or a server table.

**`23505` per table:** the connector fetches the live server row by its natural key, stores "local id → server id" in `sync_id_remaps`, and applies it to that operation and every later one that mentions it (foreign keys included).

| Table | Key | Resolution |
|---|---|---|
| `files` | `sha256` | Reuse (same PDF; the file on disk is addressed by hash) |
| `tags` | `lower(name)` | Merge: fetch all live tags (cursor pagination on `id` until an empty page, since PostgREST caps responses at `max_rows`, 1000 locally; tested with 1100) and compare with `toLowerCase()` in JS. Never `ilike`, where `%`, `_` and `\` are wildcards (`50%`, `a_b`, `x\y` tested) |
| `page_settings` | `(score_id, page_index)` | Merge |
| `score_tags`, `collection_items` | Id pair | Reuse |

A colliding PATCH (renaming a tag to another tag's name) is discarded and logged (`duplicate`). If the server reports `23505` but the colliding row cannot be found (deleted meanwhile, or the server's `lower()` differs from `toLowerCase()`), the write is **not** discarded: it is retried and, if it persists, shown as stalled. Rows returned by PostgREST are validated with Zod (at least a UUID `id`).

### 6. Conflicts and clocks

- Offline, the repository writes `updated_at` with the device clock, only for ordering. PowerSync does not overwrite local rows while uploads are pending, so the user sees their change. On upload the server sets its own `updated_at` (arrival time), which is what syncs down: **an edit made offline days ago shows up as "just edited"**. `created_at` keeps the device time.
- **Last-write-wins per column, in server arrival order**, not per row, because PATCH carries only what changed. Tested with two devices: title on one and composer on the other are both kept; if both change the title, the last to upload wins even if it edited earlier; a soft delete holds even if another device edits later offline. Acceptable for metadata: annotations are one row per stroke, so two devices do not overwrite each other. If other semantics are ever needed: the SDK's `trackPrevious` or an explicit edit-time column.

### 7. No-account mode

- Pattern from the PowerSync docs: every table with `owner_id` has a `localOnly` twin `local_<table>` (its writes never enter the queue). Both always exist and only the `viewName`s are swapped with `updateSchema()`; renaming tables or flipping `localOnly` would make PowerSync drop data (a test guards this).
- Without an account, `owner_id` is the nil UUID. On sign-in (`linkAccount`), in one transaction: `INSERT … SELECT` into the synced tables with the user's `owner_id`, parents first (score sections after their book), delete the local rows (local only, nothing uploads) and store the mode in a local `sync_state` table. The transaction still runs in local mode (synced tables are reached as `inactive_synced_<table>` and still enqueue); then the views are swapped and anything written meanwhile is moved. A per-database mode lock, also taken by repository writes, ensures no write falls into the gap between copy and view swap, where an UPDATE would hit zero rows (found in review). Reads do not wait. If the app dies before commit, data stays in the local tables; if after, `applyStoredMode` finishes the move on startup.
- Internal local-only tables, identical in both modes: `sync_errors`, `sync_state`, `sync_id_remaps` and, later, `device_settings` (reader and device settings, ADR-013 §6). Signing out (`unlinkAccount`) deletes synced data and pending uploads, after a confirmation when uploads are pending (final behaviour in the second phase). The spike uses email and password with local Supabase Auth.

### 8. Repositories

The domain package holds the Zod models of `files` and `scores` (mirroring the database CHECKs; lengths counted in code points, like `char_length`), `uuidv7()` and the `FilesRepository`, `ScoresRepository` and `Repositories.transaction` interfaces, free of React and PowerSync. `importScore` reuses the live file with the same content and creates the score in one transaction. The sync package implements them over the views, which work in both modes. A test asserts that no statement is a DELETE. Layer, annotation and device-settings repositories were added later (ADR-013 §5 and §6).

### 9. Mobile app

A single local database file (the SDK allows one instance per file), opened in its stored mode without touching the network; a Supabase client with the session in AsyncStorage and token refresh only in the foreground; `crypto.getRandomValues` from `expo-crypto` when Hermes lacks it. Only public configuration ships in the client (Supabase URL, publishable key, PowerSync URL); no `service_role` anywhere. Unencrypted local traffic is allowed in debug builds, and in release builds only behind an explicit build-time flag (for measuring against the local environment; a test checks it is off by default). iOS will need `NSAllowsLocalNetworking`. Only callback-based `watch` and `getNextCrudTransaction()` are used, so the async-iterator polyfill and Babel plugin are not needed.

### 10. Compatibility with Expo SDK 58 / React Native 0.88

`@powersync/react-native` 2.4.0, `@powersync/common` 2.5.0 (single copy), `@op-engineering/op-sqlite` **18.2.5** (the SDK requires `<19`; latest is 19.0.4), `supabase-js` 2.119.0, `@react-native-async-storage/async-storage` 2.2.0 and `expo-crypto` 58.0.7, within the pinned toolchain versions and the minimum release age policy. They build and run on the Android emulator with the New Architecture: development build (16 min 31 s locally) and release measurement build (21 min 26 s). **The fallback to SDK 57 is not needed.**

### 11. Tests

- Unit: the generator, schema, codec, classifier, upload health, conflicts, connector (against a real Node SDK PowerSync database and a fake server), repositories and no-account mode. The Node SDK uses Node 24's `node:sqlite` driver, so nothing is compiled.
- Integration (CI job `sync`): Node "devices" against local Supabase and PowerSync, covering no account → session → offline → online; Sync Streams; per-column LWW; delete vs edit; same PDF and same tag on two devices; real rejections. On a pull request the job runs only when the database migrations, the sync package, the PowerSync infrastructure, the generated database types, the root manifest, the lockfile, the Node version file or the CI workflow change; on pushes to the main branch, always. **Accepted risk:** the tests also import the domain and annotation packages, which are left out of the filter because almost every PR touches the domain package; a break is caught by the post-merge run and fixed right away.
- **SDK trap:** locks are keyed by file name. Two databases with the same `dbFilename`, even in different folders, block `connect()`; tests use unique names.

### 12. Web

Out of the spike. Proposal: the management web app (after 1.0) runs online and queries Supabase directly under RLS behind the same domain repositories; PowerSync Web only if the web needs offline support.

## Results

### Manual test on the emulator (tablet, Android 15)

All scenarios passed: no account (data survives restarts), account creation (local data moves to the account), airplane mode (queued, uploaded on reconnect), four provoked rejections (queue keeps moving; DELETE reverts by itself), a two-device conflict (title from the last uploader, composer from the other) and sign-out with pending changes (asks for confirmation). Found and fixed:

- An invalid local row (written bypassing Zod) failed the whole list query. Reads now skip the row and report it (`onInvalidRow`); it reappears once the server state comes back. The screen also missed the mode change on sign-out; Supabase `signOut` now uses `scope: 'local'` (no network).
- Clock skew: the emulator was a week behind and two hours ahead; the Docker VM was 20 minutes ahead. Ordering by `updated_at` mixes two clocks while changes are unsynced, so "most recent" lists can be out of order; `created_at` and UUID v7 timestamps carry device time and must not decide conflicts.

### Realistic volume

500 scores with one layer each and 20,000 strokes of 50 points (~1.6 KB of JSON per stroke; 14 MB in Postgres).

| | First sync | JS thread during sync | Local database |
|---|---|---|---|
| Node SDK on the PC (reference, 3 runs) | 5.7 · 7.5 · 14.0 s | — | 85.7 MB + 43.5 MB WAL |
| Emulator, development build, list visible | 15.3 s | max 157 ms · p95 48 ms · 29 of 656 ticks > 50 ms | 85.7 MB |
| Emulator, release, list paused (sync alone) | 7.8 s | max 116 ms · p95 20 ms · 3 of 372 ticks > 50 ms | — |
| Emulator, release, list visible (library open) | 7.1 s | max 59 ms · p95 24 ms · 2 of 298 ticks > 50 ms | 85.7 MB |

- **Size:** half is `ps_oplog` (40 MB, PowerSync's copy of server state, by design) and half the data (`ps_data__annotations`, 39 MB): about 4.3 KB on the device per 50-point stroke. **Consequence:** the annotation model needs a compact point encoding (e.g. delta-coded integers), not a JSON array of decimals (see ADR-008).
- **JS thread:** the SDK already processes sync in Rust inside SQLite (`powersync_control`); only networking and our screen run in JS. In release, p95 stays under 25 ms, but there are 2–3 pauses of 59–116 ms during the first sync: a page turn coinciding with one could exceed the 50 ms budget.
- **Page turns during sync** (reader test screen, warm cache, pedal input): max 19.9 ms and p95 18.3 ms, the same as without sync; only part of the 56 and 84 samples overlapped the 7 s sync.

## Decision

PowerSync with Sync Streams, a custom connector over PostgREST, and a no-account mode with local twin tables fits the app: it works offline, converges across devices under the database conventions, and the first sync of a large library takes seconds without blocking page turns in tests. `updated_at` keeps the server clock, and the real semantics are documented: last-write-wins per column, in arrival order.

## Risks and open questions

- Production: PowerSync Cloud or self-hosted, and the role password on the remote; product UI for "sync stalled" and for signing out with pending changes; cleanup of `sync_id_remaps` and old soft-deleted rows (trash). All in the second phase.
- `sync_errors` lives only on the device and stores rejected row data, so `unlinkAccount` clears it (with `sync_id_remaps` and `device_settings` entries naming a score or setlist); it must later be sent to an error service or the server.
- iOS untested until a Mac is available (including `NSAllowsLocalNetworking`).
- JS thread pauses of up to ~116 ms during the first sync (emulator). To be measured on iPad and iPhone 12; if confirmed, try the SDK's WebSocket transport with BSON, compact stroke encoding, or deferring the first sync while the reader is in Stage mode.
- Compact encoding of stroke points in the annotation model (resolved in ADR-008). The device clock is unreliable: never order conflicts by `created_at` or UUID v7.
- **Reloading JavaScript leaves the local database locked:** the previous native instance stays open and the SDK allows one per file, so the new one waits forever. The database must be `close()`d before reloading; to be fixed in the first phase, before enabling OTA updates.

## Consequences

- Every new table joins the publication and requires regenerating the local schema. Repositories never issue DELETE, and the connector never uploads one.
- Screens read and write only through the domain repositories; PowerSync can be replaced by implementing those interfaces.
