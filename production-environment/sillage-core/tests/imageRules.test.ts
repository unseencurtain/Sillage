import { describe, expect, test } from "bun:test";
import {
  isUnusableImage,
  isWeakVendorThumb,
  shouldHideForMissingImage,
} from "../src/sync/imageRules.ts";

describe("imageRules weak BeautyFort thumbs", () => {
  const bfPic =
    "https://www.beautyfort.com/pic/dHNhMzRKNjBiNDA0V2xZRGM5UHhranNEWDVYaTNFdlk%3D";

  test("flags beautyfort.com/pic URLs as weak", () => {
    expect(isWeakVendorThumb(bfPic)).toBe(true);
    expect(isUnusableImage(bfPic)).toBe(true);
  });

  test("hides weak /pic/ thumbs when hide-without-image is on", () => {
    expect(shouldHideForMissingImage(bfPic, true)).toBe(true);
    expect(shouldHideForMissingImage(bfPic, false)).toBe(false);
    expect(
      shouldHideForMissingImage("https://images.slilverbelt.xyz/9339341005643.jpg", true),
    ).toBe(false);
  });
});
