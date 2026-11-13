import { createHmac, timingSafeEqual, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getCookie } from "@tanstack/react-start/server";
import { database, resolveCrmProfileId, upsertCrmProfile, type CrmIdentity } from "./local-db.server";

const ISSUER = "sanlam-crm";
const AUDIENCE = "notify-share-portal";
const SESSION_COOKIE = "portal_crm_session";
const SSO_TOKEN_LIFETIME_SECONDS = 120;
const SESSION_LIFETIME_SECONDS = 8 * 60 * 60;
const ADMIN_OVERRIDE_EMAILS = new Set(["kennedy.malama@zm.sanlam.com"]);
const ADMIN_REMOVAL_EMAILS = new Set([
  "aaron.nyirenda@zm.sanlam.com",
  "fresh.chisenga@zm.sanlam.com",
]);

function normalizeCrmRole(email: string, role: string) {
  const normalizedEmail = email.trim().toLowerCase();
  if (ADMIN_OVERRIDE_EMAILS.has(normalizedEmail)) return "admin";
  if (ADMIN_REMOVAL_EMAILS.has(normalizedEmail)) return "Approver";
  return role;
}

type TokenPayload = CrmIdentity & {
  iss: string;
  aud: string;
  purpose: "crm_sso" | "portal_session";
  sub: string;
  iat: number;
  exp: number;
  jti: string;
};

function getSecret() {
  let secret = process.env["PORTAL_SSO_SECRET"];
  if (!secret) {
    try {
      const line = readFileSync(join(process.cwd(), ".env"), "utf8")
        .split(/\r?\n/)
        .find((entry) => /^\s*PORTAL_SSO_SECRET\s*=/.test(entry));
      secret = line?.slice(line.indexOf("=") + 1).trim().replace(/^(["'])(.*)\1$/, "$2");
    } catch {
      secret = undefined;
    }
  }
  if (!secret || secret.length < 48)
    throw new Error("CRM sign-in is not configured. Contact the portal administrator.");
  return secret;
}

export async function fetchCrmDirectoryUsers() {
  const endpoint = process.env["CRM_DIRECTORY_URL"] || "http://127.0.0.1/api/portal/approvers";
  const url = new URL(endpoint);
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const nonce = randomUUID();
  const signingKey = createHmac("sha256", getSecret())
    .update("notify-share-portal:crm-approver-directory:v1")
    .digest();
  const signature = createHmac("sha256", signingKey)
    .update(`${timestamp}\n${nonce}\n${url.pathname}`)
    .digest("hex");
  const response = await fetch(url, {
    headers: {
      "X-Portal-Timestamp": timestamp,
      "X-Portal-Nonce": nonce,
      "X-Portal-Signature": signature,
    },
    cache: "no-store",
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) {
    throw new Error(`Could not fetch CRM users (HTTP ${response.status}).`);
  }
  const payload: unknown = await response.json();
  if (!Array.isArray(payload)) {
    throw new Error("The CRM user directory returned an invalid response.");
  }

  const users: CrmIdentity[] = [];
  for (const entry of payload) {
    if (
      typeof entry !== "object" || entry === null ||
      typeof entry.id !== "string" || !entry.id ||
      typeof entry.name !== "string" ||
      typeof entry.email !== "string" ||
      typeof entry.role !== "string" ||
      typeof entry.branch !== "string"
    ) {
      throw new Error("The CRM user directory returned an invalid user.");
    }
    const identity: CrmIdentity = {
      id: `crm:${entry.id}`,
      crm_user_id: entry.id,
      full_name: entry.name.slice(0, 200),
      email: entry.email.slice(0, 254),
      department: entry.branch.slice(0, 120),
      role: normalizeCrmRole(entry.email, entry.role).slice(0, 120),
    };
    identity.id = resolveCrmProfileId(identity.email, identity.id);
    upsertCrmProfile(identity);
    users.push(identity);
  }
  return users;
}

function encode(value: unknown) {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function sign(payload: Omit<TokenPayload, "iss" | "aud">) {
  const header = encode({ alg: "HS256", typ: "JWT" });
  const body = encode({ iss: ISSUER, aud: AUDIENCE, ...payload });
  const content = `${header}.${body}`;
  return `${content}.${createHmac("sha256", getSecret()).update(content).digest("base64url")}`;
}

function verify(token: string, purpose: TokenPayload["purpose"]): TokenPayload {
  if (token.length > 8192) throw new Error("Invalid CRM sign-in token.");
  const pieces = token.split(".");
  if (pieces.length !== 3) throw new Error("Invalid CRM sign-in token.");
  const content = `${pieces[0]}.${pieces[1]}`;
  const expected = createHmac("sha256", getSecret()).update(content).digest();
  const actual = Buffer.from(pieces[2]!, "base64url");
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected))
    throw new Error("Invalid CRM sign-in token.");

  let header: { alg?: unknown; typ?: unknown };
  let payload: TokenPayload;
  try {
    header = JSON.parse(Buffer.from(pieces[0]!, "base64url").toString("utf8"));
    payload = JSON.parse(Buffer.from(pieces[1]!, "base64url").toString("utf8"));
  } catch {
    throw new Error("Invalid CRM sign-in token.");
  }
  const now = Math.floor(Date.now() / 1000);
  const maxLifetime = purpose === "crm_sso" ? SSO_TOKEN_LIFETIME_SECONDS : SESSION_LIFETIME_SECONDS;
  if (
    header.alg !== "HS256" || header.typ !== "JWT" ||
    payload.iss !== ISSUER || payload.aud !== AUDIENCE || payload.purpose !== purpose ||
    !Number.isInteger(payload.iat) || !Number.isInteger(payload.exp) ||
    payload.iat > now + 30 || payload.exp <= now || payload.exp - payload.iat > maxLifetime ||
    typeof payload.crm_user_id !== "string" || !payload.crm_user_id ||
    payload.sub !== payload.crm_user_id || payload.id !== `crm:${payload.crm_user_id}` ||
    typeof payload.full_name !== "string" || typeof payload.email !== "string" ||
    typeof payload.department !== "string" || typeof payload.role !== "string" ||
    typeof payload.jti !== "string" || payload.jti.length < 16 || payload.jti.length > 128
  ) throw new Error("Your CRM sign-in has expired or is invalid. Reopen Document Hub from the CRM.");
  return payload;
}

export function consumeCrmSsoToken(token: string) {
  const payload = verify(token, "crm_sso");
  database.prepare("DELETE FROM consumed_sso_tokens WHERE expires_at < ?").run(Math.floor(Date.now() / 1000));
  try {
    database.prepare("INSERT INTO consumed_sso_tokens (jti, expires_at) VALUES (?, ?)").run(payload.jti, payload.exp);
  } catch {
    throw new Error("This CRM sign-in link has already been used. Reopen Document Hub from the CRM.");
  }

  const identity: CrmIdentity = {
    id: `crm:${payload.crm_user_id}`,
    crm_user_id: payload.crm_user_id,
    full_name: payload.full_name.slice(0, 200),
    email: payload.email.slice(0, 254),
    department: payload.department.slice(0, 120),
    role: normalizeCrmRole(payload.email, payload.role).slice(0, 120),
  };
  upsertCrmProfile({
    ...identity,
    id: resolveCrmProfileId(identity.email, identity.id),
  });
  const now = Math.floor(Date.now() / 1000);
  const sessionToken = sign({
    ...identity,
    sub: identity.crm_user_id,
    purpose: "portal_session",
    iat: now,
    exp: now + SESSION_LIFETIME_SECONDS,
    jti: randomUUID(),
  });
  return { identity, sessionToken };
}

export function getCurrentCrmIdentity(): CrmIdentity {
  const token = getCookie(SESSION_COOKIE);
  if (!token) throw new Error("Sign in through the CRM to open Document Hub.");
  const payload = verify(token, "portal_session");
  return {
    id: resolveCrmProfileId(payload.email, payload.id),
    crm_user_id: payload.crm_user_id,
    full_name: payload.full_name,
    email: payload.email,
    department: payload.department,
    role: normalizeCrmRole(payload.email, payload.role),
  };
}

export function getSessionCookieName() {
  return SESSION_COOKIE;
}
