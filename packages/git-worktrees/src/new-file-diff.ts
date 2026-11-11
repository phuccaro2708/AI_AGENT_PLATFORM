/** Unified diff of a new (untracked) file, built from bytes already read, in git's "new file" shape. */
export function newFileDiff(file: string, bytes: Buffer): string {
  const head = `diff --git a/${file} b/${file}\nnew file mode 100644\n`;
  if (bytes.length === 0) return head;
  if (bytes.includes(0)) return `${head}Binary files /dev/null and b/${file} differ\n`;
  const text = bytes.toString("utf8");
  const endsWithNewline = text.endsWith("\n");
  const lines = (endsWithNewline ? text.slice(0, -1) : text).split("\n");
  const body = lines.map((l) => `+${l}\n`).join("");
  const count = lines.length === 1 ? "" : `,${lines.length}`;
  const tail = endsWithNewline ? "" : "\\ No newline at end of file\n";
  return `${head}--- /dev/null\n+++ b/${file}\n@@ -0,0 +1${count} @@\n${body}${tail}`;
}
