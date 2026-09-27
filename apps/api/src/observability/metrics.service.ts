import { Injectable } from "@nestjs/common";
import { redactUrl } from "../common/redact.js";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * A real Prometheus scrape target would keep per-route series, but an
 * unbounded route label explodes cardinality when ids appear in paths. We map
 * path segments that look like UUIDs (or are short hex) to `:id` so a path
 * like `/orders/eb9b.../documents` becomes `/orders/:id/documents`.
 */
function routeKey(rawPath: string) {
  const path = redactUrl(rawPath).split("?")[0] ?? "/";
  return path
    .split("/")
    .map((segment) =>
      uuid.test(segment) || /^[0-9a-f]{16,}$/i.test(segment) ? ":id" : segment,
    )
    .join("/");
}

@Injectable()
export class MetricsService {
  private started = Date.now();
  private requests = new Map<string, number>();
  private statuses = new Map<string, number>();
  private durations = new Map<string, number>();
  private failures = new Map<string, number>();
  private ocrProviderCalls = new Map<string, number>();
  private ocrProviderDurations = new Map<string, number>();
  private ocrFallbacks = new Map<string, number>();
  private ocrRoutings = new Map<string, number>();
  private redisRateLimitDegraded = false;

  recordRequest(
    method: string,
    path: string,
    status: number,
    durationMs: number,
  ) {
    const route = `${method} ${routeKey(path)}`;
    this.requests.set(route, (this.requests.get(route) ?? 0) + 1);
    this.statuses.set(`${status}`, (this.statuses.get(`${status}`) ?? 0) + 1);
    this.durations.set(route, (this.durations.get(route) ?? 0) + durationMs);
  }

  recordFailure(kind: string, label: string) {
    const key = `${kind}:${label.replaceAll('"', "_")}`;
    this.failures.set(key, (this.failures.get(key) ?? 0) + 1);
  }

  recordOcrProvider(provider: string, durationMs: number, success: boolean) {
    const key = `${provider}:${success ? "success" : "failure"}`;
    this.ocrProviderCalls.set(key, (this.ocrProviderCalls.get(key) ?? 0) + 1);
    this.ocrProviderDurations.set(
      provider,
      (this.ocrProviderDurations.get(provider) ?? 0) + durationMs,
    );
  }

  recordOcrFallback(from: string, to: string) {
    const key = `${from}:${to}`;
    this.ocrFallbacks.set(key, (this.ocrFallbacks.get(key) ?? 0) + 1);
  }

  recordOcrRouting(provider: string, reason: string) {
    const key = `${provider}:${reason}`;
    this.ocrRoutings.set(key, (this.ocrRoutings.get(key) ?? 0) + 1);
  }

  setRedisRateLimitDegraded(degraded: boolean) {
    this.redisRateLimitDegraded = degraded;
  }

  render(): string {
    const lines: string[] = [];
    const uptime = Math.floor((Date.now() - this.started) / 1000);
    lines.push(
      "# HELP vc_process_uptime_seconds Time since this process started",
    );
    lines.push("# TYPE vc_process_uptime_seconds gauge");
    lines.push(`vc_process_uptime_seconds ${uptime}`);
    lines.push(
      "# HELP vc_redis_rate_limit_degraded Whether API rate limiting is using the local fallback",
    );
    lines.push("# TYPE vc_redis_rate_limit_degraded gauge");
    lines.push(
      `vc_redis_rate_limit_degraded ${this.redisRateLimitDegraded ? 1 : 0}`,
    );
    lines.push(
      "# HELP vc_http_requests_total HTTP requests by route and method",
    );
    lines.push("# TYPE vc_http_requests_total counter");
    for (const [route, count] of [...this.requests.entries()].sort()) {
      const [method, path] = splitRoute(route);
      lines.push(
        `vc_http_requests_total{method="${method}",path="${path}"} ${count}`,
      );
    }
    lines.push("# HELP vc_http_responses_total HTTP responses by status code");
    lines.push("# TYPE vc_http_responses_total counter");
    for (const [status, count] of [...this.statuses.entries()].sort()) {
      lines.push(`vc_http_responses_total{code="${status}"} ${count}`);
    }
    lines.push(
      "# HELP vc_http_request_duration_ms_sum Total request latency in milliseconds per route",
    );
    lines.push("# TYPE vc_http_request_duration_ms_sum counter");
    for (const [route, sum] of [...this.durations.entries()].sort()) {
      const [method, key] = splitRoute(route);
      lines.push(
        `vc_http_request_duration_ms_sum{route="${method} ${key}"} ${Math.round(sum)}`,
      );
    }
    lines.push(
      "# HELP vc_failures_total Business operation failures by kind and label",
    );
    lines.push("# TYPE vc_failures_total counter");
    for (const [key, count] of [...this.failures.entries()].sort()) {
      const [kind, label] = split(key);
      lines.push(`vc_failures_total{kind="${kind}",label="${label}"} ${count}`);
    }
    lines.push(
      "# HELP vc_ocr_provider_calls_total OCR provider calls by result",
    );
    lines.push("# TYPE vc_ocr_provider_calls_total counter");
    for (const [key, count] of [...this.ocrProviderCalls.entries()].sort()) {
      const [provider, result] = split(key);
      lines.push(
        `vc_ocr_provider_calls_total{provider="${provider}",result="${result}"} ${count}`,
      );
    }
    lines.push(
      "# HELP vc_ocr_provider_duration_ms_sum Total OCR provider latency",
    );
    lines.push("# TYPE vc_ocr_provider_duration_ms_sum counter");
    for (const [provider, duration] of [
      ...this.ocrProviderDurations.entries(),
    ].sort())
      lines.push(
        `vc_ocr_provider_duration_ms_sum{provider="${provider}"} ${Math.round(duration)}`,
      );
    lines.push("# HELP vc_ocr_fallbacks_total OCR provider fallback count");
    lines.push("# TYPE vc_ocr_fallbacks_total counter");
    for (const [key, count] of [...this.ocrFallbacks.entries()].sort()) {
      const [from, to] = split(key);
      lines.push(`vc_ocr_fallbacks_total{from="${from}",to="${to}"} ${count}`);
    }
    lines.push("# HELP vc_ocr_routings_total OCR jobs by provider and reason");
    lines.push("# TYPE vc_ocr_routings_total counter");
    for (const [key, count] of [...this.ocrRoutings.entries()].sort()) {
      const [provider, reason] = split(key);
      lines.push(
        `vc_ocr_routings_total{provider="${provider}",reason="${reason}"} ${count}`,
      );
    }
    return lines.join("\n") + "\n";
  }
}

function splitRoute(route: string): [string, string] {
  const idx = route.indexOf(" ");
  return [route.slice(0, idx), route.slice(idx + 1)];
}
function split(key: string): [string, string] {
  const idx = key.indexOf(":");
  return idx === -1 ? [key, ""] : [key.slice(0, idx), key.slice(idx + 1)];
}
