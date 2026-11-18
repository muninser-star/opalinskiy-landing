import { createClient } from '@supabase/supabase-js';
import { BotEngine } from './engine.mjs';
import { DashboardAPI, TelegramAPI } from './adapters.mjs';
import { summary } from './core.mjs';
import { BotStore } from './store.mjs';
import { isTranscriptLinkCommand, issueTranscriptCode } from './transcript-code.ts';

const env = (name: string) => Deno.env.get(name) ?? '';
const encoder = new TextEncoder();

function equalSecret(actual: string, expected: string) {
  const a = encoder.encode(actual), b = encoder.encode(expected);
  let mismatch = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) mismatch |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return mismatch === 0 && b.length > 0;
}

async function readBody(request: Request, limit = 262_144) {
  const declared = Number(request.headers.get('content-length') || 0);
  if (declared > limit) throw new Error('body_too_large');
  if (!request.body) return '';
  const reader = request.body.getReader(), chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel();
      throw new Error('body_too_large');
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}

async function readJson(request: Request) {
  try { return JSON.parse(await readBody(request)); }
  catch (error) {
    if (error instanceof Error && error.message === 'body_too_large') throw error;
    throw new Error('bad_json');
  }
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });
}

const db = createClient(env('SUPABASE_URL'), env('SUPABASE_SERVICE_ROLE_KEY'), {
  auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
});
const store = new BotStore(db);
const dashboard = new DashboardAPI({ db, env });
const telegram = new TelegramAPI(env('FAMILY_BOT_TOKEN'));
const engine = new BotEngine({ store, dashboard, telegram, env });

Deno.serve(async (request) => {
  if (request.method === 'GET') return json({ ok: true, service: 'family-bot', mode: 'dashboard' });
  if (request.method !== 'POST') return json({ ok: false, error: 'method_not_allowed' }, 405);

  const cronHeader = request.headers.get('x-family-cron');
  if (cronHeader !== null) {
    if (!equalSecret(cronHeader, env('FAMILY_BOT_CRON_SECRET'))) return json({ ok: false, error: 'unauthorized' }, 401);
    try {
      const body = await readJson(request);
      if (body?.status === true || body?.preview === true) {
        const profile = await store.profile(env('FAMILY_BOT_OWNER_ID'));
        if (!profile?.active) return json({ ok: false, profile: false }, 503);
        const context = await dashboard.access(profile);
        const snapshot = await dashboard.snapshot(context);
        return json({ ok: true, mode: 'dashboard', profile: true, config: !snapshot.configError, sources: Object.fromEntries(snapshot.tiles.map(t => [t.kind, t.result.state])), events: snapshot.events.state, ...(body.preview === true ? { text: summary(snapshot, new Date(), profile.settings).text } : {}) });
      }
      if (body?.tick !== true) return json({ ok: false, error: 'bad_request' }, 400);
      return json(await engine.tick());
    } catch (error) {
      const code = error instanceof Error ? error.message : '';
      return json({ ok: false, error: code === 'body_too_large' || code === 'bad_json' ? code : 'internal_error' }, code === 'body_too_large' ? 413 : code === 'bad_json' ? 400 : 500);
    }
  }

  const webhookHeader = request.headers.get('x-telegram-bot-api-secret-token') || '';
  if (!equalSecret(webhookHeader, env('FAMILY_BOT_WEBHOOK_SECRET'))) return json({ ok: false, error: 'unauthorized' }, 401);
  try {
    const body = await readJson(request);
    if (!body || typeof body !== 'object' || !Number.isSafeInteger(body.update_id)) return json({ ok: false, error: 'bad_update' }, 400);
    if (isTranscriptLinkCommand(body.message?.text)) {
      const profile = await engine.privateProfile(body.message.from, body.message.chat);
      if (!profile) return json({ ok: true });
      const key = 'transcript:code:' + profile.owner_id + ':' + body.update_id;
      if (!await store.claim(key, profile.owner_id, 'update', {}, 600)) return json({ ok: true });
      const code = await issueTranscriptCode(db, Number(profile.chat_id));
      await telegram.send(profile.chat_id, 'Код для подключения расшифровки: ' + code +
        '\nВведите его на странице расшифровки. Код одноразовый и действует 10 минут.');
      await store.finish(key, 'done');
      return json({ ok: true });
    }
    await engine.update(body);
    return json({ ok: true });
  } catch (error) {
    const code = error instanceof Error ? error.message : '';
    return json({ ok: false, error: code === 'body_too_large' || code === 'bad_json' ? code : 'internal_error' }, code === 'body_too_large' ? 413 : code === 'bad_json' ? 400 : 500);
  }
});
