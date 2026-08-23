/* 静态函数入口（Vercel 官方支持的 /api 单层路由）。
   vercel.json 的 rewrites 把 /api/gemini 与 /api/gemini/* 都路由到这里；
   Vercel /api 目录不支持 [...catchAll]，所以不能直接建动态 catch-all 文件。 */
import { proxyHandler } from '../lib/proxy.js';
export default proxyHandler;
export const config = {
  runtime: 'nodejs',
  regions: ['iad1'],
  maxDuration: 60,
};
