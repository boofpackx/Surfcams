// Deterministic, plausible sample data so the app remains fully usable when
// the Surfline API is unreachable (offline, proxy down, endpoint changes).
// Every generated payload is tagged `demo: true` and the UI says so plainly.

function hashCode(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Layered sines → smooth "weather-looking" noise in [0,1].
function smooth(rand) {
  const p = [rand() * 1000, rand() * 1000, rand() * 1000];
  const f = [1 / 40, 1 / 17, 1 / 7].map((x) => x * (0.75 + rand() * 0.5));
  return (h) =>
    0.5 +
    0.28 * Math.sin(h * f[0] + p[0]) +
    0.16 * Math.sin(h * f[1] + p[1]) +
    0.06 * Math.sin(h * f[2] + p[2]);
}

const RATING_KEYS = ['VERY_POOR', 'POOR', 'POOR_TO_FAIR', 'FAIR', 'FAIR_TO_GOOD', 'GOOD', 'VERY_GOOD', 'EPIC'];

export function demoForecast(spotId, days = 6) {
  const rand = mulberry32(hashCode(spotId || 'demo'));
  const utcOffset = -7;
  const now = Math.floor(Date.now() / 1000);
  const start = now - ((now + utcOffset * 3600) % 86400); // spot-local midnight today
  const hours = days * 24;

  const sizeBase = 1.5 + rand() * 5;       // spot character: 1.5–6.5 ft base
  const range = 0.6 + rand() * 1.4;
  const surfN = smooth(rand);
  const windN = smooth(rand);
  const dirN = smooth(rand);
  const tempBase = 55 + rand() * 25;
  const tidePhase = rand() * 12;
  const tideAmp = 1.5 + rand() * 2.5;
  const swellDir = 180 + rand() * 120;

  const wave = [], rating = [], wind = [], weather = [], tides = [], sunlight = [];

  for (let h = 0; h < hours; h++) {
    const ts = start + h * 3600;
    const localHour = h % 24;
    const s = Math.max(0.4, sizeBase * (0.6 + 0.8 * surfN(h)));
    const min = Math.max(0.3, s - range / 2);
    const max = s + range / 2;
    const plus = surfN(h) > 0.82;

    // wind: calm mornings, onshore afternoons — the classic pattern
    const diurnal = Math.max(0, Math.sin(((localHour - 8) / 24) * Math.PI * 2));
    const speed = Math.max(1, 18 * windN(h) * (0.35 + diurnal));
    const direction = (swellDir + 140 + 80 * (dirN(h) - 0.5) + (localHour > 11 ? 40 : -30)) % 360;
    const offshore = localHour < 10 && speed < 9;
    const directionType = offshore ? 'Offshore' : speed > 11 ? 'Onshore' : 'Cross-shore';

    // rating from size + wind quality
    let score = (s / sizeBase) * 3 + (offshore ? 2 : speed > 12 ? -1.5 : 0);
    score = Math.max(0, Math.min(7, score + (rand() - 0.5) * 0.3));
    const key = s < 0.9 ? 'FLAT' : RATING_KEYS[Math.round(score)] || 'FAIR';

    wave.push({
      timestamp: ts, utcOffset, probability: 100,
      surf: { min: +min.toFixed(1), max: +max.toFixed(1), plus, humanRelation: null, optimalScore: offshore ? 2 : 0 },
      swells: [
        { height: +(s * 0.55).toFixed(1), period: Math.round(9 + 8 * surfN(h + 50)), direction: swellDir, optimalScore: 2 },
        { height: +(s * 0.25).toFixed(1), period: Math.round(6 + 4 * surfN(h + 90)), direction: (swellDir + 60) % 360, optimalScore: 0 },
      ],
    });
    rating.push({ timestamp: ts, utcOffset, rating: { key, value: Math.round(score) } });
    wind.push({
      timestamp: ts, utcOffset,
      speed: +speed.toFixed(1), gust: +(speed * (1.2 + 0.3 * windN(h + 33))).toFixed(1),
      direction, directionType, optimalScore: offshore ? 2 : 0,
    });
    weather.push({
      timestamp: ts, utcOffset,
      temperature: Math.round(tempBase + 9 * Math.sin(((localHour - 9) / 24) * Math.PI * 2)),
      condition: surfN(h + 200) > 0.55 ? 'CLEAR' : 'MOSTLY_CLOUDY',
    });
    // semidiurnal tide, ~12.4h period + weaker constituent
    const th = tideAmp * Math.sin(((h + tidePhase) / 12.42) * Math.PI * 2)
      + 0.6 * tideAmp * Math.sin(((h + tidePhase) / 25.8) * Math.PI * 2) + tideAmp;
    tides.push({ timestamp: ts, utcOffset, type: 'NORMAL', height: +th.toFixed(2) });
  }

  // mark tide extremes
  for (let i = 1; i < tides.length - 1; i++) {
    if (tides[i].height > tides[i - 1].height && tides[i].height >= tides[i + 1].height) tides[i].type = 'HIGH';
    if (tides[i].height < tides[i - 1].height && tides[i].height <= tides[i + 1].height) tides[i].type = 'LOW';
  }

  for (let d = 0; d < days; d++) {
    const midnight = start + d * 86400;
    sunlight.push({
      midnight, utcOffset,
      dawn: midnight + 5.7 * 3600, sunrise: midnight + 6.2 * 3600,
      sunset: midnight + 19.6 * 3600, dusk: midnight + 20.1 * 3600,
    });
  }

  const units = { waveHeight: 'FT', windSpeed: 'KTS', temperature: 'F', tideHeight: 'FT' };
  return {
    demo: true, utcOffset, units,
    wave, rating, wind, weather, tides, sunlight,
  };
}

export function demoSpotDetails(spotId, name) {
  const rand = mulberry32(hashCode(spotId || 'demo'));
  return {
    demo: true,
    spot: {
      _id: spotId,
      name: name || 'Sample Point',
      lat: 33 + rand() * 4, lon: -119 - rand() * 3,
      subregion: { name: 'Demo Coast' },
      cameras: [],
      abilityLevels: ['INTERMEDIATE'],
      boardTypes: ['SHORTBOARD', 'LONGBOARD'],
    },
  };
}

export const DEMO_SEARCH = [
  { id: '590927576a2e4300134fbed8', name: 'Venice Breakwater', sub: 'Los Angeles, California' },
  { id: 'demo-mavs', name: 'Sample Reef', sub: 'Demo Coast' },
  { id: 'demo-log', name: 'Sample Point', sub: 'Demo Coast' },
  { id: 'demo-beachie', name: 'Sample Beach', sub: 'Demo Coast' },
];
