// Music タブ: ブラウザから Claude API に直接つないで、演出のキューを考えてもらう。
// API キーはその人のもの。リポジトリや箱には置かず、このブラウザの中だけに置く（既定はタブを閉じると消える）。
// SDK を入れず fetch で呼ぶ: 箱に入れる画面は全体で 120 KB まで（/api/settings の ui_max）なので、重いライブラリを足さない。

import { SHOW_SYSTEM_PROMPT, showPlanSchema, type ShowPlan } from '../engine/musicShow.js';

export const showModels = [
  { id: 'claude-opus-5-5', label: 'Claude Opus 5.5', inPerM: 4, outPerM: 20 },
  { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5 (cheaper)', inPerM: 2, outPerM: 10 },
] as const;
export type ShowModelId = (typeof showModels)[number]['id'];

const KEY_LOCAL = 'miseru.claudeKey';
const KEY_SESSION = 'miseru.claudeKey.session';

export function loadApiKey(): { key: string; remember: boolean } {
  try {
    const remembered = localStorage.getItem(KEY_LOCAL);
    if (remembered) return { key: remembered, remember: true };
    return { key: sessionStorage.getItem(KEY_SESSION) ?? '', remember: false };
  } catch {
    return { key: '', remember: false };
  }
}

export function saveApiKey(key: string, remember: boolean) {
  try {
    if (remember && key) localStorage.setItem(KEY_LOCAL, key);
    else localStorage.removeItem(KEY_LOCAL);
    if (!remember && key) sessionStorage.setItem(KEY_SESSION, key);
    else sessionStorage.removeItem(KEY_SESSION);
  } catch {
    // 覚えられなくても、この画面を開いている間は使える
  }
}

export function forgetApiKey() {
  saveApiKey('', false);
}

export interface ShowResult {
  plan: ShowPlan;
  usage: { input: number; output: number; cost: number };
  model: string;
}

class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

/** Claude に演出を考えてもらう（Messages API、ストリーミング）。signal で止められる。onProgress で受け取った文字数を知らせる */
export async function askClaudeForShow(opts: {
  apiKey: string;
  model: ShowModelId;
  userMessage: string;
  signal?: AbortSignal;
  onProgress?: (chars: number) => void;
}): Promise<ShowResult> {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    signal: opts.signal,
    headers: {
      'content-type': 'application/json',
      'x-api-key': opts.apiKey,
      'anthropic-version': '2026-10-21',
      // 断られたときは server-side fallback で別のモデルに回す
      'anthropic-beta': 'server-side-fallback-2026-07-01',
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify({
      model: opts.model,
      max_tokens: 64000,
      stream: true,
      fallbacks: 'default',
      thinking: { type: 'adaptive' },
      output_config: { effort: 'high', format: { type: 'json_schema', schema: showPlanSchema } },
      system: SHOW_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: opts.userMessage }],
    }),
  });
  if (!res.ok || !res.body) {
    let message = `HTTP ${res.status}`;
    try {
      const j = (await res.json()) as { error?: { message?: string } };
      if (j.error?.message) message = j.error.message;
    } catch {
      /* 本文が読めなくても状態の番号で知らせる */
    }
    throw new ApiError(res.status, message);
  }

  let text = '';
  let stopReason: string | null = null;
  let model: string = opts.model;
  let input = 0;
  let output = 0;
  const handle = (ev: Record<string, any>) => {
    switch (ev.type) {
      case 'message_start': {
        const u = ev.message?.usage ?? {};
        input = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
        model = ev.message?.model ?? model;
        break;
      }
      case 'content_block_start':
        // 別のモデルに切り替わったら、それまでの途中の文は捨てる
        if (ev.content_block?.type === 'fallback') {
          text = '';
          model = ev.content_block?.to?.model ?? model;
        }
        break;
      case 'content_block_delta':
        if (ev.delta?.type === 'text_delta') {
          text += ev.delta.text;
          opts.onProgress?.(text.length);
        }
        break;
      case 'message_delta':
        stopReason = ev.delta?.stop_reason ?? stopReason;
        if (ev.usage?.output_tokens !== undefined) output = ev.usage.output_tokens;
        if (ev.usage?.input_tokens) input = ev.usage.input_tokens + (ev.usage.cache_read_input_tokens ?? 0) + (ev.usage.cache_creation_input_tokens ?? 0);
        break;
      case 'error':
        throw new ApiError(ev.error?.type === 'overloaded_error' ? 529 : 500, ev.error?.message ?? 'Stream error');
    }
  };

  // Server-Sent Events を 1 件ずつ読む
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += value;
    let cut: number;
    while ((cut = buf.indexOf('\n\n')) >= 0) {
      const chunk = buf.slice(0, cut);
      buf = buf.slice(cut + 2);
      const data = chunk
        .split('\n')
        .filter((l) => l.startsWith('data:'))
        .map((l) => l.slice(5).trim())
        .join('');
      if (data) handle(JSON.parse(data));
    }
  }

  if (stopReason === 'refusal') throw new Error('Claude declined this request. Try rewording the direction.');
  if (stopReason === 'max_tokens') throw new Error('The answer was cut off (too long). Ask for fewer cues or a shorter song.');
  let plan: ShowPlan;
  try {
    plan = JSON.parse(text) as ShowPlan;
  } catch {
    throw new Error('Could not read the answer from Claude.');
  }
  if (!plan || !Array.isArray(plan.cues)) throw new Error('The answer from Claude had no cues.');
  const price = showModels.find((m) => model.startsWith(m.id)) ?? showModels.find((m) => m.id === opts.model) ?? showModels[0];
  return { plan, usage: { input, output, cost: (input * price.inPerM + output * price.outPerM) / 1e6 }, model };
}

/** エラーを画面に出す短い英語に */
export function describeError(e: unknown): string {
  const err = e as { status?: number; name?: string; message?: string };
  if (err?.name === 'AbortError' || /aborted/i.test(err?.message ?? '')) return 'Stopped.';
  if (err?.status === 401) return 'The API key was not accepted. Check the key.';
  if (err?.status === 403) return 'This API key is not allowed to use this model.';
  if (err?.status === 429) return 'Rate limit or credit limit reached. Wait a little, or check your API credits.';
  if (err?.status && err.status >= 500) return `Claude API is busy or down (${err.status}). Try again later.`;
  if (/fetch|network|Failed to fetch/i.test(err?.message ?? '')) return 'Could not reach the Claude API. This device needs an internet connection.';
  return err?.message ?? String(e);
}
