# EasyEmail Development Standard

## 1. Purpose

This document defines the repository-wide code organization and effective-line policy for EasyEmail. It applies to the local HTTP service, desktop client and embedded core, independent userscript runtime, TypeScript client package, Cloudflare email center, deployment automation, tests, and supporting scripts.

The policy is incremental. Existing debt is recorded rather than hidden, while new and modified code must move the repository toward smaller ownership boundaries.

## 2. Authority

The following files form one contract:

- `AGENTS.md`: concise contributor and agent instructions.
- `scripts/effective-code-lines-policy.json`: tracked extensions, exclusions, thresholds, and baseline revision.
- `scripts/effective-code-lines-baseline.json`: immutable measurements of oversized files at the migration point.
- `scripts/effective-code-lines-exceptions.json`: reviewed 501-700 line exceptions.
- `scripts/effective-code-lines.mjs`: enforcement and report generation.
- `scripts/effective-code-lines-lexer.mjs`: language-aware counting.

The checker and policy are authoritative if descriptive prose becomes stale. A policy, checker, or lexer change invalidates integrity hashes and requires a reviewed baseline regeneration.

## 3. Effective line definition

Effective code lines exclude:

- blank lines;
- comment-only lines;
- lines wholly inside a multiline comment.

A line containing executable or declarative content plus an inline comment counts. UTF-8 is required, and the checker normalizes line endings before hashing so LF and CRLF checkouts have the same identity.

The machine policy includes handwritten production code, tests, scripts, UI components, styles, database scripts, shell automation, and selected executable configuration. Generated output, dependencies, caches, packaged releases, local runtime state, and test fixtures used only to exercise the lexer are explicitly excluded with reasons.

## 4. Size tiers

| Effective lines | Classification | Required action |
| ---: | --- | --- |
| About 150 | Target | Prefer this scale when it matches one useful responsibility. |
| 100-250 | Recommended | Normal review and verification. |
| 251-500 | Acceptable | Keep only one clear responsibility. |
| 501-700 | Soft exception | Reduce to 500 or record a current independently reviewed exception. |
| 701-1500 | Mandatory split | New or modified files must be split before completion. |
| More than 1500 | Hard violation | No waiver; continue splitting. |

The 150-line target is not a quota. A cohesive 320-line state machine may be better than several forwarding fragments. Conversely, a 120-line file can still be poorly designed if it mixes unrelated state and I/O.

## 5. New and modified code

New code includes new files, modules, components, services, routes, commands, tests, scripts, responsibilities, state, protocol branches, types, functions, and material extensions. Code copied, renamed, moved, or extracted during a task is still new for size review.

Requirements:

1. New and extracted files must not exceed 700 effective lines.
2. Files should normally remain at or below 500 effective lines.
3. Files between 501 and 700 require the formal exception process.
4. A file at or below 700 before a change may not cross above 700.
5. Changing an oversized baseline file invalidates its grandfathered unchanged status; reduce it to 700 or fewer lines.
6. Do not place a new responsibility in an oversized baseline file.

## 6. Legacy migration debt

The migration baseline is a factual snapshot, not an approval of existing design. Ratchet mode permits an oversized file only when its effective count and normalized source hash still match the baseline exactly.

A narrow in-place correctness, security, compatibility, or wiring fix is allowed only when extraction would materially increase risk. Such a change should avoid net growth and must still satisfy the changed-file gate. Larger feature work must extract a coherent ownership boundary first.

Strict mode intentionally ignores grandfathering. It is a progress report until all historical debt is removed and may later become a required gate.

## 7. Responsibility-based decomposition

Prefer these boundaries when they evolve independently:

- domain types, data mapping, and serialization;
- request, command, form, and configuration parsing and validation;
- business rules, state transitions, and orchestration;
- provider adapters and HTTP clients;
- database, filesystem, network, process, and operating-system I/O;
- runtime startup, shutdown, retry, and worker lifecycle;
- UI application state, side effects, reusable presentation, and API adapters;
- test fixtures, assertion helpers, fake providers, and integration harnesses.

Do not split by equal line ranges. Do not create generic dumping grounds or files that exist only to forward one call without owning a stable abstraction. Preserve public facades when they reduce compatibility risk, but move implementation ownership behind them.

## 8. Exception process

An exception is valid only for 501-700 effective lines. It must contain:

- repository-relative path;
- exact effective line count;
- exact normalized-source SHA-256;
- one cohesive responsibility;
- a concrete explanation of why further splitting harms correctness or ownership;
- owner;
- independent approver different from the owner;
- ISO review date that has not expired;
- concrete verification commands or tests.

Any source modification invalidates the exception hash. AI automation may calculate a hash but must not fabricate human approval or evidence. Files above 700 cannot receive an exception.

## 9. Commands

Run the checker tests:

```powershell
node --test scripts/tests/effective-code-lines.test.mjs
```

Run the required incremental gate:

```powershell
node scripts/effective-code-lines.mjs --mode ratchet --json .tmp/effective-code-lines.json
```

Inspect all current debt without failing:

```powershell
node scripts/effective-code-lines.mjs --mode report --json .tmp/effective-code-lines-report.json
```

Inspect strict compliance:

```powershell
node scripts/effective-code-lines.mjs --mode strict --json .tmp/effective-code-lines-strict.json
```

Regenerate the baseline only after an intentional policy/tool migration and review:

```powershell
node scripts/effective-code-lines.mjs --write-baseline
```

Baseline regeneration is not a routine way to accept new debt.

## 10. Change workflow

1. Measure affected files before design.
2. Identify ownership, dependency, state, and resource-lifetime boundaries.
3. Establish behavior-preserving tests before moving existing logic.
4. Extract one coherent boundary at a time and preserve public behavior.
5. Run checker unit tests and the ratchet gate.
6. Run task-relevant unit, integration, build, package, and runtime validation.
7. Inspect the final diff, line endings, generated-file cleanliness, and effective-line report.

CI runs the same checker tests and ratchet gate through `scripts/test-all.ps1` and publishes the JSON report from `.tmp/effective-code-lines.json`.

## 11. Anti-gaming rules

The following do not satisfy this standard:

- compressing code or markup onto fewer physical lines;
- moving code into an excluded or falsely labelled generated path;
- renaming files to an untracked extension;
- arbitrary `part1`/`part2` slicing;
- creating broad `common`, `utils`, or `helpers` modules;
- hiding a new responsibility behind forwarding-only wrappers;
- refreshing the baseline merely because a changed file failed the gate;
- inventing approvals, dates, hashes, or test results.

## 12. Completion criteria

A structural change is complete only when:

- new and modified source files satisfy the effective-line gate;
- behavior and public interfaces remain correct unless intentionally changed;
- task-relevant tests and builds pass;
- CI uses the same required local command;
- remaining debt is unchanged baseline debt or a valid 501-700 exception;
- the completion report states the checker mode and does not misrepresent ratchet success as strict compliance.

The rollback point immediately before this policy migration is `stable-20260903-pre-effective-lines-migration`.
