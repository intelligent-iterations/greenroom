/**
 * Isolates decode throughput from the streaming adapter.
 *
 * The pipeline benchmark measured 2 tokens/second, which is unusable. This
 * decides whether that is the runtime or our own streaming wrapper, by timing
 * raw greedy generation with no streamer against the exact configuration the
 * adapter uses. Weights are already cached, so it runs in seconds.
 */
import { AutoModelForCausalLM, AutoTokenizer, TextStreamer } from '@huggingface/transformers';

const out = document.getElementById('out')!;
const results: Record<string, unknown> = {};
const show = () => (out.textContent = JSON.stringify(results, null, 2));

async function main() {
  const repo = 'HuggingFaceTB/SmolLM2-1.7B-Instruct';
  results.stage = 'loading';
  show();

  const tokenizer = await AutoTokenizer.from_pretrained(repo);
  const model = await AutoModelForCausalLM.from_pretrained(repo, {
    dtype: 'q4f16',
    device: 'webgpu',
  });

  const inputs = tokenizer.apply_chat_template(
    [{ role: 'user', content: 'Say one short sentence about coffee.' }],
    { add_generation_prompt: true, return_dict: true },
  );

  // Warm-up so shader compilation is not attributed to either measurement.
  await model.generate({ ...(inputs as object), max_new_tokens: 1 });

  const N = 32;

  // A: greedy, no streamer. The floor: pure runtime decode.
  let t = performance.now();
  const greedy = await model.generate({ ...(inputs as object), max_new_tokens: N, do_sample: false });
  const greedyMs = performance.now() - t;
  results.greedy_no_streamer = { ms: Math.round(greedyMs), tokPerSec: +(N / (greedyMs / 1000)).toFixed(1) };
  show();

  // B: sampling, no streamer. Isolates the per-token logit readback that
  // sampling requires — a GPU->CPU transfer over the whole vocabulary.
  t = performance.now();
  await model.generate({ ...(inputs as object), max_new_tokens: N, do_sample: true, temperature: 0.6 });
  const sampleMs = performance.now() - t;
  results.sampled_no_streamer = { ms: Math.round(sampleMs), tokPerSec: +(N / (sampleMs / 1000)).toFixed(1) };
  show();

  // C: sampling + streamer, exactly what the adapter does today.
  let streamed = 0;
  const streamer = new TextStreamer(tokenizer, {
    skip_prompt: true,
    skip_special_tokens: true,
    callback_function: () => { streamed += 1; },
  });
  t = performance.now();
  await model.generate({ ...(inputs as object), max_new_tokens: N, do_sample: true, temperature: 0.6, streamer });
  const streamMs = performance.now() - t;
  results.sampled_with_streamer = {
    ms: Math.round(streamMs),
    tokPerSec: +(N / (streamMs / 1000)).toFixed(1),
    callbacks: streamed,
  };

  results.sample_text = tokenizer.batch_decode(greedy as never, { skip_special_tokens: true })[0]?.slice(-160);
  results.stage = 'done';
  show();
}

main().catch((e) => {
  results.stage = 'error';
  results.error = `${e.name}: ${e.message}`;
  show();
});
