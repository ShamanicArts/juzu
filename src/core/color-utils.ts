function normalizeHex(input: string): string | null {
  const s = (input || "").trim();
  if (!s.startsWith("#")) return null;
  const raw = s.slice(1);
  if (raw.length === 3) return raw.split("").map((c) => c + c).join("");
  if (raw.length === 6) return raw;
  return null;
}

function toRgb(hex: string): [number, number, number] {
  return [
    Number.parseInt(hex.slice(0, 2), 16),
    Number.parseInt(hex.slice(2, 4), 16),
    Number.parseInt(hex.slice(4, 6), 16),
  ];
}

function toHex(n: number): string {
  const v = Math.max(0, Math.min(255, Math.round(n)));
  return v.toString(16).padStart(2, "0");
}

export function mixHex(baseHex: string, overlayHex: string, ratio: number): string {
  const base = normalizeHex(baseHex);
  const overlay = normalizeHex(overlayHex);
  if (!base || !overlay) return overlayHex || baseHex;

  const t = Math.max(0, Math.min(1, ratio));
  const [br, bg, bb] = toRgb(base);
  const [or, og, ob] = toRgb(overlay);
  const r = br + (or - br) * t;
  const g = bg + (og - bg) * t;
  const b = bb + (ob - bb) * t;
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}
