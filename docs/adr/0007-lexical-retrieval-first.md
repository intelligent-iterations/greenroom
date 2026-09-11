# ADR 0007: Lexical retrieval first, on device

**Status:** accepted
**Date:** 2026-09-06

## Context

`InterviewScenario.contextNotes` has carried the comment "Grounding for the RAG
path" since the first commit. It was read only by the full prompt style, and the
on-device path runs the compact one, so the grounding content was dead on the
path that actually executes.

Making it live raises a question the codebase had not answered: what retrieves,
and where does it run? An interviewer that can draw on the candidate's own CV
asks better questions than one working from a role title. The corpus is small —
a handful of scenario notes plus one pasted document — and the query is one
question plus one answer.

Three options:

**Hosted vector database.** Pinecone, or Firestore vector search. Someone else
operates the index.

**On-device embeddings.** all-MiniLM-L6-v2 through transformers.js, cosine
similarity over chunks held in memory.

**On-device lexical.** BM25 over the same chunks, no model at all.

## Decision

Lexical, on device, behind a narrow `Retriever` interface that an embedding
retriever can implement later without the orchestrator changing.

## Rationale

**A hosted vector database ends ADR 0001, and for this corpus it buys nothing.**
The document being searched is the learner's CV. Uploading it to a third party to
search forty chunks would trade the product's central claim for an index that
fits in memory. Not a close call.

**The default has to be reproducible, and embeddings are not.** The eval gate
compares scored runs against a baseline. Floating-point embedding output is not
bit-identical across runtimes, accelerators or library versions, so an embedding
retriever makes retrieval a source of run-to-run variance in the one place that
exists to detect variance. CI also has to pass on a machine with no network and
no GPU. Lexical retrieval is a pure function of the corpus and the query, ties
broken by source and chunk index for a total order, so the same run returns the
same passages forever.

**This is a claim about the default, not about quality.** Embeddings retrieve
better. The measured limitation is already recorded: the adversarial
contradiction case has the candidate say "MySQL" against a note that says
"Postgres", and lexical retrieval cannot connect those — different tokens, no
overlap. That is precisely the gap an embedding retriever closes, and it is why
`Retriever` is an interface with an async `index()` that a lexical implementation
does not need.

**A relevance floor is not optional for this approach.** A lexical retriever
always returns its best match, however bad. Without `MIN_LEXICAL_SCORE` a pasted
restaurant menu produces a "grounding" passage and the interviewer asks the
candidate about the soup. There is a test for exactly that.

**Retrieval sits upstream of prompt compilation.** `compileInterviewerPrompt`
stays pure — no clocks, no randomness, no I/O — because the harness, the CI gate
and the version-bump discipline all rest on identical input producing identical
output. The orchestrator retrieves and hands the compiler passages as data.

## Consequences

- The compact prompt carries exactly one passage, capped at 140 characters. That
  prompt's size is measured, not chosen: the full prompt collapses a 1.7B model
  to one-word replies. Grounding has to fit inside a budget that was already
  tight, and one passage is what fits.
- A synonym or a competing product name will not be retrieved. Recorded above,
  and tested.
- The learner's document never leaves the device. `saveLearnerState` drops the
  field and `firestore.rules` rejects a write carrying it, so the claim holds at
  the security boundary rather than by client politeness. The Cloud Function
  scorer never receives it and does not need it: it compiles a prompt only to
  recover the focus competencies, which do not read passages.
- The interface is async although the lexical implementation needs nothing async,
  so adding an embedding retriever is a new class rather than a signature change.
  Retrieval time is logged per turn for the same reason: today it is
  sub-millisecond, and an embedding retriever would add directly to
  time-to-first-token. That has to show up in the instrumentation rather than be
  discovered in a session.

## Revisit when

Grounding scores poorly on the rubric for reasons that look like retrieval rather
than the model — passages that are plausible but not the right ones — or the
corpus grows past what a linear scan should handle. **The first baseline scores
grounding at 3.5, the lowest of the nine dimensions and exactly on its gate
floor**, but the failure mode there is the model ignoring context it was given
rather than being given the wrong context, and a better retriever does not fix
that. Measure which it is before adding a model.
