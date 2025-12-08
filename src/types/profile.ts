/**
 * User Profile Type Definitions
 *
 * Updated profile schema with research-backed cognitive domains.
 * Version 2 replaces the legacy 15-domain structure with 7 core domains.
 */

import { CognitiveDomain, TrainableDomain, TRAINABLE_DOMAINS } from "./domains";

export type DifficultyPreference = "easy" | "medium" | "hard";

export type TrendDirection = "improving" | "stable" | "declining";

/**
 * Score tracking for a single cognitive domain
 */
export interface DomainScore {
  domain: CognitiveDomain;
  current_score: number; // 0-100
  baseline_score: number; // Initial score for comparison
  improvement: number; // current_score - baseline_score
  trend: TrendDirection;
  session_count: number; // Number of sessions targeting this domain
  last_activity_scores: number[]; // Recent scores for trend calculation
  last_updated: string; // ISO timestamp
}

/**
 * User profile with cognitive domain tracking
 */
export interface UserProfile {
  // Identity
  user_external_id: string;
  participant_id: string;

  // Cognitive domain scores (7 trainable domains)
  domains: DomainScore[];

  // Session stats
  total_sessions: number;

  // Preferences
  preferred_difficulty: DifficultyPreference;

  // Processing speed baseline (for normalization)
  processing_speed_baseline_ms?: number;

  // Metadata
  created_at: string;
  updated_at: string;
  version: 2; // Schema version
}

/**
 * Legacy profile structure (version 1) for migration
 */
export interface LegacyUserProfile {
  user_external_id: string;
  participant_id: string;
  domains: {
    domain: string;
    current_score: number;
    baseline_score: number;
    improvement: number;
    trend: string;
    session_count: number;
    last_activity_scores: number[];
    last_updated: string;
  }[];
  total_sessions: number;
  preferred_difficulty: string;
  created_at: string;
  updated_at: string;
  version?: 1;
}

/**
 * Creates a new user profile with default values
 */
export function createDefaultProfile(
  userExternalId: string,
  participantId: string
): UserProfile {
  const now = new Date().toISOString();

  const domains: DomainScore[] = TRAINABLE_DOMAINS.map((domain) => ({
    domain,
    current_score: 50,
    baseline_score: 50,
    improvement: 0,
    trend: "stable" as TrendDirection,
    session_count: 0,
    last_activity_scores: [],
    last_updated: now,
  }));

  return {
    user_external_id: userExternalId,
    participant_id: participantId,
    domains,
    total_sessions: 0,
    preferred_difficulty: "easy",
    created_at: now,
    updated_at: now,
    version: 2,
  };
}

/**
 * Gets the score for a specific domain
 */
export function getDomainScore(
  profile: UserProfile,
  domain: CognitiveDomain
): DomainScore | undefined {
  return profile.domains.find((d) => d.domain === domain);
}

/**
 * Updates a domain score after an activity
 */
export function updateDomainScore(
  profile: UserProfile,
  domain: CognitiveDomain,
  newScore: number
): UserProfile {
  const now = new Date().toISOString();

  const updatedDomains = profile.domains.map((d) => {
    if (d.domain !== domain) return d;

    const lastScores = [...d.last_activity_scores, newScore].slice(-10);
    const avgRecent =
      lastScores.reduce((a, b) => a + b, 0) / lastScores.length;

    // Calculate trend based on recent scores
    let trend: TrendDirection = "stable";
    if (lastScores.length >= 3) {
      const firstHalf = lastScores.slice(0, Math.floor(lastScores.length / 2));
      const secondHalf = lastScores.slice(Math.floor(lastScores.length / 2));
      const firstAvg = firstHalf.reduce((a, b) => a + b, 0) / firstHalf.length;
      const secondAvg =
        secondHalf.reduce((a, b) => a + b, 0) / secondHalf.length;

      if (secondAvg - firstAvg > 5) trend = "improving";
      else if (firstAvg - secondAvg > 5) trend = "declining";
    }

    return {
      ...d,
      current_score: Math.round(avgRecent),
      improvement: Math.round(avgRecent - d.baseline_score),
      trend,
      session_count: d.session_count + 1,
      last_activity_scores: lastScores,
      last_updated: now,
    };
  });

  return {
    ...profile,
    domains: updatedDomains,
    updated_at: now,
  };
}

/**
 * Gets domains that need attention (declining or not recently exercised)
 */
export function getPriorityDomains(profile: UserProfile): TrainableDomain[] {
  const declining = profile.domains
    .filter((d) => d.trend === "declining")
    .map((d) => d.domain as TrainableDomain);

  const stale = profile.domains
    .filter((d) => d.session_count < 3 && !declining.includes(d.domain as TrainableDomain))
    .map((d) => d.domain as TrainableDomain);

  const remaining = TRAINABLE_DOMAINS.filter(
    (d) => !declining.includes(d) && !stale.includes(d)
  );

  return [...declining, ...stale, ...remaining];
}

/**
 * Determines appropriate difficulty for a domain based on score
 */
export function getDifficultyForDomain(
  profile: UserProfile,
  domain: CognitiveDomain
): DifficultyPreference {
  const domainScore = getDomainScore(profile, domain);
  const score = domainScore?.current_score ?? 50;

  if (score < 40) return "easy";
  if (score < 70) return "medium";
  return "hard";
}
