/**
 * Reads a provider-side request counter from Cloud Monitoring quota usage.
 *
 * The bearer token comes from the gcloud CLI, which keeps application-default credentials in its own
 * store, so this process never handles a service-account key and the token is never logged. The only
 * host contacted is monitoring.googleapis.com for the configured project.
 *
 * Quota usage is a request count, not money: a project with no readable billing account has no dollar
 * figure to fetch, and the Gemini API publishes no usage endpoint of its own.
 */
import { execFile } from "node:child_process";
import { QUOTA_METRIC_TYPE, parseQuotaUsage, usageProject, type UsageConfig, type UsageCounter } from "./budget.ts";

const MONITORING = "https://monitoring.googleapis.com/v3";

function accessToken(): Promise<string> {
	return new Promise((resolve, reject) => {
		// No project argument: gcloud then hands back the active credential's token, which reads any
		// project the account can see. Passing one makes gcloud validate that project as the account
		// context, and it fails for a machine whose configured project is elsewhere.
		execFile("gcloud", ["auth", "print-access-token"], { timeout: 30_000 }, (err, stdout, stderr) => {
			if (err) reject(new Error(`gcloud auth print-access-token: ${(stderr || err.message).trim()}`));
			else resolve(stdout.trim());
		});
	});
}

function iso(ms: number): string {
	return new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
}

export async function fetchGcpQuotaUsage(cfg: UsageConfig, periodStartMs: number, now: Date = new Date()): Promise<UsageCounter> {
	const project = usageProject(cfg);
	if (!project) throw new Error(`no GCP project for the counter: set usage.project or export ${cfg.projectEnv ?? "usage.projectEnv"}`);
	const token = await accessToken();
	const filter = `metric.type="${QUOTA_METRIC_TYPE}" AND metric.label.quota_metric="${cfg.quotaMetric}"`;
	const url =
		`${MONITORING}/projects/${project}/timeSeries` +
		`?filter=${encodeURIComponent(filter)}` +
		`&interval.startTime=${encodeURIComponent(iso(periodStartMs))}` +
		`&interval.endTime=${encodeURIComponent(iso(now.getTime()))}`;
	const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
	if (!res.ok) throw new Error(`Cloud Monitoring ${res.status} for ${cfg.project}: ${(await res.text()).slice(0, 200)}`);
	return parseQuotaUsage(await res.json(), { quotaMetric: cfg.quotaMetric, periodStartMs, asOfMs: now.getTime() });
}
