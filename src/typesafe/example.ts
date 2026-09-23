/**
 * Example usage of TypeSafe AI integration
 * 
 * Run: TYPESAFE_API_KEY=your_openrouter_key npx tsx src/typesafe/example.ts
 */

import { createTypeSafeClient, runTypeSafeQuery, noul, score, choice } from "./index.js";

async function main() {
  // Check for API key
  if (!process.env.TYPESAFE_API_KEY) {
    console.error("Error: TYPESAFE_API_KEY environment variable required");
    console.error("Get your key from https://openrouter.ai/keys");
    process.exit(1);
  }

  console.log("Creating TypeSafe client...");
  const client = createTypeSafeClient();

  console.log("Running example queries...\n");

  // Example 1: Simple yes/no question
  console.log("=== Example 1: Yes/No Question ===");
  const result1 = await runTypeSafeQuery(
    "The user reported being charged twice for the same subscription.",
    {
      isBilling: noul("Is this a billing-related issue?"),
      isUrgent: noul("Does this require urgent attention?"),
    },
    { client }
  );
  console.log("Is billing:", result1.answers.isBilling.noul);
  console.log("Is urgent:", result1.answers.isUrgent.noul);

  // Example 2: Score question with rubric
  console.log("\n=== Example 2: Score Question ===");
  const result2 = await runTypeSafeQuery(
    "The customer said: 'Your product is okay but the documentation is confusing.'",
    {
      sentiment: score(
        "What is the sentiment of this feedback?",
        [
          "Very negative",      // score 0
          "Somewhat negative",  // score 1
          "Neutral",            // score 2
          "Somewhat positive",  // score 3
          "Very positive",      // score 4
        ]
      ),
    },
    { client }
  );
  console.log("Sentiment score:", result2.answers.sentiment.score);
  console.log("Confidence:", result2.answers.sentiment.confidence);
  console.log("Legend:", result2.answers.sentiment.legend);

  // Example 3: Choice question
  console.log("\n=== Example 3: Choice Question ===");
  const result3 = await runTypeSafeQuery(
    "The server returned a 503 error after 30 seconds.",
    {
      issueType: choice(
        "What type of issue is this?",
        {
          network: "Network connectivity problem",
          server: "Server-side error",
          timeout: "Request timeout",
          auth: "Authentication failure",
        }
      ),
    },
    { client }
  );
  console.log("Selected:", result3.answers.issueType.choice);
  console.log("Confidence:", result3.answers.issueType.confidence);
  console.log("All probabilities:", result3.answers.issueType.probabilities);

  // Example 4: Combined questions
  console.log("\n=== Example 4: Combined Questions ===");
  const result4 = await runTypeSafeQuery(
    {
      userMessage: "I need help resetting my password. The link isn't working.",
      previousActions: ["viewed help docs", "clicked reset link"],
    },
    {
      needsHelp: noul("Does the user need assistance?"),
      priority: score(
        "What is the priority of this request?",
        [
          "Low - can wait",
          "Medium - standard response",
          "High - quick response needed",
          "Critical - immediate attention",
        ]
      ),
      category: choice(
        "What category is this?",
        {
          auth: "Authentication issue",
          technical: "Technical problem",
          account: "Account management",
          other: "Other",
        }
      ),
    },
    { client }
  );
  console.log("Needs help:", result4.answers.needsHelp.noul);
  console.log("Priority score:", result4.answers.priority.score);
  console.log("Category:", result4.answers.category.choice);
  console.log("\nToken usage:", result4.usage);

  console.log("\n=== All examples completed ===");
}

main().catch((err) => {
  console.error("Error:", err);
  process.exit(1);
});
