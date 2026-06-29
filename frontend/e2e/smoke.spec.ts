import { test, expect } from "@playwright/test";

// A minimal smoke test that needs no backend: the app shell loads and the login
// screen renders its form. Catches build/runtime regressions that unit tests and
// `next build` can miss (hydration errors, broken client entrypoints).
test("login page renders the sign-in form", async ({ page }) => {
  await page.goto("/login");

  // A password field is the reliable signal that the login form mounted.
  const password = page.locator('input[type="password"]');
  await expect(password.first()).toBeVisible();

  // ProxMate branding is present somewhere on the page.
  await expect(page.getByText(/proxmate/i).first()).toBeVisible();
});
