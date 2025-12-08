/**
 * Cognitive Domain Definitions
 *
 * Research-backed cognitive domains based on DSM-5 and NIH Toolbox frameworks.
 * These replace the legacy CST-based categories.
 */

// 7 research-backed cognitive domains + 2 session flow categories
export type CognitiveDomain =
  | "complex_attention"
  | "processing_speed"
  | "executive_function"
  | "working_memory"
  | "episodic_memory"
  | "language"
  | "social_cognition"
  | "orientation" // session flow
  | "closing"; // session flow

// Domains that can be targeted for exercises (excludes session flow)
export type TrainableDomain = Exclude<CognitiveDomain, "orientation" | "closing">;

// All trainable domains for iteration
export const TRAINABLE_DOMAINS: TrainableDomain[] = [
  "complex_attention",
  "processing_speed",
  "executive_function",
  "working_memory",
  "episodic_memory",
  "language",
  "social_cognition",
];

// Domain metadata for display and grouping
export const DOMAIN_INFO: Record<
  CognitiveDomain,
  {
    label: string;
    description: string;
    voiceAccessible: boolean;
  }
> = {
  complex_attention: {
    label: "Attention",
    description: "Sustained focus, divided attention, interference handling",
    voiceAccessible: true,
  },
  processing_speed: {
    label: "Processing Speed",
    description: "Quick responses, rapid perception and categorization",
    voiceAccessible: true,
  },
  executive_function: {
    label: "Executive Function",
    description: "Planning, inhibition, task switching, problem solving",
    voiceAccessible: true,
  },
  working_memory: {
    label: "Working Memory",
    description: "Holding and manipulating information over seconds",
    voiceAccessible: true,
  },
  episodic_memory: {
    label: "Episodic Memory",
    description: "Encoding new information and recalling it later",
    voiceAccessible: true,
  },
  language: {
    label: "Language",
    description: "Vocabulary, naming, fluency, comprehension",
    voiceAccessible: true,
  },
  social_cognition: {
    label: "Social Cognition",
    description: "Interpreting emotions, intentions, social rules",
    voiceAccessible: true,
  },
  orientation: {
    label: "Orientation",
    description: "Session opening and grounding",
    voiceAccessible: true,
  },
  closing: {
    label: "Closing",
    description: "Session closing and personalized farewell",
    voiceAccessible: true,
  },
};

// Legacy domain to new domain mapping for profile migration
export const LEGACY_DOMAIN_MAP: Record<string, CognitiveDomain> = {
  orientation: "orientation",
  language: "language",
  memory: "episodic_memory",
  attention: "complex_attention",
  reminiscence: "social_cognition",
  social: "social_cognition",
  mindfulness: "complex_attention",
  executive: "executive_function",
  errorless_learning: "episodic_memory",
  "CR/goal support": "executive_function",
  music: "episodic_memory",
  reality_orientation: "orientation",
  spaced_retrieval: "episodic_memory",
  goal_support: "executive_function",
  mood: "social_cognition",
  closing: "closing",
};

/**
 * Maps a legacy domain name to the new cognitive domain
 */
export function mapLegacyDomain(legacyDomain: string): CognitiveDomain {
  return LEGACY_DOMAIN_MAP[legacyDomain] ?? "complex_attention";
}
