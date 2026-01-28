import { envsafe, port, str, url } from 'envsafe';

export const env = envsafe({
  REDISHOST: str(),
  REDISPORT: port(),
  REDISUSER: str(),
  REDISPASSWORD: str(),
  PORT: port({
    devDefault: 3000,
  }),
  RAILWAY_STATIC_URL: str({
    devDefault: 'http://localhost:3000',
  }),
  AUTH_POSTMARK_KEY: str(),
  AUTH_SECRET: str(),
  ANTHROPIC_API_KEY: str(),
  DATABASE_URL: url(),
  FIREFLIES_API_KEY: str(),
  FIREFLIES_WEBHOOK_SECRET: str({
    default: '', // Optional: for verifying webhook signatures
  }),
});
