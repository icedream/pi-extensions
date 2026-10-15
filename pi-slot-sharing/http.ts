/**
 * The HTTP layer shared by every backend. Both Strata and llama.cpp answer the same slot API, so the
 * only thing a backend adds is where it reports its own facts and whether it warns before it fails.
 */

export class ServerHttpError extends Error {
	status: number;
	code?: string;
	kind?: string;

	constructor(message: string, status: number, code?: string, kind?: string) {
		super(message);
		this.name = "ServerHttpError";
		this.status = status;
		this.code = code;
		this.kind = kind;
	}
}

function errorFrom(body: unknown, status: number): ServerHttpError {
	const err = body && typeof body === "object" ? (body as { error?: { message?: string; code?: string; type?: string } }).error : undefined;
	return new ServerHttpError(err?.message ?? `HTTP ${status}`, status, err?.code, err?.type);
}

export interface RequestAuth {
	apiKey?: string;
	headers?: Record<string, string>;
}

export class JsonClient {
	readonly baseUrl: string;
	private auth: RequestAuth = {};

	constructor(baseUrl: string, auth?: RequestAuth) {
		this.baseUrl = baseUrl.replace(/\/+$/, "");
		this.auth = auth ?? {};
	}

	/**
	 * Credentials come from Pi's own provider store (see auth.ts), so they can change when the model
	 * does. Setting them here rather than at construction keeps one client per server.
	 */
	setAuth(auth: RequestAuth | undefined): void {
		this.auth = auth ?? {};
	}

	async request<T>(path: string, init?: RequestInit): Promise<T> {
		const headers: Record<string, string> = { accept: "application/json", ...(this.auth.headers ?? {}), ...(init?.headers as Record<string, string> | undefined) };
		if (this.auth.apiKey) headers.authorization = `Bearer ${this.auth.apiKey}`;
		let response: Response;
		try {
			response = await fetch(`${this.baseUrl}${path}`, { ...init, headers });
		} catch (error) {
			throw new ServerHttpError(`${this.baseUrl} unreachable: ${(error as Error).message}`, 0);
		}
		const text = await response.text();
		let body: unknown;
		if (text) {
			try {
				body = JSON.parse(text);
			} catch {
				/* a proxy's HTML error page; fall back to the status */
			}
		}
		if (!response.ok) throw errorFrom(body, response.status);
		return body as T;
	}
}
