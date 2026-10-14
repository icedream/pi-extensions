/**
 * Fetches the Copilot seat figure that github.com/settings/copilot/features renders.
 * Only ever called for the Copilot provider, and only ever against api.github.com.
 */
import { parseSeatFigure, type SeatFigure } from "./budget.ts";

export const COPILOT_PROVIDER = "github-copilot";
const ENDPOINT = "https://api.github.com/copilot_internal/user";
const TIMEOUT_MS = 10_000;

export function isCopilotProvider(provider: string): boolean {
	return provider === COPILOT_PROVIDER;
}

export async function fetchCopilotSeat(token: string): Promise<SeatFigure> {
	let res: Response;
	try {
		res = await fetch(ENDPOINT, {
			headers: { authorization: `Bearer ${token}`, accept: "application/json" },
			signal: AbortSignal.timeout(TIMEOUT_MS),
		});
	} catch (err) {
		throw new Error(`seat fetch failed: ${(err as Error).message}`);
	}
	if (res.status === 401 || res.status === 403) {
		throw new Error(`seat fetch rejected the credential (HTTP ${res.status})`);
	}
	if (!res.ok) throw new Error(`seat fetch failed: HTTP ${res.status}`);

	let body: unknown;
	try {
		body = await res.json();
	} catch {
		throw new Error("seat fetch returned invalid JSON");
	}
	return parseSeatFigure(body);
}
