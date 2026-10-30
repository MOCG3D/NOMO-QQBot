/** 站点逻辑文件名、后端路由与存储物理文件名。 */

export function cleanProjectPath(path) {
  const p = String(path || '').replace(/\\/g, '/').replace(/^\/+/, '');
  if (!p || p.length > 240 || p.includes('\0')) return '';
  const parts = p.split('/');
  if (parts.some((x) => !x || x === '.' || x === '..')) return '';
  return parts.join('/');
}

const BACKEND_EXT = '(?:js|mjs|cjs|ts|py|lua|rb)';

/** 后端源码绝不能作为静态文件公开。 */
export function isBackendPath(path) {
  const p = cleanProjectPath(path).toLowerCase();
  if (!p) return false;
  return p === '_backend.js'
    || p.startsWith('_backend/')
    || p.startsWith('backend/')
    || p.endsWith('.backend.js')
    || p === 'backend.json'
    || p === 'project.json'
    || p === 'runtime.json';
}

/**
 * /api/a/b 的后端候选文件,按精确到兜底排列。
 * 支持多个文件、子目录、旧版单文件,不再限定 _backend.js。
 */
export function backendCandidates(rest) {
  const p = cleanProjectPath(rest) || 'index';
  const out = [];
  const add = (x) => { if (x && !out.includes(x)) out.push(x); };
  for (const ext of ['js', 'mjs', 'cjs', 'ts', 'py', 'lua', 'rb']) {
    add(`backend/${p}.${ext}`);
    add(`_backend/${p}.${ext}`);
    add(`${p}.backend.${ext}`);
  }
  const first = p.split('/')[0];
  if (first !== p) {
    for (const ext of ['js', 'mjs', 'cjs', 'ts', 'py', 'lua', 'rb']) {
      add(`backend/${first}.backend.${ext}`);
      add(`backend/${first}.${ext}`);
      add(`_backend/${first}.${ext}`);
    }
  }
  for (const ext of ['js', 'mjs', 'cjs', 'ts', 'py', 'lua', 'rb']) {
    add(`backend/index.${ext}`);
    add(`_backend/index.${ext}`);
  }
  add('_backend.js');
  return out;
}

export function runtimeOf(path) {
  const ext = String(path).split('.').pop().toLowerCase();
  if (ext === 'py') return 'python';
  if (ext === 'lua') return 'lua';
  if (ext === 'rb') return 'ruby';
  return 'javascript';
}

function base64UrlText(text) {
  const bytes = new TextEncoder().encode(String(text));
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

/**
 * 每个项目独立目录;兼容模式把逻辑文件名编码后统一存成 .txt。
 * 非兼容模式维持旧 key,老项目无需迁移。
 */
export function projectObjectKey(siteId, store, path) {
  const sid = String(siteId);
  const logical = cleanProjectPath(path);
  if (store?.compatTxt === true || store?.compatMode === 'txt') {
    const safeSid = sid.replace(/[^a-zA-Z0-9_-]/g, '_');
  return `projects/${safeSid}/${base64UrlText(logical)}.txt`;
  }
  return `f/${sid}/${logical}`;
}

export function projectPrefix(siteId, store) {
  const sid = String(siteId);
  return (store?.compatTxt === true || store?.compatMode === 'txt') ? `projects/${sid.replace(/[^a-zA-Z0-9_-]/g, '_')}/` : `f/${sid}/`;
}
