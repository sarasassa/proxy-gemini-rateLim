import { Request, RequestHandler, Router } from "express";
import { createPreprocessorMiddleware } from "./middleware/request";
import { ipLimiter } from "./rate-limit";
import { createQueuedProxyMiddleware } from "./middleware/request/proxy-middleware-factory";
import { addKey, finalizeBody } from "./middleware/request";
import { ProxyResHandlerWithBody } from "./middleware/response";
import axios from "axios";
import { OpenRouterKey, keyPool } from "../shared/key-management";

let modelsCache: any = null;
let modelsCacheTime = 0;

// Cache for model-specific pricing from OpenRouter API
let modelPricingCache: Map<string, { input: number; output: number }> = new Map();
let modelContextCache: Map<string, number> = new Map();

const openrouterResponseHandler: ProxyResHandlerWithBody = async (
  _proxyRes,
  req,
  res,
  body
) => {
  if (typeof body !== "object") {
    throw new Error("Expected body to be an object");
  }

  // For OpenRouter, we generally pass through the response as-is
  // since OpenRouter already follows OpenAI-compatible format
  // But we may need to handle some special cases

  let newBody = body;

  // Check if this is a chat completion response with choices
  if (body.choices && Array.isArray(body.choices) && body.choices.length > 0) {
    // OpenRouter-specific response handling can be added here
    // For now, we pass through the response unchanged
    req.log.debug("OpenRouter chat completion response received");
  }

  res.status(200).json({ ...newBody, proxy: body.proxy });
};

const getModelsResponse = async () => {
  // Return cache if less than 15 minutes old (OpenRouter models list changes frequently)
  if (new Date().getTime() - modelsCacheTime < 1000 * 60 * 15) {
    return modelsCache;
  }

  try {
    // Get an OpenRouter key directly using keyPool.get()
    const modelToUse = "meta-llama/llama-3.1-8b-instruct:free"; // Use a common model for key selection
    const openrouterKey = keyPool.get(modelToUse, "openrouter") as OpenRouterKey;

    if (!openrouterKey || !openrouterKey.key) {
      throw new Error("Failed to get valid OpenRouter key");
    }

    // Fetch models from OpenRouter API with authorization
    const response = await axios.get("https://openrouter.ai/api/v1/models", {
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${openrouterKey.key}`,
        "HTTP-Referer": "https://localhost:7860", // Optional: for analytics
        "X-Title": "Local Proxy", // Optional: for analytics
      },
    });

    // If successful, update the cache
    if (response.data && response.data.data) {
      // Extract pricing and context length information for each model
      response.data.data.forEach((model: any) => {
        // Cache context length
        if (model.context_length && typeof model.context_length === 'number') {
          modelContextCache.set(model.id, model.context_length);
        }

        // Cache pricing information
        if (model.pricing && typeof model.pricing === 'object') {
          // OpenRouter pricing is per 1M tokens in string format
          const promptPrice = parseFloat(model.pricing.prompt) || 0;
          const completionPrice = parseFloat(model.pricing.completion) || 0;

          // Cache pricing even if it's 0 (for free models)
          modelPricingCache.set(model.id, {
            input: promptPrice,
            output: completionPrice
          });

          console.log(`Cached pricing for ${model.id}: $${promptPrice}/M input, $${completionPrice}/M output`);
        }
      });

      modelsCache = {
        object: "list",
        data: response.data.data.map((model: any) => ({
          id: model.id,
          object: "model",
          owned_by: model.owned_by || "openrouter",
          created: model.created || new Date().getTime(),
          pricing: model.pricing || {},
          context_length: model.context_length,
        })),
      };
    } else {
      throw new Error("Unexpected response format from OpenRouter API");
    }
  } catch (error) {
    console.error("Error fetching OpenRouter models:", error);
    throw error; // No fallback - error will be passed to caller
  }

  modelsCacheTime = new Date().getTime();
  return modelsCache;
};

const handleModelRequest: RequestHandler = async (_req, res) => {
  try {
    const modelsResponse = await getModelsResponse();
    res.status(200).json(modelsResponse);
  } catch (error) {
    console.error("Error in handleModelRequest:", error);
    res.status(500).json({ error: "Failed to fetch models" });
  }
};

const openrouterProxy = createQueuedProxyMiddleware({
  mutations: [addKey, finalizeBody],
  target: "https://openrouter.ai/api",
  blockingResponseHandler: openrouterResponseHandler,
});

const openrouterRouter = Router();

// Function to add OpenRouter-specific headers and handle special cases
function addOpenRouterHeaders(req: Request) {
  // Add OpenRouter-specific headers for analytics and identification
  if (!req.headers["HTTP-Referer"]) {
    req.headers["HTTP-Referer"] = "https://localhost:7860";
  }
  if (!req.headers["X-Title"]) {
    req.headers["X-Title"] = "Local Proxy";
  }
}

// Function to handle model fallbacks for OpenRouter
function handleModelFallbacks(req: Request) {
  const model = req.body.model;

  // If no model specified, default to a free model
  if (!model) {
    req.body.model = "meta-llama/llama-3.1-8b-instruct:free";
    req.log.debug("No model specified, defaulting to free model");
  }
}

openrouterRouter.post(
  "/v1/chat/completions",
  ipLimiter,
  createPreprocessorMiddleware(
    { inApi: "openai", outApi: "openai", service: "openrouter" },
    {
      afterTransform: [ addOpenRouterHeaders, handleModelFallbacks ],
      beforeTransform: []
    }
  ),
  openrouterProxy
);

// OpenRouter also supports completions endpoint (for compatibility)
openrouterRouter.post(
  "/v1/completions",
  ipLimiter,
  createPreprocessorMiddleware(
    { inApi: "openai-text", outApi: "openai-text", service: "openrouter" },
    {
      afterTransform: [ addOpenRouterHeaders, handleModelFallbacks ],
      beforeTransform: []
    }
  ),
  openrouterProxy
);

openrouterRouter.get("/v1/models", handleModelRequest);

// Export function to get model-specific pricing
export function getOpenRouterModelPricing(modelId: string): { input: number; output: number } | null {
  return modelPricingCache.get(modelId) || null;
}

// Export function to get model context length
export function getOpenRouterModelContextLength(modelId: string): number | null {
  return modelContextCache.get(modelId) || null;
}

// Initialize cache on startup
export async function initializeOpenRouterCache() {
  try {
    console.log("Initializing OpenRouter models cache...");
    await getModelsResponse();
    console.log(`OpenRouter cache initialized with ${modelPricingCache.size} models`);
  } catch (error) {
    console.error("Failed to initialize OpenRouter cache:", error);
    // Don't throw the error, allow the proxy to start even if cache initialization fails
  }
}

export { openrouterRouter as openrouter };