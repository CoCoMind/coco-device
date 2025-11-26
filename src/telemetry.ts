import log from "./logger";

export type TelemetryEvent = {
  activity_id: string;
  category: string;
  domain?: string;
  duration_min?: number;
  result?: string;
  ms?: number;
};

export async function logEvent(event: TelemetryEvent): Promise<void> {
  log.info("telemetry", "Activity event", event);
}
