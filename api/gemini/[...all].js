/* catch-all 路由：/api/gemini/* 全部进入此函数（Vercel 原生文件路由，
   不再依赖 vercel.json rewrite，避免子路径被平台 404 或重写语义不确定）。 */
import { proxyHandler } from '../../lib/proxy.js';
export default proxyHandler;
export const config = {
  runtime: 'nodejs',
  regions: ['iad1'],
  maxDuration: 60,
};
