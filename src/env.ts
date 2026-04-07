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
  // AWS S3 (for WhatsApp media storage)
  AWS_REGION: str({
    default: 'us-east-1',
  }),
  AWS_ACCESS_KEY_ID: str({
    default: '',
  }),
  AWS_SECRET_ACCESS_KEY: str({
    default: '',
  }),
  AWS_S3_BUCKET_NAME: str({
    default: '',
  }),
  AWS_S3_ENDPOINT_URL: str({
    default: '', // Optional: custom endpoint for S3-compatible services
  }),
  // WhatsApp encryption key (must match the one in one-2b)
  WHATSAPP_ENCRYPTION_KEY: str({
    default: '',
  }),
});
