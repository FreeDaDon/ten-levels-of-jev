<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { abortAgent, promptAgent, startAgent, stopAgent, subscribeAgent, type AgentItem } from "../lib/agent-api";
import { answerHTML, esc } from "../lib/viz";
import { MODELS, countTokens, money } from "../lib/cost";

/**
 * The agent window for levels 6 to 10. One real Claude Code session per mount. You prompt it, the box
 * locks, Go becomes Stop, and the stream fills with one line per thing that happened: your
 * prompt, the agent's text, each tool call, each Jev call, the level's hook decision. Click a
 * line for the details. The header shows the model, the two costs, and the context bar.
 */
const props = defineProps<{ n: number; option: string; config: Record<string, unknown>; prompt: string; then?: string }>();

type Kind = "user" | "agent" | "tool" | "jev" | "hook" | "compact" | "system" | "error";
interface Row {
  id: string;
  kind: Kind;
  tag: string;
  title: string;
  status?: "running" | "ok" | "error";
  ms?: number;
  details: Record<string, unknown>;
  html?: string;
}

const sessionId = ref("");
const model = ref("");
const contextPct = ref<number | null>(null);
const contextTokens = ref<number | null>(null);
const contextWindow = ref<number | null>(null);
const llmCost = ref(0);
const jevCost = ref(0);
const jevCalls = ref(0);
/** Files Jev judged on the agent's behalf. The agent never loaded them, so this is context it never paid for. */
const avoided = ref<{ path: string; tokens: number; usd: number }[]>([]);
const avoidedTokens = computed(() => avoided.value.reduce((n, a) => n + a.tokens, 0));
const avoidedJevUsd = computed(() => avoided.value.reduce((n, a) => n + a.usd, 0));
const avoidedRows = computed(() => MODELS.filter((m) => !m.jev).map((m) => {
  const usd = (avoidedTokens.value * m.inPerM) / 1e6;
  return { name: m.name, inPerM: m.inPerM, usd, times: avoidedJevUsd.value > 0 ? usd / avoidedJevUsd.value : 0 };
}));
const running = ref(false);
const starting = ref(true);
const error = ref("");
const text = ref(props.prompt);
const rows = ref<Row[]>([]);
const open = ref<Row | null>(null);
const listEl = ref<HTMLDivElement | null>(null);
let unsubscribe: (() => void) | null = null;
const toolRows = new Map<string, Row>();

const shortModel = computed(() => model.value);
const ctxLabel = computed(() => (contextTokens.value === null ? "context, waiting for the first reply" : `${contextTokens.value.toLocaleString("en-US")} tokens in context, ${(contextPct.value ?? 0).toFixed(1)}% of ${fmt(contextWindow.value)}`));
const fmt = (n: number | null) => (n === null ? "" : n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n));
const first = (s: string, n = 110) => { const line = (s ?? "").trim().split("\n")[0] ?? ""; return line.length > n ? line.slice(0, n - 1) + "…" : line; };
const textOf = (m: any) => (Array.isArray(m?.content) ? m.content.filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n") : "");
const thinkingOf = (m: any) => (Array.isArray(m?.content) ? m.content.filter((c: any) => c.type === "thinking").map((c: any) => c.thinking ?? c.text ?? "").join("\n") : "");
/** The one argument that says what the call is about: the command, the path, the question, the globs, or the state's first line. */
const argSummary = (_name: string, args: any) => {
  if (!args || typeof args !== "object") return "";
  if (Array.isArray(args.paths_or_globs)) return first(args.paths_or_globs.join(", "), 90);
  if (Array.isArray(args.candidates)) return first(`${args.question ?? ""} (${args.candidates.length} files)`, 90);
  const v = args.command ?? args.path ?? args.pattern ?? args.question ?? args.note_to_self ?? args.state ?? Object.values(args)[0];
  return typeof v === "string" ? first(v, 90) : v === undefined ? "" : first(JSON.stringify(v), 90);
};

/** Newest last. The list is a column-reverse flex box, so the bottom stays pinned and older rows scroll up. */
function add(row: Omit<Row, "id">): Row {
  const r = { id: `${rows.value.length}-${Date.now()}`, ...row };
  rows.value.push(r);
  return r;
}
const newestFirst = computed(() => rows.value.slice().reverse());

/** One answer's gist for a row title: yes 0.91, bug_report 0.88, 1.9 of 2. */
function gist(answers: Record<string, any>): string {
  return Object.entries(answers).slice(0, 3).map(([id, a]) => {
    if (a.type === "noul") return `${id} ${a.noul > 0.5 ? "yes" : "no"} ${a.noul.toFixed(2)}`;
    if (a.type === "choice") return `${id} ${a.choice} ${a.confidence.toFixed(2)}`;
    return `${id} ${a.score.toFixed(2)} of ${Object.keys(a.legend ?? {}).length - 1}`;
  }).join(", ");
}

function onItem({ event, data }: AgentItem) {
  switch (event) {
    case "session": model.value = data.model; return;
    case "state": if (data.model?.id) model.value = `${data.model.provider ?? ""}/${data.model.id}`.replace(/^\//, ""); return;
    case "stats":
      llmCost.value = Number(data.cost ?? 0);
      if (data.contextUsage) {
        contextPct.value = data.contextUsage.percent ?? null;
        contextTokens.value = data.contextUsage.tokens ?? null;
        contextWindow.value = data.contextUsage.contextWindow ?? null;
      }
      return;
    case "prompt": add({ kind: "user", tag: "you", title: first(data.message), details: { prompt: data.message } }); return;
    case "agent_start": running.value = true; return;
    case "agent_settled": running.value = false; return;
    case "abort": running.value = false; add({ kind: "system", tag: "stop", title: "Stopped", details: {} }); return;
    case "message_end": {
      const m = data.message;
      if (m?.role !== "assistant") return;
      const t = textOf(m); const think = thinkingOf(m);
      if (!t && !think) return;
      add({ kind: "agent", tag: "agent", title: first(t) || "(thinking only)", details: { text: t, thinking: think || undefined, usage: m.usage } });
      return;
    }
    case "tool_execution_start": {
      const r = add({ kind: "tool", tag: data.toolName, title: argSummary(data.toolName, data.args), status: "running", details: { tool: data.toolName, args: data.args } });
      toolRows.set(data.toolCallId, r);
      return;
    }
    case "tool_execution_end": {
      const r = toolRows.get(data.toolCallId);
      const out = Array.isArray(data.result?.content) ? data.result.content.filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n") : "";
      if (r) { r.status = data.isError ? "error" : "ok"; r.details = { ...r.details, result: out, isError: data.isError }; }
      return;
    }
    case "jev": {
      const d = data;
      if (d.kind === "jev") {
        jevCalls.value++;
        const usd = Number(d.usage?.cost ?? (d.usage?.input_tokens ?? 0) * 0.042 / 1e6);
        jevCost.value += usd;
        if (String(d.source).startsWith("ask_jev_file") && typeof d.state?.content === "string") {
          avoided.value.push({ path: String(d.state.path ?? "?"), tokens: countTokens(d.state.content), usd });
        }
        add({ kind: "jev", tag: "jev", title: `${d.source}: ${gist(d.answers)}`, ms: d.ms, details: d,
          html: Object.entries(d.answers).map(([id, a]) => answerHTML(id, a)).join("") });
      } else if (d.kind === "hook") {
        const pct = d.usage?.tokens !== undefined ? `, ${Math.round(d.usage.tokens / 1000)}k tokens` : "";
        const title = d.tier ? `${d.tier}${pct}: ${d.reason}`
          : d.block !== undefined ? `${d.block ? "blocked" : "allowed"} ${d.tool}: ${d.reason}`
          : d.flag !== undefined ? `${d.flag ? "flagged" : "clean"} ${d.tool} output, injection ${Number(d.noul).toFixed(2)}`
          : (d.instructions ?? "decided");
        add({ kind: "hook", tag: d.hook, title, details: d });
      } else if (d.kind === "compact") {
        return; // the compact_now tool row already shows the note
      } else if (d.kind === "compact-done") {
        add({ kind: "compact", tag: "compacted", title: `context now ${Number(d.usage?.pct ?? 0).toFixed(1)}%`, details: d });
      } else if (d.kind === "ledger") {
        add({ kind: "system", tag: "ledger", title: d.summary, details: d });
      } else if (d.kind === "error") {
        add({ kind: "error", tag: "error", title: `${d.hook ?? "hook"}: ${d.message}`, details: d });
      } else {
        add({ kind: "system", tag: d.kind, title: first(JSON.stringify(d)), details: d });
      }
      return;
    }
    case "compaction_end":
      add({ kind: "compact", tag: "compacted", title: data.result
        ? `${fmt(data.result.tokensBefore ?? null)} tokens to about ${fmt(data.result.estimatedTokensAfter ?? null)}`
        : `did not run: ${data.error ?? data.errorMessage ?? (data.aborted ? "aborted" : "no result")}`, details: data });
      return;
    case "error": add({ kind: "error", tag: "error", title: data.message, details: data }); return;
    case "closed": running.value = false; if (!starting.value) add({ kind: "system", tag: "session", title: "Session ended", details: data }); return;
    default: return;
  }
}

async function boot() {
  starting.value = true;
  error.value = "";
  rows.value = [];
  toolRows.clear();
  llmCost.value = 0; jevCost.value = 0; jevCalls.value = 0;
  avoided.value = [];
  contextPct.value = null;
  try {
    const { id, model: m } = await startAgent(props.n, props.option, props.config);
    sessionId.value = id;
    model.value = m;
    unsubscribe = subscribeAgent(id, onItem);
  } catch (err) {
    error.value = (err as Error).message;
  } finally {
    starting.value = false;
  }
}

async function go() {
  if (!sessionId.value || starting.value) return;
  if (running.value) {
    try { await abortAgent(sessionId.value); } catch (err) { error.value = (err as Error).message; }
    return;
  }
  const message = text.value.trim();
  if (!message) return;
  error.value = "";
  running.value = true;
  try {
    await promptAgent(sessionId.value, message);
    text.value = "";
  } catch (err) {
    running.value = false;
    error.value = (err as Error).message;
  }
}

function hotkey(e: KeyboardEvent) {
  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); go(); }
  if (e.key === "Escape" && open.value) open.value = null;
}

async function restart() {
  if (unsubscribe) unsubscribe();
  if (sessionId.value) await stopAgent(sessionId.value);
  sessionId.value = "";
  text.value = props.prompt;
  await boot();
}
defineExpose({ restart });

onMounted(() => { window.addEventListener("keydown", hotkey); boot(); });
onBeforeUnmount(() => {
  window.removeEventListener("keydown", hotkey);
  if (unsubscribe) unsubscribe();
  if (sessionId.value) stopAgent(sessionId.value);
});
watch(() => props.prompt, (p) => { if (!running.value) text.value = p; });

const pretty = (v: unknown) => esc(typeof v === "string" ? v : JSON.stringify(v, null, 2));
</script>

<template>
  <div class="chat">

    <div ref="listEl" class="chat-rows">
      <div v-if="!rows.length" class="meta chat-empty">{{ starting ? "Starting the agent…" : "Send the prompt below. Every tool call, Jev call, and hook decision shows up here as one line. Click a line for the details." }}</div>
      <button v-for="r in newestFirst" :key="r.id" class="row" :class="[r.kind, r.status]" @click="open = r">
        <span class="row-tag">{{ r.tag }}</span>
        <span class="row-title">{{ r.title }}</span>
        <span v-if="r.status === 'running'" class="row-ms">running</span>
        <span v-else-if="r.ms" class="row-ms">{{ r.ms }} ms</span>
      </button>
    </div>

    <div class="chat-input">
      <textarea v-model="text" rows="3" :disabled="running || starting" placeholder="Prompt the agent"></textarea>
      <div class="chat-actions">
        <button v-if="then && !running" class="ghost then" :disabled="starting" @click="text = then">Then: {{ first(then, 70) }}</button>
        <span class="spacer"></span>
        <span v-if="error" class="chat-error">{{ error }}</span>
        <button class="run" :class="{ stop: running }" :disabled="starting || !sessionId" @click="go">{{ running ? "Stop" : "Go" }} <kbd v-if="!running">⌘↵</kbd></button>
      </div>
    </div>

    <div class="chat-head">
      <span class="chat-model" :title="model">{{ shortModel || "starting…" }}</span>
      <span class="spacer"></span>
      <span class="chat-cost"><b>LLM</b> {{ money(llmCost) }}</span>
      <span class="chat-cost"><b>Jev</b> {{ money(jevCost) }}<small v-if="jevCalls"> {{ jevCalls }} call{{ jevCalls === 1 ? "" : "s" }}</small></span>
      <span class="ctx" :title="ctxLabel">
        <span class="ctx-track"><span class="ctx-fill" :style="{ width: `${Math.min(100, contextPct ?? 0)}%` }"></span></span>
        <span class="ctx-label">{{ contextTokens === null ? "context" : `${fmt(contextTokens)} tokens` }}</span>
      </span>
    </div>

    <div v-if="avoided.length" class="saved">
      <div class="saved-head">
        <b>Files the agent did not read</b>
        <span class="meta">{{ avoided.length }} file{{ avoided.length === 1 ? "" : "s" }}, {{ avoidedTokens.toLocaleString("en-US") }} tokens judged by Jev and never loaded into the agent's context</span>
      </div>
      <table class="cost saved-table">
        <thead><tr><th class="left">Model</th><th>$ / 1M in</th><th>one read of these files</th><th>vs Jev</th></tr></thead>
        <tbody>
          <tr v-for="r in avoidedRows" :key="r.name"><td class="left">{{ r.name }}</td><td>{{ money(r.inPerM) }}</td><td>{{ money(r.usd) }}</td><td>{{ r.times ? `${r.times.toFixed(0)}x` : "" }}</td></tr>
          <tr class="jev"><td class="left">Jev, what it actually charged</td><td>$0.042</td><td>{{ money(avoidedJevUsd) }}</td><td>1x</td></tr>
        </tbody>
      </table>
      <div class="meta">Rough on purpose: the read once column is the input price for loading the files a single time. The agent would pay it again on every later turn until compaction, and the files would crowd out everything else.</div>
    </div>

    <div v-if="open" class="modal-backdrop" @click.self="open = null">
      <div class="modal detail" role="dialog" aria-modal="true">
        <div class="modal-head">
          <div><div class="lvl">{{ open.tag }}</div><h2>{{ open.title }}</h2></div>
          <span class="spacer"></span>
          <button class="ghost" @click="open = null">Close</button>
        </div>
        <div class="detail-body">
          <template v-if="open.kind === 'jev'">
            <h4>Answers</h4>
            <div v-html="open.html"></div>
            <h4>State</h4>
            <pre class="code" v-html="pretty(open.details.state)"></pre>
            <h4>Questions</h4>
            <pre class="code" v-html="pretty(open.details.questions)"></pre>
            <div class="meta">{{ open.details.model }}, {{ open.details.ms }} ms, {{ (open.details.usage as any)?.input_tokens }} tokens in, {{ (open.details.usage as any)?.output_tokens }} out</div>
          </template>
          <template v-else-if="open.kind === 'hook'">
            <h4>Decision</h4>
            <pre class="code" v-html="pretty(Object.fromEntries(Object.entries(open.details).filter(([k]) => !['kind', 'at', 'hook', 'message', 'instructions', 'banner'].includes(k))))"></pre>
            <template v-if="open.details.message"><h4>Injected into the agent's next call</h4><pre class="code">{{ open.details.message }}</pre></template>
            <template v-else-if="open.details.tier === 'silent'"><div class="meta">Silent. Nothing was injected.</div></template>
            <template v-if="open.details.instructions"><h4>Compaction instructions</h4><pre class="code">{{ open.details.instructions }}</pre></template>
            <template v-if="open.details.banner"><h4>Banner put above the output</h4><pre class="code">{{ open.details.banner }}</pre></template>
          </template>
          <template v-else-if="open.kind === 'tool'">
            <h4>Arguments</h4>
            <pre class="code" v-html="pretty(open.details.args)"></pre>
            <h4>Result</h4>
            <pre class="code">{{ open.details.result ?? "(running)" }}</pre>
          </template>
          <template v-else-if="open.kind === 'agent'">
            <template v-if="open.details.thinking"><h4>Thinking</h4><pre class="code">{{ open.details.thinking }}</pre></template>
            <h4>Text</h4>
            <pre class="code">{{ open.details.text }}</pre>
          </template>
          <template v-else>
            <pre class="code" v-html="pretty(open.details)"></pre>
          </template>
        </div>
      </div>
    </div>
  </div>
</template>
