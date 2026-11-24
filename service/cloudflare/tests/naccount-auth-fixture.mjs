import assert from "node:assert/strict";
import { createHash, createSign, generateKeyPairSync, randomBytes } from "node:crypto";
import { createHarness } from "./runtime-harness.mjs";

export const ISSUER = "https://naccount-auth.aiaimimi.com";
export const CLIENT_ID = "easyemail-web";

function base64Url(buffer) {
  return Buffer.from(buffer).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function createRsaSigner(kid) {
  const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwk = publicKey.export({ format: "jwk" });
  return {
    kid,
    privateKey,
    jwk: { kty: "RSA", n: jwk.n, e: jwk.e, alg: "RS256", use: "sig", kid },
  };
}

const primaryKey = createRsaSigner("synthetic-naccount-kid-1");
const rotatedKey = createRsaSigner("synthetic-naccount-kid-2");
const wrongKey = createRsaSigner("synthetic-naccount-kid-1");

export function pkcePair() {
  const verifier = randomBytes(32).toString("hex");
  const challenge = base64Url(createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
}

function signJwt(header, payload, privateKey) {
  const head = base64Url(JSON.stringify(header));
  const body = base64Url(JSON.stringify(payload));
  const signer = createSign("RSA-SHA256");
  signer.update(`${head}.${body}`);
  signer.end();
  return `${head}.${body}.${base64Url(signer.sign(privateKey))}`;
}

export async function naccountFixture({ browser = false, through = null, bindings = {} } = {}) {
  const codes = new Map();
  const tokens = new Map();
  const calls = [];
  const unexpected = [];
  let mode = "normal";
  let activeSigner = primaryKey;

  const h = await createHarness(
    {
      NACCOUNT_CONFIG: JSON.stringify({
        issuer: ISSUER,
        clientId: CLIENT_ID,
        bootstrapAdminUsername: "admin",
      }),
      ...bindings,
    },
    browser,
    through,
    null,
    {
      outboundService: async (request) => {
        const url = new URL(request.url);
        calls.push({ method: request.method, url: request.url, authorization: request.headers.get("authorization") });
        if (mode === "provider-502") return new Response("bad gateway", { status: 502 });
        if (mode === "provider-redirect") {
          return new Response(null, { status: 302, headers: { location: "https://evil.invalid/redirect" } });
        }
        if (url.href === `${ISSUER}/.well-known/jwks.json` && request.method === "GET") {
          return Response.json({ keys: [activeSigner.jwk] });
        }
        if (url.href === `${ISSUER}/oauth2/v1/token` && request.method === "POST") {
          const form = new URLSearchParams(await request.text());
          const code = form.get("code") ?? "";
          const verifier = form.get("code_verifier") ?? "";
          const clientId = form.get("client_id") ?? "";
          const redirectUri = form.get("redirect_uri") ?? "";
          const issued = codes.get(code);
          if (mode === "invalid-grant" || !issued || issued.used) {
            return Response.json({ error: "invalid_grant" }, { status: 400 });
          }
          const expectedChallenge = base64Url(createHash("sha256").update(verifier).digest());
          if (clientId !== issued.clientId || redirectUri !== issued.redirectUri || expectedChallenge !== issued.codeChallenge) {
            return Response.json({ error: "invalid_grant" }, { status: 403 });
          }
          issued.used = true;
          const now = Math.floor(Date.now() / 1000);
          const accessToken = `na_at_${randomBytes(24).toString("hex")}`;
          tokens.set(accessToken, issued);
          const signer = mode === "wrong-signature" ? wrongKey : activeSigner;
          const idToken = signJwt(
            { alg: "RS256", typ: "JWT", kid: signer.kid },
            {
              iss: mode === "wrong-iss" ? "https://evil-issuer.example" : ISSUER,
              sub: issued.sub,
              aud: mode === "wrong-aud" ? "other-client" : issued.clientId,
              azp: issued.clientId,
              iat: now,
              exp: mode === "expired-id-token" ? now - 120 : now + 3600,
              email: issued.email,
              roles: issued.roles,
              ...(issued.nickname ? { nickname: issued.nickname, name: issued.nickname } : {}),
            },
            signer.privateKey,
          );
          return Response.json({
            access_token: accessToken,
            id_token: idToken,
            token_type: "Bearer",
            expires_in: 3600,
            scope: "openid profile",
          });
        }
        if (url.href === `${ISSUER}/oauth2/v1/userinfo` && request.method === "GET") {
          const auth = request.headers.get("authorization") ?? "";
          const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
          const issued = tokens.get(token);
          if (!issued || mode === "user-disabled") {
            return Response.json({ error: "user_disabled" }, { status: 403 });
          }
          return Response.json({
            sub: mode === "sub-mismatch" ? "different-sub-999" : issued.sub,
            authId: issued.sub,
            email: issued.email,
            emailVerified: true,
            roles: issued.roles,
            ...(issued.nickname ? { nickname: issued.nickname } : {}),
            ...(issued.preferredUsername ? { preferred_username: issued.preferredUsername } : {}),
          });
        }
        unexpected.push(request.url);
        return new Response("unexpected outbound request", { status: 502 });
      },
    },
  );

  const redirectUri = `${h.appOrigin}/auth/callback`;
  return {
    h,
    calls,
    redirectUri,
    setMode(next) { mode = next; },
    rotateSigningKey() { activeSigner = rotatedKey; },
    issueCode({
      sub = "e7b183d6-a81f-485a-9c89-32750b1346d0",
      email = "vmjcv666@gmail.com",
      nickname = null,
      preferredUsername = null,
      roles = ["super_admin"],
      codeChallenge = null,
      clientId = CLIENT_ID,
      customRedirectUri = redirectUri,
    } = {}) {
      const pkce = codeChallenge ? { verifier: null, challenge: codeChallenge } : pkcePair();
      const code = `na_code_${randomBytes(24).toString("hex")}`;
      codes.set(code, {
        sub,
        email,
        nickname,
        preferredUsername,
        roles,
        codeChallenge: pkce.challenge,
        clientId,
        redirectUri: customRedirectUri,
        used: false,
      });
      return { code, codeVerifier: pkce.verifier, redirectUri: customRedirectUri };
    },
    async complete(payload, options = {}) {
      return h.request("/api/v1/auth/naccount/complete", {
        method: "POST",
        body: payload,
        ...options,
      });
    },
    async close() {
      await h.close();
      assert.deepEqual(unexpected, []);
    },
  };
}
