// Fenced-code-block languages for syntax highlighting inside the live
// preview. Editor.svelte passes this to markdown({ codeLanguages }) so lezer
// nests the right parser; the actual colors come from
// syntaxHighlighting(defaultHighlightStyle) in index.ts. Unknown info strings
// fall back to plain monospace (null).

import type { Language } from "@codemirror/language";
import { cssLanguage } from "@codemirror/lang-css";
import { htmlLanguage } from "@codemirror/lang-html";
import {
  javascriptLanguage,
  jsxLanguage,
  tsxLanguage,
  typescriptLanguage,
} from "@codemirror/lang-javascript";
import { markdownLanguage } from "@codemirror/lang-markdown";

export function fenceLanguage(info: string): Language | null {
  switch (info.trim().toLowerCase()) {
    case "js":
    case "javascript":
    case "mjs":
    case "cjs":
      return javascriptLanguage;
    case "ts":
    case "typescript":
      return typescriptLanguage;
    case "jsx":
      return jsxLanguage;
    case "tsx":
      return tsxLanguage;
    case "json":
      return javascriptLanguage; // close enough for highlighting
    case "html":
    case "svelte":
    case "vue":
      return htmlLanguage;
    case "css":
      return cssLanguage;
    case "md":
    case "markdown":
      return markdownLanguage;
    default:
      return null;
  }
}
