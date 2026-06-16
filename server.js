const http  = require('http');
const https = require('https');
const fs    = require('fs');
const path  = require('path');
const url   = require('url');

const API_TOKEN    = process.env.HUBSPOT_API_TOKEN;
const PORT         = 3000;
const REFRESH_MS   = 5 * 60 * 1000; // fetch HubSpot every 5 minutes

const REPS = [
  { name: 'Avi Chilla',         id: '92919672' },
  { name: 'Benny Terefenko',    id: '78010725' },
  { name: 'Cole Boyden',        id: '92871323' },
  { name: 'Katelynn Patterson', id: '89923125' },
  { name: 'Rahmel Evans',       id: '93581117' },
];
const OWNER_IDS = REPS.map(r => r.id);

const DISP_VOICEMAIL = new Set(['73a0d17f-1163-4015-bdd5-ec830791da20','489b3b02-6be6-4b10-9036-b19de699be17']);
const DISP_CALLBACK  = new Set(['1beb9d2e-d374-4eff-8a49-4ed3e3770a55']);
const DISP_MEETING   = new Set(['f240bbac-87c9-4f6e-bf70-924b57d47db7']);
const DISP_CONNECTED = new Set(['b2cf5968-551e-4856-9783-52b3da59a7d0','1f6705d7-46f7-42f4-9d98-d3e349ae05d8','17b47fee-58de-441e-a44c-c6300d46f273','60e91eb6-21a5-4452-8868-65e74c7b6b6d','cb424f58-e2c9-4e8d-85da-00aaf2c13a57','2fefeb5c-b8f7-4af5-bb40-421adbdcca38','67706851-f02c-4dbe-8716-02775eba101b']);

// ─── DATE HELPERS ─────────────────────────────────────────────────────────────
function getToday() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}
function getWeekStart() {
  const d = new Date();
  const day = d.getDay();
  const diff = d.getDate() - day + (day === 0 ? -6 : 1);
  const mon = new Date(d); mon.setDate(diff);
  return `${mon.getFullYear()}-${String(mon.getMonth()+1).padStart(2,'0')}-${String(mon.getDate()).padStart(2,'0')}`;
}
function getMonthStart() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-01`;
}
function toTimestamp(dateStr) {
  return new Date(dateStr + 'T00:00:00Z').getTime();
}

// ─── HUBSPOT REQUEST ──────────────────────────────────────────────────────────
function hsRequest(method, apiPath, body) {
  return new Promise((resolve, reject) => {
    const bodyStr = body ? JSON.stringify(body) : null;
    const options = {
      hostname: 'api.hubapi.com',
      path: apiPath,
      method,
      headers: {
        'Authorization': `Bearer ${API_TOKEN}`,
        'Content-Type': 'application/json',
        ...(bodyStr ? { 'Content-Length': Buffer.byteLength(bodyStr) } : {})
      }
    };
    const req = https.request(options, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

async function hsPost(apiPath, body, attempt = 0) {
  const res = await hsRequest('POST', apiPath, body);
  if (res.status === 429) {
    if (attempt >= 5) throw new Error('Rate limit exceeded after retries');
    const wait = 2000 * (attempt + 1);
    console.log(`Rate limited — waiting ${wait}ms before retry ${attempt + 1}...`);
    await new Promise(r => setTimeout(r, wait));
    return hsPost(apiPath, body, attempt + 1);
  }
  if (res.status >= 400) throw new Error(`HubSpot ${res.status}: ${res.body}`);
  return JSON.parse(res.body);
}

async function searchAll(objectType, filters, properties) {
  let all = [], after = undefined;
  while (true) {
    const body = { filterGroups: [{ filters }], properties, limit: 100 };
    if (after) body.after = after;
    await new Promise(r => setTimeout(r, 300)); // small delay between pages
    const data = await hsPost(`/crm/v3/objects/${objectType}/search`, body);
    all = all.concat(data.results || []);
    if (data.paging?.next?.after) after = data.paging.next.after;
    else break;
  }
  return all;
}

// ─── FETCH ALL METRICS ────────────────────────────────────────────────────────
async function fetchAllData() {
  const today      = getToday();
  const weekStart  = getWeekStart();
  const monthStart = getMonthStart();
  const startOfDay = toTimestamp(today);
  const endOfDay   = startOfDay + 86400000;
  const startOfWeekTs = toTimestamp(weekStart);
  const now        = Date.now() + 86400000;

  console.log(`[${new Date().toLocaleTimeString()}] Fetching HubSpot data...`);

  const sleep = ms => new Promise(r => setTimeout(r, ms));

  // 1. Today's dials
  const dialResults = await searchAll('calls', [
    { propertyName: 'hubspot_owner_id', operator: 'IN', values: OWNER_IDS },
    { propertyName: 'hs_timestamp', operator: 'GTE', value: String(startOfDay) },
    { propertyName: 'hs_timestamp', operator: 'LT',  value: String(endOfDay) },
  ], ['hubspot_owner_id', 'hs_call_disposition']);
  await sleep(2000);

  // 2. This week's calls (for weekly dials + conversion)
  const weeklyDialResults = await searchAll('calls', [
    { propertyName: 'hubspot_owner_id', operator: 'IN', values: OWNER_IDS },
    { propertyName: 'hs_timestamp', operator: 'GTE', value: String(startOfWeekTs) },
    { propertyName: 'hs_timestamp', operator: 'LT',  value: String(now) },
  ], ['hubspot_owner_id', 'hs_call_disposition', 'final_result']);
  await sleep(2000);

  // 3. Qual calls scheduled this week (deals)
  const qualDealResults = await searchAll('deals', [
    { propertyName: 'business_development_lead', operator: 'IN', values: OWNER_IDS },
    { propertyName: 'createdate', operator: 'GTE', value: weekStart },
  ], ['business_development_lead', 'createdate']);
  await sleep(2000);

  // 4. Qual calls scheduled this month (deals)
  const qualMonthResults = await searchAll('deals', [
    { propertyName: 'business_development_lead', operator: 'IN', values: OWNER_IDS },
    { propertyName: 'createdate', operator: 'GTE', value: monthStart },
  ], ['business_development_lead', 'createdate']);

  console.log(`[${new Date().toLocaleTimeString()}] Done. Dials:${dialResults.length} WeekCalls:${weeklyDialResults.length} QualWk:${qualDealResults.length} QualMo:${qualMonthResults.length}`);

  // ─── PROCESS ───────────────────────────────────────────────────────────────
  const idToIdx = {};
  REPS.forEach((r, i) => idToIdx[r.id] = i);
  const n = REPS.length;

  const dialCallBack  = new Array(n).fill(0);
  const dialConnected = new Array(n).fill(0);
  const dialVoicemail = new Array(n).fill(0);
  const dialMeeting   = new Array(n).fill(0);
  dialResults.forEach(r => {
    const idx = idToIdx[r.properties.hubspot_owner_id];
    if (idx === undefined) return;
    const d = r.properties.hs_call_disposition;
    if (DISP_VOICEMAIL.has(d))      dialVoicemail[idx]++;
    else if (DISP_CALLBACK.has(d))  dialCallBack[idx]++;
    else if (DISP_MEETING.has(d))   dialMeeting[idx]++;
    else if (DISP_CONNECTED.has(d)) dialConnected[idx]++;
    else                            dialVoicemail[idx]++;
  });

  const weeklyDials = new Array(n).fill(0);
  weeklyDialResults.forEach(r => {
    const idx = idToIdx[r.properties.hubspot_owner_id];
    if (idx !== undefined) weeklyDials[idx]++;
  });

  const convConv = new Array(n).fill(0);
  const convMtg  = new Array(n).fill(0);
  weeklyDialResults.forEach(r => {
    const idx = idToIdx[r.properties.hubspot_owner_id];
    if (idx === undefined) return;
    const fr = r.properties.final_result;
    if (fr === 'Meeting Scheduled') convMtg[idx]++;
    else if (fr === 'Conversation')  convConv[idx]++;
  });
  const convPctMtg = REPS.map((_,i) => {
    const tot = convConv[i] + convMtg[i]; if (!tot) return 0;
    return Math.round((convMtg[i]/tot)*100);
  });
  const convPctConv = REPS.map((_,i) => {
    const tot = convConv[i] + convMtg[i]; if (!tot) return 0;
    return Math.round((convConv[i]/tot)*100);
  });

  const qualCalls = new Array(n).fill(0);
  qualDealResults.forEach(r => {
    const idx = idToIdx[r.properties.business_development_lead];
    if (idx !== undefined) qualCalls[idx]++;
  });

  const qsByRep = {};
  qualMonthResults.forEach(r => {
    const id = r.properties.business_development_lead;
    if (!REPS.find(rep => rep.id === id)) return;
    qsByRep[id] = (qsByRep[id] || 0) + 1;
  });
  const qualScheduled = Object.entries(qsByRep)
    .map(([id, val]) => ({ name: REPS.find(r => r.id === id)?.name || id, val }))
    .sort((a,b) => b.val - a.val);
  const qualScheduledTotal = qualScheduled.reduce((s,r) => s + r.val, 0);

  return {
    dialCallBack, dialConnected, dialVoicemail, dialMeeting,
    weeklyDials, qualCalls,
    convPctConv, convPctMtg, convRawConv: convConv, convRawMtg: convMtg,
    qualScheduled, qualScheduledTotal,
    fetchedAt: new Date().toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'})
  };
}

// ─── CACHE ────────────────────────────────────────────────────────────────────
let cache = null;
let fetchInProgress = false;

async function refreshCache() {
  if (fetchInProgress) return;
  fetchInProgress = true;
  try {
    cache = await fetchAllData();
  } catch(e) {
    console.error('Error fetching HubSpot data:', e.message);
  } finally {
    fetchInProgress = false;
  }
  setTimeout(refreshCache, REFRESH_MS);
}

// ─── HTTP SERVER ──────────────────────────────────────────────────────────────
const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  const parsed = url.parse(req.url, true);

  // Serve cached data to dashboard
  if (parsed.pathname === '/data') {
    if (!cache) {
      res.writeHead(503, {'Content-Type': 'application/json'});
      res.end(JSON.stringify({error: 'Data not ready yet, please wait...'}));
    } else {
      res.writeHead(200, {'Content-Type': 'application/json'});
      res.end(JSON.stringify(cache));
    }
    return;
  }

  // Serve static files
  let filePath = parsed.pathname === '/' ? '/bda_dashboard.html' : parsed.pathname;
  filePath = path.join(__dirname, filePath);
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    const ext  = path.extname(filePath);
    const mime = ext === '.html' ? 'text/html' : ext === '.js' ? 'application/javascript' : 'text/plain';
    res.writeHead(200, {'Content-Type': mime});
    res.end(data);
  });
});

server.listen(PORT, () => {
  console.log(`BDA Dashboard running at http://localhost:${PORT}`);
  console.log('Fetching initial HubSpot data — this takes about 10 seconds...');
  console.log('Keep this window open - closing it stops the dashboard.');
  refreshCache(); // kick off first fetch immediately
});
