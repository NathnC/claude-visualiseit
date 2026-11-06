# claude-visualiseit

**Diagrams instead of walls of text in Claude Code.** Type `/visualiseit` and Claude redraws its last reply as a picture. Turn on auto mode and it draws one by itself, but only when a reply is complex enough to need it.

**Before**

```text
Each server keeps its own session files on its own disk, and the load balancer has no sticky
sessions, so when a user logs in on Server A the session file is written there, then their next
request can land on Server B or C, which have no such file, so Laravel treats them as logged out.
Separately, the nightly deploy clears the storage folder, which deletes the files on Server A too...
```

**After**, right in the terminal:

```text
                       ┌──────────────┐
                       │ User logs in │
                       └───────┬──────┘
                               ▼
                    ┌────────────────────┐  ┌──────────────────┐
                    │   Load balancer    │  │ ! Nightly deploy │
                    │ no sticky sessions │  │ clears storage/  │
                    └─┬────────┬────────┬┘  └─────────────────┬┘
            request 2 │        │        │ request 1           ┆
                 ┌────┘        │        └───┐                 └┐
                 │             │ request 3  │ deletes sessions ┆
                 ▼             ▼            ▼                  ▼
┌─────────────────┐  ┌─────────────────┐  ┌─────────────────────┐
│   ✗ Server B    │  │   ✗ Server C    │  │     ✓ Server A      │
│ no session file │  │ no session file │  │ writes session file │
└───────────┬─────┘  └───────┬─────────┘  └─────────────────────┘
            ▼                ▼
          ┌───────────────────┐
          │ ✗ User logged out │
          └───────────────────┘
```

**Or as a page**, when it's too big for the terminal or you ask for one. Pages follow your light or dark theme:

![The same session diagram drawn as a web page](docs/page.png)

![A comparison table and a bar chart on a page in dark mode](docs/page-dark.png)

## Install: paste this into Claude Code

```text
Install the claude-visualiseit plugin for me from https://github.com/NathnC/claude-visualiseit.
1. Run: claude plugin marketplace add NathnC/claude-visualiseit
2. Run: claude plugin install visualiseit@claude-visualiseit
3. Check Node.js is on my PATH (node --version). The plugin needs it; tell me if it's missing.
4. Tell me to restart Claude Code, then summarise in two lines how to use /visualiseit and /visualiseit on.
```

Or type this at the Claude Code prompt:

```text
/plugin install visualiseit --marketplace NathnC/claude-visualiseit
```

Or install from a terminal:

```bash
claude plugin marketplace add NathnC/claude-visualiseit
claude plugin install visualiseit@claude-visualiseit
# then restart Claude Code
```

## Use

| Command | What it does |
|---|---|
| `/visualiseit` | Redraws Claude's previous reply as a diagram. |
| `/visualiseit the deploy part` | Draws only that part, or a topic you name. |
| `/visualiseit page` | Forces a page in your browser. |
| `/visualiseit terminal` | Forces a diagram in the terminal. |
| `/visualiseit on` | Turns on auto mode. It stays on for future sessions. |
| `/visualiseit off` | Turns off auto mode. `/visualiseit` still works. |
| `/visualiseit status` | Shows the current settings. |

You can also just ask, for example: "draw me that" or "explain that visually".

A redraw shows only what the reply said. Claude is told not to add facts, steps or numbers, and to keep a label vague where the reply was vague.

## When auto mode draws

Auto mode is off until you run `/visualiseit on`. Then, before a final reply, Claude asks whether the reply's main point is one of these structures:

- a process or request flow with branches, or 5+ steps
- 3+ components and how they connect
- 3+ options compared on 2+ criteria
- 5+ numbers being compared or ranked
- a before/after of how a system works
- 4+ dated or dependent items
- a root cause running through 3+ parts

It stays out of short answers, single facts, yes/no, code and diffs, commands, plain lists, confirmations, routine status and questions to you. If in doubt, it doesn't draw.

**The first time it fires, Claude Code asks to allow the skill.** Choose "don't ask again". `/visualiseit` itself never asks. To skip the prompt altogether, add this to your `~/.claude/settings.json`:

```json
{ "permissions": { "allow": ["Skill(visualiseit:visualiseit)"] } }
```

When it does draw, the visual replaces the explanation: Claude keeps the words around it to about 60, plus any exact commands you need.

Tested with real Claude runs on [28 prompts](evals/cases.json), 10 that should draw and 18 that shouldn't:

| Model | Drew when it should | Stayed quiet when it should | Median words beside the diagram |
|---|---|---|---|
| Sonnet | 10/10 | 18/18 | 56 |
| Opus | 10/10 | 18/18 | 53 |

That's one run per prompt, on prompts written while tuning the rules, so treat it as a sign the rules work rather than a measured accuracy. Run `node evals/run.mjs` to check it yourself.

## What it can draw

| Shape | For |
|---|---|
| `flow` | Parts and how they connect, branching logic, dependencies, cause and effect |
| `sequence` | Who calls whom, in order |
| `compare` | Options against criteria |
| `bars` | Quantities side by side |
| `timeline` | Dated or ordered events |
| `tree` | Hierarchies and file structures |
| `html` | Anything else, as custom SVG or HTML. Pages only |

Claude doesn't draw these by hand. It writes a few lines of plain text and a script does the layout, so boxes line up, labels don't collide and bars are to scale. That also uses far fewer tokens than having Claude write out a whole SVG:

```text
title: Why users get logged out at random

flow: What happens to one user's session
User logs in -> Load balancer
Load balancer -> Server A | request 1
Load balancer -> Server B | request 2
Server B -> User logged out
Nightly deploy --> Server A | deletes sessions
```

The script picks the output. A small diagram goes in the terminal. Anything wider than `width`, taller than 60 lines, with more than two sections or with lots of crossing lines becomes a page. Set `surface` or use `page` and `terminal` to choose for yourself.

## Safety

Diagrams often describe code, logs and web pages you didn't write, so a page is treated as untrusted content.

- **Pages can't run anything or call out.** Each one is a single file with a Content-Security-Policy of `default-src 'none'`, and it has no scripts and loads nothing from the network. Custom HTML also has scripts, event handlers, frames, forms, remote links and redirects removed before it's written.
- **Things that look like secrets are masked.** API keys, tokens, JWTs, private keys, passwords and credentials in URLs become `[masked]` in both outputs, and Claude tells you when that happens. This is pattern matching, so it can miss one. Claude is also told to leave secrets out.
- **Terminal output is cleaned.** Escape sequences and bidirectional text overrides are stripped from labels, so a label can't rewrite your terminal or disguise what it says.
- **Pages stay on your machine.** They're saved to `~/.claude/visualiseit/pages/`, only your user can read them on macOS and Linux, and they're deleted after 14 days. Nothing is uploaded by the plugin.
- **The script has no dependencies**, so there's nothing to install from npm. It never makes a network request.
- **The skill can only run its own script.** Its permission is pinned to that one path, so it doesn't open up `node` in general. `node -e` still needs your approval while the skill is running.

The test suite includes 29 attempts to get active content past the sanitiser. Hostile pages were also loaded in a real browser, with and without the sanitiser, against a local server logging every request: no script ran and no request arrived.

## Config (optional)

Settings go in `~/.claude/visualiseit/config.json`:

```json
{
  "auto": false,
  "surface": "auto",
  "open": true,
  "keepDays": 14,
  "width": 78
}
```

- `auto` is what `/visualiseit on` and `off` change.
- `surface` can be `auto`, `terminal` or `page`.
- `open: false` writes pages without opening a browser. It's also skipped over SSH or with no display, and you get the path instead.
- `keepDays` is how long pages are kept. They're cleaned up whenever a new page is written.
- `width` is the widest a terminal diagram can be, from 40 to 240 characters.

## Limits

- **Auto mode is Claude's judgement, not a guarantee.** It's instructions rather than a hard rule, so it can occasionally miss a reply that deserved a picture, or draw one you didn't need. `/visualiseit` covers the misses.
- **Token cost:** auto mode adds about 230 tokens at session start and about 25 per prompt. Each diagram then costs its JSON plus, for the terminal, the pasted diagram. With auto mode off, the only cost is the skill's one-line listing.
- **Terminal diagrams need a monospace font with box-drawing characters,** and a window at least as wide as `width`. Emoji and CJK widths vary by terminal, so those labels can shift by a character in some.
- **Pages open a browser tab,** including when auto mode draws one you didn't ask for. Set `open` to `false` if you'd rather click the path.
- **`claude -p` and the SDK:** auto mode is off in scripted runs, so it won't draw into piped output. `/visualiseit` still works if you ask for it.
- **[`claude-incognito`](https://github.com/NathnC/claude-incognito):** incognito sessions never write a page, because a page would outlive the session that's being deleted. Diagrams stay in the terminal.
- **Mid-session `off`:** Claude is told to stop, but the check it read earlier stays in its context until the session compacts or ends.
- Needs Node.js on `PATH`. Claude Code installed through npm already has it.

## Develop

```bash
node --test                 # unit tests, no tokens used
claude --plugin-dir .       # run it from this folder
claude plugin validate .    # check the manifest and hooks
node evals/run.mjs          # measure auto mode's judgement. Uses real tokens, about $1.25 on Sonnet
```

## Uninstall

```bash
claude plugin uninstall visualiseit@claude-visualiseit
claude plugin marketplace remove claude-visualiseit
```

Then delete `~/.claude/visualiseit/`, which holds your settings and saved pages.

## License

MIT
