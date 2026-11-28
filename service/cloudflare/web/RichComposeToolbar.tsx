import { Button, Disclosure } from '@neuro/ui';
import { useState } from "react";

export function RichComposeToolbar({ text, disabled, onUpdateText }: {
  text: string;
  disabled: boolean;
  onUpdateText(nextText: string): void;
}) {
  const [previewOpen, setPreviewOpen] = useState(false);

  function appendSnippet(snippet: string) {
    if (disabled) return;
    const next = text ? `${text}\n${snippet}` : snippet;
    onUpdateText(next.slice(0, 6000));
  }

  return <Disclosure title="排版快捷辅助（列表 / 引用 / 代码块 / 预览）">
    <div className="rich-compose-toolbar">
      <div className="row">
        <Button type="button" variant="quiet" disabled={disabled} onClick={() => appendSnippet("- 要点项")} wrap>项目列表</Button>
        <Button type="button" variant="quiet" disabled={disabled} onClick={() => appendSnippet("1. 步骤一")} wrap>编号列表</Button>
        <Button type="button" variant="quiet" disabled={disabled} onClick={() => appendSnippet("> 引用原文内容")} wrap>引用段落</Button>
        <Button type="button" variant="quiet" disabled={disabled} onClick={() => appendSnippet("```\n代码片段\n```")} wrap>代码块</Button>
        <Button type="button" variant="quiet" aria-pressed={previewOpen} onClick={() => setPreviewOpen((v) => !v)} wrap>
          {previewOpen ? "收起排版预览" : "展开排版预览"}
        </Button>
      </div>
      {previewOpen && <pre aria-label="写信内容预览">{text || "（暂无内容）"}</pre>}
    </div>
  </Disclosure>;
}
