/* 静态函数入口（Vercel 官方支持的 /api 单层路由）。
   vercel.json 的 rewrites 把 /api/gemini 与 /api/gemini/* 都路由到这里；
   Vercel /api 目录不支持 [...catchAll]，所以不能直接建动态 catch-all 文件。 */
import { Readable } from 'node:stream';
import { proxyHandler } from '../lib/proxy.js';

export default async function handler(req, res) {
  const response = await proxyHandler(req);

  res.statusCode = response.status;
  response.headers.forEach((value, key) => {
    res.setHeader(key, value);
  });

  if (!response.body) {
    res.end();
    return;
  }

  Readable.fromWeb(response.body).pipe(res);
}

/* 注意：不设置 regions / maxDuration。
   Hobby 免费版上 regions:['iad1'] 曾导致函数部署成功但调用一直挂起到超时，
   先去掉这两个配置，用默认区域验证函数本体是否正常。 */
export const config = {
  runtime: 'nodejs',
};
