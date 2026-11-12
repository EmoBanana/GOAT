# GOAT

**Gamuda's Overlaying Assisting Tool** is an on-screen companion for engineers. A second cursor, a
small kopitiam cup, rides beside your pointer in any app. Ask how to do something and it flies to
each button in turn and tells you what to do there. Ask anything else and an AI model running on
the laptop answers from your company's procedures and whatever is on screen. GOAT can also write up
your day as a timesheet, and it charges a cent or less per assist with x402 micropayments instead
of a subscription.

## What it does

- **Guides.** A guide plays step by step: the cursor flies to each control, rings it and says what
  to do. Steps that say "click" wait for your click. Each step finds its control on screen again
  before it plays, so a different resolution, window size or scroll position doesn't throw it off.
- **Guides GOAT plans itself.** For a how-to question with no guide for it, GOAT reads the controls
  on screen (page JavaScript in Chrome, Edge, Brave, Arc and Safari, macOS Accessibility elsewhere)
  and Gemma plans the steps. "Show me how to search in Google" opens Google first, then shows you
  there.
- **Answers.** Gemma 4 E4B answers from the procedures in `docs/` and the related guides. When
  nothing covers the question it thinks first, on a time budget, and with a Brave key it can search
  the web through the Brave MCP server.
- **Context.** Hold Ctrl+Option+G and drag to ask about one part of the screen. With Keynote or a
  browser in front, GOAT reads the whole deck or page for that question.
- **Voice (Pro).** Hold Option+Cmd, talk, let go. Gemma transcribes the question, which also sees
  the screen around the pointer, and GOAT says the answer aloud (through ElevenLabs, or with the
  Mac's own voice).
- **Timesheet.** Ctrl+Option+T starts and stops tracking. GOAT samples the front window of
  allowlisted apps, Gemma writes the day as activities grouped by project (from
  `config/projects.json`, or the project field of an ISO 19650 file name in the title), and the day
  exports to CSV.
- **Pay per assist.** Each assist is paid over x402: the app signs an EIP-3009 authorization for test
  USDC and a facilitator settles it, against a local ledger by default or on Base Sepolia. A wallet
  abstraction keeps addresses out of sight: balances show in ringgit beside USDC, top-ups are one
  click, the wallet lists recent payments, and Pro (voice and the Pro model) is bought the same way.
  An answer that fails is never charged.
- **Accounts and chats.** Sign in in the browser with Reown AppKit (email, Google or a wallet you
  have), or continue offline. Ctrl+Option+A opens your account card with your balance, today's
  timesheet and your chats; a chat opened from there continues with follow-ups.
- **Downloads.** `npm run package` builds the Mac and Windows apps, and `web/` is the download page.

## Hotkeys

| macOS | Windows | What it does |
| --- | --- | --- |
| Ctrl+Option+G | Ctrl+Alt+G | Ask GOAT. Hold it and drag to ask about part of the screen. |
| Hold Option+Cmd | | Talk to GOAT (Pro): listens while held, sends when you let go. |
| Ctrl+Option+V | Ctrl+Alt+V | Talk as a toggle: press to listen, press again to send. |
| Ctrl+Option+T | Ctrl+Alt+T | Start tracking the timesheet; press again to stop and see the day. |
| Ctrl+Option+A | Ctrl+Alt+A | Your account: balance, today's timesheet and chats (sign-in before that). |

## How it works

A thin client and a smart server. Every action in the app is an HTTP call, and the server decides
what happens.

```
app/ (Electron, thin)                          server/ (Express, decides)
hotkeys, voice, window context   ── HTTP ──►   a guide matches?           → its cursor path
x402 payments (wallet abstraction)             a how-to with controls?    → steps Gemma plans
                                               anything else              → Gemma 4 + procedures
cursor flies, step bubbles, spoken answers ◄── every assist               → paid over x402
```

Only the Electron main process holds wallet keys; the overlay page is sandboxed and talks to it
through a small preload bridge. Pro is checked on the server, and the server owns the model.

## Run it

You need macOS (it was built on an Apple silicon Mac with 16 GB), Node 22 or later, and
[Ollama](https://ollama.com).

```sh
npm install
ollama pull gemma4:e4b-it-qat
cp .env.example .env     # the defaults work offline
npm start                # the server on http://127.0.0.1:8402, then the overlay
```

On first use macOS asks for:

- **Accessibility**: window titles for the timesheet and the controls on screen.
- **Microphone**: voice.
- **Screen Recording**: highlighted areas and the screen around the pointer for voice questions.
- **Automation**: reading the deck in Keynote or the page in a browser. Chrome and Edge also need
  View > Developer > Allow JavaScript from Apple Events (Safari: Develop > Allow JavaScript from
  Apple Events).

Started from an editor's terminal, macOS grants these to the editor.

Optional settings, in `.env` (keys in `.env.local`, which git ignores):

| Setting | What it turns on |
| --- | --- |
| `REOWN_PROJECT_ID` | Sign-in in the browser. Get a free project ID at dashboard.reown.com. Without it, choose Continue offline. |
| `BRAVE_API_KEY` | Web search for questions the procedures don't cover. |
| `ELEVENLABS_API_KEY` (in `.env.local`) | GOAT's spoken voice. `GOAT_TTS=system` uses the Mac's voice instead. |
| `GOAT_PAYMENTS=x402` and `CDP_*` | Real settlement on Base Sepolia. The default, `x402-local`, settles against a local ledger offline. |
| `GOAT_PRICE_USD`, `GOAT_PRO_PRICE_USD`, `MYR_PER_USD` | The price per assist, the price of Pro, and the ringgit rate shown. |

`.env.example` lists every setting with a note on each.

If the app dies at launch with `app` undefined, the terminal set `ELECTRON_RUN_AS_NODE` (VS Code
extensions do): run `unset ELECTRON_RUN_AS_NODE`. If Electron's binary is missing, run
`node node_modules/electron/install.js`.

## Tests

The tests run offline, against a mock Ollama and a local x402 facilitator. Install Playwright's
Chromium once with `npx playwright install chromium`.

```sh
npm test                 # server and app logic
npm run test:ui          # the overlay in Chromium, with the app bridge stubbed
npm run test:electron    # the real app, end to end, off screen
npm run test:package     # the packaged app
npm run smoke            # the real model on this Mac: a chat answer and a spoken question
cd web && npm run build && npm test   # the download page
```

## Packaging and the download page

```sh
npm run package -- --server http://192.168.1.20:8402      # the Mac app, zipped into dist/
npm run package -- --platform win32 --server http://192.168.1.20:8402
```

A packaged app talks to the GOAT server it was built for. That server lists the builds at
`/api/downloads` and serves them at `/download/<file>`. The download page in `web/` (Next.js, a
static export) links to them, or to Vercel Blob after `npm run publish-build -- --upload` in `web/`.
The Windows build is a beta.

## Layout

| Path | What's there |
| --- | --- |
| `server/` | Express: the assist router, guides and matching, the Gemma client, payments, timesheets, accounts and chats |
| `app/` | Electron: the overlay window, hotkeys, wallet, window sampler and screen controls; `app/renderer/` is the overlay itself |
| `guides/` | Cursor guides as JSON |
| `docs/` | The procedures Gemma answers from (a sample site-issue procedure) |
| `config/` | Timesheet projects and allowlisted apps, and the MCP servers |
| `web/` | The download page |
| `scripts/` | The dev runner, tests and packaging |

## Privacy

- No keystrokes. Push-to-talk only reads whether Option and Cmd are held.
- The screen is read only when you ask (the area you highlight, or the area around the pointer for
  a voice question), and it is never stored. The same goes for the deck or page in front.
- Window titles are read only while tracking is on, and only from allowlisted apps. For browsers
  the timesheet keeps the site's name, never its address.
- Chats keep only the question and answer text, on the laptop, and you can delete them. The account
  keeps an address and how you signed in, never keys or tokens.
- The model runs on the laptop. With a Brave key, the model's search query leaves it; with
  ElevenLabs, the text of spoken answers goes to ElevenLabs (`GOAT_TTS=system` keeps it local).
