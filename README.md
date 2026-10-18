# ronakbuilds.tech

Source for my personal site, [ronakbuilds.tech](https://ronakbuilds.tech). It's a small static site built from plain HTML and CSS, with one build script that turns my GitHub profile into a projects page.

## How it works

### The projects page builds itself

I don't keep a list of projects anywhere. On every build, `scripts/build.mjs` asks the GitHub API for all my public repos and decides which ones belong on the page:

- **Needs a real README.** A repo is listed only if its README has at least 600 characters of actual writing across three or more paragraphs. Badges, images, links and markdown symbols don't count, so empty or placeholder repos stay off the page.
- **Pinned first.** Repos pinned on my GitHub profile come first, in the same order as on the profile. Everything else follows, newest first.
- **Some repos are always hidden.** Repos named in `HIDDEN` (like this one) are skipped no matter what their README says.

Each project gets a card showing its description, topics, stars and links to GitHub and its live site, if it has one.

### A page for every project

Every listed repo also gets its own page at `ronakbuilds.tech/projects/<project>/` with the full README rendered on it. The README markdown is turned into HTML and sanitized. Relative image and link paths are rewritten to point back at the repo on GitHub, so screenshots and docs links still work.

These pages are plain static HTML, so search engines can read them. The build also writes the page metadata, structured data, a `sitemap.xml` and a `robots.txt`.

### Icons from one file

`src/favicon.svg` is the only icon source. The build renders it into the `favicon.ico`, the Apple touch icon and the PWA icons that browsers and phones look for.

### Always up to date

A GitHub Actions workflow builds the site and deploys it to GitHub Pages on every push to `main`. It also rebuilds once a day, so new repos, new pins and README edits show up on the site without me touching this repo.

## Layout

| Path | What it is |
| --- | --- |
| `src/index.html` | Home page |
| `src/projects.html` | Template for the projects page; the build fills in the cards |
| `src/assets/projects.css` | Styles for the projects and project pages |
| `src/favicon.svg` | Source for every icon |
| `scripts/build.mjs` | Fetches repos and writes the finished site to `dist/` |
| `.github/workflows/deploy.yml` | Builds and deploys to GitHub Pages |
