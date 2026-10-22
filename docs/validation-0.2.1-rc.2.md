# DSH 0.2.1-rc.2 compatibility validation

This candidate starts from the reviewed fork commit
`5604a5f630b9835a40b75c9d4157597cc94cccf9` (upstream 1.6.0 at
`79932887601c9553ef668be93f129cc1527af34b`). Package/source identity and version
remain `dsh-agent-message` 1.6.0. No npm release is published.

The compatibility target is DSH 0.2.1-rc.2 and Node 24. Results below belong to
the current candidate; the older 0.2.0 report records a separate historical run.

## Results

| Check | Result | Evidence boundary |
| --- | --- | --- |
| Regression and package allowlist | **53 passed, 0 failed, 0 skipped** in each of three runs | Installed dependencies with independent Node 24.19.0; exported installed SDK with host Node 24.21.0; direct installed ASAR with Electron Node 24.21.0 |
| Native Session and current directory | Passed | Actual `workingDirectory.set`, Session projection registry and JSONL persistence; cold `prepared` observation retains the current directory while immutable `header.cwd` stays unchanged |
| Exact pair and original-project boundary | Passed | Default deny, unpaired and subagent denial, sender-scoped receipts, and no additional reachability when different original projects move to one directory |
| Current-directory lifecycle | Passed | Missing projection and changed caller/target directories deny access; asynchronous observation, title and resume rechecks prevent a stale authorized send |
| Fresh native profile | **12 assertions passed** across initial and restart phases | Candidate tarball installed using the official DSH 0.2.1-rc.2 CLI into a new temporary home |
| Actual Agent/tool loop | Passed | Offline deterministic provider completed A → cold B → A → B; three format-V4 tool results succeeded and the terminal response was `FIXTURE_APPROVED` |
| Provenance, receipts and fork ownership | Passed | All three relays retained real sender/target/coordination IDs and were claimed; a fork did not claim inherited parent Inbox history |
| Native references | Passed | Native `@` produced the official exact-ID snapshot; deterministic `@` and full-ID reference-only turns made no sends and did not resume or change cold B |
| Live/cold current-directory denial | Passed | Actual native `workingDirectory.set` changed a fork's current directory; sends, receipt reads and discovery were denied both live and after disposal to native persistence, without a relay or resume |
| Native display setting | Passed | Volatile display edit changed result rendering without replacing the tool or exposing `allowedPairs`; messageId stayed visible |
| Cancellation, archive and finite budget | Passed | No canceled/archived delivery; a fourth relay was denied; after the disposable server restarted, exhausted cold B stayed unloaded and no model was called |

The native run used 10 local deterministic provider calls during the initial
phase and zero after restart. Online model requests were zero. These checks do
not repeat the older desktop browser interactions or online model acceptance;
the current change does not modify client code. No formal desktop installation
or existing-session acceptance is claimed for 0.2.1-rc.2.

## Contract changes

- The host still owns Session identity, history, Inbox, receipts and approvals.
- Exact `allowedPairs`, matching nonempty original `header.cwd`, archive and
  subagent checks remain required. Matching current directories alone never
  authorizes different original projects.
- The public `workingDirectory` projection must also be present and match for
  both peers. Live checks use `sessionProjections.stateOf`; cold reads use
  `sessionQuery.observeSession` so directory and Inbox events share one prefix.
  Every observation lease is released. Directory changes during observation,
  title lookup and resume are checked again before delivery or discovery.
- Native format-V4 tool results use role `tool` and carry `toolCallId`. The deterministic
  fixture checks real tool dispatch against this public shape.
- JSONL persistence is mounted through its public plugin module
  (`apply`/`name`/`Config`), including in the native regression.

## Reproduce

```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm test
node scripts/live-profile-e2e.mjs /path/to/dsh
```

The native runner installs a packed candidate into a fresh temporary `DSH_HOME`,
starts its own local Web profile, and restarts only that disposable profile.
The deterministic provider makes no online model requests. It exercises real
Agent loops, tool dispatch, SessionQuery, working-directory state, settings and
JSONL; its reference-only controls do not establish online-model compliance.
No personal profile, plugin installation or existing Session is modified.
