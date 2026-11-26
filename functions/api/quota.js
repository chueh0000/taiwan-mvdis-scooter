/**
 * Cloudflare Pages Function:
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
  { id: 'lienchiang', dmvNoLv1: '20', dmvNo: '27' },
  { id: 'shulin', dmvNoLv1: '40', dmvNo: '40' },
  { id: 'banqiao', dmvNoLv1: '40', dmvNo: '41' },
  { id: 'luzhou', dmvNoLv1: '40', dmvNo: '46' },
  { id: 'yilan', dmvNoLv1: '40', dmvNo: '43' },
  { id: 'hualien', dmvNoLv1: '40', dmvNo: '44' },
  { id: 'yuli', dmvNoLv1: '40', dmvNo: '45' },
  { id: 'hsinchu-county', dmvNoLv1: '50', dmvNo: '50' },
  { id: 'taoyuan', dmvNoLv1: '50', dmvNo: '51' },
  { id: 'zhongli', dmvNoLv1: '50', dmvNo: '52' },
  { id: 'hsinchu-city', dmvNoLv1: '50', dmvNo: '53' },
  { id: 'miaoli', dmvNoLv1: '50', dmvNo: '54' },
  { id: 'taichung-city', dmvNoLv1: '60', dmvNo: '61' },
  { id: 'changhua', dmvNoLv1: '60', dmvNo: '63' },
  { id: 'nantou', dmvNoLv1: '60', dmvNo: '64' },
  { id: 'puli', dmvNoLv1: '60', dmvNo: '65' },
  { id: 'chiayi-city', dmvNoLv1: '70', dmvNo: '71' },
  { id: 'yunlin', dmvNoLv1: '70', dmvNo: '72' },
  { id: 'tainan', dmvNoLv1: '70', dmvNo: '74' },
  { id: 'madou', dmvNoLv1: '70', dmvNo: '75' },
  { id: 'kaohsiung-city', dmvNoLv1: '30', dmvNo: '30' },
  { id: 'lingya', dmvNoLv1: '30', dmvNo: '31' },
  { id: 'qishan', dmvNoLv1: '30', dmvNo: '33' },
  { id: 'fengshan', dmvNoLv1: '80', dmvNo: '80' },
  { id: 'pingtung', dmvNoLv1: '80', dmvNo: '82' },
  { id: 'hengchun', dmvNoLv1: '80', dmvNo: '83' },
  { id: 'taitung', dmvNoLv1: '80', dmvNo: '81' },
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

function parseMvdisFullRangeHtml(html, startIso, endIso, examType) {
  // 解析監理服務網回傳的完整日期列表（每列包含民國日期、場次描述、剩餘名額或額滿）
  const rows = html.match(/<tr[\s\S]*?<\/tr>/gi) || [];
  const byDate = new Map();

  for (const row of rows) {
    const text = row.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    const dateMatch = text.match(/(\d{3})\s*[年\/\-]\s*(\d{1,2})\s*[月\/\-]\s*(\d{1,2})/);
    if (!dateMatch) continue;

    const iso = rocMatchToIso(dateMatch[1], dateMatch[2], dateMatch[3]);
    if ((startIso && iso < startIso) || (endIso && iso > endIso)) continue;

    const isRetakeRow = /重考|免講習|輕機/.test(text);
    const isFirstRow = /初考|講習/.test(text) && !isRetakeRow;
    if (examType === 'first' && isRetakeRow) continue;
    if (examType === 'retake' && isFirstRow) continue;

    let remain = null;
    if (/已額滿|額滿/.test(text)) {
      remain = 0;
    } else {
      const m = text.match(/(?:剩餘|餘額|尚餘)\s*(\d+)/) || text.match(/(\d+)\s*名/);
      if (m) remain = Number(m[1]);
    }
    if (remain === null) continue;

    if (!byDate.has(iso)) {
      const [y, m, d] = iso.split('-').map(Number);
      const weekday = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
      byDate.set(iso, { date: iso, weekday, am: null, pm: null, total: 0, combined: false });
    }
    const rec = byDate.get(iso);
    if (/下午|13:|14:|15:/.test(text)) {
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
        'User-Agent': 'Mozilla/5.0 (compatible; TaiwanMvdisMap/2.0)',
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
  const cacheKey = new Request(url.toString(), { method: 'GET' });
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
