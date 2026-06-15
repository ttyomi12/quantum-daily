/**
 * 量子日报 v3 — 从可访问的新闻源直接抓取 + AI处理
 * 适配公司网络环境（Google被封，Bing/量子媒体可访问）
 */
const { writeFileSync, mkdirSync, existsSync, readFileSync } = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');

const API_KEY = 'sk-882076775e0843888c9ad3c1103c59ef';
const OUTPUT_DIR = path.resolve(__dirname, '..', 'output');
const TPL_PATH = path.resolve(__dirname, '..', 'templates', 'report.html');

// ========== 可直接访问的新闻源 ==========
const NEWS_SOURCES = {
  rss: [
    // Bing News 搜索（公司网络可访问）
    { url: 'https://www.bing.com/news/search?q=quantum+computing&format=rss&qft=interval%3d"1"', cat: '科研' },
    { url: 'https://www.bing.com/news/search?q=quantum+key+distribution+QKD&format=rss&qft=interval%3d"1"', cat: '科研' },
    { url: 'https://www.bing.com/news/search?q=quantum+computing+business+funding&format=rss&qft=interval%3d"1"', cat: '产业' },
    { url: 'https://www.bing.com/news/search?q=quantum+policy+government&format=rss&qft=interval%3d"1"', cat: '政策' },
    { url: 'https://www.bing.com/news/search?q=IonQ+OR+Rigetti+OR+Quantinuum+OR+IQM&format=rss&qft=interval%3d"1"', cat: '产业' },
    { url: 'https://www.bing.com/news/search?q=post-quantum+cryptography+PQC&format=rss&qft=interval%3d"1"', cat: '政策' },
    { url: 'https://www.bing.com/news/search?q=quantum+sensing+metrology&format=rss&qft=interval%3d"1"', cat: '科研' },
    { url: 'https://www.bing.com/news/search?q=量子计算+量子通信+量子测量&format=rss&qft=interval%3d"1"', cat: '科研' },
    // 量子专业媒体（公司网络可访问）
    { url: 'https://thequantuminsider.com/feed/', cat: '产业' },
  ],
  web: [
    // 国内量子媒体（直接抓取HTML页面）
    { url: 'http://www.qtc.com.cn/', cat: '产业', name: '量子科技产业资讯' },
    { url: 'https://thequantuminsider.com/', cat: '产业', name: 'The Quantum Insider' },
  ]
};

const T0_LIST = ['IonQ','Rigetti','IBM','Google','Microsoft','NVIDIA','IQM','本源量子','国仪量子','玻色量子','九州量子','中创为量子','问天量子','图灵量子','中国移动','中国联通','中国电信','SK Telecom'];

// ========== 工具函数 ==========
const S = ms => new Promise(r => setTimeout(r, ms));
const E = s => s ? String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;') : '';

function fetchUrl(url) {
  return new Promise(R => {
    const proto = url.startsWith('https') ? https : http;
    const req = proto.get(url, {
      timeout: 20000,
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36', 'Accept': 'text/html,application/rss+xml,application/xml' }
    }, res => {
      if ([301,302,303,307,308].includes(res.statusCode) && res.headers.location) {
        try {
          const redirectUrl = new URL(res.headers.location, url).href;
          return fetchUrl(redirectUrl).then(R);
        } catch { R(''); return; }
      }
      if (res.statusCode !== 200) { R(''); return; }
      let d = ''; res.on('data', c => d += c); res.on('end', () => R(d)); res.on('error', () => R(''));
    });
    req.on('error', () => R('')); req.on('timeout', () => { req.destroy(); R(''); });
  });
}

function parseRSSItems(xml) {
  const items = [];
  const re = /<item>([\s\S]*?)<\/item>/gi; let m;
  while ((m = re.exec(xml)) !== null) {
    const t = extractCDATA(m[1], 'title');
    const l = extractCDATA(m[1], 'link');
    const desc = extractCDATA(m[1], 'description');
    const pubDate = extractCDATA(m[1], 'pubDate');
    if (t && l) items.push({ title: cleanText(t), link: l.trim(), description: cleanText(desc).substring(0, 300), pubDate: pubDate ? new Date(pubDate).toISOString() : '' });
  }
  return items;
}

function extractCDATA(xml, tag) {
  const m = xml.match(new RegExp(`<${tag}[^>]*>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?</${tag}>`, 'is'));
  return m ? m[1].trim() : '';
}

function cleanText(s) {
  return s.replace(/<[^>]*>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ').trim();
}

// ========== AI 调用 ==========
async function callAI(messages) {
  const body = JSON.stringify({ model: 'DeepSeek-V4-pro', max_tokens: 8192, messages, temperature: 0.3 });
  return new Promise((R, J) => {
    const r = https.request({
      hostname: 'api.deepseek.com', path: '/anthropic/v1/messages', method: 'POST', timeout: 180000,
      headers: { 'Content-Type': 'application/json', 'x-api-key': API_KEY, 'anthropic-version': '2023-06-01' }
    }, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => {
        try { const j = JSON.parse(d); if (j.error) J(new Error(j.error.message)); else R((j.content||[]).map(c=>c.text||'').join('')); }
        catch(e) { J(new Error('parse err: '+d.substring(0,200))); }
      });
      res.on('error', J);
    });
    r.on('error', J); r.on('timeout', () => { r.destroy(); J(new Error('timeout')); });
    r.write(body); r.end();
  });
}

// ========== 搜索新闻 ==========
async function searchNews() {
  console.log('🔍 搜索量子科技新闻...\n');
  const all = [], seen = new Set();

  // RSS 源
  for (const src of NEWS_SOURCES.rss) {
    console.log(`  RSS: ${src.url.substring(0,70)}...`);
    const data = await fetchUrl(src.url);
    if (!data) { console.log('    ⚠ 无响应\n'); await S(500); continue; }
    const items = parseRSSItems(data);
    let added = 0;
    for (const it of items) {
      if (!seen.has(it.link)) { seen.add(it.link); it.category = src.cat; all.push(it); added++; }
    }
    console.log(`    ✅ +${added}条 (共${items.length}条)\n`);
    await S(600);
  }

  // 直接抓取网页
  for (const src of NEWS_SOURCES.web) {
    console.log(`  WEB: ${src.url}`);
    const html = await fetchUrl(src.url);
    if (!html) { console.log('    ⚠ 无响应\n'); await S(500); continue; }
    // 提取链接
    const linkRe = /<a[^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
    let m, added = 0;
    while ((m = linkRe.exec(html)) !== null) {
      let link = m[1], text = cleanText(m[2]);
      if (!link || !text || text.length < 15) continue;
      if (!link.startsWith('http')) {
        try { link = new URL(link, src.url).href; } catch { continue; }
      }
      if (!seen.has(link)) { seen.add(link); all.push({ title: text, link, description: '', source: src.name, category: src.cat }); added++; }
    }
    console.log(`    ✅ +${added}条\n`);
    await S(600);
  }

  console.log(`📊 共搜集 ${all.length} 条不重复新闻\n`);
  return all;
}

// ========== AI 处理 ==========
async function processWithAI(items) {
  console.log('🤖 AI 核验与撰写摘要...\n');
  const BATCH = 20, batches = [];
  for (let i = 0; i < items.length; i += BATCH) batches.push(items.slice(i, i + BATCH));

  const all = [];
  for (let bi = 0; bi < batches.length; bi++) {
    const batch = batches[bi];
    console.log(`  批次 ${bi+1}/${batches.length} (${batch.length}条)...`);
    const txt = batch.map((it,i) => `[${i+1}] ${it.title}\n  链接: ${it.link}`).join('\n\n');

    const sys = `你是科大国盾量子（QuantumCTek）产业分析助手。请对每条新闻进行判断：
1. 是否与量子科技（量子通信/QKD、量子计算、量子测量、PQC）相关？
2. 如相关，撰写150字中文客观摘要
3. 标注分类：政策/产业/科研
4. 判断是否涉及以下T0友商：${T0_LIST.join('、')}

规则：
- 不相关的新闻直接过滤
- 同一事件如有多条，只保留一条
- 排除纯转载、广告、标题党
- 来自官方新闻稿/Nature/Science/PRL/政府网站的标注"已核实"，其他"待核实"

输出 JSON：
{"items":[{"category":"政策|产业|科研","confidence":"已核实|待核实","title":"中文标题≤20字","summary":"≤150字中文客观摘要(5W1H)","sourceName":"来源名称","sourceUrl":"原文链接","involvesT0":true/false,"involvesCompetitor":"友商名逗号分隔(如涉及)","isBreakthrough":true/false}]}
只输出JSON，不要其他文字。`;

    try {
      const r = await callAI([{ role: 'system', content: sys }, { role: 'user', content: `处理以下新闻(${batch.length}条)：\n\n${txt}` }]);
      const jm = r.match(/\{[\s\S]*"items"[\s\S]*\}/);
      if (jm) { const p = JSON.parse(jm[0]); if (p.items) { all.push(...p.items); console.log(`    ✅ 获得${p.items.length}条\n`); } }
      else { console.log(`    ⚠ 无法解析输出: ${r.substring(0,100)}\n`); }
    } catch(e) { console.log(`    ❌ ${e.message}\n`); }
    if (bi < batches.length-1) await S(2000);
  }

  // 去重
  const s = new Set();
  const deduped = all.filter(i => { if (s.has(i.title)) return false; s.add(i.title); return true; });
  console.log(`📊 AI处理后共 ${deduped.length} 条\n`);
  return deduped;
}

// ========== 构建 HTML ==========
function buildHTML(items) {
  console.log('📝 生成HTML...');
  const tpl = readFileSync(TPL_PATH, 'utf-8');
  const now = new Date();
  const ds = `${now.getFullYear()}年${now.getMonth()+1}月${now.getDate()}日`;
  const ts = String(now.getHours()).padStart(2,'0')+':'+String(now.getMinutes()).padStart(2,'0');

  const pol = items.filter(i => i.category === '政策');
  const ind = items.filter(i => i.category === '产业');
  const res = items.filter(i => i.category === '科研');
  const t0 = items.filter(i => i.involvesT0);
  const br = items.filter(i => i.isBreakthrough);

  function card(i) {
    const cc = i.category === '政策' ? 'tag-policy' : i.category === '产业' ? 'tag-industry' : 'tag-research';
    const co = i.confidence === '已核实' ? 'conf-high' : 'conf-medium';
    const ct = i.involvesCompetitor ? `<span class="tag tag-competitor">${E(i.involvesCompetitor)}</span>` : '';
    return `\n    <div class="news-card">
      <div class="news-hdr">
        <span class="tag ${cc}">${i.category}</span>${ct}
        <span class="confidence ${co}">${i.confidence||'待核实'}</span>
      </div>
      <div class="news-title">${E(i.title)}</div>
      <div class="news-summary">${E(i.summary)}</div>
      <div class="news-meta">
        <span class="news-source">📰 ${E(i.sourceName||'综合来源')}</span>
        <a href="${E(i.sourceUrl||'#')}" target="_blank" class="news-link">查看原文</a>
      </div>
    </div>`;
  }

  function tracker() {
    const ci = items.filter(i => i.involvesCompetitor);
    if (!ci.length) return '<div class="no-data">今日暂无友商重大动态</div>';
    let h = '<table class="tracker-table"><thead><tr><th>企业</th><th>T0</th><th>动态</th><th>来源</th></tr></thead><tbody>';
    for (const it of ci) {
      for (const c of (it.involvesCompetitor||'').split(',').map(s=>s.trim()).filter(Boolean)) {
        h += `<tr><td style="font-weight:600;color:var(--text);">${E(c)}</td><td>${T0_LIST.includes(c)?'<span class="t0-badge">T0</span>':'-'}</td><td>${E(it.title)}</td><td><a href="${E(it.sourceUrl||'#')}" target="_blank">来源 ↗</a></td></tr>`;
      }
    }
    return h + '</tbody></table>';
  }

  const ss = {}; items.forEach(i => { ss[i.sourceName] = (ss[i.sourceName]||0)+1; });
  const sst = Object.entries(ss).sort((a,b)=>b[1]-a[1]).slice(0,5).map(([n,c])=>n+'('+c+')').join('、');
  const compAll = new Set(items.filter(i=>i.involvesCompetitor).flatMap(i=>(i.involvesCompetitor||'').split(',').map(s=>s.trim()))).size;

  return tpl
    .replace(/{{REPORT_DATE}}/g, ds).replace(/{{TOTAL_COUNT}}/g, items.length)
    .replace(/{{POLICY_COUNT}}/g, pol.length).replace(/{{INDUSTRY_COUNT}}/g, ind.length)
    .replace(/{{RESEARCH_COUNT}}/g, res.length).replace(/{{T0_COUNT}}/g, t0.length)
    .replace(/{{BREAKTHROUGH_COUNT}}/g, br.length).replace(/{{GENERATION_TIME}}/g, ts)
    .replace(/{{SOURCE_STATS}}/g, sst||'多源综合').replace(/{{COMPETITOR_COUNT_TEXT}}/g, compAll)
    .replace(/{{YEAR}}/g, now.getFullYear())
    .replace('{{POLICY_ITEMS}}', pol.length?pol.map(card).join(''):'<div class="no-data">今日暂无政策类新闻</div>')
    .replace('{{INDUSTRY_ITEMS}}', ind.length?ind.map(card).join(''):'<div class="no-data">今日暂无产业类新闻</div>')
    .replace('{{RESEARCH_ITEMS}}', res.length?res.map(card).join(''):'<div class="no-data">今日暂无科研类新闻</div>')
    .replace('{{COMPETITOR_TRACKER}}', tracker());
}

// ========== 主流程 ==========
async function main() {
  console.log('════════════════════════════════');
  console.log('  量子科技产业日报 · 生成系统');
  console.log('  科大国盾量子技术股份有限公司');
  console.log('════════════════════════════════\n');

  const items = await searchNews();
  if (!items.length) {
    console.log('⚠ 未搜集到新闻，尝试直接让AI生成一次...');
    // fallback: 让AI基于知识生成
    const sys2 = `你是科大国盾量子产业分析助手。请基于你对量子科技领域的了解，提供近期（近几天）的真实重大新闻。如果实在不确定具体日期的事件，请诚实返回空数组。`;
    const r2 = await callAI([{ role:'system', content:sys2 }, { role:'user', content:'请列出近期量子科技领域的重大新闻事件（政策、产业、科研各2-3条），只输出JSON。如果没有确定的近期新闻，返回{"items":[]}' }]);
    const jm2 = r2.match(/\{[\s\S]*"items"[\s\S]*\}/);
    const fallback = jm2 ? JSON.parse(jm2[0]).items || [] : [];
    if (!fallback.length) { console.log('⚠ 无新闻可生成'); return; }
    const html = buildHTML(fallback);
    if (!existsSync(OUTPUT_DIR)) mkdirSync(OUTPUT_DIR, { recursive: true });
    if (!existsSync(OUTPUT_DIR+'/archive')) mkdirSync(OUTPUT_DIR+'/archive', { recursive: true });
    writeFileSync(OUTPUT_DIR+'/index.html', html, 'utf-8');
    console.log('✅ 日报已生成(知识库模式)');
    return;
  }

  const proc = await processWithAI(items);
  if (!proc.length) { console.log('⚠ AI处理结果为空'); return; }

  const html = buildHTML(proc);
  if (!existsSync(OUTPUT_DIR)) mkdirSync(OUTPUT_DIR, { recursive: true });
  if (!existsSync(OUTPUT_DIR+'/archive')) mkdirSync(OUTPUT_DIR+'/archive', { recursive: true });
  writeFileSync(OUTPUT_DIR+'/index.html', html, 'utf-8');
  const df = `${new Date().getFullYear()}-${String(new Date().getMonth()+1).padStart(2,'0')}-${String(new Date().getDate()).padStart(2,'0')}`;
  writeFileSync(`${OUTPUT_DIR}/archive/量子日报-${df}.html`, html, 'utf-8');

  const pol = proc.filter(i=>i.category==='政策').length;
  const ind = proc.filter(i=>i.category==='产业').length;
  const ress = proc.filter(i=>i.category==='科研').length;
  const t0c = proc.filter(i=>i.involvesT0).length;
  console.log('\n════════════════════════════════');
  console.log(`  ✅ 日报生成完成！共${proc.length}条快讯`);
  console.log(`  📋 政策:${pol} | 🏭 产业:${ind} | 🔬 科研:${ress} | 🎯 T0:${t0c}`);
  console.log(`  📁 ${OUTPUT_DIR}/index.html`);
  console.log('════════════════════════════════');
}

main().catch(e => { console.error('❌', e.message); process.exit(1); });
