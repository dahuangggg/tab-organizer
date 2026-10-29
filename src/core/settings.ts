export type ModelSource = 'nano' | 'custom' | 'cloud' | 'none';

export interface EndpointConfig {
  /** OpenAI-compatible base URL, e.g. https://api.openai.com/v1 or http://localhost:11434/v1 */
  baseUrl: string;
  model: string;
  apiKey: string;
}

export interface Settings {
  modelSource: ModelSource;
  custom: EndpointConfig;
  cloud: EndpointConfig;
  /** Set when the user confirmed the list of fields sent to the cloud provider. */
  cloudConsentAt: number | null;
  template: string;
  threshold: number;
  summaryEnabled: boolean;
  summaryToCloud: boolean;
  sendDomainOnly: boolean;
  excludedDomains: string[];
  useDefaultExclusions: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  modelSource: 'nano',
  custom: { baseUrl: 'http://localhost:11434/v1', model: 'qwen2.5:7b', apiKey: '' },
  cloud: { baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini', apiKey: '' },
  cloudConsentAt: null,
  template: '按我正在做的项目分组，工作和娱乐分开。',
  threshold: 0.6,
  summaryEnabled: false,
  summaryToCloud: false,
  sendDomainOnly: false,
  excludedDomains: [],
  useDefaultExclusions: true,
};

export async function getSettings(): Promise<Settings> {
  const { settings } = await chrome.storage.local.get('settings');
  const s = (settings ?? {}) as Partial<Settings>;
  return {
    ...DEFAULT_SETTINGS,
    ...s,
    custom: { ...DEFAULT_SETTINGS.custom, ...s.custom },
    cloud: { ...DEFAULT_SETTINGS.cloud, ...s.cloud },
  };
}

export async function saveSettings(patch: Partial<Settings>): Promise<Settings> {
  const next = { ...(await getSettings()), ...patch };
  await chrome.storage.local.set({ settings: next });
  return next;
}

/** Whether the chosen source sends tab data off this machine. A custom endpoint may be local or remote. */
export function sendsOffDevice(s: Settings): boolean {
  if (s.modelSource === 'cloud') return true;
  if (s.modelSource !== 'custom') return false;
  try {
    const host = new URL(s.custom.baseUrl).hostname;
    return !['localhost', '127.0.0.1', '[::1]'].includes(host);
  } catch {
    return true;
  }
}

export function endpointFor(s: Settings): EndpointConfig | null {
  if (s.modelSource === 'cloud') return s.cloud;
  if (s.modelSource === 'custom') return s.custom;
  return null;
}

/** Host permission pattern for an endpoint, requested when the user picks it. */
export function originPattern(baseUrl: string): string | null {
  try {
    const u = new URL(baseUrl);
    return `${u.protocol}//${u.hostname}/*`;
  } catch {
    return null;
  }
}
