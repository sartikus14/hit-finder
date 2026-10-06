# Hit Finder

Two sports in one site:

- **Baseball:** ranks every MLB starting hitter by their chance of getting at least one hit against the opposing starter (MLB Stats API).
- **Football (NFL and college Top 25):** spread picks, over/under picks, straight-up winners, anytime-TD chances and projected yards (ESPN's public data). Every spread pick shows the exact line it was made against.
- **Record:** picks lock before games, get graded after, and the app corrects its own TD, yardage and hit chances as results come in.

## What's in here

- `index.html`: baseball (broadcast look, ballpark green)
- `football.html`: football (Saturday gameday look)
- `api/slate.js`: baseball model
- `api/football.js`: football picks for this week
- `api/record.js`: how past picks did
- `api/cron.js`: the daily job that locks, grades and learns
- `lib/`: football data, the football model, storage and tracking
- `vercel.json`: runs the daily job at 10 AM and 6 PM Eastern
- `package.json`: Node version and the storage package

## Updating the site from this zip

1. Unzip `hit-finder-football-update.zip`.
2. In your `hit-finder` repo on GitHub, click **Add file → Upload files**.
3. Drag in **everything** from the unzipped folder, including the `api` and `lib` folders.
4. Before committing, check the file list GitHub shows. Files from the folders must read `api/football.js`, `lib/espn.js` and so on. If any show up without the folder name, cancel and upload that folder again by dragging the folder itself.
5. Click **Commit changes**. Vercel redeploys in about a minute.

## Turn on pick tracking (about a minute, free)

1. Open your project on https://vercel.com and click the **Storage** tab.
2. Click **Create Database**, choose **Blob**, name it `hit-finder`, and create it.
3. When it asks which project to connect, pick `hit-finder` with all environments checked, and connect.
4. Go to **Deployments**, click the **⋯** on the newest one, then **Redeploy**.
5. Once that finishes, open `https://YOUR-SITE.vercel.app/api/cron?job=setup` once. It loads the season so far and locks today's picks. It can take a minute or two. If the page says some games are still loading, open it once more.

After that it runs on its own every day at about 10 AM and 6 PM Eastern. You can see the schedule under **Settings → Cron Jobs** in Vercel.

## How picks are tracked

- Picks lock against the line at that moment: games before 6 PM Eastern at the 10 AM run, later games at the 6 PM run.
- After the game, the next run grades it: spread, total and winner, every TD and yardage projection, and every hitter's hit chance.
- After about 300 graded players (or hitters), the app scales its TD, yardage and hit chances to match what really happens. After 40 graded games it adjusts how much it trusts its own line versus Vegas. The Record screen shows what it has learned.

## Install it like an app

- **iPhone (Safari):** open the site, tap Share, then **Add to Home Screen**.
- **Android (Chrome):** open the site, tap the ⋮ menu, then **Install app**.

The app reopens on whichever sport you used last.

## Notes

- Football data comes from ESPN's public endpoints. They aren't officially supported, so if ESPN changes them the football side could need a fix.
- College target counts aren't in ESPN's box scores, so they're estimated from catches.
- MLB Stats API data is for personal, non-commercial use. Keep this site for you and your friends.
- For fun among friends, not betting advice.
