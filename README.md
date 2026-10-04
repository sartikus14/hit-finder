# Hit Finder

Ranks every MLB starting hitter by their chance of getting at least one hit against the opposing starter, using live data from the MLB Stats API.

## What's in here

- `index.html`: the website (broadcast design, ballpark green, varsity fonts)
- `api/slate.js`: the server piece. It pulls the schedule, lineups, probable pitchers and splits for any date and runs the ranking model.
- `package.json`: tells Vercel which Node version to use

## Put it online (about 10 minutes, no coding)

**1. Upload the code to GitHub**
1. Sign in at https://github.com and click the **+** in the top right, then **New repository**.
2. Name it `hit-finder`, leave it **Private**, and click **Create repository**.
3. On the next page, click the link that says **uploading an existing file**.
4. Unzip `hit-finder.zip` on your computer. Drag everything inside the `hit-finder` folder (`index.html`, `README.md`, `package.json` and the `api` folder) into the upload box.
5. Click **Commit changes**.

**2. Deploy it on Vercel**
1. Sign in at https://vercel.com (use Continue with GitHub).
2. Click **Add New…**, then **Project**.
3. Find `hit-finder` in the list and click **Import**. If it isn't listed, click **Adjust GitHub App Permissions** and give Vercel access to that repo.
4. Leave every setting as it is and click **Deploy**.
5. In about a minute you get a link like `hit-finder-yourname.vercel.app`. That's your site. Send it to your friends.

**Optional: a nicer link.** In the Vercel project, go to **Settings → Domains** to rename the free `.vercel.app` address or connect a domain you buy.

## Updating later

Edit or replace a file on GitHub and commit it. Vercel redeploys automatically within a minute.

## Notes

- Data is cached for 5 minutes, so the site stays fast and light on MLB's servers.
- Lineups usually post 2 to 4 hours before first pitch. Before that, the site uses each team's nine most-used hitters and labels them "projected".
- MLB Stats API data is for personal, non-commercial use. Keep this site for you and your friends.
