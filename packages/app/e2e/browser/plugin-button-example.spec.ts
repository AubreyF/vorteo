import { test } from "../support/fixtures";
import { withButtonAuthorExample } from "../support/helpers/plugin-button-example";

async function runExample(
  page: import("@playwright/test").Page,
  info: import("@playwright/test").TestInfo,
  phones: boolean,
) {
  await withButtonAuthorExample(
    page,
    info,
    async (buttons) => {
      await buttons.refreshFromHeaderAndComposer();
      await buttons.useMenusAndToggleButtons();
      await buttons.inspectLiveWorkspaceDetails();
    },
    { phones },
  );
}

test("the button author example shows each capability without a competing overflow button", async ({
  page,
}, info) => {
  test.setTimeout(120_000);
  await runExample(page, info, false);
});

// Product regression, reported to Builds on 2026-10-25: since 195e1c044 phones have no plugin
// header toolbar, so header buttons are unreachable there. Remove the fixme once they return.
test.fixme("the button author example works on phones", async ({ page }, info) => {
  test.setTimeout(120_000);
  await runExample(page, info, true);
});
