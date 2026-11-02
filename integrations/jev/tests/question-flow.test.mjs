import * as NodeTest from "node:test";
import * as NodeAssert from "node:assert/strict";
import { beginQuestion, answerQuestion, questionPrompt } from "../question-flow.mjs";
NodeTest.test(
  "main-chat questions collect the user’s exact answers without turning them into a new task",
  () => {
    const flow = beginQuestion({
      title: "Design reviewer",
      requestId: "q",
      questions: [
        {
          id: "platform",
          question: "Which platform?",
          allowCustomAnswer: false,
          options: [
            { label: "iOS", value: "ios", description: "Apple phones" },
            { label: "Android", value: "android", description: "Android phones" },
          ],
        },
        { id: "notes", question: "What matters most?", options: [], allowCustomAnswer: true },
      ],
    });
    NodeAssert.match(questionPrompt(flow), /Which platform/);
    NodeAssert.ok(answerQuestion(flow, "unlisted").error);
    const first = answerQuestion(flow, "1");
    NodeAssert.equal(first.done, false);
    const last = answerQuestion(first.flow, "Offline support");
    NodeAssert.equal(last.done, true);
    NodeAssert.deepEqual(last.flow.answers, {
      platform: { answers: ["ios"] },
      notes: { answers: ["Offline support"] },
    });
  },
);
