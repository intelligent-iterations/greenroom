import { BUILT_IN_PRESETS, SCENARIOS, type LearnerState } from '@greenroom/shared';
import { useAppStore } from '../state/store.js';

/**
 * Chooses who the model is playing.
 *
 * The interview scenarios sit alongside the generic partners rather than above
 * them: the product is a place to hear what an on-device model sounds like, and
 * interview practice is one thing it can be used for.
 */
export function PresetPicker({ learner }: { learner: LearnerState }) {
  const { presetId, setPresetId, customPrompt, setCustomPrompt, groundingText, setGroundingText } =
    useAppStore();

  const options = [
    ...BUILT_IN_PRESETS.map((p) => ({ id: p.id, title: p.title, description: p.description })),
    ...SCENARIOS.map((s) => ({
      id: `interview:${s.id}`,
      title: s.title,
      description: `Practice interview — ${s.company}, ${s.language.toUpperCase()}`,
    })),
    {
      id: 'custom',
      title: 'Write your own',
      description: 'Give the model any system prompt and talk to it.',
    },
  ];

  void learner;

  return (
    <section className="card">
      <h2>Who are you talking to?</h2>
      <div className="scenario-grid">
        {options.map((option) => (
          <button
            key={option.id}
            type="button"
            className={`scenario ${option.id === presetId ? 'scenario--active' : ''}`}
            onClick={() => setPresetId(option.id)}
            aria-pressed={option.id === presetId}
          >
            <strong>{option.title}</strong>
            <span className="muted small">{option.description}</span>
          </button>
        ))}
      </div>

      {presetId.startsWith('interview:') && (
        <label className="stack">
          <span className="muted small">
            Optional: paste a CV or a job description. The interviewer will draw on the
            parts relevant to whatever it is about to ask, so its questions are about
            your actual experience rather than the role in the abstract. Retrieval runs
            on this device and the text is never sent anywhere — not to the model
            provider, and not to the server, which rejects it outright.
          </span>
          <textarea
            className="prompt-input"
            rows={6}
            value={groundingText}
            onChange={(e) => setGroundingText(e.target.value)}
            placeholder={
              'Senior backend engineer, six years.\n\n' +
              'Owned the checkout service end to end. Led the migration off the Rails\n' +
              'monolith onto Postgres and Kafka, which halved checkout latency.'
            }
          />
        </label>
      )}

      {presetId === 'custom' && (
        <label className="stack">
          <span className="muted small">
            Keep it short. Small on-device models follow a few clear lines far better
            than a long brief, and they weight the last line most — put the one rule
            that matters at the end.
          </span>
          <textarea
            className="prompt-input"
            rows={6}
            value={customPrompt}
            onChange={(e) => setCustomPrompt(e.target.value)}
            placeholder={
              'You are a patient chess coach having a spoken conversation.\n' +
              'Never use lists or symbols; everything you say is read aloud.\n' +
              'Your entire reply must be under 40 spoken words.'
            }
          />
        </label>
      )}
    </section>
  );
}
