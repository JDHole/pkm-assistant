# PKM Assistant — Quick Start Guide

> **For beta testers — version 2.2.0**
> Installation time: ~5 minutes. Configuration time: ~10 minutes.

> **NOTE:** This project is 100% vibe-coded by a non-coder (JDHole) with Claude Opus 4.6 via Claude Code (VS Code). Bugs or suboptimal solutions may occur. Report them to the author!

---

## Table of Contents

1. [Installation](#1-installation)
2. [API Key Configuration](#2-api-key-configuration)
3. [First Chat with Jaskier](#3-first-chat-with-jaskier)
4. [Interface — What's Where](#4-interface--whats-where)
5. [Main Features — How to Use](#5-main-features--how-to-use)
6. [Autonomy](#6-autonomy)
7. [Agents — Creating and Managing](#7-agents--creating-and-managing)
8. [Skills — Agent Abilities](#8-skills--agent-abilities)
9. [Memory System](#9-memory-system)
10. [Advanced — Sub-agents and MCP Servers](#10-advanced--sub-agents-and-mcp-servers)
11. [Settings Worth Knowing](#11-settings-worth-knowing)
12. [Troubleshooting](#12-troubleshooting)
13. [How to Report a Bug](#13-how-to-report-a-bug)

---

## 1. Installation

### Step by step

1. **Download the plugin files** from the author. You need 3 files:
   - `main.js` (~2.3 MB)
   - `manifest.json`
   - `styles.css`

2. **Find the Obsidian plugins folder:**
   - Open Obsidian → Settings → Community Plugins
   - Click the folder icon next to "Installed plugins" (opens `.obsidian/plugins/`)
   - If you don't see the icon: manually navigate to `YourVault/.obsidian/plugins/`

3. **Create the plugin folder:**
   - In the `plugins/` folder, create a new folder named `pkm-assistant`
   - Copy the 3 downloaded files into `pkm-assistant/`

4. **Enable the plugin:**
   - In Obsidian: Settings → Community Plugins
   - Find "PKM Assistant" in the list → toggle it on
   - The plugin should appear in the list without errors

5. **Verify:** In the left ribbon (sidebar with icons), 2 new icons should appear:
   - Chat icon (opens PKM Assistant Chat)
   - Agent icon (opens Agent Manager)

> **Not working?** See: [Troubleshooting](#12-troubleshooting)

---

## 2. API Key Configuration

The plugin needs an API key from an AI provider. **Without it, the chat won't work.**

### Option A: DeepSeek (RECOMMENDED to start)

Why: Cheapest (fraction of Claude/GPT price), good quality, supports reasoning.

1. Sign up at [platform.deepseek.com](https://platform.deepseek.com)
2. Top up your account (min. $2, enough for weeks of testing)
3. Copy your API key
4. In Obsidian: Settings → PKM Assistant → Klucze API (API Keys)
5. Find the "DeepSeek" row (under Cloud Platforms) and paste your key there
6. In the "Modele" (Models) section, select:
   - **Main model:** `deepseek-chat` (for conversation) or `deepseek-reasoner` (with thinking)
   - **Sub-agent model:** `deepseek-chat` (cheaper, for background work)

### Option B: Ollama (FREE, local, no internet needed)

Why: Zero cost, privacy, works offline. Requires RAM (min. 8GB for small models).

1. Install [Ollama](https://ollama.ai)
2. In terminal: `ollama pull llama3.1:8b` (or another model)
3. Run Ollama (should listen on `http://localhost:11434`)
4. In Obsidian: Settings → PKM Assistant → Klucze API (API Keys)
5. Under "Local Platforms", find the "Ollama (local)" row and type the server address: `http://localhost:11434` (that's the default — type it even though it also shows as greyed-out placeholder text; an empty field means Ollama won't show up as a model platform). This is a host address, not an API key.
6. In the "Modele" (Models) section, select Ollama as the platform and choose a model

### Option C: Claude (Anthropic)

1. Account at [console.anthropic.com](https://console.anthropic.com)
2. Add credits ($5+)
3. Copy your API key
4. Settings → PKM Assistant → Klucze API (API Keys) → find the "Anthropic (Claude)" row and paste your key there
5. Model: `claude-sonnet-4-20250514` (good price/quality ratio)

### Option D: OpenAI, Gemini, Groq, OpenRouter, LM Studio, xAI

The plugin supports 9 platforms. Each requires an API key (except Ollama/LM Studio). Configuration is similar — paste the key, choose a model.

---

## 3. First Chat with Jaskier

1. Click the chat icon in the left ribbon (or `Ctrl+P` → "PKM Assistant: Open chat")
2. You should see a chat window with "Jaskier" at the top
3. Type anything, e.g.: *"Hey, who are you?"*
4. Jaskier should respond — this is your first AI agent in Obsidian!

### What Jaskier can do right away:
- **Read your notes** — "Read my note about..."
- **Search the vault** — "Find notes about topic X"
- **Create notes** — "Write a note about..."
- **Remember** — "Remember that I like coffee" → "What do you know about me?"
- **Plan** — "Create a plan for project X"
- **Delegate** — "Research topic Y" (delegates to a sub-agent)

---

## 4. Interface — What's Where

### Chat Window (left panel)

```
+--------------------------------------+
| [Jaskier v]  [Eye]  [Mode]          |  <- Header: agent, eye, mode
+--------------------------------------+
|                                      |
|  Message area                        |  <- Conversation appears here
|  (bubbles, tool calls, thinking)     |
|                                      |
+--------------------------------------+
| [Skill 1] [Skill 2] [Skill 3]       |  <- Skill bar (clickable)
+--------------------------------------+
| [Clip] [Type a message...] [> Send]  |  <- Input + attachments + send
+--------------------------------------+
```

### Agent Manager (right sidebar)

Click the agent icon in the ribbon. You'll see:
- **Home screen** — agent cards + sections (communicator, backstage)
- **Agent profile** — click a card → 9 tabs (Overview, Persona, Skills...)
- **Backstage** — overview of skills, MCP tools, sub-agents

---

## 5. Main Features — How to Use

### 5.1 Chat with AI

Type a message → Enter (or click Send). The agent responds, and you'll see:
- **Message bubbles** — yours (right) and the agent's (left, with crystal avatar)
- **Tool calls** — colored blocks showing what the agent is doing (reading a note, searching, writing...)
- **Thinking blocks** — if the model supports reasoning (DeepSeek Reasoner, Claude), you'll see "Thinking..."

### 5.2 Reading and Writing Notes

The agent has access to your vault through MCP tools:
- **"Read note X"** → `vault_read` — agent reads the file
- **"What's in folder Y?"** → `vault_list` — agent lists files
- **"Write a note about Z"** → `vault_write` — agent creates/edits a file
- **"Delete note X"** → `vault_delete` — agent deletes a file (with confirmation!)
- **"Find notes about topic X"** → `vault_search` — semantic search

> **IMPORTANT:** When writing/deleting, the plugin asks for approval (unless the chat's autonomy is set to YOLO — see section 6).

### 5.3 @ Mentions (referencing notes)

In the message input, type `@` — a dropdown will appear with notes and folders:
- `@note_name` — inserts the note's content into the message context
- `@folder:name/` — inserts content from files in the folder (max 5)
- Fuzzy search works (no need to type the full name)

### 5.4 Attachments

- Click **clip icon** next to the input → select a file
- Or **drag & drop** a file onto the chat window
- Or **Ctrl+V** to paste an image from clipboard
- Supported: images (PNG/JPG → vision), PDF (text extraction), text files (MD/TXT/JS/JSON...)

### 5.5 Eye (Active Note Awareness)

The **Eye** button in the chat header:
- **On (default):** Agent sees what you have open in the editor and responds contextually
- **Off:** Agent doesn't know what you're editing

### 5.6 Web Search

The agent can search the internet:
- *"Search the web for latest info about..."*
- Jina (the default provider) works out of the box without a key, rate-limited; add a free Jina API key (configured in Settings) to raise the limit
- Tavily, Brave Search, and Serper.dev each require their own API key

### 5.7 Artifacts (Todo + Plans)

The agent creates interactive widgets in chat:
- **Todo lists** — "Make me a task list for today" → clickable widget with checkboxes
- **Creation plans** — "Plan project X" → numbered steps with subtasks and statuses
- Artifacts are **global** — they survive restarts, agent switches, new sessions
- Artifact panel: right toolbar → list icon

### 5.8 Approval System

By default, the agent asks for permission to:
- Write to vault (`vault_write`)
- Delete files (`vault_delete`)
- Search the web

**Autonomy** (per-chat, in the input bar): set it to **YOLO** to let the agent act without asking. See section 6. Default autonomy for new chats is configurable in Settings.

---

## 6. Autonomy

Autonomy controls **when the agent asks you before acting** — it does NOT change what the agent is allowed to do (that's Permissions). Three levels:

| Autonomy | Icon | What it does |
|----------|------|--------------|
| **YOLO** | Rocket | Never asks — no approval prompts, no diff previews. Fastest, least safe. |
| **Ask at the edge** | Shield | Asks only for "edge" actions: writing, deleting, web, sending, delegation, MCP, commands, building agents. **Default.** |
| **Ask about everything** | Magnifier | Asks before every tool (except asking you questions). Maximum control. |

Change it: the autonomy button in the input bar → popover with the 3 options. It's per-chat — each tab remembers its own. Even **YOLO never bypasses** No-Go zones, protected files, your whitelist, or the agent's permissions — it only removes the questions.

---

## 7. Agents — Creating and Managing

### Jaskier (built-in)

Jaskier is the default mentor agent. He cannot be deleted (only edited). He knows about:
- Obsidian and PKM
- Creating new agents
- Teaching you how to use the plugin

### Creating a new agent

**Method 1 — through UI:**
1. Agent Manager → "New agent"
2. A blank agent is created instantly — open its profile and fill in: name, emoji, personality (legacy `archetype`/`role` fields are ignored by the runtime)
3. Save → agent ready for chat

**Method 2 — through conversation with Jaskier:**
- *"Jaskier, help me create a new agent for writing blog posts"*
- Jaskier will guide you through the process step by step

### Switching agents

In the chat header: click the agent name → dropdown with list → select another. Each agent has a **separate tab** — you can talk to multiple agents simultaneously!

### Agent profile (9 tabs)

1. **Overview** — hero card: name, emoji/crystal color, description, quick stats
2. **Persona** — a single free-text field defining who the agent is
3. **Skills** — assigned skills by category + connectors (external MCP servers)
4. **Team** — this agent's own sub-agents (tiles, add/edit)
5. **Permissions** — one tool on/off axis, workspace (focus folders / No-Go zones), and when it asks (autonomy + per-tool approval)
6. **Memory** — brain notes, "For now" section, sessions, L1/L2/L3 summaries
7. **Artifacts** — this agent's live plans/todos + which artifact types it may create
8. **Prompt** — Inspector (preview the full system prompt) + Editor (core rules + work prompts)
9. **Advanced** — model, temperature, language, memory automation, service actions

---

## 8. Skills — Agent Abilities

Skills are ready-made "recipes" that an agent can execute. Like macros, but intelligent.

### Using a skill

1. Click the skill name in the **skill bar** (below the chat area)
2. If the skill has **pre-questions** — fill out the form
3. The skill's prompt is inserted into the input → send

### Example built-in skills

- **daily-review** — review of the day, what you did, what's next
- **vault-organization** — analysis and organization of notes
- **note-from-idea** — creating a note from a loose idea
- **weekly-review** — weekly summary

### Creating your own skills

Agent Manager → Backstage → Skills → "New Skill" → form with 13 fields. Or ask Jaskier: *"Create a skill for analyzing scientific articles"*

---

## 9. Memory System

Each agent has its own memory:

### brain.md (long-term)
- Agent remembers facts about you: *"User has a dog named Buddy"*
- Automatically extracted from conversations by MemoryExtractor
- Commands: *"Remember that..."*, *"What do you know about me?"*, *"Forget about..."*

### Sessions (short-term)
- Each conversation is a session saved to a file
- Automatically compressed into summaries (L1 = 5 sessions → 1 summary)

### How it works in practice
- Agent **always** sees your brain.md in the system prompt
- Agent **can search** memory semantically (tools: `memory_brain`, `memory_sessions`, `memory_summaries`)
- On a new session: sub-agent automatically prepares context (auto-prep)

---

## 10. Advanced — Sub-agents and MCP Servers

### Sub-agents (delegating work)

An agent can delegate tasks to sub-agents — specialized versions running on cheaper AI models:

- **Generic worker** — delegating without naming a specific sub-agent runs a built-in "pkm-sub" worker (search/list/read/web search — a cheap, researcher-level toolset). Always available; shown as a read-only card in Backstage.
- **`<agent-name>-prep`** — a new custom agent automatically gets one sub-agent of its own with this name, used to gather context at the start of a new session (auto-prep).
- Build additional custom sub-agents yourself with your own tools and instructions (Agent profile → Team, or Backstage → Sub-agents).
- Visible as "Sub-agent working..." blocks in chat.

### MCP Servers (extensible tools)

MCP servers are tool packages that agents can dynamically load:
- **connect_to_server()** — no arguments = catalog, with argument = connect
- Servers live in `.pkm-assistant/mcp-servers/` in your vault
- You can create your own servers (ask Jaskier for help!)

### Extended Thinking

If the model supports reasoning (DeepSeek Reasoner, Claude, Gemini 2.5, etc.):
- Enable in Settings → PKM Assistant → "Show AI thinking"
- "Thinking..." blocks show the model's reasoning process
- Works on ALL 9 AI platforms

### Model Configuration

Settings → PKM Assistant → Modele (Models):
- **Main model** — for conversation (e.g., DeepSeek Chat, Claude Sonnet)
- **Sub-agent model** — cheaper, for background work (e.g., DeepSeek Chat, Haiku)
- **Embedding model** — for vectors (e.g., Ollama + snowflake-arctic-embed2)

---

## 11. Settings Worth Knowing

Settings → PKM Assistant:

| Setting | Where | What it does |
|---------|-------|-------------|
| **Autonomy** | Chat input bar | Per-chat: when the agent asks before acting (YOLO / Ask at the edge / Ask about everything) |
| **Default autonomy** | Advanced | Autonomy level new chats start with |
| **Show AI thinking** | Appearance | Shows "Thinking..." blocks with reasoning |
| **Eye** | Memory | Active note awareness |
| **Prompt Builder** | Agent Profile → Prompt tab | Preview and edit the FULL system prompt |
| **Decision Tree** | Agent Profile → Prompt tab | 17 behavior instructions for the agent — toggle on/off |
| **Crystal Soul** | Appearance | Regenerate color theme |

---

## 12. Troubleshooting

### Plugin doesn't load
- Check that you have 3 files in `.obsidian/plugins/pkm-assistant/` (main.js, manifest.json, styles.css)
- Check your Obsidian version (min. 1.11.0)
- Open console (`Ctrl+Shift+I`) → check for errors (red)

### Chat doesn't respond
- Check the API key in Settings → PKM Assistant → Klucze API (API Keys)
- Check that you selected a model in Settings → PKM Assistant → Modele (Models)
- For Ollama: check that the server is running (`ollama list` in terminal)
- For Ollama: the host field (Klucze API → Local Platforms) can't be empty — Ollama won't show up as a model platform until it has an address (default `http://localhost:11434`)

### Agent "loops" (repeats tools)
- This is a known issue with short prompts on weaker models
- Try a better model (DeepSeek Reasoner, Claude Sonnet)
- Or switch mode to "Conversation" (limits available tools)

### Search doesn't work (vault_search)
- Check if embeddings have been indexed (status bar → "Indexing X/Y")
- Embedding requires Ollama + snowflake-arctic-embed2 (or another provider)
- If no embedding model → fallback to keyword search (lower quality)

### Error "Cannot read property..." / crash
- Open console (`Ctrl+Shift+I`), take a screenshot, send to the author
- Try restarting Obsidian
- Try disabling and re-enabling the plugin

### Build size (~2.3 MB)
- This is normal — it's the plugin's own code (agents, memory, tools, chat, models).
- The old base framework the plugin started from was removed early in the v2 refactor.

---

## 13. How to Report a Bug

Send the author (JDHole) a message with:

1. **What you were doing** — step by step
2. **What happened** — exact description / screenshot
3. **What should have happened** — expected behavior
4. **Console** — `Ctrl+Shift+I` → Console tab → screenshot of red errors
5. **AI model** — which provider and model (e.g., DeepSeek Chat)

### Known issues (don't report these)
- Settings UI overwhelming → we know, improvements planned

---

> **Thank you for testing!** Every piece of feedback is invaluable.
> This plugin is proof that non-coder + AI = something real.
>
> *All code generated by Claude Opus 4.6 via Claude Code (VS Code)*
> *Author: JDHole — vision, prompt engineering, testing*
