import fs from "fs";
import OpenAI from "openai";

const openai = new OpenAI({
  apiKey: "test",
});

const filePath = process.argv[2];
const outPath = process.argv[3] || "transcription.txt";

if (!filePath) {
  console.error(
    "Usage: node transcribe-to-file.mjs path/to/audio.mp3 [output.txt]"
  );
  process.exit(1);
}

const transcription = await openai.audio.transcriptions.create({
  file: fs.createReadStream(filePath),
  model: "gpt-4o-mini-transcribe",
  // language: "en",
});

fs.writeFileSync(outPath, transcription.text, "utf8");
console.log(`Saved transcription to: ${outPath}`);
