# EasyEmail development instructions

## Scope and precedence

- This file applies to the entire EasyEmail repository.
- Read `docs/DEVELOPMENT_STANDARD.md` before designing or reviewing substantial changes.
- A nested project may add stricter rules, but it must not weaken the repository-wide requirements for new or modified code.
- Machine-readable policy and `scripts/effective-code-lines.mjs` are authoritative when prose and checker behavior differ.

## Effective code lines

- Effective lines exclude blank lines, comment-only lines, and lines wholly inside multiline comments.
- A line containing code plus an inline comment still counts.
- The language-aware checker result wins over manual counting.
- Target about 150 effective lines per file; 100-250 is the recommended range.
- 251-500 lines is acceptable when the file still owns one clear responsibility.
- 501-700 lines is a soft exception requiring a current, exact, independently approved exception record.
- 701-1500 lines is mandatory split territory for new or modified files.
- More than 1500 lines is a hard violation and cannot be waived.
- The policy covers handwritten production code, tests, scripts, styles, UI components, migrations, and executable configuration included by the machine policy.
- Do not game the policy with generated formatting, arbitrary file slicing, forwarding-only fragments, or vague `common`, `utils`, and `helpers` buckets.

## Legacy debt and ratchet

- The baseline records existing oversized files; it does not declare them well-designed.
- An unchanged oversized baseline file may remain temporarily in ratchet mode.
- Do not add a new responsibility to an oversized legacy file. Put the responsibility in a cohesive module, normally at or below 500 effective lines, and leave only minimal wiring in the legacy file.
- A narrow correctness, security, compatibility, or wiring fix may remain in place when extraction would increase risk, but avoid net growth.
- A file at or below 700 lines before a task may not cross above 700 because of that task.
- Once an oversized baseline file changes, it must be reduced to 700 lines or fewer before completion.
- Every new or extracted file must be 700 lines or fewer; 500 remains the normal maximum and about 150 remains the target.

## Split boundaries

- Split by responsibility, dependency direction, state ownership, invariants, or resource lifetime rather than equal line ranges.
- Keep domain types and serialization separate from input parsing and validation when they evolve independently.
- Keep business rules and state transitions separate from network, database, filesystem, process, and provider adapters.
- Keep runtime lifecycle and background worker ownership separate from request handlers.
- Keep UI state/effects separate from reusable presentation components and API adapters.
- Split test fixtures, assertion helpers, and integration harnesses when they have independent ownership.
- Preserve stable public facades when moving internals reduces migration risk.

## Required workflow

1. Measure affected files before designing the change.
2. Identify whether the task adds a responsibility to an existing oversized file.
3. Add characterization or regression tests before moving behavior.
4. Make the smallest responsibility-based extraction that satisfies the task.
5. Run `node --test scripts/tests/effective-code-lines.test.mjs`.
6. Run `node scripts/effective-code-lines.mjs --mode ratchet`.
7. Run the task-relevant build and tests, then inspect `git diff --check` and the scoped Git diff.

## Exceptions

- Exceptions apply only to files with 501-700 effective lines and never to files above 700.
- Each exception must record path, exact effective lines, exact source hash, one cohesive responsibility, why further splitting would be harmful, owner, independent approver, review date, and concrete tests.
- Source changes invalidate the recorded hash and require either reduction to 500 or fewer lines or a freshly reviewed exact exception.
- AI agents must not invent approvers, approvals, dates, hashes, or test results.
- Time pressure, historical size, framework conventions, or difficulty are not valid exception reasons.

## Completion evidence

- Report the checker mode and summary, relevant tests/builds, and any remaining unchanged baseline debt.
- Do not claim the repository is fully strict-clean while `--mode strict` still reports violations.
- The rollback point created before introducing this policy is the annotated tag `stable-20260903-pre-effective-lines-migration`.
