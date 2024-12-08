import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import path = require('path');
// import * as sqs from 'aws-cdk-lib/aws-sqs';

export class AwsBacklogWebhookStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    /** Create an IAM role for API Gateway to send messages to SQS */
    const webhookRole = new cdk.aws_iam.Role(this, 'IAMRole', {
      assumedBy: new cdk.aws_iam.ServicePrincipal('apigateway.amazonaws.com'),
    });

    /** Create SQS Queue */
    const queue = new cdk.aws_sqs.Queue(this, 'SQSQueue', {
      visibilityTimeout: cdk.Duration.seconds(300),
      fifo: true, // FIFO must be enabled to preserve the order that webhook handler will clone the source code
      contentBasedDeduplication: true,
      deduplicationScope: cdk.aws_sqs.DeduplicationScope.MESSAGE_GROUP,
      retentionPeriod: cdk.Duration.days(7),
      deadLetterQueue: {
        maxReceiveCount: 3,
        queue: new cdk.aws_sqs.Queue(this, 'DeadLetterQueue', {
          visibilityTimeout: cdk.Duration.seconds(300),
          fifo: true,
          contentBasedDeduplication: true,
          deduplicationScope: cdk.aws_sqs.DeduplicationScope.MESSAGE_GROUP,
          retentionPeriod: cdk.Duration.days(14)
        })
      }
    });

    /** Create REST API */
    const restApi = new cdk.aws_apigateway.RestApi(this, 'RestApi', {
      restApiName: 'BacklogWebhook',
      description: 'Backlog Webhook Rest API',
      endpointConfiguration: {
        types: [cdk.aws_apigateway.EndpointType.REGIONAL]
      },
      deployOptions: {
        stageName: 'v1',
        tracingEnabled: true,
        loggingLevel: cdk.aws_apigateway.MethodLoggingLevel.INFO,
        metricsEnabled: true
      }
    });

    /** Grant permissions to send messages to the queue */
    queue.grantSendMessages(webhookRole);

    /** Create an integration to send messages to SQS */
    const sqsIntegration = new cdk.aws_apigateway.AwsIntegration({
      service: 'sqs',
      path: `${cdk.Stack.of(this).account}/${queue.queueName}`,
      integrationHttpMethod: 'POST',
      options: {
        credentialsRole: webhookRole,
        passthroughBehavior: cdk.aws_apigateway.PassthroughBehavior.NEVER,
        requestParameters: {
          'integration.request.header.Content-Type': "'application/x-www-form-urlencoded'"
        },
        requestTemplates: {
          'application/json': [
            '#set($body = $util.parseJson($input.body))',
            '#set($projectKey = $body.project.projectKey)',
            '#set($repositoryName = $body.content.repository.name)',
            '#set($gitRef = $body.content.ref)',
            '#set($concat = "/")',
            'Action=SendMessage',
            'MessageGroupId=$projectKey$concat$repositoryName$concat$gitRef',
            'MessageBody=$util.urlEncode($input.body)'
          ].join('&')
        },
        integrationResponses: [
          {
            statusCode: '200',
            responseTemplates: {
              'application/json': `#set($response = $util.parseJson($input.body))
              {
                "messageId": "$response.SendMessageResponse.SendMessageResult.MessageId",
                "md5OfMessageBody": "$response.SendMessageResponse.SendMessageResult.MD5OfMessageBody"
              }`
            }
          },
          {
            selectionPattern: '.*QueueDoesNotExist.*',
            statusCode: '400',
            responseTemplates: {
              'application/json': `{
                "error": "Queue does not exist",
                "message": $input.json('$.errorMessage')
              }`
            }
          }
        ]
      }
    });

    /** Add a resource and method to the API */
    const webhook = restApi.root
    webhook.addMethod('POST', sqsIntegration, {
      methodResponses: [
        {
          statusCode: '200',
          responseModels: {
            'application/json': cdk.aws_apigateway.Model.EMPTY_MODEL
          }
        },
        {
          statusCode: '400',
          responseModels: {
            'application/json': cdk.aws_apigateway.Model.ERROR_MODEL
          }
        },
        {
          statusCode: '500',
          responseModels: {
            'application/json': cdk.aws_apigateway.Model.ERROR_MODEL
          }
        }
      ]
    });

    /** Add S3 Bucket for Lambda to archive source code */
    const bucket = new cdk.aws_s3.Bucket(this, 'SourceArchive', {
      versioned: true,
      blockPublicAccess: cdk.aws_s3.BlockPublicAccess.BLOCK_ALL,
      encryption: cdk.aws_s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      lifecycleRules: [
        {
          enabled: true,
          expiration: cdk.Duration.days(14)
        }
      ]
    });

    /** Add DynamoDb table for Lambda to store webhook payload, S3 source version */
    const sourceInfoTable = new cdk.aws_dynamodb.Table(this, 'SourceInfo', {
      partitionKey: {
        name: 'S3_VersionId',
        type: cdk.aws_dynamodb.AttributeType.STRING
      },
      billingMode: cdk.aws_dynamodb.BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: 'TTL'
    });

    /** Create a Lambda function from ../../webhook-handler using DockerImageFunction */
    const handler = new cdk.aws_lambda.DockerImageFunction(this, 'LambdaHandler', {
      code: cdk.aws_lambda.DockerImageCode.fromImageAsset(path.join(__dirname, '../../webhook-handler')),
      description: 'From webhook payload, retrieve repository information, clone source and archive it to S3',
      timeout: cdk.Duration.seconds(120),
      tracing: cdk.aws_lambda.Tracing.ACTIVE,
      environment: {
        'S3_BUCKET': bucket.bucketName,
        'DYNAMODB_TABLE': sourceInfoTable.tableName
      }
    });
  }
}
