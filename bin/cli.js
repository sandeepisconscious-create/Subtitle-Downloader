#!/usr/bin/env node
// @ts-check
/**
 * Subtitle Downloader CLI
 * Uses Subtitle Downloader's UniversalSubtitleParser and caption extraction
 * to extract subtitles from any video and convert them into transcripts.
 */

const fs = require('fs');
const path = require('path');

// Load Subtitle Downloader core libraries
require('../src/core/config.js');
require('../src/core/subtitle_parser.js');

const Config = globalThis.SubConfig;
const Parser = globalThis.UniversalSubtitleParser;

function printHelp() {
  console.log(`
Subtitle Downloader - CLI Tool
Extract subtitles from any video and turn them into transcripts.

Usage:
  node bin/cli.js <video-url-or-id> [options]

Options:
  --lang <code>        Preferred language code (e.g. 'en', 'es', 'hi'). Default: 'en'
  --translate <code>   Translate subtitles to language (e.g. 'en')
  --format <fmt>       Output format: 'md' (Markdown), 'txt' (Text), 'srt', 'vtt'. Default: 'md'
  --timestamps         Include timestamp brackets [HH:MM:SS]. Default: false (clean paragraphs)
  --clean              Strip audio descriptions like [Music], [Applause]. Default: true
  --no-header          Omit title and source header from output
  --out <filepath>     Output file path. Defaults to ./<Video_Title>.<fmt>
  --stdout             Print transcript directly to stdout instead of saving to file
  -h, --help           Show this help message

Examples:
  node bin/cli.js "https://www.youtube.com/watch?v=BUE-icVYRFU"
  node bin/cli.js BUE-icVYRFU --format md --timestamps
  node bin/cli.js "https://www.youtube.com/watch?v=some_video" --translate en --out ./my_lecture.md
`);
}

function parseArgs(args) {
  const options = {
    input: '',
    lang: 'en',
    translate: '',
    format: 'md',
    timestamps: false,
    clean: true,
    header: true,
    out: '',
    stdout: false
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '-h' || arg === '--help') {
      printHelp();
      process.exit(0);
    } else if (arg === '--lang' && args[i + 1]) {
      options.lang = args[++i];
    } else if (arg === '--translate' && args[i + 1]) {
      options.translate = args[++i];
    } else if (arg === '--format' && args[i + 1]) {
      options.format = args[++i].toLowerCase();
    } else if (arg === '--timestamps') {
      options.timestamps = true;
    } else if (arg === '--no-timestamps') {
      options.timestamps = false;
    } else if (arg === '--clean') {
      options.clean = true;
    } else if (arg === '--no-clean') {
      options.clean = false;
    } else if (arg === '--no-header') {
      options.header = false;
    } else if (arg === '--out' && args[i + 1]) {
      options.out = args[++i];
    } else if (arg === '--stdout') {
      options.stdout = true;
    } else if (!arg.startsWith('-') && !options.input) {
      options.input = arg;
    }
  }

  return options;
}

function extractYouTubeVideoId(input) {
  if (!input) return null;
  if (/^[A-Za-z0-9_-]{11}$/.test(input.trim())) {
    return input.trim();
  }
  const match = input.match(/(?:[?&]v=|youtu\.be\/|\/shorts\/|\/embed\/|\/watch\/)([A-Za-z0-9_-]{11})/);
  return match ? match[1] : null;
}

async function fetchYouTubeCaptionTracks(videoId) {
  const clients = [
    { clientName: 'ANDROID', clientVersion: '20.10.38' },
    { clientName: 'WEB', clientVersion: '2.20240105.01.00' }
  ];

  let lastError = null;

  for (const client of clients) {
    try {
      const resp = await fetch('https://www.youtube.com/youtubei/v1/player?prettyPrint=false', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)'
        },
        body: JSON.stringify({
          context: { client },
          videoId
        })
      });

      if (!resp.ok) continue;

      const data = await resp.json();
      const tracks = data?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
      const title = data?.videoDetails?.title || `YouTube Video ${videoId}`;
      const author = data?.videoDetails?.author || '';

      if (Array.isArray(tracks) && tracks.length > 0) {
        return { tracks, title, author };
      }
    } catch (e) {
      lastError = e;
    }
  }

  throw new Error(lastError ? lastError.message : 'No caption tracks found for this video.');
}

async function extractSubtitles(opts) {
  const videoId = extractYouTubeVideoId(opts.input);

  let rawSubBody = '';
  let hintExt = 'timedtext.json3';
  let title = 'Transcript';
  let author = '';
  let videoUrl = opts.input;

  if (videoId) {
    videoUrl = `https://www.youtube.com/watch?v=${videoId}`;
    if (!opts.stdout) {
      console.log(`[Subtitle Downloader] Fetching metadata for video ${videoId}...`);
    }

    const { tracks, title: vidTitle, author: vidAuthor } = await fetchYouTubeCaptionTracks(videoId);
    title = vidTitle;
    author = vidAuthor;

    if (!opts.stdout) {
      console.log(`[Subtitle Downloader] Found video: "${title}" by ${author || 'Unknown'}`);
      console.log(`[Subtitle Downloader] Available caption tracks (${tracks.length}):`);
      tracks.forEach((t, i) => {
        const langName = t.name?.simpleText || t.name?.runs?.map((r) => r.text).join('') || t.languageCode;
        console.log(`  ${i + 1}. [${t.languageCode}] ${langName} (${t.kind === 'asr' ? 'auto-generated' : 'manual'})`);
      });
    }

    // Match preferred language
    let chosen = null;
    const targetLang = opts.lang.toLowerCase();

    // 1. Exact manual match
    chosen = tracks.find((t) => t.kind !== 'asr' && t.languageCode.toLowerCase() === targetLang);
    // 2. Prefix manual match (e.g. en-US matches en)
    if (!chosen) {
      chosen = tracks.find((t) => t.kind !== 'asr' && t.languageCode.toLowerCase().startsWith(targetLang));
    }
    // 3. ASR match
    if (!chosen) {
      chosen = tracks.find((t) => t.languageCode.toLowerCase().startsWith(targetLang));
    }
    // 4. Default to first track
    if (!chosen) {
      chosen = tracks[0];
    }

    let baseUrl = chosen.baseUrl.replace(/&fmt=[^&]+/g, '');
    if (opts.translate) {
      baseUrl = `${baseUrl.replace(/&tlang=[^&]+/g, '')}&tlang=${encodeURIComponent(opts.translate)}`;
    }

    if (!opts.stdout) {
      const chosenName = chosen.name?.simpleText || chosen.languageCode;
      console.log(`[Subtitle Downloader] Downloading subtitle track: ${chosenName}${opts.translate ? ` -> Translated to ${opts.translate}` : ''}...`);
    }

    // Fetch JSON3 first, fallback to raw XML/TTML
    try {
      const jResp = await fetch(`${baseUrl}&fmt=json3`);
      if (jResp.ok) {
        rawSubBody = await jResp.text();
        hintExt = 'timedtext.json3';
      }
    } catch (_) {}

    if (!rawSubBody || !rawSubBody.trim()) {
      const xmlResp = await fetch(baseUrl);
      if (!xmlResp.ok) {
        throw new Error(`Failed to download caption stream (HTTP ${xmlResp.status})`);
      }
      rawSubBody = await xmlResp.text();
      hintExt = 'timedtext.xml';
    }
  } else if (fs.existsSync(opts.input)) {
    // Local file
    rawSubBody = fs.readFileSync(opts.input, 'utf-8');
    hintExt = path.extname(opts.input);
    title = path.basename(opts.input, hintExt);
  } else if (/^https?:\/\//i.test(opts.input)) {
    // Direct URL to subtitle track
    const resp = await fetch(opts.input);
    rawSubBody = await resp.text();
    hintExt = opts.input;
  } else {
    throw new Error(`Invalid input: "${opts.input}". Please provide a YouTube URL, video ID, or subtitle file.`);
  }

  // Parse using UniversalSubtitleParser
  const parsed = Parser.parseUniversalSubtitle(rawSubBody, hintExt);
  if (!parsed || !parsed.cues || parsed.cues.length === 0) {
    throw new Error('No subtitle cues could be parsed from the response.');
  }

  if (!opts.stdout) {
    console.log(`[Subtitle Downloader] Parsed ${parsed.cues.length} cues using format engine (${parsed.format || 'Standard'}).`);
  }

  // Format into transcript
  const sublines = [];
  if (author) sublines.push(`**Creator / Speaker**: ${author}`);
  sublines.push(`**Source**: ${videoUrl}`);
  sublines.push(`**Total Cues**: ${parsed.cues.length}`);

  const formattedOutput = Parser.formatCuesOutput(
    parsed.cues,
    {
      heading: title,
      sublines: opts.header ? sublines : []
    },
    {
      exportFormat: opts.format,
      includeTimestamps: opts.timestamps,
      includeHeader: opts.header,
      stripSoundTags: opts.clean
    }
  );

  if (opts.stdout) {
    process.stdout.write(formattedOutput);
    return;
  }

  // Determine output path
  let outPath = opts.out;
  if (!outPath) {
    const safeTitle = Config.exactFileName(title, 'transcript');
    outPath = path.resolve(process.cwd(), `${safeTitle}.${opts.format}`);
  } else {
    outPath = path.resolve(process.cwd(), outPath);
  }

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, formattedOutput, 'utf-8');

  const words = formattedOutput.split(/\s+/).filter(Boolean).length;
  console.log(`\n==============================================`);
  console.log(` Transcript Successfully Extracted & Formatted!`);
  console.log(` File saved to: ${outPath}`);
  console.log(` Format: ${opts.format.toUpperCase()} | Timestamps: ${opts.timestamps ? 'YES' : 'NO (clean paragraphs)'}`);
  console.log(` Total Cues: ${parsed.cues.length} | Word count: ~${words} words`);
  console.log(` Ready for Gemini Notebook / NotebookLM!`);
  console.log(`==============================================\n`);
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    printHelp();
    process.exit(1);
  }

  const options = parseArgs(args);
  if (!options.input) {
    console.error('Error: No video URL, ID, or subtitle file provided.');
    printHelp();
    process.exit(1);
  }

  try {
    await extractSubtitles(options);
  } catch (err) {
    console.error(`\n[Subtitle Downloader Error]: ${err.message}`);
    process.exit(1);
  }
}

main();
