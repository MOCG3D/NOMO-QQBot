import { isBackendPath } from './site-files.js';

const GLOBAL_PREFIXES = ['api/', '__data/', 'media/', 'administrator/', 'confirm/', 'home-api/', 'qq/'];

function rootAsset(url, siteId) {
  const u = String(url || '');
  if (!u.startsWith('/') || u.startsWith('//')) return u;
  if (u.startsWith(`/${siteId}/`)) return u;
  if (GLOBAL_PREFIXES.some((p) => u.startsWith(`/${p}`))) return u;
  return `/${siteId}${u}`;
}

/** 把 AI 常写的根绝对资源路径改成项目内路径;API 与平台路径保持原样。 */
export function rewriteAbsoluteAssets(text, siteId) {
  let s = String(text || '');
  const attr = (quote, url) => `${quote}${rootAsset(url, siteId)}${quote}`;
  s = s.replace(/(\b(?:src|href)\s*=\s*)(["'])\/([^"']*)\2/gi, (_, pre, q, rest) => `${pre}${attr(q, '/' + rest)}`);
  s = s.replace(/(url\(\s*)(["']?)\/([^)'"\s]+)\2(\s*\))/gi, (_, pre, q, rest, tail) => `${pre}${q}${rootAsset('/' + rest, siteId)}${q}${tail}`);
  s = s.replace(/(\bfetch\s*\(\s*)(["'])\/([^"']*)\2/g, (_, pre, q, rest) => `${pre}${attr(q, '/' + rest)}`);
  s = s.replace(/(\bfrom\s*)(["'])\/([^"']*)\2/g, (_, pre, q, rest) => `${pre}${attr(q, '/' + rest)}`);
  s = s.replace(/(\bimport\s*\(\s*)(["'])\/([^"']*)\2/g, (_, pre, q, rest) => `${pre}${attr(q, '/' + rest)}`);
  return s;
}

/**
 * 部署时重写前端引用。后端源码不碰。
 * 仅给根目录 HTML 加 base,避免破坏子目录页面自己的相对路径语义。
 */
export function rewriteProjectReferences(files, siteId) {
  return (Array.isArray(files) ? files : []).map((f) => {
    if (!f || isBackendPath(f.path)) return f;
    const ext = String(f.path || '').split('.').pop().toLowerCase();
    if (!['html', 'htm', 'css', 'js', 'mjs'].includes(ext)) return f;
    let content = rewriteAbsoluteAssets(f.content, siteId);
    const depth = String(f.path || '').split('/').length - 1;
    if ((ext === 'html' || ext === 'htm') && depth === 0 && !/<base\s/i.test(content)) {
      const base = `<base href="/${siteId}/">`;
      if (/<head(?:\s[^>]*)?>/i.test(content)) content = content.replace(/<head(?:\s[^>]*)?>/i, (m) => `${m}${base}`);
      else content = base + content;
    }
    return { ...f, content };
  });
}
