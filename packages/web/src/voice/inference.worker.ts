/**
 * All model inference, off the main thread.
 *
 * This exists because of a failure that made the product's headline feature
 * impossible. Running recognition, generation and synthesis on the main thread
 * blocks it for seconds at a time — long enough that Chrome reports the
 * renderer as unresponsive. While it is blocked, the voice-activity detector's
 * callbacks cannot fire, which means the learner *cannot interrupt*. Barge-in
 * is not a feature you can add on top of a blocked main thread.
 *
 * So the split is: this worker owns the three models, and the main thread keeps
 * only the microphone, the VAD and audio playback — all of which must be there,
 * and none of which are compute-heavy.
 *
 * Synthesised audio is transferred back as raw samples rather than played here;
 * a worker has no output device. The transfer is zero-copy.
 */
import { KokoroTTS } from 'kokoro-js';
import {
  AutoModelForCausalLM,
  AutoTokenizer,
  InterruptableStoppingCriteria,
  TextStreamer,
  pipeline,
  type AutomaticSpeechRecognitionPipeline,
  type DynamicCache,
  type PreTrainedModel,
  type PreTrainedTokenizer,
} from '@huggingface/transformers';
import { findStage } from './model-manifest.js';
import type { ChatMessage } from '@greenroom/shared';

export type WorkerRequest =
  | { type: 'load'; language: 'en' | 'fr' }
  | { type: 'warmUp'; systemPrompt: string }
  | { type: 'transcribe'; id: number; audio: Float32Array }
  | { type: 'generate'; id: number; messages: ChatMessage[]; maxTokens: number; temperature: number }
  | { type: 'synthesize'; id: number; text: string }
  | { type: 'interrupt' }
  | { type: 'resetCache' };

export type WorkerResponse =
  | { type: 'progress'; stage: string; progress: number }
  | { type: 'ready' }
  | { type: 'warmedUp' }
  | { type: 'transcript'; id: number; text: string }
  | { type: 'delta'; id: number; text: string }
  | { type: 'generated'; id: number }
  | { type: 'audio'; id: number; samples: Float32Array; sampleRate: number }
  | { type: 'error'; id?: number; message: string };

let recognizer: AutomaticSpeechRecognitionPipeline | undefined;
let tokenizer: PreTrainedTokenizer | undefined;
let llm: PreTrainedModel | undefined;
let tts: KokoroTTS | undefined;
let language: 'en' | 'fr' = 'en';

/** Carried between turns so a turn only prefills what the learner just said. */
let pastKeyValues: DynamicCache | undefined;
let cachedMessages: ChatMessage[] = [];
let stopping: InterruptableStoppingCriteria | undefined;

/** `self` in a module worker is typed as Window by the DOM lib; narrow it. */
const worker = self as unknown as DedicatedWorkerGlobalScope;

const post = (message: WorkerResponse, transfer?: Transferable[]) =>
  transfer ? worker.postMessage(message, transfer) : worker.postMessage(message);

/** The progress union includes states with no `progress` field. */
const progressOf = (info: unknown): number =>
  typeof info === 'object' && info !== null && 'progress' in info &&
  typeof (info as { progress: unknown }).progress === 'number'
    ? (info as { progress: number }).progress / 100
    : 0;

async function load(): Promise<void> {
  const stt = findStage('stt');
  const llmSpec = findStage('llm');
  const ttsSpec = findStage('tts');

  post({ type: 'progress', stage: 'speech recognition', progress: 0 });
  recognizer = (await pipeline('automatic-speech-recognition', stt.repo, {
    device: 'webgpu',
    dtype: stt.modules.webgpu as Record<string, 'fp32'>,
    progress_callback: (info) =>
      post({ type: 'progress', stage: 'speech recognition', progress: progressOf(info) }),
  })) as AutomaticSpeechRecognitionPipeline;
  // Compile shaders now rather than on the learner's first answer.
  await recognizer(new Float32Array(16_000), { language });

  post({ type: 'progress', stage: 'interviewer', progress: 0 });
  tokenizer = await AutoTokenizer.from_pretrained(llmSpec.repo);
  llm = await AutoModelForCausalLM.from_pretrained(llmSpec.repo, {
    dtype: (llmSpec.modules.webgpu['model'] ?? 'q4f16') as 'q4f16',
    device: 'webgpu',
    progress_callback: (info) =>
      post({ type: 'progress', stage: 'interviewer', progress: progressOf(info) }),
  });

  post({ type: 'progress', stage: 'voice', progress: 0 });
  tts = await KokoroTTS.from_pretrained(ttsSpec.repo, {
    device: 'webgpu',
    dtype: (ttsSpec.modules.webgpu['model'] ?? 'fp32') as 'fp32',
    progress_callback: (info) => post({ type: 'progress', stage: 'voice', progress: progressOf(info) }),
  });

  post({ type: 'ready' });
}

/** True when `messages` begins with the conversation the cache was built on. */
function extendsCache(messages: ChatMessage[]): boolean {
  if (!pastKeyValues || messages.length < cachedMessages.length) return false;
  return cachedMessages.every(
    (cached, i) => messages[i]?.role === cached.role && messages[i]?.content === cached.content,
  );
}

async function generate(request: Extract<WorkerRequest, { type: 'generate' }>): Promise<void> {
  if (!llm || !tokenizer) throw new Error('model not loaded');
  if (!extendsCache(request.messages)) pastKeyValues = undefined;

  const inputs = tokenizer.apply_chat_template(request.messages, {
    add_generation_prompt: true,
    return_dict: true,
  });

  stopping = new InterruptableStoppingCriteria();
  const streamer = new TextStreamer(tokenizer, {
    skip_prompt: true,
    skip_special_tokens: true,
    callback_function: (text: string) => post({ type: 'delta', id: request.id, text }),
  });

  try {
    const output = (await llm.generate({
      ...(inputs as object),
      past_key_values: pastKeyValues,
      max_new_tokens: request.maxTokens,
      do_sample: true,
      temperature: request.temperature,
      streamer,
      stopping_criteria: stopping,
      return_dict_in_generate: true,
    })) as { past_key_values?: DynamicCache };

    pastKeyValues = output.past_key_values;
    cachedMessages = [...request.messages];
  } catch (err) {
    // A failed or interrupted turn must not leave a cache describing a state
    // the model never actually reached.
    pastKeyValues = undefined;
    cachedMessages = [];
    throw err;
  } finally {
    post({ type: 'generated', id: request.id });
  }
}

worker.addEventListener('message', (event: MessageEvent<WorkerRequest>) => {
  const request = event.data;

  void (async () => {
    try {
      switch (request.type) {
        case 'load':
          language = request.language;
          await load();
          break;

        case 'warmUp':
          if (llm && tokenizer) {
            const inputs = tokenizer.apply_chat_template(
              [
                { role: 'system', content: request.systemPrompt },
                { role: 'user', content: 'Hello.' },
              ],
              { add_generation_prompt: true, return_dict: true },
            );
            await llm.generate({ ...(inputs as object), max_new_tokens: 1 });
          }
          post({ type: 'warmedUp' });
          break;

        case 'transcribe': {
          if (!recognizer) throw new Error('recognizer not loaded');
          const out = await recognizer(request.audio, { language, task: 'transcribe' });
          const text = (Array.isArray(out) ? out[0]?.text : out.text) ?? '';
          post({ type: 'transcript', id: request.id, text: text.trim() });
          break;
        }

        case 'generate':
          await generate(request);
          break;

        case 'synthesize': {
          if (!tts) throw new Error('voice not loaded');
          const audio = await tts.generate(request.text, { voice: 'af_heart' });
          const samples = audio.audio;
          // Transferred, not copied: these buffers are large and this runs on
          // every sentence.
          post(
            { type: 'audio', id: request.id, samples, sampleRate: audio.sampling_rate },
            [samples.buffer as ArrayBuffer],
          );
          break;
        }

        case 'interrupt':
          stopping?.interrupt();
          break;

        case 'resetCache':
          pastKeyValues = undefined;
          cachedMessages = [];
          break;
      }
    } catch (err) {
      post({
        type: 'error',
        ...('id' in request ? { id: request.id } : {}),
        message: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
      });
    }
  })();
});
