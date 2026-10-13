# DSH 0.2.0-rc.2 compatibility validation

Candidate based on upstream 1.6.0 at
`79932887601c9553ef668be93f129cc1527af34b`. Package and source identity remain
`dsh-agent-message`; no npm version or release is published by this contribution.

Target: the installed macOS DSH 0.2.0-rc.2 / Electron Node 24.18.1.

## Results

| Check | Result | Evidence boundary |
| --- | --- | --- |
| Regression suite and package allowlist | **47 passed, 0 failed, 0 skipped** | Installed Electron Node; real rc.2 SessionQuery included; only 10 reviewed package files |
| Dependency audit | **0 advisories** | pnpm audit of the reviewed lockfile; 91 development dependencies, no runtime dependency installation hooks |
| Fresh native profile | **10 assertions passed** | Packed candidate installed through the official CLI into a new temporary home |
| Official Session reference | Passed | A canonical mention captured the exact B ID and its ready text in a native session-reference message |
| Cold A→B→A→B | Passed | Actual Agent loops and tool dispatcher with an offline deterministic model; B ends with FIXTURE_APPROVED |
| Receipts and fork ownership | Passed | All three messages claimed through public SessionQuery; a fork cannot claim its parent's Inbox prefix |
| Default-deny authorization and lifecycle | Passed | Configured pairs, identical cwd, archive/cancellation checks, asynchronous resume races and sender-specific receipts |
| Durable finite budget | Passed | A fourth message denied; restart preserves denial without loading cold B or calling a model |
| Real Settings form | Passed | Only the volatile display boolean is projected; allowedPairs is excluded. Public update changes rendering live without remounting tools; messageId remains |
| Isolated Web settings UI | **Passed** | The form appears under its own installed dsh-agent-message bundle, saves an unchecked preference, and the native profile patch reads back false |
| rc.2 relay and keyboard navigation | **Passed** | A native turn-trigger shows literal FIXTURE_FIX_1 with a real sender link; Enter opens the correct B Session |
| Header clipboard | **Passed** | Actual browser clipboard matches the full B ID |
| Sidebar row clipboard | **Passed** | B remains selected while A's row menu copies the exact full A ID; menu closes without changing selection |
| messageId visibility | **Passed** | The native trace still shows the actual messageId with technical details disabled |
| Main desktop replacement | **Passed** | Official CLI removed dsh-cross-session-agent and installed this fork; all 10 packed files match the desktop installation. The existing pair, unrelated profile fields and bundle position were preserved |
| Online native `@` review loop | **Passed** | A fresh A/B pair on the current online Flash route completed review → fix → reply → independent re-review; 9 pass / 1 fail became 10 pass / 0 fail |
| Online full Session ID review loop | **Passed** | A separate defective implementation completed the same loop with a plain full target ID and no new mention; 9 pass / 1 fail became 10 pass / 0 fail |
| Reference-only controls | **Passed for both entries** | Native `@` and plain-ID discussion prompts made no sends, added no relays and left A's native log unchanged |
| Online transport and termination | **4 of 4 relays claimed; 10 peer calls succeeded, 0 errors** | All three peer tools exercised; both final approvals followed the claimed reply and actual read/test calls. No acknowledgement loop |
| Main desktop row clipboard | **Passed** | A's sidebar … menu copied its exact full ID while B remained selected; the menu closed. Header copy passed for both Sessions |

The UI uses the public bundle-configuration slot and configForms. The source
retains GengDaPeng's locale, display preference, selectable messageId and original
three-tool messaging scope. Session references remain owned by Harness.

The first Web and deterministic native tests used separate temporary profiles.
After those passed, the personal desktop's cross-session fork was removed through
the official CLI and replaced with this original-project fork. Their three global
tool names were never intentionally installed together. The two fresh desktop
Sessions, real implementation edits and online results above belong to
`dsh-agent-message`, not to the other fork's earlier validation.

Both test files retained their original SHA-256 throughout the online run; the
final independent acceptance is **20 passed, 0 failed** across the two files.
Relay source identity and the configured coordination ID remained intact. The
temporary test pair was then removed, retaining the pre-existing pair and
restoring the migrated profile patch byte-for-byte. No application restart or
app.asar modification was needed.

The tested profile's standalone `pnpm peers check` reports five missing core
packages in the profile. DSH supplies them from its host: Cordis 4.0.4,
Schemastery 3.18.4 and dsh-llm/tools/settings 0.2.0-rc.2. Their installed versions
were checked, and the real host/client calls above exercised this resolution.
This report does not claim that standalone peer check passes.

The online tests used the user's already configured Flash routing group. They
establish behavior for that route and DSH version; they are separate from the
offline deterministic runner and do not establish behavior for every model.

## Reproduce

```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm test
node scripts/live-profile-e2e.mjs /path/to/dsh
```

The native runner packs this source, installs into a new temporary DSH_HOME,
boots and restarts its own profile, and uses real Agent/tool/SessionQuery/JSONL
services with a deterministic offline model. It never submits to personal
Sessions or modifies an existing profile. Transport and task completion are
checked separately. Exact temporary profiles and logs are excluded from the
repository and package.
