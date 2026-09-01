import assert from "node:assert/strict";
import test from "node:test";

import {
  COMPOSE_EMOJI_CATEGORIES,
  appendComposeRecipientValue,
  composeContactPickerAriaLabel,
  composeFontCss,
  filterComposeEmojiCategories,
  joinComposeAddressList,
  parseComposeAddressList,
} from "../src/compose/composeData.ts";

test("parses and joins compose recipient lists using the existing separators", () => {
  assert.deepEqual(
    parseComposeAddressList("first@example.com; second@example.com\nthird@example.com"),
    ["first@example.com", "second@example.com", "third@example.com"],
  );
  assert.equal(
    joinComposeAddressList(["first@example.com", "second@example.com"]),
    "first@example.com, second@example.com",
  );
});

test("appends normalized recipients without duplicating an existing address", () => {
  assert.equal(
    appendComposeRecipientValue("first@example.com", "Second <SECOND@example.com>"),
    "first@example.com, second@example.com",
  );
  assert.equal(
    appendComposeRecipientValue("first@example.com, second@example.com", "SECOND@example.com"),
    "first@example.com, second@example.com",
  );
});

test("provides localized contact-picker labels for every recipient field", () => {
  assert.equal(composeContactPickerAriaLabel("to"), "选择收件人联系人");
  assert.equal(composeContactPickerAriaLabel("cc"), "选择抄送联系人");
  assert.equal(composeContactPickerAriaLabel("bcc"), "选择密送联系人");
});

test("resolves configured compose fonts and falls back to Arial", () => {
  assert.equal(composeFontCss("Georgia"), "Georgia, serif");
  assert.equal(composeFontCss("Unknown font"), "Arial, sans-serif");
});

test("returns only the active emoji category when search is empty", () => {
  const categories = filterComposeEmojiCategories("", "symbols");

  assert.equal(categories.length, 1);
  assert.equal(categories[0].id, "symbols");
  assert.equal(categories[0].icon, "₹&%");
});

test("happy and sad emoji searches use keyword data and remove duplicates", () => {
  const happy = filterComposeEmojiCategories("happy", "recent");
  const sad = filterComposeEmojiCategories("sad", "recent");
  const happySymbols = happy.flatMap((category) => category.emojis.map((emoji) => emoji.symbol));
  const sadSymbols = sad.flatMap((category) => category.emojis.map((emoji) => emoji.symbol));

  assert.equal(happy[0].id, "search");
  assert.equal(new Set(happySymbols).size, happySymbols.length);
  assert.ok(happySymbols.includes("😀"));
  assert.ok(happySymbols.includes("😂"));
  assert.ok(happySymbols.includes("😊"));
  assert.ok(sadSymbols.includes("😔"));
  assert.ok(sadSymbols.includes("😢"));
  assert.ok(sadSymbols.includes("😭"));
});

test("emoji symbol search returns one unique matching result", () => {
  const results = filterComposeEmojiCategories("😢", "recent");
  assert.deepEqual(
    results.flatMap((category) => category.emojis.map((emoji) => emoji.symbol)),
    ["😢"],
  );
});

test("emoji catalogue retains the expected Proton-style category set", () => {
  assert.deepEqual(
    COMPOSE_EMOJI_CATEGORIES.map((category) => category.id),
    ["recent", "smileys", "animals", "food", "activity", "travel", "objects", "symbols", "flags"],
  );
});
