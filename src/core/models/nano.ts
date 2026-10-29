import type { ModelClient } from './index';

export type NanoAvailability = 'available' | 'downloadable' | 'downloading' | 'unavailable';

interface LanguageModelSession {
  prompt(input: string, options?: { responseConstraint?: object; signal?: AbortSignal }): Promise<string>;
  destroy(): void;
}

interface DownloadMonitor {
  addEventListener(type: 'downloadprogress', listener: (e: { loaded: number }) => void): void;
}

interface LanguageModelStatic {
  availability(): Promise<NanoAvailability>;
  create(options?: {
    initialPrompts?: { role: 'system' | 'user' | 'assistant'; content: string }[];
    monitor?: (m: DownloadMonitor) => void;
    signal?: AbortSignal;
  }): Promise<LanguageModelSession>;
}

function api(): LanguageModelStatic | undefined {
  return (globalThis as { LanguageModel?: LanguageModelStatic }).LanguageModel;
}

export async function nanoAvailability(): Promise<NanoAvailability> {
  const lm = api();
  if (!lm) return 'unavailable';
  try {
    return await lm.availability();
  } catch {
    return 'unavailable';
  }
}

/**
 * Starts the model download. Chrome only allows this from a user gesture, so the options page
 * calls it from a button click. `onProgress` receives 0..1.
 */
export async function downloadNano(onProgress: (loaded: number) => void): Promise<void> {
  const lm = api();
  if (!lm) throw new Error('当前 Chrome 不支持内置模型（Prompt API）');
  const session = await lm.create({
    monitor: (m) => m.addEventListener('downloadprogress', (e) => onProgress(e.loaded)),
  });
  session.destroy();
}

export function nanoClient(): ModelClient {
  return {
    label: 'Gemini Nano（本地）',
    // Small context window: keep batches short.
    maxBatch: 15,
    sendsOffDevice: false,
    async complete(system, user, schema) {
      const lm = api();
      if (!lm) throw new Error('当前 Chrome 不支持内置模型（Prompt API）');
      const session = await lm.create({ initialPrompts: [{ role: 'system', content: system }] });
      try {
        return await session.prompt(user, { responseConstraint: schema, signal: AbortSignal.timeout(90_000) });
      } finally {
        session.destroy();
      }
    },
  };
}
