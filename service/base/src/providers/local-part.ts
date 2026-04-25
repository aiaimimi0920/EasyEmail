import { createHash, randomBytes } from "node:crypto";

const WORDS_A = [
  "amber", "apex", "autumn", "azure", "brisk", "cinder", "cobalt", "coral",
  "crimson", "dawn", "drift", "ember", "fern", "frost", "golden", "harbor",
  "hazel", "indigo", "ivy", "juniper", "lunar", "maple", "mist", "nova",
  "onyx", "opal", "pearl", "quartz", "raven", "river", "scarlet", "shadow",
  "silver", "solar", "spruce", "stone", "sunset", "timber", "velvet", "winter",
];

const WORDS_B = [
  "anchor", "arrow", "aurora", "badger", "breeze", "brook", "cedar", "comet",
  "daisy", "falcon", "field", "finch", "forest", "garden", "glade", "harvest",
  "heron", "hollow", "island", "lagoon", "meadow", "meteor", "orchid", "otter",
  "pine", "radar", "ridge", "robin", "signal", "sparrow", "summit", "thunder",
  "trail", "valley", "voyage", "willow", "wind", "zephyr", "orbit", "lantern",
];

export function createMailboxLocalPart(hostId: string, sessionId: string): string {
  const seed = `${hostId}:${sessionId}:${Date.now()}:${randomBytes(16).toString("hex")}`;
  const digest = createHash("sha256").update(seed).digest("hex");
  const left = WORDS_A[Number.parseInt(digest.slice(0, 2), 16) % WORDS_A.length];
  const right = WORDS_B[Number.parseInt(digest.slice(2, 4), 16) % WORDS_B.length];
  const suffix = digest.slice(4, 10);
  return `${left}${right}${suffix}`;
}
