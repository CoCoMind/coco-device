# Coco Curriculum

This folder contains the activity library for Coco cognitive companion sessions.

## File Structure

- `activities.json` - All session activities organized by category

## Activity Categories

Each session runs 6 activities in this order:

1. **orientation** (1 min) - Grounding and present-moment awareness
2. **language** (2 min) - Verbal expression and storytelling
3. **memory** (2 min) - Recall and memory exercises
4. **attention** (2 min) - Focus and cognitive flexibility
5. **reminiscence** (2 min) - Life stories and social connection
6. **closing** (1 min) - Personalized wrap-up

## Activity Format

Each activity in `activities.json` has these fields:

```json
{
  "id": "unique_activity_id",
  "category": "orientation|language|memory|attention|reminiscence|closing",
  "title": "Human-readable title",
  "prompt": "Brief description of the activity",
  "domain": "cognitive domain (e.g., mindfulness, spaced_retrieval)",
  "duration_min": 1,
  "type": "cue|conversation|recall|game|closing",
  "instructions": "Internal notes for how to run this activity",
  "script": [
    "First thing Coco says to start the activity",
    "Follow-up prompt if user engages",
    "Final prompt or wrap-up for this activity"
  ],
  "goal": "What this activity aims to achieve",
  "tags": ["searchable", "tags"]
}
```

## How to Add Activities

1. Open `activities.json`
2. Add a new object with all required fields
3. Ensure the `id` is unique
4. Set `category` to one of the 6 valid categories
5. Write 2-3 `script` prompts that Coco will use

## How to Edit Activities

Simply edit the fields in `activities.json`. Changes take effect on the next session.

**Important fields:**
- `script` - The actual prompts Coco speaks (most important for content editors)
- `goal` - Helps the LLM understand the purpose when generating responses
- `instructions` - Guides the LLM on how to handle user responses

## Tips for Writing Good Scripts

- Use warm, conversational language
- Ask open-ended questions
- Keep prompts short (1-2 sentences)
- Include sensory details to spark memories
- Reference personal connections (family, friends, places)
- Avoid yes/no questions

## Example Activity

```json
{
  "id": "orientation_morning_ritual",
  "category": "orientation",
  "title": "Morning ritual check-in",
  "prompt": "Explore the user's morning routine as a grounding exercise",
  "domain": "reality_orientation",
  "duration_min": 1,
  "type": "conversation",
  "instructions": "Focus on sensory details and positive associations",
  "script": [
    "Tell me about your morning so far. What was the first thing you noticed today?",
    "That sounds lovely. What does that moment usually feel like for you?",
    "What's one small thing you're looking forward to today?"
  ],
  "goal": "Ground the user in present moment through familiar routines",
  "tags": ["orientation", "mindfulness", "routine"]
}
```
