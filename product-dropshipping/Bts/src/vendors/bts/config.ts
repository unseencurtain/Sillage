import type { BTSConfig } from "./types.js";

const config: BTSConfig = {
  /** Set BTS_JWT_TOKEN in your .env file */
  token: process.env.BTS_JWT_TOKEN ?? "",
  baseUrl: "https://api.btswholesaler.com/v1/api",
  timeout: 180_000, // 3 min — catalog fetches can be slow
  maxRetries: 3,
};

export default config;
