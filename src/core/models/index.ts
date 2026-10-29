import { endpointFor, originPattern, sendsOffDevice, type Settings } from '../settings';
import { nanoAvailability, nanoClient } from './nano';
import { openAiClient } from './openai';

export interface ModelClient {
  label: string;
  maxBatch: number;
  sendsOffDevice: boolean;
  complete(system: string, user: string, schema: object): Promise<string>;
}

/** The model cannot run right now. Organizing still applies rules; the message is shown to the user. */
export class ModelUnavailableError extends Error {}

export async function getModelClient(s: Settings): Promise<ModelClient> {
  switch (s.modelSource) {
    case 'none':
      throw new ModelUnavailableError('未选择模型来源，只按已确认的规则整理。可以在设置中选择模型。');
    case 'nano': {
      const a = await nanoAvailability();
      if (a === 'available') return nanoClient();
      if (a === 'downloadable' || a === 'downloading') {
        throw new ModelUnavailableError('本地模型尚未下载完成，请在设置页下载，或选择其他模型来源。');
      }
      throw new ModelUnavailableError('这台电脑上的 Chrome 不能使用本地模型，请在设置中选择其他模型来源。');
    }
    case 'custom':
    case 'cloud': {
      const cfg = endpointFor(s)!;
      if (!cfg.baseUrl || !cfg.model) throw new ModelUnavailableError('模型接口未配置完整，请在设置中填写地址和模型名。');
      const offDevice = sendsOffDevice(s);
      if (offDevice && !s.cloudConsentAt) {
        throw new ModelUnavailableError('还没有确认会发送到云端的内容，请在设置中确认后再使用。');
      }
      const pattern = originPattern(cfg.baseUrl);
      if (!pattern || !(await chrome.permissions.contains({ origins: [pattern] }))) {
        throw new ModelUnavailableError('还没有授权访问模型接口地址，请在设置中保存一次模型配置。');
      }
      return openAiClient(cfg, s.modelSource === 'cloud' ? '云端模型' : '自定义接口', offDevice);
    }
  }
}
