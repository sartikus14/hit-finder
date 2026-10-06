// GET /api/football?league=nfl|cfb  -> this week's games with spread, total and player picks.
const fbdata = require('../lib/fbdata');

module.exports = async function handler(req, res) {
  const lg = (req.query && req.query.league) === 'cfb' ? 'cfb' : 'nfl';
  try {
    const data = await fbdata.slate(lg);
    res.setHeader('Cache-Control', 's-maxage=600, stale-while-revalidate=1200');
    res.status(200).json(data);
  } catch (err) {
    res.status(502).json({ error: 'Could not load football data right now. Try again in a minute.', detail: String((err && err.message) || err) });
  }
};
