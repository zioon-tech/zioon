# Workbench responsiveness

## Behavior and consistency

- Desktop updates announce availability and wait for an explicit reload. Reload must finish saving; a slow or failed save keeps the current page open.
- Collaboration must accept input while connecting without publishing a stale full-document snapshot. Hydration uses the server baseline and replays only edits made after opening. Overlapping edits must preserve a recoverable local draft instead of overwriting either side. Late synchronization must recover after the initial timeout.
- Submission preserves the original assistant interaction without synthetic preparation text. Preparation and run cancellation share one lifecycle. Tool policy reads and session saves must retain account and revision boundaries.
- Session browsing needs bounded rendering and server search. Full tree metadata currently supports move, reveal, folders and tabs; pagination must not silently turn an incomplete catalog into a complete tree or delete unseen nodes.

## Test workflow

Step1 complete: existing Vitest setup, temporary skill artifacts prepared.
Step2 complete: JavaScript/TypeScript; no project AGENTS/CLAUDE test conventions found.
Step3 TARGETS (scope_type: non_diff; unrelated existing tool lifecycle changes excluded):

| file_path | target_type / symbol | locator | source | reason | hunks |
| --- | --- | --- | --- | --- | --- |
| public/sw-client-refresh.js | file / activate handler | activate listener | explicit | unexpected desktop navigation | [] |
| src/runtime/workbench-pwa-upgrade.ts | function / installWorkbenchPwaUpgradeRecovery | exported function | explicit | safe update and protocol recovery | [] |
| src/main.ts | function / reloadWindowPreservingWorkspace | local function | explicit | durable reload barrier | [] |
| extensions/dev.session-manager/collaboration-client.js | function / createSessionCollaborationManager | exported function | explicit | input and late sync | [] |
| extensions/dev.session-manager/editor/autosave-plugin.js | function / createSessionAutoSavePlugin | exported function | caller_callee | pending draft ownership and save scope | [] |
| extensions/dev.session-manager/editor/pending-assistant-plugin.js | file / pending assistant widget | widget implementation | explicit | preparation feedback | [] |
| extensions/dev.tools/main.js | function / syncEnabledToolsFromRuntimeProfile | exported function | explicit | policy reads | [] |
| extensions/dev.session-manager/ui/list-renderer.js | function / createSessionListRenderer | exported renderer | explicit | bounded list work | [] |
| extensions/dev.session-manager/ui/sidebar-view.js | file / sidebar view | getQuery binding | explicit | searchable browsing | [] |
| apps/runtime/src/postgres-workbench-state-store.mjs | method / readCatalog and session search | store methods | explicit | bounded metadata and search | [] |
| apps/runtime/src/workbench-state-http-handler.mjs | function / HTTP handler | catalog and sessions routes | caller_callee | search API | [] |
| src/ui/workbench/commandPalette.ts | function / scheduleContentSearch | local function | explicit | eliminate serial document downloads | [] |

Step4 BUG_MAP:

| severity | defect_type | file / target | scenario, evidence, correct outcome |
| --- | --- | --- | --- |
| P1 | Business Gaps | sw-client-refresh.js / activate | [defect-probing] Updating a worker with an open desktop draft must notify the client without navigating; current activate calls client.navigate unconditionally. |
| P1 | Error Handling | main.ts / reloadWindowPreservingWorkspace | [defect-probing] A save exceeding 1800ms must cancel reload; current timeout logs a warning and falls through to location.reload. |
| P1 | Logic Errors | collaboration-client.js / bindEditor | [defect-probing] A provider syncing after the deadline must reconnect; current timedOut guard permanently discards synchronization. |

Waiting for tool configuration and full catalog downloading are measured implementation costs, not classified as correctness defects.

User explicitly authorized production fixes; the test skill's restriction to test-only edits applies to its test loop, while the separate implementation work fulfills that authorization.

## Implemented user experience

1. Service worker activation announces an update without navigating desktop clients. The update action saves before reloading; failures and deadlines keep the page open. Protocol recovery checks saves again after waiting for worker activation and marks the navigation URL to prevent repeated recovery loops.
2. New sessions remain editable while collaboration connects. CodeMirror changes are replayed against the authoritative server baseline, including late synchronization. Overlapping changes remain local, with an action to restore the draft as a new session. Mirrored split-view edits are applied once; a remaining conflicting split view blocks submission and reload.
3. Clicking send preserves the original assistant presentation while retaining cancellation during preparation. Tool configuration reads have a 15-second cache scoped to Runtime, profile, account and role, invalidated by local selection changes. Saving waits for this session and necessary tree writes while preserving queue ordering. Hydration happens before assembling messages; changed content during preparation requires the user to submit again. Seed history and contributor-enriched history are prepared concurrently and remain separate.
4. Lists initially mount 100 session rows and automatically append batches near the scroll bottom, preserving scroll position. Current, selected, revealed and inline-edited rows remain reachable. The sessions sidebar uses the existing activity search rather than adding another search field. The standalone sessions panel supports debounced content search, pagination, single-character Chinese queries, stale-response rejection, and loading/error/empty states. The command palette uses the same bounded server search instead of serial document downloads.

Bound collaboration retains ownership during disconnection: autosave never publishes the disconnected editor as a full HTTP document. A local draft is retained until provider acknowledgement. Remote Yjs updates do not create local drafts. Draft storage is scoped by Runtime/account/space/session and a tab identifier stable across reloads. Access changes preserve editor content under the old identity, offer a download, stop remote writes and collaboration, and require explicit reentry. Reload preparation checks editor contents across asynchronous saves and retries a bounded number of times when input changes.

## Scale and rollout boundaries

- The complete tree, basic index and revision identities remain available to preserve existing move/delete/reveal/folder behavior. This is bounded **row rendering and content search**, not a fully paginated tree or virtual scrolling. Folder nodes and traversal still grow with catalog size.
- Startup requests at most 100 richer summaries; unopened documents and full metadata load on demand. PostgreSQL selects only allowed summary keys for catalog/search/index paths, without transporting annotations or body text when stored size/hash are available.
- Search uses literal, case-insensitive substring matching within the authenticated space. It returns at most 100 results per page. Offset pages can shift while other clients modify sessions, and substring matching still scans candidate text. Large-scale search will need an indexed search strategy with equivalent Chinese matching behavior. Command palette results are capped at the first 100 matches; full browsing uses the sessions views.
- Local recovery depends on available browser storage. Access-change content can be downloaded before reentry. Conflicts deliberately require restoration or reopening rather than silently overwriting remote content.
- Frontend and Runtime must ship together for the search endpoint. No schema migration is required. Previously installed service workers contain the old activation behavior until the new worker is installed; an already-installed old worker cannot be changed retroactively.
- The first release was deployed as `workbench-responsiveness-20261012`; subsequent interaction corrections are tracked separately. Controlled local preparation timings are not production end-to-end latency measurements.

## Verification report

Scope: update/reload, collaboration/drafts, autosave/save scope, preparation feedback, catalog summaries and session search. Existing unrelated tool execution lifecycle changes remain outside this report.

Defect analysis: the initial three P1 findings were automatic desktop navigation, reloading after the save deadline, and discarding late collaboration synchronization. Added checks cover overlapping drafts, disconnected autosave ownership, split-view duplicate replay/conflict fences, and outdated search responses.

Generated cases: 18 additional executed cases relative to HEAD across the relevant test files (including parameterized collaboration scenarios). Existing worker behavior expectations were updated. Generated scenarios cover preparation status lifecycle, late replay, overlap recovery, split-view deduplication, conflicting-view flush, offline acknowledgement, pending/disconnected autosave, scoped flush, partial catalog hydration, bounded rows, protocol save/loop protection, permission-change draft preservation, and search pagination/stale results.

Step5 generation → verification → repair: focused 97/97, subsequent boundary suite 36/36, expanded 159/159, final 162/162 Workbench tests in 19 files; real PostgreSQL catalog/projection regression 6/6 in two files. Final total: **168/168 passed**. The final PostgreSQL suite checks owning-space isolation, pagination, literal wildcard characters, Chinese matching and catalog body/annotation exclusion. Tests use code/DOM harnesses; no interactive browser automation.

Step6: coverage statistics skipped under the skill's applicable rule: no requested coverage threshold or project gate, and execution source is not flux. No coverage percentage is claimed.

Step7: `utree flush` was executed with the prepared task directory. It failed because the sandbox rejected helper writes under the global skill directory and the temporary directory outside the workspace. Verification results are recorded here; the helper report upload did not complete.

Final build: `npm run build` succeeded, including PWA output. `git diff --check` passed. `tsc --noEmit` remains unsuccessful with 11 pre-existing errors (missing JavaScript declarations and incomplete EditorProxy typing); no newly introduced TypeScript errors were observed. Existing large-bundle and outdated Browserslist notices remain. Successful commands also emitted trailing TRAE launcher diagnostics with code 60002 despite process exit 0; the recorded test/build status comes from their actual exit codes and runner summaries.
