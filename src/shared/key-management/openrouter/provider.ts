import { Key, KeyProvider, createGenericGetLockoutPeriod } from "..";
import { OpenRouterKeyChecker } from "./checker";
import { config } from "../../../config";
import { logger } from "../../../logger";
import { OpenRouterModuleFamily, ModelFamily } from "../../models";
import { prioritizeKeys } from "../prioritize-keys";

export interface OpenRouterKey extends Key {
  readonly service: "openrouter";
  readonly modelFamilies: OpenRouterModuleFamily[];
  isFreeTier: boolean;
  isOverQuota: boolean;
  accountBalance?: number; // in dollars
  effectiveBalance?: number; // in dollars - actual usable balance (min of account balance and key limit)
  limitRemaining?: number; // in dollars
  keyLimit?: number; // in dollars
}

export class OpenRouterKeyProvider implements KeyProvider<OpenRouterKey> {
  readonly service = "openrouter";

  private keys: OpenRouterKey[] = [];
  private checker?: OpenRouterKeyChecker;
  private log = logger.child({ module: "key-provider", service: this.service });

  constructor() {
    const keyConfig = config.openRouterKey?.trim();
    if (!keyConfig) {
      this.log.warn("OPENROUTER_AI_KEY is not set. OpenRouter API will not be available.");
      return;
    }

    const keys = keyConfig.split(",").map((k: string) => k.trim());
    for (const key of keys) {
      if (!key) continue;
      this.keys.push({
        key,
        service: this.service,
        modelFamilies: ["openrouter-paid", "openrouter-free"], // Support both types
        isDisabled: false,
        isRevoked: false,
        promptCount: 0,
        lastUsed: 0,
        lastChecked: 0,
        hash: this.hashKey(key),
        rateLimitedAt: 0,
        rateLimitedUntil: 0,
        tokenUsage: {},
        isFreeTier: false, // Will be determined during key checking
        isOverQuota: false,
      });
    }
  }

  private hashKey(key: string): string {
    return require("crypto").createHash("sha256").update(key).digest("hex");
  }

  public init() {
    if (this.keys.length === 0) return;
    if (!config.checkKeys) {
      this.log.warn(
        "Key checking is disabled. Keys will not be verified."
      );
      return;
    }
    this.checker = new OpenRouterKeyChecker(this.update.bind(this));
    for (const key of this.keys) {
      void this.checker.checkKey(key);
    }
  }

  public get(model: string, streaming?: boolean, requestBody?: any): OpenRouterKey {
    const modelFamily = this.getModelFamily(model);
    const isFreeModel = model.includes(":free") || this.isFreeModelByPricing(model);

    // Get all active keys
    const activeKeys = this.keys.filter(k => !k.isDisabled);

    if (activeKeys.length === 0) {
      throw new Error("No OpenRouter keys available - all keys are disabled");
    }

    // Filter keys based on model type and availability
    let candidateKeys: OpenRouterKey[];

    if (isFreeModel) {
      // For free models: try free keys first, then paid keys as fallback
      const freeKeys = activeKeys.filter(k => k.isFreeTier);
      const paidKeys = activeKeys.filter(k => !k.isFreeTier);

      if (freeKeys.length > 0) {
        candidateKeys = freeKeys;
        this.log.debug(`Trying ${freeKeys.length} free keys for free model: ${model}`);
      } else if (paidKeys.length > 0) {
        candidateKeys = paidKeys;
        this.log.debug(`No free keys available, trying ${paidKeys.length} paid keys for free model: ${model}`);
      } else {
        throw new Error(`No OpenRouter keys available for free model: ${model}`);
      }
    } else {
      // For paid models: try paid keys first, then free keys as fallback
      const paidKeys = activeKeys.filter(k => !k.isFreeTier);
      const freeKeys = activeKeys.filter(k => k.isFreeTier);

      if (paidKeys.length > 0) {
        candidateKeys = paidKeys;
        this.log.debug(`Trying ${paidKeys.length} paid keys for paid model: ${model}`);
      } else if (freeKeys.length > 0) {
        candidateKeys = freeKeys;
        this.log.warn(`Only free keys available, trying ${freeKeys.length} free keys for paid model: ${model}`);
      } else {
        throw new Error(`No OpenRouter keys available for paid model: ${model}`);
      }
    }

    // Custom comparator for OpenRouter keys
    const openRouterComparator = (a: OpenRouterKey, b: OpenRouterKey) => {
      // For paid keys, prioritize by effective balance (higher balance first)
      if (!a.isFreeTier && !b.isFreeTier) {
        const aBalance = a.effectiveBalance || 0;
        const bBalance = b.effectiveBalance || 0;
        return bBalance - aBalance; // Higher balance first
      }

      // For free keys, prioritize by usage (less usage first)
      if (a.isFreeTier && b.isFreeTier) {
        return a.promptCount - b.promptCount;
      }

      // Paid keys before free keys for paid models, free before paid for free models
      if (isFreeModel) {
        return a.isFreeTier ? -1 : 1;
      } else {
        return a.isFreeTier ? 1 : -1;
      }
    };

    // Use the common prioritizeKeys function with our custom comparator
    const keysByPriority = prioritizeKeys(candidateKeys, openRouterComparator);

    const selectedKey = keysByPriority[0];
    if (!selectedKey) {
      throw new Error(`No OpenRouter keys available for model: ${model}`);
    }

    selectedKey.lastUsed = Date.now();
    this.throttle(selectedKey.hash);

    this.log.debug({
      model,
      keyHash: selectedKey.hash,
      isFreeTier: selectedKey.isFreeTier,
      effectiveBalance: selectedKey.effectiveBalance
    }, "Selected OpenRouter key");

    return { ...selectedKey };
  }

  private isFreeModelByPricing(modelId: string): boolean {
    try {
      // Import from the correct path - OpenRouter proxy is in src/proxy/openrouter.ts
      const path = require("path");
      const openrouterPath = path.resolve(__dirname, "../../../proxy/openrouter");
      const { getOpenRouterModelPricing } = require(openrouterPath);
      const pricing = getOpenRouterModelPricing(modelId);
      return pricing ? (pricing.input === 0 && pricing.output === 0) : false;
    } catch (error) {
      this.log.warn({ error: error.message, modelId }, "Failed to get OpenRouter pricing, assuming not free");
      return false;
    }
  }

  public list(): Omit<OpenRouterKey, "key">[] {
    return this.keys.map(({ key, ...rest }) => rest);
  }

  public disable(key: OpenRouterKey): void {
    const found = this.keys.find((k) => k.hash === key.hash);
    if (found) {
      found.isDisabled = true;
    }
  }

  public update(hash: string, update: Partial<OpenRouterKey>): void {
    const key = this.keys.find((k) => k.hash === hash);
    if (key) {
      Object.assign(key, update);
    }
  }

  public available(): number {
    return this.keys.filter((k) => !k.isDisabled).length;
  }

  public incrementUsage(keyHash: string, modelFamily: OpenRouterModuleFamily, usage: { input: number; output: number }) {
    const key = this.keys.find((k) => k.hash === keyHash);
    if (!key) return;

    key.promptCount++;

    if (!key.tokenUsage) {
      key.tokenUsage = {};
    }

    if (!key.tokenUsage[modelFamily]) {
      key.tokenUsage[modelFamily] = { input: 0, output: 0 };
    }

    // Use the specific model family for token usage tracking
    const currentFamilyUsage = key.tokenUsage[modelFamily];
    if (currentFamilyUsage) {
      currentFamilyUsage.input += usage.input;
      currentFamilyUsage.output += usage.output;
    }

    // Also track under the general "openrouter-paid" or "openrouter-free" parent
    const parentFamily = key.isFreeTier ? "openrouter-free" : "openrouter-paid";
    if (!key.tokenUsage[parentFamily]) {
      key.tokenUsage[parentFamily] = { input: 0, output: 0 };
    }
    const parentUsage = key.tokenUsage[parentFamily];
    if (parentUsage) {
      parentUsage.input += usage.input;
      parentUsage.output += usage.output;
    }
  }

  private getModelFamily(model: string): OpenRouterModuleFamily {
    // Use the function from models.ts
    const { getOpenRouterModuleFamily } = require("../../models");
    return getOpenRouterModuleFamily(model);
  }

  /**
   * Upon being rate limited, a key will be locked out for this many milliseconds
   * while we wait for other concurrent requests to finish.
   */
  private static readonly RATE_LIMIT_LOCKOUT = 2000;
  /**
   * Upon assigning a key, we will wait this many milliseconds before allowing it
   * to be used again. This is to prevent the queue from flooding a key with too
   * many requests while we wait to learn whether previous ones succeeded.
   */
  private static readonly KEY_REUSE_DELAY = 500;

  getLockoutPeriod = createGenericGetLockoutPeriod(() => this.keys);

  public markRateLimited(keyHash: string) {
    this.log.debug({ key: keyHash }, "Key rate limited");
    const key = this.keys.find((k) => k.hash === keyHash)!;
    const now = Date.now();
    key.rateLimitedAt = now;
    key.rateLimitedUntil = now + OpenRouterKeyProvider.RATE_LIMIT_LOCKOUT;
  }

  public recheck(): void {
    if (!this.checker || !config.checkKeys) return;
    for (const key of this.keys) {
      this.update(key.hash, {
        isOverQuota: false,
        isDisabled: false,
        lastChecked: 0
      });
      void this.checker.checkKey(key);
    }
  }

  /**
   * Applies a short artificial delay to the key upon dequeueing, in order to
   * prevent it from being immediately assigned to another request before the
   * current one can be dispatched.
   **/
  private throttle(hash: string) {
    const now = Date.now();
    const key = this.keys.find((k) => k.hash === hash)!;

    const currentRateLimit = key.rateLimitedUntil;
    const nextRateLimit = now + OpenRouterKeyProvider.KEY_REUSE_DELAY;

    key.rateLimitedAt = now;
    key.rateLimitedUntil = Math.max(currentRateLimit, nextRateLimit);
  }

  public updateBalanceAfterUsage(keyHash: string): void {
    const key = this.keys.find((k) => k.hash === keyHash);
    if (!key) return;

    // Check if we should recheck the key (every 5 requests for paid keys)
    // Note: Don't increment promptCount here as it's already incremented in incrementUsage
    if (!key.isFreeTier && key.promptCount % 5 === 0) {
      this.log.debug({
        keyHash,
        promptCount: key.promptCount
      }, "Triggering balance refresh for OpenRouter key after usage");

      // Schedule a recheck for this specific key
      if (this.checker) {
        // Reset lastChecked to force immediate recheck
        key.lastChecked = 0;
        void this.checker.checkKey(key);
      }
    }
  }
}