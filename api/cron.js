// Daily job (Vercel cron, 10 AM and 6 PM Eastern): grade finished games, learn, lock upcoming picks.
// You can also open /api/cron?job=setup once after connecting storage to load the season so far.
const track = require('../lib/track');
const fbdata = require('../lib/fbdata');
const espn = require('../lib/espn');
const store = require('../lib/store');

module.exports = async function handler(req, res) {
  const secret = process.env.CRON_SECRET;
  if (secret && req.headers.authorization !== `Bearer ${secret}` && (req.query && req.query.key) !== secret) {
    return res.status(401).json({ error: 'Not allowed.' });
  }
  let job = (req.query && req.query.job) || '';
  if (!job) job = track.et(Date.now()).hour < 14 ? 'morning' : 'evening';
  try {
    const log = [];
    if (job === 'setup') {
      if (!store.enabled()) return res.status(200).json({ ok: false, log: ['Storage is not connected yet. Follow the README step "Turn on pick tracking".'] });
      for (const lg of ['nfl', 'cfb']) {
        const sb = await espn.currentSlate(lg);
        const { data } = await fbdata.loadGames(lg, sb, { refresh: true });
        log.push(`${lg}: ${Object.keys(data.games).length} finished games loaded` + (data.remaining ? `, ${data.remaining} still to load (open this page again)` : ''));
      }
    }
    const out = await track.run(job === 'setup' ? 'all' : job);
    res.setHeader('Cache-Control', 'no-store');
    res.status(200).json({ job, ok: out.ok, log: log.concat(out.log), learned: out.calib || null });
  } catch (err) {
    res.status(500).json({ job, error: String((err && err.message) || err) });
  }
};
