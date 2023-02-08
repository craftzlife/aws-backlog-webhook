import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import path = require('path');
// import * as sqs from 'aws-cdk-lib/aws-sqs';

export class AwsBacklogWebhookStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    /** Create an IAM role for API Gateway to send messages to SQS */
    const iamRole = new cdk.aws_iam.Role(this, 'IAMRole', {
      assumedBy: new cdk.aws_iam.CompositePrincipal(
        new cdk.aws_iam.ServicePrincipal('apigateway.amazonaws.com'),
        new cdk.aws_iam.ServicePrincipal('lambda.amazonaws.com')
      ),
      managedPolicies: [
        cdk.aws_iam.ManagedPolicy.fromManagedPolicyArn(this, 'AWSLambdaBasicExecutionRole', 'arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole')
      ]
    });

    /** Create SQS Queue */
    const queue = new cdk.aws_sqs.Queue(this, 'SQSQueue', {
      visibilityTimeout: cdk.Duration.seconds(300),
      fifo: true, // FIFO must be enabled to preserve the order that webhook handler will clone the source code
      contentBasedDeduplication: true,
      deduplicationScope: cdk.aws_sqs.DeduplicationScope.MESSAGE_GROUP,
      retentionPeriod: cdk.Duration.days(3),
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
    queue.grantSendMessages(iamRole);

    /** Create an api gateway integration to send messages to SQS */
    const sqsIntegration = new cdk.aws_apigateway.AwsIntegration({
      service: 'sqs',
      path: `${cdk.Stack.of(this).account}/${queue.queueName}`,
      integrationHttpMethod: 'POST',
      options: {
        credentialsRole: iamRole,
        passthroughBehavior: cdk.aws_apigateway.PassthroughBehavior.NEVER,
        requestParameters: {
          'integration.request.header.Content-Type': "'application/x-www-form-urlencoded'"
        },
        requestTemplates: {
          'application/json': [
            '#set($body = $util.parseJson($input.body))',
            '#set($ProjectKey = $body.project.projectKey)',
            '#set($EventType = $body.type)',
            '#set($RepositoryName = $body.content.repository.name)',
            '#set($GitRef = $body.content.ref)',
            '#set($Concat = "/")',
            'Action=SendMessage',
            'MessageGroupId=$ProjectKey$Concat$RepositoryName$Concat$GitRef',
            'MessageBody=$util.urlEncode($input.body)'
          ].join(' & ')
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
    const backlogWebhook = restApi.root.addResource('backlog-webhook');
    backlogWebhook.addMethod('POST', sqsIntegration, {
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
    bucket.grantReadWrite(iamRole);

    /** Add DynamoDb table for Lambda to store webhook payload, S3 source version */
    const sourceInfoTable = new cdk.aws_dynamodb.Table(this, 'SourceInfo', {
      partitionKey: {
        name: 'S3_VersionId',
        type: cdk.aws_dynamodb.AttributeType.STRING
      },
      timeToLiveAttribute: 'TTL',
      billingMode: cdk.aws_dynamodb.BillingMode.PAY_PER_REQUEST,
    });
    sourceInfoTable.grantWriteData(iamRole);

    /** SSH SecretKey for pulling source code from Backlog */
    const sshSecret = new cdk.aws_secretsmanager.Secret(this, 'SSHSecretKey', {
      // secretName: 'backlog-ssh-secret-key',
      secretObjectValue: {
        'id_ed25519': cdk.SecretValue.unsafePlainText('Do not store Key value here, manually edit it via AWS Console - Secret Manager'),
        'id_ed25519.pub': cdk.SecretValue.unsafePlainText('Do not store Key value here, manually edit it via AWS Console - Secret Manager')
      }
    });
    sshSecret.grantRead(iamRole);

    /** Create a Lambda function from ../../webhook-handler using DockerImageFunction */
    // const lambdaHandler = new cdk.aws_lambda.DockerImageFunction(this, 'LambdaHandler', {
    //   code: cdk.aws_lambda.DockerImageCode.fromImageAsset(path.join(__dirname, '../../webhook-handler')),
    //   role: iamRole,
    //   description: 'From webhook payload, retrieve repository information, clone source and archive it to S3',
    //   timeout: cdk.Duration.seconds(120),
    //   tracing: cdk.aws_lambda.Tracing.ACTIVE,
    //   architecture: cdk.aws_lambda.Architecture.ARM_64,
    //   memorySize: 256,
    //   environment: {
    //     'S3_BUCKET': bucket.bucketName,
    //     'DYNAMODB_TABLE': sourceInfoTable.tableName,
    //     'BACKLOG_SSH_ADDRESS': 'oxalislabs@oxalislabs.git.backlog.com',
    //     'BACKLOG_SSH_SECRET_NAME': sshSecret.secretName
    //   },
    //   retryAttempts: 0,
    //   logGroup: new cdk.aws_logs.LogGroup(this, 'LambdaHandlerLogGroup', {
    //     logGroupName: '/aws/lambda/webhook-handler',
    //     retention: cdk.aws_logs.RetentionDays.ONE_MONTH,
    //     removalPolicy: cdk.RemovalPolicy.DESTROY,
    //     logGroupClass: cdk.aws_logs.LogGroupClass.STANDARD
    //   })
    // });

    const lambdaHandler = new cdk.aws_lambda.Function(this, 'LambdaHandlerNodeJs', {
      runtime: cdk.aws_lambda.Runtime.NODEJS_18_X,
      layers: [
        cdk.aws_lambda.LayerVersion.fromLayerVersionArn(this, 'GitLayer', `arn:aws:lambda:${this.region}:553035198032:layer:git-lambda2:8`),
      ],
      handler: 'dist/src/lambdaHandler.handler',
      code: cdk.aws_lambda.Code.fromAsset(path.join(__dirname, '../../webhook-handler'), {
        bundling: {
          image: cdk.aws_lambda.Runtime.NODEJS_18_X.bundlingImage,
          network: 'host',
          user: 'root',
          command: [
            'bash', '-c', [
              'npm install --no-audit --no-fund',
              'npm run build',
              'npm prune --production',
              'rm -rf /asset-output/*',
              'cp -r dist node_modules s3-archive-configs /asset-output',
            ].join(' && ')
          ],
          bundlingFileAccess: cdk.BundlingFileAccess.VOLUME_COPY,
          outputType: cdk.BundlingOutput.NOT_ARCHIVED,
        }
      }),
      role: iamRole,
      description: 'From webhook payload, retrieve repository information, clone source and archive it to S3',
      timeout: cdk.Duration.seconds(120),
      tracing: cdk.aws_lambda.Tracing.ACTIVE,
      architecture: cdk.aws_lambda.Architecture.X86_64,
      memorySize: 256,
      environment: {
        // 'S3_BUCKET': bucket.bucketName,
        // 'DYNAMODB_TABLE': sourceInfoTable.tableName,
        // 'BACKLOG_SSH_ADDRESS': 'oxalislabs@oxalislabs.git.backlog.com',
        // 'BACKLOG_SSH_SECRET_NAME': sshSecret.secretName
        'DYNAMODB_TABLE_NAME': sourceInfoTable.tableName,
        'S3_BUCKET_NAME': bucket.bucketName,
        'BACKLOG_GIT_SERVER_URL': 'oxalislabs@oxalislabs.git.backlog.com',
        'SECRET_MANAGER_SSH_SECRET_NAME': sshSecret.secretName
      },
      retryAttempts: 0,
      logGroup: new cdk.aws_logs.LogGroup(this, 'LambdaHandlerLogGroup', {
        logGroupName: '/aws/lambda/webhook-handler',
        retention: cdk.aws_logs.RetentionDays.ONE_MONTH,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
        logGroupClass: cdk.aws_logs.LogGroupClass.STANDARD
      })
    });

    lambdaHandler.addEventSource(new cdk.aws_lambda_event_sources.SqsEventSource(queue, {
      batchSize: 1,
      reportBatchItemFailures: true,
      enabled: true
    }));
    queue.grantConsumeMessages(lambdaHandler);
  }
}
