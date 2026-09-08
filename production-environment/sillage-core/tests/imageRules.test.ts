import { describe, expect, test } from "bun:test";
import {
  absolutizeImageUrl,
  displayedShopImage,
  isUnusableImage,
  isWeakVendorThumb,
  shouldHideForMissingImage,
  shopImageKey,
  shopVisibility,
  thumbsNeedWrite,
} from "../src/sync/imageRules.ts";

describe("imageRules weak BeautyFort thumbs", () => {
  const bfPic =
    "https://www.beautyfort.com/pic/dHNhMzRKNjBiNDA0V2xZRGM5UHhranNEWDVYaTNFdlk%3D";

  test("treats Python None/null strings as missing", () => {
    expect(isUnusableImage("None")).toBe(true);
    expect(isUnusableImage("null")).toBe(true);
    expect(shouldHideForMissingImage("None", true)).toBe(true);
    expect(shopImageKey("None")).toBe("");
    expect(shopImageKey("https://images.btswholesaler.com/ok.jpg")).toBe(
      "https://images.btswholesaler.com/ok.jpg",
    );
  });

  test("displayedShopImage trusts Woo meta when it was queried", () => {
    const feed = "https://images.btswholesaler.com/ok.jpg";
    expect(displayedShopImage("", feed)).toBeNull();
    expect(displayedShopImage("None", feed)).toBeNull();
    expect(displayedShopImage(null, feed)).toBeNull();
    expect(displayedShopImage(undefined, feed)).toBe(feed);
    expect(displayedShopImage(feed, null)).toBe(feed);
  });

  test("thumbsNeedWrite when Woo holds junk and the feed has a real URL", () => {
    const feed = "https://images.btswholesaler.com/ok.jpg";
    expect(thumbsNeedWrite("None", feed)).toBe(true);
    expect(thumbsNeedWrite("", feed)).toBe(true);
    expect(thumbsNeedWrite(feed, feed)).toBe(false);
    expect(thumbsNeedWrite(null, null)).toBe(false);
  });

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

  test("shopVisibility prefers no-image hide over in-stock", () => {
    expect(
      shopVisibility({ stock: 1, imageUrl: bfPic, hideWithoutImage: true, stockThreshold: 0 }),
    ).toBe("hidden_no_image");
    expect(
      shopVisibility({
        stock: 1,
        imageUrl: "https://images.btswholesaler.com/ok.jpg",
        hideWithoutImage: true,
        stockThreshold: 0,
      }),
    ).toBe("visible");
    expect(
      shopVisibility({
        stock: 1,
        imageUrl: "https://images.btswholesaler.com/imgs/productos_cosmetica/imagenes/no_image.webp",
        hideWithoutImage: true,
        stockThreshold: 0,
      }),
    ).toBe("hidden_no_image");
    expect(
      shopVisibility({
        stock: 0,
        imageUrl: "https://images.btswholesaler.com/ok.jpg",
        hideWithoutImage: true,
        stockThreshold: 0,
      }),
    ).toBe("hidden_stock");
    expect(
      shopVisibility({
        stock: 1,
        imageUrl: "https://images.btswholesaler.com/ok.jpg",
        hideWithoutImage: true,
        stockThreshold: 0,
        operatorHidden: true,
      }),
    ).toBe("hidden_operator");
  });
});

describe("absolutizeImageUrl", () => {
  const cdn = "https://images.codeinmoon.xyz";

  test("gives a self-hosted filename this deployment's origin", () => {
    expect(absolutizeImageUrl("9424115.jpg", cdn)).toBe("https://images.codeinmoon.xyz/9424115.jpg");
    expect(absolutizeImageUrl("/9424115.jpg", cdn)).toBe("https://images.codeinmoon.xyz/9424115.jpg");
    expect(absolutizeImageUrl("9424115.jpg", `${cdn}/`)).toBe("https://images.codeinmoon.xyz/9424115.jpg");
  });

  test("the same file follows the box it is deployed on", () => {
    // The point of the whole change: one committed overrides file, no shop borrowing another
    // shop's CDN. Baking the origin in is what left a rebuilt storefront serving 3,221 photos
    // off the box it replaced.
    expect(absolutizeImageUrl("9424115.jpg", "https://images.dev.example")).toBe(
      "https://images.dev.example/9424115.jpg",
    );
  });

  test("leaves somebody else's CDN alone", () => {
    for (const url of [
      "https://cdn.shopify.com/s/files/1/x.jpg",
      "http://images.btswholesaler.com/y.webp",
      "//cdn.shopify.com/protocol-relative.jpg",
    ]) {
      expect(absolutizeImageUrl(url, cdn)).toBe(url);
    }
  });

  test("without a base, a relative value stays unusable rather than becoming a broken img", () => {
    expect(absolutizeImageUrl("9424115.jpg", "")).toBe("9424115.jpg");
    expect(isUnusableImage(absolutizeImageUrl("9424115.jpg", ""))).toBe(true);
  });

  test("junk stays junk, so the override is dropped and the product hides", () => {
    expect(isUnusableImage(absolutizeImageUrl("None", cdn))).toBe(true);
    expect(isUnusableImage(absolutizeImageUrl("", cdn))).toBe(true);
    expect(isUnusableImage(absolutizeImageUrl(null, cdn))).toBe(true);
  });
});
