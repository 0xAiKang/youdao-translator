import test from "node:test";
import assert from "node:assert/strict";
import {
  getLanguages,
  makeRequest,
  parseResponse,
  prepareText,
  signInput,
  translateText,
  TranslationCache,
  Preferences,
} from "../src/core";

const preferences: Preferences = {
  app_key: "test-app",
  app_secret: "test-secret",
};

test("defaults to Chinese-English and handles mixed code text", () => {
  assert.deepEqual(getLanguages("Hello world", preferences), {
    from: "auto",
    to: "zh-CHS",
  });
  assert.deepEqual(getLanguages("请解释 API 的使用方法", preferences), {
    from: "auto",
    to: "en",
  });
  assert.deepEqual(getLanguages("日本語を勉強します", preferences), {
    from: "auto",
    to: "zh-CHS",
  });
});
test("custom language choices persist independently of input", () => {
  assert.deepEqual(
    getLanguages("你好", {
      ...preferences,
      translation_mode: "custom",
      source_language: "auto",
      target_language: "ja",
    }),
    { from: "auto", to: "ja" }
  );
});
test("preserves paragraph breaks and only strips annotations when enabled", () => {
  assert.equal(prepareText(" First\r\n\r\nSecond \n"), "First\n\nSecond");
  assert.equal(prepareText("https://example.com"), "https://example.com");
  assert.equal(prepareText("// hello", true), "hello");
});
test("v3 signature matches a fixed independent fixture; secret never leaves request", () => {
  const request = makeRequest("hello", preferences, "test-salt", "1700000000");
  assert.equal(
    request.get("sign"),
    "646d59783da4c8a73340780c53ea538783f3fca351929a86b4288f9480047265"
  );
  assert.equal(request.get("signType"), "v3");
  assert.equal(request.get("to"), "zh-CHS");
  assert.equal(request.get("strict"), "true");
  assert.equal(request.get("appSecret"), null);
  assert.equal(request.toString().includes("test-secret"), false);
});
test("signature truncation keeps Unicode code points intact", () => {
  assert.equal(signInput("abcdefghijklmnopqrstu"), "abcdefghij21lmnopqrstu");
  assert.equal(
    signInput("🙂".repeat(21)),
    "🙂".repeat(10) + "21" + "🙂".repeat(10)
  );
});
test("accepts long paragraphs but rejects empty and over-limit text before fetching", async () => {
  let calls = 0;
  const fetcher = async () => {
    calls++;
    return {
      ok: true,
      status: 200,
      json: async () => ({ errorCode: "0", translation: ["译文"] }),
    };
  };
  await translateText("a".repeat(146), preferences, fetcher);
  assert.equal(calls, 1);
  await assert.rejects(
    () => translateText("a".repeat(5001), preferences, fetcher),
    /5000/
  );
  await assert.rejects(
    () => translateText(" \n ", preferences, fetcher),
    /输入/
  );
  assert.equal(calls, 1);
});
test("uses HTTPS POST body and forwards cancellation, preserving multiline input", async () => {
  const abort = new AbortController();
  const input = "First paragraph.\n\nSecond paragraph.";
  const result = await translateText(
    input,
    preferences,
    async (url, options) => {
      assert.equal(url, "https://openapi.youdao.com/api");
      assert.equal(url.includes("?"), false);
      assert.equal(options.method, "POST");
      assert.equal(new URLSearchParams(options.body).get("q"), input);
      assert.equal(options.signal, abort.signal);
      return {
        ok: true,
        status: 200,
        json: async () => ({
          errorCode: "0",
          translation: ["第一段。\n\n第二段。"],
          l: "en2zh-CHS",
        }),
      };
    },
    abort.signal
  );
  assert.equal(result.from, "en");
  assert.equal(result.to, "zh-CHS");
  assert.equal(result.text, "第一段。\n\n第二段。");
});
test("explains provider errors without exposing its raw response", () => {
  assert.throws(
    () =>
      parseResponse(
        { errorCode: "401", diagnostic: "private payload" },
        "hello",
        preferences
      ),
    /余额不足/
  );
  assert.throws(
    () => parseResponse({ errorCode: "110" }, "hello", preferences),
    /绑定文本翻译服务/
  );
  assert.throws(
    () => parseResponse({ errorCode: "202" }, "hello", preferences),
    /签名校验失败/
  );
  assert.throws(
    () =>
      parseResponse({ errorCode: "0", translation: [] }, "hello", preferences),
    /未返回译文/
  );
});
test("separates HTTP failures from provider business codes", async () => {
  await assert.rejects(
    () =>
      translateText("hello", preferences, async () => ({
        ok: false,
        status: 401,
        json: async () => ({ errorCode: "401" }),
      })),
    /HTTP 401/
  );
});
test("rejects malformed responses and keeps dictionary pronunciation data", async () => {
  await assert.rejects(
    () =>
      translateText("hello", preferences, async () => ({
        ok: true,
        status: 200,
        json: async () => {
          throw new Error("not JSON");
        },
      })),
    /非 JSON/
  );
  const result = parseResponse(
    {
      translation: ["你好"],
      l: "en2zh-CHS",
      basic: { phonetic: "həˈləʊ", explains: ["int. 你好"] },
    },
    "hello",
    preferences
  );
  assert.equal(result.phonetic, "həˈləʊ");
  assert.deepEqual(result.explains, ["int. 你好"]);
});
test("bounded session cache evicts least recently used text", () => {
  const cache = new TranslationCache(2);
  const result = parseResponse({ translation: ["你好"] }, "hello", preferences);
  cache.set("a", result);
  cache.set("b", result);
  cache.get("a");
  cache.set("c", result);
  assert.equal(cache.get("b"), undefined);
  assert.equal(cache.get("a"), result);
  assert.equal(cache.get("c"), result);
});
