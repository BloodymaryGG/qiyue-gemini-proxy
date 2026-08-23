/* 单一 catch-all 路由：/api/gemini 与 /api/gemini/* 全部进入此函数
   （Vercel 原生文件路由，无 vercel.json、无路径歧义，子路径不会 404）。 */
import { proxyHandler } from '../lib/proxy.js';
export default proxyHandler;
export const config = {
  runtime: 'nodejs',
  regions: ['iad1'],
  maxDuration: 60,
};
