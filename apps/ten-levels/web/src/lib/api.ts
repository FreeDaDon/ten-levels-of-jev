/** Typed client for the node server: level metadata and the SSE run stream. */

export interface OptionMeta {
  key: "A" | "B" | "C";
  name: string;
  file: string;
  /** Example states, Set A onward. */
  inputs: Record<string, unknown>[];
  call: string;
  code: string;
  /** Agent levels only: the hook set and tool allowlist the session loads. */
  hooks?: string;
  tools?: string[];
}

export interface LevelPayload {
  n: number;
  /** Levels 6 to 10 run a Claude Code session instead of a one shot call. */
  agent?: boolean;
  options: OptionMeta[];
}

export async function fetchLevel(n: number): Promise<LevelPayload> {
  const res = await fetch(`/api/level/${n}`);
  if (!res.ok) throw new Error(`level ${n}: HTTP ${res.status}`);
  return res.json();
}

export type StreamEvent = { event: string; data: any };

/** POST the edited input and yield every SSE event as it arrives. */
export async function* runOption(
  n: number,
  option: string,
  input: Record<string, unknown>,
): AsyncGenerator<StreamEvent> {
  const res = await fetch(`/api/run/${n}?option=${option}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ input }),
  });
  if (!res.ok || !res.body) throw new Error(`run: HTTP ${res.status}`);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let i: number;
    while ((i = buf.indexOf("\n\n")) >= 0) {
      const chunk = buf.slice(0, i);
      buf = buf.slice(i + 2);
      const ev = chunk.match(/^event: (.+)$/m);
      const data = chunk.match(/^data: (.+)$/m);
      if (ev && data) yield { event: ev[1], data: JSON.parse(data[1]) };
    }
  }
}
