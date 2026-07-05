/* eslint-disable @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument -- Node built-ins (crypto, http, Buffer, URL) resolve to `any` under the community review linter, whose TS program omits @types/node; these are false positives on desktop-only code, not real type holes. */
import * as http from "http";
import * as crypto from "crypto";
import { AddressInfo } from "net";
import { requestUrl } from "obsidian";
import { GMAIL_SCOPES } from "./types";
import { log, logError, withTimeout } from "./log";

export interface TokenSet {
	accessToken: string;
	refreshToken: string | null;
	expiresAt: number; // epoch ms
}

interface TokenResponse {
	access_token: string;
	refresh_token?: string;
	expires_in: number;
	token_type: string;
	scope?: string;
	error?: string;
	error_description?: string;
}

const AUTHORIZE_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";

function base64url(buf: Buffer): string {
	return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function makePkce(): { verifier: string; challenge: string } {
	const verifier = base64url(crypto.randomBytes(32));
	const challenge = base64url(crypto.createHash("sha256").update(verifier).digest());
	return { verifier, challenge };
}

/**
 * Runs the interactive Authorization Code + PKCE flow using a loopback redirect.
 * Google's "Desktop app" OAuth client type accepts any `http://127.0.0.1:<port>`
 * loopback redirect without pre-registering the port. `access_type=offline` plus
 * `prompt=consent` guarantees a refresh token on the first (and every) consent.
 */
export async function interactiveLogin(
	clientId: string,
	clientSecret: string,
	openBrowser: (url: string) => void,
): Promise<TokenSet> {
	if (!clientId) throw new Error("Client ID is not configured.");
	const { verifier, challenge } = makePkce();
	const state = base64url(crypto.randomBytes(16));

	const { code, redirectUri } = await new Promise<{ code: string; redirectUri: string }>(
		(resolve, reject) => {
			const server = http.createServer((req, res) => {
				try {
					const url = new URL(req.url ?? "/", "http://127.0.0.1");
					if (url.pathname !== "/") {
						res.writeHead(404);
						res.end();
						return;
					}
					const returnedState = url.searchParams.get("state");
					const err = url.searchParams.get("error");
					const code = url.searchParams.get("code");

					res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
					if (err) {
						res.end(htmlPage("Login failed", url.searchParams.get("error_description") || err));
						cleanup();
						reject(new Error(`${err}: ${url.searchParams.get("error_description") ?? ""}`));
						return;
					}
					if (returnedState !== state) {
						res.end(htmlPage("Login failed", "State mismatch — possible CSRF. Try again."));
						cleanup();
						reject(new Error("OAuth state mismatch."));
						return;
					}
					if (!code) {
						res.end(htmlPage("Login failed", "No authorization code returned."));
						cleanup();
						reject(new Error("No authorization code returned."));
						return;
					}
					res.end(htmlPage("Signed in", "You can close this tab and return to Obsidian."));
					const addr = server.address() as AddressInfo;
					const redirectUri = `http://127.0.0.1:${addr.port}`;
					cleanup();
					resolve({ code, redirectUri });
				} catch (e) {
					cleanup();
					reject(e instanceof Error ? e : new Error(String(e)));
				}
			});

			const timeout = window.setTimeout(() => {
				cleanup();
				reject(new Error("Login timed out after 5 minutes."));
			}, 5 * 60 * 1000);

			function cleanup() {
				window.clearTimeout(timeout);
				server.close();
			}

			server.on("error", (e) => {
				window.clearTimeout(timeout);
				reject(e instanceof Error ? e : new Error(String(e)));
			});

			// Bind to a random free port on loopback only.
			server.listen(0, "127.0.0.1", () => {
				const addr = server.address() as AddressInfo;
				const redirectUri = `http://127.0.0.1:${addr.port}`;
				const params = new URLSearchParams({
					client_id: clientId,
					response_type: "code",
					redirect_uri: redirectUri,
					scope: GMAIL_SCOPES.join(" "),
					state,
					code_challenge: challenge,
					code_challenge_method: "S256",
					access_type: "offline",
					prompt: "consent",
				});
				const authUrl = `${AUTHORIZE_ENDPOINT}?${params.toString()}`;
				log("Opening browser for consent:", authUrl);
				openBrowser(authUrl);
			});
		},
	);

	// Exchange the code for tokens.
	const body = new URLSearchParams({
		client_id: clientId,
		client_secret: clientSecret,
		grant_type: "authorization_code",
		code,
		redirect_uri: redirectUri,
		code_verifier: verifier,
	});
	return exchange(body);
}

/** Uses a stored refresh token to obtain a fresh access token. */
export async function refreshAccessToken(
	clientId: string,
	clientSecret: string,
	refreshToken: string,
): Promise<TokenSet> {
	const body = new URLSearchParams({
		client_id: clientId,
		client_secret: clientSecret,
		grant_type: "refresh_token",
		refresh_token: refreshToken,
	});
	const tokens = await exchange(body);
	// Google does not return the refresh token on a refresh; preserve the stored one.
	if (!tokens.refreshToken) tokens.refreshToken = refreshToken;
	return tokens;
}

async function exchange(body: URLSearchParams): Promise<TokenSet> {
	// Use Obsidian's requestUrl (a native request with no Origin header) rather
	// than the renderer's fetch, which attaches `Origin: app://obsidian.md` and
	// trips CORS/cross-origin checks on some identity endpoints.
	const resp = await withTimeout(
		requestUrl({
			url: TOKEN_ENDPOINT,
			method: "POST",
			contentType: "application/x-www-form-urlencoded",
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
			body: body.toString(),
			throw: false,
		}),
		30_000,
		"Token endpoint",
	);
	let json: TokenResponse;
	try {
		json = resp.json as TokenResponse;
	} catch {
		throw new Error(`Token endpoint returned ${resp.status}: ${(resp.text ?? "").slice(0, 300)}`);
	}
	const ok = resp.status >= 200 && resp.status < 300;
	if (!ok || json.error) {
		logError("Token exchange failed:", json);
		throw new Error(json.error_description || json.error || `Token endpoint returned ${resp.status}`);
	}
	return {
		accessToken: json.access_token,
		refreshToken: json.refresh_token ?? null,
		expiresAt: Date.now() + json.expires_in * 1000,
	};
}

function escapeHtml(s: string): string {
	return s
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;");
}

function htmlPage(rawTitle: string, rawMessage: string): string {
	const title = escapeHtml(rawTitle);
	const message = escapeHtml(rawMessage);
	return `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>
<style>body{font-family:system-ui,sans-serif;background:#1e1e1e;color:#eee;display:flex;
align-items:center;justify-content:center;height:100vh;margin:0}
.card{text-align:center;padding:2rem 3rem;background:#2a2a2a;border-radius:12px;
box-shadow:0 8px 30px rgba(0,0,0,.4)}h1{margin:0 0 .5rem;font-size:1.4rem}
p{margin:0;color:#aaa}</style></head>
<body><div class="card"><h1>${title}</h1><p>${message}</p></div></body></html>`;
}
/* eslint-enable @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument -- Closes the file-scoped disable for the Node-interop code above. */
