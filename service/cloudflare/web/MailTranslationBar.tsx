import { Button, Notice, Select } from '@neuro/ui';
import { useEffect, useState } from "react";
import {
  createTextNodeTranslationController,
  extractTranslatableTextSegments,
  groupSegmentsIntoBatches,
  lookupTranslatedSegment,
  type MailTranslationDisplayMode,
  type MinimalDomElement,
} from "../../base/src/domain/mail-dom-translation";
import { api, errorMessage } from "./api";

export interface TranslationRenderOutput {
  mode: MailTranslationDisplayMode;
  plainText: string;
  transformedHtml: string | null;
}

function applyTranslationToHtmlFragment(
  purifiedHtml: string,
  segmentsMap: Readonly<Record<string, string | undefined>>,
  targetLang: string,
  mode: MailTranslationDisplayMode,
): string {
  if (mode === "original" || !purifiedHtml) return purifiedHtml;
  const parser = new DOMParser();
  const doc = parser.parseFromString(`<div id="ee-tx-root">${purifiedHtml}</div>`, "text/html");
  const root = doc.getElementById("ee-tx-root");
  if (!root) return purifiedHtml;
  const apply = createTextNodeTranslationController(root as unknown as MinimalDomElement);
  apply({ mode, targetLang, segments: segmentsMap });
  return root.innerHTML;
}

function formatPlainTextWithMap(
  rawText: string,
  segmentsMap: Readonly<Record<string, string | undefined>>,
  mode: MailTranslationDisplayMode,
): string {
  if (mode === "original" || !rawText) return rawText;
  return rawText
    .split(/\r?\n/)
    .map((line) => {
      const hit = lookupTranslatedSegment(line, segmentsMap);
      if (!hit) return line;
      return mode === "bilingual" ? `${line}\n${hit}` : hit;
    })
    .join("\n");
}

export function MailTranslationBar({
  text,
  purifiedHtml,
  securityLevel,
  onTranslatedChange,
}: {
  text: string;
  purifiedHtml: string;
  securityLevel?: "safe" | "warning" | "danger";
  onTranslatedChange: (next: TranslationRenderOutput | null) => void;
}) {
  const [targetLang, setTargetLang] = useState("zh-CN");
  const [mode, setMode] = useState<MailTranslationDisplayMode>("original");
  const [segmentsMap, setSegmentsMap] = useState<Record<string, string> | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    setMode("original");
    setSegmentsMap(null);
    setError("");
    onTranslatedChange(null);
  }, [text, purifiedHtml]);

  function emitOutput(
    nextMode: MailTranslationDisplayMode,
    map: Record<string, string> | null,
  ) {
    if (!map || nextMode === "original") {
      onTranslatedChange(null);
      return;
    }
    const plain = formatPlainTextWithMap(text, map, nextMode);
    const htmlOut = purifiedHtml
      ? applyTranslationToHtmlFragment(purifiedHtml, map, targetLang, nextMode)
      : null;
    onTranslatedChange({ mode: nextMode, plainText: plain, transformedHtml: htmlOut });
  }

  async function runTranslate(desiredMode: MailTranslationDisplayMode) {
    if (desiredMode === "original") {
      setMode("original");
      onTranslatedChange(null);
      return;
    }
    if (segmentsMap) {
      setMode(desiredMode);
      emitOutput(desiredMode, segmentsMap);
      return;
    }
    setPending(true);
    setError("");
    try {
      const rawSegments = extractTranslatableTextSegments({
        textBody: text,
        htmlBody: purifiedHtml || undefined,
      });
      if (rawSegments.length === 0) {
        setError("当前邮件无可见文本段落可供翻译");
        return;
      }
      const batches = groupSegmentsIntoBatches(rawSegments);
      const nextMap: Record<string, string> = {};
      for (const batch of batches) {
        const resp = await api<{ sourceLanguage: string; translations: string[] }>(
          "/ai/translate",
          "POST",
          {
            sourceLang: "auto",
            targetLang,
            segments: batch,
            securityLevel,
          },
        );
        batch.forEach((src, idx) => {
          const translated = resp.translations[idx]?.trim();
          if (translated) nextMap[src] = translated;
        });
      }
      setSegmentsMap(nextMap);
      setMode(desiredMode);
      emitOutput(desiredMode, nextMap);
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="row" role="region" aria-label="保真段落翻译">
      <Select
        aria-label="翻译目标语言"
        value={targetLang}
        disabled={pending}
        onChange={(e) => {
          setTargetLang(e.target.value);
          setSegmentsMap(null);
          setMode("original");
          onTranslatedChange(null);
        }}
      >
        <option value="zh-CN">译为简体中文</option>
        <option value="en">译为 English</option>
        <option value="ja">译为日本語</option>
        <option value="ko">译为한국어</option>
      </Select>
      <Button
        type="button"
        variant="quiet"
        disabled={pending}
        aria-pressed={mode === "original"}
        onClick={() => void runTranslate("original")}
        wrap
      >
        原文
      </Button>
      <Button
        type="button"
        variant="quiet"
        disabled={pending}
        aria-pressed={mode === "translated"}
        onClick={() => void runTranslate("translated")}
        wrap
      >
        {pending ? "翻译中…" : "译文"}
      </Button>
      <Button
        type="button"
        variant="quiet"
        disabled={pending}
        aria-pressed={mode === "bilingual"}
        onClick={() => void runTranslate("bilingual")}
        wrap
      >
        双语对照
      </Button>
      {error && <Notice role="alert" tone="danger">{error}</Notice>}
    </div>
  );
}
