/**
 * Cloudflare Worker / Pages Function:
 * GET /api/quota?start=YYYY-MM-DD&end=YYYY-MM-DD&examType=first|retake
 *
 * 一次查詢監理服務網（mvdis.gov.tw）全臺各監理站在「全部可預約時間範圍（前 3 日至前 30 日）」
 * 內的每日普通重型機車剩餘名額。監理服務網單次 POST 查詢即會回傳該站自起始日起之完整場次列表，
 * 因此每站僅需請求 1 次，並於 Cloudflare Edge 快取 120 秒。
 */

const MVDIS_URL = 'https://www.mvdis.gov.tw/m3-emv-trn/exm/locations';

const STATION_CODES = [
  { id: 'shilin', dmvNoLv1: '20', dmvNo: '21' },
  { id: 'keelung', dmvNoLv1: '20', dmvNo: '25' },
  { id: 'kinmen', dmvNoLv1: '20', dmvNo: '26' },
  { id: 'lienchiang', dmvNoLv1: '20', dmvNo: '28' },
  { id: 'shulin', dmvNoLv1: '40', dmvNo: '40' },
  { id: 'banqiao', dmvNoLv1: '40', dmvNo: '41' },
  { id: 'luzhou', dmvNoLv1: '40', dmvNo: '46' },
  { id: 'yilan', dmvNoLv1: '40', dmvNo: '43' },
  { id: 'hualien', dmvNoLv1: '40', dmvNo: '44' },
  { id: 'yuli', dmvNoLv1: '40', dmvNo: '45' },
  { id: 'hsinchu-county', dmvNoLv1: '50', dmvNo: '50' },
  { id: 'hsinchu-city', dmvNoLv1: '50', dmvNo: '51' },
  { id: 'taoyuan', dmvNoLv1: '50', dmvNo: '52' },
  { id: 'zhongli', dmvNoLv1: '50', dmvNo: '53' },
  { id: 'miaoli', dmvNoLv1: '50', dmvNo: '54' },
  { id: 'taichung-city', dmvNoLv1: '60', dmvNo: '61' },
  { id: 'puli', dmvNoLv1: '60', dmvNo: '62' },
  { id: 'changhua', dmvNoLv1: '60', dmvNo: '64' },
  { id: 'nantou', dmvNoLv1: '60', dmvNo: '65' },
  { id: 'yunlin', dmvNoLv1: '70', dmvNo: '72' },
  { id: 'tainan', dmvNoLv1: '70', dmvNo: '74' },
  { id: 'madou', dmvNoLv1: '70', dmvNo: '75' },
  { id: 'chiayi-city', dmvNoLv1: '70', dmvNo: '76' },
  { id: 'kaohsiung-city', dmvNoLv1: '30', dmvNo: '30' },
  { id: 'lingya', dmvNoLv1: '30', dmvNo: '31' },
  { id: 'qishan', dmvNoLv1: '30', dmvNo: '33' },
  { id: 'fengshan', dmvNoLv1: '80', dmvNo: '80' },
  { id: 'taitung', dmvNoLv1: '80', dmvNo: '81' },
  { id: 'pingtung', dmvNoLv1: '80', dmvNo: '82' },
  { id: 'hengchun', dmvNoLv1: '80', dmvNo: '83' },
  { id: 'penghu', dmvNoLv1: '80', dmvNo: '84' }
];

function toRocDate(isoDate) {
  const [y, m, d] = isoDate.split('-').map(Number);
  return `${y - 1911}${String(m).padStart(2, '0')}${String(d).padStart(2, '0')}`;
}

function rocMatchToIso(rocYear, month, day) {
  const y = Number(rocYear) + 1911;
  return `${y}-${String(Number(month)).padStart(2, '0')}-${String(Number(day)).padStart(2, '0')}`;
}

function classifySessionDesc(desc) {
  if (/不開放|停考|暫停/.test(desc)) return 'closed';
  if (/供所有考生預約|無需參加講習者.*報到時間|重考考生無需參與考前講習/.test(desc)) return 'both';

  const onlyRetake =
    /初考(?:生|駕照者|機車駕照者)?(?:如未完成講習)?(?:請)?勿預約|初考生預約無效/.test(desc) ||
    /本場(?:次)?(?:為|專供|僅供|僅提供)\s*(?:筆、路試|筆試|路試)?\s*(?:重考|吊註銷)/.test(desc) ||
    /僅(?:供|提供)(?:筆、路試|筆試|路試)?(?:重考|補路考)/.test(desc) ||
    /限補路考者報名/.test(desc) ||
    /^\s*(?:上午場次|下午場次)[^()]*\(\s*重考/.test(desc);

  const onlyFirst =
    /重考生勿預約|非初考生預約無效/.test(desc) ||
    /本場次(?:為|專供|僅供|僅提供)\s*(?:機車)?(?:初考|初次報考|第一次報考)/.test(desc) ||
    /僅(?:供|提供)(?:初考|初次報考|第一次報考)/.test(desc) ||
    /初考領及持有汽車駕照初考機車|初考領講習\d|首次考照|限筆試\+路考者報名|考試前須完成講習/.test(desc);

  if (onlyRetake && !onlyFirst) return 'retake';
  if (onlyFirst && !onlyRetake) return 'first';
  return 'both';
}

function parseMvdisFullRangeHtml(html, startIso, endIso, examType) {
  // 解析監理服務網回傳的 #trnTable 完整場次列表（每列 <td> 依序為：民國日期、場次組別說明、可報名人數或額滿、功能）
  const tableMatch = html.match(/<table[^>]*id="trnTable"[\s\S]*?<\/table>/i);
  const scopeHtml = tableMatch ? tableMatch[0] : html;
  const rows = scopeHtml.match(/<tr[\s\S]*?<\/tr>/gi) || [];
  const byDate = new Map();

  for (const row of rows) {
    const tds = [...row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map((m) =>
      m[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
    );
    if (tds.length < 3) continue;

    const dateMatch = tds[0].match(/(\d{3})\s*[年\/\-]\s*(\d{1,2})\s*[月\/\-]\s*(\d{1,2})/);
    if (!dateMatch) continue;

    const iso = rocMatchToIso(dateMatch[1], dateMatch[2], dateMatch[3]);
    if ((startIso && iso < startIso) || (endIso && iso > endIso)) continue;

    const desc = tds[1];
    const kind = classifySessionDesc(desc);
    if (kind === 'closed') continue;
    if (examType === 'first' && kind === 'retake') continue;
    if (examType === 'retake' && kind === 'first') continue;

    const quotaText = tds[2];
    let remain = null;
    if (/已額滿|額滿/.test(quotaText)) {
      remain = 0;
    } else {
      const m = quotaText.match(/(\d+)/);
      if (m) remain = Number(m[1]);
    }
    if (remain === null) continue;

    if (!byDate.has(iso)) {
      const [y, m, d] = iso.split('-').map(Number);
      const weekday = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
      byDate.set(iso, { date: iso, weekday, am: null, pm: null, total: 0, combined: false });
    }
    const rec = byDate.get(iso);
    const isPm = /^下午場次/.test(desc) || (!/^上午場次/.test(desc) && /下午|13:|14:|15:/.test(desc));
    if (isPm) {
      rec.pm = (rec.pm || 0) + remain;
    } else {
      rec.am = (rec.am || 0) + remain;
    }
    rec.total = (rec.am || 0) + (rec.pm || 0);
  }

  const dates = Array.from(byDate.values()).sort((a, b) => a.date.localeCompare(b.date));
  return { dates };
}

async function queryStationRange(station, startIso, endIso, examType) {
  const body = new URLSearchParams({
    method: 'query',
    secDateStr: '',
    secId: '',
    divId: '',
    licenseTypeCode: '3', // 3 = 普通重型機車
    expectExamDateStr: toRocDate(startIso),
    dmvNoLv1: station.dmvNoLv1,
    dmvNo: station.dmvNo
  });

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 9000);
  try {
    const res = await fetch(MVDIS_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        'User-Agent': 'Mozilla/5.0 (compatible; TaiwanMvdisMap/2.1)',
        Referer: MVDIS_URL
      },
      body: body.toString(),
      signal: controller.signal
    });
    if (!res.ok) return { dates: [], error: 'HTTP_' + res.status };
    const html = await res.text();
    return parseMvdisFullRangeHtml(html, startIso, endIso, examType);
  } catch (err) {
    return { dates: [], error: 'FETCH_ERROR' };
  } finally {
    clearTimeout(timeout);
  }
}

export async function onRequestGet(context) {
  const url = new URL(context.request.url);
  const nowTw = new Date(Date.now() + 8 * 60 * 60 * 1000);
  const defaultStart = new Date(nowTw.getTime() + 3 * 86400000).toISOString().slice(0, 10);
  const defaultEnd = new Date(nowTw.getTime() + 30 * 86400000).toISOString().slice(0, 10);

  const startIso = url.searchParams.get('start') || defaultStart;
  const endIso = url.searchParams.get('end') || defaultEnd;
  const examType = url.searchParams.get('examType') === 'retake' ? 'retake' : 'first';

  if (!/^\d{4}-\d{2}-\d{2}$/.test(startIso) || !/^\d{4}-\d{2}-\d{2}$/.test(endIso)) {
    return new Response(JSON.stringify({ error: '日期格式須為 YYYY-MM-DD' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json; charset=utf-8' }
    });
  }

  const cache = caches.default;
  const cacheUrl = new URL(url.toString());
  cacheUrl.searchParams.set('_v', '2');
  const cacheKey = new Request(cacheUrl.toString(), { method: 'GET' });
  const cached = await cache.match(cacheKey);
  if (cached) return cached;

  const stations = {};
  const batchSize = 6;
  for (let i = 0; i < STATION_CODES.length; i += batchSize) {
    const batch = STATION_CODES.slice(i, i + batchSize);
    const settled = await Promise.all(
      batch.map(async (st) => [st.id, await queryStationRange(st, startIso, endIso, examType)])
    );
    for (const [id, result] of settled) {
      stations[id] = result;
    }
  }

  const updatedAt = nowTw.toISOString().slice(11, 19);
  const response = new Response(
    JSON.stringify({ start: startIso, end: endIso, examType, updatedAt, stations }),
    {
      status: 200,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'public, max-age=120'
      }
    }
  );

  if (typeof context.waitUntil === 'function') {
    context.waitUntil(cache.put(cacheKey, response.clone()));
  }
  return response;
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === '/api/quota') {
      if (request.method !== 'GET') {
        return new Response(JSON.stringify({ error: 'Method Not Allowed' }), {
          status: 405,
          headers: { 'Content-Type': 'application/json; charset=utf-8' }
        });
      }
      return onRequestGet({
        request,
        env,
        waitUntil: (promise) => ctx.waitUntil(promise)
      });
    }

    if (env && env.ASSETS) {
      return env.ASSETS.fetch(request);
    }

    return new Response('Not Found', { status: 404 });
  }
};
