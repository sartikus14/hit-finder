// Kickoff weather for outdoor games from Open-Meteo (free, no key): wind, gusts, rain chance, temperature.
const store = require('./store');
const espn = require('./espn');

// Open-Meteo rate limits bursts, so retry once after a short pause
async function getJ(url) {
  for (let i = 0; i < 2; i++) {
    try { const r = await fetch(url); if (r.ok) return await r.json(); } catch (e) { /* retry */ }
    await new Promise((res) => setTimeout(res, 600));
  }
  return null;
}

const STATES = { AL: 'Alabama', AK: 'Alaska', AZ: 'Arizona', AR: 'Arkansas', CA: 'California', CO: 'Colorado', CT: 'Connecticut', DE: 'Delaware', DC: 'District of Columbia', FL: 'Florida', GA: 'Georgia', HI: 'Hawaii', ID: 'Idaho', IL: 'Illinois', IN: 'Indiana', IA: 'Iowa', KS: 'Kansas', KY: 'Kentucky', LA: 'Louisiana', ME: 'Maine', MD: 'Maryland', MA: 'Massachusetts', MI: 'Michigan', MN: 'Minnesota', MS: 'Mississippi', MO: 'Missouri', MT: 'Montana', NE: 'Nebraska', NV: 'Nevada', NH: 'New Hampshire', NJ: 'New Jersey', NM: 'New Mexico', NY: 'New York', NC: 'North Carolina', ND: 'North Dakota', OH: 'Ohio', OK: 'Oklahoma', OR: 'Oregon', PA: 'Pennsylvania', RI: 'Rhode Island', SC: 'South Carolina', SD: 'South Dakota', TN: 'Tennessee', TX: 'Texas', UT: 'Utah', VT: 'Vermont', VA: 'Virginia', WA: 'Washington', WV: 'West Virginia', WI: 'Wisconsin', WY: 'Wyoming' };

let geo = null, geoDirty = false;
async function geocode(city, state, country) {
  const k = [city, state, country].join('|');
  if (!geo) geo = (store.enabled() && (await store.readJSON('geo.json'))) || {};
  if (geo[k]) return geo[k];
  const cc = !country || /usa|united states/i.test(country) ? 'US' : '';
  const j = await getJ(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(city)}&count=10${cc ? '&country_code=US' : ''}`);
  if (!j) return null;
  const want = STATES[state] || state;
  const hit = (j.results || []).find((x) => !want || x.admin1 === want) || (j.results || [])[0];
  if (!hit) return null;
  geo[k] = [hit.latitude, hit.longitude];
  geoDirty = true;
  return geo[k];
}

// events: ESPN scoreboard events. Returns { eventId: {wind, gust, rain, temp} } for outdoor games in the next 7 days.
async function forKickoffs(events) {
  const out = {};
  const soon = (events || []).filter((e) => {
    const c = e.competitions[0];
    const t = Date.parse(e.date);
    return c.venue && !c.venue.indoor && t > Date.now() - 3 * 3600e3 && t < Date.now() + 7 * 86400e3 && c.venue.address && c.venue.address.city;
  });
  // look up stadium locations one at a time (cached after the first run), then forecasts a few at a time
  const where = {};
  for (const e of soon) {
    const a = e.competitions[0].venue.address;
    try { where[e.id] = await geocode(a.city, a.state, a.country); } catch (err) { where[e.id] = null; }
  }
  await espn.pool(soon, 4, async (e) => {
    try {
      const ll = where[e.id];
      if (!ll) return;
      const j = await getJ(`https://api.open-meteo.com/v1/forecast?latitude=${ll[0]}&longitude=${ll[1]}&hourly=temperature_2m,precipitation_probability,wind_speed_10m,wind_gusts_10m&wind_speed_unit=mph&temperature_unit=fahrenheit&timezone=GMT&forecast_days=8`);
      if (!j) return;
      const H = j.hourly || {};
      const kick = new Date(e.date); kick.setUTCMinutes(0, 0, 0);
      const target = kick.toISOString().slice(0, 13);
      const i = (H.time || []).findIndex((t) => t.slice(0, 13) === target);
      if (i < 0) return;
      // average over the ~3 hours of the game
      const span = [i, i + 1, i + 2].filter((x) => x < H.time.length);
      const avg = (arr) => Math.round(span.reduce((s, x) => s + (arr[x] || 0), 0) / span.length);
      out[String(e.id)] = { wind: avg(H.wind_speed_10m), gust: avg(H.wind_gusts_10m), rain: Math.max(...span.map((x) => H.precipitation_probability[x] || 0)), temp: avg(H.temperature_2m) };
    } catch (err) { /* weather is optional */ }
  });
  if (geoDirty && store.enabled()) { geoDirty = false; await store.writeJSON('geo.json', geo); }
  return out;
}

module.exports = { forKickoffs };
