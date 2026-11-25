// 用 Claude API 幫有全文的文章產生：較長的英文摘要、3–5 個重點、原文重點句（畫螢光筆用），
// 以及台灣繁體中文翻譯（標題、摘要、重點、整篇內文）。結果存進每篇文章的 item.ai，做過的不會重做。
//
// 只有設定了 API key 才會執行：在 PowerShell 先打
//   $env:ANTHROPIC_API_KEY="你的 key"
// 再跑 npm run build。沒有 key 就整段跳過，其他功能照常。
//
// 可調的環境變數：
//   AI_MODEL   使用的模型，預設 claude-opus-5-5
//   AI_MAX     這次最多處理幾篇，預設 50（控制花費；設 0 表示不限）
//   AI_OFF=1   這次不跑

const MODEL = process.env.AI_MODEL || 'claude-opus-5-5';
const MAX = process.env.AI_MAX === undefined ? 50 : Number(process.env.AI_MAX) || Infinity;
const CARD_TEXT_LIMIT = 20000;   // 公開網站只做卡片摘要，送前 2 萬字元就夠，省費用
const TEXT_LIMIT = 60000;   // 送去做摘要的純文字上限（字元），超過的長文只送前段，並在報告裡註明

export const aiEnabled = () => !process.env.AI_OFF && !!(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
// cardOnly（公開網站用）：只做卡片用的短摘要＋關鍵字（和長摘要、重點），不做重點句與翻譯，一篇只呼叫一次
export const needsAi = (i, cardOnly = false) => !(i.ai && i.ai.brief && (cardOnly || (i.ai.zh && i.ai.zh.html)));
const ready = (i) => i.extractionStatus === 'full' && i.contentHtml;
export const AI_MAX = MAX;

export async function runAi(items, { JSDOM, save, cardOnly = false }) {
  const all = items.filter((i) => ready(i) && needsAi(i, cardOnly));
  const todo = all.slice(0, MAX);
  const waiting = all.length - todo.length;
  if (!todo.length) { console.log('AI 摘要與翻譯：沒有新文章要處理'); return; }
  let Anthropic;
  try { ({ default: Anthropic } = await import('@anthropic-ai/sdk')); }
  catch { console.warn('! 找不到 @anthropic-ai/sdk，請先執行 npm install。這次跳過摘要與翻譯。'); return; }
  const client = new Anthropic();
  console.log(`AI 摘要與翻譯：${todo.length} 篇（模型 ${MODEL}）${waiting ? `，另有 ${waiting} 篇留到下次` : ''}`);
  let done = 0, failed = 0, inTok = 0, outTok = 0;
  const ask = async (prompt, schema, maxTokens = 64000) => {
    const stream = client.beta.messages.stream({
      model: MODEL, max_tokens: maxTokens,
      betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default',
      output_config: { format: { type: 'json_schema', schema } },
      messages: [{ role: 'user', content: prompt }],
    });
    const msg = await stream.finalMessage();
    inTok += msg.usage.input_tokens || 0; outTok += msg.usage.output_tokens || 0;
    if (msg.stop_reason === 'refusal') throw new Error('Claude 拒絕處理這篇');
    if (msg.stop_reason === 'max_tokens') throw new Error('回覆太長被截斷');
    const text = msg.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
    return JSON.parse(text);
  };

  for (let q = 0; q < todo.length; q += 2) {
    await Promise.all(todo.slice(q, q + 2).map(async (item) => {
      try { item.ai = await processItem(item, ask, JSDOM, cardOnly); done++; console.log(`  ✓ ${item.sourceName}｜${item.title}`); }
      catch (e) { failed++; console.warn(`  ✗ ${item.sourceName}｜${item.title}：${errText(e, Anthropic)}`); }
    }));
    if (save) await save();   // 每做完兩篇就存一次，中途停掉也不會白做
  }
  console.log(`AI 完成 ${done} 篇${failed ? `，失敗 ${failed} 篇（下次再試）` : ''}；用量 輸入 ${inTok.toLocaleString()} tokens、輸出 ${outTok.toLocaleString()} tokens`);
}

function errText(e, Anthropic) {
  if (e instanceof Anthropic.AuthenticationError) return 'API key 無效';
  if (e instanceof Anthropic.PermissionDeniedError) return '這個 API key 沒有權限使用此模型';
  if (e instanceof Anthropic.RateLimitError) return '請求太頻繁或額度不足，稍後再跑';
  if (e instanceof Anthropic.APIError) return `API 錯誤 ${e.status}：${e.message}`;
  return String(e.message || e);
}

async function processItem(item, ask, JSDOM, cardOnly) {
  const dom = new JSDOM(`<body>${item.contentHtml}</body>`);
  const doc = dom.window.document, body = doc.body;
  const first = body.querySelector('h1,h2');
  if (first && !first.previousElementSibling && first.textContent.trim().toLowerCase() === item.title.trim().toLowerCase()) first.remove();
  const text = body.textContent.replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n\n').trim();

  // 1. 摘要、重點、重點句
  const s = await ask(summaryPrompt(item, text.slice(0, cardOnly ? CARD_TEXT_LIMIT : TEXT_LIMIT)), {
    type: 'object', additionalProperties: false, required: ['brief', 'keywords', 'summary', 'points', 'highlights'],
    properties: { brief: { type: 'string' }, keywords: { type: 'array', items: { type: 'string' } },
      summary: { type: 'string' }, points: { type: 'array', items: { type: 'string' } }, highlights: { type: 'array', items: { type: 'string' } } },
  }, 16000);
  const brief = String(s.brief || '').trim();
  const ai = { brief, keywords: (s.keywords || []).map(String).filter((k) => k.length > 1 && brief.toLowerCase().includes(k.toLowerCase())).slice(0, 5),
    summary: String(s.summary || '').trim(), points: (s.points || []).map(String).slice(0, 6), highlights: (s.highlights || []).map(String).slice(0, 8) };
  if (cardOnly) { ai.model = MODEL; ai.at = new Date().toISOString(); return ai; }

  const arraySchema = (n) => ({ type: 'object', additionalProperties: false, required: ['translations'],
    properties: { translations: { type: 'array', items: { type: 'string' }, minItems: n, maxItems: n } } });
  const tr = async (segs) => { const r = await ask(zhPrompt(item, segs), arraySchema(segs.length));
    if (!Array.isArray(r.translations) || r.translations.length !== segs.length) throw new Error('翻譯段數不符'); return r.translations; };
  const head = [item.title, ai.summary, ...ai.points];
  const zhHead = await tr(head);
  ai.zh = { title: zhHead[0], summary: zhHead[1], points: zhHead.slice(2) };
  ai.model = MODEL; ai.at = new Date().toISOString();
  if (text.length > TEXT_LIMIT) ai.note = 'summary-from-first-part';
  if (headOnly) return ai;

  // 2. 在原文畫上重點句，再整篇翻譯（<mark> 會跟著翻譯保留）
  markSentences(doc, body, ai.highlights);
  const blocks = [...body.childNodes].map((n) => n.nodeType === 1 ? n.outerHTML : (n.textContent.trim() ? `<p>${escapeHtml(n.textContent.trim())}</p>` : ''));
  const want = blocks.map((h, k) => (/[A-Za-z]{2}/.test(h.replace(/<[^>]+>/g, '')) ? k : -1)).filter((k) => k >= 0);
  const groups = []; let cur = [], size = 0;
  for (const k of want) { if (cur.length && (size + blocks[k].length > 9000 || cur.length >= 30)) { groups.push(cur); cur = []; size = 0; } cur.push(k); size += blocks[k].length; }
  if (cur.length) groups.push(cur);
  const out = blocks.slice();
  for (let g = 0; g < groups.length; g += 2) {
    await Promise.all(groups.slice(g, g + 2).map(async (grp) => { const r = await tr(grp.map((k) => blocks[k])); grp.forEach((k, n) => { out[k] = r[n]; }); }));
  }
  ai.zh.html = out.join('\n');
  return ai;
}

const escapeHtml = (s) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

function summaryPrompt(item, text) {
  return `You help a design-literate reader grasp an article quickly.
Article: "${item.title}" from ${item.sourceName}.

Return:
- brief: 2 or 3 sentences in English (about 45 to 65 words) for a card in a list, so the reader can decide whether to open the article: what it is about, its main claim or finding, and what makes it worth reading. Concrete, no hype, no "This article".
- keywords: 3 to 5 key phrases (1 to 4 words each) that carry the brief's meaning, copied exactly as they appear in the brief.
- summary: 4 to 6 sentences in English (about 110 to 160 words). Say what the article argues or reports, the main evidence or examples, and why it matters to people who design products, services or interfaces. Plain, precise language, no hype.
- points: 3 to 5 key takeaways, each one short sentence.
- highlights: 3 to 6 sentences from the article that carry its main ideas, copied EXACTLY as they appear in the text below, character for character, each under 280 characters. Spread them across the article.

Article text:
<<<
${text}
>>>`;
}

function zhPrompt(item, segs) {
  return `Translate these ${segs.length} segments of an article from ${item.sourceName} ("${item.title}") into Traditional Chinese as written in Taiwan (zh-Hant-TW).

Write as a professional translator for a respected design and technology publication would: accurate, natural and concise Chinese that reads as if written in Chinese, not word for word. Use the established Taiwanese terms of the field (for example: user experience 使用者經驗, user interface 使用者介面, interaction design 互動設計, usability 易用性, prototype 原型, software 軟體, information 資訊, network 網路, data 資料, model 模型, accessibility 無障礙). Keep names of people, companies, products, publications and code as they are in English; for a specialist term without an established Chinese form, write the Chinese followed by the English in parentheses the first time. Use full-width Chinese punctuation (，。、；：？！「」『』——) and put a space between Chinese and English words or numbers. Do not add, explain or leave out anything.

Segments may contain HTML. Keep every tag and attribute exactly as it is (a, em, strong, b, i, code, mark, br, li, img, figure, figcaption, sup, sub and so on), translate only the text between tags, keep links on the matching words, and keep each <mark> around the Chinese words that correspond to the marked English.

Return "translations": an array of exactly ${segs.length} strings, the translations in the same order as the segments.

Segments:
${JSON.stringify(segs)}`;
}

/* 與網頁上相同的做法：忽略空白與引號差異，在段落裡找到重點句並包上 <mark> */
function markSentences(doc, root, sentences) {
  const norm = (c) => /[‘’‛′]/.test(c) ? "'" : /[“”‟″]/.test(c) ? '"' : /[–—]/.test(c) ? '-' : c;
  const blocks = [...root.querySelectorAll('p, li, blockquote, h2, h3, h4')].filter((b) => !b.querySelector('p, li'));
  const flatsOf = () => blocks.map((block) => {
    const nodes = []; const w = doc.createTreeWalker(block, 4); let n; while ((n = w.nextNode())) nodes.push(n);
    let flat = '', map = [], lastSpace = true;
    nodes.forEach((node) => { for (let k = 0; k < node.data.length; k++) { const c = node.data[k];
      if (/\s/.test(c)) { if (lastSpace) continue; flat += ' '; lastSpace = true; } else { flat += norm(c).toLowerCase(); lastSpace = false; }
      map.push([node, k]); } });
    return { flat, map };
  });
  for (const s of sentences) {
    const want = s.split('').map((c) => /\s/.test(c) ? ' ' : norm(c).toLowerCase()).join('').replace(/ +/g, ' ').trim();
    if (want.length < 12) continue;
    for (const f of flatsOf()) {
      let at = f.flat.indexOf(want), len = want.length;
      if (at < 0 && want.length > 90) { at = f.flat.indexOf(want.slice(0, 90)); if (at >= 0) { const end = f.flat.indexOf('. ', at + 90); len = (end < 0 ? f.flat.length : end + 1) - at; } }
      if (at < 0) continue;
      const parts = new Map();
      for (let k = at; k < at + len && k < f.map.length; k++) { const [node, off] = f.map[k]; const p = parts.get(node); if (p) p[1] = off; else parts.set(node, [off, off]); }
      [...parts].reverse().forEach(([node, [a, b]]) => {
        if (node.parentElement && node.parentElement.closest('mark')) return;
        const r = doc.createRange(); r.setStart(node, a); r.setEnd(node, b + 1);
        const m = doc.createElement('mark'); m.className = 'hl'; try { r.surroundContents(m); } catch {}
      });
      break;
    }
  }
}
