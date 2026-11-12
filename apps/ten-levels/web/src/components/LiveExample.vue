<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import type { OptionMeta } from "../lib/api";
import { runOption } from "../lib/api";
import { highlightTs } from "../lib/highlight";
import { answerHTML, esc } from "../lib/viz";
import InputEditor from "./InputEditor.vue";
import CodeView from "./CodeView.vue";
import CostTable from "./CostTable.vue";
import RunVisual from "./RunVisual.vue";
import AgentChat from "./AgentChat.vue";
import { visual } from "../lib/store";
import type { StreamEvent } from "../lib/api";
import { LEVELS } from "../lib/levels";
import type { JevUsage } from "../lib/cost";

const props = defineProps<{ n: number; option: OptionMeta; agent?: boolean }>();

/* Agent levels: the input set holds the prompt, the suggested follow up, and the level config. */
const PROMPT_KEYS = new Set(["prompt", "then"]);
const agentConfig = computed(() => Object.fromEntries(Object.entries(input.value).filter(([k]) => !PROMPT_KEYS.has(k))));
const agentPrompt = computed(() => String(input.value.prompt ?? ""));
const agentThen = computed(() => (typeof input.value.then === "string" ? input.value.then : undefined));
const chat = ref<InstanceType<typeof AgentChat> | null>(null);
/** The editor shows only the config; the prompt lives in the chat box. */
const configModel = computed({
  get: () => agentConfig.value,
  set: (v: Record<string, unknown>) => { input.value = { ...input.value, ...v }; },
});

const input = ref<Record<string, unknown>>({});
const setIndex = ref(0);
const setNames = computed(() => props.option.inputs.map((_, i) => `Set ${String.fromCharCode(65 + i)}`));

function loadSet(i: number) {
  setIndex.value = i;
  input.value = JSON.parse(JSON.stringify(props.option.inputs[i]));
  resetOutputs();
}
const running = ref(false);
const status = ref("Waiting for Run live");
const sentHtml = ref("");
const receivedHtml = ref("");
const sentText = ref("");
const receivedText = ref("");
const usage = ref<JevUsage | null>(null);

/* Visual mode: the modal replays the stream on the hero while the results fill in underneath. */
const visualOpen = ref(false);
const visualEvents = ref<StreamEvent[]>([]);
const visualDone = ref(false);
const levelTitle = LEVELS.find((l) => l.n === props.n)?.title ?? "";
const answersHtml = ref("");
let lastAnswers: Record<string, any> = {};

/** Answers with the returned chips leading the first one. Re-rendered when the decision arrives. */
function renderAnswers() {
  // One field returned: the value alone. Several: key and value, so they stay readable.
  const solo = result.value.length === 1;
  const chips = result.value.map((r) => `<span class="chip lit">${solo ? "" : `<b>${esc(r.key)}</b> `}${esc(r.value)}</span>`).join("");
  answersHtml.value = Object.entries(lastAnswers).map(([id, a], i) => answerHTML(id, a, i === 0 ? chips : "")).join("");
}
const result = ref<{ key: string; value: string }[]>([]);
const errorText = ref("");
const calls = ref(0);
const vizEl = ref<HTMLDivElement | null>(null);

function resetOutputs() {
  status.value = "Waiting for Run live";
  sentHtml.value = "";
  receivedHtml.value = "";
  sentText.value = "";
  receivedText.value = "";
  usage.value = null;
  answersHtml.value = "";
  result.value = [];
  lastAnswers = {};
  errorText.value = "";
  calls.value = 0;
  if (vizEl.value) {
    vizEl.value.innerHTML = "";
    vizEl.value.classList.remove("on");
  }
}

watch(
  () => props.option,
  () => loadSet(0),
  { immediate: true },
);

function resetExample() {
  loadSet(setIndex.value);
}

/**
 * The returned value as key and value chips. Objects by key, arrays by index, scalars as one chip.
 * Booleans read yes or no. Keys the bars already show (noul, confidence) are left out.
 */
const SHOWN_ON_BARS = new Set(["noul", "confidence"]);
function toChips(output: unknown): { key: string; value: string }[] {
  const show = (v: unknown) => (typeof v === "boolean" ? (v ? "yes" : "no") : typeof v === "string" ? v : JSON.stringify(v));
  if (Array.isArray(output)) return output.map((v, i) => ({ key: String(i), value: show(v) }));
  if (output && typeof output === "object") {
    return Object.entries(output)
      .filter(([k]) => !SHOWN_ON_BARS.has(k))
      .map(([k, v]) => ({ key: k, value: show(v) }));
  }
  return [{ key: "result", value: show(output) }];
}

/** Cmd+Enter (Ctrl+Enter elsewhere) runs the example, even with the cursor in the input editor. */
function hotkey(e: KeyboardEvent) {
  if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && !running.value) {
    e.preventDefault();
    run();
  }
}
onMounted(() => window.addEventListener("keydown", hotkey));
onBeforeUnmount(() => window.removeEventListener("keydown", hotkey));

async function run() {
  running.value = true;
  resetOutputs();
  status.value = "Running live ...";
  visualEvents.value = [];
  visualDone.value = false;
  visualOpen.value = visual.value && !props.agent;
  let ms = 0;
  let model = "";
  try {
    for await (const { event, data } of runOption(props.n, props.option.key, input.value)) {
      if (visualOpen.value) visualEvents.value.push({ event, data });
      if (event === "request") {
        calls.value++;
        // The exact request body, as POSTed to the decision endpoint.
        sentText.value = JSON.stringify({ model: data.model, state: data.state, questions: data.questions }, null, 2);
        sentHtml.value = highlightTs(sentText.value, "json");
        status.value = `Request ${calls.value} to ${data.model} ...`;
      } else if (event === "response") {
        ms += data.result.meta.elapsedMs;
        model = data.result.model;
        const { answers } = data.result;
        usage.value = data.result.usage;
        lastAnswers = answers;
        renderAnswers();
        // The exact response body, as returned by the decision endpoint.
        receivedText.value = JSON.stringify({ model, answers, usage: data.result.usage }, null, 2);
        receivedHtml.value = highlightTs(receivedText.value, "json");
        status.value = `${calls.value} call${calls.value === 1 ? "" : "s"}, ${ms} ms, ${model}`;
      } else if (event === "decision") {
        result.value = toChips(data.output);
        renderAnswers();
      } else if (event === "option-error") {
        errorText.value = data.error;
        status.value = "Error";
      }
    }
  } catch (err) {
    errorText.value = (err as Error).message;
    status.value = "Error";
  } finally {
    running.value = false;
    visualDone.value = true;
    if (status.value === "Running live ...") status.value = "Done";
  }
}
</script>

<template>
  <div class="example-wrap">
    <RunVisual
      v-if="visualOpen"
      :n="n"
      :title="levelTitle"
      :option="option.key"
      :events="visualEvents"
      :finished="visualDone"
      @close="visualOpen = false"
    />
    <div class="section-head">
      <h2>Live Example</h2>
      <span class="meta">Option {{ option.key }}, {{ option.name }}</span>
      <span class="spacer"></span>
      <button v-if="agent" class="ghost" @click="loadSet(setIndex); chat?.restart()">New session</button>
      <button v-else class="ghost" :disabled="running" @click="resetExample">Reset</button>
      <button v-if="!agent" class="run" :disabled="running" @click="run">Run live <kbd>⌘↵</kbd></button>
    </div>

    <div v-if="agent" class="example agent">
      <section class="glass">
        <h3>Inputs</h3>
        <div class="meta">A prompt set and the level config</div>
        <h4>Input Examples</h4>
        <div class="sets">
          <button v-for="(name, i) in setNames" :key="name" class="set" :class="{ selected: i === setIndex }" @click="loadSet(i)">{{ name }}</button>
        </div>
        <InputEditor v-model="configModel" />
        <div class="meta">Changes apply to the next session. Use New session after editing.</div>
      </section>

      <section class="glass chat-panel">
        <h3>Agent</h3>
        <div class="meta">A real Claude Code session in the sandbox repo. One line per thing that happens.</div>
        <AgentChat ref="chat" :key="option.key" :n="n" :option="option.key" :config="agentConfig" :prompt="agentPrompt" :then="agentThen" />
      </section>

      <CodeView :file="option.file" :call="option.call" :code="option.code" :input="input" />
    </div>

    <div v-else class="example">
      <section class="glass">
        <h3>Inputs</h3>
        <div class="meta">Edit the state the code receives</div>
        <h4>Input Examples</h4>
        <div class="sets">
          <button
            v-for="(name, i) in setNames"
            :key="name"
            class="set"
            :class="{ selected: i === setIndex }"
            :disabled="running"
            @click="loadSet(i)"
          >{{ name }}</button>
        </div>
        <InputEditor v-model="input" />
        <template v-if="sentHtml">
          <h4>Sent<span v-if="calls > 1" class="meta-inline">call {{ calls }}</span></h4>
          <div class="meta">POST /decisions, the request body</div>
          <pre class="code" v-html="sentHtml"></pre>
        </template>
      </section>

      <section class="glass">
        <h3>Outputs</h3>
        <div class="meta">{{ status }}</div>
        <div ref="vizEl" class="viz-slot"></div>
        <template v-if="answersHtml">
          <h4>Answers</h4>
          <div v-html="answersHtml"></div>
        </template>
        <pre v-if="errorText" class="code">{{ errorText }}</pre>
        <template v-if="receivedHtml">
          <h4>Received<span v-if="calls > 1" class="meta-inline">call {{ calls }}</span></h4>
          <div class="meta">The response body</div>
          <pre class="code" v-html="receivedHtml"></pre>
        </template>
      </section>

      <CostTable v-if="usage && receivedText" :sent="sentText" :received="receivedText" :usage="usage" />

      <CodeView :file="option.file" :call="option.call" :code="option.code" :input="input" />
    </div>
  </div>
</template>
