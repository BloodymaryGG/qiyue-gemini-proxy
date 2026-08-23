import { proxyHandler } from '../lib/proxy.js';
export default proxyHandler;
export const config = {
  runtime: 'nodejs',
  regions: ['iad1'], // 美东（Google Gemini API 支持区域）
  maxDuration: 60, // 解读为流式输出，默认 10s 会中途掐断；上限按当前套餐（Hobby 60s/300s）取保守值
};
