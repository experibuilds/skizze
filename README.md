# Skizze

Describe a system, flow or data model in plain German or English → get a live, editable Mermaid diagram (export SVG/PNG, copy for Confluence/Jira/GitHub, open in mermaid.live).

**Live:** https://skizze.vercel.app

Stack: static HTML + Mermaid v11 · one Vercel serverless function (`api/diagram.js`) · free LLMs (Groq `gpt-oss-120b` → `gpt-oss-20b` → OpenRouter free). Invalid Mermaid is auto-repaired once. No user data stored.

Env vars (Vercel): `GROQ_API_KEY`, `OPENROUTER_API_KEY`. Ship with `./ship.sh "feat: …" minor`.
