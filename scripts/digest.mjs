// 免費的卡片摘要（不用 API）：從原文挑出最能代表全文的 2～3 句，並找出 3～4 個關鍵詞。
// 做法：計算每個詞在這篇文章出現的次數，乘上「在其他文章少見」的權重（TF-IDF），
// 標題裡的詞再加分；每句話依關鍵詞分數和位置打分，取最高的幾句、依原文順序排好。
// 結果存在 item.digest = { brief, keywords, by: 'extract' }，只是幾句引文，不存全文。

const STOP = new Set(`a about above after again against all also am an and any are aren't as at be because been before being below
between both but by can can't cannot could couldn't did didn't do does doesn't doing don't down during each even ever every few for
from further get gets got had hadn't has hasn't have haven't having he he'd he'll he's her here here's hers herself him himself his
how how's however i i'd i'll i'm i've if in into is isn't it it's its itself just let's like made make makes many may me might more
most much must mustn't my myself new no nor not now of off often on once one only or other ought our ours ourselves out over own
per perhaps put quite rather really said same say says see seem seems shan't she she'd she'll she's should shouldn't since so some
still such take than that that's the their theirs them themselves then there there's these they they'd they'll they're they've thing
things this those though through thus to too two under until up upon us use used uses using very via want was wasn't way ways we
we'd we'll we're we've well were weren't what what's when when's where where's whether which while who who's whom whose why why's
will with within without won't would wouldn't year years yet you you'd you'll you're you've your yours yourself yourselves
also around back best better big came come comes day days different does done first going good great know last least less let
lot lots look looks looking means need needs next often part people place point right show shows small something thing think
time times today told took went work works world year`.split(/\s+/));
const JUNK = /subscribe|newsletter|sign up|cookie|advertis|sponsored|all rights reserved|©|click here|read more|photo(graph)? by|image:|courtesy of|follow us|share this|related:|this story|this post|in this (article|post|episode)/i;

const DANGLING = /^(but|and|so|or|yet|if so|it|its|it's|he|she|they|we|i|you|his|her|their|in that|that|these|those|such|however|also|still|then|this is|here|there|both|which|instead|meanwhile|in a sense|of course|after all)\b/i;
const stem = (w) => w.replace(/(ies)$/, 'y').replace(/([^s])s$/, '$1');
const words = (s) => (s.toLowerCase().match(/[a-z][a-z0-9'’-]*[a-z0-9]|[a-z]/g) || []).map((w) => w.replace(/[’']s$/, '').replace(/’/g, "'"));
const good = (w) => w.length > 2 && !STOP.has(w) && !/^\d+$/.test(w);

// 全部文章的標題＋RSS 摘要當語料，找出「到處都有」的通用詞（design、product…）並降低權重
export function makeDf(items) {
  const df = new Map();
  for (const i of items) for (const w of new Set(words(`${i.title} ${i.excerpt || ''}`).filter(good))) df.set(w, (df.get(w) || 0) + 1);
  return { df, n: Math.max(items.length, 1) };
}

function sentencesOf(doc) {
  const out = [];
  const blocks = [...doc.body.querySelectorAll('p, li, blockquote')].filter((b) => !b.querySelector('p, li'));
  blocks.forEach((b, bi) => {
    const t = b.textContent.replace(/\s+/g, ' ').trim();
    if (t.length < 50) return;
    const parts = t.match(/[^.!?]+(?:[.!?]+["”’)]*|$)\s*/g) || [t];
    parts.forEach((s) => { s = s.trim(); if (s.length >= 50 && s.length <= 300 && /^[A-Z0-9"“‘'(]/.test(s) && !JUNK.test(s) && /[a-z]/.test(s) && /[.!?"”’)]$/.test(s)) out.push({ s, block: bi }); });
  });
  return out;
}

export function makeDigest(item, html, JSDOM, corpus) {
  if (!html) return null;
  const doc = new JSDOM(`<body>${html}</body>`).window.document;
  const sents = sentencesOf(doc);
  if (sents.length < 2) return null;

  // 詞的分數：在這篇出現次數 × 在語料裡少見的程度；標題詞加倍
  const titleW = new Set(words(item.title).filter(good));
  const tf = new Map(); const bi = new Map();
  for (const { s } of sents) {
    const ws = words(s);
    ws.forEach((w, k) => {
      if (good(w)) tf.set(w, (tf.get(w) || 0) + 1);
      const w2 = ws[k + 1];
      if (w2 && good(w) && good(w2)) { const p = `${w} ${w2}`; bi.set(p, (bi.get(p) || 0) + 1); }
    });
  }
  const idf = (w) => Math.log((corpus.n + 1) / ((corpus.df.get(w) || 0) + 1)) + 1;
  const score = new Map();
  for (const [w, c] of tf) score.set(w, (1 + Math.log(c)) * idf(w) * (titleW.has(w) ? 2 : 1));

  // 每句的分數：句中關鍵詞分數總和 ÷ 句長的平方根，越前面的段落越加分
  const nBlocks = Math.max(...sents.map((x) => x.block)) + 1;
  sents.forEach((x, k) => {
    const ws = words(x.s).filter(good);
    const sum = [...new Set(ws)].reduce((a, w) => a + (score.get(w) || 0), 0);
    const pos = 1 + 0.8 * (1 - x.block / nBlocks) + (k === 0 ? 0.5 : 0);
    // 以代名詞或連接詞開頭的句子，單獨拿出來常看不懂，扣分
    const dangling = DANGLING.test(x.s) ? 0.55 : /\?$/.test(x.s) ? 0.6 : 1;
    x.score = (sum / Math.sqrt(Math.max(ws.length, 6))) * pos * dangling;
    x.k = k;
  });
  const picked = []; let len = 0;
  for (const x of [...sents].sort((a, b) => b.score - a.score)) {
    if (picked.length >= 3 || len > 300) break;
    if (len + x.s.length > 420) continue;
    if (picked.some((p) => overlap(p.s, x.s) > 0.5)) continue;
    picked.push(x); len += x.s.length + 1;
  }
  if (!picked.length) return null;
  const brief = picked.sort((a, b) => a.k - b.k).map((x) => x.s).join(' ');

  // 關鍵詞：優先用出現兩次以上的雙字詞，再補單字；只留真的出現在摘要裡的
  const low = brief.toLowerCase();
  const phrases = [...bi].filter(([, c]) => c >= 2).map(([p, c]) => [p, (1 + Math.log(c)) * p.split(' ').reduce((a, w) => a + (score.get(w) || 0), 0)]);
  const singles = [...score].filter(([w]) => titleW.has(w) || tf.get(w) >= 3).map(([w, s]) => [w, s]);   // 單字要在標題裡或出現 3 次以上
  const keywords = [];
  for (const [p] of [...phrases, ...singles].sort((a, b) => b[1] - a[1])) {
    if (keywords.length >= 4) break;
    const at = findWord(low, p); if (at < 0) continue;
    const pw = p.split(' ').map(stem);
    if (keywords.some((k) => k.toLowerCase().split(' ').map(stem).some((w) => pw.includes(w)))) continue;
    keywords.push(brief.slice(at, at + p.length));
  }
  return { brief, keywords, by: 'extract' };
}

const overlap = (a, b) => { const A = new Set(words(a).filter(good)), B = new Set(words(b).filter(good)); let n = 0; for (const w of A) if (B.has(w)) n++; return n / Math.max(1, Math.min(A.size, B.size)); };
// 整個詞相符才算（不要把 "art" 標在 "start" 裡）
function findWord(text, w) {
  let at = -1;
  while ((at = text.indexOf(w, at + 1)) >= 0) {
    const before = text[at - 1], after = text[at + w.length];
    if (!(before && /[a-z0-9]/.test(before)) && !(after && /[a-z0-9]/.test(after))) return at;
  }
  return -1;
}
