import { ChildProcess, execFile, spawn } from "child_process";
import { promisify } from "util";

interface Voice {
  name: string;
  locale: string;
}
const execFileAsync = promisify(execFile);
let activeSpeech: ChildProcess | undefined;
let voicesPromise: Promise<Voice[]> | undefined;
let speechGeneration = 0;

export function parseVoices(output: string): Voice[] {
  return output.split("\n").flatMap((line) => {
    const match = line.match(/^(.+?)\s+([a-z]{2,3}_[A-Z]{2})\s+#/);
    return match ? [{ name: match[1].trim(), locale: match[2] }] : [];
  });
}

export function chooseVoice(
  voices: Voice[],
  language: string
): string | undefined {
  const preferred: Record<string, string> = {
    "zh-CHS": "Tingting",
    "zh-CHT": "Meijia",
    en: "Samantha",
    ja: "Kyoko",
    ko: "Yuna",
    fr: "Thomas",
    de: "Anna",
    es: "Monica",
    it: "Alice",
    ru: "Milena",
    pt: "Joana",
  };
  const exact = voices.find((voice) => voice.name === preferred[language]);
  if (exact) return exact.name;
  const locale = language.startsWith("zh")
    ? language === "zh-CHT"
      ? "zh_TW"
      : "zh_CN"
    : language + "_";
  return voices.find((voice) => voice.locale.startsWith(locale))?.name;
}

async function getVoices(): Promise<Voice[]> {
  if (!voicesPromise) {
    voicesPromise = execFileAsync("/usr/bin/say", ["-v", "?"], {
      timeout: 5000,
      maxBuffer: 512 * 1024,
    })
      .then(({ stdout }) => parseVoices(stdout))
      .catch((error: unknown) => {
        voicesPromise = undefined;
        throw error;
      });
  }
  return voicesPromise;
}

export function stopSpeech(): void {
  speechGeneration += 1;
  if (activeSpeech && activeSpeech.exitCode === null && !activeSpeech.killed)
    activeSpeech.kill("SIGTERM");
  activeSpeech = undefined;
}

export async function speak(
  text: string,
  language: string,
  rate = 170
): Promise<{ voice?: string; finished: Promise<void> }> {
  stopSpeech();
  const generation = speechGeneration;
  if (!text.trim()) return { finished: Promise.resolve() };
  const voices = await getVoices();
  if (generation !== speechGeneration) return { finished: Promise.resolve() };
  const voice = chooseVoice(voices, language);
  const args = ["-r", String(Math.max(100, Math.min(260, rate)))];
  if (voice) args.push("-v", voice);
  // Text travels over stdin, never through a shell or command-line argument.
  const child = spawn("/usr/bin/say", args, {
    stdio: ["pipe", "ignore", "pipe"],
  });
  activeSpeech = child;
  const finished = new Promise<void>((resolve, reject) => {
    child.once("error", () => reject(new Error("无法启动 macOS 本地朗读。")));
    child.once("close", (code, signal) => {
      if (activeSpeech === child) activeSpeech = undefined;
      if (code === 0 || signal === "SIGTERM") resolve();
      else reject(new Error("本地朗读失败，请检查系统语音是否可用。"));
    });
  });
  // Avoid an unhandled rejection before callers attach their completion handler.
  void finished.catch(() => undefined);
  child.stderr?.resume();
  child.stdin?.on("error", () => undefined);
  child.stdin?.end(text);
  return { voice, finished };
}
