import assert from "node:assert/strict";
import { test } from "node:test";
import { markdownToPlainText } from "../.test-dist/src/messaging/send.js";
import { formatMessageText } from "../.test-dist/src/messaging/markdown.js";

const cases = [
  ["empty text", "", ""],
  [
    "link destination",
    "[查看详情](https://example.com)",
    "查看详情\nhttps://example.com",
  ],
  [
    "identical label",
    "[https://example.com/a_b_c](https://example.com/a_b_c)",
    "https://example.com/a_b_c",
  ],
  [
    "formatted identical label",
    "[**https://example.com/a_b_c**](https://example.com/a_b_c)",
    "https://example.com/a_b_c",
  ],
  ["empty label", "[](https://example.com)", "https://example.com"],
  [
    "formatted label",
    "[**查看** _详情_](https://example.com/a_b_c)",
    "查看 详情\nhttps://example.com/a_b_c",
  ],
  [
    "bare URL underscores",
    "https://example.com/a_b_c",
    "https://example.com/a_b_c",
  ],
  [
    "bare URL formatting characters",
    "https://example.com/__a__/*b*/~~c~~?q=x_y_z#part_one_two",
    "https://example.com/__a__/*b*/~~c~~?q=x_y_z#part_one_two",
  ],
  [
    "link URL formatting characters",
    "[详情](https://example.com/__a__/*b*/~~c~~)",
    "详情\nhttps://example.com/__a__/*b*/~~c~~",
  ],
  [
    "parentheses",
    "[条目](https://example.com/wiki/Foo_(bar))。",
    "条目\nhttps://example.com/wiki/Foo_(bar)。",
  ],
  [
    "nested parentheses",
    "[条目](https://example.com/a_(b_(c))?x=(d))",
    "条目\nhttps://example.com/a_(b_(c))?x=(d)",
  ],
  [
    "escaped parentheses",
    String.raw`[条目](https://example.com/a_\(b\))`,
    "条目\nhttps://example.com/a_(b)",
  ],
  [
    "encoded parentheses",
    "[条目](https://example.com/a_%28b%29)",
    "条目\nhttps://example.com/a_%28b%29",
  ],
  [
    "angle destination",
    '[条目](<https://example.com/a_(b)> "标题")',
    "条目\nhttps://example.com/a_(b)",
  ],
  [
    "link title",
    '[条目](https://example.com/a_(b) "标题 (详情)")',
    "条目\nhttps://example.com/a_(b)",
  ],
  [
    "nested label brackets",
    "[条目 [详情]](https://example.com)",
    "条目 [详情]\nhttps://example.com",
  ],
  [
    "multiple links",
    "[一](https://example.com/a_b)[二](https://example.com/c_d)",
    "一\nhttps://example.com/a_b二\nhttps://example.com/c_d",
  ],
  [
    "link and raw URL",
    "[一](https://example.com/a_b_c)\nhttps://example.com/d_e_f",
    "一\nhttps://example.com/a_b_c\nhttps://example.com/d_e_f",
  ],
  [
    "plain URL trailing underscore",
    "https://example.com/a_b_",
    "https://example.com/a_b_",
  ],
  [
    "URL inside emphasis",
    "**https://example.com/a_b_c**",
    "https://example.com/a_b_c",
  ],
  [
    "URL inside underscore emphasis",
    "_https://example.com/a_b_c_",
    "https://example.com/a_b_c",
  ],
  [
    "URL ending an emphasis span",
    "**查看 https://example.com/a_b_c**",
    "查看 https://example.com/a_b_c",
  ],
  [
    "URL inside nested emphasis",
    "**_https://example.com/a_b_c_**",
    "https://example.com/a_b_c",
  ],
  [
    "URL inside inline code",
    "`https://example.com/a_b_c`",
    "https://example.com/a_b_c",
  ],
  [
    "formatting next to URL",
    "**详情**：https://example.com/a_b_c\n_结束_",
    "详情：https://example.com/a_b_c\n结束",
  ],
  [
    "HTTP and other schemes",
    "http://example.com/a_b_c ftp://example.com/d_e_f mailto:a_b_c@example.com",
    "http://example.com/a_b_c ftp://example.com/d_e_f mailto:a_b_c@example.com",
  ],
  ["relative destination", "[文件](../a_b_c.md)", "文件\n../a_b_c.md"],
  ["autolink", "<https://example.com/a_b_c>", "<https://example.com/a_b_c>"],
  [
    "malformed link",
    "[详情](https://example.com/a_b_c",
    "[详情](https://example.com/a_b_c",
  ],
  ["image removal", "前![图](https://example.com/img_(a_(b)).png)后", "前后"],
  [
    "existing formatting",
    "**粗体** *斜体* __粗体__ _斜体_ ~~删除~~ `代码`",
    "粗体 斜体 粗体 斜体 删除 代码",
  ],
  [
    "code block",
    "```text\nhttps://example.com/a_b_c\n```",
    "https://example.com/a_b_c",
  ],
  [
    "table",
    "| **标题** | 地址 |\n| --- | --- |\n| 详情 | https://example.com/a_b_c |",
    "标题  地址\n\n详情  https://example.com/a_b_c",
  ],
  [
    "placeholder collision",
    "\uE0000\uE001 [详情](https://example.com/a_b_c)",
    "\uE0000\uE001 详情\nhttps://example.com/a_b_c",
  ],
];

for (const [name, input, expected] of cases) {
  test(name, () => assert.equal(markdownToPlainText(input), expected));
}

test("Markdown mode preserves supported formatting and URL bytes", () => {
  const text =
    "# 标题\n**粗体** ~~删除~~ `a_中文_c`\n| 标题 |\n| --- |\n[查看详情](https://example.com/a_中文_(b))\nhttps://example.com/a_中文_c\n```js\n![code](a_(b))\n```";
  assert.equal(formatMessageText(text, "markdown"), text);
});

test("Markdown mode filters unsupported constructs without breaking nested links", () => {
  assert.equal(
    formatMessageText(
      "##### 标题\n*中文* ***中文*** _中文_ ___中文___ **粗体**\n![图](https://example.com/a_(b_(c)).png)",
      "markdown",
    ),
    "标题\n中文 中文 中文 中文 **粗体**\n",
  );
  assert.equal(
    formatMessageText("*English* **https://example.com/a_中文_c**", "markdown"),
    "*English* **https://example.com/a_中文_c**",
  );
});
