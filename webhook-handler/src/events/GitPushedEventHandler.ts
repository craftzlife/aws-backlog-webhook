import { fromSSO } from '@aws-sdk/credential-providers';
import path from 'path';
import fs from 'fs';
import os from 'os';
import {
  GetSecretValueCommand,
  SecretsManagerClient,
} from "@aws-sdk/client-secrets-manager";
import { S3Client, PutObjectCommand, PutObjectCommandInput, GetObjectCommand } from '@aws-sdk/client-s3';
import { DynamoDBClient, PutItemCommand, PutItemCommandInput } from '@aws-sdk/client-dynamodb';
import Git from "../Git";
import { IEventHandler, IS3ArchiveConfigs, IWebHookEvent, IGitPushedContent, ISSHKey, IArchiveMapping } from '../Interfaces';
import decompress from 'decompress';
import { Readable } from 'stream';
import { compareSync, Options, Result } from 'dir-compare';
import { execSync } from 'child_process';

export class GitPushedEventHandler implements IEventHandler {
  private _s3ArchiveConfig: IS3ArchiveConfigs = require('../../../s3-archive-configs/default.json');

  constructor(private event: IWebHookEvent) { }

  public get s3ArchiveConfig(): IS3ArchiveConfigs {
    return this._s3ArchiveConfig;
  }

  private _secretsManager?: SecretsManagerClient;
  public get secretsManager(): SecretsManagerClient {
    if (!this._secretsManager) {
      const profile = process.env['AWS_SSO_PROFILE'];
      this._secretsManager = profile
        ? new SecretsManagerClient({ credentials: fromSSO({ profile }), region: 'ap-southeast-1' })
        : new SecretsManagerClient();
    }
    return this._secretsManager;
  }

  private _s3Client?: S3Client;
  public get s3Client(): S3Client {
    if (!this._s3Client) {
      const profile = process.env['AWS_SSO_PROFILE'];
      this._s3Client = profile
        ? new S3Client({ credentials: fromSSO({ profile }), region: 'ap-southeast-1' })
        : new S3Client();
    }
    return this._s3Client;
  }

  private _dynamoDBClient?: DynamoDBClient;
  public get dynamoDBClient(): DynamoDBClient {
    if (!this._dynamoDBClient) {
      const profile = process.env['AWS_SSO_PROFILE'];
      this._dynamoDBClient = profile
        ? new DynamoDBClient({ credentials: fromSSO({ profile }), region: 'ap-southeast-1' })
        : new DynamoDBClient();
    }
    return this._dynamoDBClient;
  }

  async execute() {
    const gitPushContent = this.event.content as IGitPushedContent;
    const projectKey = this.event.project.projectKey;
    const repositoryName = this.event.content.repository.name;
    const branchName = gitPushContent.ref.replace('refs/heads/', '');
    const user = this.event.createdUser;
    const revisions = gitPushContent.revisions;

    console.info(`GitPushEventHandler: ${projectKey} - ${repositoryName} - ${branchName}`);

    this.loadProjectCustomSettings(projectKey, repositoryName);
    if (!this.s3ArchiveConfig.git_branch_pushed_trigger.includes(branchName)) {
      console.info(`GitPushEventHandler: ${projectKey} - ${repositoryName} - ${branchName} is not configured to trigger, skip`);
      return;
    }

    const sshSecret = await this.downloadSSHSecret();
    const srcDir = await this.cloneOrUpdateRepo(sshSecret, projectKey, repositoryName, branchName);

    const archiveMapping = await this.archiveRepository(srcDir, projectKey, repositoryName, branchName);
    await this.uploadToS3AndSaveToDynamoDB(archiveMapping, projectKey, repositoryName, branchName, user, revisions);
  }

  private loadProjectCustomSettings(projectKey: string, repositoryName: string) {
    const configPath = path.resolve(__dirname, `../../../s3-archive-configs/${projectKey}/${repositoryName}.json`);
    if (fs.existsSync(configPath)) {
      this._s3ArchiveConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      console.info('GitPushEventHandler: Load custom setting project setting:', this.s3ArchiveConfig);
    }
  }

  private async downloadSSHSecret(): Promise<ISSHKey> {
    const secretName = process.env['SECRET_MANAGER_SSH_SECRET_NAME'];
    if (!secretName) {
      throw new Error('env SECRET_MANAGER_SSH_SECRET_NAME is not configured');
    }

    const tmpSshDir = path.resolve(os.tmpdir(), 'backlog-webhook', '.ssh');
    fs.mkdirSync(tmpSshDir, { recursive: true });

    const sshSecret: ISSHKey = {
      SecretKey: path.resolve(tmpSshDir, 'id_ed25519'),
      PublicKey: path.resolve(tmpSshDir, 'id_ed25519.pub'),
    };

    const response = await this.secretsManager.send(new GetSecretValueCommand({ SecretId: secretName }));
    if (response.SecretString) {
      const secret = JSON.parse(response.SecretString.replace(/\n/g, "\\n"));
      fs.writeFileSync(sshSecret.SecretKey, secret["id_ed25519"], { encoding: 'utf8', mode: 0o600 });
      fs.writeFileSync(sshSecret.PublicKey, secret["id_ed25519.pub"], { encoding: 'utf8', mode: 0o644 });
    }

    return sshSecret;
  }

  private async cloneOrUpdateRepo(sshSecret: ISSHKey, projectKey: string, repositoryName: string, branchName: string): Promise<string> {
    const git = new Git(sshSecret.SecretKey, sshSecret.PublicKey);
    const backlogGitServerUrl = process.env["BACKLOG_GIT_SERVER_URL"];
    const sshRepoUrl = `ssh://${backlogGitServerUrl}:/${projectKey}/${repositoryName}.git`;
    const srcDir = path.resolve(os.tmpdir(), projectKey, repositoryName, branchName);

    if (!fs.existsSync(srcDir)) {
      fs.mkdirSync(srcDir, { recursive: true });
      git.clone(5, branchName, sshRepoUrl, srcDir);
    } else {
      git.clean(srcDir);
      git.fetch(srcDir);
      git.reset(srcDir, branchName);
    }

    return srcDir;
  }

  private async archiveRepository(srcDir: string, projectKey: string, repositoryName: string, branchName: string): Promise<IArchiveMapping[]> {
    const git = new Git();
    const archiveMapping: IArchiveMapping[] = [];

    if (this.s3ArchiveConfig.archive_by_subfolders.length === 0) {
      const archivedFile = git.archive(srcDir, branchName);
      archiveMapping.push({ objectKey: `${projectKey}/${repositoryName}/${branchName}.zip`, archivedFile });
    } else {
      for (const subFolder of this.s3ArchiveConfig.archive_by_subfolders) {
        const archivedFile = git.archive(srcDir, branchName, subFolder);
        archiveMapping.push({ objectKey: `${projectKey}/${repositoryName}/${branchName}/${subFolder}.zip`, archivedFile });
      }
    }

    return archiveMapping;
  }

  private async streamToBuffer(stream: ReadableStream): Promise<Buffer> {
    const chunks: Uint8Array[] = [];
    const reader = stream.getReader();
    let result;
    while (!(result = await reader.read()).done) {
      chunks.push(result.value);
    }
    return Buffer.concat(chunks);
  }

  private async downloadS3Object(objectKey: string): Promise<string | null> {
    try {
      const getObjectCommand = new GetObjectCommand({
        Bucket: process.env['S3_BUCKET_NAME'],
        Key: objectKey
      });
      const filePath = path.resolve(os.tmpdir(), 's3-downloads', objectKey);
      if (!fs.existsSync(path.dirname(filePath))) {
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
      }
      const response = await this.s3Client.send(getObjectCommand);

      await new Promise<void>((resolve, reject) => {
        if (!response.Body) {
          throw new Error('Response body is empty');
        }
        const writeStream = fs.createWriteStream(filePath);
        const readStream = response.Body as Readable;
        // Pipe the response body to the file
        readStream
          .pipe(writeStream)
          .on('error', (err) => reject(err))
          .on('close', () => resolve());
      });

      return filePath;

    } catch (error) {
      console.warn(`Failed to download S3 object: ${error}`);
      return null;
    }
  }

  /**
   * 
   * @param oldSource as zip file
   * @param newSource as zip file
   * @returns true: identical, false: different
   */
  private async compareZipFiles(oldSource: string, newSource: string): Promise<boolean> {
    var result: boolean = false;

    const oldDirPath = fs.mkdtempSync(path.join(os.tmpdir(), 'zip-compare-old'));
    const newDirPath = fs.mkdtempSync(path.join(os.tmpdir(), 'zip-compare-new'));

    await new Promise<void>((resolve, reject) => {
      try {
        decompress(oldSource, oldDirPath).then(files => {
          resolve();
        });
      } catch (error) {
        console.error(`Unable to decompress file: ${oldSource}`, error);
      }
    });
    await new Promise<void>((resolve, reject) => {
      try {
        decompress(newSource, newDirPath).then(files => {
          resolve();
        });
      } catch (error) {
        console.error(`Unable to decompress file: ${newSource}`, error);
      }
    });

    //Start compare unzip folders
    const compareOption: Options = {
      compareSize: true,
      compareContent: true
    }
    const compareResult: Result = compareSync(oldDirPath, newDirPath, compareOption);

    const rmTmpDirCmd1 = `rm -rf ${oldDirPath}`;
    execSync(rmTmpDirCmd1, { encoding: 'utf8', stdio: 'inherit' });
    const rmTmpDirCmd2 = `rm -rf ${newDirPath}`;
    execSync(rmTmpDirCmd2, { encoding: 'utf8', stdio: 'inherit' });

    return compareResult.same;
  }
  
  private async uploadToS3AndSaveToDynamoDB(archiveMapping: IArchiveMapping[], projectKey: string, repositoryName: string, branchName: string, user: any, revisions: any) {
    await Promise.all(archiveMapping.map(async (mapping) => {
      // Download the old file from S3 then compare with the new file
      const oldFile = await this.downloadS3Object(mapping.objectKey);
      const newFile = mapping.archivedFile;
      

      if (oldFile !== null && await this.compareZipFiles(oldFile, newFile)) {
        console.info(`GitPushEventHandler: No changes detected for ${mapping.objectKey}, skipping upload.`);
        return;
      }
      // If the file is the same, skip the upload
      // If the file is different, upload the new file to S3
      // If the file is not exist, upload the new file to S3

      const fileStream = fs.createReadStream(mapping.archivedFile);
      const s3PutObjectCommandInput: PutObjectCommandInput = {
        Bucket: process.env['S3_BUCKET_NAME'],
        Key: mapping.objectKey,
        Body: fileStream,
      };

      const sendResponse = await this.s3Client.send(new PutObjectCommand(s3PutObjectCommandInput));
      if (sendResponse.VersionId) {
        const dynamodbPutObjectCommandInput: PutItemCommandInput = {
          TableName: process.env['DYNAMODB_TABLE_NAME'],
          Item: {
            S3_VersionId: { S: sendResponse.VersionId },
            S3Key: { S: mapping.objectKey },
            ProjectKey: { S: projectKey },
            RepositoryName: { S: repositoryName },
            BranchName: { S: branchName },
            BacklogUser: { S: user.name },
            CommitMessage: { S: JSON.stringify(revisions) },
            WebHookPayload: { S: JSON.stringify(this.event) },
          }
        };

        const dynamoDBResponse = await this.dynamoDBClient.send(new PutItemCommand(dynamodbPutObjectCommandInput));
        console.info('GitPushEventHandler: DynamoDB response', dynamoDBResponse);
      }
    }));
  }
}