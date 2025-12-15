# Questions Gatekeep

The questions gatekeep is a two-step verification system that requires users to answer questions correctly before proceeding to the traditional proof-of-work challenge to obtain a temporary user token.

## Configuration

To enable questions gatekeep verification, set the following environment variables:

```
GATEKEEPER=user_token
CAPTCHA_MODE=proof_of_work_questions
# Validity of the token in hours
POW_TOKEN_HOURS=24
# Max number of IPs that can use a user_token issued via proof_of_work_questions
POW_TOKEN_MAX_IPS=2
# The difficulty level of the proof-of-work challenge
POW_DIFFICULTY_LEVEL=low
# The time limit for solving the challenge, in minutes
POW_CHALLENGE_TIMEOUT=30
# Number of questions to ask
QUESTION_COUNT=5
# Whether to show new questions on refresh token
REFRESH_QUESTIONS=true
# Whether to allow retry on error
ALLOW_RETRY_ON_ERROR=true
# Whether to randomize questions
RANDOMIZE_QUESTIONS=true
# Whether to require all correct answers
REQUIRE_ALL_CORRECT=true
# Whether to show progress bar
SHOW_PROGRESS=true
```

## Question Types

### One Answer (`type: "one"`)
Single choice questions where only one answer is correct.

```json
{
  "type": "one",
  "question": "How many days are in a week?",
  "answers": {
    "5": false,
    "6": false,
    "7": true,
    "8": false
  }
}
```

### Multiple Answers (`type: "more"`)
Multiple choice questions where multiple answers can be correct.

```json
{
  "type": "more",
  "question": "Which of these are programming languages? (select all correct)",
  "answers": {
    "Python": true,
    "JavaScript": true,
    "HTML": false,
    "CSS": false,
    "Java": true
  }
}
```

### Text Answer (`type: "text"`)
Text input questions where users type their answer.

```json
{
  "type": "text",
  "question": "What is the capital of Russia?",
  "validAnswers": [
    "moscow",
    "Moscow",
    "MOSCOW",
    "москва",
    "Москва",
    "МОСКВА"
  ]
}
```

## questions.json Structure

The `questions.json` file should contain an array of questions:

```json
{
  "questions": [
    {
      "type": "one",
      "question": "Как дела?",
      "answers": {
        "плохо": false,
        "хорошо": true,
        "отлично": true
      }
    },
    {
      "type": "text",
      "question": "Напишите столицу России",
      "validAnswers": [
        "москва",
        "Москва",
        "МОСКВА"
      ]
    }
  ]
}
```

## Configuration Options

- **QUESTION_COUNT**: Number of questions to show (default: 5, max: 20)
- **REFRESH_QUESTIONS**: Whether to show new questions on token refresh (default: true)
- **ALLOW_RETRY_ON_ERROR**: Whether to allow retry after incorrect answers (default: true)
- **RANDOMIZE_QUESTIONS**: Whether to randomize question order (default: true)
- **REQUIRE_ALL_CORRECT**: Whether to require all answers to be correct (default: true)
- **SHOW_PROGRESS**: Whether to show progress bar during questions (default: true)

## User Flow

1. User navigates to `/user/questions-captcha` or clicks "Request a user token"
2. If enabled, user enters proxy password
3. User chooses to request new token or refresh existing token
4. System presents **QUESTION_COUNT** random questions
5. User answers all questions
6. If **REQUIRE_ALL_CORRECT** is true: all answers must be correct
   If **REQUIRE_ALL_CORRECT** is false: at least half of answers must be correct
7. If answers are incorrect, user sees error message and can retry if **ALLOW_RETRY_ON_ERROR** is true
8. If answers are correct, user proceeds to traditional proof-of-work challenge
9. After completing proof-of-work, user receives temporary token

## Security Features

- **Rate limiting**: 60-second lockout after failed attempts
- **IP verification**: Challenges must be verified from the same IP address
- **Signature verification**: Prevents replay attacks
- **Challenge expiration**: Questions expire after configured timeout
- **Randomization**: Questions are randomly selected and ordered
- **Token refresh**: Existing tokens can be refreshed with half-difficulty proof-of-work

## Error Handling

- **Incorrect answers**: Shows "Не все ответы были правильными" message
- **Rate limiting**: Shows rate limit message
- **Invalid challenge**: Asks user to request new challenge
- **Expired challenge**: Shows timeout message
- **File errors**: Validates questions.json exists and is valid format

## Integration with Existing System

The questions gatekeep integrates seamlessly with the existing proof-of-work system:

1. Questions verification happens first
2. Upon successful completion, users proceed to standard proof-of-work
3. Tokens are issued the same way as regular proof-of-work tokens
4. All existing token management features work normally
5. Admin interface can manage tokens as usual

## Differences from Standard Proof-of-Work

- **Two-step process**: Questions + proof-of-work vs. proof-of-work only
- **Custom route**: `/user/questions-captcha` vs. `/user/captcha`
- **Additional configuration**: Question-specific environment variables
- **File dependency**: Requires `questions.json` file
- **Human verification**: Tests knowledge rather than computational work