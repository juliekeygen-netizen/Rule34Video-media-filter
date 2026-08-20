# Rule34Video Media Filter

A browser extension that makes the **My Subscriptions** page on Rule34Video a lot easier to browse.

It can scan your subscription feed into a local catalogue, then lets you filter and sort across all of those videos instead of being limited to whatever happens to be on the current Rule34Video page.

It supports **Chrome/Chromium** and **Firefox**. 
Additionally ui is  configured to work well on mobile too.

## What it adds

- **Local catalogue** for your subscribed videos
- Filtering across the whole scanned catalogue
- Quick, detailed, and advanced filters
- Filter presets
- Sorting by different video fields
- Seen and Favorite filtering
- **Subscriptions only** filtering using your current subscribed artists/models
- Detailed metadata scanning for things like:
  - upload date
  - artists
  - uploader
  - tags
  - categories
  - description
- Recent Update, Smart Update, and full catalogue rescans
- Queue controls for scans and metadata jobs
- Animated thumbnail previews
- Mobile swipe gesture for thumbnail previews
- Adjustable Local grid layout
- Artist labels on thumbnails
- Improved video player controls with **back/forward 10 seconds**
- 10-second skip feedback in the player
- Optional automatic sign-in
- Backup import/export
- Optional GitHub Cloud Sync

The extension keeps Rule34Video's normal subscription page available as **Native** mode. The scanned catalogue is shown separately as **Local** mode.

## Local catalogue

The first time you use Local mode, the extension can scan the pages in your Rule34Video subscription feed and save the results locally in your browser.

After that, filtering, sorting, pagination, and most browsing happens against the local catalogue instead of repeatedly loading every subscription page again.

Some filters need extra information that is only available from the individual video pages. You can scan that detailed metadata separately from the Queue.

## Filters

There are normal filters for common stuff and an Advanced filter editor for more specific combinations.

Depending on what has been scanned, you can filter using things like:

- title
- duration
- views
- rating / rating votes
- upload date
- artist
- uploader
- categories
- tags
- quality
- favorites
- seen videos
- current subscriptions
- duplicate detection

Advanced filters can be combined with **AND / OR**, grouped, enabled/disabled individually, and used as Match or Exclude rules.

## Updates and Queue

You do not need to rebuild the entire catalogue every time something new appears.

The extension has a few update options:

- **Recent Update** — scans a configurable number of the newest subscription pages
- **Smart Update** — checks for newer/changed content while keeping the existing catalogue
- **Full rescan** — rebuilds the catalogue when you actually want to start over

Longer jobs appear in the Queue and can be paused, resumed, or cancelled where supported.

The request scheduler also backs off when Rule34Video starts rate-limiting requests.

## Video player controls

When **Improved video player controls** is enabled, the Rule34Video player gets two extra buttons:

- back 10 seconds
- forward 10 seconds

They sit next to the native play/volume controls and use the same kind of on-screen skip feedback as Rule34Video's own double-click seeking.

## Backups and Cloud Sync

You can export the extension data to a `.r34mfbackup` file and restore it later.

There is also optional **GitHub Cloud Sync** using a private GitHub repository.

Cloud Sync can move the catalogue, filters, presets, Seen/Favorites state, and other portable settings between devices.

A few display settings intentionally stay **device-local** so your phone and desktop can use different layouts:

- videos per page
- video column amount
- thumbnail aspect ratio
- artist labels on video thumbnails
- artist label text size

Automatic sign-in credentials are also device-local and are **not** included in backups or Cloud Sync.

## Installation

### Firefox

Download the signed Firefox `.xpi` from the latest GitHub Release.

Then in Firefox:

1. Open **Add-ons and themes**
2. Click the gear icon
3. Choose **Install Add-on From File...**
4. Select the downloaded `.xpi`
5. Confirm the installation

The signed `.xpi` installs normally and stays installed after restarting Firefox.

### Chrome / Chromium

Download the Chrome `.zip` from the latest GitHub Release.

Then:

1. Extract the ZIP somewhere you plan to keep it
2. Open `chrome://extensions`
3. Enable **Developer mode**
4. Click **Load unpacked**
5. Select the extracted extension folder

Do not delete or move that folder afterward or Chrome will lose the unpacked extension files.

## First setup

A basic setup looks like this:

1. Sign in to Rule34Video
2. Open `https://rule34video.com/my/subscriptions/`
3. Switch to **Local**
4. Run the initial catalogue scan
5. Optionally scan detailed metadata
6. Set up your filters, sorting, and display options

After the initial scan, Recent Update is usually enough for normal day-to-day updates.

## Building from source

Requires **Node.js 22+**.

Install dependencies:

```bash
npm install
```

Run checks/tests:

```bash
npm run check
npm test
```

Build both browser versions:

```bash
npm run build
```

Or build one browser:

```bash
npm run build:chrome
npm run build:firefox
```

The generated builds are written to:

```text
dist/chrome/
dist/firefox/
```

Firefox lint:

```bash
npm run lint:firefox
```

Package an unsigned Firefox build:

```bash
npm run package:firefox
```

## Notes

- This extension is made for the **My Subscriptions** workflow and expects you to already have access to the Rule34Video account/feed you are using.
- Catalogue and metadata data are stored locally unless you explicitly use backup export or GitHub Cloud Sync.
- Cloud Sync is optional.
- The project is still being actively worked on, so Rule34Video site changes can occasionally break things.

## License

No open-source license is currently included.
