import { chatWithFallback } from './llm.js';
import { buildTools } from './tools.js';
import { executeTool } from './exec.js';
import { buildSystemPrompt } from './prompt.js';
import { truncate, clipMiddle } from '../util/text.js';
import { mcpToolDefs, callMcp } from './mcp.js';
import { listSkills, pickSkills } from './skills.js';
import { loadExts, enabledToolSet, externalToolDefs, runExternalTool, scriptDefs } from './exts.js';
import { buildRegistry, runScriptTool } from './registry.js';
import { execBackend, sandboxFetch } from '../core/backend.js';
import { listModules, agentModules, siteModules } from '../store/modules.js';
import { withRetry } from './models.js';

export async function runAgent({ cfg, core, convId, userText, images = [], meta = {}, log = console.log }) {
  const started = Date.now();
  // 总预算:0 表示不限制(大工程多轮工具调用需要多久就多久,只受轮次上限约束)
  const totalBudgetMs = Math.max(0, Number(cfg.agentBudgetMs) || 0);
  // 单次非流式请求的超时。
  // 默认走 cfg.llmTimeoutMs(120 秒):没有上限的话,上游挂住就会把任务永久卡在
  // running,用户只收到「🤖 Agent 正在运行」而永远等不到正文。
  // 「单次请求限时」开关打开时,用管理员设的值覆盖(llmMaxSeconds 单位是秒)。
  const perCallTimeoutMs = cfg.llmTimeLimitEnabled
    ? Math.max(5, Number(cfg.llmMaxSeconds) || 600) * 1000
    : Math.max(5000, Number(cfg.llmTimeoutMs) || 120000);

  let mcp = { defs: [], map: new Map() };
  try {
    mcp = await mcpToolDefs(core.env);
  } catch {
    mcp = { defs: [], map: new Map() };
  }

  // 扩展(内置开关/外部扩展)、技能、预制后端模块:任何一步失败都不挡主流程,
  // 退化成「内置工具全开、无技能、无模块」。
  let skills = [];
  let toolSet = null;
  let extTools = { defs: [], map: new Map() };
  let modules = [];
  let prefabList = [];
  let extState = { builtin: [], external: [] };
  try {
    const [skillRows, exts, moduleRows] = await Promise.all([
      listSkills(core.env, { enabledOnly: true }),
      loadExts(core.env),
      listModules(core.env, { enabledOnly: true }),
    ]);
    extState = exts;
    skills = pickSkills(skillRows, userText, cfg.skillMaxInject || 6000);
    toolSet = enabledToolSet(extState);
    extTools = externalToolDefs(extState);
    modules = agentModules(moduleRows);
    prefabList = siteModules(moduleRows).map((m) => ({ id: m.id, name: m.name, description: m.description }));
  } catch {
    /* 加载失败:用默认值 */
  }

  // 创造模式(仅管理员的单轮上帝权限):架构限制、扩展开关、审批全部放开。
  // 只在本次 runAgent 内生效,不改写数据库里的设置,下一轮自动恢复正常。
  const creative = meta?.creative === true;
  const creativeCfg = creative
    ? { ...cfg, architectures: ['html', 'prefab', 'custom'], canDeploy: true, canPrefab: true, canCustomBackend: true, deployConfirm: false }
    : cfg;

  const scriptTools = scriptDefs(extState);
  const tools = [
    ...buildTools(creativeCfg, {
      toolSet: creative ? null : toolSet,
      modules, prefabList, externalDefs: [...extTools.defs, ...scriptTools.defs],
      creative,
    }),
    ...mcp.defs,
  ];
  // 统一工具注册表:面板「工具总览」与调试日志都用这一份
  const registry = buildRegistry({
    execDefs: tools,
    toolSet,
    exts: extState,
    mcp,
  });
  const ctx = {
    cfg: creativeCfg, core, convId, meta, modules: new Map(modules.map((m) => [m.id, m])), log, creative,
    registry,
    scriptTools,
    runSandbox: execBackend,
    sandboxFetch,
    // 本轮产生的富媒体产物(图片/语音)。工具往里 push,由 BotCore 负责投递。
    // 这样 loop 本身不碰 QQ 发送逻辑,换成别的客户端也能复用。
    media: [],
  };

  const conv = await core.getContext(convId);
  const messages = [{ role: 'system', content: buildSystemPrompt(cfg, { ...meta, skills, prefabList }) }];

  if (conv.summary) {
    messages.push({ role: 'system', content: `以下是这个群之前聊天的摘要,作为背景参考:\n${conv.summary}` });
  }
  const memories = core.memList ? core.memList(convId) : [];
  if (memories.length) {
    messages.push({
      role: 'system',
      content: '这个会话长期记住的信息(用户让你记的,直接当事实用):\n'
        + memories.map((m) => `· ${m.key}: ${m.value}`).join('\n'),
    });
  }

  for (const m of conv.messages) {
    messages.push({ role: m.role, content: m.content });
  }

  let speaker = userText;
  if (meta.nickname) speaker = `[${meta.nickname}] ${userText}`;
  if (Array.isArray(images) && images.length) {
    messages.push({
      role: 'user',
      content: [
        { type: 'text', text: speaker },
        ...images.map((url) => ({ type: 'image_url', image_url: { url } })),
      ],
    });
  } else {
    messages.push({ role: 'user', content: speaker });
  }

  const toolTrace = [];
  let final = '';
  let rounds = 0;
  let usageTotal = 0;
  let downgraded = false;
  let lastError = '';
  let consecutiveFailures = 0;

  // 模型与只读工具的瞬时错误都在后台重试,不把一次 502/超时直接抛给用户。
  // 有副作用的工具(部署/写文件/删除)绝不自动重放,避免重复建项目。
  const callModel = async (msgs, defs) => withRetry(async () => {
    const r = await chatWithFallback(creativeCfg, msgs, defs, { timeoutMs: perCallTimeoutMs });
    if (r.aborted && r.error) throw new Error(r.error);
    return r;
  }, {
    attempts: 2,
    onRetry: (_n, e) => log(`[agent] 上游瞬时失败,后台重试:${String(e?.message || e).slice(0, 120)}`, 'info'),
  });
  const readOnlyTools = new Set(['web_search', 'fetch_url', 'query_dashboard', 'motd', 'group_recent', 'group_find', 'list_sites', 'read_site', 'now', 'calc', 'encode', 'random', 'recall']);

  for (let round = 0; round < creativeCfg.agentMaxRounds; round++) {
    if (totalBudgetMs > 0 && Date.now() - started > totalBudgetMs) {
      log('[agent] 超出总时间预算,提前收尾');
      break;
    }
    rounds++;

    let resp;
    try {
      resp = await callModel(messages, tools);
    } catch (e) {
      resp = { content: '', reasoningHead: '', reasoningLen: 0, toolCalls: [], finishReason: null,
        usage: null, elapsedMs: 0, aborted: false, error: String(e?.message || e) };
    }

    if (resp.downgradedFrom) downgraded = true;
    if (resp.error) lastError = resp.error;
    if (resp.usage?.total_tokens) usageTotal += resp.usage.total_tokens;

    log(`[思考] round=${round + 1} effort=${resp.downgradedFrom ? cfg.fallbackEffort : cfg.reasoningEffort} `
      + `finish=${resp.finishReason} 思考片数=${resp.reasoningLen} 正文=${resp.content.length}字 `
      + `耗时=${resp.elapsedMs}ms${resp.aborted ? ' [被超时中断]' : ''}`);
    if (resp.reasoningHead) {
      log(`[思考·摘录] ${resp.reasoningHead.replace(/\s+/g, ' ').slice(0, 800)}`);
    }

    const calls = resp.toolCalls.slice(0, creativeCfg.agentMaxToolsPerRound);
    if (calls.length === 0) {
      if (String(resp.content || '').trim()) {
        final = resp.content;
        break;
      }
      // 工具已经做过事但模型只吐了空白:不能就此中断项目,补一句继续指令再跑。
      consecutiveFailures++;
      lastError = resp.error || lastError;
      if (consecutiveFailures <= 2 && round + 1 < creativeCfg.agentMaxRounds) {
        messages.push({ role: 'user', content: '刚才没有收到正文。请根据已完成的工具结果继续,必须给出简体中文正文;项目未完成的继续调用工具。' });
        continue;
      }
      final = resp.content;
      break;
    }
    consecutiveFailures = 0;

    messages.push({
      role: 'assistant',
      content: resp.content || '',
      tool_calls: calls,
    });

    // 同一轮的多个工具调用并行执行(彼此独立,串行会白白浪费时间)。
    // 结果按原顺序回填,保证 tool_call_id 一一对应。
    const t0 = Date.now();
    const settled = await Promise.allSettled(calls.map(async (call) => {
      const name = call.function?.name || '';
      let args = {};
      try {
        args = JSON.parse(call.function?.arguments || '{}');
      } catch {
        args = {};
      }
      const m = mcp.map.get(name);
      const em = extTools.map.get(name);
      const sm = ctx.scriptTools?.map?.get(name);
      let result;
      if (m) result = await callMcp(core.env, m.serverId, m.tool, args);
      else if (em) result = await runExternalTool(em, args, (msg) => log(`[扩展] ${msg}`));
      else if (sm) result = await runScriptTool(sm, args, ctx);
      else if (readOnlyTools.has(name)) {
        result = await withRetry(() => executeTool(name, args, ctx), { attempts: 2 });
      } else result = await executeTool(name, args, ctx);
      return { name, args, result: String(result) };
    }));

    for (let i = 0; i < calls.length; i++) {
      const call = calls[i];
      const name = call.function?.name || '';
      const s = settled[i];
      const item = s.status === 'fulfilled'
        ? s.value
        : { name, args: {}, result: `工具执行出错:${s.reason?.message || s.reason}` };
      const ms = Date.now() - t0;
      toolTrace.push({ name: item.name, args: item.args, result: truncate(item.result, 500), ms });
      log(`[工具] ${item.name} ${JSON.stringify(item.args).slice(0, 200)} -> ${ms}ms :: ${item.result.replace(/\s+/g, ' ').slice(0, 300)}`);
      messages.push({
        role: 'tool',
        tool_call_id: call.id,
        // 超长工具结果掐头去尾,上下文更紧凑,模型仍能看到关键部分
        content: clipMiddle(item.result, 2600, 1400),
      });
    }

    if (round === creativeCfg.agentMaxRounds - 1) {
      messages.push({
        role: 'user',
        content: '现在请直接用简体中文给出最终回复,不要再调用任何工具。',
      });
      const last = await callModel(messages, null);
      if (last.content.trim()) final = last.content;
    }
  }

  // 达到轮次上限后仍必须有一次明确收尾;优先让模型基于工具结果总结,
  // 模型仍空白则用确定性正文兜底,绝不只留一张「正在运行」回执。
  if (!final.trim() && toolTrace.length) {
    const digest = toolTrace.slice(-8).map((t) => `· ${t.name}: ${String(t.result).slice(0, 500)}`).join('\n');
    for (let i = 0; i < 2 && !final.trim(); i++) {
      try {
        const last = await callModel([
          { role: 'system', content: '你是项目收尾助手。只能依据工具结果回答,不要调用工具,不要声称未做的事已完成。' },
          { role: 'user', content: `用户原始需求:${userText}\n已执行工具:${digest}\n请用简体中文给出最终正文,说明完成了什么、链接或错误是什么、下一步是什么。` },
        ], null);
        final = last.content || '';
      } catch (e) {
        lastError = String(e?.message || e);
      }
    }
  }

  if (!final.trim()) {
    if (toolTrace.length) {
      final = '事情办完了,但模型没给出说明。工具执行结果:\n'
        + toolTrace.map((t) => `· ${t.name} → ${t.result.slice(0, 120)}`).join('\n');
    } else if (lastError) {
      final = `😵 这次没能拿到模型的回复,上游接口报错了(${truncate(lastError, 120)})。稍后再试一次吧。`;
    } else {
      final = '抱歉,这次没生成出内容,换个说法再问我一次?';
    }
  }

  const generatedImages = ctx.media.filter((m) => m.kind === 'image');
  const generatedVoices = ctx.media.filter((m) => m.kind === 'voice');

  return {
    reply: final,
    toolTrace,
    rounds,
    usageTotal,
    downgraded,
    elapsedMs: Date.now() - started,
    historyUser: userText,
    historyAssistant: final,
    generatedImages,
    generatedVoices,
  };
}
