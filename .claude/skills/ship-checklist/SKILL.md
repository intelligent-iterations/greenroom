---
name: ship-checklist
description: Verify a change before calling it done — what was tested, what was not, and what will break first. Use when about to commit, when about to say a feature works, when a user reports something broken or stuck, when writing a test double, or when about to state a metric, a test count, or a "verified" claim in prose or a README.
---

# Before calling it done

Eight rules, each bought with a real failure in this repository. The full write-up
with the evidence is in `docs/PROTOCOL.md`; this is the operative form.

They share one shape: **the code was not wrong in a way anything reported.** It
ran, returned, exited zero, and did nothing.

## The rules

**1. Test the seam before the centre.** Anything touching files, sockets, GPUs
or clocks gets a fake and a test first. Pure logic can wait — it is the easiest
thing to fix later. *Here: the DSP got 28 tests, the 2.2GB download flow got
zero, twice. Both times the download was what broke.*

**2. A test double is the code you trust least.** When a test fails, suspect the
fake before the implementation. Read the real type's *contract*, not its shape.
*Here: three of four failures in an in-memory filesystem were in the fake, each
looking exactly like a bug in the code under test.*

**3. Check the property, not a proxy.** Existence is not validity. Configured is
not running. Written is not complete. *Here: a truncated file was trusted
because it existed; a secret scanner was trusted because it was configured and
had never scanned a commit.*

**4. A step that cannot report is indistinguishable from a hang.** For every
phase a user waits in, ask what appears on screen in second three. *Here:
"stuck at loading" was a working download with nothing rendering.*

**5. Observe before hypothesising; suspect your own recent work last.** Write
down the observation that would confirm the diagnosis, then go get it. *Here: a
re-download bug was diagnosed in code the reporter never executed. The cause was
a disk at 100%, one `df -h` away.*

**6. Every number in prose is a claim with a timestamp.** Re-derive it in the
same session you state it, or delete it. *Here: "357 tests" when it was 398, and
a README implying the live site was current when it was 29 commits behind.*

**7. Read the diff as a reviewer, not as the author.** *Here: a ternary reading
`x === 0 ? 'ready' : 'ready'`, a dead expression statement, a variable assigned
twice, and two committed typecheck failures.*

**8. Deliver it in the words it was asked in.** When a word could mean what you
built or something larger, say which — and say what it is not. *Here: a latency
optimisation described as "realtime", which was heard as a realtime
architecture.*

## The standing question

Before saying done, answer three, unprompted:

1. **What did I verify, and how?** Name the method. "It typechecks" is not
   verification of behaviour.
2. **What did I not verify?** A microphone nobody spoke into. A model nobody
   downloaded. A server nobody reached. Say it without being asked.
3. **What breaks first?** No answer means the change is not understood well
   enough to ship.

## When a user says it is broken

In this order, before writing any fix:

1. Get the observation. Logs, `df -h`, a HEAD request, the actual error string.
2. Establish which code path they were on. If your suspected fix is in code they
   never executed, the diagnosis is wrong however real the bug you found is.
3. Only then hypothesise.

A fix shipped against the wrong cause costs twice: the real bug survives, and
the next report is harder to believe.
