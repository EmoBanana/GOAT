# GOAT

**Gamuda's Overlaying Assisting Tool.** Shows the way. Logs your day. Pay as you go.

GOAT is an on-screen companion for engineers. A second cursor rides beside your mouse pointer
over any app, flies to the right button and talks you through company procedures.

## The problem

- Engineering software such as Forma Build and BIM tools is confusing. New staff and
  subcontractors waste hours finding the right button and the company's way of doing things.
- Engineers guess their timesheets at the end of the week.
- Partners pay monthly subscriptions for tools they only use a few times a month.

## The solution

Copilot knows your apps. GOAT knows your procedures.

- **Shows the way.** Press Ctrl+Option+G and ask. GOAT's cursor flies to each button in turn and
  explains the step. Everything else is answered by Gemma 4 running on the laptop, using the
  company's procedures as context. Highlight part of the screen to ask about just that, or hold
  Option+Cmd and just say it.
- **Logs your day.** Press Ctrl+Option+T and GOAT drafts your timesheet from the window titles of
  allowlisted work apps, grouped by project code. Check the day and export it to CSV.
- **Pay as you go.** Each assist is paid as you use it, with x402, instead of a monthly
  subscription.

## Business model

- **GOAT-compatible apps.** Software vendors such as Forma pay to make their app GOAT-compatible,
  and GOAT turns their documentation into cursor guides.
- **Pay per assist.** About one cent per assist, paid with x402.
- **GOAT Pro.** Voice mode and the better model; each assist is still paid per call.

## Why x402

x402 brings back HTTP 402 Payment Required: the server answers with a price, the app signs a
payment and retries, and the answer comes back with a receipt. That makes one-cent payments
practical where card fees would eat the whole cent. Users never pay gas: they sign an EIP-3009
authorization and the facilitator submits it.

## Wallet abstraction

Users never see a crypto address. GOAT creates a wallet behind the scenes, shows the balance in
ringgit and tops it up in one click. Payments settle in USDC on Base Sepolia for the demo.

## Privacy

Your data stays on your laptop.

- GOAT never reads your keystrokes.
- The screen is only read when you ask (the part you highlight, or the area around the pointer
  for a voice question) and is never stored. The same goes for the Keynote deck or browser page
  in front.
- Window titles are only read while timesheet tracking is on, and only from allowlisted apps. A
  browser tab counts as its site's name, never its address.
- Chats keep only the question and answer text, on the laptop, and you can delete them.
- The model runs on the laptop, so your questions stay on it. With web search on, only the search
  query goes out. In voice mode, the words of GOAT's spoken answer go to ElevenLabs to be voiced,
  never your question, screen or voice; GOAT can use the laptop's own voice instead.

## How it's built

An Electron overlay (the thin client) talks to an Express server (the brain), which decides each
time whether to play a guide, ask Gemma, or ask for payment. Gemma 4 E4B runs in Ollama on the
laptop. When no procedure covers a question, Gemma can search the web through the Brave Search
MCP server. Spoken answers are voiced by ElevenLabs, and payments use the x402 libraries with viem,
settled on Base Sepolia or by a local facilitator for offline demos.

## Try it

You need a Mac, Node 22 or later, and [Ollama](https://ollama.com).

```sh
npm install
ollama pull gemma4:e4b-it-qat
cp .env.example .env
npm start
```

macOS asks for Accessibility, the microphone and permission to see the screen the first time.
Optional keys go in `.env`: `REOWN_PROJECT_ID` for sign-in, `BRAVE_API_KEY` for web search, and
`ELEVENLABS_API_KEY` (in `.env.local`) for GOAT's voice.

| Keys (Ctrl+Alt on Windows) | What they do |
| --- | --- |
| Ctrl+Option+G | Ask GOAT. Hold and drag to ask about part of the screen. |
| Hold Option+Cmd | Talk to GOAT (Pro). On Windows, Ctrl+Alt+V. |
| Ctrl+Option+T | Start or stop tracking your day. |
| Ctrl+Option+A | Your account: balance, today's timesheet and chats. |
