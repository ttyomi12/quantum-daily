/**
 * 量子日报 — 单文件生成脚本（本地运行版）
 */
const { writeFileSync, mkdirSync, existsSync, readFileSync } = require('fs');
const https = require('https');
const http = require('http');

const API_KEY = 'sk-882076775e0843888c9ad3c1103c59ef';
const API_BASE = 'https://api.deepseek.com/anthropic';

const T0 = ['IonQ','Rigetti','IBM','Google','Microsoft','NVIDIA','IQM','本源量子','国仪量子','玻色量子','九州量子','中创为量子','问天量子','图灵量子','中国移动','中国联通','中国电信','SK Telecom'];
const ALL_COMP = [...T0,'D-Wave','Arqit','Xanadu','Pasqal','Quantinuum','PsiQuantum','Infleqtion','LUXQuanta','Terra Quantum','QuSecure','BTQ','SpeQtral','Thales','Toshiba','Nokia','量璇科技','赋同量子','国盛量子','国腾量子','国基量子','国科量子','弧光量子','济南量子','循态量子','幺正量子','启科量子','昆峰量子','微伽量子','九章量子','国光量子','信通量子','光启量子','易科腾','北京量子院','深圳量子院','华为','Singtel','BT','Orange','Deutsche Telekom','NTT','启明星辰','三未信安'];

const QUERIES = [
  { q: 'quantum+computing+government+policy+funding', cat: '政策', hl: 'en-US' },
  { q: 'quantum+export+control+regulation+restriction', cat: '政策', hl: 'en-US' },
  { q: 'QKD+quantum+network+standard+infrastructure', cat: '政策', hl: 'en-US' },
  { q: 'post-quantum+cryptography+NIST+migration', cat: '政策', hl: 'en-US' },
  { q: 'IonQ+OR+Rigetti+OR+Quantinuum+OR+IQM+quantum+computing', cat: '产业', hl: 'en-US' },
  { q: 'quantum+computing+funding+investment+IPO+acquisition', cat: '产业', hl: 'en-US' },
  { q: 'quantum+computing+commercial+contract+customer+deployment', cat: '产业', hl: 'en-US' },
  { q: '本源量子+国仪量子+玻色量子+九州量子+图灵量子', cat: '产业', hl: 'zh-CN' },
  { q: 'quantum+supremacy+breakthrough+logical+qubit+error+correction', cat: '科研', hl: 'en-US' },
  { q: 'quantum+key+distribution+satellite+network+trial', cat: '科研', hl: 'en-US' },
  { q: 'quantum+sensing+gravimeter+radar+magnetometer', cat: '科研', hl: 'en-US' },
  { q: 'quantum+supercomputing+hybrid+classical', cat: '科研', hl: 'en-US' },
  { q: '量子+政策+产业+规划+招标', cat: '政策', hl: 'zh-CN' },
  { q: '量子计算+量子通信+量子测量+突破+进展', cat: '科研', hl: 'zh-CN' },
];

const S = s => new Promise(r => setTimeout(r, s));
const E = s => s ? String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;') : '';

function httpGet(url) {
  return new Promise(R => {
    const c = url.startsWith('https') ? https : http;
    const r = c.get(url, { timeout: 15000, headers: { 'User-Agent': 'QDB/1.0' } }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) return httpGet(res.headers.location).then(R);
      if (res.statusCode !== 200) { R(''); return; }
      let d = ''; res.on('data', c => d += c); res.on('end', () => R(d)); res.on('error', () => R(''));
    });
    r.on('error', () => R('')); r.on('timeout', () => { r.destroy(); R(''); });
  });
}

function extractTag(xml, tag) {
  const m = xml.match(new RegExp('<'+tag+'[^>]*>([\\s\\S]*?)</'+tag+'>', 'is'));
  if (!m) return '';
  return m[1].replace(/<[^>]*>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").trim();
}

function domain(url) { try { return new URL(url).hostname.replace('www.', ''); } catch { return ''; } }

async function callAI(messages) {
  const body = JSON.stringify({ model: 'DeepSeek-V4-pro', max_tokens: 8192, messages, temperature: 0.3 });
  const u = new URL(API_BASE + '/v1/messages');
  return new Promise((R, J) => {
    const r = https.request({
      hostname: u.hostname, path: u.pathname, method: 'POST', timeout: 180000,
      headers: { 'Content-Type': 'application/json', 'x-api-key': API_KEY, 'anthropic-version': '2023-06-01' }
    }, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => {
        try { const j = JSON.parse(d); if (j.error) { J(new Error(j.error.message)); return; } R((j.content||[]).map(c=>c.text||'').join('')); }
        catch(e) { J(new Error('parse error: '+d.substring(0,200))); }
      });
      res.on('error', J);
    });
    r.on('error', J); r.on('timeout', () => { r.destroy(); J(new Error('timeout')); });
    r.write(body); r.end();
  });
}

async function collectNews() {
  console.log('🔍 搜索量子科技新闻...\n');
  const items = [], seen = new Set();
  for (const q of QUERIES) {
    const url = `https://news.google.com/rss/search?q=${q.q}&hl=${q.hl}&ceid=US:en&when:24h`;
    console.log(`  [${q.cat}] ${q.q.substring(0,60)}...`);
    const xml = await httpGet(url);
    if (!xml) { console.log('    ⚠ 无响应\n'); continue; }
    const re = /<item>([\s\S]*?)<\/item>/gi; let m; let added = 0;
    while ((m = re.exec(xml)) !== null) {
      const t = extractTag(m[1], 'title'), l = extractTag(m[1], 'link');
      if (t && l && !seen.has(l)) {
        seen.add(l);
        items.push({ title: t, link: l, description: extractTag(m[1], 'description').substring(0,300),
          source: extractTag(m[1], 'source') || domain(l), category: q.cat });
        added++;
      }
    }
    console.log(`    ✅ +${added}条\n`);
    await S(800);
  }
  console.log('📊 共搜集 ' + items.length + ' 条不重复新闻\n');
  return items;
}

async function processWithAI(items) {
  console.log('🤖 AI 核验与撰写摘要...\n');
  const B = 25, batches = [];
  for (let i = 0; i < items.length; i += B) batches.push(items.slice(i, i + B));
  const all = [];

  for (let bi = 0; bi < batches.length; bi++) {
    const batch = batches[bi];
    console.log(`  批次 ${bi+1}/${batches.length} (${batch.length}条)...`);
    const txt = batch.map((it,i) => `[${i+1}] ${it.title}\n  分类:${it.category} 来源:${it.source}\n  ${it.description}\n  ${it.link}`).join('\n\n');
    const sys = '你是科大国盾量子（QuantumCTek）产业分析助手。对新闻筛选、核验、撰写中文摘要。\n\nT0友商:'+T0.join('、')+'\n全部友商:'+ALL_COMP.join('、')+'\n\n规则: 1.优先权威来源(政府/Nature/Science/PRL/企业官方) 2.同事件合并取最优来源 3.排除转载/标题党/广告\n\n输出JSON: {"items":[{"category":"政策|产业|科研","confidence":"已核实|待核实","title":"中文标题≤20字","summary":"≤150字中文客观摘要","sourceName":"来源名称","sourceUrl":"原文链接","involvesT0":true/false,"involvesCompetitor":"友商名逗号分隔","isBreakthrough":true/false}]}\n只输出JSON，不要其他文字。';

    try {
      const r = await callAI([{ role: 'system', content: sys }, { role: 'user', content: '处理('+batch.length+'条新闻):\n\n'+txt }]);
      const jm = r.match(/\{[\s\S]*"items"[\s\S]*\}/);
      if (jm) {
        const p = JSON.parse(jm[0]);
        if (p.items && Array.isArray(p.items)) { all.push(...p.items); console.log(`    ✅ 获得 ${p.items.length} 条\n`); }
      } else { console.log('    ⚠ 无法解析AI输出\n'); }
    } catch(e) { console.log(`    ❌ ${e.message}\n`); }
    if (bi < batches.length - 1) await S(2000);
  }

  const seen = new Set();
  const deduped = all.filter(i => { const k = i.title; if (seen.has(k)) return false; seen.add(k); return true; });
  console.log('📊 AI处理后共 ' + deduped.length + ' 条（已去重）\n');
  return deduped;
}

function buildHTML(items) {
  console.log('📝 生成HTML日报...');
  const tpl = readFileSync(__dirname + '/../templates/report.html', 'utf-8');
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
        <span class="confidence ${co}">${i.confidence}</span>
      </div>
      <div class="news-title">${E(i.title)}</div>
      <div class="news-summary">${E(i.summary)}</div>
      <div class="news-meta">
        <span class="news-source">📰 ${E(i.sourceName)}</span>
        <a href="${E(i.sourceUrl)}" target="_blank" class="news-link">查看原文</a>
      </div>
    </div>`;
  }

  function tracker() {
    const ci = items.filter(i => i.involvesCompetitor);
    if (!ci.length) return '<div class="no-data">今日无 T0 友商重大动态，所有企业均在追踪中。</div>';
    let h = '<table class="tracker-table"><thead><tr><th>企业</th><th>T0</th><th>动态</th><th>来源</th></tr></thead><tbody>';
    for (const it of ci) {
      for (const c of it.involvesCompetitor.split(',')) {
        const t0b = T0.includes(c.trim()) ? '<span class="t0-badge">T0</span>' : '-';
        h += `<tr><td style="font-weight:600;color:var(--text);">${E(c.trim())}</td><td>${t0b}</td><td>${E(it.title)}</td><td><a href="${E(it.sourceUrl)}" target="_blank">来源 ↗</a></td></tr>`;
      }
    }
    return h + '</tbody></table>';
  }

  const ss = {}; items.forEach(i => { ss[i.sourceName] = (ss[i.sourceName] || 0) + 1; });
  const sst = Object.entries(ss).sort((a,b) => b[1] - a[1]).slice(0,5).map(([n,c])=>`${n}(${c})`).join('、');
  const compAll = new Set(items.filter(i => i.involvesCompetitor).flatMap(i => i.involvesCompetitor.split(',').map(s => s.trim()))).size;

  return tpl
    .replace(/{{REPORT_DATE}}/g, ds).replace(/{{TOTAL_COUNT}}/g, items.length)
    .replace(/{{POLICY_COUNT}}/g, pol.length).replace(/{{INDUSTRY_COUNT}}/g, ind.length)
    .replace(/{{RESEARCH_COUNT}}/g, res.length).replace(/{{T0_COUNT}}/g, t0.length)
    .replace(/{{BREAKTHROUGH_COUNT}}/g, br.length).replace(/{{GENERATION_TIME}}/g, ts)
    .replace(/{{SOURCE_STATS}}/g, sst || '多源综合').replace(/{{COMPETITOR_COUNT_TEXT}}/g, compAll)
    .replace(/{{YEAR}}/g, now.getFullYear())
    .replace('{{POLICY_ITEMS}}', pol.length ? pol.map(card).join('') : '<div class="no-data">今日无政策类新闻</div>')
    .replace('{{INDUSTRY_ITEMS}}', ind.length ? ind.map(card).join('') : '<div class="no-data">今日无产业类新闻</div>')
    .replace('{{RESEARCH_ITEMS}}', res.length ? res.map(card).join('') : '<div class="no-data">今日无科研类新闻</div>')
    .replace('{{COMPETITOR_TRACKER}}', tracker());
}

async function main() {
  console.log('═══════════════════════════════');
  console.log('  量子科技产业日报 · 生成系统');
  console.log('  科大国盾量子技术股份有限公司');
  console.log('═══════════════════════════════\n');

  // 搜集
  const items = await collectNews();
  if (!items.length) { console.log('⚠ 未搜集到新闻'); return; }

  // AI处理
  const proc = await processWithAI(items);
  if (!proc.length) { console.log('⚠ AI处理结果为空'); return; }

  // 生成HTML
  const html = buildHTML(proc);
  const outDir = __dirname + '/../output';
  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
  if (!existsSync(outDir + '/archive')) mkdirSync(outDir + '/archive', { recursive: true });

  writeFileSync(outDir + '/index.html', html, 'utf-8');
  const df = `${new Date().getFullYear()}-${String(new Date().getMonth()+1).padStart(2,'0')}-${String(new Date().getDate()).padStart(2,'0')}`;
  writeFileSync(`${outDir}/archive/量子日报-${df}.html`, html, 'utf-8');

  const sum = {
    date: df,
    total: proc.length,
    verified: proc.filter(i => i.confidence === '已核实').length,
    policy: proc.filter(i => i.category === '政策').length,
    industry: proc.filter(i => i.category === '产业').length,
    research: proc.filter(i => i.category === '科研').length,
    t0: proc.filter(i => i.involvesT0).length,
    breakthrough: proc.filter(i => i.isBreakthrough).length,
  };
  writeFileSync(outDir + '/summary.json', JSON.stringify(sum, null, 2), 'utf-8');

  console.log('\n═══════════════════════════════');
  console.log('  ✅ 日报生成完成！');
  console.log(`  📊 总快讯: ${sum.total} | 已核实: ${sum.verified}`);
  console.log(`  📋 政策: ${sum.policy} | 🏭 产业: ${sum.industry} | 🔬 科研: ${sum.research}`);
  console.log(`  🎯 T0友商: ${sum.t0} | 💎 重大突破: ${sum.breakthrough}`);
  console.log(`  📁 output/index.html`);
  console.log('═══════════════════════════════');
}

main().catch(e => { console.error('❌', e.message); process.exit(1); });
