/**
 * Pestr - a late-invoice chasing tool that runs on the customer's own AI assistant.
 *
 * There is NO AI in this file. The customer's assistant does the thinking and
 * writing and calls the tools below over MCP. This app only saves, edits, serves.
 * Runs on Cloudflare Workers with D1 for storage.
 */
import { Hono } from "hono";
import type { Context } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";

type Env = {
  DB: D1Database; SECRET_KEY: string; BASE_URL?: string; DEMO_PASSWORD?: string;
  RESEND_API_KEY?: string; FROM_EMAIL?: string; // optional: only for automatic sending
};
type Vars = { uid: number | null; base: string };
type AppEnv = { Bindings: Env; Variables: Vars };
type C = Context<AppEnv>;

type User = { id: number; email: string; pw_hash: string; token: string } & Profile;
type Plan = {
  id: number; user_id: number; public_id: string; client_name: string; client_email: string;
  invoice_number: string; amount: number; currency: string; due_date: string; status: string;
  notes: string; created_at: string; paid_at: string | null; payment_url: string; auto_send: number;
};
type Msg = {
  id: number; plan_id: number; step: number; tone: string; subject: string; body: string;
  send_on: string; status: string; sent_at: string | null;
};
type Profile = { business_name: string; sign_off: string; payment_instructions: string };
type Payment = { id: number; plan_id: number; amount: number; paid_on: string; note: string };
type Activity = { id: number; plan_id: number; kind: string; text: string; at: string };
type PlanRow = Plan & { paid_total: number };
type PlanView = Plan & { messages: Msg[]; payments: Payment[]; activity: Activity[]; paid_total: number };

const COOKIE = "pestr_session";
const SESSION_SECONDS = 14 * 24 * 3600;
const PBKDF2_ITERATIONS = 100_000; // Workers' maximum for PBKDF2
const DEMO_EMAIL = "demo@pestr.app";
const enc = new TextEncoder();

// --------------------------------------------------------------------------
// Crypto helpers (Web Crypto)
// --------------------------------------------------------------------------
const toHex = (b: ArrayBuffer) =>
  [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");

function b64url(buf: ArrayBuffer | Uint8Array): string {
  let s = "";
  for (const x of new Uint8Array(buf)) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromB64url(s: string): Uint8Array {
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(bin, (ch) => ch.charCodeAt(0));
}

const randomToken = (bytes: number) => b64url(crypto.getRandomValues(new Uint8Array(bytes)));

async function pbkdf2(pw: string, salt: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", enc.encode(pw), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt: enc.encode(salt), iterations: PBKDF2_ITERATIONS },
    key,
    256,
  );
  return toHex(bits);
}

async function hashPw(pw: string): Promise<string> {
  const salt = toHex(crypto.getRandomValues(new Uint8Array(8)).buffer);
  return `${salt}$${await pbkdf2(pw, salt)}`;
}

async function checkPw(pw: string, stored: string): Promise<boolean> {
  const [salt, h] = stored.split("$");
  if (!salt || !h) return false;
  const test = await pbkdf2(pw, salt);
  if (test.length !== h.length) return false;
  let diff = 0;
  for (let i = 0; i < h.length; i++) diff |= h.charCodeAt(i) ^ test.charCodeAt(i);
  return diff === 0;
}

const hmacKey = (secret: string) =>
  crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);

async function signSession(secret: string, uid: number): Promise<string> {
  const payload = `${uid}.${Math.floor(Date.now() / 1000) + SESSION_SECONDS}`;
  const sig = await crypto.subtle.sign("HMAC", await hmacKey(secret), enc.encode(payload));
  return `${payload}.${b64url(sig)}`;
}

async function readSession(secret: string, value: string | undefined): Promise<number | null> {
  if (!value) return null;
  const parts = value.split(".");
  if (parts.length !== 3) return null;
  const [uid, exp, sig] = parts;
  if (!Number.isFinite(Number(exp)) || Number(exp) < Date.now() / 1000) return null;
  try {
    const ok = await crypto.subtle.verify("HMAC", await hmacKey(secret), fromB64url(sig), enc.encode(`${uid}.${exp}`));
    return ok ? Number(uid) : null;
  } catch {
    return null;
  }
}

// --------------------------------------------------------------------------
// Data helpers
// --------------------------------------------------------------------------
function isValidDate(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

class ToolError extends Error {}

function checkDate(s: string): string {
  if (!isValidDate(s)) throw new ToolError(`Date '${s}' must be in YYYY-MM-DD format.`);
  return s;
}

async function withMessages(db: D1Database, plan: Plan) {
  const { results } = await db
    .prepare("SELECT * FROM messages WHERE plan_id=? ORDER BY step")
    .bind(plan.id)
    .all<Msg>();
  return { ...plan, messages: results };
}

// --------------------------------------------------------------------------
// Feature helpers: dates, URLs, profile, payments, activity log
// --------------------------------------------------------------------------
const today = () => new Date().toISOString().slice(0, 10);
const now = () => new Date().toISOString().slice(0, 19);
const clip = (s: string, n: number) => s.slice(0, n);
const round2 = (n: number) => Math.round(n * 100) / 100;

function daysLate(dueDate: string, asOf = today()): number {
  const ms = Date.parse(`${asOf}T00:00:00Z`) - Date.parse(`${dueDate}T00:00:00Z`);
  return Math.max(0, Math.floor(ms / 86_400_000));
}

// Only http(s) links are ever stored, so a "javascript:" link can never reach an href.
function safeUrl(s: string): string | null {
  try {
    const u = new URL(s);
    return u.protocol === "https:" || u.protocol === "http:" ? u.toString() : null;
  } catch {
    return null;
  }
}

function cleanUrl(s: string): string {
  if (!s.trim()) return "";
  const u = safeUrl(s.trim());
  if (!u) throw new ToolError("payment_url must be a valid http(s) link.");
  return u;
}

async function getProfile(db: D1Database, uid: number): Promise<Profile> {
  const row = await db
    .prepare("SELECT business_name, sign_off, payment_instructions FROM users WHERE id=?")
    .bind(uid)
    .first<Profile>();
  return row ?? { business_name: "", sign_off: "", payment_instructions: "" };
}

async function mustOwn(db: D1Database, planId: number, uid: number): Promise<Plan> {
  const plan = await db.prepare("SELECT * FROM plans WHERE id=? AND user_id=?").bind(planId, uid).first<Plan>();
  if (!plan) throw new ToolError("Plan not found.");
  return plan;
}

const logStmt = (db: D1Database, planId: number, kind: string, text: string) =>
  db.prepare("INSERT INTO activity(plan_id,kind,text,at) VALUES(?,?,?,?)").bind(planId, kind, text, now());

// Paid = stop the chase (scheduled emails are cancelled). Reopen = put them back.
async function setPaid(db: D1Database, planId: number, paid: boolean) {
  await db.batch([
    db.prepare("UPDATE plans SET status=?, paid_at=? WHERE id=?").bind(paid ? "paid" : "open", paid ? today() : null, planId),
    db.prepare(
      paid
        ? "UPDATE messages SET status='cancelled' WHERE plan_id=? AND status='scheduled'"
        : "UPDATE messages SET status='scheduled' WHERE plan_id=? AND status='cancelled'",
    ).bind(planId),
    logStmt(db, planId, paid ? "paid" : "reopened",
      paid ? "Marked as paid. Remaining emails cancelled." : "Reopened. Cancelled emails are scheduled again."),
  ]);
}

async function markSent(db: D1Database, planId: number, step: number): Promise<boolean> {
  const res = await db
    .prepare("UPDATE messages SET status='sent', sent_at=? WHERE plan_id=? AND step=? AND status='scheduled'")
    .bind(now(), planId, step)
    .run();
  if (!res.meta.changes) return false;
  await logStmt(db, planId, "sent", `Email step ${step} marked as sent.`).run();
  return true;
}

async function paidSoFar(db: D1Database, planId: number): Promise<number> {
  const row = await db.prepare("SELECT COALESCE(SUM(amount),0) AS s FROM payments WHERE plan_id=?").bind(planId).first<{ s: number }>();
  return row?.s ?? 0;
}

// Partial payments: when the running total covers the invoice, it flips to paid by itself.
async function addPayment(db: D1Database, plan: Plan, amount: number, paidOn: string, note: string) {
  await db.batch([
    db.prepare("INSERT INTO payments(plan_id,amount,paid_on,note) VALUES(?,?,?,?)").bind(plan.id, amount, paidOn, note),
    logStmt(db, plan.id, "payment",
      `Payment of ${plan.currency} ${round2(amount).toFixed(2)} recorded${note ? `: ${note}` : ""}.`),
  ]);
  const total = await paidSoFar(db, plan.id);
  const balance = Math.max(0, plan.amount - total);
  let status = plan.status;
  if (balance < 0.005 && plan.status === "open") {
    await setPaid(db, plan.id, true);
    status = "paid";
  }
  return { paid_so_far: round2(total), balance: round2(balance), status };
}

async function loadPlanView(db: D1Database, plan: Plan): Promise<PlanView> {
  const [msgs, pays, acts] = await db.batch([
    db.prepare("SELECT * FROM messages WHERE plan_id=? ORDER BY step").bind(plan.id),
    db.prepare("SELECT * FROM payments WHERE plan_id=? ORDER BY paid_on, id").bind(plan.id),
    db.prepare("SELECT * FROM activity WHERE plan_id=? ORDER BY id DESC LIMIT 50").bind(plan.id),
  ]);
  const payments = pays.results as Payment[];
  return {
    ...plan,
    messages: msgs.results as Msg[],
    payments,
    activity: acts.results as Activity[],
    paid_total: payments.reduce((s, x) => s + x.amount, 0),
  };
}

// Optional automatic sending (Cron Trigger). Only plans where the owner switched
// "send automatically" on, and that have a client email, are ever touched.
async function sendDueEmails(env: Env): Promise<void> {
  if (!env.RESEND_API_KEY || !env.FROM_EMAIL) return;
  const { results } = await env.DB.prepare(
    `SELECT m.id, m.plan_id, m.step, m.subject, m.body, p.client_email, u.email AS owner_email
       FROM messages m JOIN plans p ON p.id=m.plan_id JOIN users u ON u.id=p.user_id
      WHERE m.status='scheduled' AND m.send_on<=? AND p.status='open' AND p.auto_send=1 AND p.client_email<>''
      ORDER BY m.send_on LIMIT 50`,
  ).bind(today()).all<{ id: number; plan_id: number; step: number; subject: string; body: string; client_email: string; owner_email: string }>();
  for (const r of results) {
    // Claim the row first so two overlapping runs can never send the same email twice.
    const claim = await env.DB.prepare("UPDATE messages SET status='sending' WHERE id=? AND status='scheduled'").bind(r.id).run();
    if (!claim.meta.changes) continue;
    let ok = false;
    try {
      const res = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({ from: env.FROM_EMAIL, to: [r.client_email], reply_to: r.owner_email, subject: r.subject, text: r.body }),
      });
      ok = res.ok;
    } catch (e) {
      console.error(e);
    }
    await env.DB.batch([
      env.DB.prepare("UPDATE messages SET status=?, sent_at=? WHERE id=?").bind(ok ? "sent" : "failed", ok ? now() : null, r.id),
      logStmt(env.DB, r.plan_id, ok ? "sent" : "failed",
        ok ? `Email step ${r.step} sent automatically.` : `Email step ${r.step} failed to send automatically.`),
    ]);
  }
}

let demoChecked = false;
async function ensureDemo(env: Env) {
  if (demoChecked || !env.DEMO_PASSWORD) return;
  const exists = await env.DB.prepare("SELECT 1 AS x FROM users WHERE email=?").bind(DEMO_EMAIL).first();
  if (!exists) {
    await env.DB.prepare("INSERT OR IGNORE INTO users(email,pw_hash,token) VALUES(?,?,?)")
      .bind(DEMO_EMAIL, await hashPw(env.DEMO_PASSWORD), randomToken(24))
      .run();
  }
  demoChecked = true;
}

// --------------------------------------------------------------------------
// MCP server (what the customer's assistant talks to), Streamable HTTP, stateless JSON
// --------------------------------------------------------------------------
const SERVER_INFO = { name: "Pestr", version: "1.0.0" };
const PROTOCOLS = ["2025-06-18", "2025-03-26", "2024-11-05"];
const INSTRUCTIONS =
  "Pestr stores late-invoice chase plans. When the user describes an overdue invoice: " +
  "(1) call get_profile and use the business name, sign-off and payment instructions in every email " +
  "(if they are empty, tell the user they can fill them in under Settings); " +
  "(2) call get_client_history and adapt the tone to how this client has behaved before; " +
  "(3) write the 3 follow-up emails (friendly nudge, firmer reminder, final notice) and call create_chase_plan once. " +
  "Dates must be YYYY-MM-DD. After saving, give the user the edit_url. " +
  "For 'what should I send today?' call get_due_messages. " +
  "When the user says they sent an email, a client replied, or money arrived, call mark_message_sent, " +
  "log_activity or record_payment. calculate_late_fee only does arithmetic: remind the user to check " +
  "their contract and local law before charging interest or fees.";

const TOOLS = [
  {
    name: "create_chase_plan",
    description:
      "Save a new chase plan for an overdue invoice, with the follow-up emails you wrote " +
      "(normally 3, in order of increasing firmness). Returns the plan with an edit_url for the user.",
    inputSchema: {
      type: "object",
      properties: {
        client_name: { type: "string" },
        invoice_number: { type: "string" },
        amount: { type: "number" },
        due_date: { type: "string", description: "YYYY-MM-DD" },
        messages: {
          type: "array",
          items: {
            type: "object",
            properties: {
              subject: { type: "string", description: "Email subject line" },
              body: { type: "string", description: "Full email body, ready to send, signed off generically" },
              send_on: { type: "string", description: "Date to send, YYYY-MM-DD" },
              tone: { type: "string", description: "e.g. friendly, firm, final" },
            },
            required: ["subject", "body", "send_on"],
          },
        },
        currency: { type: "string", default: "USD" },
        client_email: { type: "string", default: "" },
        notes: { type: "string", default: "" },
        payment_url: { type: "string", description: "Optional http(s) link where the client can pay", default: "" },
      },
      required: ["client_name", "invoice_number", "amount", "due_date", "messages"],
    },
  },
  {
    name: "list_plans",
    description: "List the user's chase plans. status can be 'open', 'paid' or 'all'.",
    inputSchema: { type: "object", properties: { status: { type: "string", default: "all" } } },
  },
  {
    name: "get_plan",
    description: "Get one plan with all its messages (use this before rewriting a message).",
    inputSchema: { type: "object", properties: { plan_id: { type: "integer" } }, required: ["plan_id"] },
  },
  {
    name: "update_message",
    description: "Change one message in a plan. Only the fields you pass (non-empty) are changed.",
    inputSchema: {
      type: "object",
      properties: {
        plan_id: { type: "integer" },
        step: { type: "integer" },
        subject: { type: "string" },
        body: { type: "string" },
        send_on: { type: "string", description: "YYYY-MM-DD" },
      },
      required: ["plan_id", "step"],
    },
  },
  {
    name: "mark_paid",
    description: "Mark the invoice as paid; this stops the chase.",
    inputSchema: { type: "object", properties: { plan_id: { type: "integer" } }, required: ["plan_id"] },
  },
  {
    name: "get_profile",
    description: "Get the user's business name, email sign-off and payment instructions. Call this before writing any email.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "set_profile",
    description: "Save the user's business name, sign-off or payment instructions. Only the fields you pass are changed.",
    inputSchema: {
      type: "object",
      properties: { business_name: { type: "string" }, sign_off: { type: "string" }, payment_instructions: { type: "string" } },
    },
  },
  {
    name: "get_due_messages",
    description: "List scheduled emails whose send date has arrived (on or before as_of, default today) on open invoices.",
    inputSchema: { type: "object", properties: { as_of: { type: "string", description: "YYYY-MM-DD, default today" } } },
  },
  {
    name: "mark_message_sent",
    description: "Record that the user sent one scheduled email.",
    inputSchema: {
      type: "object",
      properties: { plan_id: { type: "integer" }, step: { type: "integer" } },
      required: ["plan_id", "step"],
    },
  },
  {
    name: "record_payment",
    description: "Record a full or partial payment. When payments cover the invoice it is marked paid automatically.",
    inputSchema: {
      type: "object",
      properties: {
        plan_id: { type: "integer" },
        amount: { type: "number" },
        paid_on: { type: "string", description: "YYYY-MM-DD, default today" },
        note: { type: "string" },
      },
      required: ["plan_id", "amount"],
    },
  },
  {
    name: "log_activity",
    description: "Add a note to a plan's timeline, e.g. 'client said they will pay on Friday'.",
    inputSchema: {
      type: "object",
      properties: { plan_id: { type: "integer" }, text: { type: "string" } },
      required: ["plan_id", "text"],
    },
  },
  {
    name: "get_client_history",
    description:
      "Past invoices for a client (matched by name) with how late they paid on average and recent notes. " +
      "Use it to choose how firm the emails should be.",
    inputSchema: { type: "object", properties: { client_name: { type: "string" } }, required: ["client_name"] },
  },
  {
    name: "calculate_late_fee",
    description:
      "Arithmetic only: simple interest plus an optional flat fee for a late invoice. " +
      "The user must check their contract and local law before charging either.",
    inputSchema: {
      type: "object",
      properties: {
        amount: { type: "number" },
        days_late: { type: "integer" },
        annual_rate_percent: { type: "number", default: 0 },
        flat_fee: { type: "number", default: 0 },
        grace_days: { type: "integer", default: 0 },
      },
      required: ["amount", "days_late"],
    },
  },
];

type Args = Record<string, unknown>;
type ToolCtx = { env: Env; uid: number; base: string };

const reqStr = (a: Args, k: string): string => {
  const v = a[k];
  if (typeof v !== "string" || !v.trim()) throw new ToolError(`'${k}' is required and must be a non-empty string.`);
  return v;
};
const optStr = (a: Args, k: string, d = ""): string => {
  const v = a[k];
  if (v === undefined || v === null) return d;
  if (typeof v !== "string") throw new ToolError(`'${k}' must be a string.`);
  return v;
};
const reqNum = (a: Args, k: string): number => {
  const v = a[k];
  if (typeof v !== "number" || !Number.isFinite(v)) throw new ToolError(`'${k}' is required and must be a number.`);
  return v;
};
const reqInt = (a: Args, k: string): number => {
  const v = reqNum(a, k);
  if (!Number.isInteger(v)) throw new ToolError(`'${k}' must be an integer.`);
  return v;
};

const HANDLERS: Record<string, (a: Args, c: ToolCtx) => Promise<unknown>> = {
  async create_chase_plan(a, { env, uid, base }) {
    const clientName = reqStr(a, "client_name");
    const invoiceNumber = reqStr(a, "invoice_number");
    const amount = reqNum(a, "amount");
    const dueDate = checkDate(reqStr(a, "due_date"));
    const currency = optStr(a, "currency", "USD");
    const clientEmail = optStr(a, "client_email");
    const notes = optStr(a, "notes");
    const paymentUrl = cleanUrl(optStr(a, "payment_url"));
    if (!Array.isArray(a.messages) || a.messages.length === 0) throw new ToolError("Provide at least one message.");
    const msgs = a.messages.map((raw) => {
      if (!raw || typeof raw !== "object") throw new ToolError("Each message must be an object.");
      const m = raw as Args;
      return {
        subject: reqStr(m, "subject"),
        body: reqStr(m, "body"),
        send_on: checkDate(reqStr(m, "send_on")),
        tone: optStr(m, "tone"),
      };
    });
    const publicId = randomToken(8);
    // One batch = one transaction: the plan and all its messages are saved together.
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO plans(user_id,public_id,client_name,client_email,invoice_number,amount,currency,due_date,notes,payment_url,created_at) " +
          "VALUES(?,?,?,?,?,?,?,?,?,?,?)",
      ).bind(uid, publicId, clientName, clientEmail, invoiceNumber, amount, currency, dueDate, notes, paymentUrl, now()),
      env.DB.prepare(
        "INSERT INTO activity(plan_id,kind,text,at) VALUES((SELECT id FROM plans WHERE public_id=?),?,?,?)",
      ).bind(publicId, "created", `Chase plan created with ${msgs.length} emails.`, now()),
      ...msgs.map((m, i) =>
        env.DB.prepare(
          "INSERT INTO messages(plan_id,step,tone,subject,body,send_on) " +
            "VALUES((SELECT id FROM plans WHERE public_id=?),?,?,?,?,?)",
        ).bind(publicId, i + 1, m.tone, m.subject, m.body, m.send_on),
      ),
    ]);
    const plan = (await env.DB.prepare("SELECT * FROM plans WHERE public_id=?").bind(publicId).first<Plan>())!;
    return {
      ...(await withMessages(env.DB, plan)),
      edit_url: `${base}/plans/${plan.id}`,
      status_page_url: `${base}/s/${publicId}`,
    };
  },

  async list_plans(a, { env, uid, base }) {
    const status = optStr(a, "status", "all");
    const filtered = status === "open" || status === "paid";
    const stmt = env.DB.prepare(
      `SELECT * FROM plans WHERE user_id=?${filtered ? " AND status=?" : ""} ORDER BY id DESC`,
    );
    const { results } = await (filtered ? stmt.bind(uid, status) : stmt.bind(uid)).all<Plan>();
    return results.map((r) => ({
      id: r.id, client_name: r.client_name, invoice_number: r.invoice_number, amount: r.amount,
      currency: r.currency, due_date: r.due_date, status: r.status,
      days_late: r.status === "open" ? daysLate(r.due_date) : 0, edit_url: `${base}/plans/${r.id}`,
    }));
  },

  async get_plan(a, { env, uid, base }) {
    const id = reqInt(a, "plan_id");
    const plan = await env.DB.prepare("SELECT * FROM plans WHERE id=? AND user_id=?").bind(id, uid).first<Plan>();
    if (!plan) throw new ToolError("Plan not found.");
    return { ...(await withMessages(env.DB, plan)), edit_url: `${base}/plans/${id}` };
  },

  async update_message(a, { env, uid }) {
    const planId = reqInt(a, "plan_id");
    const step = reqInt(a, "step");
    const subject = optStr(a, "subject");
    const body = optStr(a, "body");
    const sendOn = optStr(a, "send_on");
    const msg = await env.DB.prepare(
      "SELECT m.* FROM messages m JOIN plans p ON p.id=m.plan_id WHERE m.plan_id=? AND m.step=? AND p.user_id=?",
    ).bind(planId, step, uid).first<Msg>();
    if (!msg) throw new ToolError("Plan or step not found.");
    await env.DB.prepare("UPDATE messages SET subject=?, body=?, send_on=? WHERE id=?")
      .bind(subject || msg.subject, body || msg.body, sendOn ? checkDate(sendOn) : msg.send_on, msg.id)
      .run();
    return await env.DB.prepare("SELECT * FROM messages WHERE id=?").bind(msg.id).first();
  },

  async mark_paid(a, { env, uid }) {
    const id = reqInt(a, "plan_id");
    await mustOwn(env.DB, id, uid);
    await setPaid(env.DB, id, true);
    return { plan_id: id, status: "paid" };
  },

  async get_profile(_a, { env, uid }) {
    return await getProfile(env.DB, uid);
  },

  async set_profile(a, { env, uid }) {
    const cur = await getProfile(env.DB, uid);
    const pick = (k: keyof Profile, max: number) => (a[k] === undefined ? cur[k] : clip(optStr(a, k), max));
    const next: Profile = {
      business_name: pick("business_name", 200),
      sign_off: pick("sign_off", 500),
      payment_instructions: pick("payment_instructions", 2000),
    };
    await env.DB.prepare("UPDATE users SET business_name=?, sign_off=?, payment_instructions=? WHERE id=?")
      .bind(next.business_name, next.sign_off, next.payment_instructions, uid).run();
    return next;
  },

  async get_due_messages(a, { env, uid, base }) {
    const asOfRaw = optStr(a, "as_of");
    const asOf = asOfRaw ? checkDate(asOfRaw) : today();
    const { results } = await env.DB.prepare(
      `SELECT m.plan_id, m.step, m.tone, m.subject, m.body, m.send_on, p.client_name, p.client_email, p.invoice_number
         FROM messages m JOIN plans p ON p.id=m.plan_id
        WHERE p.user_id=? AND p.status='open' AND m.status='scheduled' AND m.send_on<=?
        ORDER BY m.send_on, m.plan_id, m.step`,
    ).bind(uid, asOf).all<Record<string, unknown> & { plan_id: number }>();
    return results.map((r) => ({ ...r, edit_url: `${base}/plans/${r.plan_id}` }));
  },

  async mark_message_sent(a, { env, uid }) {
    const planId = reqInt(a, "plan_id");
    const step = reqInt(a, "step");
    await mustOwn(env.DB, planId, uid);
    if (!(await markSent(env.DB, planId, step))) throw new ToolError("Step not found, or it was already sent or cancelled.");
    return { plan_id: planId, step, status: "sent" };
  },

  async record_payment(a, { env, uid }) {
    const plan = await mustOwn(env.DB, reqInt(a, "plan_id"), uid);
    const amount = reqNum(a, "amount");
    if (amount <= 0) throw new ToolError("'amount' must be greater than zero.");
    const paidOnRaw = optStr(a, "paid_on");
    return await addPayment(env.DB, plan, amount, paidOnRaw ? checkDate(paidOnRaw) : today(), clip(optStr(a, "note"), 200));
  },

  async log_activity(a, { env, uid }) {
    const plan = await mustOwn(env.DB, reqInt(a, "plan_id"), uid);
    await logStmt(env.DB, plan.id, "note", clip(reqStr(a, "text"), 1000)).run();
    return { plan_id: plan.id, logged: true };
  },

  async get_client_history(a, { env, uid }) {
    const name = reqStr(a, "client_name");
    const { results: plans } = await env.DB.prepare(
      `SELECT id, invoice_number, amount, currency, due_date, status, paid_at FROM plans
        WHERE user_id=? AND lower(client_name)=lower(?) ORDER BY id DESC LIMIT 20`,
    ).bind(uid, name).all<{ id: number; invoice_number: string; amount: number; currency: string; due_date: string; status: string; paid_at: string | null }>();
    const lateDays = plans.filter((p) => p.paid_at).map((p) => daysLate(p.due_date, p.paid_at!));
    const { results: notes } = await env.DB.prepare(
      `SELECT p.invoice_number, a.text, a.at FROM activity a JOIN plans p ON p.id=a.plan_id
        WHERE p.user_id=? AND lower(p.client_name)=lower(?) AND a.kind='note' ORDER BY a.id DESC LIMIT 10`,
    ).bind(uid, name).all();
    return {
      client_name: name,
      invoices: plans,
      open_count: plans.filter((p) => p.status === "open").length,
      paid_count: lateDays.length,
      avg_days_late_when_paid: lateDays.length ? round2(lateDays.reduce((s, d) => s + d, 0) / lateDays.length) : null,
      recent_notes: notes,
    };
  },

  async calculate_late_fee(a) {
    const amount = reqNum(a, "amount");
    const days = reqInt(a, "days_late");
    const rate = typeof a.annual_rate_percent === "number" ? a.annual_rate_percent : 0;
    const flat = typeof a.flat_fee === "number" ? a.flat_fee : 0;
    const grace = typeof a.grace_days === "number" ? a.grace_days : 0;
    if (amount < 0 || rate < 0 || flat < 0 || days < 0 || grace < 0) throw new ToolError("Values cannot be negative.");
    const chargeable = Math.max(0, days - grace);
    const interest = round2((amount * (rate / 100) * chargeable) / 365);
    const fee = chargeable > 0 ? round2(flat) : 0;
    return { chargeable_days: chargeable, interest, flat_fee: fee, total_due: round2(amount + interest + fee) };
  },
};

type Rpc = { id?: string | number | null; method?: string; params?: Record<string, unknown>; result?: unknown; error?: unknown };
const rpcResult = (id: unknown, result: unknown) => ({ jsonrpc: "2.0", id, result });
const rpcError = (id: unknown, code: number, message: string) => ({ jsonrpc: "2.0", id, error: { code, message } });

async function callTool(name: string, args: Args, ctx: ToolCtx) {
  try {
    const fn = HANDLERS[name];
    if (!fn) throw new ToolError(`Unknown tool: ${name}`);
    const out = await fn(args, ctx);
    return { content: [{ type: "text", text: JSON.stringify(out, null, 2) }] };
  } catch (e) {
    if (e instanceof ToolError) return { content: [{ type: "text", text: e.message }], isError: true };
    console.error(e);
    return { content: [{ type: "text", text: "Internal error." }], isError: true };
  }
}

async function handleRpc(msg: Rpc, ctx: ToolCtx): Promise<object | null> {
  if (!msg || typeof msg !== "object") return rpcError(null, -32600, "Invalid request");
  if ("result" in msg || "error" in msg) return null; // a response from the client, nothing to do
  if (typeof msg.method !== "string") return rpcError(msg.id ?? null, -32600, "Invalid request");
  if (msg.id === undefined) return null; // notification (e.g. notifications/initialized)
  const id = msg.id;
  switch (msg.method) {
    case "initialize": {
      const asked = msg.params?.protocolVersion;
      return rpcResult(id, {
        protocolVersion: typeof asked === "string" && PROTOCOLS.includes(asked) ? asked : PROTOCOLS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
        instructions: INSTRUCTIONS,
      });
    }
    case "ping":
      return rpcResult(id, {});
    case "tools/list":
      return rpcResult(id, { tools: TOOLS });
    case "tools/call": {
      const name = String(msg.params?.name ?? "");
      const args = (msg.params?.arguments ?? {}) as Args;
      return rpcResult(id, await callTool(name, args, ctx));
    }
    default:
      return rpcError(id, -32601, `Method not found: ${msg.method}`);
  }
}

// --------------------------------------------------------------------------
// Web app (what the person sees and edits)
// --------------------------------------------------------------------------
const CSS = `
:root{--bg:#f7f7f5;--card:#fff;--ink:#1b1b1b;--mut:#6b6b6b;--line:#e4e4e0;--acc:#1f5eff;--ok:#16794c;--warn:#b45309}
@media(prefers-color-scheme:dark){:root{--bg:#141414;--card:#1e1e1e;--ink:#eee;--mut:#9a9a9a;--line:#333;--acc:#6d95ff;--ok:#4ade80;--warn:#fbbf24}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.5 system-ui,sans-serif}
.wrap{max-width:760px;margin:0 auto;padding:20px}
nav{display:flex;justify-content:space-between;align-items:center;margin-bottom:20px}
nav a{color:var(--mut);margin-left:14px;text-decoration:none}nav b{font-size:20px}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:18px;margin-bottom:14px}
input,textarea{width:100%;padding:10px;border:1px solid var(--line);border-radius:8px;background:var(--bg);color:var(--ink);font:inherit;margin:4px 0 10px}
textarea{min-height:150px}label{font-size:13px;color:var(--mut)}
button,.btn{background:var(--acc);color:#fff;border:0;padding:9px 16px;border-radius:8px;font:inherit;cursor:pointer;text-decoration:none;display:inline-block}
button.ghost{background:transparent;color:var(--ink);border:1px solid var(--line)}
.pill{font-size:12px;padding:2px 10px;border-radius:99px;border:1px solid var(--line)}
.paid{color:var(--ok)}.open{color:var(--warn)}.row{display:flex;justify-content:space-between;gap:10px;align-items:center}
.mut{color:var(--mut);font-size:14px}code{word-break:break-all;font-size:13px}.err{color:#d33}
a.rowlink{color:inherit;text-decoration:none}
.sent{color:var(--ok)}.cancelled{color:var(--mut)}.failed,.overdue{color:#d33}.sending{color:var(--warn)}
.tab{margin-right:12px;color:var(--mut);text-decoration:none;text-transform:capitalize}.tab.on{color:var(--ink);font-weight:600}
.actions{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-top:10px}
table{width:100%;border-collapse:collapse;font-size:14px}td{padding:6px 0;border-top:1px solid var(--line)}
.check{display:flex;gap:8px;align-items:flex-start}.check input{width:auto;margin:4px 0}
`;

const esc = (v: unknown) =>
  String(v ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!);
const money = (n: number) => Number(n).toFixed(2);

function layout(title: string, loggedIn: boolean, body: string): string {
  return `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>
<style>${CSS}</style></head><body><div class="wrap">
<nav><b><a class="rowlink" href="/">Pestr</a></b><span>
${loggedIn ? `<a href="/">Plans</a><a href="/connect">Connect Claude</a><a href="/settings">Settings</a><a href="/export.csv">Export</a><a href="/logout">Log out</a>` : ""}</span></nav>
${body}</div></body></html>`;
}

const loginPage = (error = "") =>
  layout("Pestr", false, `
<div class="card"><h2>Chase late invoices, with your own Claude</h2>
<p class="mut">Tell Claude about an overdue invoice. It writes the follow-ups; Pestr saves them so you can edit and track.</p>
${error ? `<p class="err">${esc(error)}</p>` : ""}
<form method="post" action="/login"><label>Email</label><input name="email" type="email" required>
<label>Password</label><input name="password" type="password" required minlength="6">
<button name="mode" value="login">Log in</button> <button class="ghost" name="mode" value="signup">Create account</button></form></div>`);

const FILTERS = ["all", "open", "overdue", "paid"];

const dashboardPage = (all: PlanRow[], filter: string) => {
  const t = today();
  const overdue = (p: PlanRow) => p.status === "open" && p.due_date < t;
  const shown = all.filter((p) =>
    filter === "overdue" ? overdue(p) : filter === "open" || filter === "paid" ? p.status === filter : true);
  const owed: Record<string, number> = {};
  for (const p of all) if (p.status === "open") owed[p.currency] = (owed[p.currency] ?? 0) + Math.max(0, p.amount - p.paid_total);
  const owedText = Object.entries(owed).map(([cur, n]) => `${esc(cur)} ${money(n)}`).join(" · ") || "nothing";
  const stats = all.length
    ? `<div class="card"><div class="mut">Outstanding</div><h2 style="margin:4px 0">${owedText}</h2>
<span class="mut">${all.filter(overdue).length} overdue · ${all.filter((p) => p.status === "open").length} open · ${all.filter((p) => p.status === "paid").length} paid</span></div>
<p>${FILTERS.map((f) => `<a class="tab${f === filter ? " on" : ""}" href="/?show=${f}">${f}</a>`).join("")}</p>`
    : `<div class="card"><h3>No plans yet</h3>
<p>Go to <a href="/connect">Connect Claude</a>, then tell Claude something like:</p>
<p class="mut"><i>"Acme Co is 21 days late on invoice #104 for $3,200. Set up a chase plan."</i></p></div>`;
  return layout("Pestr", true, stats + shown.map((p) => {
    const amt = p.status === "open" ? Math.max(0, p.amount - p.paid_total) : p.amount;
    return `<a class="rowlink" href="/plans/${p.id}"><div class="card row"><div>
<b>${esc(p.client_name)}</b> <span class="mut">· ${esc(p.invoice_number)}</span><br>
<span class="mut">${esc(p.currency)} ${money(amt)}${p.status === "open" && p.paid_total > 0 ? " left" : ""} · due ${esc(p.due_date)}${overdue(p) ? ` · <span class="overdue">${daysLate(p.due_date, t)} days late</span>` : ""}</span></div>
<span class="pill ${esc(p.status)}">${esc(p.status)}</span></div></a>`;
  }).join(""));
};

const msgCard = (p: PlanView, m: Msg) => {
  const mail = p.client_email
    ? `<a class="btn ghost" style="background:transparent;color:var(--ink);border:1px solid var(--line)" href="mailto:${esc(p.client_email)}?subject=${esc(encodeURIComponent(m.subject))}&amp;body=${esc(encodeURIComponent(m.body))}">Open in mail app</a>`
    : "";
  const sent = m.status === "scheduled"
    ? `<form method="post" action="/plans/${p.id}/messages/${m.step}/sent"><button class="ghost">Mark as sent</button></form>`
    : m.sent_at ? `<span class="mut">Sent ${esc(m.sent_at.slice(0, 10))}</span>` : "";
  return `<div class="card"><form method="post" action="/plans/${p.id}/messages/${m.step}">
<div class="row"><b>Step ${m.step}${m.tone ? ` · ${esc(m.tone)}` : ""}</b>
<span class="pill ${esc(m.status)}">${esc(m.status)}</span></div>
<label>Send on</label><input type="date" name="send_on" value="${esc(m.send_on)}" required>
<label>Subject</label><input name="subject" value="${esc(m.subject)}" required>
<label>Message</label><textarea id="b${m.id}" name="body" required>${esc(m.body)}</textarea>
<button>Save changes</button></form>
<div class="actions">${sent}${mail}
<button type="button" class="ghost" onclick="navigator.clipboard.writeText(document.getElementById('b${m.id}').value);this.textContent='Copied'">Copy text</button></div></div>`;
};

const planPage = (p: PlanView) => {
  const balance = Math.max(0, p.amount - p.paid_total);
  const late = p.status === "open" ? daysLate(p.due_date) : 0;
  return layout(p.client_name, true, `
<div class="card"><div class="row"><div><h2 style="margin:0">${esc(p.client_name)}</h2>
<span class="mut">${esc(p.invoice_number)} · ${esc(p.currency)} ${money(p.amount)} · due ${esc(p.due_date)}${late ? ` · <span class="overdue">${late} days late</span>` : ""}</span></div>
<span class="pill ${esc(p.status)}">${esc(p.status)}</span></div>
${p.paid_total > 0 ? `<p class="mut">Paid so far ${esc(p.currency)} ${money(p.paid_total)} · balance ${esc(p.currency)} ${money(balance)}</p>` : ""}
${p.notes ? `<p class="mut">${esc(p.notes)}</p>` : ""}
<p class="mut">Client-facing status page: <a href="/s/${esc(p.public_id)}" target="_blank">/s/${esc(p.public_id)}</a></p>
<form method="post" action="/plans/${p.id}/${p.status === "paid" ? "reopen" : "paid"}" style="display:inline">
<button>${p.status === "paid" ? "Reopen" : "Mark as paid"}</button></form>
<form method="post" action="/plans/${p.id}/delete" style="display:inline" onsubmit="return confirm('Delete this plan?')">
<button class="ghost">Delete</button></form></div>

<form class="card" method="post" action="/plans/${p.id}/details"><b>Details</b><br>
<label>Client email</label><input name="client_email" type="email" value="${esc(p.client_email)}">
<label>Payment link (optional, shown on the status page)</label><input name="payment_url" type="url" value="${esc(p.payment_url)}" placeholder="https://">
<label>Notes</label><textarea name="notes" style="min-height:70px">${esc(p.notes)}</textarea>
<label class="check"><input type="checkbox" name="auto_send" value="1" ${p.auto_send ? "checked" : ""}>
<span>Email the client automatically on each send date (needs a client email and automatic sending set up on the server)</span></label>
<button>Save details</button></form>

<div class="card"><b>Payments</b>
${p.payments.length ? `<table>${p.payments.map((x) => `<tr><td>${esc(x.paid_on)}</td><td>${esc(p.currency)} ${money(x.amount)}</td><td class="mut">${esc(x.note)}</td></tr>`).join("")}</table>` : `<p class="mut">No payments recorded.</p>`}
<form method="post" action="/plans/${p.id}/payments"><div class="row">
<div style="flex:1"><label>Amount</label><input name="amount" type="number" step="0.01" min="0.01" required></div>
<div style="flex:1"><label>Date</label><input name="paid_on" type="date" value="${today()}" required></div></div>
<label>Note</label><input name="note" maxlength="200"><button>Record payment</button></form></div>

${p.messages.map((m) => msgCard(p, m)).join("")}

<div class="card"><b>Timeline</b>
<form method="post" action="/plans/${p.id}/notes" class="actions"><input name="text" placeholder="Add a note, e.g. client promised Friday" required maxlength="1000" style="flex:1;margin:0"><button>Add</button></form>
<table>${p.activity.map((x) => `<tr><td class="mut" style="width:130px">${esc(x.at.replace("T", " "))}</td><td>${esc(x.text)}</td></tr>`).join("")}</table></div>`);
};

const connectPage = (mcpUrl: string) =>
  layout("Connect Claude", true, `
<div class="card"><h2>Connect your Claude</h2>
<p>Your private MCP link (treat it like a password):</p><p><code>${esc(mcpUrl)}</code></p>
<ol><li>In Claude, open <b>Settings → Connectors → Add custom connector</b>.</li>
<li>Name it <b>Pestr</b> and paste the link above. Leave any advanced/OAuth fields empty.</li>
<li>Start a new chat and type: <i>"Acme Co is 21 days late on invoice #104 for $3,200. Set up a chase plan."</i></li>
<li>Come back here: the plan is waiting for you to edit.</li></ol></div>
<div class="card"><b>Link leaked?</b>
<p class="mut">Making a new link stops the old one working immediately. You will need to update the connector in Claude.</p>
<form method="post" action="/connect/rotate" onsubmit="return confirm('The old link stops working now. Continue?')"><button class="ghost">Generate a new link</button></form></div>`);

const settingsPage = (pr: Profile, saved: boolean) =>
  layout("Settings", true, `
<form class="card" method="post" action="/settings"><h2 style="margin-top:0">Your business</h2>
<p class="mut">Claude reads this before it writes your emails, so it signs off the way you do and tells clients how to pay.</p>
${saved ? `<p class="mut"><b>Saved.</b></p>` : ""}
<label>Business name</label><input name="business_name" value="${esc(pr.business_name)}" maxlength="200">
<label>Sign-off</label><textarea name="sign_off" style="min-height:80px" maxlength="500">${esc(pr.sign_off)}</textarea>
<label>Payment instructions</label><textarea name="payment_instructions" maxlength="2000">${esc(pr.payment_instructions)}</textarea>
<button>Save</button></form>`);

const publicPage = (p: Plan, paidTotal: number) => {
  const balance = Math.max(0, p.amount - paidTotal);
  const label = p.status === "paid" ? "Paid, thank you!" : paidTotal > 0 ? "Partially paid" : "Awaiting payment";
  return layout("Invoice " + p.invoice_number, false, `
<div class="card"><h2 style="margin-top:0">Invoice ${esc(p.invoice_number)}</h2>
<p>For <b>${esc(p.client_name)}</b> · ${esc(p.currency)} ${money(p.amount)} · due ${esc(p.due_date)}</p>
<p>Status: <span class="pill ${esc(p.status)}">${label}</span></p>
${p.status === "open" && paidTotal > 0 ? `<p>Balance remaining: <b>${esc(p.currency)} ${money(balance)}</b></p>` : ""}
${p.status === "open" && p.payment_url ? `<p><a class="btn" href="${esc(p.payment_url)}" rel="noopener noreferrer">Pay now</a></p>` : ""}
<p class="mut">Last updated live from Pestr.</p></div>`);
};

const app = new Hono<AppEnv>();

app.use("*", async (c, next) => {
  if (!c.env.SECRET_KEY) return c.text("SECRET_KEY is not configured. Run: wrangler secret put SECRET_KEY", 500);
  await ensureDemo(c.env);
  c.set("base", (c.env.BASE_URL || new URL(c.req.url).origin).replace(/\/+$/, ""));
  c.set("uid", await readSession(c.env.SECRET_KEY, getCookie(c, COOKIE)));
  await next();
});

async function startSession(c: C, uid: number) {
  setCookie(c, COOKIE, await signSession(c.env.SECRET_KEY, uid), {
    httpOnly: true, sameSite: "Lax", path: "/", maxAge: SESSION_SECONDS,
    secure: c.get("base").startsWith("https"),
  });
}

async function ownedPlan(c: C, idStr: string): Promise<Plan | null> {
  const uid = c.get("uid");
  const id = Number(idStr);
  if (!uid || !Number.isInteger(id)) return null;
  return await c.env.DB.prepare("SELECT * FROM plans WHERE id=? AND user_id=?").bind(id, uid).first<Plan>();
}

app.get("/", async (c) => {
  const uid = c.get("uid");
  if (!uid) return c.html(loginPage());
  const { results } = await c.env.DB.prepare(
    "SELECT p.*, COALESCE((SELECT SUM(amount) FROM payments WHERE plan_id=p.id),0) AS paid_total FROM plans p WHERE user_id=? ORDER BY id DESC",
  ).bind(uid).all<PlanRow>();
  return c.html(dashboardPage(results, c.req.query("show") ?? "all"));
});

app.post("/login", async (c) => {
  const form = await c.req.parseBody();
  const email = String(form.email ?? "").trim().toLowerCase();
  const password = String(form.password ?? "");
  const mode = String(form.mode ?? "login");
  const row = await c.env.DB.prepare("SELECT * FROM users WHERE email=?").bind(email).first<User>();
  if (mode === "signup") {
    if (!email.includes("@")) return c.html(loginPage("Enter a valid email address."), 400);
    if (row) return c.html(loginPage("That email already has an account. Log in instead."), 400);
    if (password.length < 6) return c.html(loginPage("Password needs at least 6 characters."), 400);
    const res = await c.env.DB.prepare("INSERT INTO users(email,pw_hash,token) VALUES(?,?,?)")
      .bind(email, await hashPw(password), randomToken(24)).run();
    await startSession(c, res.meta.last_row_id);
    return c.redirect("/connect", 303);
  }
  if (!row || !(await checkPw(password, row.pw_hash))) return c.html(loginPage("Wrong email or password."), 400);
  await startSession(c, row.id);
  return c.redirect("/", 303);
});

app.get("/logout", (c) => {
  deleteCookie(c, COOKIE, { path: "/" });
  return c.redirect("/", 303);
});

app.get("/connect", async (c) => {
  const uid = c.get("uid");
  if (!uid) return c.redirect("/", 303);
  const row = await c.env.DB.prepare("SELECT token FROM users WHERE id=?").bind(uid).first<{ token: string }>();
  if (!row) return c.redirect("/", 303);
  return c.html(connectPage(`${c.get("base")}/mcp/${row.token}`));
});

app.get("/plans/:id", async (c) => {
  const plan = await ownedPlan(c, c.req.param("id"));
  if (!plan) return c.redirect("/", 303);
  return c.html(planPage(await loadPlanView(c.env.DB, plan)));
});

app.post("/plans/:id/messages/:step", async (c) => {
  const plan = await ownedPlan(c, c.req.param("id"));
  if (!plan) return c.redirect("/", 303);
  const form = await c.req.parseBody();
  const step = Number(c.req.param("step"));
  const sendOn = String(form.send_on ?? "");
  if (Number.isInteger(step) && isValidDate(sendOn)) {
    await c.env.DB.prepare("UPDATE messages SET subject=?, body=?, send_on=? WHERE plan_id=? AND step=?")
      .bind(String(form.subject ?? ""), String(form.body ?? ""), sendOn, plan.id, step).run();
  }
  return c.redirect(`/plans/${plan.id}`, 303);
});

app.post("/plans/:id/messages/:step/sent", async (c) => {
  const plan = await ownedPlan(c, c.req.param("id"));
  if (!plan) return c.redirect("/", 303);
  const step = Number(c.req.param("step"));
  if (Number.isInteger(step)) await markSent(c.env.DB, plan.id, step);
  return c.redirect(`/plans/${plan.id}`, 303);
});

app.post("/plans/:id/payments", async (c) => {
  const plan = await ownedPlan(c, c.req.param("id"));
  if (!plan) return c.redirect("/", 303);
  const f = await c.req.parseBody();
  const amount = Number(f.amount);
  const paidOn = String(f.paid_on ?? "");
  if (Number.isFinite(amount) && amount > 0 && isValidDate(paidOn)) {
    await addPayment(c.env.DB, plan, amount, paidOn, clip(String(f.note ?? ""), 200));
  }
  return c.redirect(`/plans/${plan.id}`, 303);
});

app.post("/plans/:id/details", async (c) => {
  const plan = await ownedPlan(c, c.req.param("id"));
  if (!plan) return c.redirect("/", 303);
  const f = await c.req.parseBody();
  const email = clip(String(f.client_email ?? "").trim(), 200);
  const rawUrl = String(f.payment_url ?? "").trim();
  const url = rawUrl === "" ? "" : safeUrl(rawUrl);
  if (url === null) return c.text("The payment link must start with http:// or https://", 400);
  const autoSend = f.auto_send === "1" && email.includes("@") ? 1 : 0;
  await c.env.DB.prepare("UPDATE plans SET client_email=?, payment_url=?, notes=?, auto_send=? WHERE id=?")
    .bind(email, url, clip(String(f.notes ?? ""), 2000), autoSend, plan.id).run();
  return c.redirect(`/plans/${plan.id}`, 303);
});

app.post("/plans/:id/notes", async (c) => {
  const plan = await ownedPlan(c, c.req.param("id"));
  if (!plan) return c.redirect("/", 303);
  const text = clip(String((await c.req.parseBody()).text ?? "").trim(), 1000);
  if (text) await logStmt(c.env.DB, plan.id, "note", text).run();
  return c.redirect(`/plans/${plan.id}`, 303);
});

app.get("/settings", async (c) => {
  const uid = c.get("uid");
  if (!uid) return c.redirect("/", 303);
  return c.html(settingsPage(await getProfile(c.env.DB, uid), c.req.query("saved") === "1"));
});

app.post("/settings", async (c) => {
  const uid = c.get("uid");
  if (!uid) return c.redirect("/", 303);
  const f = await c.req.parseBody();
  await c.env.DB.prepare("UPDATE users SET business_name=?, sign_off=?, payment_instructions=? WHERE id=?")
    .bind(clip(String(f.business_name ?? ""), 200), clip(String(f.sign_off ?? ""), 500),
      clip(String(f.payment_instructions ?? ""), 2000), uid).run();
  return c.redirect("/settings?saved=1", 303);
});

app.post("/connect/rotate", async (c) => {
  const uid = c.get("uid");
  if (!uid) return c.redirect("/", 303);
  await c.env.DB.prepare("UPDATE users SET token=? WHERE id=?").bind(randomToken(24), uid).run();
  return c.redirect("/connect", 303);
});

// Spreadsheet cells that start with = + - @ can run formulas in Excel, so those get a leading '.
const csvCell = (v: unknown): string => {
  let s = String(v ?? "");
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

app.get("/export.csv", async (c) => {
  const uid = c.get("uid");
  if (!uid) return c.redirect("/", 303);
  const { results } = await c.env.DB.prepare(
    "SELECT p.*, COALESCE((SELECT SUM(amount) FROM payments WHERE plan_id=p.id),0) AS paid_total FROM plans p WHERE user_id=? ORDER BY id DESC",
  ).bind(uid).all<PlanRow>();
  const rows = [
    ["client", "client_email", "invoice", "currency", "amount", "paid_so_far", "balance", "due_date", "days_late", "status", "paid_at", "created_at"],
    ...results.map((p) => [
      p.client_name, p.client_email, p.invoice_number, p.currency, money(p.amount), money(p.paid_total),
      money(p.status === "paid" ? 0 : Math.max(0, p.amount - p.paid_total)), p.due_date,
      p.status === "open" ? daysLate(p.due_date) : 0, p.status, p.paid_at ?? "", p.created_at,
    ]),
  ];
  return c.body(rows.map((r) => r.map(csvCell).join(",")).join("\r\n"), 200, {
    "Content-Type": "text/csv; charset=utf-8",
    "Content-Disposition": 'attachment; filename="pestr-plans.csv"',
  });
});

app.post("/plans/:id/:action", async (c) => {
  const plan = await ownedPlan(c, c.req.param("id"));
  if (!plan) return c.redirect("/", 303);
  const action = c.req.param("action");
  if (action === "paid" || action === "reopen") {
    await setPaid(c.env.DB, plan.id, action === "paid");
  } else if (action === "delete") {
    await c.env.DB.prepare("DELETE FROM plans WHERE id=?").bind(plan.id).run();
    return c.redirect("/", 303);
  }
  return c.redirect(`/plans/${plan.id}`, 303);
});

app.get("/s/:public_id", async (c) => {
  const row = await c.env.DB.prepare("SELECT * FROM plans WHERE public_id=?").bind(c.req.param("public_id")).first<Plan>();
  return row ? c.html(publicPage(row, await paidSoFar(c.env.DB, row.id))) : c.text("Not found", 404);
});

app.get("/health", (c) => c.json({ ok: true }));

// MCP endpoint: /mcp/<secret-token>
app.post("/mcp/:token", async (c) => {
  const user = await c.env.DB.prepare("SELECT id FROM users WHERE token=?").bind(c.req.param("token")).first<{ id: number }>();
  if (!user) return c.json(rpcError(null, -32001, "Invalid connection link. Copy a fresh MCP link from the Pestr app."), 404);
  let payload: unknown;
  try {
    payload = await c.req.json();
  } catch {
    return c.json(rpcError(null, -32700, "Parse error"), 400);
  }
  const ctx: ToolCtx = { env: c.env, uid: user.id, base: c.get("base") };
  if (Array.isArray(payload)) {
    const out = (await Promise.all(payload.map((m) => handleRpc(m as Rpc, ctx)))).filter((r) => r !== null);
    return out.length ? c.json(out) : c.body(null, 202);
  }
  const res = await handleRpc(payload as Rpc, ctx);
  return res === null ? c.body(null, 202) : c.json(res);
});

app.all("/mcp/:token", (c) => c.body(null, 405, { Allow: "POST" }));

export default {
  fetch: app.fetch,
  // Runs on the Cron Trigger in wrangler.jsonc (daily). Does nothing until RESEND_API_KEY and FROM_EMAIL are set.
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(sendDueEmails(env));
  },
} satisfies ExportedHandler<Env>;
