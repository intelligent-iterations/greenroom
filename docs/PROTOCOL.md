# Development protocol

> Also available as a skill: `.claude/skills/ship-checklist`, so an agent
> working in this repository picks it up before committing rather than after.

Every rule here was bought with a specific failure in this repository. The
failures are named, because a rule whose cost you cannot see is a rule you will
talk yourself out of at the worst moment.

They share one shape: **the code was not wrong in a way anything would tell you
about.** It ran, returned, exited zero, and did nothing. Most of this protocol
is about making that state impossible to reach quietly.

---

## 1. Test the seam before the centre

The parts that touch the outside world — files, sockets, GPUs, clocks — get a
fake and a test *first*. Pure logic can wait; it is the easiest thing to fix
later and the least likely to be wrong.

> The mel frontend and the generation loop shipped with 28 and 14 tests. The
> code that downloaded 2.2GB and put it on disk shipped with **none**, twice.
> Both times it was the part that broke, and both times the user found it before
> I did.

The instinct runs backwards: pure functions are pleasant to test, so they get
tested, and the messy I/O gets "verified by running it once". Invert it
deliberately.

**Check:** before opening a PR, list the modules that touch I/O. Each one has a
test file. No exceptions for "it's just plumbing" — plumbing is where the water
gets out.

---

## 2. A test double is code, and it is the code you trust least

A passing test against a wrong fake is worse than no test: it manufactures
confidence.

> Building an in-memory File System Access API, three of four failures were in
> the *fake*, each looking exactly like a bug in the code under test. A plain
> object where a `Blob` was needed made `new Response(file)` serialise
> `"[object Object]"`. A bare `WritableStream` has `getWriter()` but no
> `write()` — the real `FileSystemWritableFileStream` adds it.
>
> Later, a fake that served every file the same size made a download test fail.
> That one was correct: the validator was refusing a wrong-sized file, which is
> its whole job.

**Check:** when a test fails, the fake is a suspect before the implementation
is. Read the real type's contract — not its shape, its *contract* — and confirm
the double honours it.

---

## 3. Check the property you depend on, not a proxy for it

Existence is not validity. Configured is not running. Written is not complete.

> - A file was trusted because it existed. A truncated download was handed to
>   ONNX Runtime and failed far from the cause. Now every file is checked
>   against a manifest of exact sizes.
> - The secret-scanning CI job was trusted because it was configured. It had
>   never scanned a commit — `gitleaks-action` refuses to run for an
>   organisation without a paid licence and fails *at the licence check*. A red
>   X that read as tooling noise. **Absent, and appearing to be present, is the
>   worst state a control can occupy.**
> - A cache write was trusted because it returned. `response.clone()` tees the
>   body stream, and a tee only flows while *both* branches are read — so it
>   deadlocked silently and cached nothing.

**Check:** for each dependency, name the property you actually need (right
size, non-zero exit, N commits scanned) and assert *that*. If a control cannot
report what it did, it is not a control.

---

## 4. A step that cannot report is indistinguishable from a hang

> "It's stuck at loading the model." It probably was not stuck. The tokenizer
> fetch happened before any progress existed, completed files vanished from the
> list, and files with no known `Content-Length` were filtered out of it
> entirely. A working download and a hung one rendered identically.

Anything slow enough to notice says it started, and says what it is doing. That
includes work that is not a download: compiling a 1.2GB graph for the GPU is a
silent minute that reads as a freeze.

**Check:** for every phase a user can wait in, ask "what appears on screen in
second three?" If the answer is "nothing", that is the bug.

---

## 5. Observe before you hypothesise, and suspect your own recent work last

The most recent change is the most available explanation, not the most likely
one.

> A user reported the app re-downloading its model every visit. I had just
> touched the folder cache, so I diagnosed the folder cache, found a real
> deadlock in it, and fixed it. **It was not their bug** — they were on the
> default path, which never used that code.
>
> The actual cause was a disk at 100%, with 3.8 GiB free on a 926 GiB volume.
> Chrome's Cache Storage is best-effort and evicts the largest bucket under
> pressure. One `df -h` would have found it in seconds.

**Check:** before writing a fix, write down the observation that would confirm
the diagnosis, and go get it. If the fix is in code the reporter never
executed, the diagnosis is wrong no matter how real the bug you found is.

---

## 6. Every number in prose is a claim with a timestamp

> The README said "357 unit tests" in two places. It was 398. It also said
> hosting was live in a way that implied the live site was this code — it was 29
> commits behind and predated the storage fix entirely, so a reader would have
> concluded the bug was fixed in production. It was not.

This matters most in a repository whose central argument is that it is precise
about what it has verified. One stale number spends that credibility.

**Check:** re-derive any figure you state, in the same session you state it. If
you cannot re-derive it, delete it or mark what it was true of. "Verified" gets
a date or a commit.

---

## 7. Read the diff as a reviewer before saying it is done

Not as the author, who sees intent. As someone who sees only what is there.

> Shipped in this session: a ternary reading `missing === 0 ? 'ready-to-load' :
> 'ready-to-load'`. A dead `handlers.onText === undefined && void 0;`. A
> variable assigned twice in a row, the first discarded. Module-level mutable
> state for an embedding lookup, shared by every session in the tab. A
> typecheck failure committed and amended — twice.

None of these needed cleverness to catch. They needed reading.

**Check:** `git diff` before every commit. Read it top to bottom. The question
is not "did I mean this" but "would I accept this".

---

## 8. Deliver what was asked, in the words it was asked in

> I shipped a latency optimisation inside the cascade and described it as
> "realtime on-device". The user reasonably understood that as a realtime
> *architecture*, asked where to select it, and there was nothing to select.
> Both statements were defensible; together they misled.

When a word could mean the thing you built or something larger, say which, and
say plainly what it is **not**. "Not verified" sections are cheap and they are
the only reason the rest of a document can be believed.

**Check:** state the deliverable in the user's vocabulary, then one sentence on
what it does not include. If that sentence is uncomfortable to write, it is the
one that most needed writing.

---

## The standing question

Before "done", answer three:

1. **What did I verify, and how?** Naming the method. "It typechecks" is not
   verification of behaviour.
2. **What did I *not* verify?** Say it unprompted. A microphone nobody has
   spoken into. A model nobody has downloaded. A server nobody has reached.
3. **What would I expect to break first?** If there is no answer, the change is
   not understood well enough to ship.
