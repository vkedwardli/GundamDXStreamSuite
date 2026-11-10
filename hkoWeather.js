// Based on the supplied hko-weather-whatsapp.mjs skeleton.
// Fetch and format only; delivery is handled by morningWeather.js.

const ROOT = 'https://data.weather.gov.hk/weatherAPI';
const URLS = {
  difference: `${ROOT}/hko_data/regional-weather/latest_past24_temperature_diff_uc.csv`,
  current: `${ROOT}/opendata/weather.php?dataType=rhrread&lang=tc`,
  forecast: `${ROOT}/opendata/weather.php?dataType=fnd&lang=tc`,
  visibility: `${ROOT}/opendata/opendata.php?dataType=LTMV&lang=tc&rformat=json`,
  warnings: `${ROOT}/opendata/weather.php?dataType=warnsum&lang=tc`,
};
const VISIBILITY_THRESHOLD_KM = 30;
const STATION = ['香港天文台', '天文台'];

async function get(url, format, fetchImpl) {
  const res = await fetchImpl(url, { signal: AbortSignal.timeout(12000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${url}`);
  return format === 'csv' ? res.text() : res.json();
}

// Returns null for N/A, empty strings, null and other non-numeric values.
function number(value) {
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  const s = String(value).trim();
  return /^[-+]?\d+(?:\.\d+)?$/.test(s) ? Number(s) : null;
}

export function hkParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Hong_Kong', hour: '2-digit', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(date);
  return Object.fromEntries(parts.map(({ type, value }) => [type, value]));
}

function timestampFromHko(s) {
  const m = String(s ?? '').match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})/);
  if (!m) return null;
  return Date.parse(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:00+08:00`);
}

function recent(ts, now, maxMinutes = 120) {
  return ts !== null && Number.isFinite(ts) &&
    now.getTime() - ts >= -5 * 60_000 && now.getTime() - ts <= maxMinutes * 60_000;
}

function getDifference(csv, now) {
  // Official file: Date time, Automatic Weather Station, Past 24-hour Temp Difference.
  const rows = csv.replace(/^\uFEFF/, '').trim().split(/\r?\n/).slice(1);
  for (const row of rows) {
    const cells = row.split(',').map(x => x.trim().replace(/^"|"$/g, ''));
    const [timestamp, place, raw] = cells;
    if (!STATION.includes(place) || !recent(timestampFromHko(timestamp), now)) continue;
    return number(raw);
  }
  return null;
}

function getCurrent(report, now) {
  if (!recent(Date.parse(report?.temperature?.recordTime ?? report?.updateTime), now)) return null;
  const records = report?.temperature?.data ?? [];
  const entry = records.find(x => STATION.includes(x.place));
  return number(entry?.value);
}

function getTodayForecast(report, dayString) {
  const days = report?.weatherForecast ?? [];
  return days.find(x => String(x.forecastDate) === dayString) ?? null;
}

function parseKm(value) {
  const s = String(value ?? '').replace(/\s/g, '').toLowerCase();
  const m = s.match(/^(\d+(?:\.\d+)?)(km|公里|m|米)?$/);
  if (!m) return null;
  const v = Number(m[1]);
  return m[2] === 'm' || m[2] === '米' ? v / 1000 : v;
}

function getVisibility(data, now) {
  // Use Central; if unavailable, fall back to Sai Wan Ho. Do not use the
  // maximum reading from all HK stations (which could exaggerate clarity).
  const stations = ['中環', 'Central', '西灣河', 'Sai Wan Ho'];
  for (const place of stations) {
    const row = (data?.data ?? []).find(x => x[1] === place);
    if (!row || !recent(timestampFromHko(row[0]), now, 60)) continue;
    const km = parseKm(row[2]);
    if (km !== null) return { place, km };
  }
  return null;
}

function weatherLine(emoji, text, bold = false) {
  return `${emoji} ${bold ? `*${text}*` : text}`;
}

function tempComparison(delta) {
  if (delta === null) return weatherLine('🌡️', '暫時未有同尋日嘅氣溫比較', true);
  if (Math.abs(delta) < 0.5) return weatherLine('🌡️', '同尋日同一時間差唔多溫度', true);
  const emoji = delta < 0 ? '🥶' : '🥵';
  const word = delta < 0 ? '凍咗' : '熱咗';
  return weatherLine(emoji, `${word}${Math.abs(delta).toFixed(1)}°C（相比尋日同一時間）`, true);
}

export async function buildWeatherMessage({ now = new Date(), fetchImpl = fetch, logger = console } = {}) {
  const { year, month, day } = hkParts(now);
  const today = `${year}${month}${day}`;
  const jobs = Object.entries(URLS).map(async ([key, url]) => [
    key, await get(url, key === 'difference' ? 'csv' : 'json', fetchImpl),
  ]);
  const results = await Promise.allSettled(jobs);
  const data = {};
  for (const result of results) {
    if (result.status === 'fulfilled') {
      const [key, value] = result.value;
      data[key] = value;
    } else {
      logger.error(`HKO API unavailable: ${result.reason?.message}`);
    }
  }

  if (!data.difference && !data.current && !data.forecast) {
    throw new Error('All primary HKO weather sources are unavailable');
  }

  const delta = data.difference ? getDifference(data.difference, now) : null;
  const temp = getCurrent(data.current, now);
  const forecast = getTodayForecast(data.forecast, today);
  const low = number(forecast?.forecastMintemp?.value);
  const high = number(forecast?.forecastMaxtemp?.value);
  const visibility = getVisibility(data.visibility, now);
  if (delta === null && temp === null && !forecast) {
    throw new Error('No usable current HKO weather data');
  }
  const warnings = Object.values(data.warnings ?? {})
    .filter(w => w?.actionCode !== 'CANCEL' && (!w?.expireTime || Date.parse(w.expireTime) > now.getTime()))
    .map(w => w?.name).filter(Boolean);

  const lines = [
    weatherLine('🌤️', `香港早晨天氣｜${Number(month)}月${Number(day)}日`, true),
    '',
    tempComparison(delta),
  ];
  if (temp !== null) lines.push(weatherLine('🌡️', `現時 ${temp}°C（天文台）`));
  if (low !== null && high !== null) lines.push(weatherLine('📈', `今日預測 ${low}–${high}°C`));
  if (forecast?.forecastWeather) lines.push(weatherLine('☁️', forecast.forecastWeather.trim()));
  if (forecast?.PSR) lines.push(weatherLine('🌧️', `顯著降雨概率：${forecast.PSR}`));
  if (warnings.length) lines.push(weatherLine('⚠️', `生效警告：${warnings.join('、')}`));
  if (visibility?.km >= VISIBILITY_THRESHOLD_KM) {
    lines.push(weatherLine('🔭', `${visibility.place}能見度達 ${visibility.km} km，今日視野特別清晰！`));
  }
  return lines.join('\n');
}
