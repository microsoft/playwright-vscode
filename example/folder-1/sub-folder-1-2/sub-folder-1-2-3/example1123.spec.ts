import { expect, test } from '@playwright/test';

test("should be awesome1", () => {
  expect(1).toBe(1);
});

test("me", () => {
  expect(2).toBe(1);
});

test.describe("should be awesome²", () => {
  test("you", () => {
    expect(1).toBe(1);
  });
  test("he", () => {
    expect(1).toBe(1);
  });
  test("she123", ({page}) => {
    expect(1).toBe(1);
  });
  test("it", () => {
    expect(1).toBe(1);
  });

  test("but not my cat", () => {
    expect(1).toBe(1);
  });
  test("but not my cat23", () => {
    expect(1).toBe(1);
  });
});
  