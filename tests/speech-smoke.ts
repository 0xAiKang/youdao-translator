import { speak, stopSpeech } from "../src/speech";

async function main() {
  for (const [text, language] of [
    ["Hello.", "en"],
    ["你好。", "zh-CHS"],
  ]) {
    const playback = await speak(text, language);
    await playback.finished;
    console.log(
      JSON.stringify({ language, voice: playback.voice, completed: true })
    );
  }
  const playback = await speak(
    "A short test of stopping speech. ".repeat(10),
    "en"
  );
  stopSpeech();
  await playback.finished;
  console.log(JSON.stringify({ cancellation: true }));
}
void main().catch(() => {
  console.error("Speech smoke test failed");
  process.exitCode = 1;
});
