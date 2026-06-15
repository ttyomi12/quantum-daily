/**
 * 量子日报 v4 — 严格核验版
 * 全部快讯必须从可访问的实际来源抓取+核验
 * HTML 格式完全参照 国盾量子_舆情监控 的 .ri 新闻卡片
 */
const { writeFileSync, mkdirSync, existsSync, readFileSync } = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');

const API_KEY = 'sk-882076775e0843888c9ad3c1103c59ef';
const TPL = readFileSync(path.resolve(__dirname, '..', 'templates', 'report3.html'), 'utf-8');

// ========= 可直接访问的新闻源 =========
const SOURCES = [
  // 量子专业媒体
  { url: 'https://thequantuminsider.com/', type: 'web', cat: '产业', name: 'The Quantum Insider', level: 'media' },
  { url: 'https://thequantuminsider.com/feed/', type: 'rss', cat: '产业', name: 'The Quantum Insider', level: 'media' },
  { url: 'http://www.qtc.com.cn/', type: 'web', cat: '产业', name: '量子科技产业资讯', level: 'media', region: 'cn' },
  // Bing News (可访问)
  { url: 'https://www.bing.com/news/search?q=quantum+computing&format=rss&qft=interval%3d"1"', type: 'rss', cat: '科研', name: 'Bing News', level: 'media' },
  { url: 'https://www.bing.com/news/search?q=IonQ+Rigetti+Quantinuum+IQM+quantum&format=rss&qft=interval%3d"1"', type: 'rss', cat: '产业', name: 'Bing News', level: 'media' },
  { url: 'https://www.bing.com/news/search?q=QKD+quantum+network+post-quantum+cryptography&format=rss&qft=interval%3d"1"', type: 'rss', cat: '政策', name: 'Bing News', level: 'media' },
  { url: 'https://www.bing.com/news/search?q=quantum+sensing+quantum+metrology+quantum+radar&format=rss&qft=interval%3d"1"', type: 'rss', cat: '科研', name: 'Bing News', level: 'media' },
  { url: 'https://www.bing.com/news/search?q=quantum+computing+funding+investment+IPO&format=rss&qft=interval%3d"1"', type: 'rss', cat: '产业', name: 'Bing News', level: 'media' },
];

const T0 = ['IonQ','Rigetti','IBM','Google','Microsoft','NVIDIA','IQM','本源量子','国仪量子','玻色量子','九州量子','中创为量子','问天量子','图灵量子','中国移动','中国联通','中国电信','SK Telecom'];

// ========= 工具 =========
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
        try { return fetchUrl(new URL(res.headers.location, url).href).then(R); } catch { R(''); return; }
      }
      if (res.statusCode !== 200) { R(''); return; }
      let d = ''; res.on('data', c => d += c); res.on('end', () => R(d)); res.on('error', () => R(''));
    });
    req.on('error', () => R('')); req.on('timeout', () => { req.destroy(); R(''); });
  });
}

function parseRSS(xml) {
  const items = [];
  const re = /<item>([\s\S]*?)<\/item>/gi; let m;
  while ((m = re.exec(xml)) !== null) {
    const t = extractRSS(m[1], 'title');
    const l = extractRSS(m[1], 'link');
    if (t && l) items.push({ title: cleanText(t), link: l.trim(), description: cleanText(extractRSS(m[1], 'description')).substring(0, 300), pubDate: extractRSS(m[1], 'pubDate') });
  }
  return items;
}
function extractRSS(xml, tag) {
  const m = xml.match(new RegExp(`<${tag}[^>]*>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?</${tag}>`, 'is'));
  return m ? m[1].trim() : '';
}
function cleanText(s) {
  return s.replace(/<[^>]*>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ').trim();
}

async function callAI(messages) {
  const body = JSON.stringify({ model: 'DeepSeek-V4-pro', max_tokens: 8192, messages, temperature: 0.2 });
  return new Promise((R, J) => {
    const r = https.request({
      hostname: 'api.deepseek.com', path: '/anthropic/v1/messages', method: 'POST', timeout: 180000,
      headers: { 'Content-Type': 'application/json', 'x-api-key': API_KEY, 'anthropic-version': '2023-06-01' }
    }, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => {
        try { const j = JSON.parse(d); if (j.error) J(new Error(j.error.message)); else R((j.content||[]).map(c=>c.text||'').join('')); }
        catch(e) { J(new Error('parse: '+d.substring(0,200))); }
      });
      res.on('error', J);
    });
    r.on('error', J); r.on('timeout', () => { r.destroy(); J(new Error('timeout')); });
    r.write(body); r.end();
  });
}

// ========= 搜索 =========
async function searchAll() {
  console.log('🔍 从可访问源搜索量子科技新闻...\n');
  const all = [], seen = new Set();

  for (const src of SOURCES) {
    console.log(`  [${src.cat}] ${src.name}...`);
    const data = await fetchUrl(src.url);
    if (!data) { console.log('    ⚠ 无响应\n'); await S(500); continue; }

    if (src.type === 'rss') {
      const items = parseRSS(data);
      let added = 0;
      for (const it of items) {
        if (!seen.has(it.link)) { seen.add(it.link); it.cat = src.cat; it.sourceName = src.name; it.sourceLevel = src.level; all.push(it); added++; }
      }
      console.log(`    ✅ RSS: +${added}/${items.length}\n`);
    } else {
      // 网页直接提取链接和标题
      const re = /<a[^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
      let m, added = 0;
      const titles = [];
      while ((m = re.exec(data)) !== null) {
        let link = m[1], text = cleanText(m[2]);
        if (!link || !text || text.length < 15 || text.length > 200) continue;
        if (!link.startsWith('http')) { try { link = new URL(link, src.url).href; } catch { continue; } }
        if (!seen.has(link)) { seen.add(link); titles.push({ title: text, link }); added++; }
      }
      // 只保留新闻标题，不直接加description（web抓取的description通常不准确）
      for (const it of titles) {
        all.push({ title: it.title, link: it.link, description: '', cat: src.cat, sourceName: src.name, sourceLevel: src.level });
      }
      console.log(`    ✅ WEB: +${added}条\n`);
    }
    await S(600);
  }

  console.log(`📊 共搜集 ${all.length} 条\n`);
  return all;
}

// ========= AI 严格核验 =========
async function verifyWithAI(items) {
  console.log('🔬 AI 严格核验与撰写摘要...\n');

  const BATCH = 15, batches = [];
  for (let i = 0; i < items.length; i += BATCH) batches.push(items.slice(i, i + BATCH));
  const all = [];

  for (let bi = 0; bi < batches.length; bi++) {
    const batch = batches[bi];
    console.log(`  批次 ${bi+1}/${batches.length} (${batch.length}条)...`);

    const txt = batch.map((it,i) => `[${i+1}] ${it.title}\n  来源: ${it.sourceName} | 链接: ${it.link}`).join('\n\n');

    const sys = `你是科大国盾量子（QuantumCTek）产业分析助手。

## 严格核验流程
对每条新闻，你必须：
1. 判断是否与量子科技（QKD/量子通信/量子计算/量子测量/PQC/量子安全）相关
2. 如果是：基于你的知识库，核验这条新闻是否真实、可信
3. ⚠️ 极其重要：只输出你能确认是真实的新闻。如果你对这条新闻的真实性有丝毫怀疑，直接过滤掉
4. 不要输出"待核实"——所有输出的新闻必须是你能确认真实的

## 关注领域
- 量子通信: QKD、量子网络、PQC后量子密码、量子卫星、量子安全
- 量子计算: 量子优越性、超导/光量子/离子阱/中性原子、量子纠错、超量融合
- 量子测量: 冷原子重力仪、光量子雷达、量子传感

## T0友商
${T0.join('、')}

## 输出格式（严格JSON，每批最多10条）
{"items":[{"category":"政策|产业|科研","title":"中文标题≤20字","summary":"150字左右中文客观摘要，5W1H","sourceName":"来源名称","sourceUrl":"原文链接","region":"cn|global","involvesT0":true/false,"involvesCompetitor":"友商名(如涉及用逗号分隔)","isBreakthrough":true/false,"sourceLevel":"gov|journal|official|media"}]}

## ⚠️ 铁律
- 不确认真实性的新闻 → 直接丢弃，不要输出
- 无关量子科技 → 丢弃
- 每批最多10条，宁可少也不要凑数
- 只输出JSON`;

    try {
      const r = await callAI([{ role: 'system', content: sys }, { role: 'user', content: `核验以下新闻(${batch.length}条)：\n\n${txt}` }]);
      const jm = r.match(/\{[\s\S]*"items"[\s\S]*\}/);
      if (jm) { const p = JSON.parse(jm[0]); if (p.items) { all.push(...p.items); console.log(`    ✅ ${p.items.length}条通过核验\n`); } }
      else { console.log(`    ⚠ 无法解析: ${r.substring(0,100)}\n`); }
    } catch(e) { console.log(`    ❌ ${e.message}\n`); }
    if (bi < batches.length-1) await S(2000);
  }

  const s = new Set();
  const deduped = all.filter(i => { if (s.has(i.title)) return false; s.add(i.title); return true; });
  console.log(`📊 严格核验后共 ${deduped.length} 条\n`);
  return deduped;
}

// ========= 生成HTML（舆情监控.ri格式） =========
function buildHTML(items) {
  console.log('📝 生成HTML(舆情监控格式)...');
  const now = new Date();
  const ds = `${now.getFullYear()}年${now.getMonth()+1}月${now.getDate()}日`;
  const ts = String(now.getHours()).padStart(2,'0')+':'+String(now.getMinutes()).padStart(2,'0');

  const pol = items.filter(i => i.category === '政策');
  const ind = items.filter(i => i.category === '产业');
  const res = items.filter(i => i.category === '科研');
  const t0 = items.filter(i => i.involvesT0);
  const br = items.filter(i => i.isBreakthrough);

  // >>>>> 核心：构建 .ri 格式新闻条目 <<<<<
  function buildRI(i, idx) {
    const rowClass = i.isBreakthrough ? 'breakthrough' : i.involvesT0 ? 't0-item' : '';
    const regionLabel = i.region === 'cn' ? '🇨🇳 国内' : '🌍 国际';

    // 来源级别徽章
    const sl = i.sourceLevel || 'media';
    const levelBadge = sl === 'gov' ? '<span class="src-badge gov">政府</span>'
      : sl === 'journal' ? '<span class="src-badge journal">期刊</span>'
      : sl === 'official' ? '<span class="src-badge official">官方</span>'
      : '<span class="src-badge media">行业媒体</span>';

    // 分类标签
    const catBadge = i.category === '政策'
      ? '<span class="tag tag-policy">政策</span>'
      : i.category === '产业'
        ? '<span class="tag tag-industry">产业</span>'
        : '<span class="tag tag-research">科研</span>';

    // 友商标签
    const compBadge = i.involvesCompetitor
      ? i.involvesCompetitor.split(',').map(c => `<span class="tag tag-competitor">${E(c.trim())}</span>`).join(' ')
      : '';

    // 突破标签
    const breakthroughBadge = i.isBreakthrough ? '<span class="tag tag-breakthrough">⚡突破</span>' : '';

    return `    <div class="ri ${rowClass}" id="item-${idx}" data-region="${i.region||'global'}">
      <div class="rt">
        <a href="${E(i.sourceUrl)}" target="_blank" rel="noopener">${E(i.title)}</a>
        <a href="${E(i.sourceUrl)}" target="_blank" class="ext-link" title="查看原文">↗</a>
      </div>
      <div class="rm">
        <span>📰 ${E(i.sourceName)}</span>
        ${levelBadge}
        <span class="tag tag-cn">${regionLabel}</span>
        <span class="tag tag-verified">✅ 已核验</span>
      </div>
      <div class="rs">${E(i.summary)}</div>
      <div class="tags">
        ${catBadge}
        ${compBadge}
        ${breakthroughBadge}
      </div>
      <div style="margin-top:6px;">
        <span class="detail-btn" onclick="toggleDetail(${idx})">📋 详细信息</span>
      </div>
      <div class="detail-panel" id="detail-${idx}">
        <b>来源:</b> <a href="${E(i.sourceUrl)}" target="_blank">${E(i.sourceUrl)}</a><br>
        <b>分类:</b> ${i.category} | <b>区域:</b> ${regionLabel} | <b>来源类型:</b> ${i.sourceLevel||'media'}<br>
        <b>涉及友商:</b> ${i.involvesCompetitor || '无'} | <b>T0级:</b> ${i.involvesT0?'是':'否'} | <b>重大突破:</b> ${i.isBreakthrough?'是':'否'}
      </div>
    </div>`;
  }

  // 友商追踪表
  function trackerTable() {
    const ci = items.filter(i => i.involvesCompetitor);
    if (!ci.length) return '<div class="empty-state"><p>今日暂无 T0 友商重大动态，持续追踪中。</p></div>';
    let h = '<table class="tracker-table" style="width:100%;border-collapse:collapse;font-size:13px;"><thead><tr style="color:var(--t3);font-size:10px;text-transform:uppercase;letter-spacing:.8px;"><th style="text-align:left;padding:8px 12px;border-bottom:1px solid var(--border);">企业</th><th style="text-align:center;padding:8px 12px;border-bottom:1px solid var(--border);">T0</th><th style="text-align:left;padding:8px 12px;border-bottom:1px solid var(--border);">最新动态</th><th style="text-align:left;padding:8px 12px;border-bottom:1px solid var(--border);">来源</th></tr></thead><tbody>';
    for (const it of ci) {
      const cs = (it.involvesCompetitor||'').split(',').map(s=>s.trim()).filter(Boolean);
      for (const c of cs) {
        h += `<tr style="border-bottom:1px solid rgba(30,42,58,.5);"><td style="padding:10px 12px;font-weight:600;color:var(--text);">${E(c)}</td><td style="text-align:center;padding:10px 12px;">${T0.includes(c)?'<span style="display:inline-block;background:var(--orange);color:#000;font-size:10px;font-weight:800;padding:2px 8px;border-radius:4px;">T0</span>':'-'}</td><td style="padding:10px 12px;color:var(--t2);">${E(it.title)}</td><td style="padding:10px 12px;"><a href="${E(it.sourceUrl)}" target="_blank" style="color:var(--cyan);text-decoration:none;">查看 ↗</a></td></tr>`;
      }
    }
    return h + '</tbody></table>';
  }

  const ss = {}; items.forEach(i => { ss[i.sourceName] = (ss[i.sourceName]||0)+1; });
  const sst = Object.entries(ss).sort((a,b)=>b[1]-a[1]).slice(0,5).map(([n,c])=>`${n}(${c})`).join('、');
  const compAll = new Set(items.filter(i=>i.involvesCompetitor).flatMap(i=>(i.involvesCompetitor||'').split(',').map(s=>s.trim()))).size;

  // 内联列表项
  const allRI = items.map((i,idx) => buildRI(i, idx + 1)).join('\n');
  const polRI = pol.map((i,idx) => buildRI(i, idx + 1)).join('\n');
  const indRI = ind.map((i,idx) => buildRI(i, idx + 1)).join('\n');
  const resRI = res.map((i,idx) => buildRI(i, idx + 1)).join('\n');

  let html = TPL
    .replace(/{{REPORT_DATE}}/g, ds).replace(/{{TOTAL_COUNT}}/g, items.length)
    .replace(/{{POLICY_COUNT}}/g, pol.length).replace(/{{INDUSTRY_COUNT}}/g, ind.length)
    .replace(/{{RESEARCH_COUNT}}/g, res.length).replace(/{{T0_COUNT}}/g, t0.length)
    .replace(/{{BREAKTHROUGH_COUNT}}/g, br.length).replace(/{{GENERATION_TIME}}/g, ts)
    .replace(/{{SOURCE_STATS}}/g, sst||'多源综合').replace(/{{YEAR}}/g, now.getFullYear())
    .replace('{{ALL_ITEMS}}', items.length ? allRI : '<div class="empty-state"><p>今日暂无量子科技相关新闻。</p></div>')
    .replace('{{POLICY_ITEMS}}', pol.length ? polRI : '<div class="empty-state"><p>今日暂无政策类新闻。</p></div>')
    .replace('{{INDUSTRY_ITEMS}}', ind.length ? indRI : '<div class="empty-state"><p>今日暂无产业类新闻。</p></div>')
    .replace('{{RESEARCH_ITEMS}}', res.length ? resRI : '<div class="empty-state"><p>今日暂无科研类新闻。</p></div>')
    .replace('{{COMPETITOR_TRACKER}}', trackerTable());

  return html;
}

// ========= 主流程 =========
async function main() {
  console.log('═══════════════════════════════');
  console.log('  量子日报 v4 · 严格核验版');
  console.log('  科大国盾量子技术股份有限公司');
  console.log('═══════════════════════════════\n');

  const items = await searchAll();
  if (!items.length) { console.log('⚠ 未搜集到新闻'); return; }

  const verified = await verifyWithAI(items);
  if (!verified.length) { console.log('⚠ 无通过核验的新闻'); return; }

  const html = buildHTML(verified);
  const outDir = path.resolve(__dirname, '..', 'output');
  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
  if (!existsSync(outDir+'/archive')) mkdirSync(outDir+'/archive', { recursive: true });

  writeFileSync(outDir+'/index.html', html, 'utf-8');
  const df = `${new Date().getFullYear()}-${String(new Date().getMonth()+1).padStart(2,'0')}-${String(new Date().getDate()).padStart(2,'0')}`;
  writeFileSync(`${outDir}/archive/量子日报-${df}.html`, html, 'utf-8');

  const pol = verified.filter(i=>i.category==='政策').length;
  const ind = verified.filter(i=>i.category==='产业').length;
  const ress = verified.filter(i=>i.category==='科研').length;
  const t0c = verified.filter(i=>i.involvesT0).length;

  console.log('\n═══════════════════════════════');
  console.log(`  ✅ 日报完成 · 全部已核验`);
  console.log(`  📊 共 ${verified.length} 条 | 政策:${pol} 产业:${ind} 科研:${ress} T0:${t0c}`);
  console.log(`  📁 ${outDir}/index.html`);
  console.log('═══════════════════════════════');
}

main().catch(e => { console.error('❌', e.message); process.exit(1); });
