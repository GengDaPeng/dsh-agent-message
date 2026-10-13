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

The UI uses the public bundle-configuration slot and configForms. The source
retains GengDaPeng's locale, display preference, selectable messageId and original
three-tool messaging scope. Session references remain owned by Harness.

The candidate was **not installed alongside dsh-cross-session-agent in the
personal desktop profile**: their three global tool names overlap. The Web and
native tests used separate temporary profiles. No online-model behavior test is
claimed for this candidate; the separately installed cross-session fork's online
review/fix/re-review evidence is not reused as proof for this package.

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
