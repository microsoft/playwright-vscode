import { expect, test } from '@playwright/test';

test("should be awesome1", () => {
  expect(1).toBe(1);
});

test.describe("should be awesome²", () => {
  test("me", () => {
    expect(1).toBe(1);
  });
  test("you", () => {
    expect(1).toBe(1);
  });
  test("he", () => {
    expect(1).toBe(1);
  });
  test("she123", ({ page }) => {
    expect(1).toBe(1);
  });
  test("it", () => {
    expect(1).toBe(1);
  });

  test("but not my cat2", () => {
    expect(1).toBe(1);
  });

  test("but not my cat3", async({page}) => {
    expect(await page.evaluate(() => window.navigator.userAgent)).toContain("WebKit");
  });


  test("but not my cat4", () => {
    expect(1).toBe(1);
  });

  test("but not my cat121", () => {
    expect(1).toBe(1);
  });

  test.describe("foobar", () => {
    test("but dfsdnot my cat3434343", () => {
      expect(1).toBe(1);
    });
  });

  test("this is a great new test", () => {
    expect(2).toBe(2);
  });
});
