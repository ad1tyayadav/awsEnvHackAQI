# AGENTS.md: Instructions for the coding agent

You are building **Clean Air Day-Planner for Schools** for the AWS Bharat Build hackathon (Track 01: Air). The single source of truth is **`PRD.md`**. Read it fully before doing anything. If this file and the PRD ever conflict on process, this file wins; on product scope, the PRD wins.

The developer is working solo, relies on you for most of the code, and has a hard deadline. Your job is to build the PRD **reliably, one small verified step at a time**. A working small thing is always better than a large thing that almost works.

---

## 1. The core workflow (follow this exactly)

### Step A: Plan the phase into small tasks
Before writing any code for a phase:
1. Open `PROGRESS.md` (create it if missing, with one heading per PRD phase).
2. Break the current phase into **small tasks**. Each task must:
   - take roughly 30 minutes or less,
   - touch as few files as possible,
   - have a **"Verify by"** line: a concrete command or check that proves it works,
   - be independent enough to commit on its own.
3. Write the tasks as a checklist in `PROGRESS.md`:
   ```
   ## Phase 2: AQI fetch and storage
   - [ ] 2.1 Read OpenAQ v3 docs, confirm endpoints (Verify by: summary shown to user)
   - [ ] 2.2 openaq.ts: nearest-station lookup (Verify by: unit test with mocked response passes)
   - [ ] 2.3 ...
   ```
4. Show the task list to the developer and **wait for approval** before starting task 1 of a new phase.

### Step B: Build one task at a time
For each task, in order:
1. Announce which task you are starting.
2. Implement **only that task**. No extras, no "while I'm here" changes, no future-phase code.
3. Run the verification. Actually run it; do not assume it passes.
4. If verification fails: fix it, re-run, and repeat. If you are stuck after 3 attempts, **stop and report** the exact error and what you tried.
5. When it passes: tick the checkbox in `PROGRESS.md`, make a git commit (`phase-2: task 2.2 nearest station lookup`), and report using the format in section 4.
6. Move to the next task **only after the current one is verified and ticked**.

### Step C: Phase gate
When all tasks in a phase are ticked:
1. Run the phase's "Done when" checks from the PRD.
2. Report a phase summary: what was built, how to test it by hand, and anything left uncertain.
3. **Stop. Do not start the next phase** until the developer replies with approval (e.g. "next phase" or "approved").

### Hard rules about ordering
- **Never skip ahead.** Do not start task N+1 until task N is verified.
- **Never start the next phase without explicit approval.**
- **Never mark a task done without running its verification.**
- If a previous task turns out to be broken, stop and fix it before continuing. Record this in `PROGRESS.md`.
- If the PRD is unclear or you think it is wrong, ask. Do not silently change scope.

---

## 2. Scope discipline

- Build exactly what the PRD says. P0 first. P1 and stretch phases only after Phase 7 is complete and approved.
- **Do not add**: user login, maps, extra pages, SMS, extra AWS services, or new dependencies without asking.
- Prefer boring, simple solutions. Fewer moving parts means fewer things break in the demo.
- Avoid abstractions that serve only one use. Keep functions small and named clearly.
- Do not rewrite working code to "improve" it unless a task requires it.

## 3. Engineering rules

**General**
- TypeScript, strict mode. No `any` unless commented why.
- Pure logic (AQI math, tiers, dedupe, advisory text) lives in `/backend/src/lib` with **no AWS calls**, and has unit tests.
- Share the evaluate-and-alert code path between the scheduler and the simulate endpoint. Do not duplicate it.
- Validate all external input (API requests, OpenAQ responses). Handle errors with clear messages and correct status codes.
- Log meaningful lines (school id, tier, decision) to CloudWatch. Never log secrets.

**External APIs**
- **Never guess an API's shape from memory.** For OpenAQ, AWS SDK calls and SAM syntax, read the current official documentation first and say which doc you used. If you cannot access docs, say so and ask the developer to paste the relevant section.

**AWS and cost**
- Region is `ap-south-1`. Everything is defined in `backend/template.yaml` (SAM). No manual console-only resources.
- Serverless only. **Never create** NAT Gateways, EC2, RDS, OpenSearch, load balancers or anything that bills hourly.
- Least-privilege IAM: scope each Lambda to the specific tables, topic and actions it needs.
- Keep API Gateway throttling enabled. Cache Translate results in DynamoDB.
- Before deploying, state what resources will be created or changed.

**Secrets**
- Never commit AWS keys, the OpenAQ key, tokens or `.env` files. Use NoEcho SAM parameters or git-ignored env files. If you see a secret in code, remove it and tell the developer.
- Check `.gitignore` covers `.env*`, `node_modules`, `.aws-sam`, `.next`, `out`.

**Testing**
- Every task has a verification. Prefer: unit tests (Vitest), `sam local invoke` with a sample event, then curl against the deployed API.
- Mock AWS and OpenAQ in unit tests. Do not make real network or AWS calls in unit tests.

## 4. How to report after each task

Keep reports short and in plain language:

```
Task 2.2 done: openaq.ts finds the nearest PM2.5 station.
What I changed: <files>
How it works (3 lines max): ...
Verified by: <command> -> <result>
How you can check it yourself: <command or steps>
Next task: 2.3 <name>
```

At phase end, add: "Phase N complete. Reply 'next phase' to continue."

When something fails, report: the exact error, what you think caused it, what you tried, and what you propose. Do not hide failures or claim success without evidence.

## 5. Explain as you go

The developer must understand the project well enough to demo it and answer judges' questions. For every Lambda or major module, include a short plain-language explanation (about 3 lines) of what it does and why. Avoid jargon or define it briefly. Do not write long lectures.

## 6. Git hygiene

- Commit after every verified task with a clear message: `phase-<n>: task <n.m> <short description>`.
- Never commit broken or untested code to the main branch. If experimenting, use a branch.
- Do not force-push or rewrite history without asking.

## 7. Definition of "done" for the whole project

All items in PRD section 15 are ticked. Until then, keep working through `PROGRESS.md` in order, one task at a time, one phase at a time, with approval at each phase gate.

## 8. Quick checklist before you reply to the developer

- [ ] Did I do only the current task?
- [ ] Did I run the verification and see it pass?
- [ ] Did I update `PROGRESS.md` and commit?
- [ ] Did I avoid adding unrequested features or dependencies?
- [ ] Is there any secret in the diff?
- [ ] Did I tell the developer exactly what to do or approve next?