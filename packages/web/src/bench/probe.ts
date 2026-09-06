/**
 * Isolates the model's raw output from our post-processing.
 *
 * The interviewer replies with a single word. That is either the model doing it,
 * or something between the model and the transcript eating the rest — the
 * reasoning stripper, the sentence chunker, or the chat template. This runs the
 * real compiled prompt through the real model and prints the raw token stream
 * with nothing applied, so the two cases can be told apart.
 */
import { compileInterviewerPrompt, findScenario, type LearnerState } from '@greenroom/shared';
import { AutoModelForCausalLM, AutoTokenizer, TextStreamer } from '@huggingface/transformers';
import { findStage } from '../voice/model-manifest.js';

const out = document.getElementById('out')!;
const result: Record<string, unknown> = {};
const show = () => (out.textContent = JSON.stringify(result, null, 2));

async function main() {
  const scenario = findScenario('backend-mid-en')!;
  const learner: LearnerState = {
    userId: 'probe', cefr: 'B2', seniority: 'mid', language: 'en',
    targetRole: 'Backend Engineer', mastery: [], recentErrors: [],
    sessionsCompleted: 0, updatedAt: 0, documents: [],
  };
  const prompt = compileInterviewerPrompt({ scenario, learner });
  result.systemPromptChars = prompt.system.length;
  result.systemPromptHead = prompt.system.slice(0, 300);
  show();

  const spec = findStage('llm');
  const tokenizer = await AutoTokenizer.from_pretrained(spec.repo);
  const model = await AutoModelForCausalLM.from_pretrained(spec.repo, {
    dtype: 'q4f16', device: 'webgpu',
  });

  const cases: Array<{ name: string; messages: { role: string; content: string }[] }> = [
    { name: 'A_opening_system_only', messages: [{ role: 'system', content: prompt.system }] },
    {
      name: 'B_with_user_turn',
      messages: [
        { role: 'system', content: prompt.system },
        { role: 'user', content: 'Okay, I am speaking now.' },
      ],
    },
    {
      name: 'C_short_generic_system',
      messages: [
        { role: 'system', content: 'You are an interviewer. Ask one short question.' },
        { role: 'user', content: 'Okay, I am speaking now.' },
      ],
    },
  ];

  result.tokenCounts = {};
  result.raw = {};

  for (const testCase of cases) {
    const inputs = tokenizer.apply_chat_template(testCase.messages, {
      add_generation_prompt: true,
      return_dict: true,
    });
    (result.tokenCounts as Record<string, number>)[testCase.name] =
      (inputs as { input_ids: { dims: number[] } }).input_ids.dims[1] ?? -1;

    const deltas: string[] = [];
    const streamer = new TextStreamer(tokenizer, {
      skip_prompt: true,
      skip_special_tokens: true,
      callback_function: (t: string) => deltas.push(t),
    });

    await model.generate({
      ...(inputs as object),
      max_new_tokens: 60,
      do_sample: true,
      temperature: 0.6,
      streamer,
    });

    (result.raw as Record<string, unknown>)[testCase.name] = {
      deltaCount: deltas.length,
      joined: deltas.join(''),
    };
    show();
  }

  // What the rendered chat prompt actually looks like going in.
  result.renderedPromptTail = (
    tokenizer.apply_chat_template(cases[1]!.messages, {
      add_generation_prompt: true,
      tokenize: false,
    }) as string
  ).slice(-400);

  result.done = true;
  show();
}

main().catch((e) => {
  result.error = `${e.name}: ${e.message}`;
  show();
});
