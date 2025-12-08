/**
 * Profile Store
 *
 * Handles loading and saving user profiles from/to local filesystem.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import {
  UserProfile,
  createDefaultProfile,
  updateDomainScore,
} from "../types/profile";
import { CognitiveDomain } from "../types/domains";
import { ActivityResult } from "../types/activity";

const PROFILES_DIR =
  process.env.COCO_PROFILES_DIR ||
  join(dirname(dirname(__dirname)), "data", "profiles");

/**
 * Get the path to a user's profile file
 */
function getProfilePath(userExternalId: string): string {
  return join(PROFILES_DIR, `${userExternalId}.json`);
}

/**
 * Load a user profile from disk
 * Returns null if profile doesn't exist
 */
export function loadProfile(userExternalId: string): UserProfile | null {
  const path = getProfilePath(userExternalId);

  if (!existsSync(path)) {
    return null;
  }

  try {
    const content = readFileSync(path, "utf-8");
    return JSON.parse(content) as UserProfile;
  } catch {
    return null;
  }
}

/**
 * Save a user profile to disk
 */
export function saveProfile(profile: UserProfile): void {
  const path = getProfilePath(profile.user_external_id);

  // Ensure directory exists
  const dir = dirname(path);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  writeFileSync(path, JSON.stringify(profile, null, 2));
}

/**
 * Load or create a user profile
 */
export function loadOrCreateProfile(
  userExternalId: string,
  participantId: string
): UserProfile {
  const existing = loadProfile(userExternalId);
  if (existing) {
    return existing;
  }

  const newProfile = createDefaultProfile(userExternalId, participantId);
  saveProfile(newProfile);
  return newProfile;
}

/**
 * Update profile with session results
 * Only updates trainable domains (excludes orientation/closing)
 */
export function updateProfileWithResults(
  profile: UserProfile,
  activityResults: ActivityResult[]
): UserProfile {
  let updatedProfile = { ...profile };
  const trainableDomains = new Set([
    "complex_attention",
    "processing_speed",
    "executive_function",
    "working_memory",
    "episodic_memory",
    "language",
    "social_cognition",
  ]);

  // Group results by domain and average scores
  const domainScores: Record<string, number[]> = {};

  for (const result of activityResults) {
    const domain = result.cognitive_domain;
    if (!trainableDomains.has(domain)) continue;

    if (!domainScores[domain]) {
      domainScores[domain] = [];
    }
    domainScores[domain].push(result.score);
  }

  // Update each domain with averaged score
  for (const [domain, scores] of Object.entries(domainScores)) {
    const avgScore = Math.round(
      scores.reduce((a, b) => a + b, 0) / scores.length
    );
    updatedProfile = updateDomainScore(
      updatedProfile,
      domain as CognitiveDomain,
      avgScore
    );
  }

  // Increment total sessions
  updatedProfile = {
    ...updatedProfile,
    total_sessions: updatedProfile.total_sessions + 1,
    updated_at: new Date().toISOString(),
  };

  return updatedProfile;
}
