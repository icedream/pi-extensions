/**
 * Fetches the wallet figure a prepaid gateway reports for the API key Pi already uses, so spend
 * from other machines and tools counts and an empty account is known before a call fails.
 * The host is fixed: the key is never sent anywhere else.
 */
import { parseBalanceFigure, type BalanceFigure } from "./budget.ts";

export const OPPER_PROVIDER = "opper";
const ENDPOINT = "https://api.opper.ai/v3/me";
const TIMEOUT_MS = 10_000;

export function isOpperProvider(provider: string): boolean {
	return provider === OPPER_PROVIDER;
}

export async function fetchOpperBalance(apiKey: string): Promise<BalanceFigure> {
	let res: Response;
	try {
		res = await fetch(ENDPOINT, {
			headers: { authorization: `Bearer ${apiKey}`, accept: "application/json" },
			signal: AbortSignal.timeout(TIMEOUT_MS),
		});
	} catch (err) {
		throw new Error(`balance fetch failed: ${(err as Error).message}`);
	}
	if (res.status === 401 || res.status === 403) {
		throw new Error(`balance fetch rejected the credential (HTTP ${res.status})`);
	}
	if (!res.ok) throw new Error(`balance fetch failed: HTTP ${res.status}`);

	let body: unknown;
	try {
		body = await res.json();
	} catch {
		throw new Error("balance fetch returned invalid JSON");
	}
	return parseBalanceFigure(body);
}
