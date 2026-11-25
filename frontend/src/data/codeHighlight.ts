export type CodeTokenKind = "plain" | "keyword" | "string" | "comment" | "number" | "type";

export interface CodeToken {
  text: string;
  kind: CodeTokenKind;
}

const KEYWORDS_BY_LANG: Record<string, Set<string>> = {
  python: new Set([
    "and",
    "as",
    "assert",
    "async",
    "await",
    "break",
    "class",
    "continue",
    "def",
    "del",
    "elif",
    "else",
    "except",
    "False",
    "finally",
    "for",
    "from",
    "global",
    "if",
    "import",
    "in",
    "is",
    "lambda",
    "None",
    "nonlocal",
    "not",
    "or",
    "pass",
    "raise",
    "return",
    "True",
    "try",
    "while",
    "with",
    "yield",
  ]),
  typescript: new Set([
    "as",
    "async",
    "await",
    "break",
    "case",
    "catch",
    "class",
    "const",
    "continue",
    "default",
    "else",
    "enum",
    "export",
    "extends",
    "false",
    "finally",
    "for",
    "from",
    "function",
    "if",
    "implements",
    "import",
    "in",
    "interface",
    "let",
    "new",
    "null",
    "of",
    "private",
    "public",
    "readonly",
    "return",
    "static",
    "switch",
    "throw",
    "true",
    "try",
    "type",
    "typeof",
    "undefined",
    "var",
    "void",
    "while",
  ]),
  rust: new Set([
    "as",
    "async",
    "await",
    "break",
    "const",
    "continue",
    "crate",
    "else",
    "enum",
    "extern",
    "false",
    "fn",
    "for",
    "if",
    "impl",
    "in",
    "let",
    "loop",
    "match",
    "mod",
    "move",
    "mut",
    "pub",
    "ref",
    "return",
    "self",
    "Self",
    "static",
    "struct",
    "super",
    "trait",
    "true",
    "type",
    "unsafe",
    "use",
    "where",
    "while",
  ]),
  go: new Set([
    "break",
    "case",
    "chan",
    "const",
    "continue",
    "default",
    "defer",
    "else",
    "fallthrough",
    "false",
    "for",
    "func",
    "go",
    "if",
    "import",
    "interface",
    "map",
    "nil",
    "package",
    "range",
    "return",
    "select",
    "struct",
    "switch",
    "true",
    "type",
    "var",
  ]),
  sql: new Set([
    "ALL",
    "ALTER",
    "AND",
    "AS",
    "ASC",
    "BY",
    "CREATE",
    "DELETE",
    "DESC",
    "DISTINCT",
    "EXISTS",
    "FROM",
    "GROUP",
    "IF",
    "IN",
    "INSERT",
    "INTO",
    "JOIN",
    "LIMIT",
    "NOT",
    "NULL",
    "ON",
    "OR",
    "ORDER",
    "RECURSIVE",
    "REPLACE",
    "SELECT",
    "SET",
    "TABLE",
    "UNION",
    "UPDATE",
    "VALUES",
    "VIEW",
    "WHERE",
    "WITH",
  ]),
};

function normalizeLang(language: string): string {
  const low = language.toLowerCase();
  if (low === "javascript") return "typescript";
  return low;
}

function pushToken(tokens: CodeToken[], text: string, kind: CodeTokenKind): void {
  if (!text) return;
  const last = tokens[tokens.length - 1];
  if (last && last.kind === kind) {
    last.text += text;
  } else {
    tokens.push({ text, kind });
  }
}

export function tokenizeCodeLines(content: string, language: string): CodeToken[][] {
  const lang = normalizeLang(language);
  const kw = KEYWORDS_BY_LANG[lang] ?? KEYWORDS_BY_LANG.typescript;
  const isHashComment = lang === "python" || lang === "config" || lang === "markdown";
  const isDashComment = lang === "sql";
  const isSlashComment =
    lang === "typescript" || lang === "rust" || lang === "go" || lang === "css";

  const lines = content.split("\n");
  const out: CodeToken[][] = [];
  let inBlockComment = false;
  let pyTripleQuote: '"""' | "'''" | null = null;

  for (const line of lines) {
    const tokens: CodeToken[] = [];
    let i = 0;
    const len = line.length;

    while (i < len) {
      if (inBlockComment) {
        const endIdx = line.indexOf("*/", i);
        if (endIdx < 0) {
          pushToken(tokens, line.slice(i), "comment");
          i = len;
        } else {
          pushToken(tokens, line.slice(i, endIdx + 2), "comment");
          i = endIdx + 2;
          inBlockComment = false;
        }
        continue;
      }

      if (pyTripleQuote) {
        const endIdx = line.indexOf(pyTripleQuote, i);
        if (endIdx < 0) {
          pushToken(tokens, line.slice(i), "string");
          i = len;
        } else {
          pushToken(tokens, line.slice(i, endIdx + 3), "string");
          i = endIdx + 3;
          pyTripleQuote = null;
        }
        continue;
      }

      if (isSlashComment && line.startsWith("//", i)) {
        pushToken(tokens, line.slice(i), "comment");
        break;
      }
      if (isSlashComment && line.startsWith("/*", i)) {
        const endIdx = line.indexOf("*/", i + 2);
        if (endIdx < 0) {
          pushToken(tokens, line.slice(i), "comment");
          inBlockComment = true;
          break;
        }
        pushToken(tokens, line.slice(i, endIdx + 2), "comment");
        i = endIdx + 2;
        continue;
      }
      if (isHashComment && line[i] === "#") {
        pushToken(tokens, line.slice(i), lang === "markdown" ? "keyword" : "comment");
        break;
      }
      if (isDashComment && line.startsWith("--", i)) {
        pushToken(tokens, line.slice(i), "comment");
        break;
      }

      if (lang === "python" && (line.startsWith('"""', i) || line.startsWith("'''", i))) {
        const quote = line.startsWith('"""', i) ? '"""' : "'''";
        const endIdx = line.indexOf(quote, i + 3);
        if (endIdx < 0) {
          pushToken(tokens, line.slice(i), "string");
          pyTripleQuote = quote;
          break;
        }
        pushToken(tokens, line.slice(i, endIdx + 3), "string");
        i = endIdx + 3;
        continue;
      }

      const ch = line[i];
      if (ch === '"' || ch === "'" || ch === "`") {
        let j = i + 1;
        while (j < len) {
          if (line[j] === "\\") {
            j += 2;
            continue;
          }
          if (line[j] === ch) {
            j += 1;
            break;
          }
          j += 1;
        }
        pushToken(tokens, line.slice(i, j), "string");
        i = j;
        continue;
      }

      if (ch >= "0" && ch <= "9") {
        const m = /^[0-9]+(?:\.[0-9]+)?/.exec(line.slice(i));
        if (m) {
          pushToken(tokens, m[0], "number");
          i += m[0].length;
          continue;
        }
      }

      if ((ch >= "A" && ch <= "Z") || (ch >= "a" && ch <= "z") || ch === "_") {
        const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(line.slice(i));
        if (m) {
          const word = m[0];
          const lookup = lang === "sql" ? word.toUpperCase() : word;
          if (kw.has(lookup)) {
            pushToken(tokens, word, "keyword");
          } else if (word[0] >= "A" && word[0] <= "Z" && /[a-z]/.test(word)) {
            pushToken(tokens, word, "type");
          } else {
            pushToken(tokens, word, "plain");
          }
          i += word.length;
          continue;
        }
      }

      pushToken(tokens, ch, "plain");
      i += 1;
    }

    out.push(tokens);
  }
  return out;
}
