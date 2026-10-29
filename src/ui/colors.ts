import type { GroupColor } from '../core/types';

/** Approximations of Chrome's tab group colours, for the dots in our UI. */
export const GROUP_COLOR_CSS: Record<GroupColor, string> = {
  grey: '#9aa0a6',
  blue: '#5c8ff0',
  red: '#e2675c',
  yellow: '#f2c043',
  green: '#4fb36b',
  pink: '#ee6eb5',
  purple: '#a876f0',
  cyan: '#45bed6',
  orange: '#f29a4a',
};

export const GROUP_COLOR_NAME: Record<GroupColor, string> = {
  grey: '灰',
  blue: '蓝',
  red: '红',
  yellow: '黄',
  green: '绿',
  pink: '粉',
  purple: '紫',
  cyan: '青',
  orange: '橙',
};
