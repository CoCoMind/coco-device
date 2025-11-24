export type TelemetryEvent = {
  activity_id: string;
  category: string;
  domain?: string;
  duration_min?: number;
  result?: string;
  ms?: number;
};

export async function logEvent(event: TelemetryEvent): Promise<void> {
  // In a real deployment, send this to durable storage or analytics.
  // For demo purposes we log locally so it is easy to inspect.
  console.info('[telemetry]', JSON.stringify(event));
}
