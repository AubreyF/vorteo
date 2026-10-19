import { test, expect } from "../support/fixtures";
import { openAgentRoute, seedMockAgentWorkspace } from "../support/helpers/mock-agent";
import {
  chooseQuestionOption,
  continueToNextQuestion,
  expectCurrentQuestion,
  expectQuestionDismissEnabled,
  expectQuestionHidden,
  expectQuestionNavigationEnabled,
  expectQuestionOptionSelected,
  expectQuestionPrimaryActionDisabled,
  expectQuestionPrimaryActionEnabled,
  fillQuestionAnswer,
  openQuestion,
  submitQuestionAnswers,
  waitForQuestionPrompt,
} from "../support/helpers/questions";

const TOTAL_QUESTIONS = 3;
const SURFACE_QUESTION = "Which surface should this apply to?";
const ROLLOUT_QUESTION = "Which rollout should we use?";
const SUCCESS_QUESTION = "What success criteria should we use?";
const REPO_URL_QUESTION = "What is the GitHub private repo URL to push to?";
const COMMIT_MESSAGE_QUESTION = "What should the first commit message be?";

test.describe("Question prompt pagination", () => {
  test("shows one question at a time with numbered navigation", async ({ page }) => {
    test.setTimeout(180_000);

    const session = await seedMockAgentWorkspace({
      repoPrefix: "question-pagination-",
      title: "Question pagination e2e",
      initialPrompt: "Emit synthetic questions.",
    });

    try {
      await openAgentRoute(page, session);
      await waitForQuestionPrompt(page, 120_000);

      await expectCurrentQuestion(page, {
        index: 1,
        total: TOTAL_QUESTIONS,
        question: SURFACE_QUESTION,
      });
      await expectQuestionHidden(page, ROLLOUT_QUESTION);
      await expectQuestionHidden(page, SUCCESS_QUESTION);

      await chooseQuestionOption(page, "App");
      await expectCurrentQuestion(page, {
        index: 2,
        total: TOTAL_QUESTIONS,
        question: ROLLOUT_QUESTION,
      });

      await openQuestion(page, { index: 1, total: TOTAL_QUESTIONS });
      await expectCurrentQuestion(page, {
        index: 1,
        total: TOTAL_QUESTIONS,
        question: SURFACE_QUESTION,
      });
      await expectQuestionOptionSelected(page, "App");

      await openQuestion(page, { index: 2, total: TOTAL_QUESTIONS });
      await chooseQuestionOption(page, "Behind feature flag");
      await expectCurrentQuestion(page, {
        index: 3,
        total: TOTAL_QUESTIONS,
        question: SUCCESS_QUESTION,
      });

      await fillQuestionAnswer(page, {
        question: SUCCESS_QUESTION,
        answer: "Only one prompt is visible at a time.",
      });
      await submitQuestionAnswers(page);
    } finally {
      await session.cleanup();
    }
  });

  for (const width of [1280, 390]) {
    test(`free-write questions use Next before final Submit at ${width}px`, async ({
      page,
    }, info) => {
      await page.setViewportSize({ width, height: 844 });
      test.setTimeout(180_000);

      const session = await seedMockAgentWorkspace({
        repoPrefix: "question-free-write-",
        title: "Question free-write e2e",
        initialPrompt: "Emit synthetic questions: two free-write questions.",
      });

      try {
        await openAgentRoute(page, session);
        await waitForQuestionPrompt(page, 120_000);

        await expectCurrentQuestion(page, {
          index: 1,
          total: 2,
          question: REPO_URL_QUESTION,
        });

        await fillQuestionAnswer(page, {
          question: REPO_URL_QUESTION,
          answer: "git@github.com:user/private-repo.git",
        });

        await expectQuestionPrimaryActionEnabled(page, "Next");
        await expectQuestionDismissEnabled(page);
        await expectQuestionNavigationEnabled(page, { index: 2, total: 2 });

        await continueToNextQuestion(page);
        await expectCurrentQuestion(page, {
          index: 2,
          total: 2,
          question: COMMIT_MESSAGE_QUESTION,
        });
        await expectQuestionPrimaryActionDisabled(page, "Submit");

        const card = page.getByTestId("question-form-card");
        await expect
          .poll(async () => {
            const primary = await card.getByTestId("question-form-primary-action").boundingBox();
            const dismiss = await card.getByTestId("question-form-dismiss").boundingBox();
            if (!primary || !dismiss) return false;
            return Math.abs(primary.y + primary.height / 2 - dismiss.y - dismiss.height / 2) < 1;
          })
          .toBe(true);
        const geometry = await card.evaluate((element) => {
          const primary = element.querySelector('[data-testid="question-form-primary-action"]')!;
          const dismiss = element.querySelector('[data-testid="question-form-dismiss"]')!;
          const actions = primary.parentElement!;
          const input = actions.previousElementSibling!;
          const rect = (node: Element) => node.getBoundingClientRect();
          return {
            rightInset: rect(element).right - rect(primary).right,
            bottomInset: rect(element).bottom - rect(primary).bottom,
            inputGap: rect(actions).top - rect(input).bottom,
            rowCenterOffset:
              (rect(primary).top +
                rect(primary).bottom -
                rect(dismiss).top -
                rect(dismiss).bottom) /
              2,
            dismissBeforeSubmit: rect(dismiss).right < rect(primary).left,
          };
        });
        expect(geometry.rightInset).toBeCloseTo(9, 0);
        expect(geometry.bottomInset).toBeCloseTo(17, 0);
        expect(geometry.inputGap).toBeCloseTo(12, 0);
        expect(geometry.rowCenterOffset).toBeCloseTo(0, 0);
        expect(geometry.dismissBeforeSubmit).toBe(true);
        await card.screenshot({ path: info.outputPath(`question-card-${width}.png`) });

        await fillQuestionAnswer(page, {
          question: COMMIT_MESSAGE_QUESTION,
          answer: "Initialize private repo",
        });
        await expectQuestionPrimaryActionEnabled(page, "Submit");
        await submitQuestionAnswers(page);
      } finally {
        await session.cleanup();
      }
    });
  }
});
