<div align="center">

<img src="app/public/brand/favicon-256.png" alt="Syrinx" width="80" />

# Syrinx · Flowing Flute

**Keep your music close. Make room for a calmer practice.**

Personal music library · Sheet music reader · Flute practice with accompaniment

[中文](README.md) · [Try online](https://romanticjojo.com) · [Quick start](#quick-start) · [Release notes](https://github.com/Romanticjojo/Syrinx/blob/dev/docs/releases/v0.3.0.md)

![Local first](https://img.shields.io/badge/local-first-77B7AC?style=flat-square)
![React](https://img.shields.io/badge/React-19-202827?style=flat-square&logo=react&logoColor=77B7AC)
[![License](https://img.shields.io/badge/license-Apache--2.0-202827?style=flat-square)](LICENSE)

</div>

> **Start with `dev`.** This README describes the v0.3.0 updates on the `dev` branch. The default GitHub branch, `master`, receives documentation updates; use the `--branch dev` instructions below to get these features. **The application UI is currently in Chinese.**

<p align="center">
  <img src="docs/img/readme/library-desktop.png" alt="Actual Syrinx desktop library: dark bookshelf, original example scores, search and view controls" width="100%" />
  <br /><sub>Actual application screenshot · Desktop personal library · Original project studies shown</sub>
</p>

## A home for everyday practice

**Collect and organize.** Import MusicXML, XML or MXL, then add titles, composer / arranger details, tags and covers. Find your next piece with folders, favorites and search. Both card and list views support pagination.

**Open and read.** Browse, turn pages and zoom at desktop, tablet and phone widths. A flute-only score opens as sheet music without generating audio. Editing its information preserves the original imported score.

**Practice at your pace.** When the score contains piano, choose one existing piano part for locally synthesized accompaniment, including both staves of that part. Follow the score cursor, adjust BPM, start from a selected measure, then listen back and review pitch comparisons.

## Choose your edition

| | Full features · Run locally | Web demo |
|---|---|---|
| Purpose | Collect, read and practice with your own scores | Try the performance flow with featured pieces |
| Personal library | Import, edit information, covers, folders, favorites and backups | A tab marked “开发中” (In development) opens a brief notice |
| Music | Your imports; featured pieces depend on local assets | Four featured pieces: Luv Letter, Flower Dance, Lumière, Interstellar |
| Entry point | `dev` · `npm run dev` | [Try online](https://romanticjojo.com) · `npm run dev:web` |
| Version mapping | `dev` → `v0.3.0` | `web-deploy` → `v0.3.0-web` |

Both modes currently run in a browser. Native Windows, Android, macOS and iOS installers are planned. The online site runs its deployed build and may lag behind branch updates; pushing source code does not automatically deploy the site.

## Three steps to your next practice

### 1. Import a score

After starting locally, open “个人仓库” (Personal library), click “导入乐谱” (Import score) or drop a file, then confirm its title and parts. Start with either of the two original studies included in this repository:

| Example | Contents | Try it with |
|---|---|---|
| [Morning Light · 晨光练习](https://raw.githubusercontent.com/Romanticjojo/Syrinx/dev/docs/examples/morning-light.musicxml) | Flute + one piano part with two staves | “钢琴伴奏” (Piano accompaniment) for reading, listening and performing |
| [Breath Study · 长音与呼吸](https://raw.githubusercontent.com/Romanticjojo/Syrinx/dev/docs/examples/breath-study.musicxml) | Solo flute | “仅阅谱” (Read only) |

Save the linked file with a `.musicxml` extension and import it, or find it in `docs/examples/` after cloning. [About the examples](docs/examples/README.md)

### 2. Make the library yours

Use a score's menu to edit its title, author, tags and PNG / JPEG / WebP cover. Create folders, move multiple scores, or favorite pieces you practice often. Removing a folder returns its scores to “未分类” (Unfiled).

<table>
  <tr>
    <td width="76%"><img src="docs/img/readme/library-list.png" alt="Personal library in list view, with titles, composers and score details" width="100%" /></td>
    <td width="24%"><img src="docs/img/readme/library-mobile.png" alt="Personal library at a 390-pixel phone width, with a two-column bookshelf" width="100%" /></td>
  </tr>
  <tr>
    <td align="center"><sub>A list for finding the next piece</sub></td>
    <td align="center"><sub>A bookshelf for smaller screens</sub></td>
  </tr>
</table>

### 3. Open your music and practice

Melody-only scores are ready for page-by-page reading. For a score with an existing piano part, preview the accompaniment and choose “开始演奏” (Start performing). A four-beat count-in leads into accompaniment and a moving score cursor.

A first-use hint introduces measure selection and BPM; dismissing it or starting playback saves that choice. Click a measure to choose a starting point, or use the BPM control to slow down. The selection box disappears after that measure has played. Seeking or applying a new tempo during performance saves the current recording segment, then starts a new one after four count-in beats. These actions leave ready or paused sessions stopped.

<p align="center">
  <img src="docs/img/readme/practice-tempo.png" alt="Actual Morning Light practice screen with measure five selected and the tempo control set to 60 BPM" width="100%" />
  <br /><sub>Actual application screenshot · Adjusting practice tempo with the original Morning Light score</sub>
</p>

| To… | Use… |
|---|---|
| Start / pause / resume | The play control or Space |
| Start from a measure | Click that measure; seeking during playback triggers a new count-in |
| Change tempo | Open BPM, type a value or move the slider, then choose “应用速度” (Apply tempo) |
| Restore the score's suggested tempo | “还原推荐” (Restore recommended) in the tempo panel |
| Record and listen back | Enable recording; after finishing, select a segment and replay it with optional accompaniment |
| Adjust the score size | Zoom controls; the personal reader also provides previous / next page buttons |

Tempo spans **0.5–1.5×** the score's initial tempo, keeping written tempo changes in proportion. Speed changes use the browser's pitch-preservation support. Each recording segment retains its practice speed so replay and pitch analysis align with the corresponding score interval. Recording needs microphone permission; headphones help keep accompaniment out of the recording.

## Quick start

You need **Node.js 20.19+ or 22.12+** and npm. Run:

```bash
git clone --branch dev https://github.com/Romanticjojo/Syrinx.git
cd Syrinx/app
npm install
npm run dev
```

Open the local address printed in the terminal, usually `http://localhost:5173`. This command enables the personal library; `desktop` is the current name of this feature mode.

```bash
npm run dev:web        # Web demo mode
npm run build          # Web demo build → app/dist
npm run build:desktop  # Full-feature build → app/dist-desktop
npm run preview        # Preview the default app/dist build
```

The repository includes a four-measure public fallback sample and the two importable studies above. Private featured-song scores, audio, covers and videos are excluded from the source, so a fresh clone's featured catalog may differ from the online site.

## Your data stays on your device

The personal library needs no account. Import parsing, cover processing and synthesis of the original piano part happen locally. Scores, edited information, covers and folders live in the current browser's IndexedDB storage.

Different browsers, profiles and site addresses have separate libraries. Changing a domain or local port does not migrate your data, and clearing site data deletes the library. **Export backups** regularly from the library menu and import them to restore or move your collection. Save and restore every part of a multi-file backup.

A locally running app can read imported scores and play their original piano accompaniment offline while its local server remains available. Website offline caching and cloud sync are not provided. Editing means changing score information; accompaniment uses one existing piano part. Note editing and automatic arrangement are outside the current feature set.

## Architecture and performance data flow

Syrinx is a statically hosted browser application. These Archify diagrams show the core path for featured pieces; every engine in the diagrams runs in the browser.

### Core architecture

![Syrinx core architecture: views, scores, accompaniment, recording and pitch analysis](docs/img/syrinx-architecture-en.png)

[Interactive diagram source](docs/img/syrinx-architecture-en.html) · [Structured data](docs/img/syrinx-architecture-en.json)

### From a score to practice feedback

![Syrinx data flow: asset parsing, timeline, synchronized playback, recording segments and pitch feedback](docs/img/syrinx-dataflow-en.png)

[Interactive diagram source](docs/img/syrinx-dataflow-en.html) · [Structured data](docs/img/syrinx-dataflow-en.json)

The live accompaniment position drives the score cursor. Seeking or changing tempo during playback saves the current take and counts in a new segment. Each segment retains its start and speed so replay and charts align with score time. Post-take pitch analysis runs in a background Worker to keep the interface responsive. The personal library separately uses IndexedDB for local score storage.

## Contributing

Syrinx uses React, TypeScript, Vite, OpenSheetMusicDisplay, Web Audio and three.js. Reading and performance run in the browser; the personal library and featured Song Packs are separate score sources.

```bash
cd app                # Skip if already in app
npm test              # Unit and component tests
npm run lint          # Static checks
npm run build
npm run build:desktop
```

- [v0.3.0 release notes](https://github.com/Romanticjojo/Syrinx/blob/dev/docs/releases/v0.3.0.md) · [Personal library scope](https://github.com/Romanticjojo/Syrinx/blob/dev/docs/superpowers/specs/2026-09-13-personal-library-scope-update.md)
- [Tempo and recording segment design](https://github.com/Romanticjojo/Syrinx/blob/dev/docs/superpowers/specs/2026-09-13-tempo-feedback-design.md) · [Web deployment](https://github.com/Romanticjojo/Syrinx/blob/dev/docs/DEPLOY-WEB.md)
- [Report an issue or suggest an improvement](https://github.com/Romanticjojo/Syrinx/issues) · [Explore the development source](https://github.com/Romanticjojo/Syrinx/tree/dev/app/src)

Next directions: native installers, measure-loop practice, and further reading and performance validation on physical devices.

## Acknowledgements and license

Thanks to [OpenSheetMusicDisplay](https://github.com/opensheetmusicdisplay/opensheetmusicdisplay), [three.js](https://github.com/mrdoob/three.js) and the wider open-source community. Syrinx uses the [Apache License 2.0](LICENSE). Song media belongs to its respective rights holders.
