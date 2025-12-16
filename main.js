
import fs from "fs";
import fsp from "fs/promises";
import os from "os";
import path from "path";
import { execFileSync } from "child_process";
import OpenAI from "openai";

const openai = new OpenAI({ apiKey: "your open ai key goes here" });

// Tune these:
const MODEL = "gpt-4o-mini-transcribe"; // or "gpt-4o-transcribe" / "whisper-1"
const CHUNK_SECONDS = 900;             // 15 min (safe under 1400s/1500s caps people hit)
const OVERLAP_SECONDS = 15;            // overlap so you don't lose boundary words

function mustHaveFfmpeg() {
  try {
    execFileSync("ffmpeg", ["-version"], { stdio: "ignore" });
    execFileSync("ffprobe", ["-version"], { stdio: "ignore" });
  } catch {
    throw new Error("ffmpeg/ffprobe not found. Install ffmpeg first.");
  }
}

function getDurationSeconds(filePath) {
  const out = execFileSync("ffprobe", [
    "-v", "error",
    "-show_entries", "format=duration",
    "-of", "default=nw=1:nk=1",
    filePath
  ], { encoding: "utf8" }).trim();

  const dur = Number.parseFloat(out);
  if (!Number.isFinite(dur) || dur <= 0) throw new Error(`Could not read duration from ffprobe output: "${out}"`);
  return dur;
}

function cutChunk(inputPath, outputPath, startSec, durSec) {
  // Re-encode to ensure clean cuts (more reliable than -c copy for arbitrary cut points)
  execFileSync("ffmpeg", [
    "-hide_banner",
    "-loglevel", "error",
    "-ss", String(startSec),
    "-t", String(durSec),
    "-i", inputPath,
    "-vn",
    "-ac", "1",
    "-ar", "16000",
    "-c:a", "libmp3lame",
    "-q:a", "4",
    outputPath
  ], { stdio: "inherit" });
}

function collapseWs(s) {
  return s.replace(/\s+/g, " ").trim();
}

// Conservative overlap de-dup: finds a suffix of prev that matches prefix of next (after whitespace collapsing),
// then removes that matching prefix from next while keeping everything else.
// If we fail to confidently map, we keep next intact (so you never lose content).
function mergeWithOverlap(prev, next) {
  const prevC = collapseWs(prev);
  const nextC = collapseWs(next);

  const maxCheck = Math.min(500, prevC.length, nextC.length);
  const minCheck = 40; // don't try to match tiny overlaps

  let best = "";
  for (let k = maxCheck; k >= minCheck; k--) {
    const suffix = prevC.slice(-k);
    if (nextC.startsWith(suffix)) {
      best = suffix;
      break;
    }
  }
  if (!best) return prev + "\n" + next;

  // Remove best (collapsed) from the *start* of original next by scanning until collapsed prefix matches.
  // If we can't match safely, keep all next (no content loss).
  let acc = "";
  for (let i = 0; i < next.length; i++) {
    acc += next[i];
    if (collapseWs(acc) === best) {
      const remainder = next.slice(i + 1).replace(/^\s+/, "");
      return prev + "\n" + remainder;
    }
    // stop early if we've already exceeded target by too much
    if (collapseWs(acc).length > best.length + 20) break;
  }

  return prev + "\n" + next;
}

async function transcribeFile(filePath, outPath) {
  mustHaveFfmpeg();

  const duration = getDurationSeconds(filePath);
  const step = CHUNK_SECONDS - OVERLAP_SECONDS;
  if (step <= 0) throw new Error("CHUNK_SECONDS must be > OVERLAP_SECONDS");

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "oa-transcribe-"));
  const chunks = [];

  // Build chunk plan
  let idx = 0;
  for (let start = 0; start < duration; start += step) {
    const len = Math.min(CHUNK_SECONDS, duration - start);
    const chunkPath = path.join(tmpDir, `chunk_${String(idx).padStart(4, "0")}.mp3`);
    chunks.push({ idx, start, len, chunkPath });
    idx++;
  }

  console.log(`Audio duration: ${duration.toFixed(3)}s`);
  console.log(`Creating ${chunks.length} chunks in: ${tmpDir}`);

  // Cut chunks
  for (const c of chunks) {
    console.log(`Cutting chunk ${c.idx} @ ${c.start.toFixed(1)}s for ${c.len.toFixed(1)}s`);
    cutChunk(filePath, c.chunkPath, c.start, c.len);
  }

  // Transcribe chunks sequentially (safer for rate limits)
  let merged = "";
  for (const c of chunks) {
    console.log(`Transcribing chunk ${c.idx}/${chunks.length - 1}...`);

    const resp = await openai.audio.transcriptions.create({
      file: fs.createReadStream(c.chunkPath),
      language: "ru",
      model: MODEL,
      // The prompt parameter is supported for gpt-4o-transcribe and gpt-4o-mini-transcribe. :contentReference[oaicite:1]{index=1}
      prompt:
        "This is a chunk of a longer recording. Transcribe verbatim. " +
        "Do NOT add headings. If the chunk starts mid-sentence, continue naturally.",
    });

    const text = resp.text?.trim() ?? "";
    if (!text) continue;

    merged = merged ? mergeWithOverlap(merged, text) : text;
  }

  await fsp.writeFile(outPath, merged.trim() + "\n", "utf8");
  console.log(`\nSaved transcription to: ${outPath}`);

  // Optional: cleanup temp chunks
  // await fsp.rm(tmpDir, { recursive: true, force: true });
}

const filePath = process.argv[2];
const outPath = process.argv[3] || "transcription.txt";

if (!filePath) {
  console.error("Usage: node transcribe-chunked.mjs input.mp3 [output.txt]");
  process.exit(1);
}

await transcribeFile(filePath, outPath);
