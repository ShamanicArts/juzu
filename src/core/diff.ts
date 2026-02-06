export interface FileDiffChunk {
  path: string;
  diff: string;
}

function parsePathFromHeader(header: string): string {
  const m = header.match(/^diff --git a\/(.+?) b\/(.+)$/);
  if (!m) return "(unknown)";
  return m[2] || m[1] || "(unknown)";
}

export function splitDiffByFile(diffText: string): FileDiffChunk[] {
  const text = (diffText || "").trim();
  if (!text) return [];

  const lines = text.split(/\r?\n/);
  const starts: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i]?.startsWith("diff --git ")) starts.push(i);
  }

  if (starts.length === 0) {
    return [{ path: "(full diff)", diff: text }];
  }

  const chunks: FileDiffChunk[] = [];
  for (let i = 0; i < starts.length; i++) {
    const start = starts[i]!;
    const end = i + 1 < starts.length ? starts[i + 1]! : lines.length;
    const chunkLines = lines.slice(start, end);
    const header = chunkLines[0] || "";
    chunks.push({
      path: parsePathFromHeader(header),
      diff: chunkLines.join("\n").trimEnd(),
    });
  }

  return chunks;
}
