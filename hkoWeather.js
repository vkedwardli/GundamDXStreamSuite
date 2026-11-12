// Based on the supplied hko-weather-whatsapp.mjs skeleton.
// Fetch, cache today's forecast, and format; delivery is in morningWeather.js.
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const ROOT = 'https://data.weather.gov.hk/weatherAPI';
const URLS = {
  difference: `${ROOT}/hko_data/regional-weather/latest_past24_temperature_diff_uc.csv`,
  current: `${ROOT}/opendata/weather.php?dataType=rhrread&lang=tc`,
  forecast: `${ROOT}/opendata/weather.php?dataType=fnd&lang=tc`,
  localForecast: `${ROOT}/opendata/weather.php?dataType=flw&lang=tc`,
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

function getHumidity(report, now) {
  if (!recent(Date.parse(report?.humidity?.recordTime), now)) return null;
  const entry = (report?.humidity?.data ?? []).find(x => STATION.includes(x.place));
  const humidity = number(entry?.value);
  return humidity !== null && humidity >= 0 && humidity <= 100 ? humidity : null;
}

// NWS/WPC procedure: Fahrenheit internally, Celsius at the boundary.
// https://www.wpc.ncep.noaa.gov/html/heatindex_equation.shtml
// Heat index estimates shaded conditions; it does not include wind or sunlight.
export function nwsHeatIndexCelsius(temperature, humidity) {
  if (!Number.isFinite(temperature) || !Number.isFinite(humidity) || humidity < 0 || humidity > 100) return null;
  const t = temperature * 9 / 5 + 32;
  const r = humidity;
  const simple = 0.5 * (t + 61 + (t - 68) * 1.2 + r * 0.094);
  let index = (simple + t) / 2;
  if (index >= 80) {
    index = -42.379 + 2.04901523 * t + 10.14333127 * r
      - 0.22475541 * t * r - 0.00683783 * t * t - 0.05481717 * r * r
      + 0.00122874 * t * t * r + 0.00085282 * t * r * r
      - 0.00000199 * t * t * r * r;
    if (r < 13 && t >= 80 && t <= 112) {
      index -= (13 - r) / 4 * Math.sqrt((17 - Math.abs(t - 95)) / 17);
    } else if (r > 85 && t >= 80 && t <= 87) {
      index += (r - 85) / 10 * (87 - t) / 5;
    }
  }
  return (index - 32) * 5 / 9;
}

function getTodayForecast(report, dayString) {
  const days = report?.weatherForecast ?? [];
  return days.find(x => String(x.forecastDate) === dayString) ?? null;
}

async function resolveTodayForecast(report, today, now, directory, logger) {
  const current = getTodayForecast(report, today);
  const file = directory ? path.join(directory, `${today}.json`) : null;
  if (current) {
    if (file) {
      const temporary = `${file}.${randomUUID()}.tmp`;
      try {
        await mkdir(directory, { recursive: true });
        await writeFile(temporary, JSON.stringify({ savedAt: now.toISOString(), forecast: current }) + '\n', { mode: 0o600 });
        await rename(temporary, file);
      } catch (error) {
        logger.error('HKO today forecast cache could not be saved:', error.message);
      } finally {
        await unlink(temporary).catch(() => {});
      }
    }
    return { forecast: current, earlier: false };
  }
  // The nine-day feed rolls over to tomorrow around midday. Only reuse a
  // snapshot explicitly dated today; never substitute its first (tomorrow) row.
  if (file) {
    try {
      const saved = JSON.parse(await readFile(file, 'utf8'));
      if (String(saved.forecast?.forecastDate) === today &&
          recent(Date.parse(saved.savedAt), now, 24 * 60)) {
        return { forecast: saved.forecast, earlier: true };
      }
    } catch (error) {
      if (error.code !== 'ENOENT') logger.error('HKO today forecast cache could not be read:', error.message);
    }
  }
  logger.error(`HKO today forecast unavailable for ${today}; no matching nine-day entry or saved forecast.`);
  return { forecast: null, earlier: false };
}

function getLocalForecast(report, now, today) {
  // Noon's bulletin can say "afternoon and tonight" instead of "today".
  // Exclude mixed tomorrow bulletins and require a same-day issue timestamp.
  const issuedAt = Date.parse(report?.updateTime);
  if (!recent(issuedAt, now, 12 * 60) ||
      !/今日|下午|今晚/.test(report?.forecastPeriod ?? '') ||
      /明日|明天/.test(report?.forecastPeriod ?? '') || typeof report?.forecastDesc !== 'string') return null;
  const { year, month, day } = hkParts(new Date(issuedAt));
  if (`${year}${month}${day}` !== today) return null;
  return report.forecastDesc.trim() || null;
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

export async function buildWeatherMessage({ now = new Date(), fetchImpl = fetch, logger = console, edition = 'morning', forecastCacheDirectory } = {}) {
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

  if (!data.difference && !data.current && !data.forecast && !data.localForecast) {
    throw new Error('All primary HKO weather sources are unavailable');
  }

  const delta = data.difference ? getDifference(data.difference, now) : null;
  const temp = getCurrent(data.current, now);
  const feelsLike = nwsHeatIndexCelsius(temp, getHumidity(data.current, now));
  const { forecast, earlier } = await resolveTodayForecast(data.forecast, today, now, forecastCacheDirectory, logger);
  const localDescription = getLocalForecast(data.localForecast, now, today);
  const low = number(forecast?.forecastMintemp?.value);
  const high = number(forecast?.forecastMaxtemp?.value);
  const visibility = getVisibility(data.visibility, now);
  if (delta === null && temp === null && !forecast && !localDescription) {
    throw new Error('No usable current HKO weather data');
  }
  const warnings = Object.values(data.warnings ?? {})
    .filter(w => w?.actionCode !== 'CANCEL' && (!w?.expireTime || Date.parse(w.expireTime) > now.getTime()))
    .map(w => w?.name).filter(Boolean);

  const lines = [
    weatherLine('🌤️', `香港${edition === 'noon' ? '中午' : '早晨'}天氣｜${Number(month)}月${Number(day)}日`, true),
    '',
    tempComparison(delta),
  ];
  if (temp !== null) lines.push(weatherLine('🌡️', `現時 ${temp}°C（天文台）`));
  if (feelsLike !== null) lines.push(weatherLine('🌡️', `體感溫度約 ${feelsLike.toFixed(1)}°C`));
  const earlierLabel = earlier ? '（早前預報）' : '';
  lines.push(weatherLine('📈', low !== null && high !== null
    ? `今日預測 ${low}–${high}°C${earlierLabel}` : '今日氣溫預測：暫未有資料'));
  const description = localDescription || forecast?.forecastWeather?.trim();
  lines.push(weatherLine('☁️', description
    ? `${description}${!localDescription ? earlierLabel : ''}` : '今日天氣預測：暫未有資料'));
  lines.push(weatherLine('🌧️', forecast?.PSR
    ? `顯著降雨概率：${forecast.PSR}${earlierLabel}` : '顯著降雨概率：暫未有資料'));
  if (warnings.length) lines.push(weatherLine('⚠️', `生效警告：${warnings.join('、')}`));
  if (visibility?.km >= VISIBILITY_THRESHOLD_KM) {
    lines.push(weatherLine('🔭', `${visibility.place}能見度達 ${visibility.km} km，今日視野特別清晰！`));
  }
  return lines.join('\n');
}
