import { createHash, randomUUID } from "crypto";

export const MAX_TEXT_LENGTH = 5000;
export const DEBOUNCE_MS = 500;
export const REQUEST_TIMEOUT_MS = 15000;

export interface Preferences {
  app_key: string;
  app_secret: string;
  translation_mode?: string;
  source_language?: string;
  target_language?: string;
  speech_rate?: string;
  handle_annotation?: boolean;
}

export interface Translation {
  source: string;
  text: string;
  translations: string[];
  explains: string[];
  phonetic?: string;
  from: string;
  to: string;
}

export interface ResponseLike {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}

export type FetchLike = (
  url: string,
  options: {
    method: "POST";
    headers: Record<string, string>;
    body: string;
    signal?: AbortSignal;
  }
) => Promise<ResponseLike>;

export function prepareText(input: string, stripAnnotations = false): string {
  const text = input.replace(/\r\n?/g, "\n");
  return (
    stripAnnotations ? text.replace(/\/\/\/|\/\/!|\/\*|\*\/|\/\//g, "") : text
  ).trim();
}

export function getLanguages(
  text: string,
  preferences: Preferences
): { from: string; to: string } {
  if (preferences.translation_mode === "custom") {
    return {
      from: preferences.source_language || "auto",
      to: preferences.target_language || "zh-CHS",
    };
  }
  // Default mode is deliberately a Chinese/English pair, not a full language detector.
  // Japanese kana and Korean Hangul should go to Chinese even when Han characters occur.
  const hasHan = /[\u3400-\u9fff]/.test(text);
  const hasKanaOrHangul = /[\u3040-\u30ff\uac00-\ud7af]/.test(text);
  return { from: "auto", to: hasHan && !hasKanaOrHangul ? "en" : "zh-CHS" };
}

export function signInput(text: string): string {
  const characters = Array.from(text);
  return characters.length > 20
    ? characters.slice(0, 10).join("") +
        characters.length +
        characters.slice(-10).join("")
    : text;
}

export function makeRequest(
  text: string,
  preferences: Preferences,
  salt: string = randomUUID(),
  curtime = String(Math.floor(Date.now() / 1000))
): URLSearchParams {
  if (!text) throw new Error("请输入要翻译的文字。");
  if (Array.from(text).length > MAX_TEXT_LENGTH)
    throw new Error("单次最多翻译 5000 个字符，请分段输入。");
  if (!preferences.app_key?.trim() || !preferences.app_secret?.trim()) {
    throw new Error("请先在扩展设置中填写有道 APP Key 和 APP Secret。");
  }
  const { from, to } = getLanguages(text, preferences);
  const appKey = preferences.app_key.trim();
  const sign = createHash("sha256")
    .update(
      appKey + signInput(text) + salt + curtime + preferences.app_secret.trim(),
      "utf8"
    )
    .digest("hex");
  return new URLSearchParams({
    q: text,
    appKey,
    from,
    to,
    salt,
    curtime,
    sign,
    signType: "v3",
    strict: "true",
  });
}

const ERRORS: Record<string, string> = {
  "101": "请求参数不完整。",
  "102": "不支持该语言组合，请修改扩展设置。",
  "103": "文本过长，请分段输入。",
  "105": "有道不支持当前签名类型。",
  "108": "应用 ID 无效，请检查 APP Key。",
  "110": "该应用尚未绑定文本翻译服务，请到有道控制台检查。",
  "111": "开发者账户无效。",
  "202": "签名校验失败，请检查 APP Key 和 APP Secret 是否匹配。",
  "203": "当前 IP 不在有道应用的允许列表中。",
  "206": "请求时间戳无效，请检查系统时间。",
  "207": "请求重复，请稍后重试。",
  "401": "有道账户余额不足或已欠费，请检查有道控制台。",
  "405": "有道鉴权失败，请检查应用服务权限。",
  "411": "请求过于频繁，请稍后重试。",
  "412": "查询文本或调用额度达到限制。",
  "500": "有道翻译服务暂时未能返回结果，请重试。",
};

export function youdaoError(code: string): string {
  return (
    "有道 " +
    code +
    "：" +
    (ERRORS[code] || "请求失败，请查看有道接口文档或重试。")
  );
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function parseResponse(
  data: unknown,
  source: string,
  preferences: Preferences
): Translation {
  if (!isObject(data))
    throw new Error("有道返回了无法识别的数据，请稍后重试。");
  const errorCode = String(data.errorCode ?? "");
  if (errorCode && errorCode !== "0") throw new Error(youdaoError(errorCode));
  const translations = Array.isArray(data.translation)
    ? data.translation.filter(
        (item): item is string =>
          typeof item === "string" && item.trim().length > 0
      )
    : [];
  if (!translations.length)
    throw new Error("有道未返回译文，请换一段文字或稍后重试。");
  const basic = isObject(data.basic) ? data.basic : {};
  const explains = Array.isArray(basic.explains)
    ? basic.explains.filter((item): item is string => typeof item === "string")
    : [];
  const requested = getLanguages(source, preferences);
  const languagePair = typeof data.l === "string" ? data.l.split("2") : [];
  return {
    source,
    text: translations.join("\n"),
    translations,
    explains,
    phonetic: typeof basic.phonetic === "string" ? basic.phonetic : undefined,
    from:
      languagePair[0] ||
      (requested.from === "auto"
        ? requested.to === "en"
          ? "zh-CHS"
          : "en"
        : requested.from),
    to: languagePair[1] || requested.to,
  };
}

export async function translateText(
  input: string,
  preferences: Preferences,
  fetcher: FetchLike,
  signal?: AbortSignal
): Promise<Translation> {
  const text = prepareText(input, preferences.handle_annotation);
  const parameters = makeRequest(text, preferences);
  const response = await fetcher("https://openapi.youdao.com/api", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: parameters.toString(),
    signal,
  });
  if (!response.ok)
    throw new Error("有道接口 HTTP " + response.status + "，请稍后重试。");
  let data: unknown;
  try {
    data = await response.json();
  } catch {
    throw new Error("有道返回了非 JSON 响应，请检查网络后重试。");
  }
  return parseResponse(data, text, preferences);
}

const LANGUAGE_LABELS: Record<string, string> = {
  "zh-CHS": "中文",
  "zh-CHT": "繁体中文",
  en: "英文",
  ja: "日文",
  ko: "韩文",
  fr: "法文",
  de: "德文",
  es: "西班牙文",
  ru: "俄文",
  pt: "葡萄牙文",
  it: "意大利文",
  auto: "自动",
};

export function languageLabel(language: string): string {
  return LANGUAGE_LABELS[language] || language;
}

export class TranslationCache {
  private entries = new Map<string, Translation>();
  constructor(private readonly limit = 20) {}
  get(key: string): Translation | undefined {
    const value = this.entries.get(key);
    if (value) {
      this.entries.delete(key);
      this.entries.set(key, value);
    }
    return value;
  }
  set(key: string, value: Translation): void {
    this.entries.delete(key);
    this.entries.set(key, value);
    while (this.entries.size > this.limit) {
      const oldest = this.entries.keys().next().value as string;
      this.entries.delete(oldest);
    }
  }
}
