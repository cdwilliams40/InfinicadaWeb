#!/usr/bin/env node
/**
 * Runs the synthetic user prompts through Claude Code (headless) connected to a
 * local server, and records which tools the model chose, their results and
 * the final answer.
 *
 * Needs the Claude Code CLI logged in (`claude`, then /login).
 *
 *   pnpm dev                      # in another terminal
 *   node evals/run.mjs [--base http://localhost:8787] [--model sonnet] [--only id1,id2] [--concurrency 4]
 *
 * Results contain your Garmin data and go to evals/results/ (git-ignored).
 */
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const args = Object.fromEntries(
  process.argv.slice(2).flatMap((arg, index, all) => (arg.startsWith("--") ? [[arg.slice(2), all[index + 1]]] : [])),
);
const base = args.base ?? "http://localhost:8787";
const model = args.model ?? "sonnet";
const concurrency = Number(args.concurrency ?? 4);
const only = args.only?.split(",");

const prompts = JSON.parse(readFileSync(join(root, "evals/prompts.json"), "utf8")).filter(
  (prompt) => !only || only.includes(prompt.id),
);
const outDir = join(root, "evals/results", new Date().toISOString().replace(/[:.]/g, "-"));
mkdirSync(outDir, { recursive: true });

/** OAuth as a regular client would: dynamic registration, consent with the owner password, PKCE. */
async function accessToken() {
  const password = readFileSync(join(root, ".env"), "utf8").match(/^OWNER_PASSWORD=(.*)$/m)?.[1];
  if (!password) throw new Error("OWNER_PASSWORD is missing from .env");
  const redirect = "http://localhost:9999/callback";
  const b64 = (buffer) => buffer.toString("base64url");
  const post = (path, body, headers = {}) => fetch(`${base}${path}`, { method: "POST", redirect: "manual", headers, body });

  const client = await (
    await post("/register", JSON.stringify({ client_name: "evals", redirect_uris: [redirect], token_endpoint_auth_method: "none" }), {
      "content-type": "application/json",
    })
  ).json();
  const verifier = b64(randomBytes(32));
  const query = new URLSearchParams({
    response_type: "code",
    client_id: client.client_id,
    redirect_uri: redirect,
    code_challenge: b64(createHash("sha256").update(verifier).digest()),
    code_challenge_method: "S256",
    state: "evals",
    scope: "garmin:read",
    resource: `${base}/mcp`,
  });
  const consent = await fetch(`${base}/authorize?${query}`);
  const handle = (await consent.text()).match(/name="handle" value="([^"]+)"/)?.[1];
  const cookie = consent.headers.getSetCookie().map((value) => value.split(";")[0]).join("; ");
  const approval = await post(`/authorize?${query}`, new URLSearchParams({ handle, decision: "approve", password }), {
    cookie,
    "content-type": "application/x-www-form-urlencoded",
  });
  const code = new URL(approval.headers.get("location")).searchParams.get("code");
  const token = await (
    await post(
      "/token",
      new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: redirect, client_id: client.client_id, code_verifier: verifier, resource: `${base}/mcp` }),
      { "content-type": "application/x-www-form-urlencoded" },
    )
  ).json();
  return token.access_token;
}

function runClaude(prompt, configPath) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(
      "claude",
      [
        "-p", prompt.prompt,
        "--model", model,
        "--output-format", "stream-json", "--verbose",
        "--strict-mcp-config", "--mcp-config", configPath,
        "--tools", "",
        "--allowedTools", "mcp__garmin",
        "--max-turns", "20",
        "--no-session-persistence",
      ],
      // A clean environment, so the CLI uses your own login rather than the variables of a parent session.
      { cwd: outDir, stdio: ["ignore", "pipe", "pipe"], env: { HOME: process.env.HOME, PATH: process.env.PATH, USER: process.env.USER } },
    );
    let stdout = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.on("close", () => {
      const events = stdout.split("\n").filter(Boolean).flatMap((line) => {
        try { return [JSON.parse(line)]; } catch { return []; }
      });
      const calls = new Map();
      for (const event of events) {
        for (const block of event.message?.content ?? []) {
          if (block.type === "tool_use") calls.set(block.id, { tool: block.name.replace(/^mcp__garmin__/, ""), input: block.input });
          if (block.type === "tool_result" && calls.has(block.tool_use_id)) {
            const text = [block.content].flat().map((part) => (typeof part === "string" ? part : part.text ?? "")).join("");
            Object.assign(calls.get(block.tool_use_id), { isError: !!block.is_error, chars: text.length, preview: text.slice(0, 300) });
          }
        }
      }
      const result = events.findLast((event) => event.type === "result") ?? {};
      resolve({
        id: prompt.id,
        prompt: prompt.prompt,
        expect: prompt.expect,
        notes: prompt.notes,
        seconds: Math.round((Date.now() - started) / 1000),
        turns: result.num_turns,
        costUsd: result.total_cost_usd,
        calls: [...calls.values()],
        answer: result.result ?? result.subtype,
      });
    });
  });
}

function check(result) {
  const used = new Set(result.calls.map((call) => call.tool));
  const missing = (result.expect ?? []).filter((alternatives) => !alternatives.split("|").some((tool) => used.has(tool)));
  const errors = result.calls.filter((call) => call.isError).length;
  return { missing, errors };
}

const config = join(outDir, "mcp.json");
writeFileSync(
  config,
  JSON.stringify({ mcpServers: { garmin: { type: "http", url: `${base}/mcp`, headers: { Authorization: `Bearer ${await accessToken()}` } } } }),
  { mode: 0o600 },
);

const results = [];
const queue = [...prompts];
await Promise.all(
  Array.from({ length: concurrency }, async () => {
    for (let prompt = queue.shift(); prompt; prompt = queue.shift()) {
      const result = await runClaude(prompt, config);
      const { missing, errors } = check(result);
      results.push({ ...result, missing, errors });
      writeFileSync(join(outDir, `${prompt.id}.json`), JSON.stringify(result, null, 2));
      console.log(
        `${missing.length ? "MISS" : "ok  "} ${prompt.id.padEnd(26)} ${String(result.seconds).padStart(4)}s turns=${result.turns} errors=${errors} tools=${result.calls.map((call) => call.tool.replace("garmin_", "")).join(",")}${missing.length ? ` missing=${missing.join(";")}` : ""}`,
      );
    }
  }),
);

writeFileSync(join(outDir, "summary.json"), JSON.stringify(results, null, 2));
const cost = results.reduce((sum, result) => sum + (result.costUsd ?? 0), 0);
console.log(`\n${results.filter((result) => !result.missing.length).length}/${results.length} used the expected tools · ${results.reduce((sum, r) => sum + r.errors, 0)} tool errors · $${cost.toFixed(2)} · ${outDir}`);
