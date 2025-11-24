import activityLibraryJson from "./content/activities.json";

export type ActivityCategory =
  | "orientation"
  | "language"
  | "memory"
  | "attention"
  | "reminiscence"
  | "closing";

export type Activity = {
  id: string;
  category: ActivityCategory;
  duration_min?: number;
  domain?: string;
  prompt?: string;
  instructions?: string;
  trials?: string[];
  tags?: string[];
  title?: string;
  type?: string;
  goal?: string;
  script?: string[];
  demo_response?: string;
};

type ActivityLibraryEntry = Activity & {
  category: ActivityCategory | string;
};

const ACTIVITY_SEQUENCE: Array<{
  category: ActivityCategory;
  targetMin: number;
}> = [
  { category: "orientation", targetMin: 1 },
  { category: "language", targetMin: 2 },
  { category: "memory", targetMin: 2 },
  { category: "attention", targetMin: 2 },
  { category: "reminiscence", targetMin: 2 },
  { category: "closing", targetMin: 1 },
];

const activityLibrary = activityLibraryJson as ActivityLibraryEntry[];

function selectActivity(
  category: ActivityCategory,
  taken: Set<string>,
): ActivityLibraryEntry {
  const available = activityLibrary.filter(
    (activity) => activity.category === category && !taken.has(activity.id),
  );
  const fallback = activityLibrary.filter(
    (activity) => activity.category === category,
  );
  if (!available.length && !fallback.length) {
    throw new Error(
      `[planner] No activities found for category "${category}".`,
    );
  }
  const pool = available.length ? available : fallback;
  const chosen = pool[Math.floor(Math.random() * pool.length)];
  if (!chosen) {
    throw new Error(
      `[planner] Unable to select activity for category "${category}".`,
    );
  }
  taken.add(chosen.id);
  return chosen;
}

function clampDuration(duration: number | undefined, targetMin: number) {
  const fallback = Number.isFinite(duration) ? Number(duration) : targetMin;
  return Math.max(1, Math.min(2, fallback));
}

function normalizeActivity(
  entry: ActivityLibraryEntry,
  targetMin: number,
): Activity {
  return {
    ...entry,
    duration_min: clampDuration(entry.duration_min, targetMin),
  };
}

export function buildPlan(): Activity[] {
  const taken = new Set<string>();
  return ACTIVITY_SEQUENCE.map(({ category, targetMin }) =>
    normalizeActivity(selectActivity(category, taken), targetMin),
  );
}
