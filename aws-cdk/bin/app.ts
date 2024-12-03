#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { AwsBacklogWebhookStack } from '../lib/aws-backlog-webhook-stack';

const app = new cdk.App();
new AwsBacklogWebhookStack(app, 'BacklogWebhook', {
  env: {
    account: '475174330998',
    region: 'ap-southeast-1'
  },
});