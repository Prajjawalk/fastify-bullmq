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
  DOCUSIGN_HMAC_KEY: str({
    default: '', // Optional: for verifying DocuSign webhook signatures
  }),
  // DocuSign OAuth configuration
  DOCUSIGN_INTEGRATION_KEY: str({
    default: '', // DocuSign Integration Key (Client ID)
  }),
  DOCUSIGN_OAUTH_BASE_URL: str({
    default: 'https://account-d.docusign.com', // Demo: account-d.docusign.com, Prod: account.docusign.com
  }),
  DOCUSIGN_USER_ID: str({
    default: '', // The user ID to impersonate for JWT auth
  }),
});
