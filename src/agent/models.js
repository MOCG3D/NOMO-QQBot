/**
 * 万能模型层 —— 每一类模态走自己的真实端点。
 *
 * 关键认知(之前搞错的地方):不同模态的接口形态完全不同,
 * 不存在"一个 chat/completions 打天下"。
 *   OCR     POST /v1/chat/completions  ( 视觉模型 + image_url)  ← 只有它走 chat
 *   TTS     POST /v1/audio/speech      (JSON,input/voice/response_format)
 *   ASR     POST /v1/audio/transcriptions (multipart/form-data,file 二进制)
 *   图像     POST /v1/images/generations (JSON,image_size/negative_prompt/seed)
 *   压缩     POST /v1/chat/completions  (文本,复用主接口)
 *
 * 每类模型独立配 baseUrl + apiKey + model,可以指向不同服务商。
 * 地址栏填到 /v1 这一层即可,具体子路径在下面的 ENDPOINTS 里拼。
 */

import { sampleInput } from './fixtures.js';

const UA = 'NOMO-QQBot/4.0';
const DEFAULT_TIMEOUT = 60000;

/** 五类模型。key 同时是 settings.models 下的字段名 */
export const MODEL_KINDS = ['ocr', 'asr', 'tts', 'imageGen', 'compress'];

export const KIND_META = {
  ocr: {
    label: '图片识别 OCR', icon: '🔍',
    endpoint: 'POST {base}/chat/completions',
    desc: '走视觉大模型(如 GLM-4V / PaddleOCR-VL),把图片里的文字读出来。',
    sample: 'THUDM/GLM-4.1V-9B-Thinking',
  },
  asr: {
    label: '语音识别 ASR', icon: '🎙️',
    endpoint: 'POST {base}/audio/transcriptions',
    desc: '以 multipart/form-data 上传音频文件,模型如 SenseVoiceSmall。',
    sample: 'FunAudioLLM/SenseVoiceSmall',
  },
  tts: {
    label: '语音合成 TTS', icon: '🔊',
    endpoint: 'POST {base}/audio/speech',
    desc: '返回音频二进制。注意 voice 的格式是「模型ID:音色名」。',
    sample: 'FunAudioLLM/CosyVoice2-0.5B',
  },
  imageGen: {
    label: '图像生成', icon: '🎨',
    endpoint: 'POST {base}/images/generations',
    desc: '文生图。生成后会作为图片消息发给用户。',
    sample: 'Kwai-Kolors/Kolors',
  },
  compress: {
    label: '摘要压缩', icon: '🗜️',
    endpoint: 'POST {base}/chat/completions',
    desc: '把过长的对话历史压成摘要,省上下文。留空则复用主接口。',
    sample: 'Qwen/Qwen2.5-7B-Instruct',
  },
};

/** 四类文本协议,只对"文本进文本出"的模型有意义(OCR / 压缩) */
export const PROTOCOLS = ['chat', 'responses', 'google', 'claude'];

/**
 * 每类模型的端点与默认参数。subPath 会拼在 baseUrl 后面。
 * method=multipart 的由对应函数自己构造 FormData。
 */
export const ENDPOINTS = {
  ocr: { subPath: '/chat/completions', method: 'json' },
  asr: { subPath: '/audio/transcriptions', method: 'multipart' },
  tts: { subPath: '/audio/speech', method: 'json' },
  imageGen: { subPath: '/images/generations', method: 'json' },
  compress: { subPath: '/chat/completions', method: 'json' },
};

export const DEFAULT_MODEL = {
  enabled: false,
  baseUrl: '',
  apiKey: '',
  model: '',
  protocol: 'chat',
  prompt: '',
  extra: {},
};

/** 深合并单个模型配置,缺字段补默认值,脏字段清掉 */
export function normaliseModel(raw) {
  const m = raw && typeof raw === 'object' ? raw : {};
  const protocol = PROTOCOLS.includes(m.protocol) ? m.protocol : 'chat';
  return {
    enabled: m.enabled === true,
    baseUrl: String(m.baseUrl || '').trim().replace(/\/+$/, ''),
    apiKey: String(m.apiKey || '').trim(),
    model: String(m.model || '').trim(),
    protocol,
    prompt: String(m.prompt || ''),
    extra: m.extra && typeof m.extra === 'object' && !Array.isArray(m.extra) ? m.extra : {},
  };
}

export function normaliseModels(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const out = {};
  for (const k of MODEL_KINDS) out[k] = normaliseModel(src[k]);
  return out;
}

/** 判断一个模型配置是否真的能调(地址和模型名都填了) */
export function modelReady(m) {
  return !!m && m.enabled === true && !!m.baseUrl && !!m.model;
}

function timeoutOf(m) {
  const n = Number(m?.extra?.timeoutMs);
  return Number.isFinite(n) && n > 0 ? Math.max(1000, n) : DEFAULT_TIMEOUT;
}

function trimSlash(s) {
  return String(s || '').replace(/\/+$/, '');
}

function baseOf(m) {
  let b = trimSlash(m.baseUrl);
  const ep = ENDPOINTS[m.kind];
  // 用户可能把完整端点粘进来,这里截掉后缀,统一从 base 拼
  if (ep) b = b.replace(new RegExp(ep.subPath.replace(/[/]/g, '\\/') + '\\/?$', 'i'), '');
  b = b.replace(/\/(chat\/completions|messages|responses|audio\/speech|audio\/transcriptions|images\/generations)$/i, '');
  b = b.replace(/\/models\/[^/]+:generateContent\/?$/i, '');
  return b;
}

/** 拼出完整端点。kind 是模型类别(ocr/asr/...) */
export function endpointOf(kind, m) {
  const ep = ENDPOINTS[kind];
  if (!ep) return '';
  let sub = String(m.extra?.path || ep.subPath);
  if ((kind === 'ocr' || kind === 'compress') && !m.extra?.path) {
    if (m.protocol === 'responses') sub = '/responses';
    else if (m.protocol === 'claude') sub = '/v1/messages';
    else if (m.protocol === 'google') sub = `/models/${encodeURIComponent(m.model)}:generateContent`;
  }
  return `${baseOf(m)}${sub.startsWith('/') ? sub : '/' + sub}`;
}

function authHeaders(m) {
  const h = { 'User-Agent': UA };
  if (m.apiKey) h['Authorization'] = `Bearer ${m.apiKey}`;
  if (m.protocol === 'google' && m.apiKey) h['x-goog-api-key'] = m.apiKey;
  if (m.protocol === 'claude') {
    h['x-api-key'] = m.apiKey || '';
    h['anthropic-version'] = String(m.extra?.anthropicVersion || '2023-06-01');
    delete h['Authorization'];
  }
  Object.assign(h, m.extra?.headers && typeof m.extra.headers === 'object' ? m.extra.headers : {});
  return h;
}

async function readError(res) {
  const t = await res.text().catch(() => '');
  return `HTTP ${res.status} ${String(t).slice(0, 200)}`;
}

async function withTimeout(ms, fn) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new Error('timeout')), Math.max(1000, Number(ms) || DEFAULT_TIMEOUT));
  try {
    return await fn(ctrl.signal);
  } catch (e) {
    if (e?.name === 'AbortError' || /timeout/i.test(String(e?.message || ''))) {
      throw new Error(`请求超时(${ms}ms)`);
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

/* ------------------------------------------------------------------ *
 * 文本协议的请求构造与响应解析(OCR / 压缩用)
 * ------------------------------------------------------------------ */

export function parseByProtocol(protocol, json) {
  if (protocol === 'chat') {
    const msg = json?.choices?.[0]?.message || {};
    if (typeof msg.content === 'string') return { text: msg.content };
    if (Array.isArray(msg.content)) return { text: msg.content.map((c) => c?.text || '').join('') };
    return { text: '' };
  }
  if (protocol === 'responses') {
    if (typeof json?.output_text === 'string') return { text: json.output_text };
    const parts = [];
    for (const item of json?.output || []) {
      for (const c of item?.content || []) if (c?.text || c?.output_text) parts.push(c.text || c.output_text);
    }
    return { text: parts.join('') };
  }
  if (protocol === 'google') {
    const parts = [];
    for (const c of json?.candidates?.[0]?.content?.parts || []) if (c?.text) parts.push(c.text);
    return { text: parts.join('') };
  }
  if (protocol === 'claude') {
    if (typeof json?.content === 'string') return { text: json.content };
    if (Array.isArray(json.content)) return { text: json.content.map((c) => c?.text || '').join('') };
    return { text: '' };
  }
  return { text: '' };
}

function buildChatBody(m, messages) {
  const body = { model: m.model, messages, stream: false };
  if (m.prompt) body.messages = [{ role: 'system', content: m.prompt }, ...messages];
  return body;
}

function dataImage(url) {
  const m = String(url || '').match(/^data:([^;,]+)?(?:;[^,]*)?;base64,(.+)$/i);
  return m ? { mime: m[1] || 'image/png', data: m[2] } : null;
}

function claudeContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return String(content ?? '');
  const out = [];
  for (const part of content) {
    if (part?.type === 'text') out.push({ type: 'text', text: String(part.text || '') });
    if (part?.type === 'image_url') {
      const url = part.image_url?.url || '';
      const data = dataImage(url);
      out.push(data
        ? { type: 'image', source: { type: 'base64', media_type: data.mime, data: data.data } }
        : { type: 'image', source: { type: 'url', url } });
    }
  }
  return out;
}

function responsesContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return String(content ?? '');
  return content.map((part) => {
    if (part?.type === 'text') return { type: 'input_text', text: String(part.text || '') };
    if (part?.type === 'image_url') return { type: 'input_image', image_url: String(part.image_url?.url || '') };
    return { type: 'input_text', text: '' };
  });
}

function googleParts(content) {
  if (typeof content === 'string') return [{ text: content }];
  if (!Array.isArray(content)) return [{ text: String(content ?? '') }];
  const out = [];
  for (const part of content) {
    if (part?.type === 'text') out.push({ text: String(part.text || '') });
    if (part?.type === 'image_url') {
      const url = part.image_url?.url || '';
      const data = dataImage(url);
      out.push(data
        ? { inline_data: { mime_type: data.mime, data: data.data } }
        : { file_data: { mime_type: 'image/*', file_uri: url } });
    }
  }
  return out;
}

function buildClaudeBody(m, messages) {
  const sys = m.prompt || '';
  const rest = sys ? messages.filter((x) => x.role !== 'system') : messages;
  const body = {
    model: m.model,
    max_tokens: Number(m.extra?.maxTokens) || 4096,
    messages: rest.map((x) => ({ role: x.role === 'system' ? 'user' : x.role, content: claudeContent(x.content) })),
  };
  if (sys) body.system = sys;
  return body;
}

function buildGoogleBody(m, messages) {
  const body = {
    contents: messages.map((x) => ({
      role: x.role === 'assistant' ? 'model' : 'user',
      parts: googleParts(x.content),
    })),
  };
  if (m.prompt) body.systemInstruction = { parts: [{ text: m.prompt }] };
  return body;
}

/** 调用"文本进文本出"的模型(chat / responses / google / claude 四种协议) */
export async function callTextModel(kind, m, messages, opts = {}) {
  if (!modelReady(m)) throw new Error(`模型未配置或未启用:${KIND_META[kind]?.label || kind}`);
  const timeoutMs = Number(opts.timeoutMs) || timeoutOf(m);
  const headers = authHeaders(m);
  headers['Content-Type'] = 'application/json';
  headers['Accept'] = 'application/json';

  let body;
  if (m.protocol === 'claude') {
    body = buildClaudeBody(m, messages);
  } else if (m.protocol === 'google') {
    body = buildGoogleBody(m, messages);
    delete headers['Content-Type'];
    headers['Content-Type'] = 'application/json';
  } else if (m.protocol === 'responses') {
    body = {
      model: m.model,
      stream: false,
      input: messages.map((x) => ({
        role: x.role,
        content: responsesContent(x.content),
      })),
    };
    if (m.prompt) body.instructions = m.prompt;
  } else {
    body = buildChatBody(m, messages);
  }
  if (m.extra?.body && typeof m.extra.body === 'object') Object.assign(body, m.extra.body);

  const url = endpointOf(kind, m);
  const raw = await withTimeout(timeoutMs, (signal) => fetch(url, {
    method: 'POST', headers, body: JSON.stringify(body), signal,
  }));
  if (!raw.ok) throw new Error(await readError(raw));
  const txt = await raw.text();
  let json;
  try {
    json = JSON.parse(txt);
  } catch {
    throw new Error(`返回的不是 JSON: ${txt.slice(0, 200)}`);
  }
  if (json?.error) throw new Error(`接口报错: ${JSON.stringify(json.error).slice(0, 300)}`);
  const parsed = parseByProtocol(m.protocol, json);
  return opts.raw ? { ...parsed, raw: json } : parsed;
}

/* ------------------------------------------------------------------ *
 * 静默重试:网络错误、429、408、5xx 自动换退避重试。
 * 只重试「再发一次可能就好」的错误;4xx 参数错误立刻返回,不浪费时间。
 * ------------------------------------------------------------------ */

export function isTransientError(error) {
  const s = String(error?.message || error || '');
  if (/HTTP (40[0-9]|41[0-9]|42[0-24]|43[0-9]|44[0-9])\b/.test(s)
    && !/HTTP (408|429)\b/.test(s)) return false;
  return /timeout|超时|ECONN|ECONNRESET|ENOTFOUND|EAI_AGAIN|fetch failed|network|HTTP (408|429|5\d\d)\b|502|503|504|socket|closed|reset/i.test(s);
}

export async function withRetry(fn, { attempts = 3, baseDelayMs = 450, onRetry = null } = {}) {
  let last;
  for (let i = 0; i < Math.max(1, attempts); i++) {
    try {
      return await fn(i);
    } catch (e) {
      last = e;
      if (i + 1 >= attempts || !isTransientError(e)) throw e;
      if (onRetry) await onRetry(i + 1, e);
      const wait = Math.min(4000, baseDelayMs * (2 ** i)) + Math.floor(Math.random() * 120);
      await new Promise((r) => setTimeout(r, wait));
    }
  }
  throw last;
}

/** OCR:视觉模型 + image_url,四种文本协议共用。 */
export async function ocrImage(m, imageUrl, opts = {}) {
  const prompt = opts.prompt || m.prompt
    || '请把图片里的文字原样提取出来,保留换行;没有文字就回答「无文字」,不要解释。';
  return withRetry(() => callTextModel('ocr', m, [{
    role: 'user',
    content: [
      { type: 'text', text: prompt },
      { type: 'image_url', image_url: { url: String(imageUrl) } },
    ],
  }], { ...opts, raw: true }), { attempts: Number(opts.attempts) || 3 });
}

export async function ocrBytes(m, bytes, contentType = 'image/png', opts = {}) {
  return ocrImage(m, bytesToDataUrl(bytes, contentType), opts);
}

export function bytesToDataUrl(bytes, contentType = 'image/png') {
  return `data:${contentType};base64,${toBase64(bytes)}`;
}

function audioExt(format) {
  const f = String(format || 'wav').toLowerCase();
  return ['mp3', 'wav', 'amr', 'silk', 'flac', 'm4a', 'webm'].includes(f) ? f : 'wav';
}

/**
 * ASR:OpenAI 兼容的 multipart/form-data,不是 chat input_audio。
 * 兼容返回 {text}、{data:{text}}、纯文本,以及带 segments 的响应。
 */
export async function asrAudio(m, bytes, format = 'wav', opts = {}) {
  if (!modelReady(m)) throw new Error('语音识别模型未配置或未启用');
  const fmt = audioExt(format);
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || []);
  if (!u8.length) throw new Error('音频文件是空的');
  return withRetry(async () => {
    const form = new FormData();
    form.append('file', new Blob([u8], { type: audioContentType(fmt) }), `voice.${fmt}`);
    form.append('model', m.model);
    if (opts.language || m.extra?.language) form.append('language', String(opts.language || m.extra.language));
    if (m.extra?.responseFormat) form.append('response_format', String(m.extra.responseFormat));
    if (m.prompt) form.append('prompt', m.prompt);
    const headers = authHeaders(m);
    // 浏览器/Workers 会自己带 multipart boundary,绝不能手写 Content-Type
    delete headers['Content-Type'];
    const res = await withTimeout(Number(opts.timeoutMs) || timeoutOf(m), (signal) => fetch(endpointOf('asr', m), {
      method: 'POST', headers, body: form, signal,
    }));
    if (!res.ok) throw new Error(await readError(res));
    const raw = await res.text();
    let text = raw;
    try {
      const j = JSON.parse(raw);
      if (j?.error) throw new Error(`接口报错:${JSON.stringify(j.error).slice(0, 200)}`);
      text = j.text ?? j.data?.text ?? j.result?.text
        ?? (Array.isArray(j.segments) ? j.segments.map((s) => s.text || '').join('') : '')
        ?? (typeof j.data === 'string' ? j.data : '');
    } catch (e) {
      if (/接口报错/.test(String(e?.message || e))) throw e;
      // 纯文本响应直接用
    }
    return { text: String(text || '').trim(), raw };
  }, { attempts: Number(opts.attempts) || 3 });
}

function isMimoModel(m) {
  return /xiaomimimo\.com/i.test(String(m.baseUrl || '')) || /^mimo-/i.test(String(m.model || ''));
}

/**
 * MiMo TTS 官方协议:POST /chat/completions。
 * 合成文本在 assistant;风格/音色描述在 user;返回 message.audio.data(base64)。
 */
async function ttsMimo(m, text, opts = {}) {
  const format = String(opts.format || m.extra?.responseFormat || 'mp3').toLowerCase();
  const isClone = /voiceclone/i.test(m.model);
  const isDesign = /voicedesign/i.test(m.model);
  const mode = String(opts.ttsMode || m.extra?.ttsMode || (isClone ? 'clone' : isDesign ? 'design' : 'preset'));
  let voice = opts.voice || (mode === 'clone' ? (m.extra?.referenceAudio || m.extra?.voice || '') : (m.extra?.voice || 'Chloe'));
  if (voice.startsWith('builtin:')) {
    const sample = sampleInput(voice.slice('builtin:'.length) || 'asr-zh');
    if (!sample?.audioBytes) throw new Error('内置参考音频不存在');
    voice = `data:audio/wav;base64,${toBase64(sample.audioBytes)}`;
  }
  const audio = { format };
  if (mode === 'clone') {
    if (!voice) throw new Error('VoiceClone 需要参考音频(data:audio/...;base64,... 或音频 URL)');
    audio.voice = voice;
  } else if (mode !== 'design') {
    audio.voice = voice;
  }
  const style = String(opts.style || m.extra?.style || m.prompt || (mode === 'design' ? '清澈自然、温和有亲和力的年轻中文女声' : '用自然清晰的中文朗读'));
  const body = {
    model: m.model,
    messages: [
      { role: 'user', content: style },
      { role: 'assistant', content: text },
    ],
    audio,
    stream: false,
  };
  if (m.extra?.body && typeof m.extra.body === 'object') Object.assign(body, m.extra.body);
  const headers = {
    ...authHeaders(m),
    'api-key': m.apiKey || '',
    'Content-Type': 'application/json',
    Accept: 'application/json',
  };
  const res = await withTimeout(Number(opts.timeoutMs) || timeoutOf(m), (signal) => fetch(`${baseOf(m)}/chat/completions`, {
    method: 'POST', headers, body: JSON.stringify(body), signal,
  }));
  if (!res.ok) throw new Error(await readError(res));
  const j = await res.json().catch(() => ({}));
  if (j?.error) throw new Error(`MiMo 接口报错:${JSON.stringify(j.error).slice(0, 250)}`);
  const msg = j?.choices?.[0]?.message || {};
  const audioOut = msg.audio || j.audio || {};
  const b64 = audioOut.data || msg.audio_data;
  if (typeof b64 !== 'string' || b64.length < 32) {
    throw new Error(`MiMo 响应没有 message.audio.data:${JSON.stringify(j).slice(0, 250)}`);
  }
  const actualFormat = String(audioOut.format || format || 'mp3').toLowerCase();
  return {
    bytes: fromBase64(b64),
    contentType: actualFormat === 'wav' ? 'audio/wav' : 'audio/mpeg',
    transcript: msg.content || audioOut.transcript || '',
  };
}

/** TTS:/audio/speech。voice 按服务商规则默认成「模型ID:音色」。 */
export async function ttsSpeech(m, text, opts = {}) {
  if (!modelReady(m)) throw new Error('语音合成模型未配置或未启用');
  const input = String(text || '').trim();
  if (!input) throw new Error('要合成的文字是空的');
  return withRetry(async () => {
    if (isMimoModel(m)) return await ttsMimo(m, input, opts);
    const voice = String(opts.voice || m.extra?.voice || 'alex');
    const body = {
      model: m.model,
      input,
      voice: voice.includes(':') ? voice : `${m.model}:${voice}`,
      response_format: String(opts.format || m.extra?.responseFormat || 'mp3'),
      stream: m.extra?.stream !== false,
      speed: Number(opts.speed || m.extra?.speed || 1),
      gain: Number(m.extra?.gain || 0),
    };
    if (m.extra?.sampleRate) body.sample_rate = Number(m.extra.sampleRate);
    if (m.extra?.body && typeof m.extra.body === 'object') Object.assign(body, m.extra.body);
    const headers = { ...authHeaders(m), 'Content-Type': 'application/json', Accept: '*/*' };
    const res = await withTimeout(Number(opts.timeoutMs) || timeoutOf(m), (signal) => fetch(endpointOf('tts', m), {
      method: 'POST', headers, body: JSON.stringify(body), signal,
    }));
    if (!res.ok) throw new Error(await readError(res));
    const ct = String(res.headers.get('content-type') || '').split(';')[0].toLowerCase();
    if (ct.includes('json') || ct.startsWith('text/')) {
      const raw = await res.text();
      let j;
      try { j = JSON.parse(raw); } catch { throw new Error(`TTS 返回异常:${raw.slice(0, 200)}`); }
      if (j?.error) throw new Error(`TTS 接口报错:${JSON.stringify(j.error).slice(0, 200)}`);
      const b64 = j.audio || j.audioContent || j.data || j.b64 || j.audio_base64;
      if (typeof b64 === 'string' && b64.length > 32) return { bytes: fromBase64(b64), contentType: 'audio/mpeg', raw: j };
      if (typeof j.url === 'string' && j.url) {
        const rr = await fetch(j.url, { headers: { 'User-Agent': UA } });
        if (!rr.ok) throw new Error(`TTS 音频下载失败 HTTP ${rr.status}`);
        return { bytes: new Uint8Array(await rr.arrayBuffer()), contentType: rr.headers.get('content-type') || 'audio/mpeg', url: j.url };
      }
      throw new Error('TTS JSON 响应里没有 audio/url 字段');
    }
    const buf = new Uint8Array(await res.arrayBuffer());
    if (!buf.length) throw new Error('TTS 返回了空音频');
    return { bytes: buf, contentType: ct || 'audio/mpeg' };
  }, { attempts: Number(opts.attempts) || 3 });
}

/** 文生图:/images/generations,服务商常见字段 image_size / negative_prompt / steps。 */
export async function generateImage(m, prompt, opts = {}) {
  if (!modelReady(m)) throw new Error('图像生成模型未配置或未启用');
  const p = String(prompt || '').trim();
  if (!p) throw new Error('图片描述是空的');
  return withRetry(async () => {
    const isCogView = /cogview/i.test(m.model) || /bigmodel\.cn/i.test(m.baseUrl);
    const body = {
      model: m.model,
      prompt: p,
    };
    if (isCogView) {
      body.size = String(opts.size || m.extra?.size || '1024x1024');
      if (m.extra?.watermarkEnabled !== undefined) body.watermark_enabled = m.extra.watermarkEnabled === true;
    } else {
      body.image_size = String(opts.size || m.extra?.size || '1024x1024');
      body.batch_size = Math.max(1, Math.min(4, Number(opts.batchSize) || 1));
      body.num_inference_steps = Math.max(1, Math.min(100, Number(opts.steps || m.extra?.steps || 20)));
    }
    if (m.extra?.negativePrompt) body.negative_prompt = String(m.extra.negativePrompt);
    if (m.extra?.guidanceScale) body.guidance_scale = Number(m.extra.guidanceScale);
    if (opts.seed !== undefined || m.extra?.seed) body.seed = Number(opts.seed ?? m.extra.seed);
    // 只有明确要求 OpenAI b64 形态时才加 response_format;Kolors 等不需要
    if (m.extra?.responseFormat) body.response_format = String(m.extra.responseFormat);
    if (m.extra?.body && typeof m.extra.body === 'object') Object.assign(body, m.extra.body);
    const headers = { ...authHeaders(m), 'Content-Type': 'application/json', Accept: 'application/json' };
    const res = await withTimeout(Number(opts.timeoutMs) || timeoutOf(m), (signal) => fetch(endpointOf('imageGen', m), {
      method: 'POST', headers, body: JSON.stringify(body), signal,
    }));
    if (!res.ok) throw new Error(await readError(res));
    const j = await res.json().catch(() => ({}));
    if (j?.error) throw new Error(`图像接口报错:${JSON.stringify(j.error).slice(0, 200)}`);
    const first = j?.data?.[0] || j?.images?.[0] || j || {};
    const b64 = first.b64_json || first.base64 || first.image || j.b64_json;
    if (typeof b64 === 'string' && b64.length > 32) {
      return { bytes: fromBase64(b64.replace(/^data:[^,]+,/, '')), contentType: 'image/png', raw: j };
    }
    const url = first.url || first.file_url || first.image_url || j.url || j.file_url;
    if (typeof url === 'string' && url) {
      const rr = await fetch(url, { headers: { 'User-Agent': UA } });
      if (!rr.ok) throw new Error(`生成图下载失败 HTTP ${rr.status}`);
      return { bytes: new Uint8Array(await rr.arrayBuffer()), contentType: rr.headers.get('content-type') || 'image/png', url };
    }
    throw new Error('图像接口响应里没有 b64_json 或 url');
  }, { attempts: Number(opts.attempts) || 3 });
}

export async function compressText(m, text, opts = {}) {
  const prompt = opts.prompt || m.prompt
    || '把下面的对话历史压缩成不超过 800 字的摘要,保留事实、用户偏好、待办和结论,丢掉闲聊。只输出摘要。';
  return withRetry(() => callTextModel('compress', m, [
    { role: 'system', content: prompt },
    { role: 'user', content: String(text || '').slice(0, Number(opts.maxChars) || 20000) },
  ], opts), { attempts: Number(opts.attempts) || 3 });
}

export function fromBase64(s) {
  const bin = atob(String(s || ''));
  const u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  return u8;
}

export function toBase64(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || []);
  let s = '';
  const chunk = 0x8000;
  for (let i = 0; i < u8.length; i += chunk) s += String.fromCharCode.apply(null, u8.subarray(i, i + chunk));
  return btoa(s);
}

export function audioContentType(format) {
  const f = String(format || '').toLowerCase();
  if (f === 'mp3' || f === 'mpeg') return 'audio/mpeg';
  if (f === 'amr') return 'audio/amr';
  if (f === 'wav' || f === 'pcm') return 'audio/wav';
  if (f === 'silk') return 'audio/silk';
  if (f === 'flac') return 'audio/flac';
  if (f === 'webm') return 'audio/webm';
  return 'audio/mpeg';
}

export { UA };
