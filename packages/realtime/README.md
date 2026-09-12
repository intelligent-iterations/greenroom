# greenroom-realtime

A vendor-neutral interface for **full-duplex** (speech-to-speech) voice sessions, with a working client for [Kyutai Moshi](https://github.com/kyutai-labs/moshi).

A realtime voice API collapses speech recognition, the language model and speech synthesis into one bidirectional audio stream. It is not a faster cascade — it is a different shape, with different things it can and cannot tell you. This package is that shape, written down.

```bash
npm install greenroom-realtime
```

## Why it exists

Adapters for realtime APIs tend to quietly overclaim. They report a
"time to first token" that is really time-to-first-audio, or produce a recording with
no transcript and call it a session. Both make an evaluation meaningless.

So `DuplexCapabilities` is part of the interface, and adapters are expected to be honest in it:

```ts
export const MOSHI_CAPABILITIES: DuplexCapabilities = {
  userTranscripts: false,      // Moshi streams the assistant's words, not yours
  assistantTranscripts: true,
  transcriptsLeadAudio: false, // so time-to-first-token is NOT measurable here
  nativeBargeIn: true,         // it hears you while it speaks; don't add a VAD
};
```

An orchestrator reading `transcriptsLeadAudio: false` should leave that metric undefined
rather than publish a number that means something else. One reading
`nativeBargeIn: true` must not also drive barge-in from a local voice activity
detector — two owners of one behaviour is how a session interrupts itself.

## Using it with Moshi

Moshi runs as a server (it needs a GPU); this is the client half. Start one from the
[Moshi repository](https://github.com/kyutai-labs/moshi), then:

```ts
import { MoshiDuplexStage } from 'greenroom-realtime/moshi';

const stage = new MoshiDuplexStage({
  url: 'ws://127.0.0.1:8088/api/chat',
  codec: myOpusCodec,
});

await stage.open();

for await (const event of stage.events()) {
  if (event.type === 'assistant_transcript') console.log(event.text);
  if (event.type === 'assistant_audio') play(event.chunk);
}
```

Push microphone audio as mono float32 PCM:

```ts
stage.send({ samples, sampleRate: 24_000 });
```

### You supply the Opus codec

Moshi speaks Opus in both directions. This package does **not** bundle a codec, deliberately:
a WebAssembly codec is a large, platform-specific dependency that would be dead weight for
anyone using a vendor that speaks PCM — and it is not something this package could honestly
claim to have verified. So it is an interface:

```ts
export interface OpusCodec {
  encode(samples: Float32Array, sampleRate: number): Promise<Uint8Array[]>;
  decode(packet: Uint8Array): Promise<Float32Array>;
  readonly outputSampleRate: number;
}
```

In a browser, [`opus-recorder`](https://github.com/chris-rudmin/opus-recorder) is what the
reference Moshi client uses.

## What is verified, and what is not

**Verified.** The wire protocol is transcribed from the reference client
(`client/src/protocol/`), and 23 tests assert the framing against **literal byte values**
rather than round-tripping through this package's own encoder — a round trip would pass
happily while disagreeing with the server about every frame. The stage is tested against a
scripted socket: handshake on open, out-of-order audio decodes emitted in arrival order,
unknown frames skipped rather than killing the stream, no audio sent before open or after
close. 37 tests in total.

**Not verified.** No byte from this package has reached a real Moshi server. The protocol is
right on paper and the state machine is right in tests; the integration is unproven. If you
run it against a live server, please open an issue either way.

## The protocol, for reference

Each frame is one type byte followed by its payload:

| Byte | Frame | Payload |
| --- | --- | --- |
| `0x00` | handshake | `[version, model]` |
| `0x01` | audio | Opus packet |
| `0x02` | text | UTF-8 |
| `0x03` | control | `[action]` — start `0`, endTurn `1`, pause `2`, restart `3` |
| `0x04` | metadata | UTF-8 JSON |
| `0x05` | error | UTF-8 |
| `0x06` | ping | — |
| `0x07` | coloured text | `[colour, ...UTF-8]` |

`encodeMessage` and `decodeMessage` are exported if you want the codec without the session.

## Licence

MIT. Part of [Greenroom](https://github.com/intelligent-iterations/greenroom), a platform for
evaluating voice AI agents.
