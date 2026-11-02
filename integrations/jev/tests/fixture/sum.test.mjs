import * as NodeTest from "node:test";
import * as NodeAssert from "node:assert/strict";
import { add } from "./sum.mjs";

NodeTest.test("add(2, 3) equals 5", () => {
  NodeAssert.equal(add(2, 3), 5);
});
