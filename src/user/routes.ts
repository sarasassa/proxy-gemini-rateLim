import express, { Router } from "express";
import { injectCsrfToken, checkCsrfToken } from "../shared/inject-csrf";
import { browseImagesRouter } from "./web/browse-images";
import { selfServiceRouter } from "./web/self-service";
import { powRouter } from "./web/pow-captcha";
import { questionsRouter } from "./web/questions-captcha";
import { injectLocals } from "../shared/inject-locals";
import { withSession } from "../shared/with-session";
import { config } from "../config";

const userRouter = Router();

userRouter.use(
  express.json({ limit: "1mb" }),
  express.urlencoded({ extended: true, limit: "1mb" })
);
userRouter.use(withSession);
userRouter.use(injectCsrfToken, checkCsrfToken);
userRouter.use(injectLocals);
if (config.showRecentImages) {
  userRouter.use(browseImagesRouter);
}
if (config.captchaMode !== "none") {
  if (config.captchaMode === "proof_of_work_questions") {
    // В режиме questions - только questions-captcha доступен
    userRouter.use("/questions-captcha", questionsRouter);

    // Специальная middleware для captcha - разрешаем только с параметром after_questions=true
    userRouter.use("/captcha", (req, res, next) => {
      if (req.query.after_questions === 'true') {
        // Разрешаем доступ, если это после прохождения вопросов
        next();
      } else {
        // Блокируем прямой доступ
        res.status(403).json({
          error: "Access denied. Questions captcha mode is enabled. Please use /user/questions-captcha instead."
        });
      }
    }, powRouter);
  } else {
    // В обычных режимах - только captcha доступен
    userRouter.use("/captcha", powRouter);

    // Блокируем доступ к questions-captcha
    userRouter.use("/questions-captcha", (req, res) => {
      res.status(403).json({
        error: "Access denied. Questions captcha mode is not enabled. Please use /user/captcha instead."
      });
    });
  }
}
userRouter.use(selfServiceRouter);

userRouter.use(
  (
    err: Error,
    req: express.Request,
    res: express.Response,
    _next: express.NextFunction
  ) => {
    const data: any = { message: err.message, stack: err.stack, status: 500 };
    const isCsrfError = err.message === "invalid csrf token";

    if (isCsrfError) {
      res.clearCookie("csrf");
      req.session.csrf = undefined;
    }

    if (req.accepts("json", "html") === "json") {
      const message = isCsrfError
        ? "CSRF token mismatch; try refreshing the page"
        : err.message;

      return res.status(500).json({ error: message });
    } else {
      return res.status(500).render("user_error", { ...data, flash: null });
    }
  }
);

export { userRouter };
