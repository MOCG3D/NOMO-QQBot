// 开关绑定的 DOM 级自检。
// 静态检查(check:switches)只看源码里「有绑定」,抓不到两类真问题:
//   1. bindTog/stog 的节点在 DOM 里根本不存在 —— 绑定函数静默 return,开关是死图片;
//   2. 整页 script 提前抛错,后面的绑定一行都没执行。
// 这个检查用 jsdom 把面板真跑起来,逐页导航、逐个点击,同时断言
// class 翻转 + 是否发出 POST。任一面板缺 jsdom 时自动跳过。
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const JSDOM_PATH = ['/tmp/domtest/node_modules/jsdom/lib/api.js', 'jsdom']
  .map((p) => (p.startsWith('/') ? p : path.join(ROOT, 'node_modules', p)))
  .find((p) => fs.existsSync(p));

if (!JSDOM_PATH) {
  console.log('⏭  jsdom 不存在,跳过 DOM 级开关自检(不影响其它检查)');
  process.exit(0);
}

const { JSDOM, VirtualConsole } = await import(JSDOM_PATH);
const { panelPage } = await import(path.join(ROOT, 'src/panel/ui.js'));
const { quotaOf } = await import(path.join(ROOT, 'src/store/projects.js'));

const SETTINGS = {
  qq: { appId: 'x', appSecret: 'x', mode: 'webhook', markdown: true, answerDelivery: 'auto' },
  groups: { allowAll: true, list: [] },
  admin: { groupAdmins: false },
  deploy: { allowData: true, confirm: true, maxProjects: 5 },
  update: { check: true, force: true, forceNote: '' },
  logs: { debug: false },
  search: { enabled: true, mergeReader: true },
  agent: { modalities: ['text'], concurrency: 4 },
  motd: { enabled: true, imageEnabled: false },
  llm: { baseUrl: 'https://api.example/v1', apiKey: 'sk', model: 'm' },
  ui: { homepage: { enabled: true, showGithub: true, custom: false } },
};

const POSTS = [];
const warn = [];
const vc = new VirtualConsole();
vc.on('jsdomError', (e) => warn.push(String((e.detail && e.detail.stack) || e.message || e).slice(0, 300)));
vc.on('error', (...a) => warn.push(a.map(String).join(' ').slice(0, 300)));
vc.on('warn', (...a) => warn.push('WARN ' + a.map(String).join(' ').slice(0, 200)));

const dom = new JSDOM(panelPage({ user: 'a' }), {
  runScripts: 'dangerously',
  pretendToBeVisual: true,
  url: 'https://bot.example.com/administrator',
  virtualConsole: vc,
  beforeParse(w) {
    w.fetch = (u, o) => {
      if (String(o?.method || 'GET').toUpperCase() === 'POST') POSTS.push(String(o.body || ''));
      const isModels = String(u).endsWith('/models');
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve(isModels ? {
          models: ['mimo-v2.5-tts', 'mimo-v2.5-tts-voiceclone'],
          items: [
            { id: 'mimo-v2.5-tts', icon: '', modalities: ['tts', 'audio-output'] },
            { id: 'mimo-v2.5-tts-voiceclone', icon: '', modalities: ['tts', 'voice-clone', 'audio-input'] },
          ],
        } : {
          settings: SETTINGS,
          callbackUrl: 'https://bot.example.com/qq/cb',
          modeText: 'WebHook',
          quota: { ...quotaOf(SETTINGS), used: 0 },
          groups: [],
          totals: {},
          builtin: [{ id: 'deploy', name: '部署工具', description: 'd', enabled: true, tools: ['deploy_project'] }],
          external: [],
        }),
        text: () => Promise.resolve('{}'),
      });
    };
    w.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
    Object.defineProperty(w.Element.prototype, 'clientWidth', { get: () => 400 });
  },
});

const W = dom.window;
const D = W.document;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const go = async (label, ms = 400) => {
  const nav = [...D.querySelectorAll('.nav')].find((n) => n.textContent.trim().startsWith(label));
  if (!nav) throw new Error('找不到导航项: ' + label);
  nav.dispatchEvent(new W.MouseEvent('click', { bubbles: true }));
  await wait(ms);
};
const fire = (sel) => {
  const n = D.querySelector(sel);
  if (!n) throw new Error('找不到开关节点 ' + sel);
  const before = n.classList.contains('on');
  n.dispatchEvent(new W.MouseEvent('click', { bubbles: true, cancelable: true }));
  return { before, after: n.classList.contains('on') };
};

await wait(150);
const failures = [];

// 1) 首页配置页:三个开关都必须「点了就存」
await go('首页配置');
for (const [attr, patch] of [
  ['hpEnabled', '{"ui":{"homepage":{"enabled":'],
  ['hpGithub', '{"ui":{"homepage":{"showGithub":'],
  ['hpCustom', '{"ui":{"homepage":{"custom":'],
]) {
  const before = POSTS.length;
  const r = fire(`[data-t="${attr}"]`);
  await wait(60);
  const sent = POSTS.slice(before);
  if (r.before === r.after) failures.push(`${attr} 点击后 class 没有翻转`);
  if (!sent.some((b) => b.includes(patch.slice(0, 24)))) {
    failures.push(`${attr} 点击后没有发出保存请求 ${patch}…(实际:${sent.join('|') || '无'})`);
  }
}

// 2) Agent 配置页:搜索 / 视觉 / MOTD 四个开关
await go('Agent 配置', 500);
for (const [attr, patch] of [
  ['agSeEnabled', '{"search":{"enabled":'],
  ['agSeMerge', '{"search":{"mergeReader":'],
  ['agVision', '{"agent":{"vision":'],
  ['agMotdEnabled', '{"motd":{"enabled":'],
  ['agMotdImage', '{"motd":{"imageEnabled":'],
]) {
  const before = POSTS.length;
  const r = fire(`[data-t="${attr}"]`);
  await wait(60);
  const sent = POSTS.slice(before);
  if (r.before === r.after) failures.push(`${attr} 点击后 class 没有翻转`);
  if (!sent.some((b) => b.includes(patch.slice(0, 22)))) {
    failures.push(`${attr} 点击后没有发出保存请求 ${patch}…(实际:${sent.join('|') || '无'})`);
  }
}
// voice 开关:只翻视觉,最终由「保存」按钮连同 modalities 提交
{
  const n = D.querySelector('[data-mod="audio"]');
  if (!n) failures.push('audio 开关没有渲染出来');
  else if (!n.onclick) failures.push('audio 开关没有 onclick(会拖垮后面的绑定)');
}

// 3) 设置页:应急强制更新
await go('设置', 500);
{
  const n = D.querySelector('[data-t="forceUpdate"]');
  if (!n) failures.push('forceUpdate 开关没有渲染出来(整页可能崩了)');
  else if (!n.onclick) failures.push('forceUpdate 开关没有 onclick');
  else {
    const before = POSTS.length;
    const r = fire('[data-t="forceUpdate"]');
    await wait(60);
    const sent = POSTS.slice(before);
    if (r.before === r.after) failures.push('forceUpdate 点击后 class 没有翻转');
    if (!sent.some((b) => b.includes('"force"'))) {
      failures.push('forceUpdate 点击后没有保存(实际:' + (sent.join('|') || '无') + ')');
    }
  }
}

// 4) 模型页:站内下拉 + 内置示例一键测试(不要求手填 URL)
await go('模型', 500);
{
  const choices = D.querySelectorAll('[data-choice]');
  if (choices.length !== 6) failures.push(`模型页应有 5 个协议下拉 + 1 个 TTS 模式下拉,实际 ${choices.length}`);
  if (!D.querySelector('#md-tts-mode')) failures.push('TTS 三模式选择器不存在');
  const pick = D.querySelector('[data-pick="tts"]');
  if (!pick) failures.push('TTS 模型选择弹窗按钮不存在');
  else {
    pick.dispatchEvent(new W.MouseEvent('click', { bubbles: true }));
    await wait(120);
    const cards = D.querySelectorAll('.model-item');
    if (cards.length < 2) failures.push(`模型选择弹窗没有展示模型卡片(实际 ${cards.length})`);
    const cloneCard = [...cards].find((c) => c.getAttribute('data-id') === 'mimo-v2.5-tts-voiceclone');
    if (!cloneCard) failures.push('模型弹窗缺少 VoiceClone 模型');
    else {
      cloneCard.dispatchEvent(new W.MouseEvent('click', { bubbles: true }));
      await wait(60);
      if (D.querySelector('#md-tts-model').value !== 'mimo-v2.5-tts-voiceclone') failures.push('选中 VoiceClone 后模型名没有回填');
      if (D.querySelector('#md-tts-mode').value !== 'clone') failures.push('选中 VoiceClone 后没有自动切到音色复刻模式');
      const ref = D.querySelector('[data-mode-field="clone"]');
      if (ref && W.getComputedStyle(ref).display === 'none') failures.push('音色复刻参考音频区域没有显示');
    }
  }
  const nativeProto = D.querySelector('select[id$="-proto"]');
  if (nativeProto) failures.push('模型协议仍在使用浏览器原生 select');
  const first = choices[0];
  first.querySelector('[data-choice-open]').dispatchEvent(new W.MouseEvent('click', { bubbles: true }));
  if (!first.querySelector('.choice-menu').classList.contains('show')) failures.push('协议下拉点击后没有展开');
  const testBtn = D.querySelector('[data-mtest="ocr"]');
  if (!testBtn) failures.push('OCR 测试按钮不存在');
  else {
    testBtn.dispatchEvent(new W.MouseEvent('click', { bubbles: true }));
    await wait(60);
    const sample = D.querySelector('[data-sample="ocr-zh"]');
    if (!sample) failures.push('OCR 内置中文样例按钮没有渲染');
    else {
      const before = POSTS.length;
      sample.dispatchEvent(new W.MouseEvent('click', { bubbles: true }));
      await wait(120);
      const sent = POSTS.slice(before);
      if (!sent.some((b) => b.includes('"sample":"ocr-zh"'))) {
        failures.push('点击内置样例没有直接发起 OCR 测试(实际:' + (sent.join('|') || '无') + ')');
      }
    }
    D.querySelector('.modal [data-x]')?.dispatchEvent(new W.MouseEvent('click', { bubbles: true }));
  }
}

// 4) 扩展工具开关(异步填充,在 Agent 页)
await go('Agent 配置', 600);
{
  const t = D.querySelector('[data-agtool]');
  if (!t) failures.push('data-agtool 开关没有渲染出来(扩展列表加载失败?)');
  else if (!t.onclick) failures.push('data-agtool 开关没有 onclick');
}

const realErrors = warn.filter((w) => !w.startsWith('WARN'));
console.log(`DOM 自检:共点击开关并断言 ${POSTS.length} 次保存,jsdom 报错 ${realErrors.length} 条`);
realErrors.slice(0, 5).forEach((e) => console.log('   ', e));

if (realErrors.length) {
  console.log('\n❌ 面板 script 运行期出错:');
  realErrors.slice(0, 10).forEach((e) => console.log('   ' + String(e).split('\n')[0]));
  process.exit(1);
}
if (failures.length) {
  console.log(`\n❌ 开关行为不符合预期 ${failures.length} 项:`);
  failures.forEach((f) => console.log('   ' + f));
  process.exit(1);
}
console.log('✅ 所有开关点得动、翻得了、存得住');
