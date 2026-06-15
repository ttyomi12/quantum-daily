/**
 * 量子日报 — 通过 DeepSeek API 直接搜索+生成
 */
const { writeFileSync, mkdirSync, existsSync, readFileSync } = require('fs');
const https = require('https');

const API_KEY = 'sk-882076775e0843888c9ad3c1103c59ef';

function callDeepSeek(messages) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model: 'DeepSeek-V4-pro',
      max_tokens: 8192,
      messages,
      temperature: 0.3,
      stream: false,
    });
    const req = https.request({
      hostname: 'api.deepseek.com',
      path: '/anthropic/v1/messages',
      method: 'POST',
      timeout: 180000,
      headers: { 'Content-Type': 'application/json', 'x-api-key': API_KEY, 'anthropic-version': '2023-06-01' }
    }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try {
          const j = JSON.parse(d);
          if (j.error) { reject(new Error(j.error.message)); return; }
          resolve((j.content || []).map(c => c.text || '').join(''));
        } catch(e) { reject(new Error('parse: ' + d.substring(0, 200))); }
      });
      res.on('error', reject);
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.write(body); req.end();
  });
}

function E(s) { return s ? String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;') : ''; }

async function main() {
  console.log('══ 量子日报生成 · 科大国盾量子 ══\n');
  console.log('🤖 调用 AI 搜索+处理 (需3-5分钟)...\n');

  const today = `${new Date().getFullYear()}年${new Date().getMonth()+1}月${new Date().getDate()}日`;

  const sys = `你是科大国盾量子技术股份有限公司（QuantumCTek）的量子科技产业分析助手。现在是${today}，你需要生成一份今日量子科技产业日报。

## 你的任务
请基于你的训练数据中截至最近更新的量子科技领域知识，从以下维度生成今天的量子科技产业日报。

⚠️ 注意：请务必只包含**过去24-48小时内**发生的真实新闻。如果没有找到今天的确切新闻，请明确标注"今日暂无相关重大新闻"，不要编造信息。

## 信息搜集维度
请为以下每个方向，各找到 2-4 条最近的新闻（不要编造）：

### 1. 政策动态
- 全球各国量子相关政策、法规、标准制定
- 量子技术出口管制
- 国家量子计划、产业园、政府采购

### 2. 产业动态
重点关注以下 T0 级友商的最新动态：
- IonQ, Rigetti, IBM, Google, Microsoft, NVIDIA, IQM（国际）
- 本源量子, 国仪量子, 玻色量子, 九州量子, 中创为量子, 问天量子, 图灵量子（国内）
- 中国移动, 中国联通, 中国电信（运营商）
- 融资、IPO、商业合同、产品发布、战略合作

### 3. 科研进展
- 量子计算：量子优越性、超导/离子阱/光量子路线、量子纠错、逻辑量子比特
- 量子通信：QKD、量子网络、PQC后量子密码、量子卫星
- 量子测量：冷原子重力仪、光量子雷达、量子传感

## 输出格式
请输出严格 JSON 格式，不要其他任何内容：

{
  "items": [
    {
      "category": "政策",
      "confidence": "已核实",
      "title": "简洁中文标题（不超过20字）",
      "summary": "150字左右的中文客观摘要，包含5W1H要素。不要主观评价。",
      "sourceName": "来源媒体名称（如Reuters、新华网、Nature等）",
      "sourceUrl": "https://原文链接（如果是真实可访问链接最佳）",
      "involvesT0": true,
      "involvesCompetitor": "IonQ",
      "isBreakthrough": false
    }
  ]
}

## 关键要求
1. **只输出真实新闻**——如果没有今天的确切新闻，对应类别输出空数组 []
2. 每条新闻必须标注来源和链接
3. 摘要必须客观，150字左右
4. confidence 标注：来自政府/Nature/Science/PRL/官方新闻稿 = "已核实"，其他 = "待核实"
5. 如果确实找不到近24小时的新闻，请诚实说明，不要编造`;

  try {
    const result = await callDeepSeek([{ role: 'system', content: sys }, { role: 'user', content: `请为${today}生成量子科技产业日报。请基于你的知识库，搜集政策、产业、科研三大领域的近期真实新闻。如果没有今天的新闻，返回空数组，不要编造。` }]);

    console.log('AI 返回长度: ' + result.length + ' 字符\n');

    // 提取 JSON
    const jm = result.match(/\{[\s\S]*"items"[\s\S]*\}/);
    if (!jm) {
      console.error('❌ 无法解析 AI 输出');
      console.log('原始输出前500字:', result.substring(0, 500));
      return;
    }

    const parsed = JSON.parse(jm[0]);
    const items = parsed.items || [];
    console.log('✅ 解析出 ' + items.length + ' 条快讯\n');

    // 构建 HTML
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
        <span class="confidence ${co}">${i.confidence || '待核实'}</span>
      </div>
      <div class="news-title">${E(i.title)}</div>
      <div class="news-summary">${E(i.summary)}</div>
      <div class="news-meta">
        <span class="news-source">📰 ${E(i.sourceName || '综合来源')}</span>
        <a href="${E(i.sourceUrl || '#')}" target="_blank" class="news-link">查看原文</a>
      </div>
    </div>`;
    }

    function tracker() {
      const ci = items.filter(i => i.involvesCompetitor);
      if (!ci.length) return '<div class="no-data">今日无友商重大动态</div>';
      const T0 = ['IonQ','Rigetti','IBM','Google','Microsoft','NVIDIA','IQM','本源量子','国仪量子','玻色量子','九州量子','中创为量子','问天量子','图灵量子','中国移动','中国联通','中国电信','SK Telecom'];
      let h = '<table class="tracker-table"><thead><tr><th>企业</th><th>T0</th><th>动态</th><th>来源</th></tr></thead><tbody>';
      for (const it of ci) {
        const cs = (it.involvesCompetitor || '').split(',').map(s => s.trim()).filter(Boolean);
        for (const c of cs) {
          const t0b = T0.includes(c) ? '<span class="t0-badge">T0</span>' : '-';
          h += `<tr><td style="font-weight:600;color:var(--text);">${E(c)}</td><td>${t0b}</td><td>${E(it.title)}</td><td><a href="${E(it.sourceUrl||'#')}" target="_blank">来源 ↗</a></td></tr>`;
        }
      }
      return h + '</tbody></table>';
    }

    const ss = {}; items.forEach(i => { ss[i.sourceName] = (ss[i.sourceName]||0)+1; });
    const sst = Object.entries(ss).sort((a,b)=>b[1]-a[1]).slice(0,5).map(([n,c])=>n+'('+c+')').join('、');
    const compAll = new Set(items.filter(i=>i.involvesCompetitor).flatMap(i=>(i.involvesCompetitor||'').split(',').map(s=>s.trim()))).size;

    let html = tpl
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

    const outDir = __dirname + '/../output';
    if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
    if (!existsSync(outDir+'/archive')) mkdirSync(outDir+'/archive', { recursive: true });
    writeFileSync(outDir+'/index.html', html, 'utf-8');
    const df = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}`;
    writeFileSync(`${outDir}/archive/量子日报-${df}.html`, html, 'utf-8');

    console.log('\n═══════════════════════════');
    console.log('  ✅ 日报生成完成！');
    console.log(`  📊 总快讯: ${items.length}`);
    console.log(`  📋 政策: ${pol.length} | 🏭 产业: ${ind.length} | 🔬 科研: ${res.length}`);
    console.log(`  🎯 T0友商: ${t0.length} | 💎 突破: ${br.length}`);
    console.log(`  📁 file://D:/DESKTOP/cc/quantum-daily/output/index.html`);
    console.log('═══════════════════════════');

  } catch(err) {
    console.error('❌', err.message);
    process.exit(1);
  }
}

main();
