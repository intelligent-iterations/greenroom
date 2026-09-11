---
name: Model behaviour
about: An agent said something it should not have, or missed something it should have caught
labels: evaluation
---

**Report this as a case, not a description.** A situation reproduces; a
paraphrase does not.

```json
{"id": "short-kebab-id",
 "probes": "One sentence on what this is testing.",
 "systemPrompt": "The prompt the agent was running under.",
 "transcript": [{"role": "user", "text": "..."}]}
```

**What the agent said**

**Which property it violated** — a deterministic check that should have fired,
or a rubric dimension that should have scored low. If neither exists yet, say
what the rule or the judgement would be.
