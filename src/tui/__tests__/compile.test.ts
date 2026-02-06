import { expect, test } from "bun:test";
import App from "../App";

test("tui app module loads", () => {
  expect(typeof App).toBe("function");
});
