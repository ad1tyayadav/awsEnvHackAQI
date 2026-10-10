// CPCB PM2.5 -> AQI conversion with linear interpolation (PRD section 6).
// Pure function: no AWS calls, fully unit-tested.
export interface AqiResult {
  aqi: number;
  category: string;
}

interface Band {
  pmMin: number;
  pmMax: number; // inclusive upper pm bound
  aqiMin: number;
  aqiMax: number;
  category: string;
}

// CPCB PM2.5 breakpoints + simplified Severe band (PRD section 6)
const BANDS: Band[] = [
  { pmMin: 0, pmMax: 30, aqiMin: 0, aqiMax: 50, category: 'Good' },
  { pmMin: 31, pmMax: 60, aqiMin: 51, aqiMax: 100, category: 'Satisfactory' },
  { pmMin: 61, pmMax: 90, aqiMin: 101, aqiMax: 200, category: 'Moderate' },
  { pmMin: 91, pmMax: 120, aqiMin: 201, aqiMax: 300, category: 'Poor' },
  { pmMin: 121, pmMax: 250, aqiMin: 301, aqiMax: 400, category: 'Very Poor' },
];

function interpolate(band: Band, pm25: number): number {
  const frac = (pm25 - band.pmMin) / (band.pmMax - band.pmMin);
  const aqi = band.aqiMin + frac * (band.aqiMax - band.aqiMin);
  return Math.round(aqi);
}

/** PM2.5 (µg/m³) -> CPCB AQI + category. Negative input throws; >=250 ramps 250=401 .. 500µg=500, hard cap 500. */
export function pm25ToAqi(pm25: number): AqiResult {
  if (typeof pm25 !== 'number' || Number.isNaN(pm25) || pm25 < 0) {
    throw new RangeError(`pm25 must be a non-negative number, got ${pm25}`);
  }
  for (const band of BANDS) {
    if (pm25 <= band.pmMax) {
      const aqi = interpolate(band, pm25);
      return { aqi, category: band.category };
    }
  }
  // Severe: linear from 401 at 250 µg/m³ to 500 at 500 µg/m³, then capped
  const aqi = Math.min(500, Math.round(401 + ((pm25 - 250) / 250) * 99));
  return { aqi, category: 'Severe' };
}
