import assert from "node:assert/strict";
import test from "node:test";

import type { MailTaxonomyItemDto } from "../src/api/mailTaxonomyClient.ts";
import {
  buildMailTaxonomyFolderTree,
  isMailTaxonomyFolderDescendant,
  mailTaxonomyDefaultColor,
  mailTaxonomyItemMatchesName,
} from "../src/mail/mailTaxonomy.ts";

function taxonomyItem(id: string, name: string, parentId: string | null): MailTaxonomyItemDto {
  return {
    id,
    kind: "folder",
    name,
    parent_id: parentId,
    color: "#d9ff38",
    sort_order: 0,
    system: false,
  };
}

test("taxonomy colors cycle deterministically for folders and labels", () => {
  assert.equal(mailTaxonomyDefaultColor("folder", 0), "#d9ff38");
  assert.equal(mailTaxonomyDefaultColor("folder", 5), "#d9ff38");
  assert.equal(mailTaxonomyDefaultColor("label", 0), "#06b6d4");
  assert.equal(mailTaxonomyDefaultColor("label", -1), "#f43f5e");
});

test("taxonomy name matching ignores surrounding whitespace and case", () => {
  assert.equal(mailTaxonomyItemMatchesName(taxonomyItem("a", " Work ", null), "work"), true);
  assert.equal(mailTaxonomyItemMatchesName(taxonomyItem("a", "Work", null), "Personal"), false);
});

test("taxonomy tree orders descendants and promotes invalid parents to roots", () => {
  const root = taxonomyItem("root", "Root", null);
  const child = taxonomyItem("child", "Child", "root");
  const grandchild = taxonomyItem("grandchild", "Grandchild", "child");
  const orphan = taxonomyItem("orphan", "Orphan", "missing");

  assert.deepEqual(
    buildMailTaxonomyFolderTree([child, orphan, grandchild, root]).map(({ item, depth }) => [
      item.id,
      depth,
    ]),
    [
      ["orphan", 0],
      ["root", 0],
      ["child", 1],
      ["grandchild", 2],
    ],
  );
});

test("taxonomy descendant checks terminate safely when parents form a cycle", () => {
  const root = taxonomyItem("root", "Root", null);
  const child = taxonomyItem("child", "Child", "root");
  const cycleA = taxonomyItem("cycle-a", "Cycle A", "cycle-b");
  const cycleB = taxonomyItem("cycle-b", "Cycle B", "cycle-a");

  assert.equal(isMailTaxonomyFolderDescendant([root, child], "child", "root"), true);
  assert.equal(isMailTaxonomyFolderDescendant([root, child], "root", "child"), false);
  assert.equal(
    isMailTaxonomyFolderDescendant([cycleA, cycleB], "cycle-a", "unrelated"),
    false,
  );
});
