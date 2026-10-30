// 多模态端点、静默重试、Agent 多轮收尾、审批、后端路由与 S3 兼容存储。
import assert from 'node:assert/strict';
import { flatten, DEFAULT_SETTINGS, deepMerge } from '../src/config.js';
import { normaliseModel, ttsSpeech, asrAudio, generateImage, ocrImage, endpointOf } from '../src/agent/models.js';
import { runAgent } from '../src/agent/loop.js';
import { makeEnv } from './harness.js';
import { createProject, removeProject } from '../src/store/projects.js';
import { getFileAuto } from '../src/store/kvfile.js';
import { savePatch } from '../src/store/settings.js';
import { handleSiteApi, serveSite } from '../src/serve.js';
import { backendCandidates, isBackendPath } from '../src/core/site-files.js';
import { execBackendFile } from '../src/core/backend.js';
import { sampleInput } from '../src/agent/fixtures.js';

let pass = 0;
const failures = [];
async function test(name, fn) {
  try { await fn(); pass++; console.log(`  ✓ ${name}`); }
  catch (e) { failures.push(`${name}: ${e?.message || e}`); console.log(`  ✗ ${name}: ${e?.message || e}`); }
}
const realFetch = globalThis.fetch;
function mockFetch(handler) {
  const calls = [];
  globalThis.fetch = async (url, init = {}) => { calls.push({ url: String(url), init }); return handler(url, init, calls.length); };
  return calls;
}
function json(value, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
}
function ready(kind, extra = {}) {
  return { ...normaliseModel({ enabled: true, baseUrl: 'https://models.example/v1', apiKey: 'k', model: kind, ...extra }) };
}
function coreStub() {
  return {
    env: {},
    getContext: () => ({ summary: '', messages: [] }),
    memList: () => [],
    groupRecent: async () => '',
  };
}

await test('五类端点分别拼接,不再共用文本端点', async () => {
  assert.equal(endpointOf('tts', ready('m')), 'https://models.example/v1/audio/speech');
  assert.equal(endpointOf('asr', ready('m')), 'https://models.example/v1/audio/transcriptions');
  assert.equal(endpointOf('imageGen', ready('m')), 'https://models.example/v1/images/generations');
  assert.equal(endpointOf('ocr', ready('m')), 'https://models.example/v1/chat/completions');
});

await test('Responses / Google / Claude 多模态请求体分别转换', async () => {
  const seen = [];
  mockFetch(async (url, init) => {
    const body = JSON.parse(init.body || '{}');
    seen.push({ url: String(url), body, headers: init.headers });
    const proto = seen.length === 1 ? 'responses' : seen.length === 2 ? 'google' : 'claude';
    if (proto === 'responses') return json({ output_text: 'ok-r' });
    if (proto === 'google') return json({ candidates: [{ content: { parts: [{ text: 'ok-g' }] } }] });
    return json({ content: [{ text: 'ok-c' }] });
  });
  const img = 'data:image/png;base64,AQID';
  const r1 = await ocrImage(ready('m', { protocol: 'responses' }), img);
  const r2 = await ocrImage(ready('m', { protocol: 'google' }), img);
  const r3 = await ocrImage(ready('m', { protocol: 'claude' }), img);
  assert.equal(r1.text, 'ok-r'); assert.equal(r2.text, 'ok-g'); assert.equal(r3.text, 'ok-c');
  assert.equal(seen[0].body.input[0].content[1].type, 'input_image');
  assert.match(seen[1].url, /models\/m:generateContent$/);
  assert.equal(seen[1].body.contents[0].parts[1].inline_data.data, 'AQID');
  assert.equal(seen[2].body.messages[0].content[1].source.type, 'base64');
  assert.equal(seen[2].body.messages[0].content[1].source.media_type, 'image/png');
});

await test('TTS 使用 input/voice,500 后静默重试成功', async () => {
  const seen = [];
  const calls = mockFetch(async (_u, _i, n) => {
    seen.push(n);
    if (n === 1) return json({ error: 'busy' }, 500);
    return new Response(new Uint8Array([1, 2, 3]), { headers: { 'Content-Type': 'audio/mpeg' } });
  });
  const r = await ttsSpeech(ready('FunAudioLLM/CosyVoice2-0.5B'), '你好', { attempts: 2 });
  assert.equal(r.bytes.length, 3);
  assert.equal(calls.length, 2);
  const body = JSON.parse(calls[0].init.body);
  assert.equal(body.input, '你好');
  assert.equal(body.voice, 'FunAudioLLM/CosyVoice2-0.5B:alex');
  assert.equal('messages' in body, false);
});

await test('ASR 是 multipart 文件上传并读取 text', async () => {
  const calls = mockFetch(async () => json({ text: '识别结果' }));
  const r = await asrAudio(ready('FunAudioLLM/SenseVoiceSmall'), new Uint8Array([82, 73, 70, 70]), 'wav');
  assert.equal(r.text, '识别结果');
  assert.equal(calls[0].init.body instanceof FormData, true);
  assert.equal(calls[0].init.body.get('model'), 'FunAudioLLM/SenseVoiceSmall');
  assert.equal(calls[0].init.body.get('file').name, 'voice.wav');
  assert.equal(calls[0].init.headers['Content-Type'], undefined);
});

await test('文生图使用 image_size,429 后重试并兼容 b64_json', async () => {
  const calls = mockFetch(async (_u, _i, n) => n === 1
    ? json({ error: 'rate' }, 429)
    : json({ data: [{ b64_json: 'AQID'.repeat(20) }] }));
  const r = await generateImage(ready('Kwai-Kolors/Kolors'), '猫', { attempts: 2 });
  assert.equal(r.bytes.length, 60);
  const body = JSON.parse(calls[0].init.body);
  assert.equal(body.image_size, '1024x1024');
  assert.equal(body.num_inference_steps, 20);
  assert.equal('size' in body, false);
});

await test('Agent 连续两轮工具后仍返回正文', async () => {
  let n = 0;
  mockFetch(async () => {
    n++;
    if (n === 1) return json({ choices: [{ message: { content: '', tool_calls: [{ id: 'a', function: { name: 'calc', arguments: '{"expression":"1+2"}' } }] } }] });
    if (n === 2) return json({ choices: [{ message: { content: '', tool_calls: [{ id: 'b', function: { name: 'now', arguments: '{}' } }] } }] });
    return json({ choices: [{ message: { content: '两轮工具都完成,答案是 3。' } }] });
  });
  const cfg = flatten(deepMerge(DEFAULT_SETTINGS, { llm: { baseUrl: 'https://m/v1', apiKey: 'k' } }), {});
  const r = await runAgent({ cfg, core: coreStub(), convId: 'g:t', userText: '计算并给时间', log: () => {} });
  assert.equal(r.rounds, 3);
  assert.equal(r.toolTrace.length, 2);
  assert.match(r.reply, /答案是 3/);
});

await test('达到工具轮次上限会强制收尾,不留下空白', async () => {
  let n = 0;
  mockFetch(async () => {
    n++;
    if (n <= 2) return json({ choices: [{ message: { content: '', tool_calls: [{ id: `c${n}`, function: { name: 'calc', arguments: `{"expression":"${n}+1"}` } }] } }] });
    return json({ choices: [{ message: { content: '工具步骤已完成,项目已构建。' } }] });
  });
  const cfg = flatten(deepMerge(DEFAULT_SETTINGS, { llm: { baseUrl: 'https://m/v1', apiKey: 'k' }, agent: { maxRounds: 2 } }), {});
  const r = await runAgent({ cfg, core: coreStub(), convId: 'g:t', userText: '做完项目', log: () => {} });
  assert.equal(r.toolTrace.length, 2);
  assert.match(r.reply, /项目已构建/);
});

await test('多后端文件按路由执行,源码不公开,旧版仍可兜底', async () => {
  assert.equal(isBackendPath('backend/a.js'), true);
  assert.equal(isBackendPath('assets/a.js'), false);
  assert.ok(backendCandidates('a/b').includes('backend/a/b.js'));
  const env = makeEnv();
  const settings = deepMerge(DEFAULT_SETTINGS, { agent: { architectures: ['custom'] }, deploy: { confirm: false } });
  const r = await createProject(env, settings, {
    id: 'multi001', name: '多后端',
    files: [
      { path: 'index.html', content: '<h1>ok</h1>' },
      { path: 'backend/hello.js', content: 'return { text: "hello" };' },
      { path: 'backend/admin/stats.js', content: 'return { text: "stats" };' },
      { path: '_backend.js', content: 'return { text: "legacy" };' },
    ],
  });
  assert.equal(r.error, undefined);
  const cfg = flatten(settings, env);
  const a = await handleSiteApi(env, cfg, new Request('https://x/api/hello', { headers: { Referer: 'https://x/multi001/' } }), new URL('https://x/api/hello'));
  assert.equal(a.status, 200);
  assert.match(await a.text(), /hello/);
  const b = await handleSiteApi(env, cfg, new Request('https://x/api/admin/stats', { headers: { Referer: 'https://x/multi001/' } }), new URL('https://x/api/admin/stats'));
  assert.match(await b.text(), /stats/);
  const c = await handleSiteApi(env, cfg, new Request('https://x/api/other', { headers: { Referer: 'https://x/multi001/' } }), new URL('https://x/api/other'));
  assert.match(await c.text(), /legacy/);
  const hidden = await serveSite(env, cfg, new Request('https://x/multi001/backend/hello.js'), new URL('https://x/multi001/backend/hello.js'), {});
  assert.equal(hidden.status, 404);
});

await test('S3 .txt 兼容模式按项目隔离,逻辑文件照常读取和删除', async () => {
  const objects = new Map();
  const R2 = {
    async put(k, v) { objects.set(k, new Uint8Array(v)); },
    async get(k) { return objects.has(k) ? { arrayBuffer: async () => objects.get(k).buffer.slice(0) } : null; },
    async head(k) { return objects.has(k) ? { size: objects.get(k).length } : null; },
    async delete(k) { objects.delete(k); },
    async list({ prefix = '', limit = 1000 }) {
      const keys = [...objects.keys()].filter((k) => k.startsWith(prefix)).slice(0, limit);
      return { objects: keys.map((key) => ({ key, size: objects.get(key).length })), truncated: false };
    },
  };
  const env = makeEnv({ R2 });
  const settings = deepMerge(DEFAULT_SETTINGS, {
    storage: { cacheKV: false, stores: [{ id: 'r2', kind: 'r2', compatTxt: true, enabled: true, priority: 100, maxBytes: 1024 ** 3 }] },
    deploy: { confirm: false },
  });
  await savePatch(env, settings);
  const r = await createProject(env, settings, { id: 'compat01', name: '兼容', files: [{ path: 'index.html', content: '<h1>仍然运行</h1>' }] });
  assert.equal(r.error, undefined);
  const keys = [...objects.keys()];
  assert.equal(keys.length, 1);
  assert.match(keys[0], /^projects\/compat01\/.+\.txt$/);
  assert.equal(keys[0].includes('index.html'), false);
  const bytes = await getFileAuto(env, 'compat01', 'index.html');
  assert.equal(new TextDecoder().decode(bytes), '<h1>仍然运行</h1>');
  await removeProject(env, 'compat01');
  assert.equal(objects.size, 0);
});

await test('审批支持机器人管理员与缓存的群主身份,确认和取消都可用', async () => {
  const env = makeEnv();
  const core = env.BOT_CORE.get(env.BOT_CORE.idFromName('core'));
  // FakeDONamespace.get 返回 stub,通过 core() 取实体
  const obj = env.BOT_CORE.core('core');
  const settings = deepMerge(DEFAULT_SETTINGS, {
    admin: { openIds: [{ openid: 'BOT_ADMIN' }], groupAdmins: true },
    deploy: { confirm: false },
  });
  await savePatch(env, { admin: settings.admin });
  obj._cfg = null;
  const cfg = await obj.cfg(true);
  obj.rememberMemberRole({ scene: 'group', targetId: 'G1', userId: 'GROUP_ADMIN', memberRole: 'admin' });
  assert.equal(obj.isAdmin(cfg, { scene: 'group', targetId: 'G1', userId: 'GROUP_ADMIN' }), true);
  assert.equal(obj.isAdmin(cfg, { scene: 'group', targetId: 'G1', userId: 'BOT_ADMIN' }), true);
  assert.equal(obj.isAdmin(cfg, { scene: 'group', targetId: 'G1', userId: 'GUEST' }), false);
  obj.getToken = async () => 'T';
  obj.reply = async () => ({ sent: [{}], mode: 'passive' });
  obj.recallDeployCard = async () => {};
  obj.feedAgentSystemNotice = async () => {};
  let cardBody = null;
  globalThis.fetch = async (_u, init) => { cardBody = JSON.parse(init.body || '{}'); return json({ id: 'CARD1' }); };
  const p = { scene: 'group', targetId: 'G1', userId: 'BOT_ADMIN', messageId: 'M1', convId: 'g:G1' };
  const pending = await obj.createPendingDeploy({ name: '审批', files: [{ path: 'index.html', content: '<h1>x</h1>' }] }, p);
  const sent = await obj.sendDeployCard(p, { ...pending, name: '审批', files: [] }, cfg);
  assert.equal(sent.ok, true);
  assert.equal(cardBody.keyboard.content.rows[0].buttons[0].action.permission.type, 2);
  await obj.handleInteraction({ scene: 'group', targetId: 'G1', userId: 'GROUP_ADMIN', convId: 'g:G1', eventId: 'E1', buttonData: `approve:${pending.token}` });
  assert.equal(await obj.getPending(pending.token), null);
  const pending2 = await obj.createPendingDeploy({ name: '取消', files: [{ path: 'index.html', content: '<h1>x</h1>' }] }, p);
  await obj.handleInteraction({ scene: 'group', targetId: 'G1', userId: 'BOT_ADMIN', convId: 'g:G1', eventId: 'E2', buttonData: `cancel:${pending2.token}` });
  assert.equal(await obj.getPending(pending2.token), null);
});


await test('Python 后端通过可配置外部运行时执行', async () => {
  const calls = mockFetch(async () => json({ ok: true, value: { text: 'python-ok' } }));
  const r = await execBackendFile({
    path: 'backend/hello.py', code: 'return {"text":"python-ok"}', ctx: { method: 'GET' },
    settings: { deploy: { runtimes: { python: { url: 'https://runner.example/execute', apiKey: 'r' } } } },
  });
  assert.equal(r.ok, true);
  assert.equal(r.value.text, 'python-ok');
  const body = JSON.parse(calls[0].init.body);
  assert.equal(body.language, 'python');
  assert.equal(body.ctx.method, 'GET');
});

await test('部署失败释放审批单,可重试也可取消', async () => {
  const env = makeEnv();
  env.BOT_CORE.get(env.BOT_CORE.idFromName('core'));
  const obj = env.BOT_CORE.core('core');
  const pending = await obj.createPendingDeploy({ name: '失败重试', files: [] }, null);
  obj.createSite = async () => ({ error: '模拟构建失败' });
  const r = await obj.resolvePending(pending.token, true, { notify: false });
  assert.match(r.error, /模拟构建失败/);
  assert.notEqual(await obj.getPending(pending.token), null);
  const c = await obj.resolvePending(pending.token, false, { notify: false });
  assert.equal(c.canceled, true);
  assert.equal(await obj.getPending(pending.token), null);
});

await test('模型内置样例无需外链即可调用', async () => {
  assert.match(sampleInput('ocr-zh').img, /^data:image\/png;base64,/);
  assert.equal(sampleInput('asr-en').format, 'wav');
  assert.ok(sampleInput('asr-en').audioBytes.length > 44);
  assert.match(sampleInput('image-cat').prompt, /橘猫/);
});

globalThis.fetch = realFetch;
console.log(`\n${'='.repeat(60)}`);
if (failures.length) {
  console.log(`❌ 稳定性测试失败 ${failures.length} 项 / 共 ${pass + failures.length} 项`);
  failures.forEach((f) => console.log('   · ' + f));
  process.exit(1);
}
console.log(`✅ 稳定性测试全部通过:${pass} 项`);
