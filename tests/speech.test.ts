import test from "node:test";
import assert from "node:assert/strict";
import { chooseVoice, parseVoices } from "../src/speech";

const voices = parseVoices(
  "Samantha            en_US    # Hello\nTingting            zh_CN    # 你好\nMeijia              zh_TW    # 你好\nEddy (中文（中国大陆）)     zh_CN    # 你好\nKyoko               ja_JP    # こんにちは\n"
);
test("recognizes installed voices including localized names", () => {
  assert.equal(voices.length, 5);
  assert.equal(voices[3].name, "Eddy (中文（中国大陆）)");
});
test("chooses separate natural voices for original and translation", () => {
  assert.equal(chooseVoice(voices, "en"), "Samantha");
  assert.equal(chooseVoice(voices, "zh-CHS"), "Tingting");
  assert.equal(chooseVoice(voices, "zh-CHT"), "Meijia");
  assert.equal(chooseVoice(voices, "ja"), "Kyoko");
});
test("falls back by locale and lets macOS use its default for an unavailable language", () => {
  assert.equal(
    chooseVoice(
      voices.filter((v) => v.name !== "Tingting"),
      "zh-CHS"
    ),
    "Eddy (中文（中国大陆）)"
  );
  assert.equal(chooseVoice(voices, "fr"), undefined);
});
