import { DEFAULT_UI_TOKENS, setUiTokens, type UiTokens } from "./ui-tokens";

export interface JjVizRuntimeConfig {
  theme: {
    name: string;
  };
  uiTokens: UiTokens;
  graph: {
    nodeRadius: number;
    laneWidth: number;
    ySpacing: number;
    canvasPadding: number;
    textColumnGap: number;
  };
  web: {
    pollIntervalMs: number;
    navigationLockDefault: boolean;
  };
  tui: {
    sidebarBreakpointWidth: number;
    sidebarMinHeight: number;
    stackedSidebarRatio: number;
  };
}

type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K];
};

export const DEFAULT_RUNTIME_CONFIG: JjVizRuntimeConfig = {
  theme: {
    name: "slate",
  },
  uiTokens: DEFAULT_UI_TOKENS,
  graph: {
    nodeRadius: 5,
    laneWidth: 24,
    ySpacing: 84,
    canvasPadding: 50,
    textColumnGap: 60,
  },
  web: {
    pollIntervalMs: 3000,
    navigationLockDefault: false,
  },
  tui: {
    sidebarBreakpointWidth: 90,
    sidebarMinHeight: 16,
    stackedSidebarRatio: 0.5,
  },
};

function deepClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value));
}

function deepMerge<T>(base: T, patch: DeepPartial<T> | undefined): T {
  if (!patch) return deepClone(base);
  const out: any = Array.isArray(base) ? [...(base as any)] : { ...(base as any) };
  for (const [k, v] of Object.entries(patch as any)) {
    if (v === undefined) continue;
    const prev = out[k];
    if (Array.isArray(v)) {
      out[k] = [...v];
    } else if (v && typeof v === "object" && prev && typeof prev === "object" && !Array.isArray(prev)) {
      out[k] = deepMerge(prev, v);
    } else {
      out[k] = v;
    }
  }
  return out as T;
}

let runtimeConfig: JjVizRuntimeConfig = deepClone(DEFAULT_RUNTIME_CONFIG);

export function getRuntimeConfig(): JjVizRuntimeConfig {
  return runtimeConfig;
}

export function applyRuntimeConfig(next: DeepPartial<JjVizRuntimeConfig> | JjVizRuntimeConfig) {
  runtimeConfig = deepMerge(DEFAULT_RUNTIME_CONFIG, next as DeepPartial<JjVizRuntimeConfig>);
  setUiTokens(runtimeConfig.uiTokens);
}
