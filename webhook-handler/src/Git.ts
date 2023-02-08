import { execSync } from 'child_process';
import fs from 'fs'
import os from 'os';
import path from 'path';
class Git {

  private _sshSecretKey: string = '/.ssh/id_ed25519';
  public get sshSecretKey(): string {
    return this._sshSecretKey;
  }

  private _sshPublicKey: string = '/.ssh/id_ed25519.pub';
  public get sshPublicKey(): string {
    return this._sshPublicKey;
  }

  /**
   * 
   * @param sshRepoUrl Repository address (SSH Address: user@example.com)
   * @param sshSecretKey Local path to sshSecretKey file
   */
  constructor(sshSecretKey?: string, sshPublicKey?: string) {
    if (sshSecretKey) this._sshSecretKey = sshSecretKey;
    if (sshPublicKey) this._sshPublicKey = sshPublicKey;

    // Add sshSecretKey to ssh-agent
    process.env['GIT_SSH_COMMAND'] = `ssh -o StrictHostKeyChecking=no -i ${sshSecretKey}`
    // this.runCommand(`ssh-agent bash -c 'ssh-add ${this.sshSecretKey}; git config --global core.sshCommand "ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -i ${this.sshSecretKey}"'`);
  }

  private runCommand(command: string): string {
    console.log(`$ ${command}`);
    return execSync(command, { encoding: 'utf8', stdio: 'inherit' });
  }

  public getVersion(): string {
    return this.runCommand(`git --version`);
  }

  public clone(depth: number = 5, _branch: string, _sshRepo: string, srcDir?: string): string {
    var tmpDir = '';
    if (!srcDir) {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'backlog-webhook-'));
    } else {
      srcDir = srcDir
    }
    this.runCommand(`git clone --depth ${depth} --single-branch --branch ${_branch} ${_sshRepo} ${srcDir}`);
    return tmpDir;
  }

  public clean(srcDir: string) {
    this.runCommand(`git -C ${srcDir} clean -fdx`);
  }

  public fetch(srcDir: string) {
    this.runCommand(`git -C ${srcDir} fetch`);
  }

  public reset(srcDir: string, branch: string) {
    this.runCommand(`git -C ${srcDir} reset origin/${branch} --hard`);
  }

  public archive(srcDir: string, branchName: string, subDir?: string): string {
    var archiveDir = '';
    var archiveFile = '';
    if (!subDir) {
      archiveDir = srcDir;
      archiveFile = path.resolve(srcDir, `archive.zip`);
      this.runCommand(`git -C ${srcDir} archive -o ${archiveFile} --format=zip HEAD`);
    } else {
      archiveDir = path.resolve(srcDir, branchName);
      archiveFile = path.resolve(srcDir, `${subDir}.zip`);
      if (!fs.existsSync(archiveDir)) {
        fs.mkdirSync(archiveDir);
      }
      this.runCommand(`git -C ${srcDir} archive -o ${archiveFile} --format=zip HEAD:${subDir}`);
    }
    return archiveFile;
  }
}

export default Git;
