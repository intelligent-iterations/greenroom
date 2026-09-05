# Licensing

## Short answer

**Yes, this can be open-sourced today.** The code is MIT, and every dependency
and model is permissively licensed — with **one exception worth a decision**:
Llama 3.2 is not OSI open source.

## This repository

MIT. See [LICENSE](../LICENSE).

## Runtime dependencies

| Package | Licence |
|---|---|
| `@huggingface/transformers` | Apache-2.0 |
| `kokoro-js` | Apache-2.0 |
| `onnxruntime-web` | MIT |
| `@ricky0123/vad-web` | ISC |
| `react`, `react-dom` | MIT |
| `zustand` | MIT |
| `firebase` | Apache-2.0 |

All permissive, all compatible with MIT distribution.

## Models

Models are **not redistributed** by this repository — the browser fetches them
from Hugging Face at runtime. Their licences still govern use, and one of them
constrains what a commercial product may do.

| Model | Licence | Notes |
|---|---|---|
| Whisper base | Apache-2.0 | speech recognition |
| Silero VAD | MIT | endpointing |
| Kokoro-82M | Apache-2.0 | voice |
| SmolLM2 360M / 1.7B | Apache-2.0 | interviewer, default |
| Qwen3 4B | Apache-2.0 | interviewer, largest tier |
| **Llama 3.2 3B** | **Llama 3.2 Community License** | **not OSI open source** |

### The Llama 3.2 exception

Meta's licence is source-available, not open source. Practically it carries
three obligations a permissive licence does not:

1. **Attribution.** Products built with it must display "Built with Llama".
2. **Acceptable Use Policy**, which the licence incorporates by reference.
3. **A scale trigger.** Above 700 million monthly active users, a separate
   licence must be requested from Meta.

None of these are onerous for this project, and none of them are MIT.

**The choice this leaves you.** Every other tier — SmolLM2 and Qwen3 — is
Apache-2.0, so dropping the Llama tier makes the whole stack cleanly open
source. It is kept because it is the strongest *non-reasoning* model in reach,
and non-reasoning matters for a voice interviewer: nothing to suppress, and no
route by which the model's private deliberation reaches the speaker.

If a fully OSI-open stack matters more than that, delete the Llama entry from
`packages/web/src/voice/models.ts` and the picker loses one option. Nothing else
changes. If it stays, the "Built with Llama" attribution belongs in the UI
before this ships to real users.

## Voices and generated audio

Kokoro's voices are Apache-2.0. The synthesised audio produced at runtime is
yours; nothing about the pipeline claims rights over a learner's recordings,
which in the default configuration never leave their device in any case.
