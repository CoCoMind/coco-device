/**
 * Activity Type Definitions
 *
 * Extended activity schema for research-backed cognitive training.
 * Supports structured exercises with built-in scoring and LLM-judged conversations.
 */

import { CognitiveDomain } from "./domains";

// Re-export for convenience
export { CognitiveDomain } from "./domains";

// Activity types determine the execution handler
export type ActivityType =
  // Structured exercises (have specific scoring logic)
  | "go_no_go" // Target detection with response (Animal Spotter, Category Snap)
  | "digit_span" // Number sequence recall (Number Echo, Backwards Challenge)
  | "n_back" // N-back matching (Word Match Game)
  | "word_list" // Word list recall immediate/delayed (Word Garden)
  | "story_recall" // Story comprehension (Story Journey)
  | "verbal_fluency" // Timed word generation (Letter Dash, Category Sprint)
  | "serial_arithmetic" // Counting/math sequences (Countdown Challenge)
  | "task_switching" // Rule-based switching (Category Switcher, Rule Change)
  | "instruction_following" // Multi-step instructions (Follow the Path)
  // Conversational exercises (LLM-judged scoring)
  | "conversation" // Open dialogue (Story Weaver)
  | "guided_recall" // Structured reminiscence (Recipe Memory)
  | "emotion_recognition" // Voice emotion ID (Voice Feelings)
  | "perspective_taking" // Theory of mind (Mind Reader, Perspective Pal)
  // Session flow
  | "orientation" // Session opening
  | "closing"; // Session closing

// Difficulty levels
export type DifficultyLevel = "easy" | "medium" | "hard" | "adaptive";

// Scoring metric types
export type ScoringMetric =
  | "accuracy" // Correct / total (go_no_go, task_switching)
  | "count" // Number of items (verbal_fluency, word_list)
  | "latency" // Response time in ms (processing_speed)
  | "span" // Maximum sequence length (digit_span)
  | "composite" // Multiple metrics combined
  | "llm_judged"; // LLM evaluates quality (conversation)

// Parameters that vary by difficulty and activity type
export interface DifficultyParams {
  // Digit span
  sequence_length?: number;
  direction?: "forward" | "backward";

  // N-back
  n_level?: number;
  trial_count?: number;

  // Word lists
  word_count?: number;
  delay_type?: "immediate" | "delayed";

  // Verbal fluency
  time_limit_sec?: number;
  letter?: string;
  category?: string;

  // Serial arithmetic
  start_number?: number;
  subtract_by?: number;

  // Instructions
  step_count?: number;

  // Go/no-go
  target_category?: string;
  distractor_count?: number;

  // Story recall
  detail_count?: number;
}

// Scoring configuration for an activity
export interface ScoringConfig {
  metric: ScoringMetric;
  capture_timing: boolean;
  normalization?: {
    min_expected: number;
    max_expected: number;
  };
}

/**
 * Activity definition - the core unit of cognitive training
 */
export interface Activity {
  // Identity
  id: string;
  version: number;

  // Domain mapping (research-backed)
  cognitive_domain: CognitiveDomain;
  secondary_domains?: CognitiveDomain[];

  // Activity classification
  type: ActivityType;

  // Difficulty
  difficulty: DifficultyLevel;
  difficulty_params?: DifficultyParams;

  // Scoring configuration
  scoring: ScoringConfig;

  // Content
  title: string;
  description: string;
  instructions: string; // Instructions for Coco on how to run
  script: string[]; // Prompts to speak to user
  goal: string;

  // Timing
  duration_min: number;
  duration_max?: number;

  // For delayed recall pairing
  paired_activity_id?: string; // e.g., word_garden_harvest pairs with word_garden
  delay_after_id?: string; // Run this after paired activity

  // Metadata
  tags: string[];
}

/**
 * Result of running an activity
 */
export interface ActivityResult {
  activity_id: string;
  cognitive_domain: CognitiveDomain;

  // Scoring
  score: number; // 0-100 normalized
  raw_score?: number; // Domain-specific metric (span, count, etc.)
  response_time_ms?: number; // Average response latency

  // Content
  transcripts: string[];
  turn_count: number;

  // Metadata
  difficulty_used: DifficultyLevel;
  completed: boolean;
  skipped_reason?: string;

  // Timing
  started_at: string;
  ended_at: string;
  duration_sec: number;
}

/**
 * Session plan with selected activities
 */
export interface SessionPlan {
  session_id: string;
  plan_id: string;
  activities: Activity[];
  target_domains: CognitiveDomain[];
  estimated_duration_min: number;
  created_at: string;
}

/**
 * Enhanced session result with activity-level details
 */
export interface SessionResult {
  session_id: string;
  plan_id: string;

  // Activity results
  activity_results: ActivityResult[];

  // Aggregated metrics
  domain_scores: Partial<Record<CognitiveDomain, number>>;
  processing_speed_avg_ms?: number;

  // Overall
  duration_sec: number;
  utterance_count: number;
  status: "success" | "unattended" | "early_exit" | "error";

  // Timing
  started_at: string;
  ended_at: string;
}

// Type guard for structured activity types
export function isStructuredActivity(type: ActivityType): boolean {
  return [
    "go_no_go",
    "digit_span",
    "n_back",
    "word_list",
    "story_recall",
    "verbal_fluency",
    "serial_arithmetic",
    "task_switching",
    "instruction_following",
  ].includes(type);
}

// Type guard for conversational activity types
export function isConversationalActivity(type: ActivityType): boolean {
  return [
    "conversation",
    "guided_recall",
    "emotion_recognition",
    "perspective_taking",
  ].includes(type);
}

// Type guard for session flow activity types
export function isSessionFlowActivity(type: ActivityType): boolean {
  return ["orientation", "closing"].includes(type);
}
