<div align="center">
  <img src="icon.png" alt="Subtitle Downloader Logo" width="96" height="96" />
  <h1>Subtitle Downloader</h1>
  <p><strong>One-click browser extension to extract, format, and batch-download closed captions, subtitles, and clean readable transcripts from web videos, playlists, and episodic series.</strong></p>
  <h3>
    <a href="https://github.com/sandeepisconscious-create/Subtitle-Downloader/raw/main/Subtitle_Downloader.zip">⬇️ Click Here to Download Subtitle Downloader (.zip)</a>
  </h3>
  <p>
    <a href="https://github.com/sandeepisconscious-create/Subtitle-Downloader/raw/main/Subtitle_Downloader.zip">
      <img src="https://img.shields.io/badge/Download-Subtitle__Downloader.zip-2563eb?style=for-the-badge&logo=googlechrome&logoColor=white" alt="Download Latest Release" />
    </a>
    <a href="https://github.com/sandeepisconscious-create/Subtitle-Downloader/releases/latest">
      <img src="https://img.shields.io/github/v/release/sandeepisconscious-create/Subtitle-Downloader?style=for-the-badge&label=Release&color=10b981" alt="Latest Release" />
    </a>
  </p>
</div>

---

## Why Subtitle Downloader? (The Problem It Solves)

Watching long lectures, courses, interviews, tutorials, or multi-episode series is time-consuming when you want to **search, study, summarize, or feed the spoken content into AI tools and note-taking apps**. However, getting subtitles out of web video players is frustrating:

1. **No Native Export Button**: Most video players and streaming portals stream captions in the background but offer no way to download them as a file.
2. **Fragmented Streaming Formats**: Modern video players split subtitles across hundreds of tiny `.vtt` / `.m3u8` HLS segments, complex nested JSON timed-text payloads, or raw XML cues that are unusable on their own.
3. **Unreadable Raw Subtitle Files**: Standard `.srt` and `.vtt` files are cluttered with millisecond timecodes, sequence numbers, positioning tags, duplicate rolling-caption lines, and `[Music]` / `[Applause]` cues—making them painful to read as study notes or paste into LLMs.
4. **Tedious Multi-Video Workflows**: Downloading transcripts for a 40-video course playlist or a 25-episode season normally requires opening every single video manually, turning on captions, and repeating the extraction process one by one.
5. **Language Barriers**: Many videos only include captions in their original spoken language without a simple way to export an auto-translated English transcript.

---

## How Subtitle Downloader Solves It

**Subtitle Downloader** sits quietly in your browser toolbar, automatically detects all available subtitle and closed-caption streams on the active page, and turns them into clean, ready-to-use files in one click:

- **Readable Paragraph Mode**: When timestamps are turned off, fragmented 2-second caption cues are automatically stitched into natural, flowing paragraphs—ready for Obsidian, Notion, or AI summarization.
- **Batch Playlist & Season Automation**: Point it at a video playlist (or select a custom range like videos `#5–#15`) or an episodic series season, and it automatically downloads and numbers every transcript concurrently, generating a `_Download_Report.md` summary when finished.
- **Universal Stream Harvester**: Captures WebVTT (`.vtt`), SubRip (`.srt`), TTML/DFXP (`.ttml`, `.xml`), JSON timed-text, and segmented HLS (`.m3u8`) subtitle streams directly from the player—deduplicating cues and stitching segments automatically.
- **Dynamic Language Detection & Auto-Translation**: Reads the exact caption languages available on the current video (including auto-generated captions and one-click **English Auto-Translated** fallback when native English isn't available).
- **Instant Clipboard Copy**: Need to paste a transcript straight into an AI chat or document? Click **Copy Transcript to Clipboard** without even saving a file to disk.

---

## Supported Modes at a Glance

| Detected Media Type | Status Shown in Popup | What It Does |
|---|---|---|
| **Single Video** | `SUBTITLES AVAILABLE · VIDEO` | Instantly downloads or copies the subtitle/transcript for the active video in your chosen language and format |
| **Video Playlist** | `SUBTITLES AVAILABLE · PLAYLIST (N)` | Batch-downloads transcripts for all videos in the playlist, a custom `#Start–#End` range, or only the current video |
| **Episodic Season List** | `SUBTITLES AVAILABLE · SEASON (N EPISODES)` | Automatically steps through a season's episode list, captures each subtitle stream, and saves numbered transcripts |
| **Universal Stream** | `SUBTITLES AVAILABLE · N TRACKS` | Intercepts live `.vtt`, `.srt`, `.ttml`, `.json`, and `.m3u8` caption tracks on any web video player |

---

## Quick Installation (60 Seconds)

1. **[Click here to download `Subtitle_Downloader.zip`](https://github.com/sandeepisconscious-create/Subtitle-Downloader/raw/main/Subtitle_Downloader.zip)** and unzip it on your computer.
2. Open **`chrome://extensions`** in Google Chrome, Brave, Edge, or Arc.
3. Turn on **Developer mode** (toggle in the top-right corner).
4. Click **Load unpacked** (top-left button) and select the unzipped **`Subtitle_Downloader`** folder.
5. Pin **Subtitle Downloader** to your browser toolbar for one-click access.

---

## How to Use

1. **Open any video, playlist, or series page** that has closed captions (`CC`) available.
2. **Click the Subtitle Downloader icon** in your browser toolbar:
   - Choose your **Caption Language** directly from the dropdown (populated automatically with all languages detected on the video).
   - **Single Video**: Click **Download Subtitle (`.MD`)** to save the file, or **Copy Transcript to Clipboard** to copy it immediately.
   - **Playlist**: Download the entire playlist, set a specific **Playlist Range** (`From #` → `to #`), or click **Download Current Video Only**.
   - **Episodic Season**: Enter or confirm the season number and click **Download All Episodes**.
   - **Universal Video Player**: Play the video with closed captions (`CC`) enabled and click **Download Subtitle** or **Copy Transcript to Clipboard**.

---

## Customization & Preferences (`⚙️` Settings)

Click the **`⚙️`** gear icon in the top-right corner of the popup to tailor the output to your workflow:

- **File Format**:
  - **MD** (`.md`): Formatted Markdown notes—best for reading, Notion, Obsidian, and AI tools.
  - **TXT** (`.txt`): Simple plain-text transcript without styling.
  - **SRT** (`.srt`): Standard subtitle file (`00:00:00,740 --> 00:00:02,298`) for VLC, Premiere, DaVinci Resolve, Final Cut.
  - **VTT** (`.vtt`): Web subtitle format for web players.
- **Save Location**:
  - **Always Ask Where to Save**: Turn on to pick a folder for each download via your file dialog. Turn off to save automatically into your Downloads folder.
  - **Downloads Subfolder**: Subfolder inside `Downloads/` where files are saved automatically (default: `Subtitles`).
- **Timestamps**:
  - **ON**: Shows `[00:01:23]` timecodes before each spoken line.
  - **OFF**: Stitches sentences into clean, flowing paragraphs without timecodes (reads like a book).
- **Title & Source Header**:
  - **ON**: Adds the video title and link at the top of the file.
  - **OFF**: Saves only the dialogue text, no header.
- **Clean Sound Descriptions**:
  - **ON**: Removes sound descriptions like `[Music]`, `[Applause]`, or `[Laughter]`.
  - **OFF**: Keeps all audio/sound descriptions in the text.
- **Batch Summary File**:
  - **ON**: Creates a `_Download_Report.md` summary table after downloading a playlist or season.
  - **OFF**: Saves only the transcripts.
- **On-Screen Progress Bar**:
  - **ON**: Shows a live floating progress bar on top of the video page during batch downloads.
  - **OFF**: Hides the on-screen overlay.
- **Theme**: Switch between **Dark** and **Light** appearance.

*(Note: File Naming options—such as choosing between original video titles and custom names, or numbered season episodes—are selectable directly on the main download card right above the Download button.)*

---

## Project Architecture

```text
Subtitle_Downloader/
├── README.md                        ← Project documentation & quick-start guide
├── icon.png                         ← Extension toolbar icon
├── manifest.json                    ← Chrome Extension Manifest V3 configuration
├── popup.html                       ← Extension popup UI markup
└── src/
    ├── core/
    │   ├── config.js                ← Shared settings, constants, JSDoc types & path helpers
    │   └── subtitle_parser.js       ← Universal subtitle parser, paragraph stitcher & exporter
    ├── content/
    │   ├── interceptor.js           ← MAIN-world network, TextTrack & DOM caption harvester
    │   └── bridge.js                ← ISOLATED-world content script message bridge
    ├── background/
    │   ├── hud.js                   ← Tab script injection, on-page HUD & verified download helper
    │   ├── track_registry.js        ← Subtitle track store, webRequest listeners & cue resolver
    │   ├── playlist_pipeline.js     ← Concurrent playlist & single-video caption pipeline
    │   ├── season_pipeline.js       ← Episodic season scanner & batch auto-pilot pipeline
    │   └── index.js                 ← Background service worker router & keep-alive manager
    └── popup/
        ├── popup.css                ← Design system stylesheet (dark/light themes)
        └── popup.js                 ← Popup UI controller & live state synchronization
```

---

## 📄 License & Credits

Created with ❤️ by [Sandheep Rao](https://github.com/sandeepisconscious-create).

Licensed under the [MIT License](LICENSE).

