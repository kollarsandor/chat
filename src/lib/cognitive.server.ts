import { supabaseAdmin } from "@/integrations/supabase/client.server";
import type { SupabaseClient } from "@supabase/supabase-js";

type DbTables = {
  agent_skills: {
    Row: {
      id: string;
      name: string;
      dsl: string;
      terms: string;
      vector: number[] | string | null;
      successes: number;
      failures: number;
      status: string;
      baseline_rate: number;
      candidate_rate: number;
      created_at?: string;
    };
    Insert: {
      id?: string;
      name: string;
      dsl: string;
      terms: string;
      vector: number[];
      successes?: number;
      failures?: number;
      status: string;
      baseline_rate: number;
      candidate_rate: number;
      created_at?: string;
    };
    Update: {
      id?: string;
      name?: string;
      dsl?: string;
      terms?: string;
      vector?: number[];
      successes?: number;
      failures?: number;
      status?: string;
      baseline_rate?: number;
      candidate_rate?: number;
      created_at?: string;
    };
    Relationships: [];
  };
  agent_playbooks: {
    Row: {
      id: string;
      content: string;
      task_count: number;
      created_at: string;
    };
    Insert: {
      id?: string;
      content: string;
      task_count: number;
      created_at?: string;
    };
    Update: {
      id?: string;
      content?: string;
      task_count?: number;
      created_at?: string;
    };
    Relationships: [];
  };
  agent_policy_weights: {
    Row: {
      ngram: string;
      weight: number;
      observations: number;
      updated_at: string;
    };
    Insert: {
      ngram: string;
      weight: number;
      observations: number;
      updated_at: string;
    };
    Update: {
      ngram?: string;
      weight?: number;
      observations?: number;
      updated_at?: string;
    };
    Relationships: [];
  };
  agent_reflections: {
    Row: {
      id: string;
      task_id: string;
      objective: string;
      failure_point: string;
      component: string;
      root_cause: string;
      pivot_action: string;
      patch: string;
      failed_action: string;
      corrective_action: string;
      created_at: string;
    };
    Insert: {
      id?: string;
      task_id: string;
      objective: string;
      failure_point: string;
      component: string;
      root_cause: string;
      pivot_action: string;
      patch: string;
      failed_action: string;
      corrective_action: string;
      created_at?: string;
    };
    Update: {
      id?: string;
      task_id?: string;
      objective?: string;
      failure_point?: string;
      component?: string;
      root_cause?: string;
      pivot_action?: string;
      patch?: string;
      failed_action?: string;
      corrective_action?: string;
      created_at?: string;
    };
    Relationships: [];
  };
  agent_tasks: {
    Row: {
      id: string;
      objective: string;
      outcome: string;
      steps: number;
      verified: boolean;
      created_at: string;
    };
    Insert: {
      id: string;
      objective: string;
      outcome: string;
      steps: number;
      verified: boolean;
      created_at?: string;
    };
    Update: {
      id?: string;
      objective?: string;
      outcome?: string;
      steps?: number;
      verified?: boolean;
      created_at?: string;
    };
    Relationships: [];
  };
  agent_operator_messages: {
    Row: {
      id: string;
      task_id: string;
      content: string;
      consumed: boolean;
      created_at: string;
    };
    Insert: {
      id?: string;
      task_id: string;
      content: string;
      consumed?: boolean;
      created_at?: string;
    };
    Update: {
      id?: string;
      task_id?: string;
      content?: string;
      consumed?: boolean;
      created_at?: string;
    };
    Relationships: [];
  };
};

type AgentDatabase = {
  public: {
    Tables: DbTables;
    Views: Record<string, never>;
    Functions: Record<string, never>;
    Enums: Record<string, never>;
    CompositeTypes: Record<string, never>;
  };
};

const db = supabaseAdmin as unknown as SupabaseClient<AgentDatabase>;

let dbWriteLock: Promise<void> = Promise.resolve();
function withLock<T>(fn: () => Promise<T>): Promise<T> {
  const next = dbWriteLock.then(fn, fn);
  dbWriteLock = next.then(
    () => undefined,
    () => undefined
  );
  return next;
}

export type Think = (system: string, user: string) => Promise<string>;
export type Probe = (command: string) => Promise<boolean>;

export type Phase = "osPerceive" | "osDeliberate" | "osAct" | "osValidate" | "osReflect" | "osConsolidate";

const TRANSITIONS: Record<Phase, Phase[]> = {
  osPerceive: ["osDeliberate", "osConsolidate"],
  osDeliberate: ["osAct", "osConsolidate"],
  osAct: ["osAct", "osValidate", "osReflect", "osPerceive", "osDeliberate", "osConsolidate"],
  osValidate: ["osReflect", "osConsolidate"],
  osReflect: ["osDeliberate", "osConsolidate"],
  osConsolidate: []
};

export class Lifecycle {
  phase: Phase = "osPerceive";
  readonly trail: Phase[] = ["osPerceive"];
  constructor(private readonly onChange: (from: Phase, to: Phase) => Promise<void>) {}
  async to(next: Phase): Promise<void> {
    if (!TRANSITIONS[this.phase].includes(next)) throw new Error(`Tiltott fázisátmenet: ${this.phase} -> ${next}`);
    const from = this.phase;
    await this.onChange(from, next);
    this.phase = next;
    this.trail.push(next);
  }
}

export const VECTOR_DIMS = [
  "confidence", "progress", "risk", "uncertainty", "complexity", "novelty", "urgency", "tool_need",
  "info_need", "verification_need", "reversibility", "resource_cost", "alignment", "coherence", "momentum", "blocker_pressure"
] as const;

const GATE_WEIGHTS: Record<(typeof VECTOR_DIMS)[number], number> = {
  confidence: 1.6, progress: 0.8, risk: -1.4, uncertainty: -1.2, complexity: -0.4, novelty: -0.3, urgency: 0.3, tool_need: 0.2,
  info_need: -0.9, verification_need: -0.3, reversibility: 0.7, resource_cost: -0.4, alignment: 1.0, coherence: 0.9, momentum: 0.5, blocker_pressure: -1.3
};

const GATE_BIAS = 0.1;

export type GateDecision = "act" | "probe" | "replan";
export type Subgoal = { id: string; text: string; done: boolean };
export type GoalSpec = {
  state_pointers: { pointer: string; equals: unknown }[];
  required_files: string[];
  file_contents: { path: string; contains: string }[];
};
export type Sigma = {
  objective: string;
  strategy: string;
  subgoals: Subgoal[];
  closed_subgoals: number;
  facts: string[];
  blockers: string[];
  next_steps: string[];
  vector: number[];
  gate: number;
  decision: GateDecision;
  goal: GoalSpec;
};

function clip(value: string, max: number): string {
  if (max <= 0) return "";
  if (value.length <= max) return value;
  let end = max;
  const code = value.charCodeAt(end - 1);
  if (code >= 0xd800 && code <= 0xdbff) {
    end -= 1;
  }
  return value.slice(0, end);
}

function rec(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function strip(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(strip);
  if (!rec(value)) return value;
  const out: Record<string, unknown> = {};
  for (const [key, inner] of Object.entries(value)) {
    if (key !== "messages" && key !== "chain_of_thought") {
      out[key] = strip(inner);
    }
  }
  return out;
}

export function gate(vector: number[]): { gate: number; decision: GateDecision } {
  let z = GATE_BIAS;
  VECTOR_DIMS.forEach((dim, i) => {
    const val = vector[i];
    z += GATE_WEIGHTS[dim] * (typeof val === "number" && Number.isFinite(val) ? val : 0.5);
  });
  const g = 1 / (1 + Math.exp(-z));
  return { gate: g, decision: g >= 0.5 ? "act" : g >= 0.3 ? "probe" : "replan" };
}

export function emptySigma(objective: string): Sigma {
  const vector = VECTOR_DIMS.map(() => 0.5);
  const g = gate(vector);
  return {
    objective: clip(objective, 4000),
    strategy: "",
    subgoals: [],
    closed_subgoals: 0,
    facts: [],
    blockers: [],
    next_steps: [],
    vector,
    gate: g.gate,
    decision: g.decision,
    goal: { state_pointers: [], required_files: [], file_contents: [] }
  };
}

export function maintain(sigma: Sigma): Sigma {
  const preservedGoal: GoalSpec = {
    state_pointers: sigma.goal.state_pointers.map((p) => ({ pointer: p.pointer, equals: p.equals })),
    required_files: [...sigma.goal.required_files],
    file_contents: sigma.goal.file_contents.map((f) => ({ path: f.path, contains: f.contains }))
  };
  const closed = sigma.subgoals.filter((g) => g.done).length;
  const clean = strip({ ...sigma, goal: undefined }) as Sigma;
  clean.goal = preservedGoal;
  clean.subgoals = sigma.subgoals
    .filter((g) => !g.done)
    .slice(0, 12)
    .map((g) => ({ id: clip(g.id, 40), text: clip(g.text, 400), done: false }));
  clean.closed_subgoals = sigma.closed_subgoals + closed;
  clean.facts = [...new Set(clean.facts.map((f) => clip(f, 400)))].slice(-20);
  clean.blockers = [...new Set(clean.blockers.map((b) => clip(b, 400)))].slice(-8);
  clean.next_steps = clean.next_steps.slice(0, 8).map((s) => clip(s, 400));
  clean.strategy = clip(clean.strategy, 2000);
  return clean;
}

function scanBalancedJson(source: string): unknown {
  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    if (ch !== "{" && ch !== "[") continue;
    const stack: string[] = [ch === "{" ? "}" : "]"];
    let inString = false;
    let escape = false;
    for (let j = i + 1; j < source.length; j++) {
      const c = source[j]!;
      if (inString) {
        if (escape) {
          escape = false;
        } else if (c === "\\") {
          escape = true;
        } else if (c === "\"") {
          inString = false;
        }
        continue;
      }
      if (c === "\"") {
        inString = true;
      } else if (c === "{") {
        stack.push("}");
      } else if (c === "[") {
        stack.push("]");
      } else if (c === "}" || c === "]") {
        if (stack[stack.length - 1] === c) {
          stack.pop();
          if (stack.length === 0) {
            try {
              return JSON.parse(source.slice(i, j + 1));
            } catch {
              break;
            }
          }
        } else {
          break;
        }
      }
    }
  }
  return null;
}

export function extractJson(text: string): unknown {
  const fenceRegex = /```(?:json)?\s*([\s\S]*?)```/gi;
  let match: RegExpExecArray | null;
  while ((match = fenceRegex.exec(text)) !== null) {
    const candidate = match[1];
    if (candidate) {
      const parsed = scanBalancedJson(candidate);
      if (parsed !== null) return parsed;
    }
  }
  return scanBalancedJson(text);
}

function strings(value: unknown, max: number): string[] {
  if (max <= 0 || !Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === "string" && v.trim().length > 0).slice(0, max);
}

let subgoalCounter = 0;

export async function deliberate(think: Think, sigma: Sigma, trace: string, guidance: string): Promise<Sigma> {
  const system = [
    "Te a System 2 stratégiai tervező vagy. Kizárólag egyetlen JSON objektumot adj vissza, magyarázat nélkül.",
    "Séma: {\"strategy\": string, \"subgoals\": [{\"id\": string, \"text\": string, \"done\": boolean}], \"next_steps\": [string], \"vector\": [16 szám 0 és 1 között], \"goal\": {\"state_pointers\": [{\"pointer\": JSON-pointer a munkamemóriába, \"equals\": érték}], \"required_files\": [abszolút útvonal], \"file_contents\": [{\"path\": string, \"contains\": string}]}}",
    `A vector dimenziói sorrendben: ${VECTOR_DIMS.join(", ")}.`,
    "A next_steps legfeljebb 5 konkrét, azonnal végrehajtható mikrolépés a System 1 számára.",
    "A goal csak olyan ellenőrizhető feltételeket tartalmazzon, amelyek a feladat valódi befejezését bizonyítják; ha nincs fájlkimenet, hagyd üresen a fájllistákat.",
    "Egyszerű beszélgetési üzenetnél vagy egylépéses kérdésnél a subgoals és a goal minden listája legyen üres."
  ].join("\n");
  const user = `MUNKAMEMÓRIA:\n${JSON.stringify(sigma)}\n\nTANULT ÚTMUTATÁS:\n${guidance || "nincs"}\n\nFRISS NYOMVONAL:\n${clip(trace, 8000)}`;
  const rawResponse = await think(system, user);
  const parsed = extractJson(rawResponse);
  if (!rec(parsed)) {
    throw new Error("A stratégiai tervező (deliberate) érvénytelen JSON választ adott.");
  }
  const next: Sigma = { ...sigma };
  if (typeof parsed.strategy === "string") next.strategy = parsed.strategy;
  if (Array.isArray(parsed.subgoals)) {
    const existingById = new Map(sigma.subgoals.map((g) => [g.id, g]));
    const existingByText = new Map(sigma.subgoals.map((g) => [g.text, g]));
    const usedIds = new Set<string>(sigma.subgoals.map((g) => g.id));
    const takenExisting = new Set<string>();
    const collected: Subgoal[] = [];
    for (const g of parsed.subgoals) {
      if (!rec(g)) continue;
      const text = typeof g.text === "string" ? g.text.trim() : "";
      if (!text) continue;
      const rawId = typeof g.id === "string" ? g.id.trim() : "";
      const existing = (rawId ? existingById.get(rawId) : undefined) ?? existingByText.get(text);
      if (existing) {
        if (takenExisting.has(existing.id)) continue;
        takenExisting.add(existing.id);
        collected.push({ id: existing.id, text, done: existing.done });
        continue;
      }
      let id = rawId;
      if (!id || usedIds.has(id)) {
        do {
          subgoalCounter += 1;
          id = `sg_${Date.now().toString(36)}_${subgoalCounter}`;
        } while (usedIds.has(id));
      }
      usedIds.add(id);
      collected.push({ id, text, done: false });
    }
    next.subgoals = collected;
  }
  if (Array.isArray(parsed.next_steps)) {
    next.next_steps = strings(parsed.next_steps, 5);
  }
  if (Array.isArray(parsed.vector) && parsed.vector.length === 16) {
    next.vector = parsed.vector.map((v) => (typeof v === "number" && Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0.5));
  }
  if (rec(parsed.goal)) {
    const goal = parsed.goal;
    next.goal = {
      state_pointers: Array.isArray(goal.state_pointers)
        ? goal.state_pointers
            .filter(rec)
            .filter((p) => typeof p.pointer === "string" && "equals" in p && p.equals !== undefined)
            .map((p) => ({ pointer: p.pointer as string, equals: p.equals }))
            .slice(0, 10)
        : [],
      required_files: strings(goal.required_files, 20),
      file_contents: Array.isArray(goal.file_contents)
        ? goal.file_contents
            .filter(rec)
            .filter((f) => typeof f.path === "string" && typeof f.contains === "string")
            .map((f) => ({ path: f.path as string, contains: f.contains as string }))
            .slice(0, 20)
        : []
    };
  }
  const g = gate(next.vector);
  next.gate = g.gate;
  next.decision = g.decision;
  return maintain(next);
}

export function applyStateUpdate(sigma: Sigma, args: Record<string, unknown>): Sigma {
  const next: Sigma = {
    ...sigma,
    facts: [...sigma.facts],
    blockers: [...sigma.blockers],
    subgoals: sigma.subgoals.map((g) => ({ ...g }))
  };
  if (typeof args.fact === "string" && args.fact.trim()) next.facts.push(args.fact.trim());
  if (typeof args.blocker === "string" && args.blocker.trim()) next.blockers.push(args.blocker.trim());
  if (typeof args.resolve_blocker === "string" && args.resolve_blocker.trim()) {
    const key = args.resolve_blocker.trim().toLowerCase();
    next.blockers = next.blockers.filter((b) => b.trim().toLowerCase() !== key);
  }
  if (typeof args.complete_subgoal === "string" && args.complete_subgoal.trim()) {
    const key = args.complete_subgoal.trim();
    for (const g of next.subgoals) {
      if (g.id === key || g.text === key) g.done = true;
    }
  }
  return maintain(next);
}

function pointer(root: unknown, path: string): unknown {
  if (path === "") return root;
  if (!path.startsWith("/")) return undefined;
  let cur: unknown = root;
  for (const raw of path.slice(1).split("/")) {
    const key = raw.replace(/~1/g, "/").replace(/~0/g, "~");
    if (Array.isArray(cur)) {
      if (!/^(0|[1-9][0-9]*)$/.test(key)) return undefined;
      const idx = Number(key);
      if (idx < 0 || idx >= cur.length) return undefined;
      cur = cur[idx];
    } else if (rec(cur)) {
      if (!Object.prototype.hasOwnProperty.call(cur, key)) return undefined;
      cur = cur[key];
    } else {
      return undefined;
    }
  }
  return cur;
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== typeof b || a === null || b === null) return false;
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!deepEqual(a[i], b[i])) return false;
    }
    return true;
  }
  if (rec(a) && rec(b)) {
    const keysA = Object.keys(a);
    const keysB = Object.keys(b);
    if (keysA.length !== keysB.length) return false;
    for (const key of keysA) {
      if (!Object.prototype.hasOwnProperty.call(b, key) || !deepEqual(a[key], b[key])) return false;
    }
    return true;
  }
  return false;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

async function safeProbe(probe: Probe, command: string): Promise<boolean> {
  try {
    return await probe(command);
  } catch {
    return false;
  }
}

export async function verify(sigma: Sigma, probe: Probe | null): Promise<{ ok: boolean; failures: string[] }> {
  const failures: string[] = [];
  for (const p of sigma.goal.state_pointers) {
    if (p.equals === undefined) {
      failures.push(`Hiányzó elvárt érték (equals): ${p.pointer}`);
      continue;
    }
    const actual = pointer(sigma, p.pointer);
    if (actual === undefined || !deepEqual(actual, p.equals)) {
      failures.push(`Állapot nem egyezik: ${p.pointer}`);
    }
  }
  const needsFiles = sigma.goal.required_files.length + sigma.goal.file_contents.length > 0;
  if (needsFiles && !probe) failures.push("Fájlellenőrzés szükséges, de nincs elérhető VM.");
  if (probe) {
    for (const path of sigma.goal.required_files) {
      if (!(await safeProbe(probe, `test -f ${shellQuote(path)}`))) {
        failures.push(`Hiányzó fájl: ${path}`);
      }
    }
    for (const fc of sigma.goal.file_contents) {
      const b64 = Buffer.from(fc.contains, "utf-8").toString("base64");
      const cmd = `node -e 'const fs = require("fs"); try { const c = fs.readFileSync(process.argv[1], "utf8"); const n = Buffer.from(process.argv[2], "base64").toString("utf8"); process.exit(c.includes(n) ? 0 : 1); } catch { process.exit(1); }' ${shellQuote(fc.path)} ${shellQuote(b64)}`;
      if (!(await safeProbe(probe, cmd))) {
        failures.push(`Fájltartalom nem egyezik: ${fc.path}`);
      }
    }
  }
  if (sigma.blockers.length) failures.push(`Nyitott blokkolók: ${sigma.blockers.join("; ")}`);
  const open = sigma.subgoals.filter((g) => !g.done);
  if (open.length) failures.push(`Lezáratlan részcélok: ${open.map((g) => g.id).join(", ")}`);
  const hasEvidence =
    sigma.goal.state_pointers.length > 0 ||
    sigma.goal.required_files.length > 0 ||
    sigma.goal.file_contents.length > 0 ||
    sigma.closed_subgoals > 0 ||
    sigma.facts.length > 0;
  if (!hasEvidence) {
    failures.push("Nincs ellenőrizhető bizonyíték a feladat teljesítésére.");
  }
  return { ok: failures.length === 0, failures };
}

export const ALLOWED_COMPONENTS = ["planner", "executor", "tool", "environment", "verifier", "model"] as const;
export type ReflectionComponent = (typeof ALLOWED_COMPONENTS)[number];

export type Reflection = {
  failure_point: string;
  component: ReflectionComponent;
  root_cause: string;
  pivot_action: string;
  patch: string;
  failed_action: string;
  corrective_action: string;
};

export async function reflect(think: Think, objective: string, trace: string, failedAction: string): Promise<Reflection> {
  const system = [
    "Hibaelemző vagy. A nyers nyomvonal alapján végezz gyökérok-elemzést. Kizárólag JSON-t adj vissza.",
    "Séma: {\"failure_point\": a kudarc pontos lépése, \"component\": felelős komponens (planner|executor|tool|environment|verifier|model), \"root_cause\": string, \"pivot_action\": egyetlen konkrét korrekciós lépés, \"patch\": javítócsomag leírása, \"corrective_action\": a sikertelen műveletet közvetlenül kiváltó helyes parancs vagy művelet}"
  ].join("\n");
  const raw = await think(system, `CÉL:\n${objective}\n\nSIKERTELEN MŰVELET:\n${clip(failedAction, 2000)}\n\nNYOMVONAL:\n${clip(trace, 10000)}`);
  const parsed = extractJson(raw);
  if (!rec(parsed)) {
    throw new Error("A hibaelemző (reflect) érvénytelen JSON választ adott.");
  }
  const reqStr = (k: string): string => {
    const val = parsed[k];
    if (typeof val !== "string" || !val.trim()) {
      throw new Error(`A hibaelemzésből hiányzik a kötelező mező: ${k}`);
    }
    return clip(val.trim(), 2000);
  };
  const optStr = (k: string): string => {
    const val = parsed[k];
    return typeof val === "string" && val.trim() ? clip(val.trim(), 2000) : "";
  };
  const rawComp = reqStr("component").toLowerCase();
  if (!(ALLOWED_COMPONENTS as readonly string[]).includes(rawComp)) {
    throw new Error(`Érvénytelen komponens a hibaelemzésben: ${rawComp}`);
  }
  const pivotAction = reqStr("pivot_action");
  const patch = optStr("patch");
  const correctiveAction = optStr("corrective_action") || patch || pivotAction;
  return {
    failure_point: reqStr("failure_point"),
    component: rawComp as ReflectionComponent,
    root_cause: reqStr("root_cause"),
    pivot_action: pivotAction,
    patch,
    failed_action: clip(failedAction, 2000),
    corrective_action: correctiveAction
  };
}

const DIM = 256;

export function tokens(text: string): string[] {
  return text.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? [];
}

function fnv(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export function embed(text: string): number[] {
  const v = new Array<number>(DIM).fill(0);
  const t = tokens(text);
  for (let i = 0; i < t.length; i++) {
    const a = t[i] as string;
    const idxA = fnv(a) % DIM;
    v[idxA] = (v[idxA] ?? 0) + 1;
    const b = t[i + 1];
    if (b) {
      const idxB = fnv(`${a} ${b}`) % DIM;
      v[idxB] = (v[idxB] ?? 0) + 0.5;
    }
    for (let j = 0; j + 3 <= a.length; j++) {
      const idxTri = fnv(`#${a.slice(j, j + 3)}`) % DIM;
      v[idxTri] = (v[idxTri] ?? 0) + 0.25;
    }
  }
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
  return v.map((x) => x / norm);
}

export function parseVector(raw: unknown): number[] {
  if (Array.isArray(raw)) {
    return raw.map((x) => (typeof x === "number" && Number.isFinite(x) ? x : Number(x) || 0));
  }
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (!trimmed) return [];
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (Array.isArray(parsed)) {
        return parsed.map((x) => (typeof x === "number" && Number.isFinite(x) ? x : Number(x) || 0));
      }
      return [];
    } catch {
      const inner = trimmed.replace(/^[[({]+|[\])}]+$/g, "");
      if (!inner) return [];
      return inner.split(",").map((s) => Number(s.trim()) || 0);
    }
  }
  return [];
}

export function cosine(a: unknown, b: unknown): number {
  const va = parseVector(a);
  const vb = parseVector(b);
  if (va.length !== vb.length || va.length === 0) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < va.length; i++) {
    const x = va[i] ?? 0;
    const y = vb[i] ?? 0;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom > 0 ? dot / denom : 0;
}

export type Skill = { id: string; name: string; dsl: string; terms: string; vector: number[]; successes: number; failures: number };

export async function retrieve(objective: string, context: string): Promise<{ skills: Skill[]; playbook: string }> {
  const [skillsRes, playbooksRes] = await Promise.all([
    db.from("agent_skills").select("id,name,dsl,terms,vector,successes,failures").eq("status", "active").limit(500),
    db.from("agent_playbooks").select("content").order("created_at", { ascending: false }).limit(1)
  ]);
  if (skillsRes.error) throw new Error(skillsRes.error.message);
  if (playbooksRes.error) throw new Error(playbooksRes.error.message);
  const skills = skillsRes.data ?? [];
  const playbooks = playbooksRes.data ?? [];
  const query = `${objective}\n${context}`;
  const qv = embed(query);
  const qt = new Set(tokens(query));
  const ranked = skills
    .map((s) => {
      const vec = parseVector(s.vector);
      const terms = tokens(`${s.name} ${s.terms}`);
      const lexical = terms.length ? terms.filter((t) => qt.has(t)).length / Math.sqrt(terms.length * Math.max(1, qt.size)) : 0;
      const rate = (s.successes + 1) / (s.successes + s.failures + 2);
      const normalizedSkill: Skill = {
        id: s.id,
        name: s.name,
        dsl: s.dsl,
        terms: s.terms,
        vector: vec,
        successes: s.successes,
        failures: s.failures
      };
      return { skill: normalizedSkill, score: 0.5 * cosine(qv, vec) + 0.3 * Math.min(1, lexical) + 0.2 * rate };
    })
    .filter((x) => x.score > 0.25)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3);
  return { skills: ranked.map((x) => x.skill), playbook: playbooks[0]?.content ?? "" };
}

function ngrams(text: string): string[] {
  const t = tokens(text);
  const out: string[] = [];
  for (let i = 0; i + 1 < t.length; i++) out.push(`${t[i]} ${t[i + 1]}`);
  return out;
}

function distribution(grams: string[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const g of grams) m.set(g, (m.get(g) ?? 0) + 1);
  for (const [k, v] of m) m.set(k, v / grams.length);
  return m;
}

async function applyPolicyDelta(ngram: string, delta: number): Promise<void> {
  for (let attempt = 0; attempt < 8; attempt++) {
    const current = await db.from("agent_policy_weights").select("ngram,weight,observations").eq("ngram", ngram).maybeSingle();
    if (current.error) throw new Error(current.error.message);
    const now = new Date().toISOString();
    if (!current.data) {
      const inserted = await db.from("agent_policy_weights").insert({ ngram, weight: delta, observations: 1, updated_at: now });
      if (!inserted.error) return;
      if (inserted.error.code === "23505") continue;
      throw new Error(inserted.error.message);
    }
    const updated = await db
      .from("agent_policy_weights")
      .update({ weight: current.data.weight + delta, observations: current.data.observations + 1, updated_at: now })
      .eq("ngram", ngram)
      .eq("observations", current.data.observations)
      .select("ngram");
    if (updated.error) throw new Error(updated.error.message);
    if (updated.data && updated.data.length > 0) return;
  }
  throw new Error(`A politikasúly frissítése ütközés miatt sikertelen: ${ngram}`);
}

export async function distill(pairs: { failed: string; corrective: string; advantage: number }[]): Promise<void> {
  const deltas = new Map<string, number>();
  const eps = 1e-3;
  const lr = 0.5;
  for (const pair of pairs) {
    const fail = ngrams(pair.failed);
    const fix = ngrams(pair.corrective);
    if (!fail.length || !fix.length) continue;
    const advantage = Number.isFinite(pair.advantage) ? Math.min(1, Math.max(0, pair.advantage)) : 0;
    if (advantage <= 0) continue;
    const p = distribution(fail);
    const q = distribution(fix);
    for (const g of new Set([...p.keys(), ...q.keys()])) {
      const qg = (q.get(g) ?? 0) + eps;
      const pg = (p.get(g) ?? 0) + eps;
      const d = lr * advantage * (qg + pg) * Math.log(qg / pg);
      if (Math.abs(d) > 1e-4) deltas.set(g, (deltas.get(g) ?? 0) + d);
    }
  }
  if (!deltas.size) return;
  const selected = [...deltas.entries()].sort((a, b) => Math.abs(b[1]) - Math.abs(a[1])).slice(0, 400);
  await withLock(async () => {
    const batchSize = 25;
    for (let i = 0; i < selected.length; i += batchSize) {
      const batch = selected.slice(i, i + batchSize);
      await Promise.all(batch.map(([ngram, delta]) => applyPolicyDelta(ngram, delta)));
    }
  });
}

export async function policyGuidance(): Promise<string> {
  const [favorRes, avoidRes] = await Promise.all([
    db.from("agent_policy_weights").select("ngram,weight").gt("weight", 0.01).order("weight", { ascending: false }).limit(8),
    db.from("agent_policy_weights").select("ngram,weight").lt("weight", -0.01).order("weight", { ascending: true }).limit(8)
  ]);
  if (favorRes.error) throw new Error(favorRes.error.message);
  if (avoidRes.error) throw new Error(avoidRes.error.message);
  const favor = favorRes.data ?? [];
  const avoid = avoidRes.data ?? [];
  const lines: string[] = [];
  if (favor.length) lines.push(`FAVOR: ${favor.map((r) => `"${r.ngram}"`).join(", ")}`);
  if (avoid.length) lines.push(`AVOID: ${avoid.map((r) => `"${r.ngram}"`).join(", ")}`);
  return lines.join("\n");
}

export function validDsl(dsl: string): boolean {
  const lines = dsl.split("\n").map((l) => l.trim());
  const has = (k: string) => lines.some((l) => l.startsWith(`${k} `) || l.startsWith(`${k}:`));
  return has("SKILL") && has("WHEN") && has("REQUIRE") && has("STEP") && has("VERIFY") && has("RECOVER");
}

type HeldOutTask = { id: string; task_id: string; objective: string; component: string; root_cause: string; pivot_action: string };

function solves(dslTokens: Set<string>, dslVector: number[], task: HeldOutTask): boolean {
  const needed = [...new Set(tokens(`${task.pivot_action} ${task.root_cause}`).filter((t) => t.length >= 4))];
  if (!needed.length) return false;
  const covered = needed.filter((t) => dslTokens.has(t)).length / needed.length;
  if (covered < 0.5) return false;
  return cosine(embed(`${task.objective}\n${task.root_cause}`), dslVector) >= 0.2;
}

async function regressionGate(
  candidate: string,
  clusterReflectionIds: Set<string>,
  clusterTaskIds: Set<string>,
  component: string
): Promise<{ accept: boolean; baseline: number; candidate: number }> {
  const [activeRes, reflRes] = await Promise.all([
    db.from("agent_skills").select("dsl").eq("status", "active").limit(100),
    db
      .from("agent_reflections")
      .select("id,task_id,objective,component,root_cause,pivot_action")
      .eq("component", component)
      .order("created_at", { ascending: false })
      .limit(200)
  ]);
  if (activeRes.error) throw new Error(activeRes.error.message);
  if (reflRes.error) throw new Error(reflRes.error.message);
  const seenObjectives = new Set<string>();
  const heldOut: HeldOutTask[] = [];
  for (const r of reflRes.data ?? []) {
    if (clusterReflectionIds.has(r.id) || clusterTaskIds.has(r.task_id)) continue;
    if (seenObjectives.has(r.objective)) continue;
    seenObjectives.add(r.objective);
    heldOut.push(r);
    if (heldOut.length >= 20) break;
  }
  if (!heldOut.length) return { accept: false, baseline: 0, candidate: 0 };
  const baseSkills = (activeRes.data ?? []).map((s) => ({ tokens: new Set(tokens(s.dsl)), vector: embed(s.dsl) }));
  const candidateSkill = { tokens: new Set(tokens(candidate)), vector: embed(candidate) };
  let baselineSolved = 0;
  let candidateSolved = 0;
  for (const task of heldOut) {
    const baseHit = baseSkills.some((s) => solves(s.tokens, s.vector, task));
    const candHit = baseHit || solves(candidateSkill.tokens, candidateSkill.vector, task);
    if (baseHit) baselineSolved += 1;
    if (candHit) candidateSolved += 1;
  }
  const baseline = baselineSolved / heldOut.length;
  const candidateRate = candidateSolved / heldOut.length;
  return { accept: candidateRate > baseline, baseline, candidate: candidateRate };
}

async function synthesizeSkills(think: Think, log: (text: string) => Promise<void>): Promise<void> {
  const [reflRes, skillsRes] = await Promise.all([
    db
      .from("agent_reflections")
      .select("id,task_id,component,root_cause,pivot_action,patch,objective")
      .order("created_at", { ascending: false })
      .limit(50),
    db.from("agent_skills").select("vector").limit(1000)
  ]);
  if (reflRes.error) throw new Error(reflRes.error.message);
  if (skillsRes.error) throw new Error(skillsRes.error.message);
  const items = (reflRes.data ?? []).map((r) => ({ ...r, v: embed(`${r.component} ${r.root_cause}`) }));
  const knownVectors: unknown[] = (skillsRes.data ?? []).map((s) => s.vector);
  const used = new Set<number>();
  for (let i = 0; i < items.length; i++) {
    if (used.has(i)) continue;
    const seed = items[i];
    if (!seed) continue;
    const cluster = [i];
    for (let j = i + 1; j < items.length; j++) {
      const other = items[j];
      if (!other || used.has(j)) continue;
      if (other.component === seed.component && cosine(seed.v, other.v) >= 0.55) cluster.push(j);
    }
    if (cluster.length < 2) continue;
    cluster.forEach((c) => used.add(c));
    const group = cluster.map((c) => items[c]).filter((g): g is NonNullable<typeof g> => g !== undefined);
    const centroid = embed(group.map((g) => `${g.component} ${g.root_cause}`).join(" "));
    if (knownVectors.some((kv) => cosine(kv, centroid) >= 0.8)) continue;
    const system = [
      "Meta-ágens vagy: a visszatérő hibamintából újrahasznosítható képességet szintetizálsz SKILL DSL nyelven. Csak a DSL-t add vissza.",
      "Kötelező formátum, minden záradék külön sorban:",
      "SKILL <rövid_snake_case_név>",
      "WHEN <alkalmazási feltétel>",
      "REQUIRE <előfeltétel>",
      "STEP <lépés> (több STEP sor is lehet)",
      "VERIFY <ellenőrizhető sikerfeltétel>",
      "RECOVER <helyreállítási lépés hiba esetén>"
    ].join("\n");
    const userPrompt = group
      .map((g) => `KOMPONENS: ${g.component}\nGYÖKÉROK: ${g.root_cause}\nKORREKCIÓ: ${g.pivot_action}\nJAVÍTÁS: ${g.patch}`)
      .join("\n---\n");
    const dsl = (await think(system, userPrompt)).replace(/```[a-z]*\n?|```/gi, "").trim();
    if (!validDsl(dsl)) {
      await log("A szintetizált képesség érvénytelen DSL-t adott, elvetve.");
      continue;
    }
    const nameMatch = /^[ \t]*SKILL[: \t]+(\S[^\n]*)$/m.exec(dsl);
    const name = nameMatch?.[1]?.trim().slice(0, 80) || `skill_${Date.now().toString(36)}`;
    const gateResult = await regressionGate(
      dsl,
      new Set(group.map((g) => g.id)),
      new Set(group.map((g) => g.task_id)),
      seed.component
    );
    const inserted = await db.from("agent_skills").insert({
      name,
      dsl,
      terms: tokens(dsl).slice(0, 200).join(" "),
      vector: centroid,
      status: gateResult.accept ? "active" : "rejected",
      baseline_rate: gateResult.baseline,
      candidate_rate: gateResult.candidate
    });
    if (inserted.error) throw new Error(inserted.error.message);
    knownVectors.push(centroid);
    await log(`Új képesség „${name}”: ${gateResult.accept ? "aktiválva" : "elutasítva"} (alap ${gateResult.baseline.toFixed(2)}, jelölt ${gateResult.candidate.toFixed(2)}).`);
  }
}

async function evolvePlaybook(think: Think, log: (text: string) => Promise<void>): Promise<void> {
  const [countRes, lastRes] = await Promise.all([
    db.from("agent_tasks").select("id", { count: "exact", head: true }),
    db.from("agent_playbooks").select("task_count").order("created_at", { ascending: false }).limit(1)
  ]);
  if (countRes.error) throw new Error(countRes.error.message);
  if (lastRes.error) throw new Error(lastRes.error.message);
  if (countRes.count === null) throw new Error("A feladatok száma nem állapítható meg.");
  const total = countRes.count;
  if (total - (lastRes.data?.[0]?.task_count ?? 0) < 5) return;
  const [reflRes, skillsRes, prevRes] = await Promise.all([
    db.from("agent_reflections").select("component,root_cause,pivot_action").order("created_at", { ascending: false }).limit(40),
    db.from("agent_skills").select("name,dsl").eq("status", "active").limit(20),
    db.from("agent_playbooks").select("content").order("created_at", { ascending: false }).limit(1)
  ]);
  if (reflRes.error) throw new Error(reflRes.error.message);
  if (skillsRes.error) throw new Error(skillsRes.error.message);
  if (prevRes.error) throw new Error(prevRes.error.message);
  const system = "Tapasztalati tudáskonszolidátor vagy. Írj tömör, ember által olvasható magyar működési kézikönyvet két szakasszal: 'Bevált eljárások' és 'Elkerülendő anti-patternek'. Legfeljebb 40 pont.";
  const reflections = (reflRes.data ?? []).map((r) => `- [${r.component}] ${r.root_cause} => ${r.pivot_action}`).join("\n");
  const activeSkills = (skillsRes.data ?? []).map((s) => s.dsl).join("\n\n");
  const content = (
    await think(system, `ELŐZŐ KÉZIKÖNYV:\n${prevRes.data?.[0]?.content ?? "nincs"}\n\nREFLEXIÓK:\n${reflections}\n\nAKTÍV KÉPESSÉGEK:\n${activeSkills}`)
  ).trim();
  if (!content) return;
  const inserted = await db
    .from("agent_playbooks")
    .insert({ content: clip(content, 20000), task_count: total })
    .select("id")
    .single();
  if (inserted.error) throw new Error(inserted.error.message);
  const ownId = inserted.data.id;
  const sameCount = await db
    .from("agent_playbooks")
    .select("id")
    .eq("task_count", total)
    .order("created_at", { ascending: true })
    .order("id", { ascending: true });
  if (sameCount.error) throw new Error(sameCount.error.message);
  const firstId = sameCount.data?.[0]?.id;
  if (firstId && firstId !== ownId) {
    const removed = await db.from("agent_playbooks").delete().eq("id", ownId);
    if (removed.error) throw new Error(removed.error.message);
    return;
  }
  await log("A működési kézikönyv frissült.");
}

async function recordSkillOutcome(id: string, verified: boolean): Promise<void> {
  for (let attempt = 0; attempt < 8; attempt++) {
    const current = await db.from("agent_skills").select("successes,failures").eq("id", id).maybeSingle();
    if (current.error) throw new Error(current.error.message);
    if (!current.data) return;
    const patch = verified ? { successes: current.data.successes + 1 } : { failures: current.data.failures + 1 };
    const updated = await db
      .from("agent_skills")
      .update(patch)
      .eq("id", id)
      .eq("successes", current.data.successes)
      .eq("failures", current.data.failures)
      .select("id");
    if (updated.error) throw new Error(updated.error.message);
    if (updated.data && updated.data.length > 0) return;
  }
  throw new Error(`A képesség eredményének rögzítése ütközés miatt sikertelen: ${id}`);
}

export async function consolidate(
  think: Think,
  input: {
    taskId: string;
    objective: string;
    outcome: string;
    steps: number;
    verified: boolean;
    reflections: Reflection[];
    usedSkills: string[];
  },
  log: (text: string) => Promise<void>
): Promise<void> {
  const taskWrite = await db.from("agent_tasks").upsert(
    {
      id: input.taskId,
      objective: clip(input.objective, 4000),
      outcome: input.outcome,
      steps: input.steps,
      verified: input.verified
    },
    { onConflict: "id" }
  );
  if (taskWrite.error) throw new Error(taskWrite.error.message);
  if (input.reflections.length) {
    const reflectionWrite = await db.from("agent_reflections").insert(
      input.reflections.map((r) => ({
        task_id: input.taskId,
        objective: clip(input.objective, 4000),
        failure_point: r.failure_point,
        component: r.component,
        root_cause: r.root_cause,
        pivot_action: r.pivot_action,
        patch: r.patch,
        failed_action: r.failed_action,
        corrective_action: r.corrective_action
      }))
    );
    if (reflectionWrite.error) throw new Error(reflectionWrite.error.message);
    await distill(
      input.reflections
        .filter((r) => r.corrective_action)
        .map((r) => ({ failed: r.failed_action, corrective: r.corrective_action, advantage: input.verified ? 1 : 0.25 }))
    );
  }
  for (const id of new Set(input.usedSkills)) {
    await recordSkillOutcome(id, input.verified);
  }
  await withLock(async () => {
    if (input.reflections.length) await synthesizeSkills(think, log);
    await evolvePlaybook(think, log);
  });
}

export async function takeOperatorMessages(taskId: string): Promise<string[]> {
  const { data, error } = await db
    .from("agent_operator_messages")
    .update({ consumed: true })
    .eq("task_id", taskId)
    .eq("consumed", false)
    .select("id,content,created_at");
  if (error) throw new Error(error.message);
  if (!data?.length) return [];
  return [...data].sort((a, b) => a.created_at.localeCompare(b.created_at)).map((d) => d.content);
}

export async function postOperatorMessage(taskId: string, content: string): Promise<void> {
  const { error } = await db.from("agent_operator_messages").insert({ task_id: taskId, content: clip(content, 8000) });
  if (error) throw new Error(error.message);
}

export type ReasonNode = { question: string; answer: string; children: ReasonNode[] };

const REASON_MAX_DEPTH = 4;
const REASON_MAX_BRANCHES = 6;
const REASON_MAX_CALLS = 300;

async function reasonNode(think: Think, question: string, depth: number, branches: number): Promise<ReasonNode> {
  if (depth <= 0) {
    const answer = await think("Izolált következtető vagy. Tömören, tényszerűen válaszolj a kérdésre; ne javasolj állapotmódosítást.", question);
    return { question, answer: clip(answer, 3000), children: [] };
  }
  const decomposition = await think(
    `Bontsd a kérdést legfeljebb ${branches} független, kisebb alkérdésre. Csak JSON tömböt adj vissza stringekkel. Ha a kérdés atomi, adj vissza üres tömböt.`,
    question
  );
  const subs = strings(extractJson(decomposition), branches);
  const children = await Promise.all(subs.map((q) => reasonNode(think, q, depth - 1, branches)));
  const answer = children.length
    ? await think(
        "Összegző vagy. Az alkérdésekre adott válaszokból adj tömör, következetes választ az eredeti kérdésre.",
        `EREDETI KÉRDÉS:\n${question}\n\nALVÁLASZOK:\n${children.map((c) => `- ${c.question}: ${c.answer}`).join("\n")}`
      )
    : await think("Izolált következtető vagy. Tömören, tényszerűen válaszolj a kérdésre; ne javasolj állapotmódosítást.", question);
  return { question, answer: clip(answer, 3000), children };
}

export async function reasonTree(think: Think, question: string, depth: number, branches: number): Promise<ReasonNode> {
  if (!Number.isInteger(depth) || depth < 0 || depth > REASON_MAX_DEPTH) {
    throw new Error(`Érvénytelen mélység: 0 és ${REASON_MAX_DEPTH} közötti egész szám szükséges.`);
  }
  if (!Number.isInteger(branches) || branches < 1 || branches > REASON_MAX_BRANCHES) {
    throw new Error(`Érvénytelen elágazásszám: 1 és ${REASON_MAX_BRANCHES} közötti egész szám szükséges.`);
  }
  let nodes = 0;
  let level = 1;
  for (let d = 0; d <= depth; d++) {
    nodes += level;
    level *= branches;
  }
  if (nodes * 2 > REASON_MAX_CALLS) {
    throw new Error(`A kért fa legfeljebb ${nodes * 2} modellhívást igényelhet, a korlát ${REASON_MAX_CALLS}.`);
  }
  return reasonNode(think, question, depth, branches);
}
