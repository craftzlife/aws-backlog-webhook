# AWS Backlog Webhook

A serverless AWS solution that processes Backlog Git repository webhooks, automatically clones source code, and archives it to S3 for backup and analysis purposes.

## Architecture

The solution consists of two main components:

- **AWS CDK Infrastructure** (`aws-cdk/`) - Defines and deploys AWS resources
- **Webhook Handler** (`webhook-handler/`) - Lambda function that processes webhook events

### AWS Resources

- **API Gateway** - Receives webhook POST requests from Backlog
- **SQS FIFO Queue** - Ensures ordered processing of webhook events
- **Lambda Function** - Processes webhook payloads and clones repositories
- **S3 Bucket** - Stores archived source code with lifecycle management
- **DynamoDB Table** - Tracks webhook payloads and S3 versions
- **Secrets Manager** - Stores SSH keys for Git repository access

## Prerequisites

- Node.js 18.x or later
- AWS CLI configured with appropriate permissions
- AWS CDK CLI installed (`npm install -g aws-cdk`)
- SSH key pair for Backlog Git access

## Setup

### 1. Install Dependencies

```bash
# Install CDK dependencies
cd aws-cdk
npm install

# Install webhook handler dependencies
cd ../webhook-handler
npm install
```

### 2. Configure SSH Keys

After deployment, manually update the SSH keys in AWS Secrets Manager:

1. Navigate to AWS Secrets Manager console
2. Find the created SSH secret
3. Update the `id_ed25519` and `id_ed25519.pub` values with your actual SSH keys

### 3. Deploy Infrastructure

```bash
cd aws-cdk
npm run build
npx cdk deploy
```

### 4. Configure Backlog Webhook

1. In your Backlog project settings, add a new webhook
2. Set the webhook URL to the deployed API Gateway endpoint: `https://<api-id>.execute-api.<region>.amazonaws.com/v1/backlog-webhook`
3. Configure webhook to trigger on Git push events

## Environment Variables

The Lambda function uses these environment variables (automatically configured by CDK):

- `DYNAMODB_TABLE_NAME` - DynamoDB table for storing webhook metadata
- `S3_BUCKET_NAME` - S3 bucket for source code archives
- `BACKLOG_GIT_SERVER_URL` - Backlog Git server URL (format: `user@server.git.backlog.com`)
- `SECRET_MANAGER_SSH_SECRET_NAME` - AWS Secrets Manager secret name for SSH keys

## Development

### Build

```bash
# Build CDK
cd aws-cdk
npm run build

# Build webhook handler
cd ../webhook-handler
npm run build
```

### Test

```bash
# Test CDK
cd aws-cdk
npm test

# Test webhook handler
cd ../webhook-handler
npm test
```

### Local Development

```bash
cd webhook-handler
npm run start
```

## How It Works

1. Backlog sends webhook POST request to API Gateway
2. API Gateway transforms the request and sends message to SQS FIFO queue
3. SQS triggers Lambda function with webhook payload
4. Lambda function:
   - Parses webhook event
   - Retrieves SSH keys from Secrets Manager
   - Clones the Git repository
   - Archives source code to S3
   - Stores metadata in DynamoDB

## Features

- **Ordered Processing** - FIFO queue ensures webhook events are processed in order
- **Automatic Cleanup** - S3 lifecycle policy removes archives after 14 days
- **Error Handling** - Dead letter queue for failed processing attempts
- **Monitoring** - CloudWatch logs and X-Ray tracing enabled
- **Security** - Encrypted S3 storage, SSL enforcement, and IAM least privilege

## Contributing

1. Fork the repository
2. Create a feature branch
3. Make changes and test
4. Submit a pull request

## License

This project is licensed under the ISC License.