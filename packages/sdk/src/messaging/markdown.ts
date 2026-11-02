/** Find a matching delimiter, allowing nesting and Markdown escapes. */
function closingDelimiter(text: string, start: number, open: string, close: string): number {
  let depth = 1;
  for (let i = start + 1; i < text.length; i++) {
    if (text[i] === "\\") i++;
    else if (text[i] === open) depth++;
    else if (text[i] === close && --depth === 0) return i;
  }
  return -1;
}

function readLink(text: string, start: number) {
  const image = text[start] === "!";
  const labelStart = start + (image ? 2 : 1);
  const labelEnd = closingDelimiter(text, labelStart - 1, "[", "]");
  if (labelEnd < 0 || text[labelEnd + 1] !== "(") return;

  let cursor = labelEnd + 2;
  while (/\s/.test(text[cursor] ?? "")) cursor++;
  let url: string;
  if (text[cursor] === "<") {
    const end = text.indexOf(">", cursor + 1);
    if (end < 0) return;
    url = text.slice(cursor + 1, end);
    cursor = end + 1;
  } else {
    const urlStart = cursor;
    while (cursor < text.length && !/[\s)]/.test(text[cursor])) {
      if (text[cursor] === "\\") cursor += 2;
      else if (text[cursor] === "(") {
        const end = closingDelimiter(text, cursor, "(", ")");
        if (end < 0) return;
        cursor = end + 1;
      } else cursor++;
    }
    url = text.slice(urlStart, cursor);
  }
  // An optional link title is metadata, not part of the destination.
  const tail = /^(?:\s+(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\((?:\\.|[^)\\])*\)))?\s*\)/.exec(text.slice(cursor));
  if (!tail) return;
  return {
    image,
    label: text.slice(labelStart, labelEnd),
    url: url.replace(/\\([\\()[\]])/g, "$1"),
    end: cursor + tail[0].length,
  };
}

/** Convert model replies to plain text, retaining link destinations verbatim. */
export function markdownToPlainText(text: string): string {
  let result = text.replace(/```[^\n]*\n?([\s\S]*?)```/g, (_, code: string) => code.trim());

  // Hide links and bare URLs before any formatting/table regex can change them.
  // Choose a prefix absent from the input so user text cannot collide with tokens.
  let prefix = "\uE000";
  while (text.includes(prefix)) prefix += "\uE000";
  const values: string[] = [];
  const protect = (value: string) => `${prefix}${values.push(value) - 1}\uE001`;
  const tokens = /!?\[|(?:[a-z][a-z\d+.-]*:\/\/|mailto:)[^\s<>`]+/gi;
  let output = "";
  let previousEnd = 0;
  for (let match; (match = tokens.exec(result));) {
    const start = match.index;
    if (match[0].endsWith("[")) {
      const link = readLink(result, start);
      if (!link) continue;
      const label = markdownToPlainText(link.label);
      const value = !label || label === link.url ? link.url : `${label}\n${link.url}`;
      output += result.slice(previousEnd, start) + (link.image ? "" : protect(value));
      tokens.lastIndex = link.end;
    } else {
      let url = match[0];
      // Leave closing emphasis outside the token, including spans such as
      // **See https://example.com/a_b_c**. Already protected URLs cannot
      // contribute false opening markers here.
      const before = output + result.slice(previousEnd, start);
      const line = before.slice(before.lastIndexOf("\n") + 1);
      const openMarkers = new Set<string>();
      for (const marker of line.match(/\*{1,3}|_{1,3}|~~/g) ?? []) {
        if (openMarkers.has(marker)) openMarkers.delete(marker);
        else openMarkers.add(marker);
      }
      for (const marker of openMarkers) {
        if (url.endsWith(marker)) {
          url = url.slice(0, -marker.length);
          tokens.lastIndex -= marker.length;
        }
      }
      output += result.slice(previousEnd, start) + protect(url);
    }
    previousEnd = tokens.lastIndex;
  }
  result = output + result.slice(previousEnd);

  result = result.replace(/^\|[\s:|-]+\|$/gm, "");
  result = result.replace(/^\|(.+)\|$/gm, (_, inner: string) =>
    inner.split("|").map((cell) => cell.trim()).join("  "),
  );
  result = result
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/\*(.+?)\*/g, "$1")
    .replace(/__(.+?)__/g, "$1")
    .replace(/_(.+?)_/g, "$1")
    .replace(/~~(.+?)~~/g, "$1")
    .replace(/`(.+?)`/g, "$1");
  return result.replace(new RegExp(`${prefix}(\\d+)\uE001`, "g"), (_, index: string) => values[Number(index)]);
}
