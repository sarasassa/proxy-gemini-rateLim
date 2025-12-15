import { OpenRouterKey } from "./provider";
import { config } from "../../../config";
import { logger } from "../../../logger";

const CHECK_TIMEOUT = 15000;

interface KeyInfoResponse {
  data: {
    is_free_tier?: boolean;
    usage?: number;
    limit_remaining?: number;
    limit?: number;
  };
  error?: {
    message?: string;
  };
}

interface CreditsResponse {
  data: {
    total_credits?: number;
    total_usage?: number;
  };
  error?: {
    message?: string;
  };
}

export class OpenRouterKeyChecker {
  private log = logger.child({ module: "key-checker", service: "openrouter" });

  constructor(private readonly update: (hash: string, key: Partial<OpenRouterKey>) => void) {
    this.log.info("OpenRouterKeyChecker initialized");
  }

  public async checkKey(key: OpenRouterKey): Promise<void> {
    this.log.info({ hash: key.hash }, "Starting key validation check");
    try {
      const result = await this.validateKey(key);
      this.handleCheckResult(key, result);
    } catch (error) {
      if (error instanceof Error) {
        this.log.error({ error, hash: key.hash }, "Key check failed");
      }
      this.update(key.hash, { lastChecked: Date.now() });
    }
  }

  protected async validateKey(key: OpenRouterKey): Promise<{
    isValid: boolean;
    isOverQuota: boolean;
    isRevoked?: boolean;
    isFreeTier?: boolean;
    accountBalance?: number;
    effectiveBalance?: number;
    limitRemaining?: number;
    keyLimit?: number;
    error?: string;
    retryAfter?: number; // minutes to wait before retry
  }> {
    const log = logger.child({ module: "key-checker", service: "openrouter", keyHash: key.hash });

    try {
      // First check the key information
      const keyInfoResponse = await this.makeRequest(key, "key");

      if (keyInfoResponse.status === 429) {
        log.warn({ status: keyInfoResponse.status }, "Rate limited during key check");
        return {
          isValid: true,
          isOverQuota: true,
          error: "Rate limited during key validation",
          retryAfter: 5
        };
      }

      if (keyInfoResponse.status !== 200 || !keyInfoResponse.data?.data) {
        const errorText = keyInfoResponse.data?.error?.message || "Invalid response";
        log.warn({ status: keyInfoResponse.status, error: errorText }, "Key validation failed");

        if (keyInfoResponse.status === 401) {
          return {
            isValid: false,
            isOverQuota: false,
            isRevoked: true,
            error: `Unauthorized - invalid API key (${keyInfoResponse.status})`
          };
        }

        return {
          isValid: false,
          isOverQuota: false,
          error: `Key validation failed (${keyInfoResponse.status}): ${errorText}`,
          retryAfter: keyInfoResponse.status >= 500 ? 10 : 30
        };
      }

      const keyInfo = keyInfoResponse.data as KeyInfoResponse;
      const isFreeTier = keyInfo.data.is_free_tier ?? false;
      const usage = keyInfo.data.usage ?? 0;
      const limitRemaining = keyInfo.data.limit_remaining;
      const keyLimit = keyInfo.data.limit;

      log.debug({
        isFreeTier,
        usage,
        limitRemaining,
        keyLimit
      }, "Key info retrieved");

      // For paid keys, check account balance
      let accountBalance = 0;
      if (!isFreeTier) {
        const creditsResponse = await this.makeRequest(key, "credits");

        if (creditsResponse.status === 200 && creditsResponse.data) {
          const creditsData = creditsResponse.data as CreditsResponse;
          const totalCredits = creditsData.data.total_credits ?? 0;
          const totalUsage = creditsData.data.total_usage ?? 0;
          accountBalance = totalCredits - totalUsage;

          log.debug({
            totalCredits,
            totalUsage,
            accountBalance
          }, "Account balance retrieved");
        }
      }

      // Determine if key is over quota and calculate effective balance
      let isOverQuota = false;
      let effectiveBalance = 0;

      if (isFreeTier) {
        // Free tier: check if usage exceeds $0.01 limit
        isOverQuota = usage >= 0.01;
        effectiveBalance = Math.max(0, 0.01 - usage); // Remaining free tier balance
      } else {
        // Paid tier logic based on Python implementation

        // 1. Check if key limit is exhausted (highest priority)
        if (limitRemaining !== null && limitRemaining !== undefined && limitRemaining <= 0) {
          isOverQuota = true;
          effectiveBalance = 0;
          log.debug({ limitRemaining }, "Key limit exhausted");
        }
        // 2. If key limit is okay, check account balance
        else if (accountBalance > 0) {
          isOverQuota = false;

          // Calculate effective balance based on what's available
          if (limitRemaining !== null && limitRemaining !== undefined) {
            // If both key limit and account balance exist, use the minimum
            effectiveBalance = Math.min(accountBalance, limitRemaining);
            log.debug({ accountBalance, limitRemaining, effectiveBalance }, "Using minimum of account balance and key limit");
          } else {
            // Only account balance exists (no key limit)
            effectiveBalance = accountBalance;
            log.debug({ accountBalance, effectiveBalance }, "Using account balance (no key limit)");
          }
        }
        // 3. Account balance is exhausted
        else {
          isOverQuota = true;
          effectiveBalance = 0;
          log.debug({ accountBalance }, "Account balance exhausted");
        }
      }

      return {
        isValid: true,
        isOverQuota,
        isFreeTier,
        accountBalance,
        effectiveBalance, // The actual usable balance
        limitRemaining,
        keyLimit
      };

    } catch (error) {
      log.error({ error }, "Failed to check OpenRouter key");
      throw error;
    }
  }

  private async makeRequest(key: OpenRouterKey, endpoint: string): Promise<{
    status: number;
    data: KeyInfoResponse | CreditsResponse | null;
  }> {
    const url = `https://openrouter.ai/api/v1/${endpoint}`;
    const headers = {
      "Authorization": `Bearer ${key.key}`,
      "Content-Type": "application/json",
    };

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), CHECK_TIMEOUT);

      const response = await fetch(url, {
        method: "GET",
        headers,
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      let data = null;
      try {
        data = await response.json();
      } catch (e) {
        // If JSON parsing fails, data remains null
        this.log.warn({ error: e }, "Failed to parse JSON response");
      }

      return { status: response.status, data };

    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        throw new Error(`Request timeout after ${CHECK_TIMEOUT}ms`);
      }
      throw error;
    }
  }

  private handleCheckResult(key: OpenRouterKey, result: {
    isValid: boolean;
    isOverQuota: boolean;
    isRevoked?: boolean;
    isFreeTier?: boolean;
    accountBalance?: number;
    limitRemaining?: number;
    keyLimit?: number;
    error?: string;
    retryAfter?: number; // minutes to wait before retry
  }) {
    this.log.info({
      hash: key.hash,
      isValid: result.isValid,
      isOverQuota: result.isOverQuota,
      isRevoked: result.isRevoked,
      isFreeTier: result.isFreeTier,
      accountBalance: result.accountBalance,
      retryAfter: result.retryAfter
    }, "Key validation result");

    const now = Date.now();
    let lastChecked = now;

    // Calculate next check time if retryAfter is specified
    if (result.retryAfter) {
      // Set lastChecked to force a recheck after the specified minutes
      const retryTime = result.retryAfter * 60 * 1000; // convert minutes to milliseconds
      lastChecked = now - (6 * 60 * 60 * 1000 - retryTime); // KEY_CHECK_PERIOD is 6 hours
    }

    if (result.isValid) {
      this.update(key.hash, {
        isDisabled: result.isOverQuota,
        isOverQuota: result.isOverQuota,
        isRevoked: false,
        isFreeTier: result.isFreeTier ?? false,
        accountBalance: result.accountBalance,
        limitRemaining: result.limitRemaining,
        keyLimit: result.keyLimit,
        lastChecked: now,
        modelFamilies: result.isFreeTier
          ? ["openrouter-free"]
          : ["openrouter-paid", "openrouter-free"], // Paid keys can also access free models
      });
      return;
    }

    // Key is invalid or over quota
    if (result.isRevoked) {
      this.log.warn({ hash: key.hash, error: result.error }, "Key has been revoked, disabling");
      this.update(key.hash, {
        isDisabled: true,
        isRevoked: true,
        isOverQuota: false,
        lastChecked: now,
      });
      return;
    }

    if (result.isOverQuota) {
      this.log.warn({ hash: key.hash, error: result.error, retryAfter: result.retryAfter }, "Key has exceeded its quota or is rate limited, disabling temporarily");
      this.update(key.hash, {
        isDisabled: true,
        isOverQuota: true,
        isRevoked: false,
        lastChecked: lastChecked,
      });
      return;
    }

    // General error case - some errors might be temporary
    if (result.retryAfter) {
      this.log.warn({ hash: key.hash, error: result.error, retryAfter: result.retryAfter }, "Key validation failed temporarily, will retry");
      this.update(key.hash, {
        isDisabled: true,
        isOverQuota: false,
        isRevoked: false,
        lastChecked: lastChecked,
      });
      return;
    }

    // Permanent error case
    this.log.warn({ hash: key.hash, error: result.error }, "Key validation failed permanently, disabling");
    this.update(key.hash, {
      isDisabled: true,
      isOverQuota: false,
      isRevoked: false,
      lastChecked: now,
    });
  }
}