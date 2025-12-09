/**
 * Conversational Exercise Handler
 *
 * Handles open-ended exercises that use LLM-based scoring:
 * - Story Weaver, Recipe Memory, Word Explorer
 * - Voice Feelings, Mind Reader Stories, Perspective Pal, Social Detective
 * - Sound Focus, Mental Postcard
 * - Orientation and Closing activities
 */

import { Activity, ActivityResult } from "../types/activity";
import OpenAI from "openai";

export interface ConversationalContext {
  speak: (text: string) => Promise<void>;
  listen: () => Promise<{ transcript: string; latency_ms: number }>;
  generateResponse: (
    userMessage: string,
    activity: Activity,
    turnNumber: number
  ) => Promise<{ text: string; shouldFollowUp: boolean }>;
  log: (msg: string) => void;
}

const MAX_TURNS = 3;

export async function runConversationalExercise(
  activity: Activity,
  ctx: ConversationalContext
): Promise<ActivityResult> {
  const startTime = new Date();
  const transcripts: string[] = [];
  const latencies: number[] = [];

  ctx.log(`Conversational: Running ${activity.id}`);

  // Special handling for emotion recognition
  if (activity.type === "emotion_recognition") {
    return runEmotionRecognition(activity, ctx, startTime);
  }

  // Special handling for perspective taking (theory of mind)
  if (activity.type === "perspective_taking" && activity.id === "mind_reader_stories") {
    return runMindReaderStories(activity, ctx, startTime);
  }

  // Standard conversational flow
  let turnNumber = 0;
  let continueConversation = true;

  // First prompt from script
  await ctx.speak(activity.script[0]);

  while (continueConversation && turnNumber < MAX_TURNS) {
    const response = await ctx.listen();
    transcripts.push(response.transcript);
    latencies.push(response.latency_ms);

    if (!response.transcript || response.transcript.trim().length < 2) {
      // No response - try to re-engage
      if (turnNumber < MAX_TURNS - 1) {
        await ctx.speak("Take your time. I'm here when you're ready.");
      }
      turnNumber++;
      continue;
    }

    // Generate contextual response
    const llmResponse = await ctx.generateResponse(
      response.transcript,
      activity,
      turnNumber
    );

    await ctx.speak(llmResponse.text);
    turnNumber++;

    // Check if we should continue or move on
    if (!llmResponse.shouldFollowUp || turnNumber >= MAX_TURNS) {
      continueConversation = false;
    }
  }

  const endTime = new Date();
  const avgLatency =
    latencies.length > 0
      ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length)
      : undefined;

  // For conversational exercises, score is based on engagement quality
  // A basic heuristic: longer, more detailed responses = higher engagement
  const engagementScore = calculateEngagementScore(transcripts);

  return {
    activity_id: activity.id,
    cognitive_domain: activity.cognitive_domain,
    score: engagementScore,
    response_time_ms: avgLatency,
    transcripts,
    turn_count: turnNumber,
    difficulty_used: activity.difficulty,
    completed: true,
    started_at: startTime.toISOString(),
    ended_at: endTime.toISOString(),
    duration_sec: Math.round((endTime.getTime() - startTime.getTime()) / 1000),
  };
}

async function runEmotionRecognition(
  activity: Activity,
  ctx: ConversationalContext,
  startTime: Date
): Promise<ActivityResult> {
  const transcripts: string[] = [];
  let correct = 0;
  const total = 4;

  // Expected emotions for the script prompts
  const emotionTrials = [
    { prompt: activity.script[1], emotions: ["angry", "frustrated", "upset", "surprised", "shocked"] },
    { prompt: activity.script[2], emotions: ["sad", "disappointed", "hurt", "passive aggressive", "upset"] },
    { prompt: activity.script[3], emotions: ["happy", "excited", "joyful", "thrilled"] },
    { prompt: activity.script[4], emotions: ["confused", "uncertain", "worried", "anxious", "unsure"] },
  ];

  ctx.log(`EmotionRecognition: Running Voice Feelings`);

  // Instructions
  await ctx.speak(activity.script[0]);

  for (const trial of emotionTrials) {
    await ctx.speak(trial.prompt);

    const response = await ctx.listen();
    transcripts.push(response.transcript);

    const responseLower = response.transcript.toLowerCase();
    const isCorrect = trial.emotions.some((e) => responseLower.includes(e));

    if (isCorrect) {
      correct++;
    }

    ctx.log(
      `EmotionRecognition: "${response.transcript}" = ${isCorrect ? "correct" : "wrong"}`
    );
  }

  // Closing
  await ctx.speak(activity.script[activity.script.length - 1]);

  const endTime = new Date();
  const score = Math.round((correct / total) * 100);

  return {
    activity_id: activity.id,
    cognitive_domain: activity.cognitive_domain,
    score,
    raw_score: correct,
    transcripts,
    turn_count: total,
    difficulty_used: activity.difficulty,
    completed: true,
    started_at: startTime.toISOString(),
    ended_at: endTime.toISOString(),
    duration_sec: Math.round((endTime.getTime() - startTime.getTime()) / 1000),
  };
}

async function runMindReaderStories(
  activity: Activity,
  ctx: ConversationalContext,
  startTime: Date
): Promise<ActivityResult> {
  const transcripts: string[] = [];
  let correct = 0;
  const total = 2;

  ctx.log(`MindReader: Running theory of mind vignettes`);

  // Instructions
  await ctx.speak(activity.script[0]);

  // First scenario
  await ctx.speak(activity.script[1]); // Sarah and the book
  let response = await ctx.listen();
  transcripts.push(response.transcript);

  // Check if they said "drawer" (where Sarah thinks it is)
  if (response.transcript.toLowerCase().includes("drawer")) {
    correct++;
  }

  // Follow-up question
  await ctx.speak(activity.script[2]); // "Why would she look there?"
  response = await ctx.listen();
  transcripts.push(response.transcript);

  // Second scenario
  await ctx.speak(activity.script[3]); // Mary and the candy
  response = await ctx.listen();
  transcripts.push(response.transcript);

  // Check if they said "blue" (what Mary believes)
  if (response.transcript.toLowerCase().includes("blue")) {
    correct++;
  }

  // Closing
  await ctx.speak(activity.script[activity.script.length - 1]);

  const endTime = new Date();
  const score = Math.round((correct / total) * 100);

  return {
    activity_id: activity.id,
    cognitive_domain: activity.cognitive_domain,
    score,
    raw_score: correct,
    transcripts,
    turn_count: transcripts.length,
    difficulty_used: activity.difficulty,
    completed: true,
    started_at: startTime.toISOString(),
    ended_at: endTime.toISOString(),
    duration_sec: Math.round((endTime.getTime() - startTime.getTime()) / 1000),
  };
}

/**
 * Calculate engagement score based on response quality
 */
function calculateEngagementScore(transcripts: string[]): number {
  if (transcripts.length === 0) return 0;

  // Metrics for engagement:
  // 1. Response length (more words = more engaged)
  // 2. Response count (more turns = more engaged)
  // 3. Content richness (approximated by word diversity)

  const totalWords = transcripts.reduce((sum, t) => {
    const words = t.split(/\s+/).filter((w) => w.length > 0);
    return sum + words.length;
  }, 0);

  const avgWordsPerResponse = totalWords / transcripts.length;

  // Score based on average words per response
  // Very short (<5 words): 30-50
  // Short (5-15 words): 50-70
  // Medium (15-30 words): 70-85
  // Long (>30 words): 85-100

  let score: number;
  if (avgWordsPerResponse < 5) {
    score = 30 + avgWordsPerResponse * 4;
  } else if (avgWordsPerResponse < 15) {
    score = 50 + (avgWordsPerResponse - 5) * 2;
  } else if (avgWordsPerResponse < 30) {
    score = 70 + (avgWordsPerResponse - 15);
  } else {
    score = Math.min(100, 85 + (avgWordsPerResponse - 30) * 0.5);
  }

  // Bonus for multiple turns
  score += Math.min(10, transcripts.length * 3);

  return Math.round(Math.min(100, score));
}
