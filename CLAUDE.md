# Bazaar SDK — project instructions

## Comment conventions

These rules are mandatory for every comment you write or edit in `packages/*/src`, `packages/*/test`,
and `scripts/`.

### 1. Comments describe the CURRENT implementation. Nothing else.

A reader should be able to understand the code in front of them without knowing anything about how
it got there. Never write:

- **Audit references** — finding IDs (`K1`, `T4`, `F3`), "per the audit", auditor names, or
  remediation status.
- **Prior implementations** — "the old behavior", "the Python keeper did X", "this used to retry
  here", "X was removed", "replaces the prior `pendingCost`".
- **Refactor history** — "moved from engine.ts", "ported from `bazaar_sdk`", "split out of
  trade.ts". Say what the code *is*, not how it got to this file.
- **Session/chat references** — never mention Claude, a conversation, a prior session, an agent, or
  a task.
- **Test names** — `... (see the "budgets hold under concurrency" test)`. Tests are found by
  searching, and test files get renamed.
- **Dated measurements** — "measured 2026-11-08: 0.5 ms", "verified on Anvil 2026-11-09". Keep the
  fact, drop the timestamp and the provenance narration.
- **External precedent name-drops** — "matches viem's pattern". Explain the reasoning instead.

**The rewrite pattern.** Almost every history comment is a defense rationale wearing the wrong
tense. Turn the past tense into a counterfactual — same information, no archaeology:

```ts
// BAD  — describes a bug that no longer exists
// The transport used to retry eth_sendRawTransaction, which sent some transactions twice.

// GOOD — describes why the current code is shaped this way
// Sends are never retried by the transport: a retry after a lost answer would resend a
// transaction the node already accepted, and the executor would sign the action again.
```

### 2. Verify every claim against the code before you write it.

Comments drift silently — nothing compiles them. Before writing or keeping a comment, check it:

- **Names must exist.** Grep them: functions, constants, options and config keys here, and every
  contract, library, function, error or constant of Bazaar's you cite (in `../bazaar/src`). Do not
  write `MAX_CANCELS` when the constant is `MAX_CANCELS_PER_CALL`, or `BucketLib.calcState` when it
  is `BucketLib.calculateState`.
- **Numbers must match the source.** If you write "3 s", "10 s deadline" or "$1 relayer fee cap",
  read the constant (here, and in the contract it mirrors). If you write "max($0.05, 2 bp)", confirm
  both terms and the `max`.
- **Units must match.** BAZAAR precision (18 decimals) vs USDC units (6), seconds vs milliseconds,
  `bigint` vs `number`. A comment that says "USDC" over an 18-dp value is wrong.
- **Sentinel semantics must match.** `(0 = none)` is wrong when the no-op value is `MAX_UINT256` or
  `null`.
- **Direction of money/state must match.** "pays the keeper from insurance" is wrong when the
  reward lands on the caller's claimable balance and insurance is only the source.
- **Lists of enforced checks must be complete and correct.** Don't claim a validation, a lock or a
  budget check that isn't there.

If a comment and the code disagree, the code wins — fix the comment, and check whether the
disagreement is actually a bug before you do. Where the SDK mirrors a contract, the contract wins:
check the comment and the code against `../bazaar/src`.

### 3. Do not cite volatile numbers.

Latencies, benchmark timings, bundle sizes, test counts and request counts go stale within a commit
or two. "Print to send takes 50 ms" and "655 tests" become lies quickly. Write the durable reason
instead: "planned on each print, so no tick delay sits on the hot path". If a performance constraint
genuinely matters, say so qualitatively and point at how to measure it.

### 4. TSDoc hygiene.

- Attach the block to the **right declaration**. An interface's doc goes on the interface, a
  field's on the field, a function's on the function. Check what the block actually sits above.
- One summary per block, then details. Two summaries is a sign that two declarations' docs got
  merged — split them and reattach.
- `@param` / `@returns` / `@throws`, where used, must **cover the full signature** and use the real
  names.
- When you edit a signature, edit its TSDoc in the same change.

### 5. Length follows subtlety, not habit.

A 20-line comment is fine above a genuinely subtle invariant (`terminateScheduledPair`'s print
selection and the executor's budget reservation both earn theirs). A 6-line comment restating what
the next line obviously does is not. Cut filler, restated code, and hedging — never cut load-bearing
reasoning to hit a length target.

Every paragraph should answer "why is the code this way", "what breaks without this", or "what
invariant does this hold". If it answers none of those, delete it.

## Generated files

Never edit these by hand; regenerate them:

- `packages/sdk/src/abi/*.ts` — `npm run sync-abis -- ../bazaar`
- `packages/sdk/src/probe/artifact.ts` — `npm run build-probe` (solc 0.8.34)
- `packages/sdk/src/client/bindings.generated.ts` — `npm run gen-bindings` (a unit test fails when
  it is stale)

### Pre-commit checklist

- [ ] No audit IDs, prior implementations, refactor history, dates, chat or test references.
- [ ] Every named function/constant/contract exists; every number and unit matches the source.
- [ ] TSDoc sits on the right declaration; tags complete, no duplicates.
- [ ] No volatile timings, sizes or counts.
- [ ] `npm run typecheck:check` and `npm test` are clean.
