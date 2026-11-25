// 抓取各來源最新文章與全文，輸出 data/feed.json
// 需求：Node 18+。第一次先執行 npm install（全文抽取用 Readability、jsdom、DOMPurify）。
// 用法：npm run build（或 node scripts/build-feed.mjs）
//
// 設定都在 config/：
//   modes.json    五個閱讀模式（頂部泡泡）
//   topics.json   主題 chips 與比對規則
//   sources.json  來源、各 feed 對應的模式、閱讀頁 skin
//   discovered.json  程式自動找到並驗證過的 feed 網址（自動產生，可刪掉讓它重找）
//
// 有設定 ANTHROPIC_API_KEY 時，還會用 Claude 產生摘要、重點、重點句與繁體中文翻譯（見 scripts/ai.mjs）。
//
// 某個 feed 失敗時，保留上一次 feed.json 裡該 feed 的文章，不會整個清空。
// 已經抽過全文的文章不會重抓（feed.json 本身就是快取）。

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { aiEnabled, runAi, needsAi, AI_MAX } from './ai.mjs';
import { makeDigest, makeDf } from './digest.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = resolve(ROOT, 'data/feed.json');
const CONFIG = (f) => resolve(ROOT, 'config', f);
const PER_FEED = 12;
const UA = 'DesignFeedReader/2.0 (personal RSS reader; one request per second per site)';
const MIN_GAP_MS = 1000;           // 同一網站兩次請求至少間隔 1 秒
// PUBLIC_SITE=1（GitHub 自動更新用）：公開網站放標題、圖片、卡片摘要與關鍵詞、原文連結；不存全文、不翻譯。
// 卡片摘要免費：從原文挑 2～3 句代表句並標出關鍵詞（scripts/digest.mjs）。有設 ANTHROPIC_API_KEY 時改用 Claude 寫的摘要。
// 全文只在做摘要時暫時抓來用，不寫進 feed.json。
const PUBLIC = !!process.env.PUBLIC_SITE;
const FULL_MIN_CHARS = 900;        // 抽出的純文字少於這個長度，視為只有摘要
const PAYWALL = /subscribe to (continue|read)|subscribers only|become a (member|subscriber)|already a subscriber|sign in to continue reading|this (article|content) is (for|available to) (members|subscribers)|premium content/i;

const readJSON = async (f, fallback) => { try { return JSON.parse(await readFile(f, 'utf8')); } catch { return fallback; } };

// ---------- 網路：每個網站排隊，間隔 MIN_GAP_MS ----------
const hostQueue = new Map();
function get(url) {
  const host = new URL(url).host;
  const prev = hostQueue.get(host) || Promise.resolve();
  const run = prev.then(async () => {
    try {
      const r = await fetch(url, { headers: { 'user-agent': UA, accept: '*/*' }, redirect: 'follow', signal: AbortSignal.timeout(25000) });
      if (!r.ok) throw new Error(`${r.status} ${url}`);
      return await r.text();
    } finally { await new Promise((ok) => setTimeout(ok, MIN_GAP_MS)); }
  });
  hostQueue.set(host, run.catch(() => {}));
  return run;
}
async function pool(items, n, fn) {
  const out = new Array(items.length); let i = 0;
  await Promise.all(Array.from({ length: n }, async () => { while (i < items.length) { const k = i++; out[k] = await fn(items[k]).catch((e) => { console.warn(`  · ${e.message || e}`); return null; }); } }));
  return out;
}

// ---------- 文字工具 ----------
const decode = (s = '') => s
  .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&#x27;|&apos;/g, "'")
  .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n)).replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
  .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').trim();
const tag = (xml, name) => { const m = xml.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, 'i')); return m ? decode(m[1]) : null; };
const meta = (html, prop) => {
  const m = html.match(new RegExp(`<meta[^>]+(?:property|name)=["']${prop}["'][^>]*>`, 'i'));
  if (!m) return null; const c = m[0].match(/content=["']([^"']*)["']/i); return c ? decode(c[1]) : null;
};
const attr = (el, name) => { const m = el.match(new RegExp(`\\s${name}=["']([^"']*)["']`, 'i')); return m ? decode(m[1]) : null; };
const toISO = (d) => { if (!d) return null; const t = Date.parse(d); return isNaN(t) ? null : new Date(t).toISOString(); };
const stripHtml = (s = '') => decode(s).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
const idFor = (url) => createHash('sha1').update(url).digest('hex').slice(0, 12);
const cleanTitle = (t, name) => t && t.replace(new RegExp(`\\s*[|\\-–—]\\s*(${name.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}|Google Design|Figma Blog)\\s*$`, 'i'), '').trim();

// 摘要：網站提供的說明 + 文章開頭幾句，湊到約 2–3 行（130–230 字元），只在句子結尾切
const finish = (t) => (/[.!?…”"’]$/.test(t) ? t : t + '.');
function summarize(lead, html = '') {
  const body = (html.match(/<article[\s\S]*?<\/article>/i) || html.match(/<main[\s\S]*?<\/main>/i) || [html])[0];
  const paras = [...body.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/gi)].map((m) => stripHtml(m[1]))
    .filter((t) => t.length > 70 && !/cookie|subscribe|newsletter|©|privacy/i.test(t));
  lead = stripHtml(lead || '');
  let s = lead ? finish(lead) : '';
  for (const p of paras) {
    if (s.length >= 230) break;
    if (lead && (p.startsWith(lead.slice(0, 30)) || lead.startsWith(p.slice(0, 30)))) continue;
    s = (s ? s + ' ' : '') + finish(p);
  }
  let out = '';
  for (const x of s.match(/[^.!?]+[.!?]+["”’)]*\s*/g) || [s]) {
    if (out.length >= 130 && (out + x).trim().length > 230) break;
    if (x.trim().length < 15 && out) break;
    out += x; if (out.length >= 230) break;
  }
  return out.trim() || null;
}

async function articleMeta(url) {
  const html = await get(url);
  let date = meta(html, 'article:published_time');
  if (!date) { const m = html.match(/"datePublished"\s*:\s*"([^"]+)"/); if (m) date = m[1]; }
  if (!date) { const m = html.match(/<time[^>]+datetime=["']([^"']+)["']/i); if (m) date = m[1]; }
  return { title: meta(html, 'og:title') || tag(html, 'title'), image: meta(html, 'og:image'), date: toISO(date), desc: meta(html, 'og:description'), html };
}

// ---------- 全文：Readability 抽取 + DOMPurify 消毒 ----------
let LIB = null;
async function libs() {
  if (LIB !== null) return LIB;
  try {
    const [{ JSDOM, VirtualConsole }, { Readability }, purify] = await Promise.all([import('jsdom'), import('@mozilla/readability'), import('dompurify')]);
    const win = new JSDOM('').window;
    // 原網頁的 CSS 解析錯誤很多，靜音
    const quiet = new VirtualConsole();
    LIB = { JSDOM, Readability, purify: purify.default(win), quiet };
  } catch {
    console.warn('! 找不到 jsdom / @mozilla/readability / dompurify，請先執行 npm install。這次只會保留摘要。');
    LIB = false;
  }
  return LIB;
}
const ALLOWED = {
  ALLOWED_TAGS: ['p', 'h2', 'h3', 'h4', 'h5', 'ul', 'ol', 'li', 'blockquote', 'figure', 'figcaption', 'img', 'a', 'em', 'strong', 'b', 'i', 'code', 'pre', 'hr', 'br', 'sup', 'sub', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'picture', 'source'],
  ALLOWED_ATTR: ['href', 'src', 'srcset', 'alt', 'title', 'width', 'height', 'colspan', 'rowspan'],
  ALLOW_DATA_ATTR: false,
};
// 消毒，並把圖片和連結的相對路徑轉成絕對路徑；h1 降成 h2，空段落拿掉
function sanitize(html, base, lib) {
  const dom = new lib.JSDOM(`<body>${lib.purify.sanitize(html, ALLOWED)}</body>`, { url: base });
  const d = dom.window.document;
  d.querySelectorAll('img').forEach((img) => {
    const src = img.getAttribute('src') || (img.getAttribute('srcset') || '').split(/\s+/)[0];
    if (!src || /^data:/.test(src)) return img.remove();
    try { img.setAttribute('src', new URL(src, base).href); } catch { return img.remove(); }
    img.removeAttribute('srcset'); img.setAttribute('loading', 'lazy');
  });
  d.querySelectorAll('source').forEach((s) => s.remove());
  d.querySelectorAll('a').forEach((a) => {
    try { a.setAttribute('href', new URL(a.getAttribute('href') || '', base).href); } catch { a.removeAttribute('href'); }
    a.setAttribute('target', '_blank'); a.setAttribute('rel', 'noopener noreferrer');
  });
  d.querySelectorAll('p,li,h2,h3,h4').forEach((el) => { if (!el.textContent.trim() && !el.querySelector('img')) el.remove(); });
  // 再消毒一次，確保加上的屬性也在白名單內
  return lib.purify.sanitize(d.body.innerHTML, { ...ALLOWED, ALLOWED_ATTR: [...ALLOWED.ALLOWED_ATTR, 'loading', 'target', 'rel'] });
}
const textLen = (html) => stripHtml(html).length;

async function extract(item) {
  const lib = await libs();
  if (!lib) return { status: 'excerpt-only' };
  // 1. feed 自己帶全文（content:encoded / Atom content）就直接用
  if (item.feedContent && textLen(item.feedContent) >= FULL_MIN_CHARS) {
    return { status: 'full', html: sanitize(item.feedContent, item.url, lib) };
  }
  // 2. 抓原網頁，用 Readability 抽出內文
  const page = await get(item.url);
  const dom = new lib.JSDOM(page, { url: item.url, virtualConsole: lib.quiet });
  const art = new lib.Readability(dom.window.document, { charThreshold: 400 }).parse();
  if (!art || !art.content) return { status: 'failed' };
  const html = sanitize(art.content, item.url, lib);
  const len = textLen(html);
  if (len < FULL_MIN_CHARS || (PAYWALL.test(stripHtml(page).slice(0, 20000)) && len < 3000)) return { status: 'excerpt-only', html: len > 200 ? html : null };
  return { status: 'full', html };
}

// ---------- 主題標籤 ----------
function makeTagger(cfg) {
  const rules = cfg.topics.map((t) => ({
    id: t.id,
    cats: new Set((t.categories || []).map((c) => c.toLowerCase())),
    re: new RegExp(`\\b(${t.keywords.join('|')})\\b`, 'i'),
  }));
  return (item, defaults = []) => {
    const out = [];
    const add = (id) => { if (!out.includes(id)) out.push(id); };
    for (const c of item.categories || []) for (const r of rules) if (r.cats.has(c.toLowerCase()) || r.id.toLowerCase() === c.toLowerCase()) add(r.id);
    const text = `${item.title} ${item.excerpt || ''}`;
    for (const r of rules) if (r.re.test(text)) add(r.id);
    for (const d of defaults) add(d);
    return out.slice(0, cfg.maxTags || 3);
  };
}

// ---------- 找 feed 網址：先讀頁面的 <link rel="alternate">；沒有的話，改找頁面上自己標出的 RSS/Feed 超連結。
//            每個候選都實際讀一次，確認內容真的是 RSS/Atom 才採用（不自己拼網址） ----------
const isFeed = (x) => /<(rss|feed|rdf:RDF)\b/i.test(x.slice(0, 2000));
async function discover(feed, src, cache, key) {
  if (cache[key]) return cache[key];
  const page = feed.discoverFrom || src.homepage;
  const tried = [];
  const accept = async (href) => {
    try { const x = await get(href); if (isFeed(x)) { cache[key] = href; return href; } tried.push(`${href}（不是 RSS）`); }
    catch (e) { tried.push(`${href}（${String(e.message || e).split(' ')[0]}）`); }
    return null;
  };
  let links = [];
  try {
    const html = await get(page);
    const abs = (h) => { try { return new URL(h, page).href; } catch { return null; } };
    const head = [...html.matchAll(/<link\b[^>]*>/gi)].map((m) => m[0])
      .filter((l) => /rel=["'][^"']*alternate/i.test(l) && /type=["']application\/(rss|atom)(\+xml)?["']/i.test(l))
      .map((l) => ({ href: abs(attr(l, 'href')), title: attr(l, 'title') || '' }));
    const base = new URL(page).hostname.replace(/^www\./, '');
    const anchors = [...html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)]
      .map((m) => ({ href: abs(attr(m[1], 'href') || ''), title: m[2].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() }))
      .filter((l) => l.href && /^https?:/.test(l.href) && (/\b(rss|atom)\b|\/feeds?\b|\.xml\b/i.test(l.href) || /^(rss|rss feed|subscribe via rss)$/i.test(l.title)))
      .filter((l) => { const h = new URL(l.href).hostname; return h.replace(/^www\./, '').endsWith(base) || /feedburner|feeds\./.test(h); });
    const seen = new Set();
    links = [...head, ...anchors].filter((l) => l.href && l.href !== page && !/comments/i.test(l.href + l.title) && !seen.has(l.href) && seen.add(l.href));
  } catch (e) { tried.push(`${page}（${String(e.message || e).split(' ')[0]}）`); }
  const pick = feed.pick ? new RegExp(feed.pick, 'i') : null;
  const ordered = pick ? [...links.filter((l) => pick.test(l.title + ' ' + l.href)), ...links.filter((l) => !pick.test(l.title + ' ' + l.href))] : links;
  for (const l of ordered.slice(0, 8)) { const ok = await accept(l.href); if (ok) return ok; }
  // 網站頁面上沒列出 feed 時，才試 sources.json 裡寫的 feedHints（網站自己公布的 feed 位址），一樣要讀到真的 RSS 才採用
  for (const h of feed.feedHints || []) { const ok = await accept(h); if (ok) return ok; }
  throw new Error(`在 ${page} 找不到可用的 feed${tried.length ? `（試過：${tried.join('、')}）` : '（頁面上沒有 feed 連結）'}`);
}

// ---------- 抓取方式 ----------
async function fromFeed(url) {
  const xml = await get(url);
  const blocks = xml.match(/<(item|entry)[\s>][\s\S]*?<\/\1>/g) || [];
  const items = blocks.slice(0, PER_FEED).map((b) => {
    const content = tag(b, 'content:encoded') || tag(b, 'content') || '';
    const description = tag(b, 'description') || tag(b, 'summary') || '';
    const link = (tag(b, 'link') || (b.match(/<link[^>]+href=["']([^"']+)/) || [])[1] || '').replace(/[?&](source|utm_[a-z]+)=[^&]*/g, '');
    const media = (b.match(/<(?:media:content|media:thumbnail|enclosure)[^>]+url=["']([^"']+)/) || [])[1];
    const categories = [...b.matchAll(/<category(?:\s[^>]*)?(?:term=["']([^"']+)["'][^>]*\/>|>([\s\S]*?)<\/category>)/gi)].map((m) => decode(m[1] || m[2] || '')).filter(Boolean);
    return {
      title: stripHtml(tag(b, 'title') || ''), url: link,
      excerpt: summarize(stripHtml(description || content).slice(0, 600)),
      publishedAt: toISO(tag(b, 'pubDate') || tag(b, 'published') || tag(b, 'updated') || tag(b, 'dc:date')),
      thumbnail: media || ((content || description).match(/<img[^>]+src=["']([^"']+)/) || [])[1] || null,
      categories, feedContent: content || (textLen(description) > FULL_MIN_CHARS ? description : null),
    };
  }).filter((i) => i.url && i.title);
  await pool(items.filter((i) => !i.thumbnail || !i.excerpt || i.excerpt.length < 130), 3, async (i) => {
    const m = await articleMeta(i.url); i.thumbnail ||= m.image; i.excerpt = summarize(i.excerpt && i.excerpt.length < 130 ? i.excerpt : m.desc, m.html) || i.excerpt; });
  return items;
}

async function fromScrape({ url, link, richOnly }) {
  const re = new RegExp(link);
  const html = await get(url);
  const found = [];
  for (const m of html.matchAll(/<a\b[^>]*href=["']([^"'#]+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    let h; try { h = new URL(decode(m[1]), url).href.split('?')[0]; } catch { continue; }
    if (!re.test(h) || found.includes(h)) continue;
    if (richOnly && !/<(img|h2|h3|h4|picture)\b/i.test(m[2])) continue;
    found.push(h);
  }
  const list = found.slice(0, PER_FEED);
  const metas = await pool(list, 3, articleMeta);
  return list.map((h, k) => metas[k] && { url: h, title: metas[k].title, thumbnail: metas[k].image, publishedAt: metas[k].date, excerpt: summarize(metas[k].desc, metas[k].html) })
    .filter((i) => i && i.title && !/^Tag:/i.test(i.title));
}

const CUSTOM = {
  async googleDesign() {
    const j = JSON.parse(await get('https://design.google/api/v1/entity/?type=page&limit=20'));
    const items = j.results.filter((r) => r.secondary_type === 'article' && r.location).slice(0, PER_FEED).map((r) => ({
      title: r.title, url: 'https://design.google' + r.location, publishedAt: toISO(r.publish_at), excerpt: r.description || null,
      categories: [r.primary_tag?.name, ...(r.tags || []).map((t) => t.name || t)].filter(Boolean),
      thumbnail: r.data?.image?.renditions?.portrait || r.data?.image?.renditions?.original || null,
    }));
    await pool(items, 3, async (i) => { const m = await articleMeta(i.url); i.excerpt = summarize(i.excerpt, m.html) || i.excerpt; });
    return items;
  },
};

// 舊版 feed.json 的全文是 [類型, 內容] 陣列，轉成 HTML 沿用
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
function blocksToHtml(body) {
  if (!Array.isArray(body)) return null;
  let html = '', list = false;
  for (const [t, x] of body) {
    if (t === 'li' && !list) { html += '<ul>'; list = true; }
    if (t !== 'li' && list) { html += '</ul>'; list = false; }
    html += t === 'h' ? `<h2>${esc(x)}</h2>` : t === 'li' ? `<li>${esc(x)}</li>` : t === 'q' ? `<blockquote><p>${esc(x)}</p></blockquote>`
      : t === 'cap' ? `<figcaption>${esc(x)}</figcaption>` : t === 'img' ? `<figure><img src="${esc(x)}" alt="" loading="lazy"></figure>` : `<p>${esc(x)}</p>`;
  }
  return html + (list ? '</ul>' : '');
}
function migrate(old) {
  if (!old || old.url) return old;
  return {
    id: idFor(old.link), sourceId: old.source, sourceName: old.sourceName, feedUrl: null, mode: null, tags: old.tags || [],
    title: old.title, excerpt: old.desc, url: old.link, publishedAt: old.date, firstSeen: old.firstSeen, thumbnail: old.thumb || old.image || null,
    contentHtml: blocksToHtml(old.body), extractionStatus: old.body ? 'full' : null,
  };
}

// ---------- main ----------
const sortedNow = (all) => [...all.values()].sort((a, b) => (Date.parse(b.publishedAt || b.firstSeen) || 0) - (Date.parse(a.publishedAt || a.firstSeen) || 0));
const publicAi = (ai) => ai && ai.brief ? { brief: ai.brief, keywords: ai.keywords || [], model: ai.model, at: ai.at } : undefined;
const publicItem = ({ contentHtml, ai, ...i }) => ({ ...i, contentHtml: null, ...(publicAi(ai) ? { ai: publicAi(ai) } : {}) });

async function main() {
  const modesCfg = await readJSON(CONFIG('modes.json'));
  const topicsCfg = await readJSON(CONFIG('topics.json'));
  const srcCfg = await readJSON(CONFIG('sources.json'));
  const cache = await readJSON(CONFIG('discovered.json'), {});
  const tagger = makeTagger(topicsCfg);
  const prev = await readJSON(OUT, { items: [] });
  const prevItems = prev.items.map(migrate);
  const prevByUrl = new Map(prevItems.map((i) => [i.url, i]));
  const all = new Map(); const report = [];

  for (const src of srcCfg.sources) {
    for (const [n, feed] of src.feeds.entries()) {
      const key = `${src.id}#${n}`;
      let feedUrl = feed.url || null;
      try {
        if (feed.discover) feedUrl = await discover(feed, src, cache, key);
        if (feedUrl && src.feeds.slice(0, n).some((_, m) => cache[`${src.id}#${m}`] === feedUrl || src.feeds[m].url === feedUrl)) {
          report.push({ key, name: src.name, mode: feed.mode, ok: true, note: `和前一個 feed 相同，改用 itemModeRules 分模式（${feedUrl}）` }); continue;
        }
        const items = feed.custom ? await CUSTOM[feed.custom]() : feed.scrape ? await fromScrape(feed.scrape) : await fromFeed(feedUrl);
        if (!items.length) throw new Error('0 篇');
        items.forEach((it, k) => {
          if (all.has(it.url)) return;
          const old = prevByUrl.get(it.url);
          const mode = (src.itemModeRules || []).find((r) => it.url.includes(r.match))?.mode || feed.mode;
          const item = {
            id: idFor(it.url), sourceId: src.id, sourceName: src.name, feedUrl: feedUrl || feed.scrape?.url || src.homepage, mode,
            title: cleanTitle(it.title, src.name), excerpt: it.excerpt || old?.excerpt || null, url: it.url,
            publishedAt: it.publishedAt || old?.publishedAt || null,
            firstSeen: old?.firstSeen || new Date(Date.now() - k * 60000).toISOString(),
            thumbnail: it.thumbnail || old?.thumbnail || null,
            contentHtml: old?.contentHtml || null, extractionStatus: old?.extractionStatus || null,
            ...(old?.ai ? { ai: old.ai } : {}), ...(old?.digest && /^[A-Z0-9"“‘'(]/.test(old.digest.brief || '') ? { digest: old.digest } : {}),   // a summary that starts mid-sentence is made again
          };
          item.tags = tagger({ ...item, categories: it.categories }, feed.defaultTags);
          Object.defineProperty(item, 'feedContent', { value: it.feedContent, enumerable: false });
          all.set(it.url, item);
        });
        report.push({ key, name: src.name, mode: feed.mode, ok: true, count: items.length, feed: feedUrl || feed.scrape?.url || feed.custom });
      } catch (e) {
        const kept = prevItems.filter((i) => i.sourceId === src.id && (!i.mode || i.mode === feed.mode) && !all.has(i.url));
        kept.forEach((i) => all.set(i.url, { ...i, sourceName: src.name, mode: i.mode || feed.mode, tags: tagger(i, feed.defaultTags) }));
        report.push({ key, name: src.name, mode: feed.mode, ok: false, error: String(e.message || e), kept: kept.length });
      }
    }
  }

  // 全文：還沒抽過、或上次失敗的才抓（feed.json 就是快取）
  // 公開網站：只為這次要做摘要的文章暫時抓全文（沒有 API key 就不抓）
  const todo = PUBLIC
    ? sortedNow(all).filter((i) => !i.digest && (!aiEnabled() || needsAi(i, true)) && !['excerpt-only', 'failed', 'no-digest'].includes(i.extractionStatus))
    : [...all.values()].filter((i) => !i.contentHtml && !['excerpt-only', 'failed'].includes(i.extractionStatus));
  console.log(`抽取全文：${todo.length} 篇（每個網站每秒最多一次請求）`);
  await pool(todo, 6, async (i) => {
    try { const r = await extract(i); i.extractionStatus = r.status; i.contentHtml = r.html || null; }
    // 連不上網站：狀態留空，下次再試；抽得到網頁但抽不出內文才算 failed
    catch (e) { i.extractionStatus = null; throw e; }
  });

  // 卡片摘要（免費、抽取式）：還沒有的才做
  const lib0 = await libs();
  if (lib0) {
    const corpus = makeDf([...all.values()]); let n = 0;
    for (const i of all.values()) if (!i.digest && i.contentHtml) { try { const g = makeDigest(i, i.contentHtml, lib0.JSDOM, corpus); if (g) { i.digest = g; n++; } else if (PUBLIC) i.extractionStatus = 'no-digest'; } catch {} }
    console.log(`卡片摘要：新做 ${n} 篇`);
  }

  const sources = srcCfg.sources.map(({ id, name, homepage, skin, tint }) => ({ id, name, homepage, ...(tint ? { tint } : {}), skin: { ...srcCfg.defaultSkin, ...skin } }));
  const sorted = () => [...all.values()].sort((a, b) => (Date.parse(b.publishedAt || b.firstSeen) || 0) - (Date.parse(a.publishedAt || a.firstSeen) || 0));
  const writeOut = async () => {
    await mkdir(dirname(OUT), { recursive: true });
    await writeFile(OUT, JSON.stringify({
      updated: new Date().toISOString(), modes: modesCfg.modes, topics: topicsCfg.topics.map((t) => t.id),
      defaultSkin: srcCfg.defaultSkin, sources, report, ...(PUBLIC ? { public: true } : {}), items: PUBLIC ? sorted().map(publicItem) : sorted(),
    }, null, 2));
  };
  await writeOut();
  await writeFile(CONFIG('discovered.json'), JSON.stringify(cache, null, 2));

  // 摘要與翻譯（需要 API key；沒有就跳過）
  if (aiEnabled()) {
    const lib = await libs();
    if (lib) await runAi(sorted(), { JSDOM: lib.JSDOM, save: writeOut, cardOnly: PUBLIC });
    await writeOut();
  } else console.log('（沒有設定 ANTHROPIC_API_KEY，這次不產生摘要與翻譯）');
  const items = sorted();

  console.log('\n來源報告');
  for (const r of report) console.log(r.ok ? `✓ ${r.name} [${r.mode}] ${r.count ?? ''} ${r.feed || r.note || ''}` : `✗ ${r.name} [${r.mode}] ${r.error}（保留舊資料 ${r.kept} 篇）`);
  const st = items.reduce((m, i) => (m[i.extractionStatus || 'none'] = (m[i.extractionStatus || 'none'] || 0) + 1, m), {});
  console.log(`\n→ ${OUT}：${items.length} 篇，全文狀態 ${JSON.stringify(st)}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
