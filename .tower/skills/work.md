# work — how a flight is flown

You are one agent flying one flight. You have no memory of the ones before you and the ones after you have none of yours. Everything that matters goes on the board.

## Claim, then read

The orchestrator claims your flight and tells you its number and the worktree to fly it from. `ff tower brief <n>` is the specification: body, comments, and any question already answered. Read the whole brief before touching a file — an earlier agent may have stopped mid-flight and left you the state.

`DESIGN.md` at the repo root is the standing design. The brief names the sections that bind your flight; read those and skip the rest.

## The repo

Writes go through `ff`, never `git`. `ff commit -m "…"` closes the open change — no add, no staging, the worktree is the change. `ff status`, `ff log`, `ff diff` read. Anything else git does: `ff git <args…>`.

fufu is strict: it replays, it does not merge. Never switch branches, never restack, never touch `main`. You were handed a branch and a worktree; stay on both and commit there. Switching parks your uncommitted work somewhere you will not think to look for it.

Commit messages are `area: summary`, blank line, then an unwrapped body carrying the detail. American spelling, one line per paragraph, no hard wrap. Plain declarative.

Node 24 and npm 11 are on the machine and the npm registry is reachable. A fresh bay has no `node_modules` — run `npm install` once before building. Never start a dev server or a watch: every command you run must exit on its own. Truncate noisy output with `… 2>&1 | tail -20`.

Stay inside your flight. Other flights own other files, and the brief says which pieces are not yours. A shared file you must touch — `package.json`, `wxt.config.ts` — you touch minimally and say so in a comment, because another agent may be editing it in another bay right now.

## Styling, where your flight has UI

daisyUI semantic colors only (`primary`, `base-100`, `base-content`, `error`…), never raw Tailwind palette. `gap` on flex and grid containers, not margins between siblings. Plain `<label class="flex flex-col gap-2">` markup — no `form-control`, `label-text`, `input-bordered`, or `fieldset`. Svelte 5 runes, never legacy reactive syntax.

## Asking a question

Ask only what is genuinely Tyler's to answer: an open question DESIGN.md already names, a design choice the brief left silent that changes the shape of the work, or a credential or account you cannot obtain. Anything you can decide from the brief and the design note, decide — then record the decision in a comment so the next agent does not reopen it.

Before you ask, put the state on the record:

```
ff tower comment <n> -m "…"
ff tower hold <n> -m "the question"
```

The comment is the handoff. A different agent, holding none of your context, must be able to resume from it: what you did, which files you wrote and what is in them, what you tried and what it did, where exactly you stopped, the options you see and which you would take. Write it long. A comment that only says "blocked on X" wastes the flight.

Commit whatever is finished before you hold. Uncommitted work does not survive the branch switch the next claim performs, and a hold whose state is only in the working tree strands the agent that follows you.

`hold` exits 3. That is the outcome, not an error. Stop there and report — do not work around the question, and do not guess.

## Finishing

Run the verification the brief names, and paste what it actually printed into a closing comment: what landed, file by file, what the checks said, and anything the next flight needs to know.

Do not run `ff tower done` and do not move the status. Verification is the orchestrator's, and it reads your comment. Your last act is the comment; then report and stop.
