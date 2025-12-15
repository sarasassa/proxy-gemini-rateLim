import crypto from "crypto";
import express from "express";
import argon2 from "@node-rs/argon2";
import { z } from "zod";
import { signMessage } from "../../shared/hmac-signing";
import {
  authenticate,
  createUser,
  getUser,
  upsertUser,
} from "../../shared/users/user-store";
import { config } from "../../config";
import fs from "fs";
import path from "path";

/** Lockout time after verification in milliseconds */
const LOCKOUT_TIME = 1000 * 60; // 60 seconds

let questionsKeySalt = crypto.randomBytes(32).toString("hex");

/**
 * Invalidates any outstanding unsolved question challenges.
 */
export function invalidateQuestionsChallenges() {
  questionsKeySalt = crypto.randomBytes(32).toString("hex");
}

const argon2Params = {
  ARGON2_TIME_COST: parseInt(process.env.ARGON2_TIME_COST || "8"),
  ARGON2_MEMORY_KB: parseInt(process.env.ARGON2_MEMORY_KB || String(1024 * 64)),
  ARGON2_PARALLELISM: parseInt(process.env.ARGON2_PARALLELISM || "1"),
  ARGON2_HASH_LENGTH: parseInt(process.env.ARGON2_HASH_LENGTH || "32"),
};

/**
 * Work factor for each difficulty. This is the expected number of hashes that
 * will be computed to solve the challenge, on average. The actual number of
 * hashes will vary due to randomness.
 */
const workFactors = { extreme: 4000, high: 1900, medium: 900, low: 200 };

// Load questions from JSON file
let cachedQuestions: any = null;
let questionsLastModified = 0;

function loadQuestions() {
  const questionsPath = path.join(process.cwd(), "questions.json");
  try {
    const stats = fs.statSync(questionsPath);
    if (stats.mtime.getTime() === questionsLastModified && cachedQuestions) {
      return cachedQuestions;
    }

    const questionsData = JSON.parse(fs.readFileSync(questionsPath, "utf8"));
    cachedQuestions = questionsData;
    questionsLastModified = stats.mtime.getTime();
    return questionsData;
  } catch (error) {
    throw new Error(`Failed to load questions: ${error.message}`);
  }
}

function getRandomQuestions(count: number, excludeIds: number[] = []): any[] {
  const questionsData = loadQuestions();
  const allQuestions = questionsData.questions || [];

  let availableQuestions = allQuestions.map((q: any, index: number) => {
    let options = null;

    if (q.type !== "text") {
      // Получаем все варианты ответов
      const allOptions = Object.keys(q.answers || {});

      // Перемешиваем опции если включен shuffleAnswers
      if (config.shuffleAnswers) {
        for (let i = allOptions.length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1));
          [allOptions[i], allOptions[j]] = [allOptions[j], allOptions[i]];
        }
      }

      options = allOptions;
    }

    return {
      id: index,
      type: q.type,
      question: q.question,
      options: options
    };
  });

  // Exclude already used questions
  if (excludeIds.length > 0) {
    availableQuestions = availableQuestions.filter((q: any) => !excludeIds.includes(q.id));
  }

  // Shuffle and take required number
  if (config.randomizeQuestions) {
    for (let i = availableQuestions.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [availableQuestions[i], availableQuestions[j]] = [availableQuestions[j], availableQuestions[i]];
    }
  }

  return availableQuestions.slice(0, Math.min(count, availableQuestions.length));
}

type QuestionChallenge = {
  /** Challenge ID */
  id: string;
  /** Questions array */
  questions: any[];
  /** Expiry time in milliseconds */
  e: number;
  /** IP address of the client */
  ip?: string;
  /** Challenge version */
  v?: number;
  /** Usertoken for refreshing */
  token?: string;
  /** Number of questions correct */
  correct?: number;
  /** Total questions */
  total?: number;
};

type PoWChallenge = {
  /** Salt */
  s: string;
  /** Argon2 hash length */
  hl: number;
  /** Argon2 time cost */
  t: number;
  /** Argon2 memory cost */
  m: number;
  /** Argon2 parallelism */
  p: number;
  /** Challenge target value (difficulty) */
  d: string;
  /** Expiry time in milliseconds */
  e: number;
  /** IP address of the client */
  ip?: string;
  /** Challenge version */
  v?: number;
  /** Usertoken for refreshing */
  token?: string;
};

const questionVerifySchema = z.object({
  challenge: z.object({
    id: z.string().min(1).max(64),
    questions: z.array(z.any()),
    e: z.number().int().positive(),
    ip: z.string().min(1).max(64).optional(),
    v: z.literal(1).optional(),
    token: z.string().min(1).max(64).optional(),
  }),
  answers: z.array(z.any()),
  signature: z.string().min(1),
  proxyKey: z.string().min(1).max(1024).optional(),
});

const questionSchema = z.object({
  action: z.union([z.literal("new"), z.literal("refresh")]),
  refreshToken: z.string().min(1).max(64).optional(),
  proxyKey: z.string().min(1).max(1024).optional(),
});

/** Solutions by timestamp */
const solves = new Map<string, number>();
/** Recent attempts by IP address */
const recentAttempts = new Map<string, number>();

setInterval(() => {
  const now = Date.now();
  for (const [ip, timestamp] of recentAttempts) {
    if (now - timestamp > LOCKOUT_TIME) {
      recentAttempts.delete(ip);
    }
  }

  for (const [key, timestamp] of solves) {
    if (now - timestamp > config.powChallengeTimeout * 1000 * 60) {
      solves.delete(key);
    }
  }
}, 1000);

function generateQuestionChallenge(clientIp?: string, token?: string): QuestionChallenge {
  return {
    id: crypto.randomBytes(16).toString("hex"),
    questions: getRandomQuestions(config.questionCount),
    e: Date.now() + config.powChallengeTimeout * 1000 * 60,
    ip: clientIp,
    token,
  };
}

function generatePoWChallenge(clientIp?: string, token?: string): PoWChallenge {
  let workFactor =
    (typeof config.powDifficultyLevel === "number"
      ? config.powDifficultyLevel
      : workFactors[config.powDifficultyLevel]) || 1000;

  // If this is a token refresh, halve the work factor
  if (token) {
    workFactor = Math.floor(workFactor / 2);
  }

  const hashBits = BigInt(argon2Params.ARGON2_HASH_LENGTH) * 8n;
  const hashMax = 2n ** hashBits;
  const targetValue = hashMax / BigInt(workFactor);

  return {
    s: crypto.randomBytes(32).toString("hex"),
    hl: argon2Params.ARGON2_HASH_LENGTH,
    t: argon2Params.ARGON2_TIME_COST,
    m: argon2Params.ARGON2_MEMORY_KB,
    p: argon2Params.ARGON2_PARALLELISM,
    d: targetValue.toString() + "n",
    e: Date.now() + config.powChallengeTimeout * 1000 * 60,
    ip: clientIp,
    token,
  };
}

function verifyQuestionAnswers(challengeQuestions: any[], userAnswers: any[]): boolean {
  if (challengeQuestions.length !== userAnswers.length) {
    return false;
  }

  // Загружаем полные данные вопросов с ответами с сервера
  const questionsData = loadQuestions();
  const allQuestions = questionsData.questions || [];

  let correctCount = 0;

  for (let i = 0; i < challengeQuestions.length; i++) {
    const clientQuestion = challengeQuestions[i];
    const userAnswer = userAnswers[i];

    // Находим полный вопрос по ID
    const fullQuestion = allQuestions[clientQuestion.id];
    if (!fullQuestion) return false;

    if (fullQuestion.type === "one") {
      // Single choice
      const isCorrect = fullQuestion.answers[userAnswer] === true;
      if (isCorrect) correctCount++;
      else if (config.requireAllCorrect) return false;
    } else if (fullQuestion.type === "more") {
      // Multiple choice - нужно выбрать все правильные варианты
      if (!Array.isArray(userAnswer)) return false;

      // Находим все правильные ответы для этого вопроса
      const correctAnswers = Object.keys(fullQuestion.answers).filter(
        key => fullQuestion.answers[key] === true
      );

      // Проверяем, что количество выбранных ответов совпадает с количеством правильных
      if (userAnswer.length !== correctAnswers.length) {
        if (config.requireAllCorrect) return false;
        continue; // Переходим к следующему вопросу
      }

      // Проверяем, что все выбранные ответы являются правильными
      let allCorrect = true;
      for (const selectedOption of userAnswer) {
        if (!fullQuestion.answers[selectedOption]) {
          allCorrect = false;
          break;
        }
      }

      if (allCorrect) correctCount++;
      else if (config.requireAllCorrect) return false;
    } else if (fullQuestion.type === "text") {
      // Text answer
      const userAnswerText = userAnswer.toString().trim().toLowerCase();
      const isValid = fullQuestion.validAnswers.some((validAnswer: string) =>
        validAnswer.toLowerCase() === userAnswerText
      );
      if (isValid) correctCount++;
      else if (config.requireAllCorrect) return false;
    }
  }

  // If requireAllCorrect is false, check if at least half are correct
  if (!config.requireAllCorrect) {
    return correctCount >= Math.ceil(challengeQuestions.length / 2);
  }

  // If requireAllCorrect is true, all answers must be correct
  return correctCount === challengeQuestions.length;
}

function verifyTokenRefreshable(token: string, req: express.Request) {
  const ip = req.ip;

  const user = getUser(token);
  if (!user) {
    req.log.warn({ token }, "Cannot refresh token - not found");
    return false;
  }
  if (user.type !== "temporary") {
    req.log.warn({ token }, "Cannot refresh token - wrong token type");
    return false;
  }
  if (!user.meta?.refreshable) {
    req.log.warn({ token }, "Cannot refresh token - not refreshable");
    return false;
  }
  if (!user.ip.includes(ip)) {
    // If there are available slots, add the IP to the list
    const { result } = authenticate(token, ip);
    if (result === "limited") {
      req.log.warn({ token, ip }, "Cannot refresh token - IP limit reached");
      return false;
    }
  }

  req.log.info({ token: `...${token.slice(-5)}` }, "Allowing token refresh");
  return true;
}

const router = express.Router();

router.post("/challenge", (req, res) => {
  const data = questionSchema.safeParse(req.body);
  if (!data.success) {
    res
      .status(400)
      .json({ error: "Invalid challenge request", details: data.error });
    return;
  }
  const { action, refreshToken, proxyKey } = data.data;
  if (config.proxyKey && proxyKey !== config.proxyKey) {
    res.status(401).json({ error: "Invalid proxy password" });
    return;
  }

  if (action === "refresh") {
    if (!refreshToken || !verifyTokenRefreshable(refreshToken, req)) {
      res.status(400).json({
        error: "Not allowed to refresh that token; request a new one",
      });
      return;
    }
    const challenge = generateQuestionChallenge(req.ip, refreshToken);
    const signature = signMessage(challenge, questionsKeySalt);
    res.json({ challenge, signature });
  } else {
    const challenge = generateQuestionChallenge(req.ip);
    const signature = signMessage(challenge, questionsKeySalt);
    res.json({ challenge, signature });
  }
});

router.post("/verify", async (req, res) => {
  const ip = req.ip;
  req.log.info("Got question verification request");
  if (recentAttempts.has(ip)) {
    const error = "Rate limited; wait a minute before trying again";
    req.log.info({ error }, "Verification rejected");
    res.status(429).json({ error });
    return;
  }

  const result = questionVerifySchema.safeParse(req.body);
  if (!result.success) {
    const error = "Invalid verify request";
    req.log.info({ error, result }, "Verification rejected");
    res.status(400).json({ error, details: result.error });
    return;
  }

  const { challenge, signature, answers } = result.data;
  if (signMessage(challenge, questionsKeySalt) !== signature) {
    const error =
      "Invalid signature; server may have restarted since challenge was issued. Please request a new challenge.";
    req.log.info({ error }, "Verification rejected");
    res.status(400).json({ error });
    return;
  }

  if (config.proxyKey && result.data.proxyKey !== config.proxyKey) {
    const error = "Invalid proxy password";
    req.log.info({ error }, "Verification rejected");
    res.status(401).json({ error, password: result.data.proxyKey });
    return;
  }

  if (challenge.ip && challenge.ip !== ip) {
    const error = "Solution must be verified from original IP address";
    req.log.info(
      { error, challengeIp: challenge.ip, clientIp: ip },
      "Verification rejected"
    );
    res.status(400).json({ error });
    return;
  }

  if (solves.has(signature)) {
    const error = "Reused signature";
    req.log.info({ error }, "Verification rejected");
    res.status(400).json({ error });
    return;
  }

  if (Date.now() > challenge.e) {
    const error = "Verification took too long";
    req.log.info({ error }, "Verification rejected");
    res.status(400).json({ error });
    return;
  }

  if (challenge.token && !verifyTokenRefreshable(challenge.token, req)) {
    res.status(400).json({ error: "Not allowed to refresh that usertoken" });
    return;
  }

  recentAttempts.set(ip, Date.now());

  try {
    const allCorrect = verifyQuestionAnswers(challenge.questions, answers);
    if (!allCorrect) {
      req.log.warn("Incorrect answers, generating new questions");

      // Вместо ошибки, генерируем новый challenge с новыми вопросами
      const newChallenge = generateQuestionChallenge(ip, challenge.token);
      const newSignature = signMessage(newChallenge, questionsKeySalt);

      return res.status(200).json({
        success: false,
        message: "Wrong.",
        newChallenge: newChallenge,
        newSignature: newSignature
      });
    }
    solves.set(signature, Date.now());
  } catch (err) {
    req.log.error(err, "Error verifying question answers");
    res.status(500).json({ error: "Internal error" });
    return;
  }

  if (challenge.token) {
    const user = getUser(challenge.token);
    if (user) {
      upsertUser({
        token: challenge.token,
        expiresAt: Date.now() + config.powTokenHours * 60 * 60 * 1000,
        disabledAt: null,
        disabledReason: null,
      });
      req.log.info(
        { token: `...${challenge.token.slice(-5)}` },
        "Token refreshed after questions"
      );
      return res.json({ success: true, token: challenge.token });
    }
  } else {
    // After correct answers, signal client to request PoW challenge from standard endpoint
    return res.json({
      success: true,
      nextStep: "pow",
      message: "All answers correct! Please proceed to proof-of-work verification."
    });
  }
});

// PoW challenge endpoint for questions captcha mode
router.post("/pow-challenge", (req, res) => {
  const data = questionSchema.safeParse(req.body);
  if (!data.success) {
    res
      .status(400)
      .json({ error: "Invalid PoW challenge request", details: data.error });
    return;
  }
  const { action, refreshToken, proxyKey } = data.data;
  if (config.proxyKey && proxyKey !== config.proxyKey) {
    res.status(401).json({ error: "Invalid proxy password" });
    return;
  }

  if (action === "refresh") {
    if (!refreshToken || !verifyTokenRefreshable(refreshToken, req)) {
      res.status(400).json({
        error: "Not allowed to refresh that token; request a new one",
      });
      return;
    }
    const challenge = generatePoWChallenge(req.ip, refreshToken);
    const signature = signMessage(challenge, questionsKeySalt);
    res.json({ challenge, signature });
  } else {
    const challenge = generatePoWChallenge(req.ip);
    const signature = signMessage(challenge, questionsKeySalt);
    res.json({ challenge, signature });
  }
});

router.get("/", (_req, res) => {
  res.render("user_questions_token", {
    keyRequired: !!config.proxyKey,
    questionCount: config.questionCount,
    tokenLifetime: config.powTokenHours,
    tokenMaxIps: config.powTokenMaxIps,
    challengeTimeout: config.powChallengeTimeout,
        requireAllCorrect: config.requireAllCorrect,
    allowRetryOnError: config.allowRetryOnError,
    shuffleAnswers: config.shuffleAnswers,
    difficultyLevel: config.powDifficultyLevel, // Добавляем для user_challenge_widget
  });
});

export { router as questionsRouter };