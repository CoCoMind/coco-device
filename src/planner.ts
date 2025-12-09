/**
 * Adaptive Session Planner
 *
 * Builds session plans based on research-backed cognitive domains.
 * Selects activities adaptively based on user profile and domain priorities.
 */

import activitiesJson from "../config/curriculum/activities.json";
import {
  Activity,
  ActivityResult,
  SessionPlan,
  CognitiveDomain,
  DifficultyLevel,
} from "./types/activity";
import {
  TrainableDomain,
  TRAINABLE_DOMAINS,
} from "./types/domains";
import {
  UserProfile,
  getDomainScore,
  getDifficultyForDomain,
  getPriorityDomains,
} from "./types/profile";
import { randomUUID } from "node:crypto";

// Cast imported JSON to Activity array
const activityLibrary = activitiesJson as Activity[];

/**
 * Session structure for ~15 minute comprehensive sessions
 *
 * 1. Orientation (1 min)
 * 2. Word Garden - Plant (2 min)
 * 3. Domain Exercise Block 1 (3 min) - attention, working_memory, processing_speed
 * 4. Domain Exercise Block 2 (3 min) - language, executive_function
 * 5. Domain Exercise Block 3 (2 min) - social_cognition
 * 6. Word Garden - Harvest (2 min)
 * 7. Closing (2 min)
 */
interface SessionSlot {
  type: "fixed" | "domain";
  domain?: CognitiveDomain;
  activityId?: string; // For fixed activities like word_garden_plant
  domainPool?: TrainableDomain[]; // For domain blocks
  duration_min: number;
}

const SESSION_STRUCTURE: SessionSlot[] = [
  { type: "fixed", domain: "orientation", duration_min: 1 },
  { type: "fixed", activityId: "word_garden_plant", duration_min: 2 },
  { type: "domain", domainPool: ["complex_attention", "working_memory", "processing_speed"], duration_min: 3 },
  { type: "domain", domainPool: ["language", "executive_function"], duration_min: 3 },
  { type: "domain", domainPool: ["social_cognition"], duration_min: 2 },
  { type: "fixed", activityId: "word_garden_harvest", duration_min: 2 },
  { type: "fixed", domain: "closing", duration_min: 2 },
];

/**
 * Build an adaptive session plan based on user profile
 */
export function buildAdaptivePlan(profile?: UserProfile): SessionPlan {
  const sessionId = randomUUID();
  const planId = randomUUID();
  const activities: Activity[] = [];
  const targetDomains: CognitiveDomain[] = [];
  const usedActivityIds = new Set<string>();

  // Get priority domains if profile available
  const priorityDomains = profile ? getPriorityDomains(profile) : TRAINABLE_DOMAINS;

  for (const slot of SESSION_STRUCTURE) {
    if (slot.type === "fixed") {
      // Fixed activity by ID or domain
      let activity: Activity | undefined;

      if (slot.activityId) {
        activity = activityLibrary.find((a) => a.id === slot.activityId);
      } else if (slot.domain) {
        activity = selectActivityForDomain(slot.domain, usedActivityIds);
      }

      if (activity) {
        activities.push(adjustDifficulty(activity, profile));
        usedActivityIds.add(activity.id);
        if (activity.cognitive_domain !== "orientation" && activity.cognitive_domain !== "closing") {
          targetDomains.push(activity.cognitive_domain);
        }
      }
    } else if (slot.type === "domain" && slot.domainPool) {
      // Select from domain pool based on priority
      const selectedDomain = selectFromPool(slot.domainPool, priorityDomains, targetDomains);

      if (selectedDomain) {
        const activity = selectActivityForDomain(selectedDomain, usedActivityIds);
        if (activity) {
          activities.push(adjustDifficulty(activity, profile));
          usedActivityIds.add(activity.id);
          targetDomains.push(selectedDomain);
        }
      }
    }
  }

  const estimatedDuration = activities.reduce((sum, a) => sum + (a.duration_min ?? 2), 0);

  return {
    session_id: sessionId,
    plan_id: planId,
    activities,
    target_domains: [...new Set(targetDomains)],
    estimated_duration_min: estimatedDuration,
    created_at: new Date().toISOString(),
  };
}

/**
 * Select from a pool of domains based on priority
 */
function selectFromPool(
  pool: TrainableDomain[],
  priorityDomains: TrainableDomain[],
  alreadySelected: CognitiveDomain[]
): TrainableDomain | undefined {
  // First try priority domains that are in the pool and not already selected
  for (const domain of priorityDomains) {
    if (pool.includes(domain) && !alreadySelected.includes(domain)) {
      return domain;
    }
  }

  // Fallback to any domain in the pool not already selected
  for (const domain of pool) {
    if (!alreadySelected.includes(domain)) {
      return domain;
    }
  }

  // Last resort: just pick the first one in the pool
  return pool[0];
}

/**
 * Select an activity for a given domain
 */
function selectActivityForDomain(
  domain: CognitiveDomain,
  usedIds: Set<string>
): Activity | undefined {
  const available = activityLibrary.filter(
    (a) => a.cognitive_domain === domain && !usedIds.has(a.id)
  );

  if (available.length === 0) {
    // Fallback to any activity in the domain
    const fallback = activityLibrary.filter((a) => a.cognitive_domain === domain);
    if (fallback.length === 0) return undefined;
    return fallback[Math.floor(Math.random() * fallback.length)];
  }

  // Random selection from available
  return available[Math.floor(Math.random() * available.length)];
}

/**
 * Adjust activity difficulty based on user profile
 */
function adjustDifficulty(activity: Activity, profile?: UserProfile): Activity {
  if (!profile || activity.difficulty !== "adaptive") {
    return activity;
  }

  const targetDifficulty = getDifficultyForDomain(profile, activity.cognitive_domain);

  // Clone and adjust
  return {
    ...activity,
    difficulty: targetDifficulty,
  };
}

/**
 * Legacy buildPlan function for backwards compatibility
 */
export function buildPlan(): Activity[] {
  const plan = buildAdaptivePlan();
  return plan.activities;
}

// Re-export types for backwards compatibility
export type { Activity } from "./types/activity";
export type { CognitiveDomain, TrainableDomain } from "./types/domains";
