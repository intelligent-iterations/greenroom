import type { SpeechSynthesizer } from '@greenroom/shared';

/**
 * Web Speech API synthesiser.
 *
 * The universal fallback: no download, no GPU, present on every target browser.
 * Quality is noticeably worse than Kokoro and voice availability varies by OS,
 * but it makes the product work on a locked-down machine with no WebGPU, which
 * describes a large share of the institutional devices this has to run on.
 *
 * Also the reference implementation for barge-in: `cancel()` stops audio within
 * a frame, which is the responsiveness the neural path has to match.
 */
export interface WebSpeechOptions {
  language?: 'en' | 'fr';
  rate?: number;
}

export class WebSpeechSynthesizer implements SpeechSynthesizer {
  readonly id = 'webspeech';
  #language: string;
  #rate: number;
  #voice: SpeechSynthesisVoice | null = null;

  constructor(options: WebSpeechOptions = {}) {
    this.#language = options.language === 'fr' ? 'fr-CA' : 'en-CA';
    // Slightly under natural pace: this is a language-training context and
    // learners at B1 and below lose the end of fast sentences.
    this.#rate = options.rate ?? 0.95;
  }

  async load(): Promise<void> {
    if (typeof speechSynthesis === 'undefined') {
      throw new Error('Speech synthesis is not available in this browser');
    }
    this.#voice = await this.#pickVoice();
  }

  /**
   * Voices load asynchronously and `getVoices()` returns [] on first call in
   * Chrome. Waiting on `voiceschanged` with a timeout is the only reliable
   * approach; without the timeout this hangs forever in Safari, which fires
   * the event before any listener can attach.
   */
  #pickVoice(): Promise<SpeechSynthesisVoice | null> {
    const choose = (): SpeechSynthesisVoice | null => {
      const voices = speechSynthesis.getVoices();
      if (voices.length === 0) return null;
      const prefix = this.#language.slice(0, 2);
      return (
        voices.find((v) => v.lang === this.#language && !v.localService) ??
        voices.find((v) => v.lang === this.#language) ??
        voices.find((v) => v.lang.startsWith(prefix)) ??
        voices[0] ??
        null
      );
    };

    const immediate = choose();
    if (immediate) return Promise.resolve(immediate);

    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(choose()), 1000);
      speechSynthesis.addEventListener(
        'voiceschanged',
        () => {
          clearTimeout(timer);
          resolve(choose());
        },
        { once: true },
      );
    });
  }

  speak(text: string, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) return reject(new DOMException('Aborted', 'AbortError'));

      const utterance = new SpeechSynthesisUtterance(text);
      utterance.lang = this.#language;
      utterance.rate = this.#rate;
      if (this.#voice) utterance.voice = this.#voice;

      const onAbort = () => {
        speechSynthesis.cancel();
        reject(new DOMException('Aborted', 'AbortError'));
      };
      signal?.addEventListener('abort', onAbort, { once: true });

      const settle = (fn: () => void) => {
        signal?.removeEventListener('abort', onAbort);
        fn();
      };

      utterance.onend = () => settle(resolve);
      utterance.onerror = (event) => {
        // A cancel() we initiated surfaces here as an error; it is not one.
        if (event.error === 'interrupted' || event.error === 'canceled') {
          settle(() => reject(new DOMException('Aborted', 'AbortError')));
        } else {
          settle(() => reject(new Error(`Speech synthesis failed: ${event.error}`)));
        }
      };

      speechSynthesis.speak(utterance);
    });
  }

  stop(): void {
    if (typeof speechSynthesis !== 'undefined') speechSynthesis.cancel();
  }
}
