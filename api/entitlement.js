import { saveVerifiedEntitlement, verifyAppleTransaction } from '../lib/access.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return send(res, { error: 'method_not_allowed' }, 405);
  if (req.headers['x-ai-app'] !== 'todoai') return send(res, { error: 'app_header_required' }, 403);
  try {
    const body = typeof req.body === 'object' ? req.body : JSON.parse(req.body || '{}');
    const installationID = String(body.installationID || '').trim();
    const transactionJWS = String(body.transactionJWS || '').trim();
    if (!installationID || !transactionJWS) return send(res, { error: 'installation_and_transaction_required' }, 400);
    const entitlement = await verifyAppleTransaction(transactionJWS);
    await saveVerifiedEntitlement(installationID, entitlement);
    return send(res, { ok: true, entitlement: { isPro: entitlement.isPro, productID: entitlement.productID, expiresDate: entitlement.expiresDate } }, 200);
  } catch (error) {
    console.warn('[todoai/entitlement] verification failed', error?.message || error);
    const status = String(error?.message || '').includes('not_configured') ? 503 : 422;
    return send(res, { error: status === 503 ? 'apple_server_not_configured' : 'transaction_verification_failed' }, status);
  }
}

function send(res, value, status) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(value));
}

export const config = { runtime: 'nodejs' };
