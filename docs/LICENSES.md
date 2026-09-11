# Licensing

## Short answer

**Yes.** The code is MIT and every dependency and model it offers is
Apache-2.0, MIT or ISC. There is no exception and nothing to caveat.

**No model weights are redistributed.** The browser fetches them at runtime from
public repositories, and the built-in list is a starting point rather than a
closed set — a user can name any Hugging Face repository or point at a folder
they already have. The project ships code, not models.

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

Llama 3.2 was previously offered as a tier and has been **removed**. Its licence
is source-available rather than open source, and shipping it as a default would
have made "open source" inaccurate for the project as a whole. The honest move
was to drop it rather than caveat it. Anyone who wants it can still enter the
repository by hand — that is their licence decision, not one this project makes
on their behalf.

### Why Llama 3.2 is not here

Meta's licence is source-available, not open source. It carries three
obligations a permissive licence does not: a "Built with Llama" attribution
requirement, an acceptable-use policy incorporated by reference, and a separate
licence above 700 million monthly active users.

None are onerous. All are incompatible with describing the project, without
qualification, as open source — and a qualified claim is the kind of thing that
erodes trust in every other claim beside it. So the tier was removed rather than
footnoted.

The cost is real and worth stating: it was the strongest *non-reasoning* model
in reach, and non-reasoning matters for a voice partner — nothing to suppress
and no route by which private deliberation reaches the speaker. Qwen3 4B covers
the quality tier at the price of being a reasoning model.

## Voices and generated audio

Kokoro's voices are Apache-2.0. The synthesised audio produced at runtime is
yours; nothing about the pipeline claims rights over a learner's recordings,
which in the default configuration never leave their device in any case.
