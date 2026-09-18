import React, { useEffect, useRef, useState } from "react";
import {
  Action,
  ActionPanel,
  Detail,
  getPreferenceValues,
  Icon,
  LaunchProps,
  List,
  openExtensionPreferences,
  showToast,
  Toast,
} from "@raycast/api";
import fetch from "node-fetch";
import {
  DEBOUNCE_MS,
  getLanguages,
  languageLabel,
  MAX_TEXT_LENGTH,
  Preferences,
  prepareText,
  REQUEST_TIMEOUT_MS,
  translateText,
  Translation,
  TranslationCache,
} from "./core";
import { speak, stopSpeech } from "./speech";

function markdownText(value: string): string {
  return value
    .replace(/[\\\x60*_{}[\]()#+.!|<>~-]/g, "\\$&")
    .replace(/\n/g, "  \n");
}

function resultMarkdown(result: Translation): string {
  return (
    "## 译文\n\n" +
    markdownText(result.text) +
    "\n\n---\n\n## 原文\n\n" +
    markdownText(result.source)
  );
}

function SettingsAction() {
  return (
    <Action
      title="翻译设置"
      icon={Icon.Gear}
      onAction={openExtensionPreferences}
    />
  );
}

function ResultActions({
  result,
  text,
  rate,
}: {
  result: Translation;
  text: string;
  rate: number;
}) {
  async function pronounce(content: string, language: string, label: string) {
    try {
      const playback = await speak(content, language, rate);
      const toast = await showToast({
        style: Toast.Style.Animated,
        title: "正在朗读" + label,
      });
      void playback.finished
        .then(() => toast.hide())
        .catch((error: Error) => {
          toast.style = Toast.Style.Failure;
          toast.title = error.message;
        });
    } catch {
      await showToast({
        style: Toast.Style.Failure,
        title: "无法启动本地朗读",
        message: "请检查 macOS 的语音设置。",
      });
    }
  }
  return (
    <ActionPanel>
      <ActionPanel.Section>
        <Action.CopyToClipboard title="复制译文" content={text} />
        <Action.Paste
          title="粘贴译文"
          content={text}
          shortcut={{ modifiers: ["cmd"], key: "return" }}
        />
        <Action.CopyToClipboard
          title="复制原文"
          content={result.source}
          shortcut={{ modifiers: ["cmd", "shift"], key: "c" }}
        />
      </ActionPanel.Section>
      <ActionPanel.Section title="本地发音">
        <Action
          title="朗读原文"
          icon={Icon.Speaker}
          shortcut={{ modifiers: ["opt"], key: "return" }}
          onAction={() => pronounce(result.source, result.from, "原文")}
        />
        <Action
          title="朗读译文"
          icon={Icon.SpeakerHigh}
          shortcut={{ modifiers: ["opt", "cmd"], key: "return" }}
          onAction={() => pronounce(text, result.to, "译文")}
        />
        <Action
          title="停止朗读"
          icon={Icon.Stop}
          shortcut={{ modifiers: ["opt", "cmd"], key: "." }}
          onAction={stopSpeech}
        />
      </ActionPanel.Section>
      <ActionPanel.Section>
        <Action.Push
          title="查看完整译文"
          icon={Icon.Document}
          shortcut={{ modifiers: ["cmd"], key: "d" }}
          target={
            <Detail
              markdown={resultMarkdown(result)}
              actions={
                <ActionPanel>
                  <Action.CopyToClipboard
                    title="复制译文"
                    content={result.text}
                  />
                  <Action.Paste title="粘贴译文" content={result.text} />
                </ActionPanel>
              }
            />
          }
        />
        <SettingsAction />
      </ActionPanel.Section>
    </ActionPanel>
  );
}

export default function Main(
  props: LaunchProps<{ arguments: { text?: string } }>
) {
  const [preferences] = useState(() => getPreferenceValues<Preferences>());
  const [query, setQuery] = useState(
    props.arguments?.text || props.fallbackText || ""
  );
  const [result, setResult] = useState<Translation>();
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [retry, setRetry] = useState(0);
  const sequence = useRef(0);
  const cache = useRef(new TranslationCache());
  const rate = Number(preferences.speech_rate || "170");

  useEffect(() => {
    const text = prepareText(query, preferences.handle_annotation);
    const current = ++sequence.current;
    setResult(undefined);
    setError("");
    if (!text) {
      setLoading(false);
      return;
    }
    if (Array.from(text).length > MAX_TEXT_LENGTH) {
      setError("单次最多翻译 5000 个字符，请分段输入。");
      setLoading(false);
      return;
    }
    const direction = getLanguages(text, preferences);
    const cacheKey = JSON.stringify([text, direction.from, direction.to]);
    const cached = cache.current.get(cacheKey);
    if (cached && retry === 0) {
      setResult(cached);
      setLoading(false);
      return;
    }

    let disposed = false;
    let timedOut = false;
    const controller = new AbortController();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    setLoading(true);
    const timer = setTimeout(() => {
      timeout = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, REQUEST_TIMEOUT_MS);
      void translateText(text, preferences, fetch, controller.signal)
        .then((translated) => {
          if (disposed || current !== sequence.current) return;
          cache.current.set(cacheKey, translated);
          setResult(translated);
        })
        .catch((failure: unknown) => {
          if (disposed || current !== sequence.current) return;
          if (timedOut) setError("翻译请求超时，请检查网络后重试。");
          else if (!controller.signal.aborted)
            setError(
              failure instanceof Error ? failure.message : "翻译失败，请重试。"
            );
        })
        .finally(() => {
          if (timeout) clearTimeout(timeout);
          if (!disposed && current === sequence.current) setLoading(false);
        });
    }, DEBOUNCE_MS);
    return () => {
      disposed = true;
      clearTimeout(timer);
      if (timeout) clearTimeout(timeout);
      controller.abort();
    };
  }, [query, preferences, retry]);

  useEffect(() => () => stopSpeech(), []);
  const visibleResult =
    result?.source === prepareText(query, preferences.handle_annotation)
      ? result
      : undefined;
  const showDetail = Boolean(
    visibleResult &&
      (visibleResult.source.length > 100 ||
        visibleResult.text.length > 80 ||
        visibleResult.text.includes("\n"))
  );
  const placeholder =
    preferences.translation_mode === "custom"
      ? "输入文字，自动翻译为" +
        languageLabel(preferences.target_language || "zh-CHS") +
        "…"
      : "直接输入文字，自动中英互译…";

  return (
    <List
      searchText={query}
      onSearchTextChange={(value) => {
        setRetry(0);
        setQuery(value);
      }}
      searchBarPlaceholder={placeholder}
      filtering={false}
      throttle={false}
      isLoading={loading}
      isShowingDetail={showDetail}
    >
      {visibleResult ? (
        <>
          <List.Section
            title={
              languageLabel(visibleResult.from) +
              " → " +
              languageLabel(visibleResult.to)
            }
          >
            <List.Item
              id="translation"
              icon="translate.png"
              title={visibleResult.text.replace(/\s+/g, " ")}
              subtitle={
                visibleResult.phonetic
                  ? "/" + visibleResult.phonetic + "/"
                  : undefined
              }
              detail={
                <List.Item.Detail markdown={resultMarkdown(visibleResult)} />
              }
              actions={
                <ResultActions
                  result={visibleResult}
                  text={visibleResult.text}
                  rate={rate}
                />
              }
            />
          </List.Section>
          {visibleResult.explains.length > 0 ? (
            <List.Section title="词典释义">
              {visibleResult.explains.slice(0, 8).map((meaning, index) => (
                <List.Item
                  key={index}
                  id={"meaning-" + index}
                  title={meaning}
                  detail={<List.Item.Detail markdown={markdownText(meaning)} />}
                  actions={
                    <ResultActions
                      result={visibleResult}
                      text={meaning}
                      rate={rate}
                    />
                  }
                />
              ))}
            </List.Section>
          ) : null}
        </>
      ) : (
        <List.EmptyView
          icon={error ? Icon.ExclamationMark : Icon.MagnifyingGlass}
          title={error ? "暂时无法翻译" : loading ? "正在翻译…" : "有道翻译"}
          description={
            error ||
            (loading
              ? "输入停顿后自动查询，无需提交表单"
              : "直接输入文字 · 默认中英互译 · ⌥↵ 读原文 · ⌥⌘↵ 读译文")
          }
          actions={
            <ActionPanel>
              {error ? (
                <Action
                  title="重试翻译"
                  icon={Icon.ArrowClockwise}
                  onAction={() => setRetry((value) => value + 1)}
                />
              ) : null}
              <SettingsAction />
            </ActionPanel>
          }
        />
      )}
    </List>
  );
}
