import { Redis } from '@upstash/redis';
import { decodeJwt, importPKCS8, SignJWT } from 'jose';

export const FREE_DAILY_LIMIT = 5;
export const MONTHLY_PRODUCT_ID = 'todoai.pro.monthly';
export const LIFETIME_PRODUCT_ID = 'todoai.pro.lifetime';

let redis;
export function resolveRedisConfig(env = process.env) {
  // Vercel's Upstash integration can prepend the selected Custom Prefix to
  // its standard KV names. Prefer canonical names, then the connected names.
  const urlCandidates = [env.UPSTASH_REDIS_REST_URL, env.UPSTASH_REDIS_REST_KV_REST_API_URL, env.UPSTASH_REDIS_REST_KV_URL];
  const url = urlCandidates.find((value) => typeof value === 'string' && /^https?:\/\//i.test(value));
  const token = env.UPSTASH_REDIS_REST_TOKEN
    || env.UPSTASH_REDIS_REST_KV_REST_API_TOKEN;
  return { url, token };
}

function getRedis() {
  if (redis) return redis;
  const { url, token } = resolveRedisConfig();
  if (!url || !token) return null;
  redis = new Redis({ url, token });
  return redis;
}

function installationID(req) {
  return String(req.headers['x-todoai-installation-id'] || '').trim().slice(0, 160);
}

function operationID(req) {
  return String(req.headers['x-todoai-operation-id'] || '').trim().slice(0, 160);
}

function dayKey() {
  return new Date().toISOString().slice(0, 10);
}

function usageKey(id) { return `todoai:usage:${id}:${dayKey()}`; }
function entitlementKey(id) { return `todoai:entitlement:${id}`; }
function operationKey(id, op) { return `todoai:operation:${id}:${op}`; }

async function readEntitlement(id) {
  const store = getRedis();
  if (!store || !id) return { isPro: false, source: 'free' };
  const cached = await store.get(entitlementKey(id));
  if (!cached) return { isPro: false, source: 'free' };
  let value = cached;
  if (typeof cached === 'string') {
    try { value = JSON.parse(cached); } catch { return { isPro: false, source: 'free' }; }
  }
  const active = value?.isPro === true && (!value.expiresDate || new Date(value.expiresDate) > new Date());
  return { isPro: active, source: active ? String(value.productID || 'verified') : 'free', expiresDate: value.expiresDate || null };
}

export async function beginAIRequest(req) {
  const id = installationID(req);
  const op = operationID(req);
  if (!id || !op) return { allowed: false, status: 400, body: { error: 'installation_and_operation_id_required' } };
  const store = getRedis();
  if (!store) return { allowed: false, status: 503, body: { error: 'quota_store_not_configured' } };
  const entitlement = await readEntitlement(id);
  if (entitlement.isPro) return { allowed: true, isPro: true, entitlement, usage: { unlimited: true } };

  // Idempotency key makes retries/fallbacks of one user operation count once.
  const opKey = operationKey(id, op);
  const existing = await store.get(opKey);
  if (existing) return { allowed: true, isPro: false, entitlement, usage: await usage(id), reservationKey: opKey, alreadyReserved: true };

  // Lua makes the check-and-increment atomic at Redis, avoiding concurrent requests bypassing 5/day.
  const script = `local current = tonumber(redis.call('GET', KEYS[1]) or '0')
if current >= tonumber(ARGV[1]) then return -1 end
redis.call('INCR', KEYS[1])
redis.call('EXPIRE', KEYS[1], ARGV[2])
redis.call('SET', KEYS[2], 'reserved', 'EX', ARGV[2])
return current + 1`;
  const used = await store.eval(script, [usageKey(id), opKey], [String(FREE_DAILY_LIMIT), '172800']);
  if (Number(used) < 0) {
    return { allowed: false, status: 429, body: { error: 'daily_ai_quota_exhausted', limit: FREE_DAILY_LIMIT, resetAt: nextResetISO(), usage: await usage(id) } };
  }
  return { allowed: true, isPro: false, entitlement, usage: await usage(id), reservationKey: opKey, usageKey: usageKey(id), alreadyReserved: false };
}

export async function commitAIRequest(gate) {
  // Reservation remains an idempotency record until its short TTL expires.
  return gate;
}

export async function releaseAIRequest(gate) {
  if (!gate?.reservationKey || gate.alreadyReserved || gate.isPro) return;
  const store = getRedis();
  if (!store) return;
  const script = `if redis.call('GET', KEYS[2]) == 'reserved' then redis.call('DECR', KEYS[1]); redis.call('DEL', KEYS[2]); end return 1`;
  await store.eval(script, [gate.usageKey || '', gate.reservationKey], []);
}

export async function usage(id) {
  const store = getRedis();
  if (!store || !id) return { used: 0, limit: FREE_DAILY_LIMIT, remaining: FREE_DAILY_LIMIT, resetAt: nextResetISO() };
  const used = Number(await store.get(usageKey(id)) || 0);
  return { used, limit: FREE_DAILY_LIMIT, remaining: Math.max(0, FREE_DAILY_LIMIT - used), resetAt: nextResetISO() };
}

export async function saveVerifiedEntitlement(id, entitlement) {
  const store = getRedis();
  if (!store || !id) throw new Error('quota_store_not_configured');
  const ttl = entitlement.expiresDate ? Math.max(3600, Math.ceil((new Date(entitlement.expiresDate).getTime() - Date.now()) / 1000)) : 31536000;
  await store.set(entitlementKey(id), JSON.stringify(entitlement), { ex: ttl });
  return entitlement;
}

export function nextResetISO() {
  const date = new Date();
  date.setUTCHours(24, 0, 0, 0);
  return date.toISOString();
}

export function parseTransactionJWS(jws) {
  const payload = decodeJwt(jws);
  return {
    productID: String(payload.productId || ''),
    originalTransactionId: String(payload.originalTransactionId || payload.transactionId || ''),
    expiresDate: payload.expiresDate ? new Date(Number(payload.expiresDate)).toISOString() : null,
    revocationDate: payload.revocationDate ? new Date(Number(payload.revocationDate)).toISOString() : null,
    environment: payload.environment
      ? (String(payload.environment).toLowerCase() === 'sandbox' ? 'sandbox' : 'production')
      : null,
  };
}

async function appleTransactionLookup(token, environment, originalTransactionId) {
  const base = environment === 'sandbox' ? 'https://api.storekit-sandbox.itunes.apple.com' : 'https://api.storekit.itunes.apple.com';
  const response = await fetch(`${base}/inApps/v1/transactions/${encodeURIComponent(originalTransactionId)}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const data = await response.json().catch(() => ({}));
  return { response, data };
}

export async function verifyAppleTransaction(jws) {
  const local = parseTransactionJWS(jws);
  if (![MONTHLY_PRODUCT_ID, LIFETIME_PRODUCT_ID].includes(local.productID)) throw new Error('unsupported_product');
  if (local.revocationDate) return { ...local, isPro: false };
  if (local.productID === MONTHLY_PRODUCT_ID && local.expiresDate && new Date(local.expiresDate) <= new Date()) return { ...local, isPro: false };

  const issuer = process.env.TODOAI_APPLE_ISSUER_ID;
  const keyID = process.env.TODOAI_APPLE_KEY_ID;
  const privateKey = process.env.TODOAI_APPLE_PRIVATE_KEY;
  if (!issuer || !keyID || !privateKey) throw new Error('apple_server_credentials_not_configured');
  const key = await importPKCS8(privateKey.replace(/\\n/g, '\n'), 'ES256');
  const token = await new SignJWT({ bid: process.env.TODOAI_APPLE_BUNDLE_ID || 'com.qihanshi.todoai' })
    .setProtectedHeader({ alg: 'ES256', kid: keyID, typ: 'JWT' })
    .setIssuer(issuer).setAudience('appstoreconnect-v1').setIssuedAt().setExpirationTime('5m').sign(key);
  const configured = process.env.TODOAI_APPLE_ENVIRONMENT === 'sandbox' ? 'sandbox' : 'production';
  const preferred = local.environment || configured;
  const environments = [preferred, preferred === 'production' ? 'sandbox' : 'production'];
  let lastStatus = 500;
  let data;
  for (const environment of environments) {
    const result = await appleTransactionLookup(token, environment, local.originalTransactionId);
    lastStatus = result.response.status;
    if (result.response.ok) { data = result.data; break; }
    // A 400/404 is the normal signal that the transaction belongs to the other
    // Apple environment. Never fail over on auth/configuration errors.
    if (![400, 404].includes(result.response.status)) break;
  }
  if (!data) throw new Error(`apple_transaction_lookup_${lastStatus}`);
  const verified = parseTransactionJWS(data.signedTransactionInfo || jws);
  if (![MONTHLY_PRODUCT_ID, LIFETIME_PRODUCT_ID].includes(verified.productID)) throw new Error('unsupported_product');
  return { ...verified, isPro: !verified.revocationDate && (verified.productID === LIFETIME_PRODUCT_ID || !verified.expiresDate || new Date(verified.expiresDate) > new Date()) };
}

export function installationFromBody(body) { return String(body?.installationID || '').trim().slice(0, 160); }
