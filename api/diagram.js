// Serverless function: plain-language description (DE/EN) → Mermaid diagram code via free LLMs (Groq → OpenRouter).
const hits = new Map(); // simple per-instance rate limit
const LIMIT = 12, WINDOW_MS = 60_000;
const TYPES = {
  auto: "the diagram type that fits best (flowchart, sequenceDiagram, erDiagram, classDiagram, stateDiagram-v2, gantt, mindmap or timeline)",
  flowchart: "flowchart (use `flowchart TD` or `flowchart LR`)",
  sequence: "sequenceDiagram",
  er: "erDiagram",
  class: "classDiagram",
  state: "stateDiagram-v2",
  gantt: "gantt",
  mindmap: "mindmap",
};

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  const ip = (req.headers["x-forwarded-for"] || "").split(",")[0] || "anon";
  const now = Date.now();
  const recent = (hits.get(ip) || []).filter(t => now - t < WINDOW_MS);
  if (recent.length >= LIMIT) return res.status(429).json({ error: "Too many requests — wait a minute" });
  recent.push(now); hits.set(ip, recent);

  const body = req.body || {};
  const text = String(body.text || "").trim().slice(0, 4000);
  const current = String(body.current || "").trim().slice(0, 6000);
  const error = String(body.error || "").trim().slice(0, 600);
  const type = TYPES[body.type] ? body.type : "auto";
  if (!text && !current) return res.status(400).json({ error: "Describe something first" });

  const providers = buildProviders();
  if (!providers.length) return res.status(500).json({ error: "Server has no AI provider key" });

  const rules = `Mermaid rules (Mermaid v11):
- Output valid Mermaid only. No markdown fences, no %%{init}%% directives, no styling/classDef unless asked.
- Node IDs: short ASCII letters/digits only (A, B1, api). Put human text in labels.
- Wrap EVERY label that has spaces, punctuation, umlauts or parentheses in double quotes: A["Nutzer öffnet App (Login)"]. Never use double quotes inside labels; use ' instead.
- Edge labels: A -->|"label"| B.
- Keep it readable: max ~25 nodes, labels under ~6 words.
- Write labels in the same language as the user's description (German stays German, English stays English).
- Invent nothing important; if details are missing, keep it generic.
Syntax by type:
- flowchart: A["Label"] --> B{"Condition?"}; use {"…"} diamonds for decisions with |"yes"| / |"no"| edges, [("…")] for databases.
- sequenceDiagram: declare actors first as \`participant A as Name\` (no brackets!), then A->>B: message, B-->>A: reply (message text plain, no quotes). Use alt/else/end for error paths.
- erDiagram: entity names are readable UPPER_SNAKE words (CUSTOMER, ORDER_ITEM), never single letters. Relationship: CUSTOMER ||--o{ ORDER : places. Optional attribute blocks: CUSTOMER { int id PK  string name }.
- classDiagram / stateDiagram-v2 / gantt / mindmap: standard Mermaid v11 syntax, no quotes around mindmap nodes unless needed.`;

  let prompt;
  if (current && error) {
    prompt = `This Mermaid diagram fails to parse. Fix it with the smallest change; keep its meaning.
Parser error: ${error}
${rules}
Return ONLY JSON: {"title":"short title","code":"fixed mermaid code"}

Diagram:
"""${current}"""`;
  } else if (current) {
    prompt = `Update this Mermaid diagram according to the change request. Keep everything else as is.
${rules}
Return ONLY JSON: {"title":"short title","code":"updated mermaid code"}

Current diagram:
"""${current}"""

Change request:
"""${text}"""`;
  } else {
    prompt = `You turn a software developer's plain-language description of a system, flow or process into a clear Mermaid diagram.
Diagram type: ${TYPES[type]}.
${rules}
Return ONLY JSON: {"title":"short title (2-5 words, same language as input)","code":"mermaid code"}

Description:
"""${text}"""`;
  }

  try {
    const { out, rateLimited, by } = await callWithFallback(providers, prompt);
    if (!out) return res.status(rateLimited ? 429 : 502).json({ error: rateLimited ? "AI is busy (rate limit) — try again in a minute" : "AI request failed — try again" });
    return res.status(200).json({ title: String(out.title || "").slice(0, 80), code: clean(out.code), by });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "Could not draw the diagram" });
  }
}

function clean(code) {
  return String(code || "")
    .replace(/^\s*```(?:mermaid)?\s*/i, "").replace(/```\s*$/, "")
    .replace(/%%\{[\s\S]*?\}%%\s*/g, "")
    .trim();
}

// Providers in order: Groq (fast) → OpenRouter free.
// Groq calls capped at 9s, OpenRouter free at 15s (it is slow); 20s total.
// 429 = quota used → next provider; 5xx / network / bad JSON → retry once, then next.
const RETRIES = 1, DEADLINE_MS = 20_000, CALL_MS = 9_000, RETRY_STATUS = new Set([500, 502, 503, 504]);
const sleep = ms => new Promise(r => setTimeout(r, ms));

function openAI(name, url, key, model, extraHeaders = {}, callMs = CALL_MS) {
  return {
    name: `${name}:${model}`, callMs,
    request: prompt => [url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}`, ...extraHeaders },
      body: JSON.stringify({
        model, temperature: 0.3, response_format: { type: "json_object" },
        messages: [{ role: "user", content: prompt }],
      }),
    }],
    text: d => d?.choices?.[0]?.message?.content || "",
  };
}

function buildProviders() {
  const e = process.env, list = [];
  if (e.GROQ_API_KEY) {
    for (const m of (e.GROQ_MODELS || "openai/gpt-oss-120b,openai/gpt-oss-20b").split(","))
      list.push(openAI("groq", "https://api.groq.com/openai/v1/chat/completions", e.GROQ_API_KEY, m.trim()));
  }
  if (e.OPENROUTER_API_KEY) {
    for (const m of (e.OPENROUTER_MODELS || "openrouter/free").split(","))
      list.push(openAI("openrouter", "https://openrouter.ai/api/v1/chat/completions", e.OPENROUTER_API_KEY, m.trim(),
        { "HTTP-Referer": "https://skizze-app.vercel.app", "X-Title": "Skizze" }, 15_000)); // free router is slower
  }
  return list;
}

function parse(raw) {
  const m = String(raw).replace(/```json|```/g, "").match(/\{[\s\S]*\}/);
  const out = JSON.parse(m ? m[0] : raw);
  if (!clean(out.code)) throw new Error("empty output");
  return out;
}

async function callWithFallback(providers, prompt) {
  const end = Date.now() + DEADLINE_MS;
  let rateLimited = false;
  for (const p of providers) {
    for (let attempt = 0; attempt <= RETRIES; attempt++) {
      const left = end - Date.now();
      if (left < 1500) return { out: null, rateLimited };
      try {
        const [url, init] = p.request(prompt);
        const r = await fetch(url, { ...init, signal: AbortSignal.timeout(Math.min(p.callMs, left)) });
        if (r.ok) {
          try { const out = parse(p.text(await r.json())); console.log("served by", p.name); return { out, by: p.name }; }
          catch (e) { console.error("Bad model output", p.name, e.message); }
        } else {
          console.error("Model error", p.name, r.status, (await r.text()).slice(0, 200));
          if (r.status === 429) { rateLimited = true; break; }
          if (!RETRY_STATUS.has(r.status)) break;
        }
      } catch (e) {
        console.error("Model fetch failed", p.name, e.name);
      }
      if (attempt < RETRIES) await sleep(300 + Math.random() * 300);
    }
  }
  return { out: null, rateLimited };
}
