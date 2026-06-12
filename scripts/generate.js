/**
 * 量子科技产业日报 — 自动生成脚本
 *
 * 功能：
 * 1. 从 Google News RSS 搜集量子科技新闻
 * 2. 调用 DeepSeek API 核验、撰写摘要、分类
 * 3. 填入 HTML 模板输出最终日报
 *
 * 运行方式: node scripts/generate.js
 * 环境变量:
 *   DEEPSEEK_API_KEY  - DeepSeek API 密钥
 *   DEEPSEEK_BASE_URL - DeepSeek API 地址 (默认: https://api.deepseek.com/anthropic)
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');

// ========== 配置 ==========
const API_KEY = process.env.DEEPSEEK_API_KEY || '';
const API_BASE_URL = process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com/anthropic';
const API_MODEL = process.env.DEEPSEEK_MODEL || 'DeepSeek-V4-pro';

const PROJECT_DIR = path.resolve(__dirname, '..');
const OUTPUT_DIR = path.join(PROJECT_DIR, 'output');
const ARCHIVE_DIR = path.join(OUTPUT_DIR, 'archive');
const TEMPLATE_PATH = path.join(PROJECT_DIR, 'templates', 'report.html');

// 读取配置
const sources = JSON.parse(fs.readFileSync(path.join(PROJECT_DIR, 'config', 'sources.json'), 'utf-8'));
const competitors = JSON.parse(fs.readFileSync(path.join(PROJECT_DIR, 'config', 'competitors.json'), 'utf-8'));
const keywordsConfig = JSON.parse(fs.readFileSync(path.join(PROJECT_DIR, 'config', 'keywords.json'), 'utf-8'));

// ========== Google News RSS 搜索 ==========
const NEWS_QUERIES = [
  // 政策类
  { q: 'quantum+computing+government+policy+funding', cat: '政策', hl: 'en-US' },
  { q: 'quantum+export+control+regulation+restriction', cat: '政策', hl: 'en-US' },
  { q: 'QKD+quantum+network+standard+infrastructure', cat: '政策', hl: 'en-US' },
  { q: 'post-quantum+cryptography+NIST+migration', cat: '政策', hl: 'en-US' },
  // 产业类
  { q: 'IonQ+OR+Rigetti+OR+Quantinuum+OR+IQM+quantum+computing', cat: '产业', hl: 'en-US' },
  { q: 'quantum+computing+funding+investment+IPO+acquisition', cat: '产业', hl: 'en-US' },
  { q: 'quantum+computing+commercial+contract+customer+deployment', cat: '产业', hl: 'en-US' },
  { q: '本源量子+国仪量子+玻色量子+九州量子+图灵量子', cat: '产业', hl: 'zh-CN' },
  // 科研类
  { q: 'quantum+supremacy+breakthrough+logical+qubit+error+correction', cat: '科研', hl: 'en-US' },
  { q: 'quantum+key+distribution+satellite+network+trial', cat: '科研', hl: 'en-US' },
  { q: 'quantum+sensing+gravimeter+radar+magnetometer', cat: '科研', hl: 'en-US' },
  { q: 'quantum+supercomputing+hybrid+classical', cat: '科研', hl: 'en-US' },
  // 中文补充
  { q: '量子+政策+产业+规划+招标', cat: '政策', hl: 'zh-CN' },
  { q: '量子计算+量子通信+量子测量+突破+进展', cat: '科研', hl: 'zh-CN' },
];

/**
 * HTTP GET 请求
 */
function httpGet(url) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https') ? https : http;
    const req = client.get(url, { timeout: 15000, headers: { 'User-Agent': 'QuantumDailyBot/1.0' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return httpGet(res.headers.location).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) { resolve(''); return; }
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(data));
      res.on('error', () => resolve(''));
    });
    req.on('error', () => resolve(''));
    req.on('timeout', () => { req.destroy(); resolve(''); });
  });
}

/**
 * 解析 RSS XML 为新闻条目
 */
function parseRSS(xml, category) {
  const items = [];
  // 匹配 <item>...</item>
  const itemRegex = /<item>([\s\S]*?)<\/item>/gi;
  let match;
  while ((match = itemRegex.exec(xml)) !== null) {
    const itemXml = match[1];
    const title = extractTag(itemXml, 'title');
    const link = extractTag(itemXml, 'link');
    const pubDate = extractTag(itemXml, 'pubDate');
    const description = extractTag(itemXml, 'description');
    const source = extractTag(itemXml, 'source');

    if (title && link) {
      items.push({
        title: cleanHtml(title),
        link: link,
        pubDate: pubDate ? new Date(pubDate).toISOString() : '',
        description: cleanHtml(description || '').substring(0, 300),
        source: source || extractDomain(link),
        category: category,
      });
    }
  }
  return items;
}

function extractTag(xml, tag) {
  const regex = new RegExp(`<${tag}[^>]*>(.*?)</${tag}>`, 'is');
  const match = xml.match(regex);
  return match ? match[1].trim() : '';
}

function cleanHtml(str) {
  return str.replace(/<[^>]*>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").trim();
}

function extractDomain(url) {
  try { return new URL(url).hostname.replace('www.', ''); } catch { return ''; }
}

/**
 * 搜集所有新闻
 */
async function collectNews() {
  console.log('🔍 开始搜集量子科技新闻...');

  const allItems = [];
  const seenLinks = new Set();

  for (const query of NEWS_QUERIES) {
    const url = `https://news.google.com/rss/search?q=${query.q}&hl=${query.hl}&ceid=US:en&when:24h`;
    console.log(`  搜索: ${query.q} (${query.cat})`);

    const xml = await httpGet(url);
    if (!xml) { console.log(`    ⚠ 无响应`); continue; }

    const items = parseRSS(xml, query.cat);
    let added = 0;
    for (const item of items) {
      if (!seenLinks.has(item.link)) {
        seenLinks.add(item.link);
        allItems.push(item);
        added++;
      }
    }
    console.log(`    ✅ 获取 ${items.length} 条，新增 ${added} 条`);

    // 请求间隔，避免被限流
    await sleep(800);
  }

  console.log(`📊 共搜集 ${allItems.length} 条不重复新闻`);
  return allItems;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

/**
 * 调用 DeepSeek API (Anthropic 兼容接口)
 */
async function callDeepSeekAPI(messages, maxTokens = 8192) {
  const body = JSON.stringify({
    model: API_MODEL,
    max_tokens: maxTokens,
    messages: messages,
    temperature: 0.3,
  });

  const url = new URL(API_BASE_URL + '/v1/messages');

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: url.hostname,
      path: url.pathname,
      method: 'POST',
      timeout: 120000,
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': API_KEY,
        'anthropic-version': '2023-06-01',
      }
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (json.error) { reject(new Error(json.error.message || JSON.stringify(json.error))); return; }
          const content = json.content || [];
          const text = content.map(c => c.text || '').join('');
          resolve(text);
        } catch (e) {
          reject(new Error(`API parse error: ${data.substring(0, 200)}`));
        }
      });
      res.on('error', reject);
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('API timeout')); });
    req.write(body);
    req.end();
  });
}

/**
 * 用 AI 处理新闻：核验、去重、撰写摘要、分类
 */
async function processWithAI(allItems) {
  console.log('🤖 调用 AI 处理新闻...');

  const t0Names = competitors.t0_competitors.list.map(c => `${c.name}(${c.name_cn})`).join('、');
  const allCompNames = [
    ...competitors.t0_competitors.list,
    ...competitors.other_competitors.list
  ].map(c => c.name).join('、');

  // 分批处理，每批最多 25 条
  const BATCH_SIZE = 25;
  const batches = [];
  for (let i = 0; i < allItems.length; i += BATCH_SIZE) {
    batches.push(allItems.slice(i, i + BATCH_SIZE));
  }

  console.log(`  分 ${batches.length} 批处理，每批 ~${BATCH_SIZE} 条`);

  const allProcessed = [];

  for (let bi = 0; bi < batches.length; bi++) {
    console.log(`  处理第 ${bi + 1}/${batches.length} 批...`);
    const batch = batches[bi];

    const newsListText = batch.map((item, idx) =>
      `[${idx + 1}] 标题: ${item.title}\n   分类: ${item.category}\n   来源: ${item.source}\n   链接: ${item.link}\n   摘要: ${item.description}`
    ).join('\n\n');

    const systemPrompt = `你是科大国盾量子技术股份有限公司（QuantumCTek）的量子科技产业分析助手。
你的任务是对提供的新闻条目进行核验、筛选、撰写摘要和分类。

## 关注领域
- 量子通信：QKD技术、量子网络建设、PQC后量子密码、量子卫星、量子安全技术
- 量子计算：量子优越性、超导量子路线（IBM/Google/Rigetti/IQM）、光量子（Xanadu/玻色量子/图灵量子）、离子阱（IonQ/Quantinuum）、量子纠错、超量融合（NVIDIA）
- 量子测量：冷原子重力仪、光量子雷达、量子传感等

## T0级（重点关注）友商
${t0Names}

## 全部友商
${allCompNames}

## 核验规则
1. 优先保留来自权威来源（政府网站、Nature/Science/PRL、企业官方、The Quantum Insider等行业媒体）的新闻
2. 同一事件如有多条，合并为一条，保留最佳来源
3. 排除：纯粹转载、标题党、缺少实质内容的空泛报道、广告

## 输出要求
对每条入选新闻，以 JSON 格式输出：
\`\`\`json
{
  "items": [
    {
      "id": 数字编号,
      "category": "政策" | "产业" | "科研",
      "confidence": "已核实" | "待核实",
      "title": "简洁中文标题（20字以内）",
      "summary": "150字左右的中文客观摘要，包含5W1H要素。不要照搬原文，要提炼核心信息。",
      "sourceName": "来源媒体名称",
      "sourceUrl": "原文链接",
      "involvesT0": true/false,
      "involvesCompetitor": "涉及到的友商名称（如有，多个用逗号分隔）",
      "isBreakthrough": true/false
    }
  ]
}
\`\`\`

## 重要说明
- 每条新闻必须包含有效的 sourceUrl（原始链接）
- 摘要必须客观中立，不带主观评价
- 只输出 JSON，不要输出其他内容
- 不重要的新闻直接过滤掉，每批最多输出 15 条
- 标注为"已核实"的条件：来自A级权威来源（政府/Nature/Science/PRL/企业官方）`;

    const userPrompt = `请处理以下量子科技新闻（${batch.length} 条），筛选、验证、撰写中文摘要：\n\n${newsListText}`;

    try {
      const result = await callDeepSeekAPI([
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
      ]);

      // 提取 JSON
      const jsonMatch = result.match(/\{[\s\S]*"items"[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        if (parsed.items && Array.isArray(parsed.items)) {
          allProcessed.push(...parsed.items);
          console.log(`    ✅ 获得 ${parsed.items.length} 条处理后新闻`);
        }
      } else {
        console.log(`    ⚠ 无法解析 AI 输出，尝试提取...`);
      }
    } catch (err) {
      console.log(`    ❌ 处理失败: ${err.message}`);
    }

    // API间隔
    if (bi < batches.length - 1) await sleep(2000);
  }

  // 去重
  const seen = new Set();
  const deduped = allProcessed.filter(item => {
    const key = item.title;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  console.log(`📊 AI 处理后共 ${deduped.length} 条（已去重）`);
  return deduped;
}

/**
 * 构建 HTML 内容
 */
function buildHTML(processedItems) {
  console.log('📝 生成 HTML 日报...');

  const template = fs.readFileSync(TEMPLATE_PATH, 'utf-8');

  // 统计
  const now = new Date();
  const dateStr = `${now.getFullYear()}年${now.getMonth() + 1}月${now.getDate()}日`;
  const dateFileStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  const timeStr = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}:${String(now.getSeconds()).padStart(2, '0')}`;

  const policyItems = processedItems.filter(i => i.category === '政策');
  const industryItems = processedItems.filter(i => i.category === '产业');
  const researchItems = processedItems.filter(i => i.category === '科研');
  const t0Items = processedItems.filter(i => i.involvesT0);
  const breakthroughItems = processedItems.filter(i => i.isBreakthrough);

  // 构建单条快讯 HTML
  function buildNewsCard(item) {
    const catClass = item.category === '政策' ? 'tag-policy' : item.category === '产业' ? 'tag-industry' : 'tag-research';
    const confClass = item.confidence === '已核实' ? 'conf-high' : 'conf-medium';
    const competitorTag = item.involvesCompetitor
      ? `<span class="tag tag-competitor">${item.involvesCompetitor}</span>`
      : '';

    return `
    <div class="news-card">
      <div class="news-hdr">
        <span class="tag ${catClass}">${item.category}</span>
        ${competitorTag}
        <span class="confidence ${confClass}">${item.confidence}</span>
      </div>
      <div class="news-title">${escapeHtml(item.title)}</div>
      <div class="news-summary">${escapeHtml(item.summary)}</div>
      <div class="news-meta">
        <span class="news-source">📰 ${escapeHtml(item.sourceName)}</span>
        <a href="${escapeHtml(item.sourceUrl)}" target="_blank" class="news-link">查看原文</a>
      </div>
    </div>`;
  }

  // 构建友商追踪表
  function buildTrackerTable() {
    const compInvolved = processedItems.filter(i => i.involvesCompetitor);
    if (compInvolved.length === 0) {
      return '<div class="no-data">今日无 T0 友商重大动态，所有企业均在追踪中。</div>';
    }

    let html = '<table class="tracker-table"><thead><tr><th>企业</th><th>T0</th><th>动态</th><th>来源</th></tr></thead><tbody>';
    for (const item of compInvolved) {
      const companies = item.involvesCompetitor.split(',');
      for (const comp of companies) {
        const isT0 = competitors.t0_competitors.list.some(c => c.name === comp.trim());
        html += `<tr>
          <td style="font-weight:600;color:var(--text);">${escapeHtml(comp.trim())}</td>
          <td>${isT0 ? '<span class="t0-badge">T0</span>' : '-'}</td>
          <td>${escapeHtml(item.title)}</td>
          <td><a href="${escapeHtml(item.sourceUrl)}" target="_blank">来源 ↗</a></td>
        </tr>`;
      }
    }
    html += '</tbody></table>';
    return html;
  }

  // 信源统计
  const sourceStats = {};
  processedItems.forEach(i => { sourceStats[i.sourceName] = (sourceStats[i.sourceName] || 0) + 1; });
  const sourceStatsText = Object.entries(sourceStats)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([name, count]) => `${name}(${count})`)
    .join('、');

  // 填充模板
  const competitorCountAll = new Set(
    processedItems.filter(i => i.involvesCompetitor).flatMap(i => i.involvesCompetitor.split(',').map(s => s.trim()))
  ).size;

  let html = template
    .replace(/{{REPORT_DATE}}/g, dateStr)
    .replace(/{{TOTAL_COUNT}}/g, processedItems.length)
    .replace(/{{POLICY_COUNT}}/g, policyItems.length)
    .replace(/{{INDUSTRY_COUNT}}/g, industryItems.length)
    .replace(/{{RESEARCH_COUNT}}/g, researchItems.length)
    .replace(/{{T0_COUNT}}/g, t0Items.length)
    .replace(/{{BREAKTHROUGH_COUNT}}/g, breakthroughItems.length)
    .replace(/{{GENERATION_TIME}}/g, timeStr)
    .replace(/{{SOURCE_STATS}}/g, sourceStatsText || '多源综合')
    .replace(/{{COMPETITOR_COUNT_TEXT}}/g, competitorCountAll)
    .replace(/{{YEAR}}/g, now.getFullYear())
    .replace('{{POLICY_ITEMS}}', policyItems.length > 0 ? policyItems.map(buildNewsCard).join('\n') : '<div class="no-data">今日无政策类新闻</div>')
    .replace('{{INDUSTRY_ITEMS}}', industryItems.length > 0 ? industryItems.map(buildNewsCard).join('\n') : '<div class="no-data">今日无产业类新闻</div>')
    .replace('{{RESEARCH_ITEMS}}', researchItems.length > 0 ? researchItems.map(buildNewsCard).join('\n') : '<div class="no-data">今日无科研类新闻</div>')
    .replace('{{COMPETITOR_TRACKER}}', buildTrackerTable());

  return { html, dateFileStr };
}

function escapeHtml(str) {
  if (!str) return '';
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * 主流程
 */
async function main() {
  console.log('═══════════════════════════════════════════');
  console.log('  量子科技产业日报 · 自动生成系统');
  console.log('  科大国盾量子技术股份有限公司');
  console.log('═══════════════════════════════════════════\n');

  if (!API_KEY) {
    console.error('❌ 错误: 未设置 DEEPSEEK_API_KEY 环境变量');
    console.error('   请在 GitHub Secrets 或本地环境中设置该变量');
    process.exit(1);
  }

  try {
    // Step 1: 搜集新闻
    const allItems = await collectNews();

    if (allItems.length === 0) {
      console.log('⚠ 未搜集到任何新闻，请检查网络或搜索查询');
      process.exit(0);
    }

    // Step 2: AI 处理
    const processedItems = await processWithAI(allItems);

    // Step 3: 生成 HTML
    const { html, dateFileStr } = buildHTML(processedItems);

    // Step 4: 保存文件
    if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });
    if (!fs.existsSync(ARCHIVE_DIR)) fs.mkdirSync(ARCHIVE_DIR, { recursive: true });

    // 保存当日日报
    const dailyPath = path.join(OUTPUT_DIR, 'index.html');
    fs.writeFileSync(dailyPath, html, 'utf-8');
    console.log(`✅ 日报已保存: ${dailyPath}`);

    // 保存归档副本
    const archivePath = path.join(ARCHIVE_DIR, `量子日报-${dateFileStr}.html`);
    fs.writeFileSync(archivePath, html, 'utf-8');
    console.log(`📁 归档副本: ${archivePath}`);

    // 输出摘要
    const policyCount = processedItems.filter(i => i.category === '政策').length;
    const industryCount = processedItems.filter(i => i.category === '产业').length;
    const researchCount = processedItems.filter(i => i.category === '科研').length;
    const t0Count = processedItems.filter(i => i.involvesT0).length;
    const verifiedCount = processedItems.filter(i => i.confidence === '已核实').length;

    console.log('\n═══════════════════════════════════════════');
    console.log('  📊 日报生成完成');
    console.log(`  总快讯: ${processedItems.length} | 已核实: ${verifiedCount}`);
    console.log(`  政策: ${policyCount} | 产业: ${industryCount} | 科研: ${researchCount} | T0友商: ${t0Count}`);
    console.log('═══════════════════════════════════════════');

    // 输出处理后的数据给工作流（用于 commit message）
    const summaryJson = {
      date: dateFileStr,
      total: processedItems.length,
      verified: verifiedCount,
      policy: policyCount,
      industry: industryCount,
      research: researchCount,
      t0: t0Count,
      breakthrough: processedItems.filter(i => i.isBreakthrough).length,
    };
    fs.writeFileSync(path.join(OUTPUT_DIR, 'summary.json'), JSON.stringify(summaryJson, null, 2));

  } catch (err) {
    console.error(`❌ 生成失败: ${err.message}`);
    console.error(err.stack);
    process.exit(1);
  }
}

main();
