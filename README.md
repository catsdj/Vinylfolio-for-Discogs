# VinylFolio

VinylFolio is a Next.js application for managing a vinyl collection locally using the Discogs API, a local SQLite database, and a UI optimized for browsing, filtering, syncing, and enrichment workflows.

This is WIP. Bugs and inconsistencies may be present :)

## High-level features

### Collection experience

- Table and card layouts for browsing your full Discogs collection
- Rich release presentation: artists, labels, styles, year, condition, pricing, and media links
- Discogs deep links from each release row/card
- Pagination controls with adjustable page size

### Search, filter, and sort

- Multi-field filtering for:
  - styles
  - artist
  - title
  - label
  - year range and exact year
  - date added range
- Column-based sorting in collection views (date, title, artist, styles, condition, price, etc.)
- Quick filter reset and stateful filtering UX

### Data sync and enrichment

- Local database sync workflows for:
  - release data refresh
  - collection updates from Discogs
  - metadata backfill jobs
- Price synchronization with stale-price refresh handling
- Video and tracklist enrichment pipelines
- Sync job progress/status feedback in the UI

### Analytics and insights

- Dedicated analytics page for collection trend exploration
- Year-based aggregation and monthly breakdowns
- Collection value summaries and metrics
- Loading/error handling for long-running analytics fetches

### Playlists and media workflows

- Playlist management integrated with collection releases
- Release-level playlist controls
- YouTube and Discogs video handling in release displays

### Invoice import pipeline

- Invoice import UI and API flow for deejay.de invoice ingestion
- Parsing and normalization utilities for invoice data
- Integration path into collection/database workflows

### Security and local-first design

- Local-request protection on API routes (designed for local/private usage)
- Environment-driven secrets (`.env.local`) with setup helper
- Security-oriented utility modules and hardened defaults

### Performance and reliability

- SQLite (`better-sqlite3`) for fast local reads/writes
- Database indexes and migration scripts for evolving schema/performance
- Caching and sync control utilities for heavy collection operations

## First-time installation (from source)

This repository is not yet a packaged desktop application. To run it, install the runtime and dependencies once on your computer.

### Prerequisites

- **Node.js 26 or later** (Current release from [nodejs.org](https://nodejs.org/), or use `nvm install 26`). Node.js installs **npm** automatically. Node.js 24 LTS also works.
- **Git**, only if you plan to clone the repository rather than download its source archive.

Open a terminal and confirm that Node.js and npm are available:

```bash
node --version
npm --version
```

Both commands must print a version. If either command is not recognized after installing Node.js, close and reopen the terminal so it can pick up the updated system path.

### Download the source and install dependencies

Choose a folder where you want to keep the app, then open a terminal in that folder. You can use your file manager's **Open in Terminal** action, or navigate there with:

```bash
cd "<folder where you keep projects>"
```

Clone the [VinylFolio repository](https://github.com/catsdj/Vinylfolio-for-Discogs.git) from that terminal into a `VinylFolio` folder. Then enter the new app folder:

```bash
git clone https://github.com/catsdj/Vinylfolio-for-Discogs.git VinylFolio
cd VinylFolio
```

Alternatively, download and extract the repository ZIP from GitHub, then open a terminal in the extracted folder.

Install the app dependencies:

```bash
npm install
```

This may take a few minutes on the first run. The app uses SQLite through `better-sqlite3`; if installation fails, first confirm that you are using a supported Node.js LTS version, then run `npm install` again.

## Run the app

```bash
npm run setup   # or configure .env.local manually — see Setup below
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

To stop the app, return to the terminal and press `Ctrl+C`. On later runs, open this project folder and run `npm run dev`.

## Setup

The app needs Discogs API credentials before it can sync your collection or call Discogs on your behalf. Credentials live in `.env.local` in the project root (gitignored).

You can configure them in either of two ways.

### Option 1: Interactive setup (recommended)

```bash
npm run setup
```

This runs `scripts/setup.cjs`, a small terminal wizard that:

1. Creates the `data/` directory and local SQLite file (`data/discogs_collection.db`)
2. Checks whether `.env.local` already exists (and asks before overwriting)
3. Prompts for your **Discogs API token**, **username**, and optional **app URL**
4. Writes `.env.local` with the values you entered

After it finishes, restart the dev server if it is already running:

```bash
npm run dev
```

Create a personal access token at [Discogs developer settings](https://www.discogs.com/settings/developers). Use the same Discogs username you sign in with.

### Option 2: Manual setup

Copy the template and edit it yourself:

```bash
cp env.example .env.local
npm run db:init
```

Then set these values in `.env.local`:


| Variable              | Required      | Purpose                                            |
| --------------------- | ------------- | -------------------------------------------------- |
| `DISCOGS_API_TOKEN`   | Yes, for sync | Personal access token from Discogs                 |
| `DISCOGS_USERNAME`    | Yes, for sync | Your Discogs username                              |
| `NEXT_PUBLIC_APP_URL` | No            | App base URL (defaults to `http://localhost:3000`) |
| `ADMIN_TOKEN`         | No            | Optional lock for `/api/performance` outside `npm run dev` |


See `[env.example](env.example)` for the full template and comments.

### What works without credentials?

The app **starts without** `.env.local`. You are not blocked at install time.


| With credentials                                        | Without credentials                                     |
| ------------------------------------------------------- | ------------------------------------------------------- |
| Browse your local SQLite collection                     | Browse your local SQLite collection (if already synced) |
| Import new releases and condition changes from Discogs  | Setup guidance shown in the UI                          |
| Refresh release details, prices, videos, and tracklists | Sync buttons disabled                                   |
| Invoice import against Discogs                          | Invoice import blocked until configured                 |


If credentials are missing, the UI shows a setup card with steps. API routes that talk to Discogs return a structured `SETUP_REQUIRED` response instead of crashing the server.

### Verify setup

1. Run `npm run dev`
2. Open the collection page — the setup banner should be gone
3. Use **Import Releases & Conditions** or **Refresh Details & Prices** — they should be enabled and reach Discogs

If something still fails, check the terminal for warnings about missing `DISCOGS_API_TOKEN` or `DISCOGS_USERNAME`.

### Local data

The collection lives in `data/discogs_collection.db` on your machine. Keep that `data/` folder if you copy or back up the app; deleting it drops the local collection.

Database schema migrations run automatically and are recorded in the `schema_migrations` table when the app first opens the database. They are safe to run on every startup and do not reset collection or sync state.

### Collection actions

**Refresh Details & Prices** processes locally stored releases that have a missing tracklist or video, or a missing or stale marketplace price (prices are rechecked after one week). It refreshes those release details from Discogs. It does **not** add new collection entries or update their media and sleeve conditions.

**Import Releases & Conditions** reads your Discogs collection and creates local records for releases that are not already stored. It also refreshes media and sleeve conditions for releases it finds. A full (**All**) import also removes a local release when it is no longer in your Discogs collection. Date-scoped imports do not remove local releases, because they only look at recently added items. This action does not refresh prices, videos, or tracklists.

## Scripts


| Command                  | Description                                          |
| ------------------------ | ---------------------------------------------------- |
| `npm run dev`            | Start development server                             |
| `npm run build`          | Build production artifacts                           |
| `npm run start`          | Run production server                                |
| `npm run lint`           | Run ESLint                                           |
| `npm run setup`          | Interactive `.env.local` setup and local DB creation |
| `npm run db:init`        | Create `data/` and the SQLite database file only     |
| `npm run security:audit` | Run production dependency audit                      |
| `npm run security:fix`   | Apply production dependency audit fixes              |
| `npm run security:check` | Check outdated packages and audit                    |


## Tech stack

- Next.js (App Router)
- React + TypeScript
- Tailwind CSS + UI components
- SQLite (`better-sqlite3`)
- Discogs REST API integration

## Release notes

See `[CHANGELOG.md](CHANGELOG.md)` for release history and unreleased changes.

## Discogs API compliance notes

- Intended usage is local/personal collection management.
- Requests identify the app with a dedicated `User-Agent` and handle `429` rate-limit responses.
- The UI displays Discogs attribution and non-affiliation notice.
- The app stores local sync/cache data only to provide the service; do not redistribute Discogs-derived datasets.

## Repository notes

- Keep all credentials in `.env.local`; never commit secrets.

## License

MIT — see `[LICENSE](LICENSE)`.
