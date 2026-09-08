---
name: voice-checks
description: Add or tune a deterministic check, or a rubric dimension, for a spoken conversational agent. Use when adding an automated check for LLM output, deciding whether something belongs in a rule or an LLM judge, tuning a check that produces false positives or fails builds wrongly, writing rubric anchors, or asking what can go wrong with text that will be read aloud.
---

# Checks and rubric dimensions for spoken output

Two instruments, one rule for choosing between them: **if it is decidable, it is
a check. If it needs judgement, it is a rubric dimension.** Nothing goes in both,
and a check that "usually gets it right" belongs in neither.

Reference: `packages/shared/src/checks.ts` and `packages/shared/src/rubric.ts`.

## Voice-specific failure modes

These are what makes evaluating a *spoken* agent different from evaluating a
chatbot, and most suites miss all of them:

| Check | Catches |
|---|---|
| `speakable` | markdown, bullets, emoji, `~40%`, `<`, `>` — things a synthesiser reads wrong or silently skips |
| `single_question` | two or three questions stacked into one spoken turn, which a listener cannot hold |
| `length` | a turn too long to listen to, which is far shorter than one too long to read |
| `asks_a_question` | a turn that never hands the floor back, so the person does not know it is their go |
| `interviewer_register` | assistant voice bleeding in — "feel free to", "thanks for sharing", "great question" |
| `language` | answering in the wrong language for the scenario |
| `not_reciting_context` | reading a retrieved passage back verbatim instead of using it |

Numbers written as digits are a live example: `~40%` is read aloud as
"tilde forty percent" by some synthesisers and skipped entirely by others.

## Precision over recall, always

**A false positive fails a build.** A check that is merely usually right teaches
people to ignore the suite, which is worse than not having the check. Anything
softer goes to the judge.

## A check that cannot fail is worse than no check

It looks like coverage and buys confidence it has not earned.

This is not hypothetical here. `not_echoing` and `not_repeating` sat in every
report for months and could never fire, because the runner never passed them the
context they need. Wiring that context in immediately turned `not_repeating` red
— on a case whose reference turn was **correct**. The candidate had dodged the
question and the interviewer re-anchored to it; the check had no notion of
whether a question had ever been answered.

So: **write the test that proves a check fires, and the test that proves it
stays quiet, before trusting it.** Then check it is actually reachable from the
harness, not merely present in the code.

## Tuning a check that fires wrongly

Widen the rule, do not weaken the threshold. When `asks_a_question` failed a
live turn saying "tell me what you built", the fix was recognising that
construction — it matched "tell me about" but not "tell me what". The same shape
had already happened once for French imperatives.

But do not keep loosening a critical check until a live model passes. That is
how a suite stops meaning anything. When a model produced "I want the real story:
what you built…" — a statement, not a question, in a product where a turn must
hand the floor back — the right answer was to leave the check alone and record a
finding about the model.

## Adding a check

There is no registry; checks are imperative pushes inside `runChecks`, in order:

```ts
results.push(check('my_check', predicate, 'why it failed', /* critical */ false));
```

Mark `critical` only for actual harm — answer leakage, unsafe content. Not for
embarrassment. A critical check fails a build on one turn regardless of the
average, which is right for harm and disproportionate for a clumsy sentence.

## Adding a rubric dimension

Anchor it at 1, 3 and 5 in words. An unanchored 1-5 scale invites a judge to
cluster everything near the middle, and a rubric that returns 4 for everything
discriminates nothing. Anchors are also what makes human calibration possible:
two raters can only agree on a scale that says what its numbers mean.

```ts
{ id: 'grounding', label: 'Grounding',
  question: 'Does the turn use what it was told, without inventing or reciting?',
  anchors: {
    1: 'States a specific that appears nowhere in what it was told, or recites it back.',
    3: 'Consistent with what it was told but ignores it — the same question would have been asked with no context.',
    5: 'Turns one thing it was told into a sharper question, without quoting it.' },
  weight: 1, critical: false }
```

**Make it conditional if it can be inapplicable.** Drop it from the rubric
entirely when the agent had no context, rather than scoring it low — and have
the judge discard a score for a dimension it was never shown.

Adding a dimension changes the composite denominator, so land it **before**
recording a baseline.

## The two instruments together

Worth knowing what the split buys, from a real run: handed some context, the
model recited it back **in paraphrase**. `not_reciting_context` correctly stayed
quiet — the text was reworded, not copied — and the judge scored grounding 2 and
quoted the sentence. The rule catches verbatim; judgement catches paraphrase.
Neither would have caught it alone.
