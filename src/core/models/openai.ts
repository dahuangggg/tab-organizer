import type { EndpointConfig } from '../settings';
import type { ModelClient } from './index';

interface ChatResponse {
  choices?: { message?: { content?: string } }[];
}

/** Any OpenAI-compatible /chat/completions endpoint: OpenAI, Ollama, LM Studio, vLLM, most proxies. */
export function openAiClient(cfg: EndpointConfig, label: string, sendsOffDevice: boolean): ModelClient {
  const url = `${cfg.baseUrl.replace(/\/+$/, '')}/chat/completions`;

  async function call(system: string, user: string, jsonMode: boolean): Promise<Response> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (cfg.apiKey) headers.Authorization = `Bearer ${cfg.apiKey}`;
    return fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: cfg.model,
        temperature: 0,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
        ...(jsonMode ? { response_format: { type: 'json_object' } } : {}),
      }),
      signal: AbortSignal.timeout(60_000),
    });
  }

  return {
    label,
    maxBatch: 80,
    sendsOffDevice,
    async complete(system, user) {
      let res = await call(system, user, true);
      // Some compatible servers reject response_format; the parser copes with plain text too.
      if (res.status === 400) res = await call(system, user, false);
      if (!res.ok) {
        const body = (await res.text()).slice(0, 200);
        throw new Error(`模型接口返回 ${res.status}${body ? `：${body}` : ''}`);
      }
      const data = (await res.json()) as ChatResponse;
      const content = data.choices?.[0]?.message?.content;
      if (typeof content !== 'string') throw new Error('模型接口没有返回内容');
      return content;
    },
  };
}
